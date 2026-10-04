import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const connection = 'execution.agent-connection-record.v1', enrollment = 'execution.runtime-enrollment.v1';
function fixture() {
  const scan = checkMigrations(`${root}migrations`, loadManifest().database_defaults.migrations);
  assert.equal(scan.ok, true);
  const candidate = { source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) };
  const active = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
  const target = { environment: 'next', database_identity: 'synthetic-agent-connection', recovery_generation: '2' };
  const host = { schema: 'freedom.release-compatibility-host/v2', target, now_ms: 10000, max_age_ms: 100,
    rollback_floor_shapes: [], rollback_floor: { evidence_id: 'synthetic-history', target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, capabilities: [] },
    observation: { evidence_id: 'synthetic-observation', observed_at_ms: 9999, target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, enabled_shapes: [], written_shapes: [], active_releases: [active], complete: true },
    release_records: [active, candidate].map(identity => ({ ...identity, evidence_id: 'synthetic-approval', status: 'approved',
      environments: ['next'], schema_ledger_digests: [scan.ledger_digest],
      capabilities: ['platform.legacy.v1', 'work.explicit-wire.v1', enrollment, connection], approved_at_ms: 9000, expires_at_ms: 11000 })) };
  return { input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] }, scan, host };
}
function run(f) {
  const result = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  return result;
}
test('088 schema alone does not activate connections, bootstrap or execution', () => {
  const f = fixture(); for (const record of f.host.release_records) record.capabilities.splice(2);
  assert.deepEqual(run(f).required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1']);
  assert.equal(run(f).status, 'compatible');
});
for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) for (const binary of [0, 1]) {
  test(`088 ${source} retains connection and enrollment requirements for binary${binary}`, () => {
    const f = fixture();
    (source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation)[source] = [connection];
    assert.equal(run(f).status, 'compatible');
    for (const capability of [connection, enrollment]) {
      const changed = structuredClone(f);
      changed.host.release_records[binary].capabilities = changed.host.release_records[binary].capabilities.filter(c => c !== capability);
      const r = run(changed); assert.equal(r.status, 'incompatible');
      assert(r.issues.some(i => i.capability === capability && i.source_sha === changed.host.release_records[binary].source_sha));
    }
  });
}
test('retained connection capability requires enrollment even when all shapes are empty', () => {
  const f = fixture(); f.host.rollback_floor.capabilities = [connection];
  for (const binary of [0, 1]) {
    const changed = structuredClone(f); changed.host.release_records[binary].capabilities = changed.host.release_records[binary].capabilities.filter(c => c !== enrollment);
    assert(run(changed).issues.some(i => i.capability === enrollment));
  }
});
test('connections cannot be enabled on087 and retained history cannot be repaired by planned088 alone', () => {
  const f = fixture(), ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) <= 87), digest = compatibilityLedgerDigest(ledger);
  for (const object of [f.host.observation, f.host.rollback_floor]) { object.schema_ledger = ledger; object.schema_ledger_digest = digest; }
  for (const record of f.host.release_records) record.schema_ledger_digests.push(digest);
  f.host.rollback_floor_shapes = [connection]; assert(run(f).issues.some(i => i.code === 'historical_shape_schema_missing'));
  f.host.rollback_floor_shapes = []; f.input.enable_shapes = [connection]; f.scan = { ok: true, ledger, ledger_digest: digest };
  assert(run(f).issues.some(i => i.code === 'shape_schema_missing'));
});
test('enrollment capability alone does not invent connection or execution authority', () => {
  const f = fixture(); f.host.rollback_floor.capabilities = [enrollment];
  for (const record of f.host.release_records) record.capabilities = record.capabilities.filter(c => c !== connection);
  const r = run(f); assert.equal(r.status, 'compatible'); assert(!r.required_capabilities.includes(connection));
});
