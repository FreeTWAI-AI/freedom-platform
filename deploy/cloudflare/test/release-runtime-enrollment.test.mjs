import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const shape = 'execution.runtime-enrollment.v1';
function fixture() {
  const scan = checkMigrations(`${root}migrations`, loadManifest().database_defaults.migrations);
  assert.equal(scan.ok, true);
  const candidate = { source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) };
  const active = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
  const target = { environment: 'next', database_identity: 'synthetic-runtime-enrollment', recovery_generation: '2' };
  const host = { schema: 'freedom.release-compatibility-host/v2', target, now_ms: 10000, max_age_ms: 100,
    rollback_floor_shapes: [], rollback_floor: { evidence_id: 'synthetic-history', target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, capabilities: [] },
    observation: { evidence_id: 'synthetic-observation', observed_at_ms: 9999, target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, enabled_shapes: [], written_shapes: [], active_releases: [active], complete: true },
    release_records: [active, candidate].map(identity => ({ ...identity, evidence_id: 'synthetic-approval', status: 'approved',
      environments: ['next'], schema_ledger_digests: [scan.ledger_digest],
      capabilities: ['platform.legacy.v1', 'work.explicit-wire.v1', shape], approved_at_ms: 9000, expires_at_ms: 11000 })) };
  return { input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] }, scan, host };
}
function run(f) {
  const r = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(r[field], false);
  return r;
}
test('087 schema alone does not enable runtime enrollment or imply model/Run support', () => {
  const f = fixture(); for (const r of f.host.release_records) r.capabilities.pop();
  const r = run(f); assert.equal(r.status, 'compatible');
  assert.deepEqual(r.required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1']);
});
for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) for (const binary of [0, 1]) {
  test(`087 ${source} requires enrollment capability from binary${binary}`, () => {
    const f = fixture();
    (source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation)[source] = [shape];
    assert.equal(run(f).status, 'compatible');
    f.host.release_records[binary].capabilities.pop();
    const r = run(f); assert.equal(r.status, 'incompatible');
    assert(r.issues.some(i => i.capability === shape && i.source_sha === f.host.release_records[binary].source_sha));
  });
}
test('087 capability floor retains enrollment/revocation support without current shapes', () => {
  const f = fixture(); f.host.rollback_floor.capabilities = [shape];
  f.host.rollback_floor.target = { ...f.host.target, recovery_generation: '1' };
  f.host.release_records[0].capabilities.pop();
  assert.equal(run(f).status, 'incompatible');
});
test('087 enrollment cannot be enabled on086 even when every binary claims the capability', () => {
  const f = fixture(), ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) <= 86), digest = compatibilityLedgerDigest(ledger);
  f.scan = { ok: true, ledger, ledger_digest: digest };
  for (const object of [f.host.observation, f.host.rollback_floor]) { object.schema_ledger = ledger; object.schema_ledger_digest = digest; }
  for (const record of f.host.release_records) record.schema_ledger_digests = [digest];
  f.input.enable_shapes = [shape]; assert(run(f).issues.some(i => i.code === 'shape_schema_missing'));
});
test('retained enrollment tombstones require actual087 observation, not only planned repair', () => {
  const f = fixture(), ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) <= 86), digest = compatibilityLedgerDigest(ledger);
  for (const object of [f.host.observation, f.host.rollback_floor]) { object.schema_ledger = ledger; object.schema_ledger_digest = digest; }
  for (const record of f.host.release_records) record.schema_ledger_digests.push(digest);
  f.host.rollback_floor_shapes = [shape];
  const r = run(f); assert.equal(r.status, 'incompatible');
  assert(r.issues.some(i => i.code === 'historical_shape_schema_missing'));
});
