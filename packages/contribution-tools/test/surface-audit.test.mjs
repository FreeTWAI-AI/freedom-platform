import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from '@typescript/typescript6';
import { auditSurfaceRegistrations } from '../surface-audit.mjs';
import { sha256 } from '../io.mjs';

const root = 'apps/platform-api/src/platform-app.ts', avatar = 'apps/platform-api/src/routes/avatars.ts';
const work = 'apps/platform-api/src/routes/private-work.ts';
const avatarDescriptor = 'modules/identity-membership/freedom.module.json', workDescriptor = 'modules/opportunity-project-work/freedom.module.json';
const file = path => readFileSync(new URL('../../../' + path, import.meta.url));
// Test harness installation identity only, never a production publisher claim.
const parserEntry = import.meta.resolve('@typescript/typescript6');
const actualParserEntry = createRequire(parserEntry).resolve('@typescript/old');
const parserDigest = sha256(JSON.stringify([parserEntry, actualParserEntry].map(path => sha256(readFileSync(path.startsWith('file:') ? new URL(path) : path)))));
const approvedParser = { version: ts.version, installationSha256: parserDigest };
const ports = { parser: { api: ts, ...approvedParser }, approvedParser };
const original = new Map([root, avatar, work, avatarDescriptor, workDescriptor, 'apps/portal-web/src/modules/MemberTasks.tsx'].map(path => [path, file(path)]));
const reader = files => ({ paths: [...files.keys()], read: path => files.get(path) });
const run = (candidate = original, baseline = original, options = {}) => auditSurfaceRegistrations({
  baseline: reader(baseline), candidate: reader(candidate), ...options,
}, ports);
function changed(path, transform) { const result = new Map(original); result.set(path, Buffer.from(transform(result.get(path).toString()))); return result; }
const has = (report, code, revision = 'candidate') => report.issues.some(x => x.code === code && x.revision === revision);
const newCandidateIssue = report => report.issues.filter(x => x.revision === 'candidate').some(x =>
  report.issues.filter(y => y.revision === 'candidate' && y.code === x.code && y.entry === x.entry).length
  > report.issues.filter(y => y.revision === 'baseline' && y.code === x.code && y.entry === x.entry).length);
const descriptorChange = mutate => changed(avatarDescriptor, text => { const value = JSON.parse(text); mutate(value); return JSON.stringify(value); });

test('actual avatar/private routes and real mounts map twelve baseline+candidate registrations without global pass', () => {
  const report = run();
  assert.equal(report.structural_status, 'unavailable', JSON.stringify(report.issues));
  assert.equal(report.coverage_kind, 'fixed-syntax-only');
  assert.equal(report.issues.filter(x => x.revision === 'candidate' && x.code === 'registration_receiver_escape').length, 4);
  assert.equal(report.status, 'unavailable'); assert.equal(report.registrations.length, 12);
  assert.equal(report.evidence.length, 10); assert.equal(report.behavior_checked, false);
  assert.equal(report.merge_authorized, false); assert.equal(report.execution_authorized, false);
  assert(report.blockers.includes('registration_behavior_audit_required'));
  assert(report.blockers.includes('surface_unmapped')); // actual root, legacy Work/page remain uncovered
  assert(report.operation_ids.includes('work.private.read'));
  assert.deepEqual(report.parser, { version: ts.version, installation_sha256: parserDigest, provenance: 'host-supplied-not-authenticated-by-this-audit' });
});
test('omitted actual route is caught even while its descriptor/file still exists', () => {
  const result = run(changed(avatar, s => s.replace("app.get('/me/avatar', async c => c.json(await avatarMetadata(pool, c.get('actor'))));", '')));
  assert(has(result, 'registration_operation_missing')); assert.equal(result.status, 'failed');
});
test('extra unregistered HTTP route is not approved by ownership or file existence', () => {
  const result = run(changed(work, s => s.replace('  return app;', "  app.post('/me/private-work', async c => c.json({}));\n  return app;")));
  assert(has(result, 'undeclared_registration')); assert.equal(result.status, 'failed');
});
test('fake operation declaration is not evidence of a registered operation', () => {
  const result = run(descriptorChange(d => d.surfaces[0].operations.push('member.avatar.fiction')));
  assert(has(result, 'registration_declaration_mismatch'));
  assert(result.operation_ids.includes('member.avatar.fiction'));
  assert(has(result, 'surface_baseline_review_required', 'both'));
});
test('descriptor self approval cannot add an unchecked route or downgrade baseline tests', () => {
  const candidate = descriptorChange(d => { d.tests = ['governance.unit']; d.surfaces[0].operations.push('member.avatar.extra'); });
  candidate.set(avatar, Buffer.from(original.get(avatar).toString().replace('  return app;', "  app.post('/me/avatar/extra', async c => c.json({}));\n  return app;")));
  const result = run(candidate);
  assert(has(result, 'undeclared_registration')); assert(has(result, 'registration_declaration_mismatch'));
  assert(result.required_tests.includes('runtime.avatar')); assert(result.required_tests.includes('governance.unit'));
});
test('removed baseline descriptor/route retain old operations and suites in the union', () => {
  const candidate = new Map(original); candidate.delete(avatarDescriptor); candidate.delete(avatar);
  const result = run(candidate);
  assert(has(result, 'registration_source_missing')); assert(has(result, 'registration_declaration_mismatch'));
  assert(result.surface_ids.includes('member.avatar')); assert(result.required_tests.includes('runtime.avatar'));
});
test('baseline omissions cannot be cured by a self-declared candidate registry', () => {
  const baseline = new Map(original); baseline.delete(avatarDescriptor);
  const result = run(original, baseline); assert(has(result, 'registration_declaration_mismatch', 'baseline'));
  assert(has(result, 'surface_baseline_review_required', 'both'));
});
for (const [name, transform] of [
  ['receiver alias', s => s.replace("app.get('/me/avatar'", "alias.get('/me/avatar'").replace('  const uploadAvatar', '  const alias = app;\n  const uploadAvatar')],
  ['computed member', s => s.replace("app.get('/me/avatar'", "app['get']('/me/avatar'")],
  ['method alias', s => s.replace("app.get('/me/avatar'", "get('/me/avatar'").replace('  const uploadAvatar', '  const get = app.get;\n  const uploadAvatar')],
  ['dynamic path', s => s.replace("app.get('/me/avatar'", "app.get('/me/' + 'avatar'")],
  ['template path', s => s.replace("app.get('/me/avatar'", 'app.get(`/me/avatar`')],
  ['conditional registration', s => s.replace("  app.get('/me/avatar',", "  if (false) app.get('/me/avatar',")],
  ['nested registration', s => s.replace("  app.get('/me/avatar',", "  function unused() { app.get('/me/avatar',").replace("avatarMetadata(pool, c.get('actor'))));", "avatarMetadata(pool, c.get('actor')))); }")],
  ['optional call', s => s.replace("app.get('/me/avatar'", "app.get?.('/me/avatar'")],
  ['constructor alias', s => s.replace("{ Hono } from 'hono'", "{ Hono as H } from 'hono'").replace('new Hono<', 'new H<')],
]) test(`${name} is uncovered, never treated as absent or statically approved`, () => {
  const report = run(changed(avatar, transform)); assert(newCandidateIssue(report), JSON.stringify(report.issues));
});
for (const [name, transform] of [
  ['missing mount', s => s.replace("  app.route('/api/v1',createAvatarRoutes(pool,runtime.avatarAssetStore));", '')],
  ['different prefix', s => s.replace("app.route('/api/v1',createAvatarRoutes", "app.route('/unreviewed',createAvatarRoutes")],
  ['aliased import/mount', s => s.replace('checkAvatarUploadHeaders, createAvatarRoutes,', 'checkAvatarUploadHeaders, createAvatarRoutes as aliasedAvatar,').replace("createAvatarRoutes(pool,runtime.avatarAssetStore)", 'aliasedAvatar(pool,runtime.avatarAssetStore)')],
  ['conditional mount', s => s.replace("  app.route('/api/v1',createAvatarRoutes", "  if (false) app.route('/api/v1',createAvatarRoutes")],
  ['wrong imported source', s => s.replace("from './routes/avatars.js'", "from './routes/evil.js'")],
]) test(`${name} cannot satisfy concrete root registration`, () => {
  assert(has(run(changed(root, transform)), 'registration_mount_missing_or_changed'));
});
test('duplicate static route and root shadow endpoint fail', () => {
  assert(has(run(changed(avatar, s => s.replace('  return app;', "  app.get('/me/avatar', async c => c.json({}));\n  return app;"))), 'duplicate_registration'));
  assert(has(run(changed(root, s => s.replace('  return app;', "  app.get('/api/v1/me/avatar', async c => c.json({}));\n  return app;"))), 'registration_outside_profile'));
});
test('strings/comments do not fabricate registrations, candidate expressions are never executed', () => {
  const marker = '__surfaceAuditMustNotExecute'; delete globalThis[marker];
  const result = run(changed(avatar, s => s + `\n// app.post('/fake', async c => c.json({}));\nglobalThis.${marker} = true;\n`));
  assert.equal(globalThis[marker], undefined); assert.equal(result.registrations.length, 12);
  assert(has(result, 'registration_module_grammar_unsupported'));
});
test('escaped binding spelling and a nested interpolation cannot hide app escapes', () => {
  assert(has(run(changed(avatar, s => s.replace('  return app;', '  const hidden = `${(() => app)()}`;\n  return app;'))), 'registration_receiver_escape'));
  assert(has(run(changed(avatar, s => s.replace('  return app;', '  const alias = \\u0061pp;\n  return app;'))), 'registration_receiver_escape'));
});
test('early throw/control flow and changed middleware are uncovered, not approved', () => {
  assert(has(run(changed(avatar, s => s.replace('  const uploadAvatar', '  throw new Error("stop");\n  const uploadAvatar'))), 'registration_factory_grammar_unsupported'));
  assert(has(run(changed(work, s => s.replace("app.use('/me/private-work*'", "app.use('/other*'"))), 'registration_middleware_changed'));
});
test('missing or nonapproved host parser fails closed but retains baseline/candidate declaration union', () => {
  for (const options of [{}, { ...ports, approvedParser: { ...approvedParser, installationSha256: '0'.repeat(64) } }]) {
    const report = auditSurfaceRegistrations({ baseline: reader(original), candidate: reader(original) }, options);
    assert(report.blockers.includes('trusted_parser_unavailable')); assert.equal(report.structural_status, 'unavailable');
    assert(report.required_tests.includes('runtime.avatar')); assert(report.surface_ids.includes('member.avatar'));
  }
});
test('unsupported Agent Kit/pages/queue/MCP/native coverage stays explicitly unavailable', () => {
  const report = auditSurfaceRegistrations({ baseline: reader(original), candidate: reader(original), profile: 'agent-kit-cli/v1' }, ports);
  assert(report.blockers.includes('surface_profile_unsupported'));
  assert.equal(report.status, 'unavailable'); assert.equal(report.registrations.length, 0);
  const unknown = run(original, original, { changedPaths: ['new/queue.ts', 'new/tool.mjs', 'native/commands.rs'] });
  for (const path of ['new/queue.ts', 'new/tool.mjs', 'native/commands.rs']) assert(unknown.issues.some(x => x.entry === path && x.code === 'surface_unmapped'));
});
test('bounded UTF8/parser inputs and reader failures contain no candidate error text', () => {
  for (const bytes of [Buffer.alloc(128_001), Buffer.from([0xc0, 0xaf])]) {
    const candidate = new Map(original); candidate.set(avatar, bytes);
    assert(has(run(candidate), 'surface_source_unavailable'));
  }
  const bad = { paths: [...original.keys()], read: () => { throw new Error('PRIVATE_MARKER'); } };
  const report = auditSurfaceRegistrations({ baseline: reader(original), candidate: bad }, ports);
  assert(!JSON.stringify(report).includes('PRIVATE_MARKER')); assert.equal(report.status, 'failed');
  assert(has(run(changed(avatar, () => 'export function {')), 'surface_syntax_unavailable'));
});
test('duplicate descriptor keys and case-colliding/unsafe reader paths fail closed', () => {
  assert(has(run(changed(avatarDescriptor, s => s.replace('"format":', '"format":"fake","format":'))), 'surface_descriptor_invalid'));
  for (const path of ['../outside.ts', avatar.toUpperCase()]) {
    const candidate = new Map(original); candidate.set(path, Buffer.from(''));
    assert(has(run(candidate), 'surface_paths_invalid'));
  }
});
