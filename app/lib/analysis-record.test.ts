import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalysisRecord, analysisRecordToCsv } from './analysis-record.ts';
import type { AnalysisResult, DecodedImage } from './image-analysis.ts';

const image: DecodedImage = {
  width: 32,
  height: 32,
  rgba: new Uint8ClampedArray(32 * 32 * 4),
  bitDepth: 16,
  sourceFormat: 'ND2',
  originalShape: '3x2x32x32',
  originalAxes: ['T', 'C', 'Y', 'X'],
  selectedShape: '32x32x2',
  selectedAxes: ['Y', 'X', 'C'],
  channelCount: 2,
  planeSelection: { T: 0, C: 'all', Y: 'all', X: 'all' },
  processing: 'linear-16bit-to-8bit',
  processingLocation: 'private companion',
  quantitativeStatus: 'experimental',
  sourceSha256: 'a'.repeat(64),
};

const result = {
  analyzedPixels: 100,
  positivePixels: 25,
  positivePercent: 25,
  mean: 12.5,
  mode: 10,
  min: 0,
  max: 50,
  perimeter: 40,
  rawIntDen: 1250,
  backgroundPixels: 20,
  backgroundPositivePixels: 2,
  backgroundPositivePercent: 10,
  excludedPercent: 2,
  tissueMask: new Uint8Array(),
  regionMask: new Uint8Array(),
  positiveMask: new Uint8Array(),
  displayRgba: new Uint8ClampedArray(),
} satisfies AnalysisResult;

test('analysis record preserves source, plane, ROI, settings, algorithms, and metric definitions', () => {
  const record = buildAnalysisRecord({
    analyzedAt: '2026-08-31T03:00:00.000Z',
    analyst: 'laila',
    sampleId: '=sample-1',
    sourceName: 'folder/plane.nd2',
    sourceSize: 1234,
    sourceLastModified: 4567,
    image,
    result,
    settings: {
      stain: 'alpha-SMA (IF)',
      signalChannel: 'green',
      structure: 'Glomeruli',
      minThreshold: 40,
      maxThreshold: 255,
      removeBackground: true,
      backgroundTolerance: 18,
      outsideMode: 'report',
      rois: [{ x: 1, y: 2, width: 3, height: 4 }],
    },
  });

  assert.equal(record.schemaVersion, '1.4.0-experimental');
  assert.equal(record.quantitativeStatus, 'experimental-not-validated');
  assert.deepEqual(record.source.provenance, { kind: 'user-supplied' });
  assert.deepEqual(record.source.planeSelection, image.planeSelection);
  assert.deepEqual(record.source.originalAxes, ['T', 'C', 'Y', 'X']);
  assert.deepEqual(record.source.selectedAxes, ['Y', 'X', 'C']);
  assert.equal(record.source.processingLocation, 'private companion');
  assert.equal(record.source.sha256, 'a'.repeat(64));
  assert.deepEqual(record.analysis.rois, [{ x: 1, y: 2, width: 3, height: 4 }]);
  assert.equal(record.analysis.backgroundTolerance, 18);
  assert.equal(record.analysis.thresholdBounds, 'inclusive');
  assert.equal(record.algorithms.background, 'border-connected-source-rgb-distance-v1');
  assert.equal(record.algorithms.perimeter, '4-neighbor-grid-edge-v1');
  assert.equal(
    record.metricDefinitions.meanScoreAllAnalyzedPixels,
    'Arithmetic mean stain score over all analyzed pixels',
  );
  assert.equal(record.calibration, null);
});

test('analysis record snapshots are isolated from later image and settings mutations', () => {
  const mutableImage: DecodedImage = {
    ...image,
    originalAxes: [...image.originalAxes],
    selectedAxes: [...image.selectedAxes],
    planeSelection: { ...image.planeSelection },
  };
  const settings = {
    stain: 'alpha-SMA (IF)',
    signalChannel: 'green' as const,
    structure: 'Glomeruli',
    minThreshold: 40,
    maxThreshold: 255,
    removeBackground: true,
    backgroundTolerance: 18,
    outsideMode: 'report' as const,
    rois: [{ x: 1, y: 2, width: 3, height: 4 }],
  };
  const record = buildAnalysisRecord({
    analyzedAt: '2026-08-31T03:00:00.000Z',
    analyst: 'laila',
    sampleId: 'sample-1',
    sourceName: 'plane.nd2',
    sourceSize: 1234,
    sourceLastModified: 4567,
    image: mutableImage,
    result,
    settings,
  });

  mutableImage.originalAxes[0] = 'MUTATED';
  mutableImage.selectedAxes[0] = 'MUTATED';
  mutableImage.planeSelection.T = 2;
  settings.rois[0].x = 99;
  settings.rois.push({ x: 5, y: 6, width: 7, height: 8 });

  assert.deepEqual(record.source.originalAxes, ['T', 'C', 'Y', 'X']);
  assert.deepEqual(record.source.selectedAxes, ['Y', 'X', 'C']);
  assert.deepEqual(record.source.planeSelection, { T: 0, C: 'all', Y: 'all', X: 'all' });
  assert.deepEqual(record.analysis.rois, [{ x: 1, y: 2, width: 3, height: 4 }]);
});

test('demonstration sources retain demonstration status in the analysis record', () => {
  const record = buildAnalysisRecord({
    analyzedAt: '2026-08-31T03:00:00.000Z',
    analyst: 'laila',
    sampleId: 'sample-1',
    sourceName: 'sample.jpg',
    sourceSize: 1234,
    sourceLastModified: 4567,
    image: { ...image, quantitativeStatus: 'demonstration' },
    result,
    settings: {
      stain: 'alpha-SMA (IF)',
      signalChannel: 'green',
      structure: 'Whole tissue',
      minThreshold: 40,
      maxThreshold: 255,
      removeBackground: false,
      backgroundTolerance: 18,
      outsideMode: 'report',
      rois: [],
    },
  });

  assert.equal(record.quantitativeStatus, 'demonstration-not-quantitative');
  assert.equal(record.source.quantitativeStatus, 'demonstration');
  assert.deepEqual(record.source.provenance, {
    kind: 'procedurally-generated-synthetic',
    generator: 'scripts/generate-synthetic-demo.py',
    seed: 20260831,
    specimen: null,
    acquisition: null,
  });
  const csv = analysisRecordToCsv(record);
  assert.match(csv, /"Source_Provenance"/);
  assert.match(csv, /procedurally-generated-synthetic/);
  assert.match(csv, /scripts\/generate-synthetic-demo\.py/);
  assert.match(csv, /20260831/);
  assert.equal(record.analysis.outsideMode, 'exclude');
});

test("outsideMode='exclude' suppresses separately reported background metrics while 'report' retains them", () => {
  const buildForOutsideMode = (outsideMode: 'exclude' | 'report') => buildAnalysisRecord({
    analyzedAt: '2026-08-31T03:00:00.000Z',
    analyst: 'laila',
    sampleId: 'sample-1',
    sourceName: 'plane.nd2',
    sourceSize: 1234,
    sourceLastModified: 4567,
    image,
    result,
    settings: {
      stain: 'alpha-SMA (IF)',
      signalChannel: 'green',
      structure: 'Glomeruli',
      minThreshold: 40,
      maxThreshold: 255,
      removeBackground: true,
      backgroundTolerance: 18,
      outsideMode,
      rois: [],
    },
  });

  const excluded = buildForOutsideMode('exclude');
  const excludedJson = JSON.stringify(excluded);
  assert.doesNotMatch(excludedJson, /"backgroundPixels"/);
  assert.doesNotMatch(excludedJson, /"backgroundPositivePixels"/);
  assert.doesNotMatch(excludedJson, /"backgroundPositivePercent"/);
  const excludedCsv = analysisRecordToCsv(excluded);
  assert.doesNotMatch(excludedCsv, /"Background_Pixels"/);
  assert.doesNotMatch(excludedCsv, /"Background_Positive_Pixels"/);
  assert.doesNotMatch(excludedCsv, /"Background_Positive_Percent"/);

  const reported = buildForOutsideMode('report');
  assert.equal(reported.metrics.backgroundPixels, 20);
  assert.equal(reported.metrics.backgroundPositivePixels, 2);
  assert.equal(reported.metrics.backgroundPositivePercent, 10);
  const reportedCsv = analysisRecordToCsv(reported);
  assert.match(reportedCsv, /"Background_Pixels"/);
  assert.match(reportedCsv, /"Background_Positive_Pixels"/);
  assert.match(reportedCsv, /"Background_Positive_Percent"/);
});

test('metric definitions use every exported metric key and are included in CSV', () => {
  const buildForOutsideMode = (outsideMode: 'exclude' | 'report') => buildAnalysisRecord({
    analyzedAt: '2026-08-31T03:00:00.000Z',
    analyst: 'laila',
    sampleId: 'sample-1',
    sourceName: 'plane.nd2',
    sourceSize: 1234,
    sourceLastModified: 4567,
    image,
    result,
    settings: {
      stain: 'alpha-SMA (IF)',
      signalChannel: 'green',
      structure: 'Glomeruli',
      minThreshold: 40,
      maxThreshold: 255,
      removeBackground: true,
      backgroundTolerance: 18,
      outsideMode,
      rois: [],
    },
  });

  const reported = buildForOutsideMode('report');
  assert.deepEqual(
    Object.keys(reported.metricDefinitions).sort(),
    Object.keys(reported.metrics).sort(),
  );
  assert.deepEqual(Object.keys(reported.metricDefinitions).sort(), [
    'analyzedPixels',
    'backgroundPixels',
    'backgroundPositivePercent',
    'backgroundPositivePixels',
    'excludedPercent',
    'gridPerimeterPixelEdges',
    'maxScoreAllAnalyzedPixels',
    'meanScoreAllAnalyzedPixels',
    'minScoreAllAnalyzedPixels',
    'modeScoreAllAnalyzedPixels',
    'positivePercent',
    'positivePixels',
    'scoreSumAllAnalyzedPixels',
  ]);

  const excluded = buildForOutsideMode('exclude');
  assert.deepEqual(
    Object.keys(excluded.metricDefinitions).sort(),
    Object.keys(excluded.metrics).sort(),
  );

  const reportedCsv = analysisRecordToCsv(reported);
  assert.match(reportedCsv, /"Metric_Definitions"/);
  assert.match(reportedCsv, /backgroundPositivePercent/);
  assert.match(reportedCsv, /positivePixels/);

  const excludedCsv = analysisRecordToCsv(excluded);
  assert.match(excludedCsv, /"Metric_Definitions"/);
  assert.doesNotMatch(excludedCsv, /backgroundPositivePercent/);
  assert.match(excludedCsv, /positivePixels/);
});

test('CSV contains reproducibility fields and neutralizes LF-prefixed spreadsheet formulas', () => {
  const record = buildAnalysisRecord({
    analyzedAt: '2026-08-31T03:00:00.000Z',
    analyst: 'laila',
    sampleId: '\n=sample-1',
    sourceName: '\n@plane.nd2',
    sourceSize: 1234,
    sourceLastModified: 4567,
    image,
    result,
    settings: {
      stain: 'alpha-SMA (IF)',
      signalChannel: 'green',
      structure: 'Glomeruli',
      minThreshold: 40,
      maxThreshold: 255,
      removeBackground: true,
      backgroundTolerance: 18,
      outsideMode: 'report',
      rois: [{ x: 1, y: 2, width: 3, height: 4 }],
    },
  });

  const csv = analysisRecordToCsv(record);

  assert.match(csv, /Background_Tolerance/);
  assert.match(csv, /Plane_Selection/);
  assert.match(csv, /Original_Axes/);
  assert.match(csv, /Selected_Axes/);
  assert.match(csv, /ROIs/);
  assert.match(csv, /Processing/);
  assert.match(csv, /Source_SHA256/);
  assert.match(csv, /Source_Provenance/);
  assert.match(csv, /user-supplied/);
  assert.match(csv, /"'\n=sample-1"/);
  assert.match(csv, /"'\n@plane.nd2"/);
});


test('co-stain assignments and active marker are frozen in the export snapshot', () => {
  const stainingPanel = {
    coStained: 'yes' as const, activeId: 'apoj',
    assignments: [
      { id: 'apoj', marker: 'ApoJ / Clusterin', channel: 'red' as const, reagent: 'AF2747' },
      { id: 'dapi', marker: 'DAPI', channel: 'blue' as const, reagent: '' },
    ],
  };
  const record = buildAnalysisRecord({
    analyzedAt: '', analyst: '', sampleId: 'co-stain', sourceName: '', sourceSize: 0, sourceLastModified: 0,
    image, result,
    settings: { stainingPanel, stain: 'ApoJ / Clusterin (IF)', signalChannel: 'red', structure: 'Whole tissue', minThreshold: 0, maxThreshold: 255, removeBackground: false, backgroundTolerance: 18, outsideMode: 'exclude', rois: [] },
  });
  stainingPanel.assignments[0].reagent = 'changed after analysis';
  assert.equal(record.analysis.stainingPanel.assignments[0].reagent, 'AF2747');
  assert.equal(record.analysis.stainingPanel.activeId, 'apoj');
  assert.equal(record.analysis.stainingPanel.coStained, 'yes');
  assert.match(analysisRecordToCsv(record), /Stain_Channel_Assignments/);
  assert.match(analysisRecordToCsv(record), /AF2747/);
});
