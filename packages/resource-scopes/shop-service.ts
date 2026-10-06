import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {requireCondition} from '../shared/problem.js';
import type {PrincipalRef,ResourceScopeRef} from '../../contracts/common/v1/identity.js';

export const SHOP_KEY_PROFILE='freedom.shop-service-key/v1';
export type ShopKeyPolicy='legacy-compatible'|'purpose-bound-only';
export interface ShopServiceHost {
 readonly environment:'local'|'staging'|'public';readonly issuer:string;readonly audience:string;
 readonly purpose:'shop-api';readonly policy:ShopKeyPolicy|undefined;
}
/** Installed host configuration only. Missing policy closes shop credentials;
 * it cannot implicitly permit unbound legacy keys on an upgraded deployment. */
export function shopServiceHost(environment:'local'|'staging'|'public',origin:string,policy?:string):ShopServiceHost {
 const url=new URL(origin);
 requireCondition(['local','staging','public'].includes(environment)&&url.origin===origin
  && (environment==='local'?url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname):url.protocol==='https:')
  && (policy===undefined||policy==='legacy-compatible'||policy==='purpose-bound-only'),
  503,'shop_auth_not_configured','商店連線設定尚未完成。');
 return Object.freeze({environment,issuer:origin,audience:origin+'/shop-api/v1',purpose:'shop-api',policy});
}
export function requireShopHost(host:ShopServiceHost){
 requireCondition(host.policy==='legacy-compatible'||host.policy==='purpose-bound-only',503,'shop_auth_not_configured','商店連線設定尚未完成。');
}
interface Shop {shop_id:string;owner_id:string;community_id:string;[key:string]:any}
export interface ShopServiceContext {
 readonly authn_kind:'shop_service_key';readonly subject_principal:Readonly<PrincipalRef>;
 readonly scope:Readonly<ResourceScopeRef>;readonly shop:Readonly<Shop>;readonly credentialId:string;
}
export interface LegacyShopContext {readonly authn_kind:'legacy_shop_key';readonly shop:Readonly<Shop>}
export type ShopContext=ShopServiceContext|LegacyShopContext;
const live=new WeakMap<ShopContext,{q:PoolClient;hash:string;host:ShopServiceHost}>();
const invalid=()=>requireCondition(false,401,'shop_key_invalid','商店連線已失效。');
function binding(row:any,host:ShopServiceHost,version:'legacy'|'v2'){
 if(version==='legacy')return host.policy==='legacy-compatible'&&row.credential_profile==='legacy-shop-key/v1'
  &&[row.purpose,row.issuer,row.audience,row.environment].every(x=>x===null);
 return row.credential_profile===SHOP_KEY_PROFILE&&row.purpose===host.purpose&&row.issuer===host.issuer
  &&row.audience===host.audience&&row.environment===host.environment;
}
/** Current SQL authority on the caller's transaction, never a member session.
 * Caller must forget the context on both commit and rollback. No I/O here. */
export async function lockShopService(q:PoolClient,authorization:string|undefined,host:ShopServiceHost):Promise<ShopContext>{
 requireShopHost(host);
 const version=typeof authorization==='string'&&/^Bearer fw_shop_v2_[A-Za-z0-9_-]{43}$/.test(authorization)?'v2':
  typeof authorization==='string'&&/^Bearer fw_shop_[A-Za-z0-9_-]{43}$/.test(authorization)?'legacy':null;
 if(!version)invalid();
 const hash=createHash('sha256').update(authorization!.slice(7)).digest('hex');
 const owner=(await q.query('SELECT s.owner_id,s.community_id FROM commerce_shop_keys k JOIN commerce_shops s USING(shop_id) WHERE k.token_hash=$1',[hash])).rows[0];
 if(!owner)invalid();
 const user=await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) FOR SHARE',[owner.owner_id,owner.community_id]);
 if(user.rowCount!==1)invalid();
 const row=(await q.query(`SELECT k.*,s.owner_id,s.community_id FROM commerce_shop_keys k JOIN commerce_shops s USING(shop_id)
  WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp() FOR SHARE OF k`,[hash])).rows[0];
 if(!row||row.owner_id!==owner.owner_id||row.community_id!==owner.community_id||!binding(row,host,version!))invalid();
 let principal:any,scope:any;
 if(version==='v2'){
  principal=(await q.query('SELECT principal_id,status FROM principals WHERE service_shop_ref=$1 FOR SHARE',[row.shop_id])).rows[0];
  if(!principal){await q.query("INSERT INTO principals(kind,service_shop_ref) VALUES('service',$1) ON CONFLICT(service_shop_ref) DO NOTHING",[row.shop_id]);
   principal=(await q.query('SELECT principal_id,status FROM principals WHERE service_shop_ref=$1 FOR SHARE',[row.shop_id])).rows[0];}
  if(!principal||principal.status!=='active')invalid();
  scope=(await q.query("SELECT scope_id,service_principal_id,status FROM resource_scopes WHERE site_shop_ref=$1 AND kind='site' FOR SHARE",[row.shop_id])).rows[0];
  if(!scope){await q.query("INSERT INTO resource_scopes(kind,site_shop_ref,service_principal_id) VALUES('site',$1,$2) ON CONFLICT(site_shop_ref) DO NOTHING",[row.shop_id,principal.principal_id]);
   scope=(await q.query("SELECT scope_id,service_principal_id,status FROM resource_scopes WHERE site_shop_ref=$1 AND kind='site' FOR SHARE",[row.shop_id])).rows[0];}
  if(!scope||scope.service_principal_id!==principal.principal_id||scope.status!=='active')invalid();
 }
 // Preserve the existing commerce ordering lock before locking mutable shop
 // state, so a pause already holding that lock can finish its shop UPDATE.
 await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commerce-orders/${row.community_id}`]);
 const shop=(await q.query('SELECT * FROM commerce_shops WHERE shop_id=$1 FOR SHARE',[row.shop_id])).rows[0];
 if(!shop||shop.owner_id!==owner.owner_id||shop.community_id!==owner.community_id)invalid();
 const context:ShopContext=version==='v2'?Object.freeze({authn_kind:'shop_service_key',
  subject_principal:Object.freeze({principal_id:principal.principal_id,kind:'service' as const}),
  scope:Object.freeze({scope_id:scope.scope_id,kind:'site' as const}),shop:Object.freeze(shop),credentialId:row.credential_id}):
  Object.freeze({authn_kind:'legacy_shop_key',shop:Object.freeze(shop)});
 live.set(context,{q,hash,host});
 try{await assertShopServiceClock(q,context);return context;}catch(error){live.delete(context);throw error;}
}
export async function assertShopServiceClock(q:PoolClient,context:ShopContext){
 const state=live.get(context);if(!state||state.q!==q)invalid();
 const row=(await q.query(`SELECT * FROM commerce_shop_keys WHERE shop_id=$1 AND token_hash=$2
  AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[context.shop.shop_id,state!.hash])).rows[0];
 if(!row||!binding(row,state!.host,context.authn_kind==='shop_service_key'?'v2':'legacy'))invalid();
}
export function forgetShopService(context:ShopContext|undefined){if(context)live.delete(context);}
