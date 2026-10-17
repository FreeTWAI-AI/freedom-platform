import {useEffect,useId,useRef,type ReactNode} from 'react';
import type {ConsoleController,ReadSlot} from '../../state/useSupplierConsoleController';
import type {Fields} from '../../state/drafts';
import type {AttemptKind} from '../../state/attempt';
import {conflictRows} from '../../state/drafts';
import {fieldLabels,changeLabel,changeSubject} from '../view';
import type {SupplierChanges} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import {formatIsoLocal} from '../../../../../apps/portal-web/src/format';
import {supplierConsoleHref} from '../route';
export function dataTime(time:string|null,seconds=true){return time?new Date(time).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{})}):'尚未取得';}
export function ReadStatus<T>({c,name,label,scopedAction=false}:{c:ConsoleController;name:string;label:string;scopedAction?:boolean}) {
 const r=c.slot<T>(name);
 return <div className="sc-read-status stack">
  <p role={r.state==='failed'?'alert':'status'}>{r.state==='idle'||r.state==='loading'&&!r.data?`正在讀取${label}…`:r.state==='loading'?`更新中（資料時間 ${dataTime(r.asOf)}）`:r.state==='failed'?`${r.data?`未更新（最後成功 ${dataTime(r.lastOkAt,false)}）`:`暫時無法讀取${label}`}。${r.error}`:`資料時間 ${dataTime(r.asOf)}`}</p>
  <div className="actions"><button type="button" className="btn btn-ghost" disabled={r.state==='loading'} onClick={()=>void c.read(name)}>{r.state==='failed'?'重試':'更新資料'}{scopedAction&&<span className="sr-only">：{label}</span>}</button></div>
 </div>;
}
export function WriteAccess({c,children}:{c:ConsoleController;children:ReactNode}) {return c.profile?.capabilities.includes('store:write')?<>{children}</>:<div className="stack"><h2 tabIndex={-1}>{c.route.page==='product'?'商品詳情':c.route.page==='partner'?'合作店家詳情':c.route.page==='review'?'審核售價申請':c.route.page==='product-new'?'新增商品':c.route.page==='partners'?'合作店家':c.route.page==='terms'?'供貨條件與審核':c.route.page==='reports'?'營運報表':c.route.page==='materials'?'行銷素材':c.route.page==='material-new'?'新增素材':c.route.page==='material'?'素材詳情':'商品與庫存'}</h2><p>需要商品編輯權限才能查看。供貨價與條件不會顯示，請聯絡業務空間擁有者。</p></div>;}
export function Capacity({count}:{count:number}){return <p className="field-hint">共用商品容量 {count}／200（含供貨商品與商店選品）</p>;}
export function Editor({c,name,title,base,version,kind,path,target,productId,fields,primary=false,disabled=false,children}:{c:ConsoleController;name:string;title:string;base:Fields;version:string;kind:AttemptKind;path:string;target:string;productId?:string;fields:{key:string;label?:string;multiline?:boolean;money?:boolean;max?:number;required?:boolean;options?:{value:string;label:string}[]}[];primary?:boolean;disabled?:boolean;children?:ReactNode}){
 const draft=c.drafts[name],values={...base,...draft?.fields},conflict=c.conflicts[name];
 return <form className="stack" aria-label={title} onSubmit={e=>{e.preventDefault();c.save(kind,title,name,base,version,target,path,productId);}}>
  <fieldset className="hosted-store-fields stack" disabled={c.locked||disabled||!!conflict}><legend className="sr-only">{title}</legend>
   {fields.map(f=><label key={f.key} className="field">{f.label??fieldLabels[f.key]}{f.multiline?<textarea maxLength={f.max??2000} required={f.required} value={String(values[f.key]??'')} onChange={e=>c.updateDraft(name,version,base,f.key,e.target.value)}/>:f.options?<select value={String(values[f.key])} onChange={e=>c.updateDraft(name,version,base,f.key,e.target.value)}>{f.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<input required={f.required} maxLength={f.max??120} inputMode={f.money?'decimal':f.key==='stock'?'numeric':undefined} value={String(values[f.key]??'')} onChange={e=>c.updateDraft(name,version,base,f.key,e.target.value)}/>}</label>)}
   {children}
   <div className="actions"><button className={primary?'btn btn-primary':'btn btn-ghost'} disabled={c.locked||disabled||!draft||!!conflict}>{title}</button>{draft&&!conflict&&<button type="button" className="btn btn-ghost" onClick={()=>c.discard(name)}>放棄我的修改</button>}</div>
  </fieldset>
  {draft?.stale&&<p className="field-hint">保存前會以最新資料核對</p>}
  {c.sectionStatus[name]&&<p role="status">{c.sectionStatus[name]}</p>}
  {conflict&&draft&&<div className="banner stack"><p>資料剛剛被更新。你的修改還在，請確認後再套用。</p>
   <dl className="detail-list">{conflictRows(draft,base).map(row=><div key={row.field}><dt>{fieldLabels[row.field]??row.field}</dt><dd>你的修改：{String(row.mine)}<br/>目前資料：{String(row.current??'')}</dd></div>)}</dl>
   <div className="actions"><button type="button" className="btn btn-ghost" disabled={c.locked||disabled} onClick={()=>c.reapply(name,base,version)}>以最新版本重新套用</button><button type="button" className="btn btn-ghost" disabled={c.phase!=='idle'} onClick={()=>c.discard(name)}>放棄我的修改</button></div>
  </div>}
 </form>;
}
export function ConfirmAction({label,title,children,disabled,onConfirm}:{label:string;title:string;children:ReactNode;disabled:boolean;onConfirm:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
 const close=()=>{dialog.current?.close();trigger.current?.focus({preventScroll:true});};
 return <><button ref={trigger} type="button" className="btn btn-ghost" disabled={disabled} aria-haspopup="dialog" onClick={()=>dialog.current?.showModal()}>{label}</button>
  <dialog ref={dialog} aria-labelledby={id} onCancel={e=>{e.preventDefault();close();}} onClose={()=>trigger.current?.focus({preventScroll:true})}><div className="stack"><h2 id={id}>{title}</h2>{children}<p>這是目前資料的影響預覽，送出時會重新確認權限與版本。</p><div className="actions"><button type="button" autoFocus className="btn btn-ghost" onClick={close}>取消</button><button type="button" className="btn btn-primary" disabled={disabled} onClick={()=>{close();onConfirm();}}>確認{label}</button></div></div></dialog>
 </>;
}
export function useListRestore(c:ConsoleController,name:string,slot:ReadSlot<unknown>){
 const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{if(slot.state!=='ready')return;const p=c.position(name);if(!p.lastId)return;const frame=requestAnimationFrame(()=>{const link=Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-sc-item]')).find(el=>el.dataset.scItem===p.lastId);(link??heading.current)?.focus({preventScroll:true});window.scrollTo(0,p.scroll);});return()=>cancelAnimationFrame(frame);},[slot.state]);
 return {heading,open:(id:string)=>c.remember(name,{lastId:id,scroll:window.scrollY})};
}
export function Changes({c,productId}:{c:ConsoleController;productId?:string}){
 const name=productId?'changes:'+productId:'changes',r=c.slot<SupplierChanges>(name),d=r.data;
 return <section className="sc-section stack"><h3>{productId?'紀錄':'近期變更'}</h3>
  {!c.profile?.capabilities.includes('store:write')?<p>無法取得：需要商品編輯權限才能查看</p>:<><ReadStatus c={c} name={name} label={productId?'商品紀錄':'近期變更'} scopedAction/>{d&&<>
   {!d.items.length&&<p>{productId?'這項商品目前沒有紀錄。':'目前沒有近期變更。'}</p>}
   <ol className="sc-history">{[...d.items].sort((a,b)=>b.at.localeCompare(a.at)).map(change=>{const s=change.subject,subject=productId?s.kind==='request'?s.partner_name:s.kind==='business'?'商品庫設定':'':changeSubject(s);
    return <li className="sc-row" key={change.change_id}><div><strong>{changeLabel(change)}</strong>{subject&&<p>{subject}</p>}<p><time dateTime={change.at}>{formatIsoLocal(change.at)}</time> · 版本 {change.version}</p></div>
     {(s.kind==='business'||s.kind==='request'||!productId)&&<div className="actions"><a className="btn btn-ghost btn-small" href={s.kind==='business'?supplierConsoleHref(c.scope,'settings'):s.kind==='request'?supplierConsoleHref(c.scope,'review',{id:s.selection_id}):supplierConsoleHref(c.scope,'product',{id:s.product_id})}>{s.kind==='business'?'查看設定':s.kind==='request'?'查看申請':'查看商品'}</a></div>}
    </li>;})}</ol>{d.truncated&&<p>只顯示最近 20 筆。</p>}
  </>}</>}
  <p className="field-hint">只列出這個商品庫的操作與版本，不顯示操作者。</p>
 </section>;
}
