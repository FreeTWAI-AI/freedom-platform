// Fixed container driver. Host observes protocol independently of captured output.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  const frame=JSON.parse(line),input=JSON.parse(Buffer.from(frame.body,'base64'));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=128','--no-addons','--import=/device-preload.mjs',
      '/candidate/src/device-cli.mjs',...input.args],{env:{PATH:'/usr/bin:/bin',TMPDIR:'/tmp',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
    let output='',stderr='',size=0,cancelled=false;
    const collect=(bytes,isOutput)=>{
      if((size+=bytes.length)>65536){child.kill('SIGKILL');reject(Error('cli_output_limit'));return;}
      if(isOutput)output+=bytes.toString();else stderr+=bytes.toString();
      if(input.cancel&&!cancelled&&output.includes('\n')){cancelled=true;child.kill('SIGINT');}
    };
    child.stdout.on('data',bytes=>collect(bytes,true));child.stderr.on('data',bytes=>collect(bytes,false));
    child.on('error',reject);child.on('close',(exit_code,signal)=>resolve({exit_code,signal,output,stderr}));
  });
  process.stdout.write(JSON.stringify({id:frame.id,status:200,headers:[['content-type','application/json']],
    body:Buffer.from(JSON.stringify(result)).toString('base64')})+'\n');
}
