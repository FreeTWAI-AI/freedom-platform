import {useState} from 'react';
import type {SupplierReservations,SupplierReservationDetail,SupplierConsoleReservation,SupplierPartners,SupplierProducts} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {formatIsoLocal,formatMinor} from '../../../../../apps/portal-web/src/format';
import {RESERVATION_NOTE,partnerLabel,reservationState} from '../view';
import {supplierConsoleHref,reservationFilterParams,type ReservationFilters} from '../route';
import {ReadStatus,dataTime} from './Shared';
import {ReservationSetting} from './Settings';
function FilterForm({c}:{c:ConsoleController}){
 const [filters,setFilters]=useState<ReservationFilters>(c.route.reservation??{}),partners=c.slot<SupplierPartners>('partners'),products=c.slot<SupplierProducts>('products');
 const invalid=reservationFilterParams(filters)===null,optionFailure=partners.state==='failed'||products.state==='failed'||!c.profile?.capabilities.includes('store:write');
 const edit=(key:keyof ReservationFilters,value:string)=>setFilters(old=>({...old,[key]:value||undefined}));
 return <form className="stack" aria-label="篩選預留" onSubmit={e=>{e.preventDefault();if(!invalid)window.location.hash=supplierConsoleHref(c.scope,'reservations',{reservation:filters});}}>
  <div className="sc-toolbar sc-reservation-filters">
   <label className="field">狀態<select value={filters.state??''} onChange={e=>edit('state',e.target.value)}><option value="">全部</option><option value="reserved">預留中</option><option value="cancelled">已取消</option><option value="expired">已到期</option></select></label>
   <label className="field">合作店家<select value={filters.partner??''} onChange={e=>edit('partner',e.target.value)}><option value="">全部</option>{filters.partner&&!partners.data?.items.some(p=>p.partner_id===filters.partner)&&<option value={filters.partner}>店家 ID …{filters.partner.slice(-6)}</option>}{partners.data?.items.map(p=><option value={p.partner_id} key={p.partner_id}>{partnerLabel(p,partners.data!.items)}</option>)}</select></label>
   <label className="field">商品<select value={filters.product??''} onChange={e=>edit('product',e.target.value)}><option value="">全部</option>{filters.product&&!products.data?.items.some(p=>p.product_id===filters.product)&&<option value={filters.product}>商品 ID …{filters.product.slice(-6)}</option>}{products.data?.items.map(p=><option value={p.product_id} key={p.product_id}>{p.title} · {p.sku}</option>)}</select></label>
   <label className="field">建立日期起（台灣時間）<input type="date" value={filters.from??''} aria-invalid={invalid||undefined} aria-describedby={invalid?'sc-reservation-date-error':undefined} onChange={e=>edit('from',e.target.value)}/></label>
   <label className="field">建立日期迄（台灣時間）<input type="date" value={filters.to??''} aria-invalid={invalid||undefined} aria-describedby={invalid?'sc-reservation-date-error':undefined} onChange={e=>edit('to',e.target.value)}/></label>
  </div>
  {invalid&&<p className="field-hint" id="sc-reservation-date-error" role="alert">建立日期起不能晚於建立日期迄，請檢查日期。</p>}
  {optionFailure&&<p className="field-hint">店家／商品選項暫時無法讀取，仍可用連結篩選。</p>}
  <div className="actions"><button type="submit" className="btn btn-small" disabled={invalid}>套用篩選</button><button type="button" className="btn btn-ghost btn-small" onClick={()=>{setFilters({});window.location.hash=supplierConsoleHref(c.scope,'reservations');}}>清除篩選</button></div>
 </form>;
}
export function ReservationTotals({data}:{data:SupplierReservations}){return <p>符合條件：{data.totals.reservations} 筆預留、{data.totals.lines} 個供貨行項 <span className="field-hint">資料時間 {dataTime(data.as_of)}</span></p>;}
export function ReservationDetailLink({c,order}:{c:ConsoleController;order:SupplierConsoleReservation}){return <a className="btn btn-ghost btn-small" href={supplierConsoleHref(c.scope,'reservation',{id:order.order_id})}>查看預留明細<span className="sr-only">：預留編號 …{order.order_id.slice(-8)}</span></a>;}
function ReservationTimes({order}:{order:SupplierConsoleReservation}){return <><p>建立：{formatIsoLocal(order.created_at)}</p><p>{order.state==='reserved'?`預留截止：${formatIsoLocal(order.reservation_expires_at)}`:`結束：${formatIsoLocal(order.closed_at)}`}</p></>;}
function ReservationLines({c,order,links=false}:{c:ConsoleController;order:SupplierConsoleReservation;links?:boolean}){return <ul>{order.items.map(line=><li key={line.product_id}>{links?<a href={supplierConsoleHref(c.scope,'product',{id:line.product_id})}>{line.title}</a>:line.title} · {line.sku}<br/>{line.quantity} × 供貨單價 {formatMinor(line.unit_supply_price_minor,order.currency)} ＝ 小計 {formatMinor(line.supply_total_minor,order.currency)}</li>)}</ul>;}
function reservationPartner(order:SupplierConsoleReservation,peers:SupplierPartners['items']){return partnerLabel({partner_id:order.partner_id,name:order.store.name},peers);}
export function Reservations({c}:{c:ConsoleController}){
 const r=c.slot<SupplierReservations>('reservations'),query=reservationFilterParams(c.route.reservation??{}),peers=c.slot<SupplierPartners>('partners').data?.items??[];
 const d=query&&r.data&&(['state','partner_id','product_id','from','to'] as const).every(key=>r.data!.filter[key]===(query.get(key)??null))?r.data:null;
 return <section className="stack"><h2 tabIndex={-1}>預留與訂單</h2><p className="banner">{RESERVATION_NOTE}</p>
 {!c.ownerAllowed?<><p>只有業務空間擁有者可以查看預留</p>{c.owner.state==='failed'&&<ReadStatus c={c} name="owner" label="預留權限"/>}</>:<><ReservationSetting c={c}/>
 <FilterForm key={supplierConsoleHref(c.scope,'reservations',{reservation:c.route.reservation})} c={c}/>
 {query&&<><ReadStatus c={c} name="reservations" label="供貨預留"/>{d&&<>
 {r.state==='ready'&&<ReservationTotals data={d}/>}
 {!d.items.length&&<p>沒有符合條件的供貨預留。</p>}<ul className="sc-list">{d.items.map(order=><li className="sc-section stack" key={order.order_id}><h3>{reservationPartner(order,peers)} <span className="badge">{reservationState(order.state)}</span></h3><p className="field-hint" title={order.order_id}>預留編號：<span aria-hidden="true">…{order.order_id.slice(-8)}</span><span className="sr-only">{order.order_id}</span></p><ReservationTimes order={order}/><ReservationLines c={c} order={order}/><div className="actions"><ReservationDetailLink c={c} order={order}/></div></li>)}</ul>
 <div className="actions"><button type="button" className="btn btn-ghost" disabled={c.cursors.length<=1||r.state!=='ready'} onClick={c.previousPage}>上一頁</button><button type="button" className="btn btn-ghost" disabled={!d.next_cursor||r.state!=='ready'} onClick={()=>d.next_cursor&&c.nextPage(d.next_cursor)}>下一頁</button></div>
 </>}</>}</>}
 </section>;
}
export function Reservation({c}:{c:ConsoleController}){
 const key='reservation:'+c.route.id,r=c.slot<SupplierReservationDetail>(key),d=r.data,order=d?.reservation,peers=c.slot<SupplierPartners>('partners').data?.items??[];
 return <section className="stack"><h2 tabIndex={-1}>預留明細</h2><div className="actions"><a className="btn btn-ghost btn-small" href={supplierConsoleHref(c.scope,'reservations',{reservation:c.reservationFilters})}>返回預留與訂單</a></div>
 {!c.ownerAllowed?<><p>只有業務空間擁有者可以查看預留</p>{c.owner.state==='failed'&&<ReadStatus c={c} name="owner" label="預留權限"/>}</>:<><ReadStatus c={c} name={key} label="預留明細"/>{r.status===404&&<p>找不到這份預留。</p>}{d&&order&&<>
  <h3>{reservationPartner(order,peers)} <span className="badge">{reservationState(order.state)}</span></h3><p className="field-hint" title={order.order_id}>預留編號：<span aria-hidden="true">…{order.order_id.slice(-8)}</span><span className="sr-only">{order.order_id}</span></p><ReservationTimes order={order}/><ReservationLines c={c} order={order} links/>
  <p className="field-hint">只顯示你供貨的行項；買家資料、其他供應商的商品與整張訂單金額不會顯示。</p><p className="banner">{RESERVATION_NOTE}</p>
  <section className="sc-section stack"><h3>供貨版本</h3><ul className="sc-list">{d.offers.map(offer=><li className="sc-row" key={offer.offer_id}><div><strong>{order.items.find(line=>line.product_id===offer.product_id)?.title??'商品 ID …'+offer.product_id.slice(-6)}</strong><p>供貨版本 …{offer.terms_sha256.slice(-8)} <span className="badge">{offer.state==='offered'?'公開中':'已撤回'}</span></p></div></li>)}</ul></section>
  <div className="actions"><a className="btn btn-ghost btn-small" href={supplierConsoleHref(c.scope,'partner',{id:order.partner_id})}>查看合作店家</a><a className="btn btn-ghost btn-small" href={supplierConsoleHref(c.scope,'reservations',{reservation:{partner:order.partner_id}})}>查看這間店的全部預留</a></div>
 </>}</>}
 </section>;
}
