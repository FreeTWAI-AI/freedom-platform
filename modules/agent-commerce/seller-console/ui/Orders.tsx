import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {SellerCheckoutOrderPageSchema,SellerCheckoutOrderSchema,SellerOrderContactSchema,SellerRefundSchema,ManualRefundInputSchema,type SellerCheckoutOrder,type SellerCheckoutOrderSummary} from '../../../../contracts/guild-launchpad/v1/hosted-seller-checkout';
import {ReservationPageSchema} from '../../../../contracts/guild-launchpad/v1/hosted-shared-order';
import {formatIsoLocal} from '../../../../apps/portal-web/src/format';
import {displayNumberPattern,sellerConsoleHref,type SellerConsoleRoute,type SellerQuery} from '../route';
import type {Controller} from '../state/controller';
import {Axis,Confirm,Editor,ReadStatus,useRead} from './Shared';
import {amountToMinor,money,words} from './view';
export function OrderBadges({order:o}:{order:SellerCheckoutOrderSummary}){return <div className="seller-badges"><span className="badge">{words.payment[o.payment_state]}</span><span className="badge">{words.inventory[o.inventory_state]}</span><span className="badge">{words.lifecycle[o.lifecycle_state]}{o.cancel_reason&&'（'+words.cancel[o.cancel_reason]+'）'}</span>{o.open_exception_count>0&&<span className="badge">需處理 {o.open_exception_count}</span>}{o.environment==='sandbox'&&<span className="badge">測試</span>}</div>;}
function Filters({route}:{route:SellerConsoleRoute}){
 const [filters,setFilters]=useState<SellerQuery>(route.query),[submitted,setSubmitted]=useState(false),invalid=!!filters.display_number&&!displayNumberPattern.test(filters.display_number);
 return <form className="stack" aria-label="篩選訂單" noValidate onSubmit={e=>{e.preventDefault();setSubmitted(true);if(!invalid)window.location.hash=sellerConsoleHref(route,'orders',{query:filters});}}>
  {submitted&&invalid&&<p role="alert"><a href="#seller-display-number" onClick={e=>{e.preventDefault();document.getElementById('seller-display-number')?.focus();}}>請修正訂單編號再套用篩選。</a></p>}
  <div className="seller-filters"><label className="field">狀態<select value={filters.lifecycle??''} onChange={e=>setFilters(old=>({...old,lifecycle:(e.target.value||undefined) as SellerQuery['lifecycle']}))}><option value="">全部</option>{Object.entries(words.lifecycle).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
   <label className="choice"><input type="checkbox" checked={filters.needs_action==='true'} onChange={e=>setFilters(old=>({...old,needs_action:e.target.checked?'true':undefined}))}/>只看需處理</label>
   <label className="field" htmlFor="seller-display-number">訂單編號<input id="seller-display-number" value={filters.display_number??''} aria-invalid={invalid} aria-describedby={invalid?'seller-display-number-error':undefined} onChange={e=>setFilters(old=>({...old,display_number:e.target.value}))}/>{invalid&&<span className="field-hint" id="seller-display-number-error">格式為六位日期、連字號及六位大寫編號，例如 261016-ABCDEF。</span>}</label></div>
  <div className="actions"><button className="btn btn-ghost" type="submit">套用篩選</button><a className="btn btn-ghost" href={sellerConsoleHref(route,'orders')} onClick={()=>setFilters({})}>清除篩選</a></div>
 </form>;
}
function OrderListPage({c,route,cursor,open}:{c:Controller;route:SellerConsoleRoute;cursor:string;open:(id:string)=>void}){
 const q=new URLSearchParams(route.query);q.set('limit','20');if(cursor)q.set('cursor',cursor);
 const key='orders:'+q,r=useRead(c,key,'/checkout-orders?'+q,SellerCheckoutOrderPageSchema),d=r.data;
 return <><ReadStatus c={c} name={key} label="訂單清單" slot={r}/>{d&&<>
  {!d.items.length&&r.state==='ready'&&<p>沒有符合條件的結帳訂單。請清除篩選，或稍後更新清單。</p>}
  <ul className="seller-list">{d.items.map(o=><li className="seller-row stack" key={o.order_ref}><div className="seller-row-head"><a data-seller-order={o.order_ref} href={sellerConsoleHref(route,'order',{id:o.order_ref})} onClick={()=>open(o.order_ref)}>{o.display_number}</a><strong>{money(o.total_minor,o.currency)}</strong></div><p><time dateTime={o.created_at}>{formatIsoLocal(o.created_at)}</time> · {o.customer.contact_redacted?'聯絡資料已遮罩':o.customer.name_masked}</p><OrderBadges order={o}/></li>)}</ul>
 </>}{d?.next_cursor&&<LoadMore key={d.next_cursor} c={c} route={route} cursor={d.next_cursor} open={open}/>}</>;
}
function LoadMore(props:{c:Controller;route:SellerConsoleRoute;cursor:string;open:(id:string)=>void}){const [show,setShow]=useState(false);return show?<OrderListPage {...props}/>:<div className="actions"><button type="button" className="btn btn-ghost" onClick={()=>setShow(true)}>載入更多</button></div>;}
export function Orders({c,route,active}:{c:Controller;route:SellerConsoleRoute;active:boolean}){
 const position=useRef<{id:string;scroll:number}|null>(null),heading=useRef<HTMLHeadingElement>(null),was=useRef(active);
 const valid=!route.query.display_number||displayNumberPattern.test(route.query.display_number),probe=useRead(c,'reservations-probe','/reservations?limit=1',ReservationPageSchema);
 useEffect(()=>{if(active&&!was.current){const p=position.current;requestAnimationFrame(()=>{const link=p?Array.from(document.querySelectorAll<HTMLElement>('[data-seller-order]')).find(el=>el.dataset.sellerOrder===p.id):null;(link??heading.current)?.focus({preventScroll:true});if(p)window.scrollTo(0,p.scroll);});}was.current=active;},[active]);
 return <section className="stack" hidden={!active}><h2 ref={heading} tabIndex={-1}>結帳訂單</h2>{probe.data&&probe.data.items.length>0&&<div className="actions"><a className="btn btn-ghost" href={sellerConsoleHref(route,'reservations')}>舊版預留</a></div>}<Filters key={JSON.stringify(route.query)} route={route}/>{valid&&<OrderListPage key={JSON.stringify(route.query)} c={c} route={route} cursor="" open={id=>{position.current={id,scroll:window.scrollY};}}/>}</section>;
}
function RefundForm({c,order,application}:{c:Controller;order:SellerCheckoutOrder;application:NonNullable<SellerCheckoutOrder['payment_detail']>['applications'][number]}){
 return <div className="stack"><p>{words.application[application.outcome]} · 可登錄 {money(application.refundable_minor,application.currency)}</p><Editor c={c} name={'refund:'+application.application_ref} label="登錄退款" fields={[{name:'amount',label:'金額（'+application.currency+' 整數）',required:true,pattern:/^[0-9]+$/},{name:'refunded_on',label:'退款日期',type:'date',required:true},{name:'provider_reference',label:'綠界參考編號（選填）',pattern:/^[A-Za-z0-9_-]{1,64}$/}]} onSubmit={(v,clear)=>{
  const body=ManualRefundInputSchema.parse({application_ref:application.application_ref,amount_minor:amountToMinor(v.amount,application.currency),refunded_on:v.refunded_on,...(v.provider_reference?{provider_reference:v.provider_reference}:{})});if(body.amount_minor>application.refundable_minor)throw Error('金額超過目前可登錄餘額。');
  c.command({label:'登錄退款',path:c.root+'/checkout-orders/'+order.order_ref+'/refunds',body,schema:SellerRefundSchema,match:value=>(value as z.infer<typeof SellerRefundSchema>).application_ref===application.application_ref,settled:success=>{if(success)clear();}});
 }}/></div>;
}
function Contact({c,id}:{c:Controller;id:string}){
 const [requested,setRequested]=useState(false),r=useRead(c,'contact','/checkout-orders/'+id+'/contact',SellerOrderContactSchema,requested,value=>value.order_ref===id);
 useEffect(()=>()=>c.forget('contact'),[c.forget,id]);
 return <Axis title="聯絡資料"><div className="actions"><button type="button" className="btn btn-ghost" onClick={()=>setRequested(true)} disabled={requested}>顯示聯絡資料</button></div>{requested&&<><ReadStatus c={c} name="contact" label="聯絡資料" slot={r}/>{r.data&&(r.data.contact_redacted?<p>聯絡資料已依保存期限遮罩</p>:<dl className="detail-list">{Object.entries({聯絡資料:r.data.contact,收件資料:r.data.delivery,發票資料:r.data.invoice}).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value&&Object.entries(value).map(([k,v])=><p key={k}>{k}：{typeof v==='object'?JSON.stringify(v):String(v)}</p>)}</dd></div>)}</dl>)}</>}</Axis>;
}
export function Order({c,route,back}:{c:Controller;route:SellerConsoleRoute;back:SellerQuery}){
 const id=route.id!,path='/checkout-orders/'+id,key='order:'+id,r=useRead(c,key,path,SellerCheckoutOrderSchema,true,v=>v.order_ref===id),d=r.data;
 // PortalClient does not expose Retry-After. Hold after a refusal until reopening this detail page; report documents this contract gap.
 const [queryHeld,setQueryHeld]=useState(false);
 const query=()=>c.command({label:'查詢付款結果',path:c.root+path+'/payment-queries',body:{},schema:SellerCheckoutOrderSchema,match:v=>(v as SellerCheckoutOrder).order_ref===id,settled:success=>{if(!success)setQueryHeld(true);}});
 return <section className="stack"><h2 tabIndex={-1}>訂單詳情{d&&'：'+d.display_number}</h2><div className="actions"><a className="btn btn-ghost" href={sellerConsoleHref(route,'orders',{query:back})}>返回訂單</a></div><ReadStatus c={c} name={key} label="訂單詳情" slot={r}/>{d&&<>
  <OrderBadges order={d}/><p>下單時間：{formatIsoLocal(d.created_at)}</p>
  <Axis title="訂單" time={r.time}><p>{words.lifecycle[d.lifecycle_state]}{d.cancel_reason&&' · '+words.cancel[d.cancel_reason]}</p><p className="field-hint">訂單變更時間未提供；上方為本次資料讀取時間。</p>{d.actions.cancel&&<div className="actions"><Confirm label="取消訂單" disabled={c.locked||r.state!=='ready'} onConfirm={()=>c.command({label:'取消訂單',path:c.root+path+'/cancel',body:{},ifMatch:d.version,schema:SellerCheckoutOrderSchema,match:v=>(v as SellerCheckoutOrder).order_ref===id})}><p>取消這筆未付款訂單並釋放保留商品？</p></Confirm></div>}</Axis>
  <Axis title="付款" time={r.time}><p>{words.payment[d.payment_state]}</p>{d.latest_payment_attempt?<p>最近一次付款：{words.latest[d.latest_payment_attempt.state]} · {formatIsoLocal(d.latest_payment_attempt.created_at)}</p>:<p>尚無付款嘗試紀錄。</p>}{d.actions.query_payment&&<div className="actions"><button type="button" className="btn btn-ghost" disabled={c.locked||queryHeld||r.state!=='ready'} onClick={query}>立即查詢付款結果</button></div>}{queryHeld&&<p role="status">暫時無法確認，請稍後再查詢。請稍後重新開啟訂單確認可用操作。</p>}
   {d.actions.view_finance&&d.payment_detail&&<><h4>付款嘗試</h4><ul className="seller-list">{d.payment_detail.attempts.map(a=><li className="seller-row" key={a.attempt_ref}>{words.attempt[a.state]} · {money(a.amount_minor,a.currency)}<p>付款方式：{a.payment_type??'尚未提供'} · 交易編號：{a.merchant_trade_no}{a.trade_no&&'／'+a.trade_no}</p><p>付款日期：{formatIsoLocal(a.payment_date)} · 最近紀錄：{formatIsoLocal(a.confirmed_at??a.paid_at??a.failed_at??a.expired_at??a.superseded_at??a.handed_off_at??a.created_at)}</p></li>)}</ul><h4>付款套用</h4><ul>{d.payment_detail.applications.map(a=><li key={a.application_ref}>{words.application[a.outcome]} · {money(a.amount_minor,a.currency)} · 已登錄退款 {money(a.refunded_minor,a.currency)} · 可登錄退款 {money(a.refundable_minor,a.currency)} · {formatIsoLocal(a.created_at)}</li>)}</ul><h4>已登錄退款</h4><ul>{d.payment_detail.refunds.map(f=><li key={f.refund_ref}>{money(f.amount_minor,f.currency)} · {f.refunded_on}{f.provider_reference&&' · '+f.provider_reference}<p>商家自行退款（平台未經綠界確認） · 已登錄 · {formatIsoLocal(f.created_at)}</p></li>)}</ul>{!d.payment_detail.refunds.length&&<p>尚無退款紀錄。</p>}</>}
  </Axis>
  {d.actions.record_refund&&<Axis title="退款紀錄" time={r.time}><p>只登錄你已在綠界後台完成的退款。平台不執行退款，也不向綠界確認退款結果。</p>{d.payment_detail?d.payment_detail.applications.filter(a=>a.refundable_minor>0).map(a=><RefundForm key={a.application_ref} c={c} order={d} application={a}/>):<p>無法取得可登錄的付款明細，請確認財務讀取權限。</p>}</Axis>}
  <Axis title="庫存" time={r.time}><p>{words.inventory[d.inventory_state]}</p><p>商品保留截止：{formatIsoLocal(d.pay_by)}</p><p className="field-hint">庫存變更時間未提供；上方為本次資料讀取時間。</p></Axis>
  <Axis title="商品" time={r.time}><ul className="seller-list">{d.lines.map(l=><li className="seller-row stack" key={l.sku}><strong>{l.title} · {l.sku}</strong><p>{l.quantity} × {money(l.unit_price_minor,d.currency)} · 小計 {money(l.line_total_minor,d.currency)}</p><p>保留 {l.inventory.held} · 配貨 {l.inventory.allocated} · 出貨 {l.inventory.shipped} · 釋出 {l.inventory.released}</p></li>)}</ul></Axis>
  <Axis title="金額" time={r.time}><dl className="detail-list">{[['商品',d.merchandise_total_minor],['折扣',d.discount_total_minor],['運費',d.shipping_total_minor],['總額',d.total_minor]].map(([t,a])=><div key={t}><dt>{t}</dt><dd>{money(a,d.currency)}</dd></div>)}</dl></Axis>
  {d.actions.view_contact&&<Contact c={c} id={id}/>}
  <Axis title="付款例外" time={r.time}>{d.exceptions.length?<ul>{d.exceptions.map(e=><li key={e.case_ref}><a href={sellerConsoleHref(route,'case',{id:e.case_ref})}>{words.kind[e.kind]}</a> · {words.status[e.status]}<p>{words.next[e.next_action]}</p></li>)}</ul>:<p>目前沒有付款例外。</p>}</Axis>
 </>}</section>;
}
