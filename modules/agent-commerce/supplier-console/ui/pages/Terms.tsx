import type {z} from 'zod';
import type {DistributionsSchema,SupplyOffersSchema,Distribution} from '../../../../../contracts/guild-launchpad/v1/hosted-distribution';
import type {SupplierProducts,SupplierRequestDetail} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {formatMinor} from '../../../../../apps/portal-web/src/format';
import {supplierConsoleHref} from '../route';
import {partnerLabel,selectionState,selectionShopLabel,priceGap,PRICE_GAP_NOTE,REVIEW_NOTE} from '../view';
import {ReadStatus,ConfirmAction,useListRestore} from './Shared';
import {Truncated} from './Partners';
export function Terms({c}:{c:ConsoleController}){
 const r=c.slot<z.infer<typeof DistributionsSchema>>('requests'),o=c.slot<z.infer<typeof SupplyOffersSchema>>('offers'),products=c.slot<SupplierProducts>('products').data,pos=c.position('terms'),restore=useListRestore(c,'terms',r);
 const queue=r.data?.items.filter(s=>s.state==='awaiting_supply_acceptance'&&s.offer.state==='offered')??[],other=r.data?.items.filter(s=>!queue.includes(s))??[];
 const list=(items:Distribution[])=>{const filtered=items.filter(s=>[s.seller_name,s.sku,s.offer.terms.title].join(' ').includes(pos.search));return !filtered.length?<p>目前沒有申請。</p>:<ul className="sc-list">{filtered.map(s=><li className="sc-row" key={s.selection_id}><div><a data-sc-item={s.selection_id} href={supplierConsoleHref(c.scope,'review',{id:s.selection_id})} onClick={()=>restore.open(s.selection_id)}>{s.offer.terms.title} · {selectionShopLabel(s,r.data!.items)}</a><p>{s.sku} · 售價 {formatMinor(s.retail_price_minor,s.offer.terms.currency)} <span className="badge">{selectionState(s)}</span></p></div></li>)}</ul>;};
 return <section className="stack"><h2 tabIndex={-1} ref={restore.heading}>供貨條件與審核</h2><label className="field">搜尋申請<input type="search" value={pos.search} onChange={e=>c.remember('terms',{search:e.target.value})}/></label>
 <ReadStatus c={c} name="requests" label="售價申請"/>{r.data&&<><h3>待確認申請</h3>{list(queue)}{r.data.truncated&&<Truncated c={c}/>}</>}
 <h3>公開中的供貨版本</h3><ReadStatus c={c} name="offers" label="供貨版本"/><ReadStatus c={c} name="products" label="目前商品版本"/>{o.data&&<>{!o.data.items.length&&<p>尚未公開供貨版本。請到商品詳情確認供貨條件。</p>}<ul className="sc-list">{o.data.items.filter(offer=>offer.state==='offered').map(offer=>{const product=products?.items.find(p=>p.product_id===offer.product_id);return <li className="sc-row" key={offer.offer_id}><a href={supplierConsoleHref(c.scope,'product',{id:offer.product_id})}>{offer.terms.title}</a><span className="badge">{product?.offer?.offer_id===offer.offer_id&&!product.offer.matches_current_terms?'需要重新公開':'公開中'}</span></li>;})}</ul>{o.data.truncated&&<Truncated c={c}/>}</>}
 {r.data&&<><h3>其他申請紀錄</h3>{list(other)}</>}
 </section>;
}
export function Review({c}:{c:ConsoleController}){
 const key='request:'+c.route.id,r=c.slot<SupplierRequestDetail>(key),s=r.data?.request,p=r.data?.product;
 const decide=(decision:'accepted'|'declined'|'revoked')=>s&&c.command({kind:'request.decide',label:decision==='accepted'?'同意售價申請':decision==='declined'?'不同意售價申請':'撤回同意',method:'post',path:c.root+`/supply-requests/${s.selection_id}/decision`,body:{decision,listing_sha256:s.listing_sha256},ifMatch:s.version,target:s.selection_id,productId:s.offer.product_id});
 return <section className="stack"><h2 tabIndex={-1}>審核售價申請</h2><div className="actions"><a className="btn btn-ghost" href={supplierConsoleHref(c.scope,'terms')}>返回供貨條件與審核</a></div><ReadStatus c={c} name={key} label="售價申請"/>
 {r.status===404&&<p>找不到這筆申請</p>}
 {s&&<><div className="sc-review-columns"><section className="card stack"><h3>賣家提案</h3><dl className="detail-list"><div><dt>店家</dt><dd>{partnerLabel({partner_id:s.partner_id,name:s.seller_name},[])}（店家 ID …{s.partner_id.slice(-6)}）</dd></div><div><dt>SKU</dt><dd>{s.sku}</dd></div><div><dt>售價</dt><dd>{formatMinor(s.retail_price_minor,s.offer.terms.currency)}</dd></div></dl></section>
 <section className="card stack"><h3>目前供貨版本</h3><dl className="detail-list"><div><dt>名稱</dt><dd>{s.offer.terms.title}</dd></div><div><dt>供貨單價</dt><dd>{formatMinor(s.offer.terms.cost_minor,s.offer.terms.currency)}</dd></div><div><dt>每件運費</dt><dd>{formatMinor(s.offer.terms.shipping_minor,s.offer.terms.currency)}</dd></div><div><dt>出貨條件</dt><dd>{s.offer.terms.shipping_terms}</dd></div><div><dt>退貨條件</dt><dd>{s.offer.terms.return_terms}</dd></div></dl></section></div>
 <p>每件價格差（售價 − 供貨單價 − 每件運費）：{priceGap(s)}</p><p>{PRICE_GAP_NOTE}</p><p className="banner">{REVIEW_NOTE}</p>
 {p&&(!p.offer||p.offer.offer_id!==s.offer.offer_id||!p.offer.matches_current_terms)&&<p className="banner">供貨條件已在公開後修改</p>}
 <p><span className="badge">{selectionState(s)}</span></p><div className="actions">
 {s.state==='awaiting_supply_acceptance'&&s.offer.state==='offered'&&<><button className="btn btn-ghost" disabled={c.locked||r.state!=='ready'} onClick={()=>decide('accepted')}>同意</button><ConfirmAction label="不同意" title="確認不同意這版售價申請" disabled={c.locked||r.state!=='ready'} onConfirm={()=>decide('declined')}><p>這間店需重新提出申請，才能再請你確認。</p></ConfirmAction></>}
 {s.state==='sellable'&&<ConfirmAction label="撤回同意" title="確認撤回同意" disabled={c.locked||r.state!=='ready'} onConfirm={()=>decide('revoked')}><p>撤回後，這版選品不能建立新預留。既有預留與歷史仍保留。</p></ConfirmAction>}
 </div>{c.sectionStatus[s.selection_id]&&<p role="status">{c.sectionStatus[s.selection_id]}</p>}
 </>}
 </section>;
}
