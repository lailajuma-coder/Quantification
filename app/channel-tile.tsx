'use client';
import { useEffect, useRef } from 'react';
import { renderPreview, type ChannelSettings } from './lib/channel-preview';
import type { AnalysisOptions, DecodedImage } from './lib/image-analysis';

export default function ChannelTile({ image, channel, ranges, settings, options, active, onSelect, view, disabled }: {
  image: DecodedImage; channel: 'red' | 'green' | 'blue'; ranges: number[];
  settings: ChannelSettings; options: AnalysisOptions; active: boolean; onSelect: () => void;
  view: 'original' | 'overlay' | 'mask';
  disabled: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const available = image.channelCount >= ({ red: 1, green: 2, blue: 3 }[channel]) && image.channelCount > 1;
  const displayMaximum=settings.displayMaximum??ranges[{red:0,green:1,blue:2}[channel]];
  const displayMinimum=settings.displayMinimum??0,brightness=settings.brightness;
  const minimum=view==='original'?0:settings.minimum,maximum=view==='original'?255:settings.maximum;
  const stain=view==='original'?'Channel intensity (IF)':options.stain;
  const {removeBackground,backgroundTolerance,outsideMode,structure,rois}=options;
  useEffect(() => {
    if (!canvas.current || !available) return;
    const context = canvas.current.getContext('2d');
    // Other channels and active marker labels do not change this channel's pixels.
    const pixels=renderPreview(image,image.analysisWorkflow==='sirius-magenta'&&channel==='red'?'magenta':channel,
      [displayMaximum,displayMaximum,displayMaximum],[brightness,brightness,brightness],
      {stain,signalChannel:channel,minThreshold:minimum,maxThreshold:maximum,removeBackground,backgroundTolerance,outsideMode,structure,rois},view,
      [displayMinimum,displayMinimum,displayMinimum]);
    context?.putImageData(new ImageData(pixels,image.width,image.height),0,0);
  },[image,channel,displayMaximum,displayMinimum,brightness,minimum,maximum,stain,removeBackground,backgroundTolerance,outsideMode,structure,rois,view,available]);
  return <div className={`channel-tile ${active ? 'selected' : ''}`}>
    <div className="channel-image">{available ? <button type="button" className="channel-image-select" disabled={disabled} onClick={onSelect} aria-label={`Select ${channel} channel`} aria-pressed={active}><canvas ref={canvas} width={image.width} height={image.height} aria-label={`${channel} channel preview`} /></button> : <span className="unavailable-channel">No {channel} source channel</span>}</div>

  </div>;
}
