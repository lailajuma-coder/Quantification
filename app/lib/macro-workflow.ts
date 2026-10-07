import type { DecodedImage } from './image-analysis.ts';
export type ConversionRange = {minimum:number;maximum:number};
export function prepareMacroImage(source:DecodedImage, sirius=false, overrides?:ConversionRange[]):DecodedImage {
 const count=source.channelCount, length=source.width*source.height;
 const ranges=Array.from({length:count},()=>({minimum:Infinity,maximum:-Infinity}));
 const value=(i:number,c:number)=>source.samples ? source.samples[i*count+c] : source.rgba[i*4+c];
 for(let i=0;i<length;i++) for(let c=0;c<count;c++) {const v=value(i,c);ranges[c].minimum=Math.min(ranges[c].minimum,v);ranges[c].maximum=Math.max(ranges[c].maximum,v);}
 const conversion=ranges.map((range,c)=>source.analysisBitDepth===8 || !source.samples ? {minimum:0,maximum:255} : overrides?.[c]??range);
 if(conversion.some(r=>!Number.isFinite(r.minimum)||!Number.isFinite(r.maximum)||r.minimum<0||r.maximum<r.minimum)) throw new Error('Invalid conversion range.');
 const samples=new Uint8Array(length*count),rgba=new Uint8ClampedArray(length*4);
 for(let i=0;i<length;i++) {
  for(let c=0;c<count;c++) {
   const {minimum,maximum}=conversion[c];
   const v=Math.max(0,Math.min(255,Math.floor((value(i,c)-minimum)*256/(maximum-minimum+1)+0.5)));
   samples[i*count+c]=v;rgba[i*4+c]=v;
  }
  if(count===1) rgba[i*4+1]=rgba[i*4+2]=rgba[i*4];
  rgba[i*4+3]=255;
 }
 return {...source,samples,rgba,analysisBitDepth:8,analysisWorkflow:sirius?'sirius-magenta':'fluorescence-8bit',conversionRanges:conversion,processing:'8bit-analysis-copy; original source preserved'};
}
