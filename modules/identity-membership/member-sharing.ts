import {randomBytes} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';
import {command, checkVersion, journal, type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {capabilityCategories} from '../community/catalog.js';
import type {Actor} from './service.js';
import {memberCard} from './members.js';

const Token=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Settings=z.object({enabled:z.boolean(),include_avatar:z.boolean(),rotate:z.boolean().default(false)}).strict();
const labels=Object.fromEntries(capabilityCategories.flatMap(group=>group.items.map(item=>[item.id,item.label])));
const settings=(row:any)=>({enabled:row?.enabled??false,include_avatar:row?.include_avatar??true,aggregate_version:row?.aggregate_version??null,share_path:row?.enabled?`/member-cards/${row.share_token}`:null});
export async function memberShareSettings(pool:Pool,actor:Actor){
  return settings((await pool.query('SELECT enabled,include_avatar,aggregate_version,share_token FROM member_card_shares WHERE user_id=$1 AND community_id=$2',[actor.user_id,actor.community_id])).rows[0]);
}
export async function saveMemberShare(pool:Pool,input:Command){
  const body=Settings.parse(input.body);
  return command(pool,input,async q=>{
    const visible=await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(user_id)',[input.actor.user_id,input.actor.community_id]);
    requireCondition(visible.rowCount===1,403,'member_share_unavailable','完成加入的正式會員才能分享名片。');
  },async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`member-share/${input.actor.user_id}`]);
    const current=(await q.query('SELECT * FROM member_card_shares WHERE user_id=$1 AND community_id=$2 FOR UPDATE',[input.actor.user_id,input.actor.community_id])).rows[0];
    if(current)checkVersion(current.aggregate_version,input.expected);
    else requireCondition(!input.expected,412,'version_conflict','分享設定已變更，請重新載入。');
    const token=!current||body.rotate||body.enabled&&!current.enabled?randomBytes(32).toString('base64url'):current.share_token;
    const row=(await q.query(`INSERT INTO member_card_shares(user_id,community_id,share_token,enabled,include_avatar) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id) DO UPDATE SET share_token=$3,enabled=$4,include_avatar=$5,aggregate_version=member_card_shares.aggregate_version+1,updated_at=now() RETURNING *`,[input.actor.user_id,input.actor.community_id,token,body.enabled,body.include_avatar])).rows[0];
    // The capability token is only in the private response, not public audit data.
    await journal(q,input.actor,'member_card_share',input.actor.user_id,row.aggregate_version,'save_member_card_share',{enabled:body.enabled,include_avatar:body.include_avatar,rotated:token!==current?.share_token});
    return settings(row);
  });
}
async function sharedRow(q:Pool|PoolClient,token:string){
  Token.parse(token);
  const row=(await q.query(`SELECT u.user_id,u.community_id,u.display_name,s.include_avatar,
      a.published_profile,av.image_bytes,
      (SELECT jsonb_build_object('guild_key',g.guild_key,'name',g.name) FROM guild_member_preferences p
        JOIN positioning_guild_catalog g ON g.guild_key=p.primary_guild_key
        JOIN positioning_profession_memberships m ON m.user_id=u.user_id AND m.community_id=u.community_id AND m.guild_key=g.guild_key AND m.state='active'
        WHERE p.user_id=u.user_id AND p.community_id=u.community_id) AS primary_guild
    FROM member_card_shares s JOIN users u USING(user_id,community_id)
      LEFT JOIN onboarding_assessments a USING(user_id,community_id)
      LEFT JOIN member_avatars av USING(user_id,community_id)
    WHERE s.share_token=$1 AND s.enabled AND u.active
      AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND NOT is_verification_test_account(u.user_id)`,[token])).rows[0];
  requireCondition(row,404,'member_card_unavailable','這張名片已關閉或分享連結已更換。');
  return row;
}
export async function publicMemberCard(pool:Pool,token:string){
  const row=await sharedRow(pool,token),profile=row.published_profile;
  const available=[...(profile?.capabilities??[]),...(profile?.custom_capabilities??[]).map((value:string)=>`custom:${value}`)];
  const featured=(profile?.featured_capabilities??available).filter((value:string)=>available.includes(value)).slice(0,3);
  return {nickname:row.display_name,primary_guild:row.primary_guild??null,
    capabilities:featured.map((id:string)=>id.startsWith('custom:')?id.slice(7):labels[id]??id),
    avatar_url:row.include_avatar&&row.image_bytes?`/api/v1/public/member-cards/${token}/avatar`:null};
}
export async function publicMemberAvatar(pool:Pool,token:string){
  const row=await sharedRow(pool,token);
  requireCondition(row.include_avatar&&row.image_bytes,404,'avatar_not_found','這張名片沒有公開頭像。');
  return row.image_bytes as Buffer;
}
export async function sharedMemberForViewer(pool:Pool,actor:Actor,token:string){
  const row=await sharedRow(pool,token);
  requireCondition(row.community_id===actor.community_id,404,'member_not_found','找不到這位工坊會員。');
  return memberCard(pool,actor,row.user_id);
}
