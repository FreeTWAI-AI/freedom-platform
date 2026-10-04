import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const shape = 'execution.model-text-step.v1';
const prerequisites = ['work.personal-owner-acl.v1', 'work.server-policy.v1', 'execution.member-run-record.v1',
  'execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.bootstrap-session.v1', 'execution.member-prerequisites.v1'];
function fixture() {
  const scan = checkMigrations(`${root}migrations`, loadManifest().database_defaults.migrations); assert.equal(scan.ok, true);
  const candidate = { source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) };
  const active = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
  const target = { environment: 'next', database_identity: 'synthetic-model-step', recovery_generation: '2' };
  const host = { schema: 'freedom.release-compatibility-host/v2', target, now_ms: 10000, max_age_ms: 100,
    rollback_floor_shapes: [], rollback_floor: { evidence_id: 'synthetic-history', target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, capabilities: [] },
    observation: { evidence_id: 'synthetic-observation', observed_at_ms: 9999, target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, enabled_shapes: [], written_shapes: [], active_releases: [active], complete: true },
    release_records: [active, candidate].map(identity => ({ ...identity, evidence_id: 'synthetic-approval', status: 'approved',
      environments: ['next'], schema_ledger_digests: [scan.ledger_digest],
      capabilities: ['platform.legacy.v1', 'work.explicit-wire.v1', shape, ...prerequisites], approved_at_ms: 9000, expires_at_ms: 11000 })) };
  return { input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] }, scan, host };
}
function run(f) {
  const result = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  return result;
}
test('093 schema alone grants neither member consent nor execution capability', () => {
  const f = fixture(); for (const record of f.host.release_records) record.capabilities.splice(2);
  assert.equal(run(f).status, 'compatible');
  assert.deepEqual(run(f).required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1']);
});
for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) for (const binary of [0, 1]) {
  test(`093 ${source} retains exact text/result profile from binary ${binary}`, () => {
    const f = fixture();
    (source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation)[source] = [shape];
    assert.equal(run(f).status, 'compatible');
    for (const capability of [shape, ...prerequisites]) {
      const changed = structuredClone(f);
      changed.host.release_records[binary].capabilities = changed.host.release_records[binary].capabilities.filter(c => c !== capability);
      assert(run(changed).issues.some(i => i.capability === capability && i.source_sha === changed.host.release_records[binary].source_sha));
    }
  });
}
test('capability-only history retains dependencies without inventing written shapes or pairing permission', () => {
  const f = fixture(); f.host.rollback_floor.capabilities = [shape];
  const result = run(f); assert.equal(result.status, 'compatible'); assert.deepEqual(result.required_shapes, []);
  assert(!result.required_capabilities.includes('execution.device-authorization.v1'));
  for (const capability of prerequisites) for (const binary of [0, 1]) {
    const changed = structuredClone(f);
    changed.host.release_records[binary].capabilities = changed.host.release_records[binary].capabilities.filter(c => c !== capability);
    assert(run(changed).issues.some(i => i.capability === capability));
  }
});
function before093(f) {
  const ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) < 93);
  assert.equal(ledger.at(-1).name.slice(0, 3), '092'); return { ledger, digest: compatibilityLedgerDigest(ledger) };
}
test('member shape requires planned093 despite binary claims', () => {
  const f = fixture(), old = before093(f);
  f.scan = { ...f.scan, ledger: old.ledger, ledger_digest: old.digest };
  for (const portion of [f.host.observation, f.host.rollback_floor]) { portion.schema_ledger = old.ledger; portion.schema_ledger_digest = old.digest; }
  for (const record of f.host.release_records) record.schema_ledger_digests.push(old.digest);
  f.input.enable_shapes = [shape]; assert(run(f).issues.some(i => i.code === 'shape_schema_missing' && i.shape === shape));
});
test('retained member history requires actual093, not a future migration promise', () => {
  const f = fixture(), old = before093(f); f.host.rollback_floor_shapes = [shape];
  for (const portion of [f.host.observation, f.host.rollback_floor]) { portion.schema_ledger = old.ledger; portion.schema_ledger_digest = old.digest; }
  for (const record of f.host.release_records) record.schema_ledger_digests.push(old.digest);
  assert(run(f).issues.some(i => i.code === 'historical_shape_schema_missing' && i.shape === shape));
});
