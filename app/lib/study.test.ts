import test from 'node:test';
import assert from 'node:assert/strict';
import {groupAverageThresholds, sampleSummaries,groupSummaries,mergeStudyTiles,type StudyTile} from './study.ts';
import {buildAnalysisRecord} from './analysis-record.ts';
import {analyzeImage,type DecodedImage} from './image-analysis.ts';
import {channelWorkbook} from './workbook-export.ts';
import ExcelJS from 'exceljs';

test('group reference averaging weights mice equally and preserves fixed maxima',()=>{
 const refs=[['M1',10],['M1',30],['M2',80]].map(([sampleId,minimum],i)=>({id:String(i),name:String(i),sampleId:String(sampleId),settings:{green:{minimum:Number(minimum),maximum:255,brightness:1}},conversion:null}));
 assert.equal(groupAverageThresholds(refs).green.average,50);assert.equal(groupAverageThresholds(refs).green.minimum,50);
 refs[2].settings.green.maximum=200;assert.throws(()=>groupAverageThresholds(refs),/maximum/);
});
const image:DecodedImage={width:10,height:1,channelCount:1,samples:new Uint8Array([0,0,0,0,0,0,0,0,0,100]),rgba:new Uint8ClampedArray(40),bitDepth:8,analysisBitDepth:8,sourceFormat:'test',originalShape:'1x10',originalAxes:['Y','X'],selectedShape:'1x10',selectedAxes:['Y','X'],planeSelection:{},processing:'native',processingLocation:'browser',quantitativeStatus:'experimental',sourceSha256:'test'};
const settings={stain:'LTL (IF)',signalChannel:'grayscale' as const,minThreshold:80,maxThreshold:255,removeBackground:false,backgroundTolerance:18,outsideMode:'exclude' as const,structure:'Whole tissue',rois:[]};
function tile(id:string,group:string,mouse:string,percent:number,area=100):StudyTile {
 const record=buildAnalysisRecord({image,result:analyzeImage(image,settings),settings,analyzedAt:'2026-10-07',analyst:'Test',sampleId:mouse,groupName:group,sourceName:id,sourceSize:1,sourceLastModified:0});
 record.metrics.positivePercent=percent;record.metrics.analyzedPixels=area;record.metrics.positivePixels=percent;
 return {id,name:id,records:[record],screenshots:{},reference:false};
}
test('group summaries preserve hierarchy, unequal tile counts, empty regions and replacement',()=>{
 const data=[tile('a','WT','M1',10),tile('b','WT','M1',30),tile('c','WT','M2',80),tile('empty','WT','M2',0,0),tile('d','KO','M1',70)];
 const samples=sampleSummaries(data),groups=groupSummaries(samples);
 assert.equal(samples[0].mean,20);assert.equal(samples[1].excludedTiles,1);
 assert.equal(groups[0].n,2);assert.equal(groups[0].mean,50);assert.equal(groups[0].sd,Math.sqrt(1800));assert.equal(groups[0].sem,30);
 assert.equal(groups[1].n,1);assert.equal(groups[1].sd,null);
 assert.equal(mergeStudyTiles(data,[tile('a','WT','M1',50)]).length,data.length);
});
test('Excel preserves every tile in nested mouse columns and separates duplicate mouse IDs across groups',async()=>{
 const data=[tile('a','WT','M1',10),tile('b','WT','M1',30),tile('c','WT','M2',80),tile('empty','WT','M2',0,0),tile('d','KO','M1',70)];
 const bytes=await channelWorkbook([],data);const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(bytes));
 const nested=book.getWorksheet('GraphPad tiles 1')!;
 assert.equal(nested.getCell('A3').value,'WT');assert.equal(nested.getCell('A4').value,'M1');assert.equal(nested.getCell('A5').value,10);assert.equal(nested.getCell('A6').value,30);
 assert.equal(nested.getCell('B5').value,80);assert.equal(nested.getCell('B6').value,null);
 assert.equal(nested.getCell('C3').value,'KO');assert.equal(nested.getCell('C5').value,70);assert.equal(nested.getCell('D5').value,null);
 assert.equal(book.getWorksheet('Tile values')!.rowCount,6);
 assert.equal(book.getWorksheet('Group summary')!.getCell('F2').value,50);
 const stain=book.getWorksheet('LTL (IF)')!;assert.equal(stain.getCell(3,1).value,'M1');assert.equal(stain.getCell(3,59).value,'M1');assert.match(String(stain.getCell(4,59).value),/KO/);
});
