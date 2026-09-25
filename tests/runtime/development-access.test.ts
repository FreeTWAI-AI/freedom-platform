import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {tokenHash,type Actor} from '../../modules/identity-membership/service.js';
import {GitHubSocial} from '../../modules/github-social/service.js';
import {DevelopmentAccess,DEVELOPMENT_POLICY} from '../../modules/development-access/service.js';
import {changeGuildMembership} from '../../modules/positioning/service.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const schema=`fp_dev_access_${process.pid}_${Date.now()}`,admin=createPool(process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL);
const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,options:`-c search_path=${schema}`,max:12});
const origin='http://127.0.0.1:4310',config={clientId:'Iv1.synthetic',clientSecret:'synthetic-secret',tokenKey:randomBytes(32).toString('base64'),redirectUri:origin+'/github/callback',appId:'9',appSlug:'synthetic-app'};
let actor:Actor,social:GitHubSocial,service:DevelopmentAccess,calls:string[],state:{push:boolean;app:number;suspended:string|null;listed:boolean;status:number;source:number;installation:number},cookie:string;
const target='video-autopilot',working='https://github.com/contributor/video-autopilot-kit';
const proposal={title:'改善字幕測試',summary:'合成測試；未執行真實影音渲染。',pr_url:null};
const fetcher:typeof fetch=async(input,init={})=>{
 const url=String(input);calls.push(url);assert.equal(init.redirect,'manual');assert.notEqual(init.redirect,'error');
 if(state.status!==200)return Response.json({private:'must-not-leak'},{status:state.status});
 if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'ghu_synthetic',token_type:'bearer',scope:''});
 if(url==='https://api.github.com/user')return Response.json({id:42,login:'contributor'});
 if(url.startsWith('https://api.github.com/applications/'))return new Response(null,{status:204});
 if(url.startsWith('https://api.github.com/user/installations?'))return Response.json({installations:[{id:state.installation,app_id:state.app,account:{id:42},suspended_at:state.suspended,permissions:{metadata:'read'}}]});
 if(url.includes('/repositories?'))return Response.json({repositories:state.listed?[{id:200,full_name:'contributor/video-autopilot-kit',private:false,permissions:{push:state.push}},{id:201,full_name:'contributor/freedom-platform',private:false,permissions:{push:state.push}}]:[]});
 if(url.includes('/repos/')){
   const name=url.split('/repos/')[1],platform=name.endsWith('/freedom-platform'),own=name.startsWith('contributor/');
   return Response.json({id:own?(platform?201:200):(platform?101:100),full_name:name,private:false,archived:false,owner:{id:own?42:7},permissions:{push:state.push},...(own?{source:{id:platform?101:state.source}}:{})});
 }
 throw Error('Unexpected GitHub fixture');
};
const command=(body:unknown={},operation='development-test',key=randomUUID()):Command=>({actor,body,operation,key});
const code=(value:string)=>(error:any)=>{assert.equal(error.code,value);return true;};
async function member(community:string){
 const id=randomUUID(),raw=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('hex');
 const user=(await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic','unused',$4) RETURNING *`,[id,community,`${id}@example.invalid`,randomUUID()])).rows[0];
 await pool.query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '1 hour',NULL)",[tokenHash(raw),id,csrf]);
 return {actor:{...user,session_hash:tokenHash(raw),csrf_token:csrf} as Actor,raw};
}
async function join(guild='guild_ai_vibe'){const row=(await pool.query('SELECT aggregate_version FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[actor.user_id,guild])).rows[0];return changeGuildMembership(pool,{...command({},'join/'+guild),expected:row?.aggregate_version},guild,'join');}
async function leave(guild:string){const row=(await pool.query('SELECT aggregate_version FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[actor.user_id,guild])).rows[0];return changeGuildMembership(pool,{...command({},'leave/'+guild),expected:row.aggregate_version},guild,'leave');}
async function connect(){const pending=await social.start(actor,'#skills');await social.complete(actor,new URL(pending.authorization_url).searchParams.get('state')!,'synthetic-code');}
async function enable(capability:'skill'|'platform'='skill',id=target){
 await join(capability==='skill'?'guild_ai_vibe':'guild_platform_engineering');await connect();
 await service.consent(command({policy_version:DEVELOPMENT_POLICY,accepted:true},'consent/'+capability),capability,id);
 return service.activate(command({working_repository_url:capability==='skill'?working:'https://github.com/contributor/freedom-platform'},'activate/'+capability),capability,id);
}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
 await pool.query('TRUNCATE communities CASCADE');const community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Development test']);
 const value=await member(community);actor=value.actor;cookie=value.raw;calls=[];state={push:true,app:9,suspended:null,listed:true,status:200,source:100,installation:77};
 social=new GitHubSocial(pool,config,fetcher);service=new DevelopmentAccess(pool,social);
});

test('task readiness needs one applicable guild, verified identity, consent and an accessible original or fork',async()=>{
 let view=await service.status(actor,'skill',target);assert.equal(view.eligible,false);assert.equal(view.guilds.length,2);assert.equal(view.enabled,false);
 await assert.rejects(()=>service.activate(command({working_repository_url:working}),'skill',target),code('development_guild_required'));
 await join();await assert.rejects(()=>service.activate(command({working_repository_url:working}),'skill',target),code('development_consent_required'));
 await service.consent(command({policy_version:DEVELOPMENT_POLICY,accepted:true}),'skill',target);
 await assert.rejects(()=>service.activate(command({working_repository_url:working}),'skill',target),code('github_connect_required'));
 await connect();await service.activate(command({working_repository_url:working}),'skill',target);
 view=await service.status(actor,'skill',target);assert.equal(view.enabled,true);assert.equal(view.github?.id,'42');assert.deepEqual(view.grant?.guild_sources,['guild_ai_vibe']);
 assert.equal((await service.status(actor,'platform','skills')).eligible,false);
});

test('OR membership keeps the first grant, final departure revokes keys, and rejoining never revives old credentials or removes proposals',async()=>{
 await enable();await join('guild_ai_field');const key=await service.issueKey(command({},'issue'),'skill',target),bearer='Bearer '+key.token;
 const saved=await service.agent(bearer,proposal,'same-proposal-key');
 await leave('guild_ai_vibe');assert.deepEqual(await service.agent(bearer,proposal,'same-proposal-key'),JSON.parse(JSON.stringify(saved)));
 await leave('guild_ai_field');assert.ok((await pool.query('SELECT revoked_at FROM development_keys')).rows[0].revoked_at);
 await assert.rejects(()=>service.agent(bearer,proposal,'same-proposal-key'),code('development_key_revoked'));
 await join();await service.activate(command({working_repository_url:working},'new-activation'),'skill',target);
 await assert.rejects(()=>service.agent(bearer,proposal,'new-proposal-key'),code('development_key_revoked'));
 assert.equal((await service.status(actor,'skill',target)).proposals.length,1);
 assert.ok((await pool.query('SELECT count(*) FROM member_skill_book_grants')).rows[0].count>0);
});

test('capabilities, targets and owners stay isolated and key secrets never enter receipts or journals',async()=>{
 await enable();const input=command({},'issue'),key=await service.issueKey(input,'skill',target);
 assert.match(key.token!,/^fpd_/);assert.equal((await service.issueKey(input,'skill',target)).token,null);
 const raw=JSON.stringify((await pool.query('SELECT response FROM command_receipts')).rows)+JSON.stringify((await pool.query('SELECT data FROM transition_journal')).rows);
 assert.ok(!raw.includes(key.token!));assert.ok(!JSON.stringify((await pool.query('SELECT * FROM development_keys')).rows).includes(key.token!));
 const second=await member(actor.community_id);assert.equal((await service.status(second.actor,'skill',target)).proposals.length,0);
 await assert.rejects(()=>service.issueKey({...command({},'other'),actor:second.actor},'skill',target),code('development_guild_required'));
 await assert.rejects(()=>service.issueKey(command({},'platform'),'platform','skills'),code('development_guild_required'));
 await assert.rejects(()=>service.saveProposal(command({...proposal,pr_url:'https://github.com/another/repo/pull/1'}),'skill',target),code('development_pr_target'));
 assert.equal((await pool.query('SELECT count(*) FROM development_proposals')).rows[0].count,'0');
});

test('wrong App, suspended installation, excluded repository, unrelated fork and missing push access fail closed',async()=>{
 await join();await connect();await service.consent(command({policy_version:DEVELOPMENT_POLICY,accepted:true}),'skill',target);
 for(const patch of [{app:99},{suspended:'2026-09-24T00:00:00Z'},{listed:false},{source:999},{push:false}]){
   const saved={...state};Object.assign(state,patch);
   await assert.rejects(()=>service.activate(command({working_repository_url:working}),'skill',target));state=saved;
 }
 assert.equal((await pool.query('SELECT count(*) FROM development_grants')).rows[0].count,'0');
});

test('provider outage blocks replay without inventing revocation, confirmed permission loss permanently revokes',async()=>{
 await enable();const key=await service.issueKey(command({},'issue'),'skill',target),bearer='Bearer '+key.token;
 await service.agent(bearer,proposal,'retry-proposal-key');state.status=503;
 await assert.rejects(()=>service.agent(bearer,proposal,'retry-proposal-key'),code('github_unavailable'));
 assert.equal((await pool.query('SELECT revoked_at FROM development_grants')).rows[0].revoked_at,null);
 state.status=200;state.listed=false;
 await assert.rejects(()=>service.agent(bearer,proposal,'retry-proposal-key'),code('github_installation_repository_required'));
 state.listed=true;await assert.rejects(()=>service.agent(bearer,proposal,'retry-proposal-key'),code('development_key_revoked'));
});

test('disconnect, consent withdrawal and member disable revoke the grant and derived key in the same transaction',async()=>{
 for(const reason of ['consent','disconnect','disabled']){
   await enable();const key=await service.issueKey(command({},'issue/'+reason),'skill',target);
   if(reason==='consent')await service.consent(command({policy_version:DEVELOPMENT_POLICY,accepted:false},'withdraw'),'skill',target);
   if(reason==='disconnect')await social.disconnect(actor);
   if(reason==='disabled')await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actor.user_id]);
   assert.ok((await pool.query('SELECT revoked_at FROM development_keys WHERE key_id=$1',[key.key_id])).rows[0].revoked_at);
 }
});

test('concurrent issuance and departure share the guild lock and never leave a usable key after departure',async()=>{
 await enable();const results=await Promise.allSettled([service.issueKey(command({},'concurrent-key'),'skill',target),leave('guild_ai_vibe')]);
 assert.equal(results[1].status,'fulfilled');
 assert.equal((await pool.query('SELECT count(*) FROM development_keys WHERE revoked_at IS NULL')).rows[0].count,'0');
});

test('Agent HTTP accepts only its scoped bearer, rejects foreign Origin and cookie-only requests, and browser endpoints retain CSRF',async()=>{
 await enable();const key=await service.issueKey(command({},'issue'),'skill',target),app=createApp(pool,origin,'local',{githubSocial:{config,fetcher}});
 const request=(headers:Record<string,string>,body:unknown=proposal)=>app.request(origin+'/development-agent/v1/proposals',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),...headers},body:JSON.stringify(body)});
 assert.equal((await request({Authorization:'Bearer '+key.token})).status,200);
 assert.equal((await request({Authorization:'Bearer '+key.token,Origin:'https://foreign.invalid'})).status,403);
 assert.equal((await request({Cookie:'freedom_local_session='+cookie})).status,401);
 const browserPath=origin+'/api/v1/me/development/skill/video-autopilot/keys';
 assert.equal((await app.request(browserPath,{method:'POST',headers:{Cookie:'freedom_local_session='+cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await request({Authorization:'Bearer fpk_'+randomBytes(32).toString('base64url')})).status,401);
 assert.equal((await app.request(origin+'/api/v1/me/development/skill/video-autopilot')).status,401);
 assert.equal((await request({Authorization:'Bearer '+key.token},{...proposal,target_key:'another'})).status,422);
});

test('losing skill eligibility preserves platform authority, while an old activation receipt cannot restore a revoked grant',async()=>{
 await join();await connect();await service.consent(command({policy_version:DEVELOPMENT_POLICY,accepted:true},'skill-consent'),'skill',target);
 const activation=command({working_repository_url:working},'activation-replay');await service.activate(activation,'skill',target);
 await join('guild_platform_engineering');await service.consent(command({policy_version:DEVELOPMENT_POLICY,accepted:true},'platform-consent'),'platform','skills');
 await service.activate(command({working_repository_url:'https://github.com/contributor/freedom-platform'},'platform-activate'),'platform','skills');
 const platformKey=await service.issueKey(command({},'platform-key'),'platform','skills');
 await leave('guild_ai_vibe');assert.equal((await service.status(actor,'platform','skills')).enabled,true);
 await service.agent('Bearer '+platformKey.token,proposal,'platform-proposal');
 await join();await assert.rejects(()=>service.activate(activation,'skill',target),code('development_grant_required'));
});

test('expired, owner-revoked and installation-replaced keys cannot write, including receipt replays',async()=>{
 await enable();let key=await service.issueKey(command({},'first-key'),'skill',target);
 await service.agent('Bearer '+key.token,proposal,'expiry-proposal');
 await pool.query("UPDATE development_keys SET expires_at=now()-interval '1 minute' WHERE key_id=$1",[key.key_id]);
 await assert.rejects(()=>service.agent('Bearer '+key.token,proposal,'expiry-proposal'),code('development_key_revoked'));
 key=await service.issueKey(command({},'second-key'),'skill',target);await service.revoke(command({key_id:key.key_id},'revoke-key'),'skill',target);
 await assert.rejects(()=>service.agent('Bearer '+key.token,proposal,'revoked-proposal'),code('development_key_revoked'));
 key=await service.issueKey(command({},'third-key'),'skill',target);state.installation=78;
 await assert.rejects(()=>service.agent('Bearer '+key.token,proposal,'changed-installation'),code('development_binding_changed'));
 state.installation=77;await assert.rejects(()=>service.agent('Bearer '+key.token,proposal,'changed-installation'),code('development_key_revoked'));
});
