import {useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {useModuleMutation} from './shared';

type Outcome='gained'|'partly_gained'|'not_gained'|'unconfirmed';
type Effort={platform_maintenance:number|null;coordination_friction:number|null;collaborative_value:number|null;paid_delivery:number|null};
type Observation={observation_id:string;report:{outcome:Outcome;actual_gain:string|null;evidence_refs:string[];would_participate_again:boolean|null;effort_minutes:Effort|null}};
type BenefitView={work_item_ref:string;aggregate_version:number;role:'beneficiary'|'contributor';work_claim_ref:string|null;can_report:boolean;own_observation:Observation|null;summary:{participants:number;reported:number;outcomes:{not_reported:number};both_participants_reported_gained:boolean}};

// One optional, lazy-loaded block. The API determines the current participant
// role; a card or browser-supplied user ID never confers reporting authority.
export function BenefitObservations({client,workItemId}:{client:PortalClient;workItemId:string}){
 const {mutate,busy,error,setError}=useModuleMutation(client);
 const [view,setView]=useState<BenefitView|null>(null),[loading,setLoading]=useState(false),[notice,setNotice]=useState('');
 const [outcome,setOutcome]=useState<Outcome>('unconfirmed'),[gain,setGain]=useState(''),[again,setAgain]=useState('unknown'),[minutes,setMinutes]=useState('');
 const fetching=useRef(false),path=`/work-items/${workItemId}/benefit-observations`;
 async function load(){
  if(fetching.current)return;fetching.current=true;setLoading(true);setError(null);
  try{
   const value=await client.get<BenefitView>(path);setView(value);const report=value.own_observation?.report;
   setOutcome(report?.outcome??'unconfirmed');setGain(report?.actual_gain??'');setAgain(report?.would_participate_again===true?'yes':report?.would_participate_again===false?'no':'unknown');
   setMinutes(report?.effort_minutes?.collaborative_value==null?'':String(report.effort_minutes.collaborative_value));
  }catch(cause){setError(cause instanceof Error?cause.message:'回報資料暫時無法讀取。');}
  finally{fetching.current=false;setLoading(false);}
 }
 async function save(event:React.FormEvent){
  event.preventDefault();if(!view||busy||loading)return;setNotice('');
  const parsed=minutes.trim()===''?null:Number(minutes);
  if(parsed!==null&&(!Number.isSafeInteger(parsed)||parsed<0)){setError('投入時間請填零或正整數，或留白。');return;}
  const prior=view.own_observation?.report;
  const effort=prior?.effort_minutes??{platform_maintenance:null,coordination_friction:null,collaborative_value:null,paid_delivery:null};
  const nextEffort={...effort,collaborative_value:parsed};
  const result=await mutate<Observation>(path,{role:view.role,work_claim_ref:view.work_claim_ref,outcome,actual_gain:gain.trim()||null,
   evidence_refs:prior?.evidence_refs??[],would_participate_again:again==='unknown'?null:again==='yes',
   effort_minutes:Object.values(nextEffort).every(value=>value===null)?null:nextEffort,supersedes_observation_ref:view.own_observation?.observation_id??null},view.aggregate_version);
  if(result){setNotice('已保存你的回報。修改會保留先前紀錄，不改變成果驗收。');await load();}
 }
 return <details className="benefit-observation" onToggle={event=>{if(event.currentTarget.open&&!view&&!loading)void load();}}>
  <summary>這次合作帶給我什麼（選填）</summary>
  <div className="stack">
   <p className="hint">可以略過，不影響成果或會員資格。內容只給你自己看，其他當事人只看到整體回報狀態。</p>
   {loading&&<p role="status">正在讀取你的回報…</p>}
   {error&&<p role="alert">{error}</p>}
   {notice&&<p role="status">{notice}</p>}
   {view&&<p className="muted">已收到 {view.summary.reported}／{view.summary.participants} 位參與者的自願回報；{view.summary.outcomes.not_reported} 位尚未回報。回報是本人經驗，不代表收款或第三方驗證。</p>}
   {view&&!view.can_report&&<p className="hint">開始參與這次合作之後，就能在這裡留下實際經驗。</p>}
   {view?.can_report&&<form className="stack" onSubmit={event=>void save(event)}>
    <label>這次有得到預期的幫助嗎？<select value={outcome} onChange={event=>setOutcome(event.target.value as Outcome)} disabled={busy}>
     <option value="unconfirmed">還不確定</option><option value="gained">有得到</option><option value="partly_gained">部分得到</option><option value="not_gained">沒有得到</option>
    </select></label>
    <label>{outcome==='gained'||outcome==='partly_gained'?'具體得到了什麼？':'想補充的經驗（選填）'}<textarea maxLength={1000} required={outcome==='gained'||outcome==='partly_gained'} value={gain} onChange={event=>setGain(event.target.value)} disabled={busy} placeholder="例如：能自己完成這個流程，或還有哪裡不符合需求。"/></label>
    <details><summary>補充投入與再參與意願（選填）</summary><div className="stack">
     <label>這次解題、創作或測試，大約投入幾分鐘？<input type="number" min="0" step="1" value={minutes} onChange={event=>setMinutes(event.target.value)} disabled={busy} placeholder="不確定可留白"/></label>
     <label>之後有類似合作，願意再參與嗎？<select value={again} onChange={event=>setAgain(event.target.value)} disabled={busy}><option value="unknown">還不確定／略過</option><option value="yes">願意</option><option value="no">目前不想</option></select></label>
    </div></details>
    <button className="btn btn-primary" disabled={busy||loading} type="submit">{busy?'保存中…':view.own_observation?'更新我的回報':'保存我的回報'}</button>
   </form>}
   {(error||view?.own_observation)&&<button className="btn btn-secondary" type="button" disabled={busy||loading} onClick={()=>void load()}>重新讀取已保存的回報</button>}
  </div>
 </details>;
}
