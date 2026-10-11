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
    schema_ledger_digests:[scan.ledger_digest],capabilities:['platform.legacy.v1','work.explicit-wire.v1',shape],approved_at_ms:9000,expires_at_ms:11000}))}};
}
function run(f){const r=evaluateReleaseCompatibility(f.input,{scan:f.scan,host:f.host});
 for(const field of ['deployment_authority','restore_proof','execution_authority'])assert.equal(r[field],false);return r;}
function lower(f,planned=true){
 const ledger=f.scan.ledger.filter(row=>Number(row.name.slice(0,3))<=160),digest=compatibilityLedgerDigest(ledger);
 if(planned)f.scan={...f.scan,ledger,ledger_digest:digest};
 for(const part of [f.host.observation,f.host.rollback_floor]){part.schema_ledger=ledger;part.schema_ledger_digest=digest;}
 for(const record of f.host.release_records)record.schema_ledger_digests.push(digest);
}
test('schema 161 alone enables nothing and preserves disabled old-reader compatibility',()=>{
 const f=fixture();for(const r of f.host.release_records)r.capabilities.pop();
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
