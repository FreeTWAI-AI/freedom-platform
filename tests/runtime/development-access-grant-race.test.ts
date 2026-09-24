import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {createPool,LOCAL_DATABASE_URL,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {tokenHash,type Actor} from '../../modules/identity-membership/service.js';
import {GitHubSocial} from '../../modules/github-social/service.js';
import {DevelopmentAccess,DEVELOPMENT_POLICY} from '../../modules/development-access/service.js';
import {changeGuildMembership} from '../../modules/positioning/service.js';

// Deterministic interleaving: a holder transaction owns github-social/<user>,
// the same-member OAuth reconnect queues behind it, then a grant-backed write
// queues behind the reconnect. Every step is confirmed via pg_stat_activity /
// pg_blocking_pids before the holder releases; nothing relies on sleep timing.
const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_grant_race_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`,admin=createPool(url);
const named=(name:string)=>new Pool({connectionString:url,options:`-c search_path=${schema}`,application_name:`${schema}/${name}`,max:4});
const pool=named('setup'),reconnectPool=named('reconnect'),waiterPool=named('waiter');
const origin='http://127.0.0.1:4310',config={clientId:'Iv1.synthetic',clientSecret:'synthetic-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:origin+'/github/callback',appId:'9',appSlug:'synthetic-app'};
const target='video-autopilot',working='https://github.com/contributor/video-autopilot-kit';
const proposal={title:'競態測試提案',summary:'合成測試；所有 GitHub 呼叫都是本機假資料。',pr_url:null};
// Synthetic GitHub only: the reconnect returns the SAME GitHub user ID 42.
const fetcher:typeof fetch=async(input,init={})=>{
 const url=String(input);assert.equal(init.redirect,'error');
 if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'ghu_synthetic',token_type:'bearer',scope:''});
 if(url==='https://api.github.com/user')return Response.json({id:42,login:'contributor'});
 if(url.startsWith('https://api.github.com/user/installations?'))return Response.json({installations:[{id:77,app_id:9,account:{id:42},suspended_at:null,permissions:{metadata:'read'}}]});
 if(url.includes('/repositories?'))return Response.json({repositories:[{id:200,full_name:'contributor/video-autopilot-kit',private:false,permissions:{push:true}}]});
 if(url.includes('/repos/')){const name=url.split('/repos/')[1],own=name.startsWith('contributor/');return Response.json({id:own?200:100,full_name:name,private:false,archived:false,owner:{id:own?42:7},permissions:{push:true},...(own?{source:{id:100}}:{})});}
 throw Error('Unexpected GitHub fixture: '+url);
};
let actor:Actor;
const command=(body:unknown={},operation='race-test',key=randomUUID()):Command=>({actor,body,operation,key});
const setupSocial=()=>new GitHubSocial(pool,config,fetcher),setup=()=>new DevelopmentAccess(pool,setupSocial());
const reconnectSocial=()=>new GitHubSocial(reconnectPool,config,fetcher);
const waiterService=()=>new DevelopmentAccess(waiterPool,new GitHubSocial(waiterPool,config,fetcher));

async function enable(){
 await changeGuildMembership(pool,{...command({},'join'),expected:undefined},'guild_ai_vibe','join');
 const social=setupSocial(),pending=await social.start(actor,'#skills');
 await social.complete(actor,new URL(pending.authorization_url).searchParams.get('state')!,'synthetic-code');
 const service=setup();
 await service.consent(command({policy_version:DEVELOPMENT_POLICY,accepted:true},'consent'),'skill',target);
 return service.activate(command({working_repository_url:working},'activate'),'skill',target);
}
type Backend={pid:number;wait_event_type:string|null;query:string;blockers:number[]};
async function backends(name:string):Promise<Backend[]>{
 return (await admin.query(`SELECT pid,wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=$1 AND state='active'`,[`${schema}/${name}`])).rows;
}
// Poll a database condition (bounded deadline); the barrier is lock state, not elapsed time.
async function until<T>(label:string,probe:()=>Promise<T|undefined>):Promise<T>{
 const deadline=Date.now()+10_000;
 for(;;){const value=await probe();if(value!==undefined)return value;if(Date.now()>deadline)throw Error('Barrier timeout: '+label);await new Promise(resolve=>setTimeout(resolve,5));}
}
const blockedOn=(name:string,...pids:number[])=>until(name+' blocked',async()=>(await backends(name)).find(row=>row.wait_event_type==='Lock'&&/pg_advisory_xact_lock/.test(row.query)&&pids.every(pid=>row.blockers.includes(pid))));
const settle=<T>(promise:Promise<T>)=>promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));

async function behindReconnect<T>(waiter:()=>Promise<T>){
 const pending=await setupSocial().start(actor,'#skills'),state=new URL(pending.authorization_url).searchParams.get('state')!;
 const holder:PoolClient=await pool.connect();let reconnect,write;
 try{
   await holder.query('BEGIN');
   await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-social/${actor.user_id}`]);
   const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   reconnect=settle(reconnectSocial().complete(actor,state,'synthetic-code'));
   const queued=await blockedOn('reconnect',holderPid);
   write=settle(waiter());
   // FIFO lock queue: the write waits on github-social behind both holder and reconnect.
   const waiting=await blockedOn('waiter',holderPid,queued.pid);
   assert.equal((await backends('reconnect')).length,1);assert.ok(waiting.blockers.includes(queued.pid));
   await holder.query('COMMIT');
 }finally{
   await holder.query('ROLLBACK').catch(()=>{});holder.release();
   // Never leak a waiter past the test even when a barrier assertion failed.
   await Promise.all([reconnect,write]);
 }
 const reconnected=await reconnect!;assert.ok(reconnected.ok,'same-member reconnect must succeed');
 return write!;
}
async function assertRevokedOnly(existingKey:string){
 const grants=(await pool.query('SELECT revoked_at,revoke_reason FROM development_grants')).rows;
 assert.equal(grants.length,1);assert.equal(grants[0].revoke_reason,'github_connection_changed');
 assert.equal((await pool.query('SELECT count(*) FROM development_keys WHERE revoked_at IS NULL')).rows[0].count,'0','no usable key may survive the reconnect');
 assert.equal((await pool.query('SELECT count(*) FROM development_keys WHERE key_id<>$1',[existingKey])).rows[0].count,'0','no key may be issued after revocation');
 assert.equal((await pool.query('SELECT count(*) FROM development_proposals')).rows[0].count,'0','no proposal may be written after revocation');
}

before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await Promise.all([pool.end(),reconnectPool.end(),waiterPool.end()]);await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
 await pool.query('TRUNCATE communities CASCADE');const community=randomUUID(),id=randomUUID(),raw=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('hex');
 await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Grant race test']);
 const user=(await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic','unused',$4) RETURNING *`,[id,community,`${id}@example.invalid`,randomUUID()])).rows[0];
 await pool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '1 hour',NULL)",[tokenHash(raw),id,csrf]);
 actor={...user,session_hash:tokenHash(raw),csrf_token:csrf} as Actor;
});

test('key issuance queued behind a same-identity reconnect rejects and never issues a key for the revoked grant',async()=>{
 await enable();const existing=await setup().issueKey(command({},'existing-key'),'skill',target);
 const result=await behindReconnect(()=>waiterService().issueKey(command({},'raced-key'),'skill',target));
 assert.equal(result.ok,false,'issueKey must not succeed after the reconnect revoked its grant');
 assert.equal((result as any).error.code,'development_grant_required');
 await assertRevokedOnly(existing.key_id);
});

test('browser proposal queued behind a same-identity reconnect rejects and writes nothing',async()=>{
 await enable();const existing=await setup().issueKey(command({},'existing-key'),'skill',target);
 const result=await behindReconnect(()=>waiterService().saveProposal(command(proposal,'raced-proposal'),'skill',target));
 assert.equal(result.ok,false,'saveProposal must not succeed after the reconnect revoked its grant');
 assert.equal((result as any).error.code,'development_grant_required');
 await assertRevokedOnly(existing.key_id);
});

test('agent proposal with an existing key queued behind a same-identity reconnect rejects and never resurrects the key',async()=>{
 await enable();const existing=await setup().issueKey(command({},'existing-key'),'skill',target);
 const result=await behindReconnect(()=>waiterService().agent('Bearer '+existing.token,proposal,'raced-agent-proposal'));
 assert.equal(result.ok,false,'agent proposal must not succeed after the reconnect revoked its key');
 assert.equal((result as any).error.code,'development_key_revoked');
 await assertRevokedOnly(existing.key_id);
 // A later retry stays revoked too.
 await assert.rejects(()=>waiterService().agent('Bearer '+existing.token,proposal,'raced-agent-proposal'),(error:any)=>error.code==='development_key_revoked');
});
