import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_MIGRATIONS, DAG_MIGRATIONS, MIGRATION_V2_GUARD, migrationDigest } from '../../../packages/db/migration-plan.mjs';
import { prepareMigrationInstallation } from '../migration-operator.mjs';
export const fixtureRoot = fileURLToPath(new URL('../../../',import.meta.url));
export const coreFiles = ['packages/db/migration-plan.mjs','packages/db/migration-files.mjs','packages/db/migration-runner.mjs','package-lock.json'];
export const A = 'v2_20261005T000000001Z_0000000000000001_alpha.sql', B = 'v2_20261005T000000002Z_0000000000000002_beta.sql', C = 'v2_20261005T000000000Z_0000000000000003_child.sql';
export const legacy = [{name:'001_base.sql',sql:'CREATE TABLE base(id integer PRIMARY KEY); INSERT INTO base VALUES(1);'},
  {name:'003_tail.sql',sql:'CREATE TABLE tail(id integer PRIMARY KEY); INSERT INTO tail VALUES(1);'}];
export const dagProfile = {format:DAG_MIGRATIONS,legacy:{format:LEGACY_MIGRATIONS,first:1,last:3,known_gaps:[2]},legacy_ledger:legacy.map(e=>({name:e.name,sha256:migrationDigest(e.sql)}))};
function v2(name,deps,sql) {return {name,sql:'-- freedom-migration: '+JSON.stringify({format:DAG_MIGRATIONS,depends_on:deps})+'\n'+MIGRATION_V2_GUARD+sql};}
export const additions = [v2(A,['003_tail.sql'],'CREATE TABLE alpha(id integer PRIMARY KEY REFERENCES base); INSERT INTO alpha VALUES(1);'),
  v2(B,['003_tail.sql'],'CREATE TABLE beta(id integer PRIMARY KEY REFERENCES tail); INSERT INTO beta VALUES(1);'),
  v2(C,[A,B],'CREATE TABLE child(a integer REFERENCES alpha,b integer REFERENCES beta); INSERT INTO child SELECT a.id,b.id FROM alpha a,beta b;')];
export function git(root,args) {return execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],
  env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'synthetic@example.invalid',GIT_COMMITTER_NAME:'Synthetic',GIT_COMMITTER_EMAIL:'synthetic@example.invalid'}}).trim();}
function put(root,path,bytes) {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),bytes);}
export function installedOptions(record,target) {return {installationDirectory:record.installation_directory,expectedInstallationDigest:record.installation_digest,
  expectedSourceCommit:record.source_commit,expectedProfileDigest:record.profile_digest,target};}
export function createMigrationFixture() {
  const root=mkdtempSync(join(tmpdir(),'fp-migration-entries-')),source=join(root,'source'),host=join(root,'host');
  mkdirSync(source,{mode:0o700});mkdirSync(host,{mode:0o700});git(source,['init','-q','-b','main']);
  for (const path of coreFiles) put(source,path,readFileSync(join(fixtureRoot,path)));
  for(const e of legacy)put(source,'migrations/'+e.name,e.sql);
  git(source,['add','.']);git(source,['commit','-qm','Synthetic legacy catalog']);const base=git(source,['rev-parse','HEAD']);
  const install=()=>prepareMigrationInstallation({sourceRoot:source,sourceCommit:git(source,['rev-parse','HEAD']),profile:dagProfile,installationParent:host});
  git(source,['checkout','-qb','add-a']);put(source,'migrations/'+A,additions[0].sql);git(source,['add','.']);git(source,['commit','-qm','Independent alpha']);const a=install(),aCommit=a.source_commit;
  git(source,['checkout','-qb','add-b',base]);put(source,'migrations/'+B,additions[1].sql);git(source,['add','.']);git(source,['commit','-qm','Independent beta']);const b=install(),bCommit=b.source_commit;
  git(source,['checkout','-q','add-a']);git(source,['merge','--no-ff','-qm','Merge beta after alpha',bCommit]);put(source,'migrations/'+C,additions[2].sql);git(source,['add','.']);git(source,['commit','-qm','Dependent child']);const ab=install();
  git(source,['checkout','-q','add-b']);git(source,['merge','--no-ff','-qm','Merge alpha after beta',aCommit]);put(source,'migrations/'+C,additions[2].sql);git(source,['add','.']);git(source,['commit','-qm','Dependent child']);const ba=install();
  return {root,source,host,base,a,b,ab,ba};
}
