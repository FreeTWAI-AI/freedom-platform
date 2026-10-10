import {useEffect,useRef,useState,lazy,Suspense,Component,type ReactNode} from 'react';
import type {PortalClient} from '../api';
import {SocialShareSession} from '../social-share';
import {SocialIcon} from './SocialTools';
import type {SocialPost} from './SocialZone';
const Panel=lazy(()=>import('./SocialCrossPlatformShare').then(m=>({default:m.SocialCrossPlatformShare})));
class ShareBoundary extends Component<{children:ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<p role="alert">分享工具暫時無法載入，請重新整理後再試。</p>:this.props.children;}}
export function SocialPostShare({client,post}:{client:PortalClient;post:SocialPost}){
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const [open,setOpen]=useState(false),[job]=useState(()=>new SocialShareSession(client)),[error,setError]=useState(''),[busy,setBusy]=useState(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const caption=[post.note||post.title,post.url].filter(Boolean).join('\n');
 function close(){dialog.current?.close();setOpen(false);trigger.current?.focus();}
 async function attach(){const generation=client.sessionGeneration;setBusy(true);setError('');try{
  const image=new Image();image.src=post.thumbnail_url!;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d')!.drawImage(image,0,0);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('圖片無法準備。')),'image/png'));
  if(!alive.current||generation!==client.sessionGeneration)return;
  if(!job.snapshot().enabled){setError('請先開啟分享，再加入照片。');return;}
  await job.addFiles([new File([blob],'workshop-post.png',{type:'image/png'})]);
 }catch(e){if(alive.current&&generation===client.sessionGeneration)setError(e instanceof Error?e.message:'圖片無法準備。');}finally{if(alive.current&&generation===client.sessionGeneration)setBusy(false);}}
 return <><button ref={trigger} type="button" className="btn btn-ghost" aria-label="分享到其他社群" onClick={()=>{setOpen(true);dialog.current?.showModal();}}><SocialIcon name="share"/>分享</button><dialog ref={dialog} className="social-publish-dialog social-share-dialog" aria-label="分享貼文" onCancel={e=>{if(e.target!==e.currentTarget)return;e.preventDefault();close();}}>{open&&<><header className="social-publish-head"><h2>分享貼文</h2><button type="button" className="btn btn-ghost" onClick={close}>關閉分享</button></header><p className="muted">已預選全部平台，可取消不需要的分享對象。</p>{post.thumbnail_url&&<button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>void attach()}>{busy?'處理圖片中…':'加入貼文照片'}</button>}{error&&<p role="alert">{error}</p>}<ShareBoundary><Suspense fallback={<p role="status">載入分享工具…</p>}><Panel client={client} draft={caption} disabled={busy} onClose={close} shareJob={job}/></Suspense></ShareBoundary></>}</dialog></>;
}
