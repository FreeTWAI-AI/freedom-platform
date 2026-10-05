import {useEffect,useId,useRef,useState} from 'react';
import type {GuideCharacter,GuideGalleryInfo} from '../contracts';
/** Loads only the selected character/view after an explicit gallery action. */
export function GuideGallery({characters,label,info,initial,initialOutfit,onClose}:{characters:readonly GuideCharacter[];label:string;info:GuideGalleryInfo;initial:string;initialOutfit?:string;onClose:()=>void}){
  const [selected,setSelected]=useState(initial),[view,setView]=useState(0),[failed,setFailed]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null),id=useId();
  const character=characters.find(character=>character.pageId===selected);
  const [outfitId,setOutfitId]=useState(initialOutfit);
  const outfit=character?.outfits?.find(outfit=>outfit.id===outfitId)??character?.outfits?.[0];
  const views=outfit?.views??character?.views??[];
  const viewLabel=(index:number)=>(outfit?.viewLabels??character?.viewLabels)?.[index]??`視角 ${index+1}`;
  useEffect(()=>{const current=dialog.current,origin=document.activeElement;current?.showModal();return()=>{current?.close();if(origin instanceof HTMLElement&&origin.isConnected)origin.focus({preventScroll:true})}},[]);
  useEffect(()=>setFailed(false),[selected,view,outfitId]);
  if(!character)return null;
  return <dialog ref={dialog} className="guide-gallery" aria-labelledby={id} onCancel={event=>{event.preventDefault();event.stopPropagation();onClose()}} onKeyDown={event=>{if(event.key==='Escape'||event.key==='~'||event.key==='`'||event.code==='Backquote')event.stopPropagation()}}>
    <header><h2 id={id}>{label}{info.title}</h2><button type="button" className="btn btn-ghost btn-small" onClick={onClose}>關閉圖鑑</button></header>
    <div className="guide-gallery-selectors"><label>角色<select value={selected} onChange={event=>{setSelected(event.target.value);setView(0)}}>{characters.map(character=><option key={character.pageId} value={character.pageId}>{character.outfits?character.name:`${character.name}・${character.title}`}</option>)}</select></label>
      {outfit&&<label>服裝<select value={outfit.id} onChange={event=>{setOutfitId(event.target.value);setView(0)}}>{character.outfits?.map(outfit=><option key={outfit.id} value={outfit.id}>{outfit.label}</option>)}</select></label>}</div>
    <div className="guide-gallery-views" aria-label="角色圖片">{views.map((_,index)=><button type="button" key={index} className="btn btn-ghost btn-small" aria-pressed={view===index} onClick={()=>setView(index)}>{viewLabel(index)}</button>)}</div>
    {failed?<p role="status">這張角色圖暫時無法顯示</p>:<img key={`${selected}:${outfit?.id}:${view}`} src={views[view]} width="384" height="576" alt={`${character.name}，${outfit?outfit.label+'服裝，':''}${viewLabel(view)}`} onError={()=>setFailed(true)}/>}
    <p>{info.attribution} <a href={info.sourceUrl} target="_blank" rel="noreferrer">{info.sourceLabel}</a></p>
  </dialog>;
}
