import type {SupplierReservationPage} from '../../../../../contracts/guild-launchpad/v1/hosted-shared-order';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {formatIsoLocal,formatMinor} from '../../../../../apps/portal-web/src/format';
import {RESERVATION_NOTE} from '../view';
import {ReadStatus} from './Shared';
import {ReservationSetting} from './Settings';
export function Reservations({c}:{c:ConsoleController}){
 const r=c.slot<SupplierReservationPage>('reservations'),d=r.data;
 return <section className="stack"><h2 tabIndex={-1}>預留與訂單</h2><p className="banner">{RESERVATION_NOTE}</p>
 {!c.ownerAllowed?<><p>只有業務空間擁有者可以查看預留</p>{c.owner.state==='failed'&&<ReadStatus c={c} name="owner" label="預留權限"/>}</>:<><ReservationSetting c={c}/><ReadStatus c={c} name="reservations" label="供貨預留"/>{d&&<>
 {!d.items.length&&<p>這一頁沒有供貨預留。</p>}<ul className="sc-list">{d.items.map(order=><li className="sc-section stack" key={order.order_id}><h3>{order.store.name} <span className="badge">{order.state==='reserved'?'預留中':order.state==='cancelled'?'已取消':'已到期'}</span></h3><p className="field-hint">預留編號：{order.order_id}</p><p>建立：{formatIsoLocal(order.created_at)}</p><p>{order.state==='reserved'?`預留截止：${formatIsoLocal(order.reservation_expires_at)}`:`結束：${formatIsoLocal(order.closed_at)}`}</p><ul>{order.items.map(line=><li key={line.product_id}>{line.title} · {line.sku}<br/>{line.quantity} × 供貨單價 {formatMinor(line.unit_supply_price_minor,order.currency)} ＝ 小計 {formatMinor(line.supply_total_minor,order.currency)}</li>)}</ul></li>)}</ul>
 <div className="actions"><button type="button" className="btn btn-ghost" disabled={c.cursors.length<=1||r.state!=='ready'} onClick={c.previousPage}>上一頁</button><button type="button" className="btn btn-ghost" disabled={!d.next_cursor||r.state!=='ready'} onClick={()=>d.next_cursor&&c.nextPage(d.next_cursor)}>下一頁</button></div>
 </>}</>}
 </section>;
}
