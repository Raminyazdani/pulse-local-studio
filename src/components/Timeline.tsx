import { useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Film, Music2, Plus, Eye, EyeOff, Volume2, VolumeX, LockKeyhole, UnlockKeyhole, Trash2, Layers2, Magnet, Minus, Maximize2, Flag, MousePointer2 } from 'lucide-react';
import type { Clip, Project, Track } from '../lib/types';
import { clipDuration, clipWaveform, flattenClip, projectDuration, sourceToOutput, outputToSource, trimClip, formatTime } from '../lib/engine';
import { visibleBeats } from '../editor';

interface Props {
  project:Project; time:number; selected:string[]; selectedTrack:string; zoom:number; tool:'select'|'marker';
  onTime:(t:number)=>void; onSelect:(ids:string[])=>void; onTrack:(id:string)=>void; onZoom:(z:number)=>void;
  onTool:(tool:'select'|'marker')=>void; onChange:(project:Project)=>void; onAddTrack:(kind:'video'|'audio')=>void;
  onDropMedia:(mediaId:string,trackId:string,time:number)=>void; onMarker:(clipId:string,localOutput:number)=>void;
  onMerge:()=>void;
}
type Drag = { type:'move'|'left'|'right'|'signal'; original:Clip; x:number; y:number; signal?:number; draft:Clip };

export function Timeline(p:Props) {
  const [snap,setSnap]=useState(true);
  const [drag,setDrag]=useState<Drag|null>(null);
  const viewport=useRef<HTMLDivElement>(null);
  const waveforms=useMemo(()=>new Map(p.project.clips.map(c=>[c.id,clipWaveform(c,p.project.media,Math.min(1500,Math.max(64,Math.ceil(clipDuration(c)*p.zoom/2))))])),[p.project,p.zoom]);
  const total=Math.max(30, projectDuration(p.project)+8);
  const width=Math.max(total*p.zoom,(viewport.current?.clientWidth??900)-168);
  const step=p.zoom<16?10:p.zoom<36?5:p.zoom<90?2:1;
  const grid=Array.from({length:Math.floor(width/p.zoom/step)+1},(_,i)=>i*step);
  const beatTargets=p.project.clips.filter(c=>p.project.tracks.find(t=>t.id===c.trackId)?.kind==='audio').flatMap(c=>visibleBeats(c,p.project));
  function snapTime(value:number,exclude?:string) {
    if(!snap)return Math.max(0,value);
    const targets=[0,p.time,...beatTargets,...p.project.clips.filter(c=>c.id!==exclude).flatMap(c=>[c.start,c.start+clipDuration(c)])];
    let best=value,delta=8/p.zoom;
    for(const target of targets)if(Math.abs(value-target)<delta){best=target;delta=Math.abs(value-target);}
    return Math.max(0,best);
  }
  function begin(e:ReactPointerEvent,clip:Clip,type:Drag['type'],signal?:number){
    e.stopPropagation();
    const track=p.project.tracks.find(t=>t.id===clip.trackId); if(track?.locked)return;
    if(e.button!==0)return;
    p.onTrack(clip.trackId);
    if(type==='move') {
      if(p.tool==='marker') { const rect=e.currentTarget.getBoundingClientRect();p.onMarker(clip.id,(e.clientX-rect.left)/p.zoom);return; }
      p.onSelect(e.shiftKey? p.selected.includes(clip.id)?p.selected.filter(id=>id!==clip.id):[...p.selected,clip.id]:[clip.id]);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const editable=type==='signal'?flattenClip(clip):clip;
    setDrag({type,original:editable,x:e.clientX,y:e.clientY,signal,draft:editable});
  }
  function move(e:ReactPointerEvent){
    if(!drag)return;
    const delta=(e.clientX-drag.x)/p.zoom;
    const original=drag.original;
    let draft={...original};
    try {
      if(drag.type==='move') {
        draft.start=snapTime(original.start+delta,original.id);
        const row=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-track-id]');
        const target=p.project.tracks.find(t=>t.id===row?.getAttribute('data-track-id'));
        const own=p.project.tracks.find(t=>t.id===original.trackId);
        if(target&&!target.locked&&target.kind===own?.kind)draft.trackId=target.id;
      } else if(drag.type==='left') {
        const start=Math.min(original.start+clipDuration(original)-.06,snapTime(original.start+delta,original.id));
        draft=trimClip(original,Math.max(original.start,start),original.start+clipDuration(original));
      } else if(drag.type==='right') {
        const end=Math.max(original.start+.06,snapTime(original.start+clipDuration(original)+delta,original.id));
        draft=trimClip(original,original.start,Math.min(original.start+clipDuration(original),end));
      } else if(drag.signal!==undefined) {
        const values=[...original.signals];
        const local=Math.min(clipDuration(original)-.001,Math.max(0,sourceToOutput(original,values[drag.signal])+delta));
        values[drag.signal]=outputToSource(original,local);
        draft.signals=values.sort((a,b)=>a-b); draft.warp=undefined;
      }
      setDrag({...drag,draft});
    }catch{ /* stop at valid source bounds */ }
  }
  function finish(){
    if(drag && JSON.stringify(drag.original)!==JSON.stringify(drag.draft))p.onChange({...p.project,clips:p.project.clips.map(c=>c.id===drag.original.id?drag.draft:c)});
    setDrag(null);
  }
  function toggle(track:Track,key:'muted'|'hidden'|'locked'){p.onChange({...p.project,tracks:p.project.tracks.map(t=>t.id===track.id?{...t,[key]:!t[key]}:t)});}
  function seek(e:ReactPointerEvent){
    const rect=e.currentTarget.getBoundingClientRect();
    p.onTime(Math.max(0,Math.min(projectDuration(p.project),(e.clientX-rect.left)/p.zoom)));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  return <section className="timeline-panel">
    <div className="timeline-toolbar">
      <div className="toolbar-group"><span className="panel-heading">TIMELINE</span><span className="subtle-tag">{p.project.tracks.length} tracks</span><span className="divider"/>
        <button title="Selection tool (V)" className={p.tool==='select'?'tool-button active':'tool-button'} onClick={()=>p.onTool('select')}><MousePointer2 size={15}/></button>
        <button title="Beat marker tool (B). Click a clip to add a marker." className={p.tool==='marker'?'tool-button active':'tool-button'} onClick={()=>p.onTool('marker')}><Flag size={15}/></button>
        <button title="Snap to beats, playhead and clip edges" className={snap?'tool-button active':'tool-button'} onClick={()=>setSnap(!snap)}><Magnet size={15}/></button>
      </div>
      <div className="toolbar-group"><button className="text-button" title="Join all clips in selected track, closing gaps" onClick={p.onMerge}><Layers2 size={15}/>Merge track</button><span className="divider"/><button className="tool-button" onClick={()=>p.onZoom(Math.max(6,p.zoom/1.35))} title="Zoom out"><Minus size={14}/></button><input aria-label="Timeline zoom" className="zoom-slider" type="range" min="6" max="180" value={p.zoom} onChange={e=>p.onZoom(+e.target.value)}/><button className="tool-button" onClick={()=>p.onZoom(Math.min(180,p.zoom*1.35))} title="Zoom in"><Plus size={14}/></button><button className="tool-button" title="Fit sequence" onClick={()=>p.onZoom(Math.max(6,Math.min(180,((viewport.current?.clientWidth??1000)-190)/Math.max(10,projectDuration(p.project)+2))))}><Maximize2 size={14}/></button></div>
    </div>
    <div className="timeline-scroll" ref={viewport}>
      <div className="timeline-content" style={{width:width+168}}>
        <div className="ruler-row"><div className="track-header ruler-label">TRACKS <span>SEC</span></div><div className="ruler" style={{width}} onPointerDown={seek} onPointerMove={e=>{if(e.buttons===1)seek(e);}}>{grid.map(t=><span className="ruler-tick" key={t} style={{left:t*p.zoom}}>{formatTime(t)}</span>)}</div></div>
        {p.project.tracks.map((track,index)=><div className={`track-row ${track.kind} ${p.selectedTrack===track.id?'chosen':''}`} key={track.id} data-track-id={track.id}>
          <div className="track-header" onClick={()=>p.onTrack(track.id)}><div className="track-name">{track.kind==='video'?<Film size={14}/>:<Music2 size={14}/>}<input aria-label="Track name" disabled={track.locked} value={track.name} onChange={e=>p.onChange({...p.project,tracks:p.project.tracks.map(t=>t.id===track.id?{...t,name:e.target.value}:t)})}/><span className="track-number">{String(index+1).padStart(2,'0')}</span></div><div className="track-actions"><button className={track.muted?'enabled':''} title="Mute track" onClick={()=>toggle(track,'muted')}>{track.muted?<VolumeX size={13}/>:<Volume2 size={13}/>}</button>{track.kind==='video'&&<button className={track.hidden?'enabled':''} title="Hide track" onClick={()=>toggle(track,'hidden')}>{track.hidden?<EyeOff size={13}/>:<Eye size={13}/>}</button>}<button className={track.locked?'enabled':''} title="Lock track" onClick={()=>toggle(track,'locked')}>{track.locked?<LockKeyhole size={12}/>:<UnlockKeyhole size={12}/>}</button><button disabled={track.locked} title="Remove this track and its clips (undo available)" onClick={()=>p.onChange({...p.project,tracks:p.project.tracks.filter(t=>t.id!==track.id),clips:p.project.clips.filter(c=>c.trackId!==track.id)})}><Trash2 size={12}/></button></div></div>
          <div className={`track-lane ${track.locked?'locked':''}`} style={{width,backgroundSize:`${step*p.zoom}px 100%`}} onDragOver={e=>{if(!track.locked)e.preventDefault();}} onDrop={e=>{e.preventDefault();const id=e.dataTransfer.getData('pulse/media');if(id&&!track.locked)p.onDropMedia(id,track.id,Math.max(0,(e.clientX-e.currentTarget.getBoundingClientRect().left)/p.zoom));}} onPointerDown={e=>{if(e.target===e.currentTarget){p.onTrack(track.id);p.onSelect([]);seek(e);}}}>
            {!p.project.clips.some(c=>c.trackId===track.id)&&<span className="track-empty">{track.kind==='video'?'Drop video or images here':'Drop your soundtrack here'}</span>}
            {p.project.clips.filter(c=>c.trackId===track.id).map(original=>{
              const clip=drag?.original.id===original.id?drag.draft:original;
              const media=p.project.media.find(m=>m.id===clip.segments[0]?.mediaId);
              const beats=track.kind==='audio'?visibleBeats(clip,p.project):[];
              const waveform=waveforms.get(clip.id)??[];
              const clipWidth=Math.max(4,clipDuration(clip)*p.zoom);
              return <div key={clip.id} data-clip-id={clip.id} className={`timeline-clip ${track.kind} ${p.selected.includes(clip.id)?'selected':''} ${clip.warp?'warped':''} ${clip.muted?'muted':''}`} style={{left:clip.start*p.zoom,width:clipWidth,transform:drag?.original.id===clip.id&&clip.trackId!==track.id?`translateY(${(p.project.tracks.findIndex(t=>t.id===clip.trackId)-index)*92}px)`:undefined}} onPointerDown={e=>begin(e,original,'move')} onPointerMove={move} onPointerUp={finish} onPointerCancel={()=>setDrag(null)} onDoubleClick={e=>{if(p.tool==='select')p.onMarker(clip.id,(e.clientX-e.currentTarget.getBoundingClientRect().left)/p.zoom);}}>
                {track.kind==='video'&&media?.thumbnailUrl&&<div className="clip-thumbnails" style={{backgroundImage:`url("${media.thumbnailUrl}")`}}/>}
                {track.kind==='audio'&&<svg className="waveform" viewBox={`0 0 ${Math.max(1,waveform.length)} 60`} preserveAspectRatio="none">{waveform.map((v,i)=><line key={i} x1={i} x2={i} y1={30-v*26} y2={30+v*26} stroke="currentColor" strokeWidth=".75"/>)}</svg>}
                <div className="clip-label">{track.kind==='video'?<Film size={12}/>:<Music2 size={12}/>}<span>{clip.name}</span>{clip.segments.length>1&&<span className="clip-badge">{clip.segments.length} clips</span>}{clip.warp&&<span className="clip-badge">↗ SYNC</span>}{clip.muted&&<VolumeX size={12}/>}</div>
                <span className="clip-duration">{clipDuration(clip).toFixed(2)}s</span>
                {beats.map((b,i)=><div key={i} className="beat-line" style={{left:(b-clip.start)*p.zoom}} title={`Beat ${i+1} · ${b.toFixed(3)}s`}><span>{i+1}</span></div>)}
                {clip.signals.map((signal,i)=><div key={i} className="signal-line" style={{left:sourceToOutput(clip,signal)*p.zoom}} title={`Signal ${i+1} · right-click to remove`} onPointerDown={e=>begin(e,original,'signal',i)} onContextMenu={e=>{e.preventDefault();e.stopPropagation();if(track.locked)return;const flat=flattenClip(clip);p.onChange({...p.project,clips:p.project.clips.map(c=>c.id===clip.id?{...flat,signals:flat.signals.filter((_,n)=>n!==i)}:c)});}}><span>{i+1}</span></div>)}
                <div className="trim-handle left" onPointerDown={e=>begin(e,original,'left')}/><div className="trim-handle right" onPointerDown={e=>begin(e,original,'right')}/>
              </div>;
            })}
          </div>
        </div>)}
        <div className="add-track-row"><div className="track-header"><button onClick={()=>p.onAddTrack('video')}><Plus size={12}/>Video</button><button onClick={()=>p.onAddTrack('audio')}><Plus size={12}/>Audio</button></div><div className="timeline-footnote">{p.tool==='marker'?'Click a video to place a beat signal · click audio to edit detected beats':'Drag to move · drag edges to trim · double-click to mark a beat'}</div></div>
        <div className="playhead" style={{left:168+p.time*p.zoom}}><div className="playhead-cap"/></div>
      </div>
    </div>
    <div className="timeline-status"><span><i className="status-dot"/>LOCAL WORKSPACE <span className="status-separator">/</span> Original media preserved</span><span>V <span>select</span> B <span>marker</span> S <span>split</span> SPACE <span>play</span></span></div>
  </section>;
}
