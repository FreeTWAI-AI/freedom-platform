import {useEffect,useId,useRef,useState} from 'react';
import type {SupplyMaterial,SupplyMaterialDetail,SupplyMaterials,SupplyMaterialVersion} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import {ApiError} from '../../../../../apps/portal-web/src/api';
import {prepareBrowserRaster,socialImageProblem} from '../../../../../packages/asset-storage/browser-raster';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {holdMaterialUpload,heldMaterialUpload,markMaterialUploadUnknown,restoreMaterialUpload,releaseMaterialUpload,forgetRefusedMaterialUpload,type MaterialUploadAttempt} from '../../state/material-upload';
import {sendMaterialUpload,materialFileProblem,MATERIAL_UPLOAD_UNKNOWN} from '../material-client';
import {materialAccess,materialKind,materialSubject,materialTime,materialSize,materialVersionSummary,materialContentPath,materialCapacityText,materialCapacityProblem,sellableMaterialPartners,partnerLabel} from '../view';
import {supplierConsoleHref} from '../route';
import {ReadStatus,Editor,ConfirmAction} from './Shared';

function MaterialContent({c,material,version,enabled}:{c:ConsoleController;material:SupplyMaterial;version:SupplyMaterialVersion;enabled:boolean}){
 const content=version.content,path=materialContentPath(c.scope,material.material_id,version.version_id),[failed,setFailed]=useState(''),[message,setMessage]=useState('');
 const text=useRef<HTMLParagraphElement>(null),mounted=useRef(false),generation=c.client.sessionGeneration;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function copy(){
  if(content.kind!=='copy')return;
  try{await navigator.clipboard.writeText(content.body);if(mounted.current&&generation===c.client.sessionGeneration)setMessage('已複製文字。');}
  catch{if(!mounted.current||generation!==c.client.sessionGeneration)return;const selection=window.getSelection(),range=document.createRange();if(text.current){range.selectNodeContents(text.current);selection?.removeAllRanges();selection?.addRange(range);text.current.focus();}setMessage('已選取全部文字，請使用裝置的複製功能。');}
 }
 if(content.kind==='copy')return <div className="stack"><p className="sc-material-copy" tabIndex={-1} ref={text}>{content.body}</p><div className="actions"><button type="button" className="btn btn-ghost btn-small" onClick={()=>void copy()}>複製文字</button></div>{message&&<p role="status">{message}</p>}</div>;
 if(!enabled)return <p>這個環境未開放素材檔案。</p>;
 return <div className="stack">{failed===path?<p role="status">{content.kind==='image'?'圖片暫時無法讀取。':'影片暫時無法讀取。'}</p>:content.kind==='image'?<img className="sc-material-media" src={path} alt={material.title} width={content.width} height={content.height} onError={()=>setFailed(path)}/>:<video className="sc-material-media" controls preload="metadata" src={path} onError={()=>setFailed(path)}/>}
  <p className="field-hint">{content.kind==='image'?content.content_type+'・':''}{materialVersionSummary(version)}</p>
 </div>;
}

function MaterialUpload({c,m,enabled,active}:{c:ConsoleController;m:SupplyMaterial;enabled:boolean;active:boolean}){
 const target={...c.scope,materialId:m.material_id},[restored]=useState(()=>restoreMaterialUpload(c.client,c.userId,target));
 const [file,setFile]=useState<File|null>(restored?.file??null),[attempt,setAttempt]=useState<MaterialUploadAttempt|null>(restored),[phase,setPhase]=useState<'idle'|'sending'|'unknown'|'review'>(restored?'unknown':'idle');
 const [message,setMessage]=useState(restored?MATERIAL_UPLOAD_UNKNOWN:''),[preparing,setPreparing]=useState(false),[preview,setPreview]=useState('');
 const input=useRef<HTMLInputElement>(null),id=useId(),busy=useRef(false),held=useRef(attempt),mounted=useRef(false),serial=useRef(0),generation=useRef(c.client.sessionGeneration),latest=useRef(c);latest.current=c;
 const binding=`${c.scope.tenantId}:${c.scope.instanceId}`,current=()=>mounted.current&&generation.current===c.client.sessionGeneration&&latest.current.client===c.client&&`${latest.current.scope.tenantId}:${latest.current.scope.instanceId}`===binding;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;serial.current++;};},[]);
 useEffect(()=>{if(!file){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
 const onState=useRef(c.materialState);onState.current=c.materialState;
 useEffect(()=>{onState.current(m.material_id,!!file||preparing||!!attempt,phase==='sending'||phase==='unknown');},[file,preparing,attempt,phase,m.material_id]);
 useEffect(()=>()=>onState.current(m.material_id,false,false),[m.material_id]);
 useEffect(()=>{if(active&&enabled&&c.materialCreated===m.material_id){input.current?.focus();c.materialFocused();}},[active,enabled,c.materialCreated]);
 const list=c.slot<SupplyMaterials>('materials'),capacity=list.state==='ready'?list.data?.capacity:undefined,kind=m.kind==='video'?'video':'image',space=materialCapacityProblem(capacity,kind);
 const writable=m.state==='active'&&c.can('store:write'),blocked=c.locked||preparing||phase==='sending'||phase==='unknown'||!writable;
 function clear(){setFile(null);setAttempt(null);held.current=null;setPhase('idle');if(input.current)input.current.value='';}
 async function choose(selected:File){
  if(busy.current||held.current?.hadUnknown||blocked)return;
  const problem=kind==='image'?socialImageProblem(selected):materialFileProblem(kind,selected);if(problem){setMessage(problem);if(input.current)input.current.value='';return;}
  const ticket=++serial.current;setPreparing(true);setMessage(kind==='image'?'正在裝置上準備圖片…':'正在準備影片預覽…');
  try{const prepared=kind==='image'&&selected.size>2*1048576?await prepareBrowserRaster(selected):selected;
   if(!current()||ticket!==serial.current)return;
   const problem=materialFileProblem(kind,prepared);if(problem)throw new Error(problem);
   setFile(prepared);setAttempt(null);held.current=null;setPhase('idle');setMessage('檔案已選擇，按「上傳新版本」後才會上傳。');
  }catch(e){if(current()&&ticket===serial.current)setMessage(e instanceof Error?e.message:'檔案無法使用，請重新選擇。');}
  finally{if(current()&&ticket===serial.current){setPreparing(false);if(input.current)input.current.value='';}}
 }
 async function send(a:MaterialUploadAttempt){
  if(busy.current||!current()||!c.materialBegin(m.material_id))return;
  try{holdMaterialUpload(c.client,c.userId,a);}catch{const original=restoreMaterialUpload(c.client,c.userId,target);if(original){held.current=original;setAttempt(original);setFile(original.file);setPhase('unknown');setMessage(MATERIAL_UPLOAD_UNKNOWN);}return;}
  busy.current=true;held.current=a;setAttempt(a);setPhase('sending');setMessage('正在上傳新版本…');
  try{await sendMaterialUpload(c.client,a);if(!current()){markMaterialUploadUnknown(c.client,c.userId,a);return;}releaseMaterialUpload(c.client,c.userId,a);
   clear();onState.current(m.material_id,false,false);setMessage('已上傳新版本。');await c.materialSaved(m.material_id);if(!current())return;
  }catch(e){
   const unknown=!(e instanceof ApiError)||e.network||e.timedOut||e.accessExpired||e.status===401;
   const uncertain=unknown||heldMaterialUpload(c.client,c.userId,a)?.hadUnknown===true;
   const retained=Object.freeze({...a,hadUnknown:uncertain});
   if(uncertain)markMaterialUploadUnknown(c.client,c.userId,a);else forgetRefusedMaterialUpload(c.client,c.userId,a);
   if(!current())return;held.current=retained;setAttempt(retained);
   if(uncertain){setPhase('unknown');setMessage(MATERIAL_UPLOAD_UNKNOWN);}
   else if(e instanceof ApiError&&e.status===412){setPhase('review');setMessage('素材已更新，檔案仍保留。請核對最新素材，再確認以新版本上傳。');onState.current(m.material_id,true,false);await c.materialSaved(m.material_id);if(!current())return;}
   else {setPhase('idle');setAttempt(null);held.current=null;setMessage(e instanceof ApiError?e.detail??e.message:'素材上傳未完成。');onState.current(m.material_id,true,false);if(e instanceof ApiError&&e.status===403)void c.read('profile');await c.materialSaved(m.material_id);if(!current())return;}
  }finally{if(current())busy.current=false;}
 }
 function fresh(){if(blocked||!file||!enabled||space)return;void send(Object.freeze({...target,file,key:crypto.randomUUID(),expected:m.version,hadUnknown:false}));}
 return <div className="stack">
  <ReadStatus c={c} name="materials" label="業務空間容量" scopedAction/><p>{materialCapacityText(capacity)}</p><p className="field-hint">與商品照片共用整個業務空間；處理{kind==='image'?'圖片需預留 1 MB':'影片需預留 20 MB'}。</p>
  {capacity?.state!=='ready'&&<p className="field-hint">容量暫時無法確認，仍可送出，由伺服器檢查。</p>}
  {!enabled?<p>這個環境未開放素材檔案上傳。</p>:writable&&<><label className="field" htmlFor={id}>選擇{kind==='image'?'圖片':'影片'}<input id={id} ref={input} type="file" accept={kind==='image'?'image/png,image/jpeg,image/webp':'video/mp4,video/webm'} disabled={blocked} onChange={e=>{const selected=e.target.files?.[0];if(selected)void choose(selected);}}/></label>
   <p className="field-hint">{kind==='image'?'PNG、JPEG 或 WebP；原圖最多 20 MB，超過 2 MB 會在裝置上縮小。':'MP4 或 WebM，最多 20 MB；請先壓縮，建議 H.264／AAC、720p、60 秒內。影片不會在瀏覽器處理。'}</p></>}
  {file&&<><p>已選擇：{file.name}・{file.type}・{materialSize(file.size)}</p>{preview&&(kind==='image'?<img className="sc-material-media" src={preview} alt="待上傳圖片的裝置預覽"/>:<video className="sc-material-media" src={preview} controls preload="metadata"/>)}<p className="field-hint">裝置上的預覽，尚未確認上傳。</p></>}
  {space&&<p className="field-hint">{space}</p>}
  <div className="actions">{phase==='unknown'?<button className="btn btn-ghost btn-small" type="button" disabled={!c.can('store:write')} onClick={()=>attempt&&void send(attempt)}>重試原操作</button>:phase==='review'?<ConfirmAction label="以最新版本上傳" title="核對最新素材後重新上傳" disabled={blocked||!enabled||!!space||m.version===attempt?.expected} onConfirm={fresh}><p>目前素材：{m.title}・版本 {m.version}。將以新的操作上傳保留的檔案：{file?.name}。</p></ConfirmAction>:enabled&&writable&&<button type="button" className="btn btn-ghost btn-small" disabled={blocked||!file||!!space} onClick={fresh}>上傳新版本</button>}
   {(file||preparing||attempt)&&phase!=='unknown'&&phase!=='sending'&&<button type="button" className="btn btn-ghost btn-small" disabled={c.locked} onClick={()=>{serial.current++;setPreparing(false);clear();setMessage('已取消這次檔案變更。');}}>取消</button>}
  </div>{message&&<p className="field-hint" role="status">{message}</p>}
 </div>;
}

function MaterialAccess({c,m,disabled}:{c:ConsoleController;m:SupplyMaterial;disabled:boolean}){
 const dialog=useRef<HTMLDialogElement>(null),select=useRef<HTMLSelectElement>(null),expected=useRef(m.version),id=useId();
 const close=()=>{dialog.current?.close();select.current?.focus({preventScroll:true});};
 const save=(access:'partners'|'public_use')=>c.command({kind:'material.access',label:'變更素材授權範圍',method:'post',path:c.root+`/supply-materials/${m.material_id}/access`,body:access==='partners'?{access}:{access,confirm_public_use:true},ifMatch:expected.current,target:m.material_id});
 return <><label className="field">使用範圍<select ref={select} value={m.access} disabled={disabled} onChange={e=>{expected.current=m.version;if(e.target.value==='public_use')dialog.current?.showModal();else save('partners');}}><option value="partners">僅授權的合作店家</option><option value="public_use">可用於合作店家的公開店面</option></select></label>
  <dialog ref={dialog} aria-labelledby={id} onCancel={e=>{e.preventDefault();close();}} onClose={()=>select.current?.focus({preventScroll:true})}><div className="stack"><h2 id={id}>可用於合作店家的公開店面</h2><p>合作店家可以把這個版本用在他們的公開店面。這不會產生公開的檔案網址，撤回後已發布的店面要等賣家下次發布才會更換。</p><div className="actions"><button type="button" className="btn btn-ghost" autoFocus onClick={close}>取消</button><button type="button" className="btn btn-primary" disabled={disabled} onClick={()=>{close();save('public_use');}}>確認開放</button></div></div></dialog>
 </>;
}

export function Material({c,id,mediaEnabled,uploadsEnabled,active}:{c:ConsoleController;id:string;mediaEnabled:boolean;uploadsEnabled:boolean;active:boolean}){
 const key='material:'+id,r=c.slot<SupplyMaterialDetail>(key),d=r.data,m=d?.material,[editing,setEditing]=useState(false);
 const selectionName=`material:${id}:grants`,selection=c.drafts[selectionName]?.fields??{},selected=d?.partners.filter(p=>!p.granted&&selection[p.partner_id]===true).map(p=>p.partner_id)??[];
 const contentName=`material:${id}:content`,copyName=`material:${id}:copy`;
 const locked=c.locked||r.state!=='ready'||m?.state!=='active';
 function command(kind:'material.access'|'material.grant'|'material.revoke'|'material.withdraw',label:string,suffix:string,body:Record<string,unknown>,draft?:string){if(m)c.command({kind,label,method:'post',path:c.root+`/supply-materials/${id}`+suffix,body,ifMatch:m.version,target:id,draft});}
 const peers=d?[...d.partners,...d.grants.map(g=>({partner_id:g.partner_id,name:g.partner_name}))]:[];
 return <section className="stack sc-material-page"><h2 tabIndex={-1}>素材詳情{m?`：${m.title}`:''}</h2><div className="actions"><a className="btn btn-ghost" href={supplierConsoleHref(c.scope,'materials')}>返回行銷素材</a></div>
  <ReadStatus c={c} name={key} label="素材詳情"/>{r.status===404&&<p>找不到這個素材。</p>}
  {d&&m&&<>
   <section className="sc-section stack"><h3>素材資料</h3><dl className="detail-list"><div><dt>標題</dt><dd>{m.title}</dd></div><div><dt>說明</dt><dd className="sc-material-copy">{m.description||'未填寫'}</dd></div><div><dt>種類</dt><dd>{materialKind(m.kind)}</dd></div><div><dt>對象</dt><dd>{materialSubject(m.subject)}</dd></div><div><dt>狀態</dt><dd>{m.state==='active'?'使用中':`已撤回・${materialTime(m.withdrawn_at!)}（台灣時間）`}</dd></div><div><dt>授權範圍</dt><dd>{materialAccess(m.access)}</dd></div><div><dt>目前版本</dt><dd>{m.current?`第 ${m.current.version_no} 版・${materialTime(m.current.created_at)}（台灣時間）`:'尚未上傳檔案'}</dd></div><div><dt>店家授權</dt><dd>已授權 {m.active_grants} 間店</dd></div></dl>
    {m.state==='active'&&(editing||c.drafts[contentName]?<><Editor c={c} name={contentName} title="儲存" base={{title:m.title,description:m.description}} version={m.version} kind="material.update" path={'/supply-materials/'+id} target={id} disabled={r.state!=='ready'} fields={[{key:'title',label:'標題',max:80,required:true},{key:'description',label:'說明',max:500,multiline:true}]}><p className="field-hint">標題 {String(c.drafts[contentName]?.fields.title??m.title).length}／80・說明 {String(c.drafts[contentName]?.fields.description??m.description).length}／500</p></Editor><div className="actions"><button type="button" className="btn btn-ghost btn-small" disabled={c.phase!=='idle'} onClick={()=>{c.discard(contentName);setEditing(false);}}>取消</button></div></>:<div className="actions"><button type="button" className="btn btn-ghost btn-small" disabled={locked} onClick={()=>setEditing(true)}>編輯標題與說明</button></div>)}
   </section>
   <section className="sc-section stack"><h3>內容</h3>{m.current?<MaterialContent key={m.current.version_id} c={c} material={m} version={m.current} enabled={mediaEnabled}/>:<p>尚未上傳檔案</p>}</section>
   {(m.state==='active'||c.materialStates[id]?.blocking)&&<section className="sc-section stack"><h3 tabIndex={-1}>新版本</h3><p>新版本會成為目前版本，舊版本保留。合作店家之後讀到的是新版本。</p>
    {m.kind==='copy'?<Editor c={c} name={copyName} title="儲存為新版本" base={{body:m.current?.content.kind==='copy'?m.current.content.body:''}} version={m.version} kind="material.copy" path={`/supply-materials/${id}/copy`} target={id} disabled={r.state!=='ready'} fields={[{key:'body',label:'文案內容',multiline:true,max:2000,required:true}]}><p className="field-hint">{String(c.drafts[copyName]?.fields.body??(m.current?.content.kind==='copy'?m.current.content.body:'')).length}／2000</p></Editor>:<MaterialUpload c={c} m={m} enabled={uploadsEnabled} active={active}/>}
   </section>}
   <section className="sc-section stack"><h3>版本紀錄</h3>{!d.versions.length&&<p>尚未建立版本。</p>}<ol className="sc-list">{[...d.versions].sort((a,b)=>b.version_no-a.version_no).map(v=><li className="sc-row" key={v.version_id}><div><strong>第 {v.version_no} 版</strong>{m.current?.version_id===v.version_id&&<> <span className="badge">目前版本</span></>}<p>{materialTime(v.created_at)}（台灣時間）</p><p>{materialVersionSummary(v)}</p></div>{v.content.kind!=='copy'&&mediaEnabled&&<div className="actions"><a className="btn btn-ghost btn-small" target="_blank" rel="noopener noreferrer" href={materialContentPath(c.scope,id,v.version_id)}>開啟檔案<span className="sr-only">：第 {v.version_no} 版</span></a></div>}</li>)}</ol>{d.versions_truncated&&<p>只顯示最新 50 個版本。</p>}</section>
   <section className="sc-section stack"><h3>授權範圍</h3>{m.state==='withdrawn'?<p>{materialAccess(m.access)}</p>:<MaterialAccess c={c} m={m} disabled={locked}/>}</section>
   <section className="sc-section stack"><h3>店家授權</h3>
    {m.state==='active'&&<><fieldset className="hosted-store-fields stack" disabled={locked}><legend>合作店家</legend>{!d.partners.length&&<p>目前沒有可授權的合作店家。</p>}{d.partners.map(p=><label className="choice" key={p.partner_id}><input type="checkbox" checked={p.granted||selected.includes(p.partner_id)} disabled={p.granted||locked} onChange={e=>c.updateDraft(selectionName,m.version,{},p.partner_id,e.target.checked)}/><span>{partnerLabel(p,peers)} · {p.cooperation==='sellable'?'可售':'待確認'}{p.granted?' · 已授權':''}</span></label>)}
     <div className="actions"><button type="button" className="btn btn-ghost btn-small" disabled={locked||!selected.length} onClick={()=>command('material.grant','授權選取的店家','/grants',{partner_ids:selected},selectionName)}>授權選取的店家</button><button type="button" className="btn btn-ghost btn-small" disabled={locked||!sellableMaterialPartners(d.partners).length} onClick={()=>{const all=sellableMaterialPartners(d.partners);c.discard(selectionName);all.forEach(partner=>c.updateDraft(selectionName,m.version,{},partner,true));}}>授權給目前所有可售的合作店家（{sellableMaterialPartners(d.partners).length} 間）</button>{Object.keys(selection).length>0&&<button type="button" className="btn btn-ghost btn-small" onClick={()=>c.discard(selectionName)}>取消選取</button>}</div><p className="field-hint">已選取 {selected.length} 間；按「授權選取的店家」後送出。</p>
    </fieldset>{d.partners_truncated&&<p>只顯示前 200 間可授權的合作店家。</p>}</>}
    <ul className="sc-list">{[...d.grants].sort((a,b)=>Number(a.revoked_at!==null)-Number(b.revoked_at!==null)).map(g=><li className="sc-row" key={g.partner_id+g.granted_at}><div><strong>{partnerLabel({partner_id:g.partner_id,name:g.partner_name},peers)}</strong><p>{g.revoked_at?'已撤銷':'已授權'}・{materialTime(g.granted_at)}（台灣時間）</p>{g.revoked_at&&<p>撤銷時間：{materialTime(g.revoked_at)}（台灣時間）</p>}</div>{m.state==='active'&&!g.revoked_at&&<div className="actions sc-material-row-action"><ConfirmAction label="撤銷" title="撤銷店家授權" disabled={locked} onConfirm={()=>command('material.revoke','撤銷授權',`/grants/${g.partner_id}/revoke`,{})}><p>撤銷後，這間店不能再讀取這個素材；已經下載的副本無法收回。</p></ConfirmAction></div>}</li>)}</ul>{!d.grants.length&&<p>目前沒有授權紀錄。</p>}{d.grants_truncated&&<p>只顯示前 200 筆授權紀錄。</p>}<p className="field-hint">之後新加入的合作店家不會自動取得授權。</p>
   </section>
   {m.state==='active'&&<section className="sc-section stack"><h3>撤回素材</h3><div className="actions sc-material-danger"><ConfirmAction label="撤回素材" title="永久撤回這個素材" disabled={locked} onConfirm={()=>command('material.withdraw','撤回素材','/withdraw',{})}><p>撤回後，合作店家不能再讀取或使用這個素材，所有授權一併撤銷；已經發布的店面維持到賣家下次發布；已被下載的副本無法收回。撤回後不能復原。</p></ConfirmAction></div></section>}
   {c.sectionStatus[id]&&<p role="status">{c.sectionStatus[id]}</p>}
  </>}
 </section>;
}
