import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import './AdminGuildManagement.css';

export type GuildExpert={user_id:string;display_name:string;active:true;member_active:boolean;aggregate_version:number};
export type ManagedGuild={guild_key:string;name:string;purpose:string;guild_master:{user_id?:string;display_name:string}|null;officer_version:number|null;guild_experts?:GuildExpert[]};
type Client={request<T>(path:string):Promise<T>};
type Candidate={user_id:string;display_name:string;email:string;active:boolean;eligible:boolean;eligibility_reason:null|'inactive';is_current:boolean;joined:boolean;is_expert:boolean;expert_version:number|null};
type CandidatePage={items:Candidate[];total:number;next_offset:number|null};
type Assignment=(guild:ManagedGuild,userId:string,reason:string)=>Promise<boolean>;
type ExpertAssignment=(guild:ManagedGuild,userId:string,active:boolean,reason:string,version:number|null)=>Promise<boolean>;
type Opened={guildKey:string;role:'master'|'expert'|'remove';userId?:string};
const failure=(cause:unknown)=>cause instanceof Error?cause.message:'無法載入人選，請重試。';

export function AdminGuildManagement({client,guilds,busy,loading,error,onSave,onExpert,onReload}:{client:Client;guilds:ManagedGuild[];busy:boolean;loading:boolean;error:string;onSave:Assignment;onExpert:ExpertAssignment;onReload:()=>Promise<void>}){
  const [search,setSearch]=useState(''),[opened,setOpened]=useState<Opened|null>(null),[saved,setSaved]=useState<{guildKey:string;message:string}|null>(null);
  const term=search.trim().toLocaleLowerCase(),shown=guilds.filter(guild=>!term||guild.name.toLocaleLowerCase().includes(term));
  function open(guildKey:string,role:Opened['role'],userId?:string){setOpened({guildKey,role,userId});setSaved(null);}
  return <section className="stack admin-guild-management"><div className="card-head"><h2>公會管理</h2><button type="button" className="btn btn-ghost" disabled={busy||loading} onClick={()=>void onReload()}>重讀公會</button></div><label className="field admin-guild-filter">搜尋公會<input type="search" value={search} disabled={busy} maxLength={100} onChange={event=>{setSearch(event.target.value);setOpened(null);}} placeholder="例如：影音、資安、活動…"/></label>
    {!opened&&error&&<p role="alert" className="banner banner-error">{error}</p>}
    {!loading&&!shown.length&&<p className="muted">{term?'沒有符合的公會。請換個名稱。':'目前沒有公會。'}</p>}
    <div className="admin-guild-list">{shown.map(guild=><article className={`card stack admin-guild-card${opened?.guildKey===guild.guild_key?' is-editing':''}`} key={guild.guild_key} aria-label={guild.name}>
      <header className="admin-guild-heading"><div><h3>{guild.name}</h3><p>{guild.purpose}</p><p className="admin-guild-current">公會長：{guild.guild_master?.display_name??'待任命'}</p></div><div className="actions admin-guild-role-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>open(guild.guild_key,'master')}>設定公會長</button><button type="button" className="btn btn-ghost" disabled={busy||(guild.guild_experts?.length??0)>=3} onClick={()=>open(guild.guild_key,'expert')}>新增公會專家</button></div></header>
      <section className="admin-guild-experts" aria-label={`${guild.name}公會專家`}><h4>公會專家 <span className="admin-expert-capacity">{guild.guild_experts?.length??0}/3</span></h4>{(guild.guild_experts?.length??0)>=3&&<p className="admin-expert-limit">已滿3位，請先移除一位</p>}{!guild.guild_experts?.length?<p className="muted">尚未任命</p>:<ul>{guild.guild_experts.map(expert=><li key={expert.user_id}><span><strong>{expert.display_name}</strong>{!expert.member_active&&<span className="admin-candidate-status">帳號已停用</span>}</span><button type="button" className="btn btn-ghost" disabled={busy} aria-label={`移除專家 ${expert.display_name}`} onClick={()=>open(guild.guild_key,'remove',expert.user_id)}>移除</button></li>)}</ul>}</section>
      {saved?.guildKey===guild.guild_key&&<p role="status" className="admin-guild-success">{saved.message}</p>}
      {opened?.guildKey===guild.guild_key&&opened.role!=='remove'&&<GuildRolePicker key={opened.role} role={opened.role} client={client} guild={guild} busy={busy} mutationError={error} onRefresh={onReload} onCancel={()=>setOpened(null)} onSave={async(candidate,reason)=>{const success=opened.role==='master'?await onSave(guild,candidate.user_id,reason):await onExpert(guild,candidate.user_id,true,reason,candidate.expert_version);if(success){setOpened(null);setSaved({guildKey:guild.guild_key,message:`已任命 ${candidate.display_name} 為${guild.name}${opened.role==='master'?'會長':'專家'}。`});}return success;}}/>}
      {opened?.guildKey===guild.guild_key&&opened.role==='remove'&&guild.guild_experts?.filter(expert=>expert.user_id===opened.userId).map(expert=><ExpertRemoval key={expert.user_id} expert={expert} busy={busy} error={error} onCancel={()=>setOpened(null)} onRefresh={onReload} onSave={async reason=>{const success=await onExpert(guild,expert.user_id,false,reason,expert.aggregate_version);if(success){setOpened(null);setSaved({guildKey:guild.guild_key,message:`已移除 ${expert.display_name} 的${guild.name}專家身分。`});}return success;}}/>)}
    </article>)}</div>
  </section>;
}

function GuildRolePicker({client,guild,role,busy,mutationError,onSave,onCancel,onRefresh}:{client:Client;guild:ManagedGuild;role:'master'|'expert';busy:boolean;mutationError:string;onSave:(candidate:Candidate,reason:string)=>Promise<boolean>;onCancel:()=>void;onRefresh:()=>Promise<void>}){
  const title=role==='master'?'公會長':'公會專家';
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[scope,setScope]=useState<'eligible'|'all'>('eligible'),[items,setItems]=useState<Candidate[]>([]),[total,setTotal]=useState<number|null>(null),[next,setNext]=useState<number|null>(null),[selectedId,setSelectedId]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[attempted,setAttempted]=useState(false),[saving,setSaving]=useState(false),[refreshing,setRefreshing]=useState(false);
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
  },[client,guild]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load,query,scope]);
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),300);return()=>clearTimeout(timer);},[search]);
  function changeSearch(value:string){generation.current++;setSearch(value);setSelectedId('');setAttempted(false);setError('');if(value.trim()!==query){setItems([]);setNext(null);setTotal(null);setLoading(true);}else void load();}
  function changeScope(value:'eligible'|'all'){if(value===scope)return;generation.current++;setScope(value);setSelectedId('');setAttempted(false);}
  function submitSearch(event:FormEvent){event.preventDefault();const value=search.trim();if(value===query)void load();else setQuery(value);}
  function isCurrent(item:Candidate){return role==='master'?(item.is_current||item.user_id===guild.guild_master?.user_id):item.is_expert;}
  const selected=items.find(item=>item.user_id===selectedId),pending=busy||saving||refreshing,canAssign=selected?.eligible&&selected.active&&!isCurrent(selected)&&(role!=='expert'||(guild.guild_experts?.length??0)<3);
  async function assign(event:FormEvent){event.preventDefault();if(!selected||!canAssign||pending||lock.current||reason.trim().length<3)return;lock.current=true;setSaving(true);setAttempted(true);try{await onSave(selected,reason.trim());}finally{lock.current=false;setSaving(false);}}
  async function refresh(){setRefreshing(true);setSelectedId('');try{await onRefresh();}finally{setRefreshing(false);}}
  return <section className="admin-guild-picker stack" aria-label={`${guild.name}${title}人選`}>
    <form className="admin-guild-candidate-search" onSubmit={submitSearch}><label className="field">搜尋{title}人選<input type="search" aria-label={`搜尋${title}人選`} value={search} disabled={pending} maxLength={100} placeholder="暱稱或 Email" onChange={event=>changeSearch(event.target.value)}/></label><button className="btn btn-ghost" disabled={pending}>查詢人選</button></form>
    <div className="admin-candidate-scopes" role="group" aria-label={`${title}人選範圍`}><button type="button" className="btn btn-ghost" disabled={pending} aria-pressed={scope==='eligible'} onClick={()=>changeScope('eligible')}>可任命的平台會員</button><button type="button" className="btn btn-ghost" disabled={pending} aria-pressed={scope==='all'} onClick={()=>changeScope('all')}>搜尋所有平台會員</button></div>
    <p className="field-hint">未加入者會在任命時加入公會、領取技能書；原本的主要公會與定位不變。</p>
    {error&&<div role="alert" className="banner banner-error"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={pending||loading} onClick={()=>void load(offsetRef.current)}>重讀人選</button></div>}
    <p className="admin-candidate-count" aria-live="polite">{loading&&!items.length?'正在搜尋人選…':total===null?'':`顯示 ${items.length} / ${total} 位人選`}</p>
    {!loading&&!error&&!items.length&&<div className="admin-candidate-empty"><p>{scope==='eligible'?'沒有符合的啟用會員。請換個暱稱或 Email。':'找不到這位會員。請確認暱稱或註冊 Email。'}</p>{scope==='eligible'&&<button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>changeScope('all')}>查看所有平台會員</button>}</div>}
    <fieldset className="admin-candidate-list" disabled={pending} aria-label={`選擇${title}`}><legend>選擇{title}</legend>{items.map(item=>{
      const current=isCurrent(item),disabled=!item.active||!item.eligible||current;
      const status=!item.active||item.eligibility_reason==='inactive'?'帳號已停用':current?`現任${title}`:!item.joined?'任命時加入公會':'已加入公會';
      return <label key={item.user_id} className={`admin-candidate${disabled?' is-unavailable':''}${selectedId===item.user_id?' is-selected':''}`}><input type="radio" name={`${role}-${guild.guild_key}`} checked={selectedId===item.user_id} disabled={disabled} aria-label={`${item.display_name} · ${item.email}`} onChange={()=>{setSelectedId(item.user_id);setAttempted(false);}}/><span><strong>{item.display_name}</strong><span className="admin-candidate-email">{item.email}</span></span><span className="admin-candidate-status">{status}</span></label>;
    })}</fieldset>
    {loading&&items.length>0&&<p role="status">正在載入更多人選…</p>}{next!==null&&!error&&<button type="button" className="btn btn-ghost" disabled={pending||loading} onClick={()=>void load(next)}>查看更多人選</button>}
    <form className="admin-guild-appointment stack" aria-label={`任命${title}`} onSubmit={assign}>
      {selected&&<p className="admin-candidate-selected">任命人選：<strong>{selected.display_name}</strong> · {selected.email}{!selected.joined&&<span> · 任命時加入公會</span>}</p>}
      <label className="field">任命理由<textarea aria-label="任命理由" required minLength={3} maxLength={1000} rows={3} value={reason} disabled={pending} onChange={event=>setReason(event.target.value)} placeholder={role==='master'?'例如：本人同意負責公會活動與技能庫':'例如：本人同意提供此領域的專業協助'}/></label>
      {mutationError&&<div role="alert" className="banner banner-error"><p>{mutationError}</p><button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>void refresh()}>重讀公會與人選</button></div>}{attempted&&!pending&&mutationError&&<p className="field-hint">已保留人選與理由。版本變更時，先重讀並重新選人；理由會保留。</p>}
      <div className="actions"><button className="btn btn-primary" disabled={pending||loading||!canAssign||reason.trim().length<3}>{pending?'正在任命…':'確認任命'}</button><button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>取消</button></div>
    </form>
  </section>;
}

function ExpertRemoval({expert,busy,error,onSave,onCancel,onRefresh}:{expert:GuildExpert;busy:boolean;error:string;onSave:(reason:string)=>Promise<boolean>;onCancel:()=>void;onRefresh:()=>Promise<void>}){
  const [reason,setReason]=useState(''),[saving,setSaving]=useState(false);const lock=useRef(false),pending=busy||saving;
  return <form className="admin-guild-appointment stack" aria-label={`移除專家 ${expert.display_name}`} onSubmit={async event=>{event.preventDefault();if(lock.current||pending||reason.trim().length<3)return;lock.current=true;setSaving(true);try{await onSave(reason.trim());}finally{lock.current=false;setSaving(false);}}}>
    <p>移除 <strong>{expert.display_name}</strong> 的公會專家身分。保留公會會員資格。</p><label className="field">移除理由<textarea aria-label="移除理由" required minLength={3} maxLength={1000} rows={2} value={reason} disabled={pending} onChange={event=>setReason(event.target.value)}/></label>
    {error&&<div role="alert" className="banner banner-error"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>void onRefresh()}>重讀公會與人選</button></div>}
    <div className="actions"><button className="btn btn-primary" disabled={pending||reason.trim().length<3}>{pending?'正在移除…':'確認移除專家'}</button><button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>取消</button></div>
  </form>;
}
