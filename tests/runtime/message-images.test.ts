import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import sharp from 'sharp';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createR2ObjectStore,type AssetR2Binding} from '../../packages/asset-storage/r2.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {objectKey} from '../../packages/asset-storage/index.js';
import {migrate} from '../../scripts/database.js';
import {tokenHash} from '../../modules/identity-membership/service.js';
import {createMessageImageAssetService} from '../../modules/assets/message-image.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {inspectCanonicalWebp} from '../../packages/shared/image-webp.js';

const url=process.env.TEST_DATABASE_URL;if(!url)throw new Error('Explicit isolated TEST_DATABASE_URL required');
const schema=`fp_message_images_${process.pid}_${Date.now()}`,role=`${schema}_app`,admin=new Pool({connectionString:url});
const fixture=new Pool({connectionString:url,options:`-c search_path=${schema} -c statement_timeout=10000`});
// The runtime pool is the restricted application role, exactly like production.
const pool=new Pool({connectionString:url,options:`-c role=${role} -c search_path=${schema} -c statement_timeout=10000`});
const origin='http://127.0.0.1:4310',community=randomUUID();
let defaultPolicy:Record<string,unknown>|undefined;
let initialized=false,mf:Miniflare,bucket:AssetR2Binding,png:Buffer,wide:Buffer,tall:Buffer,jpeg:Buffer;
type Member={id:string;token:string;hash:string;communityId:string;name:string};

before(async()=>{
  await admin.query(`CREATE ROLE ${role} NOLOGIN;CREATE SCHEMA ${schema};GRANT USAGE ON SCHEMA ${schema} TO ${role}`);initialized=true;await migrate(fixture);
  defaultPolicy=(await fixture.query("SELECT mode,persistence_allowed,policy_revision,retained_byte_limit FROM domain_media_storage_policy WHERE purpose='member.message-image'")).rows[0];
  await fixture.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  const grants=await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
  for(const match of grants.matchAll(/-- BEGIN [A-Z ]+\n([\s\S]*?)\n\\gexec/g)){
    const sql=match[1].replaceAll(":'runtime'",`'${role}'`).replaceAll("n.nspname='public'",`n.nspname='${schema}'`);
    for(const row of (await fixture.query(sql)).rows)await fixture.query(Object.values(row)[0] as string);
  }
  png=await sharp({create:{width:300,height:150,channels:3,background:'#2f9e44'}}).png().toBuffer();
  wide=await sharp({create:{width:3000,height:1500,channels:3,background:'#1c7ed6'}}).png().toBuffer();
  tall=await sharp({create:{width:600,height:2400,channels:3,background:'#e8590c'}}).png().toBuffer();
  jpeg=await sharp({create:{width:640,height:480,channels:3,background:'#862e9c'}}).jpeg().toBuffer();
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'fp-message-image-test',modules:true,script:'export default {fetch(){return new Response("synthetic");}}',compatibilityDate:'2026-09-21',r2Buckets:['MEDIA']}]}));
  await mf.ready;bucket=await mf.getR2Bucket('MEDIA') as unknown as AssetR2Binding;
});
after(async()=>{await mf?.dispose();await pool.end();await fixture.end();if(initialized)await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP ROLE ${role}`);await admin.end();});
beforeEach(async()=>{
  await fixture.query('TRUNCATE communities CASCADE');
  await fixture.query('INSERT INTO communities VALUES($1,$2)',[community,'Synthetic messages']);
  await fixture.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='synthetic-message-policy',persistence_allowed=true,retained_byte_limit=104857600 WHERE purpose='member.message-image'");
  await fixture.query('TRUNCATE auth_rate_limits');
});

async function member(communityId=community,name='Synthetic member'):Promise<Member>{
  const id=randomUUID(),token=randomBytes(32).toString('base64url'),hash=tokenHash(token);
  await fixture.query('INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,$4,$5,$6)',[id,communityId,id+'@messages.local.test',name,'not-a-login-hash',randomUUID()]);
  await fixture.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')",[hash,id]);
  return {id,token,hash,communityId,name};
}
function setup(native=false,installed=true){
  const store=native?{...createR2ObjectStore(bucket)} as unknown as FakeObjectStore:new FakeObjectStore();
  const assets=createMessageImageAssetService(pool,{store});
  const app=createApp(pool,origin,'local',installed?{messageImageAssets:assets,messageImageAssetStore:store}:{});
  const call=(user:Member|null,method:string,path:string,init:{body?:BodyInit|null;type?:string;key?:string;json?:unknown;headers?:Record<string,string>}={})=>{
    const headers:Record<string,string>={Origin:origin,...init.headers};
    if(user){headers.Cookie=`freedom_local_session=${user.token}`;headers['X-CSRF-Token']='synthetic';}
    if(method!=='GET')headers['Idempotency-Key']=init.key??randomUUID();
    let body=init.body??null;
    if(init.json!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(init.json);}
    else if(init.type)headers['Content-Type']=init.type;
    return app.request(origin+path,{method,headers,body,...(body&&typeof body==='object'&&'getReader' in body?{duplex:'half'}:{})} as RequestInit);
  };
  const upload=(user:Member,peer:Member,bytes:Buffer,type='image/png',key?:string)=>call(user,'POST',`/api/v1/me/conversations/${peer.id}/images`,{body:new Uint8Array(bytes),type,key});
  const send=(user:Member,peer:Member,json:unknown,key?:string)=>call(user,'POST',`/api/v1/me/conversations/${peer.id}/messages`,{json,key});
  const read=(user:Member|null,peerId:string,messageId:string)=>call(user,'GET',`/api/v1/me/conversations/${peerId}/messages/${messageId}/image`);
  return {store,assets,app,call,upload,send,read};
}
type Env=ReturnType<typeof setup>;
async function sendImage(s:Env,a:Member,b:Member,bytes=png,extra:Record<string,unknown>={},type='image/png'){
  const up=await s.upload(a,b,bytes,type);assert.equal(up.status,201,await up.clone().text());
  const image=await up.json() as {image_id:string};
  const sent=await s.send(a,b,{image_id:image.image_id,...extra});assert.equal(sent.status,201,await sent.clone().text());
  return {image,message:await sent.json() as {message_id:string;body:string;image?:{content_type:string;byte_size:number}}};
}
const counts=async()=>(await fixture.query(`SELECT (SELECT count(*)::int FROM assets) assets,(SELECT count(*)::int FROM asset_objects) objects,(SELECT count(*)::int FROM asset_upload_intents) intents,
  (SELECT count(*)::int FROM member_message_image_asset_targets) targets,(SELECT count(*)::int FROM member_direct_messages) messages,(SELECT count(*)::int FROM member_direct_messages d JOIN member_message_image_asset_targets t ON t.message_id=d.message_id) attached`)).rows[0];
const code=async(response:Response,status:number,expected?:string)=>{assert.equal(response.status,status,await response.clone().text());if(expected)assert.equal((await response.json() as {code:string}).code,expected);};

test('sender and recipient read the re-encoded WebP; aspect ratio is kept, nothing is enlarged, and the DTO has no URL',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob');
  const {image,message}=await sendImage(s,a,b,wide,{body:'  這是畫面  '});
  assert.equal(message.body,'這是畫面');assert.deepEqual(message.image&&Object.keys(message.image).sort(),['byte_size','content_type']);
  assert.equal(message.image!.content_type,'image/webp');assert.equal(JSON.stringify(message).includes('http'),false);
  for(const [user,peer] of [[a,b],[b,a]] as const){
    const response=await s.read(user,peer.id,message.message_id);assert.equal(response.status,200);
    assert.equal(response.headers.get('Content-Type'),'image/webp');assert.equal(response.headers.get('Cache-Control'),'private, no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.match(response.headers.get('Vary')??'',/Cookie/);
    const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,message.image!.byte_size);
    assert.deepEqual(inspectCanonicalWebp(bytes),{width:1920,height:960,chunks:['VP8 ']});
  }
  const small=await sendImage(s,a,b,png),smallBytes=Buffer.from(await (await s.read(b,a.id,small.message.message_id)).arrayBuffer());
  assert.deepEqual(inspectCanonicalWebp(smallBytes).chunks,['VP8 ']);assert.equal(inspectCanonicalWebp(smallBytes).width,300);assert.equal(inspectCanonicalWebp(smallBytes).height,150);
  const portrait=await sendImage(s,a,b,tall),shape=inspectCanonicalWebp(Buffer.from(await (await s.read(a,b.id,portrait.message.message_id)).arrayBuffer()));
  assert.deepEqual([shape.width,shape.height],[480,1920]);
  assert.ok(image.image_id);
});

test('image-only messages carry a placeholder body, show up in pages, previews and search, and count as one unread each',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob');
  const text=await sendImage(s,a,b,png,{body:'螢幕截圖'}),only=await sendImage(s,a,b,jpeg,{},'image/jpeg');
  assert.equal(only.message.body,'[圖片]');
  const page=await (await s.call(b,'GET',`/api/v1/me/conversations/${a.id}/messages`)).json() as {items:{message_id:string;image?:object;body:string}[];unread_count:number};
  assert.equal(page.unread_count,2);assert.deepEqual(page.items.map(item=>[item.message_id,Boolean(item.image)]),[[only.message.message_id,true],[text.message.message_id,true]]);
  const list=await (await s.call(b,'GET','/api/v1/me/conversations')).json() as {items:{last_message:{message_id:string;image?:object};unread_count:number}[];unread_count:number};
  assert.equal(list.items[0].last_message.message_id,only.message.message_id);assert.ok(list.items[0].last_message.image);assert.equal(list.unread_count,2);
  const found=await (await s.call(b,'GET',`/api/v1/me/conversations/${a.id}/messages/search?q=${encodeURIComponent('截圖')}`)).json() as {items:{message_id:string;image?:object}[]};
  assert.deepEqual(found.items.map(item=>[item.message_id,Boolean(item.image)]),[[text.message.message_id,true]]);
  assert.equal((await fixture.query('SELECT count(*)::int n FROM member_notifications')).rows[0].n,0,'message images create no notification, so no image bytes can leak into one');
  const read=await s.call(b,'POST',`/api/v1/me/conversations/${a.id}/read`,{json:{through_message_id:only.message.message_id}});assert.equal(read.status,200);
  assert.equal((await (await s.call(b,'GET','/api/v1/me/conversations')).json() as {unread_count:number}).unread_count,0);
});

test('third parties, other communities, wrong peers, anonymous callers and forged ids never receive bytes',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob'),c=await member(community,'Carol');
  const foreignCommunity=randomUUID();await fixture.query('INSERT INTO communities VALUES($1,$2)',[foreignCommunity,'Foreign']);
  const stranger=await member(foreignCommunity,'Stranger');
  const {message}=await sendImage(s,a,b);
  await code(await s.read(c,a.id,message.message_id),404,'media_not_found');
  await code(await s.read(c,b.id,message.message_id),404,'media_not_found');
  await code(await s.read(stranger,a.id,message.message_id),404);
  await code(await s.read(a,c.id,message.message_id),404,'media_not_found');          // right message, wrong peer
  await code(await s.read(b,a.id,randomUUID()),404,'media_not_found');
  await code(await s.read(b,a.id,'not-a-uuid'),404);
  await code(await s.read(null,a.id,message.message_id),401);
  await code(await s.read(a,a.id,message.message_id),422,'self_conversation');
  assert.equal((await s.read(b,a.id,message.message_id)).status,200);
});

test('revoked sessions and removed members lose access immediately, including while object I/O is in flight',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob');
  const {message}=await sendImage(s,a,b);
  assert.equal((await s.read(b,a.id,message.message_id)).status,200);
  const get=s.store.get.bind(s.store);
  s.store.get=async(...args)=>{const value=await get(...args);await fixture.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[b.hash]);return value;};
  await code(await s.read(b,a.id,message.message_id),404,'media_not_found');
  s.store.get=get;
  await code(await s.read(b,a.id,message.message_id),401);
  const c=await member(community,'Carol'),sent=await sendImage(s,a,c);
  await fixture.query('UPDATE users SET active=false WHERE user_id=$1',[c.id]);
  assert.notEqual((await s.read(c,a.id,sent.message.message_id)).status,200);
  await fixture.query('UPDATE users SET active=true WHERE user_id=$1',[c.id]);
});

test('format, size and content-type spoofing are refused with Chinese errors before any storage effect',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob');
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  const apng=await (async()=>{const base=await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).png().toBuffer();const ihdrEnd=8+25;const actl=Buffer.alloc(20);actl.writeUInt32BE(8,0);actl.write('acTL',4,'ascii');return Buffer.concat([base.subarray(0,ihdrEnd),actl,base.subarray(ihdrEnd)]);})();
  const cases:[string,Buffer,string,number,string][]=[
    ['GIF declared as image/gif',gif,'image/gif',415,'message_image_format'],
    ['SVG declared as image/svg+xml',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),'image/svg+xml',415,'message_image_format'],
    ['PDF declared as application/pdf',Buffer.from('%PDF-1.7'),'application/pdf',415,'message_image_format'],
    ['HTML bytes declared as PNG',Buffer.from('<html><script>alert(1)</script></html>'),'image/png',422,'invalid_message_image'],
    ['PNG bytes declared as JPEG',png,'image/jpeg',422,'invalid_message_image'],
    ['JPEG bytes declared as WebP',jpeg,'image/webp',422,'invalid_message_image'],
    ['animated PNG',apng,'image/png',422,'invalid_message_image'],
    ['truncated PNG',png.subarray(0,png.length-40),'image/png',422,'invalid_message_image'],
    ['empty body',Buffer.alloc(0),'image/png',422,'invalid_message_image'],
  ];
  for(const [name,bytes,type,status,expected] of cases){
    const response=await s.upload(a,b,bytes,type);
    assert.equal(response.status,status,name+': '+await response.clone().text());
    const problem=await response.json() as {code:string;detail:string};assert.equal(problem.code,expected,name);assert.match(problem.detail,/[\u4e00-\u9fff]/,name+' must be a Chinese message');
  }
  const oversized=Buffer.concat([png,Buffer.alloc(2*1024*1024)]);
  await code(await s.upload(a,b,oversized),413,'message_image_too_large');
  const streamed=new ReadableStream<Uint8Array>({start(c){for(let i=0;i<3;i++)c.enqueue(new Uint8Array(1024*1024));c.close();}});
  await code(await s.call(a,'POST',`/api/v1/me/conversations/${b.id}/images`,{body:streamed,type:'image/png'}),413,'message_image_too_large');
  assert.deepEqual(await counts(),{assets:0,objects:0,intents:0,targets:0,messages:0,attached:0});
  const huge=await sharp({create:{width:5000,height:100,channels:3,background:'#000'}}).png({compressionLevel:9}).toBuffer();
  assert.ok(huge.length<2*1024*1024);await code(await s.upload(a,b,huge),422,'invalid_message_image');
  assert.equal((await fixture.query("SELECT count(*)::int n FROM asset_objects")).rows[0].n,0,'rejected normalization leaves no stored object');
});

test('a fresh database ships the policy OFF with no persistence, and bridge and r2_only are the same ON state',async()=>{
  assert.deepEqual(defaultPolicy,{mode:'legacy',persistence_allowed:false,policy_revision:null,retained_byte_limit:null});
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob');
  await fixture.query("UPDATE domain_media_storage_policy SET mode='bridge' WHERE purpose='member.message-image'");
  assert.equal((await s.upload(a,b,png)).status,201);
});

test('the feature is invisible until installed, and an enabled flag still needs the canonical policy row',async()=>{
  const off=setup(false,false),a=await member(community,'Alice'),b=await member(community,'Bob');
  assert.equal((await (await off.call(null,'GET','/api/v1/site')).json() as {message_images_enabled:boolean}).message_images_enabled,false);
  await code(await off.upload(a,b,png),404,'not_found');
  await code(await off.read(a,b.id,randomUUID()),404,'not_found');
  await code(await off.send(a,b,{image_id:randomUUID()}),404,'not_found');
  assert.equal((await off.send(a,b,{body:'文字照常'})).status,201);
  const on=setup();
  assert.equal((await (await on.call(null,'GET','/api/v1/site')).json() as {message_images_enabled:boolean}).message_images_enabled,true);
  for(const sql of ["UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='member.message-image'","UPDATE domain_media_storage_policy SET retained_byte_limit=1000 WHERE purpose='member.message-image'"]){
    await fixture.query(sql);await code(await on.upload(a,b,png),503,'media_upload_unavailable');
  }
  assert.deepEqual(await counts(),{assets:0,objects:0,intents:0,targets:0,messages:1,attached:0});
  // Every media purpose keeps the floor: once raised, the mode cannot return to legacy.
  await assert.rejects(fixture.query("UPDATE domain_media_storage_policy SET mode='legacy' WHERE purpose='member.message-image'"),(e:{code?:string})=>e.code==='23514');
  await assert.rejects(pool.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='member.message-image'"),(e:{code?:string})=>e.code==='42501');
});

test('an image id only works for its own sender, its own recipient, once, and never with a sticker or in a channel',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob'),c=await member(community,'Carol');
  const up=await (await s.upload(a,b,png)).json() as {image_id:string};
  await code(await s.send(b,a,{image_id:up.image_id}),404,'image_not_available');         // another member's draft
  await code(await s.send(c,b,{image_id:up.image_id}),404,'image_not_available');
  await code(await s.send(a,c,{image_id:up.image_id}),404,'image_not_available');         // right sender, wrong recipient
  await code(await s.send(a,b,{image_id:randomUUID()}),404,'image_not_available');
  await code(await s.send(a,b,{image_id:up.image_id,sticker_id:'workshop-v1-hello'}),422);
  await code(await s.send(a,b,{image_id:up.image_id,image_url:'https://example.test/x.png'}),422);
  await code(await s.send(a,b,{image_id:'not-a-uuid'}),422);
  await code(await s.send(a,b,{}),422);
  assert.equal((await s.send(a,b,{image_id:up.image_id})).status,201);
  await code(await s.send(a,b,{image_id:up.image_id}),409,'image_already_sent');            // a new Idempotency-Key cannot reuse it
  const channel=await s.call(a,'POST','/api/v1/me/channels/world/world/messages',{json:{image_id:up.image_id}});assert.ok([400,404,422].includes(channel.status),String(channel.status));
  assert.deepEqual(await counts(),{assets:1,objects:1,intents:1,targets:1,messages:1,attached:1});
});

test('same Idempotency-Key replays: one upload, one message, and a lost response never duplicates either',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob');
  let puts=0;const put=s.store.putImmutable.bind(s.store);s.store.putImmutable=async(...args)=>{puts++;return put(...args);};
  const key=randomUUID(),first=await (await s.upload(a,b,png,'image/png',key)).json() as {image_id:string;byte_size:number};
  const again=await s.upload(a,b,png,'image/png',key);assert.equal(again.status,201);assert.deepEqual(await again.json(),first);
  assert.equal(puts,1);assert.deepEqual(await counts(),{assets:1,objects:1,intents:1,targets:1,messages:0,attached:0});
  const other=await (await s.upload(a,b,png,'image/png',randomUUID())).json() as {image_id:string};assert.notEqual(other.image_id,first.image_id);
  const messageKey=randomUUID(),one=await (await s.send(a,b,{image_id:first.image_id},messageKey)).json() as {message_id:string};
  const two=await (await s.send(a,b,{image_id:first.image_id},messageKey)).json() as {message_id:string};assert.equal(two.message_id,one.message_id);
  assert.equal((await counts()).messages,1);
  // The same key with different bytes is a conflict, never a silent replacement.
  await code(await s.upload(a,b,jpeg,'image/jpeg',key),409,'idempotency_conflict');
  // PUT accepted but its response lost: verified readback recovers it in the same request, and a replay reaches the same image.
  const lost=randomUUID(),tallHash=createHash('sha256').update(tall).digest('hex');s.store.failNext('put-after');
  const recovered=await s.upload(a,b,tall,'image/png',lost);assert.equal(recovered.status,201,await recovered.clone().text());
  assert.deepEqual(await (await s.upload(a,b,tall,'image/png',lost)).json(),await recovered.json());
  // A refused PUT fails the request; retrying the SAME key resumes the same intent instead of creating another Asset.
  const refused=randomUUID(),refusedHash=createHash('sha256').update(jpeg).digest('hex');s.store.failNext('put-before');
  const failed=await s.upload(a,b,jpeg,'image/jpeg',refused);assert.ok(failed.status>=500,String(failed.status));
  const resumed=await s.upload(a,b,jpeg,'image/jpeg',refused);assert.equal(resumed.status,201,await resumed.clone().text());
  for(const hash of [tallHash,refusedHash])assert.equal((await fixture.query('SELECT count(*)::int n FROM asset_upload_intents WHERE source_sha256=$1',[hash])).rows[0].n,1);
  assert.deepEqual(await counts(),{assets:4,objects:4,intents:4,targets:4,messages:1,attached:1});
});

test('a sender cannot be made to attach, read or reuse bytes through direct SQL shaped like the API',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob'),c=await member(community,'Carol');
  const {image,message}=await sendImage(s,a,b);
  const target=(await fixture.query('SELECT * FROM member_message_image_asset_targets WHERE image_id=$1',[image.image_id])).rows[0];
  assert.equal(target.message_id,message.message_id);assert.equal(target.owner_user_id,a.id);assert.equal(target.recipient_user_id,b.id);
  const reject=async(sql:string,values:unknown[],expected='23514')=>assert.rejects(pool.query(sql,values),(e:{code?:string})=>e.code===expected,sql);
  await reject('UPDATE member_message_image_asset_targets SET asset_id=NULL,linked_at_version=NULL WHERE image_id=$1',[image.image_id]);
  await reject('UPDATE member_message_image_asset_targets SET message_id=$2 WHERE image_id=$1',[image.image_id,randomUUID()]);
  await reject('DELETE FROM member_message_image_asset_targets WHERE image_id=$1',[image.image_id]);
  await reject('UPDATE member_message_image_asset_targets SET recipient_user_id=$2 WHERE image_id=$1',[image.image_id,c.id]);
  // A second message cannot share the image, and a message of another pair cannot adopt it.
  const other=(await fixture.query("INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body) VALUES($1,$2,$3,'x') RETURNING message_id",[community,a.id,c.id])).rows[0].message_id;
  await reject('UPDATE member_message_image_asset_targets SET message_id=$2 WHERE image_id=$1',[image.image_id,other]);
  const free=await (await s.upload(a,b,png)).json() as {image_id:string};
  await reject('UPDATE member_message_image_asset_targets SET message_id=$2 WHERE image_id=$1',[free.image_id,other],'23503');
  await reject('UPDATE member_message_image_asset_targets SET message_id=$2 WHERE image_id=$1',[free.image_id,message.message_id],'23505');
  // Typed shapes: a forged intent cannot claim another purpose's target or bypass size/MIME rules.
  const intent=(await fixture.query('SELECT * FROM asset_upload_intents WHERE target_message_image_id=$1',[image.image_id])).rows[0];
  await reject('UPDATE asset_upload_intents SET target_message_image_id=$2 WHERE intent_id=$1',[intent.intent_id,free.image_id]);
  await reject('UPDATE asset_upload_intents SET source_content_type=$2 WHERE intent_id=$1',[intent.intent_id,'image/gif'],'23514');
  await reject("UPDATE asset_upload_intents SET target_service_id=gen_random_uuid() WHERE intent_id=$1",[intent.intent_id]);
  await reject('UPDATE asset_objects SET content_type=$2 WHERE asset_id=$1',[intent.asset_id,'image/png'],'23514');
  await reject("UPDATE asset_objects SET byte_size=2097152 WHERE asset_id=$1",[intent.asset_id],'23514');
  await reject("UPDATE asset_objects SET profile_id=NULL WHERE asset_id=$1",[intent.asset_id],'23514');
  // A message may exist without an image, but nothing outside the sidecar can point at Assets.
  assert.equal((await pool.query('SELECT count(*)::int n FROM member_direct_messages WHERE community_id=$1',[community])).rows[0].n,2);
});

test('retained byte quota and the per-member upload budget stop abuse without leaving partial uploads',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob');
  // The limit is exactly one reserved upload: stored bytes are tiny, but every new upload reserves the 1 MiB output ceiling first.
  await fixture.query("UPDATE domain_media_storage_policy SET retained_byte_limit=1048576 WHERE purpose='member.message-image'");
  assert.equal((await s.upload(a,b,png)).status,201);
  await code(await s.upload(a,b,png),409,'asset_retained_quota');
  await fixture.query("UPDATE domain_media_storage_policy SET retained_byte_limit=104857600 WHERE purpose='member.message-image'");
  const before=await counts();
  let limited=0;
  for(let i=0;i<12&&!limited;i++){const r=await s.upload(a,b,png);if(r.status===429)limited=i+1;}
  assert.ok(limited>0&&limited<=11,`member upload budget must stop uploads (stopped at ${limited})`);
  assert.ok((await counts()).assets>=before.assets);
  const bob=await s.upload(b,a,png);assert.equal(bob.status,201,'another member keeps their own budget and quota');
});

test('the same pipeline works against native R2 and stores exactly the verified WebP under the Asset key',async()=>{
  const s=setup(true),a=await member(community,'Alice'),b=await member(community,'Bob');
  const {message}=await sendImage(s,a,b,wide);
  const row=(await fixture.query("SELECT o.scope_id,o.asset_id,o.representation_id,o.content_sha256,o.byte_size,o.profile_id,o.transform_version,o.purpose,o.variant,o.content_type,a.state,a.scope_kind,a.write_effect_coverage FROM asset_objects o JOIN assets a USING(asset_id)")).rows[0];
  assert.deepEqual({profile:row.profile_id,transform:row.transform_version,purpose:row.purpose,variant:row.variant,type:row.content_type,state:row.state,scope:row.scope_kind,coverage:row.write_effect_coverage},
    {profile:'member.message-image',transform:'member.message-image.webp.v1',purpose:'member.message-image',variant:'image',type:'image/webp',state:'ready',scope:'personal',coverage:true});
  const object=await bucket.get(objectKey({scopeId:row.scope_id,assetId:row.asset_id,representationId:row.representation_id}));assert.ok(object);
  const stored=Buffer.from(await object!.arrayBuffer());assert.equal(createHash('sha256').update(stored).digest('hex'),row.content_sha256);
  const served=Buffer.from(await (await s.read(b,a.id,message.message_id)).arrayBuffer());assert.deepEqual(served,stored);
  assert.equal((await fixture.query("SELECT count(*)::int n FROM asset_object_write_effects WHERE state='fulfilled'")).rows[0].n,1,'the PUT effect is journalled for the new purpose');
  const journal=(await fixture.query("SELECT aggregate_type,operation FROM scoped_transition_journal WHERE operation='member.message-image.upload'")).rows;assert.deepEqual(journal,[{aggregate_type:'member_message_image',operation:'member.message-image.upload'}]);
  assert.equal((await fixture.query("SELECT count(*)::int n FROM scoped_outbox")).rows[0].n,0,'private images never reach the community outbox');
});

test('a block in either direction stops new image uploads and sends, while earlier messages keep their history rules',async()=>{
  const s=setup(),a=await member(community,'Alice'),b=await member(community,'Bob');
  const old=await sendImage(s,a,b);
  const draft=await (await s.upload(a,b,png)).json() as {image_id:string};
  const block=(owner:Member,target:Member)=>fixture.query("INSERT INTO member_interaction_blocks(community_id,owner_ref,target_ref,state) VALUES($1,$2,$3,'active') ON CONFLICT(community_id,owner_ref,target_ref) DO UPDATE SET state='active'",[community,owner.id,target.id]);
  await block(b,a);                                                        // the recipient blocks the sender
  await code(await s.upload(a,b,png),409,'recipient_unavailable');
  await code(await s.send(a,b,{image_id:draft.image_id}),409,'recipient_unavailable');   // a prepared draft cannot be attached
  await code(await s.upload(b,a,png),409,'recipient_unavailable');         // and the blocker cannot send either
  assert.equal((await s.read(b,a.id,old.message.message_id)).status,200);  // blocking does not rewrite existing history
  await fixture.query("UPDATE member_interaction_blocks SET state='removed' WHERE owner_ref=$1",[b.id]);
  await block(a,b);                                                        // the opposite direction behaves the same
  await code(await s.upload(a,b,png),409,'recipient_unavailable');
  await fixture.query("UPDATE member_interaction_blocks SET state='removed' WHERE owner_ref=$1",[a.id]);
  assert.equal((await s.send(a,b,{image_id:draft.image_id})).status,201);  // lifted blocks restore the prepared draft
});
