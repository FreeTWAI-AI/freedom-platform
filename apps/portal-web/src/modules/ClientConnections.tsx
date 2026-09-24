import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {PortalClient} from '../api';
import {useModuleMutation} from './shared';
import {Status} from './Membership';
import './ModuleDiscovery.css';
type Connection={connection_id:string;kind:'storefront'|'supplier';client_name:string;store_id:string|null;scope:string;expires_at:string;revoked_at:string|null;created_at:string;aggregate_version:number};
type Pending={user_code:string;kind:'storefront'|'supplier';client_name:string;scope:string;expires_at:string;state:string};
const message=(e:unknown,fallback:string)=>e instanceof Error?e.message:fallback;
export function ClientConnections({client}:{client:PortalClient}){
  const [connections,setConnections]=useState<Connection[]>([]),[listLoading,setListLoading]=useState(true),[listError,setListError]=useState('');
  const [code,setCode]=useState(''),[preview,setPreview]=useState<Pending|null>(null),[stores,setStores]=useState<{store_id:string;name:string}[]>([]),[storeId,setStoreId]=useState(''),[lookupError,setLookupError]=useState(''),[notice,setNotice]=useState(''),[looking,setLooking]=useState(false);
  // Only the newest list load / code lookup may write state, so a slow older response cannot replace a newer one.
  const loadSeq=useRef(0),lookupSeq=useRef(0);
  const {mutate,busy,error}=useModuleMutation(client);
  async function load(){const seq=++loadSeq.current;setListLoading(true);setListError('');try{const data=await client.get<{items:Connection[]}>('/me/client-connections');if(seq===loadSeq.current)setConnections(data.items);}catch(e){if(seq===loadSeq.current)setListError(message(e,'暫時無法載入讀取連線。'));}finally{if(seq===loadSeq.current)setListLoading(false);}}
  useEffect(()=>{void load();},[client]);
  async function lookup(event:FormEvent){
    event.preventDefault();const seq=++lookupSeq.current,current=()=>seq===lookupSeq.current;
    setLooking(true);setPreview(null);setStores([]);setStoreId('');setLookupError('');setNotice('');
    try{const value=await client.get<Pending>(`/client-connections/${encodeURIComponent(code.trim())}`);if(!current())return;
      const items=value.kind==='storefront'?(await client.get<{items:{store_id:string;name:string}[]}>('/retail/stores')).items:[];if(!current())return;
      setStores(items);setPreview(value);
    }catch(e){if(current())setLookupError(message(e,'找不到這組連線代碼。'));}finally{if(current())setLooking(false);}
  }
  async function approve(){if(!preview)return;const result=await mutate(`/client-connections/${encodeURIComponent(preview.user_code)}/approve`,{confirmed:true,...(preview.kind==='storefront'?{store_id:storeId}:{})});if(result){setPreview(null);setCode('');setNotice('讀取連線已核准，請回到你的客戶端繼續。');await load();}}
  return <section className="card stack"><header><p className="eyebrow">CONNECT YOUR CLIENT</p><h3>連接我的客戶端（讀取）</h3></header><p className="muted">只在使用自己啟動的商店或供應端工具時需要：輸入它顯示的一次性代碼。連線只能讀取，刊登與修改仍在工坊操作。</p><Status error={lookupError||error} notice={notice}/><form className="connection-code" onSubmit={lookup}><label className="field">客戶端一次性代碼<input value={code} onChange={e=>setCode(e.target.value)} required maxLength={40} autoComplete="off" spellCheck={false} placeholder="輸入客戶端顯示的代碼"/></label><button className="btn btn-ghost" disabled={looking||busy}>{looking?'正在查詢…':'查看連線請求'}</button></form>{preview&&<div className="card stack"><h4>確認你的連線</h4><p>客戶端：<strong>{preview.client_name}</strong></p><p>讀取範圍：{preview.kind==='storefront'?'你選擇的商店、選品與供貨目錄':'你自己的商品與供貨條件'}</p><p className="muted">代碼期限：{new Date(preview.expires_at).toLocaleString('zh-TW')}</p>{preview.kind==='storefront'&&<label className="field">允許讀取哪一家商店<select value={storeId} onChange={e=>setStoreId(e.target.value)}><option value="">請選擇你的商店</option>{stores.map(store=><option key={store.store_id} value={store.store_id}>{store.name}</option>)}</select>{!stores.length&&<span className="field-hint">先到「開店與銷售」建立商店，再回來查詢代碼。</span>}</label>}<p className="field-hint">只核准你本人剛啟動的客戶端；這裡不會要求密碼或長期金鑰。</p><button className="btn btn-primary" disabled={busy||preview.state!=='pending'||(preview.kind==='storefront'&&!storeId)} onClick={()=>void approve()}>確認並允許這次讀取連線</button></div>}<h4>我的讀取連線</h4>{listError&&<><Status error={listError}/><button className="btn btn-ghost" disabled={listLoading} onClick={()=>void load()}>重新載入讀取連線</button></>}{listLoading&&<p role="status" className="muted">正在載入讀取連線…</p>}{connections.map(connection=><article className="connection-row" key={connection.connection_id}><div><strong>{connection.client_name}</strong><p className="muted">{connection.kind==='storefront'?'商店':'供應端'} · {connection.revoked_at?'已撤銷':new Date(connection.expires_at).getTime()<Date.now()?'已到期':'已授權讀取'}</p></div>{!connection.revoked_at&&<button className="btn btn-ghost" disabled={busy} onClick={async()=>{const result=await mutate(`/me/client-connections/${connection.connection_id}/revoke`,{},connection.aggregate_version);if(result){setNotice('讀取連線已撤銷。');await load();}}}>撤銷連線</button>}</article>)}{!listLoading&&!listError&&!connections.length&&<p className="muted">目前沒有客戶端連線。</p>}</section>;
}
