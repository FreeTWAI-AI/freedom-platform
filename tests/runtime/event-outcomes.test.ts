import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,transaction,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import {Problem} from '../../packages/shared/problem.js';
import {communityCatalog} from '../../modules/community/catalog.js';
import {createEventOutcome,updateEventOutcome,publishEventOutcome,withdrawEventOutcome,readPublishedEventOutcome,readOwnEventOutcome,listEventOutcomes,listEventOutcomeReferences,listEventOutcomeBacklinks,validateAndBindEventOutcomeMedia,readEventOutcomeMediaAuthorization} from '../../modules/community/event-outcomes.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_event_outcomes_${process.pid}_${Date.now()}`;
const admin=createPool(url),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
let eventId:string,actors:Actor[];
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
 await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
 actors=(await Promise.all(DEMO_USERS.map(user=>login(pool,user.email,DEMO_PASSWORD)))).map(result=>result.actor);
 eventId=randomUUID();
 await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility) VALUES($1,$2,$3,'合成回顧','隔離驗證','2020-01-01T10:00:00Z','2020-01-01T12:00:00Z','online','合成地址','published','open')`,[eventId,DEMO_COMMUNITY,actors[0]!.user_id]);
});
const input=(operation:string,body:unknown,version?:number,actor=actors[0]!):Command=>({actor,operation,key:randomUUID(),body,expected:version===undefined?undefined:String(version)});
const viewer=(actor=actors[0]!)=>({communityId:actor.community_id,userId:actor.user_id});
const is404=(error:unknown)=>error instanceof Problem&&error.status===404;
async function draft(refs:{kind:'work'|'skill_book'|'squad_outcome';id:string}[]=[],audience:'public'|'community'|'guild'='public'){
 return createEventOutcome(pool,input('outcome-create',{title:'合成成果',summary:'本人撰寫的隔離測試摘要',audience,refs}),eventId);
}
async function showcase(status='published',visibility='community'){
 const id=randomUUID();await pool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,status,visibility,consent_recorded_at) VALUES($1,$2,$3,'非公開作品標題','作品內容','artifact:synthetic',$4,$5,CASE WHEN $4='published' THEN now() ELSE NULL END)`,[id,DEMO_COMMUNITY,actors[0]!.user_id,status,visibility]);return id;
}
async function originalMedia(owner=actors[0]!,event=eventId){
 const id=randomUUID();await pool.query(`INSERT INTO community_event_highlights(media_id,event_id,community_id,uploader_user_id,kind,url,platform,title) VALUES($1,$2,$3,$4,'link',$5,'other','合成媒體')`,[id,event,owner.community_id,owner.user_id,`https://example.test/${id}`]);return id;
}
test('real author, explicit consent, expected-version conflict and command replay',async()=>{
 const creation=input('outcome-create',{title:'合成成果',summary:'自己撰寫',audience:'public',refs:[]});
 const a=await createEventOutcome(pool,creation,eventId),b=await createEventOutcome(pool,creation,eventId);assert.equal(a.outcome_id,b.outcome_id);assert.equal(a.author.user_id,actors[0]!.user_id);
 await assert.rejects(readPublishedEventOutcome(pool,a.outcome_id,null),is404);
 await assert.rejects(publishEventOutcome(pool,input('publish',{consent_to_share:false},1),a.outcome_id));
 const publication=input('publish',{consent_to_share:true},1);const published=await publishEventOutcome(pool,publication,a.outcome_id);assert.equal(published.aggregate_version,2);
 assert.equal((await publishEventOutcome(pool,publication,a.outcome_id)).aggregate_version,2);
 await assert.rejects(withdrawEventOutcome(pool,input('withdraw',{},1),a.outcome_id),(e:unknown)=>e instanceof Problem&&e.status===412&&e.code==='version_conflict');
 await assert.rejects(publishEventOutcome(pool,input('publish',{consent_to_share:true},2,actors[1]!),a.outcome_id),is404);
 const withdrawn=await withdrawEventOutcome(pool,input('withdraw',{},2),a.outcome_id);
 assert.deepEqual(await publishEventOutcome(pool,publication,a.outcome_id),published);
 const edited=await updateEventOutcome(pool,input('update',{title:'改稿',summary:'重新同意前不可公開',audience:'community',refs:[]},withdrawn.aggregate_version),a.outcome_id);
 assert.equal(edited.state,'draft');assert.equal(edited.consent_recorded_at,null);await assert.rejects(readPublishedEventOutcome(pool,a.outcome_id,viewer()),is404);
 await assert.rejects(createEventOutcome(pool,input('create',{title:'冒充',summary:'冒充作者',audience:'public',refs:[],author_user_id:actors[1]!.user_id}),eventId));
});
test('private work and arbitrary or foreign targets cannot become public sources',async()=>{
 const privateId=await showcase('draft','private');await assert.rejects(draft([{kind:'work',id:privateId}],'community'),is404);
 const id=await showcase();await assert.rejects(draft([{kind:'work',id}],'public'),is404);
 await assert.rejects(draft([{kind:'work',id:randomUUID()}],'community'),is404);
 await assert.rejects(draft([{kind:'skill_book',id:'https://example.test/private'}]));
 await assert.rejects(createEventOutcome(pool,input('create',{title:'私人成果',summary:'不可發布Result',audience:'public',refs:[{kind:'result',id:randomUUID()}]}),eventId));
 const entry=await draft([{kind:'work',id}],'community');await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),entry.outcome_id);
 await assert.rejects(readPublishedEventOutcome(pool,entry.outcome_id,null),is404);
 const publicPicker=await listEventOutcomeReferences(pool,actors[0]!,eventId);assert(publicPicker.items.some(r=>r.id===id));assert(!publicPicker.items.some(r=>r.id===privateId));
 const foreignCommunity=randomUUID();await pool.query('INSERT INTO communities(community_id,name) VALUES($1,$2)',[foreignCommunity,'隔離外社群']);
 await pool.query('UPDATE showcases SET community_id=$2 WHERE showcase_id=$1',[id,foreignCommunity]);
 await assert.rejects(readPublishedEventOutcome(pool,entry.outcome_id,viewer()),is404);
});
test('guild recap is inaccessible anonymously and membership revocation closes it',async()=>{
 const guild=(await pool.query('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
 await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active',left_at=NULL`,[randomUUID(),DEMO_COMMUNITY,actors[0]!.user_id,guild]);
 await pool.query("UPDATE community_events SET visibility='guild',guild_key=$2,event_kind='guild_skill_exchange' WHERE event_id=$1",[eventId,guild]);
 await assert.rejects(draft([],'public'),(e:unknown)=>e instanceof Problem&&e.status===422);
 const entry=await draft([],'guild');await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),entry.outcome_id);
 await assert.rejects(listEventOutcomes(pool,eventId,null),is404);assert.equal((await listEventOutcomes(pool,eventId,viewer())).items.length,1);
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key=$2",[actors[0]!.user_id,guild]);
 await assert.rejects(readPublishedEventOutcome(pool,entry.outcome_id,viewer()),is404);
 assert.equal((await readOwnEventOutcome(pool,actors[0]!,entry.outcome_id)).outcome_id,entry.outcome_id);
});
test('source withdrawal hides entire dependent summary, media and backlinks; no unbound fallback',async()=>{
 const work=await showcase(),entry=await draft([{kind:'work',id:work}],'community'),media=await originalMedia();
 await transaction(pool,q=>validateAndBindEventOutcomeMedia(q,actors[0]!,eventId,entry.outcome_id,media));
 assert.equal((await readEventOutcomeMediaAuthorization(pool,media,null))?.authorized,false);
 assert.equal((await readEventOutcomeMediaAuthorization(pool,media,viewer()))?.authorized,true);
 assert.equal((await readEventOutcomeMediaAuthorization(pool,media,viewer(actors[1]!)))?.authorized,false);
 await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),entry.outcome_id);
 const before=await readEventOutcomeMediaAuthorization(pool,media,viewer());assert.equal(before?.authorized,true);
 await pool.query("UPDATE showcases SET title='更新作品標題',aggregate_version=aggregate_version+1 WHERE showcase_id=$1",[work]);
 assert.notEqual((await readEventOutcomeMediaAuthorization(pool,media,viewer()))?.authorizationVersion,before?.authorizationVersion);
 const links=await listEventOutcomeBacklinks(pool,{kind:'work',id:work},viewer());assert.equal(links.items[0]?.path,`#highlights/${eventId}`);
 await pool.query("UPDATE showcases SET status='withdrawn',visibility='private' WHERE showcase_id=$1",[work]);
 await assert.rejects(readPublishedEventOutcome(pool,entry.outcome_id,viewer()),is404);assert.equal((await readEventOutcomeMediaAuthorization(pool,media,viewer()))?.authorized,false);
 await assert.rejects(listEventOutcomeBacklinks(pool,{kind:'work',id:work},viewer()),is404);
 assert.equal((await readOwnEventOutcome(pool,actors[0]!,entry.outcome_id)).summary,'本人撰寫的隔離測試摘要');
 await withdrawEventOutcome(pool,input('withdraw',{},2),entry.outcome_id);assert.equal((await readEventOutcomeMediaAuthorization(pool,media,viewer()))?.authorized,false);
 const unbound=await originalMedia();assert.equal(await readEventOutcomeMediaAuthorization(pool,unbound,null),null);
 await assert.rejects(pool.query('DELETE FROM community_event_outcome_media WHERE media_id=$1',[media]),(e:any)=>e.code==='23514');
});
test('foreign media owner is rejected and original binding is atomic',async()=>{
 const entry=await draft(),foreign=await originalMedia(actors[1]!);
 await assert.rejects(transaction(pool,q=>validateAndBindEventOutcomeMedia(q,actors[0]!,eventId,entry.outcome_id,foreign)),is404);
 assert.equal(await readEventOutcomeMediaAuthorization(pool,foreign,null),null);
 const media=await originalMedia();await assert.rejects(transaction(pool,async q=>{await validateAndBindEventOutcomeMedia(q,actors[0]!,eventId,entry.outcome_id,media);throw new Error('synthetic rollback');}));
 assert.equal(await readEventOutcomeMediaAuthorization(pool,media,null),null);
});
test('curated skillbook canonical reader produces permission-safe public backlinks',async()=>{
 const book=communityCatalog.skill_books[0]!;const entry=await draft([{kind:'skill_book',id:book.id}]);await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),entry.outcome_id);
 const readable=await readPublishedEventOutcome(pool,entry.outcome_id,null);assert.equal(readable.refs[0]?.path,`/development/skills/${book.id}`);
 const links=await listEventOutcomeBacklinks(pool,{kind:'skill_book',id:book.id},null);assert.equal(links.items[0]?.path,`/highlights/${eventId}`);
 await pool.query("UPDATE community_events SET state='cancelled' WHERE event_id=$1",[eventId]);assert.equal((await listEventOutcomeBacklinks(pool,{kind:'skill_book',id:book.id},null)).items.length,0);
});
test('authenticated public skillbook readers retain public backlinks without foreign private recaps',async()=>{
 const ref={kind:'skill_book' as const,id:communityCatalog.skill_books[0]!.id};
 const published=await draft([ref],'public'),privateEntry=await draft([ref],'community');
 await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),published.outcome_id);
 await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),privateEntry.outcome_id);
 const communityId=randomUUID(),userId=randomUUID();
 await pool.query('INSERT INTO communities(community_id,name) VALUES($1,$2)',[communityId,'隔離公開讀者社群']);
 await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id=$6`,[userId,communityId,`foreign-${userId}@mail.test`,'隔離公開讀者',randomUUID(),actors[0]!.user_id]);
 const foreign=await listEventOutcomeBacklinks(pool,ref,{communityId,userId});
 assert.deepEqual(foreign.items.map(row=>row.outcome_id),[published.outcome_id]);
 assert.equal(foreign.items[0]!.path,`/highlights/${eventId}`);
 const own=await listEventOutcomeBacklinks(pool,ref,viewer());
 assert.deepEqual(new Set(own.items.map(row=>row.outcome_id)),new Set([published.outcome_id,privateEntry.outcome_id]));
 assert(own.items.every(row=>row.path===`#highlights/${eventId}`));
});
test('real squad outcome source withdrawal closes dependent media and squad backlinks',async()=>{
 const squad=randomUUID(),source=randomUUID();
 await pool.query(`INSERT INTO member_squads(squad_id,community_id,name,kind,purpose,owner_ref) VALUES($1,$2,'合成小隊','project','隔離成果驗證',$3)`,[squad,DEMO_COMMUNITY,actors[0]!.user_id]);
 await pool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`,[squad,actors[0]!.user_id]);
 await pool.query(`INSERT INTO member_squad_outcomes(outcome_id,squad_id,community_id,author_ref,title,summary,audience,state,consent_recorded_at,published_at) VALUES($1,$2,$3,$4,'真實小隊來源','獨立撰寫的小隊摘要','public','published',now(),now())`,[source,squad,DEMO_COMMUNITY,actors[0]!.user_id]);
 const entry=await draft([{kind:'squad_outcome',id:source}]),media=await originalMedia();
 await transaction(pool,q=>validateAndBindEventOutcomeMedia(q,actors[0]!,eventId,entry.outcome_id,media));
 await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),entry.outcome_id);
 assert.equal((await readPublishedEventOutcome(pool,entry.outcome_id,null)).refs[0]?.path,`/squad-outcomes/${source}`);
 assert.equal((await listEventOutcomeBacklinks(pool,{kind:'squad_outcome',id:source},null)).items.length,1);
 await pool.query(`UPDATE member_squad_outcomes SET state='withdrawn',withdrawn_at=now(),aggregate_version=aggregate_version+1 WHERE outcome_id=$1`,[source]);
 await assert.rejects(readPublishedEventOutcome(pool,entry.outcome_id,null),is404);
 assert.equal((await readEventOutcomeMediaAuthorization(pool,media,null))?.authorized,false);
 await assert.rejects(listEventOutcomeBacklinks(pool,{kind:'squad_outcome',id:source},null),is404);
});

test('enabled public recap routes mount once and immediately reflect withdrawal',async()=>{
 const app=createApp(pool,'http://127.0.0.1:4310','local',{squadOutcomesEnabled:true,eventOutcomesEnabled:true});
 const ref={kind:'skill_book' as const,id:communityCatalog.skill_books[0]!.id};
 const entry=await draft([ref]);
 await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),entry.outcome_id);
 const get=(path:string)=>app.request(`http://127.0.0.1:4310/api/v1/public${path}`);
 const detail=await get(`/event-outcomes/${entry.outcome_id}`);
 assert.equal(detail.status,200,await detail.clone().text());
 assert.equal((await detail.json()).outcome_id,entry.outcome_id);
 const list=await get(`/event-highlights/${eventId}/outcomes`);
 assert.equal(list.status,200);assert.equal((await list.json()).items.length,1);
 const backlinks=await get(`/event-outcome-backlinks/skill_book/${ref.id}`);
 assert.equal(backlinks.status,200);assert.equal((await backlinks.json()).items.length,1);
 await withdrawEventOutcome(pool,input('withdraw',{},2),entry.outcome_id);
 assert.equal((await get(`/event-outcomes/${entry.outcome_id}`)).status,404);
 assert.equal((await (await get(`/event-highlights/${eventId}/outcomes`)).json()).items.length,0);
 assert.equal((await (await get(`/event-outcome-backlinks/skill_book/${ref.id}`)).json()).items.length,0);
});

test('guild publisher revocation closes recaps, bound media and backlinks for remaining members',async()=>{
 const guild=(await pool.query('SELECT guild_key FROM positioning_guild_catalog ORDER BY guild_key LIMIT 1')).rows[0].guild_key;
 for(const actor of actors.slice(0,2))await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,'active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active',left_at=NULL`,[randomUUID(),DEMO_COMMUNITY,actor.user_id,guild]);
 await pool.query("UPDATE community_events SET visibility='guild',guild_key=$2,event_kind='guild_skill_exchange' WHERE event_id=$1",[eventId,guild]);
 const ref={kind:'skill_book' as const,id:communityCatalog.skill_books[0]!.id};
 const entry=await draft([ref],'guild'),media=await originalMedia();
 await transaction(pool,q=>validateAndBindEventOutcomeMedia(q,actors[0]!,eventId,entry.outcome_id,media));
 await publishEventOutcome(pool,input('publish',{consent_to_share:true},1),entry.outcome_id);
 assert.equal((await readPublishedEventOutcome(pool,entry.outcome_id,viewer(actors[1]!))).outcome_id,entry.outcome_id);
 assert.equal((await readEventOutcomeMediaAuthorization(pool,media,viewer(actors[1]!)))?.authorized,true);
 assert.equal((await listEventOutcomeBacklinks(pool,ref,viewer(actors[1]!))).items.length,1);
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key=$2",[actors[0]!.user_id,guild]);
 await assert.rejects(readPublishedEventOutcome(pool,entry.outcome_id,viewer(actors[1]!)),is404);
 assert.equal((await readEventOutcomeMediaAuthorization(pool,media,viewer(actors[1]!)))?.authorized,false);
 assert.equal((await listEventOutcomeBacklinks(pool,ref,viewer(actors[1]!))).items.length,0);
 await assert.rejects(draft([ref],'guild'),is404);
 const withdrawn=await withdrawEventOutcome(pool,input('withdraw',{},2),entry.outcome_id);
 await assert.rejects(publishEventOutcome(pool,input('publish',{consent_to_share:true},withdrawn.aggregate_version),entry.outcome_id),is404);
});
