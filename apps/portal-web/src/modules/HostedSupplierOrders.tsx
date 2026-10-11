import {useEffect,useRef,useState} from 'react';
import {SupplierReservationPageSchema,type SupplierReservationPage} from '../../../../contracts/guild-launchpad/v1/hosted-shared-order';
import {ApiError,type PortalClient} from '../api';
import {formatIsoLocal,formatMinor} from '../format';
import type {SellerRoute} from './hosted-seller-order-state';
import './HostedStore.css';

export function HostedSupplierOrders({client,route}:{client:PortalClient;route:SellerRoute}) {
  const [page,setPage]=useState<SupplierReservationPage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const controller=useRef(new AbortController()),ticket=useRef(0),generation=useRef(client.sessionGeneration);
  const root=`/tenants/${route.tenantId}/storefronts/${route.instanceId}/supply-reservations`;
  useEffect(()=>{
    controller.current=new AbortController();generation.current=client.sessionGeneration;void load();
    return ()=>{controller.current.abort();ticket.current++;};
  },[client,root]);
  async function load(cursor?:string) {
    const current=++ticket.current;setLoading(true);setError('');setPage(null);
    const live=()=>!controller.current.signal.aborted && current===ticket.current && generation.current===client.sessionGeneration;
    try {
      const result=SupplierReservationPageSchema.parse(await client.get(root+'?limit=20'+(cursor?`&cursor=${encodeURIComponent(cursor)}`:''),{signal:controller.current.signal}));
      if(live())setPage(result);
    }catch(cause){if(live())setError(cause instanceof ApiError?cause.message:'暫時無法確認供貨訂單，請重新查詢。');}
    finally{if(live())setLoading(false);}
  }
  return <div className="hosted-store stack">
    <div className="actions"><a className="btn btn-ghost" href={`#stores/${route.tenantId}/${route.instanceId}`}>返回商店後台</a>
      <a className="btn btn-ghost" href={`#stores/${route.tenantId}/${route.instanceId}/orders`}>查看本店預留</a></div>
    <h2>供貨訂單</h2><p className="banner" role="note">只顯示你供應的商品。預留最多 30 分鐘，尚未付款或安排出貨；供貨金額不是請款紀錄。</p>
    <div className="actions"><button className="btn btn-ghost" disabled={loading} onClick={()=>void load()}>更新供貨訂單</button></div>
    <p role="status">{loading?'正在確認供貨訂單…':''}</p>{error&&<p role="alert" className="banner banner-error">{error}</p>}
    {page&&<>{!page.items.length&&<p>這一頁沒有供貨預留。</p>}
      <ul className="stack">{page.items.map(order=><li className="hosted-store-product stack" key={order.order_id}>
        <h3>{order.store.name} · {order.state==='reserved'?'預留中':order.state==='cancelled'?'已取消':'已到期'}</h3>
        <p>預留編號：{order.order_id}</p><p>預留截止：{formatIsoLocal(order.reservation_expires_at)}</p>
        <ul>{order.items.map(line=><li key={line.product_id}>{line.title} × {line.quantity} · 供貨單價 {formatMinor(line.unit_supply_price_minor,order.currency)} · 小計 {formatMinor(line.supply_total_minor,order.currency)}</li>)}</ul>
      </li>)}</ul>
      {page.next_cursor&&<div className="actions"><button className="btn btn-ghost" disabled={loading} onClick={()=>void load(page.next_cursor!)}>較早的供貨預留</button></div>}
    </>}
  </div>;
}
