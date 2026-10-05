// Creates only a marker-owned disposable PostgreSQL server. No inherited DB
// URL, credentials, ports, production settings or remote migration commands.
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {mkdtemp,chmod,mkdir,readdir,unlink,rmdir,writeFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {verificationEnvironment} from '../packages/contribution-tools/process-env.mjs';
const image='postgres:18-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd';
const args=process.argv.slice(2);
if(args.length>1||(args.length===1&&args[0]!=='--archive-only')){
  console.error('Usage: node scripts/run-media-restore-test.mjs [--archive-only]');process.exit(2);
}
const testFile=args[0]==='--archive-only'?'tests/integration/media-backup-archive.test.ts':'tests/integration/media-backup-restore.test.ts';
const task='media-restore-drill',owner='run-media-restore-test';
const directory=await mkdtemp(join(tmpdir(),'fp-media-restore-')),socket=join(directory,'socket');
await mkdir(socket);await chmod(socket,0o777);
const containerName='fp-media-restore-'+randomUUID(),intentPath=join(directory,'container-intent.json');
let container,child,createAttempted=false,cleanupComplete=true,phase='create_container';
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1024*1024});
function inspected(reference=container){
  const item=JSON.parse(docker(['inspect',reference]))[0];
  if(!/^[0-9a-f]{64}$/.test(item.Id)||(container&&item.Id!==container)||item.Name!=='/'+containerName
    ||!item.Mounts?.some(m=>m.Type==='bind'&&m.Source===socket&&m.Destination==='/pgsocket')||item.Config.Labels?.['freedom.task']!==task||item.Config.Labels?.['freedom.owner']!==owner
    ||item.HostConfig.NetworkMode!=='none'||Object.keys(item.HostConfig.PortBindings??{}).length
    ||item.Config.Image!==image||!item.HostConfig.Tmpfs?.['/var/lib/postgresql'])throw Error('restore_fixture_identity_mismatch');
  return item;
}
const stop=()=>{try{if(child?.pid)process.kill(-child.pid,'SIGTERM');}catch{}};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
try{
  const intent=await open(intentPath,'wx',0o600);try{await intent.writeFile(JSON.stringify({containerName,socket,image,task,owner})+'\n');await intent.sync();}finally{await intent.close();}
  createAttempted=true;cleanupComplete=false;
  container=docker(['create','--name',containerName,'--network','none',
    '--label','freedom.task='+task,'--label','freedom.owner='+owner,'--tmpfs','/var/lib/postgresql:rw',
    '--mount','type=bind,source='+socket+',target=/pgsocket','-e','PGHOST=/pgsocket','-e','POSTGRES_HOST_AUTH_METHOD=trust',
    // The stock image initializes through /var/run/postgresql even when PGHOST
    // is set. Keep that private container socket alongside the mounted test one.
    '-e','POSTGRES_DB=fp_media_restore',image,'postgres','-c','listen_addresses=','-c','unix_socket_directories=/pgsocket,/var/run/postgresql']).trim();
  phase='verify_container';if(!/^[0-9a-f]{64}$/.test(container))throw Error('restore_fixture_identity_mismatch');inspected();
  phase='start_container';docker(['start',container]);
  phase='wait_for_database';
  let ready=false;for(let attempt=0;attempt<100;attempt++){
    try{ready=docker(['exec',container,'psql','-h','/pgsocket','-U','postgres','-d','fp_media_restore','-Atqc','SELECT current_database()']).trim()==='fp_media_restore';}catch{}
    if(ready)break;await delay(200);
  }
  if(!ready){
    const logs=spawnSync('docker',['logs','--tail','40',container],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    await mkdir('.freedom/reports',{recursive:true});
    await writeFile('.freedom/reports/media-restore-setup.log',(logs.stdout??'')+(logs.stderr??''),{mode:0o600});
    throw Error('restore_fixture_start_failed');
  }
  const db=new URL('postgresql://postgres@localhost/fp_media_restore');db.searchParams.set('host',socket);
  phase='run_restore_tests';child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1',testFile],
    {cwd:resolve(new URL('..',import.meta.url).pathname),detached:true,env:{...verificationEnvironment(),
      TEST_DATABASE_URL:db.href,TEST_POSTGRES_CONTAINER_ID:container,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','inherit','inherit']});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},120000);
  try{process.exitCode=await new Promise(done=>{child.once('error',()=>done(1));child.once('close',code=>done(timedOut?1:code??1));});}
  finally{clearTimeout(timer);}
}catch{console.error('Owned media restore drill failed in '+phase+'; no remote deployment was attempted.');process.exitCode=1;}
finally{
  if(createAttempted){
    try{
      // A timed-out create can commit after its caller loses the acknowledgement.
      // Never retry creation or remove the intent/socket while ownership is unknown.
      if(!container){
        for(let attempt=0;attempt<25;attempt++){
          try{container=inspected(containerName).Id;break;}catch{await delay(200);}
        }
        if(!container)throw Error('restore_create_outcome_unknown');
      }
      inspected();docker(['rm','-f',container]);cleanupComplete=true;
    }catch{console.error('Owned restore container cleanup requires inspection; retained intent: '+intentPath);process.exitCode=1;}
  }
  if(cleanupComplete){
  // Remove only known server socket entries from this run's own directory.
  try{const entries=await readdir(socket);if(entries.some(name=>!['.s.PGSQL.5432','.s.PGSQL.5432.lock'].includes(name)))throw Error();
    for(const name of entries)await unlink(join(socket,name));await rmdir(socket);await unlink(intentPath).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(directory);
  }catch{console.error('Owned restore socket cleanup requires inspection.');process.exitCode=1;}
  }
}
