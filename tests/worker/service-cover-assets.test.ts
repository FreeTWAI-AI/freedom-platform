// Native local workerd + R2 + Hyperdrive; IMAGES uses Miniflare's local low-fidelity emulator.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer,createConnection,type Socket} from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {Pool} from 'pg';
import sharp from 'sharp';
import {migrate} from '../../scripts/database.js';
import {tokenHash} from '../../modules/identity-membership/service.js';
const raw=process.env.TEST_DATABASE_URL;assert(raw,'Owned fp_* TEST_DATABASE_URL required');const adminUrl=new URL(raw);
assert.match(adminUrl.pathname,/^\/fp_[a-z0-9_]+$/);assert(['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname));const socket=adminUrl.searchParams.get('host');if(socket)assert(socket.startsWith('/'));
const database=`fp_worker_cover_${process.pid}_${Date.now()}`,migrator=database+'_owner',runtimeRole=database+'_app',password=randomBytes(24).toString('hex');
function roleUrl(role:string){const url=new URL(raw!);url.pathname='/'+database;url.username=role;url.password=password;return url.href;}
const admin=new Pool({connectionString:raw}),owner=new Pool({connectionString:roleUrl(migrator)}),app=new Pool({connectionString:roleUrl(runtimeRole)});
// Pool.end() resolves after removing clients, before their sockets necessarily close.
// Wait for actual client end events before DROP FORCE, so teardown cannot kill an idle closing client.
const closedClients:Promise<void>[]=[];
for(const pool of [owner,app])pool.on('connect',client=>closedClients.push(new Promise<void>(resolve=>client.once('end',resolve))));
const sockets=new Set<Socket>(),proxy=socket?createServer(client=>{const upstream=createConnection(join(socket,'.s.PGSQL.5432'));for(const channel of [client,upstream]){sockets.add(channel);channel.on('close',()=>sockets.delete(channel));channel.on('error',()=>{client.destroy();upstream.destroy();});}client.pipe(upstream).pipe(client);}):undefined;
const origin='http://127.0.0.1:8787',community=randomUUID(),instances:Miniflare[]=[];let directory:string,tcp:string,png:Buffer,created=false,outboundCalls=0;
before(async()=>{
  await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${migrator}`);created=true;await migrate(owner);
  const source=(await readFile('deploy/cloudflare/sql/20-runtime-grants.psql','utf8')).replace(/^\\set .*$/mg,'').replaceAll(':"runtime"','"'+runtimeRole+'"').replaceAll(":'runtime'","'"+runtimeRole+"'");
  const q=await owner.connect();try{const parts=source.split('\\gexec');for(let index=0;index<parts.length;index++){const result=await q.query(parts[index]);if(index<parts.length-1){const last=Array.isArray(result)?result.at(-1)!:result;for(const row of last.rows)await q.query(Object.values(row)[0] as string);}}}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  const connection=new URL(roleUrl(runtimeRole));if(proxy){await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const address=proxy.address();assert(address&&typeof address==='object');connection.hostname='127.0.0.1';connection.port=String(address.port);connection.searchParams.delete('host');}tcp=connection.href;
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic native cover community')",[community]);
  await owner.query("UPDATE domain_media_storage_policy SET mode='bridge' WHERE purpose='member.service-cover'");
  directory=await mkdtemp(resolve('.wrangler/native-cover-'));await mkdir(join(directory,'assets'));await writeFile(join(directory,'assets/index.html'),'<!doctype html><title>Native cover fixture</title>');
  png=await sharp({create:{width:35,height:45,channels:3,background:'#337788'}}).png().toBuffer();
});
after(async()=>{for(const instance of instances)await instance.dispose();for(const channel of sockets)channel.destroy();if(proxy?.listening)await new Promise<void>(r=>proxy.close(()=>r()));await Promise.all([owner.end(),app.end()]);await Promise.all(closedClients);try{if(created){await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);await admin.query(`DROP ROLE ${migrator},${runtimeRole}`);}}finally{await admin.end();}if(directory)await rm(directory,{recursive:true,force:true});assert.equal(outboundCalls,0);});
async function worker(options:{enabled?:string;media?:boolean;images?:boolean}={}){
  const instance=new Miniflare(convertV4MiniflareOptions({workers:[{name:'native-cover-'+randomUUID(),modules:true,scriptPath:resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR??'.wrangler/dry-run/local','worker.js'),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings:{FREEDOM_ENV:'local',APP_ORIGIN:origin,FREEDOM_REGISTRATION_COMMUNITY_ID:community,...(options.enabled===undefined?{}:{FREEDOM_SERVICE_COVER_ENABLED:options.enabled})},hyperdrives:{HYPERDRIVE:tcp},...(options.media===false?{}:{r2Buckets:['MEDIA']}),...(options.images===false?{}:{images:{binding:'IMAGES'}}),assets:{directory:join(directory,'assets'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true},assetConfig:{not_found_handling:'none'}},outboundService:async()=>{outboundCalls++;return new Response(null,{status:503});}}]}));instances.push(instance);await instance.ready;return instance;
}
type Member={id:string;cookie:string;csrf:string};
async function member(){const id=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();await owner.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic cover member','not-a-login',$4)",[id,community,id+'@native-cover.test',randomUUID()]);await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[tokenHash(token),id,csrf]);return {id,cookie:'freedom_local_session='+token,csrf};}
const call=(instance:Miniflare,path:string,init?:RequestInit)=>instance.dispatchFetch(origin+path,init as never) as unknown as Promise<Response>;
function headers(member:Member){return {Origin:origin,Cookie:member.cookie,'X-CSRF-Token':member.csrf};}
async function service(instance:Miniflare,member:Member){const response=await call(instance,'/api/v1/member-services',{method:'POST',headers:{...headers(member),'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({title:'Synthetic cover service',category:'hair_beauty',summary:'Synthetic service',description:'Only owned test data.',price_text:'Fixture only',area_text:'Fixture',service_mode:'online',contacts:[{label:'Synthetic contact',url:'https://example.invalid/contact'}]})});assert.equal(response.status,201,await response.clone().text());return (await response.json() as {service_id:string}).service_id;}
function upload(instance:Miniflare,member:Member,id:string,key=randomUUID(),version='1',extra:Record<string,string>={}){return call(instance,'/api/v1/member-services/'+id+'/cover',{method:'PUT',headers:{...headers(member),'Content-Type':'image/png','Idempotency-Key':key,'If-Match':'"'+version+'"',...extra},body:new Uint8Array(png)});}
async function noPublishedCover(){assert.equal((await owner.query("SELECT count(*)::int n FROM assets WHERE state='ready'")).rows[0].n,0);assert.equal((await owner.query('SELECT count(*)::int n FROM member_service_covers')).rows[0].n,0);}
test('canonical Worker cover installation requires explicit opt-in, MEDIA and canonical DB permission; owner lifecycle uses native R2',async()=>{
  const uninstalled=await worker(),installed=await worker({enabled:'true'}),human=await member(),foreign=await member(),id=await service(uninstalled,human);
  assert.equal((await upload(uninstalled,human,id)).status,503);await noPublishedCover();
  assert.equal((await upload(installed,human,id)).status,503,'Bridge mode does not grant persistence.');await noPublishedCover();
  await owner.query("UPDATE domain_media_storage_policy SET policy_revision='synthetic-native-cover-v1',persistence_allowed=true,retained_byte_limit=10485760 WHERE purpose='member.service-cover'");
  for(const options of [{enabled:'false'},{enabled:'malformed'},{enabled:'true',media:false},{enabled:'true',images:false}]){const absent=await worker(options);assert.equal((await upload(absent,human,id)).status,503);await noPublishedCover();if(options.enabled!=='false')assert.equal((await owner.query('SELECT count(*)::int n FROM asset_upload_intents')).rows[0].n,0);}
  assert.equal((await upload(installed,foreign,id)).status,403);assert.equal((await upload(installed,human,id,randomUUID(),'1',{'X-CSRF-Token':'wrong'})).status,403);await noPublishedCover();
  const key=randomUUID(),response=await upload(installed,human,id,key);assert.equal(response.status,200,await response.clone().text());const dto=await response.json() as {cover_url:string;aggregate_version:number};assert.equal(dto.aggregate_version,2);assert.equal(dto.cover_url,'/api/v1/member-services/'+id+'/cover?v=2');
  const replay=await upload(installed,human,id,key);assert.equal(replay.status,200,await replay.clone().text());assert.deepEqual(await replay.json(),dto);
  await owner.query("UPDATE domain_media_storage_policy SET retained_byte_limit=524288 WHERE purpose='member.service-cover'");assert.equal((await upload(installed,human,id,randomUUID(),'2')).status,409);await owner.query("UPDATE domain_media_storage_policy SET retained_byte_limit=10485760 WHERE purpose='member.service-cover'");
  const bucket=await installed.getR2Bucket('MEDIA'),objects=await bucket.list();assert.equal(objects.objects.length,1);
  const rows=(await owner.query("SELECT c.storage_source,octet_length(c.image_bytes) legacy_bytes,o.object_key,o.content_sha256 FROM member_service_covers c JOIN member_service_cover_asset_targets t USING(service_id) JOIN asset_objects o ON o.asset_id=t.asset_id WHERE c.service_id=$1",[id])).rows;assert.equal(rows[0].storage_source,'asset');assert.equal(rows[0].legacy_bytes,null);
  const read=await call(installed,'/api/v1/member-services/'+id+'/cover',{headers:headers(human)});assert.equal(read.status,200);const bytes=Buffer.from(await read.arrayBuffer());assert.equal((await sharp(bytes).metadata()).format,'webp');assert.equal(createHash('sha256').update(bytes).digest('hex'),rows[0].content_sha256);
  const publicRead=await call(installed,'/api/v1/public/member-services/'+id+'/cover');assert.equal(publicRead.status,200);assert.deepEqual(Buffer.from(await publicRead.arrayBuffer()),bytes);
  const pause=await call(installed,'/api/v1/member-services/'+id+'/pause',{method:'POST',headers:{...headers(human),'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"2"'},body:'{}'});assert.equal(pause.status,200);assert.equal((await call(installed,'/api/v1/public/member-services/'+id+'/cover')).status,404);assert.equal((await call(installed,'/api/v1/member-services/'+id+'/cover',{headers:headers(foreign)})).status,404);
  const removal=await call(installed,'/api/v1/member-services/'+id+'/cover/remove',{method:'POST',headers:{...headers(human),'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"3"'},body:'{}'});assert.equal(removal.status,200,await removal.clone().text());assert.equal((await call(installed,'/api/v1/member-services/'+id+'/cover',{headers:headers(human)})).status,404);assert.equal((await bucket.list()).objects.length,1,'Removal cannot run unapproved object GC.');
  await assert.rejects(app.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='member.service-cover'"),error=>(error as {code:string}).code==='42501');
});
