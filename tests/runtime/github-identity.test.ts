import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {createPool,digest,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {GitHubSocial,type GitHubSocialConfig} from '../../modules/github-social/service.js';
import type {Actor} from '../../modules/identity-membership/service.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_github_identity_${process.pid}_${Date.now()}`;
const database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const config:GitHubSocialConfig={clientId:'Iv1.identity-test',clientSecret:'synthetic-client-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:'https://workshop.example.invalid/github/callback'};
const book='social-post',repository='Hao0321/claude-skill-social-post';
type Call={url:string;method:string};
class GitHubMock {
  calls:Call[]=[];userId=111;login='shared-github-user';starred=false;
  fetch:typeof fetch=async(input,init={})=>{
    const url=String(input),method=init.method??'GET';this.calls.push({url,method});
    if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'ghu_identity',refresh_token:'ghr_identity',token_type:'bearer',scope:'',expires_in:28800,refresh_token_expires_in:15897600});
    if(url==='https://api.github.com/user')return Response.json({id:this.userId,login:this.login});
    if(url===`https://api.github.com/user/starred/${repository}`){if(method!=='GET')this.starred=method==='PUT';return new Response(null,{status:method==='GET'&&!this.starred?404:204});}
    if(url.startsWith('https://api.github.com/repos/'))return Response.json({stargazers_count:1,forks_count:0,open_issues_count:0,subscribers_count:0,pushed_at:null,language:null,archived:false,private:false});
    if(url===`https://api.github.com/applications/${config.clientId}/token`&&method==='DELETE')return new Response(null,{status:204});
    throw new Error('Unexpected mock endpoint');
  };
}
let alice:Actor,bob:Actor,mock:GitHubMock,social:GitHubSocial;
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
async function member(community:string,name:string,target=pool):Promise<Actor>{
  const id=randomUUID(),csrf=randomBytes(16).toString('hex'),session=randomBytes(32).toString('hex');
  const user=(await target.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,'unused-test-password-hash',$5) RETURNING *`,[id,community,`${name.toLowerCase()}-${id}@example.invalid`,name,randomUUID()])).rows[0];
  await target.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '1 hour',NULL)",[session,id,csrf]);
  return {...user,session_hash:session,csrf_token:csrf};
}
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,github_repository_metrics,skill_star_support CASCADE');
  const community=randomUUID(),outside=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2),($3,$4)',[community,'Identity tests',outside,'Other community']);
  alice=await member(community,'AliceSynthetic');bob=await member(outside,'BobSynthetic');mock=new GitHubMock();social=new GitHubSocial(pool,config,mock.fetch);
});
const errorCode=(code:string)=>(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code===code;
async function begin(actor:Actor){return new URL((await social.start(actor,'#guilds')).authorization_url).searchParams.get('state')!;}
async function connect(actor:Actor){return social.complete(actor,await begin(actor),'synthetic-code');}
const row=async(actor:Actor)=>(await pool.query('SELECT * FROM github_social_connections WHERE user_id=$1',[actor.user_id])).rows[0];
const revokes=()=>mock.calls.filter(call=>call.url.includes('/applications/')).length;

test('a GitHub user ID linked to one member returns a private 409 to another member and consumes that state',async()=>{
  await connect(alice);const original=await row(alice),state=await begin(bob);
  await assert.rejects(()=>social.complete(bob,state,'synthetic-code'),error=>{
    assert.ok(errorCode('github_identity_already_linked')(error));assert.equal((error as {status:number}).status,409);
    const text=JSON.stringify({message:String(error),...(error as object)});
    for(const secret of [alice.user_id,alice.email,alice.display_name,'shared-github-user','111'])assert.equal(text.includes(secret),false,'409 must not reveal the other member or GitHub account');
    assert.match(String(error),/已連結另一個工坊帳號/);return true;
  });
  assert.equal((await pool.query('SELECT count(*) FROM github_social_oauth_states WHERE user_id=$1',[bob.user_id])).rows[0].count,'0');
  await assert.rejects(()=>social.complete(bob,state,'synthetic-code'),errorCode('github_oauth_expired'));
  assert.equal(await row(bob),undefined);assert.deepEqual(await row(alice),original);assert.equal(revokes(),0);
  assert.equal((await social.session(alice)).connected,true);assert.deepEqual(await social.session(bob),{configured:true,connected:false,github_user:null});
});

test('a member switching to an occupied GitHub account keeps their original connection',async()=>{
  await connect(alice);mock.userId=222;mock.login='bob-own-account';await connect(bob);const original=await row(bob);
  mock.userId=111;mock.login='shared-github-user';
  await assert.rejects(()=>connect(bob),errorCode('github_identity_already_linked'));
  assert.deepEqual(await row(bob),original);assert.equal(original.github_user_id,'222');
  assert.deepEqual((await social.session(bob)).github_user,{id:'222',login:'bob-own-account'});assert.equal((await row(alice)).github_user_id,'111');assert.equal(revokes(),0);
});

test('two members completing the same GitHub account concurrently yield exactly one link and one 409',async()=>{
  const states=[await begin(alice),await begin(bob)];
  const results=await Promise.allSettled([social.complete(alice,states[0],'synthetic-code'),new GitHubSocial(pool,config,mock.fetch).complete(bob,states[1],'synthetic-code')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.filter(result=>result.status==='rejected');assert.equal(rejected.length,1);assert.ok(errorCode('github_identity_already_linked')(rejected[0].reason));
  assert.equal((await pool.query("SELECT count(*) FROM github_social_connections WHERE github_user_id='111'")).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM github_social_oauth_states')).rows[0].count,'0');
});

test('the same member reconnects in place and a GitHub login rename never creates a second identity',async()=>{
  await connect(alice);mock.login='renamed-github-user';
  assert.deepEqual((await connect(alice)).github_user,{id:'111',login:'renamed-github-user'});
  const rows=(await pool.query('SELECT user_id,github_user_id,github_login FROM github_social_connections')).rows;
  assert.deepEqual(rows,[{user_id:alice.user_id,github_user_id:'111',github_login:'renamed-github-user'}]);
});

test('after the owner disconnects, another member links with a fresh state while stars and revoked grants stay put',async()=>{
  await connect(alice);await social.star(alice,book,true);
  const grant=randomUUID(),key=randomUUID();
  await pool.query(`INSERT INTO development_grants(grant_id,community_id,user_id,capability,target_key,target_repository,target_repository_id,working_repository,working_repository_id,github_user_id,installation_id,app_id,guild_sources,policy_version) VALUES($1,$2,$3,'skill','video-autopilot','FreeTWAI-AI/video','1','shared/video','2','111','77','9',$4,'development-proposal-v1')`,[grant,alice.community_id,alice.user_id,['guild_ai_vibe']]);
  await pool.query('INSERT INTO development_keys(key_id,source_grant_id,secret_hash) VALUES($1,$2,$3)',[key,grant,'synthetic-'+key]);
  const stale=await begin(bob);await assert.rejects(()=>social.complete(bob,stale,'synthetic-code'),errorCode('github_identity_already_linked'));
  await social.disconnect(alice);
  await assert.rejects(()=>social.complete(bob,stale,'synthetic-code'),errorCode('github_oauth_expired'));
  assert.deepEqual((await connect(bob)).github_user,{id:'111',login:'shared-github-user'});
  assert.equal((await row(bob)).github_user_id,'111');assert.equal(await row(alice),undefined);
  const star=(await pool.query('SELECT github_user_id,active FROM skill_star_support')).rows;assert.deepEqual(star,[{github_user_id:'111',active:true}]);
  const revoked=(await pool.query('SELECT g.revoked_at,g.revoke_reason,k.revoked_at AS key_revoked FROM development_grants g JOIN development_keys k ON k.source_grant_id=g.grant_id')).rows[0];
  assert.ok(revoked.revoked_at);assert.equal(revoked.revoke_reason,'github_connection_changed');assert.ok(revoked.key_revoked);
  assert.equal((await pool.query('SELECT count(*) FROM development_grants WHERE user_id=$1 OR revoked_at IS NULL',[bob.user_id])).rows[0].count,'0');
});

test('the database rejects any direct duplicate, and a racing direct write still yields 409 with the state consumed',async()=>{
  await connect(alice);
  await assert.rejects(()=>pool.query("INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens) VALUES($1,$2,'111','direct','x')",[bob.user_id,bob.community_id]),
    (error:{code?:string;constraint?:string})=>error.code==='23505'&&error.constraint==='github_social_connections_github_user_unique');
  await pool.query("UPDATE github_social_connections SET github_user_id='333' WHERE user_id=$1",[alice.user_id]);
  const writer=await pool.connect(),carol=await member(bob.community_id,'CarolSynthetic');
  try{
    const state=await begin(bob);
    await writer.query('BEGIN');const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await writer.query("INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens) VALUES($1,$2,'111','direct','x')",[carol.user_id,carol.community_id]);
    const pending=social.complete(bob,state,'synthetic-code');void pending.catch(()=>{});
    // The precheck cannot see the uncommitted row; wait until the insert blocks on the unique index.
    let blocked=false;
    for(let attempt=0;attempt<200&&!blocked;attempt++){
      blocked=(await pool.query('SELECT count(*) FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))',[writerPid])).rows[0].count!=='0';
      if(!blocked)await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(blocked,'callback insert should wait on the uncommitted duplicate');
    await writer.query('COMMIT');
    await assert.rejects(()=>pending,errorCode('github_identity_already_linked'));
    await assert.rejects(()=>social.complete(bob,state,'synthetic-code'),errorCode('github_oauth_expired'));
    assert.equal(await row(bob),undefined);assert.equal((await row(carol)).github_login,'direct');
  }finally{await writer.query('ROLLBACK');writer.release();}
});

test('migration 034 fails atomically on existing duplicates without choosing, merging or deleting rows',async()=>{
  const legacy=`${schema}_legacy`,legacyPool=new Pool({connectionString:databaseUrl,options:`-c search_path=${legacy}`,max:2});
  await database.query(`CREATE SCHEMA ${legacy}`);
  try{
    await legacyPool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')&&name<'034').sort()){
      const sql=await readFile('migrations/'+name,'utf8');await legacyPool.query(sql);await legacyPool.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,digest(sql)]);
    }
    const community=randomUUID();await legacyPool.query('INSERT INTO communities VALUES($1,$2)',[community,'Legacy']);
    const people=[await member(community,'LegacyOne',legacyPool),await member(community,'LegacyTwo',legacyPool),await member(community,'LegacyThree',legacyPool)];
    for(const [person,id] of [[people[0],'4242'],[people[1],'4242'],[people[2],'5151']] as const)
      await legacyPool.query('INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens) VALUES($1,$2,$3,$4,$5)',[person.user_id,community,id,'legacy-'+id,'ciphertext-'+person.user_id]);
    const snapshot=async()=>(await legacyPool.query('SELECT * FROM github_social_connections ORDER BY user_id')).rows;
    const before=await snapshot();
    await assert.rejects(()=>migrate(legacyPool),error=>{
      assert.match(String(error),/github_identity_duplicate: 1 GitHub user ID\(s\) are linked to more than one member \(2 connection rows\)/);
      for(const secret of ['4242',...people.map(person=>person.user_id),...people.map(person=>person.email)])assert.equal(String(error).includes(secret),false);
      return true;
    });
    assert.deepEqual(await snapshot(),before);
    assert.equal((await legacyPool.query("SELECT count(*) FROM schema_migrations WHERE name>='034'")).rows[0].count,'0');
    assert.equal((await legacyPool.query("SELECT count(*) FROM pg_constraint WHERE conname='github_social_connections_github_user_unique' AND connamespace=$1::regnamespace",[legacy])).rows[0].count,'0');
    // An operator resolves the duplicate explicitly; only then does the migration apply.
    await legacyPool.query('DELETE FROM github_social_connections WHERE user_id=$1',[people[1].user_id]);
    await migrate(legacyPool);
    assert.equal((await legacyPool.query("SELECT count(*) FROM schema_migrations WHERE name='034_github_identity_unique.sql'")).rows[0].count,'1');
    await assert.rejects(()=>legacyPool.query('UPDATE github_social_connections SET github_user_id=$1 WHERE user_id=$2',['4242',people[2].user_id]),(error:{code?:string})=>error.code==='23505');
  }finally{await legacyPool.end();await database.query(`DROP SCHEMA ${legacy} CASCADE`);}
});
