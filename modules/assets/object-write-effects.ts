import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {OpaqueId} from '../../contracts/common/v1/identity.js';
import {objectKey,sha256,validateMetadata,type ObjectStore,type ObjectMetadata} from '../../packages/asset-storage/index.js';
import {Problem} from '../../packages/shared/problem.js';
const purposes=new Set(['member.avatar','member.service-cover','community.event-banner','community.event-video','community.social-thumbnail','skill.submission-image','community.event-highlight','member.message-image']);
const unavailable=()=>new Problem(503,'asset_effect_unavailable','內容維運證據暫時無法使用。');
function require(value:unknown):asserts value{if(!value)throw unavailable();}
/** Trusted live transaction only. No settlement ticket/function is exported.
 * Put this wrapper INSIDE an invocation timeout: it observes the original
 * trusted PUT promise even after the caller stops waiting. The effect ledger
 * references the common intent/Asset; it is not a second object catalog. */
export async function admitAssetObjectWriteEffect(q:PoolClient,pool:Pool,store:ObjectStore,lease:{intentId:string;fence:string;leaseToken:string},metadata:ObjectMetadata):Promise<ObjectStore>{
 try{
  const intentId=OpaqueId.parse(lease.intentId),token=OpaqueId.parse(lease.leaseToken);require(/^[1-9][0-9]{0,18}$/.test(lease.fence));validateMetadata(metadata);
  const row=(await q.query(`SELECT i.*,a.state AS asset_state,a.deletion_fence FROM asset_upload_intents i JOIN assets a USING(asset_id) WHERE i.intent_id=$1 AND i.fence=$2 AND i.lease_token=$3 AND i.state IN ('processing','stored') AND i.expires_at>clock_timestamp() AND i.lease_expires_at>clock_timestamp() FOR UPDATE OF i,a`,[intentId,lease.fence,token])).rows[0];
  require(row&&purposes.has(row.purpose)&&row.asset_state==='pending'&&row.deletion_fence==='0');
  const expected=row.purpose==='community.event-highlight'&&row.target_kind==='community.event-highlight.thumb'?'community.event-highlight.thumbnail':row.purpose;require(metadata.profileId===expected&&metadata.policyRevision===row.policy_revision);
  const schema=(await q.query('SELECT current_schema() AS schema')).rows[0]?.schema;require(typeof schema==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(schema));const table=`"${schema}".asset_object_write_effects`,intents=`"${schema}".asset_upload_intents`,assets=`"${schema}".assets`;
  const outsideQuery=async(sql:string,values:unknown[])=>{const client=await pool.connect();try{return await client.query(sql,values);}finally{client.release();}};
  const effectId=randomUUID(),nonce=randomUUID();await q.query(`INSERT INTO asset_object_write_effects(effect_id,intent_id,asset_id,intent_fence,settlement_nonce) VALUES($1,$2,$3,$4,$5)`,[effectId,intentId,row.asset_id,lease.fence,nonce]);
  const key=objectKey({scopeId:row.scope_id,assetId:row.asset_id,representationId:row.representation_id}),snapshot=Object.freeze({...metadata});let used=false;
  const bound=(candidate:string)=>require(candidate===key);
  const settle=async(state:'fulfilled'|'unknown'|'not_started')=>{await outsideQuery(`UPDATE ${table} SET state=$3,finished_at=clock_timestamp() WHERE effect_id=$1 AND settlement_nonce=$2 AND state='started'`,[effectId,nonce,state]);};
  return Object.freeze({
   async putImmutable(candidate,value){
    bound(candidate);require(!used);used=true;let invoked=false;
    try{validateMetadata(value.metadata);require(Object.keys(snapshot).every(field=>(value.metadata as unknown as Record<string,unknown>)[field]===(snapshot as unknown as Record<string,unknown>)[field]));const bytes=new Uint8Array(value.bytes);require(bytes.byteLength===snapshot.byteSize&&await sha256(bytes)===snapshot.sha256);
     const live=(await outsideQuery(`SELECT 1 FROM ${intents} i JOIN ${assets} a USING(asset_id) WHERE i.intent_id=$1 AND i.fence=$2 AND i.lease_token=$3 AND i.state IN ('processing','stored') AND i.expires_at>clock_timestamp() AND i.lease_expires_at>clock_timestamp() AND a.state='pending' AND a.deletion_fence=0`,[intentId,lease.fence,token])).rowCount;require(live===1);
     // Actual trusted adapter fulfillment alone is settlement evidence. A
     // rejected PUT is unknown even if a subsequent full GET succeeds.
     let result:'created'|'exists';try{invoked=true;result=await store.putImmutable(key,{bytes,metadata:snapshot});}catch{await settle('unknown').catch(()=>{});throw unavailable();}
     await settle('fulfilled');return result;
    }catch{if(!invoked)await settle('not_started').catch(()=>{});throw unavailable();}
   },
   async get(candidate,range){bound(candidate);try{return await store.get(key,range);}catch{throw unavailable();}},
   async head(candidate){bound(candidate);try{return await store.head(key);}catch{throw unavailable();}},
   async delete(){throw unavailable();},
  } satisfies ObjectStore);
 }catch{throw unavailable();}
}
