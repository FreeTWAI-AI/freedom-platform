import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest, migrationShapeSatisfied, INTERNAL_V2_SHAPE } from '../lib/release-compatibility.mjs';
import { run } from '../preflight.mjs';
import { DAG_MIGRATIONS, LEGACY_MIGRATIONS, MIGRATION_V2_GUARD } from '../../../packages/db/migration-plan.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NOW = 1790899200000;
const CAPABILITIES = ['platform.legacy.v1', 'work.explicit-wire.v1', 'avatar.asset-bridge.v1', 'work.personal-owner-acl.v1', 'work.private-human-result.v1', 'work.server-policy.v1'];
function fixture() {
  const scan = checkMigrations(join(ROOT, 'migrations'), loadManifest().database_defaults.migrations);
  const candidate = { source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64) };
  const target = { environment: 'next', database_identity: 'synthetic-db', recovery_generation: '2' };
  const input = { schema: 'freedom.release-compatibility-request/v1', environment: 'next', candidate, enable_shapes: [] };
  const host = {
    schema: 'freedom.release-compatibility-host/v2', target, now_ms: NOW, max_age_ms: 30000,
    rollback_floor: { evidence_id: 'synthetic-retained-075', target: { ...target },
      schema_ledger: prefix(scan, 75).ledger, schema_ledger_digest: prefix(scan, 75).ledger_digest, capabilities: [] },
    rollback_floor_shapes: [], observation: {
      evidence_id: 'synthetic-observation', observed_at_ms: NOW - 1000, target: { ...target },
      schema_ledger: structuredClone(scan.ledger), schema_ledger_digest: scan.ledger_digest,
      enabled_shapes: [], written_shapes: [], active_releases: [{ ...candidate }], complete: true,
    },
    release_records: [{ ...candidate, evidence_id: 'synthetic-approval', status: 'approved', environments: ['next'],
      schema_ledger_digests: [scan.ledger_digest], capabilities: [...CAPABILITIES], approved_at_ms: NOW - 60000, expires_at_ms: NOW + 60000 }],
  };
  return { input, host, scan };
}
const evaluate = ({ input, host, scan }) => evaluateReleaseCompatibility(input, { host, scan });
const codes = (result) => result.issues.map((i) => i.code);
function prefix(value, last) {
  const rows = value.ledger.filter((r) => Number(r.name.slice(0, 3)) <= last);
  return { ...value, ledger: rows, ledger_digest: compatibilityLedgerDigest(rows) };
}

test('persisted historical avatar representation fences every old reader even after the feature is disabled',()=>{
 const f=fixture(),old={source_sha:'c'.repeat(40),artifact_sha256:'d'.repeat(64)};
 f.host.observation.written_shapes=['avatar.legacy-bytes.v1'];
 f.host.release_records[0].capabilities.push('avatar.legacy-bytes.v1');
 assert.equal(evaluate(f).status,'compatible');
 f.host.observation.active_releases.push(old);
 f.host.release_records.push({...structuredClone(f.host.release_records[0]),...old,evidence_id:'old-avatar-reader',capabilities:[...CAPABILITIES]});
 const result=evaluate(f);assert.equal(result.status,'incompatible');
 assert(result.issues.some(i=>i.code==='release_capability_missing'&&i.source_sha===old.source_sha&&i.capability==='avatar.legacy-bytes.v1'));
 assert.equal(result.deployment_authority,false);assert.equal(result.restore_proof,false);
});

test('retained avatar legacy capability preserves bridge dependency and schema111 without claiming written data',()=>{
 const f=fixture(),old=prefix(f.scan,110);
 f.host.rollback_floor.capabilities=['avatar.legacy-bytes.v1'];
 f.host.release_records[0].capabilities.push('avatar.legacy-bytes.v1');
 assert.equal(evaluate(f).status,'compatible');
 f.host.release_records[0].capabilities=f.host.release_records[0].capabilities.filter(c=>c!=='avatar.asset-bridge.v1');
 assert(evaluate(f).issues.some(i=>i.code==='release_capability_missing'&&i.capability==='avatar.asset-bridge.v1'));
 f.host.release_records[0].capabilities.push('avatar.asset-bridge.v1');
 f.host.observation.schema_ledger=old.ledger;f.host.observation.schema_ledger_digest=old.ledger_digest;
 f.host.release_records[0].schema_ledger_digests.push(old.ledger_digest);
 const result=evaluate(f);assert.equal(result.status,'incompatible');
 assert(result.issues.some(i=>i.code==='historical_shape_schema_missing'&&i.shape==='avatar.legacy-bytes.v1'));
});

test('ordinary avatar bridge does not acquire historical-byte reader capability from schema111 alone',()=>{
 const f=fixture();f.input.enable_shapes=['avatar.asset.v1'];
 const result=evaluate(f);assert.equal(result.status,'compatible');assert(!result.required_capabilities.includes('avatar.legacy-bytes.v1'));
});

test('exact current source/artifact, full ledger and synthetic host produce ONLY local compatibility', () => {
  const f = fixture();
  f.input.enable_shapes = ['avatar.asset.v1', 'work.private.v1', 'work.private-human-result.v1'];
  const result = evaluate(f);
  assert.equal(result.status, 'compatible');
  assert.deepEqual(result.issues, []);
  assert.equal(result.checked_releases, 1);
  assert.deepEqual(result.required_capabilities, CAPABILITIES.filter((c) => c !== 'work.server-policy.v1' || Number(f.scan.ledger.at(-1).name.slice(0, 3)) >= 85).sort());
  for (const flag of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[flag], false);
  assert.equal(f.host.release_records[0].capabilities.length, 6, 'caller data unchanged');
});

test('077 floor rejects old Work row-spread binary before any private writes', () => {
  const f = fixture();
  f.host.release_records[0].capabilities = ['platform.legacy.v1'];
  assert.equal(evaluate(f).status, 'incompatible');
  assert.ok(evaluate(f).issues.some((i) => i.capability === 'work.explicit-wire.v1'));
  const old = prefix(f.scan, 75);
  f.scan = old; f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.ledger_digest;
  f.host.release_records[0].schema_ledger_digests = [old.ledger_digest];
  assert.equal(evaluate(f).status, 'compatible', '075 is not given a fabricated 077 floor');
});

test('every mixed-version active binary, not only candidate, must meet the floor', () => {
  const f = fixture();
  const old = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
  f.host.observation.active_releases.push(old);
  f.host.release_records.push({ ...f.host.release_records[0], ...old, capabilities: ['platform.legacy.v1'] });
  const result = evaluate(f);
  assert.equal(result.status, 'incompatible');
  assert.equal(result.checked_releases, 2);
  assert.ok(result.issues.some((i) => i.source_sha === old.source_sha && i.capability === 'work.explicit-wire.v1'));
});

for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) {
  test(`${source} adds requirements; disabling writes never subtracts persisted rollback floors`, () => {
    const f = fixture();
    const container = source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation;
    container[source] = ['avatar.asset.v1', 'work.private-human-result.v1'];
    f.host.release_records[0].capabilities = ['platform.legacy.v1', 'work.explicit-wire.v1'];
    const result = evaluate(f);
    assert.equal(result.status, 'incompatible');
    for (const capability of ['avatar.asset-bridge.v1', 'work.personal-owner-acl.v1', 'work.private-human-result.v1']) {
      assert.ok(result.issues.some((i) => i.capability === capability), capability);
    }
  });
}

for (const [name, mutate, code] of [
  ['missing host', (f) => { f.host = undefined; }, 'trusted_host_required'],
  ['candidate approvals rejected', (f) => { f.input.capabilities = CAPABILITIES; }, 'request_invalid'],
  ['candidate clock rejected', (f) => { f.input.now_ms = NOW; }, 'request_invalid'],
  ['wrong source', (f) => { f.input.candidate.source_sha = 'e'.repeat(40); }, 'release_approval_missing'],
  ['wrong artifact', (f) => { f.input.candidate.artifact_sha256 = 'e'.repeat(64); }, 'release_approval_missing'],
  ['withdrawn', (f) => { f.host.release_records[0].status = 'withdrawn'; }, 'release_withdrawn'],
  ['expired approval', (f) => { f.host.release_records[0].expires_at_ms = NOW; }, 'release_approval_stale'],
  ['future approval', (f) => { f.host.release_records[0].approved_at_ms = NOW + 1; }, 'release_approval_stale'],
  ['stale observation', (f) => { f.host.observation.observed_at_ms = NOW - 30001; }, 'observation_stale'],
  ['future observation', (f) => { f.host.observation.observed_at_ms = NOW + 1; }, 'observation_stale'],
  ['wrong environment', (f) => { f.host.observation.target.environment = 'staging-next'; }, 'target_mismatch'],
  ['wrong database', (f) => { f.host.observation.target.database_identity = 'other-db'; }, 'target_mismatch'],
  ['old recovery generation', (f) => { f.host.observation.target.recovery_generation = '1'; }, 'target_mismatch'],
  ['incomplete observation', (f) => { f.host.observation.complete = false; }, 'observation_incomplete'],
  ['empty active list', (f) => { f.host.observation.active_releases = []; }, 'observation_incomplete'],
  ['duplicate approval', (f) => { f.host.release_records.push(f.host.release_records[0]); }, 'release_evidence_invalid'],
  ['wrong approval environment', (f) => { f.host.release_records[0].environments = ['staging-next']; }, 'release_environment_mismatch'],
  ['unknown execution shape', (f) => { f.input.enable_shapes = ['execution.run.v1']; }, 'request_invalid'],
  ['unknown stored shape', (f) => { f.host.observation.written_shapes = ['future.media.v1']; }, 'host_evidence_invalid'],
  ['unknown execution capability', (f) => { f.host.release_records[0].capabilities.push('execution.authorized.v1'); }, 'host_evidence_invalid'],
  ['full ledger approval missing', (f) => { f.host.release_records[0].schema_ledger_digests = ['f'.repeat(64)]; }, 'release_schema_unsupported'],
  ['host provenance absent', (f) => { delete f.host.observation.evidence_id; }, 'host_evidence_invalid'],
]) {
  test(`fail closed: ${name}`, () => {
    const f = fixture(); mutate(f);
    const result = evaluate(f);
    assert.notEqual(result.status, 'compatible'); assert.ok(codes(result).includes(code), JSON.stringify(result));
  });
}

test('schema ledger compares exact SQL digests, names, order and known gap22', () => {
  for (const mutation of [
    (rows) => { rows[0].sha256 = 'f'.repeat(64); },
    (rows) => { rows[0].name = '001_fake.sql'; },
    (rows) => { rows.splice(1, 1); },
    (rows) => { [rows[0], rows[1]] = [rows[1], rows[0]]; },
    (rows) => { rows.splice(21, 0, { name: '022_invented.sql', sha256: 'e'.repeat(64) }); },
  ]) {
    const f = fixture(); mutation(f.host.observation.schema_ledger);
    f.host.observation.schema_ledger_digest = compatibilityLedgerDigest(f.host.observation.schema_ledger);
    assert.notEqual(evaluate(f).status, 'compatible');
  }
});

test('migrating prefix checks BOTH current and planned schema for every consumer', () => {
  const f = fixture(); const old = prefix(f.scan, 75);
  f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.ledger_digest;
  assert.ok(codes(evaluate(f)).includes('release_schema_unsupported'));
  f.host.release_records[0].schema_ledger_digests.push(old.ledger_digest);
  assert.equal(evaluate(f).status, 'compatible');
});

test('editorial and scoped-chat migrations preserve host approval and authority boundaries', () => {
  const f = fixture();
  assert.deepEqual(f.scan.ledger.filter(row => /^(112|113)_/.test(row.name)).map(row => row.name), ['112_member_card_editorial.sql', '113_chat_stickers_replies.sql']);
  const result = evaluate(f);
  assert.equal(result.status, 'compatible');
  assert.deepEqual(result.required_capabilities, ['platform.legacy.v1', 'work.explicit-wire.v1']);
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  for (const filename of ['112_member_card_editorial.sql', '113_chat_stickers_replies.sql']) {
    const renamed = fixture();
    renamed.scan.ledger.find(row => row.name === filename).name = filename.replace('.sql', '_unreviewed.sql');
    renamed.scan.ledger_digest = compatibilityLedgerDigest(renamed.scan.ledger);
    assert.deepEqual(codes(evaluate(renamed)), ['schema_unknown']);
    const changed = fixture();
    changed.scan.ledger.find(row => row.name === filename).sha256 = 'd'.repeat(64);
    changed.scan.ledger_digest = compatibilityLedgerDigest(changed.scan.ledger);
    assert.notEqual(evaluate(changed).status, 'compatible');
    assert(codes(evaluate(changed)).includes('schema_ledger_mismatch'));
  }
});

test('preparation and OpenRouter migrations require exact ledger bytes and independent host approval', () => {
  const f = fixture();
  assert.deepEqual(f.scan.ledger.filter(row => /^(114|115)_/.test(row.name)).map(row => row.name), ['114_credential_ingest_preparations.sql', '115_openrouter_byok.sql']);
  const result = evaluate(f);
  assert.equal(result.status, 'compatible');
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  for (const filename of ['114_credential_ingest_preparations.sql', '115_openrouter_byok.sql']) {
    const renamed = fixture();
    renamed.scan.ledger.find(row => row.name === filename).name = filename.replace('.sql', '_unreviewed.sql');
    renamed.scan.ledger_digest = compatibilityLedgerDigest(renamed.scan.ledger);
    assert.deepEqual(codes(evaluate(renamed)), ['schema_unknown']);
    const changed = fixture();
    changed.scan.ledger.find(row => row.name === filename).sha256 = 'd'.repeat(64);
    changed.scan.ledger_digest = compatibilityLedgerDigest(changed.scan.ledger);
    assert(codes(evaluate(changed)).includes('schema_ledger_mismatch'));
  }
  f.host.release_records[0].schema_ledger_digests = [prefix(f.scan, 113).ledger_digest];
  assert(codes(evaluate(f)).includes('release_schema_unsupported'));
});

test('social writer floor recognition does not grant schema or deployment approval', () => {
  const filename = '116_social_thumbnail_writer_floor.sql', f = fixture();
  assert.equal(f.scan.ledger.filter(row => row.name === filename).length, 1);
  const result = evaluate(f);
  assert.equal(result.status, 'compatible');
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  f.host.release_records[0].schema_ledger_digests = [prefix(f.scan, 115).ledger_digest];
  assert(codes(evaluate(f)).includes('release_schema_unsupported'));
  const changed = fixture();
  changed.scan.ledger.find(row => row.name === filename).sha256 = 'd'.repeat(64);
  changed.scan.ledger_digest = compatibilityLedgerDigest(changed.scan.ledger);
  assert(codes(evaluate(changed)).includes('schema_ledger_mismatch'));
  const renamed = fixture();
  renamed.scan.ledger.find(row => row.name === filename).name = '116_unreviewed.sql';
  renamed.scan.ledger_digest = compatibilityLedgerDigest(renamed.scan.ledger);
  assert.deepEqual(codes(evaluate(renamed)), ['schema_unknown']);
});

test('machine admission schema still requires independently approved release and ledger', () => {
  const filename = '117_machine_text_execution.sql', f = fixture();
  assert.equal(f.scan.ledger.filter(row => row.name === filename).length, 1);
  const result = evaluate(f);
  assert.equal(result.status, 'compatible');
  for (const field of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[field], false);
  f.host.release_records[0].schema_ledger_digests = [prefix(f.scan, 116).ledger_digest];
  assert(codes(evaluate(f)).includes('release_schema_unsupported'));
  const changed = fixture();
  changed.scan.ledger.find(row => row.name === filename).sha256 = 'd'.repeat(64);
  changed.scan.ledger_digest = compatibilityLedgerDigest(changed.scan.ledger);
  assert(codes(evaluate(changed)).includes('schema_ledger_mismatch'));
  const renamed = fixture();
  renamed.scan.ledger.find(row => row.name === filename).name = '117_unreviewed.sql';
  renamed.scan.ledger_digest = compatibilityLedgerDigest(renamed.scan.ledger);
  assert.deepEqual(codes(evaluate(renamed)), ['schema_unknown']);
});

test('site authority persistence fences old readers after creation is disabled', () => {
  const shape = 'commerce.shop-service-authority.v1';
  for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) {
    const f = fixture();
    if (source === 'enable_shapes') f.input[source] = [shape];
    else if (source === 'rollback_floor_shapes') f.host[source] = [shape];
    else f.host.observation[source] = [shape];
    assert(evaluate(f).issues.some(i => i.code === 'release_capability_missing' && i.capability === shape), source);
    f.host.release_records[0].capabilities.push(shape);
    const result = evaluate(f); assert.equal(result.status, 'compatible', JSON.stringify(result));
    assert.equal(result.execution_authority, false); assert.equal(result.deployment_authority, false);
    const old = {source_sha:'c'.repeat(40),artifact_sha256:'d'.repeat(64)};
    f.host.observation.active_releases.push(old);
    f.host.release_records.push({...structuredClone(f.host.release_records[0]),...old,capabilities:[...CAPABILITIES]});
    assert(evaluate(f).issues.some(i => i.code === 'release_capability_missing' && i.source_sha === old.source_sha && i.capability === shape), source);
  }
});
test('site authority shape requires schema118 and exact independently approved ledger', () => {
  const f = fixture(), shape = 'commerce.shop-service-authority.v1', filename = '118_shop_service_identity.sql';
  assert.equal(f.scan.ledger.filter(row => row.name === filename).length, 1);
  f.host.release_records[0].schema_ledger_digests = [prefix(f.scan, 117).ledger_digest];
  assert(codes(evaluate(f)).includes('release_schema_unsupported'));
  const changed = fixture(); changed.scan.ledger.find(row => row.name === filename).sha256 = 'd'.repeat(64);
  changed.scan.ledger_digest = compatibilityLedgerDigest(changed.scan.ledger);
  assert(codes(evaluate(changed)).includes('schema_ledger_mismatch'));
  const old = fixture(); old.scan = prefix(old.scan, 117); old.input.enable_shapes = [shape];
  old.host.observation.schema_ledger = old.scan.ledger; old.host.observation.schema_ledger_digest = old.scan.ledger_digest;
  old.host.release_records[0].schema_ledger_digests = [old.scan.ledger_digest]; old.host.release_records[0].capabilities.push(shape);
  assert(codes(evaluate(old)).includes('shape_schema_missing'));
});

test('schema extension is unavailable until its exact known migration rule is reviewed', () => {
  const f = fixture();
  const next = Number(f.scan.ledger.at(-1).name.slice(0, 3)) + 1;
  f.scan.ledger.push({ name: `${String(next).padStart(3, '0')}_unknown.sql`, sha256: 'd'.repeat(64) });
  f.scan.ledger_digest = compatibilityLedgerDigest(f.scan.ledger);
  assert.deepEqual(codes(evaluate(f)), ['schema_unknown']);
});

test('085 requires current server-policy support for private shapes, but never activates private writes', () => {
  for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes']) {
    const f = fixture();
    f.scan = prefix(f.scan, 85); // Keep this historical085 vector stable as later migrations arrive.
    f.scan.ledger_digest = compatibilityLedgerDigest(f.scan.ledger);
    f.host.observation.schema_ledger = structuredClone(f.scan.ledger); f.host.observation.schema_ledger_digest = f.scan.ledger_digest;
    f.host.release_records[0].schema_ledger_digests = [f.scan.ledger_digest];
    f.host.release_records[0].capabilities = CAPABILITIES.filter((c) => c !== 'work.server-policy.v1');
    assert.equal(evaluate(f).status, 'compatible', 'schema alone does not activate private persistence');
    const container = source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host : f.host.observation;
    container[source] = ['work.private-human-result.v1'];
    assert.ok(evaluate(f).issues.some((i) => i.capability === 'work.server-policy.v1'), source);
    f.host.release_records[0].capabilities.push('work.server-policy.v1');
    assert.equal(evaluate(f).status, 'compatible');
  }
});

test('new shape cannot be enabled or observed before its migration', () => {
  const f = fixture(); const old = prefix(f.scan, 75);
  f.scan = old; f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.ledger_digest;
  f.host.release_records[0].schema_ledger_digests = [old.ledger_digest];
  f.input.enable_shapes = ['avatar.asset.v1']; f.host.observation.written_shapes = ['work.private-human-result.v1'];
  const result = evaluate(f);
  assert.ok(codes(result).includes('shape_schema_missing'));
  assert.ok(codes(result).includes('observed_shape_schema_missing'));
});

test('retained085 ledger and policy floor reject restored084 even with matching local approvals', () => {
  const f = fixture();
  f.host.rollback_floor.schema_ledger = structuredClone(f.scan.ledger);
  f.host.rollback_floor.schema_ledger_digest = f.scan.ledger_digest;
  f.host.rollback_floor.capabilities = ['work.server-policy.v1'];
  f.scan = prefix(f.scan, 84);
  f.host.observation.schema_ledger = structuredClone(f.scan.ledger);
  f.host.observation.schema_ledger_digest = f.scan.ledger_digest;
  f.host.release_records[0].schema_ledger_digests = [f.scan.ledger_digest];
  f.host.release_records[0].capabilities = CAPABILITIES.filter((c) => c !== 'work.server-policy.v1');
  f.host.rollback_floor_shapes = ['work.private-human-result.v1'];
  const result = evaluate(f);
  assert.equal(result.status, 'incompatible');
  assert.ok(codes(result).includes('historical_schema_floor_mismatch'));
  assert.ok(result.issues.some(i => i.capability === 'work.server-policy.v1'));
  assert.equal(result.restore_proof, false, 'a separate historical schema/policy-aware restore gate remains mandatory');
  assert.equal(result.deployment_authority, false);
  assert.ok(result.required_capabilities.includes('work.private-human-result.v1'), 'shape history is still required');
});

test('host-v1, absent/null/empty retained floor never receive an empty-history default', () => {
  for (const mutate of [f => { f.host.schema = 'freedom.release-compatibility-host/v1'; },
    f => { delete f.host.rollback_floor; }, f => { f.host.rollback_floor = null; }, f => { f.host.rollback_floor = {}; }]) {
    const f = fixture(); mutate(f); const result = evaluate(f);
    assert.equal(result.status, 'unavailable'); assert.equal(result.restore_proof, false);
  }
});

test('retained full ledger requires exact SQL bytes, names, order and digest even when current ledgers agree', () => {
  for (const mutate of [rows => { rows[0].sha256 = 'f'.repeat(64); }, rows => { rows[0].name = '001_changed.sql'; },
    rows => { rows.splice(1, 1); }, rows => { [rows[0], rows[1]] = [rows[1], rows[0]]; }]) {
    const f = fixture(); mutate(f.host.rollback_floor.schema_ledger);
    f.host.rollback_floor.schema_ledger_digest = compatibilityLedgerDigest(f.host.rollback_floor.schema_ledger);
    assert.notEqual(evaluate(f).status, 'compatible');
  }
  const f = fixture(); f.host.rollback_floor.schema_ledger_digest = 'f'.repeat(64);
  assert.deepEqual(codes(evaluate(f)), ['schema_ledger_invalid']);
});

test('current schema below retained floor is incompatible even if planned migrations would repair it', () => {
  const f = fixture(); f.host.rollback_floor.schema_ledger = structuredClone(f.scan.ledger);
  f.host.rollback_floor.schema_ledger_digest = f.scan.ledger_digest;
  const old = prefix(f.scan, 84); f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.ledger_digest;
  f.host.release_records[0].schema_ledger_digests.push(old.ledger_digest);
  assert.deepEqual(codes(evaluate(f)), ['historical_schema_floor_mismatch']);
});

test('retained shape independently constrains current schema even when the separate ledger floor is lower', () => {
  for (const shape of ['avatar.asset.v1','work.private.v1','work.private-human-result.v1']) {
    const f = fixture(), old = prefix(f.scan,75);
    f.host.rollback_floor_shapes = [shape]; // Explicit retained075 ledger remains unchanged.
    f.host.observation.schema_ledger = old.ledger; f.host.observation.schema_ledger_digest = old.ledger_digest;
    f.host.release_records[0].schema_ledger_digests.push(old.ledger_digest);
    const bad = evaluate(f);
    assert.equal(bad.status,'incompatible');
    assert.ok(bad.issues.some(issue => issue.code === 'historical_shape_schema_missing' && issue.shape === shape));
    // Independent lower ledger and higher shape components are not inherently
    // contradictory: their conservative union is satisfiable by current085.
    f.host.observation.schema_ledger = structuredClone(f.scan.ledger);
    f.host.observation.schema_ledger_digest = f.scan.ledger_digest;
    assert.equal(evaluate(f).status,'compatible');
    assert.equal(evaluate(f).restore_proof,false);
  }
});

test('historical capability floor survives disabled/empty shapes for every mixed active and candidate binary', () => {
  for (const missing of ['active', 'candidate']) {
    const f = fixture(), other = { source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64) };
    f.host.observation.active_releases = [other];
    f.host.release_records.push({ ...structuredClone(f.host.release_records[0]), ...other });
    f.host.rollback_floor.capabilities = ['work.server-policy.v1'];
    f.host.release_records[missing === 'candidate' ? 0 : 1].capabilities = ['platform.legacy.v1','work.explicit-wire.v1'];
    const result = evaluate(f); assert.equal(result.status, 'incompatible'); assert.equal(result.checked_releases, 2);
    assert.ok(result.issues.some(i => i.capability === 'work.server-policy.v1'));
  }
});

test('retained target lineage cannot be silently moved across databases or environments', () => {
  for (const [field, value] of [['environment','staging-next'],['database_identity','synthetic-restored-db']]) {
    const f = fixture(); f.host.rollback_floor.target[field] = value;
    assert.deepEqual(codes(evaluate(f)), ['historical_target_mismatch']);
  }
});

test('recovery comparison is exact beyond safe integers and increasing generation never removes retained capabilities', () => {
  const f = fixture(); f.host.rollback_floor.target.recovery_generation = '9007199254740993';
  f.host.target.recovery_generation = f.host.observation.target.recovery_generation = '9007199254740992';
  assert.deepEqual(codes(evaluate(f)), ['historical_recovery_regression']);
  f.host.target.recovery_generation = f.host.observation.target.recovery_generation = '9007199254740994';
  f.host.rollback_floor.capabilities = ['work.server-policy.v1'];
  f.host.release_records[0].capabilities = ['platform.legacy.v1','work.explicit-wire.v1'];
  assert.ok(evaluate(f).issues.some(i => i.capability === 'work.server-policy.v1'));
  f.host.release_records[0].capabilities.push('work.server-policy.v1');
  assert.equal(evaluate(f).status, 'compatible'); assert.equal(evaluate(f).restore_proof, false);
});

test('floor source remains external: candidate override, unknown capabilities and malformed floor data fail closed', () => {
  for (const mutate of [f => { f.input.rollback_floor = f.host.rollback_floor; },
    f => { f.host.rollback_floor.capabilities = ['execution.authorized.v1']; },
    f => { f.host.rollback_floor.capabilities = ['work.server-policy.v1','work.server-policy.v1']; },
    f => { f.host.rollback_floor.target.recovery_generation += '\n'; },
    f => { f.host.rollback_floor.evidence_id = 'x'.repeat(161); },
    f => { f.host.rollback_floor.schema_ledger = []; }]) {
    const f = fixture(); mutate(f); assert.equal(evaluate(f).status, 'unavailable');
  }
});

test('data boundary rejects accessors, functions, sparse arrays, cycles, oversized data and trailing delimiters', () => {
  let invoked = 0;
  const cases = [
    (f) => { Object.defineProperty(f.input, 'candidate', { enumerable: true, get() { invoked++; return {}; } }); },
    (f) => { f.input.toJSON = () => { invoked++; return {}; }; },
    (f) => { f.input.enable_shapes = [, 'avatar.asset.v1']; },
    (f) => { f.input.enable_shapes = f.input; },
    (f) => { f.input.extra = 'x'.repeat(16385); },
    (f) => { f.input.candidate.source_sha += '\n'; },
    (f) => { f.host.target.recovery_generation += '\r'; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.notEqual(evaluate(f).status, 'compatible'); }
  assert.equal(invoked, 0);
});

test('CLI concretely uses scanner and host port; no host fails, all propagates requested failure', async (t) => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'fp-release-compatibility-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'request.json'); writeFileSync(path, JSON.stringify(f.input));
  const flags = ['--compatibility-input', path];
  let result = await run(['compatibility', ...flags]);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.output).compatibility.status, 'unavailable');
  result = await run(['compatibility', ...flags], { compatibilityHost: f.host });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.output).compatibility.status, 'compatible');
  result = await run(['all', ...flags]); assert.equal(result.code, 1);
  result = await run(['all']); assert.equal(result.code, 0); assert.equal(JSON.parse(result.output).compatibility, undefined);
  assert.equal((await run(['compatibility', ...flags, '--execute'], { compatibilityHost: f.host })).code, 3);
  await assert.rejects(run(['compatibility', ...flags, '--trust-host', path]), /Unknown option/);
  await assert.rejects(run(['manifest', ...flags]), /only valid/);
});

test('CLI never executes candidate JSON and rejects duplicates, nonregular input and unbounded bytes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-release-input-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'request.json');
  for (const body of ['{"schema":"x","schema":"y"}', 'x'.repeat(16385), 'export default (()=>{throw Error("private-marker")})()']) {
    writeFileSync(path, body);
    const result = await run(['compatibility', '--compatibility-input', path]);
    assert.equal(result.code, 2); assert.doesNotMatch(result.output, /private-marker|export default/);
  }
  symlinkSync(path, join(dir, 'link.json'));
  assert.equal((await run(['compatibility', '--compatibility-input', join(dir, 'link.json')])).code, 2);
  assert.equal((await run(['compatibility', '--compatibility-input', resolve(dir, 'missing.json')])).code, 2);
});

test('096 broker bridge compatibility requires exact lineage and retained dependencies without granting execution', () => {
  const f=fixture();assert.equal(f.scan.ok,true);
  // Keep the original096 lineage vector stable as later reviewed migrations arrive.
  f.scan={...prefix(f.scan,96),last:'096_model_broker_authorizations.sql'};
  f.host.observation.schema_ledger=f.scan.ledger;f.host.observation.schema_ledger_digest=f.scan.ledger_digest;
  f.host.release_records[0].schema_ledger_digests=[f.scan.ledger_digest];
  assert.equal(f.scan.ledger.at(-1).name,'096_model_broker_authorizations.sql');
  const bridgeCapabilities=['execution.model-broker-bridge.v1','execution.model-credential-custody.v1','execution.model-text-step.v1',
    'work.private-model-result.v1','work.private-human-result.v1','execution.member-prerequisites.v1','execution.member-run-record.v1',
    'execution.runtime-enrollment.v1','execution.agent-connection-record.v1','execution.bootstrap-status.v1','execution.bootstrap-session.v1'];
  f.host.release_records[0].capabilities=[...CAPABILITIES,...bridgeCapabilities.filter(c=>!CAPABILITIES.includes(c))];
  f.input.enable_shapes=['execution.model-broker-bridge.v1'];
  let result=evaluate(f);assert.equal(result.status,'compatible');assert(result.required_capabilities.includes('execution.model-broker-bridge.v1'));
  for(const key of ['deployment_authority','execution_authority','restore_proof'])assert.equal(result[key],false);
  f.host.release_records[0].capabilities=f.host.release_records[0].capabilities.filter(c=>c!=='execution.model-broker-bridge.v1');
  assert(evaluate(f).issues.some(i=>i.capability==='execution.model-broker-bridge.v1'));
  f.input.enable_shapes=[];f.host.rollback_floor.capabilities=['execution.model-broker-bridge.v1'];
  assert(evaluate(f).issues.some(i=>i.capability==='execution.model-broker-bridge.v1'));
  const old=prefix(f.scan,95);f.scan=old;f.host.observation.schema_ledger=old.ledger;f.host.observation.schema_ledger_digest=old.ledger_digest;
  f.host.release_records[0].schema_ledger_digests=[old.ledger_digest];f.host.rollback_floor.capabilities=[];f.input.enable_shapes=['execution.model-broker-bridge.v1'];
  assert(evaluate(f).issues.some(i=>i.code==='shape_schema_missing'));
});

const preparationCapability = 'execution.model-credential-preparation.v1';
const openRouterCapability = 'execution.openrouter-selection.v1';
const persistedProfileCapabilities = [preparationCapability, openRouterCapability,
  'execution.model-credential-ingest.v1', 'execution.model-credential-custody.v1',
  'execution.member-prerequisites.v1', 'execution.member-run-record.v1',
  'execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1',
  'execution.bootstrap-status.v1', 'execution.bootstrap-session.v1'];
function persistedFixture() {
  const f = fixture();
  f.host.release_records[0].capabilities = [...new Set([...CAPABILITIES, ...persistedProfileCapabilities])];
  return f;
}
for (const [shape, migration, dependency] of [
  [preparationCapability, 114, 'execution.model-credential-ingest.v1'],
  [openRouterCapability, 115, 'execution.member-prerequisites.v1'],
]) {
  for (const source of ['enable_shapes', 'enabled_shapes', 'written_shapes', 'rollback_floor_shapes', 'capabilities']) {
    test(`${shape}: ${source} fences both candidate and mixed old consumer`, () => {
      const f = persistedFixture();
      const container = source === 'enable_shapes' ? f.input : source === 'rollback_floor_shapes' ? f.host
        : source === 'capabilities' ? f.host.rollback_floor : f.host.observation;
      container[source] = [shape];
      assert.equal(evaluate(f).status, 'compatible');
      const old = {source_sha: 'c'.repeat(40), artifact_sha256: 'd'.repeat(64)};
      f.host.observation.active_releases.push(old);
      f.host.release_records.push({...structuredClone(f.host.release_records[0]), ...old, evidence_id: 'old-reader'});
      for (const index of [0, 1]) {
        for (const missing of [shape, dependency]) {
          const record = f.host.release_records[index], saved = record.capabilities;
          record.capabilities = saved.filter(c => c !== missing);
          const result = evaluate(f);
          assert(result.issues.some(i => i.code === 'release_capability_missing' && i.capability === missing && i.source_sha === record.source_sha));
          for (const key of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[key], false);
          record.capabilities = saved;
        }
      }
    });
  }
  test(`${shape}: retained history rejects a restored pre-profile schema`, () => {
    for (const source of ['written_shapes', 'rollback_floor_shapes', 'capabilities']) {
      const f = persistedFixture(), old = prefix(f.scan, migration - 1);
      f.scan = old;
      f.host.observation.schema_ledger = old.ledger;
      f.host.observation.schema_ledger_digest = old.ledger_digest;
      f.host.release_records[0].schema_ledger_digests = [old.ledger_digest];
      const container = source === 'capabilities' ? f.host.rollback_floor : source === 'rollback_floor_shapes' ? f.host : f.host.observation;
      container[source] = [shape];
      const result = evaluate(f);
      assert(result.issues.some(i => i.code === 'shape_schema_missing' && i.shape === shape));
      assert(result.issues.some(i => i.code === (source === 'written_shapes' ? 'observed_shape_schema_missing' : 'historical_shape_schema_missing') && i.shape === shape));
    }
  });
}
test('114 fences generic ingest writers while schema alone does not assert OpenRouter state', () => {
  const f = persistedFixture();
  f.input.enable_shapes = ['execution.model-credential-ingest.v1'];
  f.host.release_records[0].capabilities = f.host.release_records[0].capabilities.filter(c => c !== preparationCapability);
  assert(evaluate(f).issues.some(i => i.capability === preparationCapability));
  f.input.enable_shapes = [];
  assert.equal(evaluate(f).status, 'compatible');
  assert(!evaluate(f).required_capabilities.includes(openRouterCapability));
  const old = prefix(f.scan, 113);
  f.scan = old; f.host.observation.schema_ledger = old.ledger;
  f.host.observation.schema_ledger_digest = old.ledger_digest;
  f.host.release_records[0].schema_ledger_digests = [old.ledger_digest];
  f.input.enable_shapes = ['execution.model-credential-ingest.v1'];
  assert.equal(evaluate(f).status, 'compatible', 'original pre-114 ingest contract remains representable');
});

const FRONTIER_NAME = '128_module_instance_archive.sql';
const NODE_A = 'v2_20261005T000000001Z_0000000000000001_alpha.sql';
const NODE_B = 'v2_20261005T000000002Z_0000000000000002_beta.sql';
const NODE_C = 'v2_20261005T000000000Z_0000000000000003_child.sql';
const byFileName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
function v2Sql(deps, body) {
  return '-- freedom-migration: ' + JSON.stringify({ format: DAG_MIGRATIONS, depends_on: deps }) + '\n' + MIGRATION_V2_GUARD + body;
}
function sortedLedger(rows) {
  const ledger = [...rows].sort(byFileName);
  return { ledger, ledger_digest: compatibilityLedgerDigest(ledger) };
}
let dagCatalogs;
function catalogs() {
  if (dagCatalogs) return dagCatalogs;
  const root = mkdtempSync(join(tmpdir(), 'fp-c5c-floor-'));
  const legacyScan = checkMigrations(join(ROOT, 'migrations'), loadManifest().database_defaults.migrations);
  const profile = {
    format: DAG_MIGRATIONS,
    legacy: { format: LEGACY_MIGRATIONS, first: 1, last: 128, known_gaps: [22] },
    legacy_ledger: legacyScan.ledger.map(({ name, sha256 }) => ({ name, sha256 })),
  };
  const files = {
    [NODE_A]: v2Sql([FRONTIER_NAME], 'CREATE TABLE alpha_floor(id integer PRIMARY KEY);\n'),
    [NODE_B]: v2Sql([FRONTIER_NAME], 'CREATE TABLE beta_floor(id integer PRIMARY KEY);\n'),
    [NODE_C]: v2Sql([NODE_A], 'CREATE TABLE child_floor(id integer PRIMARY KEY);\n'),
    [INTERNAL_V2_SHAPE.migration_name]: v2Sql([FRONTIER_NAME], 'CREATE TABLE shape_floor(id integer PRIMARY KEY);\n'),
  };
  const fill = (dir, names) => {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(join(ROOT, 'migrations'))) if (name.endsWith('.sql')) copyFileSync(join(ROOT, 'migrations', name), join(dir, name));
    for (const name of names) writeFileSync(join(dir, name), files[name]);
  };
  const ab = join(root, 'ab'), ba = join(root, 'ba'), abc = join(root, 'abc'), shape = join(root, 'shape');
  fill(ab, [NODE_A, NODE_B]); fill(ba, [NODE_B, NODE_A]); fill(abc, [NODE_A, NODE_B, NODE_C]); fill(shape, [INTERNAL_V2_SHAPE.migration_name]);
  const expected = loadManifest().database_defaults.migrations;
  const scan = (dir) => checkMigrations(dir, expected, profile);
  dagCatalogs = { root, profile, legacyScan, ab: scan(ab), ba: scan(ba), abc: scan(abc), shape: scan(shape) };
  return dagCatalogs;
}
after(() => { if (dagCatalogs) rmSync(dagCatalogs.root, { recursive: true, force: true }); });
function v3Fixture(scan, observedRows, floorRows = scan.ledger.filter((row) => !row.name.startsWith('v2_'))) {
  const catalog = catalogs();
  const observed = sortedLedger(observedRows), floor = sortedLedger(floorRows), base = fixture();
  base.scan = scan;
  base.host.schema = 'freedom.release-compatibility-host/v3';
  base.host.migration_profile = structuredClone(catalog.profile);
  base.host.observation.schema_ledger = observed.ledger;
  base.host.observation.schema_ledger_digest = observed.ledger_digest;
  base.host.rollback_floor.schema_ledger = floor.ledger;
  base.host.rollback_floor.schema_ledger_digest = floor.ledger_digest;
  base.host.release_records[0].schema_ledger_digests = [...new Set([observed.ledger_digest, scan.ledger_digest])];
  return base;
}
const legacyOf = (scan) => scan.ledger.filter((row) => !row.name.startsWith('v2_'));
const rowNamed = (scan, name) => scan.ledger.find((row) => row.name === name);

test('v3 legacy-only catalog keeps the v2 floor and still refuses deployment authority', () => {
  const f = fixture();
  f.host.schema = 'freedom.release-compatibility-host/v3';
  f.host.migration_profile = structuredClone(catalogs().profile);
  const result = evaluate(f);
  assert.equal(result.status, 'compatible', JSON.stringify(result));
  for (const flag of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[flag], false);
});

test('v3 accepts A→B and B→A as one canonical digest, including B-before-A observation order', () => {
  const catalog = catalogs();
  assert.equal(catalog.ab.ok, true, JSON.stringify(catalog.ab.problems));
  assert.equal(catalog.ab.ledger_digest, catalog.ba.ledger_digest);
  assert.deepEqual(catalog.ab.dependencies, catalog.ba.dependencies);
  const legacy = legacyOf(catalog.ab), alpha = rowNamed(catalog.ab, NODE_A), beta = rowNamed(catalog.ab, NODE_B);
  const forward = v3Fixture(catalog.ab, [...legacy, alpha]);
  const reverse = v3Fixture(catalog.ba, [...legacy, alpha]);
  const first = evaluate(forward), second = evaluate(reverse);
  assert.equal(first.status, 'compatible', JSON.stringify(first));
  assert.deepEqual(first.issues, second.issues);
  assert.deepEqual(first.required_capabilities, second.required_capabilities);
  for (const flag of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(first[flag], false);
  const unordered = [beta, alpha, ...legacy];
  const applied = v3Fixture(catalog.ab, unordered, legacy);
  applied.host.observation.schema_ledger = unordered;
  applied.host.observation.schema_ledger_digest = catalog.ab.ledger_digest;
  assert.equal(applied.host.observation.schema_ledger_digest, sortedLedger(unordered).ledger_digest);
  assert.equal(evaluate(applied).status, 'compatible', JSON.stringify(evaluate(applied)));
  applied.host.release_records[0].schema_ledger_digests = [compatibilityLedgerDigest(unordered)];
  assert.notEqual(compatibilityLedgerDigest(unordered), catalog.ab.ledger_digest);
  assert(codes(evaluate(applied)).includes('release_schema_unsupported'));
});

test('an earlier-sorting v2 node merged later stays pending and is not implied by a later applied node', () => {
  const catalog = catalogs(), legacy = legacyOf(catalog.ab), beta = rowNamed(catalog.ab, NODE_B);
  assert(NODE_A < NODE_B);
  const f = v3Fixture(catalog.ab, [...legacy, beta]);
  assert.equal(f.host.observation.schema_ledger.some((row) => row.name === NODE_A), false);
  assert.equal(catalog.ab.ledger.some((row) => row.name === NODE_A), true);
  assert.notEqual(f.host.observation.schema_ledger_digest, catalog.ab.ledger_digest);
  const result = evaluate(f);
  assert.equal(result.status, 'compatible', JSON.stringify(result));
  f.host.release_records[0].schema_ledger_digests = [catalog.ab.ledger_digest];
  assert(codes(evaluate(f)).includes('release_schema_unsupported'));
});

test('v3 rejects a v2 node whose declared dependency is absent from observed or the retained floor', () => {
  const catalog = catalogs(), legacy = legacyOf(catalog.abc), child = rowNamed(catalog.abc, NODE_C);
  const observed = v3Fixture(catalog.abc, [...legacy, child]);
  let result = evaluate(observed);
  assert.equal(result.status, 'incompatible');
  assert.deepEqual(result.issues.map((issue) => issue.ledger), ['observed']);
  assert.equal(result.issues[0].code, 'schema_dependency_closure_invalid');
  const floor = v3Fixture(catalog.abc, catalog.abc.ledger, [...legacy, child]);
  result = evaluate(floor);
  assert(result.issues.some((issue) => issue.code === 'schema_dependency_closure_invalid' && issue.ledger === 'rollback_floor'));
  assert.equal(result.deployment_authority, false);
});

test('v3 rejects floor/observed set mismatches, unknown rows, digest changes and renamed identities', () => {
  const catalog = catalogs(), legacy = legacyOf(catalog.ab), alpha = rowNamed(catalog.ab, NODE_A);
  const floor = v3Fixture(catalog.ab, legacy, [...legacy, alpha]);
  assert(codes(evaluate(floor)).includes('historical_schema_floor_mismatch'));
  const unknown = { name: 'v2_20261005T000000003Z_0000000000000009_unknown.sql', sha256: 'ab'.repeat(32) };
  assert.deepEqual(codes(evaluate(v3Fixture(catalog.ab, [...legacy, unknown]))), ['schema_ledger_mismatch']);
  const changed = v3Fixture(catalog.ab, [...legacy, { ...alpha, sha256: 'cd'.repeat(32) }]);
  assert.deepEqual(codes(evaluate(changed)), ['schema_ledger_mismatch']);
  const renamed = v3Fixture(catalog.ab, [...legacy, { name: NODE_A.replace('alpha', 'renamed'), sha256: alpha.sha256 }]);
  assert.deepEqual(codes(evaluate(renamed)), ['schema_identity_mismatch']);
});

test('v3 rejects a legacy frontier mismatch and a partial legacy set beside a v2 row', () => {
  const catalog = catalogs(), legacy = legacyOf(catalog.ab), alpha = rowNamed(catalog.ab, NODE_A);
  const frontier = v3Fixture(catalog.ab, legacy);
  frontier.host.migration_profile.legacy_ledger[0].sha256 = 'ef'.repeat(32);
  assert.deepEqual(codes(evaluate(frontier)), ['schema_legacy_frontier_mismatch']);
  const partialLegacy = legacy.filter((row) => !row.name.startsWith('050_'));
  assert.equal(partialLegacy.length, legacy.length - 1);
  assert(codes(evaluate(v3Fixture(catalog.ab, [...partialLegacy, alpha]))).includes('schema_ledger_invalid'));
});

test('v3 rejects a malformed or unrequested host profile and candidate-supplied profile selection', () => {
  const catalog = catalogs(), legacy = legacyOf(catalog.ab);
  const unsupported = v3Fixture(catalog.ab, legacy);
  unsupported.host.migration_profile.format = 'freedom.migrations/dag-v9';
  assert.deepEqual(codes(evaluate(unsupported)), ['migration_profile_unsupported']);
  const malformed = v3Fixture(catalog.ab, legacy);
  malformed.host.migration_profile.legacy_ledger = [];
  assert.deepEqual(codes(evaluate(malformed)), ['migration_profile_invalid']);
  const unknownHost = fixture();
  unknownHost.host.schema = 'freedom.release-compatibility-host/v4';
  assert.deepEqual(codes(evaluate(unknownHost)), ['host_version_unsupported']);
  const supplied = v3Fixture(catalog.ab, legacy);
  supplied.input.migration_profile = supplied.host.migration_profile;
  assert.deepEqual(codes(evaluate(supplied)), ['request_invalid']);
  const v2Extra = fixture();
  v2Extra.host.migration_profile = structuredClone(catalog.profile);
  assert.deepEqual(codes(evaluate(v2Extra)), ['host_evidence_invalid']);
  const stripped = v3Fixture(catalog.ab, legacy);
  stripped.scan = { ...catalog.ab };
  delete stripped.scan.dependencies;
  assert.deepEqual(codes(evaluate(stripped)), ['schema_scan_failed']);
});

test('exact-name v2 shapes require the planned filename and digest; numeric shapes stay on the legacy number', () => {
  const catalog = catalogs();
  assert.equal(catalog.shape.ok, true, JSON.stringify(catalog.shape.problems));
  const shape = rowNamed(catalog.shape, INTERNAL_V2_SHAPE.migration_name);
  const digests = new Map(catalog.shape.ledger.map((row) => [row.name, row.sha256]));
  assert.equal(migrationShapeSatisfied(INTERNAL_V2_SHAPE, catalog.shape.ledger, 118, digests), true);
  assert.equal(migrationShapeSatisfied(INTERNAL_V2_SHAPE, catalog.shape.ledger.filter((row) => row.name !== shape.name), 118, digests), false);
  assert.equal(migrationShapeSatisfied(INTERNAL_V2_SHAPE, catalog.shape.ledger.map((row) => row.name === shape.name ? { ...row, sha256: 'aa'.repeat(32) } : row), 118, digests), false);
  assert.equal(migrationShapeSatisfied(INTERNAL_V2_SHAPE, catalog.shape.ledger.map((row) => row.name === shape.name ? { ...row, name: shape.name.replace('shape', 'other') } : row), 118, digests), false);
  assert.equal(migrationShapeSatisfied({ migration: 118 }, catalog.shape.ledger, 118, digests), true);
  assert.equal(migrationShapeSatisfied({ migration: 118 }, catalog.shape.ledger, 117, digests), false);
  const legacy = legacyOf(catalog.ab), alpha = rowNamed(catalog.ab, NODE_A);
  const enabled = v3Fixture(catalog.ab, [...legacy, alpha]);
  enabled.input.enable_shapes = ['commerce.shop-service-authority.v1'];
  enabled.host.release_records[0].capabilities.push('commerce.shop-service-authority.v1');
  assert.equal(evaluate(enabled).status, 'compatible', JSON.stringify(evaluate(enabled)));
  const older = v3Fixture(catalog.ab, prefix(catalog.ab, 117).ledger, prefix(catalog.legacyScan, 75).ledger);
  older.host.observation.written_shapes = ['commerce.shop-service-authority.v1'];
  older.host.release_records[0].capabilities.push('commerce.shop-service-authority.v1');
  const numeric = evaluate(older);
  assert(codes(numeric).includes('observed_shape_schema_missing'));
  assert(!codes(numeric).includes('shape_schema_missing'));
  enabled.input.enable_shapes = [INTERNAL_V2_SHAPE.shape];
  assert.deepEqual(codes(evaluate(enabled)), ['request_invalid']);
  const injected = v3Fixture(catalog.ab, [...legacy, alpha]);
  injected.host.observation.written_shapes = [INTERNAL_V2_SHAPE.shape];
  assert.deepEqual(codes(evaluate(injected)), ['host_evidence_invalid']);
});

for (const [name, mutate, code] of [
  ['withdrawn', (f) => { f.host.release_records[0].status = 'withdrawn'; }, 'release_withdrawn'],
  ['stale approval', (f) => { f.host.release_records[0].expires_at_ms = NOW; }, 'release_approval_stale'],
  ['wrong environment', (f) => { f.host.release_records[0].environments = ['staging-next']; }, 'release_environment_mismatch'],
  ['missing capability', (f) => { f.host.release_records[0].capabilities = f.host.release_records[0].capabilities.filter((item) => item !== 'work.explicit-wire.v1'); }, 'release_capability_missing'],
]) {
  test(`v3 release record still fails closed: ${name}`, () => {
    const catalog = catalogs(), legacy = legacyOf(catalog.ab);
    const f = v3Fixture(catalog.ab, [...legacy, rowNamed(catalog.ab, NODE_A)]);
    mutate(f);
    const result = evaluate(f);
    assert.notEqual(result.status, 'compatible');
    assert(codes(result).includes(code), JSON.stringify(result));
    for (const flag of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[flag], false);
  });
}

for (const target of ['planned', 'observation', 'floor']) {
  test(`v2 host rejects a v2_ ledger row in ${target}`, () => {
    const f = fixture();
    const row = { name: NODE_A, sha256: 'ab'.repeat(32) };
    if (target === 'planned') {
      f.scan.ledger = [...f.scan.ledger, row];
      f.scan.ledger_digest = compatibilityLedgerDigest(f.scan.ledger);
    } else if (target === 'observation') {
      f.host.observation.schema_ledger = [...f.host.observation.schema_ledger, row];
      f.host.observation.schema_ledger_digest = compatibilityLedgerDigest(f.host.observation.schema_ledger);
    } else {
      f.host.rollback_floor.schema_ledger = [...f.host.rollback_floor.schema_ledger, row];
      f.host.rollback_floor.schema_ledger_digest = compatibilityLedgerDigest(f.host.rollback_floor.schema_ledger);
    }
    const result = evaluate(f);
    assert.notEqual(result.status, 'compatible');
    assert.deepEqual(codes(result), [target === 'planned' ? 'request_invalid' : 'host_evidence_invalid']);
    for (const flag of ['deployment_authority', 'execution_authority', 'restore_proof']) assert.equal(result[flag], false);
  });
}
