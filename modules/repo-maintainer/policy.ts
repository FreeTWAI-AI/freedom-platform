import { z } from 'zod';

/** Stored on every derived pull. Bump when attention or queue rules change. */
export const MAINTAINER_POLICY_VERSION = '2026-10-01.1';

export const REPOSITORY_MODES = ['off', 'observe', 'ai_review', 'merge_dry_run', 'merge'] as const;
export type RepositoryMode = (typeof REPOSITORY_MODES)[number];
export const QUEUE_STATES = ['draft', 'waiting_ci', 'ci_not_run', 'needs_author', 'awaiting_review', 'in_review', 'needs_decision', 'ready', 'paused', 'merged', 'closed'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];
/** Filters the admin list accepts. mine and author_action group claims and author/CI rows. */
export const QUEUE_FILTERS = ['draft', 'waiting_ci', 'ci_not_run', 'needs_author', 'awaiting_review', 'in_review', 'needs_decision', 'ready', 'paused', 'open', 'done', 'mine', 'author_action'] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

export const ATTENTION_REASON_CODES = [
  'sensitive', 'verification', 'maintainer', 'data_deploy', 'authority', 'contract', 'test_removed',
  'package_markdown', 'brand', 'svg', 'docs_code', 'size_large', 'size_huge', 'changed_files_truncated',
] as const;
export const QUEUE_REASON_CODES = [
  'merged', 'closed', 'repository_off', 'pull_paused', 'hold_label', 'draft', 'non_default_base', 'merge_conflict',
  'migration_number_collision', 'migration_number_behind', 'migration_duplicate_in_pr', 'migration_modified', 'migration_bad_name',
  'changes_requested', 'required_check_wrong_source', 'ci_failed', 'workflow_approval_required', 'ci_running', 'ci_pending', 'ci_missing',
  'other_check_failed', 'ready_human_approved', 'approval_stale', 'approval_not_eligible',
  'awaiting_review', 'author_is_reviewer', 'review_claimed',
] as const;

export type Reason = { code: string; message: string; paths?: string[] };

const ATTENTION_MESSAGES: Record<string, string> = {
  sensitive: '改到 .github、授權或品牌等敏感檔案，合併前請親自看過。',
  verification: '改到 CI、驗證工具、套件版本或腳本。CI 跑的可能是這個 PR 自己那一版的規則，請確認測試仍照原樣跑。',
  maintainer: '改到維護 Worker 的設定，請確認排程與權限。',
  data_deploy: '改到資料庫、部署或 Worker 設定，請確認不會動到現有環境。',
  authority: '改到登入、權限或管理 API。',
  contract: '改到協作規則或對外契約。',
  test_removed: '有測試檔被刪除或移出測試位置。',
  package_markdown: 'packages 裡的 Markdown 會被編進執行期文字，請當程式審。',
  brand: '品牌目錄裡的圖檔會出現在產品上。',
  svg: 'SVG 可以內嵌指令，請當程式審，不要只當圖片。',
  docs_code: '文件目錄裡有可執行的程式。',
  size_large: '變更超過 20 個檔案或 800 行。',
  size_huge: '變更超過 60 個檔案或 3000 行，建議請作者拆小。',
  changed_files_truncated: 'GitHub 沒有列出全部變更檔案，請先在 GitHub 看完整清單。',
};
const QUEUE_MESSAGES: Record<string, string> = {
  merged: '這個拉取請求已經合併。',
  closed: '這個拉取請求已關閉，而且沒有合併。',
  repository_off: '儲存庫目前是關閉模式，佇列先暫停。要恢復請改回觀察。',
  pull_paused: '這個拉取請求已暫停，恢復前不會往下送。',
  hold_label: '有暫停標籤，請先拿掉 hold 或 do-not-merge 再繼續。',
  draft: '這還是草稿。作者標成準備好之後才會進入審查。',
  non_default_base: '這個 PR 不是要合併到預設分支，請公會長或管理員決定怎麼處理。',
  merge_conflict: '和目標分支衝突。請作者重整後再推一次。',
  changes_requested: '審核人要求修改。請作者處理後再推上新的提交。',
  required_check_wrong_source: '有同名檢查，但不是指定的 GitHub Actions 檢查，這次先忽略。',
  ci_failed: '必要檢查失敗。請作者修正後推上新的提交。',
  workflow_approval_required: '必要檢查停在等待核准。請到 GitHub 核准這個工作流程。',
  ci_running: '必要檢查還在跑，稍後會再看一次。',
  ci_pending: '必要檢查尚未回報，仍在等待時間內。',
  ci_missing: '必要檢查還沒有出現。fork 的拉取請求通常要等維護者核准工作流程才會開始跑。',
  other_check_failed: '另有檢查失敗，不擋佇列，請一併看一下。',
  ready_human_approved: '公會長或管理員已核准目前的提交。',
  approval_stale: '有核准落在舊的提交上，那個核准不算目前這一版。',
  approval_not_eligible: '有人核准了目前的提交，但不是這個項目的公會長或管理員，不算有效核准。',
  awaiting_review: '檢查已過，等公會長或管理員核准。',
  author_is_reviewer: '作者本人也是這個項目的審核人，不能核准自己的 PR，需要另一位公會長或管理員核准。',
  review_claimed: '已有人正在審查。',
};

const FAILING = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'stale']);
const BLOCKING_ASSOCIATION = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const GENERATED = new Set([
  'apps/platform-api/src/generated/runtime-text.ts',
  'docs/platform-plan/verification/2026-09-20-file-inventory.json',
]);
const RASTER = /\.(png|jpe?g|gif|webp|avif)$/i;
const DOCS_CODE = /\.(py|js|mjs|cjs|ts|sh)$/;
const TEST_FILE = /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/;

export const repositorySettingsSchema = z.object({
  rules_profile: z.enum(['freedom-platform', 'default']).optional(),
  required_check: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  required_check_app_slug: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  ci_grace_minutes: z.number().int().min(5).max(240).optional(),
  hold_labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  migrations_dir: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_./-]+$/).refine(value => !value.split('/').includes('..') && !value.startsWith('/')).optional(),
  claim_hours: z.number().int().min(1).max(168).optional(),
  request_reviewers: z.boolean().optional(),
}).strict();
export type RepositorySettingsInput = z.infer<typeof repositorySettingsSchema>;
export type MaintainerSettings = {
  rules_profile: 'freedom-platform' | 'default';
  required_check: string;
  required_check_app_slug: string;
  ci_grace_minutes: number;
  hold_labels: string[];
  migrations_dir: string;
  claim_hours: number | null;
  request_reviewers: boolean;
};

export function defaultRulesProfile(fullName: string): MaintainerSettings['rules_profile'] {
  return fullName.toLowerCase() === 'freetwai-ai/freedom-platform' ? 'freedom-platform' : 'default';
}
export function resolveSettings(fullName: string, raw: unknown): MaintainerSettings {
  // The request schema rejects null. Stored settings keep claim_hours: null for “never expires”.
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
  if (source.claim_hours === null) delete source.claim_hours;
  const parsed = repositorySettingsSchema.parse(source);
  return {
    rules_profile: parsed.rules_profile ?? defaultRulesProfile(fullName),
    required_check: parsed.required_check ?? 'verify',
    required_check_app_slug: parsed.required_check_app_slug ?? 'github-actions',
    ci_grace_minutes: parsed.ci_grace_minutes ?? 15,
    hold_labels: parsed.hold_labels ?? ['hold', 'do-not-merge'],
    migrations_dir: parsed.migrations_dir ?? 'migrations',
    claim_hours: parsed.claim_hours ?? null,
    request_reviewers: parsed.request_reviewers ?? false,
  };
}

export type PolicyFile = { path: string; previous_path?: string | null; status: string; additions: number; deletions: number };
export type AttentionInput = {
  files: PolicyFile[];
  profile: MaintainerSettings['rules_profile'];
  changed_files?: number | null;
  /** The file list stopped at the page cap, even when changed_files equals the listed length. */
  files_truncated?: boolean;
};

type Hit = { code: string; path: string };

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{');
  const end = start < 0 ? -1 : pattern.indexOf('}', start + 1);
  if (start < 0 || end < 0) return [pattern];
  const prefix = pattern.slice(0, start), suffix = pattern.slice(end + 1);
  return pattern.slice(start + 1, end).split(',').flatMap(option => expandBraces(prefix + option + suffix));
}
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern.startsWith('**/', i)) { source += '(?:.*/)?'; i += 3; continue; }
    if (pattern.startsWith('**', i)) { source += '.*'; i += 2; continue; }
    if (pattern[i] === '*') { source += '[^/]*'; i += 1; continue; }
    source += /[\\^$+?.()|[\]{}]/.test(pattern[i]) ? `\\${pattern[i]}` : pattern[i];
    i += 1;
  }
  return new RegExp(`^${source}$`);
}
function compile(globs: string[]): RegExp[] {
  return globs.flatMap(expandBraces).map(globToRegExp);
}
const FREEDOM_RULES: Array<{ code: string; patterns: RegExp[] }> = [
  { code: 'sensitive', patterns: compile(['freedom.project.yaml', '.github/**', 'SECURITY.md', 'LICENSE*', 'site/assets/brand/**']) },
  { code: 'verification', patterns: compile(['package.json', 'package-lock.json', 'repositories.lock.json', '.npmrc', '.gitattributes', '.gitmodules', '.tool-versions', 'tsconfig*.json', 'playwright.config.*', 'scripts/**', 'docs/platform-plan/verification/verify_revision.py', 'docs/platform-plan/execution/tools/**']) },
  { code: 'maintainer', patterns: compile(['wrangler.maintainer.jsonc']) },
  { code: 'data_deploy', patterns: compile(['migrations/**', 'deploy/**', 'wrangler*.jsonc', 'compose.yaml', 'packages/db/**']) },
  { code: 'authority', patterns: compile(['apps/platform-api/src/{worker,env,readiness,admin-sync-worker,maintainer-worker}.ts', 'apps/platform-api/src/routes/admin.ts', 'modules/{platform-admin,identity-membership,github-social,development-access,catalog-commerce,repo-maintainer}/**']) },
  { code: 'contract', patterns: compile(['AGENTS.md', '**/AGENTS.md', 'CONTRIBUTING.md', 'contracts/**', 'docs/platform-plan/contracts/**']) },
];
const DEFAULT_SENSITIVE_TREE = compile(['.github/**']);
const DEFAULT_CONTRACT_NAME = /^(?:AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE.*)$/;

function matches(path: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(path));
}
function isTestPath(path: string): boolean {
  return path === 'tests' || path.startsWith('tests/') || TEST_FILE.test(path);
}
function renameLeavesTests(previous: string, next: string): boolean {
  return (isTestPath(previous) && !isTestPath(next)) || (TEST_FILE.test(previous) && !TEST_FILE.test(next));
}
function isRaster(path: string): boolean {
  return RASTER.test(path);
}
function isSvg(path: string): boolean {
  return path.toLowerCase().endsWith('.svg');
}
function brandImage(path: string): boolean {
  return path.split('/').includes('brand') && (isRaster(path) || isSvg(path));
}
function classifyFreedom(path: string): Hit | null {
  for (const rule of FREEDOM_RULES) if (matches(path, rule.patterns)) return { code: rule.code, path };
  if (path.startsWith('packages/') && path.endsWith('.md')) return { code: 'package_markdown', path };
  if (brandImage(path)) return { code: 'brand', path };
  if (isSvg(path)) return { code: 'svg', path };
  if ((path === 'docs' || path.startsWith('docs/')) && DOCS_CODE.test(path)) return { code: 'docs_code', path };
  return null;
}
function classifyDefault(path: string): Hit | null {
  if (matches(path, DEFAULT_SENSITIVE_TREE)) return { code: 'sensitive', path };
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (DEFAULT_CONTRACT_NAME.test(base)) return { code: 'contract', path };
  return null;
}
function reason(code: string, paths?: string[], message?: string): Reason {
  const text = message ?? ATTENTION_MESSAGES[code] ?? QUEUE_MESSAGES[code] ?? code;
  return paths && paths.length ? { code, message: text, paths: [...new Set(paths)] } : { code, message: text };
}
function merge(into: Reason[], code: string, path?: string, message?: string) {
  const text = message ?? ATTENTION_MESSAGES[code] ?? QUEUE_MESSAGES[code] ?? code;
  const found = into.find(item => item.code === code && item.message === text);
  if (!found) { into.push(reason(code, path ? [path] : undefined, text)); return; }
  if (path) found.paths = [...new Set([...(found.paths ?? []), path])];
}

/** Path notes in file order, then size, then a truncated file list. Paths with no rule are silent. */
export function classifyAttention(input: AttentionInput): Reason[] {
  const reasons: Reason[] = [];
  const note = (code: string, path?: string) => merge(reasons, code, path);
  for (const file of input.files) {
    if (input.profile === 'freedom-platform' && file.status === 'removed' && isTestPath(file.path)) note('test_removed', file.path);
    if (input.profile === 'freedom-platform' && file.status === 'renamed' && file.previous_path && renameLeavesTests(file.previous_path, file.path)) note('test_removed', file.previous_path);
    const consider = (path: string | null | undefined) => {
      if (!path || GENERATED.has(path)) return;
      const hit = input.profile === 'default' ? classifyDefault(path) : classifyFreedom(path);
      if (hit) note(hit.code, hit.path);
    };
    consider(file.path);
    if (file.previous_path && file.previous_path !== file.path) consider(file.previous_path);
  }
  const counted = input.files.filter(file => !GENERATED.has(file.path));
  const lines = counted.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (counted.length > 60 || lines > 3000) note('size_huge');
  else if (counted.length > 20 || lines > 800) note('size_large');
  if (input.files_truncated || (input.changed_files != null && input.changed_files > input.files.length)) note('changed_files_truncated');
  return reasons;
}

const MIGRATION_NAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
function migrationRelative(path: string, dir: string): string | null {
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length);
}
export function migrationCheck(files: PolicyFile[], baseMigrationNames: readonly string[], migrationsDir = 'migrations', baseRef = 'main'): Reason[] {
  const base = new Map<string, number>();
  const baseNumbers = new Set<number>();
  let latest = 0;
  for (const name of baseMigrationNames) {
    const file = basename(name);
    const match = MIGRATION_NAME.exec(file);
    if (!match) continue;
    const number = Number(match[1]);
    base.set(file, number);
    baseNumbers.add(number);
    if (number > latest) latest = number;
  }
  const next = String(latest + 1).padStart(3, '0');
  const reasons: Reason[] = [];
  const added = new Map<number, string[]>();
  for (const file of files) {
    const current = migrationRelative(file.path, migrationsDir);
    const previous = file.previous_path ? migrationRelative(file.previous_path, migrationsDir) : null;
    const previousBase = previous ? basename(file.previous_path ?? '') : '';
    const renamedFromExisting = file.status === 'renamed' && previousBase !== '' && base.has(previousBase);
    if (file.status === 'removed' || file.status === 'modified' || file.status === 'changed' || renamedFromExisting) {
      const target = renamedFromExisting ? previousBase : current ? basename(file.path) : '';
      if (target && base.has(target)) {
        merge(reasons, 'migration_modified', file.previous_path && renamedFromExisting ? file.previous_path : file.path,
          `不能修改、刪除或重新命名既有遷移 ${target}。請新增 ${next} 或之後的編號。`);
        continue;
      }
    }
    if (!current || (file.status !== 'added' && file.status !== 'copied' && file.status !== 'renamed')) continue;
    if (renamedFromExisting) continue;
    const name = basename(file.path);
    const match = current.includes('/') ? null : MIGRATION_NAME.exec(name);
    if (!match) {
      merge(reasons, 'migration_bad_name', file.path, `遷移檔名必須是 NNN_name.sql，${name} 不符合。請改用 ${next} 或之後的編號。`);
      continue;
    }
    const number = Number(match[1]);
    const paths = added.get(number) ?? [];
    paths.push(file.path);
    added.set(number, paths);
    if (number <= latest) {
      const latestLabel = String(latest).padStart(3, '0');
      if (baseNumbers.has(number)) {
        merge(reasons, 'migration_number_collision', file.path,
          `編號 ${match[1]} 已存在於 ${baseRef}（目前最新是 ${latestLabel}）。請改用 ${next} 或之後的編號。`);
      } else {
        merge(reasons, 'migration_number_behind', file.path,
          `編號 ${match[1]} 小於 ${baseRef} 目前最新的 ${latestLabel}，遷移只能往後加。請改用 ${next} 或之後的編號。`);
      }
    }
  }
  for (const [number, paths] of added) {
    if (paths.length < 2) continue;
    const label = String(number).padStart(3, '0');
    for (const path of paths) merge(reasons, 'migration_duplicate_in_pr', path, `這個拉取請求裡有兩份 ${label} 編號的遷移，請只留一份並改用 ${next} 或之後的編號。`);
  }
  return reasons;
}

export type PolicyCheck = { source: 'check_run' | 'status'; name: string; app_slug: string | null; head_sha: string; status: string | null; conclusion: string | null };
export type PolicyReview = { github_review_id: string; reviewer_github_id: string; reviewer_association: string | null; state: string; commit_id: string | null; submitted_at: string };
export type QueuePull = {
  state: 'open' | 'closed';
  merged_at: string | null;
  is_draft: boolean;
  base_ref: string;
  default_branch: string;
  mergeable: boolean | null;
  mergeable_state: string | null;
  labels: string[];
  head_sha: string;
  head_observed_at: string;
  author_github_id: string;
  paused: boolean;
};
/** A live claim. Null expires_at stays live; a past timestamp does not. */
export type QueueClaim = {
  reviewer_login: string;
  acting_as: 'admin' | 'guild_leader';
  guild_name: string | null;
  adopts_repository: boolean;
  expires_at: string | null;
};
export type QueueDerivationInput = {
  pull: QueuePull;
  /** GitHub numeric ids of everyone who may approve this pull now. */
  eligible_reviewer_ids: string[];
  checks: PolicyCheck[];
  reviews: PolicyReview[];
  mode: RepositoryMode;
  settings: MaintainerSettings;
  migration_reasons: Reason[];
  claim?: QueueClaim | null;
};
export type QueueDerivation = { state: QueueState; reasons: Reason[]; recheck_at: string | null };

function queueReason(code: string, message?: string): Reason {
  return { code, message: message ?? QUEUE_MESSAGES[code] ?? code };
}
function latestDecisive(reviews: PolicyReview[]): Map<string, PolicyReview> {
  const best = new Map<string, PolicyReview>();
  for (const review of reviews) {
    if (review.state === 'COMMENTED') continue;
    const previous = best.get(review.reviewer_github_id);
    const reviewTime = Date.parse(review.submitted_at);
    const previousTime = previous ? Date.parse(previous.submitted_at) : Number.NEGATIVE_INFINITY;
    if (!previous || reviewTime > previousTime || (reviewTime === previousTime && review.github_review_id > previous.github_review_id)) best.set(review.reviewer_github_id, review);
  }
  return best;
}
function done(state: QueueState, reasons: Reason[], recheck_at: string | null = null): QueueDerivation {
  return { state, reasons, recheck_at };
}
function onHead(review: PolicyReview, head: string): boolean {
  return (review.commit_id ?? '').toLowerCase() === head.toLowerCase();
}

/** Same rule deriveQueueState uses, so the detail API cannot drift. */
export function annotateReviews(reviews: PolicyReview[], pull: Pick<QueuePull, 'head_sha' | 'author_github_id'>, eligibleIds: readonly string[]) {
  const latest = latestDecisive(reviews);
  const eligible = new Set(eligibleIds);
  return reviews.map(review => {
    const current = latest.get(review.reviewer_github_id);
    const isCurrentHead = onHead(review, pull.head_sha);
    const counts = current?.github_review_id === review.github_review_id
      && review.state === 'APPROVED'
      && isCurrentHead
      && eligible.has(review.reviewer_github_id)
      && review.reviewer_github_id !== pull.author_github_id;
    return { ...review, is_current_head: isCurrentHead, counts_as_valid: counts };
  });
}

function claimMessage(claim: QueueClaim): string {
  const who = claim.acting_as === 'admin'
    ? `${claim.reviewer_login}（管理員）正在審查。`
    : `${claim.reviewer_login}（${claim.guild_name ?? ''}・公會長）正在審查。`;
  const adopt = claim.adopts_repository ? `審完後這個儲存庫會歸到${claim.guild_name ?? ''}。` : '';
  const expiry = claim.expires_at ? '認領到期後會自動釋放。' : '';
  return `${who}${adopt}${expiry}`;
}

function withClaim(derived: QueueDerivation, claim: QueueClaim | null | undefined, now: Date): QueueDerivation {
  if (!claim) return derived;
  if (claim.expires_at) {
    const expires = Date.parse(claim.expires_at);
    if (!Number.isFinite(expires) || expires <= now.getTime()) return derived;
  }
  if (derived.state !== 'awaiting_review') return derived;
  let recheck = derived.recheck_at;
  if (claim.expires_at) {
    const expiresIso = new Date(Date.parse(claim.expires_at)).toISOString();
    if (!recheck || Date.parse(recheck) > Date.parse(expiresIso)) recheck = expiresIso;
  }
  return { state: 'in_review', reasons: [...derived.reasons, queueReason('review_claimed', claimMessage(claim))], recheck_at: recheck };
}

export function deriveQueueState(input: QueueDerivationInput, now: Date): QueueDerivation {
  return withClaim(deriveWithoutClaim(input, now), input.claim, now);
}

function deriveWithoutClaim(input: QueueDerivationInput, now: Date): QueueDerivation {
  const pull = input.pull;
  if (pull.merged_at) return done('merged', [queueReason('merged')]);
  if (pull.state === 'closed') return done('closed', [queueReason('closed')]);
  const paused: Reason[] = [];
  if (input.mode === 'off') paused.push(queueReason('repository_off'));
  if (pull.paused) paused.push(queueReason('pull_paused'));
  const holds = new Set(input.settings.hold_labels.map(label => label.toLowerCase()));
  if (pull.labels.some(label => holds.has(label.toLowerCase()))) paused.push(queueReason('hold_label'));
  if (paused.length) return done('paused', paused);
  if (pull.is_draft) return done('draft', [queueReason('draft')]);
  if (pull.base_ref !== pull.default_branch) return done('needs_decision', [queueReason('non_default_base')]);
  const authorBlock: Reason[] = [];
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') authorBlock.push(queueReason('merge_conflict'));
  authorBlock.push(...input.migration_reasons);
  if (authorBlock.length) return done('needs_author', authorBlock);

  const eligible = new Set(input.eligible_reviewer_ids);
  const latest = latestDecisive(input.reviews);
  for (const review of latest.values()) {
    if (review.state !== 'CHANGES_REQUESTED') continue;
    const association = (review.reviewer_association ?? '').toUpperCase();
    if (eligible.has(review.reviewer_github_id) || BLOCKING_ASSOCIATION.has(association)) return done('needs_author', [queueReason('changes_requested')]);
  }

  const info: Reason[] = [];
  const note = (code: string) => { if (!info.some(item => item.code === code)) info.push(queueReason(code)); };
  const checksOnHead = input.checks.filter(check => check.head_sha.toLowerCase() === pull.head_sha.toLowerCase());
  const named = checksOnHead.filter(check => check.name === input.settings.required_check);
  const validChecks = named.filter(check => check.source === 'check_run' && check.app_slug === input.settings.required_check_app_slug);
  if (named.some(check => !(check.source === 'check_run' && check.app_slug === input.settings.required_check_app_slug))) note('required_check_wrong_source');
  const required = validChecks.at(-1);
  const otherFailed = checksOnHead.some(check => !named.includes(check) && FAILING.has(check.conclusion ?? ''));
  if (otherFailed) note('other_check_failed');
  if (!required) {
    const observed = Date.parse(pull.head_observed_at);
    const graceEnd = new Date(observed + input.settings.ci_grace_minutes * 60_000);
    if (now.getTime() < graceEnd.getTime()) return done('waiting_ci', [...info, queueReason('ci_pending')], graceEnd.toISOString());
    return done('ci_not_run', [...info, queueReason('ci_missing')]);
  }
  const conclusion = required.conclusion ?? '';
  const status = required.status ?? '';
  if (conclusion === 'action_required') return done('ci_not_run', [...info, queueReason('workflow_approval_required')]);
  if (status !== 'completed') return done('waiting_ci', [...info, queueReason('ci_running')]);
  if (conclusion !== 'success' && conclusion !== 'neutral') return done('needs_author', [...info, queueReason('ci_failed')]);

  for (const review of latest.values()) {
    if (review.state !== 'APPROVED' || review.reviewer_github_id === pull.author_github_id) continue;
    if (!onHead(review, pull.head_sha)) note('approval_stale');
    else if (!eligible.has(review.reviewer_github_id)) note('approval_not_eligible');
  }
  const validApproval = [...latest.values()].some(review => review.state === 'APPROVED'
    && onHead(review, pull.head_sha)
    && eligible.has(review.reviewer_github_id)
    && review.reviewer_github_id !== pull.author_github_id);
  if (validApproval) return done('ready', [...info, queueReason('ready_human_approved')]);
  if (eligible.has(pull.author_github_id)) note('author_is_reviewer');
  return done('awaiting_review', [...info, queueReason('awaiting_review')]);
}
