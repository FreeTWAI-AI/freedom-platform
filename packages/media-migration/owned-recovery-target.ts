import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,chmod,open,writeFile,readdir,unlink,rmdir,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
// @ts-expect-error Shared dependency-free verifier environment is implemented in JS.
import {verificationEnvironment} from '../contribution-tools/process-env.mjs';
import {createR2ObjectStore,type AssetR2Binding} from '../asset-storage/r2.js';
import type {ObjectStore} from '../asset-storage/index.js';
import {DUMP_MAX_BYTES,type DatabaseRestoreWriter} from './backup-archive.js';
import {assertPrivateRecoveryDirectory} from './recovery-bundle.js';

export const RECOVERY_POSTGRES_IMAGE='postgres:18-alpine@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd';
export const RECOVERY_TASK='media-recovery-handover';
export const RECOVERY_OWNER='media-recovery-restore';
export type RecoveryContainerRole='producer'|'consumer';
const DATABASE=/^fp_[a-z0-9_]{1,55}$/;
const SCHEMA=/^fp_[a-z0-9_]{0,62}$/;
const SOCKET_FILES=['.s.PGSQL.5432','.s.PGSQL.5432.lock'];
export class OwnedRecoveryTargetError extends Error {
  constructor(readonly code:'owned_recovery_target_unavailable'|'owned_restore_process_failed'='owned_recovery_target_unavailable'){super(code);this.name='OwnedRecoveryTargetError';}
}
function fail(code:OwnedRecoveryTargetError['code']='owned_recovery_target_unavailable'):never{throw new OwnedRecoveryTargetError(code);}
export interface OwnedRecoveryIdentity {
  readonly containerId:string;readonly name:string;readonly run:string;readonly socket:string;readonly role:RecoveryContainerRole;
}
interface DockerMount {Type?:string;Source?:string;Destination?:string}
interface DockerInspect {
  Id?:string;Name?:string;Config?:{Image?:string;Labels?:Record<string,string>};
  HostConfig?:{NetworkMode?:string;PortBindings?:Record<string,unknown>;Privileged?:boolean;Tmpfs?:Record<string,string>};
  Mounts?:DockerMount[];
}
const docker=(args:string[])=>execFileSync('docker',args,{env:verificationEnvironment(),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1024*1024}).trim();
function present(item:DockerInspect|undefined):DockerInspect{if(!item)fail();return item;}
function inspectRaw(reference:string):DockerInspect|undefined{
  try{
    const parsed:unknown=JSON.parse(docker(['inspect',reference]));
    if(!Array.isArray(parsed))fail();
    const first:unknown=parsed[0];
    if(typeof first!=='object'||first===null)fail();
    return first as DockerInspect;
  }catch(error){const stderr=error instanceof Error&&'stderr' in error?String((error as {stderr?:unknown}).stderr??''):'';
    const text=(stderr+'\n'+(error instanceof Error?error.message:'')).toLowerCase();
    if(text.includes('no such object')||text.includes('no such container'))return undefined;return fail();}
}
export function assertOwnedRecoveryIdentity(item:DockerInspect,identity:OwnedRecoveryIdentity):void{
  const binds=(item.Mounts??[]).filter(mount=>mount.Type==='bind');
  if(!/^[0-9a-f]{64}$/.test(item.Id??'')||item.Id!==identity.containerId||item.Name!=='/'+identity.name||item.Config?.Image!==RECOVERY_POSTGRES_IMAGE
    ||item.Config?.Labels?.['freedom.task']!==RECOVERY_TASK||item.Config?.Labels?.['freedom.owner']!==RECOVERY_OWNER
    ||item.Config?.Labels?.['freedom.role']!==identity.role||item.Config?.Labels?.['freedom.run']!==identity.run
    ||item.HostConfig?.NetworkMode!=='none'||Object.keys(item.HostConfig?.PortBindings??{}).length!==0||item.HostConfig?.Privileged===true
    ||!item.HostConfig?.Tmpfs?.['/var/lib/postgresql']||binds.length!==1
    ||binds[0]?.Source!==identity.socket||binds[0]?.Destination!=='/pgsocket')fail();
}
/** Refuse unless this exact owned container is present, then remove only that id. */
export function removeOwnedRecoveryContainer(identity:OwnedRecoveryIdentity):void{
  const item=present(inspectRaw(identity.containerId));assertOwnedRecoveryIdentity(item,identity);docker(['rm','-f',identity.containerId]);
}
/** Cleanup path: an already-absent owned container is done. A present container
 * is removed only after the same identity check; a mismatch is left untouched. */
export function discardOwnedRecoveryContainer(identity:OwnedRecoveryIdentity):void{
  const item=(identity.containerId?inspectRaw(identity.containerId):undefined)??inspectRaw(identity.name);
  if(!item?.Id)return;
  if(identity.containerId&&item.Id!==identity.containerId)fail();
  const resolved=Object.freeze({...identity,containerId:item.Id});
  assertOwnedRecoveryIdentity(item,resolved);docker(['rm','-f',resolved.containerId]);
}
function createArgs(identity:Omit<OwnedRecoveryIdentity,'containerId'>&{database:string}):string[]{
  return ['create','--pull','never','--name',identity.name,'--network','none','--label','freedom.task='+RECOVERY_TASK,'--label','freedom.owner='+RECOVERY_OWNER,
    '--label','freedom.role='+identity.role,'--label','freedom.run='+identity.run,'--tmpfs','/var/lib/postgresql:rw',
    '--mount','type=bind,source='+identity.socket+',target=/pgsocket','-e','PGHOST=/pgsocket','-e','POSTGRES_HOST_AUTH_METHOD=trust',
    '-e','POSTGRES_DB='+identity.database,RECOVERY_POSTGRES_IMAGE,'postgres','-c','listen_addresses=','-c','unix_socket_directories=/pgsocket,/var/run/postgresql'];
}
export interface OwnedRecoveryDatabase {readonly pool:Pool;readonly identity:OwnedRecoveryIdentity;readonly databaseName:string;close():Promise<void>}
/** Fresh owned PG18: network none, no published ports, tmpfs data, unix socket only.
 * Never accepts a URL or an existing container id. close() removes only this identity. */
export async function openOwnedRecoveryDatabase(input:{runDirectory:string;database:string;role:RecoveryContainerRole;signal:AbortSignal;
  searchPath?:string;prepareSchema?:boolean;max?:number}):Promise<OwnedRecoveryDatabase>{
  await assertPrivateRecoveryDirectory(input.runDirectory);
  if(!DATABASE.test(input.database)||(input.searchPath!==undefined&&!SCHEMA.test(input.searchPath))||!(input.signal instanceof AbortSignal)
    ||(input.prepareSchema===true&&!input.searchPath)||(input.max!==undefined&&(!Number.isSafeInteger(input.max)||input.max<1||input.max>8)))fail();
  const run=randomUUID(),name='fp-media-recovery-'+run,signal=input.signal;
  let socketRoot:string|undefined,socket:string|undefined,containerId='',attempted=false,pool:Pool|undefined,closed=false;
  const identity=():OwnedRecoveryIdentity=>Object.freeze({containerId,name,run,socket:socket!,role:input.role});
  async function close(){
    if(closed)return;closed=true;let failed=false;
    try{await pool?.end();}catch{failed=true;}
    try{
      if(attempted){
        if(!containerId){for(let attempt=0;attempt<25&&!containerId;attempt++){const found=inspectRaw(name);if(found?.Id){containerId=found.Id;break;}await delay(200);}}
        if(!containerId)fail();
        discardOwnedRecoveryContainer(identity());
      }
      if(socket&&socketRoot){const entries=await readdir(socket);
        if(entries.some(entry=>!SOCKET_FILES.includes(entry)))fail();
        for(const entry of entries)await unlink(join(socket,entry));await rmdir(socket);await rmdir(socketRoot);
      }
    }catch{failed=true;}
    if(failed)fail();
  }
  try{
    signal.throwIfAborted();socketRoot=await realpath(await mkdtemp('/tmp/fp-media-recovery-'));await chmod(socketRoot,0o700);
    await mkdir(join(socketRoot,'s'),{mode:0o777});await chmod(join(socketRoot,'s'),0o777);socket=await realpath(join(socketRoot,'s'));
    const planned=Object.freeze({name,run,socket,role:input.role,image:RECOVERY_POSTGRES_IMAGE,database:input.database});
    const intent=await open(join(input.runDirectory,'container-intent.json'),'wx',0o600);
    try{await intent.writeFile(JSON.stringify(planned)+'\n');await intent.sync();}finally{await intent.close();}
    const directory=await open(input.runDirectory,'r');try{await directory.sync();}finally{await directory.close();}
    signal.throwIfAborted();attempted=true;
    containerId=docker(createArgs({...planned,database:input.database}));
    if(!/^[0-9a-f]{64}$/.test(containerId))fail();
    const created=present(inspectRaw(containerId));assertOwnedRecoveryIdentity(created,identity());
    await writeFile(join(input.runDirectory,'container-intent.json'),JSON.stringify({...planned,containerId})+'\n',{mode:0o600});
    docker(['start',containerId]);
    let ready=false;for(let attempt=0;attempt<200&&!ready;attempt++){
      signal.throwIfAborted();
      try{ready=docker(['exec',containerId,'psql','-h','/pgsocket','-U','postgres','-d',input.database,'-Atqc','SELECT current_database()'])===input.database;}catch{ready=false;}
      if(!ready)await delay(200);
    }
    if(!ready)fail();
    const url=new URL(`postgresql://postgres@localhost/${input.database}`);url.searchParams.set('host',socket);
    if(input.prepareSchema&&input.searchPath){
      const admin=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000});
      try{await admin.query(`CREATE SCHEMA "${input.searchPath}"`);}finally{await admin.end();}
    }
    pool=new Pool({connectionString:url.href,max:input.max??4,connectionTimeoutMillis:5000,
      options:input.searchPath?`-c search_path=${input.searchPath} -c statement_timeout=30000`:'-c statement_timeout=30000'});
    const version=(await pool.query('SHOW server_version_num')).rows[0]?.server_version_num;
    if(typeof version!=='string'||version.slice(0,2)!=='18')fail();
    return Object.freeze({pool,identity:identity(),databaseName:input.database,close});
  }catch(error){await close().catch(()=>{});if(error instanceof OwnedRecoveryTargetError)throw error;return fail();}
}
export interface OwnedRecoveryTarget {
  readonly pool:Pool;readonly databaseName:string;readonly runtimeRole:string;
  readonly database:DatabaseRestoreWriter;readonly objects:ObjectStore;
  /** Local fixture tooling only. Not a remote deployment identity or credential. */
  readonly containerId:string;
}
/** Quarantine target. The digest stream is spooled to the end before pg_restore starts,
 * so a late digest failure cannot commit a database prefix. Cleanup cannot see a foreign container. */
export async function withOwnedRecoveryTarget<T>(input:{runDirectory:string;database:string;schema:string;signal:AbortSignal},
 operation:(target:Readonly<OwnedRecoveryTarget>)=>Promise<T>):Promise<{result:T;cleanupVerified:true;containerId:string}>{
  if(!SCHEMA.test(input.schema))fail();
  // Search path stays unset until pg_restore creates the manifest schema. Handover SQL is schema-qualified.
  const owned=await openOwnedRecoveryDatabase({runDirectory:input.runDirectory,database:input.database,role:'consumer',signal:input.signal});
  let mf:Miniflare|undefined,outbound=0,result:T|undefined,thrown:unknown;
  const spool=join(input.runDirectory,'restore.dump');
  async function restoreFile(path:string){
    input.signal.throwIfAborted();assertOwnedRecoveryIdentity(present(inspectRaw(owned.identity.containerId)),owned.identity);
    const child=spawn('docker',['exec','-i',owned.identity.containerId,'pg_restore','-U','postgres','--dbname',input.database,
      '--single-transaction','--exit-on-error','--no-owner','--no-privileges'],{env:verificationEnvironment(),stdio:['pipe','ignore','pipe'],detached:true});
    const stream=createReadStream(path);let unsuccessful=false;
    const abort=()=>{unsuccessful=true;stream.destroy();try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{/* already gone */}};
    const timer=setTimeout(abort,300000);input.signal.addEventListener('abort',abort,{once:true});
    child.stderr.resume();stream.on('error',abort);child.stdin.on('error',()=>{});stream.pipe(child.stdin);
    try{await new Promise<void>((done,reject)=>{child.once('error',()=>reject(fail('owned_restore_process_failed')));
      child.once('close',code=>{if(code===0&&!unsuccessful)done();else reject(fail('owned_restore_process_failed'));});});}
    finally{clearTimeout(timer);input.signal.removeEventListener('abort',abort);stream.destroy();}
  }
  try{
    await owned.pool.query('DROP SCHEMA public');
    mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',
      compatibilityDate:'2026-09-21',r2Buckets:['RESTORED'],outboundService:()=>{outbound++;return new Response(null,{status:503});}}));
    await mf.ready;
    const objects=createR2ObjectStore(await mf.getR2Bucket('RESTORED') as unknown as AssetR2Binding);
    const database:DatabaseRestoreWriter={async restore({database,schema,archive}){
      if(database!==input.database||schema!==input.schema)fail();input.signal.throwIfAborted();
      const file=await open(spool,'wx',0o600);let size=0;
      try{for await(const chunk of archive){input.signal.throwIfAborted();const bytes=chunk instanceof Uint8Array?chunk:fail();
        size+=bytes.byteLength;if(size>DUMP_MAX_BYTES)fail();
        let offset=0;while(offset<bytes.byteLength)offset+=(await file.write(bytes,offset,bytes.byteLength-offset)).bytesWritten;
      }await file.sync();}finally{await file.close();}
      await restoreFile(spool);
    }};
    result=await operation(Object.freeze({pool:owned.pool,databaseName:owned.databaseName,runtimeRole:'fp_recovery_app',database,objects,containerId:owned.identity.containerId}));
    if(outbound!==0)fail();input.signal.throwIfAborted();
  }catch(error){thrown=error;}
  let cleanupFailed=false;
  try{await mf?.dispose();}catch{cleanupFailed=true;}
  try{await owned.close();}catch{cleanupFailed=true;}
  if(cleanupFailed)fail();
  if(thrown)throw thrown;
  return {result:result as T,cleanupVerified:true,containerId:owned.identity.containerId};
}
