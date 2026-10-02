import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const device = 'execution.device-authorization.v1', bootstrap = 'execution.bootstrap-status.v1';
const prerequisites = [bootstrap, 'execution.agent-connection-record.v1', 'execution.runtime-enrollment.v1'];
function fixture() {
  const scan = checkMigrations(`${root}migrations`, loadManifest().database_defaults.migrations);
  assert.equal(scan.ok, true);
  const candidate = { source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) };
  const active = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
  const target = { environment: 'next', database_identity: 'synthetic-device-authorization', recovery_generation: '2' };
  const host = { schema: 'freedom.release-compatibility-host/v2', target, now_ms: 10000, max_age_ms: 100,
    rollback_floor_shapes: [], rollback_floor: { evidence_id: 'synthetic-history', target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, capabilities: [] },
    observation: { evidence_id: 'synthetic-observation', observed_at_ms: 9999, target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, enabled_shapes: [], written_shapes: [], active_releases: [active], complete: true },
    release_records: [active, candidate].map(identity => ({ ...identity, evidence_id: 'synthetic-approval', status: 'approved',
      environments: ['next'], schema_ledger_digests: [scan.ledger_digest],
      capabilities: ['platform.legacy.v1', 'work.explicit-wire.v1', device, ...prerequisites], approved_at_ms: 9000, expires_at_ms: 11000 })) };
  return { input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] }, scan, host };
}
function run(f) {
  const result = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  return result;
}
test('090 schema alone enables neither device pairing nor operational execution', () => {
  const f = fixture(); for (const record of f.host.release_records) record.capabilities.splice(2);
  const result = run(f); assert.equal(result.status, 'compatible');
  assert.deepEqual(result.required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1']);
});
for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) for (const binary of [0, 1]) {
  test(`090 ${source} requires device authorization and three prerequisites from binary${binary}`, () => {
    const f = fixture();
    (source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation)[source] = [device];
    assert.equal(run(f).status, 'compatible');
    for (const capability of [device, ...prerequisites]) {
      const changed = structuredClone(f);
      changed.host.release_records[binary].capabilities = changed.host.release_records[binary].capabilities.filter(c => c !== capability);
      assert(run(changed).issues.some(i => i.capability === capability && i.source_sha === changed.host.release_records[binary].source_sha));
    }
  });
}
test('retained device authorization capability carries every prerequisite without current shapes', () => {
  const f = fixture(); f.host.rollback_floor.capabilities = [device];
  for (const capability of prerequisites) for (const binary of [0, 1]) {
    const changed = structuredClone(f);
    changed.host.release_records[binary].capabilities = changed.host.release_records[binary].capabilities.filter(c => c !== capability);
    assert(run(changed).issues.some(i => i.capability === capability));
  }
});
function before090(f) {
  const ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) < 90);
  assert.equal(ledger.at(-1).name.slice(0, 3), '089');
  return { ledger, digest: compatibilityLedgerDigest(ledger) };
}
test('device authorization shape requires planned090 despite all binary capability claims', () => {
  const f = fixture(), old = before090(f); f.input.enable_shapes = [device];
  f.scan = { ...f.scan, ledger: old.ledger, ledger_digest: old.digest };
  f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.digest;
  f.host.rollback_floor.schema_ledger = old.ledger; f.host.rollback_floor.schema_ledger_digest = old.digest;
  for (const record of f.host.release_records) record.schema_ledger_digests.push(old.digest);
  assert(run(f).issues.some(i => i.code === 'shape_schema_missing' && i.shape === device));
});
test('retained device authorization history needs actual090, not a planned future repair', () => {
  const f = fixture(), old = before090(f); f.host.rollback_floor_shapes = [device];
  f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.digest;
  f.host.rollback_floor.schema_ledger = old.ledger; f.host.rollback_floor.schema_ledger_digest = old.digest;
  for (const record of f.host.release_records) record.schema_ledger_digests.push(old.digest);
  assert(run(f).issues.some(i => i.code === 'historical_shape_schema_missing' && i.shape === device));
});
test('bootstrap support alone never implies device issuance, refresh, Grant or private data authority', () => {
  const f = fixture(); f.input.enable_shapes = [bootstrap];
  for (const record of f.host.release_records) record.capabilities = record.capabilities.filter(c => c !== device);
  const result = run(f); assert.equal(result.status, 'compatible'); assert(!result.required_capabilities.includes(device));
  assert(!result.required_capabilities.some(c => c.startsWith('work.private') || c === 'execution.member-run-record.v1'));
});
