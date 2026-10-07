import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareMigrationInstallation, runInstalledMigrations, installedMigrationArguments } from '../migration-operator.mjs';
import { createMigrationFixture, installedOptions, dagProfile, git, A } from './migration-fixtures.mjs';
const target={database:'fp_fixture',role:'postgres',schema:'fp_case'};
function setup(t) {const f=createMigrationFixture();t.after(()=>rmSync(f.root,{recursive:true,force:true}));return f;}
test('real Git reverse merges produce equal schema plans with distinct independently pinned sources',t=>{
  const f=setup(t);assert.notEqual(f.ab.source_commit,f.ba.source_commit);assert.equal(f.ab.source_tree,f.ba.source_tree);
  assert.equal(f.ab.plan_digest,f.ba.plan_digest);assert.equal(f.ab.ledger_digest,f.ba.ledger_digest);
  assert.notEqual(f.ab.installation_digest,f.ba.installation_digest);assert.equal(f.ab.trust,'host_pin_required');
});
test('self-authored installation/profile/source claims cannot replace independent host pins',async t=>{
  const f=setup(t);let connected=0;const pool={connect:()=>{connected++;throw Error('must not connect');}};
  const options=installedOptions(f.ba,target);
  for(const patch of [{expectedInstallationDigest:undefined},{expectedInstallationDigest:'f'.repeat(64)},{expectedSourceCommit:'f'.repeat(40)},{expectedProfileDigest:'f'.repeat(64)},{target:undefined}]) {
    await assert.rejects(runInstalledMigrations(pool,{...options,...patch}));
  }
  await assert.rejects(runInstalledMigrations(pool,{...options,target:{...target,database:'freedom_public'}}),{code:'migration_v2_target_not_activated'});
  const path=join(f.ba.installation_directory,'installation.json');chmodSync(path,0o600);const v=JSON.parse(readFileSync(path));v.profile.legacy_ledger.pop();writeFileSync(path,JSON.stringify(v));
  await assert.rejects(runInstalledMigrations(pool,options),{code:'migration_installation_pin_mismatch'});assert.equal(connected,0);
});
test('changed core bytes, linked install paths and surplus preload/package files are rejected before pool access',async t=>{
  const f=setup(t),pool={connect:()=>{throw Error('unexpected connection');}};
  const path=join(f.ab.installation_directory,'packages/db/migration-runner.mjs'),original=readFileSync(path);
  chmodSync(path,0o600);writeFileSync(path,Buffer.concat([original,Buffer.from('\n// drift\n')]));
  await assert.rejects(runInstalledMigrations(pool,installedOptions(f.ab,target)),{code:'migration_installation_file_invalid'});
  writeFileSync(path,Buffer.concat([Buffer.from('#'),original.subarray(1)]));
  await assert.rejects(runInstalledMigrations(pool,installedOptions(f.ab,target)),{code:'migration_installation_changed'});
  writeFileSync(path,original);writeFileSync(join(f.ab.installation_directory,'package.json'),'{}');
  await assert.rejects(runInstalledMigrations(pool,installedOptions(f.ab,target)),{code:'migration_installation_extra_file'});
  rmSync(join(f.ab.installation_directory,'package.json'));rmSync(path);symlinkSync('/not-readable',path);
  await assert.rejects(runInstalledMigrations(pool,installedOptions(f.ab,target)));
});
test('preparation refuses dirty or mixed-source trees and candidate-contained installation',t=>{
  const f=setup(t),input={sourceRoot:f.source,sourceCommit:f.ba.source_commit,profile:dagProfile,installationParent:f.host};
  assert.throws(()=>prepareMigrationInstallation({...input,sourceCommit:f.ab.source_commit}),{code:'migration_source_mixed_worktree'});
  assert.throws(()=>prepareMigrationInstallation({...input,installationParent:f.source}),{code:'migration_source_identity_invalid'});
  writeFileSync(join(f.source,'migrations',A),'-- changed');assert.throws(()=>prepareMigrationInstallation(input),{code:'migration_source_mixed_worktree'});
  git(f.source,['checkout','--','migrations/'+A]);writeFileSync(join(f.source,'unexpected.sql'),'SELECT 1;');assert.throws(()=>prepareMigrationInstallation(input),{code:'migration_source_mixed_worktree'});
});
test('CLI pins/target arguments are exact and cannot hide duplicate or candidate-selected fields',()=>{
  const args=['--installation','/host/install','--expected-installation','a'.repeat(64),'--expected-source','b'.repeat(40),'--expected-profile','c'.repeat(64),'--database','fp_target','--role','postgres','--schema','fp_case'];
  assert.equal(installedMigrationArguments(args).target.schema,'fp_case');
  for(const bad of [[],args.slice(0,-2),[...args,'--manifest','candidate.json'],args.map((x,i)=>i===12?'--role':x)]) assert.throws(()=>installedMigrationArguments(bad),{code:'migration_host_arguments_invalid'});
});

test('source preparation refuses local alternate metadata including HTTP alternates without fetching',t=>{
  const f=setup(t),input={sourceRoot:f.source,sourceCommit:f.ba.source_commit,profile:dagProfile,installationParent:f.host};
  for(const name of ['objects/info/alternates','objects/info/http-alternates','info/grafts']) {
    const path=resolve(f.source,git(f.source,['rev-parse','--git-path',name]));
    writeFileSync(path,'');
    assert.throws(()=>prepareMigrationInstallation(input),{code:'migration_source_indirection'});
    rmSync(path);
  }
});
