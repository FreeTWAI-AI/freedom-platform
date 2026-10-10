import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {useModuleMutation} from './shared';

type Mutate=ReturnType<typeof useModuleMutation>['mutate'];
type Member={user_id:string;nickname:string;state:string;aggregate_version:number};
export type OwnedSquad={squad_id:string;name:string;purpose:string;aggregate_version:number;members:Member[]};
type Pending={kind:'remove';member:Member}|{kind:'transfer';member:Member}|{kind:'disband'};

const copy={
  remove:(member:Member)=>({title:`移除 ${member.nickname}？`,body:'對方會收到站內通知，之後仍可再次申請加入。',confirm:'確定移除'}),
  transfer:(member:Member)=>({title:`把小隊交給 ${member.nickname}？`,body:'轉移後你成為一般成員，只有新隊主能管理成員與邀請；你送出的待回覆邀請會一併撤回。',confirm:'確定轉移'}),
  disband:()=>({title:'解散這支小隊？',body:'所有成員會退出、小隊頻道停止使用，待回覆的邀請全部撤回。這個動作無法復原。',confirm:'確定解散'}),
};

/** Owner-only controls: member decisions, profile edits, transfer and disband through one site dialog. */
export function SquadOwnerTools({squad,selfId,mutate,busy,onChanged,onDisbanded}:{squad:OwnedSquad;selfId:string;mutate:Mutate;busy:boolean;onChanged:(notice:string)=>Promise<void>;onDisbanded:(notice:string)=>Promise<void>}){
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLElement|null>(null),id=useId();
  const [pending,setPending]=useState<Pending|null>(null),[heir,setHeir]=useState('');
  const others=squad.members.filter(member=>member.state==='active'&&member.user_id!==selfId);
  useEffect(()=>{const element=dialog.current;if(!element)return;if(pending&&!element.open)element.showModal();else if(!pending&&element.open)element.close();},[pending]);
  useEffect(()=>{if(!others.some(member=>member.user_id===heir))setHeir('');},[squad]);
  function ask(next:Pending,from:HTMLElement){trigger.current=from;setPending(next);}
  function close(){setPending(null);trigger.current?.focus();trigger.current=null;}
  async function confirm(){
    if(!pending)return;
    const action=pending;
    const result=action.kind==='remove'?await mutate(`/squads/${squad.squad_id}/members/${action.member.user_id}/remove`,{},action.member.aggregate_version)
      :action.kind==='transfer'?await mutate(`/squads/${squad.squad_id}/transfer`,{user_id:action.member.user_id},squad.aggregate_version)
      :await mutate(`/squads/${squad.squad_id}/disband`,{},squad.aggregate_version);
    // Close either way: a failure shows in the panel status and the refresh brings current versions.
    close();
    if(!result){await onChanged('');return;}
    if(action.kind==='disband')await onDisbanded(`小隊「${squad.name}」已解散。`);
    else await onChanged(action.kind==='remove'?`已將 ${action.member.nickname} 移出小隊。`:`小隊已交給 ${action.member.nickname}。`);
  }
  async function accept(member:Member){const result=await mutate(`/squads/${squad.squad_id}/members/${member.user_id}/accept`,{},member.aggregate_version);if(result)await onChanged('已接受加入申請。');}
  async function decline(member:Member){const result=await mutate(`/squads/${squad.squad_id}/members/${member.user_id}/decline`,{},member.aggregate_version);if(result)await onChanged(`已婉拒 ${member.nickname} 的加入申請。`);}
  async function saveProfile(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const data=new FormData(event.currentTarget);
    const result=await mutate(`/squads/${squad.squad_id}/profile`,{name:data.get('name'),purpose:data.get('purpose')},squad.aggregate_version);
    if(result)await onChanged('小隊名稱與目標已更新。');
  }
  const text=pending?pending.kind==='disband'?copy.disband():copy[pending.kind](pending.member):null;
  return <div className="stack squad-owner-tools">
    {squad.members.map(member=><div className="member-request" key={member.user_id}>
      <span>{member.nickname} · {member.user_id===selfId?'你（隊主）':member.state==='active'?'已加入':'申請中'}</span>
      {member.state==='pending'&&<><button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void accept(member)}>接受加入</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void decline(member)}>婉拒</button></>}
      {member.state==='active'&&member.user_id!==selfId&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={event=>ask({kind:'remove',member},event.currentTarget)}>移除</button>}
    </div>)}
    <details className="squad-manage">
      <summary>管理小隊</summary>
      <form className="stack" onSubmit={event=>void saveProfile(event)}>
        <label className="field">小隊名稱<input key={`name-${squad.aggregate_version}`} name="name" required maxLength={80} defaultValue={squad.name}/></label>
        <label className="field">我們想一起完成什麼<textarea key={`purpose-${squad.aggregate_version}`} name="purpose" required maxLength={800} defaultValue={squad.purpose}/></label>
        <div className="actions"><button className="btn btn-ghost" disabled={busy}>儲存名稱與目標</button></div>
      </form>
      <div className="stack">
        <label className="field">轉移隊主給<select value={heir} disabled={busy||!others.length} onChange={event=>setHeir(event.target.value)}><option value="">{others.length?'選擇一位成員':'目前沒有其他成員'}</option>{others.map(member=><option key={member.user_id} value={member.user_id}>{member.nickname}</option>)}</select></label>
        <p className="field-hint">隊主要先轉移或解散，才能離開自己建立的小隊。</p>
        <div className="actions">
          <button type="button" className="btn btn-ghost" disabled={busy||!heir} onClick={event=>{const member=others.find(item=>item.user_id===heir);if(member)ask({kind:'transfer',member},event.currentTarget);}}>轉移隊主</button>
          <button type="button" className="btn btn-ghost squad-disband" disabled={busy} onClick={event=>ask({kind:'disband'},event.currentTarget)}>解散小隊</button>
        </div>
      </div>
    </details>
    <dialog ref={dialog} className="squad-confirm-dialog" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();if(!busy)close();}}>
      {text&&<div className="stack">
        <h3 id={`${id}-title`}>{text.title}</h3>
        <p>{text.body}</p>
        <div className="squad-confirm-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>取消</button><button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={()=>void confirm()}>{text.confirm}</button></div>
      </div>}
    </dialog>
  </div>;
}
