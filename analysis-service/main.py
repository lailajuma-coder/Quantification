from __future__ import annotations

import asyncio
import hashlib
import gzip
import io
import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import nd2
import numpy as np
import tifffile
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from PIL import Image
from starlette.concurrency import run_in_threadpool

app = FastAPI(title="KidneyQuant image companion", docs_url=None, redoc_url=None)
logger = logging.getLogger("kidneyquant.analysis")
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))
MAX_DECODED_PIXELS = int(os.getenv("MAX_DECODED_PIXELS", "8000000"))
MAX_RETAINED_CHANNELS = int(os.getenv("MAX_RETAINED_CHANNELS", "3"))
MAX_CONCURRENT_DECODES = max(1, int(os.getenv("MAX_CONCURRENT_DECODES", "1")))
ALLOWED_FILE_EXTENSIONS = frozenset({".nd2", ".tif", ".tiff", ".jp2", ".j2k", ".jpx"})
DECODE_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_DECODES)


@dataclass(frozen=True)
class DecodedSource:
    display: np.ndarray
    source_format: str
    significant_bits: int
    original_shape: tuple[int, ...]
    original_axes: tuple[str, ...]
    selected_shape: tuple[int, ...]
    selected_axes: tuple[str, ...]
    selection: dict[str, int | str]
    processing: str
    samples: np.ndarray | None = None
    channel_mapping: dict[str, Any] | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def nd2_axes(axes: tuple[str, ...], array_ndim: int) -> tuple[str, ...]:
    normalized = tuple(str(axis).upper() for axis in axes)
    if len(normalized) == array_ndim:
        return normalized
    if len(normalized) + 1 == array_ndim:
        return (*normalized, "S")
    raise ValueError(f"ND2 axis metadata {normalized} does not match an array with {array_ndim} dimensions.")


def validate_retained_plane(shape: tuple[int, ...], axes: tuple[str, ...]) -> None:
    normalized_axes = tuple(str(axis).upper() for axis in axes)
    if len(shape) != len(normalized_axes) or "Y" not in normalized_axes or "X" not in normalized_axes:
        raise ValueError(f"Retained plane shape {shape} does not match axes {normalized_axes}.")
    dimensions = tuple(int(value) for value in shape)
    if any(value < 1 for value in dimensions):
        raise ValueError(f"Retained plane has invalid dimensions: {dimensions}.")
    pixels = dimensions[normalized_axes.index("Y")] * dimensions[normalized_axes.index("X")]
    if pixels > MAX_DECODED_PIXELS:
        raise ValueError(f"The selected plane exceeds the {MAX_DECODED_PIXELS // 1_000_000} million pixels limit.")
    channels = 1
    for axis, size in zip(normalized_axes, dimensions, strict=True):
        if axis not in {"Y", "X"}:
            channels *= size
    if channels > MAX_RETAINED_CHANNELS:
        raise ValueError(f"The selected plane contains more than {MAX_RETAINED_CHANNELS} channels.")


def first_plane_indexer(
    axes: tuple[str, ...],
) -> tuple[tuple[int | slice, ...], tuple[str, ...], dict[str, int | str]]:
    normalized_axes = tuple(str(axis).upper() for axis in axes)
    if "Y" not in normalized_axes or "X" not in normalized_axes:
        raise ValueError(f"The image must define Y and X axes; received {normalized_axes}.")
    selection: dict[str, int | str] = {}
    indexer: list[int | slice] = []
    retained_axes: list[str] = []
    has_component_axis = "S" in normalized_axes
    for axis in normalized_axes:
        if axis in {"Y", "X", "S"} or (axis == "C" and not has_component_axis):
            indexer.append(slice(None))
            retained_axes.append(axis)
            selection[axis] = "all"
        else:
            indexer.append(0)
            selection[axis] = 0
    return tuple(indexer), tuple(retained_axes), selection


def select_first_plane(array: np.ndarray, axes: tuple[str, ...]) -> tuple[np.ndarray, dict[str, int | str]]:
    data = np.asarray(array)
    normalized_axes = tuple(str(axis).upper() for axis in axes)
    if data.ndim != len(normalized_axes):
        raise ValueError(f"Axis metadata {normalized_axes} does not match shape {data.shape}.")

    indexer, retained_axis_tuple, selection = first_plane_indexer(normalized_axes)
    retained_axes = list(retained_axis_tuple)
    plane = data[indexer]
    if "C" in retained_axes:
        channel_axis = retained_axes.index("C")
        plane = np.moveaxis(plane, channel_axis, -1)
        retained_axes.append(retained_axes.pop(channel_axis))
    if retained_axes[:2] != ["Y", "X"]:
        order = [retained_axes.index("Y"), retained_axes.index("X")]
        order.extend(index for index, axis in enumerate(retained_axes) if axis not in {"Y", "X"})
        plane = np.transpose(plane, order)
        retained_axes = [retained_axes[index] for index in order]
    if retained_axes not in (["Y", "X"], ["Y", "X", "C"], ["Y", "X", "S"]):
        raise ValueError(f"Unsupported retained axes after first-plane selection: {tuple(retained_axes)}")
    return np.asarray(plane), selection


def _scale_into_uint8(source: np.ndarray, destination: np.ndarray, significant_bits: int) -> None:
    full_scale = (1 << significant_bits) - 1
    if source.dtype.itemsize > 4 or significant_bits > 16:
        working_dtype = np.dtype(np.uint64)
    elif source.dtype.itemsize > 2 or significant_bits > 8:
        working_dtype = np.dtype(np.uint32)
    else:
        working_dtype = np.dtype(np.uint16)

    iterator = np.nditer(
        (source, destination),
        flags=["external_loop", "buffered", "zerosize_ok"],
        op_flags=[["readonly"], ["writeonly"]],
        order="C",
        buffersize=64 * 1024,
    )
    for source_chunk, destination_chunk in iterator:
        working = source_chunk.astype(working_dtype, copy=True)
        np.minimum(working, full_scale, out=working)
        np.multiply(working, 255, out=working)
        np.add(working, full_scale // 2, out=working)
        np.floor_divide(working, full_scale, out=working)
        destination_chunk[...] = working


def linear_uint8(array: np.ndarray, significant_bits: int) -> np.ndarray:
    data = np.asarray(array)
    if not np.issubdtype(data.dtype, np.unsignedinteger):
        raise ValueError(f"Quantitative decoding requires unsigned integer pixels; received {data.dtype}.")
    if significant_bits < 1 or significant_bits > 32:
        raise ValueError(f"Unsupported significant bit depth: {significant_bits}.")
    if data.ndim not in (2, 3):
        raise ValueError(f"Expected a 2D plane with optional channels; received {data.shape}.")
    if data.ndim == 3 and data.shape[-1] not in (1, 2, 3, 4):
        raise ValueError(f"Expected channels in the final axis; received {data.shape}.")
    if data.ndim == 3 and data.shape[-1] == 4:
        raise ValueError("Unsupported four-component image; convert it to grayscale or RGB first.")

    if data.ndim == 2:
        scaled = np.empty(data.shape, dtype=np.uint8)
        _scale_into_uint8(data, scaled, significant_bits)
        return scaled
    if data.shape[-1] == 1:
        scaled = np.empty(data.shape[:2], dtype=np.uint8)
        _scale_into_uint8(data[..., 0], scaled, significant_bits)
        return scaled
    if data.shape[-1] == 2:
        scaled = np.zeros((*data.shape[:2], 3), dtype=np.uint8)
        _scale_into_uint8(data, scaled[..., :2], significant_bits)
        return scaled

    scaled = np.empty(data.shape, dtype=np.uint8)
    _scale_into_uint8(data, scaled, significant_bits)
    return scaled


def _read_exact(stream: Any, size: int, error: str) -> bytes:
    payload = stream.read(size)
    if len(payload) != size:
        raise ValueError(error)
    return payload


def _jp2_codestream_bounds(stream: Any, file_size: int) -> tuple[int, int]:
    offset = 0
    saw_signature = False
    while offset < file_size:
        if file_size - offset < 8:
            raise ValueError("The JP2 box structure is truncated or invalid.")
        stream.seek(offset)
        box_header = _read_exact(stream, 8, "The JP2 box structure is truncated or invalid.")
        box_length = int.from_bytes(box_header[:4], "big")
        box_type = box_header[4:]
        if offset == 0 and (box_type != b"jP  " or box_length != 12):
            raise ValueError("The file is not a JPEG2000 codestream or JP2 container.")
        header_length = 8
        if box_length == 1:
            box_length = int.from_bytes(
                _read_exact(stream, 8, "The JP2 extended box length is truncated."),
                "big",
            )
            header_length = 16
        elif box_length == 0:
            box_length = file_size - offset

        if box_length < header_length or box_length > file_size - offset:
            raise ValueError("The JP2 box structure is truncated or invalid.")
        payload_offset = offset + header_length
        box_end = offset + box_length

        if offset == 0:
            signature = _read_exact(stream, 4, "The JP2 signature box is truncated.")
            if signature != b"\r\n\x87\n":
                raise ValueError("The JP2 signature box is invalid.")
            saw_signature = True
        elif box_type == b"jp2c":
            if not saw_signature or payload_offset >= box_end:
                raise ValueError("The JP2 codestream box is empty or invalid.")
            return payload_offset, box_end

        offset = box_end

    raise ValueError("The JP2 container does not contain a JP2 codestream box (jp2c).")


def _codestream_component_precision(stream: Any, start: int, end: int) -> tuple[int, bool, int]:
    stream.seek(start)
    if _read_exact(stream, 2, "The JPEG2000 codestream is truncated.") != b"\xff\x4f":
        raise ValueError("The JPEG2000 codestream does not begin with an SOC marker.")
    if _read_exact(stream, 2, "The JPEG2000 codestream is truncated.") != b"\xff\x51":
        raise ValueError("The JPEG2000 codestream does not begin with a SIZ marker segment.")

    segment_length = int.from_bytes(
        _read_exact(stream, 2, "The JPEG2000 SIZ metadata is truncated or invalid."),
        "big",
    )
    if segment_length < 41 or stream.tell() + segment_length - 2 > end:
        raise ValueError("The JPEG2000 SIZ metadata is truncated or invalid.")
    fixed_fields = _read_exact(stream, 36, "The JPEG2000 SIZ metadata is truncated or invalid.")
    component_count = int.from_bytes(fixed_fields[-2:], "big")
    expected_length = 38 + 3 * component_count
    if component_count < 1 or segment_length != expected_length:
        raise ValueError("The JPEG2000 SIZ metadata is truncated or invalid.")
    component_fields = _read_exact(
        stream,
        3 * component_count,
        "The JPEG2000 SIZ metadata is truncated or invalid.",
    )

    definitions = {
        ((component_fields[index] & 0x7F) + 1, bool(component_fields[index] & 0x80))
        for index in range(0, len(component_fields), 3)
    }
    if len(definitions) != 1:
        raise ValueError("Mixed JPEG2000 component precision is not supported.")
    precision, signed = definitions.pop()
    return precision, signed, component_count


def jp2_component_precision(path: Path) -> tuple[int, bool, int]:
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        file_size = stream.tell()
        if file_size < 2:
            raise ValueError("The file is not a JPEG2000 codestream or JP2 container.")
        stream.seek(0)
        if stream.read(2) == b"\xff\x4f":
            codestream_start, codestream_end = 0, file_size
        else:
            codestream_start, codestream_end = _jp2_codestream_bounds(stream, file_size)
        return _codestream_component_precision(stream, codestream_start, codestream_end)


def map_nd2_channels(plane: np.ndarray, metadata: Any) -> tuple[np.ndarray, dict[str, Any]]:
    """Use a complete, unambiguous RGB metadata permutation; never infer antibody colors."""
    count = plane.shape[-1] if plane.ndim == 3 else 1
    channels = getattr(metadata, "channels", None) or []
    names = [str(getattr(getattr(channels[i], "channel", None), "name", ""))[:200]
             if i < len(channels) else "" for i in range(count)]
    order = list(range(count))
    method = "source-order"
    if count == 3 and len(channels) == 3:
        destinations = []
        for item in channels:
            color = getattr(getattr(item, "channel", None), "color", None)
            components = [getattr(color, key, 0) for key in ("r", "g", "b")]
            peak = max(components)
            destinations.append(components.index(peak) if peak > 0 and components.count(peak) == 1 else -1)
        if sorted(destinations) == [0, 1, 2]:
            order = [destinations.index(component) for component in range(3)]
            plane = np.ascontiguousarray(plane[..., order])
            method = "nd2-color-metadata"
    return plane, {"method": method, "sourceIndices": order, "sourceNames": [names[i] for i in order]}


def decode_source(path: Path, suffix: str, render_preview: bool = True) -> DecodedSource:
    normalized_suffix = suffix.lower()
    selection: dict[str, int | str] = {}
    channel_mapping = None
    if normalized_suffix == ".nd2":
        with nd2.ND2File(path) as nd_file:
            lazy = nd_file.to_dask()
            original_axes = nd2_axes(tuple(nd_file.sizes), lazy.ndim)
            original_shape = tuple(int(value) for value in lazy.shape)
            indexer, retained_axes, selection = first_plane_indexer(original_axes)
            retained_shape = tuple(size for size, selector in zip(original_shape, indexer, strict=True) if isinstance(selector, slice))
            validate_retained_plane(retained_shape, retained_axes)
            selected = np.asarray(lazy[indexer].compute(scheduler="synchronous"))
            plane, _ = select_first_plane(selected, retained_axes)
            plane, channel_mapping = map_nd2_channels(plane, nd_file.metadata)
            channels = getattr(nd_file.metadata, "channels", None) or []
            volume = getattr(channels[0], "volume", None) if channels else None
            calibrated = getattr(volume, "axesCalibrated", ())
            calibration = getattr(volume, "axesCalibration", ())
            if len(calibrated) >= 2 and all(calibrated[:2]) and len(calibration) >= 2 and all(np.isfinite(v) and v > 0 for v in calibration[:2]):
                channel_mapping["pixelSizeMicrons"] = [float(v) for v in calibration[:2]]
            significant_bits = int(nd_file.attributes.bitsPerComponentSignificant)
        selected_axes = ("Y", "X") if plane.ndim == 2 else ("Y", "X", next(axis for axis in retained_axes if axis not in {"Y", "X"}))
        source_format = "ND2"
    elif normalized_suffix in {".tif", ".tiff"}:
        with tifffile.TiffFile(path) as tiff:
            if len(tiff.pages) != 1:
                raise ValueError(
                    f"This TIFF contains multiple planes ({len(tiff.pages)}); select and export one plane as OME-TIFF first."
                )
            page = cast(Any, tiff.pages[0])
            original_shape = tuple(int(value) for value in page.shape)
            original_axes = tuple(str(axis).upper() for axis in page.axes)
            validate_retained_plane(original_shape, original_axes)
            bit_values = page.bitspersample if isinstance(page.bitspersample, tuple) else (page.bitspersample,)
            unique_bits = {int(value) for value in bit_values}
            if len(unique_bits) != 1:
                raise ValueError("TIFF samples with mixed bit depth are not supported.")
            significant_bits = unique_bits.pop()
            sample_values = page.sampleformat if isinstance(page.sampleformat, tuple) else (page.sampleformat,)
            if any(int(value) != 1 for value in sample_values):
                raise ValueError("Signed and floating-point TIFF values are not supported for quantitative analysis.")
            samples = int(page.samplesperpixel)
            photometric = int(page.photometric)
            planar = int(page.planarconfig) if page.planarconfig is not None else 1
            if planar != 1:
                raise ValueError("Planar-separate RGB TIFF is not supported. Convert it to interleaved RGB first.")
            if not ((photometric == 1 and samples == 1) or (photometric == 2 and samples == 3)):
                raise ValueError("Only unsigned BlackIsZero grayscale and interleaved RGB TIFF are supported.")
            plane = np.asarray(page.asarray())
        selected_axes = original_axes
        source_format = "TIFF"
    elif normalized_suffix in {".jp2", ".j2k", ".jpx"}:
        significant_bits, signed, component_count = jp2_component_precision(path)
        if signed:
            raise ValueError("Signed JPEG2000 samples are not supported for quantitative analysis.")
        if component_count not in {1, 3}:
            raise ValueError(f"JPEG2000 with {component_count} components is not supported; use grayscale or RGB.")
        if component_count > 1 and significant_bits > 8:
            raise ValueError("High-bit multi-component JPEG2000 is not supported without a precision-preserving decoder.")
        with Image.open(path) as opened:
            if opened.format != "JPEG2000":
                raise ValueError("The file is not a JPEG2000 image.")
            original_shape = (int(opened.height), int(opened.width)) if component_count == 1 else (int(opened.height), int(opened.width), component_count)
            original_axes = ("Y", "X") if component_count == 1 else ("Y", "X", "S")
            validate_retained_plane(original_shape, original_axes)
            plane = np.asarray(opened)
        if component_count == 1 and plane.ndim != 2:
            raise ValueError(f"Expected a grayscale JPEG2000 plane; decoded shape was {plane.shape}.")
        if component_count == 3 and (plane.ndim != 3 or plane.shape[-1] != 3):
            raise ValueError(f"Expected an RGB JPEG2000 plane; decoded shape was {plane.shape}.")
        selected_axes = original_axes
        source_format = "JP2"
    else:
        raise ValueError(f"Unsupported image suffix: {normalized_suffix}")

    selected_shape = tuple(int(value) for value in plane.shape)
    if not np.issubdtype(plane.dtype, np.unsignedinteger):
        raise ValueError("Quantitative decoding requires unsigned integer pixels.")
    display = linear_uint8(plane, significant_bits) if render_preview else np.empty(0, dtype=np.uint8)
    processing = "native-8bit" if significant_bits == 8 else f"linear-{significant_bits}bit-to-8bit"
    return DecodedSource(
        display=display,
        source_format=source_format,
        significant_bits=significant_bits,
        original_shape=original_shape,
        original_axes=original_axes,
        selected_shape=selected_shape,
        selected_axes=selected_axes,
        selection=selection,
        processing=processing,
        samples=plane,
        channel_mapping=channel_mapping,
    )


def metadata_headers(decoded: DecodedSource) -> dict[str, str]:
    channel_count = decoded.selected_shape[-1] if len(decoded.selected_shape) == 3 else 1
    return {
        **({"X-KidneyQuant-Channel-Mapping": json.dumps(decoded.channel_mapping, separators=(",", ":"), ensure_ascii=True)} if decoded.channel_mapping else {}),
        "X-KidneyQuant-Source-Format": decoded.source_format,
        "X-KidneyQuant-Original-Bit-Depth": str(decoded.significant_bits),
        "X-KidneyQuant-Original-Shape": "x".join(str(value) for value in decoded.original_shape),
        "X-KidneyQuant-Original-Axes": ",".join(decoded.original_axes),
        "X-KidneyQuant-Selected-Shape": "x".join(str(value) for value in decoded.selected_shape),
        "X-KidneyQuant-Selected-Axes": ",".join(decoded.selected_axes),
        "X-KidneyQuant-Channel-Count": str(channel_count),
        "X-KidneyQuant-Plane-Selection": json.dumps(decoded.selection, separators=(",", ":"), sort_keys=True),
        "X-KidneyQuant-Processing": decoded.processing,
        "X-KidneyQuant-Quantitative-Status": "experimental",
    }


def decode_png(path: Path, suffix: str) -> tuple[DecodedSource, bytes]:
    decoded = decode_source(path, suffix)
    output = io.BytesIO()
    Image.fromarray(decoded.display).save(output, format="PNG", optimize=False, compress_level=1)
    return decoded, output.getvalue()


def decode_samples(path: Path, suffix: str) -> tuple[DecodedSource, bytes]:
    decoded = decode_source(path, suffix, render_preview=False)
    if not 1 <= decoded.significant_bits <= 16 or decoded.samples is None:
        raise ValueError("Native thresholding supports unsigned images up to 16 bits.")
    storage_bits = 8 if decoded.significant_bits <= 8 else 16
    # Explicit little-endian, interleaved Y,X[,C] samples; preserve every intensity.
    samples = np.asarray(decoded.samples, dtype="u1" if storage_bits == 8 else "<u2")
    return decoded, gzip.compress(samples.tobytes(order="C"), compresslevel=1, mtime=0)


def _request_upload_metadata(request: Request) -> tuple[str, int]:
    suffix = request.headers.get("X-KidneyQuant-File-Extension")
    if suffix is None:
        raise HTTPException(
            status_code=400,
            detail="The X-KidneyQuant-File-Extension header is required.",
        )
    suffix = suffix.lower()
    if suffix not in ALLOWED_FILE_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="X-KidneyQuant-File-Extension must be .nd2, .tif, .tiff, .jp2, .j2k, or .jpx.",
        )

    content_length_header = request.headers.get("Content-Length")
    if content_length_header is None:
        raise HTTPException(status_code=411, detail="Content-Length is required for image uploads.")
    if not content_length_header.isdecimal():
        raise HTTPException(status_code=400, detail="Content-Length must be a non-negative integer.")
    content_length = int(content_length_header)
    if content_length < 1:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")
    if content_length > MAX_UPLOAD_BYTES:
        limit_mb = MAX_UPLOAD_BYTES // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"The file exceeds the {limit_mb} MB companion limit.")
    return suffix, content_length


@app.post("/decode")
async def decode(request: Request) -> Response:
    suffix, content_length = _request_upload_metadata(request)

    async with DECODE_SEMAPHORE:
        temporary_path = ""
        written = 0
        source_hash = hashlib.sha256()
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temporary:
                temporary_path = temporary.name
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    written += len(chunk)
                    if written > MAX_UPLOAD_BYTES:
                        limit_mb = MAX_UPLOAD_BYTES // (1024 * 1024)
                        raise HTTPException(
                            status_code=413,
                            detail=f"The file exceeds the {limit_mb} MB companion limit.",
                        )
                    source_hash.update(chunk)
                    temporary.write(chunk)

            if written != content_length:
                raise HTTPException(
                    status_code=400,
                    detail="The streamed body length does not match Content-Length.",
                )

            native = request.headers.get("Accept") == "application/vnd.kidneyquant.samples+gzip"
            decoder = decode_samples if native else decode_png
            decoded, png_bytes = await run_in_threadpool(decoder, Path(temporary_path), suffix)
            native_headers = {
                "X-KidneyQuant-Processing": "native-integer-samples",
            } if native else {}
            return Response(
                png_bytes,
                media_type="application/vnd.kidneyquant.samples+gzip" if native else "image/png",
                headers={
                    "Cache-Control": "no-store",
                    **metadata_headers(decoded),
                    **native_headers,
                    "X-KidneyQuant-Source-SHA256": source_hash.hexdigest(),
                },
            )
        except HTTPException:
            raise
        except ValueError as error:
            public_detail = str(error).replace(temporary_path, "the uploaded file")
            raise HTTPException(status_code=422, detail=public_detail) from error
        except Exception as error:
            logger.exception("Image decode failed for suffix %s", suffix)
            raise HTTPException(
                status_code=422,
                detail="The image could not be decoded safely. Verify the file format, dimensions, channels, and bit depth.",
            ) from error
        finally:
            if temporary_path and os.path.exists(temporary_path):
                os.unlink(temporary_path)
