from __future__ import annotations

import asyncio
import hashlib
import struct
import tempfile
import threading
import tracemalloc
import unittest
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException, Request
from PIL import Image

from main import DecodedSource, MAX_UPLOAD_BYTES, decode, decode_source, first_plane_indexer, jp2_component_precision, linear_uint8, metadata_headers, nd2_axes, select_first_plane, validate_retained_plane


def siz_codestream(precision: int = 8, components: int = 1, signed: bool = False) -> bytes:
    component_definition = ((precision - 1) | (0x80 if signed else 0)).to_bytes(1, "big") + b"\x01\x01"
    segment_length = 38 + 3 * components
    siz = b"".join(
        (
            b"\xff\x51",
            segment_length.to_bytes(2, "big"),
            b"\x00\x00",
            (1).to_bytes(4, "big") * 2,
            (0).to_bytes(4, "big") * 2,
            (1).to_bytes(4, "big") * 2,
            (0).to_bytes(4, "big") * 2,
            components.to_bytes(2, "big"),
            component_definition * components,
        )
    )
    return b"\xff\x4f" + siz


def jp2_box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


JP2_SIGNATURE = jp2_box(b"jP  ", b"\r\n\x87\n")


def raw_request(
    chunks: list[bytes],
    *,
    extension: str | None = ".jp2",
    content_length: int | str | None = None,
    receive_started: threading.Event | None = None,
) -> Request:
    remaining = list(chunks)
    headers: list[tuple[bytes, bytes]] = []
    if extension is not None:
        headers.append((b"x-kidneyquant-file-extension", extension.encode("ascii")))
    if content_length is None:
        content_length = sum(len(chunk) for chunk in chunks)
    if content_length is not False:
        headers.append((b"content-length", str(content_length).encode("ascii")))

    async def receive() -> dict[str, object]:
        if receive_started is not None:
            receive_started.set()
        chunk = remaining.pop(0)
        return {"type": "http.request", "body": chunk, "more_body": bool(remaining)}

    return Request(
        {"type": "http", "method": "POST", "path": "/decode", "headers": headers},
        receive,
    )


class ConfigurationTests(unittest.TestCase):
    def test_default_upload_limit_is_512_megabytes(self) -> None:
        self.assertEqual(MAX_UPLOAD_BYTES, 512 * 1024 * 1024)

    def test_retained_plane_limits_pixels_and_channels_before_decode(self) -> None:
        validate_retained_plane((2000, 4000, 3), ("Y", "X", "C"))
        with self.assertRaisesRegex(ValueError, "8 million pixels"):
            validate_retained_plane((2001, 4000, 3), ("Y", "X", "C"))
        with self.assertRaisesRegex(ValueError, "more than 3 channels"):
            validate_retained_plane((100, 100, 4), ("Y", "X", "C"))


class SelectFirstPlaneTests(unittest.TestCase):
    def test_nd2_component_axis_is_named_when_shape_has_one_extra_dimension(self) -> None:
        self.assertEqual(nd2_axes(("Y", "X"), 3), ("Y", "X", "S"))
        self.assertEqual(nd2_axes(("C", "Y", "X"), 3), ("C", "Y", "X"))
        with self.assertRaisesRegex(ValueError, "axis metadata"):
            nd2_axes(("Y", "X"), 4)

    def test_indexer_keeps_only_spatial_and_channel_axes_lazy(self) -> None:
        indexer, retained_axes, selection = first_plane_indexer(("P", "T", "Z", "C", "Y", "X"))

        self.assertEqual(indexer[:3], (0, 0, 0))
        self.assertEqual(indexer[3:], (slice(None), slice(None), slice(None)))
        self.assertEqual(retained_axes, ("C", "Y", "X"))
        self.assertEqual(selection["P"], 0)
        self.assertEqual(selection["T"], 0)
        self.assertEqual(selection["Z"], 0)

    def test_rgb_component_axis_selects_first_logical_channel(self) -> None:
        indexer, retained_axes, selection = first_plane_indexer(("C", "Y", "X", "S"))

        self.assertEqual(indexer, (0, slice(None), slice(None), slice(None)))
        self.assertEqual(retained_axes, ("Y", "X", "S"))
        self.assertEqual(selection["C"], 0)

    def test_preserves_two_channel_nd2_spatial_shape(self) -> None:
        source = np.arange(2 * 32 * 32, dtype=np.uint16).reshape(2, 32, 32)

        plane, selection = select_first_plane(source, ("C", "Y", "X"))

        self.assertEqual(plane.shape, (32, 32, 2))
        np.testing.assert_array_equal(plane[..., 0], source[0])
        np.testing.assert_array_equal(plane[..., 1], source[1])
        self.assertEqual(selection, {"C": "all", "Y": "all", "X": "all"})

    def test_selects_index_zero_for_non_spatial_axes(self) -> None:
        source = np.arange(3 * 2 * 4 * 5, dtype=np.uint16).reshape(3, 2, 4, 5)

        plane, selection = select_first_plane(source, ("T", "C", "Y", "X"))

        self.assertEqual(plane.shape, (4, 5, 2))
        np.testing.assert_array_equal(plane[..., 0], source[0, 0])
        np.testing.assert_array_equal(plane[..., 1], source[0, 1])
        self.assertEqual(selection["T"], 0)

    def test_rejects_unknown_axis_layout(self) -> None:
        with self.assertRaisesRegex(ValueError, "Y and X axes"):
            select_first_plane(np.zeros((2, 3), dtype=np.uint8), ("A", "B"))


class LinearUint8Tests(unittest.TestCase):
    def test_linearly_scales_unsigned_sixteen_bit_values(self) -> None:
        source = np.array([[0, 32768, 65535]], dtype=np.uint16)

        display = linear_uint8(source, significant_bits=16)

        np.testing.assert_array_equal(display, np.array([[0, 128, 255]], dtype=np.uint8))

    def test_constant_bright_field_does_not_collapse_to_zero(self) -> None:
        source = np.full((2, 2), 65535, dtype=np.uint16)

        display = linear_uint8(source, significant_bits=16)

        np.testing.assert_array_equal(display, np.full((2, 2), 255, dtype=np.uint8))

    def test_two_channels_are_rendered_as_rgb_without_losing_spatial_axes(self) -> None:
        source = np.zeros((4, 5, 2), dtype=np.uint16)
        source[..., 0] = 65535
        source[..., 1] = 32768

        display = linear_uint8(source, significant_bits=16)

        self.assertEqual(display.shape, (4, 5, 3))
        self.assertTrue(np.all(display[..., 0] == 255))
        self.assertTrue(np.all(display[..., 1] == 128))
        self.assertTrue(np.all(display[..., 2] == 0))

    def test_rejects_signed_or_float_measurements(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsigned integer"):
            linear_uint8(np.array([[-1, 1]], dtype=np.int16), significant_bits=16)
        with self.assertRaisesRegex(ValueError, "unsigned integer"):
            linear_uint8(np.array([[0.0, 1.0]], dtype=np.float32), significant_bits=16)

    def test_rejects_four_components_instead_of_silently_truncating(self) -> None:
        with self.assertRaisesRegex(ValueError, "four-component"):
            linear_uint8(np.zeros((2, 2, 4), dtype=np.uint8), significant_bits=8)

    def test_scales_large_uint16_plane_without_a_full_uint64_amplification(self) -> None:
        source = np.arange(1024 * 1024, dtype=np.uint16).reshape(1024, 1024)

        tracemalloc.start()
        try:
            display = linear_uint8(source, significant_bits=16)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        self.assertEqual(display.dtype, np.uint8)
        self.assertLessEqual(peak, source.nbytes * 2)


class DecodeSourceTests(unittest.TestCase):
    def test_decodes_supported_unsigned_gray16_tiff_with_source_metadata(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "gray16.tiff"
            import tifffile

            tifffile.imwrite(path, np.array([[0, 65535]], dtype=np.uint16), photometric="minisblack")
            decoded = decode_source(path, ".tiff")

        self.assertEqual(decoded.significant_bits, 16)
        self.assertEqual(decoded.original_axes, ("Y", "X"))
        self.assertEqual(decoded.selected_shape, (1, 2))
        np.testing.assert_array_equal(decoded.display, np.array([[0, 255]], dtype=np.uint8))

    def test_reads_jp2_codestream_precision_instead_of_container_dtype(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "nine-bit-metadata.jp2"
            source = np.array([[0, 256, 511]], dtype=np.uint16)
            Image.fromarray(source).save(path, format="JPEG2000", irreversible=False)
            payload = bytearray(path.read_bytes())
            marker = payload.index(b"\xff\x51")
            payload[marker + 40] = 8  # JPEG2000 stores precision minus one in Ssiz.
            path.write_bytes(payload)

            precision, signed, components = jp2_component_precision(path)

        self.assertEqual((precision, signed, components), (9, False, 1))

    def test_reads_siz_only_from_the_jp2c_box_not_a_spoofed_free_box(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "spoofed.jp2"
            path.write_bytes(
                JP2_SIGNATURE
                + jp2_box(b"free", siz_codestream(precision=3))
                + jp2_box(b"jp2c", siz_codestream(precision=12))
            )

            result = jp2_component_precision(path)

        self.assertEqual(result, (12, False, 1))

    def test_finds_jp2c_after_more_than_one_megabyte_of_metadata(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "large-metadata.jp2"
            path.write_bytes(
                JP2_SIGNATURE
                + jp2_box(b"free", b"metadata" + b"\x00" * (1024 * 1024))
                + jp2_box(b"jp2c", siz_codestream(precision=16))
            )

            result = jp2_component_precision(path)

        self.assertEqual(result, (16, False, 1))

    def test_reads_raw_jpeg2000_codestream(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "raw.j2k"
            path.write_bytes(siz_codestream(precision=10, components=3))

            result = jp2_component_precision(path)

        self.assertEqual(result, (10, False, 3))

    def test_rejects_spoofed_siz_when_container_has_no_jp2c_box(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "spoof-only.jp2"
            path.write_bytes(JP2_SIGNATURE + jp2_box(b"free", siz_codestream(precision=7)))

            with self.assertRaisesRegex(ValueError, "JP2 codestream box"):
                jp2_component_precision(path)

    def test_rejects_non_jpeg2000_content_renamed_as_jp2(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "fake.jp2"
            Image.new("L", (2, 2), 1).save(path, format="PNG")

            with self.assertRaisesRegex(ValueError, "not a JPEG2000"):
                decode_source(path, ".jp2")

    def test_decodes_sixteen_bit_jp2_with_linear_scaling_and_metadata(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "plane.jp2"
            source = np.array([[0, 32768, 65535]], dtype=np.uint16)
            Image.fromarray(source).save(path, format="JPEG2000", irreversible=False)

            decoded = decode_source(path, ".jp2")

        self.assertEqual(decoded.source_format, "JP2")
        self.assertEqual(decoded.significant_bits, 16)
        self.assertEqual(decoded.original_shape, (1, 3))
        self.assertEqual(decoded.original_axes, ("Y", "X"))
        self.assertEqual(decoded.selected_axes, ("Y", "X"))
        self.assertEqual(decoded.display.shape, (1, 3))
        np.testing.assert_array_equal(decoded.display, np.array([[0, 128, 255]], dtype=np.uint8))
        self.assertEqual(decoded.processing, "linear-16bit-to-8bit")
        self.assertEqual(
            metadata_headers(decoded),
            {
                "X-KidneyQuant-Source-Format": "JP2",
                "X-KidneyQuant-Original-Bit-Depth": "16",
                "X-KidneyQuant-Original-Shape": "1x3",
                "X-KidneyQuant-Original-Axes": "Y,X",
                "X-KidneyQuant-Selected-Shape": "1x3",
                "X-KidneyQuant-Selected-Axes": "Y,X",
                "X-KidneyQuant-Channel-Count": "1",
                "X-KidneyQuant-Plane-Selection": "{}",
                "X-KidneyQuant-Processing": "linear-16bit-to-8bit",
                "X-KidneyQuant-Quantitative-Status": "experimental",
            },
        )

    def test_rejects_multiplane_tiff_instead_of_silently_using_first_page(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "stack.tiff"
            import tifffile

            tifffile.imwrite(path, np.zeros((2, 3, 4), dtype=np.uint8), photometric="minisblack")

            with self.assertRaisesRegex(ValueError, "multiple planes"):
                decode_source(path, ".tiff")


class DecodeEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_cpu_decode_runs_off_the_event_loop(self) -> None:
        request = raw_request([b"not-used"])
        decoded = DecodedSource(
            display=np.zeros((1, 1), dtype=np.uint8),
            source_format="JP2",
            significant_bits=8,
            original_shape=(1, 1),
            original_axes=("Y", "X"),
            selected_shape=(1, 1),
            selected_axes=("Y", "X"),
            selection={},
            processing="native-8bit",
        )

        entered = threading.Event()
        release = threading.Event()

        def slow_decode(*_args: object) -> DecodedSource:
            entered.set()
            release.wait(timeout=1)
            return decoded

        with patch("main.decode_source", side_effect=slow_decode):
            task = asyncio.create_task(decode(request))
            while not entered.is_set():
                await asyncio.sleep(0.005)
            await asyncio.sleep(0.01)
            self.assertFalse(task.done(), "CPU decoder blocked the event loop instead of running in a worker thread")
            release.set()
            response = await task

        self.assertEqual(response.status_code, 200)

    async def test_jp2_response_exposes_processing_metadata(self) -> None:
        source = np.array([[0, 65535]], dtype=np.uint16)
        payload = BytesIO()
        Image.fromarray(source).save(payload, format="JPEG2000", irreversible=False)
        expected_hash = hashlib.sha256(payload.getvalue()).hexdigest()
        raw_payload = payload.getvalue()

        response = await decode(raw_request([raw_payload[:17], raw_payload[17:]]))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-kidneyquant-source-format"], "JP2")
        self.assertEqual(response.headers["x-kidneyquant-original-bit-depth"], "16")
        self.assertEqual(response.headers["x-kidneyquant-processing"], "linear-16bit-to-8bit")
        self.assertEqual(response.headers["x-kidneyquant-quantitative-status"], "experimental")
        self.assertEqual(response.headers["x-kidneyquant-source-sha256"], expected_hash)
        with Image.open(BytesIO(response.body)) as decoded_png:
            self.assertEqual(decoded_png.size, (2, 1))

    async def test_requires_an_allowlisted_file_extension_header(self) -> None:
        for extension, expected_status in ((None, 400), (".png", 415), ("../plane.jp2", 415)):
            with self.subTest(extension=extension):
                with self.assertRaises(HTTPException) as raised:
                    await decode(raw_request([b"image"], extension=extension))
                self.assertEqual(raised.exception.status_code, expected_status)
                self.assertIn("X-KidneyQuant-File-Extension", raised.exception.detail)

    async def test_requires_content_length_and_rejects_declared_oversize_before_upload(self) -> None:
        with self.assertRaises(HTTPException) as missing:
            await decode(raw_request([b"image"], content_length=False))
        self.assertEqual(missing.exception.status_code, 411)

        receive_started = threading.Event()
        with patch("main.MAX_UPLOAD_BYTES", 4):
            with self.assertRaises(HTTPException) as oversized:
                await decode(raw_request([b"image"], content_length=5, receive_started=receive_started))
        self.assertEqual(oversized.exception.status_code, 413)
        self.assertFalse(receive_started.is_set())

    async def test_enforces_streamed_cap_when_content_length_understates_the_body(self) -> None:
        with patch("main.MAX_UPLOAD_BYTES", 4):
            with self.assertRaises(HTTPException) as raised:
                await decode(raw_request([b"123", b"45"], content_length=4))

        self.assertEqual(raised.exception.status_code, 413)

    async def test_rejects_a_stream_length_that_does_not_match_content_length(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            await decode(raw_request([b"short"], content_length=6))

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("does not match", raised.exception.detail)

    async def test_uses_one_temp_file_for_the_stream_and_decoder(self) -> None:
        decoded = DecodedSource(
            display=np.zeros((1, 1), dtype=np.uint8),
            source_format="JP2",
            significant_bits=8,
            original_shape=(1, 1),
            original_axes=("Y", "X"),
            selected_shape=(1, 1),
            selected_axes=("Y", "X"),
            selection={},
            processing="native-8bit",
        )
        decoder_paths: list[Path] = []

        def inspect_decode(path: Path, _suffix: str) -> tuple[DecodedSource, bytes]:
            decoder_paths.append(path)
            self.assertEqual(path.read_bytes(), b"raw-image")
            return decoded, b"png"

        with (
            patch("main.tempfile.NamedTemporaryFile", wraps=tempfile.NamedTemporaryFile) as named_temporary_file,
            patch("main.decode_png", side_effect=inspect_decode),
        ):
            response = await decode(raw_request([b"raw-", b"image"]))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(named_temporary_file.call_count, 1)
        self.assertEqual(len(decoder_paths), 1)
        self.assertFalse(decoder_paths[0].exists())

    async def test_concurrency_one_holds_second_upload_until_first_decode_finishes(self) -> None:
        decoded = DecodedSource(
            display=np.zeros((1, 1), dtype=np.uint8),
            source_format="JP2",
            significant_bits=8,
            original_shape=(1, 1),
            original_axes=("Y", "X"),
            selected_shape=(1, 1),
            selected_axes=("Y", "X"),
            selection={},
            processing="native-8bit",
        )
        first_decode_started = threading.Event()
        release_first_decode = threading.Event()
        second_upload_started = threading.Event()
        decode_calls = 0
        call_lock = threading.Lock()

        def blocking_decode(*_args: object) -> tuple[DecodedSource, bytes]:
            nonlocal decode_calls
            with call_lock:
                decode_calls += 1
                call_number = decode_calls
            if call_number == 1:
                first_decode_started.set()
                release_first_decode.wait(timeout=2)
            return decoded, b"png"

        with (
            patch("main.DECODE_SEMAPHORE", asyncio.Semaphore(1)),
            patch("main.decode_png", side_effect=blocking_decode),
        ):
            first_task = asyncio.create_task(decode(raw_request([b"first"])))
            while not first_decode_started.is_set():
                await asyncio.sleep(0.005)
            second_task = asyncio.create_task(
                decode(raw_request([b"second"], receive_started=second_upload_started))
            )
            try:
                await asyncio.sleep(0.02)
                self.assertFalse(second_upload_started.is_set())
            finally:
                release_first_decode.set()
            first_response, second_response = await asyncio.gather(first_task, second_task)

        self.assertEqual((first_response.status_code, second_response.status_code), (200, 200))
        self.assertEqual(decode_calls, 2)


if __name__ == "__main__":
    unittest.main()


class NativeSampleTests(unittest.TestCase):
    def test_native_transport_preserves_sixteen_bit_neighbors_and_endianness(self):
        import gzip
        import tifffile
        from main import decode_samples
        values = np.array([[0, 1000, 1001, 65535]], dtype=np.uint16)
        with TemporaryDirectory() as directory:
            for byteorder in ("<", ">"):
                path = Path(directory) / "native.tif"
                tifffile.imwrite(path, values, byteorder=byteorder, photometric="minisblack")
                decoded, body = decode_samples(path, ".tif")
                restored = np.frombuffer(gzip.decompress(body), dtype="<u2").reshape(values.shape)
                np.testing.assert_array_equal(restored, values)
                self.assertEqual(decoded.significant_bits, 16)
                self.assertEqual(decoded.display.size, 0)

    def test_endpoint_negotiates_native_transport_and_preserves_metadata(self):
        import gzip
        import tifffile
        from fastapi.testclient import TestClient
        from main import app
        content = BytesIO()
        values = np.array([[1000, 1001, 65535]], dtype=np.uint16)
        tifffile.imwrite(content, values, photometric="minisblack")
        body = content.getvalue()
        with TestClient(app) as client:
            response = client.post("/decode", content=body, headers={
                "Content-Type": "application/octet-stream",
                "X-KidneyQuant-File-Extension": ".tif",
                "Accept": "application/vnd.kidneyquant.samples+gzip",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/vnd.kidneyquant.samples+gzip")
        self.assertEqual(response.headers["x-kidneyquant-processing"], "native-integer-samples")
        self.assertEqual(response.headers["x-kidneyquant-source-sha256"], hashlib.sha256(body).hexdigest())
        np.testing.assert_array_equal(np.frombuffer(gzip.decompress(response.content), dtype="<u2"), values.ravel())
