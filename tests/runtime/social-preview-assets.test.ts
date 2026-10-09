import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import sharp from 'sharp';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createR2ObjectStore,type AssetR2Binding} from '../../packages/asset-storage/r2.js';
import {migrate} from '../../scripts/database.js';
import {tokenHash,type Actor} from '../../modules/identity-membership/service.js';
import {createSocialThumbnailAssetService,resolveSocialThumbnailUploadPolicy} from '../../modules/assets/social-thumbnail.js';
import {saveSocialThumbnail,readSocialThumbnail,publicSocialThumbnail,deleteSocialPost,createSocialPost,createNativeSocialPost,listSocialPosts} from '../../modules/community/social-posts.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {sha256,objectKey} from '../../packages/asset-storage/index.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {previewLink} from '../../modules/community/link-preview.js';
import {Problem} from '../../packages/shared/problem.js';
const url=process.env.TEST_DATABASE_URL;if(!url)throw new Error('Explicit isolated TEST_DATABASE_URL required');
const schema=`fp_social_preview_${process.pid}_${Date.now()}`,role=`${schema}_app`,admin=new Pool({connectionString:url}),fixture=new Pool({connectionString:url,options:`-c search_path=${schema} -c statement_timeout=10000`}),pool=new Pool({connectionString:url,options:`-c role=${role} -c search_path=${schema} -c statement_timeout=10000`});
const community=randomUUID();let png:Buffer,initialized=false,mf:Miniflare,bucket:AssetR2Binding;
before(async()=>{await admin.query(`CREATE ROLE ${role} NOLOGIN;CREATE SCHEMA ${schema};GRANT USAGE ON SCHEMA ${schema} TO ${role}`);initialized=true;await migrate(fixture);await fixture.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);const grants=await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');for(const match of grants.matchAll(/-- BEGIN [A-Z ]+\n([\s\S]*?)\n\\gexec/g)){const sql=match[1].replaceAll(":'runtime'",`'${role}'`).replaceAll("n.nspname='public'",`n.nspname='${schema}'`);for(const row of (await fixture.query(sql)).rows)await fixture.query(Object.values(row)[0] as string);}png=await sharp({create:{width:40,height:20,channels:3,background:'green'}}).png().toBuffer();mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'fp-social-domain-test',modules:true,script:'export default {fetch(){return new Response("synthetic");}}',compatibilityDate:'2026-09-21',r2Buckets:['MEDIA']}]}));await mf.ready;bucket=await mf.getR2Bucket('MEDIA') as unknown as AssetR2Binding;});
after(async()=>{await mf?.dispose();await pool.end();await fixture.end();if(initialized)await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP ROLE ${role}`);await admin.end();});
beforeEach(async context=>{await fixture.query('TRUNCATE communities CASCADE');if(context.name!=='default legacy automatic preview preserves original bytes without any Asset effects')await fixture.query("UPDATE domain_media_storage_policy SET mode='bridge',policy_revision='synthetic-social-policy',persistence_allowed=true,retained_byte_limit=10485760 WHERE purpose='community.social-thumbnail'");await fixture.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic social']);});
async function member(communityId=community){const id=randomUUID(),token=randomBytes(32).toString('base64url'),hash=tokenHash(token);const row=(await fixture.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,communityId,id+'@social.local.test','Synthetic owner','not-a-login-hash',randomUUID()])).rows[0];await fixture.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[hash,id]);return {...row,session_hash:hash,csrf_token:'synthetic',synthetic_token:token} as Actor;}

async function setup(native=false,sqlPool=pool){const owner=await member(),store=native?{...createR2ObjectStore(bucket)}:new FakeObjectStore(),api=createSocialThumbnailAssetService(sqlPool,{store,resolvePolicy:resolveSocialThumbnailUploadPolicy}),image=await sharp(png).resize(640,360).webp().toBuffer(),preview={title:'Synthetic preview',image,source:'page' as const},command={actor:owner,operation:'POST /api/v1/social-posts',key:randomUUID(),body:{url:'https://example.org/'+randomUUID(),note:'Synthetic note'}};return {owner,store,api,preview,command};}
async function upload(s:Awaited<ReturnType<typeof setup>>){return createSocialPost(pool,s.command,s.preview,new Date(),'https://workshop.local.test',s.api);}
const code=(c:string)=>(e:unknown)=>e instanceof Problem&&e.code===c;
test('default legacy automatic preview preserves original bytes without any Asset effects',async()=>{const s=await setup(),row=(await fixture.query("SELECT mode,persistence_allowed,policy_revision,retained_byte_limit FROM domain_media_storage_policy WHERE purpose='community.social-thumbnail'")).rows[0];assert.deepEqual(row,{mode:'legacy',persistence_allowed:false,policy_revision:null,retained_byte_limit:null});const result=await createSocialPost(pool,s.command,s.preview);assert.deepEqual(await publicSocialThumbnail(pool,result.post_id),s.preview.image);assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);});
test('automatic preview publishes native R2 using exact existing WebP and original source/DTO receipt',async()=>{const s=await setup(true),result=await upload(s);assert.equal(result.title,'Synthetic preview');assert.equal(result.thumbnail_url,`/api/v1/social-posts/${result.post_id}/thumbnail`);assert.equal('asset_id' in result,false);assert.deepEqual(await publicSocialThumbnail(pool,result.post_id,s.store),s.preview.image);assert.deepEqual(await upload(s),result);assert.deepEqual((await pool.query('SELECT source,storage_source,image_bytes FROM community_social_post_thumbnails')).rows[0],{source:'page',storage_source:'asset',image_bytes:null});assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);await assert.rejects(publicSocialThumbnail(pool,result.post_id),code('media_unavailable'));});
test('uncommitted preview PUT failure creates no visible post or receipt and same key resumes',async()=>{const s=await setup();(s.store as FakeObjectStore).failNext('put-before');await assert.rejects(upload(s));assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,0);assert.equal((await listSocialPosts(pool,s.owner,{})).items.length,0);const changed={...s,preview:{...s.preview,title:'Changed'}};await assert.rejects(upload(changed),code('asset_source_mismatch'));const result=await upload(s);assert.ok(result.post_id);assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);});
test('unknown successful PUT reconciles and concurrent same-key create returns one receipt',async()=>{const s=await setup();(s.store as FakeObjectStore).failNext('put-after');const results=await Promise.all([upload(s),upload(s)]);assert.deepEqual(results[0],results[1]);assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,1);assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);});
test('two creators of same normalized URL preserve original duplicate error without a loser post',async()=>{const s=await setup(),peer=await member(),other={...s,command:{...s.command,actor:peer,key:randomUUID()}};const results=await Promise.allSettled([upload(s),upload(other)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.equal(failure.reason.constructor.name,'SocialPostExists');assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,1);});
test('original daily create cap rejects before any object effects',async()=>{const s=await setup();for(let i=0;i<20;i++)await fixture.query("INSERT INTO community_social_posts(community_id,author_user_id,url,platform,title,state) VALUES($1,$2,$3,'other','Synthetic','active')",[community,s.owner.user_id,'https://example.org/existing-'+i]);await assert.rejects(upload(s),code('social_post_limit'));assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);});
test('current session and canonical policy revocation after PUT prevent post/pointer/receipt publication',async()=>{for(const revoke of ['session','policy']){const s=await setup(),put=s.store.putImmutable.bind(s.store);s.store.putImmutable=async(...args)=>{const result=await put(...args);if(revoke==='session')await fixture.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[s.owner.session_hash]);else await fixture.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='community.social-thumbnail'");return result;};await assert.rejects(upload(s));assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,0);assert.ok((await pool.query('SELECT state FROM assets')).rows.every(r=>r.state==='pending'));await fixture.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='community.social-thumbnail'");}});
test('no preview bytes create original plain post, but cannot silently abandon a prior preview reservation',async()=>{const s=await setup();(s.store as FakeObjectStore).failNext('put-before');await assert.rejects(upload(s));await assert.rejects(createSocialPost(pool,s.command,{title:null,image:null,source:null},new Date(),'https://workshop.local.test',s.api),code('media_upload_unavailable'));const command={...s.command,key:randomUUID(),body:{url:'https://example.org/plain'}};const plain=await createSocialPost(pool,command,{title:null,image:null,source:null},new Date(),'https://workshop.local.test');assert.equal(plain.thumbnail_url,null);});
test('HTTP original safe link-preview redirects/caps/normalization are unchanged with installed Asset writer',async()=>{const s=await setup(true),origin='http://127.0.0.1:4310';let calls:string[]=[];const app=createApp(pool,origin,'local',{socialThumbnailAssets:s.api,socialThumbnailAssetStore:s.store,linkPreviewFetch:async(url,init)=>{calls.push(url);assert.equal(init?.redirect,'manual');return url.endsWith('/synthetic-image')?new Response(new Uint8Array(png),{headers:{'Content-Type':'image/png'}}):new Response('<meta property="og:title" content="Synthetic preview"><meta property="og:image" content="https://example.org/synthetic-image">',{headers:{'Content-Type':'text/html'}});}}),headers={Origin:origin,Cookie:`freedom_local_session=${(s.owner as Actor&{synthetic_token:string}).synthetic_token}`,'X-CSRF-Token':'synthetic','Content-Type':'application/json','Idempotency-Key':randomUUID()},send=()=>app.request(origin+'/api/v1/social-posts',{method:'POST',headers,body:JSON.stringify(s.command.body)});const response=await send(),dto=await response.json() as any;assert.equal(response.status,201,JSON.stringify(dto));assert.equal(calls.length,2);assert.deepEqual(await(await send()).json(),dto);assert.equal(calls.length,2);assert.equal((await sharp(await publicSocialThumbnail(pool,dto.post_id,s.store)).metadata()).width,640);});

test('daily cap filled after PUT cannot publish a twenty-first post',async()=>{const s=await setup(),put=s.store.putImmutable.bind(s.store);s.store.putImmutable=async(...args)=>{const value=await put(...args);for(let i=0;i<20;i++)await fixture.query("INSERT INTO community_social_posts(community_id,author_user_id,url,platform,title,state) VALUES($1,$2,$3,'other','Synthetic concurrent','active')",[community,s.owner.user_id,'https://example.org/concurrent-'+i]);return value;};await assert.rejects(upload(s),code('social_post_limit'));assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,20);assert.ok((await pool.query('SELECT state FROM assets')).rows.every(r=>r.state==='pending'));});
test('canonical policy after the last object verification is rechecked after an actual publication lock wait',async()=>{const s=await setup(),get=s.store.get.bind(s.store),locker=await fixture.connect();let gets=0,signal!:()=>void;const blocked=new Promise<void>(r=>signal=r);s.store.get=async(...args)=>{const value=await get(...args);if(++gets===2){await locker.query('BEGIN');await locker.query("SELECT purpose FROM domain_media_storage_policy WHERE purpose='community.social-thumbnail' FOR UPDATE");signal();}return value;};const pending=upload(s),outcome=pending.then(value=>({value}),error=>({error}));try{await blocked;let waiting=false;for(let i=0;i<80;i++){waiting=(await fixture.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE '%SELECT%domain_media_storage_policy%' AND wait_event_type='Lock' AND pid<>pg_backend_pid()) AS waiting")).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,10));}assert.equal(waiting,true);await locker.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='community.social-thumbnail'");await locker.query('COMMIT');const result=await outcome;assert.ok('error' in result);assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,0);assert.ok((await pool.query('SELECT state FROM assets')).rows.every(r=>r.state==='pending'));}finally{await locker.query('ROLLBACK');locker.release();await outcome;}});
test('all migrated preview/manual writers obey R2-only floor and legacy byte rows still block cutover',async()=>{const s=await setup();await fixture.query("UPDATE domain_media_storage_policy SET mode='r2_only' WHERE purpose='community.social-thumbnail'");const result=await upload(s);assert.deepEqual(await publicSocialThumbnail(pool,result.post_id,s.store),s.preview.image);await assert.rejects(pool.query("INSERT INTO community_social_post_thumbnails(post_id,image_bytes,source) VALUES($1,$2,'page') ON CONFLICT(post_id) DO UPDATE SET image_bytes=EXCLUDED.image_bytes",[result.post_id,s.preview.image]),(e:any)=>e.code==='23514');});

const writerFenced=(error:unknown)=>!!error&&typeof error==='object'&&'code' in error&&error.code==='23514';
for(const state of ['hidden','deleted'] as const){
 test(`R2:S02/M05 runtime role cannot INSERT asset-labelled bytes for a ${state} post under r2_only`,async()=>{
  const s=await setup();
  await fixture.query("UPDATE domain_media_storage_policy SET mode='r2_only' WHERE purpose='community.social-thumbnail'");
  assert.equal((await pool.query('SELECT current_user AS role')).rows[0].role,role);
  const post=(await pool.query("INSERT INTO community_social_posts(community_id,author_user_id,url,platform,title,state) VALUES($1,$2,$3,'other','Synthetic writer fence',$4) RETURNING post_id",[community,s.owner.user_id,'https://example.org/'+randomUUID(),state])).rows[0];
  await assert.rejects(pool.query("INSERT INTO community_social_post_thumbnails(post_id,image_bytes,source,storage_source) VALUES($1,$2,'upload','asset')",[post.post_id,s.preview.image]),writerFenced);
  assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_post_thumbnails')).rows[0].n,0);
 });
}

test('R2:S02/M05 runtime role cannot INSERT bytes beside a genuine ready social Asset pointer',async()=>{
 // Change only the SQL writer's thumbnail payload. The normal lifecycle still
 // creates/verifies native R2, intent, ready Asset and typed pointer under the
 // restricted role. This avoids fabricating ready rows or bypassing triggers.
 const writer=new Pool({connectionString:url,options:`-c role=${role} -c search_path=${schema} -c statement_timeout=10000`});
 let injected=0,readyPointers=0;let legacyBytes:Buffer;
 writer.on('connect',client=>{client.query=new Proxy(client.query,{apply(query,_receiver,args){
  if(typeof args[0]==='string'&&args[0].startsWith('INSERT INTO community_social_post_thumbnails(')){
   assert.ok(args[0].includes("VALUES($1,NULL,$2,'asset')"));
   const changed=[args[0].replace("VALUES($1,NULL,$2,'asset')","VALUES($1,$3,$2,'asset')"),[...args[1],legacyBytes]];
   return (async()=>{
    const pointer=await Reflect.apply(query,client,["SELECT a.state,current_user AS role FROM community_social_thumbnail_asset_targets t JOIN assets a USING(asset_id) WHERE t.post_id=$1",[args[1][0]]]);
    assert.equal(pointer.rowCount,1);assert.deepEqual(pointer.rows[0],{state:'ready',role});readyPointers++;
    injected++;
    return Reflect.apply(query,client,changed);
   })();
  }
  return Reflect.apply(query,client,args);
 }});});
 try{
  const s=await setup(true,writer);legacyBytes=s.preview.image;
  await fixture.query("UPDATE domain_media_storage_policy SET mode='r2_only' WHERE purpose='community.social-thumbnail'");
  await assert.rejects(upload(s),(error:unknown)=>writerFenced(error)&&error instanceof Error&&error.message==='Thumbnail writer violates the storage floor');
  assert.equal(injected,1);assert.equal(readyPointers,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_post_thumbnails')).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM assets WHERE state='ready'")).rows[0].n,0);
 }finally{await writer.end();}
});

test('R2-only permits genuine R2 writes and metadata, rejects byte UPDATEs, and leaves crypto bytea usable',async()=>{
 const s=await setup(true);
 await fixture.query("UPDATE domain_media_storage_policy SET mode='r2_only' WHERE purpose='community.social-thumbnail'");
 const result=await upload(s);
 assert.deepEqual(await publicSocialThumbnail(pool,result.post_id,s.store),s.preview.image);
 for(const state of ['active','hidden','deleted']){
  if(state!=='active')await pool.query('UPDATE community_social_posts SET state=$2 WHERE post_id=$1',[result.post_id,state]);
  await assert.rejects(pool.query('UPDATE community_social_post_thumbnails SET image_bytes=$2 WHERE post_id=$1',[result.post_id,s.preview.image]),writerFenced);
  await pool.query("UPDATE community_social_post_thumbnails SET source='upload',updated_at=clock_timestamp() WHERE post_id=$1",[result.post_id]);
  assert.equal((await pool.query('SELECT image_bytes FROM community_social_post_thumbnails WHERE post_id=$1',[result.post_id])).rows[0].image_bytes,null);
 }
 const salt=randomBytes(32);
 await pool.query("INSERT INTO promotion_click_salts(click_day,salt) VALUES('2099-01-01',$1)",[salt]);
 assert.deepEqual((await pool.query("SELECT salt FROM promotion_click_salts WHERE click_day='2099-01-01'")).rows[0].salt,salt);
});

test('bridge still preserves historical preview bytes while publishing a genuine R2 pointer',async()=>{
 const s=await setup(true);
 const post=(await pool.query("INSERT INTO community_social_posts(community_id,author_user_id,url,platform,title,state) VALUES($1,$2,$3,'other','Synthetic bridge','active') RETURNING post_id",[community,s.owner.user_id,'https://example.org/'+randomUUID()])).rows[0];
 await pool.query("INSERT INTO community_social_post_thumbnails(post_id,image_bytes,source) VALUES($1,$2,'page')",[post.post_id,s.preview.image]);
 await saveSocialThumbnail(pool,{actor:s.owner,operation:`PUT /api/v1/social-posts/${post.post_id}/thumbnail`,key:randomUUID(),body:null},post.post_id,{bytes:png,mime:'image/png'},new Date(),s.api);
 const retained=(await pool.query('SELECT storage_source,image_bytes FROM community_social_post_thumbnails WHERE post_id=$1',[post.post_id])).rows[0];
 assert.equal(retained.storage_source,'asset');assert.deepEqual(retained.image_bytes,s.preview.image);
 assert.ok((await publicSocialThumbnail(pool,post.post_id,s.store)).length>0);
 await assert.rejects(fixture.query("UPDATE domain_media_storage_policy SET mode='r2_only' WHERE purpose='community.social-thumbnail'"),writerFenced);
});

function noteCommand(owner:Actor,text='附圖貼文'){return {actor:owner,operation:'POST /api/v1/social-posts/notes',key:randomUUID(),body:{text,image:{mime_type:'image/png',data_base64:png.toString('base64')}}};}
test('note with image publishes post, pointer and native asset together and replays the original receipt',async()=>{
 const s=await setup(),command=noteCommand(s.owner),result=await createNativeSocialPost(pool,command,new Date(),s.api);
 assert.equal(result.kind,'note');assert.equal(result.note,'附圖貼文');assert.equal(result.thumbnail_url,`/api/v1/social-posts/${result.post_id}/thumbnail`);
 assert.deepEqual(await createNativeSocialPost(pool,command,new Date(),s.api),result);
 assert.deepEqual((await pool.query('SELECT source,storage_source,image_bytes FROM community_social_post_thumbnails')).rows[0],{source:'upload',storage_source:'asset',image_bytes:null});
 assert.deepEqual((await pool.query('SELECT create_source,create_draft FROM community_social_thumbnail_asset_targets')).rows[0],{create_source:'upload',create_draft:{text:'附圖貼文'}});
 assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,1);
 assert.equal((await sharp(await readSocialThumbnail(pool,s.owner,result.post_id,s.store)).metadata()).width,640);
 await assert.rejects(publicSocialThumbnail(pool,result.post_id,s.store),code('not_found'));
});
test('note image PUT failure publishes nothing, a changed draft cannot reuse the reservation and the same key resumes to one post',async()=>{
 const s=await setup(),command=noteCommand(s.owner);
 (s.store as FakeObjectStore).failNext('put-before');
 await assert.rejects(createNativeSocialPost(pool,command,new Date(),s.api));
 assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,0);
 assert.equal((await listSocialPosts(pool,s.owner,{})).items.length,0);
 await assert.rejects(createNativeSocialPost(pool,{...command,body:{...command.body,text:'改過的內容'}},new Date(),s.api),code('asset_source_mismatch'));
 const result=await createNativeSocialPost(pool,command,new Date(),s.api);
 assert.ok(result.post_id);assert.equal(result.thumbnail_url,`/api/v1/social-posts/${result.post_id}/thumbnail`);
 assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,1);
});
test('text-only note under the installed Asset writer stays a plain post without object effects',async()=>{
 const s=await setup(),result=await createNativeSocialPost(pool,{actor:s.owner,operation:'POST /api/v1/social-posts/notes',key:randomUUID(),body:{text:'純文字'}},new Date(),s.api);
 assert.equal(result.thumbnail_url,null);
 assert.equal((await pool.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_thumbnail_asset_targets')).rows[0].n,0);
});
test('note image without an installed Asset writer is refused before any post or reservation exists',async()=>{
 const s=await setup();
 await assert.rejects(createNativeSocialPost(pool,noteCommand(s.owner),new Date()),code('media_upload_unavailable'));
 assert.equal((await pool.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,0);
});
