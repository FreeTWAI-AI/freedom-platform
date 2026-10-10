import {ProductMediaPageSchema,type ProductMediaView} from '../../../../contracts/guild-launchpad/v1/hosted-store-media';
import {HostedStorePhoto} from './HostedStorePhoto';
import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {z} from 'zod';
import {OpaqueId} from '../../../../contracts/common/v1/identity';
import {
  StoreViewSchema, StoreSetupInputSchema, StoreUpdateInputSchema, SlugAvailabilitySchema,
  ProductInputSchema, ProductViewSchema, ProductPageSchema, ProductRemovedSchema, StorePreviewSchema,
  type ProductView, type StoreView,
} from '../../../../contracts/guild-launchpad/v1/storefront';
import {StoreAppearanceSchema, type StoreAppearance, type StoreTemplate} from '../../../../contracts/guild-launchpad/v1/storefront-presentation';
import {SupplyTermsSchema} from '../../../../contracts/guild-launchpad/v1/hosted-supply-terms';
import {HostedSupplyTerms} from './HostedSupplyTerms';
import {ApiError, type PortalClient} from '../api';
import {formatIsoLocal, formatMinor, parseMajorToMinor} from '../format';
import {useMyStores, stateWord} from './MyStoreAction';
import {HostedSellerOrders, SellerOrdersLink} from './HostedSellerOrders';
import {sellerOrdersRoute} from './hosted-seller-order-state';
import './HostedStore.css';

const NOTICE = '店鋪／商品展示已就緒，交易尚未啟用';
const LEAVE = '還有尚未儲存的內容，要離開嗎？';
const NEXT: Record<string, string> = {
  storefront_slug_taken: '請換一個商店網址。',
  storefront_slug_reserved: '請換一個商店網址。',
  storefront_slug_locked: '網址已固定，請保留目前的商店網址。',
  storefront_already_set_up: '請重新載入商店，繼續編輯資料。',
  storefront_not_set_up: '請先完成商店設定。',
  storefront_has_no_products: '請先新增至少一件商品。',
  storefront_product_limit: '請編輯或移除現有商品後再新增。',
  storefront_product_in_use: '請保留這件商品，並聯絡業務空間擁有者。',
  storefront_unavailable: '請聯絡業務空間擁有者恢復使用。',
  storefront_exists: '這個業務空間已經有商店，請沿用它。',
  capability_denied: '請聯絡業務空間擁有者確認你的權限。',
};
function errorText(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'validation_failed') return '有欄位格式不符，請檢查後再送出。';
    return `${error.detail ?? error.message} ${NEXT[error.code ?? ''] ?? '請重新載入後再試一次。'}`;
  }
  return '暫時無法確認回應。請重新載入後再試一次。';
}
type Preview = z.infer<typeof StorePreviewSchema>;
type RegisterLeave = (guard: (() => boolean) | null) => void;
export function HostedStore({client, enabled, locationHash, userId, registerLeave, photosEnabled=false, photoUploadsEnabled=false}: {client: PortalClient; photosEnabled?:boolean;photoUploadsEnabled?:boolean;enabled: boolean; locationHash: string; userId: string; registerLeave: RegisterLeave}) {
  const retained = sellerOrdersRoute(locationHash) ?? (!enabled ? sellerOrdersRoute(locationHash + '/orders') : null);
  if (retained) return <HostedSellerOrders key={`${userId}:${client.sessionGeneration}:${retained.tenantId}:${retained.instanceId}`} client={client} route={retained} registerLeave={registerLeave}/>;
  if (!enabled) return <p className="banner" role="status">目前不開放商店設定。若要查看或取消既有預留，請開啟你保存的店主管理連結；登入後會重新確認目前權限。</p>;
  const path = locationHash.replace(/^#/, '').split('/');
  if (path.length === 1 && path[0] === 'stores') return <StoreList key={userId} client={client}/>;
  const valid = path.length === 3 && path[0] === 'stores' && OpaqueId.safeParse(path[1]).success && OpaqueId.safeParse(path[2]).success;
  return valid ? <StorePage key={`${userId}:${path[1]}:${path[2]}`} client={client} userId={userId} tenantId={path[1]} instanceId={path[2]} registerLeave={registerLeave} photosEnabled={photosEnabled} photoUploadsEnabled={photoUploadsEnabled}/> : <MissingStore/>;
}
function BackLink() { return <div className="actions"><a href="#stores" className="btn btn-ghost">返回我的商店</a></div>; }
function MissingStore() { return <div className="hosted-store stack"><BackLink/><p>找不到這間商店。</p></div>; }
function StoreList({client}: {client: PortalClient}) {
  const {data, error, retry} = useMyStores(client);
  return <div className="hosted-store stack">
    {error ? <><p role="alert">暫時無法讀取你的商店。</p><div className="actions"><button type="button" className="btn btn-ghost" onClick={retry}>重試</button></div></> : !data ? <p role="status">正在確認你的商店…</p> : <>
      {data.items.length === 0 && <><p>你還沒有商店。</p><div className="actions"><a className="btn btn-ghost" href="#guilds/guild_commerce_sales">前往電商與銷售公會建立</a></div></>}
      {data.items.map(item => <article className="card stack" key={item.instance_id}>
        <h2>{item.name ?? '尚未完成設定的商店'}</h2><p>業務空間：{item.tenant_display_name}</p><p>{stateWord(item)}</p>
        <div className="actions"><a className="btn btn-primary" href={`#stores/${item.tenant_id}/${item.instance_id}`}>進入我的商店</a>
          {item.publication_state === 'published' && item.public_path && <a href={item.public_path} target="_blank" rel="noopener">查看公開頁</a>}</div>
      </article>)}
      {data.truncated && <p className="field-hint">目前只列出前面的商店，清單尚未包含全部商店。</p>}
    </>}
  </div>;
}

type Attempt = {method: 'post' | 'patch'; path: string; body: unknown; version?: string; schema: z.ZodType;
  key: string; success: (value: unknown) => void; notice: string; product?: boolean; fieldError?: (error: ApiError) => void};
function StorePage({client, userId,tenantId, instanceId, registerLeave,photosEnabled,photoUploadsEnabled}: {userId:string;photosEnabled:boolean;photoUploadsEnabled:boolean;client: PortalClient; tenantId: string; instanceId: string; registerLeave: RegisterLeave}) {
  const root = `/tenants/${tenantId}/storefronts/${instanceId}`;
  const [view, setView] = useState<StoreView | null>(null);
  const [products, setProducts] = useState<ProductView[]>([]);
  const [media,setMedia]=useState<ProductMediaView[]>([]);
  const [photoBlocks,setPhotoBlocks]=useState<Record<string,boolean>>({});
  const photoBlockRef=useRef<Record<string,boolean>>({});
  const photoBlocking=Object.values(photoBlocks).some(Boolean);
  function photoState(id:string,dirty:boolean,blocking:boolean){
    photoBlockRef.current={...photoBlockRef.current,[id]:blocking};
    setPhotoBlocks(old=>old[id]===blocking?old:{...old,[id]:blocking});markDirty('photo/'+id,dirty);
  }
  const [preview, setPreview] = useState<Preview | null>(null);
  const [appearance, setAppearance] = useState<StoreAppearance | null>(null);
  const [templateChoice, setTemplateChoice] = useState<StoreTemplate | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<Attempt | null>(null);
  const [dirtyForms, setDirtyForms] = useState<Record<string, boolean>>({});
  const hasDraft = Object.values(dirtyForms).some(Boolean);
  const dirty = hasDraft || busy || retry !== null || photoBlocking;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const controller = useRef(new AbortController());
  const readGeneration = useRef(0);
  const held = useRef<Attempt | null>(null);
  const busyRef = useRef(false);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [supplyEditing, setSupplyEditing] = useState<string | null>(null);
  function leaveOk() {
    if (Object.values(photoBlockRef.current).some(Boolean)) {announce('照片操作尚未確認，請先重試原照片操作。');return false;}
    if (busyRef.current || held.current) {
      announce(busyRef.current ? '正在確認原操作，請等候完成後再離開。' : '尚未確認原操作的結果，請按「重試」確認後再離開。');
      return false;
    }
    return !dirtyRef.current || window.confirm(LEAVE);
  }
  useEffect(() => {
    registerLeave(leaveOk);
    return () => registerLeave(null);
  }, [registerLeave]);
  useEffect(() => {
    controller.current = new AbortController();
    const unloading = (event: BeforeUnloadEvent) => {if (dirtyRef.current || busyRef.current || held.current || Object.values(photoBlockRef.current).some(Boolean)) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', unloading);
    void load();
    return () => {controller.current.abort(); readGeneration.current++; window.removeEventListener('beforeunload', unloading);};
  }, [client, root]);
  async function load() {
    const signal = controller.current.signal; const ticket = ++readGeneration.current;
    const current = () => !signal.aborted && readGeneration.current === ticket;
    setLoading(true);
    try {
      const next = StoreViewSchema.parse(await client.get(root, {signal}));
      let photos:ProductMediaView[]=[];
      let items: ProductView[] = [], draft: Preview | null = null, presentation: StoreAppearance | null = null;
      if (next.setup_state === 'ready') {
        const results = await Promise.all([client.get(root + '/products', {signal}), client.get(root + '/preview', {signal}), client.get(root + '/appearance', {signal}), photosEnabled ? client.get(root+'/product-media',{signal}) : Promise.resolve(null)]);
        items = ProductPageSchema.parse(results[0]).items; draft = StorePreviewSchema.parse(results[1]); presentation = StoreAppearanceSchema.parse(results[2]);
        if(photosEnabled)photos=ProductMediaPageSchema.parse(results[3]).items;
      }
      if (!current()) return;
      setView(next); setProducts(items); setMedia(photos); setPreview(draft); setAppearance(presentation); setError('');
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ApiError && cause.status === 404 && !Object.values(photoBlockRef.current).some(Boolean)) setMissing(true);
      else setError(errorText(cause));
    } finally {if (current()) setLoading(false);}
  }
  useEffect(() => {markDirty('appearance', templateChoice !== null && templateChoice !== appearance?.template_id);}, [templateChoice, appearance?.template_id]);
  function markDirty(id: string, value: boolean) {setDirtyForms(old => old[id] === value ? old : {...old, [id]: value});}
  function announce(text: string) {setStatus(text); requestAnimationFrame(() => statusLine.current?.focus());}
  async function send(attempt: Attempt) {
    if (busyRef.current) return;
    held.current = attempt; busyRef.current = true; setBusy(true); setRetry(null); setError('');
    const signal = controller.current.signal;
    try {
      const raw = await client[attempt.method](attempt.path, attempt.body, {idempotencyKey: attempt.key, ifMatch: attempt.version, signal});
      // An unreadable success may already have committed; retain the same attempt key.
      const parsed = attempt.schema.safeParse(raw);
      if (!parsed.success) throw new ApiError({message: '回應未完整收到，請重試確認原操作。', network: true});
      if (signal.aborted) return;
      held.current = null; attempt.success(parsed.data);
      await load(); if (!signal.aborted) announce(attempt.notice);
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof ApiError && cause.network) {setRetry(attempt); setError('尚未確認原操作的結果，請按「重試」確認。'); return;}
      held.current = null;
      if (cause instanceof ApiError && cause.status === 404) {setMissing(true); return;}
      if (cause instanceof ApiError && cause.status === 412) {
        setEditing(null); setSupplyEditing(null); markDirty('edit', false); markDirty('supply', false); await load();
        announce(attempt.path.endsWith('/appearance') ? '商店資料剛剛被更新，已重新載入。你的版型選擇仍保留，請確認後再儲存。' : attempt.product ? '這件商品剛剛被更新，已重新載入。' : '商店資料剛剛被更新，已重新載入。');
      } else if (cause instanceof ApiError && cause.code === 'storefront_already_set_up') {
        await load(); announce('這間商店已經設定過，已重新載入。');
      } else if (cause instanceof ApiError && ['storefront_slug_taken', 'storefront_slug_reserved', 'validation_failed'].includes(cause.code ?? '') && attempt.fieldError) {
        attempt.fieldError(cause);
      } else setError(errorText(cause));
    } finally {if (!signal.aborted) {busyRef.current = false; setBusy(false);}}
  }
  function command(attempt: Omit<Attempt, 'key'>) {return send({...attempt, key: crypto.randomUUID()});}
  const can = (key: string) => view?.writable === true && view.capabilities.includes(key);
  const locked = busy || retry !== null || photoBlocking;
  if (missing) return <MissingStore/>;
  const store = view?.store;
  const publication = view?.publication;
  const publicationText = publication?.state === 'published' ? `已發布・第 ${publication.current_revision} 版・${formatIsoLocal(publication.published_at)}`
    : publication?.state === 'unpublished' ? '已停止公開' : '尚未發布';
  return <div className="hosted-store stack">
    <BackLink/>
    <p ref={statusLine} tabIndex={-1} role="status" aria-live="polite">{loading && !view ? '正在載入商店…' : [status, store ? publicationText : ''].filter(Boolean).join(' ')}</p>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    <div className="actions">{retry ? <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void send(retry)}>重試</button>
      : error && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void load()}>重新載入</button>}</div>
    {view && <>
      <h2>{store?.name ?? '設定我的商店'}</h2>
      {store && <SellerOrdersLink client={client} tenantId={tenantId} instanceId={instanceId}/>}
      {!view.writable && <p>{view.capabilities.some(key => key !== 'store:read') ? '這間商店目前暫停，無法修改。' : '你可以檢視這間商店，但不能修改。'}</p>}
      {!store ? can('store:manage') ? <SettingsForm key="setup" client={client} root={root} busy={locked} onMissing={() => setMissing(true)} onDirty={value => markDirty('settings', value)} onSave={(body, success, fieldError) => command({method: 'post', path: root + '/setup', body, schema: StoreViewSchema, notice: '已建立商店。', success, fieldError})}/>
        : <p>這間商店還沒完成設定，請業務空間擁有者或管理員設定。</p> : <>
        <p className="banner" role="note">{NOTICE}</p>
        <section className="stack" aria-labelledby="store-products-title"><h3 id="store-products-title">商品</h3>
          <p>{view.product_count}／{view.product_limit} 件商品</p>
          {!products.length && <p>還沒有商品。新增第一件商品後就能發布。</p>}
          <div className="hosted-store-products">{products.map(product => <article className="hosted-store-product stack" key={product.product_id}>
            {supplyEditing === product.product_id && can('store:write') ? <HostedSupplyTerms client={client} path={root + '/products/' + product.product_id + '/supply-terms'} title={product.title} busy={locked} onDirty={value => markDirty('supply', value)} onCancel={() => {if (leaveOk()) {setSupplyEditing(null); markDirty('supply', false);}}} onSave={(body, version, success) => command({method: 'patch', path: root + '/products/' + product.product_id + '/supply-terms', body, version, schema: SupplyTermsSchema, product: true, notice: '已儲存供貨條件。', success: () => {success(); setSupplyEditing(null); markDirty('supply', false);}})}/>
              : editing === product.product_id && can('store:write') ? <ProductForm key={product.version} product={product} currency={store.currency} busy={locked} onDirty={value => markDirty('edit', value)} onCancel={() => {if (leaveOk()) {setEditing(null); markDirty('edit', false);}}} onSave={(body, success) => command({method: 'patch', path: root + '/products/' + product.product_id, body, version: product.version, schema: ProductViewSchema, product: true, notice: '已儲存。', success: value => {success(value); setEditing(null); markDirty('edit', false);}})}/>
              : <><h4>{product.title}</h4><p>{formatMinor(product.price_minor, product.currency)}</p><p>庫存 {product.stock}</p><p className="hosted-store-description">{product.description}</p>
                {can('store:write') && <div className="actions"><button type="button" className="btn btn-ghost" disabled={locked} onClick={() => {if (leaveOk()) {setSupplyEditing(null); setEditing(product.product_id); markDirty('edit', false);}}}>編輯</button>
                  <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => {if (leaveOk()) {setEditing(null); setSupplyEditing(product.product_id);}}}>供貨條件</button>
                  <button type="button" className="btn btn-ghost" disabled={locked} onClick={() => {if (window.confirm(`要移除「${product.title}」嗎？已發布的展示頁要重新發布後才會更新。`)) void command({method: 'post', path: root + '/products/' + product.product_id + '/remove', body: {}, version: product.version, schema: ProductRemovedSchema, product: true, notice: '已移除商品。', success: () => {}});}}>移除</button></div>}
              </>}
            {photosEnabled&&<HostedStorePhoto client={client} userId={userId} tenantId={tenantId} instanceId={instanceId} product={product} media={media.find(item=>item.product_id===product.product_id)}
              writable={can('store:write')} uploadsEnabled={photoUploadsEnabled} locked={busy||retry!==null||(photoBlocking&&!photoBlocks[product.product_id])}
              onState={(dirty,blocking)=>photoState(product.product_id,dirty,blocking)} onSaved={load}/>}
          </article>)}</div>
          {can('store:write') && (products.length >= view.product_limit ? <p>已達 {view.product_limit} 件商品上限。</p>
            : <ProductForm currency={store.currency} busy={locked} primary={!products.length} onDirty={value => markDirty('add', value)} onSave={(body, success) => command({method: 'post', path: root + '/products', body, schema: ProductViewSchema, notice: '已新增商品。', success})}/>)}
        </section>
        <section className="stack" aria-labelledby="store-publish-title"><h3 id="store-publish-title">預覽與發布</h3>
          <p>{publication?.state === 'published' ? `目前公開第 ${publication.current_revision} 版。` : publication?.state === 'unpublished' ? '已停止公開。' : '尚未發布。'}</p>
          {publication?.state === 'published' && preview?.dirty && <p>有尚未發布的變更。</p>}
          {appearance && <fieldset disabled={locked || !can('store:manage')} className="hosted-store-templates">
            <legend>商店版型</legend>
            {([['catalog-grid-v1', '格狀目錄', '商品並排展示，手機改為單欄。'], ['catalog-list-v1', '直列目錄', '商品逐項排列，方便閱讀較長說明。']] as const).map(([id, label, hint]) => <label key={id}>
              <input type="radio" name="store-template" value={id} checked={(templateChoice ?? appearance.template_id) === id} onChange={() => {setTemplateChoice(id); markDirty('appearance', id !== appearance.template_id);}}/>
              <span>{label}<small>{hint}</small></span>
            </label>)}
          </fieldset>}
          {appearance && can('store:manage') && <div className="actions"><button type="button" className="btn btn-ghost" disabled={locked || !templateChoice || templateChoice === appearance.template_id} onClick={() => void command({method: 'patch', path: root + '/appearance', body: {template_id: templateChoice}, version: appearance.version, schema: StoreAppearanceSchema, notice: '已儲存版型。重新發布後，公開頁才會更新。', success: () => {setTemplateChoice(null); markDirty('appearance', false);}})}>儲存版型</button></div>}
          {preview && <div className="actions"><a href={`/api/v1${root}/preview-page`} target="_blank" rel="noopener">預覽已儲存的展示頁</a></div>}
          {dirtyForms.appearance && <p className="field-hint">請先儲存版型，再開啟預覽；公開頁會保留目前發布的版本。</p>}
          {can('store:publish') && <div className="actions">
            {(publication?.state !== 'published' || preview?.dirty) && <button type="button" className={products.length ? 'btn btn-primary' : 'btn btn-ghost'} disabled={locked || hasDraft || !products.length || !preview} onClick={() => void command({method: 'post', path: root + '/publish', body: {}, version: view.version!, schema: StoreViewSchema, notice: '已發布展示頁。', success: () => {}})}>{publication?.state === 'published' ? '發布更新' : '發布展示頁'}</button>}
            {publication?.state === 'published' && <button type="button" className="btn btn-ghost" disabled={locked || hasDraft} onClick={() => {if (window.confirm(`停止公開後，/shops/${store.slug} 會顯示找不到這間商店。`)) void command({method: 'post', path: root + '/unpublish', body: {}, version: view.version!, schema: StoreViewSchema, notice: '已停止公開。', success: () => {}});}}>停止公開</button>}
          </div>}
          {can('store:publish') && hasDraft && <p className="field-hint">還有尚未儲存的內容。請先儲存商店資料與商品，再發布或停止公開。</p>}
          {can('store:publish') && !products.length && <p className="field-hint">至少上架一件商品才能發布。</p>}
          {publication?.state === 'published' && publication.public_path && <div className="actions"><a href={publication.public_path} target="_blank" rel="noopener">查看公開頁：{publication.public_path}</a></div>}
          {store.slug_locked && <p className="field-hint">網址已固定。</p>}
        </section>
        <section className="stack" aria-labelledby="store-settings-title"><h3 id="store-settings-title">商店資料</h3>
          {can('store:manage') ? <SettingsForm key={view.version} client={client} root={root} store={store} busy={locked} onMissing={() => setMissing(true)} onDirty={value => markDirty('settings', value)} onSave={(body, success, fieldError) => command({method: 'patch', path: root, body, version: view.version!, schema: StoreViewSchema, notice: `已儲存。${publication?.state === 'published' ? '重新發布後，公開頁才會更新。' : ''}`, success, fieldError})}/>
            : <dl className="detail-list"><div><dt>商店名稱</dt><dd>{store.name}</dd></div><div><dt>品牌</dt><dd>{store.brand ?? '未填寫'}</dd></div><div><dt>商店介紹</dt><dd>{store.description}</dd></div><div><dt>商店網址</dt><dd>/shops/{store.slug}</dd></div><div><dt>幣別</dt><dd>{currencyLabel(store.currency)}</dd></div></dl>}
        </section>
      </>}
    </>}
  </div>;
}
const currencyLabel = (currency: string) => currency === 'TWD' ? '新臺幣 TWD' : '美元 USD';

function SettingsForm({client, root, store, busy, onMissing, onDirty, onSave}: {
  client: PortalClient; root: string; store?: NonNullable<StoreView['store']>; busy: boolean; onMissing: () => void; onDirty: (dirty: boolean) => void;
  onSave: (body: unknown, success: (value: unknown) => void, fieldError: (error: ApiError) => void) => Promise<void>;
}) {
  const initial = {name: store?.name ?? '', brand: store?.brand ?? '', description: store?.description ?? '', slug: store?.slug ?? '', currency: store?.currency ?? 'TWD'};
  const [fields, setFields] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState('');
  const [slugError, setSlugError] = useState('');
  const [availability, setAvailability] = useState('');
  const id = useId();
  const onMissingRef = useRef(onMissing); onMissingRef.current = onMissing;
  const dirty = JSON.stringify(fields) !== JSON.stringify(saved);
  const onDirtyRef = useRef(onDirty); onDirtyRef.current = onDirty;
  useEffect(() => {onDirtyRef.current(dirty);}, [dirty]);
  useEffect(() => () => onDirtyRef.current(false), []);
  useEffect(() => {
    setAvailability(''); setSlugError('');
    if (!fields.slug || store?.slug_locked) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void client.get(root + '/slug-availability?slug=' + encodeURIComponent(fields.slug), {signal: controller.signal}).then(raw => {
        const result = SlugAvailabilitySchema.parse(raw); if (controller.signal.aborted) return;
        setAvailability(result.available ? `可以使用：/shops/${result.slug}` : result.reason === 'taken' ? '這個網址已被使用。' : result.reason === 'reserved' ? '這個網址是保留字，請換一個。' : '網址格式不符。');
      }).catch(cause => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 404) onMissingRef.current();
        else setAvailability(errorText(cause));
      });
    }, 400);
    return () => {clearTimeout(timer); controller.abort();};
  }, [client, root, fields.slug, store?.slug_locked]);
  const change = (key: keyof typeof fields, value: string) => setFields(old => ({...old, [key]: value}));
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSlugError('');
    const body = {name: fields.name, brand: fields.brand.trim() || null, description: fields.description,
      ...(!store?.slug_locked ? {slug: fields.slug.trim().toLowerCase()} : {}), ...(!store ? {currency: fields.currency} : {})};
    const result = (store ? StoreUpdateInputSchema : StoreSetupInputSchema).safeParse(body);
    if (!result.success) {setError('有欄位格式不符，請檢查後再送出。'); return;}
    await onSave(result.data, () => {setSaved(fields); onDirtyRef.current(false);}, cause => cause.code === 'validation_failed' ? setError(errorText(cause)) : setSlugError(errorText(cause)));
  }
  return <form className="hosted-store-form stack" aria-label={store ? '商店資料' : '建立商店'} onSubmit={event => void submit(event)}>
    <fieldset disabled={busy} className="hosted-store-fields stack"><legend className="sr-only">{store ? '商店資料' : '商店設定'}</legend>
      <label className="field">商店名稱<input required maxLength={StoreSetupInputSchema.shape.name.maxLength!} value={fields.name} onChange={event => change('name', event.target.value)}/></label>
      <label className="field">品牌（選填）<input maxLength={StoreSetupInputSchema.shape.brand.unwrap().unwrap().maxLength!} value={fields.brand} onChange={event => change('brand', event.target.value)}/></label>
      <div className="field">{store?.slug_locked ? <><span>商店網址</span><span>/shops/{store.slug}</span></> : <><label htmlFor={`${id}-slug`}>商店網址</label><span className="hosted-store-slug"><span aria-hidden="true">/shops/</span><input id={`${id}-slug`} required maxLength={40} autoCapitalize="off" spellCheck={false} aria-describedby={`${id}-slug-hint ${id}-slug-result ${id}-slug-error`} value={fields.slug} onChange={event => change('slug', event.target.value)}/></span></>}</div>
      {!store?.slug_locked && <><p id={`${id}-slug-hint`} className="field-hint">3–40 個小寫英文字母、數字或連字號，以英文字母開頭；第一次發布後不能再改。</p><p id={`${id}-slug-result`} aria-live="polite">{availability}</p><p id={`${id}-slug-error`} role="alert">{slugError}</p></>}
      <label className="field">商店介紹<textarea maxLength={StoreSetupInputSchema.shape.description.unwrap().maxLength!} value={fields.description} onChange={event => change('description', event.target.value)}/></label>
      {store ? <p>幣別：{currencyLabel(store.currency)}</p> : <><label className="field">幣別<select value={fields.currency} onChange={event => change('currency', event.target.value)}><option value="TWD">新臺幣 TWD</option><option value="USD">美元 USD</option></select></label><p className="field-hint">建立後不能更改。</p></>}
      {error && <p role="alert" className="banner banner-error">{error}</p>}
      <div className="actions"><button className={store ? 'btn btn-ghost' : 'btn btn-primary'} disabled={busy}>{store ? '儲存商店資料' : '建立商店'}</button></div>
    </fieldset>
  </form>;
}
function ProductForm({product, currency, busy, primary, onDirty, onSave, onCancel}: {
  product?: ProductView; currency: string; busy: boolean; primary?: boolean; onDirty: (dirty: boolean) => void; onCancel?: () => void;
  onSave: (body: unknown, success: (value: unknown) => void) => Promise<void>;
}) {
  const initial = {title: product?.title ?? '', description: product?.description ?? '', price: product ? String(product.price_minor / 100) : '', stock: String(product?.stock ?? 0)};
  const [fields, setFields] = useState(initial);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  const onDirtyRef = useRef(onDirty); onDirtyRef.current = onDirty;
  useEffect(() => {onDirtyRef.current(dirty);}, [dirty]);
  useEffect(() => () => onDirtyRef.current(false), []);
  const change = (key: keyof typeof fields, value: string) => setFields(old => ({...old, [key]: value}));
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const amount = parseMajorToMinor(fields.price);
      const cap = ProductInputSchema.shape.price_minor.maxValue!;
      if (amount > cap) {setError(`價格上限為 ${formatMinor(cap, currency)}。`); return;}
      if (!/^\d+$/.test(fields.stock)) {setError('庫存須為整數。'); return;}
      const result = ProductInputSchema.safeParse({title: fields.title, description: fields.description, price_minor: amount, stock: Number(fields.stock)});
      if (!result.success) {setError('有欄位格式不符，請檢查後再送出。'); return;}
      await onSave(result.data, () => {if (!product) setFields(initial); onDirtyRef.current(false);});
    } catch (cause) {setError(cause instanceof Error ? cause.message : '有欄位格式不符，請檢查後再送出。');}
  }
  return <form className="hosted-store-form stack" aria-label={product ? `編輯${product.title}` : '新增商品'} onSubmit={event => void submit(event)}>
    {!product && <h4>新增商品</h4>}
    <fieldset disabled={busy} className="hosted-store-fields stack"><legend className="sr-only">{product ? '編輯商品' : '新增商品'}</legend>
      <label className="field">商品名稱<input required maxLength={ProductInputSchema.shape.title.maxLength!} value={fields.title} onChange={event => change('title', event.target.value)}/></label>
      <label className="field">價格（{currencyLabel(currency)}）<input required inputMode="decimal" value={fields.price} onChange={event => change('price', event.target.value)}/></label>
      <label className="field">庫存<input required type="number" min={0} max={ProductInputSchema.shape.stock.unwrap().maxValue!} step={1} value={fields.stock} onChange={event => change('stock', event.target.value)}/></label>
      <label className="field">商品介紹<textarea maxLength={ProductInputSchema.shape.description.unwrap().maxLength!} value={fields.description} onChange={event => change('description', event.target.value)}/></label>
      {error && <p role="alert" className="banner banner-error">{error}</p>}
      <div className="actions"><button className={primary ? 'btn btn-primary' : 'btn btn-ghost'} disabled={busy}>{product ? '儲存' : '新增商品'}</button>{onCancel && <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>取消</button>}</div>
    </fieldset>
  </form>;
}
