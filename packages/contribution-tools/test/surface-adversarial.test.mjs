import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from '@typescript/typescript6';
import { auditSurfaceRegistrations } from '../surface-audit.mjs';
import { sha256 } from '../io.mjs';

const root = 'apps/platform-api/src/platform-app.ts';
const avatar = 'apps/platform-api/src/routes/avatars.ts';
const work = 'apps/platform-api/src/routes/private-work.ts';
const descriptor = 'modules/identity-membership/freedom.module.json';
const workDescriptor = 'modules/opportunity-project-work/freedom.module.json';
const file = path => readFileSync(new URL('../../../' + path, import.meta.url));
const paths = new Set([root, avatar, work, descriptor, workDescriptor]);
// Keep the real-source control complete when a feature page moves. The narrow
// HTTP parser still reports those pages as unsupported, never as verified.
for (const path of [descriptor, workDescriptor]) {
  for (const surface of JSON.parse(file(path)).surfaces) paths.add(surface.entry);
}
const files = new Map([...paths].map(path => [path, file(path)]));
// These are independent test-harness inputs, NOT candidate proof or publisher approval.
const parserEntry = import.meta.resolve('@typescript/typescript6');
const implementation = createRequire(parserEntry).resolve('@typescript/old');
const approvedParser = { version: ts.version, installationSha256: sha256(JSON.stringify(
  [parserEntry, implementation].map(path => sha256(readFileSync(path.startsWith('file:') ? new URL(path) : path))))) };
const ports = { parser: { api: ts, ...approvedParser }, approvedParser };
const reader = snapshot => ({ paths: [...snapshot.keys()], read: path => snapshot.get(path) });
function audit(path, transform) {
  const candidate = new Map(files);
  if (path) {
    const original = candidate.get(path).toString();
    const modified = transform(original);
    assert.notEqual(modified, original, 'counterexample must really mutate the source');
    candidate.set(path, Buffer.from(modified));
  }
  const result = auditSurfaceRegistrations({ baseline: reader(files), candidate: reader(candidate),
    changedPaths: path ? [path] : [] }, ports);
  assert.equal(result.behavior_checked, false);
  assert.equal(result.execution_authorized, false);
  assert.equal(result.merge_authorized, false);
  assert(result.blockers.includes('registration_behavior_audit_required'));
  return result;
}
const reject = (path, change) => {
  const report = audit(path, change);
  assert.notEqual(report.structural_status, 'passed', JSON.stringify(report.issues));
  // An unconditional whole-platform blocker is not evidence this mutation was
  // detected. Require a concrete candidate rejection, so a permanently
  // unavailable aggregate cannot make these negative vectors vacuously green.
  const concrete = issues => issues.filter(issue => issue.revision === 'candidate'
    && !['surface_unmapped', 'registration_behavior_audit_required'].includes(issue.code));
  const prior = new Map();
  for (const issue of concrete(audit().issues)) {
    const key = JSON.stringify(issue);
    prior.set(key, (prior.get(key) ?? 0) + 1);
  }
  assert(concrete(report.issues).some(issue => {
    const key = JSON.stringify(issue), count = prior.get(key) ?? 0;
    if (!count) return true;
    prior.set(key, count - 1);
    return false;
  }), JSON.stringify(report.issues));
};

test('independent real-source control extracts six-route facts but cannot approve unresolved root delegates', () => {
  const report = audit();
  assert.equal(report.coverage_kind, 'fixed-syntax-only');
  assert(!report.issues.some(issue => issue.code === 'surface_declaration_entry_missing'));
  assert.equal(report.structural_status, 'unavailable');
  assert.equal(Object.hasOwn(report, 'registration_status'), false);
  assert.equal(report.status, 'unavailable');
  assert.equal(report.registrations.length, 12);
  assert(report.blockers.includes('surface_unmapped'));
});

for (const [name, change] of [
  ['destructured method alias', s => s.replace("  app.get('/me/avatar',", "  const { get } = app;\n  get('/me/avatar',")],
  ['bound method alias', s => s.replace("app.get('/me/avatar',", "app.get.bind(app)('/me/avatar',")],
  ['computed method using concat', s => s.replace("app.get('/me/avatar',", "app['g' + 'et']('/me/avatar',")],
  ['optional receiver', s => s.replace("app.get('/me/avatar',", "app?.get('/me/avatar',")],
  ['short-circuit conditional', s => s.replace("app.get('/me/avatar',", "false && app.get('/me/avatar',")],
  ['comma operator registration', s => s.replace("app.get('/me/avatar',", "(0, app.get)('/me/avatar',")],
  ['conditional receiver', s => s.replace("app.get('/me/avatar',", "(false ? app : fake).get('/me/avatar',")],
  ['operator-bearing literal path', s => s.replace("app.get('/me/avatar',", "app.get('/me/avatar;process.exit(0)',")],
  ['parameter constructor shadowing', s => s.replace('pool: Pool, store?: ObjectStore', 'pool: Pool, Hono: any, store?: ObjectStore')],
  ['type-only constructor import', s => s.replace("import { Hono }", "import type { Hono }")],
  ['nested function registration with shadowed receiver', s => s.replace("  app.get('/me/avatar', async c => c.json(await avatarMetadata(pool, c.get('actor'))));",
    "  function hidden(app: any) { app.get('/me/avatar', async c => c.json(await avatarMetadata(pool, c.get('actor')))); }")],
  ['direct early return before registrations', s => s.replace('  const uploadAvatar', '  return app;\n  const uploadAvatar')],
  ['receiver supplied to arbitrary helper', s => s.replace('  return app;', '  const leaked = mutate(app);\n  return app;')],
]) test(`adversarial leaf: ${name} is not covered`, () => reject(avatar, change));

for (const [name, change] of [
  ['renamed factory', s => s.replaceAll('createAvatarRoutes', 'renamedAvatarRoutes')],
  ['computed mount', s => s.replace("app.route('/api/v1',createAvatarRoutes", "app['route']('/api/v1',createAvatarRoutes")],
  ['dynamic mount prefix', s => s.replace("app.route('/api/v1',createAvatarRoutes", "app.route('/api/' + 'v1',createAvatarRoutes")],
  ['short-circuit mount', s => s.replace("app.route('/api/v1',createAvatarRoutes", "false && app.route('/api/v1',createAvatarRoutes")],
  ['factory parameter shadows import', s => s.replace('createPlatformApp(pool:Pool,', 'createPlatformApp(createAvatarRoutes:any,pool:Pool,')],
  ['explicit early return before fixed mount', s => s.replace("  app.route('/api/v1',createAvatarRoutes", "  return app;\n  app.route('/api/v1',createAvatarRoutes")],
  ['early throw before fixed mount', s => s.replace("  app.route('/api/v1',createAvatarRoutes", "  throw new Error('stop');\n  app.route('/api/v1',createAvatarRoutes")],
  ['conditional early return before fixed mount', s => s.replace("  app.route('/api/v1',createAvatarRoutes", "  if (runtime) return app;\n  app.route('/api/v1',createAvatarRoutes")],
  ['wrong final returned receiver', s => s.replace('  return app;', '  return null;')],
  ['direct replacement of root mount method', s => s.replace("  app.route('/api/v1',createAvatarRoutes", "  app.route = () => app;\n  app.route('/api/v1',createAvatarRoutes")],
  ['computed replacement of root mount method', s => s.replace("  app.route('/api/v1',createAvatarRoutes", "  app['route'] = () => null;\n  app.route('/api/v1',createAvatarRoutes")],
  ['root receiver escapes to arbitrary mutator', s => s.replace("  app.route('/api/v1',createAvatarRoutes", "  mutate(app);\n  app.route('/api/v1',createAvatarRoutes")],
]) test(`adversarial mount: ${name} is not covered`, () => reject(root, change));

test('invoked throwing initializer cannot fabricate reachable registrations', () => reject(avatar,
  s => s.replace('  const uploadAvatar', '  const unreachable = (() => { throw new Error("stop"); })();\n  const uploadAvatar')));

test('candidate descriptor cannot turn a forged operation into a recognized registration', () => reject(descriptor, s => {
  const value = JSON.parse(s);
  value.surfaces[0].operations = ['operator;process.exit(0)'];
  return JSON.stringify(value);
}));

test('candidate top-level and initializer side effects never execute in the host', () => {
  const marker = '__independentSurfaceCandidateExecuted';
  delete globalThis[marker];
  const result = audit(avatar, s => `globalThis.${marker} = 'top-level';\n` + s.replace('  const uploadAvatar',
    `  const effect = (() => { globalThis.${marker} = 'initializer'; return 1; })();\n  const uploadAvatar`));
  assert.equal(globalThis[marker], undefined);
  assert.notEqual(result.structural_status, 'passed');
});

test('an unchanged scoped map cannot use its own parser declaration as host approval', () => {
  const result = auditSurfaceRegistrations({ baseline: reader(files), candidate: reader(files),
    approvedParser, parser: ports.parser });
  assert.equal(result.structural_status, 'unavailable');
  assert(result.blockers.includes('trusted_parser_unavailable'));
});
