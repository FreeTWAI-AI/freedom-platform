import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { emptyContacts } from '../../modules/identity-membership/members.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_identity_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number|string,key=randomUUID()) {
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
const session=(r:any):Session=>({cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user});
async function signIn(email=DEMO_USERS[0].email):Promise<Session>{const r=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));return session(r);}
async function account(s:Session,contacts=emptyContacts(),nickname='會員暱稱'){const before=await request('/me/account',s);return request('/me/account',s,{nickname,contacts},before.data.aggregate_version);}

test('registration saves salted password, private unverified contacts and server-side closed onboarding',async()=>{
  const registration={email:'New.Person@example.com',password:'long-enough-new-password',nickname:'新的職人',contacts:{github:{value:'hello-member',audiences:[]}}};
  const result=await request('/auth/register',undefined,registration);assert.equal(result.status,201,JSON.stringify(result.data));const member=session(result);
  const row=(await pool.query('SELECT * FROM users WHERE user_id=$1',[member.user.user_id])).rows[0];
  assert.equal(row.email,'new.person@example.com');assert.notEqual(row.password_hash,registration.password);assert.equal(row.email_verified_at,null);assert.equal(row.onboarding_required,true);assert.equal(row.onboarding_completed_at,null);
  const own=await request('/me/account',member);assert.deepEqual(own.data.contacts.email.audiences,[]);assert.equal(own.data.contacts.email.value,row.email);assert.equal(own.data.contacts.github.verified,false);
  assert.equal((await request('/session',member)).status,200);assert.equal((await request('/assessment-definition',member)).status,200);assert.equal((await request('/guilds',member)).status,200);
  for(const path of ['/work-items','/dashboard','/members','/squads','/supplier/products','/retail/stores','/marketing/campaigns','/opensource/projects']) {
    const blocked=await request(path,member);assert.equal(blocked.status,403,`${path}: ${JSON.stringify(blocked.data)}`);assert.equal(blocked.data.code,'onboarding_required');
  }
  assert.equal((await request('/work-items',member,{})).data.code,'onboarding_required');
  const again=await request('/auth/login',undefined,{email:'NEW.PERSON@example.com',password:registration.password});assert.equal(again.status,200);assert.equal((await request('/members',session(again))).status,403);
  assert.equal((await request('/auth/register',undefined,registration)).status,409);
  const directory=await request('/members',await signIn());assert.ok(!directory.data.items.some((u:any)=>u.user_id===member.user.user_id));
});

test('registration rejects forged contacts and weak passwords, persists per-network and per-email limits',async()=>{
  const body={email:'abuse@example.com',password:'long-enough-password',nickname:'正常名字'};
  assert.equal((await request('/auth/register',undefined,{...body,password:'short'})).status,422);
  assert.equal((await request('/auth/register',undefined,{...body,contacts:{github:{value:'admin',audiences:[],verified:true}}})).status,422);
  assert.equal((await request('/auth/register',undefined,body)).status,201);
  assert.equal((await request('/auth/register',undefined,body)).status,409);
  assert.equal((await request('/auth/register',undefined,body)).status,409);
  assert.equal((await request('/auth/register',undefined,body)).status,429);
  await request('/auth/register',undefined,{...body,email:'abuse2@example.com'});
  await request('/auth/register',undefined,{...body,email:'abuse3@example.com'});
  const blocked=await request('/auth/register',undefined,{...body,email:'abuse4@example.com'});assert.equal(blocked.status,429);assert.equal(blocked.data.code,'auth_rate_limited');
  const fresh=createApp(pool,origin);const afterRestart=await fresh.request(origin+'/api/v1/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({...body,email:'new@example.com'})});assert.equal(afterRestart.status,429);
});

test('failed login budget survives requests and never accepts wrong or inactive accounts',async()=>{
  for(let i=0;i<10;i++)assert.equal((await request('/auth/login',undefined,{email:DEMO_USERS[0].email,password:'wrong-password'})).status,401);
  assert.equal((await request('/auth/login',undefined,{email:DEMO_USERS[0].email,password:DEMO_PASSWORD})).status,429);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[DEMO_USERS[1].user_id]);
  assert.equal((await request('/auth/login',undefined,{email:DEMO_USERS[1].email,password:DEMO_PASSWORD})).status,401);
});

test('directory omits login email and private contacts; accepted friendships grant and removal revokes access',async()=>{
  const owner=await signIn(),viewer=await signIn(DEMO_USERS[1].email);
  const contacts={...emptyContacts(),email:{audiences:[]},github:{value:'public-maker',audiences:['public']},discord:{value:'friend-only',audiences:['friends']}};
  assert.equal((await account(owner,contacts)).status,200);
  const card=await request('/members/'+owner.user.user_id,viewer);assert.deepEqual(card.data.contacts,{github:'public-maker'});assert.ok(!JSON.stringify(card.data).includes(owner.user.email));assert.ok(!JSON.stringify(card.data).includes('private-contact'));
  const pending=await request('/friends/'+owner.user.user_id+'/request',viewer,{});assert.equal(pending.status,200);assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.discord,undefined);
  assert.equal((await request('/friends/'+owner.user.user_id+'/accept',viewer,{},pending.data.aggregate_version)).status,403);
  const accepted=await request('/friends/'+viewer.user.user_id+'/accept',owner,{},pending.data.aggregate_version);assert.equal(accepted.status,200);assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.discord,'friend-only');
  assert.equal((await request('/friends/'+owner.user.user_id+'/remove',viewer,{},accepted.data.aggregate_version)).status,200);assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.discord,undefined);
  assert.equal((await request('/members?limit=1',owner)).data.items.length,1);assert.equal((await request('/members?limit=51',owner)).status,422);
});

test('guild contact audience follows both active memberships and revokes after leaving',async()=>{
  const owner=await signIn(),viewer=await signIn(DEMO_USERS[1].email);
  await account(owner,{...emptyContacts(),line:{value:'guild-only',audiences:['guild']}});
  await request('/guilds/guild_ai_vibe/join',owner,{});const membership=await request('/guilds/guild_ai_vibe/join',viewer,{});
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.line,'guild-only');
  assert.equal((await request('/guilds/guild_ai_vibe/leave',viewer,{},membership.data.aggregate_version)).status,200);
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.line,undefined);
});

test('squad contact audience needs own request plus owner acceptance and immediately revokes on leave',async()=>{
  const owner=await signIn(),viewer=await signIn(DEMO_USERS[1].email),third=await signIn(DEMO_USERS[2].email);
  await account(owner,{...emptyContacts(),line:{value:'squad-only',audiences:['squad']}});
  const made=await request('/squads',owner,{name:'第一個專案小隊',kind:'project',purpose:'一起完成一個公開作品'});assert.equal(made.status,201);const id=made.data.squad_id;
  assert.equal((await request(`/squads/${id}/members/${viewer.user.user_id}/accept`,owner,{})).status,404);
  const pending=await request(`/squads/${id}/request`,viewer,{});assert.equal(pending.status,200);assert.equal(pending.data.state,'pending');
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.line,undefined);
  assert.equal((await request(`/squads/${id}`,third)).data.members.length,1);
  assert.equal((await request(`/squads/${id}/members/${viewer.user.user_id}/accept`,third,{},pending.data.aggregate_version)).status,403);
  const accepted=await request(`/squads/${id}/members/${viewer.user.user_id}/accept`,owner,{},pending.data.aggregate_version);assert.equal(accepted.status,200);
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.line,'squad-only');
  assert.equal((await request(`/squads/${id}/leave`,viewer,{},accepted.data.aggregate_version)).status,200);
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.line,undefined);
  assert.equal((await request('/squads',owner,{name:'另一隊',kind:'mutual_help',purpose:'一起學習'})).status,201);
  assert.equal((await request('/squads',owner,{name:'假種類',kind:'guild_admin',purpose:'不允許'})).status,422);
});

test('inactive and other-community accounts never appear or accept friends/squad actions',async()=>{
  const owner=await signIn(),community=randomUUID(),outsiderId=randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'outsider@local.test','Other',password_hash,$3 FROM users WHERE user_id=$4`,[outsiderId,community,randomUUID(),owner.user.user_id]);
  assert.equal((await request('/members/'+outsiderId,owner)).status,404);assert.equal((await request('/friends/'+outsiderId+'/request',owner,{})).status,404);
  const outsider=await signIn('outsider@local.test');const made=await request('/squads',owner,{name:'限定社群',kind:'project',purpose:'合作'});
  assert.equal((await request('/squads/'+made.data.squad_id,outsider)).status,404);assert.equal((await request('/squads/'+made.data.squad_id+'/request',outsider,{})).status,404);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[DEMO_USERS[1].user_id]);
  const list=await request('/members',owner);assert.equal(list.data.items.length,2);assert.ok(list.data.items.every((r:any)=>r.user_id!==outsiderId));
  assert.equal((await request('/members/'+DEMO_USERS[1].user_id,owner)).status,404);
});

test('account mutation uses versions and strict privacy fields without changing login identity',async()=>{
  const user=await signIn();const before=await request('/me/account',user);
  const input={nickname:'新的公開暱稱',contacts:{...emptyContacts(),email:{audiences:['public']}}};
  const updated=await request('/me/account',user,input,before.data.aggregate_version);assert.equal(updated.status,200);assert.equal(updated.data.login_email,DEMO_USERS[0].email);
  assert.equal((await request('/me/account',user,input,before.data.aggregate_version)).status,412);
  assert.equal((await request('/me/account',user,{...input,login_email:'forged@example.com'},updated.data.aggregate_version)).status,422);
  assert.equal((await request('/me/account',user,{...input,contacts:{...input.contacts,github:{value:'https://github.com/admin',audiences:['public']}}},updated.data.aggregate_version)).status,422);
  const viewer=await signIn(DEMO_USERS[1].email),card=await request('/members/'+user.user.user_id,viewer);assert.equal(card.data.nickname,'新的公開暱稱');assert.equal(card.data.contacts.email,DEMO_USERS[0].email);
});

test('member-card labels are optional, self-selected, versioned and clearable while community names propagate',async()=>{
  const owner=await signIn(),viewer=await signIn(DEMO_USERS[1].email);
  let current=(await request('/me/account',owner)).data;
  assert.equal(current.identity_label,null);
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.identity_label,null);
  const contacts=emptyContacts();
  for(const identity_label of ['male','female','alien','ai']){
    const body={nickname:'社群常用名字',identity_label,contacts};
    const saved=await request('/me/account',owner,body,current.aggregate_version);
    assert.equal(saved.status,200);assert.equal(saved.data.identity_label,identity_label);
    assert.equal((await request('/me/account',owner,{...body,identity_label:null},current.aggregate_version)).status,412);
    current=saved.data;
    const visible=(await request('/members/'+owner.user.user_id,viewer)).data;
    assert.equal(visible.identity_label,identity_label);assert.equal(visible.nickname,body.nickname);assert.deepEqual(visible.contacts,{});
  }
  assert.equal((await request('/session',owner)).data.user.display_name,'社群常用名字');
  const directory=(await request('/members?search='+encodeURIComponent('社群常用名字'),viewer)).data;
  assert.equal(directory.total,1);assert.equal(directory.items[0].identity_label,'ai');
  for(const identity_label of ['robot','',{},false])assert.equal((await request('/me/account',owner,{nickname:'不應保存',identity_label,contacts},current.aggregate_version)).status,422);
  assert.equal((await request('/members/'+owner.user.user_id)).status,401);
  // Older clients can edit names/contacts without erasing the optional label.
  const legacy=await request('/me/account',owner,{nickname:'社群常用名字',contacts},current.aggregate_version);
  assert.equal(legacy.data.identity_label,'ai');
  const cleared=await request('/me/account',owner,{nickname:'社群常用名字',identity_label:null,contacts},legacy.data.aggregate_version);
  assert.equal(cleared.status,200);assert.equal(cleared.data.identity_label,null);
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.identity_label,null);
  assert.equal(cleared.data.login_email,DEMO_USERS[0].email);
});

test('real TCP clients cannot bypass network registration budget by spoofing proxy headers',async()=>{
  const {serve}=await import('@hono/node-server');
  const previousTrust=process.env.FREEDOM_TRUST_CF;delete process.env.FREEDOM_TRUST_CF;
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  try {
    for(let i=0;i<9;i++) {
      const response:Response=await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/register`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':`192.0.2.${i+1}`,'X-Forwarded-For':`198.51.100.${i+1}`},body:JSON.stringify({email:`tcp${i}@example.com`,password:'too-short',nickname:'TCP visitor'})});
      assert.equal(response.status,i<8?422:429,JSON.stringify(await response.json()));
    }
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(previousTrust===undefined)delete process.env.FREEDOM_TRUST_CF;else process.env.FREEDOM_TRUST_CF=previousTrust;}
});

test('public mode exposes no demo login metadata and sets Secure cookie on registration',async()=>{
  const publicOrigin='https://join.freetwai.com',publicApp=createApp(pool,publicOrigin,'public');
  const prior=process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;process.env.FREEDOM_REGISTRATION_COMMUNITY_ID=DEMO_COMMUNITY;
  try {
    const site=await publicApp.request(publicOrigin+'/api/v1/site');const metadata=await site.json() as any;assert.equal(metadata.public_mode,true);assert.equal(metadata.demo_accounts_enabled,false);assert.equal(metadata.registration_enabled,true);
    const response=await publicApp.request(publicOrigin+'/api/v1/auth/register',{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({email:'public-test@example.com',password:'a-public-long-password',nickname:'公開新會員'})});
    assert.equal(response.status,201,JSON.stringify(await response.json()));assert.match(response.headers.get('set-cookie')??'',/Secure/);assert.match(response.headers.get('set-cookie')??'',/HttpOnly/);
  } finally {if(prior===undefined)delete process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;else process.env.FREEDOM_REGISTRATION_COMMUNITY_ID=prior;}
});

test('privacy projection never combines a revoked audience with a newly changed contact',async()=>{
  const owner=await signIn(),viewer=await signIn(DEMO_USERS[1].email);
  await account(owner,{...emptyContacts(),discord:{value:'old-friend-contact',audiences:['friends']}});
  const pending=await request('/friends/'+owner.user.user_id+'/request',viewer,{});
  await request('/friends/'+viewer.user.user_id+'/accept',owner,{},pending.data.aggregate_version);
  const blocker=await pool.connect();let reading:ReturnType<typeof request>|undefined;
  try {
    await blocker.query('BEGIN');await blocker.query('LOCK TABLE member_accounts IN ACCESS EXCLUSIVE MODE');
    reading=request('/members/'+owner.user.user_id,viewer);
    let waiting=false;
    for(let i=0;i<100;i++) {
      const waits=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%member_accounts%' AND application_name=$1",['']);
      if(waits.rows[0].n>0){waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'member read must be waiting on the private contact table');
    await blocker.query("UPDATE member_friendships SET state='removed',aggregate_version=aggregate_version+1 WHERE community_id=$1",[DEMO_COMMUNITY]);
    await blocker.query('UPDATE member_accounts SET contacts=$2 WHERE user_id=$1',[owner.user.user_id,JSON.stringify({...emptyContacts(),discord:{value:'new-contact-after-revocation',audiences:['friends']}})]);
    await blocker.query('COMMIT');
    const result=await reading;assert.equal(result.status,200);
    assert.notEqual(result.data.contacts.discord,'new-contact-after-revocation');
    assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.discord,undefined);
  } finally {await blocker.query('ROLLBACK');blocker.release();if(reading)await reading;}
});

test('public registration cannot poison startup with a reserved demo email domain',async()=>{
  const publicOrigin='https://join.freetwai.com',publicApp=createApp(pool,publicOrigin,'public');
  const prior=process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;process.env.FREEDOM_REGISTRATION_COMMUNITY_ID=DEMO_COMMUNITY;
  try {
    const response=await publicApp.request(publicOrigin+'/api/v1/auth/register',{method:'POST',headers:{Origin:publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({email:'attacker@LOCAL.TEST',password:'a-public-long-password',nickname:'Public visitor'})});
    assert.equal(response.status,422);assert.equal((await response.json() as any).code,'reserved_email_domain');
    assert.equal((await pool.query("SELECT 1 FROM users WHERE email='attacker@local.test'")).rowCount,0);
  } finally {if(prior===undefined)delete process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;else process.env.FREEDOM_REGISTRATION_COMMUNITY_ID=prior;}
});

test('malformed IDs reject before SQL and UUID casing cannot create a self friendship',async()=>{
  const user=await signIn();
  for(const path of ['/members/not-a-uuid','/squads/not-a-uuid'])assert.equal((await request(path,user)).status,422);
  for(const path of ['/friends/not-a-uuid/request','/squads/not-a-uuid/request'])assert.equal((await request(path,user,{})).status,422);
  const mixedId=randomUUID();await pool.query('UPDATE users SET display_name=$2 WHERE user_id=$1',[user.user.user_id,'Self']);
  const registration=await request('/auth/register',undefined,{email:`${mixedId}@example.com`,password:'twelve-plus-characters',nickname:'Case test'}),member=session(registration);
  await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=$1',[member.user.user_id]);
  assert.equal((await request('/friends/'+member.user.user_id.toUpperCase()+'/request',member,{})).status,422);
  assert.equal((await request('/members/'+member.user.user_id.toUpperCase(),member)).data.is_self,true);
});

test('legacy module reads never bypass contact privacy or return authentication material',async()=>{
  const owner=await signIn(),viewer=await signIn(DEMO_USERS[1].email);
  const sentinel='do-not-share-identity@example.com';await account(owner,{...emptyContacts(),email:{audiences:[]},discord:{value:'private-social-sentinel',audiences:[]}});
  const showcase=await request('/showcases',owner,{title:'Public artifact title',description:'An intentionally shared artifact description',artifact_ref:'artifact:public-example',consent_to_share:true});assert.equal(showcase.status,201);
  const forbidden=[sentinel,'private-social-sentinel',owner.user.email,'password_hash','csrf_token','session_hash','login_email'];
  for(const path of ['/work-items','/dashboard','/showcases','/opportunities','/engagements','/supplier/products','/supplier/requests','/retail/catalog','/retail/stores','/retail/listings','/opensource/projects','/marketing/campaigns','/members','/guilds/directory','/squads']) {
    const response=await request(path,viewer);assert.equal(response.status,200,`${path}: ${JSON.stringify(response.data)}`);
    for(const secret of forbidden)assert.ok(!JSON.stringify(response.data).includes(secret),`${path} leaked ${secret}`);
  }
});

test('contact audiences combine friends, guild and squad with OR and revoke after the final relationship ends',async()=>{
  const owner=await signIn(),viewer=await signIn(DEMO_USERS[1].email);
  const saved=await account(owner,{...emptyContacts(),line:{value:'shared-with-selected-groups',audiences:['friends','squad','guild']}});assert.equal(saved.status,200);
  const view=()=>request('/members/'+owner.user.user_id,viewer);
  assert.equal((await view()).data.contacts.line,undefined);
  const invitation=await request('/friends/'+owner.user.user_id+'/request',viewer,{});assert.equal((await view()).data.contacts.line,undefined);
  const friend=await request('/friends/'+viewer.user.user_id+'/accept',owner,{},invitation.data.aggregate_version);
  assert.equal((await view()).data.contacts.line,'shared-with-selected-groups');
  await request('/guilds/guild_ai_vibe/join',owner,{});const guild=await request('/guilds/guild_ai_vibe/join',viewer,{});
  await request('/friends/'+owner.user.user_id+'/remove',viewer,{},friend.data.aggregate_version);
  assert.equal((await view()).data.contacts.line,'shared-with-selected-groups','guild remains selected after friendship removal');
  const squad=await request('/squads',owner,{name:'一起做事',kind:'project',purpose:'確認多組公開範圍'});
  const pending=await request(`/squads/${squad.data.squad_id}/request`,viewer,{});
  const membership=await request(`/squads/${squad.data.squad_id}/members/${viewer.user.user_id}/accept`,owner,{},pending.data.aggregate_version);
  await request('/guilds/guild_ai_vibe/leave',viewer,{},guild.data.aggregate_version);
  assert.equal((await view()).data.contacts.line,'shared-with-selected-groups','squad remains selected after leaving guild');
  await request(`/squads/${squad.data.squad_id}/leave`,viewer,{},membership.data.aggregate_version);
  assert.equal((await view()).data.contacts.line,undefined);
});

test('single login email is private by default, can be explicitly shared, and cannot be changed through contact settings',async()=>{
  const result=await request('/auth/register',undefined,{email:'One.Address@example.com',password:'one-email-login-password',nickname:'只有一個Email'});assert.equal(result.status,201);const owner=session(result);
  const own=await request('/me/account',owner);assert.equal(own.data.contacts.email.value,'one.address@example.com');assert.deepEqual(own.data.contacts.email.audiences,[]);
  assert.equal((await pool.query('SELECT contacts FROM member_accounts WHERE user_id=$1',[owner.user.user_id])).rows[0].contacts.email.value,undefined,'email value must not be duplicated in contact storage');
  await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=$1',[owner.user.user_id]);
  const viewer=await signIn();assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.email,undefined);
  const body={nickname:'只有一個Email',contacts:{...emptyContacts(),email:{audiences:['public','friends','guild']}}};
  const saved=await request('/me/account',owner,body,own.data.aggregate_version);assert.equal(saved.status,200);assert.deepEqual(saved.data.contacts.email.audiences,['public']);assert.equal(saved.data.contacts.email.value,'one.address@example.com');
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.email,'one.address@example.com');
  assert.equal((await request('/members/'+owner.user.user_id)).status,401,'public contact still requires platform member login');
  assert.equal((await request('/me/account',owner,{...body,contacts:{...body.contacts,email:{value:'different@example.com',audiences:['public']}}},saved.data.aggregate_version)).status,422);
  assert.equal((await request('/auth/register',undefined,{email:'another@example.com',password:'another-long-password',nickname:'Rejected duplicate input',contacts:{email:{value:'separate@example.com',audiences:[]}}})).status,422);
  assert.equal((await pool.query('SELECT email FROM users WHERE user_id=$1',[owner.user.user_id])).rows[0].email,'one.address@example.com');
  const privateAgain=await request('/me/account',owner,{...body,contacts:emptyContacts()},saved.data.aggregate_version);assert.equal(privateAgain.status,200);
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.email,undefined);
  for(const audiences of [['friends','friends'],['private'],['admin'],['public','friends','guild','squad','extra'],'friends'])assert.equal((await request('/me/account',owner,{...body,contacts:{...body.contacts,email:{audiences}}},privateAgain.data.aggregate_version)).status,422);
});

test('legacy scalar contact migration preserves social audiences but does not expose substituted login email',async()=>{
  const {readFile}=await import('node:fs/promises');
  const owner=await signIn(),viewer=await signIn(DEMO_USERS[1].email);
  await request('/me/account',owner);await request('/me/account',viewer);
  await pool.query('UPDATE member_accounts SET contacts=$2 WHERE user_id=$1',[owner.user.user_id,JSON.stringify({discord:{value:'old-friends-only',visibility:'friends'},github:{value:'old-public-handle',visibility:'public'},line:{value:'old-private-line',visibility:'private'},email:{value:'formerly-separate@example.com',visibility:'public'}})]);
  await pool.query('UPDATE member_accounts SET contacts=$2 WHERE user_id=$1',[viewer.user.user_id,JSON.stringify({discord:{value:'hidden',visibility:'unknown'},email:{value:viewer.user.email,visibility:'public'}})]);
  const legacyRead=await request('/me/account',owner);assert.deepEqual(legacyRead.data.contacts.discord.audiences,['friends']);assert.deepEqual(legacyRead.data.contacts.email.audiences,[]);assert.equal(legacyRead.data.contacts.email.value,owner.user.email);
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.email,undefined);
  const migration=await readFile(new URL('../../migrations/008_contact_visibility.sql',import.meta.url),'utf8');await pool.query(migration);
  const migrated=await request('/me/account',owner);assert.equal(migrated.data.aggregate_version,legacyRead.data.aggregate_version+1);assert.deepEqual(migrated.data.contacts.email.audiences,[]);assert.deepEqual(migrated.data.contacts.github.audiences,['public']);
  assert.equal((await request('/members/'+owner.user.user_id,viewer)).data.contacts.github,'old-public-handle');
  assert.equal((await request('/members/'+viewer.user.user_id,owner)).data.contacts.email,viewer.user.email,'same-address sharing remains authorized');
  const stored=(await pool.query('SELECT contacts FROM member_accounts WHERE user_id=$1',[owner.user.user_id])).rows[0].contacts;
  assert.deepEqual(stored.email,{audiences:[]});assert.equal(stored.github.visibility,undefined);
  await pool.query(migration);assert.equal((await request('/me/account',owner)).data.aggregate_version,migrated.data.aggregate_version,'normalizing the same state is idempotent');
});
