import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AdminClient } from './admin-client';
import './AdminReviewCenter.css';

type Reason = { code: string; message: string; paths?: string[] };
type Claim = {
  claim_id: string; reviewer_id: string; reviewer_login: string; assignment: string; claimed_by: string;
  created_at: string; expires_at: string; head_sha: string; github_request_state: string;
  github_request_error: string | null; aggregate_version: string | number;
};
type HistoryClaim = Claim & { state: string; end_reason: string | null; ended_at: string | null };
type CheckRow = { name: string; status: string; conclusion: string | null; head_sha: string; source?: string };
type PullRow = {
  pull_id: string; full_name: string; number: number; title: string; html_url: string; queue_state: string;
  risk_class: string; author_login: string; author_association: string | null; author_type: string | null;
  is_fork: boolean; paused: boolean; sla_due_at: string | null; head_sha: string; aggregate_version: string | number;
  first_risk_reason: Reason | null; first_queue_reason: Reason | null; claim: Claim | null; required_check: CheckRow | null;
};
type FileRow = { path: string; previous_path: string | null; status: string; additions: number; deletions: number; risk_reasons: Reason[] };
type ReviewRow = {
  github_review_id: string; reviewer_login: string; state: string; commit_id: string | null; submitted_at: string;
  is_current_head: boolean; counts_as_valid: boolean;
};
type PullDetail = PullRow & {
  state: string; is_draft: boolean; mode: string;
  files: FileRow[]; checks: CheckRow[]; reviews: ReviewRow[]; queue_reasons: Reason[]; claims: HistoryClaim[];
  risk_reasons: Reason[];
};
type Viewer = { github_login: string | null; reviewer_id: string | null; max_risk: string | null; reason: string | null };
type Repo = { repository_id: string; full_name: string; mode: string; settings: Record<string, unknown>; aggregate_version: string | number };
type Summary = { counts: Record<string, number>; repositories: Repo[]; viewer: Viewer };
type Reviewer = { reviewer_id: string; display_name: string; github_login: string; max_risk: string; active: boolean; aggregate_version: string | number };
type Candidate = { user_id: string; display_name: string; github_login: string; active_reviewer: boolean };
type Page = { items: PullRow[]; next_offset: number | null };

const TABS = [
  ['awaiting_review', '待審'], ['in_review', '審核中'], ['mine', '我認領的'],
  ['waiting_ci', '等 CI'], ['author_action', '待作者'], ['needs_owner', '需要擁有者'],
  ['ready', '已核准'], ['paused', '已暫停'], ['done', '已完成'],
] as const;
type QueueTab = typeof TABS[number][0];

const QUEUE_LABEL: Record<string, string> = {
  awaiting_review: '待審', in_review: '審核中', waiting_ci: '等 CI', needs_author: '待作者', ci_not_run: '待作者',
  needs_owner: '需要擁有者', ready: '已核准', paused: '已暫停', draft: '草稿', merged: '已合併', closed: '已關閉',
};
const RISK_LABEL: Record<string, string> = { low: '低風險', medium: '中風險', high: '高風險' };
const CLAIM_STATE: Record<string, string> = { active: '認領中', released: '已釋放', expired: '已到期', completed: '已完成' };
const END_REASON: Record<string, string> = {
  admin_released: '已手動釋放', pull_closed: '拉取請求已關閉', reviewer_inactive: '審查者已停用',
  reviewer_rank_too_low: '風險上限不足', review_submitted: '已送出審查',
};
const REVIEW_STATE: Record<string, string> = {
  APPROVED: '核准', CHANGES_REQUESTED: '要求修改', COMMENTED: '留言', DISMISSED: '已撤銷', PENDING: '未送出',
};
const GITHUB_REQUEST: Record<string, string> = {
  pending: '等待寫入 GitHub', requested: '已在 GitHub 請求審查', skipped: '沒有寫入 GitHub',
  removing: '正在移除 GitHub 請求', removed: '已移除 GitHub 請求', failed: 'GitHub 寫入失敗',
};
const GITHUB_ERROR: Record<string, string> = {
  github_permission_missing: 'GitHub App 還沒有寫入權限',
  writes_disabled: '寫入已關閉，GitHub 上可能還留著這個審查請求',
  github_http_422: 'GitHub 拒絕了，這個帳號可能不是協作者',
};
const CLAIM_UNAVAILABLE = '這個拉取請求目前未開啟、仍是草稿或已暫停（包括儲存庫已關閉），不能認領。';
const MODE_LABEL: Record<string, string> = { off: '關閉', observe: '觀察' };

function versionOf(value: string | number): number {
  return Number(value);
}
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
function countdown(target: string | null, empty: string): string {
  if (!target) return empty;
  const ms = Date.parse(target) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return target === empty ? empty : '已逾期';
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `剩餘 ${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `剩餘 ${hours} 小時`;
  return `剩餘 ${Math.floor(hours / 24)} 天`;
}
function claimLeft(expires: string): string {
  const ms = Date.parse(expires) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '已到期';
  return countdown(expires, '已到期').replace('已逾期', '已到期');
}
function slaText(due: string | null): string {
  if (!due) return '沒有期限';
  return countdown(due, '沒有期限');
}
function checkText(check: CheckRow | null): string {
  if (!check) return '尚未出現';
  if (check.status !== 'completed') return '進行中';
  if (check.conclusion === 'success' || check.conclusion === 'neutral') return '已通過';
  if (check.conclusion === 'action_required') return '等待核准';
  return '未通過';
}
function modeText(mode: string): string {
  return MODE_LABEL[mode] ?? mode;
}
function riskBadgeClass(risk: string): string {
  if (risk === 'low') return 'badge badge-ok';
  if (risk === 'high') return 'badge badge-alert';
  return 'badge';
}
function queueBadgeClass(state: string): string {
  return state === 'ready' ? 'badge badge-ok' : 'badge';
}
function reviewStateLabel(state: string): string {
  return REVIEW_STATE[state] ?? state;
}
function claimSummary(claim: HistoryClaim): string {
  const how = claim.assignment === 'assigned' ? `由 ${claim.claimed_by} 指派` : '自己認領';
  const ended = claim.state !== 'active' ? END_REASON[claim.end_reason ?? ''] : undefined;
  const parts = [claim.reviewer_login, how, ended ?? CLAIM_STATE[claim.state] ?? claim.state];
  if (claim.github_request_state !== 'not_requested') {
    const github = GITHUB_REQUEST[claim.github_request_state];
    if (github) {
      const reason = claim.github_request_state === 'failed' ? GITHUB_ERROR[claim.github_request_error ?? ''] : '';
      parts.push(reason ? `${github}，${reason}` : github);
    }
  }
  return parts.join(' ');
}
function pullClaimable(detail: { state: string; is_draft: boolean; paused: boolean; mode: string }): boolean {
  return detail.state === 'open' && !detail.is_draft && !detail.paused && detail.mode !== 'off';
}
function authorBadges(row: { author_association: string | null; author_type: string | null; is_fork: boolean }) {
  const badges: string[] = [];
  if (row.author_association === 'FIRST_TIME_CONTRIBUTOR' || row.author_association === 'FIRST_TIMER') badges.push('首次貢獻');
  if (row.is_fork) badges.push('fork');
  if (row.author_type === 'Bot') badges.push('Bot');
  return badges;
}

export function AdminReviewCenter({ client, busy, onMutate }: {
  client: AdminClient;
  busy: boolean;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<QueueTab>('awaiting_review');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [items, setItems] = useState<PullRow[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PullDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const listSeq = useRef(0);
  const detailSeq = useRef(0);

  const loadQueue = useCallback(async (queue: QueueTab, offset: number) => {
    const ticket = ++listSeq.current;
    setLoading(true);
    setError('');
    try {
      const pagePath = `/review-center/pulls?queue=${queue}&limit=25&offset=${offset}`;
      const page = await client.request<Page>(pagePath);
      if (ticket !== listSeq.current) return;
      if (offset === 0) {
        const [nextSummary, people] = await Promise.all([
          client.request<Summary>('/review-center/summary'),
          client.request<{ items: Reviewer[] }>('/review-center/reviewers'),
        ]);
        if (ticket !== listSeq.current) return;
        setSummary(nextSummary);
        setReviewers(people.items);
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
      const value = await client.request<PullDetail>(`/review-center/pulls/${id}`);
      if (ticket !== detailSeq.current) return;
      setDetail(value);
      setOpenId(id);
    } catch (cause) {
      if (ticket !== detailSeq.current) return;
      setError(cause instanceof Error ? cause.message : '無法載入這個拉取請求。');
    }
  }, [client]);

  useEffect(() => { void loadQueue(tab, 0); }, [loadQueue, tab]);

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
    await loadQueue(tab, 0);
    if (id) await reloadDetail(id);
  }

  const counts = summary?.counts ?? {};
  const authorCount = (counts.needs_author ?? 0) + (counts.ci_not_run ?? 0);
  const countLine: Array<[string, number]> = [
    ['待審', counts.awaiting_review ?? 0], ['審核中', counts.in_review ?? 0], ['等 CI', counts.waiting_ci ?? 0],
    ['待作者', authorCount], ['需要擁有者', counts.needs_owner ?? 0], ['已核准', counts.ready ?? 0],
  ];

  return <section className="stack review-center">
    <div className="card-head"><h2>PR 審核</h2><button className="btn btn-ghost" type="button" disabled={busy || loading} onClick={() => void loadQueue(tab, 0)}>更新</button></div>
    <dl className="admin-summary review-counts" aria-label="審核概況">
      {countLine.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>
    {!!summary?.repositories.length && <ul className="review-modes" aria-label="儲存庫模式">
      {summary.repositories.map(repo => <li key={repo.repository_id}>{repo.full_name}　{modeText(repo.mode)}</li>)}
    </ul>}
    <div className="actions" role="tablist" aria-label="審核佇列">
      {TABS.map(([key, label]) => <button type="button" role="tab" aria-selected={tab === key} key={key} className={tab === key ? 'btn btn-primary' : 'btn btn-ghost'} onClick={() => { if (tab !== key) { setItems([]); setOpenId(null); setDetail(null); setTab(key); } }}>{label}</button>)}
    </div>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {loading && <p role="status">正在載入審核佇列…</p>}
    <ul className="review-list" aria-label="拉取請求">
      {items.map(row => <li key={row.pull_id} className="review-row" data-pull-id={row.pull_id}>
        <div className="review-row-main">
          <div className="review-title">
            <a href={row.html_url} target="_blank" rel="noopener noreferrer">{row.full_name}#{row.number} {row.title}</a>
            <span className={queueBadgeClass(row.queue_state)}>{QUEUE_LABEL[row.queue_state] ?? row.queue_state}</span>
          </div>
          <p>{row.author_login}{authorBadges(row).map(badge => <Fragment key={badge}>{' '}<span className="badge">{badge}</span></Fragment>)}</p>
          <p><span className={riskBadgeClass(row.risk_class)}>{RISK_LABEL[row.risk_class] ?? row.risk_class}</span> {row.first_risk_reason?.message ?? '沒有風險說明'}{(row.first_risk_reason?.paths ?? []).slice(0, 3).map(path => <span className="review-path" key={path}>{path}</span>)}</p>
          <p>必要檢查 {row.required_check?.name ?? 'verify'} {shortSha(row.head_sha)} {checkText(row.required_check)}</p>
          <p>{row.claim ? `${row.claim.reviewer_login} ${claimLeft(row.claim.expires_at)}` : '無人認領'}</p>
          <p>期限 {slaText(row.sla_due_at)}</p>
          <p>下一步 {row.first_queue_reason?.message ?? '沒有下一步說明'}</p>
          <button type="button" className="btn btn-ghost" aria-expanded={openId === row.pull_id} onClick={() => void choose(row.pull_id)}>{openId === row.pull_id ? '收合' : '詳情'}</button>
        </div>
        {openId === row.pull_id && detail?.pull_id === row.pull_id && <ReviewDetail
          detail={detail} viewer={summary?.viewer ?? null} reviewers={reviewers.filter(person => person.active)} busy={busy}
          onError={setError} onMutate={onMutate} onDone={() => void afterWrite(row.pull_id)}
        />}
        {openId === row.pull_id && detail?.pull_id !== row.pull_id && <p role="status">正在載入細節…</p>}
      </li>)}
    </ul>
    {!loading && !items.length && !error && <p className="muted">這個佇列目前沒有拉取請求。</p>}
    {nextOffset !== null && <button type="button" className="btn btn-ghost" disabled={loading || busy} onClick={() => void loadQueue(tab, nextOffset)}>載入更多</button>}
    <SettingsBlock client={client} repositories={summary?.repositories ?? []} reviewers={reviewers} busy={busy} onMutate={onMutate} onSaved={() => void afterWrite(openId)} />
  </section>;
}

function ReviewDetail({ detail, viewer, reviewers, busy, onError, onMutate, onDone }: {
  detail: PullDetail; viewer: Viewer | null; reviewers: Reviewer[]; busy: boolean;
  onError: (message: string) => void;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
  onDone: () => void;
}) {
  const [assignId, setAssignId] = useState(reviewers[0]?.reviewer_id ?? '');
  const [assignReason, setAssignReason] = useState('');
  const [releaseReason, setReleaseReason] = useState('');
  const [pauseReason, setPauseReason] = useState('');
  const [showAssign, setShowAssign] = useState(false);
  const [showRelease, setShowRelease] = useState(false);
  const [showPause, setShowPause] = useState(false);
  const version = versionOf(detail.aggregate_version);
  const claimBlock = detail.claim ? '這個拉取請求已有人認領。' : '';
  const unavailable = !pullClaimable(detail);
  const selfBlock = viewer?.reason ?? '';
  const groups = new Map<string, { message: string; files: FileRow[] }>();
  const other: FileRow[] = [];
  for (const file of detail.files) {
    if (!file.risk_reasons?.length) { other.push(file); continue; }
    for (const reason of file.risk_reasons) {
      const group = groups.get(reason.code) ?? { message: reason.message, files: [] };
      group.files.push(file);
      groups.set(reason.code, group);
    }
  }
  async function claim() {
    if (await onMutate(`/review-center/pulls/${detail.pull_id}/claim`, {}, version)) onDone();
  }
  async function assign(event: FormEvent) {
    event.preventDefault();
    if (assignReason.trim().length < 3) { onError('請填寫至少 3 個字的指派理由。'); return; }
    if (!assignId) { onError('請先選擇審查者。'); return; }
    if (await onMutate(`/review-center/pulls/${detail.pull_id}/assign`, { reviewer_id: assignId, reason: assignReason.trim() }, version)) onDone();
  }
  async function release(event: FormEvent) {
    event.preventDefault();
    if (!detail.claim) return;
    if (releaseReason.trim().length < 3) { onError('請填寫至少 3 個字的放棄理由。'); return; }
    if (await onMutate(`/review-center/claims/${detail.claim.claim_id}/release`, { reason: releaseReason.trim() }, versionOf(detail.claim.aggregate_version))) onDone();
  }
  async function pause(event: FormEvent) {
    event.preventDefault();
    if (pauseReason.trim().length < 3) { onError('請填寫至少 3 個字的理由。'); return; }
    const path = detail.paused ? 'resume' : 'pause';
    if (await onMutate(`/review-center/pulls/${detail.pull_id}/${path}`, { reason: pauseReason.trim() }, version)) onDone();
  }
  return <div className="review-detail stack">
    <div>
      <h3>變更檔案</h3>
      {[...groups.values()].map(group => <div key={group.message}><p>{group.message}</p><ul>{group.files.map(file => <li key={`${group.message}-${file.path}`}>{file.path}</li>)}</ul></div>)}
      {!!other.length && <div><p>其他檔案</p><ul>{other.map(file => <li key={file.path}>{file.path}</li>)}</ul></div>}
      {!detail.files.length && <p className="muted">沒有檔案紀錄。</p>}
    </div>
    <div>
      <h3>檢查</h3>
      {detail.checks.length ? <ul>{detail.checks.map(check => <li key={`${check.source ?? ''}-${check.name}-${check.head_sha}`}>{check.name} {shortSha(check.head_sha)} {checkText(check)}</li>)}</ul> : <p className="muted">沒有檢查紀錄。</p>}
    </div>
    <div>
      <h3>審查紀錄</h3>
      {detail.reviews.length ? <ul>{detail.reviews.map(review => <li key={review.github_review_id}>{review.reviewer_login} {reviewStateLabel(review.state)} {review.commit_id ? shortSha(review.commit_id) : '沒有提交'}{!review.is_current_head && <>{' '}<span className="badge">舊提交</span></>} <span className={review.counts_as_valid ? 'badge badge-ok' : 'badge'}>{review.counts_as_valid ? '算有效核准' : '不算有效核准'}</span></li>)}</ul> : <p className="muted">還沒有審查。</p>}
    </div>
    <div>
      <h3>佇列原因</h3>
      <ul>{(detail.queue_reasons ?? []).map(reason => <li key={reason.code}>{reason.message}</li>)}</ul>
    </div>
    <div>
      <h3>最近認領</h3>
      {detail.claims.length ? <ul>{detail.claims.map(claim => <li key={claim.claim_id}>{claimSummary(claim)}</li>)}</ul> : <p className="muted">還沒有認領。</p>}
    </div>
    <div className="actions review-actions">
      <button type="button" className="btn btn-ghost" disabled={busy || unavailable || !!selfBlock || !!claimBlock} onClick={() => void claim()}>我來審</button>
      <button type="button" className="btn btn-ghost" disabled={busy || unavailable || !!claimBlock} onClick={() => setShowAssign(value => !value)}>指派給…</button>
      {detail.claim && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setShowRelease(value => !value)}>放棄認領</button>}
      <a className="btn btn-ghost" href={`${detail.html_url}/files`} target="_blank" rel="noopener noreferrer">在 GitHub 審核</a>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setShowPause(value => !value)}>{detail.paused ? '恢復' : '暫停自動處理'}</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onMutate(`/review-center/pulls/${detail.pull_id}/resync`, {}).then(ok => { if (ok) onDone(); })}>重新同步</button>
    </div>
    {unavailable && <p className="field-hint">{CLAIM_UNAVAILABLE}</p>}
    {!!selfBlock && <p className="field-hint">{selfBlock}</p>}
    {!!claimBlock && <p className="field-hint">{claimBlock}</p>}
    {showAssign && <form className="stack" onSubmit={event => void assign(event)}>
      <label className="field">審查者<select value={assignId} onChange={event => setAssignId(event.target.value)}>{reviewers.map(person => <option key={person.reviewer_id} value={person.reviewer_id}>{person.github_login}（{RISK_LABEL[person.max_risk] ?? person.max_risk}）</option>)}{!reviewers.length && <option value="">沒有啟用中的審查者</option>}</select></label>
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
  </div>;
}

function SettingsBlock({ client, repositories, reviewers, busy, onMutate, onSaved }: {
  client: AdminClient; repositories: Repo[]; reviewers: Reviewer[]; busy: boolean;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
  onSaved: () => void;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState('');
  const [maxRisk, setMaxRisk] = useState('medium');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const candidateSeq = useRef(0);
  async function search(event: FormEvent) {
    event.preventDefault();
    const ticket = ++candidateSeq.current;
    setError('');
    try {
      const value = await client.request<{ items: Candidate[] }>(`/review-center/reviewer-candidates?q=${encodeURIComponent(query.trim())}`);
      if (ticket !== candidateSeq.current) return;
      setCandidates(value.items);
    } catch (cause) {
      if (ticket !== candidateSeq.current) return;
      setError(cause instanceof Error ? cause.message : '無法搜尋審查者。');
    }
  }
  async function appoint(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) { setError('請填寫至少 3 個字的任命理由。'); return; }
    if (!picked) { setError('請先選擇會員。'); return; }
    if (await onMutate('/review-center/reviewers', { user_id: picked, max_risk: maxRisk, reason: reason.trim() })) {
      setReason('');
      onSaved();
    }
  }
  return <details className="review-settings">
    <summary>儲存庫與審查者設定</summary>
    <div className="stack">
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {repositories.map(repo => <RepoForm key={`${repo.repository_id}-${repo.aggregate_version}`} repo={repo} busy={busy} onMutate={onMutate} onSaved={onSaved} />)}
      {!repositories.length && <p className="muted">還沒有儲存庫。</p>}
      <h3>審查者</h3>
      {reviewers.map(person => <ReviewerForm key={`${person.reviewer_id}-${person.aggregate_version}`} reviewer={person} busy={busy} onMutate={onMutate} onSaved={onSaved} />)}
      {!reviewers.length && <p className="muted">還沒有審查者。</p>}
      <form className="stack" onSubmit={event => void search(event)}>
        <label className="field">搜尋可任命的會員<input value={query} onChange={event => setQuery(event.target.value)} maxLength={100} /></label>
        <div className="actions"><button className="btn btn-ghost" disabled={busy}>搜尋</button></div>
      </form>
      {!!candidates.length && <form className="stack" onSubmit={event => void appoint(event)}>
        <label className="field">人選<select value={picked} onChange={event => setPicked(event.target.value)}><option value="">請選擇</option>{candidates.map(person => <option key={person.user_id} value={person.user_id} disabled={person.active_reviewer}>{person.display_name} @{person.github_login}{person.active_reviewer ? '（已是審查者）' : ''}</option>)}</select></label>
        <label className="field">風險上限<select value={maxRisk} onChange={event => setMaxRisk(event.target.value)}><option value="low">低風險</option><option value="medium">中風險</option><option value="high">高風險</option></select></label>
        <label className="field">任命理由<input value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
        <div className="actions"><button className="btn btn-primary" disabled={busy}>確認任命</button></div>
      </form>}
    </div>
  </details>;
}

function RepoForm({ repo, busy, onMutate, onSaved }: {
  repo: Repo; busy: boolean;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
  onSaved: () => void;
}) {
  const stored = repo.settings ?? {};
  const sla = (stored.sla_hours ?? {}) as { low?: number | null; medium?: number | null; high?: number | null };
  const [mode, setMode] = useState(repo.mode === 'off' || repo.mode === 'observe' ? repo.mode : 'observe');
  const [claimHours, setClaimHours] = useState(String(stored.claim_hours ?? 24));
  const [requestReviewers, setRequestReviewers] = useState(stored.request_reviewers === true);
  const [low, setLow] = useState(sla.low === undefined ? '24' : sla.low === null ? '' : String(sla.low));
  const [medium, setMedium] = useState(sla.medium === undefined ? '48' : sla.medium === null ? '' : String(sla.medium));
  const [high, setHigh] = useState(sla.high === undefined || sla.high === null ? '' : String(sla.high));
  const [requiredCheck, setRequiredCheck] = useState(String(stored.required_check ?? 'verify'));
  const [appSlug, setAppSlug] = useState(String(stored.required_check_app_slug ?? 'github-actions'));
  const [holds, setHolds] = useState(Array.isArray(stored.hold_labels) ? (stored.hold_labels as string[]).join(', ') : 'hold, do-not-merge');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    const hours = Number(claimHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) { setError('認領時數要是 1 到 168 的整數。'); return; }
    if (reason.trim().length < 3) { setError('請填寫至少 3 個字的調整理由。'); return; }
    const hourOrNull = (value: string) => value.trim() === '' ? null : Number(value);
    const settings = {
      ...stored,
      claim_hours: hours,
      request_reviewers: requestReviewers,
      required_check: requiredCheck.trim(),
      required_check_app_slug: appSlug.trim(),
      sla_hours: { low: hourOrNull(low), medium: hourOrNull(medium), high: hourOrNull(high) },
      hold_labels: holds.split(',').map(item => item.trim()).filter(Boolean),
    };
    setError('');
    if (await onMutate(`/review-center/repositories/${repo.repository_id}/settings`, { mode, settings, reason: reason.trim() }, versionOf(repo.aggregate_version))) onSaved();
  }
  return <form className="card stack" onSubmit={event => void save(event)}>
    <h3>{repo.full_name}</h3>
    <p className="muted">目前模式 {modeText(repo.mode)}</p>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    <label className="field">模式<select value={mode} onChange={event => setMode(event.target.value)}><option value="off">關閉</option><option value="observe">觀察</option></select></label>
    <label className="field">認領時數<input inputMode="numeric" value={claimHours} onChange={event => setClaimHours(event.target.value)} /></label>
    <label className="checkbox-row"><input type="checkbox" checked={requestReviewers} onChange={event => setRequestReviewers(event.target.checked)} />把認領寫成 GitHub 請求審查</label>
    <p className="field-hint">只有 Worker 變數 GITHUB_MAINTAINER_WRITES 也是 requested_reviewers，而且 GitHub App 已有 Pull requests 寫入權限時，才會寫入 GitHub。組織擁有者必須重新核准這項權限。</p>
    <label className="field">低風險期限（小時）<input inputMode="numeric" value={low} onChange={event => setLow(event.target.value)} /></label>
    <label className="field">中風險期限（小時）<input inputMode="numeric" value={medium} onChange={event => setMedium(event.target.value)} /></label>
    <label className="field">高風險期限（小時，空白表示不設）<input inputMode="numeric" value={high} onChange={event => setHigh(event.target.value)} /></label>
    <label className="field">必要檢查<input value={requiredCheck} onChange={event => setRequiredCheck(event.target.value)} maxLength={100} /></label>
    <label className="field">檢查 App<input value={appSlug} onChange={event => setAppSlug(event.target.value)} maxLength={100} /></label>
    <label className="field">保留標籤（逗號分隔，空白表示不使用）<input value={holds} onChange={event => setHolds(event.target.value)} /></label>
    <label className="field">調整理由<input value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
    <div className="actions"><button className="btn btn-primary" disabled={busy}>儲存設定</button></div>
  </form>;
}

function ReviewerForm({ reviewer, busy, onMutate, onSaved }: {
  reviewer: Reviewer; busy: boolean;
  onMutate: (path: string, body: unknown, version?: number | null) => Promise<boolean>;
  onSaved: () => void;
}) {
  const [maxRisk, setMaxRisk] = useState(reviewer.max_risk);
  const [active, setActive] = useState(reviewer.active);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) { setError('請填寫至少 3 個字的調整理由。'); return; }
    setError('');
    if (await onMutate(`/review-center/reviewers/${reviewer.reviewer_id}`, { max_risk: maxRisk, active, reason: reason.trim() }, versionOf(reviewer.aggregate_version))) onSaved();
  }
  return <form className="stack" onSubmit={event => void save(event)}>
    <p>{reviewer.display_name} @{reviewer.github_login} {reviewer.active ? '啟用中' : '已停用'}</p>
    {error && <p className="field-hint">{error}</p>}
    <label className="field">風險上限<select value={maxRisk} onChange={event => setMaxRisk(event.target.value)}><option value="low">低風險</option><option value="medium">中風險</option><option value="high">高風險</option></select></label>
    <label className="checkbox-row"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} />啟用</label>
    <label className="field">調整理由<input value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={1000} required /></label>
    <div className="actions"><button className="btn btn-primary" disabled={busy}>儲存審查者</button></div>
  </form>;
}
