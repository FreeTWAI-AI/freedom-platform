import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=await mkdtemp(resolve(tmpdir(),'freedom-skill-package-'));
try{
  // npm run supplies npm_execpath; launch its JS entry through the current Node
  // runtime so Windows does not need to spawn npm.cmd through a shell.
  const npmCli=process.env.npm_execpath;
  const result=JSON.parse(execFileSync(npmCli?process.execPath:'npm',[
    ...(npmCli?[npmCli]:[]),'pack','--json','--ignore-scripts','--pack-destination',temporary,
  ],{cwd:resolve(root,'packages/skill-upload-client'),encoding:'utf8'}));
  if(result.length!==1||!/^[a-zA-Z0-9._-]+\.tgz$/.test(result[0].filename))throw new Error('Unexpected skill client package');
  const target=resolve(root,'apps/portal-web/public/downloads');await mkdir(target,{recursive:true});
  await copyFile(resolve(temporary,result[0].filename),resolve(target,'freedom-skill-client.tgz'));
}finally{await rm(temporary,{recursive:true,force:true});}
