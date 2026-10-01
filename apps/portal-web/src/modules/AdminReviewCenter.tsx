import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AdminClient } from './admin-client';
import {
  ADMIN_LINK_STATUS, CLAIM_HELD, CLAIM_UNAVAILABLE, GITHUB_REVIEW_LINK, PullFacts, ReviewQueueRow, SKILL_MAINTAINER_STATUS, modeText, pullClaimable,
  reviewerOptionLabel, reviewerOptionValue, scopeText, versionOf,
  type EligibleReviewer, type PullDetail, type PullRow,
} from './review-center-shared';
import './AdminReviewCenter.css';

type Viewer = {
  user_id: string | null; github_login: string | null; can_self_claim: boolean;
  status: 'ready' | 'no_member' | 'email_unverified' | 'no_github'; reason: string | null;
};
type Repo = {
  repository_id: string; full_name: string; mode: string; settings: Record<string, unknown>;
  aggregate_version: string | number; guild_key: string | null; scope_kind: string | null; open_to_guilds: boolean;
  skill_book_id: string | null;
};
type Summary = { counts: Record<string, number>; repositories: Repo[]; viewer: Viewer };
type AdminPerson = { admin_id: string; display_name: string; github_login: string | null; status: string };
type GuildDirectory = {
  guild_key: string; name: string;
  leader: { user_id: string; display_name: string; github_login: string | null } | null;
  repositories: { repository_id: string; full_name: string; scope_kind: string | null }[];
};
type RepoRef = { repository_id: string; full_name: string; scope_kind: string | null; skill_book_id?: string | null };
type SkillBookChoice = { skill_book_id: string; title: string };
type Directory = {
  admins: AdminPerson[]; guilds: GuildDirectory[]; open_repositories: RepoRef[];
  admin_only_repositories: RepoRef[]; guild_choices: { guild_key: string; name: string }[];
  skill_books?: Array<{ skill_book_id: string; title: string; maintainers: Array<{ user_id: string; display_name: string; github_login: string | null; status: string }> }>;
  skill_book_choices?: SkillBookChoice[];
};
type AdminDetail = PullDetail & { eligible_reviewers: EligibleReviewer[] };
type Page = { items: PullRow[]; next_offset: number | null };

const TABS = [
  ['awaiting_review', '待審'], ['in_review', '審核中'], ['mine', '我認領的'],
  ['waiting_ci', '等 CI'], ['author_action', '待作者'], ['needs_decision', '待決定'],
  ['ready', '已核准'], ['paused', '已暫停'], ['done', '已完成'],
] as const;
type QueueTab = typeof TABS[number][0];

export function AdminReviewCenter({ client, busy, onMutate }: {
  client: AdminClient;
  busy: boolean;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<QueueTab>('awaiting_review');
  const [repositoryId, setRepositoryId] = useState('');
  const [guildFilter, setGuildFilter] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [items, setItems] = useState<PullRow[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const viewRef = useRef({ tab, repositoryId, guildFilter });
  viewRef.current = { tab, repositoryId, guildFilter };

  const loadQueue = useCallback(async (queue: QueueTab, offset: number, repository: string, guild: string) => {
    const ticket = ++listSeq.current;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ queue, limit: '25', offset: String(offset) });
      if (repository) params.set('repository_id', repository);
      if (guild) params.set('guild_key', guild);
      const page = await client.request<Page>(`/review-center/pulls?${params.toString()}`);
      if (ticket !== listSeq.current) return;
      if (offset === 0) {
        const [nextSummary, people] = await Promise.all([
          client.request<Summary>('/review-center/summary'),
          client.request<Directory>('/review-center/reviewers'),
        ]);
        if (ticket !== listSeq.current) return;
        setSummary(nextSummary);
        setDirectory(people);
        setItems(page.items);
      } else {
        setItems(current => [...current, ...page.items]);
      }
      setNextOffset(page.next_offset);
    } catch (cause) {
      if (ticket !== listSeq.current) return;
      setError(cause instanceof Error ? cause.message : '無法載入審核佇列。');
    } finally {
      if (ticket === listSeq.current) setLoading(false);
    }
  }, [client]);

  const reloadDetail = useCallback(async (id: string) => {
    const ticket = ++detailSeq.current;
    try {
      const value = await client.request<AdminDetail>(`/review-center/pulls/${id}`);
      if (ticket !== detailSeq.current) return;
      setDetail(value);
      setOpenId(id);
    } catch (cause) {
      if (ticket !== detailSeq.current) return;
      setError(cause instanceof Error ? cause.message : '無法載入這個拉取請求。');
    }
  }, [client]);

  useEffect(() => {
    detailSeq.current += 1;
    void loadQueue(tab, 0, repositoryId, guildFilter);
  }, [loadQueue, tab, repositoryId, guildFilter]);

  async function choose(id: string) {
    if (openId === id) {
      detailSeq.current += 1;
      setOpenId(null);
      setDetail(null);
      return;
    }
    setDetail(null);
    setOpenId(id);
    await reloadDetail(id);
  }
  async function afterWrite(id: string | null) {
    const view = { tab, repositoryId, guildFilter };
    const before = listSeq.current;
    await loadQueue(view.tab, 0, view.repositoryId, view.guildFilter);
    const current = viewRef.current;
    if (!id || listSeq.current !== before + 1 || current.tab !== view.tab || current.repositoryId !== view.repositoryId || current.guildFilter !== view.guildFilter) return;
    await reloadDetail(id);
  }

  const counts = summary?.counts ?? {};
  const authorCount = (counts.needs_author ?? 0) + (counts.ci_not_run ?? 0);
  const countLine: Array<[string, number]> = [
    ['待審', counts.awaiting_review ?? 0], ['審核中', counts.in_review ?? 0], ['等 CI', counts.waiting_ci ?? 0],
    ['待作者', authorCount], ['待決定', counts.needs_decision ?? 0], ['已核准', counts.ready ?? 0],
  ];
  const guildChoices = directory?.guild_choices ?? [];

  return <section className="stack review-center">
    <div className="card-head"><h2>PR 審核</h2><button className="btn btn-ghost" type="button" disabled={busy || loading} onClick={() => void loadQueue(tab, 0, repositoryId, guildFilter)}>更新</button></div>
    <dl className="admin-summary review-counts" aria-label="審核概況">
      {countLine.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>
    {!!summary?.repositories.length && <ul className="review-modes" aria-label="儲存庫模式">
      {summary.repositories.map(repo => <li key={repo.repository_id}>{repo.full_name}　{modeText(repo.mode)}</li>)}
    </ul>}
    <div className="review-filters">
      <label className="field">儲存庫<select aria-label="儲存庫" value={repositoryId} onChange={event => { setItems([]); setOpenId(null); setDetail(null); setRepositoryId(event.target.value); }}><option value="">全部</option>{(summary?.repositories ?? []).map(repo => <option key={repo.repository_id} value={repo.repository_id}>{repo.full_name}</option>)}</select></label>
      <label className="field">歸屬<select aria-label="歸屬篩選" value={guildFilter} onChange={event => { setItems([]); setOpenId(null); setDetail(null); setGuildFilter(event.target.value); }}><option value="">全部</option><option value="none">無歸屬</option>{guildChoices.map(guild => <option key={guild.guild_key} value={guild.guild_key}>{guild.name}</option>)}</select></label>
    </div>
    <div className="actions" role="tablist" aria-label="審核佇列">
      {TABS.map(([key, label]) => <button type="button" role="tab" aria-selected={tab === key} key={key} className="btn btn-ghost" onClick={() => { if (tab !== key) { setItems([]); setOpenId(null); setDetail(null); setTab(key); } }}>{label}</button>)}
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {loading && <p role="status">正在載入審核佇列…</p>}
    <ul className="review-list" aria-label="拉取請求">
      {items.map(row => <ReviewQueueRow key={row.pull_id} row={row} open={openId === row.pull_id} onToggle={() => void choose(row.pull_id)}>
        {openId === row.pull_id && detail?.pull_id === row.pull_id && <ReviewDetail
          detail={detail} viewer={summary?.viewer ?? null} repo={(summary?.repositories ?? []).find(item => item.repository_id === detail.repository_id) ?? null}
          guilds={guildChoices} books={directory?.skill_book_choices ?? []} busy={busy} onError={setError} onMutate={onMutate} onDone={() => void afterWrite(row.pull_id)}
        />}
        {openId === row.pull_id && detail?.pull_id !== row.pull_id && <p role="status">正在載入細節…</p>}
      </ReviewQueueRow>)}
    </ul>
    {!loading && !items.length && !error && <p className="muted">這個佇列目前沒有拉取請求。</p>}
    {nextOffset !== null && <button type="button" className="btn btn-ghost" disabled={loading || busy} onClick={() => void loadQueue(tab, nextOffset, repositoryId, guildFilter)}>載入更多</button>}
    <SettingsBlock repositories={summary?.repositories ?? []} directory={directory} guilds={guildChoices} books={directory?.skill_book_choices ?? []} busy={busy} onMutate={onMutate} onSaved={() => void afterWrite(openId)} />
  </section>;
}

function ReviewDetail({ detail, viewer, repo, guilds, books, busy, onError, onMutate, onDone }: {
  detail: AdminDetail; viewer: Viewer | null; repo: Repo | null; guilds: { guild_key: string; name: string }[]; books: SkillBookChoice[]; busy: boolean;
  onError: (message: string) => void;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
  onDone: () => void;
}) {
  const people = detail.eligible_reviewers ?? [];
  const [assignValue, setAssignValue] = useState(people[0] ? reviewerOptionValue(people[0]) : '');
  const [assignReason, setAssignReason] = useState('');
  const [releaseReason, setReleaseReason] = useState('');
  const [pauseReason, setPauseReason] = useState('');
  const [showAssign, setShowAssign] = useState(false);
  const [showRelease, setShowRelease] = useState(false);
  const [showPause, setShowPause] = useState(false);
  const [showOwnership, setShowOwnership] = useState(false);
  function closeForms() {
    setShowAssign(false);
    setShowRelease(false);
    setShowPause(false);
    setShowOwnership(false);
    setAssignReason('');
    setReleaseReason('');
    setPauseReason('');
  }
  const version = versionOf(detail.aggregate_version);
  const claimBlock = detail.claim ? CLAIM_HELD : '';
  const unavailable = !pullClaimable(detail);
  const selfBlock = viewer?.can_self_claim ? '' : (viewer?.reason ?? '');
  function saved(ok: boolean) {
    if (!ok) return;
    closeForms();
    onDone();
  }
  async function claim() {
    saved(await onMutate(`/review-center/pulls/${detail.pull_id}/claim`, {}, version));
  }
  async function assign(event: FormEvent) {
    event.preventDefault();
    if (assignReason.trim().length < 3) { onError('請填寫至少 3 個字的指派理由。'); return; }
    const [userId, actingAs, guildKey, skillBookId = ''] = assignValue.split('|');
    if (!userId || (actingAs !== 'admin' && actingAs !== 'guild_leader' && actingAs !== 'skill_book_maintainer')) { onError('請先選擇審查人。'); return; }
    saved(await onMutate(`/review-center/pulls/${detail.pull_id}/assign`, {
      user_id: userId, acting_as: actingAs, guild_key: actingAs === 'guild_leader' ? guildKey : null,
      skill_book_id: actingAs === 'skill_book_maintainer' ? skillBookId : null, reason: assignReason.trim(),
    }, version));
  }
  async function release(event: FormEvent) {
    event.preventDefault();
    if (!detail.claim) return;
    if (releaseReason.trim().length < 3) { onError('請填寫至少 3 個字的放棄理由。'); return; }
    saved(await onMutate(`/review-center/claims/${detail.claim.claim_id}/release`, { reason: releaseReason.trim() }, versionOf(detail.claim.aggregate_version)));
  }
  async function pause(event: FormEvent) {
    event.preventDefault();
    if (pauseReason.trim().length < 3) { onError('請填寫至少 3 個字的理由。'); return; }
    const path = detail.paused ? 'resume' : 'pause';
    saved(await onMutate(`/review-center/pulls/${detail.pull_id}/${path}`, { reason: pauseReason.trim() }, version));
  }
  return <>
    <PullFacts detail={detail} />
    <div className="review-detail stack">
      <div className="actions review-actions">
        <button type="button" className="btn btn-ghost" disabled={busy || unavailable || !!selfBlock || !!claimBlock} onClick={() => void claim()}>我來審</button>
        <button type="button" className="btn btn-ghost" disabled={busy || unavailable || !!claimBlock} onClick={() => setShowAssign(value => !value)}>指派給…</button>
        {detail.claim && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setShowRelease(value => !value)}>放棄認領</button>}
        <a className="btn btn-ghost" href={`${detail.html_url}/files`} target="_blank" rel="noopener noreferrer">{GITHUB_REVIEW_LINK}</a>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setShowPause(value => !value)}>{detail.paused ? '恢復' : '暫停'}</button>
        <button type="button" className="btn btn-ghost" disabled={busy || !repo} onClick={() => setShowOwnership(value => !value)}>變更歸屬…</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onMutate(`/review-center/pulls/${detail.pull_id}/resync`, {}).then(saved)}>重新同步</button>
      </div>
      {unavailable && <p className="field-hint">{CLAIM_UNAVAILABLE}</p>}
      {!!selfBlock && <p className="field-hint">{selfBlock}</p>}
      {!!claimBlock && <p className="field-hint">{claimBlock}</p>}
      {showAssign && <form className="stack" onSubmit={event => void assign(event)}>
        <label className="field">審查人<select aria-label="審查人" value={assignValue} onChange={event => setAssignValue(event.target.value)}>{people.map(person => <option key={reviewerOptionValue(person)} value={reviewerOptionValue(person)}>{reviewerOptionLabel(person)}</option>)}{!people.length && <option value="">目前沒有可指派的公會長、技能書維護者或管理員</option>}</select></label>
        <label className="field">指派理由<input value={assignReason} onChange={event => setAssignReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
        <div className="actions"><button className="btn btn-primary" disabled={busy}>確認指派</button></div>
      </form>}
      {showRelease && detail.claim && <form className="stack" onSubmit={event => void release(event)}>
        <label className="field">放棄理由<input value={releaseReason} onChange={event => setReleaseReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
        <div className="actions"><button className="btn btn-primary" disabled={busy}>確認放棄認領</button></div>
      </form>}
      {showPause && <form className="stack" onSubmit={event => void pause(event)}>
        <label className="field">{detail.paused ? '恢復理由' : '暫停理由'}<input value={pauseReason} onChange={event => setPauseReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
        <div className="actions"><button className="btn btn-primary" disabled={busy}>{detail.paused ? '確認恢復' : '確認暫停'}</button></div>
      </form>}
      {showOwnership && repo && <OwnershipForm repo={repo} guilds={guilds} books={books} busy={busy} hint={`會套用到整個 ${repo.full_name}。`} onMutate={onMutate} onSaved={() => saved(true)} />}
    </div>
  </>;
}

function SettingsBlock({ repositories, directory, guilds, books, busy, onMutate, onSaved }: {
  repositories: Repo[]; directory: Directory | null; guilds: { guild_key: string; name: string }[]; books: SkillBookChoice[]; busy: boolean;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
  onSaved: () => void;
}) {
  return <details className="review-settings">
    <summary>儲存庫設定</summary>
    <div className="stack">
      <p className="field-hint">新鏡像的儲存庫沒有公會，預設開放公會長認領；要改成只限管理員，請改「歸屬」。</p>
      {repositories.map(repo => <article className="card stack" key={`${repo.repository_id}-${repo.aggregate_version}`}>
        <h3>{repo.full_name}</h3>
        <p className="muted">目前模式 {modeText(repo.mode)} · 歸屬 {repo.guild_key ? (guilds.find(guild => guild.guild_key === repo.guild_key)?.name ?? repo.guild_key) : repo.open_to_guilds ? '開放認領' : '只限管理員'} · {scopeText(repo.scope_kind)}</p>
        <RepoForm repo={repo} busy={busy} onMutate={onMutate} onSaved={onSaved} />
        <OwnershipForm repo={repo} guilds={guilds} books={books} busy={busy} onMutate={onMutate} onSaved={onSaved} />
      </article>)}
      {!repositories.length && <p className="muted">還沒有儲存庫。</p>}
      <ReviewerDirectory directory={directory} />
    </div>
  </details>;
}

function knownSettings(stored: Record<string, unknown>, claimHours: string, requestReviewers: boolean, requiredCheck: string, appSlug: string, holds: string) {
  const settings: Record<string, unknown> = {
    request_reviewers: requestReviewers,
    required_check: requiredCheck.trim(),
    required_check_app_slug: appSlug.trim(),
    hold_labels: holds.split(',').map(item => item.trim()).filter(Boolean),
  };
  if (claimHours.trim() !== '') settings.claim_hours = Number(claimHours);
  if (stored.rules_profile === 'freedom-platform' || stored.rules_profile === 'default') settings.rules_profile = stored.rules_profile;
  if (typeof stored.ci_grace_minutes === 'number') settings.ci_grace_minutes = stored.ci_grace_minutes;
  if (typeof stored.migrations_dir === 'string') settings.migrations_dir = stored.migrations_dir;
  return settings;
}

function RepoForm({ repo, busy, onMutate, onSaved }: {
  repo: Repo; busy: boolean;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
  onSaved: () => void;
}) {
  const stored = repo.settings ?? {};
  const initialHours = typeof stored.claim_hours === 'number' ? String(stored.claim_hours) : '';
  const [mode, setMode] = useState(repo.mode === 'off' || repo.mode === 'observe' ? repo.mode : 'observe');
  const [claimHours, setClaimHours] = useState(initialHours);
  const [requestReviewers, setRequestReviewers] = useState(stored.request_reviewers !== false);
  const [requiredCheck, setRequiredCheck] = useState(String(stored.required_check ?? 'verify'));
  const [appSlug, setAppSlug] = useState(String(stored.required_check_app_slug ?? 'github-actions'));
  const [holds, setHolds] = useState(Array.isArray(stored.hold_labels) ? (stored.hold_labels as string[]).join(', ') : 'hold, do-not-merge');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    const trimmed = claimHours.trim();
    if (trimmed !== '') {
      const hours = Number(trimmed);
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) { setError('認領時效要是 1 到 168 的整數，或留空表示不自動釋放。'); return; }
    }
    if (reason.trim().length < 3) { setError('請填寫至少 3 個字的調整理由。'); return; }
    setError('');
    if (await onMutate(`/review-center/repositories/${repo.repository_id}/settings`, {
      mode, settings: knownSettings(stored, claimHours, requestReviewers, requiredCheck, appSlug, holds), reason: reason.trim(),
    }, versionOf(repo.aggregate_version))) onSaved();
  }
  return <form className="stack" onSubmit={event => void save(event)}>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    <label className="field">模式<select value={mode} onChange={event => setMode(event.target.value)}><option value="off">關閉</option><option value="observe">觀察</option></select></label>
    <label className="field">認領時效（小時）<input inputMode="numeric" value={claimHours} placeholder="不自動釋放" onChange={event => setClaimHours(event.target.value)} /></label>
    <label className="checkbox-row"><input type="checkbox" checked={requestReviewers} onChange={event => setRequestReviewers(event.target.checked)} />把認領寫成 GitHub 請求審查</label>
    <p className="field-hint">預設勾選：認領或指派時，在 GitHub 把審核人設成 requested reviewer。Worker 變數 GITHUB_MAINTAINER_WRITES 是 requested_reviewers 時才會寫入；GitHub 拒絕時只記下原因，不影響認領。</p>
    <label className="field">必要檢查<input value={requiredCheck} onChange={event => setRequiredCheck(event.target.value)} maxLength={100} /></label>
    <label className="field">檢查 App<input value={appSlug} onChange={event => setAppSlug(event.target.value)} maxLength={100} /></label>
    <label className="field">保留標籤（逗號分隔，空白表示不使用）<input value={holds} onChange={event => setHolds(event.target.value)} /></label>
    <label className="field">調整理由<input value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
    <div className="actions"><button className="btn btn-primary" disabled={busy}>儲存設定</button></div>
  </form>;
}

export function ownershipChoice(ownership: { guild_key: string | null; open_to_guilds: boolean }): string {
  if (ownership.guild_key) return ownership.guild_key;
  return ownership.open_to_guilds ? 'open' : 'admin';
}

function OwnershipForm({ repo, guilds, books, busy, hint, onMutate, onSaved }: {
  repo: Repo; guilds: { guild_key: string; name: string }[]; books: SkillBookChoice[]; busy: boolean; hint?: string;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState(ownershipChoice(repo));
  const [scope, setScope] = useState(repo.scope_kind ?? '');
  const [bookId, setBookId] = useState(repo.skill_book_id ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) { setError('請填寫至少 3 個字的歸屬理由。'); return; }
    const guildKey = choice === 'admin' || choice === 'open' ? null : choice;
    const open = choice === 'open';
    const scopeKind = scope === 'module' || scope === 'skill_book' ? scope : null;
    const skillBookId = scopeKind === 'skill_book' && bookId ? bookId : null;
    if (guildKey === repo.guild_key && open === repo.open_to_guilds && scopeKind === repo.scope_kind && skillBookId === (repo.skill_book_id ?? null)) { setError('歸屬沒有變更。'); return; }
    setError('');
    if (await onMutate(`/review-center/repositories/${repo.repository_id}/ownership`, {
      guild_key: guildKey, scope_kind: scopeKind, open_to_guilds: open, skill_book_id: skillBookId, reason: reason.trim(),
    }, versionOf(repo.aggregate_version))) onSaved();
  }
  return <form className="stack" onSubmit={event => void save(event)}>
    <h4>歸屬</h4>
    {hint && <p className="field-hint">{hint}</p>}
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    <label className="field">歸屬<select aria-label="歸屬" value={choice} onChange={event => setChoice(event.target.value)}><option value="admin">只限管理員</option><option value="open">開放公會長認領</option>{guilds.map(guild => <option key={guild.guild_key} value={guild.guild_key}>{guild.name}</option>)}</select></label>
    <label className="field">類型<select aria-label="類型" value={scope} onChange={event => setScope(event.target.value)}><option value="">未分類</option><option value="module">模組</option><option value="skill_book">技能書</option></select></label>
    {scope === 'skill_book' && <label className="field">技能書<select aria-label="技能書" value={bookId} onChange={event => setBookId(event.target.value)}><option value="">不指定</option>{books.map(book => <option key={book.skill_book_id} value={book.skill_book_id}>{book.title}</option>)}</select></label>}
    <label className="field">歸屬理由<input value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
    <div className="actions"><button className="btn btn-primary" disabled={busy}>儲存歸屬</button></div>
  </form>;
}

function repoLine(repo: RepoRef): string {
  return `${repo.full_name}（${scopeText(repo.scope_kind)}）`;
}

function ReviewerDirectory({ directory }: { directory: Directory | null }) {
  if (!directory) return <p className="muted">正在載入審核人…</p>;
  return <section className="stack" aria-label="審核人">
    <h3>審核人</h3>
    <h4>管理員</h4>
    {directory.admins.length ? <ul>{directory.admins.map(person => <li key={person.admin_id}>{person.display_name}{person.github_login ? ` @${person.github_login}` : ''} · {ADMIN_LINK_STATUS[person.status] ?? person.status}</li>)}</ul> : <p className="muted">沒有啟用中的管理員。</p>}
    <h4>公會</h4>
    {directory.guilds.length ? directory.guilds.map(guild => <article key={guild.guild_key}>
      <p><strong>{guild.name}</strong></p>
      <p>{guild.leader ? `${guild.leader.display_name}${guild.leader.github_login ? ` @${guild.leader.github_login}` : ' · 尚未連結 GitHub'}` : '尚未任命公會長'}</p>
      {guild.repositories.length ? <ul>{guild.repositories.map(repo => <li key={repo.repository_id}>{repoLine(repo)}</li>)}</ul> : <p className="muted">還沒有歸到這個公會的儲存庫。</p>}
    </article>) : <p className="muted">還沒有已任命公會長或已歸屬的公會。</p>}
    <h4>開放公會長認領</h4>
    {directory.open_repositories.length ? <ul>{directory.open_repositories.map(repo => <li key={repo.repository_id}>{repoLine(repo)}</li>)}</ul> : <p className="muted">沒有開放認領的儲存庫。</p>}
    <h4>只限管理員</h4>
    {directory.admin_only_repositories.length ? <ul>{directory.admin_only_repositories.map(repo => <li key={repo.repository_id}>{repoLine(repo)}</li>)}</ul> : <p className="muted">沒有只限管理員的儲存庫。</p>}
    <h4>技能書維護者</h4>
    {directory.skill_books?.length ? directory.skill_books.map(book => <article key={book.skill_book_id}>
      <p><strong>{book.title}</strong></p>
      <ul>{book.maintainers.map(person => <li key={person.user_id}>{person.display_name}{person.github_login ? ` @${person.github_login}` : ''} · {SKILL_MAINTAINER_STATUS[person.status] ?? person.status}</li>)}</ul>
    </article>) : <p className="muted">還沒有任命技能書維護者。</p>}
  </section>;
}
