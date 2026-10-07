'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent,
} from 'react';
import {
  analyzeImage,
  decodeMicroscopyFile,
  type AnalysisResult,
  type DecodedImage,
  type RoiRect,
  type RoiPoint,
  type GlomerulusOutline,
} from './lib/image-analysis';
import {
  analysisRecordToCsv,
  buildAnalysisRecord,
  type AnalysisRecord,
  type AnalysisSettingsSnapshot,
} from './lib/analysis-record';
import { applyChannelViewInPlace, prepareMicroscopyFiles } from './lib/viewer-utils.mjs';

type ViewMode = 'overlay' | 'original' | 'mask';
type OutsideMode = 'exclude' | 'report';
type SignalChannel = 'red' | 'green' | 'blue' | 'grayscale';
type DisplayChannel = 'composite' | 'red' | 'green' | 'blue';

const SYNTHETIC_DEMO_NAME = 'synthetic-demo-tile.jpg';
const DISPLAY_CHANNELS: DisplayChannel[] = ['composite', 'red', 'green', 'blue'];
const SIGNAL_CHANNELS: { value: SignalChannel; label: string }[] = [
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'grayscale', label: 'Grayscale' },
];

const STAIN_OPTIONS = [
  'Sirius Red',
  'alpha-SMA (IF)',
  'Vimentin (IF)',
  'Lotus lectin / LTL (IF)',
  'PAS',
  'H&E — hematoxylin',
  'H&E — eosin',
];

const STRUCTURE_OPTIONS = [
  'Whole tissue',
  'Glomeruli',
  'Podocytes',
  'Proximal tubules',
  'All tubules',
  'Interstitial region',
];

const DEFAULT_THRESHOLDS: Record<string, [number, number]> = {
  'Sirius Red': [6, 255],
  'alpha-SMA (IF)': [40, 255],
  Vimentin: [40, 255],
  'Vimentin (IF)': [40, 255],
  'Lotus lectin / LTL (IF)': [40, 255],
  PAS: [10, 255],
  'H&E — hematoxylin': [70, 255],
  'H&E — eosin': [70, 255],
};

const DEFAULT_CHANNELS: Record<string, SignalChannel> = {
  'alpha-SMA (IF)': 'red',
  'Vimentin (IF)': 'red',
  'Lotus lectin / LTL (IF)': 'green',
};

function stripExtension(name: string) {
  return name.replace(/\.[^.]+$/, '');
}

function formatInteger(value: number) {
  return Math.round(value).toLocaleString('en-US');
}

function formatDecimal(value: number, digits = 2) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatBytes(value: number) {
  if (!value) return '0 B';
  if (value < 1_000_000) return `${(value / 1_000).toFixed(0)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function formatPlaneSelection(selection: DecodedImage['planeSelection']) {
  const entries = Object.entries(selection);
  return entries.length ? entries.map(([axis, value]) => `${axis}=${value}`).join(', ') : 'single image plane';
}

function stainScoreDescription(stain: string, signalChannel: SignalChannel) {
  if (stain === 'Sirius Red') return 'Score = clamp(R − (G + B) / 2), integer 0–255.';
  if (stain === 'PAS') return 'Score = clamp((R + B) / 2 − G), integer 0–255.';
  if (stain === 'H&E — hematoxylin') return 'Score = clamp(B − (R + G) / 2 + 64), integer 0–255.';
  if (stain === 'H&E — eosin') return 'Score = clamp((R + B) / 2 − G + 64), integer 0–255.';
  if (stain.includes('(IF)')) return signalChannel === 'grayscale'
    ? 'Score = mean of R, G, and B display components, integer 0–255.'
    : `Score = ${signalChannel} display component intensity, integer 0–255.`;
  return 'Score = mean of R, G, and B display components, integer 0–255.';
}

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error && value.message.trim() ? value.message : fallback;
}

function safeExportName(sampleId: string) {
  return sampleId.replace(/[^a-z0-9_-]+/gi, '_') || 'sample';
}

function downloadText(contents: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function availableDisplayChannels(image: DecodedImage | null): DisplayChannel[] {
  if (!image || image.channelCount >= 3) return DISPLAY_CHANNELS;
  if (image.channelCount === 2) return ['composite', 'red', 'green'];
  return ['composite'];
}

function availableSignalChannels(image: DecodedImage | null) {
  if (!image || image.channelCount >= 3) return SIGNAL_CHANNELS;
  if (image.channelCount === 2) return SIGNAL_CHANNELS.filter(({ value }) => value !== 'blue');
  return SIGNAL_CHANNELS.filter(({ value }) => value === 'grayscale');
}

function drawRoiOverlay(
  context: CanvasRenderingContext2D,
  imageWidth: number,
  rois: RoiRect[],
  draftRoi: RoiRect | null,
) {
  const visibleRois = draftRoi ? [...rois, draftRoi] : rois;
  context.save();
  context.strokeStyle = '#69a7ff';
  context.fillStyle = 'rgba(76, 139, 234, .12)';
  context.lineWidth = Math.max(2, imageWidth / 700);
  context.setLineDash([Math.max(5, imageWidth / 180), Math.max(4, imageWidth / 260)]);
  visibleRois.forEach((roi, index) => {
    context.fillRect(roi.x, roi.y, roi.width, roi.height);
    context.strokeRect(roi.x, roi.y, roi.width, roi.height);
    context.setLineDash([]);
    context.font = `700 ${Math.max(12, imageWidth / 85)}px Arial`;
    context.fillStyle = '#ddebff';
    context.fillText(`R${index + 1}`, roi.x + 6, Math.max(18, roi.y + 20));
    context.fillStyle = 'rgba(76, 139, 234, .12)';
    context.setLineDash([Math.max(5, imageWidth / 180), Math.max(4, imageWidth / 260)]);
  });
  context.restore();
}

export default function Workbench({ userName }: { userName: string }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const roisRef = useRef<RoiRect[]>([]);
  const glomeruliRef = useRef<GlomerulusOutline[]>([]);
  const draftOutlineRef = useRef<RoiPoint[] | null>(null);
  const [glomeruli, setGlomeruli] = useState<GlomerulusOutline[]>([]);
  const [drawingGlomeruli, setDrawingGlomeruli] = useState(false);
  const draftRoiRef = useRef<RoiRect | null>(null);
  const draftFrameRef = useRef<number | null>(null);
  const openRequestId = useRef(0);
  const analysisRequestId = useRef(0);
  const [sampleId, setSampleId] = useState('synthetic-demo-tile');
  const [sourceName, setSourceName] = useState(SYNTHETIC_DEMO_NAME);
  const [sourceSize, setSourceSize] = useState(0);
  const [sourceLastModified, setSourceLastModified] = useState(0);
  const [image, setImage] = useState<DecodedImage | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analysisRecord, setAnalysisRecord] = useState<AnalysisRecord | null>(null);
  const [stain, setStain] = useState('Sirius Red');
  const [signalChannel, setSignalChannel] = useState<SignalChannel>('red');
  const [structure, setStructure] = useState('Whole tissue');
  const [minThreshold, setMinThreshold] = useState(6);
  const [maxThreshold, setMaxThreshold] = useState(255);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [outsideMode, setOutsideMode] = useState<OutsideMode>('exclude');
  const [backgroundTolerance, setBackgroundTolerance] = useState(18);
  const [rois, setRois] = useState<RoiRect[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [view, setView] = useState<ViewMode>('overlay');
  const [loading, setLoading] = useState(true);
  const [draggingFile, setDraggingFile] = useState(false);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [folderIndex, setFolderIndex] = useState(0);
  const [displayChannel, setDisplayChannel] = useState<DisplayChannel>('composite');
  const [message, setMessage] = useState('Loading the bundled procedurally generated synthetic demo tile…');
  const [error, setError] = useState('');

  const initials = useMemo(
    () =>
      userName
        .split(/\s|@/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase() || 'KQ',
    [userName],
  );

  const invalidateAnalysis = useCallback(() => {
    analysisRequestId.current++;
    setResult(null);
    setAnalysisRecord(null);
    setError('');
    setMessage('Settings changed — rerun analysis');
    if (image) setLoading(false);
  }, [image]);

  const runAnalysis = useCallback(
    (decoded = image) => {
      if (!decoded) return;
      if (!['Whole tissue', 'Interstitial region', 'Glomeruli'].includes(structure) && rois.length === 0) {
        setResult(null);
        setAnalysisRecord(null);
        setError('No analyzable ROI is defined. Add at least one region, then rerun analysis.');
        return;
      }
      const settings: AnalysisSettingsSnapshot = {
        stain,
        signalChannel,
        minThreshold,
        maxThreshold,
        removeBackground,
        backgroundTolerance,
        outsideMode,
        structure,
        rois: rois.map((roi) => ({ ...roi })),
        glomeruli: glomeruli.map(({ points }) => ({ points: points.map(p => ({ ...p })) })),
      };
      const provenance = {
        analyst: userName,
        sampleId: sampleId.trim(),
        sourceName,
        sourceSize,
        sourceLastModified,
      };
      const requestId = ++analysisRequestId.current;
      setLoading(true);
      setError('');
      setResult(null);
      setAnalysisRecord(null);
      setMessage('Analyzing image…');
      // Two animation frames guarantee that the working state is painted before
      // the bounded synchronous analysis begins. Request IDs still discard stale work.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (requestId !== analysisRequestId.current) return;
          try {
            const nextResult = analyzeImage(decoded, settings);
            if (requestId !== analysisRequestId.current) return;
            const nextRecord = buildAnalysisRecord({
              ...provenance,
              analyzedAt: new Date().toISOString(),
              image: decoded,
              result: nextResult,
              settings,
            });
            setResult(nextResult);
            setAnalysisRecord(nextRecord);
            setMessage(
              settings.removeBackground && settings.outsideMode === 'report'
                ? 'Analysis complete. Tissue and outside-tissue values are shown separately.'
                : 'Analysis complete. Review the overlay before exporting.',
            );
          } catch (analysisError) {
            if (requestId === analysisRequestId.current) {
              setResult(null);
              setAnalysisRecord(null);
              setError(errorMessage(analysisError, 'The image could not be analyzed.'));
            }
          } finally {
            if (requestId === analysisRequestId.current) setLoading(false);
          }
        });
      });
    },
    [
      image, stain, signalChannel, minThreshold, maxThreshold, removeBackground, backgroundTolerance,
      outsideMode, structure, rois, glomeruli, userName, sampleId, sourceName, sourceSize, sourceLastModified,
    ],
  );

  const openFile = useCallback(async (file: File, demonstration = false, displayName = file.name) => {
    const requestId = ++openRequestId.current;
    analysisRequestId.current++;
    setLoading(true);
    setError('');
    setResult(null);
    setAnalysisRecord(null);
    setImage(null);
    setGlomeruli([]);
    glomeruliRef.current = [];
    draftOutlineRef.current = null;
    draftRoiRef.current = null;
    setDrawingGlomeruli(false);
    setDisplayChannel('composite');
    setSourceName(displayName);
    setSourceSize(file.size);
    setSourceLastModified(file.lastModified);
    setMessage(`Opening ${file.name}…`);
    try {
      const decoded = await decodeMicroscopyFile(file);
      if (requestId !== openRequestId.current) return;
      setImage(decoded);
      setSignalChannel((current) => {
        if (decoded.channelCount <= 1) return 'grayscale';
        return decoded.channelCount === 2 && current === 'blue' ? 'red' : current;
      });
      if (!demonstration) setSampleId(stripExtension(displayName).replaceAll('/', ' · '));
      setRois([]);
      if (demonstration) {
        setMessage(`Bundled ${SYNTHETIC_DEMO_NAME} ready — procedurally generated synthetic data; no specimen or acquisition. Demonstration only; not validated for quantitative use.`);
      } else {
        setMessage('Image ready. Adjust the settings, then analyze.');
      }
    } catch (openError) {
      if (requestId === openRequestId.current) {
        setError(`Could not decode ${displayName}: ${errorMessage(openError, 'The file could not be opened.')}`);
        setMessage('Choose another supported file or verify that the private image companion is healthy.');
      }
    } finally {
      if (requestId === openRequestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch(`/${SYNTHETIC_DEMO_NAME}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Reference request failed with HTTP ${response.status}.`);
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        return openFile(new File([blob], SYNTHETIC_DEMO_NAME, { type: 'image/jpeg', lastModified: 0 }), true);
      })
      .catch((referenceError) => {
        if (active) {
          setLoading(false);
          setError(`The bundled reference image could not be loaded: ${errorMessage(referenceError, 'Unknown decode error')}`);
        }
      });
    return () => {
      active = false;
    };
  }, [openFile]);

  const paintCanvas = useCallback((draftRoi = draftRoiRef.current) => {
    const canvas = canvasRef.current;
    const baseCanvas = baseCanvasRef.current;
    if (!canvas || !baseCanvas || canvas.width !== baseCanvas.width || canvas.height !== baseCanvas.height) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(baseCanvas, 0, 0);
    drawRoiOverlay(context, canvas.width, roisRef.current, draftRoi);
    context.save();
    context.strokeStyle = '#ffbf69';
    context.fillStyle = 'rgba(255, 191, 105, .15)';
    context.lineWidth = Math.max(2, canvas.width / 700);
    const outlines = [...glomeruliRef.current, ...(draftOutlineRef.current ? [{ points: draftOutlineRef.current }] : [])];
    outlines.forEach(({ points }, index) => {
      if (!points.length) return;
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach(p => context.lineTo(p.x, p.y));
      context.closePath();
      context.fill('evenodd');
      context.stroke();
      context.font = `700 ${Math.max(12, canvas.width / 85)}px Arial`;
      context.fillText(`G${index + 1}`, points[0].x, points[0].y);
    });
    context.restore();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const baseCanvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    baseCanvas.width = image.width;
    baseCanvas.height = image.height;
    const context = baseCanvas.getContext('2d');
    if (!context) return;

    // Build the expensive RGBA frame only when the image/view changes. ROI motion
    // redraws this cached canvas instead of cloning and rewriting every source pixel.
    const source = view === 'original' || !result ? image.rgba : result.displayRgba;
    const needsWorkingCopy = displayChannel !== 'composite' || Boolean(result && view !== 'original');
    let frame: ImageData;
    if (!needsWorkingCopy) {
      frame = new ImageData(source as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
    } else {
      // Never mutate arrays owned by image/result state. Transform an independent
      // buffer only when a channel or analysis overlay actually requires writes.
      const pixels = new Uint8ClampedArray(source);
      if (displayChannel !== 'composite') applyChannelViewInPlace(pixels, displayChannel);
      if (result && view !== 'original') {
        for (let i = 0; i < result.positiveMask.length; i++) {
          const p = i * 4;
          if (view === 'mask') {
            const selected = result.regionMask[i] === 1;
            const positive = result.positiveMask[i] === 1;
            pixels[p] = positive ? 207 : selected ? 235 : 28;
            pixels[p + 1] = positive ? 54 : selected ? 241 : 36;
            pixels[p + 2] = positive ? 112 : selected ? 237 : 32;
            pixels[p + 3] = 255;
          } else if (result.positiveMask[i]) {
            pixels[p] = Math.round(pixels[p] * 0.35 + 214 * 0.65);
            pixels[p + 1] = Math.round(pixels[p + 1] * 0.35 + 52 * 0.65);
            pixels[p + 2] = Math.round(pixels[p + 2] * 0.35 + 112 * 0.65);
          } else if (!result.tissueMask[i]) {
            pixels[p] = Math.round(pixels[p] * 0.28);
            pixels[p + 1] = Math.round(pixels[p + 1] * 0.28);
            pixels[p + 2] = Math.round(pixels[p + 2] * 0.28);
          }
        }
      }
      frame = new ImageData(pixels, image.width, image.height);
    }
    context.putImageData(frame, 0, 0);
    baseCanvasRef.current = baseCanvas;
    paintCanvas();
  }, [image, displayChannel, result, view, paintCanvas]);

  useEffect(() => {
    roisRef.current = rois;
    paintCanvas();
  }, [rois, paintCanvas]);

  useEffect(() => () => {
    if (draftFrameRef.current !== null) window.cancelAnimationFrame(draftFrameRef.current);
  }, []);

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const prepared = prepareMicroscopyFiles(files);
      if (!prepared.length) {
        setError('No ND2, TIFF, or JP2 files were found.');
        return;
      }
      setFolderFiles(prepared);
      setFolderIndex(0);
      const first = prepared[0];
      void openFile(first, false, first.webkitRelativePath || first.name);
    },
    [openFile],
  );

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) handleFiles(event.target.files);
    event.target.value = '';
  };

  const onFolderChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) handleFiles(event.target.files);
    event.target.value = '';
  };

  const openFolderFile = (index: number) => {
    const file = folderFiles[index];
    if (!file || loading) return;
    setFolderIndex(index);
    void openFile(file, false, file.webkitRelativePath || file.name);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDraggingFile(false);
    if (loading) return;
    handleFiles(event.dataTransfer.files);
  };

  const pointInImage = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!image) return { x: 0, y: 0 };
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(image.width, ((event.clientX - bounds.left) / bounds.width) * image.width)),
      y: Math.max(0, Math.min(image.height, ((event.clientY - bounds.top) / bounds.height) * image.height)),
    };
  };

  useEffect(() => {
    glomeruliRef.current = glomeruli;
    paintCanvas();
  }, [glomeruli, paintCanvas]);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (drawingGlomeruli && image) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      draftOutlineRef.current = [pointInImage(event)];
      paintCanvas();
      return;
    }
    if (!drawing || !image) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointInImage(event);
    draftRoiRef.current = { x: point.x, y: point.y, width: 0, height: 0 };
    paintCanvas();
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (drawingGlomeruli && draftOutlineRef.current) {
      const point = pointInImage(event);
      draftOutlineRef.current.push(point);
      paintCanvas();
      return;
    }
    const draftRoi = draftRoiRef.current;
    if (!drawing || !draftRoi) return;
    const point = pointInImage(event);
    draftRoiRef.current = { ...draftRoi, width: point.x - draftRoi.x, height: point.y - draftRoi.y };
    if (draftFrameRef.current === null) {
      draftFrameRef.current = window.requestAnimationFrame(() => {
        draftFrameRef.current = null;
        paintCanvas();
      });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (drawingGlomeruli && draftOutlineRef.current) {
      const points = [...draftOutlineRef.current, pointInImage(event)];
      draftOutlineRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      const area = Math.abs(points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + p.x * q.y - q.x * p.y;
      }, 0)) / 2;
      if (points.length >= 3 && area > 1) {
        glomeruliRef.current = [...glomeruliRef.current, { points }];
        setGlomeruli(glomeruliRef.current);
        invalidateAnalysis();
      }
      paintCanvas();
      return;
    }
    const draftRoi = draftRoiRef.current;
    if (!drawing || !draftRoi) return;
    const point = pointInImage(event);
    const finishedRoi = { ...draftRoi, width: point.x - draftRoi.x, height: point.y - draftRoi.y };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const normalized: RoiRect = {
      x: Math.round(finishedRoi.width < 0 ? finishedRoi.x + finishedRoi.width : finishedRoi.x),
      y: Math.round(finishedRoi.height < 0 ? finishedRoi.y + finishedRoi.height : finishedRoi.y),
      width: Math.round(Math.abs(finishedRoi.width)),
      height: Math.round(Math.abs(finishedRoi.height)),
    };
    draftRoiRef.current = null;
    if (draftFrameRef.current !== null) {
      window.cancelAnimationFrame(draftFrameRef.current);
      draftFrameRef.current = null;
    }
    if (normalized.width > 5 && normalized.height > 5) {
      const nextRois = [...roisRef.current, normalized];
      roisRef.current = nextRois;
      setRois(nextRois);
      invalidateAnalysis();
    }
    paintCanvas(null);
  };

  const onPointerCancel = () => {
    draftOutlineRef.current = null;
    draftRoiRef.current = null;
    if (draftFrameRef.current !== null) {
      window.cancelAnimationFrame(draftFrameRef.current);
      draftFrameRef.current = null;
    }
    paintCanvas(null);
  };

  const addCentralRoi = () => {
    if (!image) return;
    const width = Math.max(1, Math.round(image.width * 0.25));
    const height = Math.max(1, Math.round(image.height * 0.25));
    setRois((current) => [
      ...current,
      { x: Math.round((image.width - width) / 2), y: Math.round((image.height - height) / 2), width, height },
    ]);
    invalidateAnalysis();
  };

  const updateRoi = (index: number, field: keyof RoiRect, value: number) => {
    if (!image || !Number.isFinite(value)) return;
    setRois((current) => current.map((roi, roiIndex) => {
      if (roiIndex !== index) return roi;
      const next = { ...roi };
      if (field === 'x') {
        next.x = Math.max(0, Math.min(image.width, value));
        next.width = Math.min(next.width, image.width - next.x);
      } else if (field === 'y') {
        next.y = Math.max(0, Math.min(image.height, value));
        next.height = Math.min(next.height, image.height - next.y);
      } else if (field === 'width') {
        next.width = Math.max(0, Math.min(image.width - next.x, value));
      } else {
        next.height = Math.max(0, Math.min(image.height - next.y, value));
      }
      return next;
    }));
    invalidateAnalysis();
  };

  const deleteRoi = (index: number) => {
    setRois((current) => current.filter((_, roiIndex) => roiIndex !== index));
    invalidateAnalysis();
  };

  const chooseStain = (value: string) => {
    const [minimum, maximum] = DEFAULT_THRESHOLDS[value] ?? [0, 255];
    setStain(value);
    setSignalChannel(DEFAULT_CHANNELS[value] ?? 'red');
    setMinThreshold(minimum);
    setMaxThreshold(maximum);
    invalidateAnalysis();
  };

  const chooseStructure = (value: string) => {
    onPointerCancel();
    setStructure(value);
    setRois([]);
    setDrawing(!['Whole tissue', 'Glomeruli'].includes(value));
    setDrawingGlomeruli(value === 'Glomeruli');
    invalidateAnalysis();
  };

  const chooseDisplayChannel = (channel: DisplayChannel) => {
    setDisplayChannel(channel);
  };

  const toggleDrawing = () => {
    if (drawing) onPointerCancel();
    setDrawingGlomeruli(false);
    setDrawing(!drawing);
  };

  const exportCsv = () => {
    if (!analysisRecord) return;
    downloadText(
      analysisRecordToCsv(analysisRecord),
      'text/csv;charset=utf-8',
      `${safeExportName(analysisRecord.sampleId)}_quantification.csv`,
    );
  };

  const exportJson = () => {
    if (!analysisRecord) return;
    downloadText(
      `${JSON.stringify(analysisRecord, null, 2)}\n`,
      'application/json;charset=utf-8',
      `${safeExportName(analysisRecord.sampleId)}_quantification.json`,
    );
  };

  const metrics = analysisRecord?.metrics;
  const displayChannels = availableDisplayChannels(image);
  const signalChannels = availableSignalChannels(image);
  const channelMappingDisclosure = image?.channelCount === 2
    ? 'Two source channels mapped: channel 1 → display R and channel 2 → display G. No Blue source channel is present.'
    : image?.channelCount === 1
      ? 'One source channel is rendered as a grayscale composite.'
      : '';

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><span /></span><div><p>KidneyQuant</p><span>stain analysis workbench</span></div></div>
        <div className="privacy-state"><i /> {image ? `Source processing: ${image.processingLocation === 'browser' ? 'this browser' : 'private companion'}` : 'Source processing location pending'}</div>
        <div className="profile" title={userName}>{initials}</div>
      </header>

      <section className="workspace-heading">
        <div><p className="eyebrow">New analysis</p><h1>Turn stained tissue into auditable measurements.</h1><p className="lede">Upload a microscopy image, separate tissue from slide background, select any structure-specific regions, then review every counted pixel.</p></div>
        <div className="format-badges"><span>TIFF</span><span>JP2</span><span>ND2 self-host</span><span>Folders</span></div>
      </section>

      <section className="workbench-grid">
        <aside className="control-panel">
          <div className="panel-title"><span>01</span><div><h2>Set up analysis</h2><p>Sample and staining details</p></div></div>
          <label className="field-label" htmlFor="sample-id">Sample ID <b>required</b></label>
          <input id="sample-id" className="text-input" value={sampleId} onChange={(event) => { setSampleId(event.target.value); invalidateAnalysis(); }} />

          <label className="field-label" htmlFor="stain">Staining</label>
          <select id="stain" className="select-input" value={stain} onChange={(event) => chooseStain(event.target.value)}>{STAIN_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select>

          {stain.includes('(IF)') && <><label className="field-label" htmlFor="signal-channel">Positive signal channel</label><select id="signal-channel" className="select-input" value={signalChannel} onChange={(event) => { setSignalChannel(event.target.value as SignalChannel); invalidateAnalysis(); }}>{signalChannels.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></>}

          <label className="field-label" htmlFor="roi-category">ROI category</label>
          <select id="roi-category" className="select-input" value={structure} onChange={(event) => chooseStructure(event.target.value)}>{STRUCTURE_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select>
          <p className="validation-note">ROI categories label analyst-defined regions; they do not segment or identify anatomy.</p>

          {structure !== 'Whole tissue' && structure !== 'Glomeruli' && <>
            <div className="roi-controls">
              <button type="button" disabled={!image} onClick={addCentralRoi}>Add region</button>
              <button type="button" className={drawing ? 'active' : ''} disabled={!image} aria-pressed={drawing} onClick={toggleDrawing}>{drawing ? 'Drawing regions' : 'Draw regions'}</button>
              <button type="button" disabled={!rois.length} onClick={() => { setRois([]); invalidateAnalysis(); }}>Clear ({rois.length})</button>
            </div>
            {rois.length > 0 && <div className="roi-editor" aria-label="ROI coordinate editor">
              {rois.map((roi, index) => <div className="roi-row" key={index}>
                <strong>R{index + 1}</strong>
                {(['x', 'y', 'width', 'height'] as const).map((field) => <label className="roi-coordinate" key={field}>
                  <span>{field}</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    aria-label={`Region ${index + 1} ${field}`}
                    value={Math.round(roi[field])}
                    onChange={(event) => updateRoi(index, field, Number(event.target.value))}
                  />
                </label>)}
                <button className="roi-delete" type="button" aria-label={`Delete region ${index + 1}`} onClick={() => deleteRoi(index)}>Delete</button>
              </div>)}
            </div>}
          </>}

          {['Glomeruli', 'Interstitial region'].includes(structure) && <>
            <p className="validation-note">{structure === 'Glomeruli' ? 'One pooled positive-area result per tile across all outlined glomeruli. Overlaps count once.' : 'Outlined glomeruli are excluded from positive and analyzed area. With no rectangular regions, measure the whole tissue outside glomeruli.'}</p>
            <div className="roi-controls">
              <button type="button" disabled={!image} aria-pressed={drawingGlomeruli} className={drawingGlomeruli ? 'active' : ''} onClick={() => { onPointerCancel(); setDrawing(false); setDrawingGlomeruli(!drawingGlomeruli); }}>{drawingGlomeruli ? 'Stop outlining' : 'Outline glomeruli'}</button>
              <button type="button" disabled={!glomeruli.length} onClick={() => { onPointerCancel(); setGlomeruli([]); invalidateAnalysis(); }}>Clear glomeruli ({glomeruli.length})</button>
            </div>
            <p className="validation-note">Drag around each glomerulus, then release to close its outline. Outlines are kept when switching measurement categories within this tile.</p>
            {glomeruli.map((_, index) => <div key={index} className="roi-row"><strong>G{index + 1}</strong><button type="button" onClick={() => { setGlomeruli(current => current.filter((_, i) => i !== index)); invalidateAnalysis(); }}>Delete outline</button></div>)}
          </>}

          <div className="switch-row"><div><strong>Remove slide background</strong><span>Border-connected source-RGB distance mask</span></div><button type="button" className={`toggle ${removeBackground ? 'active' : ''}`} aria-label="Remove slide background" aria-pressed={removeBackground} onClick={() => { setRemoveBackground((current) => !current); invalidateAnalysis(); }}><i /></button></div>

          {removeBackground && <><label className="field-label compact" htmlFor="outside-mode">Outside-tissue handling</label><select id="outside-mode" className="select-input" value={outsideMode} onChange={(event) => { setOutsideMode(event.target.value as OutsideMode); invalidateAnalysis(); }}><option value="exclude">Exclude from calculations</option><option value="report">Exclude and report separately</option></select><label className="field-label compact" htmlFor="background-tolerance">Background tolerance <span>{backgroundTolerance}</span></label><input id="background-tolerance" className="single-range" type="range" min="4" max="60" value={backgroundTolerance} onChange={(event) => { setBackgroundTolerance(Number(event.target.value)); invalidateAnalysis(); }} /></>}

          <div className="threshold-card"><div className="threshold-title"><strong>Positive stain threshold</strong><span>Manual</span></div><label htmlFor="minimum-threshold">Minimum <b>{minThreshold}</b></label><input id="minimum-threshold" className="single-range berry" type="range" min="0" max="255" value={minThreshold} onChange={(event) => { setMinThreshold(Math.min(Number(event.target.value), maxThreshold)); invalidateAnalysis(); }} /><label htmlFor="maximum-threshold">Maximum <b>{maxThreshold}</b></label><input id="maximum-threshold" className="single-range berry" type="range" min="0" max="255" value={maxThreshold} onChange={(event) => { setMaxThreshold(Math.max(Number(event.target.value), minThreshold)); invalidateAnalysis(); }} /></div>
          <p className="validation-note">{stainScoreDescription(stain, signalChannel)}</p>

          <button type="button" className="primary-button" disabled={!image || loading || !sampleId.trim()} onClick={() => runAnalysis()}>{loading ? 'Working…' : 'Analyze image'} <span>→</span></button>
          <p className="validation-note">Research-use workflow. Thresholds and ROI regions must be reviewed before statistical analysis.</p>
        </aside>

        <section className="image-stage" aria-busy={loading}>
          <div className="stage-toolbar">
            <div className="file-chip" title={sourceName}><i /> {sourceName} <span>{formatBytes(sourceSize)}</span></div>
            {folderFiles.length > 1 && <div className="folder-nav" aria-label="Folder image navigation"><button type="button" aria-label="Previous file" disabled={loading || folderIndex === 0} onClick={() => openFolderFile(folderIndex - 1)}>‹</button><span>{folderIndex + 1} / {folderFiles.length}</span><button type="button" aria-label="Next file" disabled={loading || folderIndex === folderFiles.length - 1} onClick={() => openFolderFile(folderIndex + 1)}>›</button></div>}
            <div className="view-tabs" aria-label="Image view">{(['overlay', 'original', 'mask'] as ViewMode[]).map((option) => <button key={option} type="button" aria-pressed={view === option} className={view === option ? 'active' : ''} onClick={() => setView(option)}>{option}</button>)}</div>
            <div className="open-actions"><button className="replace-button" type="button" disabled={loading} onClick={() => fileInput.current?.click()}>Open file</button><button className="replace-button" type="button" disabled={loading} onClick={() => folderInput.current?.click()}>Open folder</button></div>
            <input ref={fileInput} type="file" accept=".nd2,.tif,.tiff,.jp2,.j2k,.jpx" hidden onChange={onFileChange} />
            <input ref={folderInput} type="file" accept=".nd2,.tif,.tiff,.jp2,.j2k,.jpx" multiple hidden onChange={onFolderChange} {...{ webkitdirectory: '', directory: '' }} />
          </div>

          {image && <div className="channel-bar" aria-label="Image display channels"><b aria-hidden="true">C</b>{displayChannels.map((channel) => <button key={channel} type="button" disabled={loading} aria-label={`${channel} channel view`} aria-pressed={displayChannel === channel} className={displayChannel === channel ? 'active' : ''} onClick={() => chooseDisplayChannel(channel)}>{channel === 'composite' ? 'Composite' : channel[0].toUpperCase()}</button>)}{channelMappingDisclosure && <span className="channel-mapping">{channelMappingDisclosure}</span>}</div>}

          <div className={`image-canvas ${draggingFile ? 'dragging' : ''} ${drawing || drawingGlomeruli ? 'drawing' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDraggingFile(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDraggingFile(false)} onDrop={onDrop}>
            {image && <canvas ref={canvasRef} aria-label="Microscopy image analysis preview" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} />}
            {!image && <div className="empty-canvas"><strong>No image open</strong><span>Choose a TIFF, JP2, ND2 file, or folder.</span></div>}
            {(draggingFile || !image) && <button type="button" className="central-dropzone" disabled={loading} onClick={() => fileInput.current?.click()}><strong>Drop ND2, TIFF, or JP2</strong><span>or choose a file</span></button>}
            {image && <button type="button" className="dropzone" onClick={() => fileInput.current?.click()}><strong>Drop ND2, TIFF, or JP2</strong><span>or choose a file</span></button>}
            {(drawing || drawingGlomeruli) && <div className="drawing-hint">{drawingGlomeruli ? 'Drag around a glomerulus; release to close' : 'Drag on the image to add a region'}</div>}
            <div className="legend"><span><i className="positive" /> Positive stain</span><span><i className="structure" /> Selected region</span><span><i style={{ background: '#ffbf69' }} /> Glomerular outlines</span><span><i className="excluded" /> Excluded</span></div>
          </div>

          <div className={`analysis-message ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}><i>{error ? '!' : loading ? '…' : analysisRecord ? '✓' : 'i'}</i><span>{error || message}</span></div>
          <div className="stage-caption">
            <span>{image ? `${image.width.toLocaleString()} × ${image.height.toLocaleString()} px` : '—'}</span>
            <span>{image ? `Source: ${image.sourceFormat}` : '—'}</span>
            <span>{image ? `Source bit depth: ${image.bitDepth}-bit` : '—'}</span>
            <span>{image ? `Original shape: ${image.originalShape}` : '—'}</span>
            <span>{image ? `Original axes: ${image.originalAxes.join(', ')}` : '—'}</span>
            <span>{image ? `Selected shape: ${image.selectedShape}` : '—'}</span>
            <span>{image ? `Selected axes: ${image.selectedAxes.join(', ')}` : '—'}</span>
            <span>{image ? `Plane selection: ${formatPlaneSelection(image.planeSelection)}` : '—'}</span>
            <span>{image ? `Processing: ${image.processing} (${image.processingLocation})` : '—'}</span>
            <span>{removeBackground ? 'Background separation on' : 'Background included'}</span>
          </div>
          {image && <p className="validation-note" style={{ padding: '0 15px 12px', margin: 0 }}>
            {image.quantitativeStatus === 'demonstration'
              ? `Bundled ${SYNTHETIC_DEMO_NAME} is procedurally generated synthetic data with no specimen or acquisition. Demonstration only; measurements are experimental and not validated.`
              : 'Experimental quantification only — source processing, stain scoring, and thresholds are not validated.'}
          </p>}
        </section>

        <aside className="results-panel">
          <div className="panel-title"><span>02</span><div><h2>Review result</h2><p>{analysisRecord ? 'Finalized measurement snapshot' : 'Awaiting analysis'}</p></div></div>
          <div className="primary-metric"><span>Threshold-positive fraction</span><strong>{metrics ? formatDecimal(metrics.positivePercent) : '—'}{metrics && <small>%</small>}</strong><p>{structure === 'Glomeruli' ? 'of pooled analyzed pixels across all outlined glomeruli in this tile' : structure === 'Interstitial region' ? 'of analyzed tissue pixels outside outlined glomeruli' : 'of all analyzed pixels in the selected ROI category'}</p></div>
          <div className="sample-summary"><span>Sample ID</span><strong>{analysisRecord?.sampleId || sampleId || 'Required'}</strong></div>
          <dl className="metric-list">
            <div><dt>Analyzed area (ROI/tissue mask)</dt><dd>{metrics ? `${formatInteger(metrics.analyzedPixels)} px²` : '—'}</dd></div>
            <div><dt>Positive area (threshold-positive)</dt><dd>{metrics ? `${formatInteger(metrics.positivePixels)} px²` : '—'}</dd></div>
            <div><dt>Mean score (all analyzed pixels)</dt><dd>{metrics ? formatDecimal(metrics.meanScoreAllAnalyzedPixels) : '—'}</dd></div>
            <div><dt>Mode score (all analyzed pixels)</dt><dd>{metrics ? metrics.modeScoreAllAnalyzedPixels : '—'}</dd></div>
            <div><dt>Score range (all analyzed pixels)</dt><dd>{metrics ? `${metrics.minScoreAllAnalyzedPixels} / ${metrics.maxScoreAllAnalyzedPixels}` : '—'}</dd></div>
            <div><dt>Grid perimeter (positive-mask edges)</dt><dd>{metrics ? `${formatInteger(metrics.gridPerimeterPixelEdges)} pixel edges` : '—'}</dd></div>
            <div><dt>Score sum (all analyzed pixels)</dt><dd>{metrics ? formatInteger(metrics.scoreSumAllAnalyzedPixels) : '—'}</dd></div>
            <div><dt>Inclusive score threshold</dt><dd>{analysisRecord ? `${analysisRecord.analysis.minThreshold} — ${analysisRecord.analysis.maxThreshold}` : '—'}</dd></div>
          </dl>
          {analysisRecord && analysisRecord.analysis.removeBackground && analysisRecord.analysis.outsideMode === 'report' && analysisRecord.metrics.backgroundPixels !== undefined && analysisRecord.metrics.backgroundPositivePercent !== undefined && <div className="background-report"><span>Outside tissue (reported separately)</span><strong>{formatInteger(analysisRecord.metrics.backgroundPixels)} px²</strong><small>{formatDecimal(analysisRecord.metrics.backgroundPositivePercent)}% threshold-positive</small></div>}
          <div className={`quality-card ${!analysisRecord ? 'neutral' : ''}`}><i>{analysisRecord ? '✓' : 'i'}</i><div><strong>{analysisRecord ? 'Mask ready for review' : 'No finalized result yet'}</strong><span>{analysisRecord ? `${formatDecimal(analysisRecord.metrics.excludedPercent, 1)}% slide/background excluded` : 'Open an image and run analysis'}</span></div></div>
          <button type="button" className="export-button" disabled={!analysisRecord} onClick={exportCsv}>Export CSV</button>
          <button type="button" className="export-button" disabled={!analysisRecord} onClick={exportJson}>Export JSON</button>
          <p className="calibration-note">Area uses pixels; grid perimeter uses positive-mask pixel edges. No spatial calibration is applied.</p>
        </aside>
      </section>
    </main>
  );
}
