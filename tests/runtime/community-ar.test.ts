import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {migrate} from '../../scripts/database.js';
import {createPool} from '../../packages/db/index.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {tokenHash,type Actor} from '../../modules/identity-membership/service.js';
import {saveMemberShare} from '../../modules/identity-membership/member-sharing.js';
import {createArTarget,changeArTarget,listOwnArTargets,listArScene,readPublicAr,readPublicArPattern} from '../../modules/community-ar/index.js';
import {uploadArPattern} from '../../modules/community-ar/assets.js';
import {createArExperience,inspectArExperience} from '../../packages/asset-storage/ar-target.js';
import {Problem} from '../../packages/shared/problem.js';

const connectionString=process.env.TEST_DATABASE_URL;if(!connectionString)throw new Error('AR SQL tests require isolated TEST_DATABASE_URL');
const schema=`fp_ar_${process.pid}_${Date.now()}`,admin=createPool(connectionString),pool=new Pool({connectionString,options:`-c search_path=${schema} -c statement_timeout=10000`,max:12}),community=randomUUID();
const pattern=readFileSync(new URL('../fixtures/community-ar/card.mind',import.meta.url));let initialized=false;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);initialized=true;await migrate(pool);});
after(async()=>{await pool.end();if(initialized)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities CASCADE');await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic AR community']);});
const problem=(code:string)=>(error:unknown)=>error instanceof Problem&&error.code===code;
async function member():Promise<Actor>{const id=randomUUID(),hash=tokenHash(randomUUID());const row=(await pool.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,community,`${id}@ar.local.test`,'Synthetic AR member','not-a-login-hash',randomUUID()])).rows[0];await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[hash,id]);return {...row,session_hash:hash,csrf_token:'synthetic'};}
const command=(actor:Actor,body:unknown={},expected?:string,key=randomUUID())=>({actor,body,expected,key,operation:'synthetic-ar'});
async function card(actor:Actor){const existing=(await pool.query('SELECT aggregate_version FROM member_card_shares WHERE user_id=$1',[actor.user_id])).rows[0];return saveMemberShare(pool,command(actor,{enabled:true,include_avatar:false},existing?.aggregate_version));}
async function uploaded(owner:Actor,store=new FakeObjectStore(),kind:'member'|'custom'='member'){
  if(kind==='member')await card(owner);const created=await createArTarget(pool,command(owner,{kind,title:'Synthetic pattern'}));
  const bytes=kind==='custom'?createArExperience(pattern,{version:1,kind:'effect',text:'Hello',effect:'halo'}):pattern;
  const key=randomUUID(),result=await uploadArPattern(pool,store,owner,created.target_id,'1',key,bytes);return {created,result,key,store,bytes};
}
async function published(owner:Actor,kind:'member'|'custom'='member'){
  const value=await uploaded(owner,undefined,kind),result=await changeArTarget(pool,command(owner,{},value.result.aggregate_version),value.created.target_id,true);
  const token=result.share_path!.split('/').at(-1)!;return {...value,published:result,token};
}
test('AR-SQL-01 default policy is OFF, and enabling is explicit test-only setup',async()=>{
  const owner=await member();await card(owner);await assert.rejects(createArTarget(pool,command(owner,{kind:'member',title:'Synthetic'})),problem('ar_unavailable'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM community_ar_targets')).rows[0].n,0);
  await pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='synthetic-ar-v1',persistence_allowed=true,retained_byte_limit=104857600 WHERE purpose='member.ar-target'");
});
test('AR-SQL-02 durable upload/publish replay writes one Asset, survives reload, and preserves opaque public boundaries',async()=>{
  const owner=await member(),v=await published(owner);
  assert.deepEqual(await uploadArPattern(pool,v.store,owner,v.created.target_id,'1',v.key,v.bytes),v.result);
  assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);
  const own=await listOwnArTargets(pool,owner);assert.equal(own.items[0].state,'published');
  const pub=await readPublicAr(pool,v.token);assert.ok('nickname' in pub.content);assert.equal(pub.content.nickname,'Synthetic AR member');assert.equal('email' in pub.content,false);
  assert.deepEqual(await readPublicArPattern(pool,v.token,v.store),new Uint8Array(v.bytes));
  const scene=await listArScene(pool,owner);assert.equal(scene.items.length,1);
});
test('AR-SQL-03 another member cannot upload, publish, withdraw or replace an owned pattern',async()=>{
  const owner=await member(),other=await member(),v=await published(owner);
  await assert.rejects(uploadArPattern(pool,v.store,other,v.created.target_id,'1',randomUUID(),v.bytes),problem('ar_target_not_found'));
  await assert.rejects(changeArTarget(pool,command(other,{},v.published.aggregate_version),v.created.target_id,false),problem('ar_target_not_found'));
  await assert.rejects(uploadArPattern(pool,v.store,owner,v.created.target_id,v.published.aggregate_version,randomUUID(),v.bytes),problem('ar_pattern_exists'));
});
test('AR-SQL-04 share closure/rotation and withdrawal revoke public pattern after provider I/O as well as fresh reads',async()=>{
  const owner=await member(),v=await published(owner),get=v.store.get.bind(v.store);let readStarted!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>readStarted=resolve),hold=new Promise<void>(resolve=>release=resolve);
  v.store.get=async(...args)=>{readStarted();await hold;return get(...args);};
  const read=readPublicArPattern(pool,v.token,v.store),rejected=assert.rejects(read,problem('ar_target_unavailable'));await entered;
  await pool.query('UPDATE member_card_shares SET enabled=false WHERE user_id=$1',[owner.user_id]);release();await rejected;
  await assert.rejects(readPublicAr(pool,v.token),problem('ar_target_unavailable'));
  await pool.query('UPDATE member_card_shares SET enabled=true,share_token=$2 WHERE user_id=$1',[owner.user_id,'Z'.repeat(43)]);
  await assert.rejects(readPublicAr(pool,v.token),problem('ar_target_unavailable'));
  await changeArTarget(pool,command(owner,{},v.published.aggregate_version),v.created.target_id,false);
  assert.equal((await listOwnArTargets(pool,owner)).items[0].state,'withdrawn');
});
test('AR-SQL-05 two identical images cannot publish as two destinations; stale CAS never alters the active target',async()=>{
  const a=await member(),b=await member(),v=await published(a),other=await uploaded(b);
  await assert.rejects(changeArTarget(pool,command(b,{},other.result.aggregate_version),other.created.target_id,true),problem('ar_pattern_duplicate'));
  await assert.rejects(changeArTarget(pool,command(a,{},'1'),v.created.target_id,false),problem('version_conflict'));
  assert.equal((await listOwnArTargets(pool,a)).items[0].state,'published');
});
test('AR-SQL-06 malformed packet commits no quota; expired session cannot replay stored success',async()=>{
  const owner=await member();await card(owner);const created=await createArTarget(pool,command(owner,{kind:'member',title:'Synthetic'}));
  await assert.rejects(uploadArPattern(pool,new FakeObjectStore(),owner,created.target_id,'1',randomUUID(),new Uint8Array([1,2,3])));
  assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);
  const v=await uploaded(owner);await pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[owner.session_hash]);
  await assert.rejects(uploadArPattern(pool,v.store,owner,v.created.target_id,'1',v.key,v.bytes),problem('session_expired'));
});
test('AR-SQL-07 custom text/effect use the same immutable Asset, and same-key different content conflicts',async()=>{
  const owner=await member(),v=await published(owner,'custom'),pub=await readPublicAr(pool,v.token);
  assert.equal(pub.kind,'custom');assert.deepEqual(pub.binding,{version:1,kind:'effect',text:'Hello',effect:'halo'});
  assert.equal(inspectArExperience(await readPublicArPattern(pool,v.token,v.store)).binding?.kind,'effect');
  await assert.rejects(uploadArPattern(pool,v.store,owner,v.created.target_id,'1',v.key,createArExperience(pattern,{version:1,kind:'text',text:'changed'})));
});
test('AR-SQL-08 current-clock expiry across a real target lock wait prevents metadata disclosure',async()=>{
  const owner=await member(),v=await uploaded(owner),blocker=await pool.connect();await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1.2 seconds' WHERE token_hash=$1",[owner.session_hash]);
  await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM community_ar_targets WHERE target_id=$1 FOR UPDATE',[v.created.target_id]);
  const pending=changeArTarget(pool,command(owner,{},v.result.aggregate_version),v.created.target_id,true),rejected=assert.rejects(pending,problem('session_expired'));
  const pid=(await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;let blocked=false;
  try{for(let i=0;i<100;i++){blocked=(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) b',[pid])).rows[0].b;if(blocked)break;await delay(10);}assert.equal(blocked,true);while(!(await pool.query('SELECT expires_at<=clock_timestamp() e FROM sessions WHERE token_hash=$1',[owner.session_hash])).rows[0].e)await delay(20);}
  finally{await blocker.query('ROLLBACK');blocker.release();}await rejected;
  assert.equal((await pool.query('SELECT state FROM community_ar_targets WHERE target_id=$1',[v.created.target_id])).rows[0].state,'draft');
});

test('AR-SQL-09 media bindings persist normalized image bytes and bounded video in the same Asset, never SQL',async()=>{
  const owner=await member(),store=new FakeObjectStore();
  for(const kind of ['image','video'] as const){
    const source=readFileSync(new URL(`../fixtures/community-ar/${kind==='image'?'card.png':'positive.webm'}`,import.meta.url));
    const bytes=createArExperience(pattern,{version:1,kind,text:'Synthetic media',mime:kind==='image'?'image/png':'video/webm',media:source});
    const created=await createArTarget(pool,command(owner,{kind:'custom',title:`Synthetic ${kind}`}));
    const uploaded=await uploadArPattern(pool,store,owner,created.target_id,'1',randomUUID(),bytes);
    const pub=await changeArTarget(pool,command(owner,{},uploaded.aggregate_version),created.target_id,true),token=pub.share_path!.split('/').at(-1)!;
    const binding=inspectArExperience(await readPublicArPattern(pool,token,store)).binding;
    assert.equal(binding?.kind,kind);assert.ok(binding&&'media' in binding);assert.equal(binding.mime,kind==='image'?'image/webp':'video/webm');
    if(kind==='image')assert.equal(String.fromCharCode(...binding.media.subarray(8,12)),'WEBP');else assert.deepEqual(binding.media,new Uint8Array(source));
    const config=(await pool.query('SELECT content_config FROM community_ar_targets WHERE target_id=$1',[created.target_id])).rows[0].content_config;
    assert.equal('media' in config,false);assert.ok(JSON.stringify(config).length<512);
    await changeArTarget(pool,command(owner,{},pub.aggregate_version),created.target_id,false);
  }
});

test('AR-SQL-10 event scanning requires explicit pattern opt-in and current public event; RSVP conveys no visibility',async()=>{
  const organizer=await member(),owner=await member(),id=randomUUID();
  await pool.query("INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind) VALUES($1,$2,$3,'Synthetic activity','Synthetic',clock_timestamp()+interval '2 days',clock_timestamp()+interval '3 days','online','Synthetic','published','open','other')",[id,community,organizer.user_id]);
  const existing=await published(owner,'custom');
  await pool.query("INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state) VALUES($1,$2,$3,'going')",[randomUUID(),id,owner.user_id]);
  assert.equal((await listArScene(pool,organizer,id)).items.length,0);
  await assert.rejects(createArTarget(pool,command(owner,{kind:'event',event_id:id,title:'Wrong organizer'})),problem('ar_event_closed'));
  await changeArTarget(pool,command(owner,{},existing.published.aggregate_version),existing.created.target_id,false);
  const target=await createArTarget(pool,command(owner,{kind:'custom',scene_event_id:id,title:'Explicit public activity pattern'}));
  const uploaded=await uploadArPattern(pool,new FakeObjectStore(),owner,target.target_id,'1',randomUUID(),existing.bytes);
  await changeArTarget(pool,command(owner,{},uploaded.aggregate_version),target.target_id,true);
  const scene=await listArScene(pool,organizer,id);assert.equal(scene.items.length,1);assert.equal('user_id' in scene.items[0],false);assert.equal('rsvp' in scene.items[0],false);
  await pool.query("UPDATE community_events SET state='cancelled' WHERE event_id=$1",[id]);
  assert.equal((await listArScene(pool,organizer,id)).items.length,0);
  await assert.rejects(createArTarget(pool,command(owner,{kind:'custom',scene_event_id:id,title:'Closed event'})),problem('ar_scene_unavailable'));
});

for(const bytes of [20971519,20971520])test(`AR-SQL-11 publishing policy agrees with the ${bytes}-byte reservation boundary`,async()=>{
  const owner=await member();
  await pool.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='synthetic-ar-quota-boundary',persistence_allowed=true,retained_byte_limit=$1 WHERE purpose='member.ar-target'",[bytes]);
  const available=bytes===20971520;
  if(!available)await assert.rejects(createArTarget(pool,command(owner,{kind:'custom',title:'Below one reservation'})),problem('ar_unavailable'));
  assert.equal((await listOwnArTargets(pool,owner)).publishing_enabled,available);
  if(available){
    const value=await uploaded(owner,undefined,'custom');
    assert.ok(value.result.aggregate_version);
    assert.equal((await pool.query("SELECT count(*)::int n FROM assets WHERE purpose='member.ar-target'")).rows[0].n,1);
  }else{
    assert.equal((await pool.query('SELECT count(*)::int n FROM community_ar_targets')).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM assets WHERE purpose='member.ar-target'")).rows[0].n,0);
  }
});
