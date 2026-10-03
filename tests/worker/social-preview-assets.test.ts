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
const database=`fp_worker_preview_${process.pid}_${Date.now()}`,migrator=database+'_owner',runtimeRole=database+'_app',password=randomBytes(24).toString('hex');
function roleUrl(role:string){const url=new URL(raw!);url.pathname='/'+database;url.username=role;url.password=password;return url.href;}
const admin=new Pool({connectionString:raw}),owner=new Pool({connectionString:roleUrl(migrator)}),app=new Pool({connectionString:roleUrl(runtimeRole)});
const sockets=new Set<Socket>(),proxy=socket?createServer(client=>{const upstream=createConnection(join(socket,'.s.PGSQL.5432'));for(const channel of [client,upstream]){sockets.add(channel);channel.on('close',()=>sockets.delete(channel));channel.on('error',()=>{client.destroy();upstream.destroy();});}client.pipe(upstream).pipe(client);}):undefined;
const origin='http://127.0.0.1:8787',community=randomUUID(),instances:Miniflare[]=[];let directory:string,tcp:string,png:Buffer,created=false,outboundCalls=0;
before(async()=>{
  await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${migrator}`);created=true;await migrate(owner);
  const source=(await readFile('deploy/cloudflare/sql/20-runtime-grants.psql','utf8')).replace(/^\\set .*$/mg,'').replaceAll(':"runtime"','"'+runtimeRole+'"').replaceAll(":'runtime'","'"+runtimeRole+"'");
  const q=await owner.connect();try{const parts=source.split('\\gexec');for(let index=0;index<parts.length;index++){const result=await q.query(parts[index]);if(index<parts.length-1){const last=Array.isArray(result)?result.at(-1)!:result;for(const row of last.rows)await q.query(Object.values(row)[0] as string);}}}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  const connection=new URL(roleUrl(runtimeRole));if(proxy){await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const address=proxy.address();assert(address&&typeof address==='object');connection.hostname='127.0.0.1';connection.port=String(address.port);connection.searchParams.delete('host');}tcp=connection.href;
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic native social community')",[community]);
  directory=await mkdtemp(resolve('.wrangler/native-preview-'));await mkdir(join(directory,'assets'));await writeFile(join(directory,'assets/index.html'),'<!doctype html><title>Native social fixture</title>');
  png=await sharp({create:{width:30,height:40,channels:3,background:'#337788'}}).png().toBuffer();
});
after(async()=>{for(const instance of instances)await instance.dispose();for(const channel of sockets)channel.destroy();if(proxy?.listening)await new Promise<void>(r=>proxy.close(()=>r()));await Promise.all([owner.end(),app.end()]);try{if(created){await admin.query(`DROP DATABASE ${database}`);await admin.query(`DROP ROLE ${migrator},${runtimeRole}`);}}finally{await admin.end();}if(directory)await rm(directory,{recursive:true,force:true});});
async function worker(options:{enabled?:string;media?:boolean;images?:boolean}={}){
  const instance=new Miniflare(convertV4MiniflareOptions({workers:[{name:'native-preview-'+randomUUID(),modules:true,scriptPath:resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR??'.wrangler/dry-run/local','worker.js'),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings:{FREEDOM_ENV:'local',APP_ORIGIN:origin,FREEDOM_REGISTRATION_COMMUNITY_ID:community,...(options.enabled===undefined?{}:{FREEDOM_SOCIAL_THUMBNAIL_ENABLED:options.enabled})},hyperdrives:{HYPERDRIVE:tcp},...(options.media===false?{}:{r2Buckets:['MEDIA']}),...(options.images===false?{}:{images:{binding:'IMAGES'}}),assets:{directory:join(directory,'assets'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true},assetConfig:{not_found_handling:'none'}},outboundService:async(request)=>{outboundCalls++;const url=new URL(request.url);assert.equal(request.method,'GET');assert.equal(request.headers.get('user-agent'),'FreedomWorkshopPreview/1.0 (+https://freetwai.com)');assert.equal(request.headers.get('cookie'),null);assert.equal(request.headers.get('authorization'),null);assert.equal(url.protocol,'https:');if(url.hostname==='www.youtube.com'&&url.pathname==='/oembed')return Response.json({title:'Synthetic HTTPS preview'});assert.equal(url.hostname,'i.ytimg.com');assert.match(url.pathname,/^\/vi\/[a-zA-Z0-9_-]+\/hqdefault\.jpg$/);if(url.pathname.includes('/redirect001/'))return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}});if(url.pathname.includes('/oversized01/'))return new Response(new Uint8Array(png),{headers:{'Content-Type':'image/png','Content-Length':'5242881'}});return new Response(new Uint8Array(png),{headers:{'Content-Type':'image/png'}});}}]}));instances.push(instance);await instance.ready;return instance;
}
type Member={id:string;cookie:string;csrf:string};
async function member(){const id=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();await owner.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic social member','not-a-login',$4)",[id,community,id+'@native-social.test',randomUUID()]);await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[tokenHash(token),id,csrf]);return {id,cookie:'freedom_local_session='+token,csrf};}
const call=(instance:Miniflare,path:string,init?:RequestInit)=>instance.dispatchFetch(origin+path,init as never) as unknown as Promise<Response>;
function headers(member:Member){return {Origin:origin,Cookie:member.cookie,'X-CSRF-Token':member.csrf};}

function create(instance:Miniflare,human:Member,key=randomUUID(),video='abcdefghijk'){return call(instance,'/api/v1/social-posts',{method:'POST',headers:{...headers(human),'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({url:'https://www.youtube.com/watch?v='+video,title:'Synthetic HTTPS preview'})});}
test('original social POST traverses native Worker HTTPS preview normalization, restricted SQL, R2 and replay',async()=>{
 const human=await member(),installed=await worker({enabled:'true'});
 await owner.query("UPDATE domain_media_storage_policy SET mode='bridge' WHERE purpose='community.social-thumbnail'");
 const missing=await worker({enabled:'true',media:false});assert.equal((await create(missing,human)).status,503);assert.equal(outboundCalls,0);
 assert.equal((await create(installed,human)).status,503);assert.equal(outboundCalls,2);assert.equal((await owner.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,0);
 await owner.query("UPDATE domain_media_storage_policy SET policy_revision='synthetic-native-preview-v1',persistence_allowed=true,retained_byte_limit=10485760 WHERE purpose='community.social-thumbnail'");
 const uninstalled=await worker();assert.equal((await create(uninstalled,human)).status,503);assert.equal(outboundCalls,4);assert.equal((await owner.query('SELECT count(*)::int n FROM community_social_posts')).rows[0].n,0);
 const key=randomUUID(),response=await create(installed,human,key);assert.equal(response.status,201,await response.clone().text());const dto=await response.json() as {post_id:string;thumbnail_url:string};assert.equal(dto.thumbnail_url,'/api/v1/social-posts/'+dto.post_id+'/thumbnail');assert.equal(outboundCalls,6);
 const replay=await create(installed,human,key);assert.equal(replay.status,201,await replay.clone().text());assert.deepEqual(await replay.json(),dto);assert.equal(outboundCalls,6,'Receipt replay must not refetch preview.');
 const bucket=await installed.getR2Bucket('MEDIA');assert.equal((await bucket.list()).objects.length,1);
 const row=(await owner.query("SELECT t.storage_source,t.image_bytes,t.source,o.content_sha256 FROM community_social_post_thumbnails t JOIN community_social_thumbnail_asset_targets a USING(post_id) JOIN asset_objects o ON o.asset_id=a.asset_id WHERE t.post_id=$1",[dto.post_id])).rows[0];assert.equal(row.storage_source,'asset');assert.equal(row.image_bytes,null);assert.equal(row.source,'youtube');
 const publicPath='/api/v1/public/social-posts/'+dto.post_id+'/thumbnail',read=await call(installed,publicPath);assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'public, max-age=300');const bytes=Buffer.from(await read.arrayBuffer()),metadata=await sharp(bytes).metadata();assert.equal(metadata.format,'webp');assert.equal(metadata.width,640);assert.equal(metadata.height,360);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.content_sha256);
 assert.equal((await call(uninstalled,dto.thumbnail_url,{headers:headers(human)})).status,503);assert.equal(outboundCalls,6);
 for(const video of ['redirect001','oversized01']){const requestsBefore:number=outboundCalls;const result=await create(installed,human,randomUUID(),video);assert.equal(result.status,201,await result.clone().text());const bare=await result.json() as {thumbnail_url:unknown};assert.equal(bare.thumbnail_url,null);assert.equal(outboundCalls,requestsBefore+2,'No request to rejected redirect and no image fallback.');assert.equal((await bucket.list()).objects.length,1);}
 await assert.rejects(app.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='community.social-thumbnail'"),e=>(e as {code:string}).code==='42501');
 const removed=await call(installed,'/api/v1/social-posts/'+dto.post_id,{method:'DELETE',headers:{...headers(human),'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:'{}'});assert.equal(removed.status,200,await removed.clone().text());assert.equal((await call(installed,publicPath)).status,404);assert.equal((await bucket.list()).objects.length,1);assert.equal((await owner.query("SELECT count(*)::int n FROM assets WHERE state='ready'")).rows[0].n,0);
});
