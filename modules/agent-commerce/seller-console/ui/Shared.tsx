import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {ZodError,type z} from 'zod';
import type {Controller,ReadSlot} from '../state/controller';
import {NOT_ALLOWED,permissionHelp} from './view';
import {formatIsoLocal} from '../../../../apps/portal-web/src/format';
export function useRead<T>(c:Controller,key:string,path:string,schema:z.ZodType<T>,enabled=true,match?:(value:T)=>boolean):ReadSlot<T>{
 const matchRef=useRef(match);matchRef.current=match;
 useEffect(()=>{if(enabled)void c.load(key,{path,schema,match:v=>matchRef.current?.(v as T)??true});return()=>c.unregister(key);},[c.load,c.unregister,key,path,schema,enabled]);
 return c.slot<T>(key);
}
export function Permission(){return <p role="alert">{NOT_ALLOWED}。{permissionHelp}</p>;}
export function ReadStatus<T>({c,name,label,slot}:{c:Controller;name:string;label:string;slot?:ReadSlot<T>}){
 const r=slot??c.slot(name);
 return <div className="seller-read stack">
  {r.state==='failed'?<p role="alert">{r.status===403?NOT_ALLOWED+'。'+permissionHelp:`無法取得${label}，請稍後重試。${r.error}`}{r.data&&` 保留的資料時間：${formatIsoLocal(r.time)}`}</p>:<p role="status">{r.state==='idle'||r.state==='loading'?`正在讀取${label}…`:`資料時間：${formatIsoLocal(r.time)}`}</p>}
  <div className="actions"><button type="button" className="btn btn-ghost" disabled={r.state==='loading'} onClick={()=>void c.load(name)}>{r.state==='failed'?'重試':'更新資料'}<span className="sr-only">：{label}</span></button></div>
 </div>;
}
export function Axis({title,time,readState,children}:{title:string;time?:string|null;readState?:ReadSlot<unknown>['state'];children:ReactNode}){return <section className="card stack seller-axis" aria-label={title}><h3 tabIndex={-1}>{title}</h3>{time&&<p className="field-hint">資料時間：{formatIsoLocal(time)}</p>}{readState==='failed'&&<p role="status">這個項目的最新狀態尚未確認；以下保留上次讀取的資料。</p>}{readState==='loading'&&<p role="status">正在確認這個項目的最新狀態…</p>}{children}</section>;}
export function Confirm({label,children,disabled,onConfirm}:{label:string;children:ReactNode;disabled:boolean;onConfirm:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
 function close(){dialog.current?.close();if(trigger.current?.isConnected&&!trigger.current.disabled)trigger.current.focus({preventScroll:true});}
 return <><button type="button" ref={trigger} className="btn btn-ghost" disabled={disabled} onClick={()=>dialog.current?.showModal()}>{label}</button><dialog ref={dialog} aria-labelledby={id} onCancel={e=>{e.preventDefault();close();}} onClose={()=>{if(trigger.current?.isConnected&&!trigger.current.disabled)trigger.current.focus({preventScroll:true});}}><div className="stack"><h2 id={id}>{label}</h2>{children}<div className="actions"><button type="button" className="btn btn-ghost" autoFocus onClick={close}>關閉</button><button type="button" className="btn btn-primary" disabled={disabled} onClick={()=>{close();onConfirm();}}>確認{label}</button></div></div></dialog></>;
}
export type Field={name:string;label:string;type?:string;required?:boolean;pattern?:RegExp;hint?:string;options?:readonly {value:string;label:string}[]};
/** Form values remain session memory only; credential forms explicitly reset when their attempt settles. */
export function Editor({c,name,label,fields,onSubmit,sensitive=false,disabled=false}:{c:Controller;name:string;label:string;fields:Field[];onSubmit:(values:Record<string,string>,clear:()=>void)=>void;sensitive?:boolean;disabled?:boolean}){
 const [values,setValues]=useState<Record<string,string>>({}),[errors,setErrors]=useState<Record<string,string>>({}),prefix=useId(),form=useRef<HTMLFormElement>(null);
 useEffect(()=>()=>c.markDirty(name,false),[c.markDirty,name]);
 function clear(){form.current?.reset();setValues({});setErrors({});c.markDirty(name,false);}
 return <form ref={form} className="stack" aria-label={label} noValidate onSubmit={event=>{event.preventDefault();const failures:Record<string,string>={};for(const f of fields){const v=values[f.name]??'';if(f.required&&!v||v&&f.pattern&&!f.pattern.test(v))failures[f.name]='請檢查'+f.label+'的格式。';}setErrors(failures);if(Object.keys(failures).length)return;try{onSubmit(values,clear);}catch(cause){const keys=cause instanceof ZodError?cause.issues.map(i=>String(i.path[0])):fields.some(f=>f.name==='amount')?['amount']:fields.map(f=>f.name);const relevant=fields.filter(f=>keys.includes(f.name));setErrors(Object.fromEntries((relevant.length?relevant:fields).map(f=>[f.name,'請檢查'+f.label+'的格式與可用範圍。'])));}}}>
  {Object.keys(errors).length>0&&<div role="alert"><p>請修正以下欄位再送出：</p><ul>{Object.entries(errors).map(([key,text])=><li key={key}><a href={'#'+prefix+key} onClick={e=>{e.preventDefault();document.getElementById(prefix+key)?.focus();}}>{text}</a></li>)}</ul></div>}
  <fieldset className="stack" disabled={c.locked||disabled}><legend className="sr-only">{label}</legend>{fields.map(f=><label className="field" htmlFor={prefix+f.name} key={f.name}>{f.label}{f.options?<select id={prefix+f.name} aria-label={f.label} value={sensitive?undefined:values[f.name]??''} aria-invalid={!!errors[f.name]} aria-describedby={f.hint||errors[f.name]?prefix+f.name+'-hint':undefined} onChange={e=>{const next={...values,[f.name]:e.target.value};setValues(next);c.markDirty(name,Object.values(next).some(Boolean));}}><option value="">請選擇</option>{f.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<input id={prefix+f.name} aria-label={f.label} type={f.type??'text'} autoComplete={sensitive?'off':undefined} spellCheck={sensitive?false:undefined} value={sensitive?undefined:values[f.name]??''} aria-invalid={!!errors[f.name]} aria-describedby={f.hint||errors[f.name]?prefix+f.name+'-hint':undefined} onChange={e=>{const next={...values,[f.name]:e.target.value};setValues(next);c.markDirty(name,Object.values(next).some(Boolean));}}/>}{(f.hint||errors[f.name])&&<span className="field-hint" id={prefix+f.name+'-hint'}>{errors[f.name]??f.hint}</span>}</label>)}<div className="actions"><button className="btn btn-ghost" type="submit">{label}</button><button className="btn btn-ghost" type="button" onClick={clear}>清除輸入</button></div></fieldset>
 </form>;
}
