import { RepositoryLibrary } from './Community';
import { useCallback,useEffect,useRef,useState,type FormEvent } from 'react';
import { requireItems } from '../api';
import { useModuleMutation,type ModulePanelProps } from './shared';
import { SkillUpload,type SkillOpenRequest } from './SkillUpload';
import { SimpleSkillSubmission } from './SimpleSkillSubmission';
import { WorkSharingEntry } from './WorkSharingEntry';
import {projectSkillBookPath,projectSkillDraft,type ProjectSkillBook} from './SkillPublication';
import { GitHubAuthorFollow } from './GitHubAuthorFollow';

type SourceVersion={version_id:string;commit_sha:string;license_spdx:string;license_evidence_url:string|null;is_fork:boolean;archived:boolean;readme_url:string;inspected_at:string};
type Project={sharing_withdrawn_at?:string|null;project_id:string;owner_ref:string;owner_name:string;title:string;description:string;use_notes:string;demo_url:string|null;repository_url:string;repository_full_name:string;repository_id:string;relationship:string;aggregate_version:number;current_version:SourceVersion;skill_book?:ProjectSkillBook|null};
type Campaign={campaign_id:string;title:string;audience:string;goal:string;draft_text:string;aggregate_version:number;source_snapshot:{kind:string;title?:string;brief?:string;commit_sha?:string;license_spdx?:string;repository_url?:string;source_version?:string;currency?:string;net_price_minor?:string};shares:{share_id:string;channel:string;share_url:string;note:string;verification_status:string}[]};
type CampaignPage={items:Campaign[];next_offset:number|null};
type SupplierProduct={product_id:string;title:string;current_offer:{revision:number}};
const relationshipLabels:Record<string,string>={author:'原作者',maintainer:'維護者',contributor:'貢獻者',curator:'推薦／整理者'};

function SafeLink({href,children}:{href:string;children:React.ReactNode}) {
  return <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children} ↗</a>;
}
function LoadError({error,retry}:{error:string|null;retry:()=>void}) {
  return error?<div className="banner banner-error" role="alert">{error} <button className="btn btn-ghost" type="button" onClick={retry}>重新載入</button></div>:null;
}

export function OpenSourcePanel({client,session,onNavigate}:ModulePanelProps) {
  const [projects,setProjects]=useState<Project[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null);
  const [openRequest,setOpenRequest]=useState<SkillOpenRequest|null>(null);
  const openNonce=useRef(0);
  const openSkill=(submissionId:string,mode: 'preview'|'complete')=>{openNonce.current+=1;setOpenRequest({submissionId,mode,nonce:openNonce.current});};
  const [resumeId,setResumeId]=useState<string|null>(()=>new URLSearchParams(window.location.hash.split('?')[1]??'').get('submission'));
  const [projectId,setProjectId]=useState<string|null>(()=>new URLSearchParams(window.location.hash.split('?')[1]??'').get('project'));
  useEffect(()=>{const change=()=>{const params=new URLSearchParams(window.location.hash.split('?')[1]??'');setResumeId(params.get('submission'));setProjectId(params.get('project'));};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change)},[]);
  const loadSequence=useRef(0);
  const refresh=useCallback(async()=>{
    const sequence=++loadSequence.current,generation=client.sessionGeneration;
    const current=()=>sequence===loadSequence.current&&generation===client.sessionGeneration;
    setLoading(true);setLoadError(null);
    try{
      const items=requireItems<Project>(await client.get('/opensource/projects'),'開源作品');
      // A stable management link must also reach works beyond the collection's
      // first page. The domain endpoint applies the same current visibility ACL.
      if(current()&&projectId&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectId)&&!items.some(item=>item.project_id===projectId)){
        const project=await client.get<Project>(`/opensource/projects/${projectId}`);items.unshift(project);
      }
      if(current())setProjects(items);
    }
    catch(cause){if(current())setLoadError(cause instanceof Error?cause.message:'無法載入開源作品。');}
    finally{if(current())setLoading(false);}
  },[client,session.user.user_id,projectId]);
  useEffect(()=>{setProjects([]);void refresh();return()=>{loadSequence.current++;};},[refresh]);
  return <div className="stack">
    <WorkSharingEntry current="opensource"/>
    <SimpleSkillSubmission key={`${session.user.user_id}:${client.sessionGeneration}`} userId={session.user.user_id} resumeId={resumeId} client={client} withdrawnProjectIds={projects.filter(project=>Boolean(project.sharing_withdrawn_at)).map(project=>project.project_id)} onPublished={refresh} onOpenDraft={openSkill}/>
    <details className="card work-sharing-advanced"><summary>使用 Agent 或聊天 AI 協助整理（進階）</summary><div className="stack"><p className="hint">已有 Agent 草稿，或想讓 AI 整理介紹與分享短文，可使用原有上傳工具。</p><div className="actions"><SkillUpload client={client} onPublished={refresh} openRequest={openRequest}/></div></div></details>
    <LoadError error={loadError} retry={()=>void refresh()}/>
      <section className="stack" aria-label="社群開源作品"><div className="section-head"><h2>社群開源作品</h2><p>目前顯示 {projects.length} 件 · 自由探索，不必先談商務合作</p></div>
        {loading&&<p role="status">正在載入作品…</p>}
        {!loading&&!loadError&&projects.length===0&&<div className="card empty"><h3>第一件作品，從你開始</h3><p>登錄後會顯示使用說明、授權與固定版本，方便其他會員試用和參與。</p></div>}
        {projects.map(project=><ProjectCard key={project.project_id} project={project} own={project.owner_ref===session.user.user_id} client={client} session={session} reload={refresh} onNavigate={onNavigate} onOpenSkill={openSkill}/>)}
      </section>
    <details className="card"><summary>作品怎麼成為技能書？</summary><div className="stack"><p>在自己的作品卡按「製作技能書」，沿用已登錄的介紹建立私人草稿；檢查內容後按「送出技能」，即可公開為社群技能書。已有草稿會繼續原稿，不覆蓋你修改的內容。</p><p>不必先準備 100 則分享短文或示意圖；這些可在公開後選擇補充。原作者、來源與授權仍會保留，公會指定另有選書流程。</p></div></details>
  </div>;
}

function ProjectCard({project,own,client,reload,onNavigate,onOpenSkill}:ModulePanelProps & {project:Project;own:boolean;reload:()=>Promise<void>;onOpenSkill:(id:string,mode:'preview'|'complete')=>void}) {
  const {mutate,busy,error}=useModuleMutation(client),[editing,setEditing]=useState(false),[notice,setNotice]=useState<string|null>(null);
  const [draft,setDraft]=useState({title:project.title,description:project.description,use_notes:project.use_notes,demo_url:project.demo_url??''});
  const [githubManager,setGitHubManager]=useState(false),canEdit=own||githubManager;
  const skillPath=project.sharing_withdrawn_at?null:projectSkillBookPath(project.skill_book),skillDraft=projectSkillDraft(project.skill_book,own);
  const [confirmWithdrawal,setConfirmWithdrawal]=useState(false),[withdrawalConsent,setWithdrawalConsent]=useState(false);
  const card=useRef<HTMLElement>(null);
  useEffect(()=>{
    const focus=()=>{if(own&&new URLSearchParams(window.location.hash.split('?')[1]??'').get('project')===project.project_id)card.current?.focus();};
    focus();window.addEventListener('hashchange',focus);return()=>window.removeEventListener('hashchange',focus);
  },[own,project.project_id]);
  async function withdraw(){
    if(!withdrawalConsent||busy)return;
    const result=await mutate(`/opensource/projects/${project.project_id}/withdraw`,{},project.aggregate_version);
    if(result){setConfirmWithdrawal(false);setWithdrawalConsent(false);setNotice('已撤下分享；介紹與歷史內容仍保留在你的帳號。');await reload();}
  }
  async function makeSkill(){
    const result=await mutate<{submission:{submission_id:string;status:string}|null;created:boolean;catalog_book?:{book_id:string;title:string;public_path:string}|null}>(`/opensource/projects/${project.project_id}/skill-submission`,{},project.aggregate_version);
    if(!result)return;
    if(result.submission?.status==='ready_for_review'||result.submission?.status==='awaiting_upload')onOpenSkill(result.submission.submission_id,result.submission.status==='ready_for_review'?'preview':'complete');
    else setNotice('這件作品已有公開技能書，可直接閱讀。');
    await reload();
  }
  async function checkManagement(){const result=await mutate(`/opensource/projects/${project.project_id}/edit-access`,{});if(result){setGitHubManager(true);setNotice('已核對 GitHub Repo 管理權；儲存時會再次確認。');}}
  async function refreshVersion(){const result=await mutate(`/opensource/projects/${project.project_id}:refresh`,{},project.aggregate_version);if(result){setNotice('已重新查詢 GitHub；行銷草稿保留建立時的版本。');await reload();}}
  async function revise(event:FormEvent){event.preventDefault();const result=await mutate(`/opensource/projects/${project.project_id}:revise`,{...draft,demo_url:draft.demo_url.trim()||null},project.aggregate_version);if(result){setEditing(false);setNotice('使用說明已更新。');await reload();}}
  return <article ref={card} tabIndex={-1} className="card stack" aria-label={`開源作品：${project.title}`}>
    <div className="card-head"><div><p className="module-kicker">{project.repository_full_name}</p><h3>{project.title}</h3></div><span className="pill">{project.sharing_withdrawn_at?'已撤下分享・僅本人可見':skillPath?'已公開社群技能書':'已登錄作品'}</span></div>
    <p className="project-copy">{project.description}</p><div className="help-box"><strong>如何開始</strong><p className="project-copy">{project.use_notes}</p></div>
    <dl className="meta"><div><dt>登錄者</dt><dd>{project.owner_name} · {relationshipLabels[project.relationship]}（自行聲明）</dd></div><div><dt>授權</dt><dd>{project.current_version.license_spdx==='NOASSERTION'?'尚未確認，請先閱讀原始授權':project.current_version.license_spdx}</dd></div><div><dt>固定版本</dt><dd><code>{project.current_version.commit_sha.slice(0,12)}</code> · {project.current_version.is_fork?'衍生儲存庫':'原始儲存庫'}{project.current_version.archived?' · 已封存':''}</dd></div></dl>
    <div className="actions"><SafeLink href={project.current_version.readme_url}>閱讀文件／開始使用</SafeLink><SafeLink href={`${project.repository_url}/issues`}>參與討論</SafeLink>{project.demo_url&&<SafeLink href={project.demo_url}>開啟展示</SafeLink>}{project.current_version.license_evidence_url&&<SafeLink href={project.current_version.license_evidence_url}>查看授權</SafeLink>}</div>
    <GitHubAuthorFollow key={project.repository_full_name.split('/')[0]} username={project.repository_full_name.split('/')[0]} client={client}/>
    <div className="actions">
      {skillPath?<a className="btn btn-primary" href={skillPath} target="_blank" rel="noopener noreferrer">閱讀已公開技能書 ↗</a>:own&&skillDraft?<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>onOpenSkill(skillDraft.submissionId,skillDraft.mode)}>繼續製作技能書</button>:own&&<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void makeSkill()}>{project.sharing_withdrawn_at?'重新預覽並公開':'製作技能書'}</button>}
      {skillPath&&<a className="btn btn-ghost" href="/#skills">前往技能書架</a>}
    </div>
    {own&&skillDraft&&<p className="field-hint">{skillDraft.mode==='preview'?'草稿已備妥，等你預覽並公開。':'草稿仍在等候上傳內容；可繼續補充，原稿會保留。'}</p>}
    <p className="hint">來源關係為登錄者自行聲明，請依原始授權使用。</p>
    {error&&<p role="alert" className="banner banner-error">{error}</p>}{notice&&<p role="status" className="status-note">{notice}</p>}
    {!canEdit&&<div className="stack"><p className="hint">組織 Repo 的管理者也可編輯公開介紹。先連結 GitHub，並讓授權涵蓋此 Repo（admin／maintain）。</p><div className="actions"><button className="btn btn-ghost" disabled={busy} onClick={()=>void checkManagement()}>核對 GitHub 管理權</button>{onNavigate&&<button className="btn btn-ghost" onClick={()=>onNavigate('community')}>連結 GitHub</button>}</div></div>}
    {canEdit&&<div className="actions"><button className="btn btn-ghost" disabled={busy} onClick={()=>void refreshVersion()}>更新 GitHub 版本</button><button className="btn btn-ghost" disabled={busy} onClick={()=>{setDraft({title:project.title,description:project.description,use_notes:project.use_notes,demo_url:project.demo_url??''});setEditing(!editing);}}>編輯作品介紹</button>{own&&onNavigate&&<button className="btn btn-ghost" onClick={()=>onNavigate('marketing')}>為作品準備行銷</button>}</div>}
    {own&&!project.sharing_withdrawn_at&&<div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={busy||editing} onClick={()=>setConfirmWithdrawal(true)}>撤下作品分享</button></div>}
    {confirmWithdrawal&&!project.sharing_withdrawn_at&&<section className="help-box stack" aria-label="確認撤下作品分享"><p>撤下「{project.title}」的公開頁、圖片、技能書架與會員目錄；舊版連結及尚未完成的升級稿也會關閉，共創入口暫停展示。內容保留給你編輯，重新預覽並同意後才會再公開。</p><p className="hint">原始 GitHub Repo、別人已保存的副本及獨立收錄的公會技能書不受影響。</p><label className="choice"><input type="checkbox" checked={withdrawalConsent} disabled={busy} onChange={event=>setWithdrawalConsent(event.target.checked)}/>我了解這件作品的所有分享版本都會撤下</label><div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={busy||!withdrawalConsent} onClick={()=>void withdraw()}>確認撤下作品分享</button><button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={()=>{setConfirmWithdrawal(false);setWithdrawalConsent(false);}}>保留分享</button></div></section>}
    {editing&&<form className="stack" onSubmit={revise}><p className="hint">{project.sharing_withdrawn_at?'修改僅本人可見；重新預覽並公開前，不會恢復分享。':'儲存會更新目前分享中的介紹。若要先保留私人修改，請先撤下分享。'}</p><label className="field">作品名稱<input required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label><label className="field">這個作品可以做什麼<textarea required maxLength={2000} value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label><label className="field">如何開始使用<textarea required maxLength={3000} value={draft.use_notes} onChange={e=>setDraft({...draft,use_notes:e.target.value})}/></label><label className="field">展示網址（選填）<input type="url" value={draft.demo_url} onChange={e=>setDraft({...draft,demo_url:e.target.value})}/></label><button className="btn btn-primary" disabled={busy}>儲存作品介紹</button></form>}
  </article>;
}

const blankCampaign={title:'',audience:'',goal:'',draft_text:'',source_selection:'',source_brief:''};
export function MarketingPanel({client,session}:ModulePanelProps) {
  const [campaigns,setCampaigns]=useState<Campaign[]>([]),[projects,setProjects]=useState<Project[]>([]),[draft,setDraft]=useState({...blankCampaign});
  const [products,setProducts]=useState<SupplierProduct[]>([]);
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
  const [campaignNextOffset,setCampaignNextOffset]=useState<number|null>(null),[campaignLoadingMore,setCampaignLoadingMore]=useState(false),[campaignPageError,setCampaignPageError]=useState<string|null>(null);
  // Creation shifts the offset, so it must not overlap a continuation request.
  const campaignOperationPending=useRef(false);
  const {mutate,busy,error}=useModuleMutation(client);
  const refresh=useCallback(async()=>{
    setLoading(true);setLoadError(null);setCampaignPageError(null);
    try{
      const [campaignData,projectData,productData]=await Promise.all([
        client.get<CampaignPage>('/marketing/campaigns?limit=20&offset=0'),
        client.get('/opensource/projects'),
        client.get('/supplier/products'),
      ]);
      setCampaigns(campaignData.items);setCampaignNextOffset(campaignData.next_offset);
      setProjects(requireItems<Project>(projectData,'開源作品').filter(p=>p.owner_ref===session.user.user_id));
      setProducts(requireItems<SupplierProduct>(productData,'供貨商品'));
    }catch(cause){setLoadError(cause instanceof Error?cause.message:'無法載入行銷工作室。');}finally{setLoading(false);}
  },[client,session.user.user_id]);
  useEffect(()=>{void refresh();},[refresh]);
  const saveCampaign=useCallback((saved:Campaign)=>{
    setCampaigns(current=>current.map(campaign=>campaign.campaign_id===saved.campaign_id?saved:campaign));
  },[]);
  const loadMoreCampaigns=useCallback(async()=>{
    if(loading||campaignNextOffset===null||campaignOperationPending.current)return;
    campaignOperationPending.current=true;
    setCampaignLoadingMore(true);setCampaignPageError(null);
    try{
      const page=await client.get<CampaignPage>(`/marketing/campaigns?limit=20&offset=${campaignNextOffset}`);
      setCampaigns(current=>{const seen=new Set(current.map(campaign=>campaign.campaign_id));return [...current,...page.items.filter(campaign=>!seen.has(campaign.campaign_id))];});
      setCampaignNextOffset(page.next_offset);
    }catch(cause){setCampaignPageError(cause instanceof Error?cause.message:'無法載入更多行銷草稿。');}finally{campaignOperationPending.current=false;setCampaignLoadingMore(false);}
  },[campaignNextOffset,client,loading]);
  async function create(event:FormEvent){
    event.preventDefault();
    if(loading||campaignOperationPending.current)return;
    campaignOperationPending.current=true;setNotice(null);
    try{
      const {source_selection,...content}=draft;const [kind,sourceId]=source_selection.split(':');
      const saved=await mutate<Campaign>('/marketing/campaigns',{...content,source_project_id:kind==='oss'?sourceId:null,source_supplier_product_id:kind==='supplier'?sourceId:null,source_brief:source_selection?'':draft.source_brief});
      if(saved){setDraft({...blankCampaign});setCampaigns(current=>[saved,...current.filter(campaign=>campaign.campaign_id!==saved.campaign_id)]);setCampaignNextOffset(current=>current===null?null:current+1);setNotice('私人草稿已儲存，可以繼續編輯或自行分享。');}
    }finally{campaignOperationPending.current=false;}
  }
  return <div className="stack">
    {notice&&<p className="banner banner-info" role="status">{notice}</p>}{error&&<p className="banner banner-error" role="alert">{error}</p>}<LoadError error={loadError} retry={()=>void refresh()}/>
    <div className="card-grid"><section className="card stack"><div className="section-head"><h2>建立行銷草稿</h2><p>先寫文案，再到你選擇的平台自行發布。</p></div>
      <form className="stack" onSubmit={create}>
        <label className="field">內容來源<select data-guide-anchor="marketing:source" value={draft.source_selection} onChange={e=>setDraft({...draft,source_selection:e.target.value})}><option value="">自行填寫活動簡述</option>{projects.length>0&&<optgroup label="我的開源作品">{projects.map(p=><option key={p.project_id} value={`oss:${p.project_id}`}>{p.title} · {p.current_version.commit_sha.slice(0,7)}</option>)}</optgroup>}{products.length>0&&<optgroup label="我的供貨商品">{products.map(p=><option key={p.product_id} value={`supplier:${p.product_id}`}>{p.title} · 供貨版本 {p.current_offer.revision}</option>)}</optgroup>}</select>{!loading&&!projects.length&&!products.length&&<span className="field-hint">登錄開源作品或供貨商品後，可直接引用固定版本作為來源。</span>}</label>
        {!draft.source_selection&&<label className="field">活動來源簡述<textarea required maxLength={3000} placeholder="真實提供什麼、適用條件與需要注意的限制。" value={draft.source_brief} onChange={e=>setDraft({...draft,source_brief:e.target.value})}/></label>}
        <label className="field">活動名稱<input required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
        <label className="field">想分享給誰<input required maxLength={1000} value={draft.audience} onChange={e=>setDraft({...draft,audience:e.target.value})}/></label>
        <label className="field">希望對方下一步做什麼<input required maxLength={1000} value={draft.goal} onChange={e=>setDraft({...draft,goal:e.target.value})}/></label>
        <label className="field">文案草稿<textarea required rows={6} maxLength={6000} value={draft.draft_text} onChange={e=>setDraft({...draft,draft_text:e.target.value})}/></label>
        <button className="btn btn-primary" disabled={busy||campaignLoadingMore||loading}>儲存私人草稿</button>
      </form></section>
      <section className="stack" aria-label="我的行銷草稿" data-guide-anchor="marketing:drafts"><div className="section-head"><h2>我的行銷草稿</h2><p>已載入 {campaigns.length} 份 · 來源版本會保留下來，方便日後核對。</p></div>{loading&&<p role="status">正在載入草稿…</p>}{!loading&&!loadError&&campaigns.length===0&&<div className="card empty"><h3>把第一個想法寫下來</h3><p>從你的一件作品或活動開始，先準備一段能讓人理解的介紹。</p></div>}{campaigns.map(campaign=><CampaignCard key={campaign.campaign_id} campaign={campaign} client={client} onSaved={saveCampaign}/>)}{campaignPageError&&<p className="banner banner-error" role="alert">{campaignPageError}</p>}{campaignNextOffset!==null&&<div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={campaignLoadingMore||busy||loading} onClick={()=>void loadMoreCampaigns()}>{campaignLoadingMore?'載入中…':'載入更多行銷草稿'}</button></div>}</section>
    </div>
    <details className="card"><summary>行銷與影音公會的技能書</summary><RepositoryLibrary client={client} ids={['social-post','typo-studio','video-autopilot','short-drama','media-generator']} title="Hao 的行銷與影音技能書"/></details>
  </div>;
}

function CampaignCard({campaign,client,onSaved}:{campaign:Campaign;client:ModulePanelProps['client'];onSaved:(campaign:Campaign)=>void}) {
  const [editing,setEditing]=useState(false),[sharing,setSharing]=useState(false),[draft,setDraft]=useState({title:campaign.title,audience:campaign.audience,goal:campaign.goal,draft_text:campaign.draft_text});
  const [share,setShare]=useState({channel:'',share_url:'',note:''}),[notice,setNotice]=useState<string|null>(null);
  const {mutate,busy,error}=useModuleMutation(client);
  async function revise(event:FormEvent){event.preventDefault();const result=await mutate<Campaign>(`/marketing/campaigns/${campaign.campaign_id}:revise`,draft,campaign.aggregate_version);if(result){setEditing(false);setNotice('草稿已更新；既有分享紀錄保留當時的文案。');onSaved(result);}}
  async function saveShare(event:FormEvent){event.preventDefault();const result=await mutate<Campaign>(`/marketing/campaigns/${campaign.campaign_id}/shares`,share,campaign.aggregate_version);if(result){setSharing(false);setShare({channel:'',share_url:'',note:''});setNotice('分享連結已記錄，標示為你的人工回報。');onSaved(result);}}
  return <article className="card stack" aria-label={`行銷活動：${campaign.title}`}><div className="card-head"><h3>{campaign.title}</h3><span className="pill">私人草稿</span></div>
    <dl className="meta"><div><dt>分享對象</dt><dd>{campaign.audience}</dd></div><div><dt>下一步</dt><dd>{campaign.goal}</dd></div><div><dt>來源</dt><dd>{campaign.source_snapshot.kind==='oss_project'?`${campaign.source_snapshot.title} · ${campaign.source_snapshot.commit_sha?.slice(0,12)} · ${campaign.source_snapshot.license_spdx}`:campaign.source_snapshot.kind==='supplier_product'?`${campaign.source_snapshot.title} · 供貨版本 ${campaign.source_snapshot.source_version} · 供貨價 ${campaign.source_snapshot.currency} ${(Number(campaign.source_snapshot.net_price_minor)/100).toFixed(2)}（非零售價）`:<span className="draft-copy">{campaign.source_snapshot.brief}</span>}</dd></div></dl>
    <div className="help-box"><p className="draft-copy">{campaign.draft_text}</p></div>
    <div className="actions"><button className="btn btn-ghost" disabled={busy} onClick={()=>{setDraft({title:campaign.title,audience:campaign.audience,goal:campaign.goal,draft_text:campaign.draft_text});setEditing(!editing);}}>編輯草稿</button><button className="btn btn-ghost" disabled={busy} onClick={()=>setSharing(!sharing)}>記錄分享連結</button></div>
    {notice&&<p role="status" className="status-note">{notice}</p>}{error&&<p role="alert" className="banner banner-error">{error}</p>}
    {editing&&<form className="stack" onSubmit={revise}><label className="field">活動名稱<input required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label><label className="field">想分享給誰<input required maxLength={1000} value={draft.audience} onChange={e=>setDraft({...draft,audience:e.target.value})}/></label><label className="field">希望對方下一步做什麼<input required maxLength={1000} value={draft.goal} onChange={e=>setDraft({...draft,goal:e.target.value})}/></label><label className="field">文案草稿<textarea required maxLength={6000} rows={6} value={draft.draft_text} onChange={e=>setDraft({...draft,draft_text:e.target.value})}/></label><button className="btn btn-primary" disabled={busy}>儲存草稿修改</button></form>}
    {sharing&&<form className="stack" onSubmit={saveShare}><p className="hint">發布後，把文章或推薦連結貼回來。這裡只記錄你的分享，不代表已驗證成效或收入。</p><label className="field">分享渠道<input required maxLength={80} placeholder="例如：Discord、LINE、部落格" value={share.channel} onChange={e=>setShare({...share,channel:e.target.value})}/></label><label className="field">分享／推薦連結<input required type="url" maxLength={2000} value={share.share_url} onChange={e=>setShare({...share,share_url:e.target.value})}/></label><label className="field">分享備註（選填）<textarea maxLength={1000} value={share.note} onChange={e=>setShare({...share,note:e.target.value})}/></label><button className="btn btn-primary" disabled={busy}>儲存分享紀錄</button></form>}
    {campaign.shares.length>0&&<section className="stack" aria-label="人工分享紀錄"><h4>人工分享紀錄</h4>{campaign.shares.map(record=><div key={record.share_id}><SafeLink href={record.share_url}>{record.channel}</SafeLink><p className="hint">自行回報，未驗證發布或成效{record.note?<> · <span className="multiline-text">{record.note}</span></>:''}</p></div>)}</section>}
  </article>;
}
