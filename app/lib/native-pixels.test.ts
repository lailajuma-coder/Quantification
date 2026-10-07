import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePixels } from './native-pixels.ts';
import { analyzeImage, thresholdMaximum, type DecodedImage } from './image-analysis.ts';
import { buildAnalysisRecord, analysisRecordToCsv } from './analysis-record.ts';

test('16-bit thresholds distinguish neighboring values even when their previews are identical', () => {
  const values = [0, 1000, 1001, 65535];
  const buffer = new ArrayBuffer(8);
  values.forEach((value, index) => new DataView(buffer).setUint16(index * 2, value, true));
  const native = nativePixels(buffer, 4, 1, 1, 16);
  const image: DecodedImage = {
    ...native, width: 4, height: 1, channelCount: 1, bitDepth: 16,
    sourceFormat: 'TIFF', originalShape: '1x4', originalAxes: ['Y', 'X'],
    selectedShape: '1x4', selectedAxes: ['Y', 'X'], planeSelection: {},
    processing: 'native-integer-samples', processingLocation: 'browser',
    quantitativeStatus: 'experimental', sourceSha256: 'a'.repeat(64),
  };
  assert.deepEqual(Array.from(native.samples), values);
  assert.equal(native.rgba[4], native.rgba[8]);
  assert.equal(thresholdMaximum(image), 65535);
  const settings = {
    stain: 'Vimentin (IF)', signalChannel: 'grayscale' as const,
    minThreshold: 1001, maxThreshold: 65535, removeBackground: false,
    backgroundTolerance: 18, outsideMode: 'exclude' as const, structure: 'Whole tissue', rois: [],
  };
  const result = analyzeImage(image, settings);
  assert.deepEqual(Array.from(result.positiveMask), [0, 0, 1, 1]);
  assert.equal(result.mean, values.reduce((a, b) => a + b) / 4);
  const exact = analyzeImage(image, { ...settings, maxThreshold: 1001 });
  assert.deepEqual(Array.from(exact.positiveMask), [0, 0, 1, 0]);
  assert.throws(() => analyzeImage(image, { ...settings, maxThreshold: 65536 }), /Thresholds/);
  const record = buildAnalysisRecord({ image, result, settings, analyzedAt: '', analyst: '', sampleId: '', sourceName: '', sourceSize: 8, sourceLastModified: 0 });
  assert.equal(record.analysis.scoreBitDepth, 16);
  assert.equal(record.analysis.intensitySource, 'native-integer-samples');
  assert.match(analysisRecordToCsv(record), /Score_Bit_Depth/);
});

test('native two-channel preview preserves R/G mapping and has no invented blue channel', () => {
  const native = nativePixels(new Uint8Array([10, 20, 30, 40]).buffer, 2, 1, 2, 8);
  assert.deepEqual(Array.from(native.rgba), [10, 20, 0, 255, 30, 40, 0, 255]);
  assert.equal(native.analysisBitDepth, 8);
  assert.throws(() => nativePixels(new ArrayBuffer(2), 2, 1, 2, 8), /length/);
  assert.throws(() => nativePixels(new ArrayBuffer(2), 1, 1, 1, 32), /Unsupported/);
});
