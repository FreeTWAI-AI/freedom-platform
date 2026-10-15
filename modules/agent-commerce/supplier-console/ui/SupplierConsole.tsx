import {useEffect,useRef} from 'react';
import type {PortalClient} from '../../../../apps/portal-web/src/api';
import {useSupplierConsoleController,type RegisterLeave} from '../state/useSupplierConsoleController';
import {SUPPLIER_CONSOLE_PAGES,consoleNavigation,supplierConsoleHref,type SupplierConsoleRoute} from './route';
import {Overview} from './pages/Overview';
import {Products,NewProduct} from './pages/Products';
import {Product} from './pages/Product';
import {Partners,Partner} from './pages/Partners';
import {Terms,Review} from './pages/Terms';
import {Reservations} from './pages/Reservations';
import {Settings,Setup} from './pages/Settings';
import {ReadStatus,WriteAccess} from './pages/Shared';
import './SupplierConsole.css';
export function SupplierConsole({client,userId,route,registerLeave,photosEnabled=false,photoUploadsEnabled=false}:{client:PortalClient;userId:string;route:SupplierConsoleRoute;registerLeave:RegisterLeave;photosEnabled?:boolean;photoUploadsEnabled?:boolean}){
 const c=useSupplierConsoleController({client,userId,scope:route,route,registerLeave,photosEnabled}),profile=c.profile,r=c.slot('profile'),ready=profile?.setup_state==='ready';
 const pages=consoleNavigation(profile?.capabilities??[],c.ownerAllowed),current=SUPPLIER_CONSOLE_PAGES.find(p=>p.page===route.page)!,selected=current.parent??current.page;
 const content=useRef<HTMLDivElement>(null),previous=useRef(route.page+':'+route.id);
 useEffect(()=>{const key=route.page+':'+route.id;if(previous.current!==key){content.current?.querySelector<HTMLElement>('[data-sc-active="true"] h2')?.focus();previous.current=key;}},[route.page,route.id]);
 const href=(page:Parameters<typeof supplierConsoleHref>[1])=>supplierConsoleHref(route,page);
 const nav=pages.map(p=>({...p,href:href(p.page)}));
 const page=route.page==='overview'?<Overview c={c}/>:route.page==='products'?<Products c={c}/>:route.page==='product-new'?<NewProduct c={c}/>:route.page==='partners'?<Partners c={c}/>:route.page==='partner'?<Partner c={c}/>:route.page==='terms'?<Terms c={c}/>:route.page==='review'?<Review c={c}/>:route.page==='reservations'?<Reservations c={c}/>:route.page==='settings'?<Settings c={c}/>:route.page==='not-found'?<section className="stack"><h2 tabIndex={-1}>找不到這個頁面</h2><div className="actions"><a className="btn btn-ghost" href={href('overview')}>回到營運概覽</a></div></section>:null;
 const productIds=[...new Set([...Object.keys(c.reads).filter(k=>k.startsWith('product:')).map(k=>k.slice(8)),...(route.page==='product'?[route.id!]:[])])];
 return <div className="supplier-console stack">
  <div className="sc-business-bar"><div><strong>{profile?.catalog?.name??'尚未完成設定的商品庫'}</strong>{profile&&<span className="badge">{profile.retail_enabled?'已開零售':'純供貨'}</span>}</div><div className="actions"><a className="btn btn-ghost" href="#stores/supply">切換事業</a><a className="btn btn-ghost" href="#guilds/guild_product_quality_supply">返回公會</a>{profile?.retail_enabled&&<a className="btn btn-ghost" href={`#stores/${route.tenantId}/${route.instanceId}`}>前往商店</a>}</div></div>
  <p className="sc-announcement" role="status" aria-live="polite">{c.notice}</p>{c.error&&<p className="banner banner-error" role="alert">{c.error}</p>}
  {c.attempt&&<div className="banner stack" role="status"><p>{c.phase==='sending'?`正在確認原操作：${c.attempt.label}。`:`尚未確認原操作的結果：${c.attempt.label}。請按『重試』確認。`}</p>{c.phase==='held'&&<div className="actions"><button type="button" className="btn btn-ghost" onClick={c.retry}>重試</button></div>}</div>}
  {Object.entries(c.photoStates).filter(([,s])=>s.blocking).map(([id])=><div className="banner stack" role="status" key={id}><p>尚未確認原照片操作的結果，請回到商品照片確認。</p><div className="actions"><a className="btn btn-ghost" href={supplierConsoleHref(route,'product',{id})}>回到商品照片</a></div></div>)}
  {c.rejected&&<details><summary>原操作內容（冪等鍵衝突）</summary><p>{c.rejected.label} · 版本 {c.rejected.ifMatch??'建立操作'}</p><pre>{JSON.stringify(c.rejected.body,null,2)}</pre></details>}
  {c.pendingReads.length>0&&<div className="banner stack"><p>已保存，資料仍待更新；暫停寫入，請重試讀取。</p>{c.pendingReads.map(key=><ReadStatus key={key} c={c} name={key} label="保存後的資料"/>)}</div>}
  {!profile?<section className="stack"><h2 tabIndex={-1}>{r.status===404?'找不到這個供貨商品庫':r.status===403?'沒有查看商品庫的權限':'供貨商品庫'}</h2><ReadStatus c={c} name="profile" label="供貨商品庫"/></section>:<>
  {c.owner.state==='failed'&&ready&&<div className="sc-owner-note"><p>暫時無法確認預留權限；只有確認為擁有者後才顯示入口。</p><div className="actions"><button className="btn btn-ghost" onClick={()=>void c.read('owner')}>重試確認預留權限</button></div></div>}
  {!ready&&<p>請先完成商品庫設定，其他頁面暫時停用。</p>}
  <div className="sc-layout"><nav className="sc-nav" aria-label="營運中心">{(['營運','合作','管理'] as const).map(group=><div className="sc-nav-group" key={group}><p>{group}</p>{nav.filter(p=>p.group===group).map(p=>ready?<a key={p.page} href={p.href} aria-current={selected===p.page?'page':undefined}>{p.label}</a>:<span key={p.page} aria-disabled="true" title="請先完成商品庫設定">{p.label}</span>)}</div>)}</nav>
  <label className="sc-mobile-nav field">營運中心頁面<select disabled={!ready} value={nav.find(p=>p.page===selected)?.href??''} onChange={e=>{window.location.hash=e.target.value;}}>{!nav.some(p=>p.page===selected)&&<option value="" disabled>{current.title}</option>}{(['營運','合作','管理'] as const).map(group=><optgroup key={group} label={group}>{nav.filter(p=>p.group===group).map(p=><option key={p.page} value={p.href}>{p.label}</option>)}</optgroup>)}</select></label>
  <div className="sc-content stack" ref={content}>{!ready?<div data-sc-active="true"><Setup c={c}/></div>:<><div data-sc-active={route.page!=='product'}>{current.requires==='write'?<WriteAccess c={c}>{page}</WriteAccess>:page}</div>
   {productIds.map(id=><div key={id} hidden={route.page!=='product'||route.id!==id} data-sc-active={route.page==='product'&&route.id===id}><WriteAccess c={c}><Product c={c} id={id} uploadsEnabled={photoUploadsEnabled}/></WriteAccess></div>)}
  </>}</div></div></>}
 </div>;
}
