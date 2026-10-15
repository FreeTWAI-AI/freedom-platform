import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {decideGuildPresentationProfile, loadModuleDescriptors, GENERATED_INVENTORY_PATH,collectRepositoryDecision,evaluateVerifyAggregate,githubOutput,SELECTABLE_JOBS} from './select-affected-jobs.mjs';
import {GUILD_PRESENTATION_IMPORTS,guildPresentationImportsProven,GUILD_PRESENTATION_PROFILE} from '../../packages/contribution-tools/guild-presentation-profile.mjs';
import {isModuleDescriptorPath} from '../../packages/contribution-tools/context.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const graph=loadModuleDescriptors(root,head);assert.equal(graph.ok,true);
const descriptorSources=execFileSync('git',['-C',root,'ls-tree','-r','--name-only','-z',head],{encoding:'utf8'})
  .split('\0').filter(isModuleDescriptorPath)
  .map(path=>[path,execFileSync('git',['-C',root,'show',`${head}:${path}`])]);
const supply='modules/guild-supply/CatalogBlock.tsx',opensource='modules/guild-open-source/WorksBlock.tsx';
function input(paths=[supply]){return {event:'pull_request',diffComplete:true,descriptorsProven:true,changes:paths.map(path=>({status:'M',path})),baseline:structuredClone(graph.descriptors),candidate:structuredClone(graph.descriptors)};}
const decide=decideGuildPresentationProfile;
test('actual two-guild graph retains composition obligations and explains exact checks',()=>{
  const supplyLeaf = GUILD_PRESENTATION_PROFILE.leaves.find(item => item.module === 'guild-supply');
  assert.deepEqual(supplyLeaf.operations, ['storefront.supply-catalog.list', 'supplier-console.summary']);
  assert.deepEqual(supplyLeaf.dependencies, ['guild-presentation', 'hosted-distribution', 'supplier-console']);
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

function integration(t, extra='') {
  const repository=mkdtempSync(join(tmpdir(),'fp-guild-impact-'));t.after(()=>rmSync(repository,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false',...args],{
    cwd:repository,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Synthetic Fixture',GIT_COMMITTER_NAME:'Synthetic Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
  const write=(path,text)=>{mkdirSync(dirname(join(repository,path)),{recursive:true});writeFileSync(join(repository,path),text);};
  const commit=()=>{git('add','.');git('commit','-qm','Synthetic guild fixture');return git('rev-parse','HEAD');};
  git('init','-q','-b','main');
  // Preserve actual locations and raw descriptors: relocating a descriptor
  // invents another owned path and can exceed the schema's 64-path limit.
  for(const [path,source] of descriptorSources)write(path,source);
  for(const [path,prefix] of Object.entries(GUILD_PRESENTATION_IMPORTS))write(path,prefix+'export const label="before";\n');
  const base=commit();git('switch','-qc','feature');
  write(supply,GUILD_PRESENTATION_IMPORTS[supply]+'export const label="after";\n'+extra);
  const head=commit();git('switch','main');git('merge','--no-ff','-qm','Synthetic integration','feature');
  return {repository,event:'pull_request',base,head,candidate:git('rev-parse','HEAD')};
}

test('real clean integration selects the fixed guild lane and aggregate requires every selected result',t=>{
  const args=integration(t),result=collectRepositoryDecision(args);
  assert.equal(result.mode,'affected');assert.equal(result.reason,'guild_presentation_dependency_closure');
  assert.deepEqual(Object.keys(result.jobs).filter(key=>result.jobs[key]),['static-worker','guild-presentation']);
  const outputs=Object.fromEntries(githubOutput(result).trim().split('\n').map(line=>line.split('=')));
  const needs={select:{result:'success',outputs},'source-integrity':{result:'success'}};
  for(const id of SELECTABLE_JOBS)needs[id]={result:result.jobs[id]?'success':'skipped'};
  assert.equal(evaluateVerifyAggregate(needs).ok,true);
  for(const id of ['guild-presentation','static-worker','source-integrity'])for(const state of ['skipped','failure','cancelled']){
    assert.equal(evaluateVerifyAggregate({...needs,[id]:{result:state}}).ok,false);
  }
  const missing=structuredClone(needs);delete missing['guild-presentation'];assert.equal(evaluateVerifyAggregate(missing).ok,false);
  const forged=structuredClone(needs);forged.select.outputs.ui_e2e='true';assert.equal(evaluateVerifyAggregate(forged).ok,false);
  assert.equal(collectRepositoryDecision({...args,candidate:args.head}).mode,'full');
  writeFileSync(join(args.repository,'untracked.ts'),'synthetic');assert.equal(collectRepositoryDecision(args).mode,'full');
});

test('new source imports cannot preserve a falsely unchanged descriptor graph',t=>{
  for(const extra of ["import '../../modules/community/service';\n",
    "export * from // additional source dependency\n '../../apps/portal-web/src/api';\n"]){
    const args=integration(t,extra);
    assert.equal(collectRepositoryDecision(args).mode,'full');
    assert.equal(collectRepositoryDecision(args).reason,'guild_source_dependencies_unproven');
  }
});

test('reviewed source import boundaries fail closed on dynamic or unfamiliar dependencies',()=>{
  for(const path of Object.keys(GUILD_PRESENTATION_IMPORTS)){
    const source=readFileSync(join(root,path),'utf8');assert.equal(guildPresentationImportsProven(path,source),true,path);
    for(const extra of ["\nimport('new-package')", "\nrequire('new-package')", "\nexport {foo} from /* unfamiliar */ 'new-package'",
      "\nexport * from // additional source dependency\n '../../apps/portal-web/src/api';", "\nnew Function('return 1')"]){
      assert.equal(guildPresentationImportsProven(path,source+extra),false);
    }
    assert.equal(guildPresentationImportsProven(path,source.replace("from 'react'", "from 'new-package'")),false);
    assert.equal(guildPresentationImportsProven(path,source+'\nexport {foo} from '+ '*//*'.repeat(16384)+'!'),false,
      'malformed repeated comments fall back without parsing a nested regular expression');
  }
});
