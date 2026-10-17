import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import type {z} from 'zod';
import {ApiError, type PortalClient} from '../../../../../apps/portal-web/src/api';
import {DistributionPhotosSchema,DistributionPhotoCommandSchema,type DistributionPhotoItem,type PartnerMaterial} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import {partnerMaterialsErrorText} from './partner-materials';

export type DistributionPhotoSender=(attempt:{method:'post';path:string;body:unknown;version:string;schema:z.ZodType;
 notice:string;targetMissingIsStore:false;success:(value:unknown)=>void})=>Promise<void>;
/** A known 403/404 drops this projection. 503 and other read failures keep the last authorized rows. */
export function distributionPhotoReadClearsPrivate(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}
interface Props {client:PortalClient;userId:string;tenantId:string;instanceId:string;active:boolean;refresh:number;
 enabled:boolean;writable:boolean;busy:boolean;onCommand?:DistributionPhotoSender}
/** Uses the store's command owner: unknown results retain its original key/body/CAS. */
export function useDistributionPhotos({client,userId,tenantId,instanceId,active,refresh,enabled,writable,busy,onCommand}:Props) {
 const root=`/tenants/${tenantId}/storefronts/${instanceId}/distribution-photos`;
 const scope=`${userId}:${client.sessionGeneration}:${root}`;
 const current=useRef(scope);current.current=scope;
 const mounted=useRef(true),epoch=useRef(0),abort=useRef<AbortController|null>(null);
 const [result,setResult]=useState<{scope:string;items:DistributionPhotoItem[]}|null>(null);
 const [error,setError]=useState(''),[loading,setLoading]=useState(false);
 const [choice,setChoice]=useState<{material:PartnerMaterial;product:DistributionPhotoItem;scope:string}|null>(null);
 const dialog=useRef<HTMLDialogElement|null>(null),opener=useRef<HTMLElement|null>(null);
 const load=useCallback(async()=>{
  if(!enabled)return;
  abort.current?.abort();const control=new AbortController();abort.current=control;const ticket=++epoch.current,generation=client.sessionGeneration;
  const valid=()=>client.sessionGeneration===generation&&mounted.current&&!control.signal.aborted&&ticket===epoch.current&&scope===current.current;
  setLoading(true);setError('');
  try{const data=DistributionPhotosSchema.parse(await client.get(root,{signal:control.signal}));if(valid())setResult({scope,items:data.items});}
  catch(reason){
   if(!valid())return;
   setError(partnerMaterialsErrorText(reason));
   // Only this ticket may clear. An older 200 must not put the private rows back.
   if(distributionPhotoReadClearsPrivate(reason)){setResult(null);setChoice(null);}
  }
  finally{if(valid())setLoading(false);}
 },[client,root,scope,enabled]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;abort.current?.abort();};},[]);
 useEffect(()=>{setChoice(null);if(active)void load();return()=>abort.current?.abort();},[scope,active,refresh,load]);
 // showModal() focuses the first button: React's autoFocus writes no attribute, so 取消 must come first.
 useEffect(()=>{if(choice&&choice.scope===scope){dialog.current?.showModal();}else dialog.current?.close();},[choice,scope]);
 const close=()=>{setChoice(null);opener.current?.focus();};
 const rows=result?.scope===scope?result.items:[];
 const allowed=enabled&&writable&&!busy&&!loading&&!error&&!!onCommand;
 function send(product:DistributionPhotoItem,material?:PartnerMaterial) {
  if(!allowed)return;
  const started=scope,generation=client.sessionGeneration;
  void onCommand!({method:'post',path:`${root}/${product.product_id}/${material?'use':'detach'}`,
   body:material?{material_id:material.material_id,version_id:material.current.version_id}:{},version:product.version,
   schema:DistributionPhotoCommandSchema,notice:'已更新店面草稿，發布店面後才會生效。',targetMissingIsStore:false,
   success:()=>{if(mounted.current&&client.sessionGeneration===generation&&current.current===started)void load();}});
 }
 const choose=(material:PartnerMaterial,product:DistributionPhotoItem,event:React.MouseEvent<HTMLButtonElement>)=>{
  opener.current=event.currentTarget;setChoice({material,product,scope});
 };
 const stop=(product:DistributionPhotoItem)=>enabled&&writable&&<button type="button" className="btn btn-ghost btn-small" disabled={!allowed} onClick={()=>send(product)}>停止使用</button>;
 const above:ReactNode=<>
  {enabled&&loading&&<p role="status">正在讀取店面照片…</p>}
  {enabled&&error&&<div className="stack"><p role="alert" className="banner banner-error">目前無法讀取店面照片。{error}</p><div className="actions"><button type="button" className="btn btn-ghost btn-small" onClick={()=>void load()}>重試</button></div></div>}
  {rows.filter(row=>row.state==='source_unavailable').map(row=><div key={row.product_id} className="stack"><p>「{row.title}」的店面照片來源已撤回或不再開放公開使用，下次發布時不會顯示。</p><div className="actions">{stop(row)}</div>{row.photo&&<img src={row.photo.read_path} alt={`${row.title}的店面草稿照片`} loading="lazy" width={96} className="distribution-photo-thumb"/>}</div>)}
  <dialog className="distribution-photo-dialog" ref={dialog} aria-labelledby="distribution-photo-confirm-title" onCancel={event=>{event.preventDefault();close();}} onClose={close}>
   {choice&&choice.scope===scope&&<div className="stack"><h3 id="distribution-photo-confirm-title">把這張素材用在公開店面？</h3><p>會把第 {choice.material.current.version_no} 版複製到你的業務空間，作為「{choice.product.title}」的店面商品圖，計入業務空間容量。供應商之後更新或撤回素材，不會改寫已發布的店面；你重新發布店面後才會生效。</p><div className="actions"><button type="button" className="btn btn-ghost btn-small" autoFocus onClick={close}>取消</button><button type="button" className="btn btn-primary btn-small" disabled={!allowed} onClick={()=>{send(choice.product,choice.material);close();}}>複製並使用</button></div></div>}
  </dialog>
 </>;
 const renderMaterial=(material:PartnerMaterial):ReactNode=>{
  if(material.kind!=='image'||material.access!=='public_use')return null;
  // Off here means the environment, not this product: one line per usable image, like the material-file hint.
  if(!enabled)return <p className="field-hint">這個環境尚未開放把素材用在公開店面。</p>;
  return <div className="stack">{material.applies_to.map(id=>{
   const row=rows.find(item=>item.product_id===id);
   if(!row)return <p className="field-hint" key={id}>{error||loading?'店面照片狀態尚未確認。':'供貨確認後才能用在公開店面。'}</p>;
   const same=row.source?.material_id===material.material_id;
   return <div className="stack" key={id}><p>店面照片・<strong>{row.title}</strong></p>
    {same&&row.state==='in_use'&&<span className="badge">店面使用中（第 {row.source!.version_no} 版）</span>}
    {same&&row.state==='update_available'&&<p>供應商已更新為第 {row.latest!.version_no} 版，店面仍用第 {row.source!.version_no} 版</p>}
    {!same&&row.state!=='none'&&<p>這個商品目前使用另一個素材</p>}
    <div className="actions">{enabled&&writable&&(!same||row.state==='update_available'||row.state==='none')&&<button type="button" className="btn btn-ghost btn-small" disabled={!allowed} aria-haspopup="dialog" onClick={event=>choose(material,row,event)}>{row.state==='none'?'用於公開店面':same?'改用新版本':'改用這個素材'}</button>}{same&&row.state!=='none'&&stop(row)}</div>
    {row.photo&&<img src={row.photo.read_path} alt={`${row.title}的店面草稿照片`} loading="lazy" width={96} className="distribution-photo-thumb"/>}
   </div>;
  })}</div>;
 };
 return {above,renderMaterial,reload:load};
}
