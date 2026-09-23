import {refreshSkillDiscovery,useSkillDiscovery} from './skill-discovery-client';
import './SkillDiscovery.css';

export type SkillDiscoveryView='all'|'official'|'today'|'week'|'month';
const views:{key:SkillDiscoveryView;label:string}[]=[{key:'all',label:'全部技能'},{key:'official',label:'官方公會技能'},{key:'today',label:'每日新技能'},{key:'week',label:'工坊週榜'},{key:'month',label:'工坊月榜'}];
export function SkillDiscoveryFilters({value,onChange}:{value:SkillDiscoveryView;onChange:(value:SkillDiscoveryView)=>void}){
  const {data,error,loading}=useSkillDiscovery();
  return <div className="skill-discovery"><div className="skill-discovery-tabs" role="group" aria-label="技能書榜單與徽章">{views.map(view=><button type="button" key={view.key} className={`btn btn-ghost${value===view.key?' is-selected':''}`} aria-pressed={value===view.key} onClick={()=>onChange(view.key)}>{view.label}</button>)}</div>
    {error?<div className="skill-discovery-error" role="alert"><span>{error}</span><button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>void refreshSkillDiscovery(true)}>{loading?'正在重試…':'重讀徽章與榜單'}</button></div>:loading&&!data?<p className="field-hint">正在載入徽章與榜單…</p>:null}
    {value==='official'&&<p className="field-hint">自由工坊公會指定技能；不代表原作者背書。</p>}
    {value==='today'&&<p className="field-hint">今天首次收錄於工坊的技能書，以台北時間計算。</p>}
    {(value==='week'||value==='month')&&<p className="field-hint">{value==='week'?'近 7 天':'近 30 天'}透過工坊 Star 的 GitHub 人數，取消後不計入。不是 GitHub 總星數。{data&&!error&&<> 更新：<time dateTime={data.as_of}>{new Date(data.as_of).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>（台北時間）。</>}</p>}
  </div>;
}
