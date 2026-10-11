import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import type {PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import {useModuleMutation} from './shared';
import './ContributionOutcomes.css';

export const contributionRoleLabels={proposal:'提案',design:'設計',implementation:'實作',testing:'測試與驗收',review:'審查',documentation:'文件',coordination:'協調',service:'服務交付'} as const;
type Role=keyof typeof contributionRoleLabels;
type RoleRecord={role_id:string;work_item_id:string;role:Role;state:'pending'|'confirmed'|'withdrawn';summary:string;evidence_ref:string;payload_sha256:string;aggregate_version:string;member_name:string;member_ref:string;is_self:boolean;can_confirm:boolean;confirmer_name:string|null;confirmed_at:string|null};
type RolePage={work_item_id:string;title:string;work_state:string;accepted_at:string|null;items:RoleRecord[];next_offset:number|null};
type Outcome={work_item_id:string;title:string;accepted_at:string;accepted_by_name:string;delivery_ref:string|null;roles:{role:Role;summary:string;evidence_ref:string;confirmer_name:string;confirmed_at:string}[]};
type OutcomePage={accepted_count:number;entries:Outcome[];next_offset:number|null};
const fail=(cause:unknown)=>cause instanceof Error?cause.message:'紀錄暫時無法載入。';

export function MemberContributionOutcomes({client,memberId,active=true,revision=0}:{client:PortalClient;memberId?:string;active?:boolean;revision?:number}){
  const [data,setData]=useState<OutcomePage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const mounted=useRef(true),sequence=useRef(0),controller=useRef<AbortController|null>(null);
  const path=memberId?`/members/${memberId}/contribution-outcomes`:'/me/contribution-outcomes';
  const load=useCallback(async(offset=0)=>{
    const current=++sequence.current,generation=client.sessionGeneration;
    controller.current?.abort();const next=new AbortController();controller.current=next;setLoading(true);setError('');
    try{const value=await client.get<OutcomePage>(`${path}?limit=10&offset=${offset}`,{signal:next.signal});
      if(mounted.current&&current===sequence.current&&generation===client.sessionGeneration)setData(previous=>({...value,entries:offset&&previous?[...previous.entries,...value.entries]:value.entries}));
    }catch(cause){if(!next.signal.aborted&&mounted.current&&current===sequence.current&&generation===client.sessionGeneration)setError(fail(cause));}
    finally{if(mounted.current&&current===sequence.current&&generation===client.sessionGeneration)setLoading(false);}
  },[client,path]);
  useEffect(()=>{mounted.current=true;setData(null);setError('');if(active)void load();return()=>{mounted.current=false;sequence.current++;controller.current?.abort();};},[active,load,revision]);
  return <section className="contribution-outcomes stack" aria-label={memberId?'夥伴的成果紀錄':'我的成果紀錄'}>
    <div className="contribution-heading"><h3>{memberId?'合作成果':'我的成果與角色'}</h3>{data&&<span className="badge">{data.accepted_count} 件已驗收工作</span>}<button className="btn btn-ghost" type="button" disabled={loading||!active} onClick={()=>void load()}>{loading?'更新中…':'更新成果'}</button></div>
    <p className="hint">每件工作只算一次。角色確認記錄實際分工，合作前可查看成果內容與確認人。</p>
    {loading&&!data&&<p role="status">正在讀取成果紀錄…</p>}
    {error&&<div role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>void load()}>重新讀取成果</button></div>}
    {data?.entries.map(entry=><article className="contribution-outcome" key={entry.work_item_id}><h4>{entry.title}</h4><p className="muted">工作由 {entry.accepted_by_name} 驗收 · {formatIsoLocal(entry.accepted_at)}</p>
      {entry.delivery_ref&&<p><span className="badge">交付者</span> <code>{entry.delivery_ref}</code></p>}
      {entry.roles.map(item=><div className="contribution-role-fact" key={item.role}><strong>{contributionRoleLabels[item.role]}</strong><p className="multiline-text">{item.summary}</p><small>{item.confirmer_name} 確認 · {formatIsoLocal(item.confirmed_at)} · <code>{item.evidence_ref}</code></small></div>)}
      <WorkContributionRoles client={client} workItemId={entry.work_item_id} onChanged={()=>void load()}/>
    </article>)}
    {data&&!data.entries.length&&<p className="empty">尚無已驗收合作紀錄。可以先分享專長與作品，或從一件適合的工作開始。</p>}
    {data?.next_offset!=null&&<button className="btn btn-ghost" type="button" disabled={loading} onClick={()=>void load(data.next_offset!)}>顯示更多成果</button>}
    {data&&<p className="hint">工作驗收與角色確認不代表官方認證、信用評等或履約保證。</p>}
  </section>;
}

export function WorkContributionRoles({client,workItemId,onChanged}:{client:PortalClient;workItemId:string;onChanged?:()=>void}){
  const [open,setOpen]=useState(false),[page,setPage]=useState<RolePage|null>(null),[loading,setLoading]=useState(false),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState('');
  const [role,setRole]=useState<Role>('proposal'),[summary,setSummary]=useState(''),[evidence,setEvidence]=useState(''),[share,setShare]=useState(false),[editing,setEditing]=useState<RoleRecord|null>(null),[confirming,setConfirming]=useState<string|null>(null);
  const {mutate,busy,error,setError}=useModuleMutation(client);
  const mounted=useRef(true),sequence=useRef(0),controller=useRef<AbortController|null>(null),form=useRef<HTMLFormElement>(null);
  const path=`/work-items/${workItemId}/contribution-roles`;
  const load=useCallback(async(offset=0)=>{
    const current=++sequence.current,generation=client.sessionGeneration;
    controller.current?.abort();const next=new AbortController();controller.current=next;setLoading(true);setLoadError('');
    try{const value=await client.get<RolePage>(`${path}?limit=20&offset=${offset}`,{signal:next.signal});
      if(mounted.current&&current===sequence.current&&generation===client.sessionGeneration)setPage(previous=>({...value,items:offset&&previous?[...previous.items,...value.items]:value.items}));
    }catch(cause){if(!next.signal.aborted&&mounted.current&&current===sequence.current&&generation===client.sessionGeneration)setLoadError(fail(cause));}
    finally{if(mounted.current&&current===sequence.current&&generation===client.sessionGeneration)setLoading(false);}
  },[client,path]);
  useEffect(()=>{mounted.current=true;setPage(null);setEditing(null);setConfirming(null);setSummary('');setEvidence('');setShare(false);setNotice('');setError(null);if(open)void load();return()=>{mounted.current=false;sequence.current++;controller.current?.abort();};},[client,workItemId]);
  useEffect(()=>{if(open)void load();},[open]);
  function edit(item:RoleRecord){setEditing(item);setRole(item.role);setSummary(item.summary);setEvidence(item.evidence_ref);setShare(false);setNotice('');setError(null);form.current?.scrollIntoView({block:'nearest'});form.current?.querySelector('textarea')?.focus({preventScroll:true});}
  function reset(){setEditing(null);setSummary('');setEvidence('');setShare(false);setError(null);}
  async function save(event:FormEvent){
    event.preventDefault();if(busy||!share)return;setNotice('');const generation=client.sessionGeneration;
    const payload={summary,evidence_ref:evidence,share_with_community:true};
    const result=await mutate(editing?`/contribution-roles/${editing.role_id}/edit`:path,editing?payload:{...payload,role},editing?.aggregate_version);
    if(result&&mounted.current&&generation===client.sessionGeneration){reset();setNotice('署名已保存，等待合作成員確認。');await load();onChanged?.();}
  }
  async function act(item:RoleRecord,action:'confirm'|'withdraw'){
    if(busy)return;setNotice('');const generation=client.sessionGeneration;
    const result=await mutate(`/contribution-roles/${item.role_id}/${action}`,action==='confirm'?{payload_sha256:item.payload_sha256}:{},item.aggregate_version);
    if(result&&mounted.current&&generation===client.sessionGeneration){setConfirming(null);if(editing?.role_id===item.role_id)reset();setNotice(action==='confirm'?'已確認這個版本的成果角色。':'署名已撤回，不再列入成果展示。');await load();onChanged?.();}
  }
  return <details className="work-contribution-roles" onToggle={event=>setOpen(event.currentTarget.open)}><summary>成果角色與署名</summary>{open&&<div className="stack">
    <div className="contribution-actions"><button className="btn btn-ghost" type="button" disabled={loading||busy} onClick={()=>void load()}>{loading?'更新中…':'更新署名'}</button></div>
    <p className="hint">提案、設計、測試、文件與服務都能留下署名。請填自己完成的部分；修改後需重新確認。</p>
    {page&&page.work_state!=='accepted'&&<p className="hint">這件工作尚未通過驗收，角色先保留為本人填寫。</p>}
    {loading&&!page&&<p role="status">正在讀取成果角色…</p>}
    {(loadError||error)&&<div role="alert"><p>{loadError||error}</p><button className="btn btn-ghost" type="button" disabled={loading||busy} onClick={()=>void load()}>重新讀取署名</button></div>}
    {notice&&<p role="status">{notice}</p>}
    {page?.items.map(item=><article className="contribution-role" key={item.role_id} aria-label={`${item.member_name}的${contributionRoleLabels[item.role]}署名`}>
      <div className="contribution-heading"><strong>{item.member_name} · {contributionRoleLabels[item.role]}</strong><span className="badge">{item.state==='confirmed'?'合作成員已確認':item.state==='withdrawn'?'已撤回':'本人填寫 · 待確認'}</span></div>
      {item.state!=='withdrawn'&&<><p className="multiline-text">{item.summary}</p><p className="hint">引用：<code>{item.evidence_ref}</code>{item.confirmed_at&&<> · {item.confirmer_name} 確認 · {formatIsoLocal(item.confirmed_at)}</>}</p></>}
      <div className="contribution-actions">{item.is_self&&<><button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>edit(item)}>{item.state==='withdrawn'?'重新提交署名':'修改署名'}</button>{item.state!=='withdrawn'&&<button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>void act(item,'withdraw')}>撤回署名</button>}</>}
        {item.can_confirm&&<button className="btn btn-secondary" type="button" disabled={busy} aria-expanded={confirming===item.role_id} onClick={()=>setConfirming(confirming===item.role_id?null:item.role_id)}>閱讀並確認</button>}
      </div>
      {confirming===item.role_id&&<div className="contribution-confirmation"><p>請核對以上內容與成果引用。你確認的是這位成員的{contributionRoleLabels[item.role]}分工，不代表官方認證。</p><div className="contribution-actions"><button className="btn btn-primary" type="button" disabled={busy} onClick={()=>void act(item,'confirm')}>確認這個版本的角色</button><button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>setConfirming(null)}>取消確認</button></div></div>}
    </article>)}
    {page&&!page.items.length&&<p className="empty">還沒有角色署名，可以從自己的參與開始填寫。</p>}
    {page?.next_offset!=null&&<button className="btn btn-ghost" type="button" disabled={loading||busy} onClick={()=>void load(page.next_offset!)}>顯示更多署名</button>}
    {page&&<form ref={form} className="stack contribution-role-form" onSubmit={event=>void save(event)}><h4>{editing?'修改我的署名':'留下我的成果角色'}</h4>
      <label className="field">我的角色<select value={role} disabled={busy||Boolean(editing)} onChange={event=>{const next=event.target.value as Role,existing=page.items.find(item=>item.is_self&&item.role===next);if(existing)edit(existing);else setRole(next);}}>{Object.entries(contributionRoleLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label className="field">我完成了什麼<textarea rows={3} required maxLength={1000} value={summary} disabled={busy} onChange={event=>setSummary(event.target.value)} placeholder="寫具體完成的工作與成果，例如：提出需求並完成手機版驗收。"/></label>
      <label className="field">成果引用<input required maxLength={232} value={evidence} disabled={busy} onChange={event=>setEvidence(event.target.value)} placeholder="例如 artifact:mobile-test-v1"/><span className="field-hint">使用成果代號，另行提供檔案；請勿填入私人資料或登入連結。</span></label>
      <label className="contribution-consent"><input type="checkbox" required checked={share} disabled={busy} onChange={event=>setShare(event.target.checked)}/><span>我同意把這份角色與摘要分享給本社群會員。</span></label>
      <div className="contribution-actions"><button type="submit" className="btn btn-primary" disabled={busy||loading||!share}>{busy?'保存中…':editing?'提交修改，重新確認':'保存角色署名'}</button>{editing&&<button className="btn btn-ghost" type="button" disabled={busy} onClick={reset}>取消修改</button>}</div>
    </form>}
  </div>}</details>;
}
