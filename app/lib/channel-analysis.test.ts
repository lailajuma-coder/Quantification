import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChannels } from './channel-analysis.ts';
import type { DecodedImage } from './image-analysis.ts';
import type { AnalysisSettingsSnapshot } from './analysis-record.ts';

const image: DecodedImage = {
  width:4, height:1, channelCount:3, bitDepth:16, analysisBitDepth:16,
  samples: new Uint16Array([0,0,0,100,1000,10000,200,2000,20000,300,3000,30000]),
  rgba:new Uint8ClampedArray(16), sourceFormat:'test',originalShape:'1x4x3',originalAxes:['Y','X','C'],selectedShape:'1x4x3',selectedAxes:['Y','X','C'],planeSelection:{},processing:'native-integer-samples',processingLocation:'browser',quantitativeStatus:'experimental',sourceSha256:'test',
};
const settings:AnalysisSettingsSnapshot={stain:'DAPI (IF)',signalChannel:'blue',minThreshold:10000,maxThreshold:30000,removeBackground:false,backgroundTolerance:18,outsideMode:'exclude',structure:'Whole tissue',rois:[],stainingPanel:{coStained:'yes',activeId:'b',assignments:[{id:'r',marker:'ApoJ',channel:'red',reagent:''},{id:'g',marker:'LTL',channel:'green',reagent:''},{id:'b',marker:'DAPI',channel:'blue',reagent:''}]}};
const provenance={analyst:'test',sampleId:'=literal sample',sourceName:'sample.nd2',sourceSize:0,sourceLastModified:0};
const saved={'fluorescence:red':{minimum:100,maximum:100,brightness:1},'fluorescence:green':{minimum:1000,maximum:2000,brightness:1}};
test('all channels use independent native thresholds and correct marker provenance',()=>{
 const records=analyzeChannels(image,settings,saved,provenance);
 assert.deepEqual(records.map(r=>r.analysis.signalChannel),['red','green','blue']);
 assert.deepEqual(records.map(r=>r.metrics.positivePixels),[1,2,3]);
 assert.deepEqual(records.map(r=>r.analysis.stain),['ApoJ (IF)','LTL (IF)','DAPI (IF)']);
 assert.deepEqual(records.map(r=>r.analysis.stainingPanel.activeId),['r','g','b']);
 assert.equal(new Set(records.map(r=>r.analyzedAt)).size,1);
 assert.equal(records[0].analysis.maxThreshold,100);
 settings.stainingPanel!.assignments[0].reagent='changed';
 assert.equal(records[0].analysis.stainingPanel.assignments[0].reagent,'');
});
test('single and two channel sources do not invent measurements for missing channels',()=>{
 const mono={...image,channelCount:1,samples:new Uint16Array([0,1,2,3])};
 assert.deepEqual(analyzeChannels(mono,settings,{},provenance).map(r=>r.analysis.signalChannel),['grayscale']);
 const two={...image,channelCount:2,samples:new Uint16Array([0,0,1,1,2,2,3,3])};
 assert.deepEqual(analyzeChannels(two,settings,{},provenance).map(r=>r.analysis.signalChannel),['red','green']);
});

test('specific scope quantifies only that channel using its own saved thresholds',()=>{
 const onlyGreen=analyzeChannels(image,settings,{...saved,'fluorescence:red':{minimum:-1,maximum:-1,brightness:1}},provenance,'green');
 assert.equal(onlyGreen.length,1);assert.equal(onlyGreen[0].analysis.signalChannel,'green');assert.equal(onlyGreen[0].analysis.stain,'LTL (IF)');assert.equal(onlyGreen[0].metrics.positivePixels,2);
 assert.equal(analyzeChannels(image,settings,saved,provenance,'blue')[0].metrics.positivePixels,3);
 const two={...image,channelCount:2,samples:new Uint16Array([0,0,1,1,2,2,3,3])};
 assert.throws(()=>analyzeChannels(two,settings,{},provenance,'blue'),/not available/);
});
