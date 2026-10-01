import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {readPublicCards} from '../../modules/identity-membership/member-sharing.js';
const database=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_ecard_${process.pid}_${Date.now()}`,admin=createPool(database),pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,max:8});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin);
type Session={cookie:string;csrf:string;id:string};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();if(version!==undefined)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function member(name:string,ready=true,email=`${randomUUID()}@example.test`):Promise<Session>{
  const result=await request('/auth/register',undefined,{email,nickname:name,password:'freedom-connections-password'});assert.equal(result.status,201);
  const session={cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token,id:result.data.user.user_id};
  if(ready)assert.equal((await request('/me/onboarding/quick-start',session,{guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')})).status,200);
  return session;
}
const link=(label:string,url:string)=>({label,url});
const shareBody=(extra:Record<string,unknown>={})=>({enabled:true,include_avatar:false,design:'calm',headline:'一句話',links:[link('作品','https://example.com/a')],...extra});
function generationOf(path:string){return createHash('sha256').update(path.split('/').at(-1)!).digest('hex').slice(0,16);}
async function stamp(){
  const shares=(await pool.query('SELECT count(*)::int AS n, coalesce(max(aggregate_version),0)::int AS v FROM member_card_shares')).rows[0];
  const journal=(await pool.query('SELECT count(*)::int AS n FROM transition_journal')).rows[0].n;
  const receipts=(await pool.query('SELECT count(*)::int AS n FROM command_receipts')).rows[0].n;
  return {n:shares.n,v:shares.v,journal,receipts};
}

test('card links, headlines and designs are rejected in zh-TW before anything is saved',async()=>{
  const owner=await member('名片校驗');
  const rejected:[Record<string,unknown>,RegExp][]=[
    [shareBody({links:[link('作品','http://example.com')]}),/名片連結只接受 https 網址/],
    [shareBody({links:[link('作品','javascript:alert(1)')]}),/名片連結只接受 https 網址/],
    [shareBody({links:[link('作品','data:text/html,hi')]}),/名片連結只接受 https 網址/],
    [shareBody({links:[link('作品','https://user:pass@example.com/a')]}),/名片連結不可包含帳號或密碼/],
    [shareBody({links:[link('作品','https://example.com/'+'a'.repeat(290))]}),/名片連結網址最多 300 個字/],
    [shareBody({links:Array.from({length:9},(_,index)=>link(`連結${index}`,`https://example.com/${index}`))}),/名片連結最多 8 個/],
    [shareBody({links:[link('','https://example.com/a')]}),/連結名稱需要 1 到 30 個字/],
    [shareBody({links:[link('   ','https://example.com/a')]}),/連結名稱需要 1 到 30 個字/],
    [shareBody({links:[link('名'.repeat(31),'https://example.com/a')]}),/連結名稱需要 1 到 30 個字/],
    [shareBody({links:[link('好\n名','https://example.com/a')]}),/連結名稱請使用單行文字/],
    [shareBody({headline:'介'.repeat(61)}),/一句話介紹最多 60 個字/],
    [shareBody({design:'neon'}),/名片樣式請選擇清新、工坊、夜空或經典名片/],
  ];
  for(const [body,detail] of rejected){const result=await request('/me/member-card-share',owner,body);assert.equal(result.status,422);assert.match(result.data.detail,detail);}
  assert.equal((await pool.query('SELECT aggregate_version FROM member_card_shares WHERE user_id=$1',[owner.id])).rowCount,0);
});

test('omitted card fields keep their values, a stale version conflicts, and the public card hides when disabled',async()=>{
  const owner=await member('名片保存');
  const exact='https://example.com/'+'b'.repeat(280);assert.equal([...exact].length,300);
  const links=Array.from({length:8},(_,index)=>link(`作品${index}`,index===7?exact:`https://example.com/item/${index}`));
  const saved=await request('/me/member-card-share',owner,shareBody({design:'workshop',headline:'做開源的人',links,include_avatar:true}));
  assert.equal(saved.status,200,saved.data.detail);assert.equal(saved.data.design,'workshop');assert.equal(saved.data.headline,'做開源的人');assert.equal(saved.data.links.length,8);assert.equal(saved.data.links[7].url,new URL(exact).href);assert.equal('share_token' in saved.data,false);
  const tooMany=await request('/me/member-card-share',owner,shareBody({links:[...links,link('多一個','https://example.com/extra')]}),saved.data.aggregate_version);
  assert.equal(tooMany.status,422);assert.match(tooMany.data.detail,/名片連結最多 8 個/);
  const kept=await request('/me/member-card-share',owner);assert.equal(kept.data.aggregate_version,saved.data.aggregate_version);assert.equal(kept.data.links.length,8);assert.equal(kept.data.headline,'做開源的人');
  const partial=await request('/me/member-card-share',owner,{enabled:true,include_avatar:false},saved.data.aggregate_version);
  assert.equal(partial.status,200,partial.data.detail);assert.equal(partial.data.design,'workshop');assert.equal(partial.data.headline,'做開源的人');assert.deepEqual(partial.data.links,saved.data.links);assert.equal(partial.data.include_avatar,false);assert.equal(partial.data.share_path,saved.data.share_path);
  const stale=await request('/me/member-card-share',owner,{enabled:true,include_avatar:false,headline:'不該寫入'},saved.data.aggregate_version);
  assert.equal(stale.status,412);assert.equal((await request('/me/member-card-share',owner)).data.headline,'做開源的人');
  const token=partial.data.share_path.split('/').at(-1),shared=await request('/public/member-cards/'+token);
  assert.equal(shared.status,200);assert.equal(shared.data.design,'workshop');assert.equal(shared.data.headline,'做開源的人');assert.deepEqual(shared.data.links,saved.data.links);
  assert.equal((await request('/me/member-card-share',owner,{enabled:false,include_avatar:false},partial.data.aggregate_version)).status,200);
  assert.equal((await request('/public/member-cards/'+token)).status,404);
  const journal=await pool.query("SELECT data::text AS data FROM transition_journal WHERE aggregate_type='member_card_share' AND aggregate_id=$1",[owner.id]);
  assert.equal(journal.rows.some(row=>String(row.data).includes(token)),false);assert.ok(journal.rows.length>=3);
});

test('readPublicCards returns only current public cards from one read and rotates generation with the link',async()=>{
  const named=await member('有介紹'),plain=await member('只有公會'),disabled=await member('已關閉'),inactive=await member('已停用'),unfinished=await member('未完成',false),hidden=await member('驗證帳',true,`${randomUUID()}@example.invalid`);
  const long='專'.repeat(50),caps=[`${long}甲`,`${long}乙`,`${long}丙`];
  await pool.query(`INSERT INTO onboarding_assessments(assessment_id,community_id,user_id,assessment_version,assessment_sha256,state,published_profile) VALUES($1,$2,$3,'fixture',$4,'completed',$5)`,[randomUUID(),DEMO_COMMUNITY,plain.id,'0'.repeat(64),JSON.stringify({capabilities:[],custom_capabilities:caps,featured_capabilities:caps.map(value=>`custom:${value}`)})]);
  const opened=await request('/me/member-card-share',named,{enabled:true,include_avatar:false,design:'calm',headline:'做開源的人',links:[link('作品','https://example.com/a')]});
  assert.equal(opened.status,200,opened.data.detail);
  assert.equal((await request('/me/member-card-share',plain,{enabled:true,include_avatar:false})).status,200);
  const closed=await request('/me/member-card-share',disabled,{enabled:true,include_avatar:false});assert.equal((await request('/me/member-card-share',disabled,{enabled:false,include_avatar:false},closed.data.aggregate_version)).status,200);
  const paused=await request('/me/member-card-share',inactive,{enabled:true,include_avatar:false});assert.equal(paused.status,200);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[inactive.id]);
  for(const session of [unfinished,hidden])await pool.query('INSERT INTO member_card_shares(user_id,community_id,share_token,enabled,include_avatar) VALUES($1,$2,$3,true,false)',[session.id,DEMO_COMMUNITY,randomBytes(32).toString('base64url')]);
  const ids=[named.id,plain.id,disabled.id,inactive.id,unfinished.id,hidden.id,randomUUID(),named.id.toUpperCase()];
  const before=await stamp(),queries:string[]=[];
  const original=pool.query.bind(pool);
  (pool as unknown as {query:(text:unknown,values?:unknown)=>Promise<unknown>}).query=async(text,values)=>{queries.push(typeof text==='string'?text:String((text as {text?:string})?.text??''));return original(text as never,values as never);};
  let cards=new Map<string,{path:string;title:string;summary:string;image:null;generation:string}>();
  try{cards=await readPublicCards(pool,DEMO_COMMUNITY,ids);}finally{(pool as unknown as {query:typeof original}).query=original;}
  assert.equal(queries.length,1);assert.match(queries[0],/^SELECT/i);assert.doesNotMatch(queries[0],/\b(INSERT|UPDATE|DELETE|FOR UPDATE|LOCK)\b/i);
  assert.deepEqual(await stamp(),before);
  assert.deepEqual([...cards.keys()].sort(),[named.id,plain.id].sort());
  const namedCard=cards.get(named.id)!;assert.equal(namedCard.title,'有介紹 的自由工坊名片');assert.equal(namedCard.summary,'做開源的人');assert.equal(namedCard.image,null);assert.equal(namedCard.generation,generationOf(namedCard.path));assert.match(namedCard.path,/^\/member-cards\/[A-Za-z0-9_-]{43}$/);
  const plainCard=cards.get(plain.id)!;assert.equal(plainCard.summary.startsWith('AI 開發公會・'),true);assert.equal([...plainCard.summary].length<=120,true);assert.equal(plainCard.summary.endsWith('・'),false);
  assert.equal((await readPublicCards(pool,'20000000-0000-4000-8000-000000000099',[named.id])).size,0);
  const seen:string[]=[];
  const wrapped=pool.query.bind(pool);(pool as unknown as {query:(text:unknown,values?:unknown)=>Promise<unknown>}).query=async(text,values)=>{seen.push(typeof text==='string'?text:'');return wrapped(text as never,values as never);};
  try{assert.equal((await readPublicCards(pool,DEMO_COMMUNITY,[])).size,0);assert.equal((await readPublicCards(pool,'not-a-community',[named.id])).size,0);}finally{(pool as unknown as {query:typeof wrapped}).query=wrapped;}
  assert.equal(seen.length,0);
  const designed=await request('/me/member-card-share',named,{enabled:true,include_avatar:false,design:'night'},opened.data.aggregate_version);
  assert.equal(designed.status,200);assert.equal(designed.data.share_path,opened.data.share_path);
  const same=(await readPublicCards(pool,DEMO_COMMUNITY,[named.id])).get(named.id)!;assert.equal(same.generation,namedCard.generation);assert.equal(same.path,namedCard.path);
  const rotated=await request('/me/member-card-share',named,{enabled:true,include_avatar:false,rotate:true},designed.data.aggregate_version);
  const next=(await readPublicCards(pool,DEMO_COMMUNITY,[named.id])).get(named.id)!;assert.notEqual(next.generation,namedCard.generation);assert.equal(next.generation,generationOf(next.path));
  assert.equal((await request('/me/member-card-share',named,{enabled:false,include_avatar:false},rotated.data.aggregate_version)).status,200);
  const reopened=await request('/me/member-card-share',named,{enabled:true,include_avatar:false},rotated.data.aggregate_version+1);
  const renewed=(await readPublicCards(pool,DEMO_COMMUNITY,[named.id])).get(named.id)!;assert.notEqual(renewed.generation,next.generation);
});
