import type {SupplierReservations,SupplierPartners,SupplierPartnerDetail} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {supplierConsoleHref} from '../route';
import {partnerLabel,selectionState,reservationState} from '../view';
import {formatMinor,formatIsoLocal} from '../../../../../apps/portal-web/src/format';
import {ReadStatus,useListRestore} from './Shared';
import {ReservationTotals,ReservationDetailLink} from './Reservations';
export function Truncated({c}:{c:ConsoleController}){return <p>只顯示部分，完整數量見營運概覽。<a href={supplierConsoleHref(c.scope,'overview')}>營運概覽</a> · <a href={supplierConsoleHref(c.scope,'products')}>依商品查看</a> · <a href={supplierConsoleHref(c.scope,'partners')}>依店家查看</a></p>;}
export function Partners({c}:{c:ConsoleController}){
 const r=c.slot<SupplierPartners>('partners'),d=r.data,pos=c.position('partners'),restore=useListRestore(c,'partners',r),items=d?.items.filter(p=>p.name.includes(pos.search)||p.partner_id.includes(pos.search))??[];
 return <section className="stack"><h2 tabIndex={-1} ref={restore.heading}>合作店家</h2><ReadStatus c={c} name="partners" label="合作店家"/>{d&&<>
 <label className="field">搜尋合作店家<input type="search" value={pos.search} onChange={e=>c.remember('partners',{search:e.target.value})}/></label>{d.truncated&&<Truncated c={c}/>}
 {!items.length&&<p>{pos.search?'沒有符合的合作店家。':'目前沒有合作店家。'}</p>}<ul className="sc-list">{items.map(p=><li className="sc-row" key={p.partner_id}><div><a data-sc-item={p.partner_id} href={supplierConsoleHref(c.scope,'partner',{id:p.partner_id})} onClick={()=>restore.open(p.partner_id)}>{partnerLabel(p,d.items)}</a><p>商品數 {p.products}</p><p>待確認 {p.cooperation.awaiting}／可售 {p.cooperation.sellable}／需修改 {p.cooperation.changes_requested}／停用 {p.cooperation.inactive}</p></div></li>)}</ul>
 </>}</section>;
}
export function Partner({c}:{c:ConsoleController}){
 const key='partner:'+c.route.id,r=c.slot<SupplierPartnerDetail>(key),d=r.data,peers=c.slot<SupplierPartners>('partners').data?.items??[];
 const reservationsKey='partner-reservations:'+c.route.id,reservations=c.slot<SupplierReservations>(reservationsKey),orders=reservations.data;
 return <section className="stack"><h2 tabIndex={-1}>合作店家詳情</h2><div className="actions"><a className="btn btn-ghost" href={supplierConsoleHref(c.scope,'partners')}>返回合作店家</a></div><ReadStatus c={c} name={key} label="合作店家詳情"/>{r.status===404&&<p>找不到這間合作店家。</p>}{d&&<><h3>{partnerLabel(d.partner,peers)}</h3>{d.truncated&&<Truncated c={c}/>}<ul className="sc-list">{d.selections.map(s=><li className="sc-row" key={s.selection_id}><div><strong>{s.offer.terms.title} · {s.sku}</strong><p>售價 {formatMinor(s.retail_price_minor,s.offer.terms.currency)} <span className="badge">{selectionState(s)}</span></p></div><div className="actions"><a className="btn btn-ghost" href={supplierConsoleHref(c.scope,'review',{id:s.selection_id})}>{s.state==='awaiting_supply_acceptance'?'審核':'查看申請'}</a></div></li>)}</ul>{!d.selections.length&&<p>目前沒有選品紀錄。</p>}</>}
 <section className="sc-section stack"><h4>相關預留</h4>{!c.ownerAllowed?<><p>只有業務空間擁有者可以查看預留</p>{c.owner.state==='failed'&&<ReadStatus c={c} name="owner" label="預留權限"/>}</>:<>
  <ReadStatus c={c} name={reservationsKey} label="相關預留" scopedAction/>{orders&&<>
   {reservations.state==='ready'&&<ReservationTotals data={orders}/>}
   {!orders.items.length&&<p>這間店目前沒有供貨預留。</p>}
   <ul className="sc-history">{orders.items.slice(0,5).map(order=><li className="sc-row" key={order.order_id}><div><span className="badge">{reservationState(order.state)}</span><p>建立：{formatIsoLocal(order.created_at)}</p><p>{order.items.length} 個供貨行項 · 供貨小計 {formatMinor(order.items.reduce((sum,line)=>sum+line.supply_total_minor,0),order.currency)}</p></div><div className="actions"><ReservationDetailLink c={c} order={order}/></div></li>)}</ul>
  </>}<div className="actions"><a className="btn btn-ghost btn-small" href={supplierConsoleHref(c.scope,'reservations',{reservation:{partner:c.route.id}})}>查看這間店的全部預留</a></div>
 </>}</section></section>;
}
