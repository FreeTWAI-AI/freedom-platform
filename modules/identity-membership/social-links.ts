import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {command,checkVersion,journal,type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from './service.js';

const platformKeys=['facebook','instagram','youtube','threads','tiktok','linkedin','x','website','other'] as const;
const audienceKeys=['public','friends','squad','guild'] as const;
const control=/[\x00-\x1f\x7f]/;
const providerDomains:Partial<Record<typeof platformKeys[number],string[]>>={facebook:['facebook.com','fb.com'],instagram:['instagram.com'],youtube:['youtube.com','youtu.be'],threads:['threads.net','threads.com'],tiktok:['tiktok.com'],linkedin:['linkedin.com'],x:['x.com','twitter.com']};
function privateIpv4(host:string){const [a,b,c]=host.split('.').map(Number);return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||a===192&&b===0&&c===0||a>=224;}
function privateHost(host:string){
 const name=host.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
 const version=isIP(name);
 if(version===4)return privateIpv4(name);
 if(version===6){
  if(name==='::'||name==='::1'||/^f[cd]/.test(name)||/^fe[89ab]/.test(name)||/^ff/.test(name))return true;
  // WHATWG URL normalizes dotted IPv4-mapped addresses into two hextets.
  const mapped=/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(name);
  if(mapped){const first=parseInt(mapped[1],16),last=parseInt(mapped[2],16);return privateIpv4(`${first>>8}.${first&255}.${last>>8}.${last&255}`);}
  // Other IPv4-compatible/translated forms use the reserved :: prefix.
  return name.startsWith('::');
 }
 return !name.includes('.')||name==='localhost'||['.localhost','.local','.internal','.lan','.home'].some(suffix=>name.endsWith(suffix));
}
export const SocialLinkInput=z.object({
 platform:z.enum(platformKeys),label:z.string().trim().min(1).max(80).refine(value=>!control.test(value),'名稱請使用單行文字。'),
 url:z.string().refine(value=>!control.test(value),'網址不可包含控制字元。').trim().min(1).max(2048),
 audiences:z.array(z.enum(audienceKeys)).max(4).refine(values=>new Set(values).size===values.length,'公開對象不可重複。').default([]),
}).strict();
function validatedInput(raw:unknown){
 const input=SocialLinkInput.parse(raw);let parsed:URL|undefined;try{parsed=new URL(input.url);}catch{}
 requireCondition(parsed?.protocol==='https:'&&!parsed.username&&!parsed.password&&!privateHost(parsed.hostname),422,'social_link_url_invalid','請填公開網站的 HTTPS 網址，不可含帳密或本機位址。');
 const host=parsed.hostname.toLowerCase().replace(/\.$/,''),domains=providerDomains[input.platform];
 requireCondition(!domains||domains.some(domain=>host===domain||host.endsWith('.'+domain)),422,'social_link_platform_mismatch','網址與選擇的平台不符；自訂網站請選「網站」或「其他」。');
 const url=parsed.toString();requireCondition(url.length<=2048,422,'social_link_url_invalid','網址過長。');
 return {...input,url,audiences:input.audiences.includes('public')?['public']:[...input.audiences].sort()};
}
export const SocialLinkPagination=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict();
export const VisibleSocialLinkPagination=SocialLinkPagination.extend({limit:z.coerce.number().int().min(1).max(50).default(6)});
const ownColumns='link_id,platform,label,url,audiences,aggregate_version,created_at,updated_at';
function ownEntry(row:any){return {...row,aggregate_version:Number(row.aggregate_version),created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString(),verified:false as const};}
function tombstone(row:any){return {link_id:row.link_id,deleted:true as const,aggregate_version:Number(row.aggregate_version)};}
// Reuse this predicate within the SAME query as the projected rows. An old
// Actor object or a revoked cookie must not restore read access.
const activeViewer=`SELECT u.user_id FROM users u JOIN sessions s ON s.user_id=u.user_id WHERE u.user_id=$1 AND u.community_id=$2
 AND u.active AND s.token_hash=$3 AND s.revoked_at IS NULL AND s.expires_at>now()`;
export async function ownSocialLinks(pool:Pool,actor:Actor,raw:unknown={}){
 const {limit,offset}=SocialLinkPagination.parse(raw);
 const row=(await pool.query(`WITH viewer AS (${activeViewer}), links AS (
 SELECT l.${ownColumns.replaceAll(',',',l.')} FROM member_social_links l JOIN viewer v ON v.user_id=l.user_id
 WHERE l.community_id=$2 AND l.deleted_at IS NULL), page AS (
 SELECT * FROM links ORDER BY created_at,link_id LIMIT $4 OFFSET $5)
 SELECT EXISTS(SELECT 1 FROM viewer) AS viewer_valid,(SELECT count(*)::int FROM links) AS total,
 COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at,link_id) FROM page),'[]'::jsonb) AS items`,[actor.user_id,actor.community_id,actor.session_hash,limit,offset])).rows[0];
 requireCondition(row.viewer_valid,401,'session_expired','請重新登入。');
 return {items:row.items.map(ownEntry),total:row.total,next_offset:offset+limit<row.total?offset+limit:null};
}
async function ownedRow(q:Pool|PoolClient,actor:Actor,id:string,lock=false){
 const row=(await q.query(`SELECT * FROM member_social_links WHERE link_id=$1 AND user_id=$2 AND community_id=$3${lock?' FOR UPDATE':''}`,[id,actor.user_id,actor.community_id])).rows[0];
 requireCondition(row,404,'social_link_not_found','找不到這個連結。');return row;
}
async function currentOwnEntry(pool:Pool,actor:Actor,id:string){
 const row=(await pool.query(`WITH viewer AS (${activeViewer}) SELECT l.* FROM member_social_links l JOIN viewer v ON v.user_id=l.user_id
 WHERE l.link_id=$4 AND l.community_id=$2`,[actor.user_id,actor.community_id,actor.session_hash,id])).rows[0];
 requireCondition(row,404,'social_link_not_found','找不到這個連結，請重新整理。');
 if(row.deleted_at)return tombstone(row);
 // Explicitly select only fields intended for the owner, not raw DB metadata.
 const {link_id,platform,label,url,audiences,aggregate_version,created_at,updated_at}=row;
 return ownEntry({link_id,platform,label,url,audiences,aggregate_version,created_at,updated_at});
}
export async function createSocialLink(pool:Pool,input:Command){
 const body=validatedInput(input.body);
 const ref=await command(pool,input,async()=>{},async q=>{
  const row=(await q.query(`INSERT INTO member_social_links(link_id,community_id,user_id,platform,label,url,audiences) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING link_id,aggregate_version`,[randomUUID(),input.actor.community_id,input.actor.user_id,body.platform,body.label,body.url,body.audiences])).rows[0];
  await journal(q,input.actor,'member_social_link',row.link_id,row.aggregate_version,'create_social_link',{});
  return {link_id:row.link_id,aggregate_version:row.aggregate_version};
 });
 // Receipts contain identifiers and versions only. A retry must read today's
 // value, including later edits/deletion, never replay a historic private URL.
 return currentOwnEntry(pool,input.actor,ref.link_id);
}
export async function editSocialLink(pool:Pool,input:Command,id:string){
 id=z.uuid().parse(id).toLowerCase();const body=validatedInput(input.body);
 const ref=await command(pool,input,q=>ownedRow(q,input.actor,id),async q=>{
  const prior=await ownedRow(q,input.actor,id,true);requireCondition(!prior.deleted_at,404,'social_link_not_found','這個連結已刪除。');checkVersion(prior.aggregate_version,input.expected);
  const row=(await q.query(`UPDATE member_social_links SET platform=$2,label=$3,url=$4,audiences=$5,aggregate_version=aggregate_version+1,updated_at=now() WHERE link_id=$1 RETURNING link_id,aggregate_version`,[id,body.platform,body.label,body.url,body.audiences])).rows[0];
  await journal(q,input.actor,'member_social_link',id,row.aggregate_version,'edit_social_link',{});return {link_id:id,aggregate_version:row.aggregate_version};
 });
 return currentOwnEntry(pool,input.actor,ref.link_id);
}
export async function deleteSocialLink(pool:Pool,input:Command,id:string){
 id=z.uuid().parse(id).toLowerCase();z.object({}).strict().parse(input.body);
 const ref=await command(pool,input,q=>ownedRow(q,input.actor,id),async q=>{
  const prior=await ownedRow(q,input.actor,id,true);checkVersion(prior.aggregate_version,input.expected);
  if(prior.deleted_at)return {link_id:id,aggregate_version:prior.aggregate_version};
  const row=(await q.query('UPDATE member_social_links SET deleted_at=now(),updated_at=now(),aggregate_version=aggregate_version+1 WHERE link_id=$1 RETURNING aggregate_version',[id])).rows[0];
  await journal(q,input.actor,'member_social_link',id,row.aggregate_version,'delete_social_link',{});return {link_id:id,aggregate_version:row.aggregate_version};
 });
 return currentOwnEntry(pool,input.actor,ref.link_id);
}
export async function visibleSocialLinks(pool:Pool,actor:Actor,memberId:string,raw:unknown={}){
 memberId=z.uuid().parse(memberId).toLowerCase();const {limit,offset}=VisibleSocialLinkPagination.parse(raw);
 // All link values, audience predicates, count and page are one PostgreSQL
 // statement snapshot. Hidden entries cannot influence total or pagination.
 const row=(await pool.query(`WITH viewer AS (${activeViewer} AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)),
 target AS (SELECT u.user_id FROM users u WHERE u.user_id=$4 AND u.community_id=$2 AND u.active
   AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)),
 relationships AS (SELECT $1::uuid=$4::uuid AS self,
   EXISTS(SELECT 1 FROM member_friendships f WHERE f.community_id=$2 AND f.low_ref=LEAST($1::uuid,$4::uuid) AND f.high_ref=GREATEST($1::uuid,$4::uuid) AND f.state='accepted') AS friend,
   EXISTS(SELECT 1 FROM positioning_profession_memberships a JOIN positioning_profession_memberships b USING(community_id,guild_key)
     WHERE a.community_id=$2 AND a.user_id=$1 AND b.user_id=$4 AND a.state='active' AND b.state='active') AS guild,
   EXISTS(SELECT 1 FROM member_squad_memberships a JOIN member_squad_memberships b USING(squad_id) JOIN member_squads s USING(squad_id)
     WHERE s.community_id=$2 AND a.user_id=$1 AND b.user_id=$4 AND a.state='active' AND b.state='active') AS squad),
 visible AS (SELECT l.link_id,l.platform,l.label,l.url,l.created_at FROM member_social_links l
   JOIN target t ON t.user_id=l.user_id CROSS JOIN viewer v CROSS JOIN relationships r
   WHERE l.community_id=$2 AND l.deleted_at IS NULL AND (r.self OR 'public'=ANY(l.audiences)
     OR r.friend AND 'friends'=ANY(l.audiences) OR r.guild AND 'guild'=ANY(l.audiences) OR r.squad AND 'squad'=ANY(l.audiences))),
 page AS (SELECT * FROM visible ORDER BY created_at,link_id LIMIT $5 OFFSET $6)
 SELECT EXISTS(SELECT 1 FROM viewer) AS viewer_valid,EXISTS(SELECT 1 FROM target) AS target_valid,
   (SELECT count(*)::int FROM visible) AS total,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('link_id',link_id,'platform',platform,'label',label,'url',url,'verified',false) ORDER BY created_at,link_id) FROM page),'[]'::jsonb) AS items`,
  [actor.user_id,actor.community_id,actor.session_hash,memberId,limit,offset])).rows[0];
 requireCondition(row.viewer_valid,403,'member_access_required','請登入並完成會員定位。');requireCondition(row.target_valid,404,'member_not_found','找不到這位會員。');
 return {items:row.items,total:row.total,next_offset:offset+limit<row.total?offset+limit:null};
}
