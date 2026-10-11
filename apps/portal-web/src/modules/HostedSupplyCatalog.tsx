import {useEffect, useRef, useState, type FormEvent} from 'react';
import type {z} from 'zod';
import {SupplyCatalogViewSchema, SupplyCatalogSetupInputSchema, SupplyProductInputSchema, SupplyProductViewSchema, SupplyProductPageSchema, SupplyCatalogReceiptSchema, SupplyProductReceiptSchema} from '../../../../contracts/guild-launchpad/v1/hosted-supply-catalog';
import {SupplyTermsSchema} from '../../../../contracts/guild-launchpad/v1/hosted-supply-terms';
import {SupplyOfferSchema} from '../../../../contracts/guild-launchpad/v1/hosted-distribution';
import {ReservationSettingSchema} from '../../../../contracts/guild-launchpad/v1/hosted-shared-order';
import {ApiError, type PortalClient} from '../api';
import {formatMinor, parseMajorToMinor} from '../format';
import {useMyStores} from './MyStoreAction';
import {HostedSupplyTerms} from './HostedSupplyTerms';
import {HostedDistribution} from './HostedDistribution';

type Catalog = z.infer<typeof SupplyCatalogViewSchema>;
type Product = z.infer<typeof SupplyProductViewSchema>;
type Attempt = {method: 'post' | 'patch'; path: string; body: unknown; version?: string; schema: z.ZodType; key: string;
  success: (value: unknown) => void; notice: string; targetMissingIsStore?: boolean};
const LEAVE = '還有尚未儲存的內容，要離開嗎？';
const SHARING = '商品與供貨條件先儲存為私人草稿。公開供貨版本後，同社群且有選品權限的店主可查看商品介紹、供貨價、運費與退換貨條件，再提出售價供你確認。這不會發布買家可見的零售展示頁。';
function errorText(cause: unknown) {
  return cause instanceof ApiError && !cause.network ? cause.detail ?? cause.message : '暫時無法讀取供貨資料，請重新載入。';
}
export function SupplyCatalogList({client}: {client: PortalClient}) {
  const {data, error, retry, loadMore, loadingMore, pageError} = useMyStores(client, 'supply');
  return <div className="hosted-store stack">
    <h2>我的供貨商品庫</h2>
    <div className="actions"><a className="btn btn-ghost" href="#guilds/guild_product_quality_supply">前往商品品質與供應公會</a></div>
    {error ? <><p role="alert">暫時無法讀取你的供貨資料。</p><div className="actions"><button type="button" className="btn btn-ghost" onClick={retry}>重試</button></div></> : !data ? <p role="status">正在確認你的供貨資料…</p> : <>
      {data.items.length === 0 && !data.next_cursor && <p>你還沒有供貨商品庫。請從商品品質與供應公會開始供貨設定。</p>}
      {data.items.map(item => <article className="card stack" key={item.instance_id}>
        <h3>{item.name ?? '尚未完成設定的商品庫'}</h3><p>業務空間：{item.tenant_display_name}</p>
        <p>{item.setup_state === 'setup_required' ? '待設定供貨資料' : '供貨資料已就緒'}</p>
        <div className="actions"><a className="btn btn-primary" href={`#stores/${item.tenant_id}/${item.instance_id}/supply`}>查看商品與供貨</a></div>
      </article>)}
      {pageError && <p role="alert">暫時無法載入其餘商品庫，請重試。</p>}
      {data.next_cursor && <div className="actions"><button type="button" className="btn btn-ghost" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在載入…' : pageError ? '重試載入其餘商品庫' : '載入更多商品庫'}</button></div>}
    </>}
  </div>;
}
export function HostedSupplyCatalog({client, tenantId, instanceId, registerLeave}: {
  client: PortalClient; tenantId: string; instanceId: string; registerLeave: (guard: (() => boolean) | null) => void;
}) {
  const root = `/tenants/${tenantId}/storefronts/${instanceId}`;
  const [view, setView] = useState<Catalog | null>(null);
  const [reservationSetting, setReservationSetting] = useState<z.infer<typeof ReservationSettingSchema> | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true), [readFailed, setReadFailed] = useState(false);
  const [error, setError] = useState(''), [status, setStatus] = useState('');
  const [missing, setMissing] = useState(false), [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<Attempt | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [supplyEditing, setSupplyEditing] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const dirtyForms = useRef<Record<string, boolean>>({});
  const held = useRef<Attempt | null>(null), busyRef = useRef(false);
  const controller = useRef(new AbortController()), generation = useRef(0);
  const statusLine = useRef<HTMLParagraphElement>(null);
  function markDirty(key: string, value: boolean) {dirtyForms.current[key] = value;}
  function announce(text: string) {setStatus(text); requestAnimationFrame(() => statusLine.current?.focus());}
  function leaveOk() {
    if (busyRef.current || held.current) {
      announce(busyRef.current ? '正在確認原操作，請等候完成後再離開。' : '尚未確認原操作的結果，請按「重試」確認後再離開。'); return false;
    }
    return !Object.values(dirtyForms.current).some(Boolean) || window.confirm(LEAVE);
  }
  useEffect(() => {registerLeave(leaveOk); return () => registerLeave(null);}, [registerLeave]);
  useEffect(() => {
    controller.current = new AbortController();
    const unloading = (event: BeforeUnloadEvent) => {
      if (busyRef.current || held.current || Object.values(dirtyForms.current).some(Boolean)) {event.preventDefault(); event.returnValue = '';}
    };
    window.addEventListener('beforeunload', unloading); void load();
    return () => {controller.current.abort(); generation.current++; window.removeEventListener('beforeunload', unloading);};
  }, [client, root]);
  async function load() {
    const signal = controller.current.signal, ticket = ++generation.current;
    const current = () => !signal.aborted && ticket === generation.current;
    setLoading(true); setReadFailed(false);
    try {
      const next = SupplyCatalogViewSchema.parse(await client.get(root + '/supply-profile', {signal}));
      // Metadata readers must never request the cost-bearing product or offer projections.
      const items = next.setup_state === 'ready' && next.capabilities.includes('store:write')
        ? SupplyProductPageSchema.parse(await client.get(root + '/supply-products', {signal})).items : [];
      let setting: z.infer<typeof ReservationSettingSchema> | null = null;
      if (next.setup_state === 'ready' && next.capabilities.includes('store:manage')) {
        // A successful current-owner read is required; manage capability alone is insufficient.
        try {setting = ReservationSettingSchema.parse(await client.get(root + '/reservation-setting', {signal}));}
        catch (cause) {if (!(cause instanceof ApiError && [403, 404].includes(cause.status))) throw cause;}
      }
      if (!current()) return;
      setView(next); setProducts(items); setReservationSetting(setting); setError(''); setRefresh(value => value + 1);
    } catch (cause) {
      if (!current()) return;
      setReadFailed(true);
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setError(errorText(cause));
    } finally {if (current()) setLoading(false);}
  }
  async function send(attempt: Attempt) {
    if (busyRef.current || held.current && held.current !== attempt) return;
    held.current = attempt; busyRef.current = true; setBusy(true); setRetry(null); setError('');
    const signal = controller.current.signal;
    try {
      const raw = await client[attempt.method](attempt.path, attempt.body, {idempotencyKey: attempt.key, ifMatch: attempt.version, signal});
      const parsed = attempt.schema.safeParse(raw);
      if (!parsed.success) throw new ApiError({message: '回應未完整收到，請重試確認原操作。', network: true});
      if (signal.aborted) return;
      held.current = null; attempt.success(parsed.data);
      await load(); if (!signal.aborted) announce(attempt.notice);
    } catch (cause) {
      if (signal.aborted) return;
      // Preserve the exact key, payload and version across unknown responses, including 5xx.
      if (!(cause instanceof ApiError) || cause.network || cause.status >= 500) {
        setRetry(attempt); setError('尚未確認原操作的結果，請按「重試」確認。'); return;
      }
      held.current = null;
      if (cause.status === 404 && attempt.targetMissingIsStore !== false) setMissing(true);
      else if (cause.status === 412) {
        setEditing(null); setSupplyEditing(null); markDirty('edit', false); markDirty('supply', false);
        await load(); announce('資料剛剛被更新，已重新載入，請確認後再編輯。');
      } else if (cause.code === 'storefront_already_set_up') {await load(); announce('商品庫已經設定過，已重新載入。');}
      else setError(errorText(cause));
    } finally {if (!signal.aborted) {busyRef.current = false; setBusy(false);}}
  }
  const command = (attempt: Omit<Attempt, 'key'>) => send({...attempt, key: crypto.randomUUID()});
  const locked = busy || retry !== null || loading || readFailed;
  const can = (key: string) => view?.writable === true && view.capabilities.includes(key);
  const catalog = view?.catalog;
  return <div className="hosted-store hosted-supply-catalog stack">
    <div className="actions"><a className="btn btn-ghost" href="#stores/supply">返回我的供貨商品庫</a></div>
    <p ref={statusLine} tabIndex={-1} role="status" aria-live="polite">{loading && !view ? '正在載入供貨資料…' : status}</p>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    <div className="actions">{retry ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send(retry)}>重試</button>
      : error && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {if (leaveOk()) void load();}}>重新載入</button>}</div>
    {missing ? <p>找不到這個供貨商品庫。</p> : view && <>
      <h2>{catalog?.name ?? '設定供貨資料'}</h2>
      <p className="field-hint">{SHARING}</p>
      {!view.writable && <p>{view.capabilities.includes('store:write') ? '這個商品庫目前暫停，無法修改。' : '你可以檢視商品庫資料，但沒有供貨編輯權限；供貨價與條件不會顯示。'}</p>}
      {!catalog ? can('store:manage') ? <SupplySetupForm busy={locked} onDirty={value => markDirty('setup', value)} onSave={(body, success) => command({method: 'post', path: root + '/supply-profile', body, schema: SupplyCatalogReceiptSchema, success, notice: '已建立供貨商品庫。'})}/>
        : <p>商品庫還沒完成設定，請業務空間擁有者或管理員設定。</p> : <>
        <p>{catalog.description}</p><p>幣別：{catalog.currency}</p><p>共用商品容量：{view.product_count}／{view.product_limit}（含供貨商品與商店選品）</p>
        <section className="stack" aria-labelledby="supply-reservation-title"><h3 id="supply-reservation-title">供貨庫存預留</h3>
          {reservationSetting ? <>
            <p>{!reservationSetting.admission_enabled ? '平台目前暫停接受新預留。' : reservationSetting.reservation_enabled ? '已開放 30 分鐘供貨預留。' : '尚未開放供貨預留。'}付款與出貨尚未啟用。</p>
            <p className="field-hint">開放後，已取得你同意的合作店家仍需發布選品並開放預留，買家才能預留這筆共用庫存。停止只影響新預留；既有預留仍可查看，由買家或店主取消，或到期後釋放庫存。</p>
            <div className="actions"><button type="button" className="btn btn-ghost"
              disabled={locked || !reservationSetting.reservation_enabled && (!view.writable || !reservationSetting.admission_enabled)}
              onClick={() => {
                if (Object.values(dirtyForms.current).some(Boolean)) {announce('還有尚未儲存的內容，請先儲存或取消編輯，再變更預留設定。'); return;}
                void command({targetMissingIsStore: false, method: 'patch', path: root + '/reservation-setting', body: {reservation_enabled: !reservationSetting.reservation_enabled},
                  version: reservationSetting.version, schema: ReservationSettingSchema, success: () => {},
                  notice: reservationSetting.reservation_enabled ? '已停止接受新供貨預留。既有預留仍可查看。' : '已開放 30 分鐘供貨預留。'});
              }}>{reservationSetting.reservation_enabled ? '停止接受新供貨預留' : '開放 30 分鐘供貨預留'}</button>
              <a className="btn btn-ghost" href={`#stores/${tenantId}/${instanceId}/supply-orders`}>查看供貨訂單</a></div>
          </> : <p className="field-hint">只有目前業務空間擁有者可設定供貨預留及查看供貨訂單；目前沒有可用的預留管理權限。</p>}
        </section>
        {view.capabilities.includes('store:write') && <>
          <section className="stack" aria-labelledby="supply-products-title"><h3 id="supply-products-title">供貨商品</h3>
            {!products.length && !loading && <p>還沒有商品。新增商品後可設定供貨條件。</p>}
            <div className="hosted-store-products">{products.map(product => <article className="hosted-store-product stack" key={product.product_id}>
              {supplyEditing === product.product_id ? <HostedSupplyTerms key={product.version} supplierOnly client={client} path={root + '/products/' + product.product_id + '/supply-terms'} title={product.title} busy={locked || !can('store:write')} onDirty={value => markDirty('supply', value)}
                onCancel={() => {if (leaveOk()) {setSupplyEditing(null); markDirty('supply', false);}}}
                onSave={(body, version, success) => command({targetMissingIsStore: false, method: 'patch', path: root + '/products/' + product.product_id + '/supply-terms', body, version, schema: SupplyTermsSchema, notice: '已儲存供貨條件。', success: () => {success(); setSupplyEditing(null); markDirty('supply', false);}})}
                onPublish={can('store:publish') && can('store:write') ? version => command({targetMissingIsStore: false, method: 'post', path: root + '/products/' + product.product_id + '/supply-offer', body: {}, version, schema: SupplyOfferSchema, notice: '已公開供貨版本，同社群店主可申請選用。', success: () => {setSupplyEditing(null); markDirty('supply', false);}}) : undefined}/>
                : editing === product.product_id ? <SupplyProductForm key={product.version} product={product} currency={catalog.currency} busy={locked || !can('store:write')} onDirty={value => markDirty('edit', value)} onCancel={() => {if (leaveOk()) {setEditing(null); markDirty('edit', false);}}} onSave={(body, success) => command({targetMissingIsStore: false, method: 'patch', path: root + '/supply-products/' + product.product_id, body, version: product.version, schema: SupplyProductReceiptSchema, notice: '已儲存供貨商品。', success: () => {success(); setEditing(null); markDirty('edit', false);}})}/>
                : <><h4>{product.title}</h4><p>供貨單價 {formatMinor(product.cost_minor, product.currency)}</p><p>庫存 {product.stock}</p><p className="hosted-store-description">{product.description}</p>
                  {can('store:write') && <div className="actions"><button type="button" className="btn btn-ghost" disabled={locked} onClick={() => {if (leaveOk()) {setSupplyEditing(null); setEditing(product.product_id);}}}>編輯供貨商品</button>
                    <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => {if (leaveOk()) {setEditing(null); setSupplyEditing(product.product_id);}}}>供貨條件</button></div>}</>}
            </article>)}</div>
            {can('store:write') && (view.product_count >= view.product_limit ? <p>已達 {view.product_limit} 件共用商品容量上限（含供貨商品與商店選品）。</p> : <SupplyProductForm currency={catalog.currency} busy={locked} onDirty={value => markDirty('add', value)} onSave={(body, success) => command({method: 'post', path: root + '/supply-products', body, schema: SupplyProductReceiptSchema, notice: '已新增供貨商品。', success})}/>)}
          </section>
          <HostedDistribution supplierOnly client={client} root={root} refresh={refresh} busy={locked} writable={can('store:write')} onDirty={(id, value) => markDirty('distribution/' + id, value)} onCommand={command} onReload={() => leaveOk() ? load() : Promise.resolve()}/>
        </>}
      </>}
    </>}
  </div>;
}
function SupplySetupForm({busy, onDirty, onSave}: {busy: boolean; onDirty: (value: boolean) => void; onSave: (body: z.infer<typeof SupplyCatalogSetupInputSchema>, success: () => void) => Promise<void>}) {
  const [name, setName] = useState(''), [currency, setCurrency] = useState<'TWD' | 'USD'>('TWD'), [description, setDescription] = useState(''), [error, setError] = useState('');
  const dirtyRef = useRef(onDirty); dirtyRef.current = onDirty;
  useEffect(() => {dirtyRef.current(Boolean(name || description || currency !== 'TWD'));}, [name, description, currency]);
  useEffect(() => () => dirtyRef.current(false), []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    const parsed = SupplyCatalogSetupInputSchema.safeParse({name, currency, description});
    if (!parsed.success) {setError('請填寫商品庫名稱並確認欄位格式。'); return;}
    await onSave(parsed.data, () => dirtyRef.current(false));
  }
  return <form className="hosted-store-form stack" aria-label="建立供貨商品庫" onSubmit={event => void submit(event)}>
    <fieldset className="hosted-store-fields stack" disabled={busy}><legend className="sr-only">供貨資料</legend>
      <label className="field">商品庫名稱<input required maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label>
      <label className="field">供貨幣別<select value={currency} onChange={event => setCurrency(event.target.value as 'TWD' | 'USD')}><option value="TWD">新臺幣 TWD</option><option value="USD">美元 USD</option></select></label>
      <label className="field">商品庫說明<textarea maxLength={2000} value={description} onChange={event => setDescription(event.target.value)}/></label>
      {error && <p role="alert">{error}</p>}<div className="actions"><button className="btn btn-primary" disabled={busy}>建立供貨商品庫</button></div>
    </fieldset>
  </form>;
}
function SupplyProductForm({product, currency, busy, onDirty, onCancel, onSave}: {product?: Product; currency: 'TWD' | 'USD'; busy: boolean; onDirty: (value: boolean) => void; onCancel?: () => void; onSave: (body: z.infer<typeof SupplyProductInputSchema>, success: () => void) => Promise<void>}) {
  const initial = {title: product?.title ?? '', description: product?.description ?? '', cost: product ? (product.cost_minor / 100).toFixed(2) : '', stock: String(product?.stock ?? 0)};
  const [fields, setFields] = useState(initial), [error, setError] = useState('');
  const dirtyRef = useRef(onDirty); dirtyRef.current = onDirty;
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  useEffect(() => {dirtyRef.current(dirty);}, [dirty]);
  useEffect(() => () => dirtyRef.current(false), []);
  const change = (key: keyof typeof fields, value: string) => setFields(old => ({...old, [key]: value}));
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const parsed = SupplyProductInputSchema.safeParse({title: fields.title, description: fields.description, cost_minor: parseMajorToMinor(fields.cost), stock: /^\d+$/.test(fields.stock) ? Number(fields.stock) : -1});
      if (!parsed.success) {setError('請填寫有效的商品名稱、供貨單價與庫存。'); return;}
      await onSave(parsed.data, () => {if (!product) setFields(initial); dirtyRef.current(false);});
    } catch {setError('請填寫有效的供貨單價與庫存。');}
  }
  const title = product ? '編輯供貨商品' : '新增供貨商品';
  return <form className="hosted-store-form stack" aria-label={title} onSubmit={event => void submit(event)}>
    <h4>{title}</h4><fieldset className="hosted-store-fields stack" disabled={busy}><legend className="sr-only">供貨商品資料</legend>
      <label className="field">商品名稱<input required maxLength={120} value={fields.title} onChange={event => change('title', event.target.value)}/></label>
      <label className="field">商品說明<textarea maxLength={2000} value={fields.description} onChange={event => change('description', event.target.value)}/></label>
      <label className="field">供貨單價（{currency}）<input required inputMode="decimal" value={fields.cost} onChange={event => change('cost', event.target.value)}/></label>
      <label className="field">庫存<input required inputMode="numeric" value={fields.stock} onChange={event => change('stock', event.target.value)}/></label>
      {error && <p role="alert">{error}</p>}<div className="actions"><button className="btn btn-ghost" disabled={busy}>{product ? '儲存供貨商品' : title}</button>{onCancel && <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>取消編輯</button>}</div>
    </fieldset>
  </form>;
}
