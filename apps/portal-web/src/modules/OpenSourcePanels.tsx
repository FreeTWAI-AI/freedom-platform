import { ModuleBanner } from './ModuleBanner';
import { useCallback,useEffect,useState,type FormEvent } from 'react';
import { requireItems } from '../api';
import { RepositoryLibrary } from './Community';
import { useModuleMutation,type ModulePanelProps } from './shared';

type SourceVersion={version_id:string;commit_sha:string;license_spdx:string;license_evidence_url:string|null;is_fork:boolean;archived:boolean;readme_url:string;inspected_at:string};
type Project={project_id:string;owner_ref:string;owner_name:string;title:string;description:string;use_notes:string;demo_url:string|null;repository_url:string;repository_full_name:string;repository_id:string;relationship:string;aggregate_version:number;current_version:SourceVersion};
type Campaign={campaign_id:string;title:string;audience:string;goal:string;draft_text:string;aggregate_version:number;source_snapshot:{kind:string;title?:string;brief?:string;commit_sha?:string;license_spdx?:string;repository_url?:string;source_version?:string;currency?:string;net_price_minor?:string};shares:{share_id:string;channel:string;share_url:string;note:string;verification_status:string}[]};
type SupplierProduct={product_id:string;title:string;current_offer:{revision:number}};
const relationshipLabels:Record<string,string>={author:'原作者',maintainer:'維護者',contributor:'貢獻者',curator:'推薦／整理者'};
const blankProject={repository_url:'',title:'',description:'',use_notes:'',demo_url:'',relationship:'curator',consent_to_share:false};

function SafeLink({href,children}:{href:string;children:React.ReactNode}) {
  return <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children} ↗</a>;
}
function LoadError({error,retry}:{error:string|null;retry:()=>void}) {
  return error?<div className="banner banner-error" role="alert">{error} <button className="btn btn-ghost" type="button" onClick={retry}>重新載入</button></div>:null;
}

export function OpenSourcePanel({client,session,onNavigate}:ModulePanelProps) {
  const [projects,setProjects]=useState<Project[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null);
  const [draft,setDraft]=useState({...blankProject}),[notice,setNotice]=useState<string|null>(null);
  const {mutate,busy,error}=useModuleMutation(client);
  const refresh=useCallback(async()=>{
    setLoading(true);setLoadError(null);
    try{setProjects(requireItems<Project>(await client.get('/opensource/projects'),'開源作品'));}
    catch(cause){setLoadError(cause instanceof Error?cause.message:'無法載入開源作品。');}
    finally{setLoading(false);}
  },[client]);
  useEffect(()=>{void refresh();},[refresh]);
  async function submit(event:FormEvent){
    event.preventDefault();setNotice(null);
    const saved=await mutate<Project>('/opensource/projects',{...draft,demo_url:draft.demo_url.trim()||null});
    if(saved){setDraft({...blankProject});setNotice('作品已登錄。你填寫的來源關係會清楚標示為自行聲明。');await refresh();}
  }
  return <div className="stack">
    <ModuleBanner eyebrow="OPEN SOURCE / 分享程式，累積使用與協作" title="讓作品被找到，也讓別人知道怎麼開始" description="貼上公開 GitHub 專案、說明用途與使用方式。會員可以直接看文件、使用與參與開發。" art="/art/rpg/skill-codex.webp"><div className="actions"><button className="btn btn-primary" type="button" onClick={()=>onNavigate?.('cocreation')}>一起開發這些作品</button></div></ModuleBanner>
    <details className="card"><summary>作品怎麼成為技能書？</summary><div className="stack"><p>原始公開 Repo 由作者保留，工坊可以 Fork 保存與後續改造；原作者、來源與授權會保留。</p><p>請準備一個專案介紹頁（建議 GitHub Pages），寫清楚用途、畫面、如何開始與原始碼連結，方便大家理解你的作品。</p><a href="https://github.com/FreeTWAI-AI/freedom-project-page" target="_blank" rel="noopener noreferrer">使用專案介紹頁模板 ↗</a></div></details>
    <RepositoryLibrary client={client} title="工坊精選作品"/>
    {notice&&<p role="status" className="banner banner-info">{notice}</p>}
    {error&&<p role="alert" className="banner banner-error">{error}</p>}
    <LoadError error={loadError} retry={()=>void refresh()}/>
    <div className="card-grid">
      <section className="card"><div className="section-head"><h2>登錄開源作品</h2><p>先從一件可以分享的作品開始。這不會替你修改 GitHub 或執行程式。</p></div>
        <form className="stack" onSubmit={submit}>
          <label className="field">GitHub 儲存庫網址<input required type="url" maxLength={300} placeholder="https://github.com/owner/repository" value={draft.repository_url} onChange={e=>setDraft({...draft,repository_url:e.target.value})}/></label>
          <label className="field">作品名稱<input required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
          <label className="field">這個作品可以做什麼<textarea required maxLength={2000} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label>
          <label className="field">如何開始使用<textarea required maxLength={3000} placeholder="適合誰、需要什麼，以及第一個使用步驟。" value={draft.use_notes} onChange={e=>setDraft({...draft,use_notes:e.target.value})}/></label>
          <label className="field">展示網址（選填）<input type="url" maxLength={2000} placeholder="https://…" value={draft.demo_url} onChange={e=>setDraft({...draft,demo_url:e.target.value})}/></label>
          <label className="field">我與作品的關係<select value={draft.relationship} onChange={e=>setDraft({...draft,relationship:e.target.value})}>{Object.entries(relationshipLabels).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select><span className="field-hint">自行聲明；平台目前尚未驗證你的 GitHub 身分。</span></label>
          <label className="choice"><input type="checkbox" required checked={draft.consent_to_share} onChange={e=>setDraft({...draft,consent_to_share:e.target.checked})}/>我同意讓社群會員看見作品介紹與來源關係</label>
          <button className="btn btn-primary" disabled={busy}>{busy?'正在讀取公開版本…':'從 GitHub 登錄'}</button>
        </form>
      </section>
      <section className="stack" aria-label="社群開源作品"><div className="section-head"><h2>社群開源作品</h2><p>已登錄 {projects.length} 件 · 自由探索，不必先談商務合作</p></div>
        {loading&&<p role="status">正在載入作品…</p>}
        {!loading&&!loadError&&projects.length===0&&<div className="card empty"><h3>第一件作品，從你開始</h3><p>登錄後會顯示使用說明、授權與固定版本，方便其他會員試用和參與。</p></div>}
        {projects.map(project=><ProjectCard key={project.project_id} project={project} own={project.owner_ref===session.user.user_id} client={client} session={session} reload={refresh} onNavigate={onNavigate}/>)}
      </section>
    </div>
  </div>;
}

function ProjectCard({project,own,client,reload,onNavigate}:ModulePanelProps & {project:Project;own:boolean;reload:()=>Promise<void>}) {
  const {mutate,busy,error}=useModuleMutation(client),[editing,setEditing]=useState(false),[notice,setNotice]=useState<string|null>(null);
  const [draft,setDraft]=useState({title:project.title,description:project.description,use_notes:project.use_notes,demo_url:project.demo_url??''});
  async function refreshVersion(){const result=await mutate(`/opensource/projects/${project.project_id}:refresh`,{},project.aggregate_version);if(result){setNotice('已重新查詢 GitHub；行銷草稿保留建立時的版本。');await reload();}}
  async function revise(event:FormEvent){event.preventDefault();const result=await mutate(`/opensource/projects/${project.project_id}:revise`,{...draft,demo_url:draft.demo_url.trim()||null},project.aggregate_version);if(result){setEditing(false);setNotice('使用說明已更新。');await reload();}}
  return <article className="card stack" aria-label={`開源作品：${project.title}`}>
    <div className="card-head"><div><p className="module-kicker">{project.repository_full_name}</p><h3>{project.title}</h3></div><span className="pill">社群候選作品</span></div>
    <p>{project.description}</p><div className="help-box"><strong>如何開始</strong><p>{project.use_notes}</p></div>
    <dl className="meta"><div><dt>登錄者</dt><dd>{project.owner_name} · {relationshipLabels[project.relationship]}（自行聲明）</dd></div><div><dt>授權</dt><dd>{project.current_version.license_spdx==='NOASSERTION'?'尚未確認，請先閱讀原始授權':project.current_version.license_spdx}</dd></div><div><dt>固定版本</dt><dd><code>{project.current_version.commit_sha.slice(0,12)}</code> · {project.current_version.is_fork?'衍生儲存庫':'原始儲存庫'}{project.current_version.archived?' · 已封存':''}</dd></div></dl>
    <div className="actions"><SafeLink href={project.current_version.readme_url}>閱讀文件／開始使用</SafeLink><SafeLink href={`${project.repository_url}/issues`}>參與討論</SafeLink>{project.demo_url&&<SafeLink href={project.demo_url}>開啟展示</SafeLink>}{project.current_version.license_evidence_url&&<SafeLink href={project.current_version.license_evidence_url}>查看授權</SafeLink>}</div>
    <p className="hint">來源與版本已讀取；尚未進行作品品質審核。</p>
    {error&&<p role="alert" className="banner banner-error">{error}</p>}{notice&&<p role="status" className="status-note">{notice}</p>}
    {own&&<div className="actions"><button className="btn btn-ghost" disabled={busy} onClick={()=>void refreshVersion()}>更新 GitHub 版本</button><button className="btn btn-ghost" disabled={busy} onClick={()=>{setDraft({title:project.title,description:project.description,use_notes:project.use_notes,demo_url:project.demo_url??''});setEditing(!editing);}}>編輯作品介紹</button>{onNavigate&&<button className="btn btn-ghost" onClick={()=>onNavigate('marketing')}>為作品準備行銷</button>}</div>}
    {editing&&<form className="stack" onSubmit={revise}><label className="field">作品名稱<input required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label><label className="field">這個作品可以做什麼<textarea required maxLength={2000} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label><label className="field">如何開始使用<textarea required maxLength={3000} value={draft.use_notes} onChange={e=>setDraft({...draft,use_notes:e.target.value})}/></label><label className="field">展示網址（選填）<input type="url" value={draft.demo_url} onChange={e=>setDraft({...draft,demo_url:e.target.value})}/></label><button className="btn btn-primary" disabled={busy}>儲存作品介紹</button></form>}
  </article>;
}

const blankCampaign={title:'',audience:'',goal:'',draft_text:'',source_selection:'',source_brief:''};
export function MarketingPanel({client,session}:ModulePanelProps) {
  const [campaigns,setCampaigns]=useState<Campaign[]>([]),[projects,setProjects]=useState<Project[]>([]),[draft,setDraft]=useState({...blankCampaign});
  const [products,setProducts]=useState<SupplierProduct[]>([]);
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const {mutate,busy,error}=useModuleMutation(client);
  const refresh=useCallback(async()=>{setLoading(true);setLoadError(null);try{const [campaignData,projectData,productData]=await Promise.all([client.get('/marketing/campaigns'),client.get('/opensource/projects'),client.get('/supplier/products')]);setCampaigns(requireItems<Campaign>(campaignData,'行銷草稿'));setProjects(requireItems<Project>(projectData,'開源作品').filter(p=>p.owner_ref===session.user.user_id));setProducts(requireItems<SupplierProduct>(productData,'供貨商品'));}catch(cause){setLoadError(cause instanceof Error?cause.message:'無法載入行銷工作室。');}finally{setLoading(false);}},[client,session.user.user_id]);
  useEffect(()=>{void refresh();},[refresh]);
  async function create(event:FormEvent){event.preventDefault();setNotice(null);const {source_selection,...content}=draft;const [kind,sourceId]=source_selection.split(':');const saved=await mutate('/marketing/campaigns',{...content,source_project_id:kind==='oss'?sourceId:null,source_supplier_product_id:kind==='supplier'?sourceId:null,source_brief:source_selection?'':draft.source_brief});if(saved){setDraft({...blankCampaign});setNotice('私人草稿已儲存，可以繼續編輯或自行分享。');await refresh();}}
  return <div className="stack"><ModuleBanner eyebrow="MARKETING / 從真實作品與商品，說出清楚的價值" title="先準備好，再把值得分享的內容帶出去" description="選自己的作品、供貨商品或寫一份活動簡述，整理受眾、目標和文案。草稿只有你看得到。" art="/art/rpg/cooperation-forge.webp"/>
    <details className="card"><summary>行銷與影音公會的技能書</summary><RepositoryLibrary client={client} ids={['social-post','typo-studio','video-autopilot','short-drama','hao-studio','media-generator']} title="Hao 的行銷與影音技能書"/></details>
    {notice&&<p className="banner banner-info" role="status">{notice}</p>}{error&&<p className="banner banner-error" role="alert">{error}</p>}<LoadError error={loadError} retry={()=>void refresh()}/>
    <div className="card-grid"><section className="card stack"><div className="section-head"><h2>建立行銷草稿</h2><p>目前支援手動文案與分享紀錄；尚未連接社群自動發布。</p></div>
      <form className="stack" onSubmit={create}>
        <label className="field">內容來源<select value={draft.source_selection} onChange={e=>setDraft({...draft,source_selection:e.target.value})}><option value="">自行填寫活動簡述</option><optgroup label="我的開源作品">{projects.map(p=><option key={p.project_id} value={`oss:${p.project_id}`}>{p.title} · {p.current_version.commit_sha.slice(0,7)}</option>)}</optgroup><optgroup label="我的供貨商品">{products.map(p=><option key={p.product_id} value={`supplier:${p.product_id}`}>{p.title} · 供貨版本 {p.current_offer.revision}</option>)}</optgroup></select></label>
        {!draft.source_selection&&<label className="field">活動來源簡述<textarea required maxLength={3000} placeholder="真實提供什麼、適用條件與需要注意的限制。" value={draft.source_brief} onChange={e=>setDraft({...draft,source_brief:e.target.value})}/></label>}
        <label className="field">活動名稱<input required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
        <label className="field">想分享給誰<input required maxLength={1000} value={draft.audience} onChange={e=>setDraft({...draft,audience:e.target.value})}/></label>
        <label className="field">希望對方下一步做什麼<input required maxLength={1000} value={draft.goal} onChange={e=>setDraft({...draft,goal:e.target.value})}/></label>
        <label className="field">文案草稿<textarea required rows={6} maxLength={6000} value={draft.draft_text} onChange={e=>setDraft({...draft,draft_text:e.target.value})}/></label>
        <button className="btn btn-primary" disabled={busy}>儲存私人草稿</button>
      </form></section>
      <section className="stack" aria-label="我的行銷草稿"><div className="section-head"><h2>我的行銷草稿</h2><p>來源版本會保留下來，方便日後核對。</p></div>{loading&&<p role="status">正在載入草稿…</p>}{!loading&&!loadError&&campaigns.length===0&&<div className="card empty"><h3>把第一個想法寫下來</h3><p>從你的一件作品或活動開始，先準備一段能讓人理解的介紹。</p></div>}{campaigns.map(campaign=><CampaignCard key={campaign.campaign_id} campaign={campaign} client={client} reload={refresh}/>)}</section>
    </div>
  </div>;
}

function CampaignCard({campaign,client,reload}:{campaign:Campaign;client:ModulePanelProps['client'];reload:()=>Promise<void>}) {
  const [editing,setEditing]=useState(false),[sharing,setSharing]=useState(false),[draft,setDraft]=useState({title:campaign.title,audience:campaign.audience,goal:campaign.goal,draft_text:campaign.draft_text});
  const [share,setShare]=useState({channel:'',share_url:'',note:''}),[notice,setNotice]=useState<string|null>(null);
  const {mutate,busy,error}=useModuleMutation(client);
  async function revise(event:FormEvent){event.preventDefault();const result=await mutate(`/marketing/campaigns/${campaign.campaign_id}:revise`,draft,campaign.aggregate_version);if(result){setEditing(false);setNotice('草稿已更新；既有分享紀錄保留當時的文案。');await reload();}}
  async function saveShare(event:FormEvent){event.preventDefault();const result=await mutate(`/marketing/campaigns/${campaign.campaign_id}/shares`,share,campaign.aggregate_version);if(result){setSharing(false);setShare({channel:'',share_url:'',note:''});setNotice('分享連結已記錄，標示為你的人工回報。');await reload();}}
  return <article className="card stack" aria-label={`行銷活動：${campaign.title}`}><div className="card-head"><h3>{campaign.title}</h3><span className="pill">私人草稿</span></div>
    <dl className="meta"><div><dt>分享對象</dt><dd>{campaign.audience}</dd></div><div><dt>下一步</dt><dd>{campaign.goal}</dd></div><div><dt>來源</dt><dd>{campaign.source_snapshot.kind==='oss_project'?`${campaign.source_snapshot.title} · ${campaign.source_snapshot.commit_sha?.slice(0,12)} · ${campaign.source_snapshot.license_spdx}`:campaign.source_snapshot.kind==='supplier_product'?`${campaign.source_snapshot.title} · 供貨版本 ${campaign.source_snapshot.source_version} · 供貨價 ${campaign.source_snapshot.currency} ${(Number(campaign.source_snapshot.net_price_minor)/100).toFixed(2)}（非零售價）`:campaign.source_snapshot.brief}</dd></div></dl>
    <div className="help-box"><p className="draft-copy">{campaign.draft_text}</p></div>
    <div className="actions"><button className="btn btn-ghost" disabled={busy} onClick={()=>{setDraft({title:campaign.title,audience:campaign.audience,goal:campaign.goal,draft_text:campaign.draft_text});setEditing(!editing);}}>編輯草稿</button><button className="btn btn-ghost" disabled={busy} onClick={()=>setSharing(!sharing)}>記錄分享連結</button></div>
    {notice&&<p role="status" className="status-note">{notice}</p>}{error&&<p role="alert" className="banner banner-error">{error}</p>}
    {editing&&<form className="stack" onSubmit={revise}><label className="field">活動名稱<input required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label><label className="field">想分享給誰<input required maxLength={1000} value={draft.audience} onChange={e=>setDraft({...draft,audience:e.target.value})}/></label><label className="field">希望對方下一步做什麼<input required maxLength={1000} value={draft.goal} onChange={e=>setDraft({...draft,goal:e.target.value})}/></label><label className="field">文案草稿<textarea required maxLength={6000} rows={6} value={draft.draft_text} onChange={e=>setDraft({...draft,draft_text:e.target.value})}/></label><button className="btn btn-primary" disabled={busy}>儲存草稿修改</button></form>}
    {sharing&&<form className="stack" onSubmit={saveShare}><p className="hint">自行分享後，貼上已發布的文章或推薦連結。這裡不會代為發布或推算收益。</p><label className="field">分享渠道<input required maxLength={80} placeholder="例如：Discord、LINE、部落格" value={share.channel} onChange={e=>setShare({...share,channel:e.target.value})}/></label><label className="field">分享／推薦連結<input required type="url" maxLength={2000} value={share.share_url} onChange={e=>setShare({...share,share_url:e.target.value})}/></label><label className="field">分享備註（選填）<textarea maxLength={1000} value={share.note} onChange={e=>setShare({...share,note:e.target.value})}/></label><button className="btn btn-primary" disabled={busy}>儲存分享紀錄</button></form>}
    {campaign.shares.length>0&&<section className="stack" aria-label="人工分享紀錄"><h4>人工分享紀錄</h4>{campaign.shares.map(record=><div key={record.share_id}><SafeLink href={record.share_url}>{record.channel}</SafeLink><p className="hint">自行回報，未驗證發布或成效{record.note?` · ${record.note}`:''}</p></div>)}</section>}
  </article>;
}
