import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

// #400: owners decline, remove, edit, transfer and disband. In-process requests and a disposable schema only.
const origin='http://127.0.0.1:4314',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_squad_manage_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;id:string};
type Squad={squad_id:string;name:string;purpose:string;owner_ref:string;aggregate_version:string|number;members:{user_id:string;state:string;aggregate_version:string|number}[]};
type Problem={code?:string};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});

async function request<T=Problem>(path:string,s:Session|undefined,body?:unknown,version?:string|number){
  const headers:Record<string,string>={Origin:origin,...(s?{Cookie:s.cookie,'X-CSRF-Token':s.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();if(version!==undefined)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as T};
}
async function signIn(index:number):Promise<Session>{
  const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[index].email,password:DEMO_PASSWORD})});
  const data=await response.json() as {csrf_token:string;user:{user_id:string}};
  return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf_token,id:data.user.user_id};
}
async function team(){
  const owner=await signIn(0),a=await signIn(1),b=await signIn(2);
  const made=await request<Squad>('/squads',owner,{name:'管理測試小隊',kind:'project',purpose:'合成管理測試'});assert.equal(made.status,201);
  const id=made.data.squad_id;
  for(const member of [a,b])assert.equal((await request(`/squads/${id}/request`,member,{})).status,200);
  return {owner,a,b,id};
}
const view=(s:Session,id:string)=>request<Squad>(`/squads/${id}`,s);
const member=async(id:string,user:string)=>(await pool.query('SELECT state,aggregate_version FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2',[id,user])).rows[0];

test('the owner declines a request and removes an active member, who is told; members cannot do either',async()=>{
  const {owner,a,b,id}=await team();
  const pendingA=await member(id,a.id);
  const byMember=await request(`/squads/${id}/members/${b.id}/decline`,a,{},(await member(id,b.id)).aggregate_version);
  assert.equal(byMember.status,403);assert.equal(byMember.data.code,'squad_owner_required');
  assert.equal((await request(`/squads/${id}/members/${a.id}/decline`,owner,{},pendingA.aggregate_version)).status,200);
  assert.equal((await member(id,a.id)).state,'left');
  assert.equal((await request(`/squads/${id}/members/${a.id}/remove`,owner,{},(await member(id,a.id)).aggregate_version)).data.code,'squad_member_required');
  assert.equal((await request(`/squads/${id}/members/${b.id}/accept`,owner,{},(await member(id,b.id)).aggregate_version)).status,200);
  const stale=(await member(id,b.id)).aggregate_version;
  assert.equal((await request(`/squads/${id}/members/${owner.id}/remove`,owner,{},(await member(id,owner.id)).aggregate_version)).data.code,'squad_owner_cannot_leave');
  const removed=await request(`/squads/${id}/members/${b.id}/remove`,owner,{},stale);
  assert.equal(removed.status,200,JSON.stringify(removed.data));
  assert.equal((await member(id,b.id)).state,'left');
  const notes=(await pool.query("SELECT kind,action_tab,action_resource_id,title FROM member_notifications WHERE recipient_ref=$1 AND kind='squad_member_removed'",[b.id])).rows;
  assert.equal(notes.length,1);assert.equal(notes[0].action_tab,'squads');assert.equal(notes[0].action_resource_id,id);assert.match(notes[0].title,/管理測試小隊/);
  assert.equal((await request(`/squads/${id}/members/${b.id}/remove`,owner,{},stale)).status,412);
  // A removed member may ask again; the owner decides again.
  assert.equal((await request(`/squads/${id}/request`,b,{},(await member(id,b.id)).aggregate_version)).status,200);
  assert.equal((await member(id,b.id)).state,'pending');
});

test('the owner edits name and purpose with If-Match; others and invalid input are refused',async()=>{
  const {owner,a,id}=await team();
  const current=(await view(owner,id)).data.aggregate_version;
  assert.equal((await request(`/squads/${id}/profile`,a,{name:'搶改',purpose:'x'},current)).status,403);
  assert.equal((await request(`/squads/${id}/profile`,owner,{name:'',purpose:'x'},current)).status,422);
  assert.equal((await request(`/squads/${id}/profile`,owner,{name:'新名字',purpose:'新目標',kind:'coaching'},current)).status,422);
  assert.equal((await request(`/squads/${id}/profile`,owner,{name:'新名字',purpose:'新目標'})).status,428);
  const saved=await request<Squad>(`/squads/${id}/profile`,owner,{name:' 新名字 ',purpose:'新目標'},current);
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.name,'新名字');assert.equal(saved.data.purpose,'新目標');
  assert.equal((await request(`/squads/${id}/profile`,owner,{name:'再改',purpose:'再改'},current)).status,412);
});

test('transfer hands ownership to an active member, withdraws old invitations and then lets the old owner leave',async()=>{
  const {owner,a,b,id}=await team();
  await request(`/squads/${id}/members/${a.id}/accept`,owner,{},(await member(id,a.id)).aggregate_version);
  const outsider=(await pool.query("SELECT user_id FROM users WHERE user_id<>ALL($1::uuid[]) LIMIT 1",[[owner.id,a.id,b.id]])).rows[0]?.user_id as string|undefined;
  // b is still pending: not a transfer target.
  let version=(await view(owner,id)).data.aggregate_version;
  assert.equal((await request(`/squads/${id}/transfer`,owner,{user_id:b.id},version)).data.code,'squad_member_required');
  assert.equal((await request(`/squads/${id}/transfer`,owner,{user_id:owner.id},version)).status,422);
  assert.equal((await request(`/squads/${id}/transfer`,a,{user_id:owner.id},version)).status,403);
  if(outsider)assert.notEqual((await request(`/squads/${id}/transfer`,owner,{user_id:outsider},version)).status,200);
  await pool.query(`INSERT INTO member_squad_invitations(invitation_id,community_id,squad_id,owner_ref,recipient_ref,state)
    SELECT $1,community_id,squad_id,owner_ref,$2,'pending' FROM member_squads WHERE squad_id=$3`,[randomUUID(),b.id,id]);
  const moved=await request<Squad>(`/squads/${id}/transfer`,owner,{user_id:a.id},version);
  assert.equal(moved.status,200,JSON.stringify(moved.data));assert.equal(moved.data.owner_ref,a.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM member_squad_invitations WHERE squad_id=$1 AND state='pending'",[id])).rows[0].n,0);
  assert.equal((await request(`/squads/${id}/transfer`,owner,{user_id:a.id},version)).status,403);
  // The new owner manages; the old owner is an ordinary member who may now leave.
  assert.equal((await request(`/squads/${id}/members/${b.id}/accept`,owner,{},(await member(id,b.id)).aggregate_version)).status,403);
  assert.equal((await request(`/squads/${id}/members/${b.id}/accept`,a,{},(await member(id,b.id)).aggregate_version)).status,200);
  assert.equal((await request(`/squads/${id}/leave`,a,{},(await member(id,a.id)).aggregate_version)).data.code,'squad_owner_cannot_leave');
  assert.equal((await request(`/squads/${id}/leave`,owner,{},(await member(id,owner.id)).aggregate_version)).status,200);
  version=(await view(a,id)).data.aggregate_version;
  assert.ok(Number(version)>1);
});

test('a new owner already leading ten squads is refused by the same owner limit',async()=>{
  const {owner,a,id}=await team();
  await request(`/squads/${id}/members/${a.id}/accept`,owner,{},(await member(id,a.id)).aggregate_version);
  for(let i=0;i<10;i++)assert.equal((await request('/squads',a,{name:`a 的小隊 ${i}`,kind:'project',purpose:'上限'})).status,201);
  const refused=await request(`/squads/${id}/transfer`,owner,{user_id:a.id},(await view(owner,id)).data.aggregate_version);
  assert.equal(refused.status,409);assert.equal(refused.data.code,'squad_limit');
});

test('disband ends the squad for everyone: memberships leave, invitations withdraw, it disappears and stops accepting writes',async()=>{
  const {owner,a,b,id}=await team();
  await request(`/squads/${id}/members/${a.id}/accept`,owner,{},(await member(id,a.id)).aggregate_version);
  await pool.query(`INSERT INTO member_squad_invitations(invitation_id,community_id,squad_id,owner_ref,recipient_ref,state)
    SELECT $1,community_id,squad_id,owner_ref,$2,'pending' FROM member_squads WHERE squad_id=$3`,[randomUUID(),b.id,id]);
  const posted=await request(`/me/channels/squad/${id}/messages`,a,{body:'解散前的訊息'});assert.equal(posted.status,201,JSON.stringify(posted.data));
  const version=(await view(owner,id)).data.aggregate_version;
  assert.equal((await request(`/squads/${id}/disband`,a,{},version)).status,403);
  assert.equal((await request(`/squads/${id}/disband`,owner,{reason:'x'},version)).status,422);
  const done=await request<{squad_id:string;disbanded_at:string}>(`/squads/${id}/disband`,owner,{},version);
  assert.equal(done.status,200,JSON.stringify(done.data));assert.ok(done.data.disbanded_at);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM member_squad_memberships WHERE squad_id=$1 AND state<>'left'",[id])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM member_squad_invitations WHERE squad_id=$1 AND state='pending'",[id])).rows[0].n,0);
  assert.equal((await view(owner,id)).status,404);
  assert.equal((await request<{items:{squad_id:string}[]}>('/squads?limit=50&offset=0',b)).data.items.some(item=>item.squad_id===id),false);
  assert.equal((await request(`/squads/${id}/request`,b,{},(await member(id,b.id)).aggregate_version)).status,404);
  assert.equal((await request(`/me/channels/squad/${id}/messages`,a,{body:'解散後'})).status,404);
  assert.equal((await request(`/squads/${id}/disband`,owner,{},version)).status,404);
  // Disbanded squads no longer count toward the owner's limit; the journal keeps the history.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM transition_journal WHERE aggregate_id=$1 AND command='disband_squad'",[id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_channel_messages WHERE channel_key=$1',[id])).rows[0].n,1);
});
