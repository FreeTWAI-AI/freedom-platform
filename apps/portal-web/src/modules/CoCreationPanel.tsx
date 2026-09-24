import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useModuleMutation, type ModulePanelProps } from './shared';
import { Status } from './Membership';
import { ModuleBanner } from './ModuleBanner';
import { categoriesForLabels, taskCategories, type TaskCategory } from '../../../../packages/shared/task-categories';
import './ModuleDiscovery.css';
import './CoCreation.css';

type Guild = { guild_key: string; name: string };
type Project = {
  guild_keys: string[];
  project_id: string; source_project_id: string | null; title: string; goal: string;
  help_wanted: string[]; contribution_notes: string; repository_id: string;
  repository_url: string; repository_full_name: string; coordinator_ref: string | null;
  coordinator_name: string; aggregate_version: number;
  source_kind: 'member_project' | 'community_pilot'; upstream_url: string | null;
};
type Issue = { number: number; title: string; body: string; url: string; labels: string[]; assignees: string[] };
type Contribution = { number: number; title: string; url: string; author: string; merged_at: string; merge_commit_sha: string };
type Activity = { repository_url: string; issues: Issue[]; contributions: Contribution[]; checked_at: string; truncated: boolean };
type SourceProject = { project_id: string; owner_ref: string; title: string; repository_full_name: string };
const roles: [string, string][] = [
  ['development', '程式開發'], ['testing', '測試與回報'], ['design', '設計'],
  ['documentation', '文件教學'], ['marketing', '行銷內容'], ['sales', '銷售推廣'], ['operations', '社群營運'], ['security', '資安檢查'], ['music', '作曲與配樂'], ['media', '影片製作'],
];
const roleLabel = (key: string) => roles.find(([value]) => value === key)?.[1] ?? key;
const message = (error: unknown) => error instanceof Error ? error.message : '暫時無法載入，請稍後再試。';
type TaskFilters = { query: string; assignment: 'all' | 'unassigned' | 'assigned'; label: string; category: '' | TaskCategory };
const emptyTaskFilters: TaskFilters = { query: '', assignment: 'all', label: '', category: '' };
function readTaskFilters(key: string): TaskFilters {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (saved && typeof saved.query === 'string' && typeof saved.label === 'string' && ['all', 'unassigned', 'assigned'].includes(saved.assignment)) {
      return { query: saved.query.slice(0, 150), assignment: saved.assignment, label: saved.label, category: taskCategories.some(([key]) => key === saved.category) ? saved.category : '' };
    }
  } catch { /* Filtering remains usable when browser storage is unavailable. */ }
  return { ...emptyTaskFilters };
}
function GitHubLink({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return null;
  } catch { return null; }
  return <a className={primary ? 'btn btn-primary' : 'btn btn-ghost'} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children} ↗</a>;
}
export function CoCreationPanel({ client, session, onNavigate }: ModulePanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [guildFilter, setGuildFilter] = useState('');
  const [selectedGuilds, setSelectedGuilds] = useState<string[]>([]);
  const [sources, setSources] = useState<SourceProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activityError, setActivityError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [brief, setBrief] = useState<{ project_id: string; number: number | null; title: string; text: string } | null>(null);
  const [briefLoading, setBriefLoading] = useState<string | null>(null);
  const [briefError, setBriefError] = useState('');
  const requestSequence = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const [taskFilters, setTaskFilters] = useState<TaskFilters>({ ...emptyTaskFilters });
  const { mutate, busy, error } = useModuleMutation(client);
  const selected = projects.find(project => project.project_id === selectedId) ?? null;
  const matchesGuild = (project: Project, filter: string) => !filter || (filter === 'unclassified' ? project.guild_keys.length === 0 : project.guild_keys.includes(filter));
  const visibleProjects = projects.filter(project => matchesGuild(project, guildFilter));
  const guildName = (key: string) => guilds.find(guild => guild.guild_key === key)?.name ?? key;
  function chooseProject(id: string | null) {
    requestSequence.current += 1;
    setSelectedId(id); setActivity(null); setBrief(null); setBriefLoading(null); setBriefError(''); setNotice(''); setActivityError('');
  }
  function chooseGuild(filter: string) {
    setGuildFilter(filter);
    const matching = projects.filter(project => matchesGuild(project, filter));
    if (!matching.some(project => project.project_id === selectedId)) chooseProject(matching[0]?.project_id ?? null);
  }
  const filterKey = `freedom-task-filters:${session.user.user_id}:${selectedId ?? ''}`;
  useEffect(() => { setTaskFilters(readTaskFilters(filterKey)); }, [filterKey]);
  function updateTaskFilters(value: TaskFilters) {
    setTaskFilters(value);
    try { sessionStorage.setItem(filterKey, JSON.stringify(value)); } catch { /* Storage is optional. */ }
  }
  const taskLabels = [...new Set(activity?.issues.flatMap(issue => issue.labels) ?? [])].sort((a, b) => a.localeCompare(b, 'zh-TW'));
  const taskQuery = taskFilters.query.trim().toLocaleLowerCase();
  const visibleIssues = (activity?.issues ?? []).filter(issue =>
    (!taskQuery || [String(issue.number), issue.title, issue.body, ...issue.labels].join(' ').toLocaleLowerCase().includes(taskQuery)) &&
    (taskFilters.assignment === 'all' || (taskFilters.assignment === 'assigned' ? issue.assignees.length > 0 : issue.assignees.length === 0)) &&
    (!taskFilters.label || issue.labels.includes(taskFilters.label)) &&
    (!taskFilters.category || categoriesForLabels(issue.labels).includes(taskFilters.category))
  );
  const hasTaskFilters = Boolean(taskQuery || taskFilters.label || taskFilters.category || taskFilters.assignment !== 'all');

  async function loadProjects() {
    setLoading(true); setLoadError('');
    try {
      const [catalog, ownSources] = await Promise.all([
        client.get<{ items: Project[]; guilds: Guild[] }>('/co-creation/projects'),
        client.get<{ items: SourceProject[] }>('/opensource/projects'),
      ]);
      setProjects(catalog.items); setGuilds(catalog.guilds);
      setSources(ownSources.items.filter(source => source.owner_ref === session.user.user_id));
      const matching = catalog.items.filter(project => matchesGuild(project, guildFilter));
      setSelectedId(current => matching.some(project => project.project_id === current) ? current : matching[0]?.project_id ?? null);
    } catch (cause) { setLoadError(message(cause)); }
    finally { setLoading(false); }
  }
  async function loadActivity(projectId: string) {
    const sequence = ++requestSequence.current;
    setActivityLoading(true); setActivityError(''); setActivity(null); setBrief(null); setBriefLoading(null); setBriefError('');
    try {
      const value = await client.get<Activity>(`/co-creation/projects/${encodeURIComponent(projectId)}/activity`);
      if (sequence === requestSequence.current) setActivity(value);
    } catch (cause) { if (sequence === requestSequence.current) setActivityError(message(cause)); }
    finally { if (sequence === requestSequence.current) setActivityLoading(false); }
  }
  useEffect(() => { void loadProjects(); }, [client, session.user.user_id]);
  useEffect(() => {
    if (selectedId) void loadActivity(selectedId);
    return () => { requestSequence.current += 1; };
  }, [selectedId]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice('');
    const form = event.currentTarget, data = new FormData(form);
    const result = await mutate<Project>('/co-creation/projects', {
      source_project_id: data.get('source_project_id'), title: data.get('title'), goal: data.get('goal'),
      help_wanted: selectedRoles, guild_keys: selectedGuilds, contribution_notes: data.get('contribution_notes'),
    });
    if (result) {
      form.reset(); setSelectedRoles([]); setSelectedGuilds([]); setShowCreate(false); setGuildFilter('');
      setNotice('共創邀請已發布。到專案的 GitHub 建立具體任務，就能邀請夥伴一起參與。');
      await loadProjects(); setSelectedId(result.project_id);
    }
  }
  async function copyBrief(issue?: Issue) {
    if (!selected || briefLoading !== null) return;
    setBriefLoading(issue ? String(issue.number) : 'project'); setNotice(''); setBriefError('');
    const projectId = selected.project_id, sequence = requestSequence.current;
    try {
      const path = `/co-creation/projects/${encodeURIComponent(projectId)}` + (issue ? `/issues/${issue.number}/brief` : '/brief');
      const value = await client.get<{ text: string }>(path);
      if (sequence !== requestSequence.current) return;
      setBrief({ project_id: projectId, number: issue?.number ?? null, title: issue?.title ?? selected.title, text: value.text });
      try { await navigator.clipboard.writeText(value.text); if (sequence === requestSequence.current) setNotice(issue ? '工作說明已複製，可以交給你的協作夥伴或 AI 助手。' : '專案開發指令已複製，貼給你的 Agent 就能開始了解任務。'); }
      catch { if (sequence === requestSequence.current) setNotice('指令已準備好。瀏覽器未允許複製，請從下方自行選取複製。'); }
    } catch (cause) { if (sequence === requestSequence.current) setBriefError(message(cause)); }
    finally { if (sequence === requestSequence.current) setBriefLoading(null); }
  }

  return <section className="module-panel cocreation-panel" aria-labelledby="cocreation-heading">
    <ModuleBanner eyebrow="BUILD TOGETHER" title="共創任務" headingId="cocreation-heading" description="到 GitHub 任務留言認領；完成程式、測試、設計或文件後提交 PR，交由維護者審查。" art="/art/rpg/cooperation-forge.webp"><div className="actions"><button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>{showCreate ? '收起邀請表' : '發起共創邀請'}</button><button className="btn btn-ghost" onClick={() => onNavigate?.('opensource')}>登錄作品</button></div></ModuleBanner>
    <Status error={loadError || error} notice={notice}/>
    {showCreate && <form className="card stack" onSubmit={create}><h3>發起共創邀請</h3>{sources.length ? <><label className="field">選擇你已登錄的作品<select name="source_project_id" required>{sources.map(source => <option key={source.project_id} value={source.project_id}>{source.title} · {source.repository_full_name}</option>)}</select></label><label className="field">共創邀請名稱<input name="title" required maxLength={120} placeholder="例如：一起完善影片自動剪輯工具"/></label><label className="field">這一輪想完成什麼<textarea name="goal" required maxLength={2000} placeholder="說明具體成果，以及誰會因此受益。"/></label><fieldset className="fieldset"><legend>專案公會分類（可跨公會，最多 5 個）</legend><div className="selection-chips">{guilds.map(guild => <label className="selection-chip" key={guild.guild_key}><input type="checkbox" checked={selectedGuilds.includes(guild.guild_key)} disabled={selectedGuilds.length >= 5 && !selectedGuilds.includes(guild.guild_key)} onChange={() => setSelectedGuilds(current => current.includes(guild.guild_key) ? current.filter(key => key !== guild.guild_key) : [...current, guild.guild_key])}/>{guild.name}</label>)}</div></fieldset><fieldset className="fieldset"><legend>希望哪些夥伴加入？（可複選）</legend><div className="selection-chips">{roles.map(([key, label]) => <label className="selection-chip" key={key}><input type="checkbox" checked={selectedRoles.includes(key)} onChange={() => setSelectedRoles(current => current.includes(key) ? current.filter(value => value !== key) : [...current, key])}/>{label}</label>)}</div></fieldset><label className="field">參與方式與注意事項<textarea name="contribution_notes" required maxLength={3000} placeholder="先讀哪些說明？任務如何協調？修改由誰審查？"/></label><p className="field-hint">發起邀請代表你願意協調參與，不會取得別人的 GitHub 管理權。若有費用或報酬，請由當事人另外確認。</p><button className="btn btn-primary" disabled={busy || selectedRoles.length === 0}>{busy ? '發布中…' : '發布共創邀請'}</button></> : <><p>先登錄一件作品，再邀請其他夥伴一起發展。</p><button className="btn btn-primary" type="button" onClick={() => onNavigate?.('opensource')}>登錄我的作品</button></>}</form>}
    {loading && <p role="status">正在尋找可以一起做的作品…</p>}
    {loadError && <button className="btn btn-ghost" onClick={() => void loadProjects()}>重新載入共創邀請</button>}
    {!loading && !loadError && projects.length === 0 && <div className="card expedition-empty"><h3>目前沒有共創邀請</h3></div>}
    {!loading && !loadError && projects.length > 0 && <section className="discovery-toolbar cocreation-project-picker" aria-label="選擇共創專案">
      <label className="field">公會分類<select value={guildFilter} onChange={event => chooseGuild(event.target.value)}><option value="">全部公會 · {projects.length} 個專案</option>{guilds.map(guild => <option key={guild.guild_key} value={guild.guild_key}>{guild.name} · {projects.filter(project => project.guild_keys.includes(guild.guild_key)).length}</option>)}<option value="unclassified">尚未分類 · {projects.filter(project => !project.guild_keys.length).length}</option></select></label>
      <label className="field discovery-search">選擇專案<select value={selectedId ?? ''} disabled={!visibleProjects.length} onChange={event => chooseProject(event.target.value)}>{!visibleProjects.length && <option value="">此分類尚無共創專案</option>}{visibleProjects.map(project => <option key={project.project_id} value={project.project_id}>{project.repository_full_name} · {project.coordinator_name}</option>)}</select></label>
    </section>}
    {!loading && !loadError && projects.length > 0 && !visibleProjects.length && <div className="discovery-empty"><h3>這個公會還沒有共創邀請</h3><button className="btn btn-ghost" onClick={() => chooseGuild('')}>查看全部公會專案</button></div>}
    {selected && <section className="stack" aria-labelledby="cocreation-project-title"><div className="card stack expedition-project-detail">
      <div className="tag-list">{selected.guild_keys.length ? selected.guild_keys.map(key => <span className="pill" key={key}>{guildName(key)}</span>) : <span className="pill">尚未分類</span>}</div>
      <h3 id="cocreation-project-title">{selected.title}</h3><p>{selected.goal}</p>
      <p className="field-hint">把開發指令貼給你的 Agent，先讀專案、挑任務，再依完成條件修改與測試。</p>
      <div className="actions"><button className="btn btn-primary" disabled={briefLoading !== null} onClick={() => void copyBrief()}>{briefLoading === 'project' ? '準備開發指令…' : '複製專案開發指令'}</button><GitHubLink href={selected.upstream_url || selected.repository_url}>{selected.upstream_url ? '開啟原作' : '查看專案'}</GitHubLink><button className="btn btn-ghost" disabled={activityLoading} onClick={() => void loadActivity(selected.project_id)}>更新任務與成果</button></div>
      <p className="field-hint">{selected.upstream_url ? `原作：${selected.upstream_url.replace('https://github.com/', '')} · ` : ''}邀請發起：{selected.coordinator_name}</p>
      <details className="module-optional"><summary>參與方式與協作分工</summary><div className="stack"><div className="tag-list">{selected.help_wanted.map(role => <span className="pill" key={role}>{roleLabel(role)}</span>)}</div><p className="cocreation-copy">{selected.contribution_notes}</p><p className="field-hint">通用改善優先回饋原作；工坊專用整合依任務範圍提交。修改由 repo 維護者審查，邀請發起人不一定有合併權限。</p><div className="actions">{selected.upstream_url && <GitHubLink href={selected.repository_url}>查看工坊整合版本</GitHubLink>}<GitHubLink href={`${selected.repository_url}/issues/new`}>提出新任務</GitHubLink></div></div></details>
    </div>
      <Status error={briefError}/>
      {brief?.project_id === selected.project_id && <section className="card stack expedition-brief"><div className="section-heading"><h4>{brief.number === null ? '交給 Agent 的專案開發指令' : `任務 #${brief.number}：${brief.title}`}</h4><button className="btn btn-ghost" onClick={() => setBrief(null)}>收起指令</button></div><label className="field">{brief.number === null ? '給 Agent 的專案開發指令' : '給協作夥伴與 AI 的工作說明'}<textarea aria-label={brief.number === null ? '給 Agent 的專案開發指令' : '給協作夥伴與 AI 的工作說明'} readOnly rows={10} value={brief.text} onFocus={event => event.currentTarget.select()}/></label><p className="field-hint">指令包含來源、任務選擇、驗證與 PR 回饋方式；完成後仍需檢查修改，再交由維護者審查。</p></section>}
      <Status error={activityError}/>{activityError && <div className="actions"><button className="btn btn-ghost" onClick={() => void loadActivity(selected.project_id)}>重新載入任務</button><GitHubLink href={`${selected.repository_url}/issues`}>直接到 GitHub 看任務</GitHubLink></div>}
      {activityLoading && <p role="status">正在讀取專案的任務與成果…</p>}
      {activity && <><header className="section-heading"><h3>可以參與的任務</h3><p className="muted">更新於 {new Date(activity.checked_at).toLocaleString('zh-TW')}。{activity.truncated ? '這裡先列出部分任務與成果，完整紀錄請到 GitHub 查看。' : ''}</p></header>
      <p className="field-hint cocreation-task-source">GitHub 開放中的 Issues · {selected.repository_full_name}。類型依標籤分類；未指派不代表沒有人正在協調。</p>
      <section className="discovery-toolbar cocreation-task-filters" aria-label="任務篩選"><label className="field discovery-search">搜尋任務<input ref={searchInput} type="search" maxLength={150} value={taskFilters.query} onChange={event => updateTaskFilters({ ...taskFilters, query: event.target.value })} placeholder="任務名稱、內容或編號"/></label><label className="field">任務類型<select value={taskFilters.category} onChange={event => updateTaskFilters({ ...taskFilters, category: event.target.value as TaskFilters['category'] })}><option value="">全部類型</option>{taskCategories.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="field">任務負責人<select value={taskFilters.assignment} onChange={event => updateTaskFilters({ ...taskFilters, assignment: event.target.value as TaskFilters['assignment'] })}><option value="all">全部任務</option><option value="unassigned">未指派負責人</option><option value="assigned">已指派負責人</option></select></label><label className="field">任務標籤<select value={taskFilters.label} onChange={event => updateTaskFilters({ ...taskFilters, label: event.target.value })}><option value="">全部標籤</option>{taskFilters.label && !taskLabels.includes(taskFilters.label) && <option value={taskFilters.label}>{taskFilters.label}（目前無此標籤）</option>}{taskLabels.map(label => <option key={label} value={label}>{label}</option>)}</select></label></section>
      <div className="discovery-feedback"><p role="status">顯示 {visibleIssues.length} / {activity.issues.length} 項任務</p><button className="btn btn-ghost" onClick={() => { updateTaskFilters({ ...emptyTaskFilters, assignment: 'unassigned' }); searchInput.current?.focus(); }}>查看未指派任務</button>{hasTaskFilters && <button className="btn btn-ghost" onClick={() => updateTaskFilters({ ...emptyTaskFilters })}>清除任務篩選</button>}</div>
      <div className="card-grid">{visibleIssues.map(issue => <article className="card stack expedition-issue" key={issue.number}><p className="eyebrow">任務 #{issue.number} · {categoriesForLabels(issue.labels).map(key => taskCategories.find(([value]) => value === key)?.[1]).join(' / ')}</p><h4>{issue.title}</h4><p className="muted">{issue.assignees.length ? `目前負責：${issue.assignees.join('、')}` : '尚未指派負責人；請先到任務頁留言協調。'}</p><div className="tag-list">{issue.labels.map(label => <span className="pill" key={label}>{label}</span>)}</div>{issue.body && <details><summary>閱讀任務內容</summary><p className="cocreation-copy">{issue.body}</p></details>}<div className="actions"><GitHubLink href={issue.url} primary>到任務頁參與</GitHubLink><button className="btn btn-ghost" disabled={briefLoading !== null} onClick={() => void copyBrief(issue)}>{briefLoading === String(issue.number) ? '準備工作說明…' : '複製工作說明'}</button></div></article>)}</div>{activity.issues.length === 0 ? <div className="discovery-empty"><p>目前沒有開放中的任務。</p><GitHubLink href={`${selected.repository_url}/issues/new`}>到 GitHub 提出任務</GitHubLink></div> : visibleIssues.length === 0 && <div className="discovery-empty"><h4>沒有符合條件的任務</h4><button className="btn btn-ghost" onClick={() => updateTaskFilters({ ...emptyTaskFilters })}>查看全部任務</button></div>}
      <section className="stack"><h3>已合併的貢獻</h3><p className="muted">以下依 GitHub 已合併的 PR 顯示，作者是 GitHub 帳號；尚未連結成平台會員的成果認證。</p><div className="card-grid">{activity.contributions.map(contribution => <article className="card stack expedition-contribution" key={contribution.number}><p className="eyebrow">已合併 · PR #{contribution.number}</p><h4>{contribution.title}</h4><p>GitHub 作者：{contribution.author}</p><p className="muted">{new Date(contribution.merged_at).toLocaleDateString('zh-TW')}</p><GitHubLink href={contribution.url}>查看修改與審查</GitHubLink></article>)}</div>{activity.contributions.length === 0 && <p className="muted">還沒有已合併的貢獻紀錄。第一步可以從一份說明、一個測試或一項修正開始。</p>}</section></>}
    </section>}
  </section>;
}
