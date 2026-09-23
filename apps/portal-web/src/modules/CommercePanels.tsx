import { ModuleBanner } from './ModuleBanner';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatMinor, parseMajorToMinor } from '../format';
import { useModuleMutation, type ModulePanelProps } from './shared';

type Offer={offer_version_id:string;revision:number;net_price_minor:string|number;currency:string;availability:'finite'|'manual_confirmation';stock:number|null;shipping_terms:string;return_terms:string};
type Product={product_id:string;title:string;photo_url:string|null;specifications:string;supplier_name:string;current_offer:Offer};
type Store={store_id:string;name:string;description:string;support_contact:string};
type Snapshot={store_name:string;retail_price_minor:number;currency:string;sale_terms:string;supply:{title:string;specifications:string;net_price_minor:number;availability:string;stock:number|null;shipping_terms:string;return_terms:string}};
type Listing={listing_id:string;state:string;aggregate_version:number;snapshot_sha256:string;snapshot:Snapshot;decision_note?:string};
type SupplyRequest={acceptance_id:string;state:string;aggregate_version:number;snapshot_sha256:string;snapshot:Snapshot;seller_name:string;decision_note:string|null};
function ClientStarter({kind}:{kind:'supplier'|'storefront'}){const supplier=kind==='supplier';const repo=supplier?'freedom-supplier-client':'freedom-storefront';return <section className="card stack"><h3>{supplier?'你的供應端工作台':'你的第一本技能書，就是自己的商店'}</h3><p>現在就能在這裡{supplier?'刊登商品與管理供貨':'建立商店、選品與確認供貨'}。也可以 Fork 客戶端，依專案說明啟動，再到「我的名片」用一次性代碼核准讀取連線。</p><div className="actions"><a className="btn btn-primary" href={`https://github.com/FreeTWAI-AI/${repo}/fork`} target="_blank" rel="noopener noreferrer">{supplier?'Fork 我的供應端客戶端':'Fork 我的商店'} ↗</a><a href={`https://github.com/FreeTWAI-AI/${repo}`} target="_blank" rel="noopener noreferrer">查看開始方式 ↗</a></div><p className="field-hint">連線後可讀取自己的資料；商品與商店的修改仍在這個網站完成。商店目前尚未開放買家結帳。</p></section>;}
const stateLabel:Record<string,string>={draft:'選品草稿',requested:'待供貨商回覆',accepted:'供貨商已確認（內部演練）',declined:'供貨商暫不接受'};

function Stock({offer}:{offer:{availability:string;stock:number|null}}){return <span>{offer.availability==='finite'?`供貨商自報庫存 ${offer.stock} 件`:'數量須與供貨商確認'}</span>;}
function Photo({product}:{product:Product}){
  const [failed,setFailed]=useState(false);
  return product.photo_url&&!failed?<img className="product-photo" src={product.photo_url} alt={product.title} referrerPolicy="no-referrer" loading="lazy" onError={()=>setFailed(true)}/>:<div className="product-photo product-placeholder" role="img" aria-label="尚無可顯示的商品照片">實體商品</div>;
}
function ProductCard({product,children}:{product:Product;children?:React.ReactNode}){
  const o=product.current_offer;
  return <article className="card product-card"><Photo product={product}/><div className="stack"><p className="eyebrow">實體商品 · 待品質確認</p><h3>{product.title}</h3><p>{product.specifications}</p><p className="muted">供貨商：{product.supplier_name}</p><p><strong>供貨價 {formatMinor(o.net_price_minor,o.currency)}</strong></p><p><Stock offer={o}/></p><p className="muted">出貨：{o.shipping_terms}</p><p className="muted">退換貨：{o.return_terms}</p>{children}</div></article>;
}
function PreviewNote(){return <p className="banner banner-info">這一版可保存商品、選品與雙方供貨回覆。供貨確認是內部演練；尚未完成正式商業條款、品質確認與收款接線，沒有開放買家結帳。</p>;}
function SnapshotDetails({snapshot}:{snapshot:Snapshot}){return <dl className="detail-list"><div><dt>商店</dt><dd>{snapshot.store_name}</dd></div><div><dt>實際售價</dt><dd>{formatMinor(snapshot.retail_price_minor,snapshot.currency)}</dd></div><div><dt>供貨價</dt><dd>{formatMinor(snapshot.supply.net_price_minor,snapshot.currency)}</dd></div><div><dt>商品規格</dt><dd>{snapshot.supply.specifications}</dd></div><div><dt>供應數量</dt><dd><Stock offer={snapshot.supply}/></dd></div><div><dt>出貨條件</dt><dd>{snapshot.supply.shipping_terms}</dd></div><div><dt>退換貨條件</dt><dd>{snapshot.supply.return_terms}</dd></div><div><dt>銷售說明</dt><dd>{snapshot.sale_terms}</dd></div></dl>;}

export function SupplierPanel({client}:ModulePanelProps){
  const [products,setProducts]=useState<Product[]>([]),[requests,setRequests]=useState<SupplyRequest[]>([]),[loading,setLoading]=useState(true),[notice,setNotice]=useState('');
  const {mutate,busy,error,setError}=useModuleMutation(client);
  const load=useCallback(async()=>{
    try{const [p,r]=await Promise.all([client.get<{items:Product[]}>('/supplier/products'),client.get<{items:SupplyRequest[]}>('/supplier/requests')]);setProducts(p.items);setRequests(r.items);}
    catch(e){setError(e instanceof Error?e.message:'無法取得供貨資料。');}finally{setLoading(false);}
  },[client,setError]);
  useEffect(()=>{void load();},[load]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=event.currentTarget,data=new FormData(form);setNotice('');
    try{
      const availability=String(data.get('availability'));
      const created=await mutate('/supplier/products',{title:data.get('title'),photo_url:String(data.get('photo_url')??'').trim()||null,specifications:data.get('specifications'),net_price_minor:parseMajorToMinor(String(data.get('net_price'))),currency:'TWD',availability,stock:availability==='finite'?Number(data.get('stock')):null,shipping_terms:data.get('shipping_terms'),return_terms:data.get('return_terms')});
      if(created){form.reset();setNotice('商品與第一版供貨條件已保存，可到「開店與銷售」選品。');await load();}
    }catch(e){setError(e instanceof Error?e.message:'請檢查商品欄位。');}
  }
  return <section className="stack" aria-labelledby="supplier-heading"><ModuleBanner eyebrow="SUPPLY / 把你的好商品帶進來" title="供貨中心" headingId="supplier-heading" description="你提供商品與供貨條件，銷售者經營自己的店。每次合作都能看清楚對方的售價與承諾。" art="/art/rpg/market-network.webp"/><PreviewNote/><ClientStarter kind="supplier"/>
    {error&&<p role="alert" className="banner banner-error">{error}</p>}{notice&&<p role="status" className="banner status-note">{notice}</p>}
    <div className="module-split"><form className="card stack" onSubmit={event=>void submit(event)}><h3>提交實體商品</h3>
      <label className="field"><span>商品名稱</span><input name="title" required maxLength={120} placeholder="例如：阿里山烏龍茶 150g"/></label>
      <label className="field"><span>商品照片網址（選填）</span><input name="photo_url" type="url" maxLength={2000} placeholder="https://…"/></label>
      <label className="field"><span>商品規格與介紹</span><textarea name="specifications" required maxLength={2000} placeholder="重量、材質、產地、規格、適合的人…"/></label>
      <div className="form-grid"><label className="field"><span>供貨價（新台幣）</span><input name="net_price" required inputMode="decimal" placeholder="300.00"/></label><label className="field"><span>供貨方式</span><select name="availability" defaultValue="finite"><option value="finite">有明確庫存</option><option value="manual_confirmation">接單前確認數量</option></select></label></div>
      <label className="field"><span>可供數量（有明確庫存時必填）</span><input name="stock" type="number" min="0" max="100000000" step="1" defaultValue="0"/></label>
      <label className="field"><span>出貨方式與條件</span><textarea name="shipping_terms" required maxLength={1500} placeholder="例如：確認後 3 個工作天宅配，運費另議"/></label>
      <label className="field"><span>退換貨條件</span><textarea name="return_terms" required maxLength={1500} placeholder="說明瑕疵、退貨聯絡與處理方式"/></label>
      <button className="btn btn-primary" disabled={busy} type="submit">保存商品與供貨條件</button>
    </form><div className="stack"><h3>我的供貨商品</h3>{loading?<p role="status">載入中…</p>:products.length===0?<div className="card empty-state"><p>先放上第一件商品。</p><p className="muted">商品保存後，社群裡的銷售者就可以選品並提出供貨請求。</p></div>:products.map(p=><ProductCard key={p.product_id} product={p}/>)}</div></div>
    <section className="stack" aria-labelledby="supply-request-heading"><h3 id="supply-request-heading">銷售者的供貨請求</h3><button className="btn btn-ghost" onClick={()=>void load()} disabled={busy}>重新整理供貨請求</button>{requests.length===0?<p className="muted">還沒有供貨請求。銷售者選品並送出後，會出現在這裡。</p>:requests.map(r=><SupplyRequestCard key={r.acceptance_id} request={r} busy={busy} onDecide={async(decision,note)=>{const result=await mutate(`/supplier/requests/${r.acceptance_id}:decide`,{decision,note,snapshot_sha256:r.snapshot_sha256,acknowledge_internal_preview:true},r.aggregate_version);if(result){setNotice('供貨回覆已保存，銷售者可在自己的選品看到。');await load();}}}/>)}</section>
  </section>;
}
function SupplyRequestCard({request:r,busy,onDecide}:{request:SupplyRequest;busy:boolean;onDecide:(decision:'accepted'|'declined',note:string)=>Promise<void>}){
  return <article className="card stack"><div className="card-head"><h4>{r.snapshot.supply.title}</h4><span className="pill">{stateLabel[r.state]}</span></div><p>銷售者：{r.seller_name}</p><SnapshotDetails snapshot={r.snapshot}/>{r.state==='requested'?<form className="stack" onSubmit={event=>{event.preventDefault();const d=new FormData(event.currentTarget);void onDecide(d.get('decision') as 'accepted'|'declined',String(d.get('note')));}}><label className="field"><span>回覆</span><select name="decision"><option value="accepted">確認此售價與供貨條件（內部演練）</option><option value="declined">暫不接受</option></select></label><label className="field"><span>給銷售者的說明</span><textarea name="note" required maxLength={1000}/></label><label className="checkbox-row"><input type="checkbox" required/><span>我已核對以上商品、售價與條件；這是內部演練回覆。</span></label><button className="btn btn-primary" disabled={busy}>保存供貨回覆</button></form>:<p>{r.decision_note}</p>}</article>;
}

export function RetailPanel({client}:ModulePanelProps){
  const [catalog,setCatalog]=useState<Product[]>([]),[stores,setStores]=useState<Store[]>([]),[listings,setListings]=useState<Listing[]>([]),[chosen,setChosen]=useState<Product|null>(null),[loading,setLoading]=useState(true),[notice,setNotice]=useState('');
  const {mutate,busy,error,setError}=useModuleMutation(client);
  const load=useCallback(async()=>{
    try{const [p,s,l]=await Promise.all([client.get<{items:Product[]}>('/retail/catalog'),client.get<{items:Store[]}>('/retail/stores'),client.get<{items:Listing[]}>('/retail/listings')]);setCatalog(p.items);setStores(s.items);setListings(l.items);}
    catch(e){setError(e instanceof Error?e.message:'無法取得選品資料。');}finally{setLoading(false);}
  },[client,setError]);useEffect(()=>{void load();},[load]);
  async function createStore(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget,d=new FormData(form);const result=await mutate('/retail/stores',{name:d.get('name'),description:d.get('description'),support_contact:d.get('support_contact')});if(result){form.reset();setNotice('商店已建立，現在可以挑選商品。');await load();}}
  async function createListing(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!chosen)return;const d=new FormData(event.currentTarget);
    try{const result=await mutate('/retail/listings',{store_id:d.get('store_id'),offer_version_id:chosen.current_offer.offer_version_id,retail_price_minor:parseMajorToMinor(String(d.get('price'))),sale_terms:d.get('sale_terms')});if(result){setChosen(null);setNotice('選品草稿已保存。核對後送給供貨商確認。');await load();}}
    catch(e){setError(e instanceof Error?e.message:'請檢查選品欄位。');}
  }
  return <section className="stack" aria-labelledby="retail-heading"><ModuleBanner eyebrow="STOREFRONT / 用你的眼光，經營自己的店" title="開店與銷售" headingId="retail-heading" description="選擇想賣的商品、設定售價，和供貨商對齊出貨承諾。你的商店由你負責服務買家。" art="/art/rpg/market-network.webp"/><PreviewNote/><ClientStarter kind="storefront"/>{error&&<p role="alert" className="banner banner-error">{error}</p>}{notice&&<p role="status" className="banner status-note">{notice}</p>}
    <div className="module-split"><form className="card stack" onSubmit={event=>void createStore(event)}><h3>建立自己的商店</h3><label className="field"><span>商店名稱</span><input name="name" required maxLength={120} placeholder="例如：山間選物"/></label><label className="field"><span>商店介紹</span><textarea name="description" required maxLength={1500}/></label><label className="field"><span>客服聯絡方式</span><input name="support_contact" required maxLength={250} placeholder="提供給合作方的聯絡方式"/></label><button className="btn btn-primary" disabled={busy}>建立預覽商店</button></form><div className="stack"><h3>我的商店</h3>{stores.length===0?<p className="muted">商店建立後，就能選品與準備上架。</p>:stores.map(s=><article key={s.store_id} className="card"><h4>{s.name}</h4><p>{s.description}</p><p className="muted">客服：{s.support_contact}</p><span className="pill">內部預覽 · 尚未開放結帳</span></article>)}</div></div>
    <section className="stack" aria-labelledby="catalog-heading"><h3 id="catalog-heading">挑選供貨商品</h3>{loading?<p role="status">載入中…</p>:catalog.length===0?<p className="muted">供貨商還沒有提交商品。可以先到供貨中心放上第一件。</p>:<div className="module-grid">{catalog.map(p=><ProductCard key={p.product_id} product={p}><button className="btn btn-primary" disabled={busy||stores.length===0} onClick={()=>{setChosen(p);setNotice('');}}>選這件商品</button>{stores.length===0&&<p className="muted">請先建立自己的商店。</p>}</ProductCard>)}</div>}</section>
    {chosen&&<form className="card stack" onSubmit={event=>void createListing(event)}><h3>準備選品：{chosen.title}</h3><label className="field"><span>放入商店</span><select name="store_id">{stores.map(s=><option value={s.store_id} key={s.store_id}>{s.name}</option>)}</select></label><p>供貨價：{formatMinor(chosen.current_offer.net_price_minor,chosen.current_offer.currency)} · 待品質確認</p><label className="field"><span>預計售價（{chosen.current_offer.currency==='TWD'?'新台幣':'美元'}）</span><input name="price" required inputMode="decimal"/></label><label className="field"><span>對買家的銷售說明</span><textarea name="sale_terms" required maxLength={1500} placeholder="商品用途、服務與出貨承諾"/></label><div className="actions"><button className="btn btn-primary" disabled={busy}>保存選品草稿</button><button type="button" className="btn btn-ghost" onClick={()=>setChosen(null)} disabled={busy}>取消選品</button></div></form>}
    <section className="stack" aria-labelledby="listing-heading"><h3 id="listing-heading">我的選品與供貨狀態</h3><button className="btn btn-ghost" onClick={()=>void load()} disabled={busy}>重新整理選品</button>{listings.length===0?<p className="muted">選品草稿會出現在這裡，你可以核對後送供貨商確認。</p>:listings.map(l=><article className="card stack" key={l.listing_id}><div className="card-head"><h4>{l.snapshot.supply.title}</h4><span className="pill">{stateLabel[l.state]}</span></div><SnapshotDetails snapshot={l.snapshot}/>{l.decision_note&&<p>供貨商回覆：{l.decision_note}</p>}{l.state==='draft'&&<button className="btn btn-primary" disabled={busy} onClick={async()=>{const result=await mutate(`/retail/listings/${l.listing_id}:request-supply`,{snapshot_sha256:l.snapshot_sha256},l.aggregate_version);if(result){setNotice('已送給供貨商，回覆後會更新選品狀態。');await load();}}}>送出供貨確認（內部演練）</button>}<p className="muted">售價與供貨內容已保存為獨立版本；修改條件請建立新的選品草稿。</p></article>)}</section>
  </section>;
}
