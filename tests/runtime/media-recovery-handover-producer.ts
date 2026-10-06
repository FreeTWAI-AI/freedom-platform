// Producer half of the portable handover. Owns one PG18 container and a native
// local R2 bucket, migrates the installed catalog, seals the existing layout, then
// removes that container before exiting. It never publishes a port or keeps a pool
// for the consumer.
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod,lstat,mkdir,open,readFile,readdir,rename} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import sharp from 'sharp';
import {createAssetMaintenance} from '../../modules/assets/maintenance.js';
import type {Actor} from '../../modules/identity-membership/service.js';
import {createR2ObjectStore,type AssetR2Binding} from '../../packages/asset-storage/r2.js';
import {objectKey,readVerifiedObject,sha256,writeVerifiedObject,type ObjectMetadata} from '../../packages/asset-storage/index.js';
// @ts-expect-error Shared dependency-free verifier environment is implemented in JS.
import {verificationEnvironment} from '../../packages/contribution-tools/process-env.mjs';
import {createFileArchiveStore} from '../../packages/media-migration/backup-archive-fs.js';
import {sealRecoverySet} from '../../packages/media-migration/backup-archive.js';
import {createConsistentAssetBackup} from '../../packages/media-migration/backup-coordinator.js';
import {openOwnedRecoveryDatabase} from '../../packages/media-migration/owned-recovery-target.js';
import {openRecoveryBundle} from '../../packages/media-migration/recovery-bundle.js';
import {recoverySessionFingerprint} from '../../packages/media-migration/recovery-handover.js';
import {withMemberScope} from '../../packages/resource-scopes/index.js';
import {migrate} from '../../scripts/database.js';

const DATABASE='fp_b3_source',SCHEMA='fp_b3_src';
const note=(phase:string)=>process.stderr.write(`producer:${phase}\n`);
function safe(error:unknown):string{
  const pg=error&&typeof error==='object'&&'code' in error?String((error as {code:unknown}).code):'';
  const message=/^[0-9A-Z]{5}$/.test(pg)?pg:error instanceof Error?error.message:'';
  return /^[a-z0-9_:.]+$/.test(message)?message:'producer_failed';
}
async function pgDump(containerId:string,args:string[]):Promise<Buffer>{
  const child=spawn('docker',['exec',containerId,'pg_dump','-U','postgres',...args],{env:verificationEnvironment(),stdio:['ignore','pipe','pipe'],detached:true});
  const chunks:Buffer[]=[];let size=0,failed=false;
  const stop=()=>{failed=true;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{/* already gone */}};
  const timer=setTimeout(stop,180000);
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>64*1024*1024)stop();else chunks.push(chunk);});
  child.stderr.resume();
  try{await new Promise<void>((done,reject)=>{child.once('error',()=>reject(new Error('producer_failed')));child.once('close',code=>code===0&&!failed?done():reject(new Error('producer_failed')));});
    return Buffer.concat(chunks,size);
  }finally{clearTimeout(timer);}
}
async function writePrivate(path:string,body:string|Buffer){
  const file=await open(path,'wx',0o600);try{await file.writeFile(body);await file.sync();}finally{await file.close();}
}
/** The archive store creates directories under the process umask. The handed-over
 * tree must still be owner-only before a separate consumer is allowed to read it. */
async function tighten(path:string):Promise<void>{
  const stat=await lstat(path);
  if(stat.isSymbolicLink())throw new Error('producer_failed');
  await chmod(path,stat.isDirectory()?0o700:0o600);
  if(stat.isDirectory())for(const name of await readdir(path))await tighten(join(path,name));
}

export async function produceRecoveryHandover(handoff:string,work:string,sourceRelease:string):Promise<void>{
  if(![handoff,work].every(path=>isAbsolute(path)&&resolve(path)===path)||!/^[a-f0-9]{40}$/.test(sourceRelease))throw new Error('producer_failed');
  if(handoff===work||handoff.startsWith(work+'/')||work.startsWith(handoff+'/'))throw new Error('producer_failed');
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  const sealed=join(handoff,'sealed'),objects=join(handoff,'objects');
  await mkdir(sealed,{mode:0o700});await mkdir(objects,{mode:0o700});
  note('open');
  const db=await openOwnedRecoveryDatabase({runDirectory:work,database:DATABASE,role:'producer',signal:controller.signal,searchPath:SCHEMA,prepareSchema:true,max:4});
  let mf:Miniflare|undefined,outbound=0;
  try{
    note('migrate');await migrate(db.pool);
    mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null,{status:503})}}',
      compatibilityDate:'2026-09-21',r2Buckets:['SOURCE','BACKUP'],outboundService:()=>{outbound++;return new Response(null,{status:503});}}));
    await mf.ready;
    const source=createR2ObjectStore(await mf.getR2Bucket('SOURCE') as unknown as AssetR2Binding);
    const backupObjects=createR2ObjectStore(await mf.getR2Bucket('BACKUP') as unknown as AssetR2Binding);
    await db.pool.query(`UPDATE asset_maintenance_policy SET enabled=true,revision='synthetic-handover',orphan_retention_seconds=1,
      retired_retention_seconds=1,delete_lease_seconds=30,capture_seconds=120,pin_seconds=120,max_capture_objects=10`);
    async function asset(){
      const community=randomUUID(),userId=randomUUID(),session=randomUUID(),assetId=randomUUID(),representationId=randomUUID();
      await db.pool.query("INSERT INTO communities VALUES($1,'Synthetic handover owner')",[community]);
      const user=(await db.pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
        VALUES($1,$2,$3,'Synthetic handover owner','not-a-login-hash',$4) RETURNING *`,[userId,community,userId+'@example.invalid',randomUUID()])).rows[0];
      await db.pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[session,userId]);
      const actor={...user,session_hash:session,csrf_token:'synthetic'} as Actor;
      const context=await withMemberScope(db.pool,{actor,scope:'personal'},async()=>{},async(_query,scope)=>scope),scopeId=context.scope.scope_id;
      await db.pool.query(`INSERT INTO assets(asset_id,scope_id,owner_principal_id,owner_user_id,policy_revision,representation_id,created_at)
        VALUES($1,$2,$3,$4,'synthetic-content',$5,clock_timestamp()-interval '1 hour')`,[assetId,scopeId,context.subject_principal.principal_id,userId,representationId]);
      const bytes=new Uint8Array(await sharp({create:{width:256,height:256,channels:3,background:'red'}}).webp().toBuffer());
      const metadata:ObjectMetadata={contentType:'image/webp',byteSize:bytes.length,sha256:await sha256(bytes),transformVersion:'avatar.webp.v1',policyRevision:'synthetic-content'};
      const key=objectKey({scopeId,assetId,representationId});
      await writeVerifiedObject(source,key,{bytes,metadata},{revision:metadata.policyRevision,platformPersistenceAllowed:true});
      await db.pool.query(`INSERT INTO asset_objects(asset_id,scope_id,representation_id,content_type,byte_size,content_sha256,transform_version,policy_revision)
        VALUES($1,$2,$3,'image/webp',$4,$5,'avatar.webp.v1','synthetic-content')`,[assetId,scopeId,representationId,bytes.length,metadata.sha256]);
      await db.pool.query("UPDATE assets SET state='ready',ready_at=clock_timestamp()-interval '1 hour' WHERE asset_id=$1",[assetId]);
      return {assetId,key,bytes,metadata,session};
    }
    note('capture');
    const first=await asset();
    const maintenance=createAssetMaintenance(db.pool,{store:source,enabled:true});
    const dumpPath=join(work,'captured.dump');let late:Awaited<ReturnType<typeof asset>>|undefined;
    const backup=await createConsistentAssetBackup(db.pool,{enabled:true,target:{database:DATABASE,sourceSchema:SCHEMA,sourceRelease},
      maintenance,source,destination:backupObjects,snapshotEvidence:true,databaseSnapshot:{async write(input){
        late=await asset();
        const dump=await pgDump(db.identity.containerId,['--dbname',input.database,'--schema',input.schema,'--snapshot',input.snapshotId,'--format=custom','--no-owner','--no-privileges']);
        const partial=dumpPath+'.partial';await writePrivate(partial,dump);await rename(partial,dumpPath);
        return {sha256:createHash('sha256').update(dump).digest('hex'),byteSize:dump.length};
      }}});
    if(!late||backup.objects.objects.length!==1||backup.objects.objects.some(entry=>entry.key===late!.key)||!backup.evidence)throw new Error('producer_failed');
    if(outbound!==0)throw new Error('producer_failed');
    note('seal');
    const archive=await createFileArchiveStore(sealed),setId=randomUUID();
    const sealedSet=await sealRecoverySet({backup,setId,environment:'local',createdAt:new Date().toISOString(),
      dump:{async open(){return Readable.toWeb(createReadStream(dumpPath)) as ReadableStream<Uint8Array>;}},archive,backupObjects});
    const entries=[];
    for(const entry of backup.objects.objects){
      const read=await readVerifiedObject(backupObjects,entry.key,entry.metadata);
      if(entry.key!==first.key||!Buffer.from(read.bytes).equals(Buffer.from(first.bytes)))throw new Error('producer_failed');
      const body=JSON.stringify({key:entry.key,metadata:entry.metadata,bytes:Buffer.from(read.bytes).toString('base64')})+'\n';
      await writePrivate(join(objects,entry.key.replaceAll('/','_')+'.json'),body);
      entries.push({key:entry.key,sha256:entry.metadata.sha256,byteSize:entry.metadata.byteSize});
    }
    await tighten(handoff);
    const bundle=await openRecoveryBundle(handoff,setId);
    const head=await bundle.backupObjects.head(first.key);
    if(head?.metadata.sha256!==first.metadata.sha256)throw new Error('producer_failed');
    const manifestPath=join(sealed,'recovery-sets',setId,'recovery-set.json');
    const manifestBytes=await readFile(manifestPath);
    if(createHash('sha256').update(manifestBytes).digest('hex')!==sealedSet.manifestSha256)throw new Error('producer_failed');
    const expectations={format:'freedom.recovery-handover-expectations/v1',setId,manifestSha256:sealedSet.manifestSha256,
      environment:'local',database:DATABASE,schema:SCHEMA,sourceRelease,assetIds:[first.assetId],excludedAssetId:late.assetId,
      sessionFingerprint:recoverySessionFingerprint([first.session]),unfencedSessions:1,objects:entries,
      containerId:db.identity.containerId,containerName:db.identity.name};
    await writePrivate(join(work,'expectations.json'),JSON.stringify(expectations)+'\n');
    note('sealed');
  }finally{
    let cleanupFailed=false;
    try{await mf?.dispose();}catch{cleanupFailed=true;}
    try{await db.close();}catch{cleanupFailed=true;}
    process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
    if(cleanupFailed)throw new Error('producer_failed');
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [handoff,work,sourceRelease]=process.argv.slice(2);
  produceRecoveryHandover(handoff??'',work??'',sourceRelease??'').catch(error=>{process.stderr.write(safe(error)+'\n');process.exitCode=1;});
}
