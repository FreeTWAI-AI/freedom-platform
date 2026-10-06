import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {assertObjectKey,validateMetadata,OBJECT_IO_MAX_BYTES,type AssetObjectKey,type ObjectMetadata,type ObjectStore} from '../asset-storage/index.js';
import {createFileArchiveStore} from './backup-archive-fs.js';
import {recoverySetKeys,DUMP_MAX_BYTES,RECOVERY_MANIFEST_MAX_BYTES,type ArchiveStore} from './backup-archive.js';
import {EVIDENCE_MAX_BYTES} from './backup-evidence.js';

/** Read only the existing downloaded daily layout: sealed/ plus objects/.
 * No archive extraction, provider access, source DB, writes or deletion.
 * Expected manifest provenance is enforced by the existing recovery loader. */
export class RecoveryBundleError extends Error {
  constructor(){super('recovery_bundle_unavailable');this.name='RecoveryBundleError';}
}
const fail=():never=>{throw new RecoveryBundleError();};
export async function assertPrivateRecoveryDirectory(path:string):Promise<void>{
  try{
    if(!isAbsolute(path)||await realpath(path)!==path)fail();
    const stat=await lstat(path);
    if(!stat.isDirectory()||stat.uid!==process.getuid!()||(stat.mode&0o077)!==0)fail();
  }catch{fail();}
}
async function regular(path:string,max:number):Promise<boolean>{
  try{
    const stat=await lstat(path);
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid!()||(stat.mode&0o077)!==0||stat.size>max)fail();
    return true;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;return fail();}
}
async function bytes(path:string,max:number):Promise<Buffer|null>{
  if(!await regular(path,max))return null;
  let file;
  try{
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=await file.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid!()||(stat.mode&0o077)!==0||stat.size>max)fail();
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of file.createReadStream({autoClose:false,highWaterMark:64*1024})){
      size+=chunk.length;if(size>max)fail();chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks,size);
  }catch{return fail();}finally{await file?.close();}
}
export async function openRecoveryBundle(directory:string,setId:string):Promise<{archive:ArchiveStore;backupObjects:ObjectStore}>{
  try{
    const keys=recoverySetKeys(setId),sealed=join(directory,'sealed'),objects=join(directory,'objects');
    await assertPrivateRecoveryDirectory(directory);await assertPrivateRecoveryDirectory(sealed);await assertPrivateRecoveryDirectory(objects);
    await assertPrivateRecoveryDirectory(join(sealed,'recovery-sets'));await assertPrivateRecoveryDirectory(join(sealed,'recovery-sets',setId));
    const underlying=await createFileArchiveStore(sealed);
    const allowed=new Map<string,number>([[keys.manifest,RECOVERY_MANIFEST_MAX_BYTES],[keys.dump,DUMP_MAX_BYTES],[keys.evidence,EVIDENCE_MAX_BYTES]]);
    const archive:ArchiveStore=Object.freeze({
      async get(key:string){const max=allowed.get(key);if(max===undefined)fail();
        await assertPrivateRecoveryDirectory(join(sealed,'recovery-sets',setId));
        if(!await regular(join(sealed,key),max!))return null;return underlying.get(key);},
      async putIfAbsent(){return fail();},async list(){return fail();},
    });
    const object=async(key:AssetObjectKey)=>{
      assertObjectKey(key);await assertPrivateRecoveryDirectory(objects);
      const raw=await bytes(join(objects,key.replaceAll('/','_')+'.json'),4*Math.ceil(OBJECT_IO_MAX_BYTES/3)+2048);
      if(raw===null)return null;
      const text=new TextDecoder('utf-8',{fatal:true}).decode(raw),doc=JSON.parse(text);
      if(!doc||Object.keys(doc).sort().join(',')!=='bytes,key,metadata'||doc.key!==key||typeof doc.bytes!=='string')fail();
      validateMetadata(doc.metadata);
      // Matches the installed writer, including the final newline. This also
      // rejects duplicate decoded keys and alternate noncanonical base64.
      if(JSON.stringify({key:doc.key,metadata:doc.metadata,bytes:doc.bytes})+'\n'!==text)fail();
      const content=Buffer.from(doc.bytes,'base64');
      if(content.toString('base64')!==doc.bytes||content.length!==doc.metadata.byteSize
        ||createHash('sha256').update(content).digest('hex')!==doc.metadata.sha256)fail();
      return {metadata:Object.freeze({...doc.metadata}) as ObjectMetadata,content};
    };
    const backupObjects:ObjectStore=Object.freeze({
      async head(key:AssetObjectKey){try{const found=await object(key);return found?{metadata:found.metadata,etag:found.metadata.sha256}:null;}catch{return fail();}},
      async get(key:AssetObjectKey,range?:unknown){try{if(range!==undefined)fail();const found=await object(key);return found?{metadata:found.metadata,etag:found.metadata.sha256,
        body:new ReadableStream<Uint8Array>({start(c){c.enqueue(found.content);c.close();}})}:null;}catch{return fail();}},
      async putImmutable(){return fail();},async delete(){return fail();},
    });
    return Object.freeze({archive,backupObjects});
  }catch{return fail();}
}
