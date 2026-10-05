import {useEffect,useRef,useState,type ComponentType} from 'react';
import {useWorkshopTheme} from '../../workshop-theme';
import {canRequestGuide,acceptsGuideRelease} from './gate';
import {resolveExperienceProfile} from '../../experience-profiles';
import {GUIDE_PACKS} from './pack-registry';
import {AI_SISTER_CHARACTER_KEY,readAiSisterCharacter,resolveAiSisterCharacter,saveAiSisterCharacter} from './character-choice';
import type {GuidePage,GuidePack} from './contracts';
type EngineProps={pageId:string;scopeKey:string;page:GuidePage;label:string;gallery:GuidePack['gallery'];galleryInfo:GuidePack['galleryInfo'];characterChoices?:GuidePack['characterChoices'];onSelectCharacter?:(id:string)=>void;initiallyOpen?:boolean};
type Ready={scope:string;Engine:ComponentType<EngineProps>;pack:GuidePack;page:GuidePage};
/** The only mount gate. It runs before character lookup, pack import or animation effects. */
export function GuideHost({pageId,scopeKey,memberAccess}:{pageId:string;scopeKey:string;memberAccess:boolean}) {
  const {theme}=useWorkshopTheme();
  const packId=resolveExperienceProfile(theme).guidePack;
  const descriptor=packId?GUIDE_PACKS[packId]:null;
  const [characterChoice,setCharacterChoice]=useState(readAiSisterCharacter);
  const openAfterSelection=useRef('');
  const chosen=packId==='ai-sister'?characterChoice:'';
  const permitted=canRequestGuide(theme,pageId,memberAccess,scopeKey);
  const baseScope=`${scopeKey}:${pageId}:${theme}:${descriptor?.pin.version??'off'}`;
  const scope=`${baseScope}:${chosen}`;
  const [ready,setReady]=useState<Ready|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{openAfterSelection.current=''},[baseScope,memberAccess]);
  useEffect(()=>{
    const sync=(event:StorageEvent)=>{if(event.key===AI_SISTER_CHARACTER_KEY){openAfterSelection.current='';setCharacterChoice(resolveAiSisterCharacter(event.newValue))}};
    window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
  },[]);
  useEffect(()=>{
    setReady(null);setFailed(false);
    if(!permitted || !descriptor || !packId)return;
    const controller=new AbortController();let current=true;
    void (async()=>{
      const response=await fetch(descriptor.releasePath,{signal:controller.signal,cache:'no-store',credentials:'same-origin'});
      if(!response.ok)throw Error('Guide release unavailable');
      const release:unknown=await response.json();
      if(!current || !acceptsGuideRelease(release,packId))return;
      const [{GuideEngine},pack]=await Promise.all([import('./engine/GuideEngine'),descriptor.load()]);
      if(!current)return;
      if(pack.id!==descriptor.pin.pack || pack.version!==descriptor.pin.version || pack.engineContractVersion!==1)throw Error('Guide contract mismatch');
      const page=await pack.loadPage(pageId,chosen);
      if(current)setReady({scope,Engine:GuideEngine,pack,page});
    })().catch(()=>{if(current)setFailed(true)});
    return()=>{current=false;controller.abort()};
  },[permitted,scope,pageId,retry,descriptor,packId,chosen]);
  if(!permitted)return null;
  if(ready?.scope===scope){const {Engine,pack,page}=ready;return <Engine key={scope} pageId={pageId} scopeKey={scope} page={page} label={pack.label} gallery={pack.gallery} galleryInfo={pack.galleryInfo}
    characterChoices={pack.characterChoices} initiallyOpen={openAfterSelection.current===scope}
    onSelectCharacter={packId==='ai-sister'?(id)=>{
      if(!pack.characterChoices?.some(choice=>choice.id===id))return;
      const selected=saveAiSisterCharacter(id);openAfterSelection.current=`${baseScope}:${selected}`;setCharacterChoice(selected);
    }:undefined}/>;}
  return failed ? <button type="button" className="btn btn-ghost btn-small guide-load-retry" onClick={()=>setRetry(value=>value+1)}>重試載入新手導覽</button> : null;
}
