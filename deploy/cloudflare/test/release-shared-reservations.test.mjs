import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {checkMigrations} from '../lib/migrations.mjs';
import {loadManifest} from '../lib/manifest.mjs';
import {evaluateReleaseCompatibility,compatibilityLedgerDigest} from '../lib/release-compatibility.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const shape='commerce.hosted-shared-reservation.v1';
function fixture() {
 const scan=checkMigrations(root+'migrations',loadManifest().database_defaults.migrations);assert.equal(scan.ok,true);
 const candidate={source_sha:'a'.repeat(40),artifact_sha256:'b'.repeat(64)},active={source_sha:'c'.repeat(40),artifact_sha256:'d'.repeat(64)};
 const target={environment:'staging-next',database_identity:'synthetic-shared-stock',recovery_generation:'2'};
 return {scan,input:{schema:'freedom.release-compatibility-request/v1',environment:'staging-next',candidate,enable_shapes:[]},
  host:{schema:'freedom.release-compatibility-host/v2',target,now_ms:10000,max_age_ms:100,rollback_floor_shapes:[],
   rollback_floor:{evidence_id:'synthetic-shared-floor',target,schema_ledger:scan.ledger,schema_ledger_digest:scan.ledger_digest,capabilities:[]},
   observation:{evidence_id:'synthetic-shared-observation',target,observed_at_ms:9999,schema_ledger:scan.ledger,schema_ledger_digest:scan.ledger_digest,
    enabled_shapes:[],written_shapes:[],active_releases:[active],complete:true},
   release_records:[active,candidate].map(identity=>({...identity,evidence_id:'synthetic-shared-approval',status:'approved',environments:['staging-next'],
    schema_ledger_digests:[scan.ledger_digest],capabilities:['commerce.hosted-checkout.v1','commerce.hosted-inventory-reservation.v1','commerce.hosted-payment.v1','commerce.hosted-supply-catalog.v1','opensource.sharing-visibility.v1','platform.legacy.v1','work.explicit-wire.v1',shape],approved_at_ms:9000,expires_at_ms:11000}))}};
}
function run(f){const r=evaluateReleaseCompatibility(f.input,{scan:f.scan,host:f.host});
 for(const field of ['deployment_authority','restore_proof','execution_authority'])assert.equal(r[field],false);return r;}
function lower(f,planned=true,last=160){
 const ledger=f.scan.ledger.filter(row=>Number(row.name.slice(0,3))<=last),digest=compatibilityLedgerDigest(ledger);
 if(planned)f.scan={...f.scan,ledger,ledger_digest:digest};
 for(const part of [f.host.observation,f.host.rollback_floor]){part.schema_ledger=ledger;part.schema_ledger_digest=digest;}
 for(const record of f.host.release_records)record.schema_ledger_digests.push(digest);
}
test('schema 161 alone enables nothing and preserves disabled old-reader compatibility',()=>{
 const f=fixture();lower(f,true,161);
 for(const r of f.host.release_records)r.capabilities=['platform.legacy.v1','work.explicit-wire.v1'];
 const result=run(f);assert.equal(result.status,'compatible');assert.deepEqual(result.required_shapes,[]);
 assert.deepEqual(result.required_capabilities,['platform.legacy.v1','work.explicit-wire.v1']);
});
for(const source of ['enable_shapes','enabled_shapes','written_shapes','rollback_floor_shapes'])test(`shared reservation ${source} requires every reader and exact schema`,()=>{
 const f=fixture();(source==='enable_shapes'?f.input:source==='rollback_floor_shapes'?f.host:f.host.observation)[source]=[shape];
 assert.equal(run(f).status,'compatible');
 for(const index of [0,1]){const bad=structuredClone(f);bad.host.release_records[index].capabilities.pop();
  assert(run(bad).issues.some(i=>i.code==='release_capability_missing'&&i.capability===shape&&i.source_sha===bad.host.release_records[index].source_sha));}
 const old=structuredClone(f);lower(old,source==='enable_shapes');
 const code=source==='enable_shapes'?'shape_schema_missing':source==='rollback_floor_shapes'?'historical_shape_schema_missing':'observed_shape_schema_missing';
 assert(run(old).issues.some(i=>i.code===code));
});
test('disabling admission or restoring schema 160 cannot drop a retained shared-reader floor',()=>{
 const f=fixture();f.host.rollback_floor.capabilities=[shape];f.host.release_records[0].capabilities.pop();
 assert(run(f).issues.some(i=>i.code==='release_capability_missing'&&i.capability===shape));
 lower(f,false);assert(run(f).issues.some(i=>i.code==='historical_shape_schema_missing'));
 const tampered=fixture();tampered.host.observation.schema_ledger=structuredClone(tampered.scan.ledger);
 tampered.host.observation.schema_ledger.at(-1).sha256='e'.repeat(64);
 tampered.host.observation.schema_ledger_digest=compatibilityLedgerDigest(tampered.host.observation.schema_ledger);
 assert.equal(run(tampered).status,'unavailable');
});

const inventory='commerce.hosted-inventory-reservation.v1';
for(const version of ['v2','v3'])test(`schema162 ${version} fences every hosted writer before enabling any shape`,()=>{
 const f=fixture();
 if(version==='v3'){
  f.host.schema='freedom.release-compatibility-host/v3';
  const {first,last,known_gaps}=loadManifest().database_defaults.migrations;
  f.host.migration_profile={format:'freedom.migrations/dag-v2',
   legacy:{format:'freedom.migrations/legacy-v1',first,last,known_gaps},legacy_ledger:f.scan.ledger};
 }
 const before=structuredClone(f);const result=run(f);
 assert.equal(result.status,'compatible');assert.deepEqual(result.required_shapes,[]);
 assert(result.required_capabilities.includes(inventory));assert.deepEqual(f,before);
 for(const index of [0,1]){
  const old=structuredClone(f);old.host.release_records[index].capabilities=old.host.release_records[index].capabilities.filter(c=>c!==inventory);
  assert(run(old).issues.some(i=>i.code==='release_capability_missing'&&i.capability===inventory&&i.source_sha===old.host.release_records[index].source_sha));
 }
});
for(const source of ['enable_shapes','enabled_shapes','written_shapes','rollback_floor_shapes'])test(`durable inventory ${source} retains the exact162 floor`,()=>{
 const f=fixture();(source==='enable_shapes'?f.input:source==='rollback_floor_shapes'?f.host:f.host.observation)[source]=[inventory];
 assert.equal(run(f).status,'compatible');
 const old=structuredClone(f);lower(old,source==='enable_shapes',161);
 const code=source==='enable_shapes'?'shape_schema_missing':source==='rollback_floor_shapes'?'historical_shape_schema_missing':'observed_shape_schema_missing';
 assert(run(old).issues.some(i=>i.code===code&&i.shape===inventory));
});
test('capability-only inventory history cannot be erased by restoring161 or disabling admission',()=>{
 const f=fixture();f.host.rollback_floor.capabilities=[inventory];lower(f,true,161);
 const result=run(f);assert(result.issues.some(i=>i.code==='shape_schema_missing'&&i.shape===inventory));
 assert(result.issues.some(i=>i.code==='historical_shape_schema_missing'&&i.shape===inventory));
 assert.deepEqual(result.required_shapes,[]);
 const retained=fixture();lower(retained,true,161);
 const current=fixture();retained.host.rollback_floor=current.host.rollback_floor;
 retained.host.release_records[0].capabilities=retained.host.release_records[0].capabilities.filter(c=>c!==inventory);
 assert(run(retained).issues.some(i=>i.code==='release_capability_missing'&&i.capability===inventory));
});

const supplyCatalog='commerce.hosted-supply-catalog.v1';
test('schema164 fences every supply catalog reader/writer without activating any shape',()=>{
 const f=fixture(),before=structuredClone(f),result=run(f);
 assert.equal(result.status,'compatible');assert.deepEqual(result.required_shapes,[]);
 assert(result.required_capabilities.includes(supplyCatalog));assert.deepEqual(f,before);
 for(const index of [0,1]){
  const old=structuredClone(f);old.host.release_records[index].capabilities=old.host.release_records[index].capabilities.filter(c=>c!==supplyCatalog);
  assert(run(old).issues.some(i=>i.code==='release_capability_missing'&&i.capability===supplyCatalog&&i.source_sha===old.host.release_records[index].source_sha));
 }
});
for(const source of ['enable_shapes','enabled_shapes','written_shapes','rollback_floor_shapes'])test(`supply catalog ${source} retains the exact164 floor`,()=>{
 const f=fixture();(source==='enable_shapes'?f.input:source==='rollback_floor_shapes'?f.host:f.host.observation)[source]=[supplyCatalog];
 assert.equal(run(f).status,'compatible');
 const old=structuredClone(f);lower(old,source==='enable_shapes',163);
 const code=source==='enable_shapes'?'shape_schema_missing':source==='rollback_floor_shapes'?'historical_shape_schema_missing':'observed_shape_schema_missing';
 assert(run(old).issues.some(i=>i.code===code&&i.shape===supplyCatalog));
});
test('restoring163 cannot erase retained supply catalog capability history',()=>{
 const f=fixture();f.host.rollback_floor.capabilities=[supplyCatalog];lower(f,true,163);
 const result=run(f);assert(result.issues.some(i=>i.code==='shape_schema_missing'&&i.shape===supplyCatalog));
 assert(result.issues.some(i=>i.code==='historical_shape_schema_missing'&&i.shape===supplyCatalog));
 assert.deepEqual(result.required_shapes,[]);
});

const sharingVisibility='opensource.sharing-visibility.v1';
for(const version of ['v2','v3'])test(`schema165 fences withdrawn-work readers and publishers with host ${version}`,()=>{
 const f=fixture();
 if(version==='v3'){
  f.host.schema='freedom.release-compatibility-host/v3';
  const {first,last,known_gaps}=loadManifest().database_defaults.migrations;
  f.host.migration_profile={format:'freedom.migrations/dag-v2',legacy:{format:'freedom.migrations/legacy-v1',first,last,known_gaps},legacy_ledger:f.scan.ledger};
 }
 const before=structuredClone(f),result=run(f);
 assert.equal(result.status,'compatible');assert.deepEqual(result.required_shapes,[]);
 assert(result.required_capabilities.includes(sharingVisibility));assert.deepEqual(f,before);
 for(const index of [0,1]){
  const old=structuredClone(f);old.host.release_records[index].capabilities=old.host.release_records[index].capabilities.filter(c=>c!==sharingVisibility);
  assert(run(old).issues.some(i=>i.code==='release_capability_missing'&&i.capability===sharingVisibility&&i.source_sha===old.host.release_records[index].source_sha));
 }
});
for(const source of ['enable_shapes','enabled_shapes','written_shapes','rollback_floor_shapes'])test(`sharing visibility ${source} requires exact schema165 support`,()=>{
 const f=fixture();(source==='enable_shapes'?f.input:source==='rollback_floor_shapes'?f.host:f.host.observation)[source]=[sharingVisibility];
 assert.equal(run(f).status,'compatible');
 const old=structuredClone(f);lower(old,source==='enable_shapes',164);
 const code=source==='enable_shapes'?'shape_schema_missing':source==='rollback_floor_shapes'?'historical_shape_schema_missing':'observed_shape_schema_missing';
 assert(run(old).issues.some(i=>i.code===code&&i.shape===sharingVisibility));
});
test('restoring164 cannot erase retained withdrawal capability history or grant deployment authority',()=>{
 const f=fixture();f.host.rollback_floor.capabilities=[sharingVisibility];lower(f,true,164);
 const result=run(f);assert(result.issues.some(i=>i.code==='shape_schema_missing'&&i.shape===sharingVisibility));
 assert(result.issues.some(i=>i.code==='historical_shape_schema_missing'&&i.shape===sharingVisibility));
 assert.deepEqual(result.required_shapes,[]);
});
