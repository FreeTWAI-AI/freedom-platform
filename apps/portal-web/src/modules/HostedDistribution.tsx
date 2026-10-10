import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {z} from 'zod';
import {DistributionInputSchema,DistributionSchema,DistributionsSchema,SupplyOfferSchema,SupplyOffersSchema,type Distribution,type SupplyOffer} from '../../../../contracts/guild-launchpad/v1/hosted-distribution';
import {ApiError,type PortalClient} from '../api';
import {formatMinor,parseMajorToMinor} from '../format';

type Command = {method:'post'|'patch';path:string;body:unknown;version?:string;schema:z.ZodType;notice:string;success:(value:unknown)=>void;targetMissingIsStore?:boolean};
const stateWord:Record<Distribution['state'],string> = {awaiting_supply_acceptance:'等待供應商確認',sellable:'已同意，可加入展示頁',declined:'供應商未同意',changes_requested:'需要修改',revoked:'已撤回供貨'};
export function HostedDistribution({client,root,refresh,busy,writable,onDirty,onCommand,onReload}:{client:PortalClient;root:string;refresh:number;busy:boolean;writable:boolean;onDirty:(key:string,value:boolean)=>void;onCommand:(command:Command)=>Promise<void>;onReload:()=>Promise<void>}) {
  const [data,setData]=useState<{offers:SupplyOffer[];catalog:SupplyOffer[];selections:Distribution[];requests:Distribution[];truncated:boolean}|null>(null);
  const [error,setError]=useState(''),[editing,setEditing]=useState<string|null>(null);
  useEffect(()=>{
    const abort=new AbortController(); setError('');
    void Promise.all(['supply-offers','supply-catalog','distribution-selections','supply-requests'].map(path=>client.get(root+'/'+path,{signal:abort.signal}))).then(raw=>{
      if(abort.signal.aborted)return;
      const offers=SupplyOffersSchema.parse(raw[0]),catalog=SupplyOffersSchema.parse(raw[1]),selections=DistributionsSchema.parse(raw[2]),requests=DistributionsSchema.parse(raw[3]);
      setData({offers:offers.items,catalog:catalog.items,selections:selections.items,requests:requests.items,truncated:[offers,catalog,selections,requests].some(p=>p.truncated)});
    }).catch(cause=>{if(!abort.signal.aborted){setError(cause instanceof ApiError ? cause.detail??'目前無法讀取供貨合作。':'暫時無法讀取供貨合作。');}});
    return()=>abort.abort();
  },[client,root,refresh]);
  const command=(value:Command)=>onCommand({...value,targetMissingIsStore:false});
  return <section className="stack hosted-distribution" aria-labelledby="store-distribution-title">
    <h3 id="store-distribution-title">供貨合作</h3>
    <p className="field-hint">供應商確認這一版售價後，商品才能加入你的展示頁。跨店商品目前尚未開放買家預留。</p>
    <div className="actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void onReload()}>更新供貨狀態</button></div>
    {error&&<p role="alert">{error}</p>}
    {!data?<p>{error ? '請更新供貨狀態後再試一次。' : '正在讀取供貨合作…'}</p>:<>
      <details><summary>我的供貨（{data.offers.length}）</summary>
        {!data.offers.length&&<p>尚未公開供貨版本。請在商品的「供貨條件」確認內容後公開。</p>}
        {data.offers.map(o=><article className="hosted-distribution-item stack" key={o.offer_id}>
          <h4>{o.terms.title}</h4><Terms offer={o}/>
          <div className="actions"><button type="button" className="btn btn-ghost" disabled={busy||!writable||!!error} onClick={()=>{
            if(window.confirm('撤回後，所有採用這一版的商店都不能再加入新的公開版本。既有公開內容與歷史紀錄會保留。'))void command({method:'post',path:root+`/supply-offers/${o.offer_id}/withdraw`,body:{},version:o.version,schema:SupplyOfferSchema,notice:'已撤回這一版供貨。',success:()=>{}});
          }}>撤回供貨版本</button></div>
        </article>)}
      </details>
      <details><summary>供貨申請（{data.requests.length}）</summary>
        {!data.requests.length&&<p>目前沒有供貨申請。</p>}
        {data.requests.map(r=><article className="hosted-distribution-item stack" key={r.selection_id}>
          <h4>{r.offer.terms.title}・{r.seller_name}</h4><Terms offer={r.offer}/>
          <p>對方零售價 {formatMinor(r.retail_price_minor,r.offer.terms.currency)}・{stateWord[r.state]}</p>
          <div className="actions">{(r.state==='sellable'?['revoked']:r.offer.state==='offered'&&r.state==='awaiting_supply_acceptance'?['accepted','declined']:[]).map(decision=><button type="button" className="btn btn-ghost" disabled={busy||!writable||!!error} key={decision} onClick={()=>void command({method:'post',path:root+`/supply-requests/${r.selection_id}/decision`,body:{decision,listing_sha256:r.listing_sha256},version:r.version,schema:DistributionSchema,notice:decision==='accepted'?'已同意這一版選品。':decision==='revoked'?'已撤回這間店的供貨同意。':'已回覆不同意。',success:()=>{}})}>{decision==='accepted'?'同意這一版':decision==='revoked'?'撤回這間店的同意':'不同意'}</button>)}</div>
        </article>)}
      </details>
      <details><summary>我的選品（{data.selections.length}）</summary>
        {!data.selections.length&&<p>尚未選用其他商店的商品。</p>}
        {data.selections.map(r=><article className="hosted-distribution-item stack" key={r.selection_id}>
          <h4>{r.offer.terms.title}・{r.offer.supplier_name}</h4>
          <p>{r.offer.state==='withdrawn'?'供貨版本已撤回':stateWord[r.state]}・零售價 {formatMinor(r.retail_price_minor,r.offer.terms.currency)}</p>
          <Terms offer={r.offer}/>
          {r.state!=='revoked'&&<div className="actions"><button type="button" className="btn btn-ghost" disabled={busy||!writable||!!error} onClick={()=>void command({method:'post',path:root+`/distribution-selections/${r.selection_id}/withdraw`,body:{},version:r.version,schema:DistributionSchema,notice:'已停止採用這項選品；重新發布後，展示頁才會更新。',success:()=>{}})}>停止採用</button></div>}
          {r.offer.state==='offered'&&<PriceForm key={r.version} offer={r.offer} selection={r} busy={busy||!writable||!!error} onDirty={v=>onDirty(r.selection_id,v)} onSubmit={body=>command({method:'patch',path:root+`/distribution-selections/${r.selection_id}`,body,version:r.version,schema:DistributionSchema,notice:'已送出新售價，等待供應商重新確認。',success:()=>onDirty(r.selection_id,false)})}/>}
          {r.offer.state==='withdrawn'&&data.catalog.filter(o=>o.product_id===r.offer.product_id).map(o=><PriceForm key={o.offer_id} offer={o} selection={r} busy={busy||!writable||!!error} onDirty={v=>onDirty(r.selection_id,v)} onSubmit={body=>command({method:'patch',path:root+`/distribution-selections/${r.selection_id}`,body,version:r.version,schema:DistributionSchema,notice:'已申請新供貨版本，等待供應商確認。',success:()=>onDirty(r.selection_id,false)})}/>)}
        </article>)}
      </details>
      <details><summary>選用其他商店的商品</summary>
        {!data.catalog.length&&<p>目前沒有其他店主公開的同幣別供貨商品。</p>}
        {data.catalog.length>0&&data.catalog.every(o=>data.selections.some(s=>s.offer.product_id===o.product_id))&&<p>目前可選的商品都已加入「我的選品」。</p>}
        {data.catalog.filter(o=>!data.selections.some(s=>s.offer.product_id===o.product_id)).map(o=><article className="hosted-distribution-item stack" key={o.offer_id}>
          <h4>{o.terms.title}・{o.supplier_name}</h4><p>{o.terms.description}</p><Terms offer={o}/>
          {editing===o.offer_id?<><PriceForm offer={o} busy={busy||!writable||!!error} onDirty={v=>onDirty(o.offer_id,v)} onSubmit={body=>command({method:'post',path:root+'/distribution-selections',body,schema:DistributionSchema,notice:'已送出選品，等待供應商確認。',success:()=>{onDirty(o.offer_id,false);setEditing(null);}})}/><div className="actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{onDirty(o.offer_id,false);setEditing(null);}}>取消選品</button></div></>:<div className="actions"><button type="button" className="btn btn-ghost" disabled={busy||!writable||!!error||editing!==null} onClick={()=>setEditing(o.offer_id)}>設定我的售價</button></div>}
        </article>)}
      </details>
      {data.truncated&&<p className="field-hint">目前只顯示部分供貨與申請，這份清單尚未包含全部資料。</p>}
    </>}
  </section>;
}
function Terms({offer:o}:{offer:SupplyOffer}) {
  return <div><p>供貨單價 {formatMinor(o.terms.cost_minor,o.terms.currency)}・每件運費 {formatMinor(o.terms.shipping_minor,o.terms.currency)}</p>
    <p>出貨：{o.terms.shipping_terms}</p><p>退貨：{o.terms.return_terms}</p></div>;
}
function PriceForm({offer,selection,busy,onDirty,onSubmit}:{offer:SupplyOffer;selection?:Distribution;busy:boolean;onDirty:(value:boolean)=>void;onSubmit:(body:unknown)=>Promise<void>}) {
  const initial=selection?String(selection.retail_price_minor/100):'';
  const [price,setPrice]=useState(initial),[error,setError]=useState('');
  const dirtyRef=useRef(onDirty); dirtyRef.current=onDirty;
  useEffect(()=>{dirtyRef.current(price!==initial);},[price,initial]);
  useEffect(()=>()=>dirtyRef.current(false),[]);
  async function submit(e:FormEvent) {
    e.preventDefault();setError('');
    try{const body=DistributionInputSchema.parse({offer_id:offer.offer_id,terms_sha256:offer.terms_sha256,retail_price_minor:parseMajorToMinor(price)});await onSubmit(body);}
    catch{setError('請填寫有效的零售價。');}
  }
  return <form className="hosted-store-form stack" aria-label={`${offer.terms.title}選品售價`} onSubmit={e=>void submit(e)}>
    <label className="field">我的零售價（{offer.terms.currency}）<input inputMode="decimal" required value={price} disabled={busy} onChange={e=>setPrice(e.target.value)}/></label>
    {error&&<p role="alert">{error}</p>}
    <div className="actions"><button className="btn btn-ghost" disabled={busy||(!!selection&&price===initial&&selection.offer.offer_id===offer.offer_id&&!['revoked','declined'].includes(selection.state))}>送出供貨申請</button></div>
  </form>;
}
