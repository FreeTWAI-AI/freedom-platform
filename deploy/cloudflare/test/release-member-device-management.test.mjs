import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkMigrations } from '../lib/migrations.mjs';
import { loadManifest } from '../lib/manifest.mjs';
import { evaluateReleaseCompatibility, compatibilityLedgerDigest } from '../lib/release-compatibility.mjs';

const root = fileURLToPath(new URL('../../../',import.meta.url));
const shape = 'execution.member-device-management.v1';
const prerequisites = ['execution.runtime-enrollment.v1','execution.agent-connection-record.v1','execution.bootstrap-status.v1',
  'execution.device-authorization.v1','execution.bootstrap-session.v1'];
const unrelated = ['execution.model-credential-custody.v1','execution.member-prerequisites.v1','execution.member-run-record.v1',
  'work.personal-owner-acl.v1','work.server-policy.v1','execution.model-credential-ingest.v1','execution.model-broker-bridge.v1',
  'execution.model-text-step.v1','work.private-model-result.v1'];
function fixture() {
  const scan = checkMigrations(`${root}migrations`,loadManifest().database_defaults.migrations);assert.equal(scan.ok,true);
  const candidate = {source_sha:'a'.repeat(40),artifact_sha256:'b'.repeat(64)},active = {source_sha:'c'.repeat(40),artifact_sha256:'d'.repeat(64)};
  const target = {environment:'next',database_identity:'synthetic-member-device-management',recovery_generation:'2'};
  const host = {schema:'freedom.release-compatibility-host/v2',target,now_ms:10000,max_age_ms:100,rollback_floor_shapes:[],
    rollback_floor:{evidence_id:'synthetic-device-history',target,schema_ledger:scan.ledger,schema_ledger_digest:scan.ledger_digest,capabilities:[]},
    observation:{evidence_id:'synthetic-device-observation',observed_at_ms:9999,target,schema_ledger:scan.ledger,schema_ledger_digest:scan.ledger_digest,
      enabled_shapes:[],written_shapes:[],active_releases:[active],complete:true},
    release_records:[active,candidate].map(identity=>({...identity,evidence_id:'synthetic-device-approval',status:'approved',environments:['next'],
      schema_ledger_digests:[scan.ledger_digest],capabilities:['platform.legacy.v1','work.explicit-wire.v1',shape,...prerequisites],approved_at_ms:9000,expires_at_ms:11000}))};
  return {input:{schema:'freedom.release-compatibility-request/v1',environment:'next',candidate,enable_shapes:[]},scan,host};
}
function run(f) {
  const result = evaluateReleaseCompatibility(f.input,{scan:f.scan,host:f.host});
  for (const field of ['deployment_authority','execution_authority','restore_proof']) assert.equal(result[field],false);
  return result;
}
function prefix(f,last) {
  const ledger = f.scan.ledger.filter(row=>Number(row.name.slice(0,3))<=last);
  assert.equal(Number(ledger.at(-1).name.slice(0,3)),last);
  return {ledger,digest:compatibilityLedgerDigest(ledger)};
}
function useLedger(f,view,{planned=true}={}) {
  if (planned) f.scan = {...f.scan,ledger:view.ledger,ledger_digest:view.digest};
  for (const part of [f.host.observation,f.host.rollback_floor]) {part.schema_ledger=view.ledger;part.schema_ledger_digest=view.digest;}
  for (const record of f.host.release_records) record.schema_ledger_digests.push(view.digest);
}

test('device management schema presence alone preserves legacy releases when the member port is unavailable',()=>{
  const f=fixture();for (const record of f.host.release_records) record.capabilities.splice(2);
  const result=run(f);assert.equal(result.status,'compatible');
  assert.deepEqual(result.required_capabilities,['platform.legacy.v1','work.explicit-wire.v1']);
  assert.deepEqual(result.required_shapes,[]);
});

for (const source of ['enable_shapes','enabled_shapes','written_shapes','rollback_floor_shapes']) for (const binary of [0,1]) {
  test(`device management ${source} denies missing installed member port/prerequisite support from active or candidate binary ${binary}`,()=>{
    const f=fixture();
    (source==='enable_shapes'?f.input:source==='rollback_floor_shapes'?f.host:f.host.observation)[source]=[shape];
    const result=run(f);assert.equal(result.status,'compatible');
    for (const capability of [shape,...prerequisites]) {
      const changed=structuredClone(f),record=changed.host.release_records[binary];
      record.capabilities=record.capabilities.filter(c=>c!==capability);
      assert(run(changed).issues.some(i=>i.code==='release_capability_missing'&&i.capability===capability&&i.source_sha===record.source_sha));
    }
    for (const capability of unrelated) assert(!result.required_capabilities.includes(capability));
  });
}

test('device management capability-only history retains device/session closure without inventing written shapes or ingestion',()=>{
  const f=fixture();f.host.rollback_floor.capabilities=[shape];
  const result=run(f);assert.equal(result.status,'compatible');assert.deepEqual(result.required_shapes,[]);
  assert.deepEqual(result.required_capabilities,['platform.legacy.v1','work.explicit-wire.v1',shape,...prerequisites].sort());
  for (const capability of prerequisites) for (const binary of [0,1]) {
    const changed=structuredClone(f);changed.host.release_records[binary].capabilities=changed.host.release_records[binary].capabilities.filter(c=>c!==capability);
    assert(run(changed).issues.some(i=>i.capability===capability&&i.source_sha===changed.host.release_records[binary].source_sha));
  }
});

test('actual scanner ledger through091 suffices for installed member device management without092 or later',()=>{
  const f=fixture(),through091=prefix(f,91);useLedger(f,through091);
  f.input.enable_shapes=[shape];f.host.observation.enabled_shapes=[shape];f.host.rollback_floor_shapes=[shape];
  const result=run(f);assert.equal(result.status,'compatible');
  assert.equal(f.scan.ledger.some(row=>/^09[2-7]_/.test(row.name)),false);
  for (const capability of unrelated) assert(!result.required_capabilities.includes(capability));
});

test('device management cannot replace missing091 with binary capability claims',()=>{
  const f=fixture(),through090=prefix(f,90);useLedger(f,through090);f.input.enable_shapes=[shape];
  assert(run(f).issues.some(i=>i.code==='shape_schema_missing'&&i.shape===shape));
  f.host.observation.enabled_shapes=[shape];
  assert(run(f).issues.some(i=>i.code==='observed_shape_schema_missing'&&i.shape===shape));
});

test('retained device management history requires observed091 despite a future planned ledger',()=>{
  const f=fixture(),through090=prefix(f,90);useLedger(f,through090,{planned:false});f.host.rollback_floor_shapes=[shape];
  assert(run(f).issues.some(i=>i.code==='historical_shape_schema_missing'&&i.shape===shape));
});

test('capability-only device history on090 requires both planned and current091 without inventing written shapes',()=>{
  const f=fixture();useLedger(f,prefix(f,90));f.host.rollback_floor.capabilities=[shape];
  const result=run(f);assert.equal(result.status,'incompatible');assert.deepEqual(result.required_shapes,[]);
  assert(result.issues.some(i=>i.code==='shape_schema_missing'&&i.shape===shape));
  assert(result.issues.some(i=>i.code==='historical_shape_schema_missing'&&i.shape===shape));
  const repaired=fixture();useLedger(repaired,prefix(repaired,90),{planned:false});repaired.host.rollback_floor.capabilities=[shape];
  assert(run(repaired).issues.some(i=>i.code==='historical_shape_schema_missing'&&i.shape===shape));
});

test('retained connection support alone does not invent installed member port or execution',()=>{
  const f=fixture();f.host.rollback_floor.capabilities=['execution.agent-connection-record.v1'];
  for(const record of f.host.release_records)record.capabilities=record.capabilities.filter(c=>c!==shape);
  const result=run(f);assert.equal(result.status,'compatible');assert(!result.required_capabilities.includes(shape));
  assert(result.required_capabilities.includes('execution.runtime-enrollment.v1'));
  for(const capability of unrelated)assert(!result.required_capabilities.includes(capability));
});

test('unknown device capability cannot claim approval or mutate trusted registry',()=>{
  for(const target of ['request','approval','floor']) {
    const f=fixture(),unknown='execution.member-device-management.v2';
    if(target==='request')f.input.enable_shapes=[unknown];
    if(target==='approval')f.host.release_records[0].capabilities.push(unknown);
    if(target==='floor')f.host.rollback_floor.capabilities=[unknown];
    assert.equal(run(f).status,'unavailable');
  }
});

test('device capability cannot replace exact approved ledger digest or SQL prefix',()=>{
  const f=fixture();f.input.enable_shapes=[shape];f.host.release_records[0].schema_ledger_digests=['e'.repeat(64)];
  assert(run(f).issues.some(i=>i.code==='release_schema_unsupported'&&i.source_sha===f.host.release_records[0].source_sha));
  const changed=fixture();changed.input.enable_shapes=[shape];changed.host.observation.schema_ledger=structuredClone(changed.host.observation.schema_ledger);
  changed.host.observation.schema_ledger.at(-1).sha256='f'.repeat(64);
  changed.host.observation.schema_ledger_digest=compatibilityLedgerDigest(changed.host.observation.schema_ledger);
  assert.equal(run(changed).status,'unavailable');assert.equal(run(changed).issues[0].code,'schema_ledger_mismatch');
});
