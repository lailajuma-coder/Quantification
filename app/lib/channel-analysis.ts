import { analyzeImage, type DecodedImage } from './image-analysis.ts';
import { automaticSettings, channelSettingsKey, samplePreview, type ChannelSettings } from './channel-preview.ts';
import { buildAnalysisRecord, type AnalysisSettingsSnapshot } from './analysis-record.ts';

export type AnalysisScope='all'|AnalysisSettingsSnapshot['signalChannel'];

export function analyzeChannels(image: DecodedImage, settings: AnalysisSettingsSnapshot,
  saved: Record<string, ChannelSettings>, provenance: { analyst: string; sampleId: string; groupName?:string; sourceName: string; sourceSize: number; sourceLastModified: number },
  scope:AnalysisScope='all',
) {
  const channels = image.analysisWorkflow === 'sirius-magenta' ? ['red'] as const : image.channelCount === 1 ? ['grayscale'] as const
    : image.channelCount === 2 ? ['red', 'green'] as const : ['red', 'green', 'blue'] as const;
  if(scope!=='all'&&!channels.some(channel=>channel===scope))throw new Error(`The ${scope} channel is not available for this image/workflow.`);
  const selected=channels.filter(channel=>scope==='all'||channel===scope);
  const preview = samplePreview(image);
  const analyzedAt = new Date().toISOString();
  return selected.map(channel => {
    const assignment = settings.stainingPanel?.assignments.filter(item => item.channel === channel && item.marker.trim()) ?? [];
    const stain = settings.stain.includes('(IF)')
      ? `${assignment.length ? assignment.map(item => item.marker.trim()).join(' + ') : 'Channel intensity'} (IF)` : settings.stain;
    const values = channel === settings.signalChannel
      ? { minimum: settings.minThreshold, maximum: settings.maxThreshold }
      : saved[channelSettingsKey(settings.stain, channel)] ?? automaticSettings(preview, stain, channel);
    const snapshot: AnalysisSettingsSnapshot = { ...settings, stain, signalChannel: channel,
      minThreshold: values.minimum, maxThreshold: values.maximum,
      stainingPanel: settings.stainingPanel ? { ...settings.stainingPanel, activeId: assignment.length === 1 ? assignment[0].id : null } : undefined,
    };
    return buildAnalysisRecord({ ...provenance, analyzedAt, image, result: analyzeImage(image, snapshot), settings: snapshot });
  });
}
