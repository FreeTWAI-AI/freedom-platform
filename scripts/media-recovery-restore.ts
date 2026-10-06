import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
// @ts-expect-error Shared dependency-free verifier environment is implemented in JS.
import {verificationEnvironment} from '../packages/contribution-tools/process-env.mjs';
import {assertPrivateRecoveryDirectory} from '../packages/media-migration/recovery-bundle.js';
import {restoreRecoveryHandover} from '../packages/media-migration/recovery-handover.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const refuse=(code='recovery_handover_unavailable'):never=>{throw new Error(code);};
const fields=['set-id','manifest-sha256','environment','source-database','schema','source-release','operator-source','bundle-dir','state-dir','target-database'] as const;
const plan=Object.freeze({format:'freedom.recovery-handover-plan/v1',execution:'not_run',requiredArguments:fields.map(x=>'--'+x),
 inputLayout:'Existing downloaded daily sealed/ and objects/ directories; no tar extraction or credential discovery.',
 target:'New owned PG18 network-none/noports/tmpfs plus native local R2; always quarantined and removed.',
 secondOperatorAcceptance:'not_run',externalRecoveryAuthority:'not_run',cutoverAuthorized:false});
async function record(path:string,value:unknown){
 const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}
 const d=await open(resolve(path,'..'),'r');try{await d.sync();}finally{await d.close();}
}
export async function runMediaRecoveryRestore(args:string[]){
 let runDirectory:string|undefined;
 try{
  const values:Record<string,string>={};let execute=false;
  for(let i=0;i<args.length;i++){
   if(args[i]==='--execute-quarantine'){if(execute)refuse();execute=true;continue;}
   if(args[i]==='--plan'){if(args.length!==1)refuse();continue;}
   const key=args[i].slice(2);if(!args[i].startsWith('--')||!fields.includes(key as typeof fields[number])||Object.hasOwn(values,key)||!args[i+1]||args[i+1].startsWith('--'))refuse();
   values[key]=args[++i];
  }
  if(!execute){if(Object.keys(values).length)refuse();return {exitCode:0,report:plan};}
  if(fields.some(key=>!Object.hasOwn(values,key)))refuse();
  // A handed-over process must not inherit the producer's database, socket or password.
  if(['DATABASE_URL','TEST_DATABASE_URL','FREEDOM_MEDIA_DATABASE_URL','PGHOST','PGPASSWORD','PGDATABASE'].some(name=>{
    const value=process.env[name];return typeof value==='string'&&value.length>0;}))refuse('recovery_handover_ambient_database');
  const id=/^[a-z_][a-z0-9_]{0,62}$/,sha=/^[a-f0-9]{40}$/,hash=/^[a-f0-9]{64}$/;
  if(!z.string().uuid().safeParse(values['set-id']).success||!hash.test(values['manifest-sha256'])
   ||!['local','staging','production'].includes(values.environment)||![values['source-database'],values.schema].every(x=>id.test(x))
   ||![values['source-release'],values['operator-source']].every(x=>sha.test(x))||!/^fp_[a-z0-9_]{1,55}$/.test(values['target-database'])
   ||![values['bundle-dir'],values['state-dir']].every(x=>isAbsolute(x)&&resolve(x)===x))refuse();
  // Clean exact installed source is an operator check, not publisher approval.
  const git=(args:string[])=>execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],
   {cwd:root,env:{...verificationEnvironment(),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
  if(git(['rev-parse','HEAD'])!==values['operator-source']||git(['status','--porcelain','--untracked-files=no']))refuse('recovery_handover_operator_source');
  const overlap=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
  if(overlap(values['bundle-dir'],values['state-dir'])||overlap(values['state-dir'],resolve(root))||overlap(values['bundle-dir'],resolve(root)))refuse();
  await assertPrivateRecoveryDirectory(values['state-dir']);
  runDirectory=join(values['state-dir'],randomUUID());await mkdir(runDirectory,{mode:0o700});
  const expected={setId:values['set-id'],manifestSha256:values['manifest-sha256'],environment:values.environment as 'local'|'staging'|'production',
   database:values['source-database'],schema:values.schema,sourceRelease:values['source-release']};
  await record(join(runDirectory,'started.json'),{format:'freedom.recovery-handover-run/v1',expected,operatorSource:values['operator-source'],targetDatabase:values['target-database']});
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,20*60*1000);timer.unref();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{
   const report=await restoreRecoveryHandover({expected,operatorSource:values['operator-source'],bundleDirectory:values['bundle-dir'],runDirectory,
    targetDatabase:values['target-database'],signal:controller.signal});
   await record(join(runDirectory,'completed.json'),report);return {exitCode:0,report};
  }finally{clearTimeout(timer);process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
 }catch(error){
  const message=error instanceof Error?error.message:'';
  if(/^[a-z0-9_:.]+$/.test(message))process.stderr.write(message+'\n');
  const report={format:'freedom.recovery-handover/v1',status:'unavailable',code:'recovery_handover_unavailable',cleanupVerified:false,
   secondOperatorAcceptance:'not_run',externalRecoveryAuthority:'not_run',cutoverAuthorized:false};
  if(runDirectory)try{await record(join(runDirectory,'failed.json'),report);}catch{}
  return {exitCode:1,report};
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await runMediaRecoveryRestore(process.argv.slice(2));process.stdout.write(JSON.stringify(result.report)+'\n');process.exitCode=result.exitCode;
}
