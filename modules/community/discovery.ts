import type {Pool,PoolClient} from 'pg';
import {communityCatalog,officialGuildKeys} from './catalog.js';
import {guildTitles} from '../positioning/assessment.js';
import {readSkillEditorialSummaries} from '../guild-workspace/service.js';

const DAY=86_400_000;
const taipei=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'});
export const rankingBasis='近 7／30 天首次在工坊加星、且最近核對仍保留星星的 GitHub 帳號數。同一帳號與專案只算一次；取消後重加不刷新日期。不含 GitHub 全站新增星星，也不代表能力或收益。';
export type SkillRank={book_id:string;rank:number;stars:number};
export type SkillDiscoveryBook={book_id:string;summary_override?:string;published_at:string|null;official_guild_keys:string[];official_guilds:{guild_key:string;name:string}[];is_new_today:boolean;week_rank:number|null;month_rank:number|null;week_stars:number;month_stars:number};
export type SkillDiscovery={as_of:string;timezone:'Asia/Taipei';ranking_basis:string;books:SkillDiscoveryBook[];weekly:SkillRank[];monthly:SkillRank[]};

// Called only AFTER the provider confirms the authenticated member's requested
// mutation. A read may retract an existing vote, but cannot manufacture a vote.
export async function recordConfirmedStar(q:PoolClient,githubId:string,repository:string,starred:boolean){
  if(starred)await q.query(`INSERT INTO skill_star_support(github_user_id,repository_key,active) VALUES($1,$2,true)
    ON CONFLICT(github_user_id,repository_key) DO UPDATE SET active=true,last_confirmed_at=now()`,[githubId,repository.toLowerCase()]);
  else await q.query('UPDATE skill_star_support SET active=false,last_confirmed_at=now() WHERE github_user_id=$1 AND repository_key=$2',[githubId,repository.toLowerCase()]);
}
export async function reconcileConfirmedStar(q:PoolClient,githubId:string,repository:string,starred:boolean){
  await q.query('UPDATE skill_star_support SET active=$3,last_confirmed_at=now() WHERE github_user_id=$1 AND repository_key=$2',[githubId,repository.toLowerCase(),starred]);
}
export async function skillDiscovery(pool:Pool,now=new Date()):Promise<SkillDiscovery>{
  const [support,publications,summaries,guildNames,bindings]=await Promise.all([
    pool.query(`SELECT repository_key,count(*) FILTER(WHERE first_confirmed_at>$1 AND first_confirmed_at<=$3)::int AS week_stars,
      count(*) FILTER(WHERE first_confirmed_at>$2 AND first_confirmed_at<=$3)::int AS month_stars
      FROM skill_star_support WHERE active AND first_confirmed_at>$2 AND first_confirmed_at<=$3 GROUP BY repository_key`,[new Date(now.getTime()-7*DAY),new Date(now.getTime()-30*DAY),now]),
    pool.query('SELECT book_id,published_at FROM skill_publications WHERE published_at<=$1',[now]),
    readSkillEditorialSummaries(pool),
    pool.query('SELECT guild_key,name FROM positioning_guild_catalog'),
    // Administrator-approved guilds designate books too; joining them grants the same books.
    pool.query('SELECT DISTINCT guild_key,book_id FROM guild_skill_book_bindings'),
  ]);
  const counts=new Map(support.rows.map(row=>[row.repository_key,row])),dates=new Map(publications.rows.map(row=>[row.book_id,new Date(row.published_at)]));
  const names=new Map<string,string>(guildNames.rows.map(row=>[row.guild_key,row.name]));
  const standard=Object.keys(guildTitles),bound=new Map<string,Set<string>>();
  for(const row of bindings.rows){if(!bound.has(row.book_id))bound.set(row.book_id,new Set());bound.get(row.book_id)!.add(row.guild_key);}
  const books:SkillDiscoveryBook[]=communityCatalog.skill_books.map(book=>{
    const row=counts.get(new URL(book.upstream_url).pathname.slice(1).toLowerCase()),date=dates.get(book.id);
    const designated=new Set<string>([...officialGuildKeys(book.id),...(bound.get(book.id)??[])]);
    const keys=[...standard.filter(key=>designated.has(key)),...[...designated].filter(key=>!standard.includes(key)).sort()];
    return {book_id:book.id,...(summaries[book.id]?{summary_override:summaries[book.id]}:{}),published_at:date?.toISOString()??null,
      official_guild_keys:keys,official_guilds:keys.flatMap(guild_key=>names.has(guild_key)?[{guild_key,name:names.get(guild_key)!}]:[]),
      is_new_today:!!date&&taipei.format(date)===taipei.format(now),week_rank:null,month_rank:null,
      week_stars:Number(row?.week_stars??0),month_stars:Number(row?.month_stars??0)};
  });
  function ranking(window:'week'|'month'):SkillRank[]{
    const key=window==='week'?'week_stars':'month_stars',rankKey=window==='week'?'week_rank':'month_rank';
    const ordered=books.filter(book=>book[key]>0).sort((a,b)=>b[key]-a[key]||a.book_id.localeCompare(b.book_id));
    let previous=-1,rank=0;
    return ordered.map((book,index)=>{if(book[key]!==previous)rank=index+1;previous=book[key];book[rankKey]=rank;return {book_id:book.book_id,rank,stars:book[key]};});
  }
  return {as_of:now.toISOString(),timezone:'Asia/Taipei',ranking_basis:rankingBasis,books,weekly:ranking('week'),monthly:ranking('month')};
}
