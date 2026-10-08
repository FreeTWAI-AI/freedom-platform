import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {z} from 'zod';
import {PUBLIC_REVALIDATION_MARKUP} from '../../packages/shared/public-revalidation.js';

const discoverySchema=z.object({sections:z.array(z.object({kind:z.enum(['resources','works','events','highlights','services']),state:z.enum(['ready','unavailable']),items:z.array(z.object({id:z.string(),title:z.string(),summary:z.string(),author_name:z.string().nullable(),occurred_at:z.string().nullable(),path:z.string()}).strict())}).strict())}).strict();
const siteSchema=z.object({community_discovery_enabled:z.boolean()});

const origin='http://127.0.0.1:4310';
const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_discovery_${process.pid}_${Date.now()}`;
const admin=createPool(url);
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
const app=createApp(pool,origin,'local',{communityDiscoveryEnabled:true});
const owner=DEMO_USERS[0].user_id;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities, login_attempts, auth_rate_limits CASCADE');await seedLocal(pool);});
async function event(title:string,visibility='open',ended=false,state='published',organizer=owner){
  const id=randomUUID();
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind,guild_key) VALUES($1,$2,$3,$4,$5,now()+$6::interval,now()+$7::interval,'online','private-location',$8,$9,$10,$11)`,[id,DEMO_COMMUNITY,organizer,title,`${title} summary`,ended?'-2 days':'2 days',ended?'-1 day':'3 days',state,visibility,visibility==='guild'?'guild_skill_exchange':'other',visibility==='guild'?'guild_event_space':null]);
  return id;
}
async function service(title:string,state='active'){
  const id=randomUUID();
  await pool.query(`INSERT INTO member_services(service_id,community_id,owner_user_id,title,category,summary,service_mode,contacts,state) VALUES($1,$2,$3,$4,'other',$5,'online','[{"label":"公開網站","url":"https://example.com/service"}]',$6)`,[id,DEMO_COMMUNITY,owner,title,`${title} summary`,state]);
  return id;
}
async function discovery(){const response=await app.request(origin+'/api/v1/public/community-discovery');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');return discoverySchema.parse(await response.json());}

test('OFF is failclosed and site reports the effective boolean',async()=>{
  const off=createApp(pool,origin);
  const response=await off.request(origin+'/api/v1/public/community-discovery');
  assert.equal(response.status,404);
  assert.equal(siteSchema.parse(await (await off.request(origin+'/api/v1/site')).json()).community_discovery_enabled,false);
  assert.equal(siteSchema.parse(await (await app.request(origin+'/api/v1/site')).json()).community_discovery_enabled,true);
});

test('opt-in public HTML allows only the fixed revalidation script and escapes member scripts',async()=>{
  const malicious='<script>alert("member")</script>';
  const recap=await event(malicious,'open',true);
  const offer=await service(malicious);
  for(const path of ['/services',`/services/${offer}`,'/highlights',`/highlights/${recap}`]){
    const response=await app.request(origin+path);
    assert.equal(response.status,200,path);
    const html=await response.text();
    assert.equal(html.includes(malicious),false,path);
    assert.equal(html.includes(PUBLIC_REVALIDATION_MARKUP),true,path);
    assert.equal(html.replace(PUBLIC_REVALIDATION_MARKUP,'').includes('<script'),false,path);
  }
});

test('bounded real content excludes nonpublic states and all private projection fields',async()=>{
  const visible=await event('public-upcoming');
  const recap=await event('public-recap','open',true);
  const offer=await service('public-service');
  for(const visibility of ['referral','workshop','guild'])await event(`secret-${visibility}`,visibility,true);
  for(const state of ['pending','cancelled','rejected'])await event(`secret-${state}`,'open',false,state);
  await service('secret-paused','paused');
  await service('secret-hidden','hidden');
  for(let i=0;i<5;i++)await event(`public-extra-${i}`);
  const data=await discovery();
  assert.deepEqual(data.sections.map(s=>s.kind),['resources','works','events','highlights','services']);
  assert.ok(data.sections.every(s=>s.state==='ready'&&s.items.length<=3));
  assert.ok(data.sections.find(s=>s.kind==='events')!.items.some(c=>c.id===visible));
  assert.equal(data.sections.find(s=>s.kind==='highlights')!.items[0].id,recap);
  assert.equal(data.sections.find(s=>s.kind==='services')!.items[0].id,offer);
  for(const card of data.sections.flatMap(s=>s.items))assert.deepEqual(Object.keys(card).sort(),['author_name','id','occurred_at','path','summary','title']);
  const text=JSON.stringify(data);
  for(const secret of ['secret-','private-location',owner,DEMO_USERS[0].email,'attending_count','contacts','next_cursor'])assert.equal(text.includes(secret),false,secret);
  const page=await app.request(origin+'/highlights');assert.equal(page.status,200);assert.equal((await page.text()).includes('secret-'),false);
  for(const path of [`/services/${offer}`,`/highlights/${recap}`,`/api/v1/public/events/${visible}`])assert.equal((await app.request(origin+path)).status,200,path);
});

test('referral event links remain readable without entering discovery or indexing',async()=>{
  const id=await event('referral-only','referral');
  const response=await app.request(origin+`/api/v1/public/events/${id}`);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow');
  const data=await response.json();
  assert.equal(data.visibility,'referral');
  assert.equal(JSON.stringify(data).includes('private-location'),false);
  assert.equal(JSON.stringify(await discovery()).includes('referral-only'),false);
  await pool.query("UPDATE users SET active=false WHERE user_id=$1",[owner]);
  assert.equal((await app.request(origin+`/api/v1/public/events/${id}`)).status,404);
});

test('source failure is unavailable while successful zero stays ready and retry reads current truth',async()=>{
  await pool.query('ALTER TABLE member_services RENAME TO temporarily_unavailable_services');
  try{
    const data=await discovery();
    assert.deepEqual(data.sections.find(s=>s.kind==='services'),{kind:'services',state:'unavailable',items:[]});
    assert.deepEqual(data.sections.find(s=>s.kind==='events'),{kind:'events',state:'ready',items:[]});
    assert.equal(JSON.stringify(data).includes('temporarily_unavailable'),false);
  }finally{await pool.query('ALTER TABLE temporarily_unavailable_services RENAME TO member_services');}
  assert.equal((await discovery()).sections.find(s=>s.kind==='services')!.state,'ready');
});

test('visibility revoke removes summaries, canonical HTML and already discovered media immediately',async()=>{
  const id=await event('revoked-recap','open',true);
  const media=randomUUID();
  await pool.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,title,orientation,byte_size,state) VALUES($1,$2,$3,$4,'photo','public photo','landscape',22,'active')`,[media,id,DEMO_COMMUNITY,owner]);
  await pool.query(`INSERT INTO community_event_highlight_images(media_id,variant,bytes) VALUES($1,'image',$2),($1,'thumb',$2)`,[media,Buffer.from('synthetic-public-image')]);
  await pool.query(`INSERT INTO community_event_banners(event_id,image_bytes,orientation) VALUES($1,$2,'landscape')`,[id,Buffer.from('synthetic-public-banner')]);
  const paths=[`/highlights/${id}`,`/api/v1/public/event-highlights/${id}/banner`,`/api/v1/public/event-highlights/media/${media}/image`,`/api/v1/public/event-highlights/media/${media}/thumb`];
  for(const path of paths){const response=await app.request(origin+path);assert.equal(response.status,200,path);assert.equal(response.headers.get('cache-control'),'no-store');}
  assert.equal((await discovery()).sections.find(s=>s.kind==='highlights')!.items[0].id,id);
  await pool.query(`UPDATE community_events SET visibility='workshop' WHERE event_id=$1`,[id]);
  assert.equal(JSON.stringify(await discovery()).includes('revoked-recap'),false);
  for(const path of paths){const response=await app.request(origin+path,{headers:{'If-None-Match':'old'}});assert.equal(response.status,404,path);assert.equal((await response.text()).includes('revoked-recap'),false);}
});

test('owner active and onboarding permission revocation removes details and services without stale cached bytes',async()=>{
  const recap=await event('eligible-recap','open',true);
  const offer=await service('eligible-service');
  await pool.query(`INSERT INTO member_service_covers(service_id,image_bytes) VALUES($1,$2)`,[offer,Buffer.from('synthetic-cover')]);
  const paths=[`/highlights/${recap}`,`/services/${offer}`,`/api/v1/public/member-services/${offer}/cover`];
  for(const mutation of [`onboarding_required=true,onboarding_completed_at=NULL`,`active=false`]){
    await pool.query(`UPDATE users SET ${mutation} WHERE user_id=$1`,[owner]);
    const data=await discovery();assert.equal(JSON.stringify(data).includes('eligible-'),false);
    for(const path of paths)assert.equal((await app.request(origin+path)).status,404,path);
    await pool.query(`UPDATE users SET active=true,onboarding_required=false WHERE user_id=$1`,[owner]);
  }
});

test('verification and cross-community authors cannot enter discovery or anonymous HTML',async()=>{
  const testOwner=randomUUID(),otherOwner=randomUUID(),otherCommunity=randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,community_id,'discovery@example.invalid','secret-verification',password_hash,$2 FROM users WHERE user_id=$3`,[testOwner,randomUUID(),owner]);
  const hidden=await event('secret-verification-event','open',true,'published',testOwner);
  await pool.query(`INSERT INTO communities(community_id,name) VALUES($1,'isolated other community')`,[otherCommunity]);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'other@local.test','secret-other',password_hash,$3 FROM users WHERE user_id=$4`,[otherOwner,otherCommunity,randomUUID(),owner]);
  const otherEvent=randomUUID();
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind) VALUES($1,$2,$3,'secret-cross-community','secret cross summary',now()-interval '2 days',now()-interval '1 day','online','secret place','published','open','other')`,[otherEvent,otherCommunity,otherOwner]);
  const previous=process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;
  process.env.FREEDOM_REGISTRATION_COMMUNITY_ID=DEMO_COMMUNITY;
  try{
    const data=await discovery();assert.equal(JSON.stringify(data).includes('secret-'),false);
    const page=await app.request(origin+'/highlights');assert.equal((await page.text()).includes('secret-'),false);
    for(const id of [hidden,otherEvent])assert.equal((await app.request(origin+`/highlights/${id}`)).status,404);
  }finally{if(previous===undefined)delete process.env.FREEDOM_REGISTRATION_COMMUNITY_ID;else process.env.FREEDOM_REGISTRATION_COMMUNITY_ID=previous;}
});
