import {z} from 'zod';
import {developmentPages} from './pages.js';
import {Problem} from '../../packages/shared/problem.js';

export const PLATFORM_REPOSITORY='https://github.com/FreeTWAI-AI/freedom-platform';
export const DESIGN_CLAIM_MARKER='<!-- freedom-design-claim -->';
const itemSchema=z.object({number:z.number().int().positive(),title:z.string().max(1000),body:z.string().nullable(),state:z.enum(['open','closed']),created_at:z.iso.datetime(),user:z.object({login:z.string().max(100)}).nullable(),labels:z.array(z.union([z.string(),z.object({name:z.string()})])).max(100),pull_request:z.unknown().optional()});
export type PageGitHubItem={number:number;title:string;url:string;author:string;created_at:string;state:'open'|'closed';kind:'issue'|'pr';pages:string[]};
export type PageGitHubActivity={items:PageGitHubItem[];checked_at:string;truncated:boolean};
export type PageGitHubEvent={id:string;kind:'issue_opened'|'pr_opened'|'pr_approved'|'design_claimed';number:number;title:string;url:string;actor:string;created_at:string};
export type PageGitHubEvents={items:PageGitHubEvent[];checked_at:string;truncated:boolean};
const pageIds=new Set(developmentPages.map(page=>page.id));
const headers={Accept:'application/vnd.github+json','User-Agent':'Freedom-Platform-page-tools','X-GitHub-Api-Version':'2022-11-28'};
async function readPublicGitHub(fetcher:typeof fetch,url:string,token?:string){
  const request=(authorization?:string)=>fetcher(url,{headers:{...headers,...(authorization?{Authorization:`Bearer ${authorization}`}:{})},signal:AbortSignal.timeout(10000)});
  let response=await request(token);
  // A stale read token must not hide public GitHub data. Never retry writes here.
  if(token&&(response.status===401||response.status===403)){await response.body?.cancel();response=await request();}
  if(!response.ok){console.warn('github_public_read_failed',new URL(url).pathname,response.status,response.headers.get('x-ratelimit-remaining'));throw new Problem(503,'github_unavailable','暫時無法同步 GitHub，請稍後再試。');}
  return response;
}

/** The marker survives even when the repo has not created GitHub labels yet. */
export function issuePageMarker(pageId:string){if(!pageIds.has(pageId))throw new Problem(404,'page_not_found','找不到這個頁面。');return `<!-- freedom-page:${pageId} -->`;}
export function pageIdsForIssue(body:string|null,labels:string[]):string[]{
  const found=new Set<string>();
  for(const label of labels){const match=/^page:([a-z0-9-]+)$/.exec(label);if(match&&pageIds.has(match[1]))found.add(match[1]);}
  for(const match of (body??'').matchAll(/<!--\s*freedom-page:([a-z0-9-]+)\s*-->/g))if(pageIds.has(match[1]))found.add(match[1]);
  return [...found];
}

export class PageGitHubReader {
  private cached:{expires:number;value:PageGitHubActivity}|null=null;
  private pending:Promise<PageGitHubActivity>|null=null;
  constructor(private fetcher:typeof fetch=fetch,private now=()=>Date.now(),private readToken:()=>string|undefined=()=>undefined){}
  async read(pageId?:string,refresh=false){
    if(pageId&&!pageIds.has(pageId))throw new Problem(404,'page_not_found','找不到這個頁面。');
    const activity=await this.all(refresh);
    return {...activity,items:pageId?activity.items.filter(item=>item.kind==='issue'&&item.state==='open'&&item.pages.includes(pageId)):activity.items};
  }
  private async all(refresh=false):Promise<PageGitHubActivity>{
    if(this.cached&&(this.cached.expires>this.now()&&!refresh||refresh&&this.now()-Date.parse(this.cached.value.checked_at)<30000))return this.cached.value;
    if(this.pending)return this.pending;
    this.pending=this.refresh().then(value=>{this.cached={value,expires:this.now()+90000};return value}).finally(()=>{this.pending=null});
    return this.pending;
  }
  private async refresh():Promise<PageGitHubActivity>{
    // Workerd's native fetch must be called without this reader as its receiver.
    const fetcher=this.fetcher;
    const token=this.readToken();
    const response=await readPublicGitHub(fetcher,'https://api.github.com/repos/FreeTWAI-AI/freedom-platform/issues?state=all&sort=created&direction=desc&per_page=100',token);
    const parsed=z.array(itemSchema).max(100).safeParse(await response.json());
    if(!parsed.success)throw new Problem(503,'github_invalid_response','GitHub 資料暫時無法解析，請稍後再試。');
    return {checked_at:new Date(this.now()).toISOString(),truncated:parsed.data.length===100,items:parsed.data.map(item=>({number:item.number,title:item.title,url:`${PLATFORM_REPOSITORY}/${item.pull_request?'pull':'issues'}/${item.number}`,author:item.user?.login??'GitHub 使用者',created_at:item.created_at,state:item.state,kind:item.pull_request?'pr' as const:'issue' as const,pages:pageIdsForIssue(item.body,item.labels.map(label=>typeof label==='string'?label:label.name))}))};
  }
}

const eventSchema=z.object({id:z.string(),type:z.string(),actor:z.object({login:z.string()}).nullable(),created_at:z.iso.datetime(),payload:z.unknown()});
const subjectSchema=z.object({number:z.number().int().positive(),title:z.string().max(1000),html_url:z.string().url()});
const claimSchema=z.object({action:z.literal('created'),issue:subjectSchema.extend({pull_request:z.unknown().optional()}),comment:z.object({body:z.string().nullable(),html_url:z.string().url()})});
const reviewSchema=z.object({action:z.literal('created'),pull_request:subjectSchema,review:z.object({state:z.literal('approved').or(z.literal('APPROVED')),html_url:z.string().url()})});
const openedSchema=z.object({action:z.literal('opened'),issue:subjectSchema.optional(),pull_request:subjectSchema.optional()});
const repoIssueUrl=/^https:\/\/github\.com\/FreeTWAI-AI\/freedom-platform\/issues\/([1-9][0-9]*)$/;
const repoPullUrl=/^https:\/\/github\.com\/FreeTWAI-AI\/freedom-platform\/pull\/([1-9][0-9]*)$/;
function publicEvent(raw:unknown):PageGitHubEvent|null{
  const parsed=eventSchema.safeParse(raw);if(!parsed.success||!parsed.data.actor)return null;
  const {id,type,actor,created_at,payload}=parsed.data;
  if(type==='IssueCommentEvent'){
    const value=claimSchema.safeParse(payload);if(!value.success||value.data.issue.pull_request||!value.data.comment.body?.includes(DESIGN_CLAIM_MARKER)||!repoIssueUrl.test(value.data.issue.html_url))return null;
    const {issue,comment}=value.data;
    if(!comment.html_url.startsWith(`${issue.html_url}#issuecomment-`))return null;
    return {id,kind:'design_claimed',number:issue.number,title:issue.title,url:comment.html_url,actor:actor.login,created_at};
  }
  if(type==='PullRequestReviewEvent'){
    const value=reviewSchema.safeParse(payload);if(!value.success||!repoPullUrl.test(value.data.pull_request.html_url))return null;
    const {pull_request,review}=value.data;
    if(!review.html_url.startsWith(`${pull_request.html_url}#pullrequestreview-`))return null;
    return {id,kind:'pr_approved',number:pull_request.number,title:pull_request.title,url:review.html_url,actor:actor.login,created_at};
  }
  if(type==='IssuesEvent'||type==='PullRequestEvent'){
    const value=openedSchema.safeParse(payload);if(!value.success)return null;
    const subject=type==='IssuesEvent'?value.data.issue:value.data.pull_request;
    if(!subject||!(type==='IssuesEvent'?repoIssueUrl:repoPullUrl).test(subject.html_url))return null;
    return {id,kind:type==='IssuesEvent'?'issue_opened':'pr_opened',number:subject.number,title:subject.title,url:subject.html_url,actor:actor.login,created_at};
  }
  return null;
}

/** Repository Events API is the authority for public announcements; opening a page is never an event. */
export class PageGitHubEventReader {
  private cached:{expires:number;value:PageGitHubEvents}|null=null;
  private pending:Promise<PageGitHubEvents>|null=null;
  constructor(private fetcher:typeof fetch=fetch,private now=()=>Date.now(),private readToken:()=>string|undefined=()=>undefined){}
  async read():Promise<PageGitHubEvents>{
    if(this.cached&&this.cached.expires>this.now())return this.cached.value;
    if(this.pending)return this.pending;
    this.pending=this.refresh().then(value=>{this.cached={value,expires:this.now()+90000};return value}).finally(()=>{this.pending=null});
    return this.pending;
  }
  private async refresh():Promise<PageGitHubEvents>{
    const fetcher=this.fetcher;
    const token=this.readToken();
    const response=await readPublicGitHub(fetcher,'https://api.github.com/repos/FreeTWAI-AI/freedom-platform/events?per_page=100',token);
    const raw=await response.json();
    if(!Array.isArray(raw)||raw.length>100)throw new Problem(503,'github_invalid_response','GitHub 資料暫時無法解析，請稍後再試。');
    return {checked_at:new Date(this.now()).toISOString(),truncated:raw.length===100,items:raw.map(publicEvent).filter((event):event is PageGitHubEvent=>event!==null)};
  }
}
