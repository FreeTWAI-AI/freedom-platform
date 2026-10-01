import {useCallback,useEffect,useRef,useState} from 'react';
import {useModuleMutation,type ModulePanelProps} from './shared';
import {DirectoryMemberRow,loadLabels,type MemberCardData} from './Membership';
import {announceInboxChange} from './member-inbox';
import './MemberConnections.css';
type Scope='accepted'|'incoming'|'outgoing';
type Page={items:MemberCardData[];total:number;next_offset:number|null};
export function FriendsPanel({client,onNavigate,onMessage}:ModulePanelProps&{onMessage:(id:string)=>void}){
  const [scope,setScope]=useState<Scope>('accepted'),[search,setSearch]=useState(''),[page,setPage]=useState<Page|null>(null),[offset,setOffset]=useState(0),[labels,setLabels]=useState<Record<string,string>>({}),[loadError,setLoadError]=useState(''),[loading,setLoading]=useState(true),[notice,setNotice]=useState('');
  const generation=useRef(0),{mutate,busy,error}=useModuleMutation(client);
  const load=useCallback(async()=>{const current=++generation.current;setLoading(true);setLoadError('');setPage(null);try{const query=new URLSearchParams({scope,search,offset:String(offset),limit:'20'});const data=await client.get<Page>(`/friends/directory?${query}`);if(current===generation.current)setPage(data);}catch(cause){if(current===generation.current)setLoadError(cause instanceof Error?cause.message:'好友名單暫時無法載入。');}finally{if(current===generation.current)setLoading(false);}},[client,scope,search,offset]);
  useEffect(()=>{const timer=setTimeout(()=>void load(),search?250:0);return()=>{clearTimeout(timer);generation.current++;};},[load]);
  useEffect(()=>{let active=true;void loadLabels(client).then(data=>{if(active)setLabels(data);}).catch(()=>{});return()=>{active=false;};},[client]);
  async function act(member:MemberCardData,action:'accept'|'remove'){setNotice('');const result=await mutate(`/friends/${member.user_id}/${action}`,{},member.friendship.aggregate_version);if(result){setNotice(action==='accept'?`已和${member.nickname}成為好友。`:'好友關係或邀請已移除。');announceInboxChange();await load();}}
  function changeScope(next:Scope){generation.current++;setPage(null);setScope(next);setOffset(0);}
  return <section className="module-panel members-panel friends-panel"><div className="actions"><button type="button" className="btn btn-ghost" onClick={()=>onNavigate?.('members')}>認識更多工坊夥伴</button></div>
    <div className="friend-scopes" role="group" aria-label="好友名單範圍">{([['accepted','我的好友'],['incoming','收到的邀請'],['outgoing','送出的邀請']] as [Scope,string][]).map(([key,label])=><button type="button" className="btn btn-ghost" key={key} aria-pressed={scope===key} onClick={()=>changeScope(key)}>{label}</button>)}</div>
    <label className="field">搜尋好友名稱<input type="search" maxLength={100} value={search} onChange={event=>{generation.current++;setPage(null);setSearch(event.target.value);setOffset(0);}}/></label>
    {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重讀好友名單</button></div>}{error&&<div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void load()}>重讀好友名單</button></div>}{notice&&<p role="status" className="banner status-note">{notice}</p>}
    {loading&&<p role="status">正在載入好友名單…</p>}{!loading&&!loadError&&page&&<><p className="field-hint" aria-live="polite">共 {page.total} 位{scope==='accepted'?'好友':'待回覆的夥伴'}</p>{!page.items.length&&<p>{search?'沒有符合的名字。':scope==='accepted'?'還沒有好友，從工坊夥伴或首頁推薦開始認識彼此。':'目前沒有待回覆的邀請。'}</p>}
      <div className="directory-rows">{page.items.map(member=><DirectoryMemberRow key={member.user_id} member={member} labels={labels} client={client}><div className="directory-friend-actions">{scope==='accepted'?<><button type="button" className="btn btn-ghost" onClick={()=>onMessage(member.user_id)}>私訊使用者</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void act(member,'remove')}>移除好友</button></>:scope==='incoming'?<><button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void act(member,'accept')}>接受邀請</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void act(member,'remove')}>婉拒</button></>:<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void act(member,'remove')}>取消邀請</button>}</div></DirectoryMemberRow>)}</div>
      <div className="actions">{offset>0&&<button type="button" className="btn btn-ghost" onClick={()=>setOffset(value=>Math.max(0,value-20))}>上一頁好友</button>}{page.next_offset!==null&&<button type="button" className="btn btn-ghost" onClick={()=>setOffset(page.next_offset!)}>下一頁好友</button>}</div></>}
  </section>;
}
