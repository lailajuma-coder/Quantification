import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeImage,
  decodeMicroscopyFile,
  sha256Hex,
  tiffDimensions,
  tiffMetadata,
  tiffRgbaFromDecoded,
  type AnalysisOptions,
  type DecodedImage,
} from './image-analysis.ts';

function image(width: number, height: number, rgba: number[] | Uint8ClampedArray): DecodedImage {
  return {
    width,
    height,
    rgba: rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba),
    bitDepth: 8,
    sourceFormat: 'test',
    originalShape: `${height}x${width}x3`,
    originalAxes: ['Y', 'X', 'S'],
    selectedShape: `${height}x${width}x3`,
    selectedAxes: ['Y', 'X', 'S'],
    channelCount: 3,
    planeSelection: {},
    processing: 'native-8bit',
    processingLocation: 'browser',
    quantitativeStatus: 'experimental',
    sourceSha256: 'test-hash',
  };
}

test('source fingerprint uses SHA-256', async () => {
  const digest = await sha256Hex(new TextEncoder().encode('abc').buffer);
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('arbitrary JPEG uploads are rejected; only the bundled synthetic demo may use JPEG', async () => {
  await assert.rejects(
    decodeMicroscopyFile(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'user-photo.jpg', { type: 'image/jpeg' })),
    /Unsupported image extension/i,
  );
});

test('TIFF dimensions are read from tags before pixel decoding', () => {
  assert.deepEqual(tiffDimensions({ t256: [3], t257: [2] }), { width: 3, height: 2 });
  assert.throws(() => tiffDimensions({ t256: [0], t257: [2] }), /invalid dimensions/i);
});

test('TIFF validation accepts only unsigned BlackIsZero grayscale or interleaved RGB', () => {
  assert.deepEqual(tiffMetadata({ t258: [16], t339: [1], t284: [1], t262: [1], t277: [1] }), {
    bitDepth: 16,
    channelCount: 1,
  });
  assert.deepEqual(tiffMetadata({ t258: [8, 8, 8], t339: [1, 1, 1], t284: [1], t262: [2], t277: [3] }), {
    bitDepth: 8,
    channelCount: 3,
  });
  assert.throws(() => tiffMetadata({ t258: [8], t262: [3], t277: [1] }), /BlackIsZero grayscale or interleaved RGB/i);
  assert.throws(() => tiffMetadata({ t258: [8, 16, 8], t262: [2], t277: [3] }), /mixed bit depth/i);
  assert.throws(() => tiffMetadata({ t258: [8], t339: [2], t262: [1], t277: [1] }), /Signed and floating-point/i);
  assert.throws(() => tiffMetadata({ t258: [8, 8], t262: [1], t277: [2] }), /BlackIsZero grayscale or interleaved RGB/i);
  assert.throws(() => tiffMetadata({ t258: [8], t259: [32946], t262: [1], t277: [1] }), /uncompressed TIFF/i);
});

test('16-bit TIFF samples use rounded full-scale conversion rather than high-byte truncation', () => {
  const values = [0, 1000, 32768, 65535];
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  const rgba = tiffRgbaFromDecoded({ data: bytes, isLE: true }, 2, 2, 16, 1);
  assert.deepEqual(Array.from(rgba), [
    0, 0, 0, 255,
    4, 4, 4, 255,
    128, 128, 128, 255,
    255, 255, 255, 255,
  ]);
  assert.deepEqual(
    Array.from(tiffRgbaFromDecoded({ data: bytes, isLE: false }, 2, 2, 16, 1)),
    Array.from(rgba),
    'UTIF normalizes decoded 16-bit sample bytes to little-endian regardless of source byte order',
  );
});

const options: AnalysisOptions = {
  stain: 'Sirius Red',
  signalChannel: 'red',
  minThreshold: 6,
  maxThreshold: 255,
  removeBackground: false,
  backgroundTolerance: 18,
  outsideMode: 'exclude',
  structure: 'Whole tissue',
  rois: [],
};

test('analysis rejects an empty ROI instead of reporting a valid zero percent', () => {
  const decoded = image(2, 2, [
    200, 0, 0, 255,
    200, 0, 0, 255,
    200, 0, 0, 255,
    200, 0, 0, 255,
  ]);

  assert.throws(
    () => analyzeImage(decoded, { ...options, structure: 'Podocytes', rois: [{ x: 10, y: 10, width: 5, height: 5 }] }),
    /No analyzable pixels remain/,
  );
});

test('analysis still reports a true zero-positive result when the denominator is nonzero', () => {
  const decoded = image(1, 1, [10, 10, 10, 255]);

  const result = analyzeImage(decoded, options);

  assert.equal(result.analyzedPixels, 1);
  assert.equal(result.positivePixels, 0);
  assert.equal(result.positivePercent, 0);
});

test('small but connected slide background is retained instead of silently discarded', () => {
  const width = 2100;
  const height = 2100;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const value = border ? 255 : 0;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  const decoded = image(width, height, rgba);

  const result = analyzeImage(decoded, { ...options, removeBackground: true });

  assert.equal(result.backgroundPixels, 2 * width + 2 * height - 4);
  assert.ok(result.excludedPercent > 0 && result.excludedPercent < 0.2);
});

function box(x: number, y: number, width: number, height: number) {
  return { points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] };
}

test('glomeruli pool pixel areas rather than averaging percentages and overlaps count once', () => {
  const decoded = image(4, 1, [200,0,0,255, 0,0,0,255, 0,0,0,255, 0,0,0,255]);
  const result = analyzeImage(decoded, { ...options, structure: 'Glomeruli', glomeruli: [box(0,0,1,1), box(1,0,3,1), box(0,0,1,1)] });
  assert.equal(result.analyzedPixels, 4);
  assert.equal(result.positivePixels, 1);
  assert.equal(result.positivePercent, 25);
});

test('interstitial measurement subtracts glomeruli from both numerator and denominator', () => {
  const decoded = image(4, 1, [200,0,0,255, 200,0,0,255, 0,0,0,255, 0,0,0,255]);
  const settings = { ...options, structure: 'Interstitial region', glomeruli: [box(0,0,1,1)] };
  const result = analyzeImage(decoded, settings);
  assert.equal(result.analyzedPixels, 3);
  assert.equal(result.positivePixels, 1);
  assert.ok(Math.abs(result.positivePercent - 100 / 3) < 1e-10);
  const restricted = analyzeImage(decoded, { ...settings, rois: [{ x:0,y:0,width:2,height:1 }] });
  assert.equal(restricted.analyzedPixels, 1);
  assert.equal(restricted.positivePercent, 100);
  assert.throws(() => analyzeImage(decoded, { ...settings, glomeruli: [box(0,0,4,1)] }), /No analyzable pixels/);
});

test('polygon rasterization uses actual outline and combines it with tissue background', () => {
  const decoded = image(2, 2, [255,255,255,255, 200,0,0,255, 200,0,0,255, 200,0,0,255]);
  const result = analyzeImage(decoded, { ...options, structure: 'Glomeruli', removeBackground:true, glomeruli: [box(-1,-1,4,4)] });
  assert.equal(result.analyzedPixels, 4 - result.backgroundPixels);
  assert.ok(result.backgroundPixels > 0);
  const triangle = analyzeImage(decoded, { ...options, structure: 'Glomeruli', glomeruli: [{ points:[{x:0,y:0},{x:2,y:0},{x:0,y:2}] }] });
  assert.equal(triangle.analyzedPixels, 1);
  assert.throws(() => analyzeImage(decoded, { ...options, structure:'Glomeruli' }), /Outline at least/);
  assert.throws(() => analyzeImage(decoded, { ...options, structure:'Glomeruli', glomeruli:[{points:[{x:NaN,y:0}]}] }), /finite points/);
});
