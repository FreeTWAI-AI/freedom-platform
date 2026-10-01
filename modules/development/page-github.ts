import {z} from 'zod';
import type {Pool} from 'pg';
import {developmentPages} from './pages.js';
import {Problem} from '../../packages/shared/problem.js';
import {postgresText} from '../community/github-history.js';

export const PLATFORM_REPOSITORY='https://github.com/FreeTWAI-AI/freedom-platform';
export const DESIGN_CLAIM_MARKER='<!-- freedom-design-claim -->';
export const FREEDOM_PLATFORM_EVENTS_FEED='freedom_platform_events';
const PLATFORM_KEY='freetwai-ai/freedom-platform';
const STALE_MS=30*60*1000;
export type PageGitHubItem={number:number;title:string;url:string;author:string;created_at:string;state:'open'|'closed';kind:'issue'|'pr';pages:string[]};
export type PageGitHubActivity={items:PageGitHubItem[];checked_at:string;truncated:boolean;partial?:boolean;stale?:boolean};
export const PAGE_GITHUB_EVENT_KINDS=['issue_opened','issue_closed','pr_opened','pr_merged','pr_closed','pr_approved','design_claimed','release_published'] as const;
export type PageGitHubEventKind=typeof PAGE_GITHUB_EVENT_KINDS[number];
export type PageGitHubEvent={id:string;kind:PageGitHubEventKind;number:number|null;title:string;url:string;actor:string;created_at:string};
export type PageGitHubEvents={items:PageGitHubEvent[];checked_at:string;truncated:boolean;stale?:boolean};
const pageIds=new Set(developmentPages.map(page=>page.id));

/** The marker survives even when the repo has not created GitHub labels yet. */
export function issuePageMarker(pageId:string){if(!pageIds.has(pageId))throw new Problem(404,'page_not_found','找不到這個頁面。');return `<!-- freedom-page:${pageId} -->`;}
export function pageIdsForIssue(body:string|null,labels:string[]):string[]{
  const found=new Set<string>();
  for(const label of labels){const match=/^page:([a-z0-9-]+)$/.exec(label);if(match&&pageIds.has(match[1]))found.add(match[1]);}
  for(const match of (body??'').matchAll(/<!--\s*freedom-page:([a-z0-9-]+)\s*-->/g))if(pageIds.has(match[1]))found.add(match[1]);
  return [...found];
}
const eventSchema=z.object({id:z.string(),type:z.string(),actor:z.object({login:z.string()}).nullable(),created_at:z.iso.datetime(),payload:z.unknown()});
const subjectSchema=z.object({number:z.number().int().positive(),title:z.string().max(1000).optional(),html_url:z.string().url().optional(),url:z.string().url().optional()});
const claimSchema=z.object({action:z.literal('created'),issue:subjectSchema.extend({pull_request:z.unknown().optional()}),comment:z.object({body:z.string().nullable(),html_url:z.string().url()})});
const reviewSchema=z.object({action:z.literal('created'),pull_request:subjectSchema,review:z.object({state:z.literal('approved').or(z.literal('APPROVED')),html_url:z.string().url()})});
const activitySchema=z.object({action:z.enum(['opened','closed','reopened']),issue:subjectSchema.extend({pull_request:z.unknown().optional()}).optional(),pull_request:subjectSchema.extend({merged:z.boolean().optional()}).optional()});
const releaseSchema=z.object({action:z.literal('published'),release:z.object({tag_name:z.string().regex(/^[\w.+-]{1,100}$/),name:z.string().max(1000).nullable().optional(),html_url:z.string().url()})});
function eventTitle(value:string|undefined,fallback:string){const text=postgresText((value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'').trim(),300);return text||fallback;}
function subjectUrl(kind:'issues'|'pull',subject:z.infer<typeof subjectSchema>){
  const html=`${PLATFORM_REPOSITORY}/${kind}/${subject.number}`;
  const api=`https://api.github.com/repos/FreeTWAI-AI/freedom-platform/${kind==='pull'?'pulls':'issues'}/${subject.number}`;
  return (subject.html_url||subject.url)&&(!subject.html_url||subject.html_url===html)&&(!subject.url||subject.url===api)?html:null;
}
export function publicEvent(raw:unknown):PageGitHubEvent|null{
  const parsed=eventSchema.safeParse(raw);if(!parsed.success||!parsed.data.actor)return null;
  const {id,type,actor,created_at,payload}=parsed.data;
  if(type==='IssueCommentEvent'){
    const value=claimSchema.safeParse(payload);if(!value.success||value.data.issue.pull_request||!value.data.comment.body?.includes(DESIGN_CLAIM_MARKER)||!subjectUrl('issues',value.data.issue))return null;
    const {issue,comment}=value.data;
    if(!comment.html_url.startsWith(`${PLATFORM_REPOSITORY}/issues/${issue.number}#issuecomment-`))return null;
    return {id,kind:'design_claimed',number:issue.number,title:eventTitle(issue.title,`Issue #${issue.number}`),url:comment.html_url,actor:actor.login,created_at};
  }
  if(type==='PullRequestReviewEvent'){
    const value=reviewSchema.safeParse(payload);if(!value.success||!subjectUrl('pull',value.data.pull_request))return null;
    const {pull_request,review}=value.data;
    if(!review.html_url.startsWith(`${PLATFORM_REPOSITORY}/pull/${pull_request.number}#pullrequestreview-`))return null;
    return {id,kind:'pr_approved',number:pull_request.number,title:eventTitle(pull_request.title,`PR #${pull_request.number}`),url:review.html_url,actor:actor.login,created_at};
  }
  if(type==='IssuesEvent'||type==='PullRequestEvent'){
    const value=activitySchema.safeParse(payload);if(!value.success||value.data.action==='reopened')return null;
    if(type==='IssuesEvent'){
      const issue=value.data.issue;
      if(!issue||issue.pull_request||!subjectUrl('issues',issue))return null;
      const kind=value.data.action==='closed'?'issue_closed':'issue_opened';
      return {id,kind,number:issue.number,title:eventTitle(issue.title,`Issue #${issue.number}`),url:`${PLATFORM_REPOSITORY}/issues/${issue.number}`,actor:actor.login,created_at};
    }
    const pull=value.data.pull_request;
    if(!pull||!subjectUrl('pull',pull)||(value.data.action!=='opened'&&value.data.action!=='closed'))return null;
    const kind=value.data.action==='opened'?'pr_opened':pull.merged===true?'pr_merged':'pr_closed';
    return {id,kind,number:pull.number,title:eventTitle(pull.title,`PR #${pull.number}`),url:`${PLATFORM_REPOSITORY}/pull/${pull.number}`,actor:actor.login,created_at};
  }
  if(type==='ReleaseEvent'){
    const value=releaseSchema.safeParse(payload);if(!value.success)return null;
    const tag=value.data.release.tag_name,url=`${PLATFORM_REPOSITORY}/releases/tag/${tag}`;
    if(value.data.release.html_url!==url)return null;
    return {id,kind:'release_published',number:null,title:eventTitle(value.data.release.name??undefined,tag),url,actor:actor.login,created_at};
  }
  return null;
}

type ActivityRow={number:number;kind:'issue'|'pr';title:string;author_login:string|null;state:'open'|'closed';created_at:Date;page_ids:string[]|null};
function itemFromRow(row:ActivityRow):PageGitHubItem{
  return {number:row.number,title:row.title,url:`${PLATFORM_REPOSITORY}/${row.kind==='pr'?'pull':'issues'}/${row.number}`,author:row.author_login??'GitHub 使用者',created_at:new Date(row.created_at).toISOString(),state:row.state,kind:row.kind,pages:row.page_ids??[]};
}

/** Stored platform issues and pull requests. `refresh` only re-reads PostgreSQL. */
export class PageGitHubReader {
  constructor(private pool:Pool,private now=()=>Date.now()){}
  async read(pageId?:string,_refresh=false):Promise<PageGitHubActivity>{
    if(pageId&&!pageIds.has(pageId))throw new Problem(404,'page_not_found','找不到這個頁面。');
    const repo=(await this.pool.query<{last_synced_at:Date|null;access_status:string}>('SELECT last_synced_at, access_status FROM github_sync_repositories WHERE repository_key=$1',[PLATFORM_KEY])).rows[0];
    const syncedAt=repo?.last_synced_at?new Date(repo.last_synced_at).getTime():null;
    const partial=!repo||repo.access_status==='pending'||syncedAt==null;
    const stale=syncedAt==null||this.now()-syncedAt>STALE_MS;
    const checkedAt=syncedAt==null?new Date(this.now()).toISOString():new Date(syncedAt).toISOString();
    const rows=pageId
      ?(await this.pool.query<ActivityRow>(`SELECT number, kind, title, author_login, state, created_at, page_ids FROM github_items
        WHERE repository_key=$1 AND kind='issue' AND state='open' AND $2=ANY(page_ids) ORDER BY created_at DESC, number DESC LIMIT 101`,[PLATFORM_KEY,pageId])).rows
      :(await this.pool.query<ActivityRow>(`SELECT number, kind, title, author_login, state, created_at, page_ids FROM github_items
        WHERE repository_key=$1 ORDER BY created_at DESC, number DESC LIMIT 101`,[PLATFORM_KEY])).rows;
    return {items:rows.slice(0,100).map(itemFromRow),checked_at:checkedAt,truncated:rows.length>100,...(partial?{partial:true}:{}),...(stale?{stale:true}:{})};
  }
}

/** Stored public events. Opening a page is never an event; the cron fills this feed. */
export class PageGitHubEventReader {
  constructor(private pool:Pool,private now=()=>Date.now()){}
  async read():Promise<PageGitHubEvents>{
    const feed=(await this.pool.query<{checked_at:Date|null;last_error:string|null}>('SELECT checked_at, last_error FROM github_feed_state WHERE feed_name=$1',[FREEDOM_PLATFORM_EVENTS_FEED])).rows[0];
    const checked=feed?.checked_at?new Date(feed.checked_at).getTime():null;
    const stale=!feed||checked==null||this.now()-checked>STALE_MS||Boolean(feed.last_error);
    const rows=(await this.pool.query<{event_id:string;kind:PageGitHubEventKind;number:number|null;title:string;url:string;actor:string;created_at:Date}>(
      'SELECT event_id, kind, number, title, url, actor, created_at FROM github_repository_events ORDER BY created_at DESC, event_id DESC LIMIT 101')).rows;
    return {items:rows.slice(0,100).map(row=>({id:row.event_id,kind:row.kind,number:row.number,title:row.title,url:row.url,actor:row.actor,created_at:new Date(row.created_at).toISOString()})),checked_at:checked==null?new Date(this.now()).toISOString():new Date(checked).toISOString(),truncated:rows.length>100,...(stale?{stale:true}:{})};
  }
}
