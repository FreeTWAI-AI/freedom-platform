import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkMigrations } from '../lib/migrations.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const last = Math.max(...readdirSync(join(root, 'migrations')).filter(n => /^\d{3}_.*\.sql$/.test(n)).map(n => Number(n.slice(0, 3))));
const scan = checkMigrations(join(root, 'migrations'), { first: 1, last, known_gaps: [22] });
const capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1', 'avatar.asset-bridge.v1', 'work.personal-owner-acl.v1', 'work.private-human-result.v1', 'work.server-policy.v1'];
const identity = (character) => ({ source_sha: character.repeat(40), artifact_sha256: character.repeat(64) });
function fixture() {
  const now = Date.parse('2026-10-02T12:00:00.000Z'), current = identity('a'), candidate = identity('b');
  const target = { environment: 'next', database_identity: 'synthetic-database', recovery_generation: '7' };
  // This is a synthetic independent HOST port. No actual approved publisher,
  // production observation, cloud configuration or deployment is asserted.
  const baseline = scan.ledger.filter(row => Number(row.name.slice(0, 3)) <= 75);
  const host = { schema: 'freedom.release-compatibility-host/v2', target, now_ms: now, max_age_ms: 10000,
    rollback_floor: { evidence_id: 'synthetic-history-baseline', target: { ...target }, schema_ledger: structuredClone(baseline),
      schema_ledger_digest: compatibilityLedgerDigest(baseline), capabilities: [] },
    rollback_floor_shapes: [], observation: { evidence_id: 'synthetic-observation', observed_at_ms: now - 1, target: { ...target },
      schema_ledger: structuredClone(scan.ledger), schema_ledger_digest: scan.ledger_digest,
      enabled_shapes: [], written_shapes: ['avatar.asset.v1', 'work.private-human-result.v1'], active_releases: [current], complete: true },
    release_records: [current, candidate].map((value, i) => ({ ...value, evidence_id: `synthetic-review-${i}`, status: 'approved', environments: ['next'],
      schema_ledger_digests: [scan.ledger_digest], capabilities: [...capabilities], approved_at_ms: now - 100, expires_at_ms: now + 10000 })) };
  return { input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] }, host, scan: structuredClone(scan) };
}
function run(f) {
  const result = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  assert.equal(result.deployment_authority, false); assert.equal(result.execution_authority, false); assert.equal(result.restore_proof, false);
  return result;
}
function reject(mutator, expectedCode) {
  const f = fixture(); mutator(f); const result = run(f);
  assert.notEqual(result.status, 'compatible', JSON.stringify(result));
  if (expectedCode) assert(result.issues.some(issue => issue.code === expectedCode), JSON.stringify(result));
}

test('RELEASE independent complete real ledger with synthetic host is diagnostic only, never deployment permission', () => {
  assert.equal(scan.ok, true);
  const result = run(fixture()); assert.equal(result.status, 'compatible', JSON.stringify(result)); assert.equal(result.checked_releases, 2);
  assert(result.required_capabilities.includes('work.private-human-result.v1'));
});

test('RELEASE recognized social-feed migration still needs exact independent schema approval', () => {
  const f = fixture();
  assert(f.scan.ledger.some(row => row.name === '125_social_feed_interactions.sql'));
  assert(f.scan.ledger.some(row => row.name === '126_workshop_sticker_pack.sql'));
  assert.equal(run(f).status, 'compatible');
  // A release approved before native posts existed cannot use that approval
  // for the new schema, even with the same source/artifact identity.
  const old = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) < 126);
  f.host.release_records[1].schema_ledger_digests = [compatibilityLedgerDigest(old)];
  const result = run(f);
  assert.equal(result.status, 'incompatible');
  assert(result.issues.some(issue => issue.code === 'release_schema_unsupported'));
});

test('RELEASE unknown migration names remain refused even with recomputed host digests', () => {
  for (const mode of ['rename-known', 'append-unknown']) {
    const f = fixture();
    if (mode === 'rename-known') f.scan.ledger.at(-1).name = '126_unreviewed_stickers.sql';
    else f.scan.ledger.push({name: '127_unreviewed_future.sql', sha256: 'e'.repeat(64)});
    f.scan.ledger_digest = compatibilityLedgerDigest(f.scan.ledger);
    f.host.observation.schema_ledger = structuredClone(f.scan.ledger);
    f.host.observation.schema_ledger_digest = f.scan.ledger_digest;
    for (const record of f.host.release_records) record.schema_ledger_digests = [f.scan.ledger_digest];
    const result = run(f);
    assert.equal(result.status, 'unavailable');
    assert(result.issues.some(issue => issue.code === 'schema_unknown'));
  }
});
test('RELEASE candidate cannot manufacture host authority or self-approve capabilities', () => {
  reject(f => { delete f.host; }, 'trusted_host_required');
  reject(f => { f.input.candidate.capabilities = [...capabilities]; }, 'request_invalid');
  reject(f => { f.input.host = f.host; delete f.host; }, 'request_invalid');
});
test('RELEASE correct source SHA with different artifact still needs independent approval', () => {
  reject(f => { f.input.candidate.artifact_sha256 = 'c'.repeat(64); }, 'release_approval_missing');
});
for (const [name, mutate, issue] of [
  ['stale observation', f => { f.host.observation.observed_at_ms = f.host.now_ms - f.host.max_age_ms - 1; }, 'observation_stale'],
  ['future observation', f => { f.host.observation.observed_at_ms = f.host.now_ms + 1; }, 'observation_stale'],
  ['wrong database', f => { f.host.observation.target.database_identity = 'another-synthetic-db'; }, 'target_mismatch'],
  ['old recovery generation', f => { f.host.observation.target.recovery_generation = '6'; }, 'target_mismatch'],
  ['wrong environment', f => { f.host.observation.target.environment = 'staging-next'; }, 'target_mismatch'],
  ['incomplete deployment observation', f => { f.host.observation.complete = false; }, 'observation_incomplete'],
  ['empty active deployment set', f => { f.host.observation.active_releases = []; }, 'observation_incomplete'],
  ['duplicate active deployment identity', f => { f.host.observation.active_releases.push(f.host.observation.active_releases[0]); }, 'observation_incomplete'],
]) test(`RELEASE independent ${name} cannot attest compatibility`, () => reject(mutate, issue));

test('RELEASE mismatched DB migration bytes cannot be hidden behind recomputed digests and approved capabilities', () => {
  reject(f => {
    f.host.observation.schema_ledger[0].sha256 = 'f'.repeat(64);
    f.host.observation.schema_ledger_digest = compatibilityLedgerDigest(f.host.observation.schema_ledger);
    for (const record of f.host.release_records) record.schema_ledger_digests.push(f.host.observation.schema_ledger_digest);
  }, 'schema_ledger_mismatch');
});
test('RELEASE matching last migration is insufficient if a prior row is missing or the ledger order is wrong', () => {
  for (const mutation of [ledger => ledger.splice(2, 1), ledger => { [ledger[0], ledger[1]] = [ledger[1], ledger[0]]; }]) reject(f => {
    mutation(f.host.observation.schema_ledger);
    f.host.observation.schema_ledger_digest = compatibilityLedgerDigest(f.host.observation.schema_ledger);
  }, 'schema_ledger_invalid');
});
test('RELEASE candidate cannot lower planned schema below the actually observed ledger', () => {
  reject(f => { f.scan.ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) <= 75); f.scan.ledger_digest = compatibilityLedgerDigest(f.scan.ledger); }, 'schema_ledger_mismatch');
});
test('RELEASE schema077 requires explicit Work projection even without any enabled or written private shape', () => {
  reject(f => {
    f.host.observation.written_shapes = [];
    for (const record of f.host.release_records) record.capabilities = record.capabilities.filter(v => v !== 'work.explicit-wire.v1');
  }, 'release_capability_missing');
});
for (const release of ['active', 'candidate']) for (const capability of ['avatar.asset-bridge.v1', 'work.personal-owner-acl.v1', 'work.private-human-result.v1', 'work.server-policy.v1'])
  test(`RELEASE ${release} missing ${capability} is unsafe during mixed-version rollout`, () => reject(f => {
    const record = f.host.release_records[release === 'active' ? 0 : 1]; record.capabilities = record.capabilities.filter(v => v !== capability);
  }, 'release_capability_missing'));
test('RELEASE policy schema alone is not private feature activation', () => {
  const f = fixture(); f.host.observation.written_shapes = [];
  for (const record of f.host.release_records) record.capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1'];
  const result = run(f); assert.equal(result.status, 'compatible', JSON.stringify(result));
  assert(!result.required_capabilities.includes('work.server-policy.v1'));
});
test('RELEASE disabled feature does not erase a non-rollback historical data floor', () => {
  reject(f => {
    f.host.observation.written_shapes = []; f.host.observation.enabled_shapes = [];
    f.host.rollback_floor_shapes = ['work.private-human-result.v1'];
    f.host.release_records[1].capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1'];
  }, 'release_capability_missing');
});
for (const [name, mutate, issue] of [
  ['withdrawn active binary', f => { f.host.release_records[0].status = 'withdrawn'; }, 'release_withdrawn'],
  ['expired candidate approval', f => { f.host.release_records[1].expires_at_ms = f.host.now_ms; }, 'release_approval_stale'],
  ['future candidate approval', f => { f.host.release_records[1].approved_at_ms = f.host.now_ms + 1; }, 'release_approval_stale'],
  ['candidate approved only for staging', f => { f.host.release_records[1].environments = ['staging-next']; }, 'release_environment_mismatch'],
  ['missing planned ledger approval', f => { f.host.release_records[1].schema_ledger_digests = ['f'.repeat(64)]; }, 'release_schema_unsupported'],
]) test(`RELEASE ${name} cannot satisfy current release evidence`, () => reject(mutate, issue));
test('RELEASE unknown execution shape is not inferred from otherwise capable binaries', () => {
  reject(f => { f.input.enable_shapes = ['execution.model-result.v1']; }, 'request_invalid');
});
test('RELEASE candidate getters are not run and candidate-selected error text is not echoed', () => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.input.candidate, 'source_sha', { enumerable: true, get() { calls++; throw Error('PRIVATE_MARKER'); } });
  const result = run(f); assert.equal(result.status, 'unavailable'); assert.equal(calls, 0); assert(!JSON.stringify(result).includes('PRIVATE_MARKER'));
});
