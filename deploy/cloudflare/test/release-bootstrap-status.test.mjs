import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bootstrap = 'execution.bootstrap-status.v1', connection = 'execution.agent-connection-record.v1', enrollment = 'execution.runtime-enrollment.v1';
function fixture() {
  const scan = checkMigrations(`${root}migrations`, loadManifest().database_defaults.migrations);
  assert.equal(scan.ok, true);
  const candidate = { source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) };
  const active = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
  const target = { environment: 'next', database_identity: 'synthetic-bootstrap-admission', recovery_generation: '2' };
  const host = { schema: 'freedom.release-compatibility-host/v2', target, now_ms: 10000, max_age_ms: 100,
    rollback_floor_shapes: [], rollback_floor: { evidence_id: 'synthetic-history', target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, capabilities: [] },
    observation: { evidence_id: 'synthetic-observation', observed_at_ms: 9999, target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, enabled_shapes: [], written_shapes: [], active_releases: [active], complete: true },
    release_records: [active, candidate].map(identity => ({ ...identity, evidence_id: 'synthetic-approval', status: 'approved',
      environments: ['next'], schema_ledger_digests: [scan.ledger_digest],
      capabilities: ['platform.legacy.v1', 'work.explicit-wire.v1', enrollment, connection, bootstrap], approved_at_ms: 9000, expires_at_ms: 11000 })) };
  return { input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] }, scan, host };
}
function run(f) {
  const result = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  return result;
}
test('089 schema alone enables neither bootstrap admission nor execution', () => {
  const f = fixture(); for (const record of f.host.release_records) record.capabilities.splice(2);
  assert.equal(run(f).status, 'compatible');
  assert.deepEqual(run(f).required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1']);
});
for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) for (const binary of [0, 1]) {
  test(`089 ${source} requires admission and both prerequisites from binary${binary}`, () => {
    const f = fixture();
    (source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation)[source] = [bootstrap];
    assert.equal(run(f).status, 'compatible');
    for (const capability of [bootstrap, connection, enrollment]) {
      const changed = structuredClone(f);
      changed.host.release_records[binary].capabilities = changed.host.release_records[binary].capabilities.filter(c => c !== capability);
      assert(run(changed).issues.some(i => i.capability === capability && i.source_sha === changed.host.release_records[binary].source_sha));
    }
  });
}
test('retained bootstrap capability requires connection and enrollment with no enabled shapes', () => {
  const f = fixture(); f.host.rollback_floor.capabilities = [bootstrap];
  for (const capability of [connection, enrollment]) for (const binary of [0, 1]) {
    const changed = structuredClone(f);
    changed.host.release_records[binary].capabilities = changed.host.release_records[binary].capabilities.filter(c => c !== capability);
    assert(run(changed).issues.some(i => i.capability === capability));
  }
});
function before089(f) {
  const ledger = f.scan.ledger.filter(row => !row.name.startsWith('089_')), digest = compatibilityLedgerDigest(ledger);
  return { ledger, digest };
}
test('bootstrap shape requires planned089 even when binaries claim all capabilities', () => {
  const f = fixture(), old = before089(f); f.input.enable_shapes = [bootstrap];
  f.scan = { ...f.scan, ledger: old.ledger, ledger_digest: old.digest };
  f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.digest;
  f.host.rollback_floor.schema_ledger = old.ledger; f.host.rollback_floor.schema_ledger_digest = old.digest;
  for (const record of f.host.release_records) record.schema_ledger_digests.push(old.digest);
  assert.notEqual(run(f).status, 'compatible');
});
test('retained nonce history requires actual089 observation, not merely planned repair', () => {
  const f = fixture(), old = before089(f); f.host.rollback_floor_shapes = [bootstrap];
  f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.digest;
  f.host.rollback_floor.schema_ledger = old.ledger; f.host.rollback_floor.schema_ledger_digest = old.digest;
  for (const record of f.host.release_records) record.schema_ledger_digests.push(old.digest);
  assert.notEqual(run(f).status, 'compatible');
});
test('connection and enrollment support never imply bootstrap admission or Run/Grant rights', () => {
  const f = fixture(); f.input.enable_shapes = [connection];
  for (const record of f.host.release_records) record.capabilities = record.capabilities.filter(c => c !== bootstrap);
  const result = run(f); assert.equal(result.status, 'compatible');
  assert(!result.required_capabilities.includes(bootstrap));
  assert(!result.required_capabilities.some(c => c.startsWith('work.private') || c === 'execution.member-run-record.v1'));
});
