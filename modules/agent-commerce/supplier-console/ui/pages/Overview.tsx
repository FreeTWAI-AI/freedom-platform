import type {SupplierOverview} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {supplierConsoleHref} from '../route';
import {metricText,permissionReason,todoText} from '../view';
import {ReadStatus,Capacity,dataTime,Changes} from './Shared';
export function Overview({c}:{c:ConsoleController}){
 const r=c.slot<SupplierOverview>('overview'),d=r.data,href=(page:Parameters<typeof supplierConsoleHref>[1],extra={})=>supplierConsoleHref(c.scope,page,extra);
 const metrics=d?[
  {name:'公開供貨商品',metric:d.metrics.offered_products,definition:'目前有公開供貨版本的商品，包含需更新版本的商品。',href:href('products',{state:'offered'})},
  {name:'待確認售價申請',metric:d.metrics.pending_requests,definition:'仍在公開版本上等待你確認的售價申請。',href:href('terms')},
  {name:'有效供貨預留行項',metric:d.metrics.active_reservation_lines,definition:'這份資料時間仍有效且未到期的供貨預留行數；預留不是成交。',href:c.ownerAllowed?href('reservations',{reservation:{state:'reserved'}}):null},
  {name:'缺貨商品',metric:d.metrics.out_of_stock_products,definition:'可用量（庫存減已預留）等於零的商品。',href:href('products',{state:'out_of_stock'})},
 ]:[];
 return <section className="stack"><h2 tabIndex={-1}>營運概覽</h2>
  {!c.profile?.capabilities.includes('store:write')&&<p>目前只有查看商品庫的權限。供貨價與條件不會顯示，需要商品編輯權限才能查看指標與清單。</p>}
  <ReadStatus c={c} name="overview" label="營運概覽"/>
  {d&&<><div className="sc-metrics">{metrics.map(m=><article className="card stack" key={m.name}><h3>{m.name}</h3><strong className="sc-metric-value">{m.metric.state==='ready'?metricText(m.metric):'無法取得'}</strong>{m.metric.state==='unavailable'&&<p>{permissionReason(m.metric.reason)}</p>}<p>{m.definition}</p><p className="field-hint">{r.state==='loading'?'更新中':r.state==='failed'?'未更新':'資料時間'} {dataTime(d.as_of)}</p>{m.href&&m.metric.state==='ready'&&<div className="actions"><a className="btn btn-ghost" href={m.href}>查看清單<span className="sr-only">：{m.name}</span></a></div>}</article>)}</div>
  <Capacity count={d.product_count}/>{d.product_count===0&&c.can('store:write')&&<div className="actions"><a className="btn btn-primary" href={href('product-new')}>新增商品</a></div>}<section className="stack"><h3>待辦</h3>{d.todos.state==='unavailable'?<p>無法取得：{permissionReason(d.todos.reason)}</p>:<>
   {d.todos.truncated&&<p>只顯示前 20 項待辦</p>}{!d.todos.items.length&&<p>目前沒有待辦。</p>}
   <ul className="sc-list">{d.todos.items.map((todo,index)=><li className="sc-row" key={index}><div><strong>{todo.title}</strong>{todo.kind==='request_pending'&&<p>{todo.partner_name}（店家 ID …{todo.partner_id.slice(-6)}）</p>}<p>{todoText(todo)}</p></div><div className="actions"><a className="btn btn-ghost" href={todo.kind==='request_pending'?href('review',{id:todo.selection_id}):href('product',{id:todo.product_id})}>{todo.kind==='request_pending'?'審核':'查看商品'}</a></div></li>)}</ul>
  </>}</section></>}
  <Changes c={c}/>
 </section>;
}
