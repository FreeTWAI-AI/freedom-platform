import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {CATEGORY_LABELS,CATEGORY_ORDER} from '../../../../contracts/guild-launchpad/v1/guild-preferences';
import './AdminGuildManagement.css';
import {GuildDiscoveryReport} from './GuildDiscoveryReport';
import {GuildName} from './GuildName';

export type GuildExpert={user_id:string;display_name:string;active:true;member_active:boolean;member_tier?:'intern'|'full'|null;aggregate_version:number};
export type ManagedGuild={guild_key:string;name:string;alias?:string;profession_title?:string;catalog_version?:number;purpose:string;guild_master:{user_id?:string;display_name:string;member_tier?:'intern'|'full'|null}|null;officer_version:number|null;guild_experts?:GuildExpert[];full_member_count?:number;intern_member_count?:number};
const customGuildKey=/^guild_custom_[0-9A-Fa-f]{32}$/;
type ProfileBody={name?:string;alias:string;profession_title?:string;reason:string};
type Client={request<T>(path:string, body?:unknown, options?:{key?:string; version?:number|string|null}):Promise<T>};
type Candidate={user_id:string;display_name:string;email:string;active:boolean;eligible:boolean;eligibility_reason:null|'inactive';is_current:boolean;joined:boolean;is_expert:boolean;expert_version:number|null};
type CandidatePage={items:Candidate[];total:number;next_offset:number|null};
type Assignment=(guild:ManagedGuild,userId:string,reason:string)=>Promise<boolean>;
type ExpertAssignment=(guild:ManagedGuild,userId:string,active:boolean,reason:string,version:number|null)=>Promise<boolean>;
type ProfileSave=(guild:ManagedGuild,body:ProfileBody)=>Promise<boolean>;
type Opened={guildKey:string;role:'master'|'expert'|'remove'|'profile';userId?:string};
const failure=(cause:unknown)=>cause instanceof Error?cause.message:'無法載入人選，請重試。';

export function AdminGuildManagement({client,guilds,busy,loading,error,onSave,onExpert,onProfile,onReload}:{client:Client;guilds:ManagedGuild[];busy:boolean;loading:boolean;error:string;onSave:Assignment;onExpert:ExpertAssignment;onProfile:ProfileSave;onReload:()=>Promise<void>}){
  const [search,setSearch]=useState(''),[opened,setOpened]=useState<Opened|null>(null),[saved,setSaved]=useState<{guildKey:string;message:string}|null>(null);
  const term=search.trim().toLocaleLowerCase(),shown=guilds.filter(guild=>!term||[guild.name,guild.alias].join(' ').toLocaleLowerCase().includes(term));
  function open(guildKey:string,role:Opened['role'],userId?:string){setOpened({guildKey,role,userId});setSaved(null);}
  return <section className="stack admin-guild-management"><div className="card-head"><h2>公會管理</h2><button type="button" className="btn btn-ghost" disabled={busy||loading} onClick={()=>void onReload()}>重讀公會</button></div>
    <GuildCategoryTools client={client} busy={busy}/><label className="field admin-guild-filter">搜尋公會<input type="search" value={search} disabled={busy} maxLength={100} onChange={event=>{setSearch(event.target.value);setOpened(null);}} placeholder="例如：影音、資安、活動…"/></label>
    <GuildDiscoveryReport client={client}/>
    {!opened&&error&&<p role="alert" className="banner banner-error">{error}</p>}
    {!loading&&!shown.length&&<p className="muted">{term?'沒有符合的公會。請換個名稱。':'目前沒有公會。'}</p>}
    <div className="admin-guild-list">{shown.map(guild=><article className={`card stack admin-guild-card${opened?.guildKey===guild.guild_key?' is-editing':''}`} key={guild.guild_key} aria-label={guild.name}>
      <header className="admin-guild-heading"><div><h3><GuildName name={guild.name} alias={guild.alias}/></h3><p className="multiline-text">{guild.purpose}</p><p className="admin-guild-current">公會長：{guild.guild_master?.display_name??'待任命'}{guild.guild_master?.member_tier==='full'&&<span className="badge">正式成員</span>}{guild.guild_master?.member_tier==='intern'&&<span className="badge">實習成員</span>}</p><p className="admin-guild-current">正式成員 {guild.full_member_count??0} · 實習成員 {guild.intern_member_count??0}</p></div><div className="actions admin-guild-role-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>open(guild.guild_key,'profile')}>編輯名稱與別名</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>open(guild.guild_key,'master')}>設定公會長</button><button type="button" className="btn btn-ghost" disabled={busy||(guild.guild_experts?.length??0)>=3} onClick={()=>open(guild.guild_key,'expert')}>新增公會專家</button></div></header>
      <section className="admin-guild-experts" aria-label={`${guild.name}公會專家`}><h4>公會專家 <span className="admin-expert-capacity">{guild.guild_experts?.length??0}/3</span></h4>{(guild.guild_experts?.length??0)>=3&&<p className="admin-expert-limit">已滿3位，請先移除一位</p>}{!guild.guild_experts?.length?<p className="muted">尚未任命</p>:<ul>{guild.guild_experts.map(expert=><li key={expert.user_id}><span><strong>{expert.display_name}</strong>{expert.member_tier==='full'&&<span className="badge">正式成員</span>}{expert.member_tier==='intern'&&<span className="badge">實習成員</span>}{!expert.member_active&&<span className="admin-candidate-status">帳號已停用</span>}</span><button type="button" className="btn btn-ghost" disabled={busy} aria-label={`移除專家 ${expert.display_name}`} onClick={()=>open(guild.guild_key,'remove',expert.user_id)}>移除</button></li>)}</ul>}</section>
      {saved?.guildKey===guild.guild_key&&<p role="status" className="admin-guild-success">{saved.message}</p>}
      {opened?.guildKey===guild.guild_key&&opened.role==='profile'&&<GuildProfileEditor key={guild.guild_key} guild={guild} busy={busy} error={error} onCancel={()=>setOpened(null)} onRefresh={onReload} onSave={async body=>{const success=await onProfile(guild,body);if(success){setOpened(null);setSaved({guildKey:guild.guild_key,message:'已更新公會名稱與別名。'});}return success;}}/>}
      {opened?.guildKey===guild.guild_key&&(opened.role==='master'||opened.role==='expert')&&<GuildRolePicker key={opened.role} role={opened.role} client={client} guild={guild} busy={busy} mutationError={error} onRefresh={onReload} onCancel={()=>setOpened(null)} onSave={async(candidate,reason)=>{const success=opened.role==='master'?await onSave(guild,candidate.user_id,reason):await onExpert(guild,candidate.user_id,true,reason,candidate.expert_version);if(success){setOpened(null);setSaved({guildKey:guild.guild_key,message:`已任命 ${candidate.display_name} 為${guild.name}${opened.role==='master'?'會長':'專家'}。`});}return success;}}/>}
      {opened?.guildKey===guild.guild_key&&opened.role==='remove'&&guild.guild_experts?.filter(expert=>expert.user_id===opened.userId).map(expert=><ExpertRemoval key={expert.user_id} expert={expert} busy={busy} error={error} onCancel={()=>setOpened(null)} onRefresh={onReload} onSave={async reason=>{const success=await onExpert(guild,expert.user_id,false,reason,expert.aggregate_version);if(success){setOpened(null);setSaved({guildKey:guild.guild_key,message:`已移除 ${expert.display_name} 的${guild.name}專家身分。`});}return success;}}/>)}
    </article>)}</div>
  </section>;
}

function GuildProfileEditor({guild,busy,error,onSave,onCancel,onRefresh}:{guild:ManagedGuild;busy:boolean;error:string;onSave:(body:ProfileBody)=>Promise<boolean>;onCancel:()=>void;onRefresh:()=>Promise<void>}){
  const custom=customGuildKey.test(guild.guild_key);
  const [name,setName]=useState(guild.name),[alias,setAlias]=useState(guild.alias??''),[title,setTitle]=useState(guild.profession_title??''),[reason,setReason]=useState(''),[saving,setSaving]=useState(false);
  const lock=useRef(false),pending=busy||saving;
  const ready=reason.trim().length>=3&&alias.trim().length<=100&&(!custom||(name.trim().length>=2&&name.trim().length<=100&&title.trim().length<=40));
  return <form className="admin-guild-profile admin-guild-appointment stack" aria-label={`編輯${guild.name}的名稱與別名`} onSubmit={async event=>{event.preventDefault();if(lock.current||pending||!ready)return;lock.current=true;setSaving(true);try{await onSave(custom?{name:name.trim(),alias:alias.trim(),profession_title:title.trim(),reason:reason.trim()}:{alias:alias.trim(),reason:reason.trim()});}finally{lock.current=false;setSaving(false);}}}>
    {custom?<label className="field">公會名稱<input value={name} required minLength={2} maxLength={100} disabled={pending} onChange={event=>setName(event.target.value)}/></label>:<><p>公會名稱：{guild.name}</p><p className="field-hint">內建公會的名稱與職業稱號由平台維護。</p></>}
    <label className="field">別名<input value={alias} maxLength={100} disabled={pending} onChange={event=>setAlias(event.target.value)}/></label>
    <p className="field-hint">有趣的名字放這裡，會並排顯示在公會名稱旁；留空就不顯示。</p>
    {custom&&<><label className="field">職業稱號<input value={title} maxLength={40} disabled={pending} onChange={event=>setTitle(event.target.value)}/></label><p className="field-hint">成員的職業稱號；留空時顯示「專業探索者」。</p></>}
    <label className="field">調整理由<textarea required minLength={3} maxLength={1000} rows={3} value={reason} disabled={pending} onChange={event=>setReason(event.target.value)}/></label>
    {error&&<div role="alert" className="banner banner-error"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>void onRefresh()}>重讀公會</button></div>}
    <div className="actions"><button className="btn btn-primary" disabled={pending||!ready}>{pending?'正在儲存…':'儲存名稱與別名'}</button><button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>取消</button></div>
  </form>;
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

type CategoryKey=typeof CATEGORY_ORDER[number];
type ClassifiedGuild={guild_key:string;name:string;category:CategoryKey|null;category_review:'pending'|'approved'|string;capability_tags:string[];catalog_revision:string|null};
type CategoryCatalog={catalog_revision:string;categories:{category:CategoryKey;label:string;section:string;items:ClassifiedGuild[]}[];pending:ClassifiedGuild[]};
type BackfillReport={dry_run:boolean;processed:number;mapped:number;blocked:number;remaining:number;remaining_blocked:number};
type SwitchReport={state:string;blocked:number;processed:number;already_switched:boolean};
const tagList=(value:string)=>value.split(/[,\n]/).map(item=>item.trim()).filter(Boolean);
function adminNote(cause:unknown){
  const status=cause instanceof Error&&'status' in cause?Number((cause as {status?:number}).status):0;
  if(status===0||status>=500)return '正在確認是否已儲存';
  return cause instanceof Error?cause.message:'需要處理';
}

function GuildCategoryTools({client,busy}:{client:Client;busy:boolean}){
  const [panel,setPanel]=useState<null|'catalog'|'switch'>(null),[catalog,setCatalog]=useState<CategoryCatalog|null>(null),[note,setNote]=useState(''),[loading,setLoading]=useState(false);
  const [guildKey,setGuildKey]=useState(''),[category,setCategory]=useState<CategoryKey>('internal'),[tags,setTags]=useState(''),[reason,setReason]=useState(''),[saving,setSaving]=useState(false);
  const [report,setReport]=useState<BackfillReport|null>(null),[accept,setAccept]=useState(false),[previewReady,setPreviewReady]=useState(false),[switched,setSwitched]=useState<SwitchReport|null>(null);
  const items=catalog?[...catalog.categories.flatMap(group=>group.items),...catalog.pending]:[];
  const selected=items.find(item=>item.guild_key===guildKey)??null;
  async function loadCatalog(){
    setLoading(true);setNote('');setPanel('catalog');
    try{const data=await client.request<CategoryCatalog>('/guild-categories');setCatalog(data);}
    catch(cause){setCatalog(null);setNote(adminNote(cause));}
    finally{setLoading(false);}
  }
  async function preview(){
    setLoading(true);setNote('');setSwitched(null);setAccept(false);setPreviewReady(false);setPanel('switch');
    try{setReport(await client.request<BackfillReport>('/guild-preferences/backfill',{dry_run:true}));setPreviewReady(true);}
    catch(cause){setReport(null);setPreviewReady(false);setNote(adminNote(cause));}
    finally{setLoading(false);}
  }
  function chooseGuild(key:string){
    setGuildKey(key);setNote('');
    const item=items.find(row=>row.guild_key===key);
    if(item?.category)setCategory(item.category);
    setTags(item?.capability_tags.join('\n')??'');
  }
  async function saveClassification(event:FormEvent){
    event.preventDefault();
    if(!selected||saving||busy)return;
    if(!selected.catalog_revision){setNote('無法核對版本。');return;}
    setSaving(true);setNote('');
    try{
      await client.request(`/guilds/${encodeURIComponent(selected.guild_key)}/classification`,{category,capability_tags:tagList(tags),reason:reason.trim()},{version:selected.catalog_revision});
      setReason('');setNote(`已儲存${selected.name}的分類。`);
      const data=await client.request<CategoryCatalog>('/guild-categories');setCatalog(data);
    }catch(cause){setNote(adminNote(cause));}
    finally{setSaving(false);}
  }
  async function confirmSwitch(){
    if(!report||!previewReady||saving||busy)return;
    if(report.blocked>0&&!accept){setNote(`還有 ${report.blocked} 位會員無法對照。請確認後再切換。`);return;}
    setSaving(true);setNote('');
    try{setSwitched(await client.request<SwitchReport>('/guild-preferences/switch',{accept_blocked:report.blocked>0&&accept}));}
    catch(cause){setNote(adminNote(cause));}
    finally{setSaving(false);}
  }
  const pending=busy||loading||saving;
  return <div className="admin-guild-category-tools">
    <div className="actions"><button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>void loadCatalog()}>分類與能力標籤</button><button type="button" className="btn btn-ghost" disabled={pending} onClick={()=>void preview()}>分類與主力切換</button></div>
    {note&&<div role="status" className="banner status-note"><p>{note}</p></div>}
    {panel==='catalog'&&catalog&&<form className="stack" onSubmit={saveClassification}><fieldset disabled={pending}><legend>分類與能力標籤</legend>
      <label className="field">公會<select value={guildKey} onChange={event=>chooseGuild(event.target.value)}><option value="">選擇公會</option>{items.map(item=><option key={item.guild_key} value={item.guild_key}>{item.name}{item.category_review==='approved'&&item.category?` · ${CATEGORY_LABELS[item.category]}`:' · 分類整理中'}</option>)}</select></label>
      <label className="field">類別<select value={category} onChange={event=>setCategory(event.target.value as CategoryKey)}>{CATEGORY_ORDER.map(key=><option key={key} value={key}>{CATEGORY_LABELS[key]}</option>)}</select></label>
      <label className="field">能力標籤<textarea value={tags} rows={3} maxLength={1400} onChange={event=>setTags(event.target.value)} placeholder="以逗號或換行分隔"/></label>
      <p className="field-hint">標籤只幫助瀏覽，不授予權限。最多 20 個。</p>
      <label className="field">調整理由<textarea required minLength={3} maxLength={1000} rows={2} value={reason} onChange={event=>setReason(event.target.value)}/></label>
      {!selected?.catalog_revision&&guildKey&&<p className="field-hint">無法核對版本。</p>}
    </fieldset><div className="actions"><button className="btn btn-primary" disabled={pending||!selected?.catalog_revision||reason.trim().length<3}>{saving?'結果確認中':'儲存分類'}</button></div></form>}
    {panel==='switch'&&<section className="stack" aria-label="分類與主力切換">{loading&&<p role="status">正在載入對照…</p>}{report&&<><p>預覽：這一批檢視 {report.processed} 位，可對照 {report.mapped} 位。全部尚餘 {report.remaining} 位，無法對照 {report.remaining_blocked} 位。</p>{report.blocked>0&&<label className="checkbox-row"><input type="checkbox" checked={accept} disabled={pending||!previewReady} onChange={event=>setAccept(event.target.checked)}/>我確認仍要切換。這會留下 {report.blocked} 位無法對照的會員，不自動補上主力。</label>}<div className="actions"><button type="button" className="btn btn-primary" disabled={pending||!previewReady||(report.blocked>0&&!accept)} onClick={()=>void confirmSwitch()}>{saving?'結果確認中':'確認切換'}</button></div></>}{switched&&<p role="status">{switched.already_switched?'這個社群已經切換。':`已切換。這次處理 ${switched.processed} 位，無法對照 ${switched.blocked} 位。`}</p>}</section>}
  </div>;
}
