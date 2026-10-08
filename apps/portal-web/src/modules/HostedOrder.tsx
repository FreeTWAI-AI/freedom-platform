import {useEffect, useRef, useState, type FormEvent} from 'react';
import {PublicStoreProjectionSchema, type PublicStoreProjection} from '../../../../contracts/guild-launchpad/v1/storefront';
import {QuoteInputSchema, ReadinessSchema, type HostedOrder, type HostedOrderQuote} from '../../../../contracts/guild-launchpad/v1/hosted-order';
import {ApiError, type PortalClient} from '../api';
import {formatIsoLocal, formatMinor} from '../format';
import {buyerRoute, readOrder, readQuote, readCancelObservation, type BuyerAttempt, type BuyerRoute} from './hosted-order-state';
import './HostedStore.css';

const TERMS = '僅預留 30 分鐘，尚未付款，不會安排出貨。運費未設定，稅額未評估。';
const unreadable = () => new ApiError({message: '回應未完整收到，尚未確認原操作結果。', network: true});
const errorText = (error: unknown) => error instanceof ApiError ? error.message : '暫時無法確認回應，請重試。';
type Props = {client: PortalClient; locationHash: string; registerLeave: (guard: (() => boolean) | null) => void; replaceLocation: (hash: string) => void};
/** Mounted with the member/session key by Workspace; no private browser persistence. */
export function HostedOrderPage({client, locationHash, registerLeave, replaceLocation}: Props) {
  const route = buyerRoute(locationHash);
  const [store, setStore] = useState<PublicStoreProjection | null>(null);
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false);
  const [quantity, setQuantity] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<HostedOrderQuote | null>(null), [order, setOrder] = useState<HostedOrder | null>(null);
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reference, setReference] = useState('');
  const held = useRef<BuyerAttempt | null>(null), busyRef = useRef(false), dirty = useRef(false);
  const controller = useRef(new AbortController()), reads = useRef(0);
  const currentRoute = useRef(route); currentRoute.current = route;
  const authGeneration = useRef(client.sessionGeneration);
  const live = () => !controller.current.signal.aborted && client.sessionGeneration === authGeneration.current;
  const status = useRef<HTMLParagraphElement>(null);
  function announce(message: string) {setNotice(message); requestAnimationFrame(() => status.current?.focus());}
  function canLeave() {
    if (held.current || busyRef.current) {announce('請先確認原操作結果，再離開這頁。'); return false;}
    return !dirty.current || window.confirm('預留內容尚未送出，要離開嗎？');
  }
  useEffect(() => {registerLeave(canLeave); return () => registerLeave(null);}, [registerLeave]);
  useEffect(() => {
    controller.current = new AbortController(); authGeneration.current = client.sessionGeneration;
    const unload = (e: BeforeUnloadEvent) => {if (held.current || busyRef.current || dirty.current) {e.preventDefault(); e.returnValue = '';}};
    window.addEventListener('beforeunload', unload);
    return () => {controller.current.abort(); reads.current++; window.removeEventListener('beforeunload', unload);};
  }, [client]);
  useEffect(() => {
    // Establishing the recovery URL before submit must not clear its held tuple.
    const attempt = held.current;
    if (attempt?.kind === 'submit' && route?.kind === 'intent' && route.intent === attempt.body.client_order_id && route.slug === attempt.slug) return;
    setStore(null); setReady(false); setOrder(null); setQuote(null); setQuantity({}); setError(''); setNotice(''); dirty.current = false;
    void load(route);
    return () => {reads.current++;};
  }, [locationHash]);
  async function load(target: BuyerRoute | null) {
    const ticket = ++reads.current; const current = () => live() && ticket === reads.current;
    setLoading(true); setError('');
    try {
      if (target?.kind === 'shop') {
        // Never preserve a previous true readiness through an unsuccessful refresh.
        setReady(false);
        const display = PublicStoreProjectionSchema.parse(await client.get(`/public/stores/${target.slug}`, {signal: controller.current.signal}));
        if (display.slug !== target.slug) throw unreadable();
        if (current()) setStore(display);
        const readiness = ReadinessSchema.parse(await client.get(`/hosted-stores/${target.slug}/order-readiness`, {signal: controller.current.signal}));
        if (current()) {setReady(readiness.reservation_enabled); if (!readiness.reservation_enabled) setNotice('這間商店目前未開放新的預留；商品僅供展示。');}
      } else if (target?.kind === 'order' || target?.kind === 'intent') {
        const path = target.kind === 'order' ? `/me/hosted-orders/${target.id}` : `/me/hosted-orders/by-intent/${target.intent}?store_slug=${target.slug}`;
        const raw = await client.get(path, {signal: controller.current.signal});
        const attempt = held.current;
        const found = readOrder(raw, target, attempt?.kind === 'submit' ? attempt.body : undefined);
        if (!found) throw unreadable();
        const cancellation = attempt?.kind === 'cancel' ? readCancelObservation(raw, attempt) : null;
        if (attempt?.kind === 'cancel' && !cancellation) throw unreadable();
        if (current()) {
          setOrder(found);
          // An own read confirms submit, but cannot prove an in-flight cancel did not commit later.
          if (attempt?.kind === 'submit' || cancellation?.confirmed === true) clearAttempt();
          dirty.current = false;
        }
      }
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ApiError && cause.status === 404) {
        setError(target?.kind === 'order' || target?.kind === 'intent' ? '目前查不到屬於你的這筆預留。請確認登入帳號與原連結；這不會自動建立新預留。' : '目前無法查看這間商店或建立新的預留。');
      } else setError(errorText(cause));
    } finally {if (current()) setLoading(false);}
  }
  function clearAttempt() {held.current = null; setUnknown(false);}
  function adoptOrder(value: HostedOrder) {
    clearAttempt(); setOrder(value); setQuote(null); dirty.current = false;
    replaceLocation(`#reservations/order/${value.order_id}`);
    announce(value.state === 'reserved' ? '預留已確認。請保留這筆預留連結。' : '已確認目前預留狀態。');
  }
  async function send(attempt: BuyerAttempt) {
    if (busyRef.current || !live()) return;
    held.current = attempt; busyRef.current = true; setBusy(true); setError('');
    try {
      const path = attempt.kind === 'cancel' ? `/me/hosted-orders/${attempt.id}/cancel` : `/hosted-stores/${attempt.slug}/${attempt.kind === 'quote' ? 'quotes' : 'orders'}`;
      const raw = await client.post(path, attempt.body, {idempotencyKey: attempt.key, ifMatch: attempt.kind === 'cancel' ? attempt.version : undefined, signal: controller.current.signal});
      if (!live()) return;
      if (attempt.kind === 'quote') {
        const value = readQuote(raw, attempt.slug, attempt.body); if (!value) throw unreadable();
        clearAttempt(); setQuote(value); dirty.current = true; announce('請確認商品、數量與金額；目前尚未預留庫存。');
      } else {
        const value = readOrder(raw, attempt.kind === 'submit' ? {kind: 'intent', slug: attempt.slug, intent: attempt.body.client_order_id} : {kind: 'order', id: attempt.id}, attempt.kind === 'submit' ? attempt.body : undefined);
        if (!value || attempt.kind === 'cancel' && (readCancelObservation(raw, attempt)?.confirmed !== true)) throw unreadable();
        adoptOrder(value);
      }
    } catch (cause) {
      if (!live()) return;
      if (attempt.unknown || !(cause instanceof ApiError) || cause.network || cause.status >= 500) {
        attempt.unknown = true; setUnknown(true); setError('尚未確認原操作結果。請查詢原預留或以相同內容重試，勿重新建立。');
      } else {
        clearAttempt(); setError(errorText(cause));
        if (attempt.kind === 'submit') {setQuote(null); dirty.current = false; announce('這次預留未被接受。請返回商店，重新查看預留內容。');}
        if (attempt.kind === 'cancel' && cause.status === 412) {
          await load({kind: 'order', id: attempt.id});
          if (live()) announce('預留版本已更新，已重新查詢。請核對目前狀態，再決定是否取消。');
        }
      }
    } finally {if (live()) {busyRef.current = false; setBusy(false);}}
  }
  function requestQuote(e: FormEvent) {
    e.preventDefault(); if (!ready || !store || held.current || busyRef.current) return;
    const body = QuoteInputSchema.safeParse({publication_revision: store.revision, items: store.products.filter(p => Number(quantity[p.sku] ?? 0) > 0).map(p => ({sku: p.sku, quantity: Number(quantity[p.sku])}))});
    if (!body.success) {setError('請選擇 1 至 50 件不同商品，每件數量 1 至 99。'); return;}
    void send({kind: 'quote', slug: store.slug, body: body.data, key: crypto.randomUUID(), unknown: false});
  }
  function submit() {
    if (!quote || !ready || busyRef.current || held.current) return;
    if (Date.parse(quote.expires_at) <= Date.now()) {setError('這份內容已到期，請重新查看預留內容。'); return;}
    const attempt: BuyerAttempt = {kind: 'submit', slug: quote.store.slug, key: crypto.randomUUID(), body: {quote_id: quote.quote_id, terms_sha256: quote.terms_sha256, client_order_id: crypto.randomUUID()}, unknown: false};
    held.current = attempt;
    replaceLocation(`#reservations/${attempt.slug}/intent/${attempt.body.client_order_id}`);
    void send(attempt);
  }
  function lookup(e: FormEvent) {
    e.preventDefault();
    const target = buyerRoute(`#reservations/order/${reference.trim()}`);
    if (target?.kind !== 'order') {setError('請填入完整的預留編號。'); return;}
    if (canLeave()) replaceLocation(`#reservations/order/${target.id}`);
  }
  const locked = busy || unknown;
  const lookupTarget = held.current?.kind === 'submit' ? {kind: 'intent' as const, slug: held.current.slug, intent: held.current.body.client_order_id} : currentRoute.current;
  return <div className="hosted-store stack">
    <p role="note" className="banner">{TERMS}</p>
    <p ref={status} tabIndex={-1} role="status">{loading ? '正在確認目前狀態…' : notice}</p>
    {error && <p role="alert" className="banner banner-error">{error}</p>}
    {unknown && <div className="actions"><button className="btn btn-ghost" disabled={busy || loading} onClick={() => held.current && void send(held.current)}>重試原操作</button>
      {held.current?.kind !== 'quote' && <button className="btn btn-ghost" disabled={busy || loading} onClick={() => void load(lookupTarget)}>查詢原預留</button>}</div>}
    {!route ? <p>預留連結格式不正確。</p> : route.kind === 'lookup' ? <form className="stack" onSubmit={lookup}>
      <p>輸入你保存的預留編號，或開啟原預留連結。這裡目前不提供完整歷史清單。</p>
      <label className="field"><span>預留編號</span><input value={reference} maxLength={36} onChange={e => setReference(e.target.value)} required/></label>
      <div className="actions"><button className="btn btn-primary">查詢我的預留</button></div>
    </form> : <>
      {route.kind === 'shop' && store && !quote && !order && <form className="stack" onSubmit={requestQuote}>
        <h2>{store.name}</h2><p>{store.description}</p>
        {!ready && !loading && <p>新的預留目前不可用，商品僅供展示。</p>}
        {store.products.map(p => <div className="hosted-store-product stack" key={p.sku}><h3>{p.title}</h3><p>{formatMinor(p.price_minor, store.currency)}</p><p>{p.description}</p>
          {ready && <label className="field"><span>{p.title}數量</span><input type="number" min={0} max={99} step={1} value={quantity[p.sku] ?? '0'} disabled={locked} onChange={e => {dirty.current = true; setQuantity(v => ({...v, [p.sku]: e.target.value}));}}/></label>}</div>)}
        {ready && <div className="actions"><button className="btn btn-primary" disabled={locked || loading}>查看預留內容</button></div>}
      </form>}
      {quote && !order && <section className="stack" aria-label="確認預留內容"><h2>{quote.store.name}</h2><Lines value={quote}/><p>內容有效至 {formatIsoLocal(quote.expires_at)}。查看內容不會預留庫存。</p>
        <div className="actions"><button className="btn btn-primary" disabled={locked || !ready} onClick={submit}>確認預留 30 分鐘</button><button className="btn btn-ghost" disabled={locked} onClick={() => setQuote(null)}>修改數量／重新查看</button></div></section>}
      {order && <section className="stack" aria-label="我的預留"><h2>{order.store.name}</h2><p>狀態：{order.state === 'reserved' ? '預留中' : order.state === 'cancelled' ? '已取消' : '已到期'}</p><p>預留截止：{formatIsoLocal(order.reservation_expires_at)}</p><Lines value={order}/>
        <label className="field"><span>預留編號</span><input readOnly value={order.order_id}/></label>
        <label className="field"><span>我的預留連結（需要本人登入）</span><input readOnly value={`${window.location.origin}/#reservations/order/${order.order_id}`} onFocus={e => e.target.select()}/></label>
        <div className="actions"><button className="btn btn-ghost" disabled={locked || loading} onClick={() => void load({kind: 'order', id: order.order_id})}>更新預留狀態</button>
          {order.state === 'reserved' && <button className="btn btn-ghost" disabled={locked || loading} onClick={() => {if (!busyRef.current && !held.current && window.confirm('取消這筆預留並釋放商品？')) void send({kind: 'cancel', id: order.order_id, slug: order.store.slug, intent: order.client_order_id, body: {}, key: crypto.randomUUID(), version: order.version, unknown: false});}}>取消預留</button>}</div>
      </section>}
      {!unknown && error && <div className="actions"><button className="btn btn-ghost" disabled={busy || loading} onClick={() => void load(route)}>重新查詢</button></div>}
      {route.kind === 'intent' && !order && !locked && !loading && <a href={`#reservations/${route.slug}`} className="btn btn-ghost">返回商店查看預留內容</a>}
    </>}
    <div className="actions"><a href="#reservations" className="btn btn-ghost">查詢其他預留</a>{route && 'slug' in route && <a href={`/shops/${route.slug}`} onClick={e => {if (!canLeave()) e.preventDefault();}}>查看公開商品頁</a>}</div>
  </div>;
}
function Lines({value}: {value: HostedOrderQuote | HostedOrder}) {
  return <><ul className="stack">{value.items.map(i => <li key={i.sku}>{i.title} × {i.quantity} · 單價 {formatMinor(i.unit_price_minor, value.currency)} · 小計 {formatMinor(i.line_total_minor, value.currency)}</li>)}</ul>
    <p><strong>商品金額：{formatMinor(value.merchandise_total_minor, value.currency)}</strong>（非應付金額）</p></>;
}
