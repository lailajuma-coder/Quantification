import type { StainingPanel } from './stain-channels';
import type { AnalysisResult, DecodedImage, RoiRect } from './image-analysis';

export const ANALYSIS_SCHEMA_VERSION = '1.4.0-experimental';

export type AnalysisSettingsSnapshot = {
  stainingPanel?: StainingPanel;
  stain: string;
  signalChannel: 'red' | 'green' | 'blue' | 'grayscale';
  structure: string;
  minThreshold: number;
  maxThreshold: number;
  removeBackground: boolean;
  backgroundTolerance: number;
  outsideMode: 'exclude' | 'report';
  rois: RoiRect[];
};

type BuildAnalysisRecordInput = {
  analyzedAt: string;
  analyst: string;
  sampleId: string;
  groupName?: string;
  sourceName: string;
  sourceSize: number;
  sourceLastModified: number;
  image: DecodedImage;
  result: AnalysisResult;
  settings: AnalysisSettingsSnapshot;
};

export function buildAnalysisRecord(input: BuildAnalysisRecordInput) {
  const { image, result, settings } = input;
  const reportsBackground = settings.removeBackground && settings.outsideMode === 'report';
  const metrics = {
    analyzedPixels: result.analyzedPixels,
    positivePixels: result.positivePixels,
    ...(result.positiveMean === undefined ? {} : {meanPositive:result.positiveMean,stdDevPositive:result.positiveStdDev!,sumPositive:result.positiveSum!,minPositive:result.positiveMin!,maxPositive:result.positiveMax!}),
    positivePercent: result.positivePercent,
    meanScoreAllAnalyzedPixels: result.mean,
    modeScoreAllAnalyzedPixels: result.mode,
    minScoreAllAnalyzedPixels: result.min,
    maxScoreAllAnalyzedPixels: result.max,
    gridPerimeterPixelEdges: result.perimeter,
    scoreSumAllAnalyzedPixels: result.rawIntDen,
    backgroundPixels: result.backgroundPixels,
    backgroundPositivePixels: result.backgroundPositivePixels,
    backgroundPositivePercent: result.backgroundPositivePercent,
    excludedPercent: result.excludedPercent,
  };
  const metricDefinitions = {
    analyzedPixels: 'Pixels inside the whole-image or analyst-defined ROI mask after any enabled background exclusion',
    meanPositive: 'Mean intensity of threshold-positive pixels (zero if none)',
    stdDevPositive: 'Sample standard deviation of threshold-positive intensities (zero with fewer than two pixels)',
    sumPositive: 'Raw integrated intensity of threshold-positive pixels',
    minPositive: 'Minimum threshold-positive intensity (zero if none)',
    maxPositive: 'Maximum threshold-positive intensity (zero if none)',
    positivePixels: 'Analyzed pixels with a stain score inside the inclusive minimum and maximum thresholds',
    positivePercent: 'Positive pixels divided by analyzed pixels, multiplied by 100',
    meanScoreAllAnalyzedPixels: 'Arithmetic mean stain score over all analyzed pixels',
    modeScoreAllAnalyzedPixels: 'Most frequent integer stain score over all analyzed pixels; ties resolve to the lowest score',
    minScoreAllAnalyzedPixels: 'Minimum stain score over all analyzed pixels',
    maxScoreAllAnalyzedPixels: 'Maximum stain score over all analyzed pixels',
    gridPerimeterPixelEdges: 'Four-neighbor grid-edge count around threshold-positive analyzed pixels',
    scoreSumAllAnalyzedPixels: 'Sum of stain scores over all analyzed pixels',
    backgroundPixels: 'Border-connected pixels classified as slide background and excluded from analyzed pixels',
    backgroundPositivePixels: 'Background pixels with a stain score inside the inclusive minimum and maximum thresholds',
    backgroundPositivePercent: 'Background-positive pixels divided by background pixels, multiplied by 100; zero when no background pixels exist',
    excludedPercent: 'Background pixels divided by all source-image pixels, multiplied by 100',
  };
  if(result.positiveMean === undefined) for(const key of ['meanPositive','stdDevPositive','sumPositive','minPositive','maxPositive'] as const) Object.defineProperty(metricDefinitions,key,{enumerable:false});
  if (!reportsBackground) {
    // JSON exports include enumerable fields only; exclude mode must not report these values or definitions.
    for (const key of ['backgroundPixels', 'backgroundPositivePixels', 'backgroundPositivePercent'] as const) {
      Object.defineProperty(metrics, key, { enumerable: false });
      Object.defineProperty(metricDefinitions, key, { enumerable: false });
    }
  }
  const sourceProvenance = image.quantitativeStatus === 'demonstration'
    ? {
        kind: 'procedurally-generated-synthetic' as const,
        generator: 'scripts/generate-synthetic-demo.py',
        seed: 20260831,
        specimen: null,
        acquisition: null,
      }
    : { kind: 'user-supplied' as const };
  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    quantitativeStatus: image.quantitativeStatus === 'demonstration'
      ? 'demonstration-not-quantitative' as const
      : 'experimental-not-validated' as const,
    analyzedAt: input.analyzedAt,
    analyst: input.analyst,
    sampleId: input.sampleId,
    groupName: input.groupName ?? 'Ungrouped',
    source: {
      name: input.sourceName,
      sizeBytes: input.sourceSize,
      lastModifiedMs: input.sourceLastModified,
      provenance: sourceProvenance,
      format: image.sourceFormat,
      originalBitDepth: image.bitDepth,
      originalShape: image.originalShape,
      originalAxes: [...image.originalAxes],
      selectedShape: image.selectedShape,
      selectedAxes: [...image.selectedAxes],
      channelCount: image.channelCount,
      pixelSizeMicrons: image.pixelSizeMicrons ? [...image.pixelSizeMicrons] : null,
      analysisWorkflow: image.analysisWorkflow ?? 'native',
      conversionRanges: image.conversionRanges?.map(range=>({...range})) ?? null,
      ...(image.channelMapping ? { channelMapping: { ...image.channelMapping, sourceIndices: [...image.channelMapping.sourceIndices], sourceNames: [...image.channelMapping.sourceNames] } } : {}),
      planeSelection: { ...image.planeSelection },
      processing: image.processing,
      processingLocation: image.processingLocation,
      quantitativeStatus: image.quantitativeStatus,
      sha256: image.sourceSha256,
    },
    analysis: {
      stainingPanel: {
        coStained: settings.stainingPanel?.coStained ?? 'unspecified',
        activeId: settings.stainingPanel?.activeId ?? null,
        assignments: settings.stainingPanel?.assignments.map((assignment) => ({ ...assignment })) ?? [],
      },
      stain: settings.stain,
      signalChannel: settings.signalChannel,
      structureCategory: settings.structure,
      minThreshold: settings.minThreshold,
      maxThreshold: settings.maxThreshold,
      scoreBitDepth: image.analysisWorkflow === 'sirius-magenta' ? 32 : image.analysisBitDepth ?? 8,
      intensitySource: image.analysisWorkflow ? 'converted-8bit-analysis-copy' : image.samples ? 'native-integer-samples' : '8bit-display',
      thresholdBounds: 'inclusive' as const,
      removeBackground: settings.removeBackground,
      backgroundTolerance: settings.backgroundTolerance,
      outsideMode: settings.removeBackground ? settings.outsideMode : 'exclude',
      rois: settings.rois.map((roi) => ({ ...roi, ...(roi.points ? {points:roi.points.map(point=>({...point}))}: {}) })),
    },
    metrics,
    metricDefinitions,
    algorithms: {
      stainScore: image.analysisWorkflow === 'sirius-magenta' ? 'CMYK-magenta-(maxRGB-G)/maxRGB; undefined black scores excluded' : image.samples ? 'kidneyquant-native-integer-score-v2-experimental' : 'kidneyquant-rgb-score-v1-experimental',
      background: settings.removeBackground ? 'border-connected-source-rgb-distance-v1' : 'disabled',
      perimeter: '4-neighbor-grid-edge-v1',
    },
    calibration: image.pixelSizeMicrons ? {pixelWidthMicrons:image.pixelSizeMicrons[0],pixelHeightMicrons:image.pixelSizeMicrons[1],source:'ND2 metadata',screenUnits:'pixels',excelAreaUnits:'µm²'} : null,
    warnings: [
      'Research use only: stain transforms and thresholds are not validated for publication or clinical use.',
      image.processing === 'native-8bit' ? null : `Source pixels were processed as ${image.processing}.`,
      Object.values(image.planeSelection).some((value) => value === 0)
        ? 'Only the recorded first plane was selected for one or more non-spatial axes.'
        : null,
      'Area and perimeter are uncalibrated pixel measurements.',
    ].filter((warning): warning is string => Boolean(warning)),
  };
}

export type AnalysisRecord = ReturnType<typeof buildAnalysisRecord>;

function spreadsheetSafe(value: string | number | boolean | null) {
  if (value === null) return '';
  const text = String(value);
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value: string | number | boolean | null) {
  return `"${spreadsheetSafe(value).replaceAll('"', '""')}"`;
}

export function analysisRecordToCsv(record: AnalysisRecord) {
  const backgroundFields: Array<[string, string | number | boolean | null]> =
    record.analysis.removeBackground && record.analysis.outsideMode === 'report'
      ? [
          ['Background_Pixels', record.metrics.backgroundPixels!],
          ['Background_Positive_Pixels', record.metrics.backgroundPositivePixels!],
          ['Background_Positive_Percent', record.metrics.backgroundPositivePercent!.toFixed(4)],
        ]
      : [];
  const fields: Array<[string, string | number | boolean | null]> = [
    ['Schema_Version', record.schemaVersion],
    ['Quantitative_Status', record.quantitativeStatus],
    ['Analyzed_At', record.analyzedAt],
    ['Analyst', record.analyst],
    ['Sample_ID', record.sampleId],
    ['Group', record.groupName],
    ['Source_File', record.source.name],
    ['Source_Size_Bytes', record.source.sizeBytes],
    ['Source_Last_Modified_Ms', record.source.lastModifiedMs],
    ['Source_Provenance', JSON.stringify(record.source.provenance)],
    ['Source_Format', record.source.format],
    ['Original_Bit_Depth', record.source.originalBitDepth],
    ['Original_Shape', record.source.originalShape],
    ['Original_Axes', record.source.originalAxes.join(',')],
    ['Selected_Shape', record.source.selectedShape],
    ['Selected_Axes', record.source.selectedAxes.join(',')],
    ['Channel_Count', record.source.channelCount],
    ['Analysis_Workflow', record.source.analysisWorkflow],
    ['Conversion_Ranges', JSON.stringify(record.source.conversionRanges)],
    ['Mean_Positive', record.metrics.meanPositive ?? null],
    ['StdDev_Positive', record.metrics.stdDevPositive ?? null],
    ['RawIntDen_Positive', record.metrics.sumPositive ?? null],
    ['Channel_Mapping', JSON.stringify(record.source.channelMapping ?? null)],
    ['Plane_Selection', JSON.stringify(record.source.planeSelection)],
    ['Processing', record.source.processing],
    ['Processing_Location', record.source.processingLocation],
    ['Source_Quantitative_Status', record.source.quantitativeStatus],
    ['Source_SHA256', record.source.sha256],
    ['Stain', record.analysis.stain],
    ['Signal_Channel', record.analysis.signalChannel],
    ['Co_Stained', record.analysis.stainingPanel.coStained],
    ['Active_Stain_ID', record.analysis.stainingPanel.activeId],
    ['Stain_Channel_Assignments', JSON.stringify(record.analysis.stainingPanel.assignments)],
    ['Structure_Category', record.analysis.structureCategory],
    ['Min_Threshold', record.analysis.minThreshold],
    ['Max_Threshold', record.analysis.maxThreshold],
    ['Score_Bit_Depth', record.analysis.scoreBitDepth],
    ['Intensity_Source', record.analysis.intensitySource],
    ['Threshold_Bounds', record.analysis.thresholdBounds],
    ['Remove_Background', record.analysis.removeBackground],
    ['Background_Tolerance', record.analysis.backgroundTolerance],
    ['Outside_Mode', record.analysis.outsideMode],
    ['ROIs', JSON.stringify(record.analysis.rois)],
    ['Analyzed_Pixels', record.metrics.analyzedPixels],
    ['Positive_Pixels', record.metrics.positivePixels],
    ['Positive_Percent', record.metrics.positivePercent.toFixed(4)],
    ['Mean_Score_All_Analyzed_Pixels', record.metrics.meanScoreAllAnalyzedPixels.toFixed(4)],
    ['Mode_Score_All_Analyzed_Pixels', record.metrics.modeScoreAllAnalyzedPixels],
    ['Min_Score_All_Analyzed_Pixels', record.metrics.minScoreAllAnalyzedPixels],
    ['Max_Score_All_Analyzed_Pixels', record.metrics.maxScoreAllAnalyzedPixels],
    ['Grid_Perimeter_Pixel_Edges', record.metrics.gridPerimeterPixelEdges],
    ['Score_Sum_All_Analyzed_Pixels', record.metrics.scoreSumAllAnalyzedPixels.toFixed(4)],
    ...backgroundFields,
    ['Excluded_Percent', record.metrics.excludedPercent.toFixed(4)],
    ['Metric_Definitions', JSON.stringify(record.metricDefinitions)],
    ['Calibration', record.calibration ? JSON.stringify(record.calibration) : null],
    ['Algorithms', JSON.stringify(record.algorithms)],
    ['Warnings', JSON.stringify(record.warnings)],
  ];
  return `${fields.map(([header]) => csvCell(header)).join(',')}\n${fields.map(([, value]) => csvCell(value)).join(',')}\n`;
}
