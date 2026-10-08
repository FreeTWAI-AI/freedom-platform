import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

// Reviewed host data. Package scripts, globs and descriptors never change a suite.
// A directory suite runs its baseline plus every candidate file in its directory
// that matches its pattern: a candidate can add tests but cannot drop a baseline
// file. To remove or rename a baseline test, edit its baseline here on main in a
// reviewed PR. CI runs the pinned copy (job.workflow_sha), so the change applies
// from the next central pin upgrade, and the old file must stay until then.

export const E2E_BASELINE = Object.freeze(`
admin-credentials.spec.ts admin-guilds.spec.ts admin-review-center.spec.ts admin.spec.ts
agent-shops.spec.ts ai-sister-guides.spec.ts audit-identity-final.spec.ts audit-identity.spec.ts
audit-operations.spec.ts audit-shell.spec.ts audit-skills.spec.ts avatar.spec.ts benefits.spec.ts
calm-experience.spec.ts campaign-draft-newlines.spec.ts chat-stickers.spec.ts
client-connections-recovery.spec.ts cloud-candidate-acceptance.spec.ts co-creation.spec.ts
commerce-modules.spec.ts development-access.spec.ts development-guide.spec.ts
device-connections.spec.ts event-highlights.spec.ts event-public.spec.ts events-past.spec.ts
game-console.spec.ts github-setup.spec.ts github-social.spec.ts guild-alias.spec.ts
guild-category-preferences.spec.ts guild-entry-questions.spec.ts guild-launchpad.spec.ts
guild-launchpad-my-work.spec.ts
guild-member-tiers.spec.ts guild-members.spec.ts guild-organization.spec.ts guild-reviews.spec.ts
guild-workspace.spec.ts help-box-padding.spec.ts journeys.spec.ts member-avatar-asset.spec.ts
member-channels-real.spec.ts member-channels.spec.ts member-connections-51.spec.ts
member-connections.spec.ts member-directory.spec.ts member-ecard.spec.ts
member-editorial-card.spec.ts member-experience.spec.ts member-home-next-step.spec.ts
member-services.spec.ts member-session-lifecycle.spec.ts member-settings-real.spec.ts
member-settings.spec.ts member-todos-real.spec.ts member-todos.spec.ts model-settings.spec.ts
modules-beginners.spec.ts navigation-audit.spec.ts newcomer-guides.spec.ts
notification-bell-actions.spec.ts onboarding-members.spec.ts onboarding-recovery.spec.ts
opensource-modules.spec.ts page-issue-recovery.spec.ts page-tools-notification.spec.ts
page-tools.spec.ts password-recovery.spec.ts positioning-modules.spec.ts private-work-ai.spec.ts
repo-author-claims.spec.ts session-recovery.spec.ts share-promotion.spec.ts sidebar-refine.spec.ts
simple-work-sharing.spec.ts skill-book-library.spec.ts skill-book-upgrade.spec.ts
skill-editor-guild-access.spec.ts skill-sharing.spec.ts skill-upload.spec.ts social-links.spec.ts
squad-invitations.spec.ts squad-types-channel.spec.ts tenant-ownership.spec.ts
tenant-workspaces.spec.ts text-autospace.spec.ts typed-line-breaks.spec.ts workshop-design.spec.ts
`.trim().split(/\s+/).map(n => `tests/e2e/${n}`).sort());

// Host-owned whole-pass bounds; candidate config and environment cannot enlarge them.
export const E2E_PASS_TIMEOUT_MS = Object.freeze({
  default: 40 * 60 * 1000,
  'private-ai': 30 * 60 * 1000,
  'avatar-asset': 30 * 60 * 1000,
});

export const E2E_PLAN = Object.freeze([
  { id: 'default', env: {}, files: [] },
  { id: 'private-ai', env: { FREEDOM_E2E_PRIVATE_AI_FIXTURE: '1' }, files: ['tests/e2e/private-work-ai.spec.ts'] },
  { id: 'avatar-asset', env: { FREEDOM_E2E_AVATAR_ASSET_FIXTURE: '1' }, files: ['tests/e2e/member-avatar-asset.spec.ts'] }
]);

const SPEC_NAME = /^[a-z0-9][a-z0-9-]*\.spec\.ts$/;
const text = value => typeof value === 'string' && !value.includes('\0');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Playwright 1.63 JSON: file suites are relative to config.rootDir, test.status
// is an outcome, and results[].status is an execution state. No test.titlePath.
export function evaluateE2ePasses(expectedFiles, passReports, options = {}) {
  let reason = 'tests_executed';
  const identities = new Map();
  let selected_files = [], passes = [];
  try {
    if (!Array.isArray(expectedFiles) || expectedFiles.some(file => !text(file)
      || !file.startsWith('tests/e2e/') || !SPEC_NAME.test(file.slice('tests/e2e/'.length)))
      || new Set(expectedFiles).size !== expectedFiles.length) throw Error('invalid_expected_files');
    selected_files = [...expectedFiles].sort();
    if (!selected_files.length) throw Error('empty_test_set');
    if (!object(options) || !text(options.rootDir) || !options.rootDir.startsWith('/')
      || options.rootDir.includes('\\')) throw Error('invalid_root_dir');
    if (!text(options.configFile) || !isAbsolute(options.configFile)) throw Error('invalid_test_results');
    if (!Array.isArray(passReports)) throw Error('invalid_pass_plan');
    passes = passReports.map(pass => ({ id: text(pass?.id) ? pass.id : '',
      exit_code: Number.isInteger(pass?.exit_code) ? pass.exit_code : null,
      ...(typeof pass?.evidence_sha256 === 'string' && /^[a-f0-9]{64}$/.test(pass.evidence_sha256)
        ? { evidence_sha256: pass.evidence_sha256 } : {}) }));
    if (passReports.length !== E2E_PLAN.length || passReports.some((pass, i) => pass?.id !== E2E_PLAN[i].id)) {
      throw Error('invalid_pass_plan');
    }
    const expected = new Set(selected_files);
    for (const [index, pass] of passReports.entries()) {
      if (pass.exit_code !== 0) throw Error('test_process_failed');
      const report = pass.report;
      if (!object(report) || !object(report.config) || report.config.rootDir !== options.rootDir
        || report.config.configFile !== options.configFile || report.config.forbidOnly !== true
        || !Array.isArray(report.config.projects) || report.config.projects.length !== 1
        || report.config.projects[0]?.name !== 'chromium' || report.config.projects[0]?.testDir !== options.rootDir
        || !Array.isArray(report.errors) || !object(report.stats) || !Array.isArray(report.suites)
        || ['expected', 'skipped', 'unexpected', 'flaky'].some(key => !Number.isSafeInteger(report.stats[key]) || report.stats[key] < 0)) {
        throw Error('invalid_test_results');
      }
      if (report.errors.length || report.stats.unexpected !== 0 || report.stats.flaky !== 0) throw Error('test_not_passed');
      const seen = new Set();
      const visit = (suite, file, titles) => {
        if (!object(suite) || !text(suite.title) || !text(suite.file) || !SPEC_NAME.test(suite.file)
          || suite.file !== file || !Array.isArray(suite.specs)
          || (suite.suites !== undefined && !Array.isArray(suite.suites))) throw Error('invalid_test_results');
        const path = 'tests/e2e/' + file;
        if (!expected.has(path)) throw Error('unexpected_file');
        for (const spec of suite.specs) {
          if (!object(spec) || !text(spec.file) || !SPEC_NAME.test(spec.file) || spec.file !== file
            || !text(spec.title) || !Array.isArray(spec.tests) || !spec.tests.length) throw Error('invalid_test_results');
          if (index > 0 && !E2E_PLAN[index].files.includes(path)) throw Error('unexpected_file_in_pass');
          for (const test of spec.tests) {
            if (!object(test) || !text(test.projectName) || !Array.isArray(test.results)) throw Error('invalid_test_results');
            const identity = createHash('sha256').update(`${path}\0${titles.join('\0')}\0${spec.title}\0${test.projectName}`).digest('hex');
            if (seen.has(identity)) throw Error('duplicate_test_identity');
            seen.add(identity);
            const passed = test.status === 'expected' && test.expectedStatus === 'passed' && test.results.length > 0
              && test.results.every(result => object(result) && result.status === 'passed');
            const skipped = test.status === 'skipped' && test.results.every(result => object(result) && result.status === 'skipped');
            if (!passed && !skipped) throw Error('test_not_passed');
            const info = identities.get(identity) ?? { file: path, expected: false, skipped: false };
            info.expected ||= passed;
            info.skipped ||= skipped;
            identities.set(identity, info);
          }
        }
        for (const nested of suite.suites ?? []) visit(nested, file, [...titles, nested?.title]);
      };
      for (const suite of report.suites) visit(suite, suite?.file, []);
    }
    if ([...identities.values()].some(info => info.skipped && !info.expected)) throw Error('skipped_test_never_expected');
    if (selected_files.some(file => ![...identities.values()].some(info => info.file === file && info.expected))) throw Error('missing_or_empty_file');
  } catch (error) {
    const allowed = ['invalid_expected_files', 'empty_test_set', 'invalid_root_dir', 'invalid_pass_plan',
      'test_process_failed', 'invalid_test_results', 'test_not_passed', 'unexpected_file',
      'unexpected_file_in_pass', 'duplicate_test_identity', 'skipped_test_never_expected', 'missing_or_empty_file'];
    reason = allowed.includes(error?.message) ? error.message : 'invalid_test_results';
  }
  const test_files = selected_files.map(path => {
    const tests = [...identities.values()].filter(info => info.file === path);
    return { path, counts: { tests: tests.length, passed: tests.filter(info => info.expected).length } };
  });
  return { check_id: 'ci.e2e', status: reason === 'tests_executed' ? 'passed' : 'failed', reason,
    test_count: identities.size, selected_files, test_files, passes };
}
