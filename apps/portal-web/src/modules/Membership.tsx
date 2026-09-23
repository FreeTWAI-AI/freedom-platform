import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useModuleMutation, type ModulePanelProps } from './shared';
import type { PortalClient } from '../api';
import type { SkillBook } from './Onboarding';
import { SkillBooks } from './Onboarding';
import { ClientConnections } from './ClientConnections';
import { ModuleBanner } from './ModuleBanner';
import { AvatarEditor } from './AvatarEditor';
import { MemberAvatar, type AvatarMetadata } from './MemberAvatar';
import { GitHubConnectionPanel } from './GitHubSocial';
import './MemberDirectory.css';
import {MemberSocialLinks,SocialLinksList} from './MemberSocialLinks';

type Audience='public'|'friends'|'squad'|'guild';
type Contact={value:string;audiences:Audience[];verified?:boolean};
type Account={user_id:string;avatar:AvatarMetadata;nickname:string;login_email:string;email_verified:boolean;contacts:Record<'email'|'discord'|'github'|'line',Contact>;aggregate_version:number};
type GuildRef={guild_key:string;name:string;joined_at?:string|null};
export type MemberCardData={user_id:string;joined_at?:string|null;joined_at_source?:'launch_day'|'registered';avatar_url?:string|null;nickname:string;positioning_title:string|null;primary_guild:GuildRef|null;secondary_guilds:GuildRef[];capabilities:string[];equipment:string[];custom_capabilities?:string[];custom_equipment?:string[];featured_capabilities?:string[];contacts:Partial<Record<'email'|'discord'|'github'|'line',string>>;is_self:boolean;friendship:{state:string;requester_ref?:string;aggregate_version?:number}};
const audienceOptions: [Audience,string][]=[['public','平台公開'],['friends','平台好友'],['squad','小隊夥伴'],['guild','公會夥伴']];
const contactLabels={email:'聯絡 E-mail',discord:'Discord 帳號',github:'GitHub 帳號',line:'LINE ID'} as const;
const fail=(e:unknown)=>e instanceof Error?e.message:'暫時無法讀取，請稍後再試。';
export function AccountPanel({client,session}:ModulePanelProps){
  const [account,setAccount]=useState<Account|null>(null),[nickname,setNickname]=useState(''),[contacts,setContacts]=useState<Account['contacts']|null>(null),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState(''),[member,setMember]=useState<MemberCardData|null>(null),[books,setBooks]=useState<SkillBook[]>([]),[labels,setLabels]=useState<Record<string,string>>({});
  const {mutate,busy,error}=useModuleMutation(client);
  const fill=(value:Account)=>{setAccount(value);setNickname(value.nickname);setContacts(value.contacts);};
  async function load(){setLoadError('');try{const [a,m,b]=await Promise.all([client.get<Account>('/me/account'),client.get<MemberCardData>(`/members/${session.user.user_id}`),client.get<{items:SkillBook[]}>('/me/skill-books')]);fill(a);setMember(m);setBooks(b.items);}catch(e){setLoadError(fail(e));}}
  useEffect(()=>{void load();void loadLabels(client).then(setLabels).catch(()=>{});},[client,session.user.user_id]);
  async function submit(event:FormEvent){event.preventDefault();if(!contacts||!account)return;setNotice('');const clean=Object.fromEntries(Object.entries(contacts).map(([key,c])=>[key,key==='email'?{audiences:c.audiences}:{value:c.value,audiences:c.audiences}]));const saved=await mutate<Account>('/me/account',{nickname,contacts:clean},account.aggregate_version);if(saved){fill(saved);setNotice('個人資料與每一項聯絡方式的可見範圍已保存。');window.dispatchEvent(new Event('freedom-profile-updated'));await load();}}
  return <section className="module-panel account-panel"><ModuleBanner eyebrow="YOUR MEMBER CARD" title="我的會員名片" description="讓夥伴認識你的方向與能力，聯絡方式由你決定分享給誰。"/>{member&&<MemberCard member={member} labels={labels} client={client}/>}
    {account&&<AvatarEditor client={client} nickname={account.nickname} initial={account.avatar} onSaved={avatar=>{setAccount(current=>current?{...current,avatar}:current);setMember(current=>current?{...current,avatar_url:avatar.avatar_url}:current);}}/>}
    <GitHubConnectionPanel/>
    <Status error={loadError||error} notice={notice}/>{loadError&&<button className="btn" onClick={()=>void load()}>重新載入我的資料</button>}{!account&&!loadError&&<p role="status">載入會員資料…</p>}{account&&contacts&&<form className="card stack account-settings" onSubmit={submit}><h3>暱稱與聯絡方式</h3><label className="field">喜歡的暱稱<input required minLength={1} maxLength={60} value={nickname} onChange={e=>setNickname(e.target.value)}/></label><p className="muted">Email 同時用於登入與聯絡，這裡可以選擇分享給誰。每項聯絡方式可勾選多種分享對象；都不勾選就是不公開。</p><div className="contact-grid">{(Object.keys(contactLabels) as (keyof typeof contactLabels)[]).map(key=><div className="contact-row" key={key}><label className="field">{contactLabels[key]}<input aria-label={contactLabels[key]} type={key==='email'?'email':'text'} value={key==='email'?account.login_email:contacts[key].value} readOnly={key==='email'} maxLength={key==='github'?39:key==='email'?200:100} autoComplete="off" onChange={key==='email'?undefined:e=>setContacts({...contacts,[key]:{...contacts[key],value:e.target.value}})} placeholder={key==='github'?'你的 GitHub username':key==='discord'?'你的 Discord username':undefined}/>{key==='email'&&<span className="field-hint">與登入信箱相同</span>}</label><AudienceChoices label={contactLabels[key]} audiences={contacts[key].audiences} onChange={audiences=>setContacts({...contacts,[key]:{...contacts[key],audiences}})}/></div>)}</div><p className="field-hint">「平台公開」涵蓋所有已登入的工坊會員。其他分享對象可同時勾選，符合任一項就能看見；好友須雙方接受，小隊與公會依目前有效成員關係判斷。社群帳號由本人填寫，尚未驗證身分。</p><button className="btn btn-primary" disabled={busy}>{busy?'保存中…':'保存個人資料與公開範圍'}</button></form>}<MemberSocialLinks client={client} memberId={session.user.user_id}/><section className="stack member-bookshelf"><h3>我的技能書架</h3>{books.length?<SkillBooks books={books}/>:<p className="muted">加入公會後，對應技能書會放在這裡。</p>}</section><ClientConnections client={client}/></section>;
}
function AudienceChoices({label,audiences,onChange}:{label:string;audiences:Audience[];onChange:(value:Audience[])=>void}){
  const isPublic=audiences.includes('public');
  const toggle=(audience:Audience)=>{if(audience==='public'){onChange(isPublic?[]:['public']);return;}onChange(audiences.includes(audience)?audiences.filter(value=>value!==audience):[...audiences,audience]);};
  return <fieldset className="fieldset" aria-label={`${label}可見範圍`}><legend>{label}可見範圍</legend><label className="checkbox-row"><input type="checkbox" checked={audiences.length===0} onChange={()=>onChange([])}/>不公開</label>{audienceOptions.map(([value,name])=><label className="checkbox-row" key={value}><input type="checkbox" checked={audiences.includes(value)} disabled={value!=='public'&&isPublic} onChange={()=>toggle(value)}/>{name}</label>)}{isPublic&&<p className="field-hint">平台公開已包含好友、小隊與公會夥伴。</p>}</fieldset>;
}
export function MemberCard({member,children,labels={},client}:{member:MemberCardData;children?:React.ReactNode;labels?:Record<string,string>;client?:PortalClient}){
  const featured=(member.featured_capabilities??member.capabilities.slice(0,3)).slice(0,3);
  const label=(id:string)=>id.startsWith('custom:')?id.slice(7):labels[id]??id;
  const abilities=[...member.capabilities,...(member.custom_capabilities??[]).map(value=>`custom:${value}`)],equipment=[...member.equipment,...(member.custom_equipment??[]).map(value=>`custom:${value}`)];
  return <article className="card member-card expedition-dossier">
    <div className="member-card-heading">
      <MemberAvatar nickname={member.nickname} avatarUrl={member.avatar_url}/>
      <div><p className="eyebrow">FREEDOM WORKSHOP MEMBER</p><h3>{member.nickname} <span className="positioning-title">{member.positioning_title??'探索自己的方向'}</span></h3><p>{member.primary_guild?`主要公會 · ${member.primary_guild.name}`:'尚未設定主要公會'}</p></div>
    </div>
    <div className="member-card-body">
      <div className="member-featured"><h4>擅長的能力</h4><div className="tag-list">{featured.length?featured.map(id=><span key={id} className="pill">{label(id)}</span>):<span className="muted">還在探索自己的專長</span>}</div></div>
      <div className="member-secondary-guilds"><h4>次要公會</h4><p className="muted">{member.secondary_guilds.map(g=>g.name).join('、')||'先專注在主要公會'}</p></div>
      <details className="member-full-profile"><summary>完整能力與裝備 · {abilities.length} 項能力／{equipment.length} 項裝備</summary><div className="stack"><div><h4>基本能力</h4><div className="tag-list">{abilities.length?abilities.map(id=><span key={id} className="pill">{label(id)}</span>):<span className="muted">尚未填寫</span>}</div></div><div><h4>裝備</h4><div className="tag-list">{equipment.length?equipment.map(id=><span key={id} className="pill">{label(id)}</span>):<span className="muted">尚未填寫</span>}</div></div></div></details>
      {Object.keys(member.contacts).length>0&&<dl className="detail-list">{Object.entries(member.contacts).map(([key,value])=><div key={key}><dt>{contactLabels[key as keyof typeof contactLabels]}</dt><dd>{value}</dd></div>)}</dl>}
      {client&&<SocialLinksList client={client} memberId={member.user_id}/>}
    </div>
    {children}
  </article>;

}
type DirectoryFilters={search:string;guild_key:string;sort:'newest'|'oldest'|'nickname'};
type DirectoryResponse={items:MemberCardData[];next_offset:number|null;total:number};
type DirectoryFriend={user_id:string;nickname:string;state:string;requester_ref:string;aggregate_version:number};
const defaultDirectoryFilters:DirectoryFilters={search:'',guild_key:'',sort:'newest'};

export function DirectoryMemberRow({member,labels,children,client}:{member:MemberCardData;labels:Record<string,string>;children?:React.ReactNode;client:PortalClient}){
  const [detailsOpen,setDetailsOpen]=useState(false);
  const skillLabel=(id:string)=>id.startsWith('custom:')?id.slice(7):labels[id]??id;
  const featured=(member.featured_capabilities??member.capabilities.slice(0,3)).slice(0,3);
  const abilities=[...member.capabilities,...(member.custom_capabilities??[]).map(value=>`custom:${value}`)];
  const equipment=[...member.equipment,...(member.custom_equipment??[]).map(value=>`custom:${value}`)];
  const joined=member.joined_at&&Number.isFinite(Date.parse(member.joined_at))?member.joined_at:null;
  const contacts=(Object.keys(contactLabels) as (keyof typeof contactLabels)[]).filter(key=>typeof member.contacts[key]==='string'&&member.contacts[key]);
  return <article className="directory-member" data-member-id={member.user_id} aria-label={member.nickname}>
    <div className="directory-member-identity"><MemberAvatar nickname={member.nickname} avatarUrl={member.avatar_url}/><div><div className="directory-member-name"><h3>{member.nickname}</h3>{member.is_self&&<span className="badge">你</span>}</div><p className="directory-member-title">{member.positioning_title??'探索自己的方向'}</p><p className="directory-member-guild">{member.primary_guild?.name??'尚未設定主要公會'}</p></div></div>
    <div className="directory-member-skills" aria-label="擅長的能力">{featured.length?featured.map(id=><span className="pill" key={id}>{skillLabel(id)}</span>):<span className="muted">尚未填寫專長</span>}</div>
    <div className="directory-member-meta">{joined?<span><time dateTime={joined} title={member.joined_at_source==='launch_day'?'開站日 · 台北時間':'台北時間'}>{new Date(joined).toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'})}</time> 加入</span>:<span>加入日期未記錄</span>}{children}</div>
    <details className="directory-member-details" onToggle={event=>setDetailsOpen(event.currentTarget.open)}><summary>更多資料</summary><div className="directory-member-expanded"><section><h4>公會加入紀錄</h4><ul className="directory-guild-dates">{[...(member.primary_guild?[member.primary_guild]:[]),...member.secondary_guilds].map(guild=><li key={guild.guild_key}><strong>{guild.name}</strong><span>{guild.guild_key===member.primary_guild?.guild_key?'主要公會':'次要公會'}{guild.joined_at&&Number.isFinite(Date.parse(guild.joined_at))?<> · <time dateTime={guild.joined_at}>{new Date(guild.joined_at).toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'})}</time> 加入</>:null}</span></li>)}</ul>{!member.primary_guild&&!member.secondary_guilds.length&&<p>尚未加入公會</p>}</section><section><h4>完整能力</h4><div className="tag-list">{abilities.length?abilities.map(id=><span key={id} className="pill">{skillLabel(id)}</span>):<p>尚未填寫</p>}</div></section><section><h4>裝備</h4><div className="tag-list">{equipment.length?equipment.map(id=><span key={id} className="pill">{skillLabel(id)}</span>):<p>尚未填寫</p>}</div></section><section><h4>聯絡方式</h4>{contacts.length?<dl>{contacts.map(key=><div key={key}><dt>{contactLabels[key]}</dt><dd>{member.contacts[key]}</dd></div>)}</dl>:<p>沒有對你公開的聯絡方式。</p>}</section>{detailsOpen&&<SocialLinksList client={client} memberId={member.user_id}/>}</div></details>
  </article>;
}

export function MembersPanel({client,session}:ModulePanelProps){
  const [members,setMembers]=useState<MemberCardData[]>([]),[nextOffset,setNextOffset]=useState<number|null>(null),[total,setTotal]=useState<number|null>(null),[loadError,setLoadError]=useState(''),[loading,setLoading]=useState(true),[notice,setNotice]=useState(''),[labels,setLabels]=useState<Record<string,string>>({});
  const [friends,setFriends]=useState<DirectoryFriend[]>([]),[friendError,setFriendError]=useState('');
  const [guilds,setGuilds]=useState<GuildRef[]>([]),[guildError,setGuildError]=useState(''),[search,setSearch]=useState(''),[filters,setFilters]=useState<DirectoryFilters>(defaultDirectoryFilters);
  const filterRef=useRef(filters),generation=useRef(0),friendsGeneration=useRef(0),guildGeneration=useRef(0),loadedOffset=useRef(0);
  filterRef.current=filters;
  const {mutate,busy,error}=useModuleMutation(client);
  const load=useCallback(async(offset=0)=>{
    const sequence=++generation.current,current=filterRef.current;
    const query=new URLSearchParams({limit:'20',offset:String(offset),sort:current.sort});
    if(current.search)query.set('search',current.search);
    if(current.guild_key)query.set('guild_key',current.guild_key);
    setLoadError('');setLoading(true);loadedOffset.current=offset;
    if(offset===0){setMembers([]);setNextOffset(null);setTotal(null);}
    try{
      const data=await client.get<DirectoryResponse>(`/members?${query}`);
      if(sequence!==generation.current)return;
      setMembers(existing=>offset?[...new Map([...existing,...data.items].map(member=>[member.user_id,member])).values()]:data.items);
      setNextOffset(data.next_offset);setTotal(data.total);
    }catch(cause){if(sequence===generation.current)setLoadError(fail(cause));}
    finally{if(sequence===generation.current)setLoading(false);}
  },[client]);
  const loadFriends=useCallback(async()=>{
    const sequence=++friendsGeneration.current;setFriendError('');
    try{const data=await client.get<{items:DirectoryFriend[]}>('/friends');if(sequence===friendsGeneration.current)setFriends(data.items);}
    catch(cause){if(sequence===friendsGeneration.current)setFriendError(fail(cause));}
  },[client]);
  const loadGuilds=useCallback(async()=>{
    const sequence=++guildGeneration.current;setGuildError('');
    try{const data=await client.get<{items:GuildRef[]}>('/guilds/directory');if(sequence===guildGeneration.current)setGuilds(data.items);}
    catch(cause){if(sequence===guildGeneration.current)setGuildError(fail(cause));}
  },[client]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load,filters]);
  useEffect(()=>{let active=true;void loadFriends();void loadGuilds();void loadLabels(client).then(data=>{if(active)setLabels(data);}).catch(()=>{});return()=>{active=false;friendsGeneration.current++;guildGeneration.current++;};},[client,loadFriends,loadGuilds]);
  useEffect(()=>{const timer=setTimeout(()=>{const term=search.trim();setFilters(current=>{if(current.search===term)return current;generation.current++;return {...current,search:term};});},250);return()=>clearTimeout(timer);},[search]);
  function filter(change:Partial<DirectoryFilters>){generation.current++;setFilters(current=>({...current,...change}));}
  function searchNow(event:FormEvent){event.preventDefault();filter({search:search.trim()});}
  function reset(){setSearch('');filter(defaultDirectoryFilters);}
  async function act(userId:string,action:string,version?:number){setNotice('');const result=await mutate(`/friends/${userId}/${action}`,{},version);if(result){setNotice(action==='accept'?'已成為平台好友。':action==='remove'?'好友關係已移除。':'好友邀請已送出，等待對方接受。');await Promise.all([load(),loadFriends()]);}}
  const invitations=friends.filter(friend=>friend.state==='pending'&&friend.requester_ref!==session.user.user_id);
  const filtered=Boolean(filters.search||filters.guild_key),changed=filtered||filters.sort!=='newest'||Boolean(search);
  return <section className="module-panel members-panel"><ModuleBanner eyebrow="FIND YOUR PEOPLE" title="工坊夥伴" description="依專長與公會找到一起做事的夥伴。" art="/art/rpg/cooperation-forge.webp"/>
    <Status error={error} notice={notice}/>
    {friendError&&<div className="banner banner-error" role="alert"><p>好友邀請暫時無法載入：{friendError}</p><button className="btn btn-ghost" onClick={()=>void loadFriends()}>重讀好友邀請</button></div>}
    {invitations.length>0&&<section className="card stack directory-invitations"><h3>收到的好友邀請</h3>{invitations.map(friend=><div className="member-request" key={friend.user_id}><strong>{friend.nickname}</strong><button className="btn btn-primary" disabled={busy} onClick={()=>void act(friend.user_id,'accept',friend.aggregate_version)}>接受邀請</button><button className="btn btn-ghost" disabled={busy} onClick={()=>void act(friend.user_id,'remove',friend.aggregate_version)}>婉拒</button></div>)}</section>}
    <form className="directory-filters" onSubmit={searchNow}><label className="field directory-search">搜尋夥伴<div><input type="search" aria-label="搜尋夥伴" maxLength={100} value={search} onChange={event=>setSearch(event.target.value)} placeholder="暱稱、定位稱號或專長" autoComplete="off"/>{search&&<button type="button" className="btn btn-ghost" aria-label="清除搜尋" onClick={()=>{setSearch('');filter({search:''});}}>清除</button>}</div></label><label className="field">依公會篩選<select value={filters.guild_key} onChange={event=>filter({guild_key:event.target.value})}><option value="">全部公會</option>{guilds.map(guild=><option value={guild.guild_key} key={guild.guild_key}>{guild.name}</option>)}</select></label><label className="field">排序方式<select value={filters.sort} onChange={event=>filter({sort:event.target.value as DirectoryFilters['sort']})}><option value="newest">最新加入</option><option value="oldest">最早加入</option><option value="nickname">暱稱排序</option></select></label><div className="directory-filter-actions"><button className="btn btn-primary" type="submit">搜尋</button>{changed&&<button className="btn btn-ghost" type="button" onClick={reset}>重設篩選</button>}</div></form>
    {guildError&&<div className="directory-options-error" role="alert"><span>公會選項暫時無法載入。</span><button className="btn btn-ghost" onClick={()=>void loadGuilds()}>重讀公會選項</button></div>}
    <div className="directory-results-heading"><p className="directory-result-count" aria-live="polite">{loading&&members.length===0?'正在尋找夥伴…':total===null?'':`顯示 ${members.length} / ${total} 位夥伴`}</p><p className="field-hint">聯絡方式依本人設定顯示。</p></div>
    {loadError&&<div role="alert" className="banner banner-error"><p>{loadError}</p><button className="btn btn-ghost" onClick={()=>void load(loadedOffset.current)}>重新載入夥伴</button></div>}
    <div className="member-directory directory-rows" aria-busy={loading}>{members.map(member=><DirectoryMemberRow key={member.user_id} member={member} labels={labels} client={client}>{!member.is_self&&<div className="directory-friend-actions">{member.friendship.state==='accepted'?<><span className="badge">平台好友</span><button className="btn btn-ghost" disabled={busy} onClick={()=>void act(member.user_id,'remove',member.friendship.aggregate_version)}>移除好友</button></>:member.friendship.state==='pending'?<span className="muted">{member.friendship.requester_ref===session.user.user_id?'好友邀請已送出':'對方已邀請你'}</span>:<button className="btn btn-ghost" disabled={busy} onClick={()=>void act(member.user_id,'request',member.friendship.aggregate_version)}>邀請成為好友</button>}</div>}</DirectoryMemberRow>)}</div>
    {loading&&members.length>0&&<p role="status">正在載入更多夥伴…</p>}
    {!loading&&!members.length&&!loadError&&<div className="directory-empty"><p>{filtered?'沒有符合的夥伴。換個關鍵字或公會試試。':'還沒有完成定位的會員。'}</p>{filtered&&<button className="btn btn-ghost" onClick={reset}>查看全部夥伴</button>}</div>}
    {nextOffset!==null&&!loadError&&<button className="btn btn-ghost directory-load-more" disabled={loading} onClick={()=>void load(nextOffset)}>查看更多夥伴</button>}
  </section>;
}
export async function loadLabels(client:PortalClient){const definition=await client.get<{capability_categories:{options:{id:string;label:string}[]}[];equipment_categories:{options:{id:string;label:string}[]}[]}>('/assessment-definition');return Object.fromEntries([...definition.capability_categories,...definition.equipment_categories].flatMap(c=>c.options).map(o=>[o.id,o.label]));}
export function Status({error,notice}:{error?:string|null;notice?:string|null}){return <>{error&&<p role="alert" className="banner banner-error">{error}</p>}{notice&&<p role="status" className="banner status-note">{notice}</p>}</>;}
