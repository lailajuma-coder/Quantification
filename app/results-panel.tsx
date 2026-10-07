'use client';
import type { AnalysisRecord } from './lib/analysis-record';
import {sampleSummaries,groupSummaries,type StudyTile} from './lib/study';

export default function ResultsPanel({ records, tiles=[], hasStudy=false, exporting, onExcel, onCsv, onJson }: {
  tiles?:StudyTile[]; hasStudy?:boolean; records: AnalysisRecord[]; exporting: boolean; onExcel: () => void; onCsv: () => void; onJson: () => void;
}) {
  const groups=groupSummaries(sampleSummaries(tiles));
  return <aside className="results-panel" aria-label="Channel results">
    <div className="panel-title"><span>02</span><div><h2>Channel results</h2><p>{records.length ? `${records.length} finalized channel measurements` : 'Run analysis'}</p></div></div>
    <div className="results-scroll" tabIndex={0} aria-label="Scrollable channel measurements">
      {groups.length>0 && <details open><summary>Collected groups and samples</summary><p className="validation-note">Excel includes every tile value for GraphPad, plus optional sample and group summaries. Group summaries give each sample equal weight.</p>{groups.map(group=><section className="group-summary" key={JSON.stringify([group.group,group.staining,group.channel,group.region])}><h3>{group.group} · {group.staining}</h3><p>{group.region} · {group.channel}</p><p>{group.n} samples · mean {group.mean?.toFixed(2)??'—'}% · SD {group.sd?.toFixed(2)??'—'} · SEM {group.sem?.toFixed(2)??'—'}</p>{group.samples.map(sample=><p key={sample.sample}>{sample.sample}: {sample.tileCount} tiles · mean {sample.mean?.toFixed(2)??'—'}%{sample.excludedTiles?` · ${sample.excludedTiles} empty regions excluded`:''}</p>)}{group.thresholds.length>1&&<p className="validation-note">Multiple thresholds in this group: {group.thresholds.join('; ')}. Review before comparison.</p>}</section>)}</details>}
      {!records.length && <p className="validation-note">Results appear here after analysis. Changing detection or region settings clears results until you analyze again.</p>}
      {records.map(record => <section className="channel-result" key={record.analysis.signalChannel} aria-label={`${record.analysis.signalChannel} results`}>
        <h3>{record.analysis.signalChannel.toUpperCase()} · {record.analysis.stain}</h3>
        <p className="result-sample">{record.sampleId}</p>
        <div className="primary-metric"><span>Threshold-positive fraction</span><strong>{record.metrics.positivePercent.toFixed(2)}<small>%</small></strong><p>of analyzed pixels</p></div>
        <dl className="metric-list">
          <div><dt>Detection threshold (inclusive)</dt><dd>{record.analysis.minThreshold}–{record.analysis.maxThreshold}</dd></div>
          {Object.entries(record.metrics).map(([key, value]) => <div key={key}><dt title={record.metricDefinitions[key as keyof typeof record.metricDefinitions]}>{({ meanPositive:'Mean (positive)',stdDevPositive:'Std. deviation (positive)',sumPositive:'RawIntDen (positive)',minPositive:'Minimum (positive)',maxPositive:'Maximum (positive)',analyzedPixels:'Analyzed area (px²)', positivePixels:'Positive area (px²)', positivePercent:'Positive (%)', meanScoreAllAnalyzedPixels:'Mean score', modeScoreAllAnalyzedPixels:'Mode score', minScoreAllAnalyzedPixels:'Minimum score', maxScoreAllAnalyzedPixels:'Maximum score', gridPerimeterPixelEdges:'Perimeter (pixel edges)', scoreSumAllAnalyzedPixels:'Score sum', excludedPercent:'Excluded (%)', backgroundPixels:'Background area (px²)', backgroundPositivePixels:'Background positive (px²)', backgroundPositivePercent:'Background positive (%)' } as Record<string,string>)[key] ?? key}</dt><dd>{value!.toLocaleString(undefined, { maximumFractionDigits: 4 })}</dd></div>)}
        </dl>
      </section>)}
    </div>
    <div className="results-exports">
      <button type="button" className="export-button" disabled={(!records.length && !hasStudy) || exporting} onClick={onExcel}>{exporting ? 'Preparing workbook…' : 'Export Excel · staining tabs'}</button>
      <div className="secondary-exports"><button type="button" className="export-button" disabled={!records.length} onClick={onCsv}>Selected channel CSV</button><button type="button" className="export-button" disabled={!records.length} onClick={onJson}>All channels JSON</button></div>
      <p className="calibration-note">Full-resolution measurements. Screen areas use pixels. Excel uses µm² when source calibration is available.</p>
    </div>
  </aside>;
}
