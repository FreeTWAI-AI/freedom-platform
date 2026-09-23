import { randomBytes,randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool,PoolClient } from 'pg';
import { command,checkVersion,transaction,type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { tokenHash,type Actor } from '../identity-membership/service.js';
import { authRateLimit } from '../identity-membership/members.js';

const StartInput=z.object({kind:z.enum(['storefront','supplier']),client_name:z.string().trim().min(1).max(80).refine(v=>!/[\x00-\x1f\x7f]/.test(v))}).strict();
const PollInput=z.object({device_secret:z.string().regex(/^fw_pair_[A-Za-z0-9_-]{43}$/)}).strict();
const ApprovalInput=z.object({confirmed:z.literal(true),store_id:z.uuid().optional()}).strict();
const normalizeCode=(raw:string)=>raw.replace(/-/g,'').toUpperCase();
const approvedFields='connection_id,client_name,kind,scope,store_id,aggregate_version,created_at,expires_at,revoked_at';
const limited={read_only:true,checkout_enabled:false,money_movement_enabled:false,official:false,confirmation_kind:'internal_preview'};

export async function startClientPairing(pool:Pool,raw:unknown,platformOrigin:string,network:string){
 await authRateLimit(pool,'client-pairing-start-network',network,10,900);
 await authRateLimit(pool,'client-pairing-start-global','global',100,60);
 const body=StartInput.parse(raw),deviceSecret='fw_pair_'+randomBytes(32).toString('base64url');
 const userCode=randomBytes(10).toString('hex').toUpperCase().match(/.{1,5}/g)!.join('-');
 const origin=new URL(platformOrigin);requireCondition(origin.protocol==='https:'||origin.hostname==='127.0.0.1'||origin.hostname==='localhost',500,'platform_origin_invalid','平台連線網址尚未設定。');
 await pool.query('INSERT INTO client_pairing_requests(pairing_id,device_secret_hash,user_code_hash,kind,client_name) VALUES($1,$2,$3,$4,$5)',[randomUUID(),tokenHash(deviceSecret),tokenHash(normalizeCode(userCode)),body.kind,body.client_name]);
 return {device_secret:deviceSecret,user_code:userCode,verification_uri:origin.origin+'/#account',expires_in:300,interval:5,scope:body.kind+':read'};
}
export async function pollClientPairing(pool:Pool,raw:unknown,network:string){
 await authRateLimit(pool,'client-pairing-poll-network',network,120,60);
 await authRateLimit(pool,'client-pairing-poll-global','global',1200,60);
 const body=PollInput.parse(raw);
 return transaction(pool,async q=>{
   const pending=(await q.query('SELECT * FROM client_pairing_requests WHERE device_secret_hash=$1 FOR UPDATE',[tokenHash(body.device_secret)])).rows[0];
   if(!pending||new Date(pending.expires_at).getTime()<=Date.now()||pending.state==='issued')return {status:'invalid_grant'} as const;
   if(pending.last_polled_at&&Date.now()-new Date(pending.last_polled_at).getTime()<5000)return {status:'slow_down',interval:5} as const;
   await q.query('UPDATE client_pairing_requests SET last_polled_at=now() WHERE pairing_id=$1',[pending.pairing_id]);
   if(pending.state==='pending')return {status:'authorization_pending',interval:5} as const;
   const connection=(await q.query(`SELECT c.* FROM member_client_connections c JOIN users u ON u.user_id=c.user_id AND u.community_id=c.community_id
      WHERE c.connection_id=$1 AND c.revoked_at IS NULL AND c.expires_at>now() AND u.active AND u.onboarding_completed_at IS NOT NULL FOR UPDATE OF c`,[pending.connection_id])).rows[0];
   if(!connection)return {status:'invalid_grant'} as const;
   const token='fw_read_'+randomBytes(32).toString('base64url');
   await q.query('UPDATE member_client_connections SET token_hash=$2 WHERE connection_id=$1',[connection.connection_id,tokenHash(token)]);
   await q.query("UPDATE client_pairing_requests SET state='issued' WHERE pairing_id=$1",[pending.pairing_id]);
   return {status:'authorized',access_token:token,token_type:'Bearer',connection_id:connection.connection_id,scope:connection.scope,
     store_id:connection.store_id,expires_at:connection.expires_at,api_base_path:'/client-api/v1',read_only:true} as const;
 });
}
async function pairingByCode(q:Pool|PoolClient,code:string,lock=false){
 const normalized=normalizeCode(code);requireCondition(/^[A-F0-9]{20}$/.test(normalized),404,'pairing_not_found','找不到有效的連線要求，請由客戶端重新產生代碼。');
 const row=(await q.query(`SELECT * FROM client_pairing_requests WHERE user_code_hash=$1 AND state='pending' AND expires_at>now()${lock?' FOR UPDATE':''}`,[tokenHash(normalized)])).rows[0];
 requireCondition(row,404,'pairing_not_found','找不到有效的連線要求，請由客戶端重新產生代碼。');return row;
}
export async function pairingView(pool:Pool,actor:Actor,code:string){
 await authRateLimit(pool,'client-pairing-lookup',actor.user_id,30,300);
 const row=await pairingByCode(pool,code);
 return {user_code:normalizeCode(code).match(/.{1,5}/g)!.join('-'),kind:row.kind,client_name:row.client_name,scope:row.kind+':read',expires_at:row.expires_at,state:'pending',read_only:true};
}
export async function approveClientPairing(pool:Pool,input:Command,code:string){
 const body=ApprovalInput.parse(input.body);
 await authRateLimit(pool,'client-pairing-approve',input.actor.user_id,30,300);
 return command(pool,input,async q=>{
   requireCondition((await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND onboarding_completed_at IS NOT NULL',[input.actor.user_id,input.actor.community_id])).rowCount===1,403,'onboarding_required','請先完成定位與主力公會選擇，再批准客戶端連線。');
 },async q=>{
   const pairing=await pairingByCode(q,code,true);
   await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`client-connections/${input.actor.user_id}`]);
   requireCondition(Number((await q.query('SELECT count(*) FROM member_client_connections WHERE user_id=$1 AND community_id=$2 AND revoked_at IS NULL AND expires_at>now()',[input.actor.user_id,input.actor.community_id])).rows[0].count)<20,409,'connection_limit','目前最多保留二十個有效讀取連線；請先撤銷不再使用的連線。');
   if(pairing.kind==='storefront')requireCondition(body.store_id&&(await q.query('SELECT 1 FROM retail_stores WHERE store_id=$1 AND community_id=$2 AND seller_ref=$3',[body.store_id,input.actor.community_id,input.actor.user_id])).rowCount===1,404,'store_not_found','請選擇你自己建立的商店。');
   else requireCondition(body.store_id===undefined,422,'supplier_store_not_allowed','供應端連線不需要商店識別碼。');
   const connectionId=randomUUID();
   await q.query('INSERT INTO member_client_connections(connection_id,community_id,user_id,client_name,kind,scope,store_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[connectionId,input.actor.community_id,input.actor.user_id,pairing.client_name,pairing.kind,pairing.kind+':read',body.store_id??null]);
   await q.query("UPDATE client_pairing_requests SET state='approved',connection_id=$2 WHERE pairing_id=$1",[pairing.pairing_id,connectionId]);
   return {approved:true,connection_id:connectionId,scope:pairing.kind+':read',read_only:true};
 });
}
export async function listClientConnections(pool:Pool,actor:Actor){
 return (await pool.query(`SELECT ${approvedFields} FROM member_client_connections WHERE community_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100`,[actor.community_id,actor.user_id])).rows.map(row=>({...row,read_only:true}));
}
export async function revokeClientConnection(pool:Pool,input:Command,id:string){
 z.object({}).strict().parse(input.body);z.uuid().parse(id);
 return command(pool,input,async q=>{
   requireCondition((await q.query('SELECT 1 FROM member_client_connections WHERE connection_id=$1 AND community_id=$2 AND user_id=$3',[id,input.actor.community_id,input.actor.user_id])).rowCount===1,404,'connection_not_found','找不到你的讀取連線。');
 },async q=>{
   const row=(await q.query('SELECT * FROM member_client_connections WHERE connection_id=$1 AND community_id=$2 AND user_id=$3 FOR UPDATE',[id,input.actor.community_id,input.actor.user_id])).rows[0];
   checkVersion(row.aggregate_version,input.expected);
   return (await q.query(`UPDATE member_client_connections SET revoked_at=COALESCE(revoked_at,now()),aggregate_version=aggregate_version+1 WHERE connection_id=$1 RETURNING ${approvedFields}`,[id])).rows[0];
 });
}

type ClientResource='connection'|'catalog'|'stores'|'listings'|'products'|'requests';
// Authentication, authorization and reads share a transaction. No browser Actor/session is fabricated.
export async function readClientResource(pool:Pool,authorization:string|undefined,resource:ClientResource,requestedStoreId?:string){
 requireCondition(authorization&&/^Bearer fw_read_[A-Za-z0-9_-]{43}$/.test(authorization),401,'client_token_invalid','讀取連線已失效，請重新配對。');
 return transaction(pool,async q=>{
   const client=(await q.query(`SELECT c.connection_id,c.community_id,c.user_id,c.kind,c.scope,c.store_id,c.expires_at FROM member_client_connections c
      JOIN users u ON u.user_id=c.user_id AND u.community_id=c.community_id
      WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>now() AND u.active AND u.onboarding_completed_at IS NOT NULL FOR SHARE OF c,u`,[tokenHash(authorization.slice(7))])).rows[0];
   requireCondition(client,401,'client_token_invalid','讀取連線已失效，請重新配對。');
   if(resource==='connection')return {connection_id:client.connection_id,kind:client.kind,scope:client.scope,store_id:client.store_id,expires_at:client.expires_at,read_only:true};
   requireCondition((client.kind==='storefront'&&['catalog','stores','listings'].includes(resource))||(client.kind==='supplier'&&['products','requests'].includes(resource)),403,'client_scope_denied','這個讀取連線沒有此資料的權限。');
   if(requestedStoreId!==undefined)requireCondition(client.kind==='storefront'&&requestedStoreId===client.store_id,404,'store_not_found','找不到這個讀取連線的商店。');
   if(client.kind==='storefront')requireCondition((await q.query('SELECT 1 FROM retail_stores WHERE store_id=$1 AND community_id=$2 AND seller_ref=$3',[client.store_id,client.community_id,client.user_id])).rowCount===1,403,'client_store_unavailable','已批准的商店不再可供這個連線讀取。');
   let rows:any[];
   if(resource==='catalog'||resource==='products')rows=(await q.query(`SELECT p.*,u.display_name AS supplier_name,to_jsonb(o) AS current_offer FROM catalog_products p
     JOIN users u ON u.user_id=p.supplier_ref JOIN LATERAL(SELECT * FROM supplier_offer_versions o WHERE o.product_id=p.product_id ORDER BY revision DESC LIMIT 1)o ON true
     WHERE p.community_id=$1${resource==='products'?' AND p.supplier_ref=$2':''} ORDER BY p.created_at DESC,p.product_id LIMIT 200`,resource==='products'?[client.community_id,client.user_id]:[client.community_id])).rows;
   else if(resource==='stores')rows=(await q.query('SELECT * FROM retail_stores WHERE store_id=$1 AND community_id=$2 AND seller_ref=$3',[client.store_id,client.community_id,client.user_id])).rows;
   else if(resource==='listings')rows=(await q.query(`SELECT l.*,a.acceptance_id,a.state AS acceptance_state,a.decision_note FROM retail_listing_revisions l LEFT JOIN distribution_acceptances a USING(listing_id)
     WHERE l.community_id=$1 AND l.store_id=$2 AND l.seller_ref=$3 ORDER BY l.created_at DESC,l.listing_id LIMIT 200`,[client.community_id,client.store_id,client.user_id])).rows;
   else rows=(await q.query(`SELECT a.*,l.snapshot,u.display_name AS seller_name FROM distribution_acceptances a JOIN retail_listing_revisions l USING(listing_id) JOIN users u ON u.user_id=a.seller_ref
     WHERE a.community_id=$1 AND a.supplier_ref=$2 ORDER BY a.created_at DESC,a.acceptance_id LIMIT 200`,[client.community_id,client.user_id])).rows;
   return {items:rows.map(row=>({...row,...limited})),read_only:true,limit:200};
 });
}
