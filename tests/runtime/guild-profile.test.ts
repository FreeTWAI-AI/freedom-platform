import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {communityCatalog} from '../../modules/community/catalog.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_guild_profile_${process.pid}_${Date.now()}`,database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const issuer='https://test-team.cloudflareaccess.com',audience='guild-profile-tests',email='admin@example.invalid',adminId=randomUUID(),pair=await generateKeyPair('RS256');
const jwk=await exportJWK(pair.publicKey),verifier=createAdminAccessVerifier({issuer,audience,csrfSecret:'test-fixture-admin-csrf-secret-123456789',keySet:createLocalJWKSet({keys:[{...jwk,kid:'admin-test',alg:'RS256'}]})});
let app=createApp(pool,origin,'local',{adminVerifier:verifier}),jwt='',csrf='';
const book=communityCatalog.skill_books[0].id;
const approval={decision:'approve' as const,reason:'已確認公會目標與第一步。',guild:{name:'研究與協作公會',purpose:'整理公開研究的方法與範例。',first_step:'提出第一份可以共同重現的研究。',module_key:'guilds',skill_book_ids:[book]}};
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');
  await pool.query("DELETE FROM positioning_guild_catalog WHERE guild_key LIKE 'guild_custom_%'");
  await pool.query("UPDATE positioning_guild_catalog SET alias='',profession_title='',catalog_version=1 WHERE guild_key NOT LIKE 'guild_custom_%'");
  await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,email,'Verified Admin']);
  app=createApp(pool,origin,'local',{adminVerifier:verifier});
  jwt=await sign(email);csrf=(await verifier(new Request(origin,{headers:{'Cf-Access-Jwt-Assertion':jwt}}))).csrfToken;
});
async function sign(claimedEmail:string){const now=Math.floor(Date.now()/1000);return new SignJWT({type:'app',email:claimedEmail,sub:'verified-human-fixture',iss:issuer,aud:audience,iat:now,nbf:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:'admin-test'}).sign(pair.privateKey);}
async function request(path:string,body?:unknown,version?:number,key:string=randomUUID()){
  const headers:Record<string,string>={Origin:origin,'Cf-Access-Jwt-Assertion':jwt,'X-Admin-CSRF':csrf};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version!==undefined)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/admin/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function member(path:string,cookie='',body?:unknown,memberCsrf=''){
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':memberCsrf,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function login(){const result=await member('/auth/login','',{email:DEMO_USERS[0].email,password:DEMO_PASSWORD});assert.equal(result.status,200);return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token};}
async function application(name='研究與協作公會',user=DEMO_USERS[0].user_id){const id=randomUUID();await pool.query('INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,DEMO_COMMUNITY,user,name,'研究','把共同研究的方法整理清楚。']);return id;}
async function catalog(key:string){return (await pool.query('SELECT name,alias,profession_title,catalog_version FROM positioning_guild_catalog WHERE guild_key=$1',[key])).rows[0];}
async function customCount(){return (await pool.query("SELECT count(*)::int AS n FROM positioning_guild_catalog WHERE guild_key LIKE 'guild_custom_%'")).rows[0].n as number;}
async function notice(user=DEMO_USERS[0].user_id){return (await pool.query('SELECT kind,title,body,action_tab,action_resource_id,source_key FROM member_notifications WHERE recipient_ref=$1 ORDER BY created_at,notification_id',[user])).rows;}
const check=(sql:string,params:unknown[]=[])=>assert.rejects(pool.query(sql,params),(error:any)=>error.code==='23514');

test('guild alias and profession title default to empty and reject unsafe catalog text',async()=>{
  const seeded=await catalog('guild_ai_field');
  assert.deepEqual([seeded.alias,seeded.profession_title,seeded.catalog_version],['','',1]);
  const line=await pool.query(`SELECT guild_catalog_line_ok('',100) AS empty,guild_catalog_line_ok('別名',100) AS ok,guild_catalog_line_ok(' x',100) AS pad,
    guild_catalog_line_ok(chr(10),100) AS nl,guild_catalog_line_ok(chr(9),100) AS tab,guild_catalog_line_ok(chr(127),100) AS del,
    guild_catalog_line_ok(repeat('字',100),100) AS max_ok,guild_catalog_line_ok(repeat('字',101),100) AS too_long`);
  assert.deepEqual(line.rows[0],{empty:true,ok:true,pad:false,nl:false,tab:false,del:false,max_ok:true,too_long:false});
  for(const value of [' padded ',' x ', '\n', '\t', '\x7f', '字'.repeat(101)]) await check('UPDATE positioning_guild_catalog SET alias=$1 WHERE guild_key=$2',[value,'guild_marketing']);
  await check('UPDATE positioning_guild_catalog SET profession_title=$1 WHERE guild_key=$2',['探索者','guild_marketing']);
  await check('UPDATE positioning_guild_catalog SET profession_title=$1 WHERE guild_key=$2',['稱'.repeat(41),'guild_marketing']);
  const key='guild_custom_'+randomUUID().replaceAll('-','');
  await pool.query('INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key) VALUES($1,$2,$3,$4,$5,$6)',[key,'custom_'+key.slice('guild_custom_'.length),'檢查用公會','整理一個可以檢查的公會說明。','先完成一件可以核對的小事。','guilds']);
  const inserted=await catalog(key);assert.deepEqual([inserted.alias,inserted.profession_title],['','']);
  await pool.query('UPDATE positioning_guild_catalog SET profession_title=$2,alias=$3 WHERE guild_key=$1',[key,'場域驗證者','檢查別名']);
  assert.equal((await catalog(key)).profession_title,'場域驗證者');
  assert.equal((await catalog(key)).alias,'檢查別名');
  for(const value of [' 稱號 ', '\n', '稱'.repeat(41)]) await check('UPDATE positioning_guild_catalog SET profession_title=$1 WHERE guild_key=$2',[value,key]);
  assert.equal((await catalog('guild_marketing')).alias,'');
});

test('an admin can edit a guild profile with version, uniqueness and alias rules',async()=>{
  const builtin='/guilds/guild_marketing/profile',reason='調整公會對外名稱。';
  assert.equal((await request(builtin,{alias:'行銷小名',reason})).status,428);
  assert.equal((await request(builtin,{alias:'行銷小名',name:'另一個行銷公會',reason},1)).data.code,'guild_builtin_locked');
  assert.equal((await request(builtin,{alias:'行銷小名',profession_title:'行銷者',reason},1)).data.code,'guild_builtin_locked');
  assert.equal((await request(builtin,{alias:'',name:'成長與行銷公會',profession_title:'',reason},1)).data.code,'guild_profile_unchanged');
  assert.equal((await catalog('guild_marketing')).catalog_version,1);
  const key=randomUUID();
  const saved=await request(builtin,{alias:'行銷小名',name:'成長與行銷公會',profession_title:'',reason},1,key);
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.alias,'行銷小名');assert.equal(saved.data.profession_title,'');assert.equal(saved.data.catalog_version,2);assert.equal(saved.data.aggregate_version,2);assert.equal(saved.response.headers.get('etag'),'"2"');
  assert.deepEqual((await request(builtin,{alias:'行銷小名',name:'成長與行銷公會',profession_title:'',reason},1,key)).data,saved.data);
  assert.equal((await request(builtin,{alias:'另一個別名',reason},2,key)).status,409);
  assert.equal((await catalog('guild_marketing')).catalog_version,2);
  assert.equal((await request(builtin,{alias:'過期別名',reason},1)).status,412);
  const cleared=await request(builtin,{alias:'',reason:'清掉暫時別名。'},2);
  assert.equal(cleared.status,200,JSON.stringify(cleared.data));assert.equal(cleared.data.alias,'');assert.equal(cleared.data.catalog_version,3);
  const audits=(await pool.query("SELECT before_state,after_state,reason FROM platform_admin_audit WHERE action='guild_profile_update' ORDER BY created_at")).rows;
  assert.equal(audits.length,2);
  assert.deepEqual(audits[0].before_state,{name:'成長與行銷公會',alias:'',profession_title:'',catalog_version:1});
  assert.deepEqual(audits[0].after_state,{name:'成長與行銷公會',alias:'行銷小名',profession_title:'',catalog_version:2});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM member_notifications WHERE kind='guild_profile_update'")).rows[0].n,0);

  const id=await application(),approved=await request(`/guild-applications/${id}/review`,approval,1);
  assert.equal(approved.status,200,JSON.stringify(approved.data));
  const custom=approved.data.approved_guild_key as string,profile=`/guilds/${custom}/profile`;
  const renamed=await request(profile,{name:'協作研究方法公會',alias:'我不是MiniMax',profession_title:'研究協作者',reason:'改成對外使用的名稱。'},1);
  assert.equal(renamed.status,200,JSON.stringify(renamed.data));
  assert.deepEqual([renamed.data.name,renamed.data.alias,renamed.data.profession_title,renamed.data.catalog_version],['協作研究方法公會','我不是MiniMax','研究協作者',2]);
  assert.equal((await request(profile,{name:'成長與行銷公會',alias:'我不是MiniMax',profession_title:'研究協作者',reason:'這個名稱已經有人用了。'},2)).data.code,'guild_name_exists');
  assert.equal((await request(profile,{name:'ai 導入與驗證公會',alias:'我不是MiniMax',profession_title:'研究協作者',reason:'大小寫不同仍是同一個名稱。'},2)).data.code,'guild_name_exists');
  assert.equal((await request(profile,{name:'協作研究方法公會',alias:'協作研究方法公會',profession_title:'研究協作者',reason:'別名不該等於自己的名稱。'},2)).data.code,'guild_alias_conflict');
  assert.equal((await request(profile,{name:'協作研究方法公會',alias:'AI 導入與驗證公會',profession_title:'研究協作者',reason:'別名不該等於別的公會名稱。'},2)).data.code,'guild_alias_conflict');
  assert.equal((await catalog(custom)).catalog_version,2);
  const shared=await request(builtin,{alias:'共享別名',reason:'先放一個可以共用的別名。'},3);
  assert.equal(shared.status,200,JSON.stringify(shared.data));
  const copied=await request(profile,{name:'協作研究方法公會',alias:'共享別名',profession_title:'研究協作者',reason:'和其他公會使用相同別名。'},2);
  assert.equal(copied.status,200,JSON.stringify(copied.data));assert.equal(copied.data.alias,'共享別名');
  const titled=await request(profile,{name:'共享別名',alias:'另一個別名',profession_title:'研究協作者',reason:'名稱可以和其他公會的別名相同。'},3);
  assert.equal(titled.status,200,JSON.stringify(titled.data));assert.equal(titled.data.name,'共享別名');
  const session=await login();
  for(const path of ['/guilds','/guilds/directory']){
    const row=(await member(path,session.cookie)).data.items.find((item:any)=>item.guild_key===custom);
    assert.equal(row.alias,'另一個別名',path);assert.equal(row.profession_title,'研究協作者',path);assert.equal(row.catalog_version,4,path);
  }
  const adminRow=(await request('/guilds')).data.items.find((item:any)=>item.guild_key==='guild_marketing');
  assert.equal(adminRow.alias,'共享別名');assert.equal(adminRow.profession_title,'');assert.equal(adminRow.catalog_version,4);
  assert.equal((await request('/guilds/not-a-key/profile',{alias:'別名',reason},1)).status,422);
  assert.equal((await request('/guilds/guild_missing_catalog/profile',{alias:'別名',reason},1)).data.code,'guild_not_found');
  assert.equal((await request(profile,{name:'獨特別名甲',alias:'含有\n換行',profession_title:'研究協作者',reason:'單行檢查。'},3)).status,422);
});

test('merging an application attaches it to an existing guild and can set that guild alias',async()=>{
  const id=await application('我不是MiniMax'),target='guild_ai_field',path=`/guild-applications/${id}/review`;
  const pending=(await request('/guild-applications?state=all')).data.items.find((item:any)=>item.application_id===id);
  assert.equal(pending.approved_guild_name,null);assert.equal(pending.approved_guild_alias,null);
  for(const body of [
    {decision:'approve',reason:'缺少公會設定。',merge:{guild_key:target}},
    {decision:'merge',reason:'同時帶了兩種設定。',guild:approval.guild,merge:{guild_key:target,alias:'我不是MiniMax'}},
    {decision:'reject',reason:'拒絕不需要目標。',merge:{guild_key:target}},
    {decision:'merge',reason:'還沒有選擇公會。'},
    {decision:'reject',reason:'拒絕不需要新公會。',guild:approval.guild},
  ]) assert.equal((await request(path,body,1)).data.code,'review_details_required',JSON.stringify(body));
  assert.equal((await request(path,{decision:'merge',reason:'這個公會不存在。',merge:{guild_key:'guild_missing_catalog'}},1)).data.code,'guild_not_found');
  assert.equal((await request(path,{decision:'merge',reason:'別名和目標名稱相同。',merge:{guild_key:target,alias:'ai 導入與驗證公會'}},1)).data.code,'guild_alias_conflict');
  assert.equal((await pool.query('SELECT state FROM guild_creation_applications WHERE application_id=$1',[id])).rows[0].state,'pending');
  assert.equal(await customCount(),0);assert.equal((await catalog(target)).catalog_version,1);
  const merged=await request(path,{decision:'merge',reason:'併入既有的導入公會。',merge:{guild_key:target,alias:'我不是MiniMax'}},1);
  assert.equal(merged.status,200,JSON.stringify(merged.data));
  assert.equal(merged.data.state,'approved');assert.equal(merged.data.approved_guild_key,target);assert.equal(merged.data.aggregate_version,2);
  assert.equal(await customCount(),0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guild_skill_book_bindings WHERE guild_key=$1',[target])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM positioning_profession_memberships WHERE user_id=$1',[DEMO_USERS[0].user_id])).rows[0].n,0);
  assert.deepEqual(await catalog(target),{name:'AI 導入與驗證公會',alias:'我不是MiniMax',profession_title:'',catalog_version:2});
  const listed=(await request('/guild-applications?state=all')).data.items.find((item:any)=>item.application_id===id);
  assert.equal(listed.approved_guild_name,'AI 導入與驗證公會');assert.equal(listed.approved_guild_alias,'我不是MiniMax');
  const audit=(await pool.query("SELECT after_state FROM platform_admin_audit WHERE action='guild_application_review' AND target_ref=$1",[id])).rows[0].after_state;
  assert.equal(audit.decision,'merge');assert.equal(audit.guild_key,target);assert.equal(audit.alias_before,'');assert.equal(audit.alias_after,'我不是MiniMax');
  const notes=await notice();assert.equal(notes.length,1);
  assert.equal(notes[0].kind,'guild_application_approved');assert.equal(notes[0].title,'公會申請已併入既有公會');
  assert.equal(notes[0].action_tab,'guilds');assert.equal(notes[0].action_resource_id,target);assert.equal(notes[0].source_key,`guild-application/${id}/2`);
  assert.equal(notes[0].body,['你申請的「我不是MiniMax」已併入「AI 導入與驗證公會」。','「我不是MiniMax」成為這個公會的別名。','審查說明：併入既有的導入公會。'].join('\n'));
  assert.equal((await request(path,{decision:'reject',reason:'第二次審核。'},2)).data.code,'application_reviewed');
  const again=await application('另一個好玩的名字'),same=await request(`/guild-applications/${again}/review`,{decision:'merge',reason:'覆寫成相同別名。',merge:{guild_key:target,alias:'我不是MiniMax'}},1);
  assert.equal(same.status,200,JSON.stringify(same.data));assert.equal((await catalog(target)).catalog_version,3);
  assert.match((await notice())[1].body,/「我不是MiniMax」成為這個公會的別名。/);
  const quiet=await application('不改別名的申請'),untouched=await request(`/guild-applications/${quiet}/review`,{decision:'merge',reason:'只併入，不改別名。',merge:{guild_key:target}},1);
  assert.equal(untouched.status,200,JSON.stringify(untouched.data));
  const blank=await application('清空不動作'),kept=await request(`/guild-applications/${blank}/review`,{decision:'merge',reason:'空白別名不更動。',merge:{guild_key:target,alias:''}},1);
  assert.equal(kept.status,200,JSON.stringify(kept.data));
  assert.deepEqual(await catalog(target),{name:'AI 導入與驗證公會',alias:'我不是MiniMax',profession_title:'',catalog_version:3});
  const bodies=(await notice()).slice(2).map(row=>row.body);
  for(const body of bodies){assert.equal(body.includes('成為這個公會的別名'),false,body);assert.match(body,/已併入「AI 導入與驗證公會」。/);}
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM positioning_guild_catalog WHERE guild_key LIKE 'guild_custom_%'")).rows[0].n,0);
});

test('approval stores an optional alias and profession title and enforces the alias rule',async()=>{
  const own=await application('新研究公會');
  const conflict=await request(`/guild-applications/${own}/review`,{...approval,guild:{...approval.guild,name:'新研究公會',alias:'新研究公會',profession_title:'研究者'}},1);
  assert.equal(conflict.data.code,'guild_alias_conflict');assert.equal(await customCount(),0);
  assert.equal((await pool.query('SELECT state FROM guild_creation_applications WHERE application_id=$1',[own])).rows[0].state,'pending');
  const taken=await application('借用既有名稱');
  assert.equal((await request(`/guild-applications/${taken}/review`,{...approval,guild:{...approval.guild,name:'借用既有名稱',alias:'成長與行銷公會'}},1)).data.code,'guild_alias_conflict');
  const id=await application(),result=await request(`/guild-applications/${id}/review`,{...approval,guild:{...approval.guild,alias:'我不是MiniMax',profession_title:'研究協作者'}},1);
  assert.equal(result.status,200,JSON.stringify(result.data));
  const row=await catalog(result.data.approved_guild_key);
  assert.deepEqual([row.name,row.alias,row.profession_title,row.catalog_version],['研究與協作公會','我不是MiniMax','研究協作者',1]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guild_skill_book_bindings WHERE guild_key=$1',[result.data.approved_guild_key])).rows[0].n,1);
  const plain=await application('沒有別名的公會'),bare=await request(`/guild-applications/${plain}/review`,{...approval,guild:{...approval.guild,name:'沒有別名的公會'}},1);
  assert.equal(bare.status,200,JSON.stringify(bare.data));
  assert.equal((await catalog(bare.data.approved_guild_key)).alias,'');
  assert.equal((await catalog(bare.data.approved_guild_key)).profession_title,'');
  const note=(await notice()).find(row=>row.source_key===`guild-application/${id}/2`);
  assert.ok(note);assert.equal(note.kind,'guild_application_approved');assert.equal(note.title,'公會申請已核准');assert.match(note.body,/已核准成立/);
});

test('a custom profession title replaces 專業探索者 for that member and stays searchable',async()=>{
  async function person(name:string){const id=randomUUID();await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,true,false FROM users WHERE user_id=$6`,[id,DEMO_COMMUNITY,id+'@example.test',name,randomUUID(),DEMO_USERS[0].user_id]);return id;}
  async function primary(user:string,key:string){
    await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')",[randomUUID(),DEMO_COMMUNITY,user,key]);
    await pool.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)',[DEMO_COMMUNITY,user,key]);
  }
  async function addGuild(title:string,alias:string){
    const id=randomUUID().replaceAll('-',''),key='guild_custom_'+id;
    await pool.query('INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key,alias,profession_title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[key,'custom_'+id,`稱號公會${title||'空'}`, '提供一個稱號測試用的公會說明。','先完成一件和稱號有關的小事。','guilds',alias,title]);
    return key;
  }
  const titled=await person('稱號會員甲'),empty=await person('稱號會員乙'),builtin=await person('稱號會員丙');
  const titledKey=await addGuild('場域驗證者','敢於體驗'),emptyKey=await addGuild('','');
  await primary(titled,titledKey);await primary(empty,emptyKey);await primary(builtin,'guild_security');
  const session=await login();
  const card=async(id:string)=>(await member('/members/'+id,session.cookie)).data;
  const titledCard=await card(titled);
  assert.equal(titledCard.positioning_title,'場域驗證者');assert.equal(titledCard.primary_guild.alias,'敢於體驗');assert.equal(titledCard.primary_guild.name,'稱號公會場域驗證者');
  assert.equal((await card(empty)).positioning_title,'專業探索者');assert.equal((await card(empty)).primary_guild.alias,'');
  assert.equal((await card(builtin)).positioning_title,'資安實踐者');
  const directory=async(search:string)=>(await member('/members?'+new URLSearchParams({search}),session.cookie)).data;
  assert.deepEqual((await directory('場域驗證者')).items.map((item:any)=>item.user_id),[titled]);
  assert.deepEqual((await directory('專業探索者')).items.map((item:any)=>item.user_id),[empty]);
  assert.deepEqual((await directory('資安實踐者')).items.map((item:any)=>item.user_id),[builtin]);
});
