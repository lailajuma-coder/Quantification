import test from 'node:test';import assert from 'node:assert/strict';
import {prepareMacroImage} from './macro-workflow.ts';import {averageThresholds} from './study.ts';import {analyzeImage,type DecodedImage,type AnalysisOptions} from './image-analysis.ts';
const source:DecodedImage={width:4,height:1,channelCount:1,samples:new Uint16Array([100,200,300,400]),rgba:new Uint8ClampedArray(16),bitDepth:16,analysisBitDepth:16,sourceFormat:'test',originalShape:'1x4',originalAxes:['Y','X'],selectedShape:'1x4',selectedAxes:['Y','X'],planeSelection:{},processing:'native',processingLocation:'browser',quantitativeStatus:'experimental',sourceSha256:'test'};
const options:AnalysisOptions={stain:'LTL (IF)',signalChannel:'grayscale',minThreshold:80,maxThreshold:255,removeBackground:false,backgroundTolerance:18,outsideMode:'exclude',structure:'Whole tissue',rois:[]};
test('16-bit conversion follows ImageJ short-to-byte rounding and preserves original',()=>{
 const converted=prepareMacroImage(source);assert.deepEqual(Array.from(converted.samples!),[0,85,170,255]);assert.deepEqual(Array.from(source.samples!),[100,200,300,400]);
 const result=analyzeImage(converted,options);assert.equal(result.positivePixels,3);assert.equal(result.positiveMean,170);assert.equal(result.positiveSum,510);assert.equal(result.positivePercent,75);
});
test('reference means keep maxima fixed, reject channel mismatches, round only applied 8-bit minimum',()=>{
 const refs=[1,2].map((v)=>({id:String(v),name:String(v),settings:{green:{minimum:80+v,maximum:255,brightness:1}},conversion:null}));
 assert.equal(averageThresholds(refs).green.average,81.5);assert.equal(averageThresholds(refs).green.minimum,82);
 refs[1].settings.green.maximum=200;assert.throws(()=>averageThresholds(refs),/maximum/);
});
test('freehand ROI uses polygon interior rather than bounding rectangle and overlaps count once',()=>{
 const image={...source,width:4,height:4,samples:new Uint8Array(16).fill(100),rgba:new Uint8ClampedArray(64),analysisBitDepth:8};
 const roi={x:0,y:0,width:4,height:4,points:[{x:0,y:0},{x:4,y:0},{x:0,y:4}]};
 const result=analyzeImage(image,{...options,structure:'Glomeruli',rois:[roi,roi]});assert.equal(result.analyzedPixels,6);assert.equal(result.positivePercent,100);
 const crop=analyzeImage(image,{...options,rois:[{x:0,y:0,width:2,height:2}]});assert.equal(crop.analyzedPixels,4);
});
test('Sirius Red uses fractional CMYK magenta and threshold-limited intensity',()=>{
 const image={...source,width:3,height:1,channelCount:3,samples:new Uint8Array([200,100,50,100,90,20,0,0,0]),rgba:new Uint8ClampedArray(12),analysisBitDepth:8};
 const prepared=prepareMacroImage(image,true);const result=analyzeImage(prepared,{...options,stain:'Sirius Red',signalChannel:'red',minThreshold:.35,maxThreshold:1});assert.equal(result.positivePixels,1);assert.equal(result.positiveMean,.5);assert.equal(result.positivePercent,50);
});
