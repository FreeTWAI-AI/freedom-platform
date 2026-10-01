import { z } from 'zod';

/** Stored on every derived pull. Phase 1b maps the exported reason codes. */
export const MAINTAINER_POLICY_VERSION = '2026-09-30.1';

export const RISK_CLASSES = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISK_CLASSES)[number];
export const REPOSITORY_MODES = ['off', 'observe', 'ai_review', 'merge_dry_run', 'merge'] as const;
export type RepositoryMode = (typeof REPOSITORY_MODES)[number];
export const QUEUE_STATES = ['draft', 'waiting_ci', 'ci_not_run', 'needs_author', 'awaiting_review', 'in_review', 'needs_owner', 'ready', 'paused', 'merged', 'closed'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];
/** Filters the admin list accepts. in_review is reserved for claims and is never produced here. */
export const QUEUE_FILTERS = ['draft', 'waiting_ci', 'ci_not_run', 'needs_author', 'awaiting_review', 'in_review', 'needs_owner', 'ready', 'paused', 'open', 'done'] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

export const RISK_REASON_CODES = [
  'high_sensitive', 'high_verification', 'high_data_deploy', 'high_authority', 'high_contract', 'high_maintainer',
  'test_removed', 'medium_package_markdown', 'medium_brand', 'medium_svg', 'medium_docs_code', 'medium_code', 'medium_uncovered',
  'low_docs', 'generated_only', 'author_first_time_contributor', 'author_first_timer', 'author_none',
  'fork_head', 'size_medium', 'size_high', 'changed_files_truncated', 'bot_author',
] as const;
export const QUEUE_REASON_CODES = [
  'merged', 'closed', 'repository_off', 'pull_paused', 'hold_label', 'draft', 'non_default_base', 'merge_conflict',
  'migration_number_collision', 'migration_duplicate_in_pr', 'migration_modified', 'migration_bad_name',
  'changes_requested', 'required_check_wrong_source', 'ci_failed', 'workflow_approval_required', 'ci_running', 'ci_pending', 'ci_missing',
  'other_check_failed', 'ready_human_approved', 'approval_stale', 'approval_rank_too_low', 'high_risk_requires_owner',
  'awaiting_review', 'sla_overdue', 'owner_authored',
] as const;

export type Reason = { code: string; message: string; paths?: string[] };

const RISK_MESSAGES: Record<string, string> = {
  high_sensitive: '變更碰到清單上的敏感路徑，請擁有者親自看過再合併。',
  high_verification: '變更碰到驗證、工具版本或腳本，請擁有者確認測試仍會照原樣跑。',
  high_data_deploy: '變更碰到資料庫、部署或 Worker 設定，請擁有者確認不會改到現有環境。',
  high_authority: '變更碰到身分、權限或管理 API，請擁有者親自審查。',
  high_contract: '變更碰到契約、貢獻規則或平台計畫契約，請擁有者確認對外承諾沒有被改掉。',
  high_maintainer: '變更碰到維護者 Worker 的設定，請擁有者確認排程與權限。',
  test_removed: '有測試檔被刪除或移走，請擁有者確認覆蓋沒有變少。',
  medium_package_markdown: 'packages 裡的 Markdown 會被編成執行期文字，請當程式審查。',
  medium_brand: '品牌目錄裡的圖檔會出現在產品上，請當程式審查。',
  medium_svg: 'SVG 可能內嵌指令，請當程式審查，不要只當圖片。',
  medium_docs_code: '文件目錄裡有可執行的程式，請當程式審查。',
  medium_code: '這是一般程式變更，需要符合風險等級的真人核准。',
  medium_uncovered: '這條路徑沒有更細的規則，先視為中風險。',
  low_docs: '這次只動到文件或圖片，風險較低，仍需要真人核准。',
  generated_only: '這次只有產生出來的檔案，那些檔案不提高風險。',
  author_first_time_contributor: '作者是首次貢獻者，風險至少為中，請由真人審查。',
  author_first_timer: '作者是第一次在 GitHub 送變更的人，風險至少為中，請由真人審查。',
  author_none: '作者與儲存庫沒有關聯，風險至少為中，請由真人審查。',
  fork_head: '變更來自 fork，風險至少為中，請確認工作流程已由維護者核准。',
  size_medium: '變更超過 20 個檔案或 800 行，風險至少為中。',
  size_high: '變更超過 60 個檔案或 3000 行，風險升為高，請擁有者處理。',
  changed_files_truncated: 'GitHub 沒有列出全部變更檔案，風險升為高，請先補齊清單再審查。',
  bot_author: '作者是 Bot。自動化審查不能代替真人，請由符合風險等級的審查者處理。',
};
const QUEUE_MESSAGES: Record<string, string> = {
  merged: '這個拉取請求已經合併。',
  closed: '這個拉取請求已關閉，而且沒有合併。',
  repository_off: '儲存庫目前是關閉模式，佇列先暫停。要恢復請改回觀察。',
  pull_paused: '這個拉取請求已暫停，恢復前不會往下送。',
  hold_label: '有暫停標籤，請先拿掉 hold 或 do-not-merge 再繼續。',
  draft: '這還是草稿。作者標成準備好之後才會進入審查。',
  non_default_base: '目標分支不是預設分支，請擁有者決定要不要收。',
  merge_conflict: '和目標分支衝突。請作者重整後再推一次。',
  changes_requested: '審查者要求修改。請作者處理後再推上新的提交。',
  required_check_wrong_source: '有同名檢查，但不是指定的 GitHub Actions 檢查，這次先忽略。',
  ci_failed: '必要檢查失敗。請作者修正後推上新的提交。',
  workflow_approval_required: '必要檢查停在等待核准。請到 GitHub 核准這個工作流程。',
  ci_running: '必要檢查還在跑，稍後會再看一次。',
  ci_pending: '必要檢查尚未回報，仍在等待時間內。',
  ci_missing: '必要檢查還沒有出現。fork 的拉取請求通常要等維護者核准工作流程才會開始跑。',
  other_check_failed: '另有檢查失敗，不擋佇列，請一併看一下。',
  ready_human_approved: '符合風險等級的審查者已核准目前的提交。',
  approval_stale: '有核准落在舊的提交上，那個核准不算目前這一版。',
  approval_rank_too_low: '有審查者核准了，但他的風險上限低於這次變更，不算有效核准。',
  high_risk_requires_owner: '這是高風險變更，需要擁有者處理，一般審查者的核准不夠。',
  awaiting_review: '檢查已過，還在等符合風險等級的真人核准。',
  sla_overdue: '已超過這個風險等級的審查時限，請盡快有人看。',
  owner_authored: '作者本人是審查者，不能核准自己的拉取請求，需要另一位審查者。',
};

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const FAILING = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'stale']);
const BLOCKING_ASSOCIATION = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const GENERATED = new Set([
  'apps/platform-api/src/generated/runtime-text.ts',
  'docs/platform-plan/verification/2026-09-20-file-inventory.json',
]);
const RASTER = /\.(png|jpe?g|gif|webp|avif)$/i;
const DOCS_CODE = /\.(py|js|mjs|cjs|ts|sh)$/;
const TEST_FILE = /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/;

const hour = z.number().int().min(1).max(720).nullable();
export const repositorySettingsSchema = z.object({
  rules_profile: z.enum(['freedom-platform', 'default']).optional(),
  required_check: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).optional(),
  required_check_app_slug: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).optional(),
  ci_grace_minutes: z.number().int().min(5).max(240).optional(),
  sla_hours: z.object({ low: hour.optional(), medium: hour.optional(), high: hour.optional() }).strict().optional(),
  hold_labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  migrations_dir: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_./-]+$/).refine(value => !value.split('/').includes('..') && !value.startsWith('/')).optional(),
}).strict();
export type RepositorySettingsInput = z.infer<typeof repositorySettingsSchema>;
export type MaintainerSettings = {
  rules_profile: 'freedom-platform' | 'default';
  required_check: string;
  required_check_app_slug: string;
  ci_grace_minutes: number;
  sla_hours: { low: number | null; medium: number | null; high: number | null };
  hold_labels: string[];
  migrations_dir: string;
};

export function defaultRulesProfile(fullName: string): MaintainerSettings['rules_profile'] {
  return fullName.toLowerCase() === 'freetwai-ai/freedom-platform' ? 'freedom-platform' : 'default';
}
export function resolveSettings(fullName: string, raw: unknown): MaintainerSettings {
  const parsed = repositorySettingsSchema.parse(raw ?? {});
  return {
    rules_profile: parsed.rules_profile ?? defaultRulesProfile(fullName),
    required_check: parsed.required_check ?? 'verify',
    required_check_app_slug: parsed.required_check_app_slug ?? 'github-actions',
    ci_grace_minutes: parsed.ci_grace_minutes ?? 15,
    sla_hours: {
      low: parsed.sla_hours?.low === undefined ? 24 : parsed.sla_hours.low,
      medium: parsed.sla_hours?.medium === undefined ? 48 : parsed.sla_hours.medium,
      high: parsed.sla_hours?.high === undefined ? null : parsed.sla_hours.high,
    },
    hold_labels: parsed.hold_labels ?? ['hold', 'do-not-merge'],
    migrations_dir: parsed.migrations_dir ?? 'migrations',
  };
}

export type PolicyFile = { path: string; previous_path?: string | null; status: string; additions: number; deletions: number };
export type RiskInput = {
  files: PolicyFile[];
  profile: MaintainerSettings['rules_profile'];
  author_association?: string | null;
  author_type?: string | null;
  is_fork?: boolean;
  changed_files?: number | null;
};

type Hit = { risk: Risk; code: string; path: string };

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
const FREEDOM_HIGH: Array<{ code: string; patterns: RegExp[] }> = [
  { code: 'high_sensitive', patterns: compile(['freedom.project.yaml', '.github/**', 'SECURITY.md', 'LICENSE*', 'site/assets/brand/**']) },
  { code: 'high_verification', patterns: compile(['package.json', 'package-lock.json', '.tool-versions', 'tsconfig*.json', 'playwright.config.*', 'scripts/**', 'docs/platform-plan/verification/verify_revision.py', 'docs/platform-plan/execution/tools/**']) },
  { code: 'high_maintainer', patterns: compile(['wrangler.maintainer.jsonc']) },
  { code: 'high_data_deploy', patterns: compile(['migrations/**', 'deploy/**', 'wrangler*.jsonc', 'compose.yaml', 'packages/db/**']) },
  { code: 'high_authority', patterns: compile(['apps/platform-api/src/{worker,env,readiness,admin-sync-worker,maintainer-worker}.ts', 'apps/platform-api/src/routes/admin.ts', 'modules/{platform-admin,identity-membership,github-social,development-access,catalog-commerce,repo-maintainer}/**']) },
  { code: 'high_contract', patterns: compile(['AGENTS.md', '**/AGENTS.md', 'CONTRIBUTING.md', 'contracts/**', 'docs/platform-plan/contracts/**']) },
];
const DEFAULT_HIGH_TREE = compile(['.github/**']);
const DEFAULT_HIGH_NAME = /^(?:AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE.*)$/;

function matches(path: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(path));
}
function isTestPath(path: string): boolean {
  return path === 'tests' || path.startsWith('tests/') || TEST_FILE.test(path);
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
function classifyFreedom(path: string): Hit {
  for (const rule of FREEDOM_HIGH) if (matches(path, rule.patterns)) return { risk: 'high', code: rule.code, path };
  if (path.startsWith('packages/') && path.endsWith('.md')) return { risk: 'medium', code: 'medium_package_markdown', path };
  if (brandImage(path)) return { risk: 'medium', code: 'medium_brand', path };
  if (isSvg(path)) return { risk: 'medium', code: 'medium_svg', path };
  if ((path === 'docs' || path.startsWith('docs/')) && DOCS_CODE.test(path)) return { risk: 'medium', code: 'medium_docs_code', path };
  if (path.endsWith('/README.md') || path === 'README.md') return { risk: 'low', code: 'low_docs', path };
  if (path === 'docs' || path.startsWith('docs/')) return { risk: 'low', code: 'low_docs', path };
  if (!path.includes('/') && path.endsWith('.md')) return { risk: 'low', code: 'low_docs', path };
  if (/^(?:apps|modules|packages|tests)(?:\/|$)/.test(path)) return { risk: 'medium', code: 'medium_code', path };
  if (isRaster(path)) return { risk: 'low', code: 'low_docs', path };
  return { risk: 'medium', code: 'medium_uncovered', path };
}
function classifyDefault(path: string): Hit {
  if (matches(path, DEFAULT_HIGH_TREE)) return { risk: 'high', code: 'high_sensitive', path };
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (DEFAULT_HIGH_NAME.test(base)) return { risk: 'high', code: 'high_contract', path };
  if (path === 'docs' || path.startsWith('docs/') || path.endsWith('.md')) return { risk: 'low', code: 'low_docs', path };
  return { risk: 'medium', code: 'medium_code', path };
}
function atLeast(current: Risk, floor: Risk): Risk {
  return RANK[current] >= RANK[floor] ? current : floor;
}
function reason(code: string, paths?: string[], message?: string): Reason {
  const text = message ?? RISK_MESSAGES[code] ?? QUEUE_MESSAGES[code] ?? code;
  return paths && paths.length ? { code, message: text, paths: [...new Set(paths)] } : { code, message: text };
}
function merge(into: Reason[], code: string, path?: string, message?: string) {
  const text = message ?? RISK_MESSAGES[code] ?? QUEUE_MESSAGES[code] ?? code;
  const found = into.find(item => item.code === code && item.message === text);
  if (!found) { into.push(reason(code, path ? [path] : undefined, text)); return; }
  if (path) found.paths = [...new Set([...(found.paths ?? []), path])];
}

export function classifyRisk(input: RiskInput): { risk: Risk; reasons: Reason[] } {
  const reasons: Reason[] = [];
  let risk: Risk = 'low';
  let sawFile = false, sawCounted = false;
  for (const file of input.files) {
    sawFile = true;
    const counted = !GENERATED.has(file.path);
    if (counted) sawCounted = true;
    const hits: Hit[] = [];
    if (input.profile === 'freedom-platform' && file.status === 'removed' && isTestPath(file.path)) hits.push({ risk: 'high', code: 'test_removed', path: file.path });
    if (input.profile === 'freedom-platform' && file.status === 'renamed' && file.previous_path && isTestPath(file.previous_path)) hits.push({ risk: 'high', code: 'test_removed', path: file.previous_path });
    const consider = (path: string | null | undefined) => {
      if (!path || GENERATED.has(path)) return;
      hits.push(input.profile === 'default' ? classifyDefault(path) : classifyFreedom(path));
    };
    consider(file.path);
    if (file.previous_path && file.previous_path !== file.path) consider(file.previous_path);
    if (!hits.length) continue;
    const best = hits.reduce<Risk>((current, hit) => atLeast(current, hit.risk), 'low');
    risk = atLeast(risk, best);
    for (const hit of hits) if (hit.risk === best) merge(reasons, hit.code, hit.path);
  }
  if (sawFile && !sawCounted) merge(reasons, 'generated_only');
  const association = input.author_association ?? '';
  if (association === 'FIRST_TIME_CONTRIBUTOR') { merge(reasons, 'author_first_time_contributor'); risk = atLeast(risk, 'medium'); }
  if (association === 'FIRST_TIMER') { merge(reasons, 'author_first_timer'); risk = atLeast(risk, 'medium'); }
  if (association === 'NONE') { merge(reasons, 'author_none'); risk = atLeast(risk, 'medium'); }
  if (input.is_fork) { merge(reasons, 'fork_head'); risk = atLeast(risk, 'medium'); }
  if (input.author_type === 'Bot') { merge(reasons, 'bot_author'); risk = atLeast(risk, 'medium'); }
  const counted = input.files.filter(file => !GENERATED.has(file.path));
  const lines = counted.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (counted.length > 60 || lines > 3000) { merge(reasons, 'size_high'); risk = 'high'; }
  else if (counted.length > 20 || lines > 800) { merge(reasons, 'size_medium'); risk = atLeast(risk, 'medium'); }
  if (input.changed_files != null && input.changed_files > input.files.length) { merge(reasons, 'changed_files_truncated'); risk = 'high'; }
  if (!reasons.length) merge(reasons, 'low_docs');
  return { risk, reasons };
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
export function migrationCheck(files: PolicyFile[], baseMigrationNames: readonly string[], migrationsDir = 'migrations'): Reason[] {
  const base = new Map<string, number>();
  let latest = 0;
  for (const name of baseMigrationNames) {
    const file = basename(name);
    const match = MIGRATION_NAME.exec(file);
    if (!match) continue;
    const number = Number(match[1]);
    base.set(file, number);
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
      merge(reasons, 'migration_number_collision', file.path,
        `編號 ${match[1]} 已存在於 main（目前最新是 ${String(latest).padStart(3, '0')}）。請改用 ${next} 或之後的編號。`);
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
export type ActiveReviewer = { github_user_id: string; max_risk: Risk };
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
export type QueueDerivationInput = {
  pull: QueuePull;
  risk: Risk;
  checks: PolicyCheck[];
  reviews: PolicyReview[];
  reviewers: ActiveReviewer[];
  mode: RepositoryMode;
  settings: MaintainerSettings;
  migration_reasons: Reason[];
};
export type QueueDerivation = { state: QueueState; reasons: Reason[]; sla_due_at: string | null; recheck_at: string | null };

function queueReason(code: string, message?: string): Reason {
  return { code, message: message ?? QUEUE_MESSAGES[code] ?? code };
}
function reviewerMap(reviewers: ActiveReviewer[]): Map<string, Risk> {
  return new Map(reviewers.map(reviewer => [reviewer.github_user_id, reviewer.max_risk]));
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
function done(state: QueueState, reasons: Reason[], recheck_at: string | null = null, sla_due_at: string | null = null): QueueDerivation {
  return { state, reasons, sla_due_at, recheck_at };
}
function covers(maxRisk: Risk, risk: Risk): boolean {
  return RANK[maxRisk] >= RANK[risk];
}

/** Same rule deriveQueueState uses, so the detail API cannot drift. */
export function annotateReviews(reviews: PolicyReview[], pull: Pick<QueuePull, 'head_sha' | 'author_github_id'>, risk: Risk, reviewers: ActiveReviewer[]) {
  const latest = latestDecisive(reviews);
  const active = reviewerMap(reviewers);
  return reviews.map(review => {
    const current = latest.get(review.reviewer_github_id);
    const maxRisk = active.get(review.reviewer_github_id);
    const isCurrentHead = (review.commit_id ?? '').toLowerCase() === pull.head_sha.toLowerCase();
    const counts = current?.github_review_id === review.github_review_id
      && review.state === 'APPROVED'
      && isCurrentHead
      && maxRisk !== undefined
      && covers(maxRisk, risk)
      && review.reviewer_github_id !== pull.author_github_id;
    return { ...review, is_current_head: isCurrentHead, counts_as_valid: counts };
  });
}

export function deriveQueueState(input: QueueDerivationInput, now: Date): QueueDerivation {
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
  if (pull.base_ref !== pull.default_branch) return done('needs_owner', [queueReason('non_default_base')]);
  const authorBlock: Reason[] = [];
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') authorBlock.push(queueReason('merge_conflict'));
  authorBlock.push(...input.migration_reasons);
  if (authorBlock.length) return done('needs_author', authorBlock);

  const active = reviewerMap(input.reviewers);
  const latest = latestDecisive(input.reviews);
  for (const review of latest.values()) {
    if (review.state !== 'CHANGES_REQUESTED') continue;
    const association = (review.reviewer_association ?? '').toUpperCase();
    if (active.has(review.reviewer_github_id) || BLOCKING_ASSOCIATION.has(association)) return done('needs_author', [queueReason('changes_requested')]);
  }

  const info: Reason[] = [];
  const note = (code: string) => { if (!info.some(item => item.code === code)) info.push(queueReason(code)); };
  const onHead = input.checks.filter(check => check.head_sha.toLowerCase() === pull.head_sha.toLowerCase());
  const named = onHead.filter(check => check.name === input.settings.required_check);
  const validChecks = named.filter(check => check.source === 'check_run' && check.app_slug === input.settings.required_check_app_slug);
  if (named.some(check => !(check.source === 'check_run' && check.app_slug === input.settings.required_check_app_slug))) note('required_check_wrong_source');
  const required = validChecks.at(-1);
  const otherFailed = onHead.some(check => !named.includes(check) && FAILING.has(check.conclusion ?? ''));
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
  if (status === 'queued' || status === 'in_progress' || status === 'pending') return done('waiting_ci', [...info, queueReason('ci_running')]);
  if (conclusion !== 'success' && conclusion !== 'neutral') return done('needs_author', [...info, queueReason('ci_failed')]);

  for (const review of latest.values()) {
    if (review.state !== 'APPROVED' || review.reviewer_github_id === pull.author_github_id) continue;
    const onCurrent = (review.commit_id ?? '').toLowerCase() === pull.head_sha.toLowerCase();
    const maxRisk = active.get(review.reviewer_github_id);
    if (!onCurrent) note('approval_stale');
    else if (maxRisk === undefined) continue;
    else if (!covers(maxRisk, input.risk)) note('approval_rank_too_low');
  }
  const validApproval = [...latest.values()].some(review => {
    const maxRisk = active.get(review.reviewer_github_id);
    return review.state === 'APPROVED'
      && (review.commit_id ?? '').toLowerCase() === pull.head_sha.toLowerCase()
      && maxRisk !== undefined
      && covers(maxRisk, input.risk)
      && review.reviewer_github_id !== pull.author_github_id;
  });
  if (validApproval) return done('ready', [...info, queueReason('ready_human_approved')]);
  if (active.has(pull.author_github_id)) note('owner_authored');
  if (input.risk === 'high') return done('needs_owner', [...info, queueReason('high_risk_requires_owner')]);
  const hours = input.settings.sla_hours[input.risk];
  const observed = Date.parse(pull.head_observed_at);
  const sla = hours == null ? null : new Date(observed + hours * 3_600_000);
  const overdue = sla !== null && now.getTime() >= sla.getTime();
  if (overdue) note('sla_overdue');
  // A past recheck_at would be selected again every tick. Once overdue, stop rescheduling.
  return done('awaiting_review', [...info, queueReason('awaiting_review')], overdue || !sla ? null : sla.toISOString(), sla ? sla.toISOString() : null);
}
