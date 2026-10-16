import type {ConsoleController} from '../../state/useSupplierConsoleController';
import {HostedReservationSetting} from '../../../../../apps/portal-web/src/modules/HostedReservationSetting';
import {Editor,ReadStatus} from './Shared';
export function ReservationSetting({c}:{c:ConsoleController}){
 const setting=c.owner.data;
 return c.ownerAllowed&&setting?<HostedReservationSetting setting={setting} supplierOnly={!c.profile?.retail_enabled} writable={c.profile?.writable===true} locked={c.locked||c.owner.state!=='ready'} onToggle={()=>c.command({kind:'reservation.toggle',label:setting.reservation_enabled?'停止接受新預留':'開放 30 分鐘預留',method:'patch',path:c.root+'/reservation-setting',body:{reservation_enabled:!setting.reservation_enabled},ifMatch:setting.version,target:c.scope.instanceId})}/>:<p>只有業務空間擁有者可以修改預留設定。</p>;
}
export function Settings({c}:{c:ConsoleController}){
 const p=c.profile,catalog=p?.catalog;
 const abilities=[['store:read','查看商品庫'],['store:write','編輯商品與供貨條件、審核申請'],['store:manage','修改商品庫資料'],['store:publish','公開供貨版本']];
 return <section className="stack"><h2 tabIndex={-1}>設定與資料</h2><ReadStatus c={c} name="profile" label="商品庫資料"/>{catalog&&<>
 <section className="sc-section stack"><h3>商品庫資料</h3>{p.retail_enabled?<><p>這個商品庫已開零售商店，請到商店資料修改名稱與說明</p><div className="actions"><a className="btn btn-ghost" href={`#stores/${c.scope.tenantId}/${c.scope.instanceId}`}>前往商店資料</a></div></>:c.can('store:manage')?<Editor c={c} name="settings:profile" title="儲存商品庫資料" base={{name:catalog.name,description:catalog.description}} version={p.version!} kind="profile.update" path="/supply-profile" target={c.scope.instanceId} fields={[{key:'name',max:80,required:true},{key:'description',multiline:true}]}/>:<><p>你沒有修改商品庫資料的權限，請聯絡業務空間擁有者。</p><dl className="detail-list"><div><dt>名稱</dt><dd>{catalog.name}</dd></div><div><dt>說明</dt><dd>{catalog.description||'未填寫'}</dd></div></dl></>}
 <p>幣別：{catalog.currency}（建立後不可變更）</p></section>
 <section className="sc-section stack"><h3>目前能力</h3><ul>{abilities.map(([key,label])=><li key={key}>{label}：{p.capabilities.includes(key)?'已授予':'未授予'}</li>)}</ul><p>公會身分不授予私人資料。每次讀寫由伺服器重新確認目前權限。</p><div className="actions"><a className="btn btn-ghost" href="#business">團隊與邀請</a></div></section>
 <ReadStatus c={c} name="owner" label="預留設定權限"/><ReservationSetting c={c}/>
 <section className="sc-section stack"><h3>資料用途與界線</h3><p>商品、供貨條件與申請供目前有權限的成員管理；公開供貨版本後，同社群且有選品權限的店家可查看該版本。</p><p>預留不是成交；價差不是佣金。</p><h3>尚未提供</h3><ul><li>完整資料匯出（營運報表的 CSV 不是完整匯出）</li></ul></section>
 </>}</section>;
}
export function Setup({c}:{c:ConsoleController}){return <section className="stack"><h2 tabIndex={-1}>設定供貨商品庫</h2><p>先儲存私人商品與供貨條件，公開供貨版本後再讓店家提出售價。不需要零售商店網址。</p>{c.can('store:manage')?<Editor c={c} name="settings:profile" title="建立供貨商品庫" base={{name:'',description:'',currency:'TWD'}} version="" kind="profile.setup" path="/supply-profile" target={c.scope.instanceId} primary fields={[{key:'name',max:80,required:true},{key:'description',multiline:true},{key:'currency',options:[{value:'TWD',label:'新臺幣 TWD'},{value:'USD',label:'美元 USD'}]}]}><p>幣別建立後不可變更。</p></Editor>:<p>請業務空間擁有者或管理員設定</p>}</section>;}
