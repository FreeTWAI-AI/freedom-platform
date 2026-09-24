import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,type Command} from '../../packages/db/index.js';
import {Problem} from '../../packages/shared/problem.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import {createSquad,changeSquadMembership} from '../../modules/identity-membership/members.js';
import {changeGuildMembership} from '../../modules/positioning/service.js';
import {reviewGuildApplication,type AdminActor} from '../../modules/platform-admin/service.js';
import {sendDirectMessage} from '../../modules/member-communications/service.js';
import {listChannels,channelMessages,sendChannelMessage,markChannelRead} from '../../modules/member-communications/channels.js';
import {CHANNEL_NOT_AVAILABLE,type ChannelKind} from '../../modules/member-communications/channel-types.js';

// Group channels (037): every ordinary active guild/squad member, isolated per
// community+kind+key, never the leader-only guild council. All actors are
// unique synthetic members logged in for real; no demo friendship or squad.
const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_member_channels_${process.pid}_${Date.now()}`,database=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:16});
// Named pools let race tests wait for a specific backend on a specific lock; statement_timeout keeps a regression from hanging.
const racer=(role:string)=>new Pool({connectionString:databaseUrl,options:`-c search_path=${schema} -c statement_timeout=20000`,application_name:`${schema}_${role}`,max:2});
const app=createApp(pool,origin,'local');
const guild='guild_event_space',otherGuild='guild_projection_mapping',thirdGuild='guild_ai_field';
const admin:AdminActor={admin_id:randomUUID(),community_id:DEMO_COMMUNITY,email:'channel-admin@example.invalid',display_name:'頻道測試管理者',role:'super_admin',subject:'verified-test'};
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
  await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[admin.admin_id,DEMO_COMMUNITY,admin.email,admin.display_name]);});

type Member={id:string;email:string;actor:Actor;http:{cookie:string;csrf:string}};
/** Synthetic member reusing the seeded demo password hash; completed onboarding unless `legacy` (onboarding_required=false, never completed). */
async function member(label:string,{community=DEMO_COMMUNITY,legacy=false}:{community?:string;legacy?:boolean}={}):Promise<Member>{
  const id=randomUUID(),email=`channel-${label}-${id.slice(0,8)}@example.invalid`;
  if(community!==DEMO_COMMUNITY)await pool.query('INSERT INTO communities VALUES($1,$2) ON CONFLICT DO NOTHING',[community,'合成的其他社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required,onboarding_completed_at)
    SELECT $1,$2,$3,$4,password_hash,$5,$6,$7 FROM users WHERE user_id=$8`,[id,community,email,`頻道成員${label}`,randomUUID(),!legacy,legacy?null:new Date(),DEMO_USERS[0].user_id]);
  return {id,email,...await session(email)};
}
async function session(email:string){const auth=await login(pool,email,DEMO_PASSWORD);return {actor:auth.actor,http:{cookie:`freedom_local_session=${auth.token}`,csrf:auth.actor.csrf_token}};}
const cmd=(actor:Actor,body:unknown={},operation='test-channel',key:string=randomUUID(),expected?:string):Command=>({actor,body,operation,key,expected});
/** A real custom guild: an application of this community approved through the admin service (catalog + approval). */
async function approvedGuild(founder:Member,name:string){
  const application=randomUUID();
  await pool.query('INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason) VALUES($1,$2,$3,$4,$5,$6)',[application,DEMO_COMMUNITY,founder.id,name,'研究','整理共同研究的方法。']);
  const approved=await reviewGuildApplication(pool,{admin,body:{decision:'approve',reason:'合成核准',guild:{name,purpose:'合成的公會用途說明',first_step:'先讀共同研究筆記',module_key:'guilds',skill_book_ids:['event-space']}},key:randomUUID(),operation:'test-approve',expected:'1'},application);
  return approved.approved_guild_key as string;
}

// ---------- membership through the existing product commands ----------
async function changeGuild(m:Member,key:string,action:'join'|'leave',on=pool){
  const row=(await pool.query('SELECT aggregate_version FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',[m.actor.community_id,m.id,key])).rows[0];
  return changeGuildMembership(on,cmd(m.actor,{},`${action}/${key}`,randomUUID(),row?String(row.aggregate_version):undefined),key,action);
}
const squadVersion=async(squad:string,user:string)=>(await pool.query('SELECT aggregate_version FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2',[squad,user])).rows[0]?.aggregate_version as string|undefined;
async function newSquad(owner:Member,name='頻道測試小隊'){return (await createSquad(pool,cmd(owner.actor,{name,kind:'project',purpose:'合成的小隊協作。'},'squad-create'))).squad_id as string;}
async function requestSquad(squad:string,m:Member){const v=await squadVersion(squad,m.id);return changeSquadMembership(pool,cmd(m.actor,{},'squad-request',randomUUID(),v?String(v):undefined),squad,'request');}
async function joinSquad(squad:string,m:Member,owner:Member){await requestSquad(squad,m);await changeSquadMembership(pool,cmd(owner.actor,{},'squad-accept',randomUUID(),String(await squadVersion(squad,m.id))),squad,'accept',m.id);}
/** Upper-case id on purpose: leave and channel access must normalize to the same squad-membership lock. */
async function leaveSquad(squad:string,m:Member,on=pool){return changeSquadMembership(on,cmd(m.actor,{},'squad-leave',randomUUID(),String(await squadVersion(squad,m.id))),squad.toUpperCase(),'leave');}

// ---------- channel calls ----------
const send=(m:Member,kind:ChannelKind,key:string,body:string,opKey=randomUUID(),on=pool)=>sendChannelMessage(on,cmd(m.actor,{body},`channel-send/${kind}/${key}`,opKey),kind,key);
const markRead=(m:Member,kind:ChannelKind,key:string,through:string,opKey=randomUUID(),on=pool)=>markChannelRead(on,cmd(m.actor,{through_message_id:through},`channel-read/${kind}/${key}`,opKey),kind,key);
const page=(m:Member,kind:ChannelKind,key:string,query:Record<string,unknown>={},on=pool)=>channelMessages(on,m.actor,kind,key,query);
const list=(m:Member,kind:ChannelKind,query:Record<string,unknown>={})=>listChannels(pool,m.actor,{kind,...query});
async function request(path:string,m?:Member,body?:unknown,options:{key?:string;csrf?:string}={}){
  const headers:Record<string,string>={Origin:origin,...(m?{Cookie:m.http.cookie,'X-CSRF-Token':options.csrf??m.http.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';if(options.key!=='')headers['Idempotency-Key']=options.key??randomUUID();}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any};
}
const count=async(sql:string,values:unknown[]=[])=>(await pool.query(`SELECT count(*)::int AS n FROM ${sql}`,values)).rows[0].n as number;
const cursor=async(m:Member,kind:ChannelKind,key:string)=>(await pool.query('SELECT last_read_sequence::text AS s FROM member_channel_reads WHERE community_id=$1 AND kind=$2 AND channel_key=$3 AND user_id=$4',[m.actor.community_id,kind,key,m.id])).rows[0]?.s as string|undefined;
const noPrivate=(data:unknown)=>{const text=JSON.stringify(data);for(const needle of ['@example.invalid','@local.test','email','password','csrf','token','session'])assert.ok(!text.includes(needle),`leaked ${needle}: ${text}`);};
async function rejectsWith(run:()=>Promise<unknown>,status:number,code:string,label:string){
  let resolved=false;
  try{await run();resolved=true;}
  catch(error){assert.ok(error instanceof Problem,`${label}: expected Problem, got ${(error as any)?.code??error}`);assert.deepEqual([error.status,error.code],[status,code],label);}
  assert.ok(!resolved,`${label}: resolved (disclosed data) instead of ${status} ${code}`);
}
const gone=(run:()=>Promise<unknown>,label:string)=>rejectsWith(run,404,CHANNEL_NOT_AVAILABLE,label);
/** A well-formed through_message_id that is not a message of this channel is exactly 404 channel_message_not_found. */
const badThrough=(run:()=>Promise<unknown>,label:string)=>rejectsWith(run,404,'channel_message_not_found',label);
/** Deterministic barrier: resolves once the racer backend is blocked on one of the given lock wait events. */
async function waitingOn(role:string,events:string|string[]){
  const name=`${schema}_${role}`,wanted=[events].flat();
  for(let i=0;i<4000;i++){if((await database.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event=ANY($2)",[name,wanted])).rowCount)return;await new Promise(resolve=>setImmediate(resolve));}
  throw Error(`${role} never waited on ${wanted.join('|')}`);
}
const pidOf=async(role:string)=>(await database.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state<>'idle'",[`${schema}_${role}`])).rows[0].pid as number;
const blockers=async(pid:number)=>(await database.query('SELECT pg_blocking_pids($1) AS pids',[pid])).rows[0].pids as number[];
function rejected(result:PromiseSettledResult<unknown>,status:number,code:string,label:string){
  assert.equal(result.status,'rejected',`${label}: returned data`);const error=(result as PromiseRejectedResult).reason;
  assert.ok(error instanceof Problem,`${label}: raw ${error?.code??error} escaped`);assert.deepEqual([error.status,error.code],[status,code],label);
}

test('ordinary guild and squad members (no officer row) read and write their own rooms; kinds and rooms stay isolated; empty GET writes nothing',async()=>{
  const owner=await member('owner'),mate=await member('mate'),other=await member('other'),pending=await member('pending'),outsider=await member('outsider');
  await changeGuild(owner,guild,'join');await changeGuild(mate,guild,'join');await changeGuild(other,otherGuild,'join');
  const squad=await newSquad(owner,'閒聊小隊');await joinSquad(squad,mate,owner);await requestSquad(squad,pending);
  assert.equal(await count('positioning_guild_officers WHERE user_id=ANY($1)',[[owner.id,mate.id]]),0,'no officer authority involved');
  // Listing and reading empty rooms derives them from memberships without any write.
  const guilds=await list(mate,'guild'),squads=await list(mate,'squad');
  assert.deepEqual(guilds,{items:[{kind:'guild',channel_key:guild,name:'活動與空間公會',unread_count:0,last_message_at:null}],unread_count:0,next_offset:null});
  assert.deepEqual(squads,{items:[{kind:'squad',channel_key:squad,name:'閒聊小隊',unread_count:0,last_message_at:null}],unread_count:0,next_offset:null});
  const empty=await page(mate,'guild',guild);assert.deepEqual(empty,{channel:{kind:'guild',channel_key:guild,name:'活動與空間公會'},items:[],unread_count:0,next_offset:null});
  assert.deepEqual((await page(mate,'squad',squad)).items,[]);
  assert.equal(await count('member_chat_channels'),0,'empty GET creates no channel row');assert.equal(await count('member_channel_reads'),0);
  // Ordinary members write; each message lands only in its own kind/room.
  const inGuild=await send(mate,'guild',guild,'公會閒聊 marker-guild'),inSquad=await send(owner,'squad',squad,'小隊閒聊 marker-squad');
  assert.deepEqual([inGuild.kind,inGuild.channel_key,inSquad.kind,inSquad.channel_key],['guild',guild,'squad',squad]);
  const guildPage=await page(owner,'guild',guild),squadPage=await page(mate,'squad',squad);
  assert.deepEqual(guildPage.items.map(m=>m.body),['公會閒聊 marker-guild']);assert.deepEqual(squadPage.items.map(m=>m.body),['小隊閒聊 marker-squad']);
  assert.equal(guildPage.items[0].sender_ref,mate.id);assert.equal(guildPage.items[0].sender_name,'頻道成員mate');
  noPrivate([guilds,squads,guildPage,squadPage,await list(owner,'guild'),await list(owner,'squad')]);
  // Not a member, a pending squad requester, a different guild, and a squad key under the guild kind: all indistinguishable 404 with no text.
  for(const [who,kind,key,label] of [[other,'guild',guild,'other guild member'],[outsider,'squad',squad,'non member'],[pending,'squad',squad,'pending requester'],[outsider,'guild',guild,'no guild']] as const){
    await gone(()=>page(who,kind,key),`${label} GET`);await gone(()=>send(who,kind,key,'越權'),`${label} send`);
    await gone(()=>markRead(who,kind,key,kind==='guild'?inGuild.message_id:inSquad.message_id),`${label} read`);
    const listed=await list(who,kind);assert.ok(!listed.items.some(item=>item.channel_key===key),label);assert.equal(listed.unread_count,0,`${label} unread`);
  }
  const http=await request(`/me/channels/guild/${guild}/messages`,other);assert.equal(http.status,404);assert.equal(http.data.code,CHANNEL_NOT_AVAILABLE);assert.ok(!JSON.stringify(http.data).includes('marker'));
  assert.notEqual((await request(`/me/channels/guild/${squad}/messages`,owner)).status,200,'a squad key is not a guild room');
  assert.notEqual((await request(`/me/channels/squad/${guild}/messages`,owner)).status,200,'a guild key is not a squad room');
  assert.equal(await count('member_channel_messages'),2);
});

test('every active guild and squad is listed with totals across pages; left guilds and pending squads are not',async()=>{
  const m=await member('many'),peer=await member('peer');
  for(const key of [guild,otherGuild,thirdGuild]){await changeGuild(m,key,'join');await changeGuild(peer,key,'join');}
  const own=await newSquad(m,'自己的小隊'),joined=await newSquad(peer,'加入的小隊'),waiting=await newSquad(peer,'申請中小隊');
  await joinSquad(joined,m,peer);await requestSquad(waiting,m);
  await send(peer,'guild',guild,'g1');await send(peer,'guild',otherGuild,'g2');await send(peer,'guild',otherGuild,'g3');await send(peer,'squad',joined,'s1');
  const first=await list(m,'guild',{limit:2}),second=await list(m,'guild',{limit:2,offset:2});
  assert.equal(first.next_offset,2);assert.equal(second.next_offset,null);assert.equal(first.unread_count,3);assert.equal(second.unread_count,3);
  assert.deepEqual([...first.items,...second.items].map(i=>i.channel_key).sort(),[guild,otherGuild,thirdGuild].sort());
  assert.deepEqual(Object.fromEntries([...first.items,...second.items].map(i=>[i.channel_key,i.unread_count])),{[guild]:1,[otherGuild]:2,[thirdGuild]:0});
  const squads=await list(m,'squad');assert.deepEqual(squads.items.map(i=>i.channel_key).sort(),[own,joined].sort());assert.equal(squads.unread_count,1);
  assert.deepEqual(Object.keys(squads.items[0]).sort(),['channel_key','kind','last_message_at','name','unread_count']);
  // Leaving drops the room and its unread from the kind total.
  await changeGuild(m,otherGuild,'leave');const after=await list(m,'guild');
  assert.deepEqual(after.items.map(i=>i.channel_key).sort(),[guild,thirdGuild].sort());assert.equal(after.unread_count,1);
  const http=await request('/me/channels?kind=guild',m);assert.equal(http.status,200);assert.equal(http.data.unread_count,1);
  for(const query of ['kind=council','','kind=guild&limit=0','kind=guild&limit=51','kind=guild&offset=-1','kind=guild&extra=1'])assert.equal((await request(`/me/channels?${query}`,m)).status,422,query);
});

test('custom guild rooms need an approved application in the actor community; a foreign same-key membership stays 404',async()=>{
  const founder=await member('founder'),joiner=await member('joiner');
  const custom=await approvedGuild(founder,'頻道研究公會');assert.match(custom,/^guild_custom_[0-9a-f]{32}$/);
  await changeGuild(founder,custom,'join');await changeGuild(joiner,custom,'join');
  const sent=await send(joiner,'guild',custom,'自訂公會閒聊');
  assert.deepEqual((await list(founder,'guild')).items.map(i=>[i.channel_key,i.name,i.unread_count]),[[custom,'頻道研究公會',1]]);
  assert.deepEqual((await page(founder,'guild',custom)).items.map(m=>m.message_id),[sent.message_id]);
  // A catalog row without an approved application of this community grants nothing, even with an active membership.
  const unapproved='guild_custom_'+randomUUID().replaceAll('-','');
  await pool.query("INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key) VALUES($1,$2,'未核准公會','合成未核准用途','合成第一步','guilds')",[unapproved,'custom_'+unapproved.slice(13)]);
  await changeGuild(founder,unapproved,'join');
  await gone(()=>page(founder,'guild',unapproved),'catalog-only GET');await gone(()=>send(founder,'guild',unapproved,'x'),'catalog-only send');
  assert.ok(!(await list(founder,'guild')).items.some(i=>i.channel_key===unapproved));
  // A valid session of another community with a forged same-key active membership row: 404, not 401, and nothing leaks.
  const foreign=await member('foreign',{community:randomUUID()});
  await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active')",[randomUUID(),foreign.actor.community_id,foreign.id,custom]);
  await gone(()=>page(foreign,'guild',custom),'foreign GET');await gone(()=>send(foreign,'guild',custom,'跨社群'),'foreign send');await gone(()=>markRead(foreign,'guild',custom,sent.message_id),'foreign read');
  assert.equal((await list(foreign,'guild')).items.length,0);
  const http=await request(`/me/channels/guild/${custom}/messages`,foreign);assert.equal(http.status,404);assert.ok(!JSON.stringify(http.data).includes('自訂公會閒聊'));
  // Our community's squad is equally unknown to a valid foreign session.
  const squad=await newSquad(founder);await gone(()=>page(foreign,'squad',squad),'foreign squad GET');
  assert.equal(await count('member_channel_messages'),1);assert.equal(await count('member_channel_reads WHERE user_id=$1',[foreign.id]),0);
});

test('messages: idempotent plain-text send, string sequences, newest-first pages, GET never marks read, own messages never unread',async()=>{
  const a=await member('a'),b=await member('b');await changeGuild(a,guild,'join');await changeGuild(b,guild,'join');
  const key=randomUUID(),text='  <img src=x onerror=alert(1)> **粗體**\r\n第二行  ';
  const first=await send(a,'guild',guild,text,key);
  assert.deepEqual(Object.keys(first).sort(),['body','channel_key','created_at','kind','message_id','sender_name','sender_ref','sequence']);
  assert.equal(first.body,'<img src=x onerror=alert(1)> **粗體**\n第二行');assert.equal(first.sequence,'1');assert.equal(first.sender_ref,a.id);
  assert.deepEqual(await send(a,'guild',guild,text,key),first,'same-key replay returns the one message');
  await assert.rejects(send(a,'guild',guild,'不同內容',key),(e:unknown)=>e instanceof Problem&&e.code==='idempotency_conflict');
  assert.equal(await count('member_channel_messages'),1);
  // HTTP: 201 with the same DTO, strict body, CSRF and Idempotency-Key.
  const path=`/me/channels/guild/${guild}/messages`,httpKey=randomUUID();
  const b1=await request(path,b,{body:'b1'},{key:httpKey});assert.equal(b1.status,201,JSON.stringify(b1.data));
  assert.deepEqual((await request(path,b,{body:'b1'},{key:httpKey})).data,b1.data);
  for(const body of [{body:''},{body:'  \n '},{body:'字'.repeat(2001)},{body:'a\u0000b'},{body:1},{},{body:'x',sequence:'9'},{body:'x',sender_ref:a.id}])assert.equal((await request(path,b,body)).status,422,JSON.stringify(body));
  assert.equal((await request(path,b,{body:'no csrf'},{csrf:'z'.repeat(43)})).data.code,'csrf_rejected');
  assert.equal((await request(path,b,{body:'no key'},{key:''})).data.code,'idempotency_required');
  assert.equal(await count('member_channel_messages'),2);
  const b2=await send(b,'guild',guild,'b2'),b3=await send(b,'guild',guild,'b3');
  const one=await page(a,'guild',guild,{limit:2}),two=await page(a,'guild',guild,{limit:2,offset:2});
  assert.deepEqual([...one.items,...two.items].map(m=>[m.body,m.sequence]),[['b3','4'],['b2','3'],['b1','2'],[first.body,'1']]);
  assert.equal(one.next_offset,2);assert.equal(two.next_offset,null);assert.equal(one.unread_count,3);assert.equal(two.unread_count,3,'own message excluded');
  assert.equal((await page(b,'guild',guild)).unread_count,1);
  assert.equal(await count('member_channel_reads'),0,'GET never marks read');assert.equal((await list(a,'guild')).unread_count,3);
  // Read cursor: explicit, monotonic max, per viewer.
  const r1=await markRead(a,'guild',guild,b1.data.message_id);assert.deepEqual(Object.keys(r1).sort(),['channel_key','kind','read_at','read_sequence']);assert.equal(r1.read_sequence,'2');
  assert.equal((await page(a,'guild',guild)).unread_count,2);
  assert.equal((await markRead(a,'guild',guild,b3.message_id)).read_sequence,'4');
  assert.equal((await markRead(a,'guild',guild,b2.message_id)).read_sequence,'4','an older message never moves the cursor back');
  assert.equal(await cursor(a,'guild',guild),'4');assert.equal((await list(a,'guild')).unread_count,0);assert.equal(await cursor(b,'guild',guild),undefined);
  // Concurrent old/new marks by one reader converge on the newest.
  await Promise.all([b1.data.message_id,b3.message_id,first.message_id,b3.message_id,b2.message_id].map(id=>markRead(b,'guild',guild,id)));
  assert.equal(await cursor(b,'guild',guild),'4');
  // Sequences stay exact past Number.MAX_SAFE_INTEGER.
  await pool.query("UPDATE member_chat_channels SET last_sequence=9007199254740993 WHERE community_id=$1 AND kind='guild' AND channel_key=$2",[DEMO_COMMUNITY,guild]);
  const big=await send(b,'guild',guild,'big');assert.equal(big.sequence,'9007199254740994');
  assert.equal((await markRead(a,'guild',guild,big.message_id)).read_sequence,'9007199254740994');assert.equal(await cursor(a,'guild',guild),'9007199254740994');
  for(const query of ['limit=51','offset=10001','limit=x','before=1'])assert.equal((await request(`${path}?${query}`,a)).status,422,query);
});

/** Every character percent-encoded: decodes to exactly `text`. */
const encodeAll=(text:string)=>[...text].map(ch=>'%'+ch.charCodeAt(0).toString(16).toUpperCase().padStart(2,'0')).join('');
const receipts=(m:Member,key:string)=>count('command_receipts WHERE user_id=$1 AND idempotency_key=$2',[m.id,key]);

test('one Idempotency-Key is one squad send or read across lowercase, uppercase and percent-encoded squad ids; guild keys keep exact case',async()=>{
  const owner=await member('alias-owner'),mate=await member('alias-mate'),squad=await newSquad(owner);await joinSquad(squad,mate,owner);
  const aliases=[squad,squad.toUpperCase(),encodeAll(squad.toUpperCase()),encodeAll(squad)];
  const key=randomUUID(),sends=[];
  for(const alias of aliases)sends.push(await request(`/me/channels/squad/${alias}/messages`,mate,{body:'只送一次'},{key}));
  for(const [i,sent] of sends.entries()){assert.equal(sent.status,201,`${aliases[i]}: ${JSON.stringify(sent.data)}`);assert.deepEqual(sent.data,sends[0].data,`${aliases[i]} replays the same message`);}
  assert.deepEqual([sends[0].data.channel_key,sends[0].data.sequence],[squad,'1']);
  const rows=(await pool.query('SELECT message_id,sequence::text FROM member_channel_messages WHERE sender_ref=$1',[mate.id])).rows;
  assert.deepEqual(rows,[{message_id:sends[0].data.message_id,sequence:'1'}],'exactly one row, same message_id and sequence');
  assert.equal(await receipts(mate,key),1);
  assert.equal((await request(`/me/channels/squad/${aliases[2]}/messages`,mate,{body:'不同內容'},{key})).data.code,'idempotency_conflict');
  // A later message keeps sequence 2: no alias consumed a sequence number.
  assert.equal((await send(owner,'squad',squad,'下一則')).sequence,'2');
  const readKey=randomUUID(),first=await request(`/me/channels/squad/${squad}/read`,owner,{through_message_id:sends[0].data.message_id},{key:readKey});assert.equal(first.status,200);
  for(const alias of aliases.slice(1)){
    const again=await request(`/me/channels/squad/${alias}/read`,owner,{through_message_id:sends[0].data.message_id},{key:readKey});
    assert.equal(again.status,200,`${alias}: ${JSON.stringify(again.data)}`);assert.deepEqual(again.data,first.data);
  }
  assert.equal(await receipts(owner,readKey),1);
  // Guild keys are not case-folded: a percent-encoded spelling of the same key replays, an upper-case hex custom key is another (unknown) room.
  const custom=await approvedGuild(owner,'別名測試公會');await changeGuild(owner,custom,'join');await changeGuild(mate,custom,'join');
  const guildKey=randomUUID(),exact=await request(`/me/channels/guild/${custom}/messages`,mate,{body:'公會一次'},{key:guildKey});assert.equal(exact.status,201);
  const encoded=await request(`/me/channels/guild/${encodeAll(custom)}/messages`,mate,{body:'公會一次'},{key:guildKey});
  assert.equal(encoded.status,201,JSON.stringify(encoded.data));assert.deepEqual(encoded.data,exact.data);assert.equal(exact.data.channel_key,custom);
  const upperHex=`guild_custom_${custom.slice(13).toUpperCase()}`;
  const other=await request(`/me/channels/guild/${upperHex}/messages`,mate,{body:'公會一次'},{key:guildKey});
  assert.deepEqual([other.status,other.data.code],[404,CHANNEL_NOT_AVAILABLE],'upper-case hex is not the approved room');
  assert.equal((await request(`/me/channels/guild/${guild.toUpperCase()}/messages`,mate,{body:'x'})).status,422,'built-in guild keys are lower-case only');
  assert.equal(await count('member_channel_messages WHERE sender_ref=$1 AND kind=$2',[mate.id,'guild']),1);assert.equal(await receipts(mate,guildKey),1);
  assert.equal(await count('member_chat_channels WHERE channel_key=$1',[upperHex]),0);
});

test('read marks reject cross-channel, cross-kind, forged and malformed message ids without moving the cursor',async()=>{
  const a=await member('reader'),b=await member('writer');
  for(const key of [guild,otherGuild]){await changeGuild(a,key,'join');await changeGuild(b,key,'join');}
  const squad=await newSquad(b);await joinSquad(squad,a,b);
  const own=await send(b,'guild',guild,'room'),elsewhere=await send(b,'guild',otherGuild,'other room'),inSquad=await send(b,'squad',squad,'squad room');
  assert.equal((await markRead(a,'guild',guild,own.message_id)).read_sequence,'1');
  const newer=await send(b,'guild',guild,'room 2');
  await badThrough(()=>markRead(a,'guild',guild,elsewhere.message_id),'other guild message');
  await badThrough(()=>markRead(a,'guild',guild,inSquad.message_id),'squad message on guild path');
  await badThrough(()=>markRead(a,'squad',squad,newer.message_id),'guild message on squad path');
  await badThrough(()=>markRead(a,'guild',guild,randomUUID()),'forged id');
  await badThrough(()=>markRead(a,'squad',squad,randomUUID()),'forged id on squad');
  assert.equal(await cursor(a,'guild',guild),'1');assert.equal(await cursor(a,'squad',squad),undefined);assert.equal((await page(a,'guild',guild)).unread_count,1);
  const path=`/me/channels/guild/${guild}/read`;
  // Over HTTP: well-formed ids of another room are the same Problem; malformed bodies are 422 validation, not 404.
  for(const through of [elsewhere.message_id,inSquad.message_id,randomUUID()]){
    const http=await request(path,a,{through_message_id:through});assert.deepEqual([http.status,http.data.code],[404,'channel_message_not_found'],through);
  }
  for(const body of [{through_message_id:'not-a-uuid'},{through_message_id:''},{through_message_id:1},{},{through_message_id:newer.message_id,read_sequence:'99'}])assert.equal((await request(path,a,body)).status,422,JSON.stringify(body));
  assert.equal(await cursor(a,'guild',guild),'1');assert.equal(await cursor(a,'squad',squad),undefined);assert.equal(await cursor(a,'guild',otherGuild),undefined);
  const ok=await request(path,a,{through_message_id:newer.message_id});assert.equal(ok.status,200,JSON.stringify(ok.data));assert.equal(ok.data.read_sequence,'2');
});

test('channels stay out of private conversations and notifications, and private messages stay out of channels',async()=>{
  const a=await member('pa'),b=await member('pb'),c=await member('pc');for(const m of [a,b,c])await changeGuild(m,guild,'join');
  const squad=await newSquad(a);await joinSquad(squad,b,a);await joinSquad(squad,c,a);
  await sendDirectMessage(pool,cmd(a.actor,{body:'私訊 private-marker'},'dm'),b.id);
  await send(a,'guild',guild,'公會 guild-marker');await send(b,'squad',squad,'小隊 squad-marker');
  for(const m of [a,b,c])for(const [kind,key] of [['guild',guild],['squad',squad]] as const)assert.ok(!JSON.stringify(await page(m,kind,key)).includes('private-marker'));
  const inbox=await request('/me/conversations',b),thread=await request(`/me/conversations/${a.id}/messages`,b);
  assert.equal(inbox.data.unread_count,1);assert.deepEqual(thread.data.items.map((m:any)=>m.body),['私訊 private-marker']);
  assert.deepEqual((await request('/me/conversations',c)).data.items,[],'a third room member sees no private pair');
  assert.equal(await count('member_notifications'),0,'channel messages create no notifications');
  assert.equal(await count("outbox WHERE payload::text LIKE '%guild-marker%' OR payload::text LIKE '%squad-marker%'"),0,'no channel text is published outward');
  assert.equal(await count("transition_journal WHERE data::text LIKE '%guild-marker%' OR data::text LIKE '%squad-marker%'"),0);
  assert.equal(await count("command_receipts WHERE response::text LIKE '%guild-marker%' OR response::text LIKE '%squad-marker%'"),0,'receipts keep no message text');
});

test('leaving a guild or squad revokes history, send, read and receipt replays; rejoin restores history with the original cursor',async()=>{
  const a=await member('leaver'),b=await member('stayer');
  await changeGuild(a,guild,'join');await changeGuild(b,guild,'join');await changeGuild(a,otherGuild,'join');await changeGuild(b,otherGuild,'join');
  const squad=await newSquad(b);await joinSquad(squad,a,b);
  for(const [kind,key,leave,rejoin] of [
    ['guild',guild,()=>changeGuild(a,guild,'leave'),()=>changeGuild(a,guild,'join')],
    ['squad',squad,()=>leaveSquad(squad,a),()=>joinSquad(squad,a,b)],
  ] as const){
    const m1=await send(b,kind,key,`${kind} before`),sendKey=randomUUID(),readKey=randomUUID();
    const mine=await send(a,kind,key,`${kind} mine`,sendKey),read=await markRead(a,kind,key,m1.message_id,readKey);
    await send(b,'guild',otherGuild,`${kind} other room`);const unreadBefore=await send(b,kind,key,`${kind} unread before leave`);
    const before=await cursor(a,kind,key);assert.equal(read.read_sequence,before);
    const otherUnread=kind==='guild'?(await list(a,'guild')).items.find(i=>i.channel_key===otherGuild)!.unread_count:0;
    assert.equal((await list(a,kind)).unread_count,1+otherUnread);
    await leave();
    await gone(()=>page(a,kind,key),`${kind} left GET`);await gone(()=>send(a,kind,key,'after leave'),`${kind} left send`);
    await gone(()=>markRead(a,kind,key,mine.message_id),`${kind} left read`);
    await gone(()=>send(a,kind,key,`${kind} mine`,sendKey),`${kind} left send replay`);await gone(()=>markRead(a,kind,key,m1.message_id,readKey),`${kind} left read replay`);
    const listed=await list(a,kind);assert.ok(!listed.items.some(i=>i.channel_key===key));assert.equal(listed.unread_count,otherUnread,'total excludes the left room');
    const http=await request(`/me/channels/${kind}/${key}/messages`,a);assert.equal(http.status,404);assert.ok(!JSON.stringify(http.data).includes('before'));
    const whileAway=await send(b,kind,key,`${kind} while away`);
    assert.equal(await cursor(a,kind,key),before,'leaving keeps the cursor');
    await rejoin();
    const back=await page(a,kind,key);
    assert.deepEqual(back.items.map(m=>m.message_id),[whileAway.message_id,unreadBefore.message_id,mine.message_id,m1.message_id],'full history is readable again');
    assert.equal(back.unread_count,2,'messages after the kept cursor, including those posted while away, are unread');assert.equal(await cursor(a,kind,key),before,'rejoin does not reset or advance the cursor');
    assert.deepEqual(await send(a,kind,key,`${kind} mine`,sendKey),mine,'an eligible replay returns the original message');
    assert.equal(await count('member_channel_messages WHERE kind=$1 AND channel_key=$2 AND sender_ref=$3',[kind,key,a.id]),1);
  }
  assert.deepEqual(Object.fromEntries((await list(a,'guild')).items.map(i=>[i.channel_key,i.unread_count])),{[guild]:2,[otherGuild]:2});
});

test('direct service calls recheck live account, session, community and onboarding; a completed legacy member still works',async()=>{
  const a=await member('svc'),b=await member('svc-peer'),legacy=await member('legacy',{legacy:true});
  for(const m of [a,b,legacy])await changeGuild(m,guild,'join');
  const squad=await newSquad(b);await joinSquad(squad,a,b);
  const m1=await send(b,'guild',guild,'hello'),s1=await send(b,'squad',squad,'hello squad'),sendKey=randomUUID(),readKey=randomUUID();
  const sent=await send(a,'guild',guild,'mine',sendKey),read=await markRead(a,'guild',guild,m1.message_id,readKey);
  // Legacy member: onboarding_required=false and never completed.
  assert.equal((await page(legacy,'guild',guild)).items.length,2);assert.equal((await send(legacy,'guild',guild,'legacy ok')).kind,'guild');
  assert.equal((await request(`/me/channels/guild/${guild}/messages`,legacy)).status,200);
  const other=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[other,'合成的其他社群']);
  const state=async()=>(await pool.query('SELECT (SELECT count(*) FROM member_channel_messages)::int AS messages,(SELECT count(*) FROM command_receipts)::int AS receipts,(SELECT coalesce(sum(last_read_sequence),0)::text FROM member_channel_reads) AS cursors')).rows[0];
  const restore=async()=>{await pool.query('UPDATE users SET active=true,onboarding_required=true,onboarding_completed_at=now() WHERE user_id=$1',[a.id]);};
  const scenarios:{label:string;status:number;code:string;revoke:(actor:Actor)=>Promise<Actor>}[]=[
    {label:'revoked session',status:401,code:'session_expired',revoke:async actor=>{await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actor.session_hash]);return actor;}},
    {label:'expired session',status:401,code:'session_expired',revoke:async actor=>{await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",[actor.session_hash]);return actor;}},
    {label:'disabled member',status:401,code:'session_expired',revoke:async actor=>{await pool.query('UPDATE users SET active=false WHERE user_id=$1',[a.id]);return actor;}},
    {label:'forged community actor',status:401,code:'session_expired',revoke:async actor=>({...actor,community_id:other})},
    {label:'onboarding reset',status:403,code:'onboarding_required',revoke:async actor=>{await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[a.id]);return actor;}},
  ];
  for(const scenario of scenarios){
    const stale={...a,actor:await scenario.revoke((await session(a.email)).actor)},before=await state(),label=scenario.label;
    for(const kind of ['guild','squad'] as const){const key=kind==='guild'?guild:squad;
      await rejectsWith(()=>list(stale,kind),scenario.status,scenario.code,`${label} list ${kind}`);
      await rejectsWith(()=>page(stale,kind,key),scenario.status,scenario.code,`${label} GET ${kind}`);
      await rejectsWith(()=>send(stale,kind,key,'stale'),scenario.status,scenario.code,`${label} send ${kind}`);
      await rejectsWith(()=>markRead(stale,kind,key,kind==='guild'?m1.message_id:s1.message_id),scenario.status,scenario.code,`${label} read ${kind}`);
    }
    await rejectsWith(()=>send(stale,'guild',guild,'mine',sendKey),scenario.status,scenario.code,`${label} send replay`);
    await rejectsWith(()=>markRead(stale,'guild',guild,m1.message_id,readKey),scenario.status,scenario.code,`${label} read replay`);
    assert.deepEqual(await state(),before,`${label} wrote nothing`);await restore();
  }
  const fresh={...a,...await session(a.email)};
  assert.deepEqual(await send(fresh,'guild',guild,'mine',sendKey),sent);assert.deepEqual(await markRead(fresh,'guild',guild,m1.message_id,readKey),read);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[a.id]);
  assert.equal((await request(`/me/channels/guild/${guild}/messages`,fresh)).data.code,'onboarding_required');
  const anonymous=await app.request(origin+`/api/v1/me/channels?kind=guild`,{headers:{Origin:origin}});assert.equal(anonymous.status,401);
});

/** Resolves once `count` backends are waiting on the blocker's locks; fails if a call finishes without waiting. */
async function waitUntilBlocked(blockerPid:number,count:number,pending:Promise<unknown>[]){
  let settled=0;for(const p of pending)p.then(()=>settled++,()=>settled++);
  for(let i=0;i<2000;i++){
    if((await database.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[blockerPid])).rows[0].n>=count)return;
    assert.equal(settled,0,'a channel call finished without waiting for the concurrent revocation');
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.fail('channel calls never waited for the concurrent revocation');
}

test('channel reads and writes waiting behind a held users/sessions revocation fail closed after it commits, never with raw 40001',async()=>{
  const a=await member('held'),b=await member('held-peer');await changeGuild(a,guild,'join');await changeGuild(b,guild,'join');
  const squad=await newSquad(b);await joinSquad(squad,a,b);const m1=await send(b,'guild',guild,'held secret'),s1=await send(b,'squad',squad,'held squad secret');
  for(const steps of [['UPDATE users SET active=false WHERE user_id=$1'],['SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE','UPDATE sessions SET revoked_at=now() WHERE user_id=$1']]){
    const m={...a,...await session(a.email)},blocker=await pool.connect();let pending:Promise<unknown>[]=[];
    try{
      const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await blocker.query("SET statement_timeout='20s'");await blocker.query('BEGIN');for(const step of steps)await blocker.query(step,[a.id]);
      pending=[list(m,'guild'),page(m,'guild',guild),page(m,'squad',squad),send(m,'guild',guild,'while revoked'),markRead(m,'squad',squad,s1.message_id)];
      await waitUntilBlocked(pid,pending.length,pending);
      await blocker.query('COMMIT');
      for(const [i,result] of (await Promise.allSettled(pending)).entries())rejected(result,401,'session_expired',`${steps[0]} call ${i}`);
    }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await Promise.allSettled(pending);await pool.query('UPDATE users SET active=true WHERE user_id=$1',[a.id]);}
  }
  assert.equal(await count('member_channel_messages WHERE sender_ref=$1',[a.id]),0);assert.equal(await count('member_channel_reads WHERE user_id=$1',[a.id]),0);
  assert.equal((await page({...a,...await session(a.email)},'guild',guild)).items[0].message_id,m1.message_id,'a fresh session reads again');
});

test('race: a guild or squad leave that commits first makes queued channel GET, send and read fail closed',{timeout:60000},async()=>{
  const a=await member('race-owner'),b=await member('race-member');
  await changeGuild(a,guild,'join');await changeGuild(b,guild,'join');const squad=await newSquad(a);await joinSquad(squad,b,a);
  const cases=[
    {kind:'guild' as const,key:guild,hold:['SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 FOR KEY SHARE',[DEMO_COMMUNITY,b.id,guild]] as const,leave:(on:Pool)=>changeGuild(b,guild,'leave',on)},
    {kind:'squad' as const,key:squad,hold:['SELECT 1 FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2 FOR KEY SHARE',[squad,b.id]] as const,leave:(on:Pool)=>leaveSquad(squad,b,on)},
  ];
  for(const c of cases){
    const seen=await send(a,c.kind,c.key,`${c.kind} race secret`),roles=['leave','get','send','read'].map(r=>`${r}-${c.kind}`);
    const [leaver,getter,sender,reader]=roles.map(racer),holder=await pool.connect(),pending:Promise<unknown>[]=[];
    try{
      // The real leave takes its advisory lock, then blocks on FOR UPDATE of the held membership row before committing.
      await holder.query("SET statement_timeout='20s'");await holder.query('BEGIN');await holder.query(c.hold[0],[...c.hold[1]]);
      const leave=c.leave(leaver);pending.push(leave);await waitingOn(roles[0],'transactionid');
      const get=page(b,c.kind,c.key,{},getter);pending.push(get);await waitingOn(roles[1],'advisory');
      const posted=send(b,c.kind,c.key,'after leave',randomUUID(),sender);pending.push(posted);await waitingOn(roles[2],'advisory');
      const read=markRead(b,c.kind,c.key,seen.message_id,randomUUID(),reader);pending.push(read);await waitingOn(roles[3],'advisory');
      // Advisory waiters queue: the first waits only on the leave; later ones also list earlier queued racers of this case, nothing else.
      const [leavePid,...queued]=await Promise.all(roles.map(pidOf));
      for(const [i,pid] of queued.entries()){const by=await blockers(pid);assert.ok(by.includes(leavePid)&&by.every(p=>p===leavePid||queued.slice(0,i).includes(p)),`${roles[i+1]} blocked by ${by}`);}
      await holder.query('COMMIT');
      const [left,...calls]=await Promise.allSettled([leave,get,posted,read]);
      assert.equal(left.status,'fulfilled',String((left as PromiseRejectedResult).reason));
      calls.forEach((result,i)=>rejected(result,404,CHANNEL_NOT_AVAILABLE,`${c.kind} ${roles[i+1]}`));
      assert.equal(await count('member_channel_messages WHERE sender_ref=$1 AND kind=$2',[b.id,c.kind]),0);assert.equal(await cursor(b,c.kind,c.key),undefined);
    }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await Promise.allSettled(pending);for(const p of [leaver,getter,sender,reader])await p.end();}
  }
});

// Root/ops contract: the send command commits and stores only {message_id} in
// its receipt; the response body is read in a fresh snapshot that re-checks
// membership. When the leave commits in between, the committed send answers
// 404 channel_not_available (strict revocation) - that is correct, not a bug.
test('race: a send already past membership commits exactly one message before a concurrent leave; its answer is that message or strict 404, and everything after the leave is 404',{timeout:60000},async()=>{
  const a=await member('rev-owner'),b=await member('rev-member');
  await changeGuild(a,guild,'join');await changeGuild(b,guild,'join');const squad=await newSquad(a);await joinSquad(squad,b,a);
  const membershipXmin={
    guild:async()=>(await pool.query('SELECT xmin::text::bigint AS x,state FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3',[DEMO_COMMUNITY,b.id,guild])).rows[0],
    squad:async()=>(await pool.query('SELECT xmin::text::bigint AS x,state FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2',[squad,b.id])).rows[0],
  };
  for(const [kind,key,leave] of [['guild',guild,(on:Pool)=>changeGuild(b,guild,'leave',on)],['squad',squad,(on:Pool)=>leaveSquad(squad,b,on)]] as const){
    const earlier=await send(b,kind,key,`${kind} earlier`),earlierRead=randomUUID();await markRead(b,kind,key,earlier.message_id,earlierRead);
    const body=`${kind} sent before leave`,opKey=randomUUID();
    const sender=racer(`rsend-${kind}`),leaver=racer(`rleave-${kind}`),holder=await pool.connect(),pending:Promise<unknown>[]=[];
    try{
      // Hold the channel row so the send, already holding its membership share lock, blocks at sequence allocation.
      await holder.query("SET statement_timeout='20s'");await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM member_chat_channels WHERE community_id=$1 AND kind=$2 AND channel_key=$3 FOR UPDATE',[DEMO_COMMUNITY,kind,key]);
      const posted=send(b,kind,key,body,opKey,sender);pending.push(posted);await waitingOn(`rsend-${kind}`,['transactionid','tuple']);
      const left=leave(leaver);pending.push(left);await waitingOn(`rleave-${kind}`,'advisory');
      const sendPid=await pidOf(`rsend-${kind}`),leaveBy=await blockers(await pidOf(`rleave-${kind}`));
      assert.ok(leaveBy.length>0&&leaveBy.every(pid=>pid===sendPid),`the leave waits only on the in-flight send, got ${leaveBy}`);
      assert.equal(await count('member_channel_messages WHERE body=$1',[body]),0,'nothing committed while held');
      await holder.query('COMMIT');
      const [sent,leftResult]=await Promise.allSettled([posted,left]);
      assert.equal(leftResult.status,'fulfilled',String((leftResult as PromiseRejectedResult).reason));
      // DB: exactly one committed message, written by a transaction that precedes the leave's write.
      const rows=(await pool.query('SELECT message_id,sequence::text,xmin::text::bigint AS x FROM member_channel_messages WHERE sender_ref=$1 AND kind=$2 AND body=$3',[b.id,kind,body])).rows;
      assert.equal(rows.length,1,`${kind}: exactly one committed message`);const [row]=rows;
      assert.equal(row.sequence,(BigInt(earlier.sequence)+1n).toString());
      const membership=await membershipXmin[kind]();assert.notEqual(membership.state,'active');assert.ok(BigInt(row.x)<BigInt(membership.x),`${kind}: send xid ${row.x} precedes leave xid ${membership.x}`);
      // Receipt: only the message id, never the text.
      const receipt=(await pool.query('SELECT response FROM command_receipts WHERE user_id=$1 AND idempotency_key=$2',[b.id,opKey])).rows;
      assert.equal(receipt.length,1);assert.deepEqual(receipt[0].response,{message_id:row.message_id});
      // HTTP-equivalent answer: the one committed message, or the strict revocation 404 - nothing else.
      if(sent.status==='fulfilled')assert.deepEqual([sent.value.message_id,sent.value.sequence,sent.value.body,sent.value.sender_ref],[row.message_id,row.sequence,body,b.id],`${kind}: answered message`);
      else rejected(sent,404,CHANNEL_NOT_AVAILABLE,`${kind} committed send answered after leave`);
      // The room still has it; the leaver has no read, send, read mark or replay.
      assert.equal((await page(a,kind,key)).items[0].message_id,row.message_id);
      await gone(()=>page(b,kind,key),`${kind} GET after leave`);await gone(()=>send(b,kind,key,'after'),`${kind} send after leave`);
      await gone(()=>markRead(b,kind,key,row.message_id),`${kind} read after leave`);
      await gone(()=>send(b,kind,key,body,opKey),`${kind} same-key send replay after leave`);await gone(()=>markRead(b,kind,key,earlier.message_id,earlierRead),`${kind} same-key read replay after leave`);
      assert.equal(await count('member_channel_messages WHERE sender_ref=$1 AND kind=$2',[b.id,kind]),2,'no resend');assert.equal(await cursor(b,kind,key),earlier.sequence,'cursor unchanged');
      assert.equal(await receipts(b,opKey),1);
    }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await Promise.allSettled(pending);await sender.end();await leaver.end();}
  }
});

test('race: concurrent senders in one room commit in sequence order, so a read cursor never skips a late smaller sequence',{timeout:60000},async()=>{
  const a=await member('seq-a'),b=await member('seq-b'),c=await member('seq-c');for(const m of [a,b,c])await changeGuild(m,guild,'join');
  const m0=await send(c,'guild',guild,'m0');
  // Test-schema trigger: the "slow" insert blocks on a test-only lock after its sequence is allocated, before commit.
  const barrier=`${schema}/channel-barrier`;
  await pool.query(`CREATE FUNCTION channel_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.body='barrier-slow' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${barrier}',0)); END IF; RETURN NEW; END$$`);
  await pool.query('CREATE TRIGGER channel_test_barrier AFTER INSERT ON member_channel_messages FOR EACH ROW EXECUTE FUNCTION channel_test_barrier()');
  const slowPool=racer('slow'),fastPool=racer('fast'),holder=await pool.connect(),pending:Promise<unknown>[]=[];
  try{
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[barrier]);
    const slow=send(a,'guild',guild,'barrier-slow',randomUUID(),slowPool);pending.push(slow);await waitingOn('slow','advisory');
    const fast=send(b,'guild',guild,'fast',randomUUID(),fastPool);pending.push(fast);await waitingOn('fast',['advisory','transactionid','tuple']);
    assert.deepEqual(await blockers(await pidOf('fast')),[await pidOf('slow')],'the later sender waits for the earlier uncommitted sequence');
    const meanwhile=await page(c,'guild',guild);assert.deepEqual(meanwhile.items.map(m=>m.message_id),[m0.message_id]);assert.equal(meanwhile.unread_count,0);
    await holder.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[barrier]);
    const [s,f]=await Promise.all([slow,fast]);
    assert.equal(BigInt(f.sequence),BigInt(s.sequence)+1n);assert.equal(BigInt(s.sequence),BigInt(m0.sequence)+1n);
    assert.equal((await markRead(c,'guild',guild,f.message_id)).read_sequence,f.sequence);assert.equal((await page(c,'guild',guild)).unread_count,0,'nothing hides behind the cursor');
    assert.equal((await page(a,'guild',guild)).unread_count,2);
  }finally{
    await holder.query('SELECT pg_advisory_unlock_all()').catch(()=>{});holder.release();await Promise.allSettled(pending);await slowPool.end();await fastPool.end();
    await pool.query('DROP TRIGGER IF EXISTS channel_test_barrier ON member_channel_messages');await pool.query('DROP FUNCTION IF EXISTS channel_test_barrier()');
  }
});
