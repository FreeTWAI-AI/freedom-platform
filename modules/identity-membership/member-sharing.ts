import {createHash,randomBytes} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';
import {command, checkVersion, journal, type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {capabilityCategories} from '../community/catalog.js';
import type {Actor} from './service.js';
import {memberCard,normalizedContacts} from './members.js';
import {privateHost} from './social-links.js';
import type {ObjectStore} from '../../packages/asset-storage/index.js';
import {avatarReadColumns,avatarReadJoins,readAuthorizedAvatar,type AvatarReadSnapshot} from '../assets/avatar-read.js';

const Token=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const designs=['editorial','calm','workshop','night','classic'] as const;
export type MemberCardDesign=typeof designs[number];
export type MemberCardLink={label:string;url:string};
const control=/[\u0000-\u001f\u007f]/;
const chars=(value:string)=>Array.from(value).length;
const Settings=z.object({
  enabled:z.boolean(),include_avatar:z.boolean(),rotate:z.boolean().default(false),
  design:z.unknown().optional(),headline:z.unknown().optional(),links:z.unknown().optional(),
  show_profile_links:z.unknown().optional(),profile_link_prefs:z.unknown().optional(),
}).strict();
const profileKey=/^(?:contact:(?:line|github|discord|email)|social:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export type MemberCardProfileLink={source:string;platform:string;label:string;handle:string|null;url:string|null;shown:boolean};
export type MemberCardProfileContact={value:string;audiences:readonly string[]};
export type MemberCardProfileSocial={link_id:string;platform:string;label:string;url:string;audiences:readonly string[];created_at?:string|Date|null;deleted_at?:string|Date|null};
const contactOrder=['line','github','discord','email'] as const;
const contactMeta={line:{platform:'line',label:'LINE'},github:{platform:'github',label:'GitHub'},discord:{platform:'discord',label:'Discord'},email:{platform:'email',label:'Email'}} as const;
const labels=Object.fromEntries(capabilityCategories.flatMap(group=>group.items.map(item=>[item.id,item.label])));

function cardDesign(value:unknown):MemberCardDesign{
  requireCondition(typeof value==='string'&&(designs as readonly string[]).includes(value),422,'member_card_design_invalid','名片樣式請選擇工坊誌、清新、工坊、夜空或經典名片。');
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
function cardShowProfileLinks(value:unknown){
  requireCondition(typeof value==='boolean',422,'member_card_profile_links_invalid','請選擇要不要自動放上平台公開的聯絡方式。');
  return value;
}
function cardProfilePrefs(value:unknown):Record<string,boolean>{
  requireCondition(value!==null&&typeof value==='object'&&!Array.isArray(value),422,'member_card_profile_links_invalid','名片上的聯絡方式設定格式不正確。');
  const record=value as Record<string,unknown>,keys=Object.keys(record);
  requireCondition(keys.length<=64,422,'member_card_profile_links_invalid','名片上的聯絡方式最多設定 64 項。');
  const prefs:Record<string,boolean>={};
  for(const key of keys){
    requireCondition(profileKey.test(key),422,'member_card_profile_links_invalid','名片上的聯絡方式有無法辨識的項目。');
    requireCondition(typeof record[key]==='boolean',422,'member_card_profile_links_invalid','名片上的聯絡方式只能設為顯示或隱藏。');
    prefs[key]=record[key] as boolean;
  }
  return prefs;
}
function lineProfileTarget(value:string){
  const raw=value.trim();
  if(raw&&chars(raw)<=300&&!control.test(raw)){
    let parsed:URL|undefined;try{parsed=new URL(raw);}catch{/* not a url */}
    const host=parsed?.hostname.toLowerCase().replace(/\.$/,'')??'';
    const lineHost=host==='line.me'||host.endsWith('.line.me')||host==='lin.ee'||host.endsWith('.lin.ee');
    if(parsed&&parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&lineHost&&chars(parsed.href)<=300)return {handle:null,url:raw};
  }
  if(/^@[A-Za-z0-9._-]{1,40}$/.test(raw))return {handle:raw,url:'https://line.me/R/ti/p/'+encodeURIComponent(raw)};
  if(/^[A-Za-z0-9._-]{4,20}$/.test(raw))return {handle:raw,url:'https://line.me/ti/p/~'+raw};
  return {handle:raw||null,url:null};
}
function socialHandle(url:string){try{return new URL(url).hostname.replace(/^www\./,'').replace(/\.$/,'')||null;}catch{return null;}}
const githubLogin=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
function githubProfileTarget(value:string){return githubLogin.test(value)?{handle:value,url:`https://github.com/${value}`}:{handle:value,url:null};}
function acceptedSocialUrl(value:string){
  let parsed:URL|undefined;try{parsed=new URL(value.trim());}catch{return false;}
  return parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&!privateHost(parsed.hostname);
}
function storedPrefs(value:unknown):Record<string,boolean>{
  const parsed=typeof value==='string'?JSON.parse(value):value;
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {};
  return Object.fromEntries(Object.entries(parsed as Record<string,unknown>).filter((entry):entry is [string,boolean]=>typeof entry[1]==='boolean'));
}
function storedSocial(value:unknown):MemberCardProfileSocial[]{
  const parsed=typeof value==='string'?JSON.parse(value):value;
  if(!Array.isArray(parsed))return [];
  return parsed.flatMap(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return [];
    const row=item as Record<string,unknown>;
    if(typeof row.link_id!=='string'||typeof row.url!=='string'||typeof row.label!=='string')return [];
    const audiences=Array.isArray(row.audiences)?row.audiences.filter((entry):entry is string=>typeof entry==='string'):[];
    return [{link_id:row.link_id,platform:typeof row.platform==='string'?row.platform:'other',label:row.label,url:row.url,audiences,created_at:typeof row.created_at==='string'||row.created_at instanceof Date?row.created_at:null,deleted_at:row.deleted_at?String(row.deleted_at):null}];
  });
}
/** Public profile items for a card. The client renders these URLs and never builds them. */
export function mapMemberCardProfileLinks(input:{contacts?:Partial<Record<'line'|'github'|'discord'|'email',MemberCardProfileContact|undefined>>;socialLinks?:readonly MemberCardProfileSocial[];prefs?:Record<string,boolean>|null}):MemberCardProfileLink[]{
  const contacts=input.contacts??{},prefs=input.prefs??{};
  const fromContacts=contactOrder.flatMap(key=>{
    const field=contacts[key];
    const value=field?.value?.trim()??'';
    if(!value||!field?.audiences?.includes('public'))return [];
    const source=`contact:${key}`,meta=contactMeta[key];
    const target=key==='line'?lineProfileTarget(value):key==='github'?githubProfileTarget(value):key==='discord'?{handle:value,url:null}:{handle:value,url:`mailto:${value}`};
    const shown=Object.hasOwn(prefs,source)?Boolean(prefs[source]):source!=='contact:email';
    return [{source,platform:meta.platform,label:meta.label,handle:target.handle,url:target.url,shown}];
  });
  const social=(input.socialLinks??[]).filter(link=>!link.deleted_at&&link.audiences.includes('public')&&link.url.trim()&&link.label.trim()&&acceptedSocialUrl(link.url)).slice().sort((a,b)=>{
    const time=Date.parse(String(a.created_at??''))-Date.parse(String(b.created_at??''));
    if(time)return time;
    return a.link_id<b.link_id?-1:a.link_id>b.link_id?1:0;
  }).map(link=>{
    const source=`social:${link.link_id.toLowerCase()}`;
    return {source,platform:link.platform,label:link.label,handle:socialHandle(link.url),url:link.url,shown:Object.hasOwn(prefs,source)?Boolean(prefs[source]):true};
  });
  return [...fromContacts,...social];
}
export function presentProfileLinks(items:readonly MemberCardProfileLink[],showProfileLinks:boolean,manual:readonly {url:string}[]){
  if(!showProfileLinks)return [];
  const urls=new Set(manual.map(link=>link.url));
  return items.filter(item=>item.shown&&!(item.url&&urls.has(item.url))).map(({platform,label,handle,url})=>({platform,label,handle,url}));
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
const profileColumns=`u.email,account.contacts,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'link_id',l.link_id,'platform',l.platform,'label',l.label,'url',l.url,'audiences',to_jsonb(l.audiences),'created_at',l.created_at,'deleted_at',l.deleted_at)
      ORDER BY l.created_at,l.link_id) FROM member_social_links l WHERE l.user_id=u.user_id AND l.community_id=u.community_id AND l.deleted_at IS NULL),'[]'::jsonb) AS social_links`;
function profileItemsFrom(row:any,prefs:Record<string,boolean>){
  return mapMemberCardProfileLinks({contacts:normalizedContacts(row?.contacts,row?.email??''),socialLinks:storedSocial(row?.social_links),prefs});
}
const settings=(row:any,profileLinks:MemberCardProfileLink[],prefs:Record<string,boolean>)=>({
  enabled:row?.enabled??false,include_avatar:row?.include_avatar??false,aggregate_version:row?.aggregate_version??null,
  share_path:row?.enabled?`/member-cards/${row.share_token}`:null,
  design:(row?.design??'editorial') as MemberCardDesign,headline:row?.headline??null,links:row?storedLinks(row.links):[],
  show_profile_links:row?Boolean(row.show_profile_links):true,
  profile_link_prefs:prefs,profile_links:profileLinks,
});
export async function memberShareSettings(pool:Pool,actor:Actor){
  const row=(await pool.query(`SELECT s.enabled,s.include_avatar,s.aggregate_version,s.share_token,s.design,s.headline,s.links,s.show_profile_links,s.profile_link_prefs,${profileColumns}
    FROM users u LEFT JOIN member_card_shares s ON s.user_id=u.user_id AND s.community_id=u.community_id
    LEFT JOIN member_accounts account ON account.user_id=u.user_id AND account.community_id=u.community_id
    WHERE u.user_id=$1 AND u.community_id=$2`,[actor.user_id,actor.community_id])).rows[0];
  const share=row?.aggregate_version?row:null,prefs=storedPrefs(share?.profile_link_prefs);
  return settings(share,profileItemsFrom(row,prefs),prefs);
}
export async function saveMemberShare(pool:Pool,input:Command){
  const body=Settings.parse(input.body);
  const design=body.design===undefined?undefined:cardDesign(body.design);
  const headline=body.headline===undefined?undefined:cardHeadline(body.headline);
  const links=body.links===undefined?undefined:cardLinks(body.links);
  const showProfileLinks=body.show_profile_links===undefined?undefined:cardShowProfileLinks(body.show_profile_links);
  const profilePrefs=body.profile_link_prefs===undefined?undefined:cardProfilePrefs(body.profile_link_prefs);
  return command(pool,input,async q=>{
    const visible=await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(user_id)',[input.actor.user_id,input.actor.community_id]);
    requireCondition(visible.rowCount===1,403,'member_share_unavailable','完成加入流程的會員才能分享名片。');
  },async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`member-share/${input.actor.user_id}`]);
    const current=(await q.query('SELECT * FROM member_card_shares WHERE user_id=$1 AND community_id=$2 FOR UPDATE',[input.actor.user_id,input.actor.community_id])).rows[0];
    if(current)checkVersion(current.aggregate_version,input.expected);
    else requireCondition(!input.expected,412,'version_conflict','分享設定已變更，請重新載入。');
    const token=!current||body.rotate||body.enabled&&!current.enabled?randomBytes(32).toString('base64url'):current.share_token;
    const nextDesign=design??current?.design??'editorial';
    const nextHeadline=headline===undefined?(current?.headline??null):headline;
    const nextLinks=links===undefined?storedLinks(current?.links):links;
    const nextShow=showProfileLinks===undefined?(current?Boolean(current.show_profile_links):true):showProfileLinks;
    const nextPrefs=profilePrefs===undefined?storedPrefs(current?.profile_link_prefs):profilePrefs;
    const row=(await q.query(`INSERT INTO member_card_shares(user_id,community_id,share_token,enabled,include_avatar,design,headline,links,show_profile_links,profile_link_prefs) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)
      ON CONFLICT(user_id) DO UPDATE SET share_token=$3,enabled=$4,include_avatar=$5,design=$6,headline=$7,links=$8::jsonb,show_profile_links=$9,profile_link_prefs=$10::jsonb,aggregate_version=member_card_shares.aggregate_version+1,updated_at=now() RETURNING *`,
      [input.actor.user_id,input.actor.community_id,token,body.enabled,body.include_avatar,nextDesign,nextHeadline,JSON.stringify(nextLinks),nextShow,JSON.stringify(nextPrefs)])).rows[0];
    const profile=(await q.query(`SELECT ${profileColumns} FROM users u LEFT JOIN member_accounts account ON account.user_id=u.user_id AND account.community_id=u.community_id WHERE u.user_id=$1 AND u.community_id=$2`,[input.actor.user_id,input.actor.community_id])).rows[0];
    const items=profileItemsFrom(profile,nextPrefs);
    // Audit records the choice, never the capability token, handles, or link targets.
    await journal(q,input.actor,'member_card_share',input.actor.user_id,row.aggregate_version,'save_member_card_share',{enabled:body.enabled,include_avatar:body.include_avatar,rotated:token!==current?.share_token,design:nextDesign,headline_length:nextHeadline?chars(nextHeadline):0,link_count:nextLinks.length,show_profile_links:nextShow,hidden_profile_link_count:items.filter(item=>!item.shown).length});
    return settings(row,items,nextPrefs);
  });
}
async function sharedRow(q:Pool|PoolClient,token:string){
  Token.parse(token);
  // Contacts, social links and the share predicate share this one statement snapshot.
  const row=(await q.query(`SELECT u.user_id,u.community_id,u.display_name,s.include_avatar,s.design,s.headline,s.links,s.show_profile_links,s.profile_link_prefs,
      a.published_profile,(av.present) AS has_avatar,${profileColumns},
      (SELECT jsonb_build_object('guild_key',g.guild_key,'name',g.name) FROM guild_member_preferences p
        JOIN positioning_guild_catalog g ON g.guild_key=p.primary_guild_key
        JOIN positioning_profession_memberships m ON m.user_id=u.user_id AND m.community_id=u.community_id AND m.guild_key=g.guild_key AND m.state='active'
        WHERE p.user_id=u.user_id AND p.community_id=u.community_id) AS primary_guild
    FROM member_card_shares s JOIN users u USING(user_id,community_id)
      LEFT JOIN member_accounts account USING(user_id,community_id)
      LEFT JOIN onboarding_assessments a USING(user_id,community_id)
      LEFT JOIN member_avatar_presence av USING(user_id,community_id)
    WHERE s.share_token=$1 AND s.enabled AND u.active
      AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND NOT is_verification_test_account(u.user_id)`,[token])).rows[0];
  requireCondition(row,404,'member_card_unavailable','這張名片已關閉或分享連結已更換。');
  return row;
}
export async function publicMemberCard(pool:Pool,token:string){
  const row=await sharedRow(pool,token);
  const links=storedLinks(row.links);
  const prefs=storedPrefs(row.profile_link_prefs);
  return {nickname:row.display_name,primary_guild:row.primary_guild??null,capabilities:featuredLabels(row.published_profile),
    avatar_url:row.include_avatar&&row.has_avatar?`/api/v1/public/member-cards/${token}/avatar`:null,
    design:row.design,headline:row.headline??null,links,
    profile_links:presentProfileLinks(profileItemsFrom(row,prefs),Boolean(row.show_profile_links),links)};
}
export async function publicMemberAvatar(pool:Pool,token:string,store?:ObjectStore){
  token=Token.parse(token);
  // There is currently no share expiry column. Both snapshots check the live
  // token, generation, opt-in and member state; no generic private Asset URL.
  const result=await readAuthorizedAvatar(async()=>(await pool.query<AvatarReadSnapshot>(`SELECT ${avatarReadColumns},s.aggregate_version AS share_generation
    FROM member_avatars a ${avatarReadJoins}
    JOIN member_card_shares s ON s.user_id=a.user_id AND s.community_id=a.community_id
    JOIN users u ON u.user_id=a.user_id AND u.community_id=a.community_id
    WHERE s.share_token=$1 AND s.enabled AND s.include_avatar AND u.active
      AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)
      AND NOT is_verification_test_account(u.user_id)`,[token])).rows[0],store);
  return result.image_bytes;
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
