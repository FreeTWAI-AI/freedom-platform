import {createHash,randomBytes} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';
import {command, checkVersion, journal, type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {capabilityCategories} from '../community/catalog.js';
import type {Actor} from './service.js';
import {memberCard} from './members.js';

const Token=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const designs=['calm','workshop','night','classic'] as const;
export type MemberCardDesign=typeof designs[number];
export type MemberCardLink={label:string;url:string};
const control=/[\u0000-\u001f\u007f]/;
const chars=(value:string)=>Array.from(value).length;
const Settings=z.object({
  enabled:z.boolean(),include_avatar:z.boolean(),rotate:z.boolean().default(false),
  design:z.unknown().optional(),headline:z.unknown().optional(),links:z.unknown().optional(),
}).strict();
const labels=Object.fromEntries(capabilityCategories.flatMap(group=>group.items.map(item=>[item.id,item.label])));

function cardDesign(value:unknown):MemberCardDesign{
  requireCondition(typeof value==='string'&&(designs as readonly string[]).includes(value),422,'member_card_design_invalid','名片樣式請選擇清新、工坊、夜空或經典名片。');
  return value as MemberCardDesign;
}
function cardHeadline(value:unknown){
  requireCondition(value===null||typeof value==='string',422,'member_card_headline_invalid','一句話介紹請使用文字。');
  if(value===null)return null;
  requireCondition(!control.test(value),422,'member_card_headline_invalid','一句話介紹請使用單行文字。');
  const text=value.trim();
  requireCondition(chars(text)<=60,422,'member_card_headline_invalid','一句話介紹最多 60 個字。');
  return text||null;
}
function cardUrl(value:string){
  requireCondition(!control.test(value),422,'member_card_links_invalid','名片連結只接受 https 網址。');
  const raw=value.trim();
  requireCondition(chars(raw)<=300&&chars(raw)>0,422,'member_card_links_invalid',chars(raw)>300?'名片連結網址最多 300 個字。':'名片連結只接受 https 網址。');
  let parsed:URL|undefined;try{parsed=new URL(raw);}catch{/* invalid */}
  requireCondition(parsed,422,'member_card_links_invalid','名片連結只接受 https 網址。');
  requireCondition(!parsed.username&&!parsed.password,422,'member_card_links_invalid','名片連結不可包含帳號或密碼。');
  requireCondition(parsed.protocol==='https:',422,'member_card_links_invalid','名片連結只接受 https 網址。');
  requireCondition(chars(parsed.href)<=300,422,'member_card_links_invalid','名片連結網址最多 300 個字。');
  return parsed.href;
}
function cardLinks(value:unknown):MemberCardLink[]{
  requireCondition(Array.isArray(value),422,'member_card_links_invalid','名片連結必須是清單。');
  requireCondition(value.length<=8,422,'member_card_links_invalid','名片連結最多 8 個。');
  return value.map(item=>{
    requireCondition(item&&typeof item==='object'&&!Array.isArray(item),422,'member_card_links_invalid','名片連結只接受名稱與網址。');
    const record=item as Record<string,unknown>;
    requireCondition(Object.keys(record).length===2&&'label' in record&&'url' in record,422,'member_card_links_invalid','名片連結只接受名稱與網址。');
    requireCondition(typeof record.label==='string'&&typeof record.url==='string',422,'member_card_links_invalid','名片連結只接受名稱與網址。');
    requireCondition(!control.test(record.label),422,'member_card_links_invalid','連結名稱請使用單行文字。');
    const label=record.label.trim();
    requireCondition(chars(label)>=1&&chars(label)<=30,422,'member_card_links_invalid','連結名稱需要 1 到 30 個字。');
    return {label,url:cardUrl(record.url)};
  });
}
function storedLinks(value:unknown):MemberCardLink[]{
  const parsed=typeof value==='string'?JSON.parse(value):value;
  if(!Array.isArray(parsed))return [];
  return parsed.flatMap(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return [];
    const label=(item as {label?:unknown}).label,url=(item as {url?:unknown}).url;
    if(typeof label!=='string'||typeof url!=='string')return [];
    try{return [{label,url:cardUrl(url)}];}catch{return [];}
  }).slice(0,8);
}
function featuredLabels(profile:any){
  const available=[...(profile?.capabilities??[]),...(profile?.custom_capabilities??[]).map((value:string)=>`custom:${value}`)];
  const featured=(profile?.featured_capabilities??available).filter((value:string)=>available.includes(value)).slice(0,3);
  return featured.map((id:string)=>id.startsWith('custom:')?id.slice(7):labels[id]??id);
}
function cardSummary(headline:string|null,guild:string|null,capabilities:string[]){
  if(headline)return Array.from(headline).slice(0,120).join('');
  let text=[guild,...capabilities.slice(0,3)].filter((part):part is string=>Boolean(part)).join('・');
  const pieces=Array.from(text);
  if(pieces.length<=120)return text;
  text=pieces.slice(0,120).join('');
  return text.endsWith('・')?text.slice(0,-1):text;
}
const settings=(row:any)=>({
  enabled:row?.enabled??false,include_avatar:row?.include_avatar??false,aggregate_version:row?.aggregate_version??null,
  share_path:row?.enabled?`/member-cards/${row.share_token}`:null,
  design:(row?.design??'calm') as MemberCardDesign,headline:row?.headline??null,links:row?storedLinks(row.links):[],
});
export async function memberShareSettings(pool:Pool,actor:Actor){
  return settings((await pool.query('SELECT enabled,include_avatar,aggregate_version,share_token,design,headline,links FROM member_card_shares WHERE user_id=$1 AND community_id=$2',[actor.user_id,actor.community_id])).rows[0]);
}
export async function saveMemberShare(pool:Pool,input:Command){
  const body=Settings.parse(input.body);
  const design=body.design===undefined?undefined:cardDesign(body.design);
  const headline=body.headline===undefined?undefined:cardHeadline(body.headline);
  const links=body.links===undefined?undefined:cardLinks(body.links);
  return command(pool,input,async q=>{
    const visible=await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(user_id)',[input.actor.user_id,input.actor.community_id]);
    requireCondition(visible.rowCount===1,403,'member_share_unavailable','完成加入流程的會員才能分享名片。');
  },async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`member-share/${input.actor.user_id}`]);
    const current=(await q.query('SELECT * FROM member_card_shares WHERE user_id=$1 AND community_id=$2 FOR UPDATE',[input.actor.user_id,input.actor.community_id])).rows[0];
    if(current)checkVersion(current.aggregate_version,input.expected);
    else requireCondition(!input.expected,412,'version_conflict','分享設定已變更，請重新載入。');
    const token=!current||body.rotate||body.enabled&&!current.enabled?randomBytes(32).toString('base64url'):current.share_token;
    const nextDesign=design??current?.design??'calm';
    const nextHeadline=headline===undefined?(current?.headline??null):headline;
    const nextLinks=links===undefined?storedLinks(current?.links):links;
    const row=(await q.query(`INSERT INTO member_card_shares(user_id,community_id,share_token,enabled,include_avatar,design,headline,links) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT(user_id) DO UPDATE SET share_token=$3,enabled=$4,include_avatar=$5,design=$6,headline=$7,links=$8::jsonb,aggregate_version=member_card_shares.aggregate_version+1,updated_at=now() RETURNING *`,
      [input.actor.user_id,input.actor.community_id,token,body.enabled,body.include_avatar,nextDesign,nextHeadline,JSON.stringify(nextLinks)])).rows[0];
    // Audit records the choice, never the capability token or the link targets.
    await journal(q,input.actor,'member_card_share',input.actor.user_id,row.aggregate_version,'save_member_card_share',{enabled:body.enabled,include_avatar:body.include_avatar,rotated:token!==current?.share_token,design:nextDesign,headline_length:nextHeadline?chars(nextHeadline):0,link_count:nextLinks.length});
    return settings(row);
  });
}
async function sharedRow(q:Pool|PoolClient,token:string){
  Token.parse(token);
  const row=(await q.query(`SELECT u.user_id,u.community_id,u.display_name,s.include_avatar,s.design,s.headline,s.links,
      a.published_profile,(av.image_bytes IS NOT NULL) AS has_avatar,
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
  const row=await sharedRow(pool,token);
  return {nickname:row.display_name,primary_guild:row.primary_guild??null,capabilities:featuredLabels(row.published_profile),
    avatar_url:row.include_avatar&&row.has_avatar?`/api/v1/public/member-cards/${token}/avatar`:null,
    design:row.design,headline:row.headline??null,links:storedLinks(row.links)};
}
export async function publicMemberAvatar(pool:Pool,token:string){
  const row=await sharedRow(pool,token);
  requireCondition(row.include_avatar&&row.has_avatar,404,'avatar_not_found','這張名片沒有公開頭像。');
  const stored=(await pool.query('SELECT image_bytes FROM member_avatars WHERE user_id=$1 AND community_id=$2 AND image_bytes IS NOT NULL',[row.user_id,row.community_id])).rows[0];
  requireCondition(stored?.image_bytes,404,'avatar_not_found','這張名片沒有公開頭像。');
  return stored.image_bytes as Buffer;
}
export async function sharedMemberForViewer(pool:Pool,actor:Actor,token:string){
  const row=await sharedRow(pool,token);
  requireCondition(row.community_id===actor.community_id,404,'member_not_found','找不到這位工坊會員。');
  return memberCard(pool,actor,row.user_id);
}
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Read-only batch for share promotion. The token is used only to build path and generation. */
export async function readPublicCards(pool:Pool,communityId:string,userIds:string[]){
  const ids=[...new Set(userIds.filter(id=>uuidPattern.test(id)).map(id=>id.toLowerCase()))];
  const cards=new Map<string,{path:string;title:string;summary:string;image:null;generation:string}>();
  if(!ids.length||!uuidPattern.test(communityId))return cards;
  const rows=(await pool.query(`SELECT u.user_id,u.display_name,s.share_token,s.headline,a.published_profile,
      (SELECT g.name FROM guild_member_preferences p
        JOIN positioning_guild_catalog g ON g.guild_key=p.primary_guild_key
        JOIN positioning_profession_memberships m ON m.user_id=u.user_id AND m.community_id=u.community_id AND m.guild_key=g.guild_key AND m.state='active'
        WHERE p.user_id=u.user_id AND p.community_id=u.community_id) AS guild_name
    FROM member_card_shares s JOIN users u ON u.user_id=s.user_id AND u.community_id=s.community_id
      LEFT JOIN onboarding_assessments a ON a.user_id=u.user_id AND a.community_id=u.community_id
    WHERE s.community_id=$1 AND u.user_id=ANY($2::uuid[]) AND s.enabled AND u.active
      AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND NOT is_verification_test_account(u.user_id)`,[communityId,ids])).rows;
  for(const row of rows){
    const token=String(row.share_token);
    cards.set(String(row.user_id).toLowerCase(),{
      path:`/member-cards/${token}`,
      title:`${row.display_name} 的自由工坊名片`,
      summary:cardSummary(row.headline??null,row.guild_name??null,featuredLabels(row.published_profile)),
      image:null,
      generation:createHash('sha256').update(token).digest('hex').slice(0,16),
    });
  }
  return cards;
}
