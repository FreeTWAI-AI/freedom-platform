// Portable handover: a producer process seals one owned PG18 + native local R2
// set and exits. A second process, with only those files and the expected
// identity, restores through scripts/media-recovery-restore.ts into a new
// container. A second process is not a second authorized human. Synthetic
// fixture data only; no production DB, backup, GC, timer or provider call.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {cp,chmod,lstat,mkdir,mkdtemp,readFile,realpath,writeFile,readdir,rm,link,symlink,unlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// @ts-expect-error Shared dependency-free verifier environment is implemented in JS.
import {verificationEnvironment} from '../../packages/contribution-tools/process-env.mjs';
import {runMediaRecoveryRestore} from '../../scripts/media-recovery-restore.js';
import {decodeEvidence} from '../../packages/media-migration/backup-evidence.js';
import {readbackRecoverySet,restoreRecoverySet,restoredReferenceAuthorization,recoverySetKeys,RecoveryArchiveError,type DatabaseRestoreWriter,type RecoverySetIdentity} from '../../packages/media-migration/backup-archive.js';
import {MEDIA_ACL_SIGNATURES} from '../../packages/media-migration/restore-acl-lockdown.js';
import {RECOVERY_OWNER,RECOVERY_POSTGRES_IMAGE,discardOwnedRecoveryContainer,removeOwnedRecoveryContainer,withOwnedRecoveryTarget,type OwnedRecoveryIdentity,type RecoveryContainerRole} from '../../packages/media-migration/owned-recovery-target.js';
import {openRecoveryBundle,RecoveryBundleError} from '../../packages/media-migration/recovery-bundle.js';
import {restoreRecoveryHandover,RecoveryHandoverError} from '../../packages/media-migration/recovery-handover.js';
import type {ObjectStore} from '../../packages/asset-storage/index.js';

const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
assert.match(head,/^[a-f0-9]{40}$/);
const children=new Set<number>();
let root='',handoff='',work='',state='',foreignId='',foreignName='';
interface Expectations {
  format:string;setId:string;manifestSha256:string;environment:'local';database:string;schema:string;sourceRelease:string;
  assetIds:string[];excludedAssetId:string;sessionFingerprint:string;unfencedSessions:number;
  objects:{key:string;sha256:string;byteSize:number}[];containerId:string;containerName:string;
}
let expectations:Expectations|undefined;
const dockerEnv=()=>verificationEnvironment();
function dockerText(args:string[]):string{
  return execFileSync('docker',args,{env:dockerEnv(),encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
}
function ownedContainerIds():string[]{
  const out=dockerText(['ps','-aq','--filter','label=freedom.owner='+RECOVERY_OWNER]);
  return out?out.split('\n').filter(Boolean).sort():[];
}
function inspectOne(id:string):{Id?:string;Name?:string;State?:{Status?:string};Config?:{Labels?:Record<string,string>}}|undefined{
  try{const parsed:unknown=JSON.parse(dockerText(['inspect',id]));return Array.isArray(parsed)?parsed[0] as {Id?:string;Name?:string;State?:{Status?:string};Config?:{Labels?:Record<string,string>}}:undefined;}
  catch{return undefined;}
}
async function privateDir(prefix:string):Promise<string>{
  const path=await realpath(await mkdtemp(join(tmpdir(),prefix)));await chmod(path,0o700);return path;
}
async function tighten(path:string):Promise<void>{
  const stat=await lstat(path);
  if(stat.isSymbolicLink())throw new Error('copy_refuses_symlink');
  await chmod(path,stat.isDirectory()?0o700:0o600);
  if(stat.isDirectory())for(const name of await readdir(path))await tighten(join(path,name));
}
async function copyBundle():Promise<string>{
  assert(handoff);const dest=await privateDir('fp-b3-copy-');
  await cp(handoff,dest,{recursive:true,verbatimSymlinks:true});await tighten(dest);return dest;
}
async function treeHash(path:string):Promise<string>{
  const hash=createHash('sha256');
  async function walk(current:string,rel:string){
    for(const name of (await readdir(current)).sort()){
      const full=join(current,name),stat=await lstat(full),child=rel?rel+'/'+name:name;
      hash.update(child+'\0'+(stat.isDirectory()?'d':'f')+'\0');
      if(stat.isDirectory())await walk(full,child);else hash.update(await readFile(full));
    }
  }
  await walk(path,'');return hash.digest('hex');
}
function spawnNode(args:string[],timeoutMs:number):Promise<{code:number|null;stdout:string;stderr:string;timedOut:boolean}>{
  return new Promise(resolveChild=>{
    const child=spawn(process.execPath,['--import','tsx',...args],{cwd:repo,env:dockerEnv(),stdio:['ignore','pipe','pipe'],detached:true});
    if(child.pid)children.add(child.pid);
    let stdout='',stderr='',timedOut=false;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{stdout+=chunk;if(stdout.length>1_000_000)stdout=stdout.slice(-500_000);});
    child.stderr.on('data',(chunk:string)=>{stderr+=chunk;process.stderr.write(chunk);if(stderr.length>1_000_000)stderr=stderr.slice(-500_000);});
    const timer=setTimeout(()=>{timedOut=true;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{/* already gone */}},timeoutMs);
    const finish=(code:number|null)=>{clearTimeout(timer);if(child.pid)children.delete(child.pid);resolveChild({code,stdout,stderr,timedOut});};
    child.once('error',()=>finish(null));child.once('close',code=>finish(code));
  });
}
async function releaseIntent(dir:string):Promise<void>{
  let raw:string;try{raw=await readFile(join(dir,'container-intent.json'),'utf8');}catch{return;}
  const intent=JSON.parse(raw) as {containerId?:string;name?:string;run?:string;socket?:string;role?:string};
  if(typeof intent.name!=='string'||typeof intent.run!=='string'||typeof intent.socket!=='string'||(intent.role!=='producer'&&intent.role!=='consumer'))return;
  const identity:OwnedRecoveryIdentity={containerId:typeof intent.containerId==='string'?intent.containerId:'',name:intent.name,run:intent.run,socket:intent.socket,role:intent.role as RecoveryContainerRole};
  discardOwnedRecoveryContainer(identity);
  const socketRoot=dirname(intent.socket);
  if(intent.socket.startsWith('/tmp/fp-g-b3-')&&socketRoot.startsWith('/tmp/fp-g-b3-'))await rm(socketRoot,{recursive:true,force:true}).catch(()=>{});
}
async function releaseTree(dir:string):Promise<void>{
  let names:string[];try{names=await readdir(dir);}catch{return;}
  if(names.includes('container-intent.json'))await releaseIntent(dir);
  for(const name of names){const full=join(dir,name);try{if((await lstat(full)).isDirectory())await releaseTree(full);}catch{/* already gone */}}
}
function removeForeign():void{
  if(!foreignId)return;
  const item=inspectOne(foreignId);
  if(!item){foreignId='';return;}
  if(item.Config?.Labels?.['freedom.owner']!=='grok-b3-other'||item.Name!=='/'+foreignName||item.Id!==foreignId)throw new Error('foreign_container_identity_mismatch');
  dockerText(['rm',foreignId]);foreignId='';
}
let chain:Promise<void>=Promise.resolve();
function serial(name:string,fn:()=>Promise<void>,timeout=120000){
  test(name,{timeout},async()=>{
    let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});const prev=chain;chain=gate;
    await prev;try{process.stderr.write(`handover-test:${name}\n`);await fn();}finally{release();}
  });
}
function refusal(error:unknown):boolean{
  return error instanceof RecoveryArchiveError||error instanceof RecoveryBundleError||error instanceof RecoveryHandoverError;
}

after(async()=>{
  for(const pid of children){try{process.kill(-pid,'SIGKILL');}catch{/* already gone */}}
  if(work)await releaseTree(work).catch(()=>{});
  if(state)await releaseTree(state).catch(()=>{});
  try{removeForeign();}catch{/* reported by the foreign test */ }
  if(root)await rm(root,{recursive:true,force:true}).catch(()=>{});
});

function reportField(report:object,key:string):unknown{return Object.hasOwn(report,key)?(report as Record<string,unknown>)[key]:undefined;}
serial('plan and incomplete invocation create no container',async()=>{
  const before=ownedContainerIds();
  const plan=await runMediaRecoveryRestore(['--plan']);
  assert.equal(plan.exitCode,0);assert.equal(reportField(plan.report,'execution'),'not_run');assert.equal(reportField(plan.report,'cutoverAuthorized'),false);
  const missing=await runMediaRecoveryRestore(['--execute-quarantine']);
  assert.equal(missing.exitCode,1);assert.equal(reportField(missing.report,'status'),'unavailable');
  assert.deepEqual(ownedContainerIds(),before);
});

serial('ambient database environment is refused before docker',async()=>{
  const previous=process.env.DATABASE_URL;const before=ownedContainerIds();
  process.env.DATABASE_URL='postgresql://postgres@127.0.0.1:54339/freedom';
  try{
    const refused=await runMediaRecoveryRestore(['--execute-quarantine','--set-id',randomUUID(),'--manifest-sha256','a'.repeat(64),'--environment','local','--source-database','fp_b3_source','--schema','fp_b3_src','--source-release',head,'--operator-source',head,'--bundle-dir','/tmp/fp-b3-absent-bundle','--state-dir','/tmp/fp-b3-absent-state','--target-database','fp_b3_restore']);
    assert.equal(refused.exitCode,1);assert.equal(reportField(refused.report,'status'),'unavailable');
    assert.deepEqual(ownedContainerIds(),before);
  }finally{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;}
});

serial('cleanup refuses a foreign container without removing it',async()=>{
  dockerText(['image','inspect','--format','{{.Id}}',RECOVERY_POSTGRES_IMAGE]);
  foreignName='fp-g-b3-foreign-'+randomUUID();
  const run=randomUUID();
  foreignId=dockerText(['create','--pull','never','--name',foreignName,'--network','none','--label','freedom.task=foundation-recovery-handover','--label','freedom.owner=grok-b3-other','--label','freedom.role=consumer','--label','freedom.run='+run,RECOVERY_POSTGRES_IMAGE]);
  assert.match(foreignId,/^[0-9a-f]{64}$/);
  const identity:OwnedRecoveryIdentity={containerId:foreignId,name:foreignName,run,socket:'/tmp/fp-g-b3-not-ours',role:'consumer'};
  assert.throws(()=>removeOwnedRecoveryContainer(identity),(error:unknown)=>error instanceof Error&&error.message==='owned_recovery_target_unavailable');
  const item=inspectOne(foreignId);
  assert.equal(item?.Id,foreignId);assert.equal(item?.State?.Status,'created');assert.equal(item?.Config?.Labels?.['freedom.owner'],'grok-b3-other');
});

serial('producer exit then a new process restores only the handed-over files',async()=>{
  const porcelain=execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repo,encoding:'utf8'});
  assert.equal(porcelain,'','CLI refuses a dirty operator source; commit before this test');
  dockerText(['image','inspect','--format','{{.Id}}',RECOVERY_POSTGRES_IMAGE]);
  root=await privateDir('fp-b3-handover-');
  handoff=join(root,'handoff');work=join(root,'work');state=join(root,'state');
  await mkdir(handoff,{mode:0o700});await mkdir(work,{mode:0o700});await mkdir(state,{mode:0o700});
  handoff=await realpath(handoff);work=await realpath(work);state=await realpath(state);
  const producer=await spawnNode(['tests/runtime/media-recovery-handover-producer.ts',handoff,work,head],12*60*1000);
  if(producer.code!==0){await releaseTree(work);assert.fail(`producer exit ${producer.code} timedOut=${producer.timedOut} stderr=${producer.stderr.slice(-1500)}`);}
  assert.equal(producer.timedOut,false);
  expectations=JSON.parse(await readFile(join(work,'expectations.json'),'utf8')) as Expectations;
  assert.equal(expectations.sourceRelease,head);assert.equal(expectations.unfencedSessions,1);
  assert.equal(inspectOne(expectations.containerId),undefined,'producer container must be gone before the consumer starts');
  const beforeHash=await treeHash(handoff);
  assert.equal(dockerEnv().DATABASE_URL,undefined);assert.equal(dockerEnv().PGHOST,undefined);
  const consumer=await spawnNode(['scripts/media-recovery-restore.ts','--execute-quarantine','--set-id',expectations.setId,'--manifest-sha256',expectations.manifestSha256,'--environment','local','--source-database',expectations.database,'--schema',expectations.schema,'--source-release',head,'--operator-source',head,'--bundle-dir',handoff,'--state-dir',state,'--target-database','fp_b3_restore'],12*60*1000);
  if(consumer.code!==0){await releaseTree(state);assert.fail(`consumer exit ${consumer.code} timedOut=${consumer.timedOut} stderr=${consumer.stderr.slice(-1500)} stdout=${consumer.stdout.slice(-1500)}`);}
  const runs=(await readdir(state)).filter(name=>name!=='.');
  assert.equal(runs.length,1);
  const completed=JSON.parse(await readFile(join(state,runs[0]!,'completed.json'),'utf8'));
  const reported=JSON.parse(consumer.stdout);
  assert.deepEqual(reported,completed);
  const manifestPath=join(handoff,'sealed','recovery-sets',expectations.setId,'recovery-set.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8')) as {createdAt:string;setId:string};
  assert.equal(createHash('sha256').update(await readFile(manifestPath)).digest('hex'),expectations.manifestSha256);
  const sealedEvidence=decodeEvidence(await readFile(join(handoff,'sealed',recoverySetKeys(expectations.setId).evidence)));
  const prints=(rows:{table:string;count:string;fingerprint:string}[])=>[...rows].sort((a,b)=>a.table<b.table?-1:a.table>b.table?1:0);
  assert.deepEqual(prints(completed.evidence.fingerprints),prints(sealedEvidence.tables.map(table=>({table:table.table,count:table.count,fingerprint:table.fingerprint}))));
  const byKey=(rows:{key:string;sha256:string;byteSize:number}[])=>[...rows].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  assert.deepEqual(byKey(completed.objects.entries),byKey(expectations.objects));
  assert.deepEqual(completed.rows.assetIds,expectations.assetIds);
  assert.equal(completed.rows.assetIds.includes(expectations.excludedAssetId),false);
  assert.equal(completed.rows.sessionFingerprint,expectations.sessionFingerprint);
  assert.equal(completed.rows.unfencedSessionsBefore,1);assert.equal(completed.rows.backupPins,0);
  assert.equal(completed.importedSessionsFenced,1);
  assert.deepEqual(completed.maintenance,{enabled:false,domainMediaEnabled:false,unfencedSessions:0});
  assert.equal(completed.acl.functionsRevoked,24);assert.equal(completed.acl.runtimeExecuteDenied,true);
  assert.deepEqual([...completed.acl.signatures].sort(),[...MEDIA_ACL_SIGNATURES].sort());
  assert.equal(MEDIA_ACL_SIGNATURES.length,24);
  assert.equal(completed.exposure,'quarantine_not_approved_for_exposure');
  assert.equal(completed.cleanupVerified,true);assert.equal(completed.cutoverAuthorized,false);
  assert.equal(completed.secondOperatorAcceptance,'not_run');assert.equal(completed.externalRecoveryAuthority,'not_run');
  assert.equal(completed.oldExecutionTokenAcceptance,'not_run');assert.equal(completed.applicationInstalled,false);
  assert.equal(completed.dispatchStarted,false);assert.equal(completed.retentionExecuted,false);assert.equal(completed.sourcePins,'untouched');
  assert.equal(completed.operatorSource,head);assert.equal(completed.sourceSetCreatedAt,manifest.createdAt);
  assert.equal(completed.status,'quarantine_restore_verified');assert.equal(inspectOne(completed.targetContainerId),undefined);
  assert.equal(await treeHash(handoff),beforeHash);
},30*60*1000);

serial('corrupt, missing, wrong-identity and unsafe inputs fail before a target write',async()=>{
  assert(expectations&&handoff,'producer bundle required');
  const identity=():RecoverySetIdentity=>({setId:expectations!.setId,manifestSha256:expectations!.manifestSha256,environment:'local',database:expectations!.database,schema:expectations!.schema,sourceRelease:head});
  const flipped=expectations.manifestSha256.slice(0,-1)+(expectations.manifestSha256.endsWith('0')?'1':'0');
  const cases:RecoverySetIdentity[]=[
    {...identity(),manifestSha256:flipped},{...identity(),environment:'staging'},{...identity(),database:'fp_b3_other'},
    {...identity(),schema:'fp_b3_other'},{...identity(),sourceRelease:head.startsWith('a')?'b'.repeat(40):'a'.repeat(40)},
  ];
  for(const expected of cases){
    const run=await privateDir('fp-b3-run-'),before=ownedContainerIds();
    try{
      await assert.rejects(restoreRecoveryHandover({expected,operatorSource:head,bundleDirectory:handoff,runDirectory:run,targetDatabase:'fp_b3_restore',signal:AbortSignal.timeout(120000)}),
        (error:unknown)=>error instanceof RecoveryArchiveError&&error.code==='recovery_identity_mismatch');
      await assert.rejects(access(join(run,'container-intent.json')));
      assert.deepEqual(ownedContainerIds(),before);
    }finally{await rm(run,{recursive:true,force:true});}
  }
  const missingDir=await privateDir('fp-b3-run-');
  try{
    await assert.rejects(restoreRecoveryHandover({expected:{...identity(),setId:randomUUID()},operatorSource:head,bundleDirectory:handoff,runDirectory:missingDir,targetDatabase:'fp_b3_restore',signal:AbortSignal.timeout(60000)}),
      (error:unknown)=>error instanceof RecoveryBundleError);
    await assert.rejects(access(join(missingDir,'container-intent.json')));
  }finally{await rm(missingDir,{recursive:true,force:true});}
  const opened=await openRecoveryBundle(handoff,expectations.setId);
  await assert.rejects(readbackRecoverySet({...opened,setId:expectations.setId,verifiedAt:new Date().toISOString(),expected:{...identity(),setId:randomUUID()}}),
    (error:unknown)=>error instanceof RecoveryArchiveError&&error.code==='recovery_identity_mismatch');
  async function tamper(mutate:(copy:string,objectFile:string)=>Promise<void>,label:string){
    const copy=await copyBundle();const run=await privateDir('fp-b3-run-'),before=ownedContainerIds();
    try{
      const objectFile=join(copy,'objects',expectations!.objects[0]!.key.replaceAll('/','_')+'.json');
      await mutate(copy,objectFile);
      await assert.rejects(restoreRecoveryHandover({expected:identity(),operatorSource:head,bundleDirectory:copy,runDirectory:run,targetDatabase:'fp_b3_restore',signal:AbortSignal.timeout(180000)}),refusal,label);
      await assert.rejects(access(join(run,'container-intent.json')),label);
      assert.deepEqual(ownedContainerIds(),before,label);
    }finally{await rm(copy,{recursive:true,force:true});await rm(run,{recursive:true,force:true});}
  }
  await tamper(async(_copy,file)=>{
    const text=await readFile(file,'utf8');const at=text.indexOf('"bytes":"');assert(at>0);
    const pos=at+'"bytes":"'.length;const next=text[pos]==='A'?'B':'A';
    await writeFile(file,text.slice(0,pos)+next+text.slice(pos+1),{mode:0o600});
  },'corrupt object bytes');
  await tamper(async(_copy,file)=>{await unlink(file);},'missing object');
  await tamper(async(_copy,file)=>{await link(file,file+'.hard');},'hardlink');
  await tamper(async(_copy,file)=>{const target=file+'.target';await writeFile(target,await readFile(file),{mode:0o600});await unlink(file);await symlink(target,file);},'symlink');
  await tamper(async(_copy,file)=>{await chmod(file,0o644);},'object mode');
  await tamper(async copy=>{await chmod(copy,0o755);},'directory mode');
  {
    const copy=await copyBundle(),via=join(dirname(copy),'..',basename(dirname(copy)),basename(copy));
    assert.notEqual(via,copy);
    const run=await privateDir('fp-b3-via-'),before=ownedContainerIds();
    try{
      await assert.rejects(restoreRecoveryHandover({expected:identity(),operatorSource:head,bundleDirectory:via,runDirectory:run,targetDatabase:'fp_b3_restore',signal:AbortSignal.timeout(60000)}),(error:unknown)=>error instanceof RecoveryBundleError,'traversal path');
      await assert.rejects(access(join(run,'container-intent.json')));
      assert.deepEqual(ownedContainerIds(),before);
    }finally{await rm(copy,{recursive:true,force:true});await rm(run,{recursive:true,force:true});}
  }
  await tamper(async(_copy,file)=>{
    const doc=JSON.parse(await readFile(file,'utf8')) as {key:string;metadata:unknown;bytes:string};
    doc.key='../'+doc.key;await writeFile(file,JSON.stringify(doc)+'\n',{mode:0o600});
  },'traversal name');
},10*60*1000);

serial('non-empty target is refused before restore writes, and the foreign container survives',async()=>{
  assert(expectations&&handoff&&foreignId);
  const copy=await copyBundle();const run=await privateDir('fp-b3-nonempty-');
  let sqlWrites=0,objectWrites=0,sentinel=-1,assets=-1;
  const before=ownedContainerIds();
  try{
    const bundle=await openRecoveryBundle(copy,expectations.setId);
    const expected:RecoverySetIdentity={setId:expectations.setId,manifestSha256:expectations.manifestSha256,environment:'local',database:expectations.database,schema:expectations.schema,sourceRelease:head};
    await assert.rejects(withOwnedRecoveryTarget({runDirectory:run,database:'fp_b3_nonempty',schema:'fp_b3_src',signal:AbortSignal.timeout(180000)},async target=>{
      await target.pool.query('CREATE SCHEMA fp_b3_src');
      await target.pool.query('CREATE TABLE fp_b3_src.sentinel (id int)');
      await target.pool.query('INSERT INTO fp_b3_src.sentinel VALUES (1)');
      const database:DatabaseRestoreWriter={async restore(){sqlWrites++;throw new Error('writer_called');}};
      const destinationObjects:ObjectStore={
        async putImmutable(){objectWrites++;throw new Error('put_called');},
        async get(){throw new Error('get_called');},async head(){throw new Error('head_called');},async delete(){throw new Error('delete_called');},
      };
      try{await restoreRecoverySet({...bundle,setId:expectations!.setId,expected,destinationObjects,restoredPool:target.pool,restoredDatabase:target.databaseName,database,
        objectAuthority:restoredReferenceAuthorization(target.pool,{database:target.databaseName,schema:'fp_b3_src',current:{mode:'quarantine'}})});}
      finally{
        sentinel=(await target.pool.query('SELECT count(*)::int AS n FROM fp_b3_src.sentinel')).rows[0].n;
        assets=(await target.pool.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fp_b3_src' AND c.relname='assets'")).rows[0].n;
      }
    }),(error:unknown)=>error instanceof RecoveryArchiveError&&error.code==='restore_target_not_empty');
    assert.equal(sqlWrites,0);assert.equal(objectWrites,0);assert.equal(sentinel,1);assert.equal(assets,0);
    assert.deepEqual(ownedContainerIds(),before);
    const foreign=inspectOne(foreignId);
    assert.equal(foreign?.State?.Status,'created');assert.equal(foreign?.Config?.Labels?.['freedom.owner'],'grok-b3-other');
  }finally{await rm(copy,{recursive:true,force:true});await releaseTree(run);await rm(run,{recursive:true,force:true});removeForeign();}
},10*60*1000);
