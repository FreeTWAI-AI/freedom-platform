import {z} from 'zod';
import {developmentPages} from './pages.js';
import {Problem} from '../../packages/shared/problem.js';

export const PLATFORM_REPOSITORY='https://github.com/FreeTWAI-AI/freedom-platform';
const itemSchema=z.object({number:z.number().int().positive(),title:z.string().max(1000),body:z.string().nullable(),state:z.enum(['open','closed']),created_at:z.iso.datetime(),user:z.object({login:z.string().max(100)}).nullable(),labels:z.array(z.union([z.string(),z.object({name:z.string()})])).max(100),pull_request:z.unknown().optional()});
export type PageGitHubItem={number:number;title:string;url:string;author:string;created_at:string;state:'open'|'closed';kind:'issue'|'pr';pages:string[]};
export type PageGitHubActivity={items:PageGitHubItem[];checked_at:string;truncated:boolean};
const pageIds=new Set(developmentPages.map(page=>page.id));

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
  constructor(private fetcher:typeof fetch=fetch,private now=()=>Date.now()){}
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
    const response=await this.fetcher('https://api.github.com/repos/FreeTWAI-AI/freedom-platform/issues?state=all&sort=created&direction=desc&per_page=100',{headers:{Accept:'application/vnd.github+json','User-Agent':'Freedom-Platform-page-tools','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Problem(503,'github_unavailable','暫時無法同步 GitHub，請稍後再試。');
    const parsed=z.array(itemSchema).max(100).safeParse(await response.json());
    if(!parsed.success)throw new Problem(503,'github_invalid_response','GitHub 資料暫時無法解析，請稍後再試。');
    return {checked_at:new Date(this.now()).toISOString(),truncated:parsed.data.length===100,items:parsed.data.map(item=>({number:item.number,title:item.title,url:`${PLATFORM_REPOSITORY}/${item.pull_request?'pull':'issues'}/${item.number}`,author:item.user?.login??'GitHub 使用者',created_at:item.created_at,state:item.state,kind:item.pull_request?'pr' as const:'issue' as const,pages:pageIdsForIssue(item.body,item.labels.map(label=>typeof label==='string'?label:label.name))}))};
  }
}
