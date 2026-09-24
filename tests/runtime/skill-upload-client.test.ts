import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {serve} from '@hono/node-server';
import sharp from 'sharp';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';

test('real CLI uploads a private draft over HTTP, preserves owner review and loses access after key revocation',{timeout:30000},async()=>{
  const database=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema='fp_cli_http_'+randomUUID().replaceAll('-','');
  const admin=createPool(database),url=new URL(database);url.searchParams.set('options','-c search_path='+schema);
  const pool=createPool(url.href),temporary=await mkdtemp(join(tmpdir(),'fp-cli-http-'));
  const bin=fileURLToPath(new URL('../../packages/skill-upload-client/bin/freedom-skill-upload.mjs',import.meta.url));
  let server:ReturnType<typeof serve>|undefined,created=false;
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(pool);await seedLocal(pool);
    let app:ReturnType<typeof createApp>;
    const origin=await new Promise<string>(resolve=>{
      server=serve({fetch:request=>app.fetch(request),hostname:'127.0.0.1',port:0},info=>{
        const value='http://127.0.0.1:'+info.port;app=createApp(pool,value);resolve(value);
      });
    });
    type Session={cookie:string;csrf:string};
    const request=async(path:string,body?:unknown,session?:Session)=>{
      const response=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,
        ...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),
        ...(body!==undefined?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}: {})},
        body:body===undefined?undefined:JSON.stringify(body)});
      return {response,data:response.headers.get('content-type')?.includes('json')?await response.json() as any:null};
    };
    const signIn=async(email:string):Promise<Session>=>{
      const {response,data}=await request('/api/v1/auth/login',{email,password:DEMO_PASSWORD});assert.equal(response.status,200);
      return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf_token};
    };
    const owner=await signIn(DEMO_USERS[0].email),other=await signIn(DEMO_USERS[1].email);
    const issued=await request('/api/v1/me/skill-upload-keys',{label:'CLI HTTP 隔離驗證',expires_in_days:1},owner);
    assert.equal(issued.response.status,201);const secret=issued.data.token;assert.match(secret,/^fpk_/);

    // Redirect only this child process's os.homedir() to disposable private config;
    // the caller's HOME and any real upload configuration remain untouched.
    const preload=join(temporary,'preload.mjs');
    await writeFile(preload,"import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>process.env.FP_UPLOAD_TEST_HOME;syncBuiltinESMExports();\n",{mode:0o600});
    const cli=(args:string[],stdin='')=>new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import',preload,bin,...args],{
        env:{...process.env,FP_UPLOAD_TEST_HOME:temporary,FREEDOM_SKILL_UPLOAD_KEY:'',FREEDOM_SKILL_UPLOAD_GRANT:''},stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
      child.on('error',reject);child.on('close',code=>resolve({code:code??1,stdout,stderr}));child.stdin.end(stdin);
    });
    const init=await cli(['init','--origin',origin,'--key-stdin'],secret+'\n');
    assert.equal(init.code,0);assert.equal((init.stdout+init.stderr).includes(secret),false);
    const config=await stat(join(temporary,'.config','freedom-skill-upload','config.json'));assert.equal(config.mode&0o777,0o600);
    const payloadPath=join(temporary,'skill.json'),coverPath=join(temporary,'cover.png');
    await writeFile(payloadPath,JSON.stringify({repository_url:'https://github.com/example/project',title:'CLI HTTP 隔離技能',
      description:'驗證真實 CLI 經本機 HTTP 上傳私人草稿。',use_notes:'先閱讀專案 README，再整理筆記。',demo_url:null,relationship:'curator',
      share_introductions:Array.from({length:100},(_,index)=>`第 ${index+1} 則介紹：把專案筆記整理成團隊可讀的技能草稿。`)}),{mode:0o600});
    await sharp({create:{width:100,height:64,channels:3,background:'#c4ff20'}}).png().toFile(coverPath);
    const uploaded=await cli(['submit','--file',payloadPath,'--cover',coverPath,'--json']);
    assert.equal(uploaded.code,0);assert.equal((uploaded.stdout+uploaded.stderr).includes(secret),false);
    const summary=JSON.parse(uploaded.stdout);assert.equal(summary.status,'ready_for_review');assert.match(summary.submission_id,/^[a-f0-9-]{36}$/);
    const path='/api/v1/me/skill-submissions/'+summary.submission_id;
    const viewed=await request(path,undefined,owner);assert.equal(viewed.response.status,200);
    assert.equal(viewed.data.payload.share_introductions.length,100);assert.equal(viewed.data.public_path,null);
    assert.equal((await request(path,undefined,other)).response.status,404);
    const picture=await request(path+'/illustration',undefined,owner);assert.equal(picture.response.status,200);
    assert.equal(picture.response.headers.get('content-type'),'image/webp');
    const dimensions=await sharp(Buffer.from(await picture.response.arrayBuffer())).metadata();
    assert.equal(dimensions.width,1200);assert.equal(dimensions.height,630);
    assert.equal((await request(path+'/illustration',undefined,other)).response.status,404);
    const published=await request('/api/v1/skill-submissions/published');
    assert.equal(published.data.items.some((item:any)=>item.submission_id===summary.submission_id),false);
    assert.equal((await request('/development/submissions/'+summary.submission_id)).response.status,404);
    assert.equal((await request('/api/v1/skill-submissions/'+summary.submission_id+'/illustration')).response.status,404);
    const records=await pool.query('SELECT (SELECT count(*) FROM oss_projects) AS projects,(SELECT count(*) FROM skill_submissions WHERE consent_to_share) AS consented');
    assert.equal(Number(records.rows[0].projects),0);assert.equal(Number(records.rows[0].consented),0);
    assert.equal((await request('/api/v1/me/skill-upload-keys/'+issued.data.key.key_id+'/revoke',{},owner)).response.status,200);
    const revoked=await cli(['submit','--file',payloadPath,'--json']);
    assert.notEqual(revoked.code,0);assert.match(revoked.stderr,/upload_key_invalid/);assert.equal((revoked.stdout+revoked.stderr).includes(secret),false);
  }finally{
    if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
    await pool.end();if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
    await rm(temporary,{recursive:true,force:true});
  }
});
