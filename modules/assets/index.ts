import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { digest, type Command } from '../../packages/db/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { avatarMemberCommand } from '../../packages/scoped-commands/index.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { requireAvatarCapacity, requireAvatarQuotaLimit, type AvatarPersistencePolicy } from './avatar-policy.js';
import { AVATAR_PROFILE, prepareAvatar, requirePersistence, type AvatarNormalizer, type ObjectStore } from '../../packages/asset-storage/index.js';
import { assetCommandKey, assetVersion, createAssetLifecycle, type AssetClaimInput, type AssetLeaseInput, type LifecycleTarget } from './engine.js';

const prepareInput=z.object({key:assetCommandKey,targetUserId:OpaqueId,expectedVersion:assetVersion,
  contentType:z.enum(['image/png','image/jpeg','image/webp']),byteSize:z.number().int().min(1).max(AVATAR_PROFILE.inputMaxBytes),sha256:z.string().length(64).regex(/^[0-9a-f]+$/)}).strict();
export type AvatarPrepareInput=z.infer<typeof prepareInput>;
export type AvatarClaimInput=AssetClaimInput;
export type AvatarLeaseInput=AssetLeaseInput;
export interface AvatarAssetDependencies {
  readonly store:ObjectStore;
  readonly normalizeAvatar:AvatarNormalizer;
  /** Trusted same-transaction DB-only policy resolver, never caller JSON. */
  readonly resolvePolicy:(q:PoolClient,context:MemberScopeContext,targetUserId:string)=>Promise<AvatarPersistencePolicy>;
  readonly intentTtlSeconds?:number;readonly leaseSeconds?:number;readonly maxPendingIntents?:number;
}
interface AvatarFinalized {intentId:string;assetId:string;targetUserId:string;aggregateVersion:string}
const missing=(value:unknown)=>requireCondition(value,404,'asset_intent_not_found','找不到這個上傳。');

/** Avatar-only domain adapter. Shared engine owns every lifecycle phase. */
export function createAvatarAssetService(pool:Pool,dependencies:AvatarAssetDependencies){
  const {normalizeAvatar,resolvePolicy}=dependencies;
  async function eligibleMember(q:PoolClient,actor:Actor):Promise<{community_id:string}>{
    const current=(await q.query('SELECT community_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)',[actor.user_id])).rows[0];
    requireCondition(current,403,'onboarding_required','請先完成加入。');return current;
  }
  async function lockTarget(q:PoolClient,context:MemberScopeContext,actor:Actor,id:string,create:boolean):Promise<LifecycleTarget>{
    requireCondition(id===actor.user_id,404,'asset_target_not_found','找不到這個目標。');
    requireCondition(context.scope.kind==='personal',403,'asset_scope_required','需要本人的私人範圍。');
    const current=await eligibleMember(q,actor);
    if(create)await q.query('INSERT INTO member_avatars(user_id,community_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.user_id,current.community_id]);
    const avatar=(await q.query('SELECT user_id,aggregate_version FROM member_avatars WHERE user_id=$1 FOR UPDATE',[actor.user_id])).rows[0];missing(avatar);
    if(create)await q.query('INSERT INTO member_avatar_asset_targets(user_id,scope_id,owner_principal_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[actor.user_id,context.scope.scope_id,context.subject_principal.principal_id]);
    const pointer=(await q.query('SELECT asset_id FROM member_avatar_asset_targets WHERE user_id=$1 AND scope_id=$2 AND owner_principal_id=$3 FOR UPDATE',[actor.user_id,context.scope.scope_id,context.subject_principal.principal_id])).rows[0];missing(pointer);
    return {targetId:actor.user_id,aggregateVersion:avatar.aggregate_version,assetId:pointer.asset_id};
  }
  const engine=createAssetLifecycle<AvatarPrepareInput,AvatarFinalized>(pool,dependencies,{
    purpose:'member.avatar',targetKind:'member.avatar',variant:'avatar',inputMaxBytes:AVATAR_PROFILE.inputMaxBytes,outputMaxBytes:AVATAR_PROFILE.outputMaxBytes,retireReplacedAsset:true,
    parsePrepare:raw=>prepareInput.parse(raw),targetId:input=>input.targetUserId,lockTarget,resolvePolicy,
    requireCapacity:(q,_context,actor,_target,policy,reserve)=>requireAvatarCapacity(q,actor.user_id,policy.retainedByteLimit,reserve),
    prepareRepresentation:(body,mime,policy)=>prepareAvatar(body,mime,policy,normalizeAvatar),
    lockPublication:async q=>(await q.query("SELECT mode FROM avatar_storage_policy WHERE profile='member.avatar' FOR SHARE")).rows[0],
    async publish(q,_context,actor,row,_target,publication,operation){
      const mode=(publication as {mode:string}).mode,legacy=operation==='member.avatar.replace';
      if(legacy)requireCondition(mode!=='legacy',503,'avatar_upload_unavailable','頭像上傳暫時無法使用。');
      const saved=(await q.query("UPDATE member_avatars SET aggregate_version=aggregate_version+1,storage_source=CASE WHEN $3='legacy' THEN storage_source ELSE 'asset' END,updated_at=clock_timestamp() WHERE user_id=$1 AND aggregate_version=$2 RETURNING aggregate_version",[actor.user_id,row.expected_version,mode])).rows[0];
      requireCondition(saved,412,'version_conflict','頭像版本已改變。');
      await q.query('UPDATE member_avatar_asset_targets SET asset_id=$2,linked_at_version=$3 WHERE user_id=$1',[actor.user_id,row.asset_id,saved.aggregate_version]);
      const result={intentId:row.intent_id,assetId:row.asset_id,targetUserId:actor.user_id,aggregateVersion:saved.aggregate_version as string};
      return {aggregateVersion:result.aggregateVersion,result,fact:legacy
        ? {aggregateType:'member_avatar',id:actor.user_id,data:{intent_id:row.intent_id,asset_id:row.asset_id},eventType:'freedom.member.avatar.replaced.v1'}
        : {aggregateType:'asset',id:row.asset_id,data:{intent_id:row.intent_id,target_user_id:actor.user_id},eventType:'freedom.asset.avatar.stored.v1'}};
    },
  });
  async function finalizeAvatar(legacy:Command,input:AvatarLeaseInput){
    legacy=Object.freeze({...legacy,actor:Object.freeze({...legacy.actor}),body:Object.freeze(z.object({content_type:z.enum(['image/png','image/jpeg','image/webp']),sha256:z.string().length(64).regex(/^[0-9a-f]+$/)}).strict().parse(legacy.body))});
    const actor=legacy.actor;
    return engine.finalizeVia<{avatar_url:string;aggregate_version:string}>(actor,input,{operation:'member.avatar.replace',
      execute:run=>avatarMemberCommand(pool,legacy,q=>eligibleMember(q,actor),run),
      validateIntent:row=>requireCondition(legacy.expected===row.expected_version&&digest(legacy.body)===digest({content_type:row.source_content_type,sha256:row.source_sha256}),409,'asset_source_mismatch','上傳內容與準備紀錄不同。'),
      result:saved=>({avatar_url:`/api/v1/members/${actor.user_id}/avatar?v=${saved.aggregateVersion}`,aggregate_version:saved.aggregateVersion})});
  }
  async function readTarget(actor:Actor){
    actor=Object.freeze({...actor});
    return withMemberScope(pool,{actor,scope:'personal'},async()=>{},async(q,context)=>{
      await eligibleMember(q,actor);const policy=await resolvePolicy(q,context,actor.user_id);
      requirePersistence(policy);requireAvatarQuotaLimit(policy.retainedByteLimit);
      const row=(await q.query('SELECT a.aggregate_version,t.asset_id FROM member_avatars a LEFT JOIN member_avatar_asset_targets t ON t.user_id=a.user_id AND t.scope_id=$2 AND t.owner_principal_id=$3 AND t.linked_at_version=a.aggregate_version WHERE a.user_id=$1',[actor.user_id,context.scope.scope_id,context.subject_principal.principal_id])).rows[0];
      await assertCurrentSessionClock(q,actor);
      return {targetUserId:actor.user_id,assetId:(row?.asset_id??null) as string|null,aggregateVersion:(row?.aggregate_version??'1') as string};
    });
  }
  const {prepare,claim,write,finalize,resumeUpload}=engine;
  return Object.freeze({prepare,claim,write,finalize,readTarget,resumeUpload,finalizeAvatar});
}
