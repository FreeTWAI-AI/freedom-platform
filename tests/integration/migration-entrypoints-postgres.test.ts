// Importing the owned fixture also executes its legacy/DAG baseline cases.
import { isolated } from './migration-plan-postgres.test.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
const { createMigrationFixture, installedOptions, fixtureRoot, A, B, C } = await import(new URL('../../deploy/cloudflare/test/migration-fixtures.mjs',import.meta.url).href);

function entry(kind: 'repository'|'operator', record: any, host: string, connectionString: string, target: any) {
  const options=installedOptions(record,target), flags=['--installation',options.installationDirectory,'--expected-installation',options.expectedInstallationDigest,
    '--expected-source',options.expectedSourceCommit,'--expected-profile',options.expectedProfileDigest,'--database',target.database,'--role',target.role,'--schema',target.schema];
  let executable=join(fixtureRoot,'scripts/migrate-installed.mjs'), args=flags, before='';
  if(kind==='operator') {
    executable=join(host,'operator-'+randomUUID()+'.mjs'); args=[];
    const code=`import pg from ${JSON.stringify(pathToFileURL(join(fixtureRoot,'node_modules/pg/lib/index.js')).href)}; const {Pool}=pg;\n`
      +`import {runInstalledMigrations} from ${JSON.stringify(pathToFileURL(join(fixtureRoot,'deploy/cloudflare/migration-operator.mjs')).href)};\n`
      +`const options=${JSON.stringify(options)}; const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000,statement_timeout:30000});\n`
      +`try { console.log(JSON.stringify({...await runInstalledMigrations(pool,options),entrypoint:'external-operator-wrapper'})); }\n`
      +`catch(error) { console.error(JSON.stringify({code:/^migration_[a-z0-9_]+$/.test(error.code??'')?error.code:'migration_entry_unavailable'}));process.exitCode=1; } finally {await pool.end();}\n`;
    writeFileSync(executable,code,{mode:0o400,flag:'wx'});before=createHash('sha256').update(code).digest('hex');
  }
  const output=execFileSync(process.execPath,[executable,...args],{cwd:host,timeout:30000,encoding:'utf8',maxBuffer:1048576,
    env:{PATH:'/usr/bin:/bin',NODE_ENV:'test',DATABASE_URL:connectionString},stdio:['ignore','pipe','pipe']});
  if(before)assert.equal(createHash('sha256').update(readFileSync(executable)).digest('hex'),before);
  const result=JSON.parse(output);assert.equal(result.deployment_authorized,false);assert.equal(result.source_commit,record.source_commit);
  assert.equal(result.installation_digest,record.installation_digest);assert.equal(result.profile_digest,record.profile_digest);
  return {...result,wrapper_digest:before||null};
}
function rejectsEntry(run:()=>unknown,code:string) {
  assert.throws(run,(error:any)=>{
    try {return error.status===1&&JSON.parse(error.stderr).code===code;}catch{return false;}
  });
}
async function facts(pool:Pool) {
  const tables=['base','tail','alpha','beta','child'],data:Record<string,unknown>={};
  for(const table of tables)data[table]=(await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
  return {data,ledger:(await pool.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows,
    shape:(await pool.query("SELECT c.relname,con.contype,pg_get_constraintdef(con.oid) def FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname<>'schema_migrations' ORDER BY c.relname,con.contype,def")).rows};
}
test('both real entries replay Git A→B / B→A / empty catalogs to identical SQL facts without legacy watermark skips', {timeout:180000},async t=>{
  const f=createMigrationFixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}));const observed:unknown[]=[],receipts:any[]=[];
  for(const kind of ['repository','operator'] as const)for(const direction of ['ab','ba','empty'] as const)await isolated(async(pool,url,target)=>{
    if(direction!=='empty')entry(kind,direction==='ab'?f.a:f.b,f.host,url,target);
    const final=direction==='ba'?f.ba:f.ab,result=entry(kind,final,f.host,url,target);
    assert.deepEqual(result.applied,direction==='ab'?[B,C]:direction==='ba'?[A,C]:['001_base.sql','003_tail.sql',A,B,C]);
    assert.deepEqual(entry(kind,final,f.host,url,target).applied,[]); observed.push(await facts(pool));
    receipts.push({entrypoint:result.entrypoint,direction,source:result.source_commit,installation:result.installation_digest,profile:result.profile_digest,wrapper:result.wrapper_digest,ledger:result.ledger_digest});
  });
  for(const value of observed)assert.deepEqual(value,observed[0]);
  console.log(JSON.stringify({evidence:'two-real-local-migration-entrypoints',receipts,production_pipeline_updated:false}));
});
test('actual CLI refuses wrong target, corrupted/unknown restored ledger and mismatched host pins without new SQL effects', {timeout:60000},async t=>{
  const f=createMigrationFixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}));
  await isolated(async(pool,url,target)=>{
    rejectsEntry(()=>entry('repository',f.ab,f.host,url,{...target,schema:'fp_foreign'}),'migration_target_mismatch');
    assert.equal((await pool.query("SELECT to_regclass('base') found")).rows[0].found,null);
    entry('repository',f.ab,f.host,url,target);const baseline=await facts(pool);
    await pool.query("INSERT INTO schema_migrations(name,sha256) VALUES('999_unknown.sql',repeat('f',64))");
    rejectsEntry(()=>entry('operator',f.ab,f.host,url,target),'migration_applied_unknown');await pool.query("DELETE FROM schema_migrations WHERE name='999_unknown.sql'");
    await pool.query('UPDATE schema_migrations SET sha256=repeat(\'f\',64) WHERE name=$1',[A]);
    rejectsEntry(()=>entry('repository',f.ab,f.host,url,target),'migration_applied_digest_mismatch');
    const original=(baseline.ledger as any[]).find(e=>e.name===A);await pool.query('UPDATE schema_migrations SET sha256=$2 WHERE name=$1',[A,original.sha256]);
    rejectsEntry(()=>entry('repository',{...f.ab,installation_digest:'f'.repeat(64)},f.host,url,target),'migration_installation_pin_mismatch');
    assert.deepEqual(await facts(pool),baseline);
  });
});

test('host source pins and target are captured before the installed runner import yields', {timeout:60000},async t=>{
  const f=createMigrationFixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}));
  const { runInstalledMigrations } = await import(new URL('../../deploy/cloudflare/migration-operator.mjs',import.meta.url).href);
  await isolated(async(pool,_url,target)=>{
    const callerTarget={...target},options=installedOptions(f.ab,callerTarget);
    // The async call validates and starts its fresh module import synchronously.
    // This mutation runs before that import continuation and before pool.connect.
    const pending=runInstalledMigrations(pool,options);
    callerTarget.schema='fp_foreign';callerTarget.database='fp_other';
    options.target={database:'fp_replaced',role:'other',schema:'fp_replaced'};
    options.expectedInstallationDigest='f'.repeat(64);options.expectedSourceCommit='f'.repeat(40);
    options.expectedProfileDigest='f'.repeat(64);options.installationDirectory='/not-the-admitted-installation';
    const result=await pending;
    assert.equal(result.source_commit,f.ab.source_commit);assert.equal(result.installation_digest,f.ab.installation_digest);
    assert.equal(result.profile_digest,f.ab.profile_digest);assert.deepEqual(result.applied,['001_base.sql','003_tail.sql',A,B,C]);
    assert.deepEqual((await facts(pool)).data.child,[{a:1,b:1}]);
  });
});
