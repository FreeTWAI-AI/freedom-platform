// Owned disposable PostgreSQL pair for the recovery-generation restore drill.
// No inherited DB URL, credentials, published ports, or remote migration commands.
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,chmod,mkdir,readdir,unlink,rmdir,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {verificationEnvironment} from '../packages/contribution-tools/process-env.mjs';
const image='postgres:18-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd';
const task='recovery-generation-drill',owner='recovery-generation-drill';
const root=resolve(new URL('..',import.meta.url).pathname);
if(process.argv.length!==2){console.error('Usage: node scripts/run-recovery-generation-drill.mjs');process.exit(2);}
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1024*1024});
function inspected(spec,reference){
  const item=JSON.parse(docker(['inspect',reference]))[0];
  if(!/^[0-9a-f]{64}$/.test(item.Id)||(spec.id&&item.Id!==spec.id)||item.Name!=='/'+spec.name
    ||!item.Mounts?.some(m=>m.Type==='bind'&&m.Source===spec.socket&&m.Destination==='/pgsocket')
    ||item.Config.Labels?.['freedom.task']!==task||item.Config.Labels?.['freedom.owner']!==owner
    ||item.HostConfig.NetworkMode!=='none'||Object.keys(item.HostConfig.PortBindings??{}).length
    ||item.Config.Image!==image||!item.HostConfig.Tmpfs?.['/var/lib/postgresql'])throw Error('restore_fixture_identity_mismatch');
  return item;
}
const specs=[];
let child,phase='create_container';
const stop=()=>{try{if(child?.pid)process.kill(-child.pid,'SIGTERM');}catch{}};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
async function ownedDatabase(role){
  const directory=await mkdtemp(join(tmpdir(),'fp-recovery-generation-')),socket=join(directory,'socket');
  await mkdir(socket);await chmod(socket,0o777);
  const database=role==='source'?'fp_recovery_generation':'fp_recovery_restored';
  const spec={role,directory,socket,database,name:`fp-recovery-generation-${role==='source'?'src':'dst'}-${randomUUID()}`,intent:join(directory,'container-intent.json'),id:'',cleanup:false,created:false};
  specs.push(spec);
  const intent=await open(spec.intent,'wx',0o600);
  try{await intent.writeFile(JSON.stringify({containerName:spec.name,socket,image,task,owner,database})+'\n');await intent.sync();}finally{await intent.close();}
  spec.created=true;spec.cleanup=false;
  spec.id=docker(['create','--name',spec.name,'--network','none','--label','freedom.task='+task,'--label','freedom.owner='+owner,
    '--tmpfs','/var/lib/postgresql:rw','--mount','type=bind,source='+socket+',target=/pgsocket','-e','PGHOST=/pgsocket','-e','POSTGRES_HOST_AUTH_METHOD=trust',
    '-e','POSTGRES_DB='+database,image,'postgres','-c','listen_addresses=','-c','unix_socket_directories=/pgsocket,/var/run/postgresql']).trim();
  if(!/^[0-9a-f]{64}$/.test(spec.id))throw Error('restore_fixture_identity_mismatch');
  inspected(spec,spec.id);docker(['start',spec.id]);
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    try{ready=docker(['exec',spec.id,'psql','-h','/pgsocket','-U','postgres','-d',database,'-Atqc','SELECT current_database()']).trim()===database;}catch{}
    if(ready)break;await delay(200);
  }
  if(!ready){console.error('Owned recovery-generation database '+role+' did not become ready.');throw Error('restore_fixture_start_failed');}
  const db=new URL('postgresql://postgres@localhost/'+database);db.searchParams.set('host',socket);
  return db.href;
}
try{
  phase='create_source';const sourceUrl=await ownedDatabase('source');
  phase='create_restore_target';const restoreUrl=await ownedDatabase('restore');
  phase='run_recovery_generation_drill';
  child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-timeout=840000','tests/integration/recovery-generation-restore.test.ts'],
    {cwd:root,detached:true,env:{...verificationEnvironment(),TEST_DATABASE_URL:sourceUrl,TEST_POSTGRES_CONTAINER_ID:specs[0].id,
      TEST_RESTORE_DATABASE_URL:restoreUrl,TEST_RESTORE_POSTGRES_CONTAINER_ID:specs[1].id,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','inherit','inherit']});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},900000);
  try{process.exitCode=await new Promise(done=>{child.once('error',()=>done(1));child.once('close',code=>done(timedOut?1:code??1));});}
  finally{clearTimeout(timer);}
}catch(error){console.error('Owned recovery-generation drill failed in '+phase+'; no remote deployment was attempted.');if(error instanceof Error&&error.message)console.error(error.message);process.exitCode=1;}
finally{
  for(const spec of specs){
    if(!spec.created)continue;
    try{
      if(!spec.id){
        for(let attempt=0;attempt<25;attempt++){try{spec.id=inspected(spec,spec.name).Id;break;}catch{await delay(200);}}
        if(!spec.id)throw Error('restore_create_outcome_unknown');
      }
      inspected(spec,spec.id);docker(['rm','-f',spec.id]);spec.cleanup=true;
    }catch{console.error('Owned recovery-generation container cleanup requires inspection; retained intent: '+spec.intent);process.exitCode=1;}
    if(!spec.cleanup)continue;
    try{const entries=await readdir(spec.socket);if(entries.some(name=>!['.s.PGSQL.5432','.s.PGSQL.5432.lock'].includes(name)))throw Error();
      for(const name of entries)await unlink(join(spec.socket,name));await rmdir(spec.socket);await unlink(spec.intent).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(spec.directory);
    }catch{console.error('Owned recovery-generation socket cleanup requires inspection.');process.exitCode=1;}
  }
}
