import {useEffect,useId,useRef,useState} from 'react';
import type {GuideCharacter} from '../contracts';
/** Loads only the selected character/view after an explicit gallery action. */
export function GuideGallery({characters,label,initial,onClose}:{characters:readonly GuideCharacter[];label:string;initial:string;onClose:()=>void}){
  const [selected,setSelected]=useState(initial),[view,setView]=useState(0),[failed,setFailed]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null),id=useId();
  const character=characters.find(character=>character.pageId===selected);
  useEffect(()=>{const current=dialog.current,origin=document.activeElement;current?.showModal();return()=>{current?.close();if(origin instanceof HTMLElement&&origin.isConnected)origin.focus({preventScroll:true})}},[]);
  useEffect(()=>setFailed(false),[selected,view]);
  if(!character)return null;
  return <dialog ref={dialog} className="guide-gallery" aria-labelledby={id} onCancel={event=>{event.preventDefault();event.stopPropagation();onClose()}} onKeyDown={event=>{if(event.key==='Escape'||event.key==='~'||event.key==='`'||event.code==='Backquote')event.stopPropagation()}}>
    <header><h2 id={id}>{label}角色六視圖</h2><button type="button" className="btn btn-ghost btn-small" onClick={onClose}>關閉圖鑑</button></header>
    <label>角色<select value={selected} onChange={event=>{setSelected(event.target.value);setView(0)}}>{characters.map(character=><option key={character.pageId} value={character.pageId}>{character.name}・{character.title}</option>)}</select></label>
    <div className="guide-gallery-views" aria-label="角色視角">{character.views.map((_,index)=><button type="button" key={index} className="btn btn-ghost btn-small" aria-pressed={view===index} onClick={()=>setView(index)}>視角 {index+1}</button>)}</div>
    {failed?<p role="status">這張角色圖暫時無法顯示</p>:<img key={`${selected}:${view}`} src={character.views[view]} width="384" height="576" alt={`${character.name}，視角 ${view+1}`} onError={()=>setFailed(true)}/>}
    <p>原創角色圖來自 mars-tw 的 <a href="https://github.com/FreeTWAI-AI/freedom-platform/pull/106" target="_blank" rel="noreferrer">PR #106</a></p>
  </dialog>;
}
