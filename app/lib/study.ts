import type { AnalysisRecord } from './analysis-record';
import type { RoiRect } from './image-analysis';
import type { ChannelSettings } from './channel-preview';
export type ReferenceTile = { id:string; name:string; sampleId?:string; groupName?:string; stain?:string; sourceId?:string; settings:Record<string,ChannelSettings>; conversion:unknown; rois?:RoiRect[]; regionCategory?:string };
export type StudyTile = { id:string; name:string; records:AnalysisRecord[]; screenshots:Record<string,string>; displaySettings?:Record<string,ChannelSettings>; reference:boolean };
export function averageThresholds(references:ReferenceTile[], fractional=false) {
 if (!references.length) throw new Error('Save at least one reference tile first.');
 const keys=Object.keys(references[0].settings);
 if(references.some(r=>Object.keys(r.settings).sort().join()!==[...keys].sort().join())) throw new Error('Reference tiles must contain the same channels.');
 return Object.fromEntries(keys.map(key=>{
  const values=references.map(r=>r.settings[key]);
  if(values.some(v=>v.maximum!==values[0].maximum)) throw new Error(`Keep the maximum threshold consistent for ${key}.`);
  const average=values.reduce((sum,v)=>sum+v.minimum,0)/values.length;
  const minimum=fractional ? Number(average.toFixed(4)) : Math.round(average);
  return [key,{minimum,maximum:values[0].maximum,brightness:1,average}];
 }));
}

/** Average within sample first, so unequal reference counts do not weight one sample more. */
export function groupAverageThresholds(references: ReferenceTile[], fractional=false) {
 const validation=averageThresholds(references,fractional);
 const samples=[...new Set(references.map(r=>r.sampleId || 'Sample'))];
 const perSample=samples.map(sample=>averageThresholds(references.filter(r=>(r.sampleId||'Sample')===sample),fractional));
 return Object.fromEntries(Object.entries(validation).map(([key,value])=>{
  const average=perSample.reduce((sum,settings)=>sum+settings[key].average,0)/samples.length;
  return [key,{...value,average,minimum:fractional?Number(average.toFixed(4)):Math.round(average)}];
 }));
}
export function mergeStudyTiles(previous: StudyTile[], incoming: StudyTile[]) {
 const merged=new Map(previous.map(tile=>[tile.id,tile]));
 for(const tile of incoming) merged.set(tile.id,tile);
 return [...merged.values()];
}
export function stainingName(record:AnalysisRecord) {
 return record.analysis.stain==='Channel intensity (IF)'?`${record.analysis.signalChannel} channel`:record.analysis.stain;
}
export function sampleSummaries(tiles:StudyTile[]) {
 const buckets=new Map<string,{group:string;sample:string;staining:string;channel:string;region:string; records:AnalysisRecord[]}>();
 for(const tile of mergeStudyTiles([],tiles)) for(const record of tile.records) {
  const context={group:record.groupName||'Ungrouped',sample:record.sampleId,staining:stainingName(record),channel:record.analysis.signalChannel,region:record.analysis.structureCategory};
  const key=JSON.stringify(Object.values(context));
  if(!buckets.has(key))buckets.set(key,{...context,records:[]});
  buckets.get(key)!.records.push(record);
 }
 return [...buckets.values()].map(({records,...context})=>{
  const usable=records.filter(r=>r.metrics.analyzedPixels>0 && Number.isFinite(r.metrics.positivePercent));
  const thresholds=[...new Set(records.map(r=>`${r.analysis.minThreshold}–${r.analysis.maxThreshold}`))];
  return {...context,tileCount:usable.length,excludedTiles:records.length-usable.length,mean:usable.length?usable.reduce((sum,r)=>sum+r.metrics.positivePercent,0)/usable.length:null,thresholds};
 });
}
export function groupSummaries(samples:ReturnType<typeof sampleSummaries>) {
 const buckets=new Map<string,typeof samples>();
 for(const sample of samples){const key=JSON.stringify([sample.group,sample.staining,sample.channel,sample.region]);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key)!.push(sample);}
 return [...buckets.values()].map(samples=>{
  const valid=samples.filter(m=>m.mean!==null),n=valid.length;
  const mean=n?valid.reduce((sum,m)=>sum+m.mean!,0)/n:null;
  const sd=n>1?Math.sqrt(valid.reduce((sum,m)=>sum+(m.mean!-mean!)**2,0)/(n-1)):null;
  const {group,staining,channel,region}=samples[0];
  return {group,staining,channel,region,n,mean,sd,sem:sd===null?null:sd/Math.sqrt(n),samples,thresholds:[...new Set(samples.flatMap(m=>m.thresholds))]};
 });
}
