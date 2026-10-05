import {useEffect,useState,type ComponentType} from 'react';
import {useWorkshopTheme} from '../../workshop-theme';
import {canRequestGuide,acceptsGuideRelease} from './gate';
import {DRAGON_RELEASE_PIN} from './release-pin';
import type {GuidePage,GuidePack} from './contracts';
type EngineProps={pageId:string;scopeKey:string;page:GuidePage;label:string;gallery:GuidePack['gallery']};
type Ready={scope:string;Engine:ComponentType<EngineProps>;pack:GuidePack;page:GuidePage};
/** The only mount gate. It runs before character lookup, pack import or animation effects. */
export function GuideHost({pageId,scopeKey,memberAccess}:{pageId:string;scopeKey:string;memberAccess:boolean}) {
  const {theme}=useWorkshopTheme();
  const permitted=canRequestGuide(theme,pageId,memberAccess,scopeKey);
  const scope=`${scopeKey}:${pageId}:${theme}:${DRAGON_RELEASE_PIN.version}`;
  const [ready,setReady]=useState<Ready|null>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    setReady(null);setFailed(false);
    if(!permitted)return;
    const controller=new AbortController();let current=true;
    void (async()=>{
      const response=await fetch('/api/v1/guide-packs/release',{signal:controller.signal,cache:'no-store',credentials:'same-origin'});
      if(!response.ok)throw Error('Guide release unavailable');
      const release:unknown=await response.json();
      if(!current || !acceptsGuideRelease(release))return;
      const [{GuideEngine},{DRAGON_PACK}]=await Promise.all([import('./engine/GuideEngine'),import('./packs/dragon')]);
      if(!current)return;
      if(DRAGON_PACK.id!==DRAGON_RELEASE_PIN.pack || DRAGON_PACK.version!==DRAGON_RELEASE_PIN.version || DRAGON_PACK.engineContractVersion!==1)throw Error('Guide contract mismatch');
      const page=await DRAGON_PACK.loadPage(pageId);
      if(current)setReady({scope,Engine:GuideEngine,pack:DRAGON_PACK,page});
    })().catch(()=>{if(current)setFailed(true)});
    return()=>{current=false;controller.abort()};
  },[permitted,scope,pageId,retry]);
  if(!permitted)return null;
  if(ready?.scope===scope){const {Engine,pack,page}=ready;return <Engine key={scope} pageId={pageId} scopeKey={scope} page={page} label={pack.label} gallery={pack.gallery}/>;}
  return failed ? <button type="button" className="btn btn-ghost btn-small guide-load-retry" onClick={()=>setRetry(value=>value+1)}>重試載入新手導覽</button> : null;
}
