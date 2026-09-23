// Run after committing the bundle; consumer pins always point to committed bytes.
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const destinations=process.argv.slice(2);if(!destinations.length)throw Error('Pass consumer repository directories');
const source=resolve(root,'contracts/preview/v1');
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const bytes=await readFile(resolve(source,'bundle.json')),bundle=JSON.parse(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
for(const name of ['bundle.json',...Object.keys(bundle.files)]){
 const committed=execFileSync('git',['show',`${sha}:contracts/preview/v1/${name}`],{cwd:root});
 if(!committed.equals(await readFile(resolve(source,name))))throw Error('Commit canonical bundle before exporting');
}
for(const destination of destinations){
 const target=resolve(destination),vendor=resolve(target,'vendor/freedom-platform');await mkdir(vendor,{recursive:true});
 for(const name of ['bundle.json',...Object.keys(bundle.files)]){await mkdir(dirname(resolve(vendor,name)),{recursive:true});await cp(resolve(source,name),resolve(vendor,name));}
 await writeFile(resolve(target,'contracts.lock.json'),JSON.stringify({format:'freedom.contract-pin/v1',source_repository:'FreeTWAI-AI/freedom-platform',source_commit:sha,bundle_path:'contracts/preview/v1',protocol:bundle.protocol,protocol_sha256:bundle.protocol_sha256,bundle_sha256:hash(bytes)},null,2)+'\n');
 await mkdir(resolve(target,'scripts'),{recursive:true});
 for(const name of ['verify-contracts.mjs','verify-project-manifest.py'])await cp(resolve(root,'scripts/repository-bootstrap',name),resolve(target,'scripts',name));
 console.log('Pinned contract in',target);
}
