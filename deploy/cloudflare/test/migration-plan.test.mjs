import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LEGACY_MIGRATIONS, DAG_MIGRATIONS, MIGRATION_V2_GUARD, MIGRATION_LIMITS, legacyMigrationProfile, resolveMigrationPlan, migrationDigest } from '../../../packages/db/migration-plan.mjs';
import { readMigrationSources } from '../../../packages/db/migration-files.mjs';
import { checkMigrations } from '../lib/migrations.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const legacy = [{ name: '001_base.sql', sql: 'CREATE TABLE baseline(id integer PRIMARY KEY);\n' }, { name: '003_base_tail.sql', sql: 'CREATE TABLE tail(id integer PRIMARY KEY);\n' }];
const legacyProfile = { format: LEGACY_MIGRATIONS, first: 1, last: 3, known_gaps: [2] };
const row = e => ({ name: e.name, sha256: migrationDigest(e.sql) });
const profile = () => ({ format: DAG_MIGRATIONS, legacy: structuredClone(legacyProfile), legacy_ledger: legacy.map(row) });
const A = 'v2_20261005T000000001Z_0000000000000001_alpha.sql';
const B = 'v2_20261005T000000002Z_0000000000000002_beta.sql';
const C = 'v2_20261005T000000000Z_0000000000000003_child.sql';
function v2(name = A, deps = [legacy.at(-1).name], body = 'CREATE TABLE alpha(id integer PRIMARY KEY);\n') {
  return { name, sql: '-- freedom-migration: ' + JSON.stringify({ format: DAG_MIGRATIONS, depends_on: deps }) + '\n' + MIGRATION_V2_GUARD + body };
}
const refused = code => error => error.code === code;
const plan = (entries, applied = [], host = profile()) => resolveMigrationPlan([...legacy, ...entries], host, applied);
function temporary(run) { const dir = mkdtempSync(join(tmpdir(), 'fp-migration-plan-')); try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }

test('all 115 historical SQL names and JSON-string digests retain the source057 ledger', () => {
  const sources = readMigrationSources(join(root, 'migrations')).filter(e => Number(e.name.slice(0, 3)) <= 116);
  const result = resolveMigrationPlan(sources, { format: LEGACY_MIGRATIONS, first: 1, last: 116, known_gaps: [22] });
  assert.equal(result.ledger.length, 115);
  assert.equal(result.ledger_digest, '8b4a69b5bcc32eed9eb17d95c9901b6e987ca76af3370996d45f4a32023e7121');
  for (const source of sources) assert.equal(result.ledger.find(e => e.name === source.name).sha256, createHash('sha256').update(JSON.stringify(source.sql)).digest('hex'));
  const manifest = JSON.parse(readFileSync(join(root, 'deploy/cloudflare/environments.json'), 'utf8'));
  const scan = checkMigrations(join(root, 'migrations'), manifest.database_defaults.migrations);
  assert.equal(scan.ok, true); assert.deepEqual(scan.reviewed_privileged.map(e => e.file), sources.filter(e => ['105','107','109','110','111'].includes(e.name.slice(0, 3))).map(e => e.name));
});

test('empty-ledger replay is deterministic by dependency, never timestamp order', () => {
  const a = v2(), b = v2(B), c = v2(C, [A, B]);
  const result = plan([c, b, a]);
  assert.deepEqual(result.pending, [...legacy.map(e => e.name), A, B, C]);
  assert.deepEqual(result.execution_order, plan([a, c, b]).execution_order);
  assert.equal(result.plan_digest, plan([b, a, c]).plan_digest);
  assert.deepEqual(result.ledger.map(e => e.name), [...legacy.map(e => e.name), C, A, B]);
});

test('reverse merge keeps earlier-sorting pending migration after a later one was applied', () => {
  const a = v2(), b = v2(B), c = v2(C, [A, B]);
  const first = plan([b], legacy.map(row)); assert.deepEqual(first.pending, [B]);
  const afterB = [...legacy, b].map(row), reversed = plan([b, a, c], afterB);
  assert.deepEqual(reversed.pending, [A, C]);
  const afterA = plan([a, b, c], [...legacy, a].map(row)); assert.deepEqual(afterA.pending, [B, C]);
  assert.equal(reversed.ledger_digest, afterA.ledger_digest);
  assert.deepEqual(plan([c, a, b], [...legacy, a, b, c].map(row)).pending, []);
});

test('mixed catalog requires explicit DAG profile and exact host-selected legacy ledger', () => {
  assert.throws(() => resolveMigrationPlan([...legacy, v2()], legacyProfile), refused('migration_v2_not_activated'));
  for (const mutate of [p => p.legacy_ledger.pop(), p => p.legacy_ledger[0].sha256 = 'f'.repeat(64), p => p.legacy_ledger[0].name = '001_other.sql']) {
    const p = profile(); mutate(p); assert.throws(() => plan([v2()], [], p), refused('migration_frontier_mismatch'));
  }
  assert.throws(() => plan([v2()], [], { ...profile(), format: 'freedom.migrations/dag-v3' }), refused('migration_profile_unsupported'));
  assert.throws(() => legacyMigrationProfile({ ...legacyProfile, format: DAG_MIGRATIONS }), refused('migration_profile_unsupported'));
});

test('unknown, changed, duplicate and non-dependency-closed applied ledgers fail before scheduling', () => {
  const a = v2(), b = v2(B, [A]), entries = [a, b];
  for (const [applied, code] of [
    [[...legacy, v2(C)].map(row), 'migration_applied_unknown'],
    [[...legacy.map(row), { name: A, sha256: 'f'.repeat(64) }], 'migration_applied_digest_mismatch'],
    [[...legacy.map(row), row(a), row(a)], 'migration_applied_ledger_invalid'],
    [[...legacy, b].map(row), 'migration_applied_dependency_missing'],
    [[row(legacy[1])], 'migration_applied_dependency_missing'],
  ]) assert.throws(() => plan(entries, applied), refused(code));
  assert.deepEqual(plan(entries, [...legacy, a, b].map(row)).pending, [], 'a complete restored ledger is admitted');
  assert.throws(() => plan([a, { ...b, sql: b.sql + '\n-- changed dependency record\n' }], [...legacy, a, b].map(row)), refused('migration_applied_digest_mismatch'));
});

test('missing, self, duplicate, cyclic and incomplete legacy-frontier dependencies fail', () => {
  for (const [entries, code] of [
    [[v2(A, [B])], 'migration_dependency_missing'],
    [[v2(A, [A])], 'migration_self_dependency'],
    [[v2(A, [legacy[1].name, legacy[1].name])], 'migration_dependencies_invalid'],
    [[v2(A, [B]), v2(B, [A])], 'migration_dependency_cycle'],
    [[v2(A, [legacy[0].name])], 'migration_frontier_dependency_missing'],
    [[v2(A, [])], 'migration_dependencies_invalid'],
  ]) assert.throws(() => plan(entries), refused(code));
});

test('duplicate stable identity under another slug and invalid UTC/case/path are refused', () => {
  assert.throws(() => plan([v2(), v2(A.replace('alpha', 'renamed'))]), refused('migration_duplicate_identity'));
  assert.throws(() => plan([v2(), v2()]), refused('migration_duplicate_name'));
  for (const name of [A.replace('20261005', '20260230'), A.replace('T000000001', 'T240000001'), A.replace('alpha', 'Alpha'), '../' + A, A + '\n']) {
    assert.throws(() => plan([v2(name)]), refused('migration_name_invalid'));
  }
});

test('metadata is immutable SQL content and exact runner guard precedes any candidate statement', () => {
  const a = v2();
  for (const sql of [a.sql.replace(MIGRATION_V2_GUARD, ''), a.sql.replace(MIGRATION_V2_GUARD, 'SELECT 1;\n' + MIGRATION_V2_GUARD), a.sql.replace("IS DISTINCT FROM", '=')]) {
    assert.throws(() => plan([{ ...a, sql }]), refused('migration_runner_guard_missing'));
  }
  for (const sql of [a.sql.replace('{"format":', '{"unknown":true,"format":'), a.sql.replace('{"format":', '{"format":"ignored","format":'), a.sql.replace('-- freedom-migration:', '-- different:')]) {
    assert.throws(() => plan([{ ...a, sql }]), refused('migration_metadata_invalid'));
  }
  const changed = v2(A, [legacy[1].name, legacy[0].name]);
  assert.notEqual(row(a).sha256, row(changed).sha256);
  assert.throws(() => plan([changed], [...legacy, a].map(row)), refused('migration_applied_digest_mismatch'));
});

test('legacy duplicates, filled known gap, unexpected gap and out-of-profile additions fail', () => {
  for (const [sources, code] of [
    [[...legacy, { name: '003_other.sql', sql: '' }], 'migration_duplicate_number'],
    [[...legacy, { name: '002_forbidden.sql', sql: '' }], 'migration_legacy_frontier_mismatch'],
    [[legacy[0]], 'migration_legacy_gap'],
    [[...legacy, { name: '004_not_reviewed.sql', sql: '' }], 'migration_legacy_frontier_mismatch'],
  ]) assert.throws(() => resolveMigrationPlan(sources, legacyProfile), refused(code));
});

test('bounded catalog and metadata reject oversized candidates without truncation', () => {
  assert.throws(() => resolveMigrationPlan(Array(MIGRATION_LIMITS.files + 1).fill(legacy[0]), legacyProfile), refused('migration_catalog_limit'));
  assert.throws(() => resolveMigrationPlan([{ ...legacy[0], sql: 'x'.repeat(MIGRATION_LIMITS.fileBytes + 1) }], legacyProfile), refused('migration_catalog_limit'));
  assert.throws(() => plan([v2(A, Array.from({length: MIGRATION_LIMITS.dependencies + 1}, (_, i) => String(i)))]), refused('migration_dependencies_invalid'));
  const sql = '-- freedom-migration: ' + ' '.repeat(MIGRATION_LIMITS.metadataBytes) + '{}\n' + MIGRATION_V2_GUARD;
  assert.throws(() => plan([{ name: A, sql }]), refused('migration_metadata_invalid'));
});

test('file loader keeps exact UTF-8/BOM bytes and rejects links, directories and malformed UTF-8', () => temporary(dir => {
  const path = join(dir, '001_a.sql'); writeFileSync(path, '\ufeff-- 中文\nSELECT 1;\n');
  assert.equal(readMigrationSources(dir)[0].sql, '\ufeff-- 中文\nSELECT 1;\n');
  writeFileSync(path, Buffer.from([0xff])); assert.throws(() => readMigrationSources(dir), refused('migration_source_invalid_utf8'));
  rmSync(path); symlinkSync('/not-read-by-loader', path); assert.throws(() => readMigrationSources(dir), refused('migration_source_not_regular'));
  rmSync(path); mkdirSync(path); assert.throws(() => readMigrationSources(dir), refused('migration_source_not_regular'));
}));
test('file loader rejects a symlinked migration directory before reading its SQL', () => temporary(dir => {
  const source = join(dir,'source'), link = join(dir,'linked'); mkdirSync(source);
  writeFileSync(join(source,'001_a.sql'),'SELECT 1;'); symlinkSync(source,link);
  assert.throws(() => readMigrationSources(link), refused('migration_source_directory_invalid'));
}));

test('public scanner rejects v2 and changed privileged statements while retaining legacy profile', () => temporary(dir => {
  for (const e of [...legacy, v2()]) writeFileSync(join(dir, e.name), e.sql);
  let scan = checkMigrations(dir, legacyProfile); assert.equal(scan.ok, false); assert(scan.problems.includes('migration_v2_not_activated'));
  scan = checkMigrations(dir, profile()); assert.equal(scan.ok, false); assert(scan.problems.includes('migration_profile_unsupported'));
  writeFileSync(join(dir, A), v2(A, [legacy[1].name], 'CREATE ROLE forbidden;').sql);
  scan = checkMigrations(dir, legacyProfile); assert.equal(scan.ok, false); assert(scan.privileged.some(e => /role management/.test(e.statement)));
}));
