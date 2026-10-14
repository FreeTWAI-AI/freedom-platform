import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {Pool} from 'pg';
import {z} from 'zod';
import {LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';

const database=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_squad_cutover_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:database}),pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,application_name:schema,max:12});
const origin='http://127.0.0.1:4334',record=z.record(z.string(),z.unknown());
type Session={cookie:string;csrf:string;id:string};
type RequestResult={status:number;data:Record<string,unknown>;cookie:string|null};
type Signal={promise:Promise<void>;resolve:()=>void};
type ReadGate={id:string;prefix:string;used:boolean;readerPid?:number;held:Signal;released:Signal};
let gate:ReadGate|undefined;
function signal():Signal{
  let resolve:(()=>void)|undefined;
  const promise=new Promise<void>(done=>{resolve=done});assert.ok(resolve);
  return {promise,resolve};
}
// Delay one real SQL result's delivery. Never replace a row, command or HTTP reply.
// The client proxy retains the actual transaction so a fix cannot escape the race fixture.
function observe<T extends object>(target:T):T{
  return new Proxy(target,{get(target,property,receiver){
    const value=Reflect.get(target,property,receiver);
    if(property==='connect'&&target===pool){
      assert.ok(typeof value==='function');
      return async(...args:unknown[])=>{
        const client=await Reflect.apply(value,target,args);assert.ok(client&&typeof client==='object');return observe(client);
      };
    }
    if(property==='query'){
      assert.ok(typeof value==='function');
      return async(...args:unknown[])=>{
      const result=await Reflect.apply(value,target,args),current=gate;
      if(current&&!current.used&&typeof args[0]==='string'&&args[0].startsWith(current.prefix)&&Array.isArray(args[1])&&args[1][0]===current.id){
        current.used=true;
        if(target!==pool)current.readerPid=z.object({processID:z.number()}).parse(target).processID;
        current.held.resolve();await current.released.promise;
      }
      return result;
      };
    }
    return typeof value==='function'?value.bind(target):value;
  }});
}
const app=createApp(observe(pool),origin);
async function request(path:string,session?:Session,body?:unknown,version?:number):Promise<RequestResult>{
  const headers:Record<string,string>={Origin:origin};if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf;}
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();if(version!==undefined)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:record.parse(await response.json()),cookie:response.headers.get('set-cookie')};
}
async function member(name:string):Promise<Session>{
  const result=await request('/auth/register',undefined,{email:`${randomUUID()}@example.test`,nickname:name,password:'freedom-squad-cutover-password'});assert.equal(result.status,201);
  const parsed=z.object({csrf_token:z.string(),user:z.object({user_id:z.uuid()})}).parse(result.data);assert.ok(result.cookie);
  const session={cookie:result.cookie.split(';')[0],csrf:parsed.csrf_token,id:parsed.user.user_id};
  assert.equal((await request('/me/onboarding/quick-start',session,{guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')})).status,200);return session;
}
async function squad(owner:Session,successor:Session){
  const created=await request('/squads',owner,{name:'權限切換合成小隊',kind:'project',purpose:'私人成員讀取競態'});assert.equal(created.status,201);
  const id=z.object({squad_id:z.uuid()}).parse(created.data).squad_id;
  assert.equal((await request(`/squads/${id}/request`,successor,{})).status,200);
  assert.equal((await request(`/squads/${id}/members/${successor.id}/accept`,owner,{},1)).status,200);return id;
}
function pause(id:string,prefix:string):ReadGate{gate={id,prefix,used:false,held:signal(),released:signal()};return gate;}
async function waitHeld(held:Signal){
  let reached=false;void held.promise.then(()=>{reached=true});const deadline=Date.now()+8000;
  while(!reached){assert.ok(Date.now()<deadline,'metadata must reach the real SQL result gate');await setImmediate();}
}
// Allow either a complete statement snapshot or a serialized transaction.
// A real queued writer must be released by finishing the reader, not by a test timeout.
async function cutover(held:ReadGate,reading:Promise<RequestResult>,write:()=>Promise<RequestResult>,afterCommit:()=>Promise<void>){
  const writing=write();let settled=false;void writing.then(()=>{settled=true},()=>{settled=true});
  const deadline=Date.now()+8000;
  try{
    while(!settled){
      if(held.readerPid!==undefined){
        const blocked=z.object({blocked:z.boolean()}).parse((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS blocked',[schema,held.readerPid])).rows[0]).blocked;
        if(blocked){held.released.resolve();break;}
      }
      assert.ok(Date.now()<deadline,'the concurrent writer must commit or queue behind the reader');await setImmediate();
    }
    const written=await writing;assert.equal(written.status,200,JSON.stringify(written.data));
    await afterCommit();held.released.resolve();return await reading;
  }finally{held.released.resolve();await writing;await reading;}
}
const detail=z.object({owner_ref:z.uuid(),disbanded_at:z.string().nullable(),members:z.array(z.object({user_id:z.uuid(),state:z.string()}))});

test('squad ownership and active grants stay coherent across concurrent cutovers',async t=>{
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);
    const owner=await member('原隊主'),successor=await member('新隊主'),applicant=await member('轉移後申請者'),recipient=await member('私人邀請收件者');
    await t.test('a former owner cannot borrow its old metadata to read a new owners pending request',async()=>{
      const id=await squad(owner,successor),held=pause(id,'SELECT s.* FROM member_squads');let reading:Promise<RequestResult>|undefined;
      try{
        reading=request(`/squads/${id}`,owner);await waitHeld(held.held);
        const before=await cutover(held,reading,()=>request(`/squads/${id}/transfer`,owner,{user_id:successor.id},1),async()=>{assert.equal((await request(`/squads/${id}/request`,applicant,{})).status,200);});
        assert.equal(before.status,200);const prior=detail.parse(before.data);assert.equal(prior.owner_ref,owner.id);
        assert.equal(prior.members.some(m=>m.user_id===applicant.id),false,'old ownership must not expose a request created after transfer');
        const former=await request(`/squads/${id}`,owner),current=await request(`/squads/${id}`,successor);assert.equal(former.status,200);assert.equal(current.status,200);
        assert.equal(detail.parse(former.data).owner_ref,successor.id);assert.equal(detail.parse(former.data).members.some(m=>m.user_id===applicant.id),false);
        assert.equal(detail.parse(current.data).members.some(m=>m.user_id===applicant.id&&m.state==='pending'),true);
      }finally{held.released.resolve();gate=undefined;if(reading)await reading;}
    });
    await t.test('owner-only history does not mix an old owner grant with post-transfer withdrawal',async()=>{
      const id=await squad(owner,successor);assert.equal((await request(`/squads/${id}/invitations`,owner,{recipient_ref:recipient.id})).status,200);
      const held=pause(id,'SELECT squad_id,name,owner_ref FROM member_squads');let reading:Promise<RequestResult>|undefined;
      try{
        reading=request(`/squads/${id}/invitations`,owner);await waitHeld(held.held);
        const before=await cutover(held,reading,()=>request(`/squads/${id}/transfer`,owner,{user_id:successor.id},1),async()=>{assert.equal((await request(`/squads/${id}/invitations`,successor,{recipient_ref:applicant.id})).status,200);});
        assert.equal(before.status,200);const items=z.object({items:z.array(z.object({recipient_ref:z.uuid(),state:z.string()}))}).parse(before.data).items;
        assert.deepEqual(items.map(i=>({recipient:i.recipient_ref,state:i.state})),[{recipient:recipient.id,state:'pending'}]);
        const former=await request(`/squads/${id}/invitations`,owner);assert.equal(former.status,403);assert.equal(former.data.code,'squad_owner_required');
        const current=await request(`/squads/${id}/invitations`,successor);assert.equal(current.status,200);
        assert.deepEqual(z.object({items:z.array(z.object({recipient_ref:z.uuid(),state:z.string()}))}).parse(current.data).items.map(i=>({recipient:i.recipient_ref,state:i.state})),[{recipient:applicant.id,state:'pending'}]);
      }finally{held.released.resolve();gate=undefined;if(reading)await reading;}
    });
    await t.test('disband cannot combine active metadata with the post-disband roster',async()=>{
      const id=await squad(owner,successor),held=pause(id,'SELECT s.* FROM member_squads');let reading:Promise<RequestResult>|undefined;
      try{
        reading=request(`/squads/${id}`,owner);await waitHeld(held.held);
        const before=await cutover(held,reading,()=>request(`/squads/${id}/disband`,owner,{},1),async()=>{assert.equal((await request(`/squads/${id}/invitations`,owner)).status,404);});
        assert.equal(before.status,200);const prior=detail.parse(before.data);assert.equal(prior.disbanded_at,null);
        assert.deepEqual(prior.members.map(m=>({id:m.user_id,state:m.state})).sort((a,b)=>a.id.localeCompare(b.id)),[owner,successor].map(m=>({id:m.id,state:'active'})).sort((a,b)=>a.id.localeCompare(b.id)));
        const current=await request(`/squads/${id}`,owner);assert.equal(current.status,404);assert.equal(current.data.code,'squad_not_found');
      }finally{held.released.resolve();gate=undefined;if(reading)await reading;}
    });
  }finally{gate?.released.resolve();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
