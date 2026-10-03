import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { checkVersion, digest } from '../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { objectKey, readBounded, requirePersistence, sha256, verifyObject, writeVerifiedObject,
  type ObjectMetadata, type ObjectStore, type PersistencePolicy, type PreparedRepresentation } from '../../packages/asset-storage/index.js';

export const assetVersion = z.string().refine(v => /^[1-9][0-9]{0,18}$/.test(v) && !/[\r\n]/.test(v) && BigInt(v) <= 9223372036854775807n);
export const assetCommandKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(v => !/[\r\n]/.test(v));
const claimInput = z.object({ key: assetCommandKey, intentId: OpaqueId }).strict();
const leaseInput = claimInput.extend({ fence: assetVersion, leaseToken: OpaqueId });
export type AssetClaimInput = z.infer<typeof claimInput>;
export type AssetLeaseInput = z.infer<typeof leaseInput>;
export interface LifecyclePrepare { key: string; expectedVersion: string; contentType: string; byteSize: number; sha256: string }
export interface LifecyclePolicy extends PersistencePolicy { readonly retainedByteLimit: string }
export interface LifecycleTarget { readonly targetId: string; readonly aggregateVersion: string; readonly assetId: string|null }
export interface LifecycleIntent {
  intent_id: string; asset_id: string; representation_id: string; scope_id: string; owner_principal_id: string;
  target_user_id: string; target_work_id?: string|null; target_service_id?:string|null; target_event_id?:string|null; target_community_id?:string|null; source_orientation?:'landscape'|'portrait'|null; target_kind?: string; purpose: string; policy_revision: string; expected_version: string;
  source_content_type: string; source_byte_size: number; source_sha256: string;
  state: 'prepared'|'processing'|'stored'|'finalized'; fence: string; lease_token: string|null;
  lease_expires_at: Date|null; expires_at: Date;
}
export interface LifecyclePublication<R> {
  readonly aggregateVersion: string; readonly result: R;
  readonly fact: { readonly aggregateType: string; readonly id: string; readonly data: Record<string,unknown>; readonly eventType?: string };
}
export interface LifecycleDependencies {
  readonly store: ObjectStore; readonly intentTtlSeconds?: number; readonly leaseSeconds?: number; readonly maxPendingIntents?: number;
}
/** Trusted server code, NEVER a request/profile JSON or caller-controlled SQL.
 * Domain ports perform database-only work on the supplied live transaction.
 * lockTarget/lockPublication acquire every publication lock before the engine's
 * decision-clock refresh; publish may only reuse already-held domain locks.
 * The engine alone owns upload state transitions, source effects and fences. */
export interface LifecycleProfile<P extends LifecyclePrepare,R> {
  readonly purpose: 'member.avatar'|'work.private-draft'|'member.service-cover'|'community.event-banner'; readonly targetKind: 'member.avatar'|'work.private-result'|'work.model-result'|'member.service-cover'|'community.event-banner'; readonly variant: 'avatar'|'draft'|'cover'|'banner';
  readonly inputMaxBytes: number; readonly outputMaxBytes: number; readonly retireReplacedAsset: boolean;
  /** Additional trusted invocation check on the caller's current transaction.
   * Captured at composition, never supplied by upload/lease JSON. */
  readonly revalidate?: (q: PoolClient) => Promise<void>;
  readonly parsePrepare: (raw: P) => P;
  readonly targetId: (input: P) => string;
  readonly lockTarget: (q: PoolClient, context: MemberScopeContext, actor: Actor, targetId: string, create: boolean) => Promise<LifecycleTarget>;
  readonly resolvePolicy: (q: PoolClient, context: MemberScopeContext, targetId: string) => Promise<LifecyclePolicy>;
  readonly requireCapacity: (q: PoolClient, context: MemberScopeContext, actor: Actor, target: LifecycleTarget, policy: LifecyclePolicy, reserveBytes: number) => Promise<void>;
  readonly prepareRepresentation: (body: ReadableStream<Uint8Array>, mime: string, policy: LifecyclePolicy, source:Readonly<LifecycleIntent>) => Promise<PreparedRepresentation>;
  readonly lockPublication: (q: PoolClient, context: MemberScopeContext, actor: Actor, intent: LifecycleIntent, target: LifecycleTarget) => Promise<unknown>;
  readonly publish: (q: PoolClient, context: MemberScopeContext, actor: Actor, intent: LifecycleIntent, target: LifecycleTarget, publication: unknown, operation: string) => Promise<LifecyclePublication<R>>;
}
/** In-process bridge only. execute must supply a shared command adapter's live
 * context. This callable port is never serialized verification evidence. */
export interface LifecycleCommitPort<R,T> {
  readonly operation: string;
  /** Trusted external authority recheck after storage I/O, before DB commit work. */
  readonly beforeCommit?: () => Promise<void>;
  readonly execute: (run: (q: PoolClient, context: MemberScopeContext) => Promise<T>) => Promise<T>;
  readonly validateIntent: (intent: LifecycleIntent) => void;
  readonly result: (value: R) => T|Promise<T>;
}
const missing = (value: unknown) => requireCondition(value,404,'asset_intent_not_found','找不到這個上傳。');
const state = (value: boolean) => requireCondition(value,409,'asset_intent_state','上傳狀態已改變。');

export function createAssetLifecycle<P extends LifecyclePrepare,R>(pool: Pool, dependencies: LifecycleDependencies, definition: LifecycleProfile<P,R>) {
  const settings = z.object({ ttl: z.number().int().min(1).max(86400), lease: z.number().int().min(1).max(3600), pending: z.number().int().min(1).max(100) })
    .parse({ ttl: dependencies.intentTtlSeconds??3600, lease: dependencies.leaseSeconds??300, pending: dependencies.maxPendingIntents??3 });
  const revalidation=Object.getOwnPropertyDescriptor(definition,'revalidate');
  requireCondition(revalidation===undefined||(revalidation.enumerable&&'value' in revalidation
    &&(revalidation.value===undefined||typeof revalidation.value==='function')),500,'asset_profile_invalid','內容設定不正確。');
  const revalidate=revalidation?.value as LifecycleProfile<P,R>['revalidate'];
  const profile = Object.freeze({ ...definition }), store = dependencies.store;
  requireCondition((profile.purpose==='member.avatar' && profile.targetKind==='member.avatar' && profile.variant==='avatar' && profile.inputMaxBytes===2097152 && profile.outputMaxBytes===131072)
    || (profile.purpose==='work.private-draft' && profile.targetKind==='work.private-result' && profile.variant==='draft' && profile.inputMaxBytes===262144 && profile.outputMaxBytes===262144)
    || (profile.purpose==='work.private-draft' && profile.targetKind==='work.model-result' && profile.variant==='draft' && profile.inputMaxBytes===16384 && profile.outputMaxBytes===16384)
    || (profile.purpose==='member.service-cover'&&profile.targetKind==='member.service-cover'&&profile.variant==='cover'&&profile.inputMaxBytes===4194304&&profile.outputMaxBytes===524288)
    || (profile.purpose==='community.event-banner'&&profile.targetKind==='community.event-banner'&&profile.variant==='banner'&&profile.inputMaxBytes===524288&&profile.outputMaxBytes===524288),500,'asset_profile_invalid','內容設定不正確。');
  const targetId = (row: LifecycleIntent) => profile.targetKind==='member.avatar' ? row.target_user_id : OpaqueId.parse(profile.targetKind==='community.event-banner'?row.target_event_id:profile.targetKind==='member.service-cover'?row.target_service_id:row.target_work_id);
  const scopeKind=profile.purpose==='community.event-banner'?'community' as const:'personal' as const;
  const lockUser=scopeKind==='community';
  const storageKey = (row: LifecycleIntent) => objectKey({scopeId:row.scope_id,assetId:row.asset_id,representationId:row.representation_id});
  async function policy(q: PoolClient, context: MemberScopeContext, id: string, pinned?: string): Promise<LifecyclePolicy> {
    const resolved = await profile.resolvePolicy(q,context,id);
    const snapshot = Object.freeze({revision:resolved?.revision,platformPersistenceAllowed:resolved?.platformPersistenceAllowed,retainedByteLimit:resolved?.retainedByteLimit});
    requirePersistence(snapshot);
    requireCondition(typeof snapshot.retainedByteLimit==='string' && /^[1-9][0-9]{0,18}$/.test(snapshot.retainedByteLimit) && !/[\r\n]/.test(snapshot.retainedByteLimit)
      && BigInt(snapshot.retainedByteLimit)>=BigInt(profile.outputMaxBytes) && BigInt(snapshot.retainedByteLimit)<=9223372036854775807n,503,profile.purpose==='member.avatar'?'avatar_upload_unavailable':'asset_upload_unavailable','內容上傳暫時無法使用。');
    requireCondition(pinned===undefined || snapshot.revision===pinned,409,'asset_policy_changed','內容政策已變更，請重新準備上傳。');return snapshot;
  }
  async function readIntent(q: PoolClient, context: MemberScopeContext, actor: Actor, id: string, lock: boolean): Promise<LifecycleIntent> {
    const row = (await q.query<LifecycleIntent>(`SELECT * FROM asset_upload_intents WHERE intent_id=$1 AND target_user_id=$2 AND scope_id=$3 AND owner_principal_id=$4 AND purpose=$5${lock?' FOR UPDATE':''}`,[id,actor.user_id,context.scope.scope_id,context.subject_principal.principal_id,profile.purpose])).rows[0];missing(row);
    requireCondition((row.target_kind??'member.avatar')===profile.targetKind,404,'asset_intent_not_found','找不到這個上傳。');return row;
  }
  async function locked(q: PoolClient, context: MemberScopeContext, actor: Actor, id: string) {
    // Read only immutable, owner/scope/profile-bound routing before locking.
    // Target always precedes intent/Asset. State/fence come from the re-read.
    const hint=await readIntent(q,context,actor,id,false);
    const target=await profile.lockTarget(q,context,actor,targetId(hint),false),row=await readIntent(q,context,actor,id,true);missing(target.targetId===targetId(row));
    // Replaced avatar retirement is also a write. Acquire both rows NOW, in the
    // same UUID order as backup capture, never after the decision-clock check.
    const assets=profile.retireReplacedAsset&&target.assetId?[row.asset_id,target.assetId]:[row.asset_id];
    await q.query('SELECT asset_id FROM assets WHERE asset_id=ANY($1::uuid[]) ORDER BY asset_id FOR UPDATE',[assets]);return {target,row};
  }
  async function live(q: PoolClient,row: LifecycleIntent,lease?: AssetLeaseInput) {
    const now=(await q.query('SELECT expires_at>clock_timestamp() AS live,lease_expires_at>clock_timestamp() AS leased FROM asset_upload_intents WHERE intent_id=$1',[row.intent_id])).rows[0];
    requireCondition(now.live,409,'asset_intent_expired','上傳已到期。');
    if(lease)requireCondition(row.fence===lease.fence&&row.lease_token===lease.leaseToken&&now.leased,409,'asset_lease_stale','上傳租約已失效。');
  }
  async function metadata(q: PoolClient,row: LifecycleIntent): Promise<ObjectMetadata> {
    const object=(await q.query('SELECT content_type,byte_size,content_sha256,transform_version,policy_revision,profile_id FROM asset_objects WHERE asset_id=$1 AND scope_id=$2 AND representation_id=$3',[row.asset_id,row.scope_id,row.representation_id])).rows[0];
    requireCondition(object,409,'asset_not_stored','內容尚未完成儲存。');
    return Object.freeze({contentType:object.content_type,byteSize:object.byte_size,sha256:object.content_sha256,transformVersion:object.transform_version,policyRevision:object.policy_revision,...(object.profile_id?{profileId:object.profile_id}:{})});
  }
  async function prepare(actor: Actor,raw: P) {
    actor=Object.freeze({...actor});const input=Object.freeze({...profile.parsePrepare(raw)}),{key:receiptKey,...body}=input,id=OpaqueId.parse(profile.targetId(input));let target!:LifecycleTarget,resolved!:LifecyclePolicy;
    return scopedMemberCommand(pool,{actor,scope:scopeKind,lockUser,operation:'asset.upload.prepare',key:receiptKey,target:{kind:profile.targetKind,id},expected:input.expectedVersion,body},async(q,context)=>{
      // One owner may have many Work targets. No scope SHARE->UPDATE upgrade.
      // Fixed namespace; receipt precedes quota, quota precedes target.
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`asset.quota/v1/${context.scope.scope_id}/${profile.purpose}`]);
      target=await profile.lockTarget(q,context,actor,id,true);resolved=await policy(q,context,id);
    },async(q,context)=>{
      checkVersion(target.aggregateVersion,input.expectedVersion);
      const pending=(await q.query("SELECT count(*)::int AS n FROM asset_upload_intents WHERE owner_principal_id=$1 AND scope_id=$2 AND purpose=$3 AND state<>'finalized' AND expires_at>clock_timestamp()",[context.subject_principal.principal_id,context.scope.scope_id,profile.purpose])).rows[0].n;
      requireCondition(pending<settings.pending,409,'asset_upload_quota','進行中的上傳已達上限。');
      await profile.requireCapacity(q,context,actor,target,resolved,profile.outputMaxBytes);await assertCurrentSessionClock(q,actor);
      const assetId=randomUUID(),intentId=randomUUID(),representationId=randomUUID();
      await q.query('INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,purpose,scope_kind,community_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[assetId,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id,resolved.revision,representationId,profile.purpose,scopeKind,scopeKind==='community'?actor.community_id:null]);
      const values:unknown[]=[intentId,assetId,representationId,context.scope.scope_id,context.subject_principal.principal_id,actor.user_id,resolved.revision,receiptKey,digest(body),input.contentType,input.byteSize,input.sha256,input.expectedVersion,settings.ttl,profile.purpose,profile.outputMaxBytes];
      const work=profile.targetKind!=='member.avatar',column=profile.targetKind==='community.event-banner'?'target_event_id':profile.targetKind==='member.service-cover'?'target_service_id':'target_work_id';if(work)values.push(profile.targetKind,id);const banner=profile.purpose==='community.event-banner';if(banner)values.push(actor.community_id,(input as P&{orientation:string}).orientation);
      const row=(await q.query(`INSERT INTO asset_upload_intents(intent_id,asset_id,representation_id,scope_id,owner_principal_id,target_user_id,policy_revision,prepare_key,request_digest,source_content_type,source_byte_size,source_sha256,expected_version,expires_at,purpose,reserved_bytes${work?',target_kind,'+column:''}${banner?',target_community_id,source_orientation':''}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+make_interval(secs=>$14),$15,$16${work?',$17,$18':''}${banner?',$19,$20':''}) RETURNING expires_at`,values)).rows[0];
      await scopedJournal(q,context,{aggregate_type:'asset_upload_intent',id:intentId,version:'1',operation:'asset.upload.prepare',data:{asset_id:assetId}});
      return {intentId,assetId,representationId,expiresAt:row.expires_at.toISOString() as string};
    },revalidate);
  }
  async function claim(actor:Actor,raw:AssetClaimInput){
    actor=Object.freeze({...actor});const input=claimInput.parse(raw);let row!:LifecycleIntent;
    return scopedMemberCommand(pool,{actor,scope:scopeKind,lockUser,operation:'asset.upload.claim',key:input.key,target:{kind:'asset_upload_intent',id:input.intentId},body:{intentId:input.intentId}},async(q,context)=>{
      ({row}=await locked(q,context,actor,input.intentId));await policy(q,context,targetId(row),row.policy_revision);state(row.state!=='finalized');await live(q,row);
    },async q=>{
      const updated=(await q.query<LifecycleIntent>(`UPDATE asset_upload_intents SET fence=fence+1,lease_token=$2,lease_expires_at=LEAST(expires_at,clock_timestamp()+make_interval(secs=>$3)),state=CASE WHEN state='stored' THEN 'stored' ELSE 'processing' END WHERE intent_id=$1 AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *`,[row.intent_id,randomUUID(),settings.lease])).rows[0];
      requireCondition(updated,409,'asset_lease_active','目前仍有有效上傳租約。');
      return {intentId:updated.intent_id,assetId:updated.asset_id,representationId:updated.representation_id,fence:updated.fence,leaseToken:updated.lease_token!,leaseExpiresAt:updated.lease_expires_at!.toISOString()};
    },revalidate);
  }
  async function inspect(actor:Actor,input:AssetLeaseInput,allowFinalized=false){
    return withMemberScope(pool,{actor,scope:scopeKind,lockUser},async()=>{},async(q,context)=>{
      const {row}=await locked(q,context,actor,input.intentId),resolved=await policy(q,context,targetId(row),row.policy_revision);
      state(row.state==='processing'||row.state==='stored'||allowFinalized&&row.state==='finalized');
      if(row.state!=='finalized')await live(q,row,input);else requireCondition(row.fence===input.fence&&row.lease_token===input.leaseToken,409,'asset_lease_stale','上傳租約已失效。');
      const storedMetadata=row.state==='stored'?await metadata(q,row):null;await assertCurrentSessionClock(q,actor);if(revalidate)await revalidate(q);return {row:Object.freeze({...row}),policy:resolved,metadata:storedMetadata};
    });
  }
  async function write(actor:Actor,raw:AssetLeaseInput,body:ReadableStream<Uint8Array>){
    actor=Object.freeze({...actor});const input=leaseInput.parse(raw),snapshot=await inspect(actor,input),bytes=await readBounded(body,profile.inputMaxBytes);
    requireCondition(bytes.byteLength===snapshot.row.source_byte_size&&await sha256(bytes)===snapshot.row.source_sha256,409,'asset_source_mismatch','上傳內容與準備紀錄不同。');
    const prepared=await profile.prepareRepresentation(new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),snapshot.row.source_content_type,snapshot.policy,snapshot.row);
    requireCondition(prepared.metadata.byteSize<=profile.outputMaxBytes && (profile.purpose==='member.avatar'
      ? prepared.metadata.contentType==='image/webp'&&prepared.metadata.transformVersion==='avatar.webp.v1'
      : profile.purpose==='member.service-cover'?prepared.metadata.profileId==='member.service-cover'&&prepared.metadata.contentType==='image/webp'&&prepared.metadata.transformVersion==='member.service-cover.legacy-bytes.v1'
      : profile.purpose==='community.event-banner'?prepared.metadata.profileId==='community.event-banner'&&prepared.metadata.contentType==='image/webp'&&prepared.metadata.transformVersion==='community.event-banner.legacy-bytes.v1'
      : ['text/plain','text/markdown'].includes(prepared.metadata.contentType)&&prepared.metadata.transformVersion==='private-text.utf8.v1'),422,'asset_profile_invalid','內容不符合儲存規格。');
    const verified=await writeVerifiedObject(store,storageKey(snapshot.row),prepared,snapshot.policy);let row!:LifecycleIntent;
    return scopedMemberCommand(pool,{actor,scope:scopeKind,lockUser,operation:'asset.upload.write',key:input.key,target:{kind:'asset_upload_intent',id:input.intentId},body:{intentId:input.intentId,fence:input.fence,metadata:verified.metadata}},async(q,context)=>{
      ({row}=await locked(q,context,actor,input.intentId));await policy(q,context,targetId(row),row.policy_revision);state(row.state==='processing'||row.state==='stored');await live(q,row,input);
    },async q=>{
      if(row.state==='stored')requireCondition(digest(await metadata(q,row))===digest(verified.metadata),409,'asset_object_conflict','已儲存內容不同。');
      else{
        const value=verified.metadata,work=profile.targetKind!=='member.avatar';const values:unknown[]=[row.asset_id,row.scope_id,row.representation_id,value.contentType,value.byteSize,value.sha256,value.transformVersion,value.policyRevision];if(work)values.push(profile.purpose,profile.variant);values.push(value.profileId??null);
        await q.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision${work?',purpose,variant':''},profile_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8${work?',$9,$10':''},$${values.length})`,values);
        await q.query("UPDATE asset_upload_intents SET state='stored' WHERE intent_id=$1",[row.intent_id]);
      }
      return {intentId:row.intent_id,assetId:row.asset_id,state:'stored' as const};
    },revalidate);
  }
  async function publish(q:PoolClient,context:MemberScopeContext,actor:Actor,row:LifecycleIntent,target:LifecycleTarget,publication:unknown,operation:string):Promise<R>{
    state(row.state==='stored');checkVersion(target.aggregateVersion,row.expected_version);
    state((await q.query("UPDATE assets SET state='ready',ready_at=clock_timestamp() WHERE asset_id=$1 AND state='pending'",[row.asset_id])).rowCount===1);
    const outcome=await profile.publish(q,context,actor,row,target,publication,operation);
    if(profile.retireReplacedAsset&&target.assetId&&target.assetId!==row.asset_id)await q.query("UPDATE assets SET state='retired',retired_at=clock_timestamp() WHERE asset_id=$1 AND state='ready'",[target.assetId]);
    await q.query("UPDATE asset_upload_intents SET state='finalized',finalized_at=clock_timestamp() WHERE intent_id=$1",[row.intent_id]);
    await scopedJournal(q,context,{aggregate_type:outcome.fact.aggregateType,id:outcome.fact.id,version:outcome.aggregateVersion,operation,data:outcome.fact.data,eventType:outcome.fact.eventType});if(revalidate)await revalidate(q);return outcome.result;
  }
  async function verifyFinalization(actor:Actor,input:AssetLeaseInput){const snapshot=await inspect(actor,input,true);state(snapshot.row.state==='stored'||snapshot.row.state==='finalized');if(snapshot.row.state==='stored')await verifyObject(store,storageKey(snapshot.row),snapshot.metadata!);}
  async function authorizeFinalization(q:PoolClient,context:MemberScopeContext,actor:Actor,input:AssetLeaseInput){
    const {target,row}=await locked(q,context,actor,input.intentId);await policy(q,context,targetId(row),row.policy_revision);
    const publication=await profile.lockPublication(q,context,actor,row,target);state(row.state==='stored'||row.state==='finalized');
    if(row.state!=='finalized')await live(q,row,input);else requireCondition(row.fence===input.fence&&row.lease_token===input.leaseToken,409,'asset_lease_stale','上傳租約已失效。');
    await assertCurrentSessionClock(q,actor);if(revalidate)await revalidate(q);return {target,row,publication};
  }
  async function finalize(actor:Actor,raw:AssetLeaseInput){
    actor=Object.freeze({...actor});const input=leaseInput.parse(raw);await verifyFinalization(actor,input);let authorized!:Awaited<ReturnType<typeof authorizeFinalization>>;
    return scopedMemberCommand(pool,{actor,scope:scopeKind,lockUser,operation:'asset.upload.finalize',key:input.key,target:{kind:'asset_upload_intent',id:input.intentId},body:{intentId:input.intentId,fence:input.fence}},async(q,context)=>{authorized=await authorizeFinalization(q,context,actor,input);},
      (q,context)=>publish(q,context,actor,authorized.row,authorized.target,authorized.publication,'asset.upload.finalize'),revalidate);
  }
  async function finalizeVia<T>(actor:Actor,raw:AssetLeaseInput,bridge:LifecycleCommitPort<R,T>){
    actor=Object.freeze({...actor});const input=leaseInput.parse(raw),port=Object.freeze({...bridge});await verifyFinalization(actor,input);
    requireCondition(port.beforeCommit===undefined||typeof port.beforeCommit==='function',500,'asset_commit_port_invalid','內容設定不正確。');
    if(port.beforeCommit)await port.beforeCommit();
    return port.execute(async(q,context)=>{const {row,target,publication}=await authorizeFinalization(q,context,actor,input);port.validateIntent(Object.freeze({...row}));return port.result(await publish(q,context,actor,row,target,publication,port.operation));});
  }
  async function resumeUpload(actor:Actor,raw:AssetClaimInput){
    actor=Object.freeze({...actor});const input=claimInput.parse(raw);
    const snapshot=await withMemberScope(pool,{actor,scope:scopeKind,lockUser},async()=>{},async(q,context)=>{
      const {row}=await locked(q,context,actor,input.intentId);await policy(q,context,targetId(row),row.policy_revision);if(row.state!=='finalized')await live(q,row);
      const active=(await q.query('SELECT lease_expires_at>clock_timestamp() AS active FROM asset_upload_intents WHERE intent_id=$1',[row.intent_id])).rows[0].active;await assertCurrentSessionClock(q,actor);if(revalidate)await revalidate(q);return {row,active};
    });
    if(snapshot.active||snapshot.row.state==='finalized')return {state:snapshot.row.state,intentId:snapshot.row.intent_id,fence:snapshot.row.fence,leaseToken:snapshot.row.lease_token!};
    const lease=await claim(actor,{intentId:input.intentId,key:digest({facadeKey:input.key,intentId:input.intentId,priorFence:snapshot.row.fence})});return {state:snapshot.row.state==='stored'?'stored' as const:'processing' as const,intentId:lease.intentId,fence:lease.fence,leaseToken:lease.leaseToken};
  }
  return Object.freeze({prepare,claim,write,finalize,resumeUpload,finalizeVia});
}
