import {SupplyMaterialCreateInputSchema,type SupplierProducts} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {supplierConsoleHref} from '../route';
import {ReadStatus} from './Shared';
const base={kind:'image',product_id:'',title:'',description:'',body:''};
export function MaterialNew({c}:{c:ConsoleController}){
 const name='material:new',draft=c.drafts[name],values={...base,...draft?.fields},r=c.slot<SupplierProducts>('products');
 const body={kind:values.kind,product_id:values.product_id||null,title:values.title,description:values.description,...(values.kind==='copy'?{body:values.body}:{})},parsed=SupplyMaterialCreateInputSchema.safeParse(body);
 const edit=(field:string,value:string)=>c.updateDraft(name,'',base,field,value);
 return <section className="stack sc-material-page"><h2 tabIndex={-1}>新增素材</h2><div className="actions"><a className="btn btn-ghost" href={supplierConsoleHref(c.scope,'materials')}>返回行銷素材</a></div>
  <ReadStatus c={c} name="products" label="自有商品"/>
  <form className="stack" aria-label="新增素材" onSubmit={e=>{e.preventDefault();if(parsed.success)c.command({kind:'material.create',label:'新增素材',method:'post',path:c.root+'/supply-materials',body:parsed.data,target:'',draft:name});}}>
   <fieldset className="hosted-store-fields stack" disabled={c.locked}><legend className="sr-only">素材內容</legend>
    <label className="field">種類<select value={String(values.kind)} onChange={e=>edit('kind',e.target.value)}><option value="image">圖片</option><option value="video">影片</option><option value="copy">文案</option></select></label>
    <label className="field">素材對象<select value={String(values.product_id)} disabled={r.state!=='ready'} onChange={e=>edit('product_id',e.target.value)}><option value="">品牌素材</option>{r.data?.items.map(p=><option key={p.product_id} value={p.product_id}>{p.sku}・{p.title}</option>)}</select></label>
    {r.state!=='ready'&&<p className="field-hint">自有商品尚未讀取完成；目前可建立品牌素材。</p>}
    {(['title','description',...(values.kind==='copy'?['body']:[])] as ('title'|'description'|'body')[]).map(field=>{const max=field==='title'?80:field==='description'?500:2000,label=field==='title'?'標題':field==='description'?'說明':'文案內容';return <label className="field" key={field}>{label}{field==='title'?<input required maxLength={max} value={String(values[field])} onChange={e=>edit(field,e.target.value)}/>:<textarea required={field==='body'} maxLength={max} value={String(values[field])} onChange={e=>edit(field,e.target.value)}/>}<span className="field-hint" aria-live="polite">{String(values[field]).length}／{max}</span></label>;})}
    <p className="field-hint">標題、說明與文案會去除前後空白；不接受控制字元，多行內容可換行。</p>
    {draft&&!parsed.success&&<p className="field-hint">請填寫標題{values.kind==='copy'?'與文案內容':''}，並確認字數與格式。</p>}
    <div className="actions"><button className="btn btn-primary" disabled={!parsed.success||c.locked}>建立素材</button>{draft&&<button type="button" className="btn btn-ghost" onClick={()=>c.discard(name)}>取消</button>}</div>
   </fieldset>
  </form>
 </section>;
}
