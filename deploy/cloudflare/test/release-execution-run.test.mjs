import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const shape = 'execution.member-run-record.v1';
const capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1', 'work.personal-owner-acl.v1', 'work.server-policy.v1', shape];
function fixture() {
  const scan = checkMigrations(join(root, 'migrations'), loadManifest().database_defaults.migrations);
  assert.equal(scan.ok, true);
  const candidate = { source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) };
  const active = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
  const target = { environment: 'next', database_identity: 'synthetic-run-floor', recovery_generation: '2' };
  const host = { schema: 'freedom.release-compatibility-host/v2', target, now_ms: 10000, max_age_ms: 100,
    rollback_floor_shapes: [], rollback_floor: { evidence_id: 'synthetic-history', target, schema_ledger: scan.ledger,
      schema_ledger_digest: scan.ledger_digest, capabilities: [] },
    observation: { evidence_id: 'synthetic-observation', observed_at_ms: 9999, target,
      schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, enabled_shapes: [], written_shapes: [], active_releases: [active], complete: true },
    release_records: [active, candidate].map(identity => ({ ...identity, evidence_id: 'synthetic-approval', status: 'approved',
      environments: ['next'], schema_ledger_digests: [scan.ledger_digest], capabilities: [...capabilities], approved_at_ms: 9000, expires_at_ms: 11000 })) };
  return { input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] }, scan, host };
}
function evaluate(f) {
  const result = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  return result;
}
test('086 additive schema alone does not activate closed Runs or require their capability', () => {
  const f = fixture();
  for (const record of f.host.release_records) record.capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1'];
  assert.equal(evaluate(f).status, 'compatible');
  assert(!evaluate(f).required_capabilities.includes(shape));
});
for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) {
  test(`086 ${source} requires closed Run capability without granting operational authority`, () => {
    const f = fixture(), target = source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation;
    target[source] = [shape];
    assert.equal(evaluate(f).status, 'compatible');
    assert.deepEqual(evaluate(f).required_capabilities, [...capabilities].sort());
    for (const record of f.host.release_records) record.capabilities = record.capabilities.filter(value => value !== shape);
    assert.equal(evaluate(f).status, 'incompatible');
    assert(evaluate(f).issues.some(issue => issue.capability === shape));
  });
}
for (const binary of [0, 1]) for (const missing of ['work.personal-owner-acl.v1', 'work.server-policy.v1', shape]) {
  test(`086 closed Run shape requires ${missing} from ${binary === 0 ? 'active' : 'candidate'} binary`, () => {
    const f = fixture(); f.host.observation.written_shapes = [shape];
    f.host.release_records[binary].capabilities = capabilities.filter(value => value !== missing);
    const result = evaluate(f); assert.equal(result.status, 'incompatible');
    assert(result.issues.some(issue => issue.capability === missing && issue.source_sha === f.host.release_records[binary].source_sha));
  });
}
test('086 closed Run shape cannot be enabled before086 even with approval for older schema', () => {
  const f = fixture(), ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) <= 85), digest = compatibilityLedgerDigest(ledger);
  f.scan = { ok: true, ledger, ledger_digest: digest };
  for (const object of [f.host.observation, f.host.rollback_floor]) { object.schema_ledger = ledger; object.schema_ledger_digest = digest; }
  for (const record of f.host.release_records) record.schema_ledger_digests = [digest];
  f.input.enable_shapes = [shape]; f.host.observation.written_shapes = [shape];
  const result = evaluate(f); assert.equal(result.status, 'incompatible');
  for (const code of ['shape_schema_missing', 'observed_shape_schema_missing']) assert(result.issues.some(issue => issue.code === code));
});
test('086 historical Run capability survives empty current shape arrays and later recovery generation', () => {
  const f = fixture(); f.host.rollback_floor.capabilities = [shape];
  f.host.rollback_floor.target = { ...f.host.target, recovery_generation: '1' };
  f.host.release_records[0].capabilities = capabilities.filter(value => value !== shape);
  assert.equal(evaluate(f).status, 'incompatible');
  assert(evaluate(f).issues.some(issue => issue.capability === shape));
});

for (const capability of [shape, 'work.private-human-result.v1']) {
  for (const binary of [0, 1]) for (const missing of ['work.personal-owner-acl.v1', 'work.server-policy.v1']) {
    test(`retained ${capability} alone still requires ${missing} from binary${binary}`, () => {
      const f = fixture(); f.host.rollback_floor.capabilities = [capability];
      for (const record of f.host.release_records) record.capabilities.push('work.private-human-result.v1');
      assert.equal(evaluate(f).status, 'compatible');
      f.host.release_records[binary].capabilities = f.host.release_records[binary].capabilities.filter(value => value !== missing);
      const result = evaluate(f); assert.equal(result.status, 'incompatible');
      assert.deepEqual(result.required_shapes, []);
      assert(result.issues.some(issue => issue.capability === missing && issue.source_sha === f.host.release_records[binary].source_sha));
    });
  }
}
test('retained human Result at084 requires owner ACL but does not invent the later085 policy requirement', () => {
  const f = fixture(), ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) <= 84), digest = compatibilityLedgerDigest(ledger);
  f.scan = { ok: true, ledger, ledger_digest: digest };
  for (const object of [f.host.observation, f.host.rollback_floor]) { object.schema_ledger = ledger; object.schema_ledger_digest = digest; }
  f.host.rollback_floor.capabilities = ['work.private-human-result.v1'];
  for (const record of f.host.release_records) {
    record.schema_ledger_digests = [digest];
    record.capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1', 'work.personal-owner-acl.v1', 'work.private-human-result.v1'];
  }
  const result = evaluate(f); assert.equal(result.status, 'compatible');
  assert(!result.required_capabilities.includes('work.server-policy.v1'));
});
test('owner ACL capability alone does not invent persistence Result or Run requirements', () => {
  const f = fixture(); f.host.rollback_floor.capabilities = ['work.personal-owner-acl.v1'];
  for (const record of f.host.release_records) record.capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1', 'work.personal-owner-acl.v1'];
  const result = evaluate(f); assert.equal(result.status, 'compatible');
  assert.deepEqual(result.required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1', 'work.personal-owner-acl.v1']);
  assert.deepEqual(result.required_shapes, []);
});
