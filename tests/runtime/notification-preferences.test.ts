import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {isNotificationQuietHours,type NotificationPreferences} from '../../modules/member-communications/notification-preferences.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL must name a disposable database');
const schema=`fp_preferences_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const origin='http://127.0.0.1:4310';
const app=createApp(pool,origin,'local',{notificationPreferencesEnabled:true,communitySearchEnabled:true,communityRelationsEnabled:true,personalContentEnabled:true,now:()=>new Date('2026-10-08T04:00:00Z')});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function member(index:number){
  const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[index].email,password:DEMO_PASSWORD})});
  assert.equal(response.status,200);
  const session=await response.json() as {csrf_token:string};
  const headers={Origin:origin,Cookie:response.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':session.csrf_token,'Content-Type':'application/json'};
  return {request:(path:string,body?:unknown,version?:number,key:string=randomUUID(),method='PATCH')=>app.request(origin+'/api/v1/'+path,body===undefined?{headers}:{method,headers:{...headers,'Idempotency-Key':key,...(version===undefined?{}:{'If-Match':`"${version}"`})},body:JSON.stringify(body)})};
}
type Member={request:(path:string,body?:unknown,version?:number,key?:string,method?:string)=>Response|Promise<Response>};
type PreferenceBody=Pick<NotificationPreferences,'categories'|'quiet_hours'|'muted_channel_ids'>;
const endpoint='me/notification-preferences';
function body(preferences:NotificationPreferences){return {categories:{...preferences.categories},quiet_hours:{...preferences.quiet_hours},muted_channel_ids:[...preferences.muted_channel_ids]};}
async function preferences(owner:Member){const response=await owner.request(endpoint);assert.equal(response.status,200,await response.clone().text());return await response.json() as NotificationPreferences;}
async function save(owner:Member,value:PreferenceBody){const current=await preferences(owner),response=await owner.request(endpoint,value,current.version);assert.equal(response.status,200,await response.clone().text());return await response.json() as NotificationPreferences;}
async function notices(index:number,kind:string,count:number,created:string){
  const ids:string[]=[];
  for(let i=0;i<count;i++){const id=randomUUID();ids.push(id);await pool.query('INSERT INTO member_notifications(notification_id,community_id,recipient_ref,kind,source_key,title,body,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,DEMO_COMMUNITY,DEMO_USERS[index].user_id,kind,id,kind+'提醒','不能出現在摘要的私人本體',created]);}
  return ids;
}

test('owner preferences survive re-login, serialize first writes and reject foreign fields or Email opt-in',async()=>{
  const owner=await member(0),other=await member(1),initial=await preferences(owner);
  const value=body(initial);value.categories.friends='off';value.muted_channel_ids=['world:world'];
  const [a,b]=await Promise.all([owner.request(endpoint,value,initial.version),owner.request(endpoint,value,initial.version)]);
  assert.deepEqual([a.status,b.status].sort(),[200,412]);
  const again=await member(0);assert.deepEqual((await preferences(again)).categories,value.categories);
  assert.deepEqual((await preferences(other)).muted_channel_ids,[]);
  const current=await preferences(again),key=randomUUID(),first=await again.request(endpoint,value,current.version,key);
  assert.equal(first.status,200);
  const replay=await (await member(0)).request(endpoint,value,current.version,key);
  assert.equal(replay.status,200);assert.deepEqual(await replay.json(),await first.json());
  assert.equal((await again.request(endpoint,{...value,owner_user_id:DEMO_USERS[1].user_id},current.version)).status,422);
  assert.equal((await again.request(endpoint,{...value,email_digest:{enabled:true}},current.version)).status,422);
  assert.equal((await again.request(endpoint,{...value,muted_channel_ids:['squad:'+randomUUID()]},current.version)).status,404);
  assert.equal((await again.request(endpoint,{...value,quiet_hours:{...value.quiet_hours,enabled:true,start:'10:00',end:'10:00'}},current.version)).status,422);
  assert.equal((await again.request(endpoint,{...value,quiet_hours:{...value.quiet_hours,time_zone:'Not/AZone'}},current.version)).status,422);
});

test('suppressed recent notices cannot starve older essential reminders or selected summary notices',async()=>{
  const owner=await member(1);
  const essential=(await notices(1,'guild_expert_revoked',1,'2026-10-06T00:00:00Z'))[0];
  const summary=(await notices(1,'squad_invitation',1,'2026-10-06T01:00:00Z'))[0];
  await notices(1,'friend_request',45,'2026-10-07T00:00:00Z');
  const value=body(await preferences(owner));value.categories.friends='off';value.categories.squads='summary';await save(owner,value);
  const reminders=await (await owner.request(endpoint+'/reminders')).json() as {items:{notification_id:string;body:string}[];unread_count:number};
  assert.equal(reminders.unread_count,1);assert.deepEqual(reminders.items.map(item=>item.notification_id),[essential]);assert.equal(reminders.items[0].body,'');
  const digest=await (await owner.request(endpoint+'/summary')).json() as {items:{id:string}[];email_status:string};
  assert.deepEqual(digest.items.map(item=>item.id),[summary]);assert.equal(digest.email_status,'not_enabled');
  const inbox=await (await owner.request('me/notifications?limit=50')).json() as {items:{read_at:string|null}[];unread_count:number};
  assert.equal(inbox.unread_count,47);assert.equal(inbox.items.every(item=>item.read_at===null),true);
  assert.equal(JSON.stringify(digest).includes('私人本體'),false);
});

test('quiet wall-clock boundaries handle cross-midnight and both DST transitions',()=>{
  const quiet=(time_zone:string,start:string,end:string,instant:string)=>isNotificationQuietHours({quiet_hours:{enabled:true,time_zone,start,end}},new Date(instant));
  assert.equal(quiet('Asia/Taipei','22:00','08:00','2026-10-08T13:59:00Z'),false);
  assert.equal(quiet('Asia/Taipei','22:00','08:00','2026-10-08T14:00:00Z'),true);
  assert.equal(quiet('Asia/Taipei','22:00','08:00','2026-10-08T23:59:00Z'),true);
  assert.equal(quiet('Asia/Taipei','22:00','08:00','2026-10-09T00:00:00Z'),false);
  assert.equal(quiet('America/New_York','01:00','03:00','2026-03-08T06:30:00Z'),true);
  assert.equal(quiet('America/New_York','01:00','03:00','2026-03-08T07:00:00Z'),false);
  assert.equal(quiet('America/New_York','01:00','02:00','2026-11-01T05:30:00Z'),true);
  assert.equal(quiet('America/New_York','01:00','02:00','2026-11-01T06:30:00Z'),true);
  assert.equal(quiet('Asia/Taipei','10:00','11:00','2026-10-08T02:00:00Z'),true);
  assert.equal(quiet('Asia/Taipei','10:00','11:00','2026-10-08T03:00:00Z'),false);
});

test('channel mute and quiet suppress badges without changing original history or read cursors',async()=>{
  const sender=await member(0),owner=await member(2);
  const sent=await sender.request('me/channels/world/world/messages',{body:'頻道靜音仍保留255'},undefined,randomUUID(),'POST');assert.equal(sent.status,201,await sent.clone().text());
  const original=await (await owner.request('me/channels?kind=world')).json() as {unread_count:number};assert.equal(original.unread_count,1);
  const value=body(await preferences(owner));value.muted_channel_ids=['world:world'];await save(owner,value);
  assert.equal((await (await owner.request(endpoint+'/channel-reminders')).json() as {world:number}).world,0);
  assert.equal((await (await owner.request('me/channels?kind=world')).json() as {unread_count:number}).unread_count,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_channel_reads WHERE user_id=$1',[DEMO_USERS[2].user_id])).rows[0].n,0);
  value.muted_channel_ids=[];await save(owner,value);
  assert.equal((await (await owner.request(endpoint+'/channel-reminders')).json() as {world:number}).world,1);
  value.quiet_hours={enabled:true,time_zone:'Asia/Taipei',start:'11:00',end:'13:00'};await save(owner,value);
  assert.equal((await (await owner.request(endpoint+'/channel-reminders')).json() as {world:number}).world,0);
  assert.equal((await (await owner.request('me/channels?kind=world')).json() as {unread_count:number}).unread_count,1);
  value.quiet_hours.enabled=false;await save(owner,value);
  assert.equal((await (await owner.request(endpoint+'/channel-reminders')).json() as {world:number}).world,1);
  const message=await sent.json() as {message_id:string};
  assert.equal((await sender.request(`me/channels/world/world/messages/${message.message_id}/retract`,{},undefined,randomUUID(),'POST')).status,200);
  assert.equal((await (await owner.request(endpoint+'/channel-reminders')).json() as {world:number}).world,0);
  assert.equal((await (await owner.request('me/channels?kind=world')).json() as {unread_count:number}).unread_count,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_channel_reads WHERE user_id=$1',[DEMO_USERS[2].user_id])).rows[0].n,0);
});

test('follow reminder and summary recheck original published content and opt-out at each read',async()=>{
  const author=await member(0),follower=await member(2);
  const sharedResponse=await author.request('showcases',{title:'追蹤原始作品255',description:'會員作品摘要',consent_to_share:true},undefined,randomUUID(),'POST');assert.equal(sharedResponse.status,201,await sharedResponse.clone().text());
  const shared=await sharedResponse.json() as {showcase_id:string;aggregate_version:string};
  assert.equal((await follower.request('community-relations/follows',{kind:'author',id:DEMO_USERS[0].user_id,selected:true},undefined,randomUUID(),'POST')).status,200);
  const value=body(await preferences(follower));value.quiet_hours.enabled=false;value.categories.following='instant';await save(follower,value);
  const live=await (await follower.request(endpoint+'/following-reminders')).json() as {items:{id:string;title:string}[]};assert.equal(live.items.some(item=>item.title==='追蹤原始作品255'),true);
  value.categories.following='summary';await save(follower,value);
  assert.deepEqual((await (await follower.request(endpoint+'/following-reminders')).json() as {items:unknown[]}).items,[]);
  assert.equal(JSON.stringify(await (await follower.request(endpoint+'/summary')).json()).includes('追蹤原始作品255'),true);
  const withdrawn=await author.request('me/showcases/'+shared.showcase_id+'/withdraw',{},Number(shared.aggregate_version),randomUUID(),'POST');assert.equal(withdrawn.status,200,await withdrawn.clone().text());
  assert.equal(JSON.stringify(await (await follower.request(endpoint+'/summary')).json()).includes('追蹤原始作品255'),false);
  await follower.request('community-relations/follows',{kind:'author',id:DEMO_USERS[0].user_id,selected:false},undefined,randomUUID(),'POST');
  assert.deepEqual((await (await follower.request(endpoint+'/summary')).json() as {items:unknown[]}).items,[]);
});

test('event bulletins obey event modes and quiet hours while pending subjects stay owner-private',async()=>{
  const owner=await member(0),other=await member(2);
  const created=await owner.request('events',{title:'公告偏好與待審核255',description:'尚未公开細節',starts_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+90000000).toISOString(),mode:'online',location:'測試參與位置',visibility:'open',capacity:null},undefined,randomUUID(),'POST');
  assert.equal(created.status,201,await created.clone().text());
  const value=body(await preferences(owner));value.categories.events='instant';value.quiet_hours.enabled=false;await save(owner,value);
  assert.equal(JSON.stringify(await (await owner.request(endpoint+'/event-reminders')).json()).includes('公告偏好與待審核255'),true);
  assert.deepEqual((await (await other.request(endpoint+'/event-reminders')).json() as {items:unknown[]}).items,[]);
  value.categories.events='off';await save(owner,value);
  assert.deepEqual((await (await owner.request(endpoint+'/event-reminders')).json() as {items:unknown[]}).items,[]);
  assert.equal(JSON.stringify(await (await owner.request('events/bulletins')).json()).includes('公告偏好與待審核255'),true);
  value.categories.events='summary';await save(owner,value);
  assert.deepEqual((await (await owner.request(endpoint+'/event-reminders')).json() as {items:unknown[]}).items,[]);
  assert.equal(JSON.stringify(await (await owner.request(endpoint+'/summary')).json()).includes('公告偏好與待審核255'),true);
  const foreign=body(await preferences(other));foreign.categories.events='summary';await save(other,foreign);
  assert.equal(JSON.stringify(await (await other.request(endpoint+'/summary')).json()).includes('公告偏好與待審核255'),false);
  value.categories.events='instant';value.quiet_hours={enabled:true,time_zone:'Asia/Taipei',start:'11:00',end:'13:00'};await save(owner,value);
  assert.deepEqual((await (await owner.request(endpoint+'/event-reminders')).json() as {items:unknown[]}).items,[]);
});

test('preference release flag fails closed and does not authorize outbound Email',async()=>{
  const off=createApp(pool,origin,'local');
  for(const path of [endpoint,endpoint+'/summary',endpoint+'/reminders',endpoint+'/channel-reminders',endpoint+'/following-reminders',endpoint+'/event-reminders'])assert.equal((await off.request(origin+'/api/v1/'+path)).status,404);
  assert.equal((await app.request(origin+'/api/v1/'+endpoint)).status,401);
  assert.equal((await preferences(await member(0))).email_digest.enabled,false);
});
