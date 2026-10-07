import ExcelJS from 'exceljs';
import type { AnalysisRecord } from './analysis-record';
import {sampleSummaries,groupSummaries,stainingName,mergeStudyTiles,type ReferenceTile,type StudyTile} from './study.ts';
import type { ChannelSettings } from './channel-preview';

export async function channelWorkbook(records:AnalysisRecord[], tiles:StudyTile[]=[],references:ReferenceTile[]=[],accepted:Record<string,ChannelSettings>|null=null,groups:{name:string;stain:string;accepted:Record<string,ChannelSettings>|null;reason:string}[]=[]) {
 const workbook=new ExcelJS.Workbook();workbook.creator='Quantification';
 const entries=tiles.length?mergeStudyTiles([],tiles):[{id:'current',name:records[0]?.source.name??'Current',records,screenshots:{},reference:false} as StudyTile];
 const all=entries.flatMap(t=>t.records);
 const headers=['Row','Label / filename','Area','Mean','Min','Max','IntDen','%Area','RawIntDen','MinThr','MaxThr','Area units'];
 const stains=[...new Set(all.map(r=>r.analysis.stain==='Channel intensity (IF)'?`${r.analysis.signalChannel} channel`:r.analysis.stain))];
 const usedNames=new Set(['Reference thresholds','Provenance','Sample summary','Group summary','Tile values','Group thresholds']);
 for(const staining of stains) {
  let name=staining.replace(/[\\/?*\[\]:]/g,' ').slice(0,31)||'Staining';const base=name;let suffix=2;while(usedNames.has(name)){name=base.slice(0,27)+' '+suffix++;}usedNames.add(name);
  const sheet=workbook.addWorksheet(name);sheet.getRow(1).values=[staining];sheet.getRow(2).values=['Each sample has its own column group. Tiles run vertically. Baseline and threshold-positive rows share the same ROI denominator.'];
  const relevant=entries.flatMap(tile=>tile.records.filter(r=>(r.analysis.stain==='Channel intensity (IF)'?`${r.analysis.signalChannel} channel`:r.analysis.stain)===staining).map(record=>({tile,record})));
  const sampleKey=(r:AnalysisRecord)=>JSON.stringify([r.groupName,r.sampleId,r.analysis.structureCategory,r.analysis.signalChannel]);
  const samples=[...new Set(relevant.map(({record})=>sampleKey(record)))];
  for(const [sampleIndex,sample] of samples.entries()) {
   const offset=sampleIndex*29;
   for(let i=0;i<29;i++)sheet.getColumn(offset+i+1).width=i===1?32:i<12?15:11;
   const first=relevant.find(({record})=>sampleKey(record)===sample)!.record;
   sheet.getCell(3,offset+1).value=first.sampleId;sheet.getCell(4,offset+1).value=`${first.groupName} · ${first.analysis.structureCategory} · ${first.analysis.signalChannel}`;
   let row=5;
   for(const [index,{tile,record}] of relevant.filter(({record})=>sampleKey(record)===sample).entries()) {
    headers.forEach((header,i)=>sheet.getCell(row,offset+i+1).value=header);sheet.getRow(row).height=30;sheet.getRow(row+1).height=32;sheet.getRow(row+2).height=32;
    const m=record.metrics,scale=record.source.pixelSizeMicrons ? record.source.pixelSizeMicrons[0]*record.source.pixelSizeMicrons[1] : 1;
    const unit=record.source.pixelSizeMicrons?'µm²':'px²';
    const baseline=[index+1,`${tile.name} — baseline`,m.analyzedPixels*scale,m.meanScoreAllAnalyzedPixels,m.minScoreAllAnalyzedPixels,m.maxScoreAllAnalyzedPixels,m.scoreSumAllAnalyzedPixels*scale,100,m.scoreSumAllAnalyzedPixels,0,record.source.analysisWorkflow==='sirius-magenta'?1:255,unit];
    const positive=[index+1,`${tile.name} — positive`,m.positivePixels*scale,m.meanPositive??null,m.minPositive??null,m.maxPositive??null,(m.sumPositive??0)*scale,m.positivePercent,m.sumPositive??null,record.analysis.minThreshold,record.analysis.maxThreshold,unit];
    for(const [j,values] of [baseline,positive].entries())values.forEach((v,i)=>sheet.getCell(row+1+j,offset+i+1).value=v);
    const channel=record.analysis.signalChannel;
    const sources=record.source.analysisWorkflow==='sirius-magenta'?[tile.screenshots.composite,tile.screenshots.magenta,tile.screenshots.all]:[tile.screenshots[channel],tile.screenshots[channel+'-counted'],tile.screenshots.all];
    sources.forEach((base64,i)=>{if(!base64)return;const imageId=workbook.addImage({base64,extension:'png'});sheet.addImage(imageId,{tl:{col:offset+13+i*5,row:row-1},ext:{width:265,height:265}});});
    row+=20;
   }
  }
  sheet.views=[{state:'frozen',ySplit:4}];
  sheet.eachRow(r=>{r.alignment={vertical:'top',wrapText:true};r.eachCell(c=>{if(typeof c.value==='number')c.numFmt='0.0000';});});sheet.getRow(1).font={bold:true,size:16,color:{argb:'FF1E6B4D'}};
 }
 const sampleRows=sampleSummaries(entries),summary=groupSummaries(sampleRows);
 const samplesSheet=workbook.addWorksheet('Sample summary');
 samplesSheet.addRow(['Group','Staining','Channel','Region','Sample ID','Valid tile count','Mean tile % area','Empty region tiles excluded','Thresholds used']);
 for(const m of sampleRows)samplesSheet.addRow([m.group,m.staining,m.channel,m.region,m.sample,m.tileCount,m.mean,m.excludedTiles,m.thresholds.join('; ')]);
 const groupSheet=workbook.addWorksheet('Group summary');
 groupSheet.addRow(['Group','Staining','Channel','Region','N samples with measurements','Mean of sample means (%)','SD between sample means','SEM','Thresholds used','Review']);
 for(const g of summary)groupSheet.addRow([g.group,g.staining,g.channel,g.region,g.n,g.mean,g.sd,g.sem,g.thresholds.join('; '),g.thresholds.length>1?'Multiple thresholds: review':'' ]);
 const raw=workbook.addWorksheet('Tile values');
 raw.addRow(['Group','Staining','Channel','Region','Sample ID','Tile filename','% positive area','Analyzed pixels','Positive pixels','Minimum threshold','Maximum threshold','Status']);
 for(const tile of entries)for(const r of tile.records)raw.addRow([r.groupName,stainingName(r),r.analysis.signalChannel,r.analysis.structureCategory,r.sampleId,tile.name,r.metrics.analyzedPixels>0?r.metrics.positivePercent:null,r.metrics.analyzedPixels,r.metrics.positivePixels,r.analysis.minThreshold,r.analysis.maxThreshold,r.metrics.analyzedPixels>0?'Measured':'No analyzed pixels; not included in summaries']);
 const panels=[...new Set(sampleRows.map(m=>JSON.stringify([m.staining,m.channel,m.region])))];
 for(const [i,panel] of panels.entries()) {
  const context=JSON.parse(panel) as string[];
  const relevant=sampleRows.filter(m=>JSON.stringify([m.staining,m.channel,m.region])===panel);
  const names=[...new Set(relevant.map(m=>m.group))];
  let nestedName=`GraphPad tiles ${i+1}`,suffix=2;while(usedNames.has(nestedName))nestedName=`GraphPad tiles ${i+1} (${suffix++})`;const nested=workbook.addWorksheet(nestedName);usedNames.add(nested.name);
  nested.addRow([context.join(' · ')]);
  nested.addRow(['Nested layout: groups across, one sample per subcolumn, all tile % area values down rows. Blank = missing/empty region, not zero. See Tile values for filenames. Rows are not paired between samples.']);
  const width=Math.max(...names.map(name=>relevant.filter(m=>m.group===name).length));
  for(const [g,name] of names.entries()) {
   const groupSamples=relevant.filter(m=>m.group===name);
   for(let slot=0;slot<width;slot++){
    const col=g*width+slot+1,sample=groupSamples[slot];nested.getColumn(col).width=23;
    nested.getCell(3,col).value=name;nested.getCell(4,col).value=sample?.sample??null;
    if(!sample)continue;
    const records=entries.flatMap(t=>t.records).filter(r=>(r.groupName||'Ungrouped')===name&&r.sampleId===sample.sample&&stainingName(r)===context[0]&&r.analysis.signalChannel===context[1]&&r.analysis.structureCategory===context[2]);
    records.forEach((r,row)=>{nested.getCell(row+5,col).value=r.metrics.analyzedPixels>0?r.metrics.positivePercent:null;nested.getCell(row+5,col).numFmt='0.0000';});
   }
  }
  nested.views=[{state:'frozen',ySplit:4}];nested.getRow(1).font={bold:true};nested.getRow(3).font={bold:true};
 }
 const groupThresholds=workbook.addWorksheet('Group thresholds');
 groupThresholds.addRow(['Group','Staining / panel','Channel / score','Accepted minimum','Fixed maximum','Selection notes']);
 for(const group of groups)for(const [channel,values] of Object.entries(group.accepted??{}))groupThresholds.addRow([group.name,group.stain,channel,values.minimum,values.maximum,group.reason]);
 groupThresholds.addRow(['Group minimum = mean of per-sample reference means, then rounded. Different group thresholds can affect comparability; retain the selection rationale.']);
 for(const sheet of [samplesSheet,groupSheet,raw,groupThresholds]){sheet.columns.forEach(col=>{col.width=24;});sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).font={bold:true};}
 const ref=workbook.addWorksheet('Reference thresholds');ref.columns=[{width:45},{width:24},{width:18},{width:18},{width:50}];ref.addRow(['Reference tile','Channel / score','Minimum','Fixed maximum','Conversion ranges','Region category','ROIs','Group','Sample ID','Staining']);
 for(const tile of references) for(const [key,value] of Object.entries(tile.settings))ref.addRow([tile.name,key,value.minimum,value.maximum,JSON.stringify(tile.conversion),tile.regionCategory??'Whole tissue',JSON.stringify(tile.rois??[]),tile.groupName??'',tile.sampleId??'',tile.stain??'']);
 ref.addRow([]);ref.addRow(['Current group accepted thresholds']);for(const [key,value] of Object.entries(accepted??{}))ref.addRow(['Applied',key,value.minimum,value.maximum]);
 ref.addRow(['Group means average sample reference means equally. 8-bit mean minima rounded to nearest integer; Sirius Red means rounded to 4 decimals.']);
 const metadata=workbook.addWorksheet('Provenance');metadata.columns=[{width:35},{width:55},{width:100}];metadata.addRow(['Tile','Field','Value']);
 for(const tile of entries) for(const record of tile.records) {
  const add=(prefix:string,value:unknown)=>{
   if(value!==null && typeof value==='object'&&!Array.isArray(value))for(const [key,child] of Object.entries(value))add(prefix?`${prefix}.${key}`:key,child);
   else metadata.addRow([tile.name,prefix,Array.isArray(value)?JSON.stringify(value):value]);
  };add('',record);add('screenshotDisplaySettings',tile.displaySettings??{});
 }
 for(const sheet of [ref,metadata]){sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).font={bold:true};}
 return new Uint8Array(await workbook.xlsx.writeBuffer());
}
