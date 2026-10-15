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
import {Problem} from '../../packages/shared/problem.js';

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
 const url=String(input);assert.equal(init.redirect,'manual');assert.notEqual(init.redirect,'error');
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

async function enable(read:typeof fetch=fetcher){
 await changeGuildMembership(pool,{...command({},'join'),expected:undefined},'guild_ai_vibe','join');
 await pool.query("UPDATE positioning_profession_memberships SET member_tier='full' WHERE user_id=$1 AND guild_key='guild_ai_vibe'",[actor.user_id]);
 const social=new GitHubSocial(pool,config,read),pending=await social.start(actor,'#skills');
 await social.complete(actor,new URL(pending.authorization_url).searchParams.get('state')!,'synthetic-code');
 const service=new DevelopmentAccess(pool,social);
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

test('key issuance waiting on the guild lock cannot mint after the browser session expires',async()=>{
  await enable();
  const holder=await pool.connect();
  let issue:Promise<unknown>|undefined;
  try{
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`guild-member/${actor.community_id}/${actor.user_id}`]);
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1",[actor.session_hash]);
    const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    issue=waiterService().issueKey(command({},'expired-session-key'),'skill',target);
    await until('guild lock',async()=>{
      const locked=await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%' AND $2=ANY(pg_blocking_pids(pid))",[`${schema}/waiter`,holderPid]);
      return locked.rowCount?true:undefined;
    });
    await pool.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM sessions WHERE token_hash=$1',[actor.session_hash]);
    await holder.query('COMMIT');
    await assert.rejects(issue,(error:any)=>error.code==='session_expired');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM development_keys WHERE revoked_at IS NULL AND expires_at>clock_timestamp()")).rows[0].n,0);
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await issue?.catch(()=>{});}
});

test('an agent proposal waiting on the GitHub lock cannot write after its key expires',async()=>{
  await enable();
  const existing=await setup().issueKey(command({},'expiring-key'),'skill',target);
  const holder=await pool.connect();
  let write:Promise<unknown>|undefined;
  try{
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-social/${actor.user_id}`]);
    await pool.query("UPDATE development_keys SET expires_at=clock_timestamp()+interval '2 seconds' WHERE key_id=$1",[existing.key_id]);
    const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    write=waiterService().agent('Bearer '+existing.token,proposal,'expired-agent-proposal');
    await until('github lock',async()=>{
      const locked=await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%' AND $2=ANY(pg_blocking_pids(pid))",[`${schema}/waiter`,holderPid]);
      return locked.rowCount?true:undefined;
    });
    await pool.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM development_keys WHERE key_id=$1',[existing.key_id]);
    await holder.query('COMMIT');
    await assert.rejects(write,(error:any)=>error.code==='development_key_revoked');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM development_proposals')).rows[0].n,0);
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await write?.catch(()=>{});}
});

test('key issuance waiting on the GitHub lock cannot mint after its grant expires',async()=>{
  await enable();
  const holder=await pool.connect();
  let issue:Promise<unknown>|undefined;
  try{
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-social/${actor.user_id}`]);
    await pool.query("UPDATE development_grants SET expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=$1 AND revoked_at IS NULL",[actor.user_id]);
    const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    issue=waiterService().issueKey(command({},'expired-grant-key'),'skill',target);
    await until('github lock',async()=>{
      const locked=await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%' AND $2=ANY(pg_blocking_pids(pid))",[`${schema}/waiter`,holderPid]);
      return locked.rowCount?true:undefined;
    });
    await pool.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM development_grants WHERE user_id=$1 AND revoked_at IS NULL',[actor.user_id]);
    await holder.query('COMMIT');
    await assert.rejects(issue,(error:any)=>error.code==='development_grant_required');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM development_keys WHERE revoked_at IS NULL AND expires_at>clock_timestamp()")).rows[0].n,0);
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await issue?.catch(()=>{});}
});

test('key issuance waiting on the GitHub lock cannot mint after the browser session expires',async()=>{
  await enable();
  const holder=await pool.connect();
  let issue:Promise<unknown>|undefined;
  try{
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`github-social/${actor.user_id}`]);
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash=$1",[actor.session_hash]);
    const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    issue=waiterService().issueKey(command({},'expired-session-github-key'),'skill',target);
    await until('github lock',async()=>{
      const locked=await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%' AND $2=ANY(pg_blocking_pids(pid))",[`${schema}/waiter`,holderPid]);
      return locked.rowCount?true:undefined;
    });
    await pool.query('SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM sessions WHERE token_hash=$1',[actor.session_hash]);
    await holder.query('COMMIT');
    await assert.rejects(issue,(error:any)=>error.code==='session_expired');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM development_keys WHERE revoked_at IS NULL AND expires_at>clock_timestamp()")).rows[0].n,0);
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await issue?.catch(()=>{});}
});

type CommandOutcome={ok:true;value:unknown}|{ok:false;error:unknown};
for(const operation of ['agent-key','agent-grant','browser-proposal','issue-key'] as const)for(const phase of ['provider','receipt'] as const){
 test(`${operation} rejects authority expiry after ${phase} and rolls back only the new command`,async()=>{
  await enable();
  const credential=await setup().issueKey(command({},'late-authority-credential'),'skill',target);
  const keyExpires=operation==='agent-key',table=keyExpires?'development_keys':'development_grants';
  const idColumn=keyExpires?'key_id':'grant_id',id=keyExpires?credential.key_id:credential.source_grant_id;
  const code=keyExpires?'development_key_revoked':'development_grant_required';
  const facts=async()=>(await pool.query(`SELECT
   (SELECT count(*)::int FROM development_proposals) AS proposals,
   (SELECT count(*)::int FROM development_keys) AS keys,
   (SELECT count(*)::int FROM command_receipts) AS receipts,
   (SELECT count(*)::int FROM transition_journal) AS journal`)).rows[0];
  const before=await facts();
  const run=async(expired:boolean)=>{
   const key=randomUUID(),lock=`${schema}/${key}`,holder=await admin.connect();
   let enter!:()=>void,release!:()=>void;
   const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
   let armed=true,pending:Promise<CommandOutcome>|undefined;
   const social=new GitHubSocial(waiterPool,config,async(input,init)=>{
    if(phase==='provider'&&armed&&String(input).includes('/repositories?')){armed=false;enter();await held;}
    return fetcher(input,init);
   });
   const service=new DevelopmentAccess(waiterPool,social);
   try{
    if(phase==='receipt'){
     await pool.query(`CREATE OR REPLACE FUNCTION pause_late_authority_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.idempotency_key='${key}' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${lock}',0)); END IF; RETURN NEW; END $$`);
     await pool.query('CREATE TRIGGER late_authority_receipt BEFORE INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION pause_late_authority_receipt()');
     await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);
    }
    await pool.query(`UPDATE ${table} SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE ${idColumn}=$1`,[id,expired?3:300]);
    pending=settle(operation.startsWith('agent')?service.agent('Bearer '+credential.token,proposal,key)
     :operation==='browser-proposal'?service.saveProposal(command(proposal,'late-browser-proposal',key),'skill',target)
     :service.issueKey(command({},'late-issued-key',key),'skill',target));
    if(phase==='provider')await Promise.race([entered,pending.then(result=>{if(!result.ok)throw result.error;throw Error('command settled before provider barrier');})]);
    else{
     const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
     await until('new command receipt wait',async()=>(await admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))',[`${schema}/waiter`,pid])).rowCount?true:undefined);
    }
    assert.equal((await pool.query(`SELECT expires_at>clock_timestamp() AS active FROM ${table} WHERE ${idColumn}=$1`,[id])).rows[0].active,true);
    if(expired)await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM ${table} WHERE ${idColumn}=$1`,[id]);
    release();await holder.query('SELECT pg_advisory_unlock_all()');
    const result=await pending;
    if(expired){
     assert.equal(result.ok,false);
     assert.ok(result.error instanceof Problem);
     assert.equal(result.error.status,403);assert.equal(result.error.code,code);
    }else{
     assert.equal(result.ok,true);
     const value=result.value;assert.ok(value&&typeof value==='object');
     if(operation==='issue-key'){assert.ok('source_grant_id' in value);assert.equal(value.source_grant_id,credential.source_grant_id);}
     else{assert.ok('title' in value);assert.equal(value.title,proposal.title);}
    }
   }finally{
    release();await holder.query('SELECT pg_advisory_unlock_all()');holder.release();if(pending)await pending;
    if(phase==='receipt'){await pool.query('DROP TRIGGER IF EXISTS late_authority_receipt ON command_receipts');await pool.query('DROP FUNCTION IF EXISTS pause_late_authority_receipt()');}
   }
  };
  await run(true);assert.deepEqual(await facts(),before);
  await run(false);
  assert.deepEqual(await facts(),{proposals:before.proposals+(operation==='issue-key'?0:1),keys:before.keys+(operation==='issue-key'?1:0),receipts:before.receipts+1,journal:before.journal+(operation==='issue-key'?0:1)});
 });
}

for(const authority of ['key','grant'] as const)test(`an existing Agent receipt cannot bypass ${authority} expiry during provider verification`,async()=>{
 await enable();
 const credential=await setup().issueKey(command({},'replay-authority-key'),'skill',target),key=randomUUID();
 const original=await setup().agent('Bearer '+credential.token,proposal,key);
 const before=(await pool.query(`SELECT (SELECT count(*)::int FROM development_proposals) AS proposals,
  (SELECT count(*)::int FROM command_receipts) AS receipts,(SELECT count(*)::int FROM transition_journal) AS journal`)).rows[0];
 const table=authority==='key'?'development_keys':'development_grants',idColumn=authority==='key'?'key_id':'grant_id';
 const id=authority==='key'?credential.key_id:credential.source_grant_id;
 let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 let armed=true;
 const social=new GitHubSocial(waiterPool,config,async(input,init)=>{
  if(armed&&String(input).includes('/repositories?')){armed=false;enter();await held;}
  return fetcher(input,init);
 });
 const service=new DevelopmentAccess(waiterPool,social);
 await pool.query(`UPDATE ${table} SET expires_at=clock_timestamp()+interval '3 seconds' WHERE ${idColumn}=$1`,[id]);
 const pending=settle(service.agent('Bearer '+credential.token,proposal,key));
 try{
  await Promise.race([entered,pending.then(result=>{if(!result.ok)throw result.error;throw Error('replay settled before provider barrier');})]);
  assert.equal((await pool.query(`SELECT expires_at>clock_timestamp() AS active FROM ${table} WHERE ${idColumn}=$1`,[id])).rows[0].active,true);
  await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM ${table} WHERE ${idColumn}=$1`,[id]);
  release();const result=await pending;
  assert.equal(result.ok,false);assert.ok(result.error instanceof Problem);
  assert.equal(result.error.code,authority==='key'?'development_key_revoked':'development_grant_required');
  assert.deepEqual((await pool.query(`SELECT (SELECT count(*)::int FROM development_proposals) AS proposals,
   (SELECT count(*)::int FROM command_receipts) AS receipts,(SELECT count(*)::int FROM transition_journal) AS journal`)).rows[0],before);
  await pool.query(`UPDATE ${table} SET expires_at=clock_timestamp()+interval '5 minutes' WHERE ${idColumn}=$1`,[id]);
  assert.deepEqual(await setup().agent('Bearer '+credential.token,proposal,key),JSON.parse(JSON.stringify(original)));
 }finally{release();await pending;}
});

for(const operation of ['agent-key','agent-grant','browser-proposal','browser-session','issue-key'] as const)test(`${operation} keeps a remotely rotated credential when receipt-wait authority expires`,async()=>{
 let refreshes=0,expectedRefresh='ghr_initial',expectedAccess='ghu_initial',short=true;
 const rotating:typeof fetch=async(input,init={})=>{
  if(String(input)==='https://github.com/login/oauth/access_token'){
   const body=new URLSearchParams(String(init.body??''));
   if(body.get('grant_type')==='refresh_token'){
    assert.equal(body.get('refresh_token'),expectedRefresh,'invalidated refresh credentials must never be reused');
    refreshes++;expectedRefresh=`ghr_rotated_${refreshes}`;expectedAccess=`ghu_rotated_${refreshes}`;
   }
   return Response.json({access_token:expectedAccess,refresh_token:expectedRefresh,token_type:'bearer',scope:'',expires_in:short?1:28800,refresh_token_expires_in:15897600});
  }
  if(String(input).includes('/repos/')&&!String(input).includes('/repos/contributor/'))assert.equal(new Headers(init.headers).get('authorization'),null);
  else assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+expectedAccess);
  return fetcher(input,init);
 };
 await enable(rotating);
 const service=new DevelopmentAccess(waiterPool,new GitHubSocial(waiterPool,config,rotating));
 const credential=await service.issueKey(command({},'refresh-existing-key'),'skill',target);
 const cipher=async()=>(await pool.query('SELECT encrypted_tokens FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0].encrypted_tokens;
 const facts=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM development_proposals) AS proposals,
  (SELECT count(*)::int FROM development_keys) AS keys,(SELECT count(*)::int FROM command_receipts) AS receipts,
  (SELECT count(*)::int FROM transition_journal) AS journal`)).rows[0];
 const beforeCipher=await cipher(),before=await facts(),beforeRefreshes=refreshes,key=randomUUID(),lock=`${schema}/refresh/${key}`;
 const table=operation==='agent-key'?'development_keys':operation==='browser-session'?'sessions':'development_grants';
 const column=operation==='agent-key'?'key_id':operation==='browser-session'?'token_hash':'grant_id';
 const id=operation==='agent-key'?credential.key_id:operation==='browser-session'?actor.session_hash:credential.source_grant_id;
 const expectedCode=operation==='agent-key'?'development_key_revoked':operation==='browser-session'?'session_expired':'development_grant_required';
 const invoke=()=>operation.startsWith('agent')?service.agent('Bearer '+credential.token,proposal,key)
  :operation==='issue-key'?service.issueKey(command({},'refresh-issue',key),'skill',target)
  :service.saveProposal(command(proposal,'refresh-browser-proposal',key),'skill',target);
 const holder=await admin.connect();let pending:Promise<CommandOutcome>|undefined;
 try{
  await pool.query(`CREATE FUNCTION pause_rotated_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.idempotency_key='${key}' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${lock}',0)); END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER rotated_receipt BEFORE INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION pause_rotated_receipt()');
  await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);
  await pool.query(`UPDATE ${table} SET expires_at=clock_timestamp()+interval '3 seconds' WHERE ${column}=$1`,[id]);
  short=false;pending=settle(invoke());
  const pid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await until('rotated command receipt wait',async()=>(await admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))',[`${schema}/waiter`,pid])).rowCount?true:undefined);
  assert.equal(refreshes,beforeRefreshes+1);
  assert.equal((await pool.query(`SELECT expires_at>clock_timestamp() AS live FROM ${table} WHERE ${column}=$1`,[id])).rows[0].live,true);
  await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.05) FROM ${table} WHERE ${column}=$1`,[id]);
  await holder.query('SELECT pg_advisory_unlock_all()');
  const result=await pending;assert.equal(result.ok,false);assert.ok(result.error instanceof Problem);assert.equal(result.error.code,expectedCode);
  assert.deepEqual(await facts(),before);assert.notEqual(await cipher(),beforeCipher);
 }finally{
  await holder.query('SELECT pg_advisory_unlock_all()');holder.release();if(pending)await pending;
  await pool.query('DROP TRIGGER IF EXISTS rotated_receipt ON command_receipts');await pool.query('DROP FUNCTION IF EXISTS pause_rotated_receipt()');
 }
 // Rearm only the synthetic authority fixture, then consume the saved rotation.
 await pool.query(`UPDATE ${table} SET expires_at=clock_timestamp()+interval '5 minutes' WHERE ${column}=$1`,[id]);
 const committed=await invoke(),replay=await invoke();
 assert.equal(refreshes,beforeRefreshes+1,'the persisted access token is usable without another refresh');
 if(operation==='issue-key'){assert.equal(replay.key_id,committed.key_id);assert.equal(replay.token,null);}
 else assert.deepEqual(replay,JSON.parse(JSON.stringify(committed)));
 assert.deepEqual(await facts(),{proposals:before.proposals+(operation==='issue-key'?0:1),keys:before.keys+(operation==='issue-key'?1:0),receipts:before.receipts+1,journal:before.journal+(operation==='issue-key'?0:1)});
});
