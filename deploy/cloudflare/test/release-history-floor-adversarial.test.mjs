import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkMigrations } from '../lib/migrations.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scanner = checkMigrations(join(root, 'migrations'), { first: 1, last: 85, known_gaps: [22] });
const capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1', 'avatar.asset-bridge.v1',
  'work.personal-owner-acl.v1', 'work.private-human-result.v1', 'work.server-policy.v1'];
const identity = character => ({ source_sha: character.repeat(40), artifact_sha256: character.repeat(64) });
const rowsThrough = last => structuredClone(scanner.ledger.filter(row => Number(row.name.slice(0, 3)) <= last));
function fixture() {
  const target = { environment: 'next', database_identity: 'synthetic-history-db', recovery_generation: '12' };
  const now = Date.parse('2026-10-02T12:00:00Z'), active = identity('a'), candidate = identity('b');
  // Host records are deliberate synthetic inputs, not authenticated approval
  // or a durable history collector. Every report remains authority-free.
  const host = { schema: 'freedom.release-compatibility-host/v2', target, now_ms: now, max_age_ms: 10000,
    rollback_floor_shapes: [], rollback_floor: { evidence_id: 'independent-history-085', target: { ...target, recovery_generation: '7' },
      schema_ledger: rowsThrough(85), schema_ledger_digest: scanner.ledger_digest, capabilities: ['work.server-policy.v1'] },
    observation: { evidence_id: 'independent-observation', observed_at_ms: now - 1, target: { ...target },
      schema_ledger: rowsThrough(85), schema_ledger_digest: scanner.ledger_digest,
      enabled_shapes: [], written_shapes: [], active_releases: [active], complete: true },
    release_records: [active, candidate].map((record, i) => ({ ...record, evidence_id: `synthetic-release-${i}`, status: 'approved',
      environments: ['next'], schema_ledger_digests: [scanner.ledger_digest], capabilities: [...capabilities],
      approved_at_ms: now - 1000, expires_at_ms: now + 10000 })) };
  return { input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] }, host, scan: structuredClone(scanner) };
}
function run(f) {
  const report = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  assert.equal(report.deployment_authority, false); assert.equal(report.restore_proof, false); assert.equal(report.execution_authority, false);
  return report;
}
function denied(f, code) {
  const report = run(f); assert.notEqual(report.status, 'compatible', JSON.stringify(report));
  if (code) assert(report.issues.some(issue => issue.code === code), JSON.stringify(report));
  return report;
}
function replaceCurrent(f, last) {
  const ledger = rowsThrough(last), digest = compatibilityLedgerDigest(ledger);
  f.scan.ledger = structuredClone(ledger); f.scan.ledger_digest = digest;
  f.host.observation.schema_ledger = structuredClone(ledger); f.host.observation.schema_ledger_digest = digest;
  // Approve the restored pair explicitly so no ordinary release-ledger
  // rejection can mask failure to enforce the separate historical floor.
  for (const record of f.host.release_records) record.schema_ledger_digests = [digest];
}

test('HISTORY independent valid historical floor yields diagnostic compatibility, never restore authority', () => {
  assert.equal(scanner.ok, true); const f = fixture(), report = run(f);
  assert.equal(report.status, 'compatible', JSON.stringify(report)); assert.equal(report.checked_releases, 2);
  assert(report.required_capabilities.includes('work.server-policy.v1'));
  assert.deepEqual(report.required_shapes, []);
});

test('HISTORY independent restored observation084 plus candidate084 cannot evade retained085 floor', () => {
  const f = fixture(); replaceCurrent(f, 84);
  const report = denied(f, 'historical_schema_floor_mismatch'); assert.equal(report.status, 'incompatible');
});

test('HISTORY independent planned upgrade085 alone cannot certify observed084 against already-retained085', () => {
  const f = fixture(), old = rowsThrough(84), digest = compatibilityLedgerDigest(old);
  f.host.observation.schema_ledger = old; f.host.observation.schema_ledger_digest = digest;
  for (const record of f.host.release_records) record.schema_ledger_digests.push(digest);
  denied(f, 'historical_schema_floor_mismatch');
});

for (const binary of ['active', 'candidate']) test(`HISTORY independent disabled features do not release ${binary} from historical policy capability`, () => {
  const f = fixture(); assert.deepEqual(f.host.observation.enabled_shapes, []); assert.deepEqual(f.host.observation.written_shapes, []);
  f.host.release_records[binary === 'active' ? 0 : 1].capabilities = capabilities.filter(v => v !== 'work.server-policy.v1');
  const report = denied(f, 'release_capability_missing');
  assert(report.issues.some(issue => issue.capability === 'work.server-policy.v1'));
});

test('HISTORY independent same migration name with altered SQL cannot be approved over prior immutable bytes', () => {
  const f = fixture();
  f.scan.ledger.at(-1).sha256 = 'f'.repeat(64); f.scan.ledger_digest = compatibilityLedgerDigest(f.scan.ledger);
  f.host.observation.schema_ledger = structuredClone(f.scan.ledger); f.host.observation.schema_ledger_digest = f.scan.ledger_digest;
  for (const record of f.host.release_records) record.schema_ledger_digests = [f.scan.ledger_digest];
  denied(f, 'historical_schema_floor_mismatch');
});

test('HISTORY independent earlier migration digest mismatch is not hidden by equal latest ID', () => {
  const f = fixture(); f.host.rollback_floor.schema_ledger[0].sha256 = 'e'.repeat(64);
  f.host.rollback_floor.schema_ledger_digest = compatibilityLedgerDigest(f.host.rollback_floor.schema_ledger);
  denied(f, 'historical_schema_floor_mismatch');
});

test('HISTORY independent every active reader is checked, not just current newest release and candidate', () => {
  const f = fixture(), old = identity('c'); f.host.observation.active_releases.push(old);
  f.host.release_records.push({ ...structuredClone(f.host.release_records[0]), ...old, evidence_id: 'older-background-reader',
    capabilities: capabilities.filter(v => v !== 'work.server-policy.v1') });
  const report = denied(f, 'release_capability_missing'); assert.equal(report.checked_releases, 3);
  assert(report.issues.some(issue => issue.source_sha === old.source_sha && issue.capability === 'work.server-policy.v1'));
});

test('HISTORY independent higher recovery generation cannot clear schema or capability obligations', () => {
  for (const erase of ['schema', 'capability']) {
    const f = fixture(); f.host.target.recovery_generation = '9999999999999999999999999999999999999999';
    f.host.observation.target.recovery_generation = f.host.target.recovery_generation;
    if (erase === 'schema') replaceCurrent(f, 84);
    else f.host.release_records[1].capabilities = capabilities.filter(v => v !== 'work.server-policy.v1');
    denied(f, erase === 'schema' ? 'historical_schema_floor_mismatch' : 'release_capability_missing');
  }
});

test('HISTORY independent big decimal generations compare numerically without Number rounding', () => {
  const f = fixture(); f.host.target.recovery_generation = '9007199254740992';
  f.host.observation.target.recovery_generation = f.host.target.recovery_generation;
  f.host.rollback_floor.target.recovery_generation = '9007199254740993';
  denied(f);
  f.host.rollback_floor.target.recovery_generation = '9007199254740991';
  assert.equal(run(f).status, 'compatible');
});

for (const field of ['environment', 'database_identity']) test(`HISTORY independent wrong ${field} floor cannot imply restore lineage`, () => {
  const f = fixture(); f.host.rollback_floor.target[field] = field === 'environment' ? 'staging-next' : 'another-original-database';
  denied(f);
  f.host.rollback_floor.lineage = { approved: true, source: 'another-original-database' };
  denied(f);
});

test('HISTORY independent moving both current DB observations never silently rebinds retained old-DB history', () => {
  const f = fixture(); f.host.target.database_identity = 'new-restored-database'; f.host.observation.target.database_identity = 'new-restored-database';
  denied(f);
});

for (const malformed of ['missing', 'null', 'empty', 'v1', 'unknown-field', 'missing-capabilities', 'unknown-capability', 'duplicate-capability',
  'empty-ledger', 'wrong-digest', 'duplicate-row', 'reordered-row', 'unknown-migration', 'future-generation', 'leading-zero-generation'])
  test(`HISTORY independent ${malformed} floor is unavailable rather than assumed empty`, () => {
    const f = fixture(), floor = f.host.rollback_floor;
    if (malformed === 'missing') delete f.host.rollback_floor;
    if (malformed === 'null') f.host.rollback_floor = null;
    if (malformed === 'empty') f.host.rollback_floor = {};
    if (malformed === 'v1') { f.host.schema = 'freedom.release-compatibility-host/v1'; delete f.host.rollback_floor; }
    if (malformed === 'unknown-field') floor.approved = true;
    if (malformed === 'missing-capabilities') delete floor.capabilities;
    if (malformed === 'unknown-capability') floor.capabilities.push('execution.anything.v1');
    if (malformed === 'duplicate-capability') floor.capabilities.push(floor.capabilities[0]);
    if (malformed === 'empty-ledger') { floor.schema_ledger = []; floor.schema_ledger_digest = compatibilityLedgerDigest([]); }
    if (malformed === 'wrong-digest') floor.schema_ledger_digest = '0'.repeat(64);
    if (malformed === 'duplicate-row') { floor.schema_ledger.push(floor.schema_ledger.at(-1)); floor.schema_ledger_digest = compatibilityLedgerDigest(floor.schema_ledger); }
    if (malformed === 'reordered-row') { [floor.schema_ledger[0], floor.schema_ledger[1]] = [floor.schema_ledger[1], floor.schema_ledger[0]]; floor.schema_ledger_digest = compatibilityLedgerDigest(floor.schema_ledger); }
    if (malformed === 'unknown-migration') { floor.schema_ledger.push({ name: '086_unreviewed.sql', sha256: 'c'.repeat(64) }); floor.schema_ledger_digest = compatibilityLedgerDigest(floor.schema_ledger); }
    if (malformed === 'future-generation') floor.target.recovery_generation = '13';
    if (malformed === 'leading-zero-generation') floor.target.recovery_generation = '07';
    assert.equal(denied(f).status, 'unavailable');
  });

test('HISTORY independent floor075 permits compatible expansion, without inventing policy activation', () => {
  const f = fixture(); f.host.rollback_floor.schema_ledger = rowsThrough(75);
  f.host.rollback_floor.schema_ledger_digest = compatibilityLedgerDigest(f.host.rollback_floor.schema_ledger);
  f.host.rollback_floor.capabilities = [];
  for (const record of f.host.release_records) record.capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1'];
  const report = run(f); assert.equal(report.status, 'compatible'); assert(!report.required_capabilities.includes('work.server-policy.v1'));
});

test('HISTORY independent candidate cannot replace trusted retained history', () => {
  const f = fixture(); f.input.rollback_floor = { schema_ledger: [], capabilities: [] };
  assert.equal(denied(f).status, 'unavailable');
});

test('HISTORY independent accessor floor is rejected without invocation or sensitive diagnostic output', () => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.host, 'rollback_floor', { enumerable: true, get() { calls++; throw Error('PRIVATE_HISTORY_MARKER'); } });
  const report = denied(f); assert.equal(calls, 0); assert(!JSON.stringify(report).includes('PRIVATE_HISTORY_MARKER'));
});

for (const malformed of ['oversized-string', 'oversized-array', 'deep-object', 'cycle', 'sparse-array', 'array-properties'])
  test(`HISTORY independent ${malformed} input is bounded and refused`, () => {
    const f = fixture(), floor = f.host.rollback_floor;
    if (malformed === 'oversized-string') floor.evidence_id = 'x'.repeat(600000);
    if (malformed === 'oversized-array') floor.schema_ledger = Array(4097).fill(floor.schema_ledger[0]);
    if (malformed === 'deep-object') { let nested = {}; floor.extra = nested; for (let i = 0; i < 30; i++) nested = nested.child = {}; }
    if (malformed === 'cycle') floor.extra = floor;
    if (malformed === 'sparse-array') floor.capabilities = Array(10);
    if (malformed === 'array-properties') floor.capabilities.extra = 'not-a-capability';
    const start = performance.now(); assert.equal(denied(f).status, 'unavailable'); assert(performance.now() - start < 1000);
  });
