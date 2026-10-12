import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {decideGuildPresentationProfile, loadModuleDescriptors, GENERATED_INVENTORY_PATH} from './select-affected-jobs.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const graph=loadModuleDescriptors(root,head);assert.equal(graph.ok,true);
const supply='modules/guild-supply/CatalogBlock.tsx',opensource='modules/guild-open-source/WorksBlock.tsx';
function input(paths=[supply]){return {event:'pull_request',diffComplete:true,descriptorsProven:true,changes:paths.map(path=>({status:'M',path})),baseline:structuredClone(graph.descriptors),candidate:structuredClone(graph.descriptors)};}
const decide=decideGuildPresentationProfile;
test('actual two-guild graph retains composition obligations and explains exact checks',()=>{
  for(const paths of [[supply],[opensource],[supply,opensource,GENERATED_INVENTORY_PATH]]){
    const result=decide(input(paths));assert.equal(result.profile,'guild-presentation');
    assert.ok(result.affected_modules.includes('application-composition'));
    assert.deepEqual(result.declared_suites,['runtime.full','runtime.guild-blocks']);
    assert.ok(result.integration_files.includes('tests/e2e/guild-block-composition.spec.ts'));
    assert.ok(result.preview_files.includes('modules/guild-open-source/WorksBlock.spec.ts'));
  }
});
test('unknown, core, test, manifest, registration and new paths keep full integration',()=>{
  for(const path of ['packages/guild-presentation/block.ts','modules/guild-supply/NewBlock.tsx','modules/guild-supply/CatalogBlock.spec.ts','modules/guild-supply/freedom.module.json','apps/portal-web/src/guild-blocks/registry.generated.ts','contracts/guild-launchpad/v2/config.ts','apps/platform-api/src/routes/guild-launchpad.ts','README.md','migrations/new.sql'])assert.equal(decide(input([supply,path])).profile,'full',path);
  assert.equal(decide(input([GENERATED_INVENTORY_PATH])).profile,'full');
});
test('events, incomplete diff, new file, deletion, rename and duplicate changes cannot narrow',()=>{
  for(const event of ['push','merge_group','workflow_dispatch',''])assert.equal(decide({...input(),event}).profile,'full');
  for(const status of ['A','D','R','R100','T','U']){const value=input();value.changes[0].status=status;assert.equal(decide(value).profile,'full');}
  assert.equal(decide({...input(),diffComplete:false}).profile,'full');
  assert.equal(decide({...input(),descriptorsProven:false}).profile,'full');
  assert.equal(decide(input([])).profile,'full');assert.equal(decide(input([supply,supply])).profile,'full');
});
test('baseline and candidate union cannot shed obligations or gain an unreviewed consumer',()=>{
  for(const side of ['baseline','candidate'])for(const field of ['owner_role','dependencies','tests','surfaces','public_exports']){
    const value=input(),owner=value[side].find(d=>d.module_id==='guild-supply');
    owner[field]=field==='owner_role'?'someone-else':[];assert.equal(decide(value).profile,'full',side+field);
  }
  const extra=input();for(const graph of [extra.baseline,extra.candidate])graph.find(d=>d.module_id==='personal-content').dependencies.push('guild-supply');
  assert.equal(decide(extra).profile,'full');
  const duplicate=input();duplicate.candidate.push(duplicate.candidate[0]);assert.equal(decide(duplicate).profile,'full');
  const missing=input();missing.candidate=missing.candidate.filter(d=>d.module_id!=='guild-presentation');assert.equal(decide(missing).profile,'full');
});
