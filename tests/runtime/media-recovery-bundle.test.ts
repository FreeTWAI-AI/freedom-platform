import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,link,symlink,unlink,chmod,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {objectKey,preparePrivateText} from '../../packages/asset-storage/index.js';
import {openRecoveryBundle,RecoveryBundleError} from '../../packages/media-migration/recovery-bundle.js';
import {recoverySetKeys} from '../../packages/media-migration/backup-archive.js';
const denied=(e:unknown)=>e instanceof RecoveryBundleError&&e.message==='recovery_bundle_unavailable';
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'fp-handover-bundle-')),setId=randomUUID(),keys=recoverySetKeys(setId);
 await mkdir(join(directory,'sealed','recovery-sets',setId),{recursive:true,mode:0o700});await mkdir(join(directory,'objects'),{mode:0o700});
 const key=objectKey({scopeId:randomUUID(),assetId:randomUUID(),representationId:randomUUID()});
 const body=new TextEncoder().encode('Synthetic portable private result');
 const value=await preparePrivateText(new ReadableStream({start(c){c.enqueue(body);c.close();}}),'text/plain',{revision:'synthetic-handover',platformPersistenceAllowed:true});
 const doc={key,metadata:value.metadata,bytes:Buffer.from(value.bytes).toString('base64')},encoded=JSON.stringify(doc)+'\n';
 const file=join(directory,'objects',key.replaceAll('/','_')+'.json');await writeFile(file,encoded,{mode:0o600});
 const manifest=join(directory,'sealed',keys.manifest);await writeFile(manifest,'synthetic-manifest',{mode:0o600});
 return {directory,setId,keys,key,value,doc,encoded,file,manifest};
}
test('Downloaded daily layout reads exact existing bytes and has no writing, listing or deletion authority',async()=>{
 const f=await fixture();try{
  const {archive,backupObjects}=await openRecoveryBundle(f.directory,f.setId);
  assert.equal(await new Response(await archive.get(f.keys.manifest)).text(),'synthetic-manifest');
  assert.deepEqual((await backupObjects.head(f.key))?.metadata,f.value.metadata);
  assert.deepEqual(new Uint8Array(await new Response((await backupObjects.get(f.key))!.body).arrayBuffer()),f.value.bytes);
  await assert.rejects(archive.putIfAbsent(f.keys.dump,new ReadableStream()),denied);await assert.rejects(archive.list('',1),denied);
  await assert.rejects(backupObjects.putImmutable(f.key,f.value),denied);await assert.rejects(backupObjects.delete(f.key),denied);
  await assert.rejects(archive.get('../private'),denied);await assert.rejects(backupObjects.get(f.key,{offset:0,length:1}),denied);
  assert.equal(await readFile(f.file,'utf8'),f.encoded);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('Downloaded object reader rejects corruption, duplicate keys, metadata mismatches and noncanonical base64',async()=>{
 const f=await fixture();try{
  const {backupObjects}=await openRecoveryBundle(f.directory,f.setId);
  const cases=[f.encoded.replace('"key":','"key":"ignored","key":'),JSON.stringify({...f.doc,bytes:f.doc.bytes+'\n'})+'\n',
   JSON.stringify({...f.doc,metadata:{...f.doc.metadata,byteSize:f.value.bytes.length+1}})+'\n',
   JSON.stringify({...f.doc,metadata:{...f.doc.metadata,sha256:'f'.repeat(64)}})+'\n',
   JSON.stringify({...f.doc,extra:true})+'\n',JSON.stringify({...f.doc,key:objectKey({scopeId:randomUUID(),assetId:randomUUID(),representationId:randomUUID()})})+'\n'];
  for(const encoded of cases){await writeFile(f.file,encoded);await assert.rejects(backupObjects.get(f.key),denied);}
  await writeFile(f.file,f.encoded);assert(await backupObjects.head(f.key));
  await truncate(f.file,40*1024*1024);await assert.rejects(backupObjects.head(f.key),denied);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('Bundle and nested readers reject public permissions, links and nonregular source files',async()=>{
 const f=await fixture();try{
  const {archive,backupObjects}=await openRecoveryBundle(f.directory,f.setId);
  await link(f.file,f.file+'.linked');await assert.rejects(backupObjects.head(f.key),denied);await unlink(f.file+'.linked');
  await link(f.manifest,f.manifest+'.linked');await assert.rejects(archive.get(f.keys.manifest),denied);await unlink(f.manifest+'.linked');
  await chmod(f.file,0o644);await assert.rejects(backupObjects.head(f.key),denied);await chmod(f.file,0o600);
  await unlink(f.file);await symlink(f.manifest,f.file);await assert.rejects(backupObjects.head(f.key),denied);
  await chmod(f.directory,0o755);await assert.rejects(openRecoveryBundle(f.directory,f.setId),denied);await chmod(f.directory,0o700);
  await assert.rejects(openRecoveryBundle(f.directory+'/../'+f.directory.split('/').at(-1),f.setId),denied);
 }finally{await rm(f.directory,{recursive:true,force:true});}
});
