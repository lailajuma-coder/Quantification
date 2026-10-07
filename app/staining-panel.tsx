'use client';

import { channelAvailable, setCoStained, type StainingPanel, type StainAssignment } from './lib/stain-channels';

const MARKERS = ['DAPI', 'ApoJ / Clusterin', 'alpha-SMA', 'Vimentin', 'Lotus lectin / LTL'];
const CHANNELS = ['red', 'green', 'blue', 'grayscale'] as const;

export default function StainingPanelControls({ panel, channelCount, disabled, onChange }: {
  panel: StainingPanel;
  channelCount: number;
  disabled: boolean;
  onChange: (panel: StainingPanel) => void;
}) {
  const update = (id: string, patch: Partial<StainAssignment>) => {
    onChange({ ...panel, assignments: panel.assignments.map((item) => item.id === id ? { ...item, ...patch } : item) });
  };
  return <fieldset className="staining-panel" disabled={disabled}>
    <legend>Stains &amp; channels</legend>
    <label className="field-label" htmlFor="co-stained">Is the tissue co-stained?</label>
    <select id="co-stained" className="select-input" value={panel.coStained} onChange={(event) => onChange(setCoStained(panel, event.target.value as StainingPanel['coStained']))}>
      <option value="unspecified">Not specified</option>
      <option value="no">No — single stain</option>
      <option value="yes">Yes — multiple stains</option>
    </select>
    <p className="validation-note">Assign each fluorescent stain to the color channel in this image.</p>
    {panel.assignments.map((assignment, index) => {
      const custom = assignment.custom || (Boolean(assignment.marker) && !MARKERS.includes(assignment.marker));
      return <div className="stain-assignment" key={assignment.id}>
        <label className="field-label" htmlFor={`marker-${assignment.id}`}>Stain {index + 1}</label>
        <select id={`marker-${assignment.id}`} className="select-input" value={custom ? 'custom' : assignment.marker} onChange={(event) => update(assignment.id, { marker: event.target.value === 'custom' ? '' : event.target.value, custom: event.target.value === 'custom', channel: event.target.value === 'DAPI' ? 'blue' : assignment.channel })}>
          <option value="">Choose stain…</option>
          {MARKERS.map((marker) => <option key={marker}>{marker}</option>)}
          <option value="custom">Other / custom stain</option>
        </select>
        {custom && <><label className="field-label compact" htmlFor={`custom-${assignment.id}`}>Custom stain name</label><input id={`custom-${assignment.id}`} className="text-input" maxLength={100} value={assignment.marker} onChange={(event) => update(assignment.id, { marker: event.target.value })} /></>}
        <label className="field-label compact" htmlFor={`channel-${assignment.id}`}>Visible color channel</label>
        <select id={`channel-${assignment.id}`} className="select-input" value={assignment.channel} onChange={(event) => update(assignment.id, { channel: event.target.value as StainAssignment['channel'] })}>
          {CHANNELS.map((channel) => <option key={channel} value={channel} disabled={!channelAvailable(channel, channelCount)}>{channel[0].toUpperCase() + channel.slice(1)}{!channelAvailable(channel, channelCount) ? ' — unavailable in this image' : ''}</option>)}
        </select>
        <label className="field-label compact" htmlFor={`reagent-${assignment.id}`}>Antibody / fluorophore <span>optional</span></label>
        <input id={`reagent-${assignment.id}`} className="text-input" maxLength={200} value={assignment.reagent} placeholder="e.g. AF2747 + fluorescent secondary" onChange={(event) => update(assignment.id, { reagent: event.target.value })} />
        {panel.coStained === 'yes' && panel.assignments.length > 2 && <button type="button" className="stain-action" onClick={() => onChange({ ...panel, assignments: panel.assignments.filter(({ id }) => id !== assignment.id), activeId: panel.activeId === assignment.id ? null : panel.activeId })}>Remove stain {index + 1}</button>}
      </div>;
    })}
    {panel.coStained === 'yes' && panel.assignments.length < 3 && <button type="button" className="stain-action" onClick={() => onChange({ ...panel, assignments: [...panel.assignments, { id: crypto.randomUUID(), marker: '', channel: 'green', reagent: '' }] })}>Add stain</button>}
    <label className="field-label" htmlFor="stain-channel-view">Stain to edit</label>
    <select id="stain-channel-view" className="select-input" value={panel.activeId ?? ''} onChange={(event) => onChange({ ...panel, activeId: event.target.value || null })}>
      <option value="">Choose channel directly</option>
      {panel.assignments.map((assignment, index) => <option key={assignment.id} value={assignment.id} disabled={!assignment.marker.trim() || !channelAvailable(assignment.channel, channelCount)}>{assignment.marker || `Stain ${index + 1} (choose a name)`} — {assignment.channel}{!channelAvailable(assignment.channel, channelCount) ? ' (unavailable)' : ''}</option>)}
    </select>
    <p className="validation-note">Selecting a stain opens its channel controls without changing other stain assignments. Analysis scope determines which channels are measured. Review thresholds, then rerun analysis. Assign colors from your fluorophore and image channel mapping; antibody catalog numbers alone do not specify a color.</p>
    {panel.assignments.some((item, index) => item.marker && panel.assignments.some((other, otherIndex) => otherIndex < index && other.marker && other.channel === item.channel)) && <p className="validation-note">Stains assigned to the same channel share a combined signal; this view cannot separate them.</p>}
  </fieldset>;
}
