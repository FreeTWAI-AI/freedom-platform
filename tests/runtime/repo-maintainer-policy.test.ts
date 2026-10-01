import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAINTAINER_POLICY_VERSION, QUEUE_REASON_CODES, QUEUE_STATES, RISK_REASON_CODES,
  classifyRisk, deriveQueueState, migrationCheck, resolveSettings,
  type PolicyCheck, type PolicyFile, type PolicyReview, type QueueDerivationInput, type QueuePull, type Risk,
} from '../../modules/repo-maintainer/policy.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const settings = resolveSettings('FreeTWAI-AI/freedom-platform', {});

function file(path: string, status = 'modified', additions = 1, deletions = 0, previous: string | null = null): PolicyFile {
  return { path, previous_path: previous, status, additions, deletions };
}
function riskOf(files: PolicyFile[], extra: { author_association?: string; author_type?: string; is_fork?: boolean; changed_files?: number; profile?: 'freedom-platform' | 'default' } = {}) {
  return classifyRisk({ files, profile: extra.profile ?? 'freedom-platform', author_association: extra.author_association, author_type: extra.author_type, is_fork: extra.is_fork, changed_files: extra.changed_files ?? files.length });
}
function codes(result: { reasons: Array<{ code: string; message: string; paths?: string[] }> }, code: string) {
  return result.reasons.filter(reason => reason.code === code);
}

test('repository settings fill defaults and an explicit profile wins', () => {
  assert.equal(MAINTAINER_POLICY_VERSION, '2026-09-30.1');
  assert.equal(settings.rules_profile, 'freedom-platform');
  assert.equal(settings.required_check, 'verify');
  assert.equal(settings.required_check_app_slug, 'github-actions');
  assert.equal(settings.ci_grace_minutes, 15);
  assert.deepEqual(settings.sla_hours, { low: 24, medium: 48, high: null });
  assert.deepEqual(settings.hold_labels, ['hold', 'do-not-merge']);
  assert.equal(resolveSettings('Other/repo', {}).rules_profile, 'default');
  assert.equal(resolveSettings('FreeTWAI-AI/freedom-platform', { rules_profile: 'default' }).rules_profile, 'default');
  assert.equal(resolveSettings('Other/repo', { rules_profile: 'freedom-platform', ci_grace_minutes: 5, sla_hours: { high: 12 } }).sla_hours.high, 12);
  assert.ok(RISK_REASON_CODES.includes('bot_author'));
  assert.ok(QUEUE_REASON_CODES.includes('ci_missing'));
  assert.ok(QUEUE_STATES.includes('in_review'));
});

test('freedom-platform risk classes follow the path rules and escalations', () => {
  const cases: Array<[string, PolicyFile[], Record<string, unknown>, Risk, string]> = [
    ['docs only', [file('docs/guide.md'), file('README.md'), file('DESIGN.md')], {}, 'low', 'low_docs'],
    ['ordinary code', [file('apps/portal-web/src/App.tsx')], {}, 'medium', 'medium_code'],
    ['workflow', [file('.github/workflows/verify.yml')], {}, 'high', 'high_sensitive'],
    ['scripts', [file('scripts/generate-runtime-text.mjs')], {}, 'high', 'high_verification'],
    ['rename into scripts', [file('scripts/run.mjs', 'renamed', 1, 0, 'docs/guide.md')], {}, 'high', 'high_verification'],
    ['removed test', [file('tests/runtime/old.test.ts', 'removed')], {}, 'high', 'test_removed'],
    ['removed spec', [file('apps/portal-web/src/App.spec.tsx', 'removed')], {}, 'high', 'test_removed'],
    ['package markdown', [file('packages/shop-agent/common.md')], {}, 'medium', 'medium_package_markdown'],
    ['brand image', [file('apps/portal-web/public/brand/logo.png')], {}, 'medium', 'medium_brand'],
    ['svg', [file('docs/diagram.svg')], {}, 'medium', 'medium_svg'],
    ['docs code', [file('docs/tool.py')], {}, 'medium', 'medium_docs_code'],
    ['verify script', [file('docs/platform-plan/verification/verify_revision.py')], {}, 'high', 'high_verification'],
    ['agents', [file('docs/AGENTS.md')], {}, 'high', 'high_contract'],
    ['maintainer wrangler', [file('wrangler.maintainer.jsonc')], {}, 'high', 'high_maintainer'],
    ['root raster', [file('photo.png')], {}, 'low', 'low_docs'],
  ];
  for (const [label, files, extra, expected, code] of cases) {
    const result = riskOf(files, extra);
    assert.equal(result.risk, expected, label);
    assert.ok(codes(result, code).length >= 1, `${label} ${JSON.stringify(result.reasons)}`);
  }
  const many = Array.from({ length: 21 }, (_, index) => file(`docs/note-${index}.md`));
  assert.equal(riskOf(many).risk, 'medium');
  assert.ok(codes(riskOf(many), 'size_medium').length === 1);
  const huge = Array.from({ length: 61 }, (_, index) => file(`docs/note-${index}.md`));
  assert.equal(riskOf(huge).risk, 'high');
  assert.equal(riskOf([file('docs/guide.md', 'modified', 3001, 0)]).risk, 'high');
  assert.equal(riskOf([file('docs/guide.md')], { changed_files: 2 }).risk, 'high');
  assert.ok(codes(riskOf([file('docs/guide.md')], { changed_files: 2 }), 'changed_files_truncated').length === 1);
  const first = riskOf([file('docs/guide.md')], { author_association: 'FIRST_TIME_CONTRIBUTOR', is_fork: true });
  assert.equal(first.risk, 'medium');
  assert.ok(codes(first, 'author_first_time_contributor').length === 1);
  assert.ok(codes(first, 'fork_head').length === 1);
  const bot = riskOf([file('docs/guide.md')], { author_type: 'Bot' });
  assert.equal(bot.risk, 'medium');
  assert.match(codes(bot, 'bot_author')[0].message, /自動化審查不能代替真人/);
  const generated = riskOf([
    file('apps/platform-api/src/generated/runtime-text.ts', 'modified', 5000, 0),
    file('docs/platform-plan/verification/2026-09-20-file-inventory.json', 'modified', 5000, 0),
  ]);
  assert.equal(generated.risk, 'low');
  assert.equal(codes(generated, 'size_high').length, 0);
  assert.equal(riskOf([file('apps/portal-web/src/App.tsx')], { profile: 'default' }).risk, 'medium');
  assert.equal(riskOf([file('.github/workflows/verify.yml')], { profile: 'default' }).risk, 'high');
  assert.equal(riskOf([file('docs/guide.md'), file('README.md')], { profile: 'default' }).risk, 'low');
  assert.equal(riskOf([file('SECURITY.md')], { profile: 'default' }).risk, 'high');
  const rename = riskOf([file('scripts/run.mjs', 'renamed', 1, 0, 'docs/guide.md')]);
  assert.ok(codes(rename, 'high_verification')[0].paths?.includes('scripts/run.mjs'));
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
});

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
function derive(over: Partial<QueueDerivationInput> = {}, now = NOW) {
  const input: QueueDerivationInput = {
    pull: pull(), risk: 'low', checks: [check()], reviews: [], reviewers: [], mode: 'observe', settings, migration_reasons: [], ...over,
  };
  if (over.pull) input.pull = over.pull;
  return deriveQueueState(input, now);
}

test('deriveQueueState covers every phase-1a state and does not emit in_review', () => {
  assert.equal(derive({ pull: pull({ merged_at: NOW.toISOString() }) }).state, 'merged');
  assert.equal(derive({ pull: pull({ state: 'closed' }) }).state, 'closed');
  const paused = derive({ pull: pull({ paused: true, labels: ['HOLD'], is_draft: true }), mode: 'off' });
  assert.equal(paused.state, 'paused');
  assert.deepEqual(paused.reasons.map(reason => reason.code).sort(), ['hold_label', 'pull_paused', 'repository_off']);
  assert.equal(derive({ pull: pull({ is_draft: true }) }).state, 'draft');
  assert.equal(derive({ pull: pull({ base_ref: 'release' }) }).state, 'needs_owner');
  assert.equal(derive({ pull: pull({ base_ref: 'release' }) }).reasons[0].code, 'non_default_base');
  assert.equal(derive({ pull: pull({ mergeable: false }) }).reasons[0].code, 'merge_conflict');
  const migration = derive({ migration_reasons: [{ code: 'migration_bad_name', message: '壞檔名' }] });
  assert.equal(migration.state, 'needs_author');
  assert.equal(migration.reasons[0].code, 'migration_bad_name');
  assert.equal(derive({ reviews: [review({ state: 'CHANGES_REQUESTED', reviewer_association: 'NONE' })] }).state, 'awaiting_review');
  assert.equal(derive({ reviews: [review({ state: 'CHANGES_REQUESTED', reviewer_association: 'OWNER' })] }).reasons[0].code, 'changes_requested');
  assert.equal(derive({ reviews: [review({ state: 'CHANGES_REQUESTED', reviewer_association: 'COLLABORATOR' })] }).state, 'needs_author');
  assert.equal(derive({
    reviews: [review({ state: 'CHANGES_REQUESTED', reviewer_github_id: '300', reviewer_association: 'NONE' })],
    reviewers: [{ github_user_id: '300', max_risk: 'low' }],
  }).state, 'needs_author');
  assert.equal(derive({ reviews: [review({ state: 'COMMENTED', reviewer_association: 'OWNER' })] }).state, 'awaiting_review');
  const olderChange = derive({ reviews: [
    review({ github_review_id: '1', state: 'CHANGES_REQUESTED', reviewer_association: 'OWNER', submitted_at: '2026-09-30T10:00:00.000Z' }),
    review({ github_review_id: '2', state: 'APPROVED', reviewer_association: 'OWNER', submitted_at: '2026-09-30T11:00:00.000Z' }),
  ] });
  assert.equal(olderChange.state, 'awaiting_review');
  assert.equal(olderChange.reasons.some(reason => reason.code === 'changes_requested'), false);

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
  const other = derive({ checks: [check(), check({ name: 'lint', conclusion: 'failure' })] });
  assert.equal(other.state, 'awaiting_review');
  assert.ok(other.reasons.some(reason => reason.code === 'other_check_failed'));

  const ready = derive({ risk: 'high', reviews: [review()], reviewers: [{ github_user_id: '200', max_risk: 'high' }] });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.reasons.at(-1)?.code, 'ready_human_approved');
  const stale = derive({ reviews: [review({ commit_id: OLD })] });
  assert.equal(stale.state, 'awaiting_review');
  assert.ok(stale.reasons.some(reason => reason.code === 'approval_stale'));
  const lowRank = derive({ risk: 'high', reviews: [review()], reviewers: [{ github_user_id: '200', max_risk: 'medium' }] });
  assert.equal(lowRank.state, 'needs_owner');
  assert.ok(lowRank.reasons.some(reason => reason.code === 'approval_rank_too_low'));
  assert.ok(lowRank.reasons.some(reason => reason.code === 'high_risk_requires_owner'));
  const self = derive({ reviews: [review({ reviewer_github_id: '100' })], reviewers: [{ github_user_id: '100', max_risk: 'high' }] });
  assert.equal(self.state, 'awaiting_review');
  assert.ok(self.reasons.some(reason => reason.code === 'owner_authored'));
  assert.equal(self.reasons.some(reason => reason.code === 'ready_human_approved'), false);
  assert.equal(derive({ risk: 'high' }).state, 'needs_owner');
  const waiting = derive();
  assert.equal(waiting.state, 'awaiting_review');
  assert.equal(waiting.sla_due_at, new Date(NOW.getTime() - 60 * 60_000 + 24 * 3_600_000).toISOString());
  assert.equal(waiting.recheck_at, waiting.sla_due_at);
  const overdue = derive({ pull: pull({ head_observed_at: new Date(NOW.getTime() - 48 * 3_600_000).toISOString() }) });
  assert.equal(overdue.state, 'awaiting_review');
  assert.equal(overdue.recheck_at, null);
  assert.ok(overdue.reasons.some(reason => reason.code === 'sla_overdue'));
  assert.ok(overdue.sla_due_at);
  const seen = [
    derive({ pull: pull({ merged_at: NOW.toISOString() }) }).state,
    derive({ pull: pull({ state: 'closed' }) }).state,
    paused.state, derive({ pull: pull({ is_draft: true }) }).state, pending.state, boundary.state,
    migration.state, waiting.state, ready.state, lowRank.state,
  ];
  assert.equal(seen.includes('in_review'), false);
});

test('pull 46 is high risk and needs the author because of the conflict and migration numbers', () => {
  const raw = JSON.parse(readFileSync('tests/runtime/fixtures/repo-maintainer/pr-46-files.json', 'utf8')) as Array<{ filename: string; previous_filename: string | null; status: string; additions: number; deletions: number }>;
  assert.equal(raw.length, 38);
  const files = raw.map(item => file(item.filename, item.status, item.additions, item.deletions, item.previous_filename));
  const additions = raw.reduce((sum, item) => sum + item.additions, 0);
  const deletions = raw.reduce((sum, item) => sum + item.deletions, 0);
  assert.equal(additions, 1781);
  assert.equal(deletions, 180);
  const classified = riskOf(files, { author_association: 'FIRST_TIME_CONTRIBUTOR', is_fork: true, changed_files: 38 });
  assert.equal(classified.risk, 'high');
  const paths = classified.reasons.flatMap(reason => reason.paths ?? []);
  assert.ok(paths.some(path => path.startsWith('migrations/')), paths.join(','));
  assert.ok(paths.some(path => path.startsWith('scripts/')), paths.join(','));
  const base = Array.from({ length: 56 }, (_, index) => `${String(index + 1).padStart(3, '0')}_base.sql`);
  const migrations = migrationCheck(files, base);
  assert.equal(migrations.filter(reason => reason.code === 'migration_number_collision').length, 2);
  const derived = derive({
    pull: pull({ mergeable: false, mergeable_state: 'dirty', author_github_id: '46' }),
    risk: classified.risk,
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
