import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const media = ['media.service-cover.asset.v1', 'media.event-banner.asset.v1', 'media.event-video.asset.v1', 'media.social-thumbnail.asset.v1', 'media.skill-image.asset.v1', 'media.event-highlight.asset.v1', 'media.social-preview-create.v1'];
function fixture() {
  const scan = checkMigrations(`${root}migrations`, loadManifest().database_defaults.migrations);
  assert.equal(scan.ok, true);
  const candidate = { source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) };
  const active = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
  const target = { environment: 'next', database_identity: 'synthetic-media-db', recovery_generation: '2' };
  return {
    scan, input: { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] },
    host: { schema: 'freedom.release-compatibility-host/v2', target, now_ms: 10000, max_age_ms: 100,
      rollback_floor_shapes: [],
      rollback_floor: { evidence_id: 'synthetic-media-floor', target, schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, capabilities: [] },
      observation: { evidence_id: 'synthetic-media-observation', target, observed_at_ms: 9999,
        schema_ledger: scan.ledger, schema_ledger_digest: scan.ledger_digest, enabled_shapes: [], written_shapes: [], active_releases: [active], complete: true },
      release_records: [active, candidate].map(identity => ({ ...identity, evidence_id: 'synthetic-media-approval', status: 'approved',
        environments: ['next'], schema_ledger_digests: [scan.ledger_digest], capabilities: ['platform.legacy.v1', 'work.explicit-wire.v1', 'media.server-policy.v1', ...media],
        approved_at_ms: 9000, expires_at_ms: 11000 })) }
  };
}
function run(f) {
  const result = evaluateReleaseCompatibility(f.input, { scan: f.scan, host: f.host });
  for (const field of ['deployment_authority', 'restore_proof', 'execution_authority']) assert.equal(result[field], false);
  return result;
}
function prefix(f, last, { planned = true } = {}) {
  const ledger = f.scan.ledger.filter(row => Number(row.name.slice(0, 3)) <= last);
  const digest = compatibilityLedgerDigest(ledger);
  if (planned) f.scan = { ...f.scan, ledger, ledger_digest: digest };
  for (const part of [f.host.observation, f.host.rollback_floor]) { part.schema_ledger = ledger; part.schema_ledger_digest = digest; }
  for (const record of f.host.release_records) record.schema_ledger_digests.push(digest);
}

test('additive media schema alone preserves disabled legacy compatibility', () => {
  const f = fixture(); for (const record of f.host.release_records) record.capabilities.splice(2);
  assert.equal(run(f).status, 'compatible');
  assert.deepEqual(run(f).required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1']);
});

for (const shape of media) test(`${shape} requires domain and policy support in every binary and every retained shape source`, () => {
  for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) {
    const f = fixture(); (source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation)[source] = [shape];
    const result = run(f); assert.equal(result.status, 'compatible');
    const required = ['media.server-policy.v1', shape, ...(shape==='media.social-preview-create.v1'?['media.social-thumbnail.asset.v1']:[])];
    assert.deepEqual(result.required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1', ...required].sort());
    for (const binary of [0, 1]) for (const capability of required) {
      const bad = structuredClone(f); bad.host.release_records[binary].capabilities = bad.host.release_records[binary].capabilities.filter(item => item !== capability);
      assert(run(bad).issues.some(issue => issue.code === 'release_capability_missing' && issue.capability === capability && issue.source_sha === bad.host.release_records[binary].source_sha));
    }
  }
});

test('retained media capabilities cannot replace missing prerequisite migrations or a restored lower schema', () => {
  for (const [capability, missing] of [['media.server-policy.v1', 99], ['media.service-cover.asset.v1', 99], ['media.event-banner.asset.v1', 99], ['media.event-video.asset.v1', 100], ['media.social-thumbnail.asset.v1', 101], ['media.skill-image.asset.v1', 102], ['media.event-highlight.asset.v1', 103], ['media.social-preview-create.v1', 105]]) {
    const f = fixture(); prefix(f, missing); f.host.rollback_floor.capabilities = [capability];
    const result = run(f); assert.equal(result.status, 'incompatible');
    assert(result.issues.some(issue => issue.code === 'shape_schema_missing'));
    assert(result.issues.some(issue => issue.code === 'historical_shape_schema_missing'));
    assert.deepEqual(result.required_shapes, [], 'capability history does not invent media writes');
    const planned = fixture(); prefix(planned, missing, { planned: false }); planned.host.rollback_floor.capabilities = [capability];
    assert(run(planned).issues.some(issue => issue.code === 'historical_shape_schema_missing'));
  }
});

test('written video floor cannot be removed by disabling the current installation', () => {
  const f = fixture(); f.host.rollback_floor_shapes = ['media.event-video.asset.v1'];
  f.host.release_records[0].capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1'];
  assert(run(f).issues.some(issue => issue.capability === 'media.event-video.asset.v1'));
  prefix(f, 100, { planned: false });
  assert(run(f).issues.some(issue => issue.code === 'historical_shape_schema_missing'));
});

test('uninstalled media purposes and changed SQL bytes cannot claim compatibility', () => {
  const unknown = fixture(); unknown.input.enable_shapes = ['media.future-kind.asset.v1'];
  assert.equal(run(unknown).status, 'unavailable');
  const altered = fixture(); altered.host.observation.schema_ledger = structuredClone(altered.host.observation.schema_ledger);
  altered.host.observation.schema_ledger.at(-1).sha256 = 'e'.repeat(64);
  altered.host.observation.schema_ledger_digest = compatibilityLedgerDigest(altered.host.observation.schema_ledger);
  assert.equal(run(altered).status, 'unavailable');
});

test('automatic social writer capability cannot be supplied by a manual-thumbnail-only binary', () => {
  const f = fixture(); f.input.enable_shapes = ['media.social-preview-create.v1'];
  f.host.release_records[0].capabilities = f.host.release_records[0].capabilities.filter(x => x !== 'media.social-preview-create.v1');
  assert(run(f).issues.some(issue => issue.code === 'release_capability_missing' && issue.capability === 'media.social-preview-create.v1'));
});
