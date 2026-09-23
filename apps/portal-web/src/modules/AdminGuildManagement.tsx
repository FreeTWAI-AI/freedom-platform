import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import './AdminGuildManagement.css';

export type ManagedGuild={guild_key:string;name:string;purpose:string;guild_master:{user_id?:string;display_name:string}|null;officer_version:number|null};
type Client={request<T>(path:string):Promise<T>};
type Candidate={user_id:string;display_name:string;email:string;active:boolean;eligible:boolean;eligibility_reason:null|'inactive'|'not_joined';is_current:boolean};
type CandidatePage={items:Candidate[];total:number;next_offset:number|null};
type Assignment=(guild:ManagedGuild,userId:string,reason:string)=>Promise<boolean>;
const failure=(cause:unknown)=>cause instanceof Error?cause.message:'無法載入人選，請重試。';

export function AdminGuildManagement({client,guilds,busy,loading,error,onSave,onReload}:{client:Client;guilds:ManagedGuild[];busy:boolean;loading:boolean;error:string;onSave:Assignment;onReload:()=>void}){
  const [search,setSearch]=useState(''),[opened,setOpened]=useState<string|null>(null),[saved,setSaved]=useState<{guildKey:string;name:string}|null>(null);
  const term=search.trim().toLocaleLowerCase(),shown=guilds.filter(guild=>!term||guild.name.toLocaleLowerCase().includes(term));
  return <section className="stack admin-guild-management"><div className="card-head"><h2>公會管理</h2><button type="button" className="btn btn-ghost" disabled={busy||loading} onClick={onReload}>重讀公會</button></div><label className="field admin-guild-filter">搜尋公會<input type="search" value={search} disabled={busy} maxLength={100} onChange={event=>{setSearch(event.target.value);setOpened(null);}} placeholder="例如：影音、資安、活動…"/></label>
    {!opened&&error&&<p role="alert" className="banner banner-error">{error}</p>}
    {!loading&&!shown.length&&<p className="muted">{term?'沒有符合的公會。請換個名稱。':'目前沒有公會。'}</p>}
    <div className="admin-guild-list">{shown.map(guild=><article className={`card stack admin-guild-card${opened===guild.guild_key?' is-editing':''}`} key={guild.guild_key} aria-label={guild.name}>
      <header className="admin-guild-heading"><div><h3>{guild.name}</h3><p>{guild.purpose}</p><p className="admin-guild-current">公會長：{guild.guild_master?.display_name??'待任命'}</p></div>{opened!==guild.guild_key&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{setOpened(guild.guild_key);setSaved(null);}}>設定公會長</button>}</header>
      {saved?.guildKey===guild.guild_key&&<p role="status" className="admin-guild-success">已任命 {saved.name} 為{guild.name}會長。</p>}
      {opened===guild.guild_key&&<GuildMasterPicker client={client} guild={guild} busy={busy} mutationError={error} onRefresh={onReload} onCancel={()=>setOpened(null)} onSave={async(userId,reason,name)=>{const success=await onSave(guild,userId,reason);if(success){setOpened(null);setSaved({guildKey:guild.guild_key,name});}return success;}}/>}
    </article>)}</div>
  </section>;
}

function GuildMasterPicker({client,guild,busy,mutationError,onSave,onCancel,onRefresh}:{client:Client;guild:ManagedGuild;busy:boolean;mutationError:string;onSave:(userId:string,reason:string,name:string)=>Promise<boolean>;onCancel:()=>void;onRefresh:()=>void}){
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[scope,setScope]=useState<'eligible'|'all'>('eligible'),[items,setItems]=useState<Candidate[]>([]),[total,setTotal]=useState<number|null>(null),[next,setNext]=useState<number|null>(null),[selectedId,setSelectedId]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[attempted,setAttempted]=useState(false),[saving,setSaving]=useState(false);
  const generation=useRef(0),offsetRef=useRef(0),lock=useRef(false),queryRef=useRef({query,scope});queryRef.current={query,scope};
  const load=useCallback(async(offset=0)=>{
    const sequence=++generation.current,{query:q,scope:currentScope}=queryRef.current;
    const params=new URLSearchParams({q,scope:currentScope,limit:'20',offset:String(offset)});
    setLoading(true);setError('');offsetRef.current=offset;
    if(offset===0){setItems([]);setNext(null);setTotal(null);setSelectedId('');}
    try{
      const data=await client.request<CandidatePage>(`/guilds/${encodeURIComponent(guild.guild_key)}/master-candidates?${params}`);
      if(sequence!==generation.current)return;
      setItems(current=>offset?[...new Map([...current,...data.items].map(item=>[item.user_id,item])).values()]:data.items);setTotal(data.total);setNext(data.next_offset);
    }catch(cause){if(sequence===generation.current)setError(failure(cause));}
    finally{if(sequence===generation.current)setLoading(false);}
  },[client,guild.guild_key,guild.officer_version]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load,query,scope]);
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),300);return()=>clearTimeout(timer);},[search]);
  function changeSearch(value:string){generation.current++;setSearch(value);setSelectedId('');setAttempted(false);setError('');if(value.trim()!==query){setItems([]);setNext(null);setTotal(null);setLoading(true);}else void load();}
  function changeScope(value:'eligible'|'all'){if(value===scope)return;generation.current++;setScope(value);setSelectedId('');setAttempted(false);}
  function submitSearch(event:FormEvent){event.preventDefault();const value=search.trim();if(value===query)void load();else setQuery(value);}
  const selected=items.find(item=>item.user_id===selectedId),pending=busy||saving,canAssign=selected?.eligible&&selected.active&&!selected.is_current&&selected.user_id!==guild.guild_master?.user_id;
  async function assign(event:FormEvent){event.preventDefault();if(!selected||!canAssign||pending||lock.current||reason.trim().length<3)return;lock.current=true;setSaving(true);setAttempted(true);try{await onSave(selected.user_id,reason.trim(),selected.display_name);}finally{lock.current=false;setSaving(false);}}
  return <section className="admin-guild-picker stack" aria-label={`${guild.name}公會長人選`}>
    <form className="admin-guild-candidate-search" onSubmit={submitSearch}><label className="field">搜尋公會長人選<input type="search" aria-label="搜尋公會長人選" value={search} disabled={pending} maxLength={100} placeholder="暱稱或 Email" onChange={event=>changeSearch(event.target.value)}/></label><button className="btn btn-ghost" disabled={pending}>查詢人選</button></form>
    <div className="admin-candidate-scopes" role="group" aria-label="公會長人選範圍"><button type="button" className="btn btn-ghost" disabled={pending} aria-pressed={scope==='eligible'} onClick={()=>changeScope('eligible')}>可任命的公會會員</button><button type="button" className="btn btn-ghost" disabled={pending} aria-pressed={scope==='all'} onClick={()=>changeScope('all')}>搜尋所有平台會員</button></div>
    <p className="field-hint">先加入此公會且帳號啟用，才可任命為公會長。尚未加入時，請對方到「職業公會」加入。</p>
    {error&&<div role="alert" className="banner banner-error"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={pending||loading} onClick={()=>void load(offsetRef.current)}>重讀人選</button></div>}
    <p className="admin-candidate-count" aria-live="polite">{loading&&!items.length?'正在搜尋人選…':total===null?'':`顯示 ${items.length} / ${total} 位人選`}</p>
    {!loading&&!error&&!items.length&&<div className="admin-candidate-empty"><p>{scope==='eligible'?'沒有符合的公會會員。可改查所有平台會員，確認是否尚未加入此公會。':'找不到這位會員。請確認暱稱或註冊 Email。'}</p>{scope==='eligible'&&<button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>changeScope('all')}>查看所有平台會員</button>}</div>}
    <fieldset className="admin-candidate-list" disabled={pending} aria-label="選擇公會長"><legend>選擇公會長</legend>{items.map(item=>{
      const current=item.is_current||item.user_id===guild.guild_master?.user_id,disabled=!item.active||!item.eligible||current;
      const status=current?'現任公會長':!item.active||item.eligibility_reason==='inactive'?'帳號已停用':!item.eligible?'未加入此公會':'可任命';
      return <label key={item.user_id} className={`admin-candidate${disabled?' is-unavailable':''}${selectedId===item.user_id?' is-selected':''}`}><input type="radio" name={`master-${guild.guild_key}`} checked={selectedId===item.user_id} disabled={disabled} aria-label={`${item.display_name} · ${item.email}`} onChange={()=>{setSelectedId(item.user_id);setAttempted(false);}}/><span><strong>{item.display_name}</strong><span className="admin-candidate-email">{item.email}</span></span><span className="admin-candidate-status">{status}</span></label>;
    })}</fieldset>
    {loading&&items.length>0&&<p role="status">正在載入更多人選…</p>}{next!==null&&!error&&<button type="button" className="btn btn-ghost" disabled={pending||loading} onClick={()=>void load(next)}>查看更多人選</button>}
    <form className="admin-guild-appointment stack" aria-label="任命公會長" onSubmit={assign}>
      {selected&&<p className="admin-candidate-selected">任命人選：<strong>{selected.display_name}</strong> · {selected.email}</p>}
      <label className="field">任命理由<textarea aria-label="任命理由" required minLength={3} maxLength={1000} rows={3} value={reason} disabled={pending} onChange={event=>setReason(event.target.value)} placeholder="例如：本人同意負責公會活動與技能庫"/></label>
      {mutationError&&<div role="alert" className="banner banner-error"><p>{mutationError}</p><button type="button" className="btn btn-ghost" disabled={pending} onClick={onRefresh}>重讀公會與人選</button></div>}{attempted&&!pending&&mutationError&&<p className="field-hint">已保留人選與理由。版本變更時，先重讀並重新選人；理由會保留。</p>}
      <div className="actions"><button className="btn btn-primary" disabled={pending||loading||!canAssign||reason.trim().length<3}>{pending?'正在任命…':'確認任命'}</button><button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>取消</button></div>
    </form>
  </section>;
}
