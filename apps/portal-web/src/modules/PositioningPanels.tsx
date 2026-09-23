import { useEffect,useState,type FormEvent } from 'react';
import { useModuleMutation,type ModulePanelProps } from './shared';
import type { TabId } from '../types';

type Profile={profile_id:string;aggregate_version:number;source:'self_declared';real_world_occupations:string[];background:string;strengths:string[];goals:string;weekly_minutes:number;desired_roles:string[];selected_tracks:string[];confirmed_at:string};
type Track={track_key:string;name:string;description:string;guild_key:string;guild_name:string;role_key:string;first_result:string;estimated_minutes:number};
type Recommendation={module_key:TabId;track_key:string;name:string;guild_key:string;guild_name:string;reason:string;first_result:string;estimated_minutes:number;time_note:string|null};
type View={profile:Profile|null;tracks:Track[];recommendations:Recommendation[]};
type Guild={guild_key:string;name:string;purpose:string;first_step:string;profession_key:string;track_count:number;membership:{membership_id:string;state:'active'|'left';rank:'runner';aggregate_version:number}|null};
const roles=[['supplier','供貨商'],['seller','銷售者'],['creator','作品作者'],['promoter','行銷推廣者'],['helper','專業協作者']] as const;
const words=(value:string)=>[...new Set(value.split(/[,，、\n]/).map(v=>v.trim()).filter(Boolean))];
function failure(error:unknown){return error instanceof Error?error.message:'暫時無法取得資料，請重試。';}

export function PositioningPanel({client,onNavigate}:ModulePanelProps) {
  const [view,setView]=useState<View|null>(null),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null);
  const [occupations,setOccupations]=useState(''),[background,setBackground]=useState(''),[strengths,setStrengths]=useState(''),[goals,setGoals]=useState(''),[minutes,setMinutes]=useState(120);
  const [selectedRoles,setSelectedRoles]=useState<string[]>([]),[tracks,setTracks]=useState<string[]>([]),[confirmed,setConfirmed]=useState(false),[saved,setSaved]=useState(false),[search,setSearch]=useState(''),[showAll,setShowAll]=useState(false);
  const {mutate,busy,error}=useModuleMutation(client);
  const fill=(data:View)=>{setView(data);if(data.profile){const p=data.profile;setOccupations(p.real_world_occupations.join('、'));setBackground(p.background);setStrengths(p.strengths.join('、'));setGoals(p.goals);setMinutes(p.weekly_minutes);setSelectedRoles(p.desired_roles);setTracks(p.selected_tracks);}setConfirmed(false);};
  async function load(){setLoading(true);setLoadError(null);try{fill(await client.get<View>('/me/positioning'));}catch(e){setLoadError(failure(e));}finally{setLoading(false);}}
  useEffect(()=>{void load();},[client]);
  async function submit(event:FormEvent){event.preventDefault();setSaved(false);const result=await mutate<Profile>('/me/positioning',{real_world_occupations:words(occupations),background,strengths:words(strengths),goals,weekly_minutes:minutes,desired_roles:selectedRoles,selected_tracks:tracks,confirmed},view?.profile?.aggregate_version);if(result){try{fill(await client.get<View>('/me/positioning'));setSaved(true);}catch(e){setLoadError('方向卡已保存；建議載入失敗，請重新整理。');}}}
  const toggle=(current:string[],key:string,set:(value:string[])=>void)=>set(current.includes(key)?current.filter(v=>v!==key):[...current,key]);
  const filteredTracks=view?.tracks.filter(t=>`${t.name} ${t.description} ${t.guild_name}`.includes(search))??[];
  const visibleTracks=search||showAll?filteredTracks:filteredTracks.filter((t,index)=>index<6||tracks.includes(t.track_key));
  return <section className="module-panel" aria-labelledby="positioning-title">
    <header className="section-heading"><p className="eyebrow">從你自己開始</p><h2 id="positioning-title">我的定位</h2><p>寫下你會什麼、想做什麼，再挑一個可以開始的方向。可以隨時修改，也可以直接使用其他模組。</p></header>
    {loading&&<p role="status">正在載入你的方向卡…</p>}
    {loadError&&<div role="alert">{loadError}<button type="button" onClick={()=>void load()}>重新載入方向卡</button></div>}
    {!loading&&view&&<><div className="card"><h3>我的方向卡</h3><p>{view.profile?`已保存第 ${view.profile.aggregate_version} 版 · 本人自述`:'還沒有方向卡。先用自己的話寫下目前想法。'}</p>
      <form onSubmit={submit} className="form-grid">
        <label className="field">現實職業／目前身分<input value={occupations} maxLength={800} onChange={e=>setOccupations(e.target.value)} placeholder="例如：餐飲業者、上班族、學生；可用頓號分隔"/></label>
        <label className="field">背景與手上的資源<textarea value={background} maxLength={1200} onChange={e=>setBackground(e.target.value)} placeholder="你做過什麼？有商品、設備、人脈或既有作品嗎？"/></label>
        <label className="field">我擅長的事<input value={strengths} maxLength={1200} onChange={e=>setStrengths(e.target.value)} placeholder="例如：攝影、溝通、整理資料；可用頓號分隔"/></label>
        <label className="field">我現在想完成的事<textarea required value={goals} maxLength={1000} onChange={e=>setGoals(e.target.value)} placeholder="例如：把自家茶葉整理成商品，找到第一位合作銷售者"/></label>
        <label className="field">每週可投入時間（分鐘）<input type="number" min={0} max={10080} required value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/><small>填 0 也可以，先瀏覽與收藏方向。</small></label>
        <fieldset className="fieldset"><legend>我想怎麼參與（可複選）</legend>{roles.map(([key,label])=><label className="checkbox-row" key={key}><input type="checkbox" checked={selectedRoles.includes(key)} onChange={()=>toggle(selectedRoles,key,setSelectedRoles)}/>{label}</label>)}</fieldset>
        <fieldset className="fieldset"><legend>想探索的職業方向（最多 3 個）</legend><p>方向是你的選擇；加入公會另由你確認。共有 {view.tracks.length} 個方向可探索。</p>
          <label className="field">搜尋職業方向<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="輸入食品、銷售、開源、剪輯…"/></label>
          <p>目前已選：{tracks.length?view.tracks.filter(t=>tracks.includes(t.track_key)).map(t=>t.name).join('、'):'尚未選擇，也可以先保存目標。'}</p>
          <div className="card-grid">{visibleTracks.map(t=><label className="card checkbox-card" key={t.track_key}><input type="checkbox" checked={tracks.includes(t.track_key)} disabled={!tracks.includes(t.track_key)&&tracks.length>=3} onChange={()=>toggle(tracks,t.track_key,setTracks)}/><strong>{t.name}</strong><span>{t.description}</span><small>{t.guild_name}</small></label>)}</div>
          {!search&&<button type="button" className="btn" onClick={()=>setShowAll(!showAll)}>{showAll?'收起完整清單':`查看全部 ${view.tracks.length} 個方向`}</button>}
          {search&&!filteredTracks.length&&<p>沒有符合的方向。你仍可在目標欄寫下自己的想法。</p>}
        </fieldset>
        <label className="checkbox-row"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>這些是我目前的想法，我確認保存</label>
        <div className="actions"><button type="submit" className="btn btn-primary" disabled={busy||!confirmed}>{busy?'保存中…':'保存我的方向卡'}</button><button type="button" onClick={()=>void load()} disabled={busy}>重新載入已保存內容</button></div>
        {error&&<p role="alert">{error}</p>}{saved&&<p role="status">方向卡已保存。你可以修改，也可以開始下面的小步。</p>}
      </form></div>
      <section className="card" aria-labelledby="positioning-next"><h3 id="positioning-next">適合先試的下一步</h3><p>依照你已保存的方向與角色整理；不判定能力，也不影響參與資格。</p>
        {!view.recommendations.length&&<p>保存角色或職業方向後，這裡會出現最多三個建議。</p>}
        <div className="card-grid">{view.recommendations.map(r=><article className="card" key={r.track_key}><h4>{r.name}</h4><p>{r.reason}</p><p>先完成：{r.first_result}</p><p>預估 {r.estimated_minutes} 分鐘 · {r.guild_name}</p>{r.time_note&&<p>{r.time_note}</p>}<div className="actions"><button type="button" className="btn btn-primary" onClick={()=>onNavigate?.(r.module_key)}>開始這個方向</button><button type="button" className="btn" onClick={()=>onNavigate?.('guilds')}>看看職業公會</button></div></article>)}</div>
      </section></>}
  </section>;
}

export function GuildsPanel({client}:ModulePanelProps) {
  const [guilds,setGuilds]=useState<Guild[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null),[notice,setNotice]=useState('');
  const {mutate,busy,error}=useModuleMutation(client);
  async function load(){setLoadError(null);try{setGuilds((await client.get<{items:Guild[]}>('/guilds')).items);}catch(e){setLoadError(failure(e));}finally{setLoading(false);}}
  useEffect(()=>{void load();},[client]);
  async function change(g:Guild){const joining=g.membership?.state!=='active';setNotice('');const result=await mutate(`/guilds/${g.guild_key}/${joining?'join':'leave'}`,{},g.membership?.aggregate_version);if(result){setNotice(joining?`已加入${g.name}，從 Runner 開始交流與實作。`:`已退出${g.name}。既有成果與其他公會關係保留。`);await load();}}
  return <section className="module-panel" aria-labelledby="guilds-title"><header className="section-heading"><p className="eyebrow">找到一起做事的人</p><h2 id="guilds-title">職業公會</h2><p>公會是長期的專業交流與學習空間。同時加入多個也可以；不用先完成定位測驗。</p></header>
    {loading&&<p role="status">正在載入職業公會…</p>}{loadError&&<div role="alert">{loadError}<button onClick={()=>void load()}>重新載入公會</button></div>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <div className="card-grid">{guilds.map(g=><article className="card" key={g.guild_key} aria-label={g.name}><div className="card-head"><h3>{g.name}</h3>{g.membership?.state==='active'&&<span className="badge">已加入 · Runner</span>}</div><p>{g.purpose}</p><p>可以先做：{g.first_step}</p><small>{g.track_count} 個職業方向 · 公開知識與共同學習免費</small><p className="field-hint">目前提供站內參與登記，公會主持與活動由實際參與者另行安排。</p><button type="button" disabled={busy} onClick={()=>void change(g)}>{g.membership?.state==='active'?'退出':'加入'}{g.name}</button></article>)}</div>
  </section>;
}
