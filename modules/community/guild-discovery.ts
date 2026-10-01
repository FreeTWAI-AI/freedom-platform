import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest,transaction} from '../../packages/db/index.js';
import {guildTopics,GUILD_TOPIC_LABELS} from '../../packages/shared/guild-topics.js';
import {communityCatalog,skillBooksForGuild} from './catalog.js';

export type GuildEvidence={guild_key:string;name:string;purpose:string;tags:string[];books:{id:string;title:string}[]};
export type GuildReviewer=(catalog:GuildEvidence[])=>Promise<unknown>;
const Proposal=z.object({guild_keys:z.tuple([z.string().max(100),z.string().max(100)]),reason:z.string().trim().min(1).max(600),difference:z.string().trim().min(1).max(600),suggestion:z.enum(['collaborate','clarify','consider_merge'])}).strict();
const AiReport=z.object({pairs:z.array(Proposal).max(12)}).strict();
export type GuildReport={method:'rules'|'ai';ai_status:'not_configured'|'completed'|'unavailable'|'invalid_response';catalog_count:number;pairs:{guild_keys:[string,string];names:[string,string];reason:string;difference:string;suggestion:'collaborate'|'clarify'|'consider_merge';shared_topics:string[];shared_books:string[]}[]};
const excluded=new Set(['公會','協作','合作','整理','完成','夥伴','會員','平台','自由','工坊','專案','需要','使用']);
function terms(text:string){
  const values=new Set<string>();
  for(const word of text.toLowerCase().match(/[a-z]{2,}|[\p{Script=Han}]{2,}/gu)??[]){
    if(/^[a-z]+$/.test(word))values.add(word);
    else for(let i=0;i<word.length-1;i++){const part=word.slice(i,i+2);if(!excluded.has(part))values.add(part);}
  }
  return values;
}
export function ruleGuildReport(catalog:GuildEvidence[]):GuildReport{
  const pairs: (GuildReport['pairs'][number]&{score:number})[]=[];
  for(let i=0;i<catalog.length;i++)for(let j=i+1;j<catalog.length;j++){
    const a=catalog[i],b=catalog[j],sharedTopics=a.tags.filter(tag=>b.tags.includes(tag)),sharedBooks=a.books.filter(book=>b.books.some(other=>other.id===book.id)).map(book=>book.title);
    const aTerms=terms(a.name+' '+a.purpose),bTerms=terms(b.name+' '+b.purpose),common=[...aTerms].filter(term=>bTerms.has(term));
    const score=sharedBooks.length*4+sharedTopics.length+Math.min(common.length,5);
    if(score<4)continue;
    pairs.push({guild_keys:[a.guild_key,b.guild_key],names:[a.name,b.name],score,shared_topics:sharedTopics.map(tag=>GUILD_TOPIC_LABELS[tag as keyof typeof GUILD_TOPIC_LABELS]??tag),shared_books:sharedBooks,
      reason:sharedBooks.length?`共同技能書：${sharedBooks.join('、')}`:`共同描述主題：${common.slice(0,5).join('、')||sharedTopics.join('、')}`,
      difference:`${a.name}：${a.purpose}\n${b.name}：${b.purpose}`,suggestion:sharedBooks.length?'collaborate':'clarify'});
  }
  return {method:'rules',ai_status:'not_configured',catalog_count:catalog.length,pairs:pairs.sort((a,b)=>b.score-a.score||a.guild_keys.join().localeCompare(b.guild_keys.join())).slice(0,12).map(({score,...pair})=>pair)};
}
export function validateAiGuildReport(raw:unknown,catalog:GuildEvidence[],fallback:GuildReport):GuildReport{
  const outer=raw as {response?:unknown}|null;
  const value=outer&&typeof outer==='object'&&'response' in outer?outer.response:raw;
  if(typeof value==='string'&&value.length>20000)throw new Error('invalid_ai_report');
  const parsed=AiReport.parse(typeof value==='string'?JSON.parse(value):value),seen=new Set<string>();
  const pairs=parsed.pairs.map(pair=>{
    const [a,b]=pair.guild_keys.map(key=>catalog.find(g=>g.guild_key===key));
    if(!a||!b||a.guild_key===b.guild_key)throw new Error('unknown_guild');
    const key=[a.guild_key,b.guild_key].sort().join('/');if(seen.has(key))throw new Error('duplicate_pair');seen.add(key);
    return {...pair,names:[a.name,b.name] as [string,string],shared_topics:a.tags.filter(tag=>b.tags.includes(tag)).map(tag=>GUILD_TOPIC_LABELS[tag as keyof typeof GUILD_TOPIC_LABELS]??tag),shared_books:a.books.filter(book=>b.books.some(other=>other.id===book.id)).map(book=>book.title)};
  });
  return {...fallback,method:'ai',ai_status:'completed',pairs};
}
async function evidence(pool:Pool,communityId:string):Promise<GuildEvidence[]>{
  const [guilds,bindings]=await Promise.all([pool.query('SELECT guild_key,name,purpose FROM positioning_guild_catalog ORDER BY guild_key LIMIT 100'),pool.query('SELECT guild_key,book_id FROM guild_skill_book_bindings WHERE community_id=$1',[communityId])]);
  return guilds.rows.map(g=>{
    const books=new Map(skillBooksForGuild(g.guild_key).map(book=>[book.id,book]));
    for(const bound of bindings.rows.filter(row=>row.guild_key===g.guild_key)){const book=communityCatalog.skill_books.find(book=>book.id===bound.book_id);if(book)books.set(book.id,book);}
    return {guild_key:g.guild_key,name:g.name,purpose:g.purpose.slice(0,1000),tags:guildTopics(g),books:[...books.values()].map(({id,title})=>({id,title})).slice(0,50)};
  });
}
export async function guildDiscoveryReport(pool:Pool,communityId:string){
  const row=(await pool.query('SELECT generated_at,next_attempt_at,source_sha256,report FROM guild_discovery_reports WHERE community_id=$1',[communityId])).rows[0];
  if(row?.report)return row;
  return {generated_at:null,next_attempt_at:row?.next_attempt_at??null,source_sha256:null,report:ruleGuildReport(await evidence(pool,communityId))};
}
async function reviewWithTimeout(reviewer:GuildReviewer,catalog:GuildEvidence[]){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([reviewer(catalog),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('review_timeout')),15000);})]);}
  finally{clearTimeout(timer);}
}
/** Existing ten-minute Worker cron invokes this; the database enforces one daily report per community. */
export async function refreshGuildDiscoveryReports(pool:Pool,options:{reviewer?:GuildReviewer;communityId?:string}={}){
  const communities=options.communityId?[{community_id:options.communityId}]:(await pool.query(`SELECT c.community_id FROM communities c LEFT JOIN guild_discovery_reports r USING(community_id)
    WHERE EXISTS(SELECT 1 FROM users u WHERE u.community_id=c.community_id AND u.active)
      AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now()) AND (r.lease_until IS NULL OR r.lease_until<now())
    ORDER BY r.next_attempt_at NULLS FIRST,c.community_id LIMIT 4`)).rows;
  let updated=0;
  for(const {community_id:communityId} of communities){
    const lease=await transaction(pool,async q=>{
      await q.query('INSERT INTO guild_discovery_reports(community_id) VALUES($1) ON CONFLICT DO NOTHING',[communityId]);
      return (await q.query(`UPDATE guild_discovery_reports SET lease_until=now()+interval '2 minutes',lease_id=$2,next_attempt_at=now()+interval '1 hour'
        WHERE community_id=$1 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING lease_id`,[communityId,randomUUID()])).rows[0]?.lease_id;
    });
    if(!lease)continue;
    try{
      const catalog=await evidence(pool,communityId);let report=ruleGuildReport(catalog);
      if(options.reviewer){
        try{
          const output=await reviewWithTimeout(options.reviewer,catalog);
          try{report=validateAiGuildReport(output,catalog,report);}catch{report.ai_status='invalid_response';}
        }catch{report.ai_status='unavailable';}
      }
      const saved=await pool.query(`UPDATE guild_discovery_reports SET generated_at=now(),next_attempt_at=now()+interval '1 day',lease_until=NULL,lease_id=NULL,source_sha256=$3,report=$4
        WHERE community_id=$1 AND lease_id=$2`,[communityId,lease,digest(catalog),JSON.stringify(report)]);updated+=saved.rowCount??0;
    }catch{
      await pool.query("UPDATE guild_discovery_reports SET lease_until=NULL,lease_id=NULL WHERE community_id=$1 AND lease_id=$2",[communityId,lease]);
      // No catalog, provider output or credentials are logged.
      console.error('guild_discovery_failed');
    }
  }
  return {updated};
}
