import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { GUILD_PRESENTATION_PROFILE } from './guild-presentation-profile.mjs';

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
guild-workspace.spec.ts help-box-padding.spec.ts hosted-store-photo.spec.ts journeys.spec.ts member-avatar-asset.spec.ts
member-channels-real.spec.ts member-channels.spec.ts member-connections-51.spec.ts
member-connections.spec.ts member-directory.spec.ts member-ecard.spec.ts
member-editorial-card.spec.ts member-experience.spec.ts member-home-next-step.spec.ts
member-services.spec.ts member-session-lifecycle.spec.ts member-settings-real.spec.ts
message-images.spec.ts member-settings.spec.ts member-todos-real.spec.ts member-todos.spec.ts model-settings.spec.ts
modules-beginners.spec.ts navigation-audit.spec.ts newcomer-guides.spec.ts
notification-bell-actions.spec.ts onboarding-members.spec.ts onboarding-recovery.spec.ts
notification-preferences.spec.ts
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
  default: 60 * 60 * 1000,
  'private-ai': 30 * 60 * 1000,
  'avatar-asset': 30 * 60 * 1000,
  'message-image': 30 * 60 * 1000,
  'store-photo': 30 * 60 * 1000,
  'notification-preferences': 30 * 60 * 1000,
});

// One default mode, two isolated single-worker processes under its original bound.
export const E2E_DEFAULT_SHARDS = Object.freeze([
  Object.freeze({ current: 1, total: 2, port: 14311 }),
  Object.freeze({ current: 2, total: 2, port: 14312 }),
]);

export const E2E_PLAN = Object.freeze([
  { id: 'default', env: {}, files: [] },
  { id: 'private-ai', env: { FREEDOM_E2E_PRIVATE_AI_FIXTURE: '1' }, files: ['tests/e2e/private-work-ai.spec.ts'] },
  { id: 'avatar-asset', env: { FREEDOM_E2E_AVATAR_ASSET_FIXTURE: '1' }, files: ['tests/e2e/member-avatar-asset.spec.ts'] },
  { id: 'message-image', env: { FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE: '1' }, files: ['tests/e2e/message-images.spec.ts'] },
  { id: 'store-photo', env: { FREEDOM_E2E_STORE_PHOTO_FIXTURE: '1' }, files: ['tests/e2e/hosted-store-photo.spec.ts'] },
  { id: 'notification-preferences', env: { FREEDOM_E2E_NOTIFICATION_PREFERENCES: '1' }, files: ['tests/e2e/notification-preferences.spec.ts'] }
]);

// App composition is an actual reverse dependent of the globally mounted guide.
// Its reviewed test ownership is included, never removed from the impact graph.
export const GUIDE_COMPOSITION_PROFILE = Object.freeze({
  module: 'application-composition',
  dependencies: Object.freeze(`agent-commerce community community-search personal-content development
execution-runs guild-workspace member-card member-communications module-registry newcomer-guides
positioning runtime-registration skill-submissions social-feed tenant-workspaces work member-squads
github-social member-reporting guild-presentation guild-supply guild-open-source guild-events community-ar`.trim().split(/\s+/)),
  files: Object.freeze(`audit-identity modules-beginners typed-line-breaks calm-experience
member-connections-51 member-experience game-console instant-feedback member-directory
member-settings-real member-settings member-todos mobile-install page-issue-recovery
page-tools simple-social-experience shared-feedback-language audit-shell member-navigation-hierarchy workshop-design navigation-audit platform-purpose audit-skills guild-workspace`.trim().split(/\s+/)
    .map(name => `tests/e2e/${name}.spec.ts`).sort()),
});

// Pilot ownership is reviewed host data. Descriptors never provide filenames.
// Keep fixture specs in default too: their OFF cases are not the ON passes.
export const GUIDE_DEFAULT_FILES = Object.freeze([...new Set([
  'tests/e2e/newcomer-guides.spec.ts', 'tests/e2e/ai-sister-guides.spec.ts',
  'tests/e2e/member-experience.spec.ts', 'tests/e2e/journeys.spec.ts',
  'tests/e2e/navigation-audit.spec.ts', 'tests/e2e/audit-shell.spec.ts',
  'tests/e2e/member-session-lifecycle.spec.ts', 'tests/e2e/session-recovery.spec.ts',
  'tests/e2e/onboarding-members.spec.ts', 'tests/e2e/page-tools.spec.ts',
  'tests/e2e/page-tools-notification.spec.ts',
  ...GUIDE_COMPOSITION_PROFILE.files,
  ...E2E_PLAN.slice(1).flatMap(pass => pass.files),
])].sort());
export const GUILD_PREVIEW_PLAN = Object.freeze([{id: 'default', env: {}, files: GUILD_PRESENTATION_PROFILE.previewFiles}]);
export const GUILD_E2E_PLAN = Object.freeze([{id: 'default', env: {}, files: GUILD_PRESENTATION_PROFILE.integrationFiles}]);
export function planE2eSelection(profile, catalog) {
  if (profile === 'guild-presentation' && GUILD_PRESENTATION_PROFILE.integrationFiles.every(file => catalog.includes(file))) {
    return {profile, expectedFiles: [...GUILD_PRESENTATION_PROFILE.integrationFiles].sort(), plan: GUILD_E2E_PLAN};
  }
  const narrow = profile === 'newcomer-guides' && GUIDE_DEFAULT_FILES.every(file => catalog.includes(file));
  const expectedFiles = narrow ? [...GUIDE_DEFAULT_FILES] : [...catalog];
  return { profile: narrow ? 'newcomer-guides' : 'full', expectedFiles,
    plan: E2E_PLAN.map((pass, index) => narrow && index === 0 ? { ...pass, files: [...GUIDE_DEFAULT_FILES] } : pass) };
}

const SPEC_NAME = /^[a-z0-9][a-z0-9-]*\.spec\.ts$/;
const text = value => typeof value === 'string' && !value.includes('\0');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// --list uses the same trusted config/files/env but does not start the server.
// The independent enumeration catches dropped cases inside a selected file.
function fileRules(options) {
  return options?.profile === 'guild-preview'
    ? {prefix: 'modules/', valid: file => ['guild-supply/CatalogBlock.spec.ts', 'guild-open-source/WorksBlock.spec.ts', 'guild-events/EventsBlock.spec.ts'].includes(file)}
    : {prefix: 'tests/e2e/', valid: file => SPEC_NAME.test(file)};
}
function listedCaseIdentities(report, files, options) {
  const {prefix, valid} = fileRules(options);
  if (!object(report) || report.config?.rootDir !== options.rootDir || report.config?.configFile !== options.configFile
    || report.config?.forbidOnly !== true || report.config?.projects?.length !== 1
    || report.config.projects[0]?.name !== 'chromium' || report.config.projects[0]?.testDir !== options.rootDir
    || report.config.shard !== null
    || !Array.isArray(report.errors) || report.errors.length || !Array.isArray(report.suites)) throw Error('invalid_case_listing');
  const identities = new Set();
  const visit = (suite, file, titles) => {
    if (!object(suite) || !text(suite.title) || !valid(file) || suite.file !== file
      || !files.includes(prefix + file) || !Array.isArray(suite.specs)
      || (suite.suites !== undefined && !Array.isArray(suite.suites))) throw Error('invalid_case_listing');
    for (const spec of suite.specs) {
      if (!object(spec) || spec.file !== file || !text(spec.title) || !Array.isArray(spec.tests) || !spec.tests.length) throw Error('invalid_case_listing');
      for (const test of spec.tests) {
        if (test?.projectName !== 'chromium') throw Error('invalid_case_listing');
        const identity = createHash('sha256').update(`${prefix}${file}\0${titles.join('\0')}\0${spec.title}\0${test.projectName}`).digest('hex');
        if (identities.has(identity)) throw Error('invalid_case_listing');
        identities.add(identity);
      }
    }
    for (const nested of suite.suites ?? []) visit(nested, file, [...titles, nested?.title]);
  };
  for (const suite of report.suites) visit(suite, suite?.file, []);
  if (!identities.size) throw Error('invalid_case_listing');
  return identities;
}

// Playwright 1.63 JSON: file suites are relative to config.rootDir, test.status
// is an outcome, and results[].status is an execution state. No test.titlePath.
export function evaluateE2ePasses(expectedFiles, passReports, options = {}) {
  return evaluatePassReports(expectedFiles, passReports, options, true);
}

// Validate only the actual ordered prefix before its scratch is discarded.
// A valid prefix is not complete-plan admission; cross-mode coverage is checked
// once all required passes exist, using the same evidence contract below.
export function evaluateE2ePassProgress(expectedFiles, passReports, options = {}) {
  return evaluatePassReports(expectedFiles, passReports, options, false);
}

function evaluatePassReports(expectedFiles, passReports, options, complete) {
  let reason = 'tests_executed';
  const identities = new Map();
  let selected_files = [], passes = [];
  const {prefix, valid} = fileRules(options);
  try {
    if (!Array.isArray(expectedFiles) || expectedFiles.some(file => !text(file)
      || !file.startsWith(prefix) || !valid(file.slice(prefix.length)))
      || new Set(expectedFiles).size !== expectedFiles.length) throw Error('invalid_expected_files');
    selected_files = [...expectedFiles].sort();
    if (!selected_files.length) throw Error('empty_test_set');
    const preview = options?.profile === 'guild-preview';
    const guild = options?.profile === 'guild-presentation' || preview;
    const pilot = options?.profile === 'newcomer-guides' || guild;
    const requiredPlan = preview ? GUILD_PREVIEW_PLAN : guild ? GUILD_E2E_PLAN : E2E_PLAN;
    if (pilot && JSON.stringify(selected_files) !== JSON.stringify(preview ? [...GUILD_PRESENTATION_PROFILE.previewFiles].sort() : guild ? [...GUILD_PRESENTATION_PROFILE.integrationFiles].sort() : GUIDE_DEFAULT_FILES)) throw Error('invalid_expected_files');
    if (!object(options) || !text(options.rootDir) || !options.rootDir.startsWith('/')
      || options.rootDir.includes('\\')) throw Error('invalid_root_dir');
    if (!text(options.configFile) || !isAbsolute(options.configFile)) throw Error('invalid_test_results');
    if (!Array.isArray(passReports)) throw Error('invalid_pass_plan');
    passes = passReports.map(pass => ({ id: text(pass?.id) ? pass.id : '',
      exit_code: Number.isInteger(pass?.exit_code) ? pass.exit_code : null,
      ...(typeof pass?.evidence_sha256 === 'string' && /^[a-f0-9]{64}$/.test(pass.evidence_sha256)
        ? { evidence_sha256: pass.evidence_sha256 } : {}),
      ...(typeof pass?.listing_evidence_sha256 === 'string' && /^[a-f0-9]{64}$/.test(pass.listing_evidence_sha256)
        ? { listing_evidence_sha256: pass.listing_evidence_sha256 } : {}),
      ...(Array.isArray(pass?.partitions) && pass.partitions.length === E2E_DEFAULT_SHARDS.length
        ? { partitions: pass.partitions.map(part => ({
          current: Number.isSafeInteger(part?.current) ? part.current : null,
          total: Number.isSafeInteger(part?.total) ? part.total : null,
          exit_code: Number.isInteger(part?.exit_code) ? part.exit_code : null,
          ...(typeof part?.evidence_sha256 === 'string' && /^[a-f0-9]{64}$/.test(part.evidence_sha256)
            ? { evidence_sha256: part.evidence_sha256 } : {}),
        })) } : {}) }));
    if (!passReports.length || passReports.length > requiredPlan.length
      || (complete && passReports.length !== requiredPlan.length)
      || passReports.some((pass, i) => pass?.id !== requiredPlan[i].id)) {
      throw Error('invalid_pass_plan');
    }
    const expected = new Set(selected_files);
    for (const [index, pass] of passReports.entries()) {
      if (pass.exit_code !== 0) throw Error('test_process_failed');
      const partitioned = !pilot && index === 0;
      if (partitioned && (!Array.isArray(pass.partitions) || pass.partitions.length !== E2E_DEFAULT_SHARDS.length
        || pass.report !== undefined)) throw Error('invalid_pass_plan');
      const fragments = partitioned ? pass.partitions : [pass];
      const seen = new Set(), caseResults = [];
      for (const [partIndex, part] of fragments.entries()) {
        const bound = partitioned ? E2E_DEFAULT_SHARDS[partIndex] : null;
        if (bound && (part?.current !== bound.current || part.total !== bound.total
          || !/^[a-f0-9]{64}$/.test(part.evidence_sha256 ?? ''))) throw Error('invalid_pass_plan');
        if (part.exit_code !== 0) throw Error('test_process_failed');
        const report = part.report;
        if (!object(report) || !object(report.config) || report.config.rootDir !== options.rootDir
          || report.config.configFile !== options.configFile || report.config.forbidOnly !== true
          || !Array.isArray(report.config.projects) || report.config.projects.length !== 1
          || report.config.projects[0]?.name !== 'chromium' || report.config.projects[0]?.testDir !== options.rootDir
          || !Array.isArray(report.errors) || !object(report.stats) || !Array.isArray(report.suites)
          || ['expected', 'skipped', 'unexpected', 'flaky'].some(key => !Number.isSafeInteger(report.stats[key]) || report.stats[key] < 0)) {
          throw Error('invalid_test_results');
        }
        const shard = report.config.shard;
        if (bound ? !object(shard) || Object.keys(shard).length !== 2 || shard.current !== bound.current || shard.total !== bound.total
          : shard !== null) throw Error('invalid_test_results');
        if (report.errors.length || report.stats.unexpected !== 0 || report.stats.flaky !== 0) throw Error('test_not_passed');
        const observedCounts = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
        const visit = (suite, file, titles) => {
          if (!object(suite) || !text(suite.title) || !text(suite.file) || !valid(suite.file)
            || suite.file !== file || !Array.isArray(suite.specs)
            || (suite.suites !== undefined && !Array.isArray(suite.suites))) throw Error('invalid_test_results');
          const path = prefix + file;
          if (!expected.has(path)) throw Error('unexpected_file');
          if (pilot && index > 0 && !requiredPlan[index].files.includes(path)) throw Error('unexpected_file_in_pass');
          for (const spec of suite.specs) {
            if (!object(spec) || !text(spec.file) || !valid(spec.file) || spec.file !== file
              || !text(spec.title) || !Array.isArray(spec.tests) || !spec.tests.length) throw Error('invalid_test_results');
            if (index > 0 && !requiredPlan[index].files.includes(path)) throw Error('unexpected_file_in_pass');
            for (const test of spec.tests) {
              if (!object(test) || !text(test.projectName) || !Array.isArray(test.results)) throw Error('invalid_test_results');
              const identity = createHash('sha256').update(`${path}\0${titles.join('\0')}\0${spec.title}\0${test.projectName}`).digest('hex');
              if (seen.has(identity)) throw Error('duplicate_test_identity');
              seen.add(identity);
              const passed = test.status === 'expected' && test.expectedStatus === 'passed' && test.results.length > 0
                && test.results.every(result => object(result) && result.status === 'passed');
              const skipped = test.status === 'skipped' && test.results.every(result => object(result) && result.status === 'skipped');
              if (!passed && !skipped) throw Error('test_not_passed');
              observedCounts[passed ? 'expected' : 'skipped']++;
              if (pilot || partitioned) caseResults.push({ case_sha256: identity, status: passed ? 'passed' : 'skipped' });
              const info = identities.get(identity) ?? { file: path, expected: false, skipped: false };
              info.expected ||= passed;
              info.skipped ||= skipped;
              identities.set(identity, info);
            }
          }
          for (const nested of suite.suites ?? []) visit(nested, file, [...titles, nested?.title]);
        };
        for (const suite of report.suites) visit(suite, suite?.file, []);
        if ((pilot || partitioned) && Object.keys(observedCounts).some(key => observedCounts[key] !== report.stats[key])) throw Error('case_listing_mismatch');
        if (partitioned && observedCounts.expected + observedCounts.skipped === 0) throw Error('missing_or_empty_file');
      }
      if (pilot || partitioned) {
        if (pass.listing_exit_code !== 0 || !/^[a-f0-9]{64}$/.test(pass.listing_evidence_sha256 ?? '')) throw Error('invalid_case_listing');
        const listed = listedCaseIdentities(pass.listing, index === 0 ? selected_files : requiredPlan[index].files, options);
        if (listed.size !== seen.size || [...listed].some(identity => !seen.has(identity))) throw Error('case_listing_mismatch');
        passes[index].listed_case_count = listed.size;
        passes[index].listed_cases_sha256 = createHash('sha256').update(JSON.stringify([...listed].sort())).digest('hex');
        passes[index].cases = caseResults.sort((a, b) => a.case_sha256.localeCompare(b.case_sha256));
      }
    }
    if (passReports.length === requiredPlan.length) {
      if ([...identities.values()].some(info => info.skipped && !info.expected)) throw Error('skipped_test_never_expected');
      if (selected_files.some(file => ![...identities.values()].some(info => info.file === file && info.expected))) throw Error('missing_or_empty_file');
    }
  } catch (error) {
    const allowed = ['invalid_expected_files', 'empty_test_set', 'invalid_root_dir', 'invalid_pass_plan',
      'test_process_failed', 'invalid_test_results', 'test_not_passed', 'unexpected_file',
      'unexpected_file_in_pass', 'invalid_case_listing', 'case_listing_mismatch', 'duplicate_test_identity', 'skipped_test_never_expected', 'missing_or_empty_file'];
    reason = allowed.includes(error?.message) ? error.message : 'invalid_test_results';
  }
  const test_files = selected_files.map(path => {
    const tests = [...identities.values()].filter(info => info.file === path);
    return { path, counts: { tests: tests.length, passed: tests.filter(info => info.expected).length } };
  });
  return { check_id: 'ci.e2e', status: reason === 'tests_executed' ? 'passed' : 'failed', reason,
    test_count: identities.size, selected_files, test_files, passes };
}
