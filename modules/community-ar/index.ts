import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {publicMemberCard} from '../identity-membership/member-sharing.js';
import {publicEvent} from '../community/events.js';
import {scopedMemberCommand,scopedJournal} from '../../packages/scoped-commands/index.js';
import {withMemberScope} from '../../packages/resource-scopes/index.js';
import {assertCurrentSessionClock} from '../../packages/db/member-session.js';
import {checkVersion,type Command} from '../../packages/db/index.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import {objectKey,readVerifiedObject,type ObjectStore,type ObjectMetadata} from '../../packages/asset-storage/index.js';
import {AR_SCENE_MAX_TARGETS} from '../../packages/asset-storage/ar-target.js';
import {OpaqueId} from '../../contracts/common/v1/identity.js';

const Token=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Create=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('custom'),title:z.string().trim().min(1).max(60),scene_event_id:OpaqueId.optional()}).strict(),
  z.object({kind:z.literal('member'),title:z.string().trim().min(1).max(60),scene_event_id:OpaqueId.optional()}).strict(),
  z.object({kind:z.literal('event'),event_id:OpaqueId,title:z.string().trim().min(1).max(60)}).strict(),
]);
export type ArTargetRow={target_id:string;community_id:string;owner_user_id:string;scope_id:string;owner_principal_id:string;kind:'member'|'event'|'custom';event_id:string|null;title:string;aggregate_version:string;asset_id:string|null;state:'draft'|'published'|'withdrawn';share_token:string;parent_token:string|null;target_sha256:string|null};
export async function arPolicy(q:Pick<PoolClient,'query'>){
  const row=(await q.query("SELECT mode,policy_revision,persistence_allowed,retained_byte_limit::text AS retained_byte_limit FROM domain_media_storage_policy WHERE purpose='member.ar-target' FOR SHARE")).rows[0];
  requireCondition(row&&row.mode!=='legacy'&&row.persistence_allowed===true&&BigInt(row.retained_byte_limit??'0')>=20971520n,503,'ar_unavailable','AR 圖案發布尚未開放，可先在裝置上試掃。');
  return {revision:row.policy_revision as string,platformPersistenceAllowed:true,retainedByteLimit:row.retained_byte_limit as string};
}
export async function lockOwnAr(q:PoolClient,actor:Actor,id:string):Promise<ArTargetRow>{
  const row=(await q.query<ArTargetRow>('SELECT * FROM community_ar_targets WHERE target_id=$1 AND community_id=$2 AND owner_user_id=$3 FOR UPDATE',[OpaqueId.parse(id),actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'ar_target_not_found','找不到這個圖案。');return row;
}
/** Parent consent is current and held through publication, including replay.
 * The target carries no private MemberCard projection or attendee roster. */
export async function lockArParent(q:PoolClient,actor:Actor,row:{kind:'member'|'event'|'custom';event_id:string|null}){
  if(row.kind==='custom')return null;
  if(row.kind==='member'){
    const card=(await q.query('SELECT share_token FROM member_card_shares WHERE user_id=$1 AND community_id=$2 AND enabled FOR SHARE',[actor.user_id,actor.community_id])).rows[0];
    requireCondition(card,409,'ar_card_closed','請先在「我的名片」開啟公開名片分享。');return card.share_token as string;
  }
  const event=(await q.query("SELECT event_id FROM community_events WHERE event_id=$1 AND community_id=$2 AND organizer_ref=$3 AND state='published' AND visibility IN ('open','referral') FOR SHARE",[row.event_id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(event,409,'ar_event_closed','請選擇自己主辦且已發布的公開活動。');return null;
}
async function complete(q:Pick<PoolClient,'query'>,actor:Actor){const row=await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(user_id)',[actor.user_id,actor.community_id]);requireCondition(row.rowCount===1,403,'onboarding_required','請先完成加入。');}
function ownView(row:ArTargetRow){return {target_id:row.target_id,kind:row.kind,event_id:row.event_id,title:row.title,aggregate_version:String(row.aggregate_version),ready:!!row.asset_id,state:row.state,share_path:row.state==='published'?`/ar/${row.share_token}`:null};}
export async function createArTarget(pool:Pool,input:Command){
  const body=Create.parse(input.body);requireCondition(!/[\u0000-\u001f\u007f]/.test(body.title),422,'ar_title_invalid','圖案名稱請使用單行文字。');
  return scopedMemberCommand(pool,{actor:input.actor,scope:'personal',operation:'ar.target.create',key:input.key,body,target:{kind:'ar.target-owner',id:input.actor.user_id}},async(q)=>{
    await complete(q,input.actor);await arPolicy(q);await lockArParent(q,input.actor,{kind:body.kind,event_id:body.kind==='event'?body.event_id:null});
    if(body.kind!=='event'&&body.scene_event_id)requireCondition((await q.query("SELECT 1 FROM community_events WHERE event_id=$1 AND community_id=$2 AND state='published' AND visibility IN ('open','referral') FOR SHARE",[body.scene_event_id,input.actor.community_id])).rowCount===1,404,'ar_scene_unavailable','這個活動目前無法展示 AR 圖案。');
  },async(q,context)=>{
    const n=(await q.query('SELECT count(*)::int AS n FROM community_ar_targets WHERE owner_user_id=$1',[input.actor.user_id])).rows[0].n;
    requireCondition(n<24,409,'ar_target_limit','目前每人最多保留 24 個圖案，請沿用已有的圖案。');
    const row=(await q.query<ArTargetRow>('INSERT INTO community_ar_targets(target_id,community_id,scope_id,owner_principal_id,owner_user_id,kind,event_id,title,share_token,scene_event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [randomUUID(),input.actor.community_id,context.scope.scope_id,context.subject_principal.principal_id,input.actor.user_id,body.kind,body.kind==='event'?body.event_id:null,body.title,randomBytes(32).toString('base64url'),body.kind==='event'?body.event_id:body.scene_event_id??null])).rows[0];
    await scopedJournal(q,context,{aggregate_type:'ar_target',id:row.target_id,version:'1',operation:'ar.target.create',data:{kind:row.kind}});return ownView(row);
  });
}
export async function changeArTarget(pool:Pool,input:Command,id:string,publish:boolean){
  z.object({}).strict().parse(input.body);id=OpaqueId.parse(id);requireCondition(input.expected,428,'version_required','請重新載入圖案後再操作。');
  let current!:ArTargetRow,parent:string|null=null;
  return scopedMemberCommand(pool,{actor:input.actor,scope:'personal',operation:publish?'ar.target.publish':'ar.target.withdraw',key:input.key,body:{},expected:input.expected,target:{kind:'ar.target',id}},async q=>{
    await complete(q,input.actor);current=await lockOwnAr(q,input.actor,id);
    if(publish){await arPolicy(q);parent=await lockArParent(q,input.actor,current);requireCondition(current.asset_id,409,'ar_pattern_required','請先完成圖案上傳。');}
  },async(q,context)=>{
    checkVersion(current.aggregate_version,input.expected);
    if(publish){
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`ar.pattern/${input.actor.community_id}/${current.target_sha256}`]);
      requireCondition(!(await q.query("SELECT 1 FROM community_ar_targets WHERE community_id=$1 AND target_sha256=$2 AND state='published' AND target_id<>$3",[input.actor.community_id,current.target_sha256,id])).rowCount,409,'ar_pattern_duplicate','這個圖案已有人使用。請選擇容易分辨的個人圖案。');
    }
    const row=(await q.query<ArTargetRow>('UPDATE community_ar_targets SET state=$2,parent_token=$3,aggregate_version=aggregate_version+1 WHERE target_id=$1 RETURNING *',[id,publish?'published':'withdrawn',publish?parent:current.parent_token])).rows[0];
    await scopedJournal(q,context,{aggregate_type:'ar_target',id,version:row.aggregate_version,operation:publish?'ar.target.publish':'ar.target.withdraw',data:{state:row.state}});return ownView(row);
  });
}
export async function listOwnArTargets(pool:Pool,actor:Actor){
  return withMemberScope(pool,{actor,scope:'personal'},async q=>{await complete(q,actor);},async q=>{
    const rows=(await q.query<ArTargetRow>('SELECT * FROM community_ar_targets WHERE community_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC,target_id LIMIT 24',[actor.community_id,actor.user_id])).rows;
    const policy=(await q.query("SELECT mode,persistence_allowed FROM domain_media_storage_policy WHERE purpose='member.ar-target'")).rows[0];
    await assertCurrentSessionClock(q,actor);return {items:rows.map(ownView),publishing_enabled:!!policy&&policy.mode!=='legacy'&&policy.persistence_allowed===true};
  });
}
const visible=`t.state='published' AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(u.user_id)
 AND ((t.kind='custom') OR (t.kind='member' AND s.enabled AND s.share_token=t.parent_token) OR (t.kind='event' AND e.state='published' AND e.visibility IN ('open','referral') AND e.organizer_ref=t.owner_user_id))`;
const joins='JOIN users u ON u.user_id=t.owner_user_id AND u.community_id=t.community_id LEFT JOIN member_card_shares s ON s.user_id=t.owner_user_id AND s.community_id=t.community_id LEFT JOIN community_events e ON e.event_id=t.event_id AND e.community_id=t.community_id';
async function publicSnapshot(pool:Pool,token:string){
  const row=(await pool.query<ArTargetRow>(`SELECT t.*,CASE WHEN t.kind='member' THEN s.aggregate_version ELSE e.aggregate_version END AS parent_generation FROM community_ar_targets t ${joins} WHERE t.share_token=$1 AND ${visible}`,[Token.parse(token)])).rows[0];
  requireCondition(row,404,'ar_target_unavailable','這個 AR 圖案已撤下，或公開內容已關閉。');return row;
}
function same(a:ArTargetRow,b:ArTargetRow){requireCondition((a as ArTargetRow&{parent_generation?:string}).parent_generation===(b as ArTargetRow&{parent_generation?:string}).parent_generation&&a.aggregate_version===b.aggregate_version&&a.asset_id===b.asset_id&&a.parent_token===b.parent_token,404,'ar_target_unavailable','這個 AR 圖案已更新，請重新載入。');}
export async function readPublicAr(pool:Pool,token:string){
  const before=await publicSnapshot(pool,token);
  const content=before.kind==='custom'?{title:before.title,description:(before as ArTargetRow&{content_config?:{text?:string}}).content_config?.text??''}:before.kind==='member'?await publicMemberCard(pool,before.parent_token!):await publicEvent(pool,before.event_id!);
  same(before,await publicSnapshot(pool,token));
  return {title:before.title,kind:before.kind,version:before.aggregate_version,pattern_url:`/api/v1/public/ar/${token}/pattern`,content,binding:(before as ArTargetRow&{content_config?:unknown}).content_config??null,
    destination:before.kind==='custom'?`/ar/${token}`:before.kind==='member'?`/member-cards/${before.parent_token}`:`/events/${before.event_id}`};
}
export async function readPublicArPattern(pool:Pool,token:string,store:ObjectStore){
  const before=await publicSnapshot(pool,token);
  const row=(await pool.query(`SELECT o.* FROM asset_objects o JOIN assets a USING(asset_id) WHERE a.asset_id=$1 AND a.state='ready' AND a.deletion_fence=0 AND a.purpose='member.ar-target' AND a.scope_id=$2 AND a.owner_user_id=$3`,[before.asset_id,before.scope_id,before.owner_user_id])).rows[0];
  requireCondition(row,404,'ar_target_unavailable','圖案目前無法讀取。');
  const metadata:ObjectMetadata={contentType:row.content_type,byteSize:Number(row.byte_size),sha256:row.content_sha256,transformVersion:row.transform_version,policyRevision:row.policy_revision,profileId:row.profile_id};
  let bytes:Uint8Array;try{bytes=(await readVerifiedObject(store,objectKey({scopeId:row.scope_id,assetId:row.asset_id,representationId:row.representation_id}),metadata)).bytes;}
  catch{throw new Problem(503,'ar_pattern_unavailable','圖案暫時無法載入，請稍後再試。');}
  same(before,await publicSnapshot(pool,token));return bytes;
}
/** Bounded opt-in scan set. An event is only a discovery filter, never a claim
 * that a member attended it. No directory enumeration outside this community. */
export async function listArScene(pool:Pool,actor:Actor,eventId?:string){
  if(eventId)eventId=OpaqueId.parse(eventId);
  return withMemberScope(pool,{actor,scope:'personal'},async q=>{await complete(q,actor);},async q=>{
    const rows=(await q.query(`SELECT t.title,t.kind,t.share_token FROM community_ar_targets t ${joins} WHERE t.community_id=$1 AND ${visible}
      AND ($2::uuid IS NULL OR (t.scene_event_id=$2 AND EXISTS(SELECT 1 FROM community_events ev WHERE ev.event_id=$2 AND ev.community_id=t.community_id AND ev.state='published' AND ev.visibility IN ('open','referral'))))
      ORDER BY t.created_at DESC,t.target_id LIMIT $3`,[actor.community_id,eventId??null,AR_SCENE_MAX_TARGETS+1])).rows;
    await assertCurrentSessionClock(q,actor);return {items:rows.slice(0,AR_SCENE_MAX_TARGETS).map(row=>({title:row.title,kind:row.kind,url:`/api/v1/public/ar/${row.share_token}`})),more_available:rows.length>AR_SCENE_MAX_TARGETS};
  });
}
export function patternFingerprint(_bytes:Uint8Array,shape:{targetImage:{width:number;height:number};trackingData:unknown[]}){
  const t=shape.trackingData[0] as {data:Uint8Array;width:number;height:number};
  return createHash('sha256').update(JSON.stringify([shape.targetImage.width,shape.targetImage.height,t.width,t.height])).update(t.data).digest('hex');
}
