import {randomBytes} from 'node:crypto';
import type {PoolClient} from 'pg';
import {parse} from 'hono/utils/cookie';
import {Problem,requireCondition} from '../../../packages/shared/problem.js';
import {hashKey} from './terms.js';

export const shopCookieName=(origin:string)=>new URL(origin).protocol==='https:'?'__Host-freedom_shop':'freedom_local_shop';
export function readShopCookie(header:string|undefined,origin:string) {
  const name=shopCookieName(origin),cookies=header??'';
  const count=cookies.split(';').filter(pair=>pair.includes('=')&&pair.slice(0,pair.indexOf('=')).trim()===name).length;
  requireCondition(count<=1,403,'credential_kind_rejected','瀏覽器 Cookie 不明確。');
  return parse(cookies,name)[name];
}
export function shopCookie(origin:string,value:string,maxAge:number) {
  return `${shopCookieName(origin)}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${new URL(origin).protocol==='https:'?'; Secure':''}`;
}
export interface AccessDevice {device_id:string;expires_at:Date;remaining:number}
const credential=/^[A-Za-z0-9_-]{43}$/;
/** Reads never refresh a credential or record usage. Write commands hold a
 * shared lock against forget, then recheck the database clock before commit. */
export async function liveDevice(q:PoolClient,token:string|undefined,lock=false):Promise<AccessDevice|null> {
  if(!token||!credential.test(token))return null;
  return (await q.query<AccessDevice>(`SELECT device_id,expires_at,greatest(0,floor(extract(epoch FROM expires_at-clock_timestamp())))::int AS remaining
    FROM commerce_access_devices WHERE token_sha256=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() ${lock?'FOR SHARE':''}`,[hashKey(token)])).rows[0]??null;
}
export async function ensureDevice(q:PoolClient,token:string|undefined,origin:string) {
  const old=await liveDevice(q,token,true);
  if(old)return {device:old,cookie:shopCookie(origin,token!,old.remaining)};
  const value=randomBytes(32).toString('base64url');
  const device=(await q.query<AccessDevice>(`INSERT INTO commerce_access_devices(token_sha256,created_at,expires_at)
    SELECT $1,t,t+interval '4320 hours' FROM (SELECT date_trunc('milliseconds',clock_timestamp()) t) n
    RETURNING device_id,expires_at,floor(extract(epoch FROM expires_at-clock_timestamp()))::int AS remaining`,[hashKey(value)])).rows[0];
  return {device,cookie:shopCookie(origin,value,device.remaining)};
}
export async function grantDevice(q:PoolClient,deviceId:string,target:{tenant_id:string;instance_id:string;checkout_id:string},orderId:string|null=null) {
  await q.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,order_id,kind,device_id)
    VALUES($1,$2,$3,$4,'device',$5) ON CONFLICT DO NOTHING`,[target.tenant_id,target.instance_id,target.checkout_id,orderId,deviceId]);
}
export async function hasDeviceGrant(q:PoolClient,deviceId:string,checkoutId:string,orderId:string|null=null) {
  return (await q.query(`SELECT 1 FROM commerce_order_access_grants g JOIN commerce_access_devices d USING(device_id)
    WHERE g.device_id=$1 AND g.checkout_id=$2 AND g.kind='device' AND g.revoked_at IS NULL
      AND d.revoked_at IS NULL AND d.expires_at>clock_timestamp() AND (g.order_id IS NULL OR g.order_id=$3) LIMIT 1`,[deviceId,checkoutId,orderId])).rowCount===1;
}
export function orderAccessNotFound():never {throw new Problem(404,'checkout_order_not_found','找不到訂單。');}
export async function assertDeviceLive(q:PoolClient,deviceId:string) {
  if((await q.query('SELECT 1 FROM commerce_access_devices WHERE device_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[deviceId])).rowCount!==1)orderAccessNotFound();
}
export async function createAccessLink(q:PoolClient,target:{tenant_id:string;instance_id:string;checkout_id:string;order_id:string}) {
  const token=randomBytes(32).toString('base64url');
  await q.query(`INSERT INTO commerce_order_access_grants(tenant_id,instance_id,checkout_id,order_id,kind,link_token_sha256,created_at,expires_at)
    SELECT $1,$2,$3,$4,'link',$5,t,t+interval '168 hours' FROM (SELECT date_trunc('milliseconds',clock_timestamp()) t) n`,
  [target.tenant_id,target.instance_id,target.checkout_id,target.order_id,hashKey(token)]);
  return token;
}
export async function redeemAccessLink(q:PoolClient,target:{tenant_id:string;instance_id:string;order_id:string},token:string) {
  if(!credential.test(token))return orderAccessNotFound();
  // UPDATE may evaluate its clock predicate and SET value before waiting on a
  // concurrent redemption that rolls back. Lock the immutable identity first;
  // the separate statement below makes its decision using the post-lock clock.
  const locked=(await q.query<{grant_id:string}>(`SELECT grant_id FROM commerce_order_access_grants
    WHERE tenant_id=$1 AND instance_id=$2 AND order_id=$3 AND kind='link' AND link_token_sha256=$4 FOR UPDATE`,
  [target.tenant_id,target.instance_id,target.order_id,hashKey(token)])).rows[0];
  if(!locked)orderAccessNotFound();
  const row=(await q.query<{grant_id:string;checkout_id:string}>(`UPDATE commerce_order_access_grants SET redeemed_at=clock_timestamp()
    WHERE tenant_id=$1 AND instance_id=$2 AND order_id=$3 AND kind='link' AND link_token_sha256=$4
      AND grant_id=$5 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING grant_id,checkout_id`,
  [target.tenant_id,target.instance_id,target.order_id,hashKey(token),locked.grant_id])).rows[0];
  if(!row)orderAccessNotFound();
  return row!;
}
/** The redemption transaction still owns this link's row lock. A later device
 * or order wait must not let an expired link commit its new browser grant. */
export async function assertAccessLinkLive(q:PoolClient,grantId:string) {
  if((await q.query(`SELECT 1 FROM commerce_order_access_grants WHERE grant_id=$1 AND kind='link'
    AND redeemed_at IS NOT NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[grantId])).rowCount!==1)orderAccessNotFound();
}
export async function forgetDevice(q:PoolClient,token:string|undefined) {
  if(token&&credential.test(token))await q.query(`UPDATE commerce_access_devices SET revoked_at=clock_timestamp()
    WHERE token_sha256=$1 AND revoked_at IS NULL`,[hashKey(token)]);
}
