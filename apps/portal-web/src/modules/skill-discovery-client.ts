import {useEffect,useSyncExternalStore} from 'react';

export type SkillDiscoveryBook={book_id:string;summary_override?:string;published_at:string|null;official_guild_keys:string[];is_new_today:boolean;week_rank:number|null;month_rank:number|null;week_stars:number;month_stars:number};
export type SkillRanking={book_id:string;rank:number;stars:number};
export type SkillDiscovery={as_of:string;timezone:'Asia/Taipei';ranking_basis:string;books:SkillDiscoveryBook[];weekly:SkillRanking[];monthly:SkillRanking[]};
type Snapshot={data:SkillDiscovery|null;loading:boolean;error:string};
let snapshot:Snapshot={data:null,loading:false,error:''},pending:Promise<void>|null=null,checkedAt=0;
const listeners=new Set<()=>void>();
function publish(next:Snapshot){snapshot=next;for(const listener of listeners)listener();}
function subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
function getSnapshot(){return snapshot;}
const validCount=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function validRanking(value:unknown):value is SkillRanking[]{return Array.isArray(value)&&value.every(item=>item&&typeof item.book_id==='string'&&validCount(item.rank)&&item.rank>0&&validCount(item.stars));}
function parseDiscovery(value:unknown):SkillDiscovery{
  const data=value as SkillDiscovery;
  if(!data||typeof data.as_of!=='string'||!Number.isFinite(Date.parse(data.as_of))||data.timezone!=='Asia/Taipei'||typeof data.ranking_basis!=='string'||!validRanking(data.weekly)||!validRanking(data.monthly)||!Array.isArray(data.books)||!data.books.every(book=>book&&typeof book.book_id==='string'&&(book.published_at===null||typeof book.published_at==='string')&&Array.isArray(book.official_guild_keys)&&book.official_guild_keys.every(key=>typeof key==='string')&&typeof book.is_new_today==='boolean'&&(book.week_rank===null||validCount(book.week_rank)&&book.week_rank>0)&&(book.month_rank===null||validCount(book.month_rank)&&book.month_rank>0)&&validCount(book.week_stars)&&validCount(book.month_stars)))throw new Error('invalid_discovery');
  return data;
}
export function refreshSkillDiscovery(force=false):Promise<void>{
  if(pending)return pending;
  if(!force&&Date.now()-checkedAt<60_000)return Promise.resolve();
  publish({...snapshot,loading:true,error:''});
  pending=(async()=>{
    try{
      const response=await fetch('/api/v1/skills/discovery',{credentials:'omit',headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error('discovery_unavailable');
      const data=parseDiscovery(await response.json());
      publish({data,loading:false,error:''});
    }catch{publish({...snapshot,loading:false,error:'技能徽章與工坊榜單暫時無法載入。'});}
    finally{checkedAt=Date.now();pending=null;}
  })();
  return pending;
}
export function useSkillDiscovery(){
  const state=useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  useEffect(()=>{void refreshSkillDiscovery();},[]);
  return state;
}
