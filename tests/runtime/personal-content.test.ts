import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { migrate } from '../../scripts/database.js';
import { seedLocal, DEMO_USERS, DEMO_PASSWORD, DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { login } from '../../modules/identity-membership/service.js';
import { Problem } from '../../packages/shared/problem.js';
import { listPersonalContent } from '../../modules/community/personal-content.js';
import { listOwnShowcases,readOwnShowcase } from '../../modules/opportunity-project-work/business.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL must name a disposable database');
const schema=`fp_personal_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:url});
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const origin='http://127.0.0.1:4310';
const app=createApp(pool,origin,'local',{personalContentEnabled:true,communitySearchEnabled:true,communityRelationsEnabled:true});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function member(index:number){
  const login=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[index].email,password:DEMO_PASSWORD})});
  assert.equal(login.status,200);
  const session=await login.json() as any;
  const headers={Origin:origin,Cookie:login.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':session.csrf_token,'Content-Type':'application/json'};
  return {headers,request:(path:string,body?:unknown,version?:string,key=randomUUID(),method='POST')=>app.request(origin+'/api/v1/'+path,body===undefined?{headers}:{method,headers:{...headers,'Idempotency-Key':key,...(version?{'If-Match':`"${version}"`}:{})},body:JSON.stringify(body)})};
}

test('private showcase survives re-login and requires explicit versioned publication without duplicate effects',async()=>{
  const owner=await member(0),other=await member(1);
  const body={title:'私人作品續寫254',description:'草稿摘要不可洩漏',public_url:'https://example.com/not-a-public-platform-page'};
  const key=randomUUID();
  const created=await owner.request('me/showcases',body,undefined,key);
  assert.equal(created.status,201,await created.clone().text());
  const draft=await created.json() as any;
  const replay=await owner.request('me/showcases',body,undefined,key);
  assert.equal((await replay.json() as any).showcase_id,draft.showcase_id);
  const id=draft.showcase_id;
  assert.equal(draft.status,'draft');
  assert.equal(draft.public_url,body.public_url);
  assert.equal(draft.visibility,'private');
  assert.equal(draft.consent_recorded_at,null);
  assert.equal((await other.request('me/showcases/'+id)).status,404);
  assert.equal(JSON.stringify(await (await other.request('me/content')).json()).includes(body.title),false);
  assert.equal(JSON.stringify(await (await owner.request('showcases')).json()).includes(body.title),false);
  assert.equal(JSON.stringify(await (await owner.request('community-search?q='+encodeURIComponent(body.title))).json()).includes(body.description),false);
  const again=await member(0);
  const restored=await (await again.request('me/showcases/'+id)).json() as any;
  assert.equal(restored.description,body.description);
  const updatedResponse=await again.request('me/showcases/'+id,{...body,title:body.title+'新版'},restored.aggregate_version,randomUUID(),'PATCH');
  assert.equal(updatedResponse.status,200,await updatedResponse.clone().text());
  const updated=await updatedResponse.json() as any;
  const stale=await again.request('me/showcases/'+id,{...body,title:'過期回覆'},restored.aggregate_version,randomUUID(),'PATCH');
  assert.equal(stale.status,412);
  assert.equal((await again.request('me/showcases/'+id+'/publish',{consent_to_share:false},updated.aggregate_version)).status,422);
  const publishKey=randomUUID();
  const publishedResponse=await again.request('me/showcases/'+id+'/publish',{consent_to_share:true},updated.aggregate_version,publishKey);
  assert.equal(publishedResponse.status,200,await publishedResponse.clone().text());
  const published=await publishedResponse.json() as any;
  assert.equal(published.status,'published');
  const publishedReplay=await again.request('me/showcases/'+id+'/publish',{consent_to_share:true},updated.aggregate_version,publishKey);
  assert.equal(publishedReplay.status,200,await publishedReplay.clone().text());
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM showcases WHERE showcase_id=$1',[id])).rows[0].n,1);
  const listed=await (await other.request('showcases')).json() as any;
  assert.equal(listed.items.filter((item:any)=>item.showcase_id===id).length,1);
  assert.equal((await app.request(origin+'/api/v1/community-search?q='+encodeURIComponent(body.title))).status,200);
  assert.equal(JSON.stringify(await (await app.request(origin+'/api/v1/community-search?q='+encodeURIComponent(body.title))).json()).includes(body.title),false);
  const bookmark=await other.request('community-relations/bookmarks',{kind:'work',id,selected:true});
  assert.equal(bookmark.status,200,await bookmark.clone().text());
  const withdrawn=await again.request('me/showcases/'+id+'/withdraw',{},published.aggregate_version);
  assert.equal(withdrawn.status,200,await withdrawn.clone().text());
  assert.equal(JSON.stringify(await (await other.request('showcases')).json()).includes(body.title),false);
  assert.deepEqual((await (await other.request('community-search?q='+encodeURIComponent(body.title))).json() as any).items,[]);
  const bookmarks=await (await other.request('community-relations/bookmarks')).json() as any;
  assert.equal(bookmarks.items.find((item:any)=>item.id===id).content,null);
  assert.equal((await other.request('community-relations/bookmarks',{kind:'work',id,selected:false})).status,200);
  assert.equal((await other.request('community-relations/bookmarks',{kind:'work',id,selected:true})).status,404);
  const own=await (await again.request('me/content')).json() as any;
  assert.equal(own.items.find((item:any)=>item.id===id).status,'withdrawn');
});

test('personal management flag fails closed before authentication and old direct publication remains available',async()=>{
  const off=createApp(pool,origin,'local');
  for(const path of ['me/content','me/showcases','me/showcases/'+randomUUID()])assert.equal((await off.request(origin+'/api/v1/'+path)).status,404);
  for(const [path,method] of [['me/showcases','POST'],['me/showcases/'+randomUUID(),'PATCH'],['me/showcases/'+randomUUID()+'/publish','POST'],['me/showcases/'+randomUUID()+'/withdraw','POST']]){
    assert.equal((await off.request(origin+'/api/v1/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,404);
  }
  const siteFlags=z.object({personal_content_enabled:z.boolean(),community_relations_enabled:z.boolean()});
  const offSite=siteFlags.parse(await (await off.request(origin+'/api/v1/site')).json());
  assert.equal(offSite.personal_content_enabled,false);
  assert.equal(offSite.community_relations_enabled,false);
  const onSite=siteFlags.parse(await (await app.request(origin+'/api/v1/site')).json());
  assert.equal(onSite.personal_content_enabled,true);
  assert.equal(onSite.community_relations_enabled,true);
  assert.equal((await app.request(origin+'/api/v1/me/content')).status,401);
  const owner=await member(2);
  const direct=await owner.request('showcases',{title:'既有直接分享254',description:'不強迫改走草稿',consent_to_share:true});
  assert.equal(direct.status,201,await direct.clone().text());
  const value=await direct.json() as any;
  assert.equal(value.status,'published');
  assert.equal((await (await owner.request('showcases')).json() as any).items.some((item:any)=>item.showcase_id===value.showcase_id),true);
});

test('prior opportunity retains its published title after owner resumes a private draft',async()=>{
  const owner=await member(0),client=await member(1);
  const shared=await owner.request('showcases',{title:'合作當時的標題254',description:'已分享介紹',consent_to_share:true});
  assert.equal(shared.status,201,await shared.clone().text());
  const source=await shared.json() as any;
  const opportunity=await client.request('opportunities',{showcase_id:source.showcase_id,need:'合作需要'});
  assert.equal(opportunity.status,201,await opportunity.clone().text());
  const withdrawn=await owner.request('me/showcases/'+source.showcase_id+'/withdraw',{},source.aggregate_version);
  assert.equal(withdrawn.status,200,await withdrawn.clone().text());
  const version=(await withdrawn.json() as any).aggregate_version;
  const draft=await owner.request('me/showcases/'+source.showcase_id,{title:'新私人機密標題254',description:'新私人摘要'},version,randomUUID(),'PATCH');
  assert.equal(draft.status,200,await draft.clone().text());
  const records=await (await client.request('opportunities')).json() as any;
  const original=records.items.find((item:any)=>item.showcase_id===source.showcase_id);
  assert.equal(original.showcase_title,'合作當時的標題254');
  assert.equal(JSON.stringify(records).includes('新私人機密標題254'),false);
  assert.equal((await client.request('opportunities',{showcase_id:source.showcase_id,need:'不能對私人草稿發起合作'})).status,404);
});

test('inventory preserves native pending and ready states without exposing other community drafts or granting review',async()=>{
  const owner=await member(2),other=await member(1);
  const skill=randomUUID();
  await pool.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,status,payload,payload_sha256,grant_consumed_at) VALUES($1,$2,$3,'ready_for_review',$4,$5,now())`,[skill,DEMO_COMMUNITY,DEMO_USERS[2].user_id,JSON.stringify({title:'尚未公開投稿254'}),'a'.repeat(64)]);
  const event=await owner.request('events',{title:'尚未審核活動254',description:'待審核摘要',starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+90000000).toISOString(),mode:'online',location:'待審核位置',visibility:'open',capacity:null});
  assert.equal(event.status,201,await event.clone().text());
  const eventSource=await event.json() as any;
  const community=randomUUID(),user=randomUUID(),foreign=randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'個人內容隔離社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'其他作者','hash',$4)`,[user,community,`personal-${user}@local.test`,randomUUID()]);
  await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,status,visibility,consent_recorded_at) VALUES($1,$2,$3,'跨社群私人標題254','跨社群私人摘要','artifact:private254','draft','private',NULL)`,[foreign,community,user]);
  const own=await (await owner.request('me/content')).json() as any;
  assert.equal(own.items.find((item:any)=>item.id===skill).status,'ready_for_review');
  const eventItem=own.items.find((item:any)=>item.id===eventSource.event_id);
  assert.equal(eventItem.status,'pending');assert.equal(eventItem.visibility,'private');
  assert.equal(eventItem.actions.includes('publish'),false);
  assert.equal(JSON.stringify(own).includes('跨社群私人標題254'),false);
  const strangers=await (await other.request('me/content')).json();
  assert.equal(JSON.stringify(strangers).includes('尚未公開投稿254'),false);
  assert.equal(JSON.stringify(strangers).includes('尚未審核活動254'),false);
  assert.equal((await owner.request('me/showcases/'+foreign)).status,404);
  assert.equal((await other.request('events/'+eventSource.event_id+'/review',{decision:'approve',reason:'不能繞過審核'},eventSource.aggregate_version)).status,403);
  assert.equal((await pool.query('SELECT state FROM community_events WHERE event_id=$1',[eventSource.event_id])).rows[0].state,'pending');
});

test('owner inventory and showcase reads reject revoked sessions even when called without HTTP middleware',async()=>{
  const actor=(await login(pool,DEMO_USERS[0].email,DEMO_PASSWORD)).actor;
  const id=randomUUID();
  await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,status,visibility,consent_recorded_at) VALUES($1,$2,$3,'會話私人草稿254','不能洩漏','artifact:session254','draft','private',NULL)`,[id,actor.community_id,actor.user_id]);
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actor.session_hash]);
  const denied=(error:unknown)=>error instanceof Problem&&error.code==='session_expired';
  await assert.rejects(listPersonalContent(pool,actor),denied);
  await assert.rejects(listOwnShowcases(pool,actor),denied);
  await assert.rejects(readOwnShowcase(pool,actor,id),denied);
});

test('all owner reads refresh expiry after blocked source lookups',async()=>{
  const actor=(await login(pool,DEMO_USERS[0].email,DEMO_PASSWORD)).actor;
  const id=randomUUID();
  await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,status,visibility,consent_recorded_at) VALUES($1,$2,$3,'等待私人草稿254','不能洩漏','artifact:expiry254','draft','private',NULL)`,[id,actor.community_id,actor.user_id]);
  const reads=[(q:Pool)=>listPersonalContent(q,actor),(q:Pool)=>listOwnShowcases(q,actor),(q:Pool)=>readOwnShowcase(q,actor,id)];
  for(const [index,read] of reads.entries()){
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=$1",[actor.session_hash]);
    const locker=await pool.connect(),workerName=`${schema}_owner_read_${index}`;
    const racer=new Pool({connectionString:url,options:`-c search_path=${schema}`,application_name:workerName,max:1});
    let pending:Promise<{value?:unknown;error?:unknown}>|undefined;
    try{
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE showcases IN ACCESS EXCLUSIVE MODE');
      pending=read(racer).then(value=>({value}),error=>({error}));
      let waiting=false;
      for(let count=0;count<2000;count+=1){
        waiting=(await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[workerName])).rowCount===1;
        if(waiting)break;
        await nextTurn();
      }
      assert.ok(waiting,'owner read must reach the held source table after session locking');
      await locker.query('SELECT pg_sleep(3.1)');
      await locker.query('COMMIT');
      const outcome=await pending;
      assert.ok(outcome.error instanceof Problem&&outcome.error.code==='session_expired');
    }finally{
      await locker.query('ROLLBACK');locker.release();
      await pending;await racer.end();
    }
  }
});

test('native social notes inventory existing lifecycle without inventing draft or publish actions',async()=>{
  const owner=await member(2);
  const created=await owner.request('social-posts/notes',{text:'原生社群內容254\n第二行'});
  assert.equal(created.status,201,await created.clone().text());
  const post=z.object({post_id:z.string()}).parse(await created.json());
  const inventory=z.object({items:z.array(z.object({kind:z.string(),id:z.string(),status:z.string(),version:z.string().nullable(),actions:z.array(z.string())}))});
  const active=inventory.parse(await (await owner.request('me/content')).json()).items.find(item=>item.id===post.post_id);
  assert.ok(active);
  assert.equal(active.kind,'social_post');
  assert.equal(active.status,'active');
  assert.equal(active.version,null);
  assert.deepEqual(active.actions,['view','withdraw']);
  const removed=await owner.request('social-posts/'+post.post_id,{},undefined,randomUUID(),'DELETE');
  assert.equal(removed.status,200,await removed.clone().text());
  const closed=inventory.parse(await (await owner.request('me/content')).json()).items.find(item=>item.id===post.post_id);
  assert.ok(closed);
  assert.equal(closed.status,'deleted');
  assert.deepEqual(closed.actions,[]);
});
