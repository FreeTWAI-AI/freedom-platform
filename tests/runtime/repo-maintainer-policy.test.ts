import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ATTENTION_REASON_CODES, MAINTAINER_POLICY_VERSION, QUEUE_REASON_CODES, QUEUE_STATES,
  classifyAttention, deriveQueueState, migrationCheck, repositorySettingsSchema, resolveSettings,
  type AttentionInput, type PolicyCheck, type PolicyFile, type PolicyReview, type QueueClaim, type QueueDerivation, type QueueDerivationInput, type QueuePull,
} from '../../modules/repo-maintainer/policy.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const settings = resolveSettings('FreeTWAI-AI/freedom-platform', {});
const FORBIDDEN = /風險|擁有者|真人/;

function file(path: string, status = 'modified', additions = 1, deletions = 0, previous: string | null = null): PolicyFile {
  return { path, previous_path: previous, status, additions, deletions };
}
function attention(files: PolicyFile[], extra: Partial<AttentionInput> = {}) {
  return classifyAttention({ files, profile: extra.profile ?? 'freedom-platform', changed_files: extra.changed_files ?? files.length, files_truncated: extra.files_truncated });
}
function codes(reasons: Array<{ code: string }>) {
  return reasons.map(reason => reason.code);
}
function pull(over: Partial<QueuePull> = {}): QueuePull {
  return {
    state: 'open', merged_at: null, is_draft: false, base_ref: 'main', default_branch: 'main',
    mergeable: true, mergeable_state: 'clean', labels: [], head_sha: HEAD,
    head_observed_at: new Date(NOW.getTime() - 60 * 60_000).toISOString(), author_github_id: '100', paused: false, ...over,
  };
}
function check(over: Partial<PolicyCheck> = {}): PolicyCheck {
  return { source: 'check_run', name: 'verify', app_slug: 'github-actions', head_sha: HEAD, status: 'completed', conclusion: 'success', ...over };
}
function review(over: Partial<PolicyReview> = {}): PolicyReview {
  return {
    github_review_id: '1', reviewer_github_id: '200', reviewer_association: 'NONE', state: 'APPROVED',
    commit_id: HEAD, submitted_at: '2026-09-30T11:00:00.000Z', ...over,
  };
}
function derive(over: Partial<QueueDerivationInput> = {}, now = NOW): QueueDerivation {
  const input: QueueDerivationInput = {
    pull: over.pull ?? pull(), eligible_reviewer_ids: over.eligible_reviewer_ids ?? [], checks: over.checks ?? [check()],
    reviews: over.reviews ?? [], mode: over.mode ?? 'observe', settings, migration_reasons: over.migration_reasons ?? [], claim: over.claim,
  };
  return deriveQueueState(input, now);
}
function claim(over: Partial<QueueClaim> = {}): QueueClaim {
  return { reviewer_login: 'ada', acting_as: 'admin', guild_name: null, adopts_repository: false, expires_at: null, ...over };
}

test('repository settings fill defaults and reject a retired sla_hours field', () => {
  assert.equal(MAINTAINER_POLICY_VERSION, '2026-10-01.1');
  assert.equal(settings.rules_profile, 'freedom-platform');
  assert.equal(settings.required_check, 'verify');
  assert.equal(settings.required_check_app_slug, 'github-actions');
  assert.equal(settings.ci_grace_minutes, 15);
  assert.equal(settings.claim_hours, null);
  assert.equal('sla_hours' in settings, false);
  assert.deepEqual(settings.hold_labels, ['hold', 'do-not-merge']);
  assert.equal(resolveSettings('Other/repo', {}).rules_profile, 'default');
  assert.equal(resolveSettings('FreeTWAI-AI/freedom-platform', { rules_profile: 'default' }).rules_profile, 'default');
  assert.equal(resolveSettings('Other/repo', { claim_hours: 12, request_reviewers: true }).claim_hours, 12);
  assert.equal(settings.request_reviewers, false);
  assert.equal(resolveSettings('Other/repo', { claim_hours: null }).claim_hours, null);
  assert.throws(() => resolveSettings('Other/repo', { claim_hours: 0 }));
  assert.throws(() => resolveSettings('Other/repo', { claim_hours: 169 }));
  assert.throws(() => repositorySettingsSchema.parse({ claim_hours: null }));
  assert.throws(() => resolveSettings('Other/repo', { sla_hours: { high: 12 } }));
  assert.ok(QUEUE_REASON_CODES.includes('review_claimed'));
  assert.ok(QUEUE_REASON_CODES.includes('approval_not_eligible'));
  assert.ok(QUEUE_REASON_CODES.includes('author_is_reviewer'));
  assert.equal((QUEUE_REASON_CODES as readonly string[]).includes('sla_overdue'), false);
  assert.equal((QUEUE_REASON_CODES as readonly string[]).includes('approval_rank_too_low'), false);
  assert.ok(QUEUE_STATES.includes('needs_decision'));
  assert.equal(QUEUE_STATES.includes('needs_owner' as never), false);
  assert.deepEqual(ATTENTION_REASON_CODES.includes('sensitive'), true);
  const source = readFileSync('modules/repo-maintainer/policy.ts', 'utf8');
  const maps = source.slice(source.indexOf('const ATTENTION_MESSAGES'), source.indexOf('const FAILING'));
  assert.equal(FORBIDDEN.test(maps), false);
});

test('classifyAttention keeps path order, then size, then a truncated file list', () => {
  const cases: Array<[string, PolicyFile[], Partial<AttentionInput>, string[]]> = [
    ['docs only', [file('docs/guide.md'), file('README.md'), file('DESIGN.md')], {}, []],
    ['ordinary code', [file('apps/portal-web/src/App.tsx')], {}, []],
    ['workflow', [file('.github/workflows/verify.yml')], {}, ['sensitive']],
    ['scripts', [file('scripts/generate-runtime-text.mjs')], {}, ['verification']],
    ['repositories lock', [file('repositories.lock.json')], {}, ['verification']],
    ['npmrc', [file('.npmrc')], {}, ['verification']],
    ['gitattributes', [file('.gitattributes')], {}, ['verification']],
    ['gitmodules', [file('.gitmodules')], {}, ['verification']],
    ['rename into scripts', [file('scripts/run.mjs', 'renamed', 1, 0, 'docs/guide.md')], {}, ['verification']],
    ['removed test', [file('tests/runtime/old.test.ts', 'removed')], {}, ['test_removed']],
    ['removed spec', [file('apps/portal-web/src/App.spec.tsx', 'removed')], {}, ['test_removed']],
    ['package markdown', [file('packages/shop-agent/common.md')], {}, ['package_markdown']],
    ['brand image', [file('apps/portal-web/public/brand/logo.png')], {}, ['brand']],
    ['svg', [file('docs/diagram.svg')], {}, ['svg']],
    ['docs code', [file('docs/tool.py')], {}, ['docs_code']],
    ['verify script', [file('docs/platform-plan/verification/verify_revision.py')], {}, ['verification']],
    ['agents', [file('docs/AGENTS.md')], {}, ['contract']],
    ['maintainer wrangler', [file('wrangler.maintainer.jsonc')], {}, ['maintainer']],
    ['migrations', [file('migrations/060_new.sql')], {}, ['data_deploy']],
    ['authority', [file('apps/platform-api/src/routes/admin.ts')], {}, ['authority']],
    ['root raster', [file('photo.png')], {}, []],
  ];
  const expectedMessage: Record<string, string> = {
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
  for (const [label, files, extra, expected] of cases) {
    const reasons = attention(files, extra);
    assert.deepEqual(codes(reasons), expected, label);
    for (const reason of reasons) {
      assert.equal(reason.message, expectedMessage[reason.code], label);
      assert.equal(FORBIDDEN.test(reason.message), false, label);
    }
  }
  const ordered = attention([
    file('docs/guide.md'),
    file('.github/workflows/verify.yml'),
    file('scripts/run.mjs'),
    ...Array.from({ length: 19 }, (_, index) => file(`docs/note-${index}.md`)),
  ], { files_truncated: true });
  assert.deepEqual(codes(ordered), ['sensitive', 'verification', 'size_large', 'changed_files_truncated']);
  assert.equal(ordered[0].paths?.[0], '.github/workflows/verify.yml');
  const many = attention(Array.from({ length: 21 }, (_, index) => file(`docs/note-${index}.md`)));
  assert.deepEqual(codes(many), ['size_large']);
  assert.equal(many[0].message, expectedMessage.size_large);
  const boundary = attention(Array.from({ length: 20 }, (_, index) => file(`docs/note-${index}.md`)));
  assert.deepEqual(codes(boundary), []);
  const huge = attention(Array.from({ length: 61 }, (_, index) => file(`docs/note-${index}.md`)));
  assert.deepEqual(codes(huge), ['size_huge']);
  const longDiff = attention([file('docs/guide.md', 'modified', 3001, 0)]);
  assert.deepEqual(codes(longDiff), ['size_huge']);
  const lineBoundary = attention([file('docs/guide.md', 'modified', 800, 0)]);
  assert.deepEqual(codes(lineBoundary), []);
  const mediumLines = attention([file('docs/guide.md', 'modified', 801, 0)]);
  assert.deepEqual(codes(mediumLines), ['size_large']);
  const shortList = attention([file('docs/guide.md')], { changed_files: 2 });
  assert.deepEqual(codes(shortList), ['changed_files_truncated']);
  const truncatedList = attention([file('docs/guide.md')], { changed_files: 1, files_truncated: true });
  assert.deepEqual(codes(truncatedList), ['changed_files_truncated']);
  assert.deepEqual(codes(attention([file('tests/b.test.ts', 'renamed', 1, 0, 'tests/a.test.ts')])), []);
  const renamedToSource = attention([file('tests/a.ts', 'renamed', 1, 0, 'tests/a.test.ts')]);
  assert.deepEqual(codes(renamedToSource), ['test_removed']);
  assert.deepEqual(renamedToSource[0].paths, ['tests/a.test.ts']);
  assert.deepEqual(codes(attention([file('src/x.ts', 'renamed', 1, 0, 'tests/x.ts')])), ['test_removed']);
  assert.deepEqual(codes(attention([file('docs/guide.md')], { profile: 'default' })), []);
  assert.deepEqual(codes(attention([file('apps/portal-web/src/App.tsx')], { profile: 'default' })), []);
  assert.deepEqual(codes(attention([file('.github/workflows/verify.yml')], { profile: 'default' })), ['sensitive']);
  assert.deepEqual(codes(attention([file('SECURITY.md')], { profile: 'default' })), ['contract']);
  const generated = attention([
    file('apps/platform-api/src/generated/runtime-text.ts', 'modified', 5000, 0),
    file('docs/platform-plan/verification/2026-09-20-file-inventory.json', 'modified', 5000, 0),
  ]);
  assert.deepEqual(codes(generated), []);
  const rename = attention([file('scripts/run.mjs', 'renamed', 1, 0, 'docs/guide.md')]);
  assert.ok(rename[0].paths?.includes('scripts/run.mjs'));
});

test('migrationCheck names colliding, duplicate, modified and badly named files', () => {
  const base = Array.from({ length: 56 }, (_, index) => `${String(index + 1).padStart(3, '0')}_base.sql`);
  const collision = migrationCheck([file('migrations/048_agent_shops.sql', 'added'), file('migrations/049_commerce_distribution.sql', 'added')], base);
  assert.equal(collision.length, 2);
  assert.ok(collision.every(reason => reason.code === 'migration_number_collision'));
  assert.match(collision.map(reason => reason.message).join('\n'), /048/);
  assert.match(collision.map(reason => reason.message).join('\n'), /049/);
  assert.match(collision[0].message, /056/);
  assert.match(collision[0].message, /057/);
  const duplicate = migrationCheck([file('migrations/057_a.sql', 'added'), file('migrations/057_b.sql', 'added')], base);
  assert.deepEqual(duplicate.map(reason => reason.code), ['migration_duplicate_in_pr']);
  assert.deepEqual(duplicate[0].paths, ['migrations/057_a.sql', 'migrations/057_b.sql']);
  const modified = migrationCheck([file('migrations/010_base.sql', 'modified')], base);
  assert.equal(modified[0].code, 'migration_modified');
  assert.match(modified[0].message, /010_base\.sql/);
  const renamed = migrationCheck([file('migrations/057_new.sql', 'renamed', 1, 0, 'migrations/010_base.sql')], base);
  assert.deepEqual(renamed.map(reason => reason.code), ['migration_modified']);
  const bad = migrationCheck([file('migrations/readme.md', 'added')], base);
  assert.equal(bad[0].code, 'migration_bad_name');
  assert.match(bad[0].message, /readme\.md/);
  assert.deepEqual(migrationCheck([file('migrations/057_ok.sql', 'added')], base), []);
  const gapped = base.filter(name => !name.startsWith('050_'));
  const behind = migrationCheck([file('migrations/050_gap.sql', 'added')], gapped);
  assert.equal(behind.length, 1);
  assert.equal(behind[0].code, 'migration_number_behind');
  assert.equal(behind[0].message, '編號 050 小於 main 目前最新的 056，遷移只能往後加。請改用 057 或之後的編號。');
  const onDevelop = migrationCheck([file('migrations/048_agent_shops.sql', 'added')], base, 'migrations', 'develop');
  assert.equal(onDevelop[0].code, 'migration_number_collision');
  assert.match(onDevelop[0].message, /編號 048 已存在於 develop/);
  assert.equal(derive({ migration_reasons: behind }).state, 'needs_author');
});

test('deriveQueueState uses eligible reviewers and has no sla fields', () => {
  assert.equal(derive({ pull: pull({ merged_at: NOW.toISOString() }) }).state, 'merged');
  assert.equal(derive({ pull: pull({ state: 'closed' }) }).state, 'closed');
  const paused = derive({ pull: pull({ paused: true, labels: ['HOLD'], is_draft: true }), mode: 'off' });
  assert.equal(paused.state, 'paused');
  assert.deepEqual(paused.reasons.map(reason => reason.code).sort(), ['hold_label', 'pull_paused', 'repository_off']);
  assert.equal(derive({ pull: pull({ is_draft: true }) }).state, 'draft');
  const otherBase = derive({ pull: pull({ base_ref: 'release' }) });
  assert.equal(otherBase.state, 'needs_decision');
  assert.equal(otherBase.reasons[0].code, 'non_default_base');
  assert.equal(otherBase.reasons[0].message, '這個 PR 不是要合併到預設分支，請公會長或管理員決定怎麼處理。');
  assert.equal(derive({ pull: pull({ mergeable: false }) }).reasons[0].code, 'merge_conflict');
  const migration = derive({ migration_reasons: [{ code: 'migration_bad_name', message: '壞檔名' }] });
  assert.equal(migration.state, 'needs_author');
  assert.equal(migration.reasons[0].code, 'migration_bad_name');
  assert.equal(derive({ reviews: [review({ state: 'CHANGES_REQUESTED', reviewer_association: 'NONE' })] }).state, 'awaiting_review');
  assert.equal(derive({ reviews: [review({ state: 'CHANGES_REQUESTED', reviewer_association: 'OWNER' })] }).reasons[0].code, 'changes_requested');
  assert.equal(derive({ reviews: [review({ state: 'CHANGES_REQUESTED', reviewer_association: 'COLLABORATOR' })] }).state, 'needs_author');
  assert.equal(derive({
    reviews: [review({ state: 'CHANGES_REQUESTED', reviewer_github_id: '300', reviewer_association: 'NONE' })],
    eligible_reviewer_ids: ['300'],
  }).state, 'needs_author');
  assert.equal(derive({ reviews: [review({ state: 'COMMENTED', reviewer_association: 'OWNER' })] }).state, 'awaiting_review');
  const olderChange = derive({ reviews: [
    review({ github_review_id: '1', state: 'CHANGES_REQUESTED', reviewer_association: 'OWNER', submitted_at: '2026-09-30T10:00:00.000Z' }),
    review({ github_review_id: '2', state: 'APPROVED', reviewer_association: 'OWNER', submitted_at: '2026-09-30T11:00:00.000Z' }),
  ] });
  assert.equal(olderChange.state, 'awaiting_review');
  assert.equal(olderChange.reasons.some(reason => reason.code === 'changes_requested'), false);
  assert.ok(olderChange.reasons.some(reason => reason.code === 'approval_not_eligible'));

  const observed = new Date(NOW.getTime() - 14 * 60_000).toISOString();
  const pending = derive({ pull: pull({ head_observed_at: observed }), checks: [] });
  assert.equal(pending.state, 'waiting_ci');
  assert.equal(pending.reasons.at(-1)?.code, 'ci_pending');
  assert.equal(pending.recheck_at, new Date(NOW.getTime() + 60_000).toISOString());
  const boundary = derive({ pull: pull({ head_observed_at: new Date(NOW.getTime() - 15 * 60_000).toISOString() }), checks: [] });
  assert.equal(boundary.state, 'ci_not_run');
  assert.equal(boundary.reasons.at(-1)?.code, 'ci_missing');
  assert.match(boundary.reasons.at(-1)?.message ?? '', /fork/);
  const wrong = derive({ checks: [check({ source: 'status', app_slug: null, conclusion: 'success' })] });
  assert.equal(wrong.state, 'ci_not_run');
  assert.ok(wrong.reasons.some(reason => reason.code === 'required_check_wrong_source'));
  assert.equal(derive({ checks: [check({ conclusion: 'failure', status: 'completed' })] }).reasons.at(-1)?.code, 'ci_failed');
  assert.equal(derive({ checks: [check({ conclusion: 'skipped' })] }).reasons.at(-1)?.code, 'ci_failed');
  assert.equal(derive({ checks: [check({ conclusion: 'action_required' })] }).reasons.at(-1)?.code, 'workflow_approval_required');
  assert.equal(derive({ checks: [check({ status: 'in_progress', conclusion: null })] }).reasons.at(-1)?.code, 'ci_running');
  const checkStatuses: Array<[string, string | null, string]> = [
    ['queued', null, 'ci_running'],
    ['in_progress', null, 'ci_running'],
    ['waiting', null, 'ci_running'],
    ['requested', null, 'ci_running'],
    ['pending', null, 'ci_running'],
    ['completed', 'success', 'awaiting_review'],
    ['completed', 'failure', 'ci_failed'],
    ['completed', 'action_required', 'workflow_approval_required'],
    ['waiting', 'action_required', 'workflow_approval_required'],
  ];
  for (const [status, conclusion, expected] of checkStatuses) {
    const derived = derive({ checks: [check({ status, conclusion })] });
    const got = expected === 'awaiting_review' ? derived.state : derived.reasons.at(-1)?.code;
    assert.equal(got, expected, `${status}/${String(conclusion)}`);
  }
  const other = derive({ checks: [check(), check({ name: 'lint', conclusion: 'failure' })] });
  assert.equal(other.state, 'awaiting_review');
  assert.ok(other.reasons.some(reason => reason.code === 'other_check_failed'));

  const ready = derive({ reviews: [review()], eligible_reviewer_ids: ['200'] });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.reasons.at(-1)?.code, 'ready_human_approved');
  assert.equal(ready.reasons.at(-1)?.message, '公會長或管理員已核准目前的提交。');
  const stale = derive({ reviews: [review({ commit_id: OLD })], eligible_reviewer_ids: ['200'] });
  assert.equal(stale.state, 'awaiting_review');
  assert.ok(stale.reasons.some(reason => reason.code === 'approval_stale'));
  const outsider = derive({ reviews: [review()] });
  assert.equal(outsider.state, 'awaiting_review');
  assert.ok(outsider.reasons.some(reason => reason.code === 'approval_not_eligible'));
  assert.equal(outsider.reasons.find(reason => reason.code === 'approval_not_eligible')?.message, '有人核准了目前的提交，但不是這個項目的公會長或管理員，不算有效核准。');
  const self = derive({ reviews: [review({ reviewer_github_id: '100' })], eligible_reviewer_ids: ['100'] });
  assert.equal(self.state, 'awaiting_review');
  assert.ok(self.reasons.some(reason => reason.code === 'author_is_reviewer'));
  assert.equal(self.reasons.find(reason => reason.code === 'author_is_reviewer')?.message, '作者本人也是這個項目的審核人，不能核准自己的 PR，需要另一位公會長或管理員核准。');
  assert.equal(self.reasons.some(reason => reason.code === 'ready_human_approved'), false);
  const waiting = derive();
  assert.equal(waiting.state, 'awaiting_review');
  assert.equal(waiting.reasons.at(-1)?.message, '檢查已過，等公會長或管理員核准。');
  assert.equal(waiting.recheck_at, null);
  assert.equal('sla_due_at' in waiting, false);
  const seen = [
    derive({ pull: pull({ merged_at: NOW.toISOString() }) }).state,
    derive({ pull: pull({ state: 'closed' }) }).state,
    paused.state, derive({ pull: pull({ is_draft: true }) }).state, pending.state, boundary.state,
    migration.state, waiting.state, ready.state, otherBase.state,
  ];
  assert.equal(seen.includes('in_review'), false);
  for (const derived of [waiting, ready, outsider, self, otherBase]) {
    for (const reason of derived.reasons) assert.equal(FORBIDDEN.test(reason.message), false, reason.code);
  }
});

test('an active claim turns only awaiting review into in_review', () => {
  const expires = new Date(NOW.getTime() + 3_600_000).toISOString();
  const live = claim();
  const cases: Array<[string, Partial<QueueDerivationInput>, string, boolean]> = [
    ['awaiting', { claim: live }, 'in_review', true],
    ['null expiry', { claim: claim({ expires_at: null }) }, 'in_review', true],
    ['expired', { claim: claim({ expires_at: NOW.toISOString() }) }, 'awaiting_review', false],
    ['past', { claim: claim({ expires_at: new Date(NOW.getTime() - 1000).toISOString() }) }, 'awaiting_review', false],
    ['invalid', { claim: claim({ expires_at: 'not-a-date' }) }, 'awaiting_review', false],
    ['absent', {}, 'awaiting_review', false],
    ['ready', { claim: live, reviews: [review()], eligible_reviewer_ids: ['200'] }, 'ready', false],
    ['other base', { claim: live, pull: pull({ base_ref: 'release' }) }, 'needs_decision', false],
    ['merged', { claim: live, pull: pull({ merged_at: NOW.toISOString() }) }, 'merged', false],
    ['closed', { claim: live, pull: pull({ state: 'closed' }) }, 'closed', false],
    ['paused', { claim: live, pull: pull({ paused: true }) }, 'paused', false],
    ['draft', { claim: live, pull: pull({ is_draft: true }) }, 'draft', false],
    ['author', { claim: live, migration_reasons: [{ code: 'migration_bad_name', message: '壞檔名' }] }, 'needs_author', false],
    ['ci running', { claim: live, pull: pull({ head_observed_at: new Date(NOW.getTime() - 14 * 60_000).toISOString() }), checks: [] }, 'waiting_ci', false],
    ['ci missing', { claim: live, pull: pull({ head_observed_at: new Date(NOW.getTime() - 15 * 60_000).toISOString() }), checks: [] }, 'ci_not_run', false],
  ];
  for (const [label, over, state, claimed] of cases) {
    const derived = derive(over);
    assert.equal(derived.state, state, label);
    assert.equal(derived.reasons.some(reason => reason.code === 'review_claimed'), claimed, label);
    assert.equal('sla_due_at' in derived, false, label);
  }
  const admin = derive({ claim: claim({ expires_at: expires }) });
  assert.equal(admin.reasons.at(-1)?.message, 'ada（管理員）正在審查。認領到期後會自動釋放。');
  assert.equal(admin.recheck_at, expires);
  const leader = derive({ claim: claim({ acting_as: 'guild_leader', guild_name: '平台工程公會' }) });
  assert.equal(leader.reasons.at(-1)?.message, 'ada（平台工程公會・公會長）正在審查。');
  assert.equal(leader.recheck_at, null);
  const adopting = derive({ claim: claim({ acting_as: 'guild_leader', guild_name: '平台工程公會', adopts_repository: true, expires_at: expires }) });
  assert.equal(adopting.reasons.at(-1)?.message, 'ada（平台工程公會・公會長）正在審查。審完後這個儲存庫會歸到平台工程公會。認領到期後會自動釋放。');
  assert.equal(FORBIDDEN.test(adopting.reasons.at(-1)?.message ?? ''), false);
});

test('pull 46 needs the author because of the conflict and migration numbers', () => {
  const raw = JSON.parse(readFileSync('tests/runtime/fixtures/repo-maintainer/pr-46-files.json', 'utf8')) as Array<{ filename: string; previous_filename: string | null; status: string; additions: number; deletions: number }>;
  assert.equal(raw.length, 38);
  const files = raw.map(item => file(item.filename, item.status, item.additions, item.deletions, item.previous_filename));
  const additions = raw.reduce((sum, item) => sum + item.additions, 0);
  const deletions = raw.reduce((sum, item) => sum + item.deletions, 0);
  assert.equal(additions, 1781);
  assert.equal(deletions, 180);
  const classified = attention(files, { changed_files: 38 });
  assert.ok(codes(classified).includes('data_deploy'));
  assert.ok(codes(classified).includes('verification'));
  assert.ok(codes(classified).includes('size_large'));
  const paths = classified.flatMap(reason => reason.paths ?? []);
  assert.ok(paths.some(path => path.startsWith('migrations/')), paths.join(','));
  assert.ok(paths.some(path => path.startsWith('scripts/')), paths.join(','));
  const base = Array.from({ length: 56 }, (_, index) => `${String(index + 1).padStart(3, '0')}_base.sql`);
  const migrations = migrationCheck(files, base);
  assert.equal(migrations.filter(reason => reason.code === 'migration_number_collision').length, 2);
  const derived = derive({
    pull: pull({ mergeable: false, mergeable_state: 'dirty', author_github_id: '46' }),
    checks: [],
    migration_reasons: migrations,
  });
  assert.equal(derived.state, 'needs_author');
  assert.ok(derived.reasons.some(reason => reason.code === 'merge_conflict'));
  assert.equal(derived.reasons.filter(reason => reason.code === 'migration_number_collision').length, 2);
  const text = derived.reasons.map(reason => reason.message).join('\n');
  assert.match(text, /048/);
  assert.match(text, /049/);
  assert.match(text, /056/);
  assert.match(text, /057/);
});
