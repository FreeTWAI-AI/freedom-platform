import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createServer,createConnection,type Socket} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import sharp from 'sharp';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrate} from '../../scripts/database.js';
import {backfillLegacyScopeBatch} from '../../packages/resource-scopes/index.js';
import {planOperatorBackfill} from '../../packages/media-migration/operator-backfill.js';
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');

test('private named native operator RPC binds actual restricted SQL and R2; cover/video, closed profiles and unknown PUT reconciliation',{timeout:60000},async()=>{
 const raw=process.env.TEST_DATABASE_URL;if(!raw)throw Error('Explicit owned TEST_DATABASE_URL required');
 const parsed=new URL(raw),socket=parsed.searchParams.get('host');if(!/^\/fp_[a-z0-9_]+$/.test(parsed.pathname)||(!socket&&!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)))throw Error('Owned fp_* loopback/socket database required');
 const suffix=process.pid+'_'+Date.now(),schema='fp_operator_rpc_'+suffix,role='fp_media_migrator_'+suffix,foreign=role+'_f',password=randomBytes(24).toString('hex');
 const admin=new Pool({connectionString:raw}),owner=new Pool({connectionString:raw,options:'-c search_path='+schema});
 const sockets=new Set<Socket>(),proxy=socket?createServer(client=>{const upstream=createConnection(join(socket,'.s.PGSQL.5432'));for(const s of [client,upstream]){sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{client.destroy();upstream.destroy();});}client.pipe(upstream).pipe(client);}):undefined;
 let mf:Miniflare|undefined,directory:string|undefined,created=false;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);created=true;await migrate(owner);
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}';CREATE ROLE ${foreign} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
  const grants=(await readFile(new URL('../../deploy/cloudflare/sql/40-media-backfill-operator-grants.psql',import.meta.url),'utf8')).split('-- BEGIN CLOSED OPERATOR GRANTS')[1].split('-- END CLOSED OPERATOR GRANTS')[0];
  const q=await owner.connect();try{for(const r of [role,foreign]){await q.query('BEGIN');await q.query("SELECT set_config('freedom.operator_role',$1,true),set_config('freedom.operator_schema',$2,true)",[r,schema]);await q.query(grants);await q.query('COMMIT');}}catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();}
  let port:string|undefined;if(proxy){await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const a=proxy.address();assert(a&&typeof a==='object');port=String(a.port);}
  const hyperdrive=(r:string)=>{const u=new URL(raw);u.username=r;u.password=password;if(proxy){u.hostname='127.0.0.1';u.port=port!;u.searchParams.delete('host');}return u.href;};
  const target={environment:'local' as const,database:parsed.pathname.slice(1),schema,role,releaseSha:'4'.repeat(40)},binding='synthetic-native-operator-r2';
  const profile={target,logicalStore:'MEDIA',storeBindingId:binding,purposes:['member.service-cover','community.event-video']};
  const bindings={FREEDOM_MEDIA_OPERATOR_ENABLED:'true',FREEDOM_MEDIA_OPERATOR_ENVIRONMENT:'local',FREEDOM_MEDIA_OPERATOR_RELEASE_SHA:target.releaseSha,FREEDOM_MEDIA_OPERATOR_STORE_BINDING_ID:binding,FREEDOM_MEDIA_OPERATOR_PROFILE:JSON.stringify(profile)};
  directory=await mkdtemp(resolve('.wrangler/media-operator-rpc-'));
  await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','wrangler.media-operator.example.jsonc','--env','staging-next','--outdir',directory],{maxBuffer:1024*1024});
  const native={name:'operator',modules:true,scriptPath:join(directory,'worker.js'),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings,hyperdrives:{OPERATOR_HYPERDRIVE:hyperdrive(role)},r2Buckets:{MEDIA:'synthetic-operator-private-assets'},outboundService:'no-external'};
  const bundle=await readFile(join(directory,'worker.js'),'utf8');
  const fault=`import {MediaOperator as Base} from './main.js';export class MediaOperator extends Base {constructor(ctx,env){const b=env.MEDIA;super(ctx,{...env,MEDIA:{put:async(...a)=>{await b.put(...a);throw Error('synthetic unknown ACK');},get:async()=>{throw Error('synthetic readback unavailable');},head:(...a)=>b.head(...a),delete:(...a)=>b.delete(...a)}});}}export {default} from './main.js';`;
  const partial=`import {MediaOperator as Base} from './main.js';export class MediaOperator extends Base {constructor(ctx,env){const b=env.MEDIA;super(ctx,{...env,MEDIA:{put:(...a)=>b.put(...a),get:(...a)=>b.get(...a)}});}}export {default} from './main.js';`;
  const names=['partial-media','cover-only','operator','disabled','absent-flag','invalid-flag','missing-profile','missing-media','missing-db','wrong-environment','wrong-release','wrong-binding','foreign-role','unknown-ack'];
  const caller=`export default {async fetch(r,e){try{return Response.json(await e[new URL(r.url).pathname.slice(1)].execute(await r.json()));}catch{return Response.json({code:'operator_media_unavailable'},{status:503});}}};`;
  mf=new Miniflare(convertV4MiniflareOptions({workers:[native,
   {...native,name:'partial-media',scriptPath:undefined,modules:[{type:'ESModule',path:'entry.js',contents:partial},{type:'ESModule',path:'main.js',contents:bundle}]},
   {...native,name:'cover-only',bindings:{...bindings,FREEDOM_MEDIA_OPERATOR_PROFILE:JSON.stringify({...profile,purposes:['member.service-cover']})}},
   {name:'no-external',modules:true,script:"let calls=0;export default {fetch(r){if(new URL(r.url).pathname==='/counts')return Response.json({calls});calls++;return new Response(null,{status:503});}}",compatibilityDate:'2026-09-21'},
   {...native,name:'disabled',bindings:{...bindings,FREEDOM_MEDIA_OPERATOR_ENABLED:'false'}},
   {...native,name:'absent-flag',bindings:Object.fromEntries(Object.entries(bindings).filter(([k])=>k!=='FREEDOM_MEDIA_OPERATOR_ENABLED'))},
   {...native,name:'invalid-flag',bindings:{...bindings,FREEDOM_MEDIA_OPERATOR_ENABLED:'TRUE'}},
   {...native,name:'missing-profile',bindings:{...bindings,FREEDOM_MEDIA_OPERATOR_PROFILE:''}},
   {...native,name:'missing-media',r2Buckets:{}},{...native,name:'missing-db',hyperdrives:{}},
   {...native,name:'wrong-environment',bindings:{...bindings,FREEDOM_MEDIA_OPERATOR_ENVIRONMENT:'public'}},
   {...native,name:'wrong-release',bindings:{...bindings,FREEDOM_MEDIA_OPERATOR_RELEASE_SHA:'5'.repeat(40)}},
   {...native,name:'wrong-binding',bindings:{...bindings,FREEDOM_MEDIA_OPERATOR_STORE_BINDING_ID:'foreign-store'}},
   {...native,name:'foreign-role',hyperdrives:{OPERATOR_HYPERDRIVE:hyperdrive(foreign)}},
   {...native,name:'unknown-ack',scriptPath:undefined,modules:[{type:'ESModule',path:'entry.js',contents:fault},{type:'ESModule',path:'main.js',contents:bundle}]},
   {name:'caller',modules:true,script:caller,compatibilityDate:'2026-09-21',serviceBindings:Object.fromEntries(names.map(n=>[n,{name:n,entrypoint:'MediaOperator'}]))}]}));await mf.ready;
  const client=await mf.getWorker('caller'),rpc=async(name:string,p:unknown)=>client.fetch('https://synthetic-private-rpc.internal/'+name,{method:'POST',body:JSON.stringify(p)});
  const plan=(purpose:'member.service-cover'|'community.event-video')=>planOperatorBackfill({target,jobId:randomUUID(),logicalStore:'MEDIA',storeBindingId:binding,migrationId:'synthetic-native-'+purpose.split('.').at(-1),purpose,maxRows:1,maxBytes:purpose==='member.service-cover'?8388608:134217728,leaseSeconds:30});
  const approve=async(p:ReturnType<typeof plan>)=>{await owner.query("INSERT INTO media_backfill_operator_policy(role_name,environment,database_name,schema_name,release_sha,logical_store,store_binding_id,migration_id,purpose,approved_plan_sha256,allowed,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,clock_timestamp()+interval '1 hour')",[target.role,target.environment,target.database,target.schema,target.releaseSha,p.logicalStore,p.storeBindingId,p.migrationId,p.purpose,p.planSha256]);return p;};
  await owner.query("UPDATE domain_media_storage_policy SET mode='bridge',policy_revision='synthetic-native-operator-v1',persistence_allowed=true,retained_byte_limit=134217728 WHERE purpose IN('member.service-cover','community.event-video')");
  const bytes=await sharp({create:{width:1200,height:675,channels:3,background:'green'}}).webp().toBuffer(),community=randomUUID(),user=randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic RPC operator')",[community]);
  await owner.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic','not-a-password',$4)",[user,community,user+'@operator.invalid',randomUUID()]);
  const cover=async()=>{const id=randomUUID();await owner.query("INSERT INTO member_services(service_id,community_id,owner_user_id,title,category,summary,service_mode,contacts,state) VALUES($1,$2,$3,'Synthetic','other','Synthetic','online','[{}]','active')",[id,community,user]);await owner.query('INSERT INTO member_service_covers(service_id,image_bytes) VALUES($1,$2)',[id,bytes]);return id;};
  const service=await cover();await backfillLegacyScopeBatch(owner,500);await backfillLegacyScopeBatch(owner,500);
  const p=await approve(plan('member.service-cover'));
  for(const n of names.filter(n=>!['operator','unknown-ack','cover-only'].includes(n)))assert.equal((await rpc(n,p)).status,503,n);
  for(const bad of [{...p,storeBindingId:'foreign-plan'},{...p,purpose:'member.avatar'},{...p,planSha256:'0'.repeat(64)}])assert.equal((await rpc('operator',bad)).status,503);
  assert.equal((await rpc('operator',plan('member.service-cover'))).status,503,'missing actual DB approval');
  assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);
  await owner.query(`GRANT UPDATE(status) ON principals TO ${role}`);try{assert.equal((await rpc('operator',p)).status,503,'live extra owner authority refuses before host');}finally{await owner.query(`REVOKE UPDATE(status) ON principals FROM ${role}`);}
  const direct=await mf.getWorker('operator');for(const method of ['GET','POST'])assert.equal((await direct.fetch('https://operator.invalid/execute',{method,...(method==='POST'?{body:JSON.stringify(p)}:{})})).status,404);
  await owner.query("UPDATE domain_media_storage_policy SET persistence_allowed=false WHERE purpose='member.service-cover'");assert.equal((await rpc('operator',await approve(plan('member.service-cover')))).status,503,'current canonical consent required');assert.equal((await owner.query('SELECT count(*)::int n FROM assets')).rows[0].n,0);await owner.query("UPDATE domain_media_storage_policy SET persistence_allowed=true WHERE purpose='member.service-cover'");
  const first=await rpc('operator',p);assert.equal(first.status,200,await first.clone().text());assert.equal((await first.json() as any).linked,1);
  const row=(await owner.query('SELECT c.image_bytes,c.storage_source,s.aggregate_version,o.content_sha256 FROM member_services s JOIN member_service_covers c USING(service_id) JOIN member_service_cover_asset_targets t USING(service_id) JOIN asset_objects o USING(asset_id) WHERE service_id=$1',[service])).rows[0];assert.deepEqual(row.image_bytes,bytes);assert.equal(row.storage_source,'asset');assert.equal(row.aggregate_version,'2');assert.equal(row.content_sha256,hash(bytes));
  assert.equal((await (await rpc('operator',p)).json() as any).status,'complete');
  const event=randomUUID(),video=Buffer.alloc(2048);video.writeUInt32BE(24,0);video.write('ftyp',4);video.write('isom',8);
  await owner.query("INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind) VALUES($1,$2,$3,'Synthetic','Synthetic',clock_timestamp()-interval '2 hour',clock_timestamp()-interval '1 hour','online','Synthetic','published','open','other')",[event,community,user]);
  await owner.query("INSERT INTO community_event_videos(event_id,media_bytes,mime_type) VALUES($1,$2,'video/mp4')",[event,video]);
  await backfillLegacyScopeBatch(owner,500);await backfillLegacyScopeBatch(owner,500);
  const vp=await approve(plan('community.event-video'));assert.equal((await rpc('cover-only',vp)).status,503,'closed installed purpose subset');const vr=await rpc('operator',vp);assert.equal(vr.status,200,await vr.clone().text());assert.equal((await vr.json() as any).linked,1);
  assert.deepEqual((await owner.query('SELECT media_bytes,storage_source FROM community_event_videos WHERE event_id=$1',[event])).rows[0],{media_bytes:video,storage_source:'asset'});
  const uncertain=await cover(),up=await approve(plan('member.service-cover'));assert.equal((await rpc('unknown-ack',up)).status,503);
  assert.equal((await owner.query('SELECT storage_source FROM member_service_covers WHERE service_id=$1',[uncertain])).rows[0].storage_source,'legacy');
  const item=(await owner.query('SELECT intent_id,asset_id FROM media_backfill_items WHERE job_id=$1',[up.jobId])).rows[0];assert.ok(item);assert.deepEqual((await owner.query('SELECT state FROM asset_object_write_effects WHERE asset_id=$1',[item.asset_id])).rows,[{state:'unknown'}]);
  assert.ok((await owner.query('SELECT event FROM media_backfill_audit WHERE job_id=$1',[up.jobId])).rows.some(r=>r.event==='object_outcome_unknown'));
  await owner.query('UPDATE media_backfill_jobs SET lease_expires_at=LEAST(lease_expires_at,clock_timestamp()) WHERE job_id=$1',[up.jobId]);await owner.query('UPDATE asset_upload_intents SET lease_expires_at=LEAST(lease_expires_at,clock_timestamp()) WHERE intent_id=$1',[item.intent_id]);
  const resumed=await rpc('operator',up);assert.equal(resumed.status,200,await resumed.clone().text());assert.equal((await resumed.json() as any).linked,1);
  const reconciled=(await owner.query('SELECT intent_id,asset_id,fence FROM asset_upload_intents WHERE intent_id=$1',[item.intent_id])).rows[0];assert.equal(reconciled.asset_id,item.asset_id);assert.equal(reconciled.fence,'2');assert.deepEqual((await owner.query('SELECT state FROM asset_object_write_effects WHERE asset_id=$1 ORDER BY state',[item.asset_id])).rows,[{state:'fulfilled'},{state:'unknown'}],'retry does not erase old uncertain effect evidence');
  const bucket=await mf.getR2Bucket('MEDIA','operator');for(const o of (await owner.query('SELECT object_key,content_sha256 FROM asset_objects')).rows){const object=await bucket.get(o.object_key);assert.ok(object);assert.equal(hash(new Uint8Array(await object.arrayBuffer())),o.content_sha256);}
  assert.equal((await owner.query('SELECT count(*)::int n FROM sessions')).rows[0].n,0);
  const restricted=new Pool({connectionString:hyperdrive(role)});try{for(const sql of ['UPDATE users SET active=active','UPDATE domain_media_storage_policy SET persistence_allowed=true','UPDATE media_backfill_operator_policy SET allowed=true','SELECT * FROM broker_credential_vault'])await assert.rejects(restricted.query('SET search_path TO '+schema+';'+sql),(e:any)=>e.code==='42501');}finally{await restricted.end();}
  assert.equal((await (await (await mf.getWorker('no-external')).fetch('https://synthetic-no-external.internal/counts')).json() as any).calls,0,'no external HTTP calls');
  assert.equal((await bucket.list()).objects.length,3,'exactly one immutable native object per published source');
  assert.equal((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE usename IN($1,$2)',[role,foreign])).rows[0].n,0,'no cross-request pooled client');
 }finally{
  await mf?.dispose();for(const s of sockets)s.destroy();if(proxy?.listening)await new Promise<void>((r,j)=>proxy.close(e=>e?j(e):r()));await owner.end();
  if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role};DROP ROLE IF EXISTS ${foreign}`);await admin.end();if(directory)await rm(directory,{recursive:true,force:true});
 }
});
