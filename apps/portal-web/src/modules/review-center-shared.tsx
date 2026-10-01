import { Fragment, type ReactNode } from 'react';

export type Reason = { code: string; message: string; paths?: string[] };
export type Ownership = { guild_key: string | null; guild_name: string | null; scope_kind: string | null; open_to_guilds: boolean; skill_book_id?: string | null };
export type OwnershipChange = Ownership & { who: string | null; source: string; reason: string; created_at: string | null };
export type Claim = {
  claim_id: string; reviewer_user_id: string; reviewer_login: string; acting_as: string;
  guild_key: string | null; guild_name: string | null; skill_book_id?: string | null; skill_book_title?: string | null;
  assignment: string; claimed_by: string | null;
  created_at: string; expires_at: string | null; head_sha: string; github_request_state: string;
  github_request_error?: string | null; aggregate_version: string | number;
};
export type HistoryClaim = Claim & { state: string; end_reason: string | null; ended_at: string | null };
export type CheckRow = { name: string; status: string; conclusion: string | null; head_sha: string; source?: string };
export type PullRow = {
  pull_id: string; repository_id: string; full_name: string; number: number; title: string; html_url: string;
  state: string; queue_state: string; author_login: string; author_association: string | null; author_type: string | null;
  is_fork: boolean; paused: boolean; head_sha: string; aggregate_version: string | number;
  ownership: Ownership; first_queue_reason: Reason | null; claim: Claim | null; required_check: CheckRow | null;
};
export type FileRow = { path: string; previous_path: string | null; status: string; additions: number; deletions: number; notes: Reason[] };
export type ReviewRow = {
  github_review_id: string; reviewer_login: string; state: string; commit_id: string | null;
  is_current_head: boolean; counts_as_valid: boolean;
};
export type HandoffRecent = { kind: string; cli: string; github_login: string; head_sha: string | null; created_at: string | null };
export type PullHandoff = {
  allowed: boolean; reason: string | null; merge_allowed: boolean; merge_reason: string | null; recent: HandoffRecent[];
};
export type PullDetail = PullRow & {
  is_draft: boolean; mode: string; files: FileRow[]; checks: CheckRow[]; reviews: ReviewRow[];
  queue_reasons: Reason[]; claims: HistoryClaim[]; attention_reasons: Reason[];
  ownership: Ownership & { history: OwnershipChange[] };
  handoff: PullHandoff;
};
export type EligibleReviewer = {
  user_id: string; display_name: string; github_login: string; acting_as: 'admin' | 'guild_leader' | 'skill_book_maintainer';
  guild_key: string | null; guild_name: string | null; skill_book_id: string | null; skill_book_title: string | null;
};

export const QUEUE_LABEL: Record<string, string> = {
  awaiting_review: '待審', in_review: '審核中', waiting_ci: '等 CI', needs_author: '待作者', ci_not_run: '待作者',
  needs_decision: '待決定', ready: '已核准', paused: '已暫停', draft: '草稿', merged: '已合併', closed: '已關閉',
};
export const CLAIM_STATE: Record<string, string> = { active: '認領中', released: '已釋放', expired: '已到期', completed: '已完成' };
export const END_REASON: Record<string, string> = {
  self_released: '本人放棄認領', admin_released: '管理員已釋放', pull_closed: '拉取請求已關閉',
  reviewer_not_eligible: '已不是這個項目的公會長、技能書維護者或管理員', review_submitted: '已送出審查',
};
export const REVIEW_STATE: Record<string, string> = {
  APPROVED: '核准', CHANGES_REQUESTED: '要求修改', COMMENTED: '留言', DISMISSED: '已撤銷', PENDING: '未送出',
};
export const GITHUB_REQUEST: Record<string, string> = {
  pending: '等待寫入 GitHub', requested: '已在 GitHub 請求審查', skipped: '沒有寫入 GitHub',
  removing: '正在移除 GitHub 請求', removed: '已移除 GitHub 請求', failed: 'GitHub 寫入失敗',
};
export const GITHUB_ERROR: Record<string, string> = {
  github_permission_missing: 'GitHub App 還沒有寫入權限',
  writes_disabled: '寫入已關閉，GitHub 上可能還留著這個審查請求',
  github_http_422: 'GitHub 拒絕了，這個帳號可能不是協作者',
};
export const MODE_LABEL: Record<string, string> = { off: '關閉', observe: '觀察' };
export const SCOPE_LABEL: Record<string, string> = { module: '模組', skill_book: '技能書' };
export const SOURCE_LABEL: Record<string, string> = { admin: '管理員調整', adopted: '審完歸屬' };
export const SKILL_MAINTAINER_STATUS: Record<string, string> = {
  linked: '已連結 GitHub', no_github: '尚未連結 GitHub', inactive: '任命已停用',
};
export const ADMIN_LINK_STATUS: Record<string, string> = {
  ready: '已可審查',
  no_member: '沒有同 email 的會員帳號',
  email_unverified: '會員 email 尚未驗證',
  no_github: '會員尚未連結 GitHub',
};
export const CLAIM_UNAVAILABLE = '這個拉取請求目前未開啟、仍是草稿或已暫停（包括儲存庫已關閉），不能認領。';
export const CLAIM_HELD = '這個拉取請求已有人認領。';
export const GITHUB_REVIEW_LINK = '到 GitHub 審查 ↗';
export const GITHUB_REVIEW_HINT = '請在 GitHub 送出審查（Approve 或 Request changes），送出後這裡會自動標示完成。';

export function versionOf(value: string | number): number {
  return Number(value);
}
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
export function countdown(target: string): string {
  const ms = Date.parse(target) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '已到期';
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `剩餘 ${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `剩餘 ${hours} 小時`;
  return `剩餘 ${Math.floor(hours / 24)} 天`;
}
export function checkText(check: CheckRow | null): string {
  if (!check) return '尚未出現';
  if (check.status !== 'completed') return '進行中';
  if (check.conclusion === 'success' || check.conclusion === 'neutral') return '已通過';
  if (check.conclusion === 'action_required') return '等待核准';
  return '未通過';
}
export function modeText(mode: string): string {
  return MODE_LABEL[mode] ?? mode;
}
export function scopeText(kind: string | null): string {
  if (!kind) return '未分類';
  return SCOPE_LABEL[kind] ?? kind;
}
export function queueBadgeClass(state: string): string {
  return state === 'ready' ? 'badge badge-ok' : 'badge';
}
export function ownershipBadge(ownership: Ownership): { label: string; className: string } {
  if (ownership.guild_key) return { label: ownership.guild_name ?? ownership.guild_key, className: 'badge badge-own' };
  if (ownership.open_to_guilds) return { label: '開放認領', className: 'badge badge-open' };
  return { label: '只限管理員', className: 'badge' };
}
export function reviewStateLabel(state: string): string {
  return REVIEW_STATE[state] ?? state;
}
export function authorBadges(row: { author_association: string | null; author_type: string | null; is_fork: boolean }): string[] {
  const badges: string[] = [];
  if (row.author_association === 'FIRST_TIME_CONTRIBUTOR' || row.author_association === 'FIRST_TIMER') badges.push('首次貢獻');
  if (row.is_fork) badges.push('fork');
  if (row.author_type === 'Bot') badges.push('Bot');
  return badges;
}
export function claimLine(claim: Claim | null): string {
  if (!claim) return '無人認領';
  const role = claim.acting_as === 'guild_leader'
    ? `${claim.guild_name ?? '公會'}・公會長`
    : claim.acting_as === 'skill_book_maintainer'
      ? `${claim.skill_book_title ?? '技能書'}・維護者`
      : '管理員';
  const expiry = claim.expires_at ? countdown(claim.expires_at) : '不自動釋放';
  return `${claim.reviewer_login}（${role}）${expiry}`;
}
export function claimSummary(claim: HistoryClaim): string {
  const how = claim.assignment === 'assigned' ? `由 ${claim.claimed_by ?? '管理員'} 指派` : '自己認領';
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
export function pullClaimable(detail: { state: string; is_draft: boolean; paused: boolean; mode: string }): boolean {
  return detail.state === 'open' && !detail.is_draft && !detail.paused && detail.mode !== 'off';
}
export function reviewerOptionLabel(person: EligibleReviewer): string {
  if (person.acting_as === 'guild_leader') return `${person.display_name}（@${person.github_login}・${person.guild_name ?? '公會'}・公會長）`;
  if (person.acting_as === 'skill_book_maintainer') return `${person.display_name}（@${person.github_login}・${person.skill_book_title ?? '技能書'}・維護者）`;
  return `${person.display_name}（@${person.github_login}・管理員）`;
}
export function reviewerOptionValue(person: EligibleReviewer): string {
  return `${person.user_id}|${person.acting_as}|${person.guild_key ?? ''}|${person.skill_book_id ?? ''}`;
}
export function ownershipPlace(ownership: Ownership): string {
  if (ownership.guild_key) return ownership.guild_name ?? ownership.guild_key;
  return ownership.open_to_guilds ? '開放認領' : '只限管理員';
}
export function adoptionHint(guildName: string): string {
  return `這個儲存庫還沒有歸屬，你審完後會歸到${guildName}。`;
}

export function ReviewQueueRow({ row, open, onToggle, children }: {
  row: PullRow; open: boolean; onToggle: () => void; children?: ReactNode;
}) {
  const ownership = ownershipBadge(row.ownership);
  return <li className="review-row" data-pull-id={row.pull_id}>
    <div className="review-row-main">
      <div className="review-title">
        <a href={row.html_url} target="_blank" rel="noopener noreferrer">{row.full_name}#{row.number} {row.title}</a>
        <span className={queueBadgeClass(row.queue_state)}>{QUEUE_LABEL[row.queue_state] ?? row.queue_state}</span>
        <span className={ownership.className}>{ownership.label}</span>
      </div>
      <p>{row.author_login}{authorBadges(row).map(badge => <Fragment key={badge}>{' '}<span className="badge">{badge}</span></Fragment>)}</p>
      <p>下一步 {row.first_queue_reason?.message ?? '沒有下一步說明'}</p>
      <p>必要檢查 {row.required_check?.name ?? 'verify'} {shortSha(row.head_sha)} {checkText(row.required_check)}</p>
      <p>{claimLine(row.claim)}</p>
      <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={onToggle}>{open ? '收合' : '詳情'}</button>
    </div>
    {children}
  </li>;
}

export function PullFacts({ detail }: { detail: PullDetail }) {
  const notes = detail.attention_reasons ?? [];
  const files = [...(detail.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const last = detail.ownership.history?.[0];
  return <div className="review-detail stack">
    <p>歸屬 {ownershipPlace(detail.ownership)} · {scopeText(detail.ownership.scope_kind)}{last ? ` · 最近由 ${last.who ?? '未記錄'}（${SOURCE_LABEL[last.source] ?? last.source}）：${last.reason}` : ''}</p>
    <div>
      <h3>注意事項</h3>
      {notes.length ? notes.map(reason => <div key={reason.code}><p>{reason.message}</p>{!!reason.paths?.length && <ul>{reason.paths.map(path => <li key={path}>{path}</li>)}</ul>}</div>) : <p className="muted">沒有需要特別看的檔案。</p>}
    </div>
    <div>
      <h3>變更檔案</h3>
      {files.length ? <ul>{files.map(file => <li key={file.path}>{file.path}{file.notes.map(note => <span className="review-path" key={note.code}>{note.message}</span>)}</li>)}</ul> : <p className="muted">沒有檔案紀錄。</p>}
    </div>
    <div>
      <h3>檢查</h3>
      {detail.checks.length ? <ul>{detail.checks.map(check => <li key={`${check.source ?? ''}-${check.name}-${check.head_sha}`}>{check.name} {shortSha(check.head_sha)} {checkText(check)}</li>)}</ul> : <p className="muted">沒有檢查紀錄。</p>}
    </div>
    <div>
      <h3>審查紀錄</h3>
      {detail.reviews.length ? <ul>{detail.reviews.map(review => <li key={review.github_review_id}>{review.reviewer_login} {reviewStateLabel(review.state)} {review.commit_id ? shortSha(review.commit_id) : '沒有提交'}{!review.is_current_head && <>{' '}<span className="badge">舊提交</span></>} <span className={review.counts_as_valid ? 'badge badge-ok' : 'badge badge-alert'}>{review.counts_as_valid ? '有效核准' : '不算有效核准'}</span></li>)}</ul> : <p className="muted">還沒有審查。</p>}
    </div>
    <div>
      <h3>佇列原因</h3>
      {(detail.queue_reasons ?? []).length ? <ul>{detail.queue_reasons.map(reason => <li key={reason.code}>{reason.message}</li>)}</ul> : <p className="muted">沒有佇列原因。</p>}
    </div>
    <div>
      <h3>最近認領</h3>
      {detail.claims.length ? <ul>{detail.claims.map(claim => <li key={claim.claim_id}>{claimSummary(claim)}</li>)}</ul> : <p className="muted">還沒有認領。</p>}
    </div>
  </div>;
}
