import type {Pool} from 'pg';
import type {PublicDiscovery,PublicDiscoveryCard,PublicDiscoverySection} from '../../packages/shared/community-discovery.js';
import {communityCatalog} from './catalog.js';
import {resolvePublicCommunity} from './member-services.js';
import {listPublishedSkillSubmissions,PUBLISHED} from '../skill-submissions/public.js';

export const discoveryAuthorSql = `u.community_id=e.community_id AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(u.user_id)`;
export const discoveryEventSql = `e.state='published' AND e.visibility='open' AND ${discoveryAuthorSql}`;
async function section(kind:PublicDiscoverySection['kind'],read:()=>Promise<PublicDiscoveryCard[]>):Promise<PublicDiscoverySection>{
  try{return {kind,state:'ready',items:(await read()).slice(0,3)};}catch{return {kind,state:'unavailable',items:[]};}
}
/** Each source reads current authority separately; one unavailable source cannot disclose an exception or erase another. */
export async function publicDiscovery(pool:Pool,configured?:string):Promise<PublicDiscovery>{
  const scope=resolvePublicCommunity(pool,configured);
  const scoped=async(read:(id:string)=>Promise<PublicDiscoveryCard[]>)=>{const id=await scope;return id?read(id):[];};
  const sections=await Promise.all([
    section('resources',async()=>communityCatalog.skill_books.slice(0,3).map(book=>({id:book.id,title:book.title,summary:book.description,author_name:new URL(book.upstream_url).pathname.split('/')[1]||null,occurred_at:null,path:`/development/skills/${book.id}`}))),
    section('works',()=>scoped(async id=>(await listPublishedSkillSubmissions(pool,3,id)).map(work=>({id:work.submission_id,title:work.title,summary:work.description,author_name:work.author_name,occurred_at:work.published_at,path:work.public_path})))),
    ...(['events','highlights'] as const).map(kind=>section(kind,()=>scoped(async id=>{
      const rows=(await pool.query(`SELECT e.event_id AS id,e.title,e.description AS summary,u.display_name AS author_name,e.${kind==='events'?'starts_at':'ends_at'} AS occurred_at FROM community_events e JOIN users u ON u.user_id=e.organizer_ref WHERE e.community_id=$1 AND ${discoveryEventSql} AND e.ends_at${kind==='events'?'>':'<='}now() ORDER BY e.${kind==='events'?'starts_at ASC,e.event_id ASC':'ends_at DESC,e.event_id DESC'} LIMIT 3`,[id])).rows;
      return rows.map(row=>({id:row.id,title:row.title,summary:row.summary,author_name:row.author_name,occurred_at:new Date(row.occurred_at).toISOString(),path:`/${kind==='events'?'events':'highlights'}/${row.id}`}));
    }))),
    section('services',()=>scoped(async id=>(await pool.query(`SELECT s.service_id AS id,s.title,s.summary,u.display_name AS author_name,s.updated_at AS occurred_at FROM member_services s JOIN users u ON u.user_id=s.owner_user_id AND u.community_id=s.community_id WHERE s.community_id=$1 AND s.state='active' AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(u.user_id) ORDER BY s.updated_at DESC,s.service_id DESC LIMIT 3`,[id])).rows.map(row=>({id:row.id,title:row.title,summary:row.summary,author_name:row.author_name,occurred_at:new Date(row.occurred_at).toISOString(),path:`/services/${row.id}`}))))
  ]);
  return {sections};
}

/** Checks canonical public detail and media reads both before and after their existing domain reader. */
export async function discoveryReadAllowed(pool:Pool,path:string,configured?:string):Promise<boolean>{
  const work=path.match(/^\/(?:development\/submissions|api\/v1\/skill-submissions)\/([0-9a-f-]{36})(?:\/(?:SKILL\.md|illustration|share-content))?\/?$/i);
  const event=path.match(/^\/(?:highlights|events|api\/v1\/public\/events|api\/v1\/public\/event-highlights)\/([0-9a-f-]{36})(?:\/(?:banner|video))?\/?$/i);
  const media=path.match(/^\/api\/v1\/public\/event-highlights\/media\/([0-9a-f-]{36})\/(?:image|thumb)$/i);
  const service=path.match(/^\/(?:services|api\/v1\/public\/member-services)\/([0-9a-f-]{36})(?:\/cover)?\/?$/i);
  if(!event&&!media&&!service&&!work)return true;
  const community=await resolvePublicCommunity(pool,configured);
  if(!community)return false;
  if(work)return (await pool.query(`SELECT 1 ${PUBLISHED} AND s.submission_id=$1 AND s.community_id=$2`,[work[1],community])).rowCount===1;
  if(service)return (await pool.query(`SELECT 1 FROM member_services s JOIN users u ON u.user_id=s.owner_user_id AND u.community_id=s.community_id WHERE s.service_id=$1 AND s.community_id=$2 AND s.state='active' AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL) AND NOT is_verification_test_account(u.user_id)`,[service[1],community])).rowCount===1;
  const visible=event&&!path.includes('highlights')?`e.state='published' AND e.visibility IN ('open','referral') AND ${discoveryAuthorSql}`:discoveryEventSql;
  const rows=await pool.query(`SELECT 1 FROM community_events e JOIN users u ON u.user_id=e.organizer_ref ${media?'JOIN community_event_highlights h ON h.event_id=e.event_id':''} WHERE ${media?"h.media_id=$1 AND h.state='active' AND NOT is_verification_test_account(h.uploader_user_id)":"e.event_id=$1"} AND e.community_id=$2 AND ${visible}${media||path.includes('highlights')?' AND e.ends_at<=now()':''}`,[media?.[1]??event![1],community]);
  return rows.rowCount===1;
}
