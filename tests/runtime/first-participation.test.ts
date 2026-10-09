import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createWorkerHandler,type WorkerEnv} from '../../apps/platform-api/src/worker.js';
import {z} from 'zod';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
interface TestMember {id:string;email:string;request:(route:string,body?:unknown,version?:number|string,key?:string)=>Promise<Response>}
const completionSchema=z.object({kind:z.enum(['work','guild_message']),source_id:z.string(),created_at:z.string(),title:z.string().nullable(),href:z.string(),audience:z.enum(['community','guild']),reply_count:z.number().nullable()});
const claimantSchema=z.object({user_id:z.string(),display_name:z.string()});
const apiResponse=z.looseObject({aggregate_version:z.number().optional(),state:z.string().optional(),choice:z.string().nullable().optional(),showcase_id:z.string().optional(),opportunity_id:z.string().optional(),message_id:z.string().optional(),completion:completionSchema.nullable().optional(),resume:z.object({source_id:z.string(),href:z.string(),kind:z.literal('work_draft')}).nullable().optional(),claimant:claimantSchema.nullable().optional(),reception:z.object({requested:z.boolean(),state:z.string(),claimant:claimantSchema.nullable()}).optional(),items:z.array(z.object({completion:completionSchema})).optional()});
const url=process.env.TEST_DATABASE_URL;if(!url)throw new Error('TEST_DATABASE_URL must name a disposable database');
const schema=`fp_first_participation_${process.pid}_${Date.now()}`,admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema} -c statement_timeout=15000`,max:16});
const origin='http://127.0.0.1:4310',guild='guild_event_space',path='me/first-participation',queue='first-participation/reception';
const app=createApp(pool,origin,'local',{firstParticipationEnabled:true,personalContentEnabled:true});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function session(email:string,id:string){
 const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password:DEMO_PASSWORD})});assert.equal(response.status,200,await response.clone().text());const auth=z.object({csrf_token:z.string()}).parse(await response.json());
 const headers={Origin:origin,Cookie:response.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':auth.csrf_token,'Content-Type':'application/json'};
 return {id,email,request:async(route:string,body?:unknown,version?:number|string,key:string=randomUUID())=>app.request(origin+'/api/v1/'+route,body===undefined?{headers}:{method:'POST',headers:{...headers,'Idempotency-Key':key,...(version!==undefined?{'If-Match':`"${version}"`}:{})},body:JSON.stringify(body)})};
}
async function member(community=DEMO_COMMUNITY){
 const id=randomUUID(),email=`first-${id}@example.test`;
 if(community!==DEMO_COMMUNITY)await pool.query('INSERT INTO communities VALUES($1,$2) ON CONFLICT DO NOTHING',[community,'合成其他社群']);
 await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required) SELECT $1,$2,$3,$4,password_hash,$5,true FROM users WHERE user_id=$6`,[id,community,email,'合成會員'+id.slice(0,8),randomUUID(),DEMO_USERS[0].user_id]);
 const m=await session(email,id);const onboard=await m.request('me/onboarding/quick-start',{guild_keys:[guild],primary_guild_key:guild,guild_answers:sampleGuildAnswers(guild),confirmed:true});assert.equal(onboard.status,200,await onboard.clone().text());return m;
}
async function json(response:Response,status=200){assert.equal(response.status,status,await response.clone().text());return apiResponse.parse(await response.json());}
async function choose(m:TestMember,choice:'work'|'introduction'){return json(await m.request(path,{action:'choose',choice},1));}
async function publish(m:TestMember,title='真實原作品'){return json(await m.request('showcases',{title,description:'原有作品摘要',consent_to_share:true}),201);}

test('selection, old publications and private drafts do not complete; original publication, relogin and withdrawal are truthful',async()=>{
 const owner=await member(),other=await member();await publish(owner,'較早作品');
 const draft=await json(await owner.request('me/showcases',{title:'私人未分享標題',description:'私人內容'}),201);
 const selected=await choose(owner,'work');assert.equal(selected.state,'chosen');assert.equal(selected.completion,null);assert.equal(selected.resume!.source_id,draft.showcase_id);
 assert.equal((await owner.request(path,{action:'request_reception'},selected.aggregate_version)).status,409);
 const relog=await session(owner.email,owner.id);assert.deepEqual(await json(await relog.request(path)),selected);
 const source=await json(await relog.request('me/showcases/'+draft.showcase_id+'/publish',{consent_to_share:true},draft.aggregate_version));
 const complete=await json(await relog.request(path));assert.equal(complete.state,'completed');assert.equal(complete.completion!.source_id,source.showcase_id);assert.equal(complete.completion!.reply_count,0);
 const need=await json(await other.request('opportunities',{showcase_id:source.showcase_id,need:'原有私人合作需求'}),201);assert.ok(need.opportunity_id);
 assert.equal((await json(await relog.request(path))).completion!.reply_count,1);
 await json(await relog.request(path,{action:'request_reception'},complete.aggregate_version));
 const visible=await json(await other.request(queue));assert.equal(visible.items![0].completion.reply_count,null);assert.equal(JSON.stringify(visible).includes('私人內容'),false);
 await json(await relog.request('me/showcases/'+source.showcase_id+'/withdraw',{},source.aggregate_version));
 const unavailable=await json(await relog.request(path));assert.equal(unavailable.state,'source_unavailable');assert.equal(unavailable.completion,null);
 assert.deepEqual((await json(await other.request(queue))).items,[]);assert.equal((await other.request(queue+'/'+owner.id+'/claim',{},unavailable.aggregate_version)).status,404);
 assert.equal((await other.request(path)).status,200);assert.equal((await json(await other.request(path))).choice,null);
});

test('first insert CAS and replay serialize selection; skip dismiss resume persist without fake completion',async()=>{
 const m=await member(),key=randomUUID(),body={action:'choose',choice:'work'};
 const responses=await Promise.all([m.request(path,body,1,key),m.request(path,body,1,key)]);for(const r of responses)assert.equal(r.status,200,await r.clone().text());
 let value=await json(await m.request(path));assert.equal(value.aggregate_version,2);assert.equal(value.completion,null);
 assert.equal((await m.request(path,{action:'dismiss'},1)).status,412);
 value=await json(await m.request(path,{action:'skip'},value.aggregate_version));assert.equal(value.state,'skipped');
 value=await json(await m.request(path,{action:'dismiss'},value.aggregate_version));assert.equal(value.state,'dismissed');
 const again=await session(m.email,m.id);assert.equal((await json(await again.request(path))).state,'dismissed');
 value=await json(await again.request(path,{action:'resume'},value.aggregate_version));assert.equal(value.state,'chosen');assert.equal(value.completion,null);
 assert.equal((await m.request(path,{action:'choose',choice:'comment'},value.aggregate_version)).status,422);
 assert.equal((await m.request(path,{action:'resume',completed:true},value.aggregate_version)).status,422);
 const receipts=await pool.query("SELECT response FROM command_receipts WHERE user_id=$1 AND operation='POST /api/v1/me/first-participation'",[m.id]);assert.equal(JSON.stringify(receipts.rows).includes('title'),false);
});

test('different first commands have one CAS winner and disabled claimant loses current eligibility',async()=>{
 const owner=await member(),volunteer=await member(),replacement=await member();
 const attempts=await Promise.all([owner.request(path,{action:'choose',choice:'work'},1),owner.request(path,{action:'choose',choice:'introduction'},1)]);
 assert.deepEqual(attempts.map(response=>response.status).sort(),[200,412]);
 let progress=await json(await owner.request(path));
 if(progress.choice!=='work')progress=await json(await owner.request(path,{action:'choose',choice:'work'},progress.aggregate_version));
 await publish(owner);progress=await json(await owner.request(path,{action:'request_reception'},progress.aggregate_version));
 const claimed=await json(await volunteer.request(queue+'/'+owner.id+'/claim',{},progress.aggregate_version));
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[volunteer.id]);
 assert.equal((await json(await owner.request(path))).reception!.claimant,null);
 const next=await json(await replacement.request(queue+'/'+owner.id+'/claim',{},claimed.aggregate_version));
 assert.equal(next.claimant!.user_id,replacement.id);
 const count=(await pool.query('SELECT count(*)::int AS n FROM member_first_participation WHERE user_id=$1',[owner.id])).rows[0].n;
 assert.equal(count,1);
});

test('volunteer opt-in, cross-community denial, one claim winner, release, stop and revoked replay use current sources',async()=>{
 const owner=await member(),a=await member(),b=await member(),outsider=await member(randomUUID());const selection=await choose(owner,'work');await publish(owner);
 assert.deepEqual((await json(await a.request(queue))).items,[]);
 const request=await json(await owner.request(path,{action:'request_reception'},selection.aggregate_version));
 assert.deepEqual((await json(await outsider.request(queue))).items,[]);assert.equal((await outsider.request(queue+'/'+owner.id+'/claim',{},request.aggregate_version)).status,404);
 assert.equal((await owner.request(queue+'/'+owner.id+'/claim',{},request.aggregate_version)).status,403);
 const ka=randomUUID(),kb=randomUUID();const results=await Promise.all([a.request(queue+'/'+owner.id+'/claim',{},request.aggregate_version,ka),b.request(queue+'/'+owner.id+'/claim',{},request.aggregate_version,kb)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);const winner=results[0].status===200?a:b,key=results[0].status===200?ka:kb;
 const claimed=await json(await owner.request(path));assert.equal(claimed.reception!.claimant!.user_id,winner.id);
 assert.equal((await winner.request(queue+'/'+owner.id+'/claim',{},request.aggregate_version,key)).status,200);
 const released=await json(await winner.request(queue+'/'+owner.id+'/release',{},claimed.aggregate_version));assert.equal(released.claimant,null);
 await json(await owner.request(path,{action:'stop_reception'},released.aggregate_version));
 assert.deepEqual((await json(await a.request(queue))).items,[]);assert.equal((await winner.request(queue+'/'+owner.id+'/claim',{},request.aggregate_version,key)).status,404);
 assert.equal((await json(await owner.request(path))).reception!.state,'stopped');
});

test('only actual selected guild message completes; replies count original other-author replies, leave and disabled owner revoke',async()=>{
 const owner=await member(),volunteer=await member();const messages=`me/channels/guild/${guild}/messages`;
 await json(await owner.request(messages,{body:'選擇前原訊息'}),201);const selected=await choose(owner,'introduction');assert.equal(selected.completion,null);
 const sent=await json(await owner.request(messages,{body:'自己實際送出的第一則'}),201);
 await json(await owner.request(messages,{body:'自己的回覆',reply_to_message_id:sent.message_id}),201);
 await json(await volunteer.request(messages,{body:'原公會回覆',reply_to_message_id:sent.message_id}),201);
 const complete=await json(await owner.request(path));assert.equal(complete.completion!.source_id,sent.message_id);assert.equal(complete.completion!.reply_count,1);assert.equal(complete.completion!.title,null);
 await json(await owner.request(path,{action:'request_reception'},selected.aggregate_version));assert.equal((await json(await volunteer.request(queue))).items!.length,1);
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE community_id=$1 AND user_id=$2 AND guild_key=$3",[DEMO_COMMUNITY,volunteer.id,guild]);
 assert.deepEqual((await json(await volunteer.request(queue))).items,[]);assert.equal((await volunteer.request(queue+'/'+owner.id+'/claim',{},3)).status,404);
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE community_id=$1 AND user_id=$2 AND guild_key=$3",[DEMO_COMMUNITY,owner.id,guild]);
 const unavailable=await json(await owner.request(path));assert.equal(unavailable.state,'source_unavailable');assert.equal(unavailable.completion,null);
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[owner.id]);assert.equal((await owner.request(path)).status,401);
});

test('OFF and invalid dependency combinations fail before any feature database/auth/static work',async()=>{
 let reads=0;const unavailable={query:()=>{reads++;throw new Error('unexpected database');},connect:()=>{reads++;throw new Error('unexpected database');}} as unknown as Pool;
 const off=createApp(unavailable,origin,'local');for(const route of [path,queue,queue+'/'+randomUUID()+'/claim'])assert.equal((await off.request(origin+'/api/v1/'+route)).status,404);assert.equal(reads,0);
 assert.throws(()=>createApp(unavailable,origin,'local',{firstParticipationEnabled:true}),/first_participation_requires/);
 const handler=createWorkerHandler({createPool:()=>{reads++;throw new Error('unexpected pool');}});const env={FREEDOM_ENV:'local',APP_ORIGIN:origin,HYPERDRIVE:{connectionString:'postgresql://unavailable'},ASSETS:{fetch:()=>{throw new Error('unexpected static');}}} satisfies WorkerEnv;const ctx={waitUntil:()=>{}};
 assert.equal((await handler.fetch(new Request(origin+'/api/v1/'+path),env,ctx)).status,404);assert.equal(reads,0);
 assert.equal((await handler.fetch(new Request(origin+'/'),{...env,FREEDOM_FIRST_PARTICIPATION_ENABLED:'true'},ctx)).status,503);assert.equal(reads,0);
 assert.equal((await handler.fetch(new Request(origin+'/'),{...env,FREEDOM_FIRST_PARTICIPATION_ENABLED:'invalid'},ctx)).status,503);assert.equal(reads,0);
});
