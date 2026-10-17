import type {SupplyMaterials} from '../../../../../contracts/guild-launchpad/v1/supplier-console';
import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {supplierConsoleHref} from '../route';
import {materialAccess,materialCapacityText,materialKind,materialSubject,materialTime} from '../view';
import {ReadStatus,useListRestore} from './Shared';
export function Materials({c}:{c:ConsoleController}){
 const r=c.slot<SupplyMaterials>('materials'),d=r.data,restore=useListRestore(c,'materials',r);
 const items=d?[...d.items].sort((a,b)=>Number(a.state==='withdrawn')-Number(b.state==='withdrawn')):[];
 return <section className="stack sc-material-page"><div className="sc-row"><h2 tabIndex={-1} ref={restore.heading}>行銷素材</h2><div className="actions"><a className="btn btn-primary" href={supplierConsoleHref(c.scope,'material-new')}>新增素材</a></div></div>
  <ReadStatus c={c} name="materials" label="行銷素材"/>
  <section className="card stack"><h3>業務空間容量</h3><p>{materialCapacityText(r.state==='ready'?d?.capacity:undefined)}</p><p className="field-hint">這是整個業務空間的共用容量，包含商品照片與素材的舊版本。</p></section>
  {d&&<><p>使用中 {d.active}／200</p>
   {!items.length&&<div className="stack"><h3>還沒有行銷素材</h3><p>提供品牌或商品的圖片、影片與文案，讓取得授權的合作店家使用。先按「新增素材」建立第一筆。</p></div>}
   <ul className="sc-list">{items.map(m=><li className={`sc-row${m.state==='withdrawn'?' sc-material-withdrawn':''}`} key={m.material_id}><div>
    <span className="badge">{materialKind(m.kind)}</span> <a data-sc-item={m.material_id} href={supplierConsoleHref(c.scope,'material',{id:m.material_id})} onClick={()=>restore.open(m.material_id)}>{m.title}</a>
    <p>{materialSubject(m.subject)}</p><p>{materialAccess(m.access)} · {m.state==='active'?'使用中':'已撤回'}</p>
    <p>{m.current?`第 ${m.current.version_no} 版・${materialTime(m.current.created_at)}（台灣時間）`:'尚未上傳檔案'}</p><p>已授權 {m.active_grants} 間店</p>
   </div><div className="actions"><a className="btn btn-ghost btn-small" href={supplierConsoleHref(c.scope,'material',{id:m.material_id})}>查看素材<span className="sr-only">：{m.title}</span></a></div></li>)}</ul>
   {d.truncated&&<p>只顯示前 200 筆素材，使用中的素材列在已撤回的素材之前。</p>}
  </>}
 </section>;
}
