import {z} from 'zod';
import type {Pool} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {communityCatalog,skillBooksForGuild} from './catalog.js';
import {guildTitles} from '../positioning/assessment.js';
import {githubCoordinate,publicJson} from '../opensource-marketing/github.js';
import {Problem,requireCondition} from '../../packages/shared/problem.js';
import repositorySet from '../../repositories.lock.json' with {type:'json'};

export type HistoryCategory='platform'|'official'|'personal';
export type HistoryRepository={name:string;title:string;category:HistoryCategory;url:string};
export type HistoryKind='issue'|'pr';
export type HistoryItem={kind:HistoryKind;repository:string;number:number;title:string;url:string;author:string|null;created_at:string;updated_at:string;state:'open'|'closed';state_reason?:string|null;merged_at?:string|null};

const coordinate=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const date=z.iso.datetime({offset:true});
const issue=z.object({number:z.number().int().positive(),title:z.string().max(1000),state:z.enum(['open','closed']),
  state_reason:z.string().nullable().optional(),user:z.object({login:z.string()}).nullable(),created_at:date,updated_at:date,pull_request:z.unknown().optional()});
const pull=z.object({number:z.number().int().positive(),title:z.string().max(1000),state:z.enum(['open','closed']),
  user:z.object({login:z.string()}).nullable(),created_at:date,updated_at:date,merged_at:date.nullable()});

/** The list is based on the current platform architecture set, guild bindings, and public works registered here. */
export async function historyRepositories(pool:Pool,actor:Actor):Promise<HistoryRepository[]> {
  const rows=(await Promise.all([
    pool.query('SELECT book_id FROM guild_skill_book_bindings WHERE community_id=$1',[actor.community_id]),
    pool.query('SELECT repository_full_name,title FROM oss_projects WHERE community_id=$1 ORDER BY created_at DESC',[actor.community_id]),
  ]));
  const assigned=new Set<string>(rows[0].rows.map(row=>row.book_id));
  for(const key of Object.keys(guildTitles))for(const book of skillBooksForGuild(key))assigned.add(book.id);
  const byName=new Map<string,HistoryRepository>();
  const add=(value:string,title:string,category:HistoryCategory)=>{
    if(!coordinate.test(value))return;
    const name=value.toLowerCase(),prior=byName.get(name);
    const priority={personal:0,official:1,platform:2};
    if(!prior||priority[category]>priority[prior.category])byName.set(name,{name:value,title,category,url:`https://github.com/${value}`});
  };
  add('FreeTWAI-AI/freedom-platform','自由工坊平台','platform');
  for(const entry of repositorySet.repositories)add(entry.repository,entry.repository.split('/')[1],'platform');
  for(const book of communityCatalog.skill_books){
    const value=book.upstream_url||book.repository_url;
    try{add(githubCoordinate(value),book.title,assigned.has(book.id)?'official':'personal');}catch{/* A catalog entry without a valid GitHub source is not queried. */}
  }
  for(const row of rows[1].rows)add(row.repository_full_name,row.title,'personal');
  return [...byName.values()].sort((a,b)=>({platform:0,official:1,personal:2})[a.category]-({platform:0,official:1,personal:2})[b.category]||a.title.localeCompare(b.title,'zh-TW'));
}

export class GitHubHistory {
  private cache=new Map<string,{expires:number;value:{items:HistoryItem[];has_more:boolean;checked_at:string}}>();
  private pending=new Map<string,Promise<{items:HistoryItem[];has_more:boolean;checked_at:string}>>();
  constructor(private fetcher:typeof fetch=(...args)=>globalThis.fetch(...args),private now=()=>Date.now()){}
  async page(repository:string,kind:HistoryKind,page:number,token?:string){
    requireCondition(coordinate.test(repository),422,'invalid_repository','請選擇清單中的儲存庫。');
    requireCondition(Number.isInteger(page)&&page>=1&&page<=10000,422,'invalid_page','歷史頁碼無效。');
    const key=`${repository.toLowerCase()}/${kind}/${page}`,saved=this.cache.get(key);
    if(saved&&saved.expires>this.now())return saved.value;
    if(this.pending.has(key))return this.pending.get(key)!;
    const promise=this.fetchPage(repository,kind,page,token).then(value=>{
      if(this.cache.size>=1000)this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key,{expires:this.now()+600000,value});return value;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,promise);return promise;
  }
  private async fetchPage(repository:string,kind:HistoryKind,page:number,token?:string){
    const signal=AbortSignal.timeout(10000);
    const path=`/repos/${repository}/${kind==='issue'?'issues':'pulls'}?state=all&sort=created&direction=desc&per_page=100&page=${page}`;
    let raw:unknown;
    try{raw=await publicJson(path,signal,this.fetcher,false,4194304,token);}
    catch(error){
      if(token&&error instanceof Problem&&error.code==='github_rate_limited')raw=await publicJson(path,signal,this.fetcher,false,4194304);
      else throw error;
    }
    const parsed=z.array(kind==='issue'?issue:pull).max(100).safeParse(raw);
    requireCondition(parsed.success,503,'github_invalid_response','GitHub 歷史資料不完整，請稍後重試。');
    const base=`https://github.com/${repository}`,items:HistoryItem[]=parsed.data
      .filter(item=>kind==='pr'||!('pull_request' in item))
      .map(item=>({kind,repository,number:item.number,title:item.title,url:`${base}/${kind==='issue'?'issues':'pull'}/${item.number}`,
        author:item.user?.login??null,created_at:item.created_at,updated_at:item.updated_at,state:item.state,
        ...(kind==='issue'?{state_reason:'state_reason' in item?item.state_reason:null}:{merged_at:'merged_at' in item?item.merged_at:null})}));
    return {items,has_more:parsed.data.length===100,checked_at:new Date(this.now()).toISOString()};
  }
}
