'use client';

import {useEffect, useRef, useState, type PointerEvent} from 'react';

type Point = {x:number;y:number};
type Shape = {kind:'rectangle'|'ellipse'|'arrow'|'line'|'freehand';color:string;width:number;points:Point[]};

function paintShape(ctx:CanvasRenderingContext2D,shape:Shape) {
 const a=shape.points[0],b=shape.points[shape.points.length-1];
 ctx.save();ctx.strokeStyle=shape.color;ctx.lineWidth=shape.width;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();
 if(shape.kind==='rectangle')ctx.rect(a.x,a.y,b.x-a.x,b.y-a.y);
 else if(shape.kind==='ellipse')ctx.ellipse((a.x+b.x)/2,(a.y+b.y)/2,Math.abs(b.x-a.x)/2,Math.abs(b.y-a.y)/2,0,0,Math.PI*2);
 else {ctx.moveTo(a.x,a.y);if(shape.kind==='freehand')shape.points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));else ctx.lineTo(b.x,b.y);}
 ctx.stroke();
 if(shape.kind==='arrow') {const angle=Math.atan2(b.y-a.y,b.x-a.x),size=12+shape.width*2;ctx.beginPath();ctx.moveTo(b.x-size*Math.cos(angle-Math.PI/6),b.y-size*Math.sin(angle-Math.PI/6));ctx.lineTo(b.x,b.y);ctx.lineTo(b.x-size*Math.cos(angle+Math.PI/6),b.y-size*Math.sin(angle+Math.PI/6));ctx.stroke();}
 ctx.restore();
}

export default function PngAnnotationEditor({source,filename,onClose}:{source:string;filename:string;onClose:()=>void}) {
 const dialog=useRef<HTMLDialogElement>(null),canvas=useRef<HTMLCanvasElement>(null),base=useRef<HTMLImageElement|null>(null),draft=useRef<Shape|null>(null);
 const [shapes,setShapes]=useState<Shape[]>([]),[kind,setKind]=useState<Shape['kind']>('arrow'),[color,setColor]=useState('#ffff00'),[width,setWidth]=useState(3),[ready,setReady]=useState(false);
 const repaint=(items:Shape[],pending:Shape|null=null)=>{const c=canvas.current,ctx=c?.getContext('2d');if(!c||!ctx||!base.current)return;ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(base.current,0,0);items.forEach(shape=>paintShape(ctx,shape));if(pending)paintShape(ctx,pending);};
 useEffect(()=>{dialog.current?.showModal();const img=new Image();let active=true;img.onload=()=>{if(!active||!canvas.current)return;base.current=img;canvas.current.width=img.width;canvas.current.height=img.height;canvas.current.getContext('2d')?.drawImage(img,0,0);setReady(true);};img.src=source;return()=>{active=false;};},[source]);
 useEffect(()=>{repaint(shapes);},[shapes,ready]);
 const point=(e:PointerEvent<HTMLCanvasElement>)=>{const c=e.currentTarget,r=c.getBoundingClientRect();return{x:Math.max(0,Math.min(c.width,(e.clientX-r.left)*c.width/r.width)),y:Math.max(0,Math.min(c.height,(e.clientY-r.top)*c.height/r.height))};};
 const move=(e:PointerEvent<HTMLCanvasElement>)=>{const shape=draft.current;if(!shape)return;const p=point(e);shape.points=shape.kind==='freehand'?[...shape.points,p]:[shape.points[0],p];repaint(shapes,shape);};
 const cancel=()=>{draft.current=null;repaint(shapes);};
 return <dialog ref={dialog} className="png-annotation-dialog" aria-labelledby="annotation-title" onCancel={onClose}>
  <div className="annotation-header"><div><h2 id="annotation-title">Annotate PNG</h2><p>Draw on any image. Annotations only affect this PNG, not quantification.</p></div><button type="button" onClick={onClose}>Close</button></div>
  <div className="annotation-tools">
   <label htmlFor="annotation-shape">Shape</label><select id="annotation-shape" value={kind} onChange={e=>setKind(e.target.value as Shape['kind'])}><option value="arrow">Arrow</option><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse / circle</option><option value="line">Line</option><option value="freehand">Freehand</option></select>
   <label htmlFor="annotation-color">Color</label><input id="annotation-color" type="color" value={color} onChange={e=>setColor(e.target.value)} />
   <label htmlFor="annotation-width">Line width</label><select id="annotation-width" value={width} onChange={e=>setWidth(Number(e.target.value))}>{[1,2,3,5,8].map(w=><option key={w} value={w}>{w} px</option>)}</select>
   <button type="button" disabled={!shapes.length} onClick={()=>setShapes(items=>items.slice(0,-1))}>Undo</button>
   <button type="button" disabled={!shapes.length} onClick={()=>setShapes([])}>Clear annotations</button>
   <button type="button" disabled={!ready} onClick={()=>{repaint(shapes);const link=document.createElement('a');link.href=canvas.current!.toDataURL('image/png');link.download=filename;link.click();}}>Download PNG</button>
   <span role="status">{shapes.length} annotation{shapes.length===1?'':'s'}</span>
  </div>
  <div className="annotation-image"><canvas ref={canvas} aria-label="PNG annotation canvas" onPointerDown={e=>{if(!ready||e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);const p=point(e);draft.current={kind,color,width,points:[p,p]};}} onPointerMove={move} onPointerUp={e=>{if(!draft.current)return;move(e);const completed=draft.current;draft.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);if(completed.points.some(p=>Math.hypot(p.x-completed.points[0].x,p.y-completed.points[0].y)>1))setShapes(items=>[...items,completed]);else repaint(shapes);}} onPointerCancel={cancel} onLostPointerCapture={cancel}/></div>
 </dialog>;
}
