import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';
import { run } from '../preflight.mjs';

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
