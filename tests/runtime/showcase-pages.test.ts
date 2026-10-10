import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';

// #402: the community showcase list is paged. In-process requests and a disposable schema only.
const origin='http://127.0.0.1:4316',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_showcase_pages_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:4});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string};
type Page={items:{showcase_id:string;title:string}[];next_offset:number|null};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});

async function signIn(index:number):Promise<Session>{
  const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[index].email,password:DEMO_PASSWORD})});
  return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:(await response.json() as {csrf_token:string}).csrf_token};
}
async function get(path:string,s:Session){
  const response=await app.request(origin+'/api/v1'+path,{headers:{Origin:origin,Cookie:s.cookie,'X-CSRF-Token':s.csrf}});
  return {status:response.status,data:await response.json() as Page};
}

test('the community list pages newest first with stable ties and only published showcases',async()=>{
  const reader=await signIn(1),ids:string[]=[];
  // 45 published rows, 5 sharing one timestamp to pin the tie order, plus a draft and a withdrawn row that never list.
  for(let i=0;i<45;i++){
    const id=randomUUID();ids.push(id);
    await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,created_at)
      VALUES($1,$2,$3,$4,'合成作品',$5,timestamptz '2026-10-01T00:00:00Z'+make_interval(mins=>$6))`,[id,DEMO_COMMUNITY,DEMO_USERS[0].user_id,`作品 ${i}`,`artifact:${id}`,i<5?0:i]);
  }
  for(const status of ['draft','withdrawn'])await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,status,visibility,consent_recorded_at)
    VALUES($1,$2,$3,$4,'不應列出',$5,$6,'private',NULL)`,[randomUUID(),DEMO_COMMUNITY,DEMO_USERS[0].user_id,`未發布 ${status}`,`artifact:${status}`,status]);
  const expected=(await pool.query(`SELECT showcase_id FROM showcases WHERE community_id=$1 AND status='published' ORDER BY created_at DESC,showcase_id`,[DEMO_COMMUNITY])).rows.map(row=>row.showcase_id as string);
  assert.equal(expected.length,45);

  const first=await get('/showcases',reader);
  assert.equal(first.status,200);assert.equal(first.data.items.length,20);assert.equal(first.data.next_offset,20);
  const all=[...first.data.items];let next:number|null=first.data.next_offset;
  while(next!==null){const page=await get(`/showcases?limit=20&offset=${next}`,reader);assert.equal(page.status,200);all.push(...page.data.items);next=page.data.next_offset;}
  assert.deepEqual(all.map(item=>item.showcase_id),expected);
  assert.equal(all.some(item=>item.title.startsWith('未發布')),false);
  const max=await get('/showcases?limit=50',reader);assert.equal(max.data.items.length,45);assert.equal(max.data.next_offset,null);
  const exact=await get('/showcases?limit=45',reader);assert.equal(exact.data.next_offset,null);
  const tail=await get('/showcases?limit=20&offset=40',reader);assert.deepEqual(tail.data.items.map(item=>item.showcase_id),expected.slice(40));assert.equal(tail.data.next_offset,null);
  assert.deepEqual((await get('/showcases?offset=100',reader)).data,{items:[],next_offset:null});
});

test('invalid page parameters are refused',async()=>{
  const reader=await signIn(1);
  for(const query of ['limit=0','limit=51','offset=-1','offset=1.5','offset=9007199254740992','limit=abc','sort=title'])assert.equal((await get(`/showcases?${query}`,reader)).status,422,query);
});

test('an advertised continuation past 10,000 still retrieves the remaining visible rows',async()=>{
  const reader=await signIn(1);
  await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,created_at)
    SELECT gen_random_uuid(),$1,$2,'大量作品 '||n,'合成分頁邊界作品','artifact:page-boundary:'||n,
      timestamptz '2026-10-01T00:00:00Z'+make_interval(secs=>n)
    FROM generate_series(1,10025) n`,[DEMO_COMMUNITY,DEMO_USERS[0].user_id]);
  const expected=(await pool.query(`SELECT showcase_id FROM showcases WHERE community_id=$1 AND status='published'
    ORDER BY created_at DESC,showcase_id OFFSET 10000`,[DEMO_COMMUNITY])).rows.map(row=>row.showcase_id);
  const boundary=await get('/showcases?limit=20&offset=10000',reader);
  assert.equal(boundary.status,200);assert.equal(boundary.data.items.length,20);assert.equal(boundary.data.next_offset,10020);
  const tail=await get(`/showcases?limit=20&offset=${boundary.data.next_offset}`,reader);
  assert.equal(tail.status,200);assert.equal(tail.data.items.length,5);assert.equal(tail.data.next_offset,null);
  assert.deepEqual([...boundary.data.items,...tail.data.items].map(item=>item.showcase_id),expected);
});
