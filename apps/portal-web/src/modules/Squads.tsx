import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useModuleMutation,type ModulePanelProps} from './shared';
import {Status} from './Membership';
import {ModuleBanner} from './ModuleBanner';
import './ModuleDiscovery.css';
type Squad={squad_id:string;name:string;kind:'project'|'mutual_help';purpose:string;owner_ref:string;owner_name:string;member_count:number;membership:null|{state:string;aggregate_version:number}};
type SquadDetail=Squad&{members:{user_id:string;nickname:string;state:string;aggregate_version:number}[]};
const kindLabels={project:'專案小隊',mutual_help:'共同目標互助小隊'};
export function SquadsPanel({client,session}:ModulePanelProps){
  const [squads,setSquads]=useState<Squad[]>([]),[detail,setDetail]=useState<SquadDetail|null>(null),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true),[nextOffset,setNextOffset]=useState<number|null>(null);
  const [query,setQuery]=useState(''),[kind,setKind]=useState<'all'|Squad['kind']>('all'),[failedOffset,setFailedOffset]=useState(0),[detailError,setDetailError]=useState('');
  const nameInput=useRef<HTMLInputElement>(null),detailHeading=useRef<HTMLHeadingElement>(null),detailTrigger=useRef<HTMLElement|null>(null);
  const {mutate,busy,error}=useModuleMutation(client);
  async function load(offset=0){setLoading(true);setLoadError('');setFailedOffset(offset);try{const data=await client.get<{items:Squad[];next_offset:number|null}>(`/squads?limit=20&offset=${offset}`);setSquads(current=>offset?[...current,...data.items]:data.items);setNextOffset(data.next_offset);}catch(e){setLoadError(e instanceof Error?e.message:'無法載入小隊。');}finally{setLoading(false);}}
  async function open(id:string,trigger?:HTMLElement){setDetailError('');if(trigger)detailTrigger.current=trigger;try{const data=await client.get<SquadDetail>(`/squads/${id}`);const own=data.members.find(member=>member.user_id===session.user.user_id);setDetail({...data,membership:own?{state:own.state,aggregate_version:own.aggregate_version}:null});if(trigger)requestAnimationFrame(()=>detailHeading.current?.focus());}catch(e){setDetailError(e instanceof Error?e.message:'無法載入小隊。');}}
  useEffect(()=>{void load();},[client]);
  function closeDetail(){setDetail(null);detailTrigger.current?.focus();}
  async function create(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget,d=new FormData(form);const result=await mutate<Squad>('/squads',{name:d.get('name'),kind:d.get('kind'),purpose:d.get('purpose')});if(result){form.reset();setNotice('小隊已成立。夥伴可以提出加入申請。');setQuery('');setKind('all');await load();await open(result.squad_id,nameInput.current??undefined);}}
  async function change(squad:Squad,action:string,version?:number){const result=await mutate(`/squads/${squad.squad_id}/${action}`,{},version);if(result){setNotice(action==='request'?'加入申請已送出，等待隊主接受。':'小隊資料已更新。');await load();if(detail?.squad_id===squad.squad_id)await open(squad.squad_id);}}
  const search=query.trim().toLocaleLowerCase();
  const visibleSquads=squads.filter(squad=>(kind==='all'||squad.kind===kind)&&(!search||[squad.name,squad.purpose,squad.owner_name].join(' ').toLocaleLowerCase().includes(search)));
  const filtered=Boolean(search||kind!=='all');
  return <section className="module-panel squad-panel">
    <ModuleBanner eyebrow="BUILD SOMETHING TOGETHER" title="加入或成立小隊" description="" art="/art/rpg/cooperation-forge.webp"><div className="actions"><button className="btn btn-primary" onClick={()=>nameInput.current?.focus()}>成立一支小隊</button></div></ModuleBanner>
    <Status error={loadError||detailError||error} notice={notice}/>
    <section className="squad-directory" aria-labelledby="squad-directory-heading">
      <h3 id="squad-directory-heading">尋找小隊</h3>
      <p className="field-hint">申請加入後，需由隊主接受。接受前，看不到只分享給小隊夥伴的聯絡方式。</p>
      <div className="discovery-toolbar"><label className="field discovery-search">搜尋小隊<input type="search" value={query} maxLength={150} onChange={event=>setQuery(event.target.value)} placeholder="小隊名稱、目標或隊主"/></label><label className="field">篩選小隊類型<select value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="all">全部類型</option><option value="project">專案小隊</option><option value="mutual_help">共同目標互助小隊</option></select></label></div>
      <div className="discovery-feedback">{squads.length>0&&<p role="status">顯示 {visibleSquads.length} / {squads.length} 支小隊</p>}{filtered&&<button className="btn btn-ghost" onClick={()=>{setQuery('');setKind('all');}}>清除小隊篩選</button>}</div>
      {nextOffset!==null&&<p className="field-hint">目前只篩選已載入的小隊。載入更多，可繼續找夥伴。</p>}
      <div className="card-grid">{visibleSquads.map(squad=><article className="card stack expedition-squad" key={squad.squad_id}>
        <span className="eyebrow">{kindLabels[squad.kind]}</span><h3>{squad.name}</h3><p>{squad.purpose}</p><p className="muted squad-meta"><span>隊主：{squad.owner_name}</span><span>{squad.member_count} 位夥伴</span></p>
        <div className="actions"><button className="btn btn-ghost" aria-label={`查看小隊：${squad.name}`} onClick={event=>void open(squad.squad_id,event.currentTarget)}>查看小隊</button>{squad.membership?.state==='active'?<span className="badge">已加入</span>:squad.membership?.state==='pending'?<span className="muted">等候隊主接受</span>:<button className="btn btn-primary" disabled={busy} onClick={()=>void change(squad,'request',squad.membership?.aggregate_version)}>申請加入</button>}</div>
      </article>)}</div>
      {loading&&<p role="status">正在載入小隊…</p>}
      {!loading&&!loadError&&!visibleSquads.length&&<div className="discovery-empty"><h4>{filtered?'沒有符合條件的小隊':'還沒有小隊'}</h4>{!filtered&&<p className="field-hint">可以在下方成立第一支。</p>}</div>}
      {loadError&&<button className="btn btn-ghost" disabled={loading} onClick={()=>void load(failedOffset)}>重新載入小隊</button>}
      {nextOffset!==null&&<button className="btn btn-ghost" disabled={loading} onClick={()=>void load(nextOffset)}>查看更多小隊</button>}
    </section>
    {detail&&<section className="card stack expedition-squad-detail" aria-label="小隊詳情"><div className="card-head"><h3 ref={detailHeading} tabIndex={-1}>{detail.name}的夥伴</h3><button className="btn btn-ghost" onClick={closeDetail}>收起</button></div>{detail.members.map(member=><div className="member-request" key={member.user_id}><span>{member.nickname} · {member.state==='active'?'已加入':'申請中'}</span>{member.state==='pending'&&detail.owner_ref===session.user.user_id&&<button className="btn btn-primary" disabled={busy} onClick={async()=>{const result=await mutate(`/squads/${detail.squad_id}/members/${member.user_id}/accept`,{},member.aggregate_version);if(result){await load();await open(detail.squad_id);}}}>接受加入</button>}</div>)}{detail.membership?.state==='active'&&detail.owner_ref!==session.user.user_id&&<button className="btn btn-ghost" disabled={busy} onClick={()=>void change(detail,'leave',detail.membership?.aggregate_version)}>退出這支小隊</button>}</section>}
    <div className="squad-start">
      <form className="card stack" onSubmit={create}><h3>成立一支小隊</h3><label className="field">小隊名稱<input ref={nameInput} name="name" required maxLength={80}/></label><label className="field">小隊類型<select name="kind"><option value="project">專案小隊</option><option value="mutual_help">共同目標互助小隊</option></select></label><label className="field">我們想一起完成什麼<textarea name="purpose" required maxLength={800} placeholder="寫下目標，以及想找哪些夥伴。"/></label><button className="btn btn-primary" disabled={busy}>成立小隊</button></form>
    </div>
  </section>;
}
