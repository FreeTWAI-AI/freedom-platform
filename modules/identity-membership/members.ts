import { randomBytes,randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { command,checkVersion,journal,transaction,type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { hashPasswordAsync,SESSION_LIFETIME_SECONDS,tokenHash,type Actor } from './service.js';
import { memberPositioningSummaries } from '../positioning/onboarding.js';
import { ensureRegisteredPreferenceSet } from '../positioning/guild-categories.js';
import {guildTitles} from '../positioning/assessment.js';
import {capabilityCategories} from '../community/catalog.js';
import { avatarMetadata, avatarUrl } from './avatars.js';
import { notifyFriendshipChange } from '../member-communications/events.js';
import { notifyMember } from '../member-communications/notifications.js';
import {lockInteractionPair,assertCanContact,assertInteractionMember,contactableIds} from './blocks.js';

const audienceKeys=['public','friends','squad','guild'] as const;
type Audience=typeof audienceKeys[number];
const Audiences=z.array(z.enum(audienceKeys)).max(4).refine(values=>new Set(values).size===values.length,'請移除重複的公開對象。')
  .transform(values=>values.includes('public')?['public'] as Audience[]:[...values].sort());
const contact=(value:z.ZodType<string>)=>z.object({value,audiences:Audiences.default([])}).strict();
const contactValue=z.string().trim().max(100).refine(v=>!/[\x00-\x1f\x7f]/.test(v));
const SocialContacts=z.object({
  discord:contact(contactValue),github:contact(z.string().trim().max(39).refine(v=>v===''||/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(v),'請填 GitHub 帳號，不要貼網址。')),
  line:contact(contactValue),
}).strict();
export const ContactInput=SocialContacts.extend({email:z.object({audiences:Audiences}).strict()}).strict();
export const RegistrationInput=z.object({email:z.email().max(200),password:z.string().min(12).max(128),nickname:z.string().trim().max(60).optional(),contacts:SocialContacts.partial().optional()}).strict();
const AccountInput=z.object({nickname:z.string().trim().min(1).max(60),identity_label:z.enum(['male','female','alien','ai']).nullable().optional(),contacts:ContactInput}).strict();
export const emptyContacts=()=>({discord:{value:'',audiences:[] as string[]},github:{value:'',audiences:[] as string[]},line:{value:'',audiences:[] as string[]},email:{audiences:[] as string[]}});

// Compatible reads for older stored scalar rows, never for new API writes.
// A former separate contact email cannot authorize exposing the login address.
export function normalizedContacts(raw:unknown,email:string) {
  const source=raw&&typeof raw==='object'?raw as Record<string,any>:{};
  return Object.fromEntries(['discord','github','line','email'].map(key=>{
    const field=source[key]&&typeof source[key]==='object'?source[key]:{};
    let audiences:Audience[]=Array.isArray(field.audiences)?field.audiences.filter((v:unknown):v is Audience=>typeof v==='string'&&audienceKeys.includes(v as Audience)):
      audienceKeys.includes(field.visibility)?[field.visibility]:[];
    if(key==='email'&&Object.hasOwn(field,'value')&&(typeof field.value!=='string'||field.value.toLowerCase()!==email.toLowerCase()))audiences=[];
    audiences=audiences.includes('public')?['public']:[...new Set(audiences)].sort();
    return [key,{value:key==='email'?email:typeof field.value==='string'?field.value:'',audiences}];
  })) as Record<'discord'|'github'|'line'|'email',{value:string;audiences:Audience[]}>;
}

// Persistent per-network budgets run before password hashing. A separate email
// budget survives changing networks. No mail or provider ownership is inferred.
export async function authRateLimit(pool:Pool,scope:string,network:string,limit:number,seconds=900) {
  await transaction(pool,q=>authRateLimitInTransaction(q,scope,network,limit,seconds));
}

/** Domain commands charge only new effects and roll the budget back on failure. */
export async function authRateLimitInTransaction(q:PoolClient,scope:string,network:string,limit:number,seconds=900) {
  const bucket=tokenHash(`${scope}/${network}`);
  // DO UPDATE locks an existing row, so the scheduled prune cannot delete it before the SELECT below.
  await q.query('INSERT INTO auth_rate_limits(bucket) VALUES($1) ON CONFLICT(bucket) DO UPDATE SET bucket=excluded.bucket',[bucket]);
  const row=(await q.query('SELECT * FROM auth_rate_limits WHERE bucket=$1 FOR UPDATE',[bucket])).rows[0];
  const expired=Date.now()-new Date(row.window_start).getTime()>=seconds*1000;
  requireCondition(expired||row.attempts<limit,429,'auth_rate_limited','操作次數過多，請稍後再試。');
  await q.query(`UPDATE auth_rate_limits SET attempts=$2,window_start=CASE WHEN $3 THEN now() ELSE window_start END WHERE bucket=$1`,[bucket,expired?1:row.attempts+1,expired]);
}
export async function registerMember(pool:Pool,raw:unknown,options:{communityId?:string;allowSingleCommunity:boolean;publicMode?:boolean}) {
  const body=RegistrationInput.parse(raw),email=body.email.trim().toLowerCase();
  // Never derive a public display name from the private login email.
  const nickname=body.nickname||`新夥伴 ${randomBytes(4).toString('hex')}`;
  requireCondition(!options.publicMode||!email.endsWith('@local.test'),422,'reserved_email_domain','請使用你自己的電子郵件地址；示範網域不能在公開網站註冊。');
  await authRateLimit(pool,'registration-email',email,3);
  const passwordHash=await hashPasswordAsync(body.password);
  return transaction(pool,async q=>{
    let communityId=options.communityId;
    if(communityId)z.uuid().parse(communityId);
    else {
      requireCondition(options.allowSingleCommunity,503,'registration_unavailable','註冊尚未開放。');
      const communities=await q.query('SELECT community_id FROM communities LIMIT 2');
      requireCondition(communities.rowCount===1,503,'registration_unavailable','註冊尚未開放。');communityId=communities.rows[0].community_id;
    }
    requireCondition((await q.query('SELECT 1 FROM communities WHERE community_id=$1',[communityId])).rowCount===1,503,'registration_unavailable','註冊尚未開放。');
    const user=(await q.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(email) DO NOTHING RETURNING user_id,community_id,email,display_name,profession_membership_ref,onboarding_required,onboarding_completed_at`,[randomUUID(),communityId,email,nickname,passwordHash,randomUUID()])).rows[0];
    requireCondition(user,409,'account_unavailable','無法使用這個註冊資料；已有帳號請登入。');
    const contacts={...emptyContacts(),...body.contacts};
    await q.query('INSERT INTO member_accounts(user_id,community_id,contacts) VALUES($1,$2,$3)',[user.user_id,communityId,JSON.stringify(contacts)]);
    await ensureRegisteredPreferenceSet(q,communityId!,user.user_id);
    const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
    await q.query(`INSERT INTO sessions VALUES($1,$2,$3,now()+make_interval(secs=>$4),NULL)`,[tokenHash(token),user.user_id,csrf,SESSION_LIFETIME_SECONDS]);
    return {token,actor:{...user,session_hash:tokenHash(token),csrf_token:csrf} as Actor};
  });
}
async function ensureAccount(q:Pool|PoolClient,actor:Actor) {
  await q.query('INSERT INTO member_accounts(user_id,community_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.user_id,actor.community_id]);
}
export async function accountView(pool:Pool,actor:Actor) {
  await ensureAccount(pool,actor);
  const row=(await pool.query(`SELECT a.*,u.email,u.display_name,u.email_verified_at,u.created_at,u.created_at_source FROM member_accounts a JOIN users u USING(user_id) WHERE a.user_id=$1 AND a.community_id=$2`,[actor.user_id,actor.community_id])).rows[0];
  return {user_id:row.user_id,nickname:row.display_name,identity_label:row.identity_label,joined_at:row.created_at?new Date(row.created_at).toISOString():null,joined_at_source:row.created_at_source,login_email:row.email,email_verified:Boolean(row.email_verified_at),contacts:Object.fromEntries(Object.entries(normalizedContacts(row.contacts,row.email)).map(([key,value])=>[key,{...value,verified:false}])),aggregate_version:row.aggregate_version,avatar:await avatarMetadata(pool,actor)};
}
export async function saveAccount(pool:Pool,input:Command) {
  const body=AccountInput.parse(input.body);
  await command(pool,{...input,lockUser:true},async q=>{await ensureAccount(q,input.actor);},async q=>{
    const account=(await q.query('SELECT * FROM member_accounts WHERE user_id=$1 AND community_id=$2 FOR UPDATE',[input.actor.user_id,input.actor.community_id])).rows[0];
    checkVersion(account.aggregate_version,input.expected);
    await q.query('UPDATE users SET display_name=$2 WHERE user_id=$1',[input.actor.user_id,body.nickname]);
    const updated=(await q.query('UPDATE member_accounts SET contacts=$2,identity_label=$3,aggregate_version=aggregate_version+1 WHERE user_id=$1 RETURNING aggregate_version',[input.actor.user_id,JSON.stringify(body.contacts),body.identity_label===undefined?account.identity_label:body.identity_label])).rows[0];
    await journal(q,input.actor,'member_account',input.actor.user_id,updated.aggregate_version,'update_account',{});
    // Do not persist contacts in command receipts: all reads recheck current privacy.
    return {updated:true,aggregate_version:updated.aggregate_version};
  });
  return accountView(pool,input.actor);
}
const pair=(a:string,b:string)=>[a,b].sort();
async function visibleMember(q:Pool|PoolClient,actor:Actor,id:string,lock=false) {
  z.uuid().parse(id);
  const row=(await q.query(`SELECT user_id,display_name FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AND ($1=$3 OR NOT is_verification_test_account(user_id)) ${lock?'FOR SHARE':''}`,[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'member_not_found','找不到這位會員。');return row;
}
export async function memberCard(pool:Pool,actor:Actor,id:string) {
  const cards=await memberCards(pool,actor,[id]);
  requireCondition(cards[0],404,'member_not_found','找不到這位會員。');return cards[0];
}
export async function memberCards(pool:Pool,actor:Actor,ids:string[]) {
  ids=ids.map(id=>z.uuid().parse(id).toLowerCase());
  if(!ids.length)return [];
  // Contact values and their audience predicates must share ONE database snapshot.
  // Split reads can combine an old friendship with a newly changed private value.
  const [projection,positioning]=await Promise.all([
    pool.query(`SELECT u.user_id,u.display_name,u.created_at,u.created_at_source,u.email,account.contacts,account.identity_label,avatar.aggregate_version AS avatar_version,avatar.present AS avatar_present,
      (SELECT max(coalesce(s.last_seen_at,s.created_at)) FROM sessions s WHERE s.user_id=u.user_id) AS last_seen_at,
      EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.user_id AND s.revoked_at IS NULL AND s.expires_at>now()
        AND s.last_seen_at>now()-interval '2 minutes') AS is_online,
      (SELECT jsonb_build_object('state',f.state,'requester_ref',f.requester_ref,'aggregate_version',f.aggregate_version) FROM member_friendships f WHERE f.community_id=$1 AND f.low_ref=least(u.user_id,$2::uuid) AND f.high_ref=greatest(u.user_id,$2::uuid)) AS friendship,
      EXISTS(SELECT 1 FROM positioning_profession_memberships a JOIN positioning_profession_memberships b USING(community_id,guild_key) WHERE a.community_id=$1 AND a.user_id=$2 AND b.user_id=u.user_id AND a.state='active' AND b.state='active') AS guild,
      EXISTS(SELECT 1 FROM member_squad_memberships a JOIN member_squad_memberships b USING(squad_id) JOIN member_squads s USING(squad_id) WHERE s.community_id=$1 AND a.user_id=$2 AND b.user_id=u.user_id AND a.state='active' AND b.state='active') AS squad
      FROM users u LEFT JOIN member_accounts account ON account.user_id=u.user_id AND account.community_id=u.community_id
      LEFT JOIN member_avatar_presence avatar ON avatar.user_id=u.user_id AND avatar.community_id=u.community_id
      WHERE u.user_id=ANY($3::uuid[]) AND u.community_id=$1 AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND (u.user_id=$2 OR NOT is_verification_test_account(u.user_id))`,[actor.community_id,actor.user_id,ids]),
    memberPositioningSummaries(pool,actor.community_id,ids),
  ]);
  const tiers=ids.includes(actor.user_id)?(await pool.query("SELECT guild_key,member_tier FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND state='active' ORDER BY guild_key",[actor.community_id,actor.user_id])).rows:undefined;
  const cards=new Map(projection.rows.map(relation=>{
  const id=relation.user_id,isSelf=id===actor.user_id,contacts:Record<string,string>={};
  for(const [key,field] of Object.entries(normalizedContacts(relation.contacts,relation.email))) {
    const audience=field.audiences;
    if(field.value&&(isSelf||audience.includes('public')||audience.includes('friends')&&relation.friendship?.state==='accepted'||audience.includes('guild')&&relation.guild||audience.includes('squad')&&relation.squad))contacts[key]=field.value;
  }
  const card={user_id:id,nickname:relation.display_name,identity_label:relation.identity_label??null,joined_at:relation.created_at?new Date(relation.created_at).toISOString():null,joined_at_source:relation.created_at_source,last_seen_at:relation.last_seen_at?new Date(relation.last_seen_at).toISOString():null,is_online:relation.is_online,...positioning.get(id)!,avatar_url:avatarUrl(id,relation.avatar_version,relation.avatar_present),contacts,is_self:isSelf,friendship:relation.friendship??{state:'none'}};
  return [id,isSelf?{...card,member_tiers:tiers}:card] as const;
  }));
  return ids.flatMap(id=>{const card=cards.get(id);return card?[card]:[];});
}
export const MemberDirectoryQuery=z.object({
 limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0),
 search:z.string().trim().max(100).refine(value=>!/[\x00-\x1f\x7f]/.test(value),'請使用單行搜尋文字。').default(''),
 guild_key:z.union([z.literal(''),z.string().max(100).regex(/^(guild_[a-z0-9_]+|guild_custom_[0-9A-Fa-f]{32})$/)]).default(''),
 primary_guild_key:z.union([z.literal(''),z.string().max(100).regex(/^(guild_[a-z0-9_]+|guild_custom_[0-9A-Fa-f]{32})$/)]).default(''),
 capability:z.string().refine(value=>value===''||capabilityCategories.some(category=>category.items.some(option=>option.id===value)),'請選擇有效的專長。').default(''),
 sort:z.enum(['newest','oldest','nickname','positioning','guild']).default('nickname'),
}).strict();
type MemberDirectoryFilters=Partial<Pick<z.infer<typeof MemberDirectoryQuery>,'search'|'guild_key'|'primary_guild_key'|'capability'|'sort'>>;
const capabilityLabels=Object.fromEntries(capabilityCategories.flatMap(category=>category.items.map(option=>[option.id,option.label])));
const memberSort={newest:'created_at DESC NULLS LAST,user_id',oldest:'created_at ASC NULLS LAST,user_id',nickname:'lower(display_name),display_name,user_id',positioning:'lower(positioning_title) NULLS LAST,lower(display_name),user_id',guild:'lower(primary_guild_name) NULLS LAST,lower(display_name),user_id'} as const;
export async function listMembers(pool:Pool,actor:Actor,limit:number,offset:number,filters:MemberDirectoryFilters={}) {
  const input=MemberDirectoryQuery.parse({...filters,limit,offset});
  // Search only the public, last-confirmed profile. Raw assessment answers,
  // occupation, drafts and contact handles/email are never search predicates.
  // Count and page selection share one snapshot; filtering happens before LIMIT.
  const switched=(await pool.query(`SELECT 1 FROM guild_preference_switch WHERE community_id=$1 AND state='switched'`,[actor.community_id])).rowCount===1;
  const result=(await pool.query(`WITH visible AS (
    SELECT u.user_id,u.display_name,u.created_at,a.published_profile,
      CASE WHEN $11::bool THEN display_primary.guild_key ELSE p.primary_guild_key END AS primary_guild_key,
      CASE WHEN EXISTS(SELECT 1 FROM positioning_profession_memberships m WHERE m.community_id=u.community_id
        AND m.user_id=u.user_id AND m.guild_key=(CASE WHEN $11::bool THEN display_primary.guild_key ELSE p.primary_guild_key END) AND m.state='active')
        THEN COALESCE(NULLIF($6::jsonb->>(CASE WHEN $11::bool THEN display_primary.guild_key ELSE p.primary_guild_key END),''),(SELECT NULLIF(c.profession_title,'') FROM positioning_guild_catalog c WHERE c.guild_key=(CASE WHEN $11::bool THEN display_primary.guild_key ELSE p.primary_guild_key END) AND c.guild_key ~ '^guild_custom_[0-9A-Fa-f]{32}$'),'專業探索者') ELSE NULL END AS positioning_title
    FROM users u JOIN member_account_classification t USING(user_id,community_id)
      LEFT JOIN onboarding_assessments a ON a.user_id=u.user_id AND a.community_id=u.community_id
      LEFT JOIN guild_member_preferences p ON p.user_id=u.user_id AND p.community_id=u.community_id
      LEFT JOIN LATERAL (
        SELECT cp.guild_key FROM guild_category_preferences cp
        JOIN positioning_profession_memberships dm ON dm.community_id=cp.community_id AND dm.user_id=cp.user_id AND dm.guild_key=cp.guild_key AND dm.state='active'
        WHERE cp.community_id=u.community_id AND cp.user_id=u.user_id
        ORDER BY CASE cp.category WHEN 'professional_industry' THEN 1 WHEN 'external' THEN 2 ELSE 3 END
        LIMIT 1
      ) display_primary ON $11::bool
    WHERE u.community_id=$1 AND u.active AND (NOT t.is_test_account OR u.user_id=$10) AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$1 AND b.state='active'
        AND ((b.owner_ref=$10 AND b.target_ref=u.user_id) OR (b.owner_ref=u.user_id AND b.target_ref=$10)))
      AND ($5='' OR EXISTS(SELECT 1 FROM positioning_profession_memberships m WHERE m.community_id=u.community_id
        AND m.user_id=u.user_id AND m.guild_key=$5 AND m.state='active'))
      AND ($8='' OR CASE WHEN $11::bool THEN EXISTS (
        SELECT 1 FROM guild_category_preferences cp
        JOIN positioning_profession_memberships pm ON pm.community_id=cp.community_id AND pm.user_id=cp.user_id AND pm.guild_key=cp.guild_key AND pm.state='active'
        WHERE cp.community_id=u.community_id AND cp.user_id=u.user_id AND cp.guild_key=$8
      ) ELSE p.primary_guild_key=$8 AND EXISTS(SELECT 1 FROM positioning_profession_memberships pm WHERE pm.community_id=u.community_id
        AND pm.user_id=u.user_id AND pm.guild_key=$8 AND pm.state='active') END)
  ), matched AS (
    SELECT user_id,display_name,created_at,positioning_title,
      CASE WHEN positioning_title IS NOT NULL THEN NULLIF($6::jsonb->>primary_guild_key,'') END AS primary_guild_name FROM visible
    WHERE ($4='' OR strpos(lower(display_name),lower($4))>0 OR strpos(lower(positioning_title),lower($4))>0
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(published_profile->'capabilities','[]'::jsonb)) AS capability(id)
        WHERE strpos(lower(COALESCE($7::jsonb->>capability.id,capability.id)),lower($4))>0
          OR strpos(lower(capability.id),lower($4))>0)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(published_profile->'custom_capabilities','[]'::jsonb)) AS custom(label)
        WHERE strpos(lower(custom.label),lower($4))>0))
      AND ($9='' OR COALESCE(published_profile->'capabilities','[]'::jsonb) ? $9)
  ) SELECT (SELECT count(*)::int FROM matched) AS total,
    ARRAY(SELECT user_id FROM matched ORDER BY ${memberSort[input.sort]} LIMIT $2 OFFSET $3) AS user_ids`,
    [actor.community_id,input.limit,input.offset,input.search,input.guild_key,JSON.stringify(guildTitles),JSON.stringify(capabilityLabels),input.primary_guild_key,input.capability,actor.user_id,switched])).rows[0];
  const items: Array<Awaited<ReturnType<typeof memberCard>> & {guild_roster?: {member_tier:'intern'|'full';aggregate_version:number;expert_aggregate_version:number|null;expert_active:boolean}}>=await Promise.all((result.user_ids as string[]).map(id=>memberCard(pool,actor,id)));
  if(input.guild_key&&items.length&&(await pool.query("SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active'",[actor.community_id,actor.user_id,input.guild_key])).rowCount){
    const rows=(await pool.query(`SELECT m.user_id,m.member_tier,m.aggregate_version,e.aggregate_version AS expert_aggregate_version,COALESCE(e.active,false) AS expert_active
      FROM positioning_profession_memberships m LEFT JOIN positioning_guild_experts e ON e.community_id=m.community_id AND e.guild_key=m.guild_key AND e.user_id=m.user_id
      WHERE m.community_id=$1 AND m.guild_key=$2 AND m.state='active' AND m.user_id=ANY($3::uuid[])`,[actor.community_id,input.guild_key,items.map(item=>item.user_id)])).rows;
    const byId=new Map(rows.map(row=>[row.user_id,row]));
    for(const item of items){const row=byId.get(item.user_id);if(row)item.guild_roster={member_tier:row.member_tier,aggregate_version:Number(row.aggregate_version),expert_aggregate_version:row.expert_aggregate_version==null?null:Number(row.expert_aggregate_version),expert_active:Boolean(row.expert_active)};}
  }
  const allowed=await contactableIds(pool,actor,items.map(item=>item.user_id));
  return {items:items.filter(item=>allowed.has(item.user_id)),total:result.total,next_offset:input.offset+input.limit<result.total?input.offset+input.limit:null};
}
export async function memberPresence(pool:Pool,actor:Actor,raw:string){
  const ids=z.array(z.uuid()).max(50).parse(raw.split(',').filter(Boolean));
  if(ids.length===0)return {items:[]};
  const rows=(await pool.query(`SELECT u.user_id,
    (SELECT max(coalesce(s.last_seen_at,s.created_at)) FROM sessions s WHERE s.user_id=u.user_id) AS last_seen_at,
    EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.user_id AND s.revoked_at IS NULL AND s.expires_at>now()
      AND s.last_seen_at>now()-interval '2 minutes') AS is_online
    FROM users u WHERE u.community_id=$1 AND u.user_id=ANY($2::uuid[]) AND u.active
      AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND (u.user_id=$3 OR NOT is_verification_test_account(u.user_id))`,[actor.community_id,ids,actor.user_id])).rows;
  return {items:rows.map(row=>({user_id:row.user_id,last_seen_at:row.last_seen_at?new Date(row.last_seen_at).toISOString():null,is_online:row.is_online}))};
}
export async function listFriends(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT u.user_id,u.display_name AS nickname,f.state,f.requester_ref,f.aggregate_version FROM member_friendships f JOIN users u ON u.user_id=CASE WHEN f.low_ref=$2 THEN f.high_ref ELSE f.low_ref END WHERE f.community_id=$1 AND (f.low_ref=$2 OR f.high_ref=$2) AND f.state<>'removed' AND u.community_id=$1 AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(u.user_id) ORDER BY f.updated_at DESC LIMIT 100`,[actor.community_id,actor.user_id])).rows;
}
export async function changeFriendship(pool:Pool,input:Command,id:string,action:'request'|'accept'|'remove') {
  z.object({}).strict().parse(input.body);id=z.uuid().parse(id).toLowerCase();requireCondition(id!==input.actor.user_id,422,'self_friendship','不能將自己加為好友。');
  const [low,high]=pair(id,input.actor.user_id);
  const authorize=async(q:PoolClient)=>{
    await lockInteractionPair(q,input.actor,id);
    await visibleMember(q,input.actor,id,true);
    if(action!=='remove')await assertCanContact(q,input.actor,id);
  };
  return command(pool,input,authorize,async q=>{
    const row=(await q.query('SELECT * FROM member_friendships WHERE community_id=$1 AND low_ref=$2 AND high_ref=$3 FOR UPDATE',[input.actor.community_id,low,high])).rows[0];
    if(action==='request'&&row&&row.state!=='removed')return row;
    if(row)checkVersion(row.aggregate_version,input.expected);
    else requireCondition(action==='request'&&!input.expected,404,'friendship_not_found','找不到這個好友邀請。');
    if(action==='accept')requireCondition(row?.state==='pending'&&row.requester_ref===id,403,'friendship_accept_rejected','只有受邀者可以接受待處理邀請。');
    const state=action==='request'?'pending':action==='accept'?'accepted':'removed';
    const result=(await q.query(`INSERT INTO member_friendships(community_id,low_ref,high_ref,requester_ref,state) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(community_id,low_ref,high_ref) DO UPDATE SET state=$5,requester_ref=CASE WHEN $5='pending' THEN $4 ELSE member_friendships.requester_ref END,aggregate_version=member_friendships.aggregate_version+1,updated_at=now() RETURNING *`,[input.actor.community_id,low,high,input.actor.user_id,state])).rows[0];
    await notifyFriendshipChange(q,input.actor.community_id,input.actor.user_id,row,result);
    return result;
  },async q=>{await assertInteractionMember(q,input.actor);if(action!=='remove')await assertCanContact(q,input.actor,id);});
}

const channelName=z.string().trim().max(100).refine(value=>!/[\x00-\x1f\x7f]/.test(value),'請輸入頻道名稱，不要加入換行或控制字元。');
const SquadInput=z.object({name:z.string().trim().min(1).max(80),kind:z.enum(['project','mutual_help','coaching']),purpose:z.string().trim().min(1).max(800),communication_channel_name:channelName.default('')}).strict();
async function squadExists(q:Pool|PoolClient,actor:Actor,id:string) {
  z.uuid().parse(id);
  const row=(await q.query(`SELECT s.* FROM member_squads s JOIN member_squad_classification t USING(squad_id,community_id)
    WHERE s.squad_id=$1 AND s.community_id=$2 AND (NOT t.is_test_data OR s.owner_ref=$3 OR EXISTS(
      SELECT 1 FROM member_squad_memberships m WHERE m.squad_id=s.squad_id AND m.user_id=$3 AND m.state IN ('active','pending')))`,[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'squad_not_found','找不到這個小隊。');return row;
}
export async function listSquads(pool:Pool,actor:Actor,limit:number,offset:number) {
  const rows=(await pool.query(`SELECT s.*,u.display_name AS owner_name,
    (SELECT count(*)::int FROM member_squad_memberships a JOIN users mu ON mu.user_id=a.user_id JOIN member_account_classification mt ON mt.user_id=mu.user_id AND mt.community_id=mu.community_id WHERE a.squad_id=s.squad_id AND a.state='active' AND mu.active AND mu.community_id=s.community_id AND NOT mt.is_test_account) AS member_count,
    CASE WHEN m.user_id IS NULL THEN NULL ELSE jsonb_build_object('state',m.state,'aggregate_version',m.aggregate_version) END AS membership
    FROM member_squads s JOIN member_squad_classification t USING(squad_id,community_id)
    JOIN users u ON u.user_id=s.owner_ref LEFT JOIN member_squad_memberships m ON m.squad_id=s.squad_id AND m.user_id=$2
    WHERE s.community_id=$1 AND u.active AND (NOT t.is_test_data OR s.owner_ref=$2) ORDER BY s.created_at,s.squad_id LIMIT $3 OFFSET $4`,[actor.community_id,actor.user_id,limit+1,offset])).rows;
  return {items:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null,kinds:[{key:'project',name:'專案小隊（跨職能協作）'},{key:'mutual_help',name:'共同目標互助小隊'},{key:'coaching',name:'陪跑小隊'}]};
}
export async function squadView(pool:Pool,actor:Actor,id:string) {
  const squad=await squadExists(pool,actor,id);
  const members=(await pool.query(`SELECT m.user_id,u.display_name AS nickname,m.state,m.aggregate_version FROM member_squad_memberships m JOIN users u USING(user_id)
    WHERE m.squad_id=$1 AND u.community_id=$2 AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
    AND (m.state='active' OR (m.state='pending' AND ($3::uuid=$4::uuid OR m.user_id=$3::uuid)))
    AND (m.user_id=$3 OR $3::uuid=$4::uuid OR NOT is_verification_test_account(m.user_id)) ORDER BY m.updated_at,m.user_id`,[id,actor.community_id,actor.user_id,squad.owner_ref])).rows;
  return {...squad,members};
}
export async function createSquad(pool:Pool,input:Command) {
  const body=SquadInput.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`squad-create/${input.actor.user_id}`]);
    const count=(await q.query('SELECT count(*)::int AS n FROM member_squads WHERE owner_ref=$1 AND community_id=$2',[input.actor.user_id,input.actor.community_id])).rows[0].n;
    requireCondition(count<10,409,'squad_limit','每人最多先建立 10 個小隊。');
    const squad=(await q.query(`INSERT INTO member_squads(squad_id,community_id,name,kind,purpose,owner_ref,communication_channel_name) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[randomUUID(),input.actor.community_id,body.name,body.kind,body.purpose,input.actor.user_id,body.communication_channel_name])).rows[0];
    await q.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`,[squad.squad_id,input.actor.user_id]);
    await journal(q,input.actor,'member_squad',squad.squad_id,1,'create_squad',{kind:body.kind});return squad;
  });
}
export async function updateSquadChannel(pool:Pool,input:Command,id:string) {
  id=z.uuid().parse(id).toLowerCase();
  const body=z.object({communication_channel_name:channelName}).strict().parse(input.body);
  return command(pool,input,async q=>{
    const squad=await squadExists(q,input.actor,id);
    requireCondition(squad.owner_ref===input.actor.user_id,403,'squad_owner_required','只有隊主可以設定小隊溝通頻道。');
  },async q=>{
    const squad=(await q.query('SELECT * FROM member_squads WHERE squad_id=$1 AND community_id=$2 FOR UPDATE',[id,input.actor.community_id])).rows[0];
    checkVersion(String(squad.aggregate_version),input.expected);
    const updated=(await q.query(`UPDATE member_squads SET communication_channel_name=$2,aggregate_version=aggregate_version+1 WHERE squad_id=$1 RETURNING squad_id,communication_channel_name,aggregate_version`,[id,body.communication_channel_name])).rows[0];
    await journal(q,input.actor,'member_squad',id,updated.aggregate_version,'update_squad_channel',{});
    return updated;
  });
}
export async function changeSquadMembership(pool:Pool,input:Command,id:string,action:'request'|'accept'|'leave',targetId=input.actor.user_id) {
  // Normalized ids keep one advisory lock per (squad,member), shared with squad-invitations.ts.
  z.object({}).strict().parse(input.body);id=z.uuid().parse(id).toLowerCase();targetId=z.uuid().parse(targetId).toLowerCase();
  let peerId:string|undefined;
  return command(pool,input,async q=>{
    const squad=await squadExists(q,input.actor,id);
    if(action==='accept') {requireCondition(squad.owner_ref===input.actor.user_id,403,'squad_owner_required','只有小隊發起人可以接受加入申請。');await visibleMember(q,input.actor,targetId);}
    else requireCondition(targetId===input.actor.user_id,403,'squad_self_only','請本人提出加入或退出申請。');
    if(action!=='leave'){
      const other=action==='accept'?targetId:String(squad.owner_ref);
      peerId=other;
      await lockInteractionPair(q,input.actor,other);
      await assertCanContact(q,input.actor,other);
    }
    if(action==='leave')requireCondition(squad.owner_ref!==input.actor.user_id,409,'squad_owner_cannot_leave','發起人目前不能退出自己建立的小隊。');
  },async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`squad-membership/${id}/${targetId}`]);
    const row=(await q.query('SELECT * FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2 FOR UPDATE',[id,targetId])).rows[0];
    if(action==='request'&&row&&row.state!=='left')return row;
    if(row)checkVersion(row.aggregate_version,input.expected);
    else requireCondition(action==='request'&&!input.expected,404,'squad_membership_not_found','找不到這個小隊申請。');
    if(action==='accept')requireCondition(row?.state==='pending',409,'squad_request_required','必須先由本人申請加入。');
    const state=action==='request'?'pending':action==='accept'?'active':'left';
    const saved=(await q.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,$3)
      ON CONFLICT(squad_id,user_id) DO UPDATE SET state=$3,aggregate_version=member_squad_memberships.aggregate_version+1,updated_at=now() RETURNING *`,[id,targetId,state])).rows[0];
    if(action==='request'||action==='accept'){
      // Same transaction as the membership change; the version keys a fresh notice per new request.
      const squad=(await q.query('SELECT s.name,s.owner_ref,u.display_name AS actor_name FROM member_squads s JOIN users u ON u.user_id=$2 WHERE s.squad_id=$1',[id,input.actor.user_id])).rows[0];
      const name=String(squad.name).slice(0,60);
      if(action==='request')await notifyMember(q,{community_id:input.actor.community_id,recipient_ref:squad.owner_ref,kind:'squad_join_requested',source_key:`squad-request:${id}:${targetId}:${saved.aggregate_version}`,
        title:`${String(squad.actor_name).slice(0,80)} 申請加入小隊「${name}」`,body:'前往小隊集合查看申請，決定是否接受。',action:{tab:'squads',resource_id:id}});
      else await notifyMember(q,{community_id:input.actor.community_id,recipient_ref:targetId,kind:'squad_join_accepted',source_key:`squad-accepted:${id}:${targetId}:${saved.aggregate_version}`,
        title:`你已加入小隊「${name}」`,body:'隊主接受了你的申請，可以在小隊集合與頻道和夥伴聯絡。',action:{tab:'squads',resource_id:id}});
    }
    return saved;
  },async q=>{if(peerId){await lockInteractionPair(q,input.actor,peerId);await assertCanContact(q,input.actor,peerId);}});
}
