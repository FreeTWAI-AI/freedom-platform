import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {command,transaction,checkVersion,type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import type {Actor} from '../identity-membership/service.js';
import {adminCommand,audit,type AdminActor,type AdminCommand} from '../platform-admin/service.js';
import {communityCatalog} from '../community/catalog.js';
import {getSkillCollaboration,type SkillEditorial} from '../community/skill-collaboration.js';

const text=(max:number,min=1)=>z.string().trim().min(min).max(max).refine(s=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s),'請移除控制字元。');
const id=text(64).regex(/^[A-Za-z0-9_-]+$/);
const announcementInput=z.object({title:text(120),body:text(6000),state:z.enum(['draft','published','archived'])}).strict();
const threadInput=z.object({title:text(120),body:text(6000)}).strict();
const replyInput=z.object({body:text(6000)}).strict();
const editorialInput=z.object({summary:text(240),collaboration_intro:text(3000),milestones:z.array(z.object({id,title:text(120)}).strict()).max(8),tasks:z.array(z.object({id,title:text(120),description:text(1500),acceptance:z.array(text(300)).min(1).max(5),issue_url:z.string().max(500).nullable(),milestone_id:id.nullable(),status:z.enum(['todo','in_progress','done'])}).strict()).max(12)}).strict();
const publicEditorialColumns='summary,collaboration_intro,milestones,tasks,updated_at,aggregate_version';
function book(bookId:string){const found=communityCatalog.skill_books.find(b=>b.id===bookId);requireCondition(found,404,'skill_not_found','找不到這本技能書。');return found;}
function editorial(row:any):SkillEditorial{return {...row,updated_at:new Date(row.updated_at).toISOString(),aggregate_version:Number(row.aggregate_version)};}
function announcement(row:any){return {announcement_id:row.announcement_id,guild_key:row.guild_key,title:row.title,body:row.body,state:row.state,aggregate_version:Number(row.aggregate_version),created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString()};}
async function activeMember(q:PoolClient,actor:Actor){
 requireCondition((await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 AND active FOR SHARE',[actor.user_id,actor.community_id])).rowCount===1,401,'session_expired','請重新登入。');
 requireCondition((await q.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE',[actor.session_hash,actor.user_id])).rowCount===1,401,'session_expired','請重新登入。');
}
async function activeAdmin(q:PoolClient,admin:AdminActor){requireCondition((await q.query('SELECT 1 FROM platform_admins WHERE admin_id=$1 AND community_id=$2 AND email=$3 AND active FOR SHARE',[admin.admin_id,admin.community_id,admin.email])).rowCount===1,403,'admin_required','管理權限已變更。');}
async function guildMembership(q:PoolClient,actor:Actor,key:string){requireCondition((await q.query("SELECT 1 FROM positioning_profession_memberships WHERE community_id=$1 AND user_id=$2 AND guild_key=$3 AND state='active' FOR SHARE",[actor.community_id,actor.user_id,key])).rowCount===1,403,'guild_member_required','加入公會後可閱讀公告。');}
async function managedGuilds(q:PoolClient,actor:Actor){return (await q.query(`SELECT g.guild_key,g.name FROM positioning_guild_officers o JOIN positioning_guild_catalog g USING(guild_key)
 JOIN positioning_profession_memberships m ON m.community_id=o.community_id AND m.guild_key=o.guild_key AND m.user_id=o.user_id AND m.state='active'
 WHERE o.community_id=$1 AND o.user_id=$2 ORDER BY g.guild_key FOR SHARE OF m,o`,[actor.community_id,actor.user_id])).rows;}
async function leader(q:PoolClient,actor:Actor,key?:string){const rows=await managedGuilds(q,actor);requireCondition(key?rows.some(g=>g.guild_key===key):rows.length>0,403,'guild_leader_required','此操作限目前在任的公會長。');}
async function maintainer(q:PoolClient,actor:Actor,bookId:string){book(bookId);requireCondition((await q.query('SELECT 1 FROM skill_book_maintainers WHERE community_id=$1 AND user_id=$2 AND book_id=$3 AND active FOR SHARE',[actor.community_id,actor.user_id,bookId])).rowCount===1,403,'skill_maintainer_required','此操作限這本技能書的維護者。');}

export async function guildWorkspace(pool:Pool,actor:Actor){return transaction(pool,async q=>{await activeMember(q,actor);const guilds=await managedGuilds(q,actor);const rows=(await q.query('SELECT book_id FROM skill_book_maintainers WHERE community_id=$1 AND user_id=$2 AND active',[actor.community_id,actor.user_id])).rows;return {managed_guilds:guilds,managed_books:rows.flatMap(row=>{const found=communityCatalog.skill_books.find(b=>b.id===row.book_id);return found?[{book_id:found.id,title:found.title}]:[]}),can_discuss:guilds.length>0};});}
export async function guildAnnouncements(pool:Pool,actor:Actor,key:string){return transaction(pool,async q=>{await activeMember(q,actor);await guildMembership(q,actor,key);const isLeader=(await managedGuilds(q,actor)).some(g=>g.guild_key===key);return {items:(await q.query("SELECT * FROM guild_announcements WHERE community_id=$1 AND guild_key=$2 AND ($3 OR state='published') ORDER BY created_at DESC,announcement_id LIMIT 100",[actor.community_id,key,isLeader])).rows.map(announcement),can_publish:isLeader};});}
export async function createGuildAnnouncement(pool:Pool,input:Command,key:string){const body=announcementInput.parse(input.body);requireCondition(body.state!=='archived',422,'announcement_state_invalid','新公告請選草稿或發布。');return command(pool,input,q=>leader(q,input.actor,key),async q=>{const row=(await q.query('INSERT INTO guild_announcements(announcement_id,community_id,guild_key,author_user_id,title,body,state) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),input.actor.community_id,key,input.actor.user_id,body.title,body.body,body.state])).rows[0];return announcement(row);});}
export async function editGuildAnnouncement(pool:Pool,input:Command,announcementId:string){z.uuid().parse(announcementId);const body=announcementInput.parse(input.body);const scoped=async(q:PoolClient,lock=false)=>{const row=(await q.query(`SELECT * FROM guild_announcements WHERE community_id=$1 AND announcement_id=$2${lock?' FOR UPDATE':''}`,[input.actor.community_id,announcementId])).rows[0];requireCondition(row,404,'announcement_not_found','找不到這則公告。');return row;};return command(pool,input,async q=>{const row=await scoped(q);await leader(q,input.actor,row.guild_key);},async q=>{const prior=await scoped(q,true);checkVersion(prior.aggregate_version,input.expected);return announcement((await q.query('UPDATE guild_announcements SET title=$2,body=$3,state=$4,aggregate_version=aggregate_version+1,updated_at=now() WHERE announcement_id=$1 RETURNING *',[announcementId,body.title,body.body,body.state])).rows[0]);});}

/** Only intentionally public editorial fields; no maintainer, member or council facts. */
export async function readSkillEditorial(pool:Pool,bookId:string):Promise<SkillEditorial|null>{book(bookId);const row=(await pool.query(`SELECT ${publicEditorialColumns} FROM skill_book_editorial WHERE book_id=$1`,[bookId])).rows[0];return row?editorial(row):null;}
export async function readSkillEditorialSummaries(pool:Pool):Promise<Record<string,string>>{const known=new Set(communityCatalog.skill_books.map(b=>b.id));return Object.fromEntries((await pool.query('SELECT book_id,summary FROM skill_book_editorial')).rows.filter(r=>known.has(r.book_id)).map(r=>[r.book_id,r.summary]));}
function initialEditorial(bookId:string){
 const collaboration=getSkillCollaboration(bookId);
 requireCondition(collaboration,500,'skill_collaboration_missing','技能書協作指引尚未就緒。');
 // Populate the form from what members already read. Merely opening an editor
 // never creates an editorial or attributes the suggested plan to a maintainer.
 return {summary:book(bookId).description,collaboration_intro:collaboration.intent.summary,
  milestones:collaboration.milestones.map(({id,title})=>({id,title})),
  tasks:collaboration.tasks.map(task=>({id:task.id,title:task.title,description:task.scope,
   acceptance:[...task.acceptance],issue_url:task.source_url,
   milestone_id:collaboration.milestones.find(m=>m.task_ids.includes(task.id))?.id??null,status:'todo' as const})),
  updated_at:null,aggregate_version:0};
}
export async function skillEditor(pool:Pool,actor:Actor,bookId:string){return transaction(pool,async q=>{await activeMember(q,actor);await maintainer(q,actor,bookId);const row=(await q.query(`SELECT ${publicEditorialColumns} FROM skill_book_editorial WHERE book_id=$1 AND community_id=$2`,[bookId,actor.community_id])).rows[0];return {book_id:bookId,...(row?editorial(row):initialEditorial(bookId))};});}
export async function saveSkillEditorial(pool:Pool,input:Command,bookId:string){
 const source=book(bookId),body=editorialInput.parse(input.body);
 requireCondition(Buffer.byteLength(JSON.stringify(body),'utf8')<=12000,422,'editorial_too_large','技能書摘要與待辦合計請控制在 12 KB 內。');
 const milestones=new Set(body.milestones.map(m=>m.id)),tasks=new Set(body.tasks.map(t=>t.id));requireCondition(milestones.size===body.milestones.length&&tasks.size===body.tasks.length,422,'editorial_duplicate_id','里程碑與任務代號不可重複。');
 for(const task of body.tasks){requireCondition(task.milestone_id===null||milestones.has(task.milestone_id),422,'editorial_milestone_missing','任務必須連到已列出的里程碑。');if(task.issue_url!==null){let valid=false;try{const u=new URL(task.issue_url);valid=[source.repository_url,source.upstream_url].some(url=>u.origin==='https://github.com'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&new RegExp('^'+new URL(url).pathname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/issues/[1-9][0-9]*$').test(u.pathname));}catch{}requireCondition(valid,422,'editorial_issue_invalid','Issue 請連到這本技能書的工坊或原作者 GitHub 專案。');}}
 return command(pool,input,q=>maintainer(q,input.actor,bookId),async q=>{
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`skill-editorial/${bookId}`]);
  const prior=(await q.query('SELECT aggregate_version FROM skill_book_editorial WHERE book_id=$1 AND community_id=$2 FOR UPDATE',[bookId,input.actor.community_id])).rows[0];
  if(prior)checkVersion(prior.aggregate_version,input.expected);else requireCondition(!input.expected,412,'version_conflict','技能書內容已變更，請重新整理。');
  const row=(await q.query(`INSERT INTO skill_book_editorial(book_id,community_id,summary,collaboration_intro,milestones,tasks,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(book_id) DO UPDATE SET summary=$3,collaboration_intro=$4,milestones=$5,tasks=$6,updated_by=$7,updated_at=now(),aggregate_version=skill_book_editorial.aggregate_version+1
 WHERE skill_book_editorial.community_id=$2 RETURNING ${publicEditorialColumns}`,[bookId,input.actor.community_id,body.summary,body.collaboration_intro,JSON.stringify(body.milestones),JSON.stringify(body.tasks),input.actor.user_id])).rows[0];requireCondition(row,403,'editorial_scope_denied','這本技能書由另一個社群維護。');return {book_id:bookId,...editorial(row)};
 });
}
export async function listSkillMaintainers(pool:Pool,admin:AdminActor){return transaction(pool,async q=>{await activeAdmin(q,admin);const rows=(await q.query(`SELECT m.book_id,m.user_id,u.display_name,m.active,m.aggregate_version FROM skill_book_maintainers m JOIN users u ON u.user_id=m.user_id AND u.community_id=m.community_id WHERE m.community_id=$1 ORDER BY u.display_name`,[admin.community_id])).rows;return {items:communityCatalog.skill_books.map(b=>({book_id:b.id,title:b.title,maintainers:rows.filter(r=>r.book_id===b.id).map(r=>({user_id:r.user_id,display_name:r.display_name,active:r.active,aggregate_version:Number(r.aggregate_version)}))}))};});}
export async function appointSkillMaintainer(pool:Pool,input:AdminCommand,bookId:string){
 book(bookId);const body=z.object({user_id:z.uuid(),active:z.boolean(),reason:text(1000,3)}).strict().parse(input.body);
 return adminCommand(pool,input,async q=>{requireCondition((await q.query(`SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2 ${body.active?'AND active':''} FOR SHARE`,[body.user_id,input.admin.community_id])).rowCount===1,422,'active_member_required','請選擇這個社群的有效會員。');},async q=>{
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`skill-maintainer/${bookId}`]);
  const owner=(await q.query('SELECT community_id FROM skill_editorial_ownership WHERE book_id=$1 FOR UPDATE',[bookId])).rows[0];
  if(owner)requireCondition(owner.community_id===input.admin.community_id,403,'editorial_scope_denied','這本技能書由另一個社群維護。');
  else{requireCondition(body.active,409,'maintainer_missing','尚未任命這本技能書的維護者。');requireCondition((await q.query('SELECT count(*)::int AS n FROM communities')).rows[0].n===1,409,'editorial_owner_required','多社群資料庫需先確認這本技能書的管理社群。');await q.query('INSERT INTO skill_editorial_ownership(book_id,community_id) VALUES($1,$2)',[bookId,input.admin.community_id]);}
  const prior=(await q.query('SELECT * FROM skill_book_maintainers WHERE book_id=$1 AND user_id=$2 FOR UPDATE',[bookId,body.user_id])).rows[0];
  if(prior)checkVersion(prior.aggregate_version,input.expected);else requireCondition(!input.expected,412,'version_conflict','維護者資料已變更，請重新整理。');
  const updated=(await q.query(`INSERT INTO skill_book_maintainers(book_id,community_id,user_id,appointed_by,active) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(book_id,user_id) DO UPDATE SET active=$5,appointed_by=$4,appointed_at=now(),aggregate_version=skill_book_maintainers.aggregate_version+1 RETURNING book_id,user_id,active,aggregate_version`,[bookId,input.admin.community_id,body.user_id,input.admin.admin_id,body.active])).rows[0];
  await audit(q,input.admin,'skill_maintainer','skill_book',bookId,body.reason,prior?{user_id:prior.user_id,active:prior.active}:null,updated);return {...updated,aggregate_version:Number(updated.aggregate_version)};
 });
}

type CouncilIdentity={community_id:string;user_id?:string;admin_id?:string};
const threadFields=`t.thread_id,t.title,t.body,t.created_at,COALESCE(u.display_name,a.display_name,'已移除的成員') AS author_name`;
const threadJoins='LEFT JOIN users u ON u.user_id=t.author_user_id LEFT JOIN platform_admins a ON a.admin_id=t.author_admin_id';
async function councilThread(q:PoolClient,who:CouncilIdentity,threadId:string){
 z.uuid().parse(threadId);const row=(await q.query(`SELECT ${threadFields} FROM guild_council_threads t ${threadJoins} WHERE t.thread_id=$1 AND t.community_id=$2`,[threadId,who.community_id])).rows[0];requireCondition(row,404,'council_thread_not_found','找不到這篇公會議事。');
 const replies=(await q.query(`SELECT r.reply_id,r.body,r.created_at,COALESCE(u.display_name,a.display_name,'已移除的成員') AS author_name FROM guild_council_replies r LEFT JOIN users u ON u.user_id=r.author_user_id LEFT JOIN platform_admins a ON a.admin_id=r.author_admin_id WHERE r.thread_id=$1 AND r.community_id=$2 ORDER BY r.created_at,r.reply_id LIMIT 200`,[threadId,who.community_id])).rows;return {...row,replies};
}
async function councilList(q:PoolClient,who:CouncilIdentity){return {items:(await q.query(`SELECT ${threadFields},(SELECT count(*)::int FROM guild_council_replies r WHERE r.thread_id=t.thread_id AND r.community_id=t.community_id) AS reply_count FROM guild_council_threads t ${threadJoins} WHERE t.community_id=$1 ORDER BY t.created_at DESC,t.thread_id LIMIT 100`,[who.community_id])).rows};}
async function createThread(q:PoolClient,who:CouncilIdentity,body:z.infer<typeof threadInput>){const threadId=randomUUID();await q.query('INSERT INTO guild_council_threads(thread_id,community_id,author_user_id,author_admin_id,title,body) VALUES($1,$2,$3,$4,$5,$6)',[threadId,who.community_id,who.user_id??null,who.admin_id??null,body.title,body.body]);return councilThread(q,who,threadId);}
async function createReply(q:PoolClient,who:CouncilIdentity,threadId:string,body:z.infer<typeof replyInput>){await councilThread(q,who,threadId);const row=(await q.query('INSERT INTO guild_council_replies(reply_id,community_id,thread_id,author_user_id,author_admin_id,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING reply_id,body,created_at',[randomUUID(),who.community_id,threadId,who.user_id??null,who.admin_id??null,body.body])).rows[0];return row;}
export async function listGuildCouncil(pool:Pool,actor:Actor){return transaction(pool,async q=>{await activeMember(q,actor);await leader(q,actor);return councilList(q,actor);});}
export async function getGuildCouncilThread(pool:Pool,actor:Actor,threadId:string){return transaction(pool,async q=>{await activeMember(q,actor);await leader(q,actor);return councilThread(q,actor,threadId);});}
export async function createGuildCouncilThread(pool:Pool,input:Command){const body=threadInput.parse(input.body);return command(pool,input,q=>leader(q,input.actor),q=>createThread(q,input.actor,body));}
export async function replyGuildCouncilThread(pool:Pool,input:Command,threadId:string){const body=replyInput.parse(input.body);return command(pool,input,q=>leader(q,input.actor),q=>createReply(q,input.actor,threadId,body));}
export async function listAdminCouncil(pool:Pool,admin:AdminActor){return transaction(pool,async q=>{await activeAdmin(q,admin);return councilList(q,admin);});}
export async function getAdminCouncilThread(pool:Pool,admin:AdminActor,threadId:string){return transaction(pool,async q=>{await activeAdmin(q,admin);return councilThread(q,admin,threadId);});}
export async function createAdminCouncilThread(pool:Pool,input:AdminCommand){const body=threadInput.parse(input.body);return adminCommand(pool,input,async()=>{},async q=>{const value=await createThread(q,input.admin,body);await audit(q,input.admin,'council_thread','guild_council',value.thread_id,'建立公會議事',null,{thread_id:value.thread_id});return value;});}
export async function replyAdminCouncilThread(pool:Pool,input:AdminCommand,threadId:string){const body=replyInput.parse(input.body);return adminCommand(pool,input,async()=>{},async q=>{const value=await createReply(q,input.admin,threadId,body);await audit(q,input.admin,'council_reply','guild_council',threadId,'回覆公會議事',null,{reply_id:value.reply_id});return value;});}
