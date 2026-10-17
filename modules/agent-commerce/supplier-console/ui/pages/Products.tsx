import type {SupplierProducts} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import type {ProductMediaView} from '../../../../../contracts/guild-launchpad/v1/hosted-store-media';
import {useEffect} from 'react';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {formatMinor} from '../../../../../apps/portal-web/src/format';
import {supplierConsoleHref,type ProductState,type ProductSort} from '../route';
import {filterProducts,offerState} from '../view';
import {ReadStatus,Capacity,Editor,useListRestore} from './Shared';
export function Products({c}:{c:ConsoleController}){
 const r=c.slot<SupplierProducts>('products'),data=r.data,p=c.position('products'),state=c.route.state,sort=c.route.sort??'sku',items=data?filterProducts(data.items,state,sort,p.search):[],restore=useListRestore(c,'products',r);
 useEffect(()=>{c.remember('products',{filter:state??'',sort});},[state,sort]);
 const media=c.slot<{items:ProductMediaView[]}>('media'),capacity=c.profile!.product_count;
 const filter=(nextState:ProductState|undefined,nextSort:ProductSort)=>{c.remember('products',{filter:nextState??'',sort:nextSort});window.location.hash=supplierConsoleHref(c.scope,'products',{state:nextState,sort:nextSort});};
 return <section className="stack"><h2 tabIndex={-1} ref={restore.heading}>商品與庫存</h2><ReadStatus c={c} name="products" label="商品清單"/>
  {data&&<><div className="sc-toolbar"><label className="field">搜尋商品<input type="search" value={p.search} placeholder="商品名稱、SKU 或介紹" onChange={e=>c.remember('products',{search:e.target.value})}/></label>
   <label className="field">供貨狀態<select value={state??''} onChange={e=>filter((e.target.value||undefined) as ProductState|undefined,sort)}>{[['','全部'],['offered','公開中'],['not_offered','尚未公開'],['outdated','需更新版本'],['out_of_stock','缺貨']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label className="field">排序<select value={sort} onChange={e=>filter(state,e.target.value as ProductSort)}><option value="sku">SKU</option><option value="title">名稱</option><option value="available">可用量</option></select></label>
   <div className="actions">{capacity<200&&c.slot('profile').state==='ready'?<a className="btn btn-primary" href={supplierConsoleHref(c.scope,'product-new')}>新增商品</a>:<><button className="btn btn-primary" disabled>新增商品</button><span>{capacity>=200?'商品容量已達 200 件':'請先確認共用商品容量'}</span></>}</div>
  </div>
  <p role="status">{items.length===data.items.length?`共 ${data.items.length} 件（完整清單）`:`符合 ${items.length} 件，共 ${data.items.length} 件（完整清單）`}</p><ReadStatus c={c} name="profile" label="共用商品容量"/><Capacity count={capacity}/>
  {!data.items.length?<p>還沒有商品。新增商品後可設定供貨條件。</p>:!items.length?<p>沒有符合條件的商品。</p>:<table className="sc-products"><thead><tr><th>名稱與 SKU</th><th>供貨單價與運費</th><th>庫存／已預留／可用</th><th>供貨版本狀態</th><th>合作</th></tr></thead><tbody>{items.map(product=>{const photo=media.data?.items.find(m=>m.product_id===product.product_id)?.photo;return <tr key={product.product_id}>
   <td data-label="名稱與 SKU"><div className="sc-product-name">{c.photosEnabled&&photo&&<img width={48} height={48} src={photo.read_path} alt=""/>}<a data-sc-item={product.product_id} href={supplierConsoleHref(c.scope,'product',{id:product.product_id})} onClick={()=>restore.open(product.product_id)}>{product.title}<br/><span className="field-hint">{product.sku}</span></a></div></td>
   <td data-label="供貨單價與運費" className="sc-number">{formatMinor(product.supply_price_minor,product.currency)}<br/><span className="field-hint">運費 {formatMinor(product.shipping_minor,product.currency)}</span></td><td data-label="庫存／已預留／可用" className="sc-number">{product.stock}／{product.reserved}／{product.available}</td><td data-label="供貨版本狀態"><span className="badge">{offerState(product)}</span></td><td data-label="合作"><span className="sc-nowrap">待確認 {product.cooperation.awaiting} · 可售 {product.cooperation.sellable}</span><br/><span className="sc-nowrap">需修改 {product.cooperation.changes_requested} · 停用 {product.cooperation.inactive}</span></td>
  </tr>;})}</tbody></table>}
  {c.photosEnabled&&media.state==='failed'&&<p>縮圖暫時無法讀取，商品清單不受影響。<button type="button" className="btn btn-ghost" onClick={()=>void c.read('media')}>重試照片</button></p>}
 </>}
 </section>;
}
export function NewProduct({c}:{c:ConsoleController}){
 const r=c.slot<SupplierProducts>('products'),full=c.profile!.product_count>=200;
 return <section className="stack"><h2 tabIndex={-1}>新增商品</h2><ReadStatus c={c} name="products" label="商品清單"/><ReadStatus c={c} name="profile" label="共用商品容量"/><Capacity count={c.profile!.product_count}/>{full&&<p>商品容量已達 200 件。</p>}
 <Editor c={c} name="product:new" title="新增商品" base={{title:'',description:'',cost_minor:'',stock:'0'}} version="" kind="product.create" path="/supply-products" target="new" primary disabled={r.state!=='ready'||full} fields={[{key:'title',required:true},{key:'description',multiline:true},{key:'cost_minor',money:true,required:true},{key:'stock',required:true}]}/>
 </section>;
}
