import {useEffect,useRef} from 'react';
import type {PortalClient} from '../../../../apps/portal-web/src/api';
import {useSupplierConsoleController,type RegisterLeave} from '../state/useSupplierConsoleController';
import {SUPPLIER_CONSOLE_PAGES,consoleNavigation,supplierConsoleHref,type SupplierConsoleRoute} from './route';
import {Materials} from './pages/Materials';
import {MaterialNew} from './pages/MaterialNew';
import {Material} from './pages/Material';
import {Reports} from './pages/Reports';
import {Overview} from './pages/Overview';
import {Products,NewProduct} from './pages/Products';
import {Product} from './pages/Product';
import {Partners,Partner} from './pages/Partners';
import {Terms,Review} from './pages/Terms';
import {Reservations,Reservation} from './pages/Reservations';
import {Settings,Setup} from './pages/Settings';
import {ReadStatus,WriteAccess} from './pages/Shared';
import {fieldLabels,attemptFieldText} from './view';
import {ConsoleShell} from '../../hosted-ui/ConsoleShell';
import './SupplierConsole.css';
const NAV_GROUPS=['營運','合作','管理'] as const;
export function SupplierConsole({client,userId,route,registerLeave,photosEnabled=false,photoUploadsEnabled=false,materialMediaEnabled=false,materialUploadsEnabled=false}:{client:PortalClient;userId:string;route:SupplierConsoleRoute;registerLeave:RegisterLeave;photosEnabled?:boolean;photoUploadsEnabled?:boolean;materialMediaEnabled?:boolean;materialUploadsEnabled?:boolean}){
 const c=useSupplierConsoleController({client,userId,scope:route,route,registerLeave,photosEnabled}),profile=c.profile,r=c.slot('profile'),ready=profile?.setup_state==='ready';
 const pages=consoleNavigation(profile?.capabilities??[],c.ownerAllowed),current=SUPPLIER_CONSOLE_PAGES.find(p=>p.page===route.page)!,selected=current.parent??current.page;
 const content=useRef<HTMLDivElement>(null),previous=useRef(route.page+':'+route.id),retry=useRef<HTMLButtonElement>(null),focused=useRef<{el:HTMLElement;section:Element|null;lost:boolean}|null>(null);
 useEffect(()=>{const key=route.page+':'+route.id;if(previous.current!==key){content.current?.querySelector<HTMLElement>('[data-sc-active="true"] h2')?.focus();previous.current=key;}},[route.page,route.id]);
 // Keyboard focus must not fall to the page when the console disables or removes the focused control during a write or
 // read: return to it once usable, or after the work settles go to its section heading (else the page h2), or to 重試
 // while an outcome is unknown. Focus the member moved elsewhere is left alone.
 useEffect(()=>{const frame=requestAnimationFrame(()=>{
  const f=focused.current,active=document.activeElement;if(!f)return;
  if(active&&active!==f.el&&active!==document.body){focused.current=null;return;}
  const usable=f.el.isConnected&&!f.el.matches(':disabled')&&f.el.getClientRects().length>0;if(!usable)f.lost=true;
  if(!f.lost||active===f.el)return;
  if(usable){focused.current=null;f.el.focus({preventScroll:true});return;}
  if(c.phase==='sending'||Object.values(c.reads).some(r=>r.state==='loading'))return;
  focused.current=null;
  const target=(c.phase==='held'?retry.current:f.section?.isConnected?f.section.querySelector<HTMLElement>('h3'):null)??content.current?.querySelector<HTMLElement>('[data-sc-active="true"] h2');
  if(target){if(!target.hasAttribute('tabindex'))target.tabIndex=-1;target.focus();}
 });return()=>cancelAnimationFrame(frame);});
 const href=(page:Parameters<typeof supplierConsoleHref>[1])=>supplierConsoleHref(route,page);
 const nav=pages.map(p=>({key:p.page,label:p.label,group:p.group!,href:href(p.page)}));
 const page=route.page==='materials'?<Materials c={c}/>:route.page==='material-new'?<MaterialNew c={c}/>:route.page==='overview'?<Overview c={c}/>:route.page==='products'?<Products c={c}/>:route.page==='product-new'?<NewProduct c={c}/>:route.page==='partners'?<Partners c={c}/>:route.page==='partner'?<Partner c={c}/>:route.page==='terms'?<Terms c={c}/>:route.page==='review'?<Review c={c}/>:route.page==='reservations'?<Reservations c={c}/>:route.page==='reservation'?<Reservation c={c}/>:route.page==='reports'?<Reports c={c}/>:route.page==='settings'?<Settings c={c}/>:route.page==='not-found'?<section className="stack"><h2 tabIndex={-1}>找不到這個頁面</h2><div className="actions"><a className="btn btn-ghost" href={href('overview')}>回到營運概覽</a></div></section>:null;
 const materialIds=[...new Set([...Object.keys(c.reads).filter(k=>k.startsWith('material:')).map(k=>k.slice(9)),...Object.keys(c.materialStates),...(route.page==='material'?[route.id!]:[])])];
 const productIds=[...new Set([...Object.keys(c.reads).filter(k=>k.startsWith('product:')).map(k=>k.slice(8)),...(route.page==='product'?[route.id!]:[])])];
 return <div className="supplier-console stack" onFocus={e=>{const el=e.target as HTMLElement;focused.current={el,section:el.closest('.sc-section'),lost:false};}}>
  <div className="sc-business-bar"><div><strong>{profile?.catalog?.name??'尚未完成設定的商品庫'}</strong>{profile&&<span className="badge">{profile.retail_enabled?'已開零售':'純供貨'}</span>}</div><div className="actions"><a className="btn btn-ghost" href="#stores/supply">切換事業</a><a className="btn btn-ghost" href="#guilds/guild_product_quality_supply">返回公會</a>{profile?.retail_enabled&&<a className="btn btn-ghost" href={`#stores/${route.tenantId}/${route.instanceId}`}>前往商店</a>}</div></div>
  <p className="sc-announcement" role="status" aria-live="polite">{c.notice}</p>{c.error&&<p className="banner banner-error" role="alert">{c.error}</p>}
  {c.refused&&profile&&r.state==='failed'&&<div className="banner stack"><p>確認目前權限前暫停寫入。</p><ReadStatus c={c} name="profile" label="目前權限"/></div>}
  {c.attempt&&<div className="banner stack" role="status"><p>{c.phase==='sending'?`正在確認原操作：${c.attempt.label}。`:`尚未確認原操作的結果：${c.attempt.label}。請按『重試』確認。`}</p>{c.phase==='held'&&<div className="actions"><button ref={retry} type="button" className="btn btn-ghost" onClick={c.retry}>重試</button></div>}</div>}
  {Object.entries(c.photoStates).filter(([,s])=>s.blocking).map(([id])=><div className="banner stack" role="status" key={id}><p>尚未確認原照片操作的結果，請回到商品照片確認。</p><div className="actions"><a className="btn btn-ghost" href={supplierConsoleHref(route,'product',{id})}>回到商品照片</a></div></div>)}
  {Object.entries(c.materialStates).filter(([,s])=>s.blocking).map(([id])=><div className="banner stack" role="status" key={id}><p>尚未確認上傳結果。檔案仍保留，請按重試原操作確認後再離開。</p><div className="actions"><a className="btn btn-ghost btn-small" href={supplierConsoleHref(route,'material',{id})}>回到素材上傳</a></div></div>)}
  {c.rejected&&<details><summary>原操作內容（冪等鍵衝突）</summary><p>{c.rejected.label} · 版本 {c.rejected.ifMatch??'建立操作'}</p><dl className="detail-list">{Object.entries(c.rejected.body).map(([field,value])=><div key={field}><dt>{fieldLabels[field]??field}</dt><dd>{attemptFieldText(field,value,profile?.catalog?.currency??'TWD')}</dd></div>)}</dl></details>}
  {c.pendingReads.length>0&&<div className="banner stack"><p>已保存，資料仍待更新；暫停寫入，請重試讀取。</p>{c.pendingReads.map(key=><ReadStatus key={key} c={c} name={key} label="保存後的資料"/>)}</div>}
  {!profile?<section className="stack"><h2 tabIndex={-1}>{r.status===404?'找不到這個供貨商品庫':r.status===403?'沒有查看商品庫的權限':'供貨商品庫'}</h2><ReadStatus c={c} name="profile" label="供貨商品庫"/></section>:<>
  {c.owner.state==='failed'&&ready&&<div className="sc-owner-note"><p>暫時無法確認預留權限；只有確認為擁有者後才顯示入口。</p><div className="actions"><button className="btn btn-ghost" onClick={()=>void c.read('owner')}>重試確認預留權限</button></div></div>}
  {!ready&&<p>請先完成商品庫設定，其他頁面暫時停用。</p>}
  <ConsoleShell label="營運中心" selectLabel="營運中心頁面" groups={NAV_GROUPS} items={nav} current={{key:selected,title:current.title}} enabled={ready} disabledReason="請先完成商品庫設定">
  <div className="sc-content stack" ref={content}>{!ready?<div data-sc-active="true"><Setup c={c}/></div>:<><div data-sc-active={route.page!=='product'&&route.page!=='material'}>{route.page==='material'?null:current.requires==='write'?<WriteAccess c={c}>{page}</WriteAccess>:page}</div>
   {materialIds.map(id=><div key={id} hidden={route.page!=='material'||route.id!==id} data-sc-active={route.page==='material'&&route.id===id}><WriteAccess c={c}><Material c={c} id={id} mediaEnabled={materialMediaEnabled} uploadsEnabled={materialUploadsEnabled} active={route.page==='material'&&route.id===id}/></WriteAccess></div>)}
   {productIds.map(id=><div key={id} hidden={route.page!=='product'||route.id!==id} data-sc-active={route.page==='product'&&route.id===id}><WriteAccess c={c}><Product c={c} id={id} uploadsEnabled={photoUploadsEnabled}/></WriteAccess></div>)}
  </>}</div></ConsoleShell></>}
 </div>;
}
