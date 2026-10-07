import { samplePreview, renderPreview, displayRanges, channelSettingsKey, type ChannelSettings } from './channel-preview';
import type { DecodedImage, AnalysisOptions } from './image-analysis';
export function captureChannels(image:DecodedImage, settings:Record<string,ChannelSettings>,options:AnalysisOptions):Record<string,string> {
 const preview=samplePreview(image,420),auto=displayRanges(preview);
 const colors=['red','green','blue'] as const;
 const values=colors.map(c=>settings[channelSettingsKey(options.stain,image.channelCount===1?'grayscale':c)]??{minimum:0,maximum:255,brightness:1});
 const ranges=values.map((v,i)=>v.displayMaximum??auto[i]);
 const lower=values.map(v=>v.displayMinimum??0),brightness=values.map(v=>v.brightness);
 const output:Record<string,string>={};
 const grid=document.createElement('canvas');grid.width=840;grid.height=900;
 const ctx=grid.getContext('2d')!;ctx.fillStyle='#08100c';ctx.fillRect(0,0,840,900);
 for(const [index,channel] of (['composite',...colors] as const).entries()) {
  const canvas=document.createElement('canvas');canvas.width=preview.width;canvas.height=preview.height;
  const c=canvas.getContext('2d')!;
  c.putImageData(new ImageData(renderPreview(preview,channel,ranges,brightness,options,'original',lower),preview.width,preview.height),0,0);
  // Selected outlines are shown in screenshot exports, without detection colors.
  c.strokeStyle='#ffffff';c.lineWidth=1;
  for(const roi of options.rois) {
    const sx=preview.width/image.width,sy=preview.height/image.height;
    if(roi.points?.length) {c.beginPath();roi.points.forEach((p,j)=>{if(j)c.lineTo(p.x*sx,p.y*sy);else c.moveTo(p.x*sx,p.y*sy);});c.closePath();c.stroke();}
    else c.strokeRect(roi.x*sx,roi.y*sy,roi.width*sx,roi.height*sy);
  }
  output[channel]=canvas.toDataURL('image/png');
  if(channel!=='composite') {
   const value=settings[channelSettingsKey(options.stain,channel)];
   const overlay={...options,signalChannel:channel,minThreshold:value?.minimum??options.minThreshold,maxThreshold:value?.maximum??options.maxThreshold,rois:options.rois.map(r=>({...r,x:r.x*preview.width/image.width,y:r.y*preview.height/image.height,width:r.width*preview.width/image.width,height:r.height*preview.height/image.height,points:r.points?.map(p=>({x:p.x*preview.width/image.width,y:p.y*preview.height/image.height}))}))};
   const overlayCanvas=document.createElement('canvas');overlayCanvas.width=preview.width;overlayCanvas.height=preview.height;
   overlayCanvas.getContext('2d')!.putImageData(new ImageData(renderPreview(preview,channel,ranges,brightness,overlay,'overlay',lower),preview.width,preview.height),0,0);
   output[channel+'-counted']=overlayCanvas.toDataURL('image/png');
  }
  const x=index%2*420,y=Math.floor(index/2)*450;
  ctx.fillStyle='#ffffff';ctx.font='16px Arial';ctx.fillText(channel[0].toUpperCase()+channel.slice(1),x+10,y+22);
  const scale=Math.min(410/preview.width,410/preview.height);
  ctx.drawImage(canvas,x+(420-preview.width*scale)/2,y+32,preview.width*scale,preview.height*scale);
 }
 if(image.analysisWorkflow==='sirius-magenta') {
  const canvas=document.createElement('canvas');canvas.width=preview.width;canvas.height=preview.height;const context=canvas.getContext('2d')!;
  const pixels=new Uint8ClampedArray(preview.rgba.length);
  for(let i=0;i<preview.width*preview.height;i++) {const r=preview.samples![i*preview.channelCount],g=preview.samples![i*preview.channelCount+1],b=preview.samples![i*preview.channelCount+2],max=Math.max(r,g,b);pixels[i*4]=pixels[i*4+2]=max?Math.round((max-g)/max*255):0;pixels[i*4+3]=255;}
  context.putImageData(new ImageData(pixels,preview.width,preview.height),0,0);output.magenta=canvas.toDataURL('image/png');
 }
 output.all=grid.toDataURL('image/png');return output;
}
