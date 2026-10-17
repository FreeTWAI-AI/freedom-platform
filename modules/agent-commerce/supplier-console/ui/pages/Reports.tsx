import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {SupplierReportQuerySchema,type SupplierReport} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import {ApiError} from '../../../../../apps/portal-web/src/api';
import {formatMinor} from '../../../../../apps/portal-web/src/format';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {reportMatchesReadKey} from '../../state/useSupplierConsoleController';
import {supplierConsoleHref,validLocalDate,type ReportPeriod,type ProductState} from '../route';
import {fetchSupplierReportCsv} from '../report-download';
import {partnerLabel,reservationState} from '../view';
import {ReadStatus} from './Shared';

export function reportPeriodError(period:ReportPeriod):string|null {
 if(!validLocalDate(period.from)||!validLocalDate(period.to)||period.from<'2000-01-01'||period.to<'2000-01-01')return '請輸入有效日期（2000 年以後）。';
 if(period.from>period.to)return '期間起不能晚於期間迄，請檢查日期。';
 return SupplierReportQuerySchema.safeParse(period).success?null:'期間最長 366 天，請縮短期間。';
}
const cooperationLabels=[['awaiting','待確認'],['sellable','可售'],['changes_requested','需修改'],['inactive','停用']] as const;
export function Reports({c}:{c:ConsoleController}){
 const period=c.reportPeriod,key=`report:${period.from}:${period.to}`,r=c.slot<SupplierReport>(key);
 const d=r.state==='ready'&&r.data&&reportMatchesReadKey(r.data,c.scope,key)?r.data:null;
 return <section className="stack"><h2 tabIndex={-1}>營運報表</h2>
  <ReportControls key={key} c={c} ready={!!d}>
  <ReadStatus c={c} name={key} label="營運報表"/>
  {d&&<>
   <section className="sc-section stack"><h3>商品（資料時間當下）</h3><table className="sc-products sc-report-table"><thead><tr><th scope="col">項目</th><th scope="col" className="sc-number">數量</th><th scope="col">清單</th></tr></thead><tbody>
    {([['total','商品總數',undefined],['offered','公開中','offered'],['not_offered','尚未公開','not_offered'],['outdated','需更新版本','outdated'],['out_of_stock','缺貨','out_of_stock']] as const).map(([field,label,state])=><tr key={field}><th scope="row">{label}</th><td className="sc-number" data-label="數量">{d.products[field]}</td><td><a className="btn btn-ghost btn-small" aria-label={`${label}：查看清單`} href={supplierConsoleHref(c.scope,'products',{state:state as ProductState|undefined})}>查看清單</a></td></tr>)}
   </tbody></table></section>
   <section className="sc-section stack"><h3>合作（資料時間當下）</h3>
    <dl className="detail-list sc-report-totals">{cooperationLabels.map(([field,label])=><div key={field}><dt>{label}</dt><dd className="sc-number">{d.cooperation.totals[field]}</dd></div>)}</dl>
    <p>合作店家 {d.cooperation.partner_count} 間</p>
    <table className="sc-products sc-report-table"><thead><tr><th scope="col">店家名稱</th><th scope="col" className="sc-number">商品數</th>{cooperationLabels.map(([field,label])=><th scope="col" className="sc-number" key={field}>{label}</th>)}</tr></thead><tbody>
     {d.cooperation.partners.map(p=><tr key={p.partner_id}><td data-label="店家名稱"><a className="btn btn-ghost btn-small" href={supplierConsoleHref(c.scope,'partner',{id:p.partner_id})}>{partnerLabel(p,d.cooperation.partners)}</a></td><td className="sc-number" data-label="商品數">{p.products}</td>{cooperationLabels.map(([field,label])=><td key={field} className="sc-number" data-label={label}>{p.cooperation[field]}</td>)}</tr>)}
    </tbody></table>
    {d.cooperation.partner_count>200&&<p>畫面只列前 200 間，CSV 列出全部店家。</p>}
   </section>
   <section className="sc-section stack"><h3>預留（期間內建立）</h3>{d.reservations.state==='unavailable'?<p>只有業務空間擁有者可以查看預留。</p>:<>
    <table className="sc-products sc-report-table"><thead><tr><th scope="col">狀態</th>{['預留筆數','行項數','數量','預留供貨金額'].map(label=><th scope="col" className="sc-number" key={label}>{label}</th>)}<th scope="col">預留清單</th></tr></thead><tbody>
     {(['reserved','cancelled','expired'] as const).map(state=>{const totals=d.reservations.state==='ready'?d.reservations[state]:null;return totals&&<tr key={state}><th scope="row">{reservationState(state)}</th><td className="sc-number" data-label="預留筆數">{totals.reservations}</td><td className="sc-number" data-label="行項數">{totals.lines}</td><td className="sc-number" data-label="數量">{totals.quantity}</td><td className="sc-number" data-label="預留供貨金額">{formatMinor(totals.supply_total_minor,d.business.currency)}</td><td><a className="btn btn-ghost btn-small" aria-label={`${reservationState(state)}：查看預留`} href={supplierConsoleHref(c.scope,'reservations',{reservation:{state,from:period.from,to:period.to}})}>查看預留</a></td></tr>;})}
    </tbody></table>
    <p className="field-hint">預留供貨金額是數量乘以供貨單價，不是營收、請款、付款或佣金。已過到期時間但尚未結算的預留算已到期。</p>
   </>}</section>
  </>}
  </ReportControls>
 </section>;
}
function ReportControls({c,ready,children}:{c:ConsoleController;ready:boolean;children:ReactNode}){
 const [form,setForm]=useState(c.reportPeriod),invalid=reportPeriodError(form),errorId=useId();
 const [download,setDownload]=useState({state:'idle' as 'idle'|'sending'|'ready'|'failed',error:''});
 const mounted=useRef(false),active=useRef<AbortController|null>(null),latest=useRef(c);latest.current=c;
 const binding=`${c.scope.tenantId}:${c.scope.instanceId}`,session=c.client.sessionGeneration;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;active.current?.abort();active.current=null;};},[c.client,binding,session]);
 async function saveCsv(){
  if(active.current||invalid||!ready)return;
  const abort=new AbortController(),generation=c.client.sessionGeneration,period={...c.reportPeriod};active.current=abort;
  const current=()=>mounted.current&&!abort.signal.aborted&&active.current===abort&&latest.current.client===c.client&&c.client.sessionGeneration===generation&&`${latest.current.scope.tenantId}:${latest.current.scope.instanceId}`===binding;
  setDownload({state:'sending',error:''});
  try{
   const file=await fetchSupplierReportCsv(c.client,c.scope,period,abort.signal);if(!current())return;
   const url=URL.createObjectURL(file.blob),a=document.createElement('a');
   try{a.href=url;a.download=file.filename;document.body.append(a);a.click();}finally{a.remove();URL.revokeObjectURL(url);}
   if(current())setDownload({state:'ready',error:''});
  }catch(cause){if(!current())return;setDownload({state:'failed',error:cause instanceof ApiError?cause.message:'無法下載 CSV，請重試。'});if(cause instanceof ApiError&&cause.status===403)void c.read('profile');}
  finally{if(active.current===abort)active.current=null;}
 }
 return <>
  <form className="stack" aria-label="報表期間" noValidate onSubmit={e=>{e.preventDefault();if(!invalid)window.location.hash=supplierConsoleHref(c.scope,'reports',{period:form});}}>
   <div className="sc-toolbar sc-reservation-filters">{([['from','期間起（台灣時間）'],['to','期間迄（台灣時間）']] as const).map(([field,label])=><label className="field" key={field}>{label}<input type="date" min="2000-01-01" value={form[field]} aria-invalid={!!invalid||undefined} aria-describedby={invalid?errorId:undefined} onChange={e=>setForm(old=>({...old,[field]:e.target.value}))}/></label>)}</div>
   {invalid&&<p className="field-hint" id={errorId} role="alert">{invalid}</p>}
   <div className="actions"><button className="btn btn-small" type="submit" disabled={!!invalid}>套用期間</button><button className="btn btn-ghost btn-small" type="button" onClick={()=>{setForm(c.reportPeriod);window.location.hash=supplierConsoleHref(c.scope,'reports');}}>回到最近 30 天</button></div>
  </form>
  <p className="field-hint">商品與合作是資料時間當下的狀態；預留只計期間內建立的預留（台灣時間，含首尾）。</p>
  {children}
  {ready&&<section className="sc-section stack"><h3>下載 CSV</h3><p>CSV 使用相同期間，下載時重新計算，資料時間可能比畫面晚。本檔不是完整資料匯出，也不是備份或搬家用的資料包。</p>
   <div className="actions"><button className="btn btn-ghost btn-small" type="button" disabled={download.state==='sending'||!!invalid} onClick={()=>void saveCsv()}>下載 CSV</button></div>
   <p role="status">{download.state==='sending'?'正在產生 CSV…':download.state==='ready'?'已開始下載 CSV。':''}</p>
   {download.state==='failed'&&<div className="banner stack"><p role="alert">{download.error}</p><div className="actions"><button type="button" className="btn btn-ghost btn-small" disabled={!!invalid} onClick={()=>void saveCsv()}>重試</button></div></div>}
  </section>}
 </>;
}
