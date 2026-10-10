import {useEffect,useRef,useState,type FormEvent} from 'react';
import {SQUAD_KINDS,SQUAD_KIND_LABELS,type SquadKind} from '../../../../packages/shared/squad-kinds';
import {ApiError,type PortalClient} from '../api';
import {useModuleMutation,type ModulePanelProps} from './shared';
import {Status} from './Membership';
import {ModuleBanner} from './ModuleBanner';
import {SquadOwnerTools} from './SquadOwnerTools';
import './ModuleDiscovery.css';
import './SquadInvitations.css';
type Squad={squad_id:string;name:string;kind:SquadKind;purpose:string;communication_channel_name:string;aggregate_version:number;owner_ref:string;owner_name:string;member_count:number;membership:null|{state:string;aggregate_version:number}};
type SquadDetail=Squad&{members:{user_id:string;nickname:string;state:string;aggregate_version:number}[]};
const kindLabels=SQUAD_KIND_LABELS;
const kindOptions=SQUAD_KINDS.map(kind=><option key={kind} value={kind}>{kindLabels[kind]}</option>);
type Invitation={invitation_id:string;squad_id:string;squad_name:string;owner_ref:string;owner_name:string;recipient_ref:string;recipient_name:string;state:'pending'|'accepted'|'declined'|'withdrawn';aggregate_version:number;created_at:string;updated_at:string;resolved_at:string|null};
type InvitationPage={items:Invitation[];next_offset:number|null};
type Mutate=ReturnType<typeof useModuleMutation>['mutate'];
const invitationLabels={pending:'待回覆',accepted:'已接受',declined:'已婉拒',withdrawn:'已撤回'};
const message=(e:unknown,fallback:string)=>e instanceof Error?e.message:fallback;

// A shared page loader: only the newest request may write, so a slow earlier
// page or filter never overwrites the list the member is looking at now.
function useInvitationPages(client:PortalClient,path:(offset:number)=>string,deps:unknown[]){
  const [items,setItems]=useState<Invitation[]>([]),[nextOffset,setNextOffset]=useState<number|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[failedOffset,setFailedOffset]=useState(0);
  const request=useRef(0);
  async function load(offset=0){const token=++request.current;setLoading(true);setError('');setFailedOffset(offset);try{const data=await client.get<InvitationPage>(path(offset));if(token!==request.current)return;setItems(current=>offset?[...current,...data.items]:data.items);setNextOffset(data.next_offset);}catch(e){if(token===request.current)setError(message(e,'無法載入小隊邀請。'));}finally{if(token===request.current)setLoading(false);}}
  useEffect(()=>{void load();return ()=>{request.current++;};},deps);
  return {items,nextOffset,loading,error,load,retry:()=>void load(failedOffset)};
}

function ReceivedInvitations({client,mutate,busy,refreshToken,onChanged}:{client:PortalClient;mutate:Mutate;busy:boolean;refreshToken:number;onChanged:(notice:string)=>Promise<void>}){
  const [expanded,setExpanded]=useState(false);
  const [showAll,setShowAll]=useState(false),heading=useRef<HTMLHeadingElement>(null);
  const page=useInvitationPages(client,offset=>`/me/squad-invitations?state=${showAll?'all':'pending'}&limit=20&offset=${offset}`,[client,showAll,refreshToken]);
  useEffect(()=>{if(page.error||page.items.some(item=>item.state==='pending'))setExpanded(true);},[page.error,page.items]);
  async function respond(invitation:Invitation,action:'accept'|'decline'){
    const result=await mutate<Invitation>(`/squad-invitations/${invitation.invitation_id}/${action}`,{},invitation.aggregate_version);
    if(result){await onChanged(action==='accept'?`已加入「${result.squad_name}」。`:`已婉拒「${result.squad_name}」的邀請。`);heading.current?.focus();}
    else await onChanged(''); // Keep the error visible, but replace a stale pending row with the current record.
  }
  return <section className="squad-invitations" aria-labelledby="received-squad-invitations">
    <details open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary><h3 id="received-squad-invitations" data-guide-anchor="squads:invitations" ref={heading} tabIndex={-1}>收到的小隊邀請</h3><span className="muted">{page.loading?'載入中…':page.items.some(item=>item.state==='pending')?'有待回覆邀請':'查看紀錄'}</span></summary>
      <label className="squad-invitations-toggle"><input type="checkbox" checked={showAll} onChange={event=>setShowAll(event.target.checked)}/>顯示已回覆</label>
    {page.items.length>0&&<ul className="squad-invitation-list">{page.items.map(invitation=><li key={invitation.invitation_id} className="squad-invitation">
      <div><strong>{invitation.squad_name}</strong><span className="muted">隊主：{invitation.owner_name} · {invitationLabels[invitation.state]}</span></div>
      {invitation.state==='pending'&&<div className="actions"><button className="btn btn-primary" disabled={busy} aria-label={`接受邀請：${invitation.squad_name}`} onClick={()=>void respond(invitation,'accept')}>接受</button><button className="btn btn-ghost" disabled={busy} aria-label={`婉拒邀請：${invitation.squad_name}`} onClick={()=>void respond(invitation,'decline')}>婉拒</button></div>}
    </li>)}</ul>}
    {page.loading&&<p role="status">正在載入小隊邀請…</p>}
    {page.error&&<><p role="alert" className="banner banner-error">{page.error}</p><button className="btn btn-ghost" disabled={page.loading} onClick={page.retry}>重新載入邀請</button></>}
    {!page.loading&&!page.error&&!page.items.length&&<p className="field-hint">{showAll?'還沒有收到小隊邀請。':'目前沒有待回覆的小隊邀請。'}</p>}
    {page.nextOffset!==null&&!page.error&&<button className="btn btn-ghost" disabled={page.loading} onClick={()=>void page.load(page.nextOffset!)}>查看更多邀請</button>}
    </details>
  </section>;
}

type Candidate={user_id:string;nickname:string;positioning_title?:string|null};
function OwnerInvitations({client,squad,selfId,mutate,busy,refreshToken,onChanged}:{client:PortalClient;squad:SquadDetail;selfId:string;mutate:Mutate;busy:boolean;refreshToken:number;onChanged:(notice:string)=>Promise<void>}){
  const outgoing=useInvitationPages(client,offset=>`/squads/${squad.squad_id}/invitations?limit=20&offset=${offset}`,[client,squad.squad_id,refreshToken]);
  const [search,setSearch]=useState(''),[candidates,setCandidates]=useState<Candidate[]|null>(null),[searching,setSearching]=useState(false),[searchError,setSearchError]=useState('');
  const searchRequest=useRef(0),heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>()=>{searchRequest.current++;},[]);
  async function find(event?:FormEvent<HTMLFormElement>){event?.preventDefault();const token=++searchRequest.current;setSearching(true);setSearchError('');
    try{const data=await client.get<{items:Candidate[]}>(`/members?limit=20&sort=nickname&search=${encodeURIComponent(search.trim())}`);if(token===searchRequest.current)setCandidates(data.items.filter(member=>member.user_id!==selfId));}
    catch(e){if(token===searchRequest.current)setSearchError(message(e,'無法搜尋夥伴。'));}finally{if(token===searchRequest.current)setSearching(false);}}
  function status(candidate:Candidate){
    const member=squad.members.find(row=>row.user_id===candidate.user_id);
    if(member?.state==='active')return '已在小隊';
    if(outgoing.items.some(row=>row.recipient_ref===candidate.user_id&&row.state==='pending'))return '已邀請，等候回覆';
    if(member?.state==='pending')return '已申請加入，可直接接受';
    return null;
  }
  async function invite(candidate:Candidate){const result=await mutate<Invitation>(`/squads/${squad.squad_id}/invitations`,{recipient_ref:candidate.user_id});if(result){await onChanged(`已邀請 ${result.recipient_name}，等候對方回覆。`);heading.current?.focus();}else await onChanged('');}
  async function withdraw(invitation:Invitation){const result=await mutate<Invitation>(`/squad-invitations/${invitation.invitation_id}/withdraw`,{},invitation.aggregate_version);if(result){await onChanged(`已撤回給 ${result.recipient_name} 的邀請。`);heading.current?.focus();}else await onChanged('');}
  return <section className="squad-invite-manager stack" aria-label="邀請夥伴">
    <form className="squad-invite-search" onSubmit={find}><label className="field">搜尋要邀請的夥伴<input type="search" value={search} maxLength={100} onChange={event=>setSearch(event.target.value)} placeholder="暱稱、定位或技能"/></label><button className="btn btn-ghost" disabled={searching}>搜尋夥伴</button></form>
    <p className="field-hint">對方接受後才會加入小隊；接受前看不到只分享給小隊夥伴的聯絡方式。</p>
    {searching&&<p role="status">正在搜尋夥伴…</p>}
    {searchError&&<><p role="alert" className="banner banner-error">{searchError}</p><button className="btn btn-ghost" onClick={()=>void find()}>重新搜尋</button></>}
    {candidates&&!searching&&!searchError&&(candidates.length?<ul className="squad-invitation-list" aria-label="搜尋結果">{candidates.map(candidate=>{const state=status(candidate);return <li key={candidate.user_id} className="squad-invitation">
      <div><strong>{candidate.nickname}</strong>{candidate.positioning_title&&<span className="muted">{candidate.positioning_title}</span>}</div>
      {state?<span className="muted">{state}</span>:<button className="btn btn-primary" disabled={busy||outgoing.loading||Boolean(outgoing.error)} aria-label={`邀請 ${candidate.nickname}`} onClick={()=>void invite(candidate)}>邀請</button>}
    </li>;})}</ul>:<p className="field-hint">沒有符合的夥伴。</p>)}
    <h4 ref={heading} tabIndex={-1}>送出的邀請</h4>
    {outgoing.items.length>0&&<ul className="squad-invitation-list">{outgoing.items.map(invitation=><li key={invitation.invitation_id} className="squad-invitation">
      <div><strong>{invitation.recipient_name}</strong><span className="muted">{invitationLabels[invitation.state]}</span></div>
      {invitation.state==='pending'&&<button className="btn btn-ghost" disabled={busy} aria-label={`撤回給 ${invitation.recipient_name} 的邀請`} onClick={()=>void withdraw(invitation)}>撤回邀請</button>}
    </li>)}</ul>}
    {outgoing.loading&&<p role="status">正在載入送出的邀請…</p>}
    {outgoing.error&&<><p role="alert" className="banner banner-error">{outgoing.error}</p><button className="btn btn-ghost" disabled={outgoing.loading} onClick={outgoing.retry}>重新載入送出的邀請</button></>}
    {!outgoing.loading&&!outgoing.error&&!outgoing.items.length&&<p className="field-hint">還沒有送出邀請。</p>}
    {outgoing.nextOffset!==null&&!outgoing.error&&<button className="btn btn-ghost" disabled={outgoing.loading} onClick={()=>void outgoing.load(outgoing.nextOffset!)}>查看更多送出的邀請</button>}
  </section>;
}
export function SquadsPanel({client,session}:ModulePanelProps){
  const [squads,setSquads]=useState<Squad[]>([]),[detail,setDetail]=useState<SquadDetail|null>(null);
  const [loadError,setLoadError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true),[nextOffset,setNextOffset]=useState<number|null>(null);
  const [query,setQuery]=useState(''),[kind,setKind]=useState<'all'|SquadKind>('all'),[onlyMine,setOnlyMine]=useState(false);
  const [failedOffset,setFailedOffset]=useState(0),[detailError,setDetailError]=useState(''),[detailLoading,setDetailLoading]=useState(false);
  const [creating,setCreating]=useState(false),[inviting,setInviting]=useState(false),[refreshToken,setRefreshToken]=useState(0);
  const nameInput=useRef<HTMLInputElement>(null),detailHeading=useRef<HTMLHeadingElement>(null),directoryHeading=useRef<HTMLHeadingElement>(null);
  const detailTrigger=useRef<HTMLElement|null>(null),createTrigger=useRef<HTMLButtonElement>(null);
  const detailRequest=useRef(0),listRequest=useRef(0),openSquad=useRef<string|null>(null),focusDetail=useRef(false);
  const {mutate,busy,error}=useModuleMutation(client);
  const selfId=session.user.user_id;
  async function load(offset=0){
    const token=++listRequest.current;setLoading(true);setLoadError('');setFailedOffset(offset);
    try{const data=await client.get<{items:Squad[];next_offset:number|null}>(`/squads?limit=20&offset=${offset}`);
      if(token!==listRequest.current)return;
      setSquads(current=>offset?[...current,...data.items]:data.items);setNextOffset(data.next_offset);
    }catch(e){if(token===listRequest.current)setLoadError(message(e,'無法載入小隊。'));}
    finally{if(token===listRequest.current)setLoading(false);}
  }
  async function open(id:string,trigger?:HTMLElement,invite=false){
    const token=++detailRequest.current;openSquad.current=id;setDetailError('');setDetailLoading(true);
    if(trigger)detailTrigger.current=trigger;
    try{const data=await client.get<SquadDetail>(`/squads/${id}`);if(token!==detailRequest.current)return;
      const own=data.members.find(member=>member.user_id===selfId);
      if(trigger){focusDetail.current=true;setInviting(invite);}
      setCreating(false);setDetail({...data,membership:own?{state:own.state,aggregate_version:own.aggregate_version}:null});
    }catch(e){if(token===detailRequest.current){
      if(e instanceof ApiError&&e.status===404){closeDetail();setNotice('這支小隊已不存在或目前無法查看，已返回列表。');}
      else setDetailError(message(e,'無法載入小隊。'));
    }}
    finally{if(token===detailRequest.current)setDetailLoading(false);}
  }
  useEffect(()=>{if(!focusDetail.current)return;focusDetail.current=false;detailHeading.current?.focus();},[detail]);
  useEffect(()=>{if(creating)nameInput.current?.focus();},[creating]);
  async function refreshAll(text:string){
    setNotice(text);setRefreshToken(token=>token+1);
    await Promise.all([load(),openSquad.current?open(openSquad.current):undefined]);
  }
  useEffect(()=>{void load();return ()=>{listRequest.current++;detailRequest.current++;};},[client]);
  function closeDetail(){
    detailRequest.current++;openSquad.current=null;setDetail(null);setDetailLoading(false);setDetailError('');setInviting(false);
    requestAnimationFrame(()=>{if(detailTrigger.current?.isConnected)detailTrigger.current.focus();else directoryHeading.current?.focus();});
  }
  async function create(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=event.currentTarget,d=new FormData(form);
    const result=await mutate<Squad>('/squads',{name:d.get('name'),kind:d.get('kind'),purpose:d.get('purpose'),communication_channel_name:d.get('communication_channel_name')});
    if(result){form.reset();setNotice('小隊已成立，現在可以邀請夥伴。');setCreating(false);setQuery('');setKind('all');setOnlyMine(false);
      await load();await open(result.squad_id,createTrigger.current??undefined,true);}
  }
  async function saveChannel(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!detail)return;
    const name=new FormData(event.currentTarget).get('communication_channel_name');
    const result=await mutate(`/squads/${detail.squad_id}/channel`,{communication_channel_name:name},detail.aggregate_version);
    await refreshAll(result?'小隊溝通頻道已更新，所有會員都看得見。':'');
  }
  async function change(squad:Squad,action:string,version?:number){
    const result=await mutate(`/squads/${squad.squad_id}/${action}`,{},version);
    await refreshAll(result?(action==='request'?'加入申請已送出，等待隊主接受。':'小隊資料已更新。'):'');
  }
  const search=query.trim().toLocaleLowerCase();
  const visibleSquads=squads.filter(squad=>(!onlyMine||squad.owner_ref===selfId||squad.membership?.state==='active')&&(kind==='all'||squad.kind===kind)&&(!search||[squad.name,squad.purpose,squad.communication_channel_name,squad.owner_name].join(' ').toLocaleLowerCase().includes(search)));
  const filtered=Boolean(search||kind!=='all'||onlyMine),isOwner=detail?.owner_ref===selfId;
  return <section className="module-panel squad-panel">
    <div hidden={Boolean(detail)||creating}>
      <ModuleBanner eyebrow="" title="找夥伴，一起完成想做的事" description="">
        <button ref={createTrigger} className="btn btn-primary" onClick={()=>{detailRequest.current++;openSquad.current=null;setDetailLoading(false);setCreating(true);}}>成立一支小隊</button>
      </ModuleBanner>
    </div>
    <Status error={loadError||detailError||error} notice={notice}/>
    {detailLoading&&<p role="status">正在載入小隊詳情…</p>}
    <div hidden={Boolean(detail)||creating} className="stack">
      <ReceivedInvitations client={client} mutate={mutate} busy={busy} refreshToken={refreshToken} onChanged={refreshAll}/>
      <section className="squad-directory" aria-labelledby="squad-directory-heading">
        <div className="squad-directory-heading"><h3 id="squad-directory-heading" ref={directoryHeading} tabIndex={-1}>尋找小隊</h3>
          <label className="squad-invitations-toggle"><input type="checkbox" checked={onlyMine} onChange={event=>setOnlyMine(event.target.checked)}/>只看我的小隊</label>
        </div>
        <div className="discovery-toolbar">
          <label className="field discovery-search">搜尋小隊<input data-guide-anchor="squads:search" type="search" value={query} maxLength={150} onChange={event=>setQuery(event.target.value)} placeholder="小隊名稱、目標、頻道或隊主"/></label>
          <label className="field">篩選小隊類型<select value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="all">全部類型</option>{kindOptions}</select></label>
        </div>
        <div className="discovery-feedback">
          {squads.length>0&&<p role="status">顯示 {visibleSquads.length} / {squads.length} 支小隊</p>}
          {filtered&&<button className="btn btn-ghost" onClick={()=>{setQuery('');setKind('all');setOnlyMine(false);}}>清除小隊篩選</button>}
        </div>
        {nextOffset!==null&&<p className="field-hint">目前只篩選已載入的小隊。載入更多，可繼續找夥伴。</p>}
        <div className="card-grid">{visibleSquads.map(squad=><article className="card expedition-squad" key={squad.squad_id}>
          <span className="eyebrow">{kindLabels[squad.kind]}</span><h3>{squad.name}</h3>
          <p className="squad-purpose">{squad.purpose}</p>
          {squad.communication_channel_name&&<p className="muted squad-channel">溝通頻道：{squad.communication_channel_name}</p>}
          <p className="muted squad-meta"><span>隊長：{squad.owner_name}</span><span>{squad.member_count} 位夥伴</span></p>
          <div className="actions">
            <button className="btn btn-ghost" aria-label={`查看小隊：${squad.name}`} onClick={event=>void open(squad.squad_id,event.currentTarget)}>查看小隊</button>
            {squad.owner_ref===selfId?<button className="btn btn-ghost" aria-label={`邀請夥伴：${squad.name}`} onClick={event=>void open(squad.squad_id,event.currentTarget,true)}>邀請夥伴</button>
              :squad.membership?.state==='active'?<span className="badge">已加入</span>
              :squad.membership?.state==='pending'?<span className="muted">等候隊主接受</span>
              :<button className="btn btn-ghost" disabled={busy} onClick={()=>void change(squad,'request',squad.membership?.aggregate_version)}>申請加入</button>}
          </div>
        </article>)}</div>
        {loading&&<p role="status">正在載入小隊…</p>}
        {!loading&&!loadError&&!visibleSquads.length&&<div className="discovery-empty"><h4>{filtered?'沒有符合條件的小隊':'還沒有小隊'}</h4>{!filtered&&<p className="field-hint">從「成立一支小隊」開始找夥伴。</p>}</div>}
        {loadError&&<button className="btn btn-ghost" disabled={loading} onClick={()=>void load(failedOffset)}>重新載入小隊</button>}
        {nextOffset!==null&&<button className="btn btn-ghost" disabled={loading} onClick={()=>void load(nextOffset)}>查看更多小隊</button>}
      </section>
    </div>
    {detail&&<section className="card stack expedition-squad-detail" aria-label="小隊詳情">
      <div className="card-head"><h3 ref={detailHeading} tabIndex={-1}>{detail.name}的夥伴</h3><button className="btn btn-ghost" onClick={closeDetail}>返回小隊列表</button></div>
      <p className="muted">{kindLabels[detail.kind]} · 隊長：{detail.members.find(member=>member.user_id===detail.owner_ref)?.nickname??'目前不可用的會員'}</p>
      <p className="multiline-text">{detail.purpose}</p>
      {detail.communication_channel_name&&<p className="muted">溝通頻道：{detail.communication_channel_name}</p>}
      {isOwner&&<div className="actions squad-detail-actions" aria-label="小隊操作">
        <button className="btn btn-ghost" aria-pressed={!inviting} onClick={()=>setInviting(false)}>成員與管理</button>
        <button className="btn btn-ghost" aria-pressed={inviting} onClick={()=>setInviting(true)}>邀請夥伴</button>
      </div>}
      {isOwner&&inviting?<OwnerInvitations key={detail.squad_id} client={client} squad={detail} selfId={selfId} mutate={mutate} busy={busy} refreshToken={refreshToken} onChanged={refreshAll}/>
        :isOwner?<SquadOwnerTools key={detail.squad_id} squad={detail} selfId={selfId} mutate={mutate} busy={busy} onChanged={refreshAll} onDisbanded={async text=>{closeDetail();await refreshAll(text);}}>
          <form className="stack" onSubmit={saveChannel}>
            <label className="field">小隊溝通頻道名稱<input key={`${detail.squad_id}-${detail.aggregate_version}`} name="communication_channel_name" defaultValue={detail.communication_channel_name} maxLength={100} placeholder="例如 LINE 頻道名稱"/></label>
            <p className="field-hint">所有會員都看得見；請勿填私人邀請連結。留空可移除。</p>
            <div className="actions"><button className="btn btn-ghost" disabled={busy}>儲存頻道名稱</button></div>
          </form>
        </SquadOwnerTools>
        :<>{detail.members.map(member=><div className="member-request" key={member.user_id}><span>{member.nickname} · {member.state==='active'?'已加入':'申請中'}</span></div>)}</>}
      {!isOwner&&(detail.membership?.state==='active'?<div className="actions"><button className="btn btn-ghost" disabled={busy} onClick={()=>void change(detail,'leave',detail.membership?.aggregate_version)}>退出這支小隊</button></div>
        :detail.membership?.state==='pending'?<p className="muted">等候隊主接受</p>:<div className="actions"><button className="btn btn-primary" disabled={busy} onClick={()=>void change(detail,'request',detail.membership?.aggregate_version)}>申請加入</button><p className="field-hint">隊長接受後，才能查看分享給小隊的聯絡方式。</p></div>)}
    </section>}
    {creating&&<div className="squad-start">
      <form className="card stack" onSubmit={create}>
        <div className="card-head"><h3>成立一支小隊</h3><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{setCreating(false);requestAnimationFrame(()=>createTrigger.current?.focus());}}>返回小隊列表</button></div>
        <label className="field">小隊名稱<input ref={nameInput} name="name" required maxLength={80}/></label>
        <label className="field">小隊類型<select name="kind">{kindOptions}</select></label>
        <label className="field">我們想一起完成什麼<textarea name="purpose" required maxLength={800} placeholder="寫下目標，以及想找哪些夥伴。"/></label>
        <label className="field">小隊溝通頻道名稱（選填）<input name="communication_channel_name" maxLength={100} placeholder="例如 LINE 頻道名稱"/></label>
        <p className="field-hint">所有會員都看得見；請勿填私人邀請連結。</p>
        <div className="actions"><button className="btn btn-primary" disabled={busy}>成立小隊</button></div>
      </form>
    </div>}
  </section>;
}
