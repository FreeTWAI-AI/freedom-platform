import {readFile,mkdir,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,isAbsolute} from 'node:path';
const base=process.env.FREEDOM_REPOSITORIES_ROOT;
if(!base||!isAbsolute(base))throw Error('Set absolute FREEDOM_REPOSITORIES_ROOT outside this source tree');
const lock=JSON.parse(await readFile(new URL('../repositories.lock.json',import.meta.url),'utf8'));
await mkdir(base,{recursive:true});
for(const entry of lock.repositories){
 if(!/^FreeTWAI-AI\/(?:freedom-[a-z-]+|\.github|FreeTWAI-AI\.github\.io)$/.test(entry.repository)||!/^[a-f0-9]{40}$/.test(entry.commit))throw Error('Invalid pinned repository');
 const path=resolve(base,entry.repository.split('/')[1]);let exists=true;try{await access(path);}catch{exists=false;}
 if(!exists){execFileSync('git',['clone','--quiet','--no-checkout',`https://github.com/${entry.repository}.git`,path],{stdio:'inherit'});execFileSync('git',['checkout','--quiet','--detach',entry.commit],{cwd:path,stdio:'inherit'});}
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:path,encoding:'utf8'}).trim();
 const dirty=execFileSync('git',['status','--porcelain'],{cwd:path,encoding:'utf8'}).trim();
 if(head!==entry.commit||dirty)throw Error(`Existing checkout differs from lock or is dirty: ${entry.repository}; use a fresh directory`);
 console.log(`${entry.repository}@${head.slice(0,12)}`);
}
