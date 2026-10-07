import { nativePixels } from './native-pixels.ts';
import { companionPixelDimensions, companionRequired, parseCompanionError, parseCompanionMetadata } from './decode-metadata.mjs';

export type DecodedImage = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  samples?: Uint8Array | Uint16Array;
  pixelSizeMicrons?: number[];
  analysisBitDepth?: number;
  analysisWorkflow?: 'fluorescence-8bit' | 'sirius-magenta';
  conversionRanges?: {minimum:number;maximum:number}[];
  bitDepth: number;
  sourceFormat: string;
  originalShape: string;
  originalAxes: string[];
  selectedShape: string;
  selectedAxes: string[];
  channelCount: number;
  channelMapping?: { method: string; sourceIndices: number[]; sourceNames: string[] };
  planeSelection: Record<string, number | string>;
  processing: string;
  processingLocation: 'browser' | 'private companion';
  quantitativeStatus: 'experimental' | 'demonstration';
  sourceSha256: string;
};

export type RoiRect = { x: number; y: number; width: number; height: number; points?: {x:number;y:number}[] };

export type AnalysisOptions = {
  stain: string;
  signalChannel: 'red' | 'green' | 'blue' | 'grayscale';
  minThreshold: number;
  maxThreshold: number;
  removeBackground: boolean;
  backgroundTolerance: number;
  outsideMode: 'exclude' | 'report';
  structure: string;
  rois: RoiRect[];
};

export type AnalysisResult = {
  analyzedPixels: number;
  positivePixels: number;
  positivePercent: number;
  mean: number;
  mode: number;
  min: number;
  max: number;
  perimeter: number;
  rawIntDen: number;
  positiveMean?: number;
  positiveStdDev?: number;
  positiveSum?: number;
  positiveMin?: number;
  positiveMax?: number;
  backgroundPixels: number;
  backgroundPositivePixels: number;
  backgroundPositivePercent: number;
  excludedPercent: number;
  tissueMask: Uint8Array;
  regionMask: Uint8Array;
  positiveMask: Uint8Array;
  displayRgba: Uint8ClampedArray;
};

const MAX_BROWSER_PIXELS = 8_000_000;
const MAX_BROWSER_LOCAL_FILE_BYTES = 128 * 1024 * 1024;
const MAX_COMPANION_FILE_BYTES = 512 * 1024 * 1024;

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export function tiffDimensions(ifd: { t256?: number[]; t257?: number[] }) {
  const width = Number(ifd.t256?.[0]);
  const height = Number(ifd.t257?.[0]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('The TIFF has invalid dimensions.');
  }
  return { width, height };
}

type BrowserTiffIfd = {
  t258?: number[];
  t259?: number[];
  t262?: number[];
  t277?: number[];
  t284?: number[];
  t339?: number[];
  data?: Uint8Array;
  isLE?: boolean;
};

export function tiffMetadata(ifd: BrowserTiffIfd) {
  const channelCount = Number(ifd.t277?.[0] ?? 1);
  const bitValues = (ifd.t258?.length ? ifd.t258 : [8]).map(Number);
  const uniqueBits = new Set(bitValues);
  if (uniqueBits.size !== 1) throw new Error('TIFF samples with mixed bit depth are not supported.');
  const bitDepth = bitValues[0];
  if (![8, 16].includes(bitDepth)) throw new Error(`Unsupported TIFF bit depth: ${bitDepth}. Use unsigned 8- or 16-bit TIFF.`);

  const sampleFormats = (ifd.t339?.length ? ifd.t339 : [1]).map(Number);
  if (sampleFormats.some((value) => value !== 1)) {
    throw new Error('Signed and floating-point TIFF values are not supported for quantitative analysis.');
  }
  if (Number(ifd.t284?.[0] ?? 1) !== 1) {
    throw new Error('Planar-separate RGB TIFF is not supported. Convert it to interleaved RGB first.');
  }
  if (Number(ifd.t259?.[0] ?? 1) !== 1) {
    throw new Error('Only uncompressed TIFF is supported in the browser. Export an uncompressed plane first.');
  }
  const photometric = Number(ifd.t262?.[0] ?? 1);
  if (!((photometric === 1 && channelCount === 1) || (photometric === 2 && channelCount === 3))) {
    throw new Error('Only unsigned BlackIsZero grayscale or interleaved RGB TIFF is supported.');
  }
  return { bitDepth, channelCount };
}

export function tiffRgbaFromDecoded(
  ifd: Pick<BrowserTiffIfd, 'data' | 'isLE'>,
  width: number,
  height: number,
  bitDepth: number,
  channelCount: number,
) {
  const data = ifd.data;
  if (!(data instanceof Uint8Array)) throw new Error('The TIFF decoder did not return unsigned sample bytes.');
  const bytesPerSample = bitDepth / 8;
  const expectedBytes = width * height * channelCount * bytesPerSample;
  if (data.byteLength !== expectedBytes) {
    throw new Error(`Decoded TIFF sample length ${data.byteLength} does not match expected length ${expectedBytes}.`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const read = bitDepth === 8
    ? (sample: number) => data[sample]
    : (sample: number) => {
        // UTIF.decodeImage normalizes decoded 16-bit sample bytes to
        // little-endian regardless of the source TIFF byte order.
        const value = view.getUint16(sample * 2, true);
        return Math.floor((value * 255 + 32767) / 65535);
      };
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = pixel * channelCount;
    const target = pixel * 4;
    const red = read(source);
    rgba[target] = red;
    rgba[target + 1] = channelCount === 1 ? red : read(source + 1);
    rgba[target + 2] = channelCount === 1 ? red : read(source + 2);
    rgba[target + 3] = 255;
  }
  return rgba;
}

export async function decodeMicroscopyFile(file: File, signal?: AbortSignal): Promise<DecodedImage> {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  const requiresCompanion = companionRequired(file.name);
  const fileLimit = requiresCompanion ? MAX_COMPANION_FILE_BYTES : MAX_BROWSER_LOCAL_FILE_BYTES;
  if (file.size > fileLimit) {
    const limitMb = fileLimit / (1024 * 1024);
    throw new Error(`The file exceeds the ${limitMb} MB ${requiresCompanion ? 'companion' : 'browser-local'} safety limit.`);
  }
  if (requiresCompanion) {
    return decodeWithCompanion(file, signal);
  }

  const browserLocalSupported = extension === 'tif' || extension === 'tiff' || file.name === 'synthetic-demo-tile.jpg';
  if (!browserLocalSupported) {
    throw new Error(`Unsupported image extension: .${extension || 'unknown'}. Use unsigned grayscale/RGB TIFF, JP2, J2K, JPX, or ND2.`);
  }
  const buffer = await file.arrayBuffer();
  const sourceSha256 = await sha256Hex(buffer);
  if (extension === 'tif' || extension === 'tiff') return decodeTiff(buffer, sourceSha256);
  return decodeBrowserImage(file, sourceSha256);
}

async function decodeWithCompanion(file: File, signal?: AbortSignal): Promise<DecodedImage> {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  let response: Response;
  try {
    response = await fetch('/api/decode', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/octet-stream',
        'accept': 'application/vnd.kidneyquant.samples+gzip',
        'x-kidneyquant-file-extension': `.${extension}`,
      },
      body: file,
    });
  } catch {
    throw new Error('The private image companion could not be reached. TIFF files can still be opened in the browser.');
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string; detail?: string } | null;
    throw new Error(
      parseCompanionError(detail) ??
        'The companion could not decode this file. Review the source format, dimensions, and bit depth.',
    );
  }
  const metadata = parseCompanionMetadata(response.headers);
  const expected = companionPixelDimensions(metadata);
  validateDimensions(expected.width, expected.height);
  let decoded: Pick<DecodedImage, 'width' | 'height' | 'rgba' | 'samples' | 'analysisBitDepth'>;
  if (response.headers.get('content-type')?.split(';')[0] === 'application/vnd.kidneyquant.samples+gzip') {
    if (!response.body || metadata.processing !== 'native-integer-samples'
      || metadata.selectedAxes[0] !== 'Y' || metadata.selectedAxes[1] !== 'X') {
      throw new Error('The companion returned invalid native pixel metadata.');
    }
    const raw = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    decoded = { ...expected, ...nativePixels(raw, expected.width, expected.height, metadata.channelCount, metadata.originalBitDepth) };
  } else {
    if (metadata.originalBitDepth !== 8) {
      throw new Error('Update the private image companion to preserve native intensities for high-bit-depth thresholding.');
    }
    const png = await response.blob();
    decoded = await decodeBrowserImage(new File([png], `${file.name}.png`, { type: 'image/png' }), metadata.sourceSha256);
    if (decoded.width !== expected.width || decoded.height !== expected.height) {
      throw new Error('Companion PNG dimensions contradict selected metadata.');
    }
  }
  return {
    ...decoded,
    bitDepth: metadata.originalBitDepth,
    sourceFormat: metadata.sourceFormat,
    originalShape: metadata.originalShape,
    originalAxes: metadata.originalAxes,
    selectedShape: metadata.selectedShape,
    selectedAxes: metadata.selectedAxes,
    channelCount: metadata.channelCount,
    channelMapping: metadata.channelMapping,
    pixelSizeMicrons: metadata.channelMapping?.pixelSizeMicrons,
    planeSelection: metadata.planeSelection,
    processing: metadata.processing,
    processingLocation: metadata.processingLocation,
    quantitativeStatus: metadata.quantitativeStatus,
    sourceSha256: metadata.sourceSha256,
  };
}

async function decodeTiff(buffer: ArrayBuffer, sourceSha256: string): Promise<DecodedImage> {
  const utifModule = await import('utif');
  const UTIF = utifModule.default ?? utifModule;
  const ifds = UTIF.decode(buffer);
  if (!ifds.length) throw new Error('No image plane was found in this TIFF.');
  if (ifds.length !== 1) throw new Error(`This TIFF contains ${ifds.length} planes. Export one plane before analysis.`);
  const ifd = ifds[0];
  const { width, height } = tiffDimensions(ifd);
  validateDimensions(width, height);
  const { bitDepth, channelCount } = tiffMetadata(ifd);

  UTIF.decodeImage(buffer, ifd);
  const data = ifd.data;
  if (!(data instanceof Uint8Array)) throw new Error('The TIFF decoder did not return unsigned sample bytes.');
  const native = nativePixels(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, width, height, channelCount, bitDepth);
  const shape = channelCount > 1 ? `${height}x${width}x${channelCount}` : `${height}x${width}`;
  return {
    width,
    height,
    ...native,
    bitDepth,
    sourceFormat: 'TIFF',
    originalShape: shape,
    originalAxes: channelCount > 1 ? ['Y', 'X', 'S'] : ['Y', 'X'],
    selectedShape: shape,
    selectedAxes: channelCount > 1 ? ['Y', 'X', 'S'] : ['Y', 'X'],
    channelCount,
    planeSelection: {},
    processing: bitDepth === 8 ? 'native-8bit' : 'native-integer-samples',
    processingLocation: 'browser',
    quantitativeStatus: 'experimental',
    sourceSha256,
  };
}

async function decodeBrowserImage(file: File, knownSourceSha256?: string): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(file);
  validateDimensions(bitmap.width, bitmap.height);
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new Error('The browser could not create an image canvas.');
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  const shape = `${canvas.height}x${canvas.width}x3`;
  const sourceSha256 = knownSourceSha256 ?? await sha256Hex(await file.arrayBuffer());
  return {
    width: canvas.width,
    height: canvas.height,
    rgba,
    bitDepth: 8,
    sourceFormat: file.type || 'Image',
    originalShape: shape,
    originalAxes: ['Y', 'X', 'S'],
    selectedShape: shape,
    selectedAxes: ['Y', 'X', 'S'],
    channelCount: 3,
    planeSelection: {},
    processing: 'native-8bit',
    processingLocation: 'browser',
    quantitativeStatus: 'demonstration',
    sourceSha256,
  };
}

function validateDimensions(width: number, height: number) {
  if (!width || !height) throw new Error('The image dimensions are invalid.');
  if (width * height > MAX_BROWSER_PIXELS) {
    throw new Error(
      `This image contains ${(width * height / 1_000_000).toFixed(1)} million pixels. The interactive limit is 8 million pixels per plane; use tiled images.`,
    );
  }
}

export function thresholdMaximum(image: DecodedImage | null): number {
  if(image?.analysisWorkflow === 'sirius-magenta') return 1;
  return image?.samples && image.analysisBitDepth === 16 ? 65535 : 255;
}

export function analyzeImage(image: DecodedImage, options: AnalysisOptions): AnalysisResult {
  const { width, height, rgba } = image;
  const length = width * height;
  const displayRgba = makeDisplayRgba(rgba, length);
  const backgroundMask = options.removeBackground
    ? findConnectedBackground(rgba, width, height, options.backgroundTolerance)
    : new Uint8Array(length);

  const backgroundPixels = countMask(backgroundMask);

  const tissueMask = new Uint8Array(length);
  const regionMask = new Uint8Array(length);
  const roiMask = makeRoiMask(width, height, options.rois);
  const useWholeTissue = options.structure === 'Whole tissue' && options.rois.length === 0;
  for (let i = 0; i < length; i++) {
    tissueMask[i] = backgroundMask[i] ? 0 : 1;
    regionMask[i] = tissueMask[i] && (useWholeTissue || roiMask[i]) ? 1 : 0;
  }

  const positiveMask = new Uint8Array(length);
  const scoreMax = thresholdMaximum(image);
  const fractional = image.analysisWorkflow === 'sirius-magenta';
  if ((!fractional && (!Number.isInteger(options.minThreshold) || !Number.isInteger(options.maxThreshold))) || !Number.isFinite(options.minThreshold) || !Number.isFinite(options.maxThreshold)
    || options.minThreshold < 0 || options.maxThreshold > scoreMax || options.minThreshold > options.maxThreshold) {
    throw new Error(`Thresholds must be ordered integers from 0 to ${scoreMax}.`);
  }
  const histogramScale = fractional ? 65535 : 1;
  const histogram = new Uint32Array(scoreMax * histogramScale + 1);
  let positiveSum=0, positiveSquares=0, positiveMin=Infinity, positiveMax=-Infinity;
  let analyzedPixels = 0;
  let positivePixels = 0;
  let rawIntDen = 0;
  let min = scoreMax;
  let max = 0;
  let backgroundPositivePixels = 0;

  for (let i = 0; i < length; i++) {
    const p = i * 4;
    const samples = image.samples;
    const q = i * image.channelCount;
    const r = samples ? samples[q] : rgba[p];
    const g = samples ? samples[q + (image.channelCount === 1 ? 0 : 1)] : rgba[p + 1];
    const b = samples ? (image.channelCount === 2 ? 0 : samples[q + (image.channelCount === 1 ? 0 : 2)]) : rgba[p + 2];
    const score = fractional ? (Math.max(r,g,b) === 0 ? NaN : Math.fround((Math.max(r,g,b)-g)/Math.max(r,g,b))) : stainScore(r, g, b, options.stain, options.signalChannel, scoreMax);
    if(!Number.isFinite(score)) {regionMask[i]=0;tissueMask[i]=0;continue;}
    const isPositive = score >= options.minThreshold && score <= options.maxThreshold;
    if (regionMask[i]) {
      analyzedPixels++;
      histogram[Math.round(score * histogramScale)]++;
      rawIntDen += score;
      if (score < min) min = score;
      if (score > max) max = score;
      if (isPositive) {
        positiveMask[i] = 1;
        positivePixels++;
        positiveSum+=score; positiveSquares+=score*score; positiveMin=Math.min(positiveMin,score);positiveMax=Math.max(positiveMax,score);
      }
    } else if (backgroundMask[i] && isPositive) {
      backgroundPositivePixels++;
    }
  }

  if (analyzedPixels === 0) {
    throw new Error('No analyzable pixels remain after applying the tissue and ROI masks. Review the background and region settings.');
  }

  let mode = 0;
  for (let i = 1; i < histogram.length; i++) if (histogram[i] > histogram[mode]) mode = i;
  const mean = analyzedPixels ? rawIntDen / analyzedPixels : 0;
  const positivePercent = analyzedPixels ? (positivePixels / analyzedPixels) * 100 : 0;
  const backgroundPositivePercent = backgroundPixels ? (backgroundPositivePixels / backgroundPixels) * 100 : 0;

  return {
    analyzedPixels,
    positivePixels,
    positivePercent,
    mean,
    mode: mode / histogramScale,
    positiveMean: positivePixels ? positiveSum/positivePixels : 0,
    positiveStdDev: positivePixels>1 ? Math.sqrt(Math.max(0,(positiveSquares-positiveSum*positiveSum/positivePixels)/(positivePixels-1))) : 0,
    positiveSum, positiveMin:positivePixels?positiveMin:0,positiveMax:positivePixels?positiveMax:0,
    min: analyzedPixels ? min : 0,
    max: analyzedPixels ? max : 0,
    perimeter: maskPerimeter(positiveMask, width, height),
    rawIntDen,
    backgroundPixels,
    backgroundPositivePixels,
    backgroundPositivePercent,
    excludedPercent: (backgroundPixels / length) * 100,
    tissueMask,
    regionMask,
    positiveMask,
    displayRgba,
  };
}

export function stainScore(
  r: number,
  g: number,
  b: number,
  stain: string,
  signalChannel: AnalysisOptions['signalChannel'],
  maximum = 255,
): number {
  const scoreClamp = (value: number) => Math.max(0, Math.min(maximum, value));
  if (stain === 'Sirius Red') return scoreClamp(Math.round(r - (g + b) / 2));
  if (stain === 'PAS') return scoreClamp(Math.round((r + b) / 2 - g));
  if (stain === 'H&E — hematoxylin') return scoreClamp(Math.round(b - (r + g) / 2 + 64 * maximum / 255));
  if (stain === 'H&E — eosin') return scoreClamp(Math.round((r + b) / 2 - g + 64 * maximum / 255));
  if (stain.includes('(IF)')) {
    if (signalChannel === 'red') return r;
    if (signalChannel === 'green') return g;
    if (signalChannel === 'blue') return b;
    return Math.round((r + g + b) / 3);
  }
  return Math.round((r + g + b) / 3);
}

function clamp(value: number) {
  return Math.max(0, Math.min(255, value));
}

function makeDisplayRgba(source: Uint8ClampedArray, length: number) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < length; i++) {
    const p = i * 4;
    histogram[Math.round((source[p] + source[p + 1] + source[p + 2]) / 3)]++;
  }
  const high = percentileFromHistogram(histogram, length, 0.995);
  const scale = high > 0 && high < 210 ? 235 / high : 1;
  const output = new Uint8ClampedArray(source.length);
  for (let i = 0; i < length; i++) {
    const p = i * 4;
    output[p] = clamp(Math.round(source[p] * scale));
    output[p + 1] = clamp(Math.round(source[p + 1] * scale));
    output[p + 2] = clamp(Math.round(source[p + 2] * scale));
    output[p + 3] = 255;
  }
  return output;
}

function percentileFromHistogram(histogram: Uint32Array, total: number, percentile: number) {
  const target = total * percentile;
  let count = 0;
  for (let i = 0; i < histogram.length; i++) {
    count += histogram[i];
    if (count >= target) return i;
  }
  return 255;
}

function findConnectedBackground(rgba: Uint8ClampedArray, width: number, height: number, tolerance: number) {
  const length = width * height;
  const mask = new Uint8Array(length);
  const queue = new Int32Array(length);
  const reference = dominantBorderColor(rgba, width, height);
  let head = 0;
  let tail = 0;

  const tryAdd = (index: number) => {
    if (mask[index]) return;
    const p = index * 4;
    const distance = Math.sqrt(
      (rgba[p] - reference[0]) ** 2 +
      (rgba[p + 1] - reference[1]) ** 2 +
      (rgba[p + 2] - reference[2]) ** 2,
    );
    if (distance <= tolerance) {
      mask[index] = 1;
      queue[tail++] = index;
    }
  };

  for (let x = 0; x < width; x++) { tryAdd(x); tryAdd((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { tryAdd(y * width); tryAdd(y * width + width - 1); }

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    if (x > 0) tryAdd(index - 1);
    if (x < width - 1) tryAdd(index + 1);
    if (index >= width) tryAdd(index - width);
    if (index < length - width) tryAdd(index + width);
  }
  return mask;
}

function dominantBorderColor(rgba: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 500));
  const sample = (index: number) => {
    const p = index * 4;
    const key = (rgba[p] >> 4) * 256 + (rgba[p + 1] >> 4) * 16 + (rgba[p + 2] >> 4);
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count++;
    bin.r += rgba[p]; bin.g += rgba[p + 1]; bin.b += rgba[p + 2];
    bins.set(key, bin);
  };
  for (let x = 0; x < width; x += stride) { sample(x); sample((height - 1) * width + x); }
  for (let y = stride; y < height - 1; y += stride) { sample(y * width); sample(y * width + width - 1); }
  let best = { count: 1, r: 255, g: 255, b: 255 };
  for (const bin of bins.values()) if (bin.count > best.count) best = bin;
  return [best.r / best.count, best.g / best.count, best.b / best.count];
}

function makeRoiMask(width: number, height: number, rois: RoiRect[]) {
  const mask = new Uint8Array(width * height);
  for (const roi of rois) {
    const x0 = Math.max(0, Math.floor(roi.x));
    const y0 = Math.max(0, Math.floor(roi.y));
    const x1 = Math.min(width, Math.ceil(roi.x + roi.width));
    const y1 = Math.min(height, Math.ceil(roi.y + roi.height));
    if(roi.points && roi.points.length>=3) {
      for(let y=y0;y<y1;y++) {
        const crossings:number[]=[];
        for(let i=0,j=roi.points.length-1;i<roi.points.length;j=i++) {
          const a=roi.points[i],b=roi.points[j],scan=y+0.5;
          if((a.y>scan)!==(b.y>scan)) crossings.push(a.x+(scan-a.y)*(b.x-a.x)/(b.y-a.y));
        }
        crossings.sort((a,b)=>a-b);
        for(let i=0;i+1<crossings.length;i+=2) {const left=Math.max(0,Math.ceil(crossings[i]-.5)),right=Math.min(width,Math.ceil(crossings[i+1]-.5));if(right>left) mask.fill(1,y*width+left,y*width+right);}
      }
    } else for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
  return mask;
}

function countMask(mask: Uint8Array) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return count;
}

function maskPerimeter(mask: Uint8Array, width: number, height: number) {
  let perimeter = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!mask[index]) continue;
      if (x === 0 || !mask[index - 1]) perimeter++;
      if (x === width - 1 || !mask[index + 1]) perimeter++;
      if (y === 0 || !mask[index - width]) perimeter++;
      if (y === height - 1 || !mask[index + width]) perimeter++;
    }
  }
  return perimeter;
}
