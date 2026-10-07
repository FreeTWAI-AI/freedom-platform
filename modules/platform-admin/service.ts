import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {transaction,digest,checkVersion} from '../../packages/db/index.js';
import {communityCatalog} from '../community/catalog.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {authorizeGuildAppointee,ensureGuildAppointeeMembership} from './guild-appointment-membership.js';
import {notifyGuildApplicationReview,notifyGuildMasterChange} from '../member-communications/events.js';
import {BackfillInput,ClassificationInput,SwitchInput} from '../../contracts/guild-launchpad/v1/guild-preferences.js';
import {backfillInTransaction,classifyInTransaction,seedPendingClassification,switchInTransaction} from '../positioning/guild-categories.js';
import {applyOwnerAccountStatus} from '../tenant-workspaces/security-path.js';

export type VerifiedAdminIdentity={email:string;subject:string;csrfToken:string};
export type AdminActor={admin_id:string;community_id:string;email:string;display_name:string;role:'super_admin';subject:string};
export type AdminCommand={admin:AdminActor;operation:string;key:string;body:unknown;expected?:string};
const reason=z.string().trim().min(3).max(1000);
const administrativeMember=`user_id,email,display_name,active,onboarding_required,onboarding_completed_at,onboarding_entry_mode,email_verified_at,admin_status_version AS aggregate_version`;
const adminAccessStateSql=(alias:string)=>`CASE WHEN ${alias}.active THEN CASE WHEN ${alias}.access_synced_version=${alias}.aggregate_version THEN 'ready' ELSE 'pending' END ELSE CASE WHEN ${alias}.access_synced_version=${alias}.aggregate_version THEN 'revoked' ELSE 'pending_removal' END END`;
function withAdminAccessState(row:any){
  const aggregate_version=Number(row.aggregate_version),access_synced_version=row.access_synced_version===null?null:Number(row.access_synced_version);
  return {...row,aggregate_version,access_synced_version,access_state:row.active?(access_synced_version===aggregate_version?'ready':'pending'):(access_synced_version===aggregate_version?'revoked':'pending_removal')};
}

export async function authenticateAdmin(q:Pool|PoolClient,identity:VerifiedAdminIdentity):Promise<AdminActor>{
  const email=z.email().max(200).parse(identity.email).toLowerCase();
  const row=(await q.query('SELECT admin_id,community_id,email,display_name,role FROM platform_admins WHERE email=$1 AND active',[email])).rows[0];
  requireCondition(row,403,'admin_required','這個已驗證身分沒有平台管理權限。');
  return {...row,subject:identity.subject};
}
function publicAdmin(admin:AdminActor){return {admin_id:admin.admin_id,community_id:admin.community_id,email:admin.email,display_name:admin.display_name,role:admin.role};}
export async function adminCommand<T>(pool:Pool,input:AdminCommand,authorize:(q:PoolClient)=>Promise<unknown>,run:(q:PoolClient)=>Promise<T>,lockRoles=false,revalidate?:(q:PoolClient)=>Promise<unknown>):Promise<T>{
  requireCondition(/^[A-Za-z0-9_-]{8,128}$/.test(input.key),400,'idempotency_required','請提供有效的 Idempotency-Key。');
  return transaction(pool,async q=>{
    // Role mutations and Access synchronization serialize before locking the
    // acting admin. Otherwise two admins revoking one another can deadlock.
    if(lockRoles)await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`admin-roles/${input.admin.community_id}`]);
    requireCondition((await q.query('SELECT 1 FROM platform_admins WHERE admin_id=$1 AND community_id=$2 AND email=$3 AND active FOR SHARE',[input.admin.admin_id,input.admin.community_id,input.admin.email])).rowCount===1,403,'admin_required','管理權限已變更，請重新整理。');
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`admin-command/${input.admin.admin_id}/${input.operation}/${input.key}`]);
    await authorize(q);
    const hash=digest({body:input.body,expected:input.expected??null}),prior=(await q.query('SELECT * FROM platform_admin_receipts WHERE admin_id=$1 AND operation=$2 AND idempotency_key=$3',[input.admin.admin_id,input.operation,input.key])).rows[0];
    if(prior){
      requireCondition(prior.request_sha256===hash,409,'idempotency_conflict','同一操作識別碼不可搭配不同內容。');
      if(revalidate)await revalidate(q);
      return prior.response as T;
    }
    const result=await run(q);
    await q.query('INSERT INTO platform_admin_receipts(admin_id,operation,idempotency_key,request_sha256,response) VALUES($1,$2,$3,$4,$5)',[input.admin.admin_id,input.operation,input.key,hash,JSON.stringify(result)]);
    if(revalidate)await revalidate(q);
    return result;
  });
}
export async function audit(q:PoolClient,admin:AdminActor,action:string,type:string,ref:string,why:string,before:unknown,after:unknown){
  await q.query('INSERT INTO platform_admin_audit(audit_id,community_id,admin_id,verified_access_subject,action,target_type,target_ref,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),admin.community_id,admin.admin_id,admin.subject,action,type,ref,why,JSON.stringify(before),JSON.stringify(after)]);
}
export async function adminBootstrap(pool:Pool,admin:AdminActor){
  const summary=(await pool.query(`SELECT (SELECT count(*)::int FROM users u JOIN member_account_classification t USING(user_id,community_id) WHERE u.community_id=$1 AND NOT t.is_test_account) AS members,
    (SELECT count(*)::int FROM users u JOIN member_account_classification t USING(user_id,community_id) WHERE u.community_id=$1 AND u.active AND NOT t.is_test_account) AS active_members,
    (SELECT count(*)::int FROM guild_creation_applications a WHERE a.community_id=$1 AND a.state='pending' AND NOT is_verification_test_account(a.user_id)) AS pending_guild_applications,
    (SELECT count(*)::int FROM positioning_guild_catalog) AS guilds,
    (SELECT count(*)::int FROM platform_admins WHERE community_id=$1 AND active) AS admins`,[admin.community_id])).rows[0];
  return {admin:publicAdmin(admin),summary,available_skill_books:communityCatalog.skill_books};
}
export async function adminMembers(pool:Pool,admin:AdminActor,limit:number,offset:number,search='',includeTest=false){
  const rows=(await pool.query(`SELECT u.${administrativeMember.replaceAll(',',',u.')},t.is_test_account,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('guild_key',m.guild_key,'name',g.name)) FROM positioning_profession_memberships m JOIN positioning_guild_catalog g USING(guild_key) WHERE m.user_id=u.user_id AND m.community_id=u.community_id AND m.state='active'),'[]'::jsonb) AS guilds,
    CASE WHEN a.admin_id IS NULL THEN NULL ELSE jsonb_build_object('admin_id',a.admin_id,'active',a.active,'aggregate_version',a.aggregate_version,'access_state',${adminAccessStateSql('a')}) END AS platform_admin
    FROM users u JOIN member_account_classification t USING(user_id,community_id)
    LEFT JOIN platform_admins a ON a.community_id=u.community_id AND a.email=lower(u.email)
    WHERE u.community_id=$1 AND ($5 OR NOT t.is_test_account) AND ($4='' OR strpos(lower(u.display_name),lower($4))>0 OR strpos(lower(u.email),lower($4))>0)
    ORDER BY u.display_name,u.user_id LIMIT $2 OFFSET $3`,[admin.community_id,limit+1,offset,search,includeTest])).rows;
  return {items:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null};
}
async function scopedUser(q:PoolClient,admin:AdminActor,id:string,lock=false){
  const row=(await q.query(`SELECT ${administrativeMember} FROM users WHERE user_id=$1 AND community_id=$2${lock?' FOR UPDATE':''}`,[id,admin.community_id])).rows[0];
  requireCondition(row,404,'member_not_found','找不到這個社群的會員。');return row;
}
export async function changeMemberStatus(pool:Pool,input:AdminCommand,id:string){
  z.uuid().parse(id);const body=z.object({active:z.boolean(),reason}).strict().parse(input.body);
  return adminCommand(pool,input,async q=>{
    await scopedUser(q,input.admin,id);
  },async q=>{
    const prior=await scopedUser(q,input.admin,id,true);checkVersion(prior.aggregate_version,input.expected);
    const updated=(await q.query(`UPDATE users SET active=$2,admin_status_version=admin_status_version+1 WHERE user_id=$1 RETURNING ${administrativeMember}`,[id,body.active])).rows[0];
    if(!body.active){await q.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1',[id]);await q.query('UPDATE member_client_connections SET revoked_at=COALESCE(revoked_at,now()),aggregate_version=aggregate_version+1 WHERE user_id=$1 AND revoked_at IS NULL',[id]);}
    await applyOwnerAccountStatus(q,id,body.active);
    await audit(q,input.admin,'member_status','member',id,body.reason,{active:prior.active,aggregate_version:prior.aggregate_version},{active:updated.active,aggregate_version:updated.aggregate_version});return updated;
  });
}
export async function adminApplications(pool:Pool,admin:AdminActor,limit:number,offset:number,state:string){
  const rows=(await pool.query(`SELECT a.*,u.display_name AS applicant_name,u.email AS applicant_email,g.name AS approved_guild_name,g.alias AS approved_guild_alias
    FROM guild_creation_applications a JOIN users u ON u.user_id=a.user_id AND u.community_id=a.community_id
    LEFT JOIN positioning_guild_catalog g ON g.guild_key=a.approved_guild_key
    WHERE a.community_id=$1 AND ($4='all' OR a.state=$4) AND NOT is_verification_test_account(a.user_id) ORDER BY a.created_at,a.application_id LIMIT $2 OFFSET $3`,[admin.community_id,limit+1,offset,state])).rows;
  return {items:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null};
}
const singleLine=(max:number,min=0)=>z.string().trim().min(min).max(max).refine(value=>!/[\x00-\x1f\x7f]/.test(value),'請使用單行文字。');
const guildKeySchema=z.string().min(1).max(100).regex(/^(guild_[a-z0-9_]+|guild_custom_[0-9A-Fa-f]{32})$/);
const customGuildKey=/^guild_custom_[0-9A-Fa-f]{32}$/;
const GuildInput=z.object({name:singleLine(100,2),purpose:z.string().trim().min(5).max(1000),first_step:z.string().trim().min(5).max(1000),module_key:z.enum(['positioning','supplier','retail','marketing','workbench','guilds','engagement','opensource']),skill_book_ids:z.array(z.string().min(1).max(100)).min(1).max(20).refine(ids=>new Set(ids).size===ids.length,'技能書不可重複。'),alias:singleLine(100).optional(),profession_title:singleLine(40).optional()}).strict();
const MergeTarget=z.object({guild_key:guildKeySchema,alias:singleLine(100).optional()}).strict();
const GuildProfileInput=z.object({name:singleLine(100,2).optional(),alias:singleLine(100),profession_title:singleLine(40).optional(),reason}).strict();
function profileSnapshot(row:{name:string;alias:string;profession_title:string;catalog_version:number|string}){
  return {name:row.name,alias:row.alias,profession_title:row.profession_title,catalog_version:Number(row.catalog_version)};
}
async function aliasConflicts(q:PoolClient,alias:string,guildKey:string,ownName:string){
  if(!alias)return;
  const hit=await q.query(`SELECT 1 FROM positioning_guild_catalog WHERE lower(name)=lower($1) AND guild_key<>$2 UNION ALL SELECT 1 WHERE lower($1)=lower($3) LIMIT 1`,[alias,guildKey,ownName]);
  requireCondition(!hit.rowCount,409,'guild_alias_conflict','別名不可與公會名稱相同。');
}
export async function updateGuildProfile(pool:Pool,input:AdminCommand,key:string){
  guildKeySchema.parse(key);const body=GuildProfileInput.parse(input.body);
  return adminCommand(pool,input,async()=>{},async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['admin-guild-catalog']);
    const current=(await q.query('SELECT * FROM positioning_guild_catalog WHERE guild_key=$1 FOR UPDATE',[key])).rows[0];
    requireCondition(current,404,'guild_not_found','找不到這個公會。');
    checkVersion(String(current.catalog_version),input.expected);
    const custom=customGuildKey.test(key);
    if(!custom){
      const nameLocked=body.name!==undefined&&body.name!==current.name;
      const titleLocked=body.profession_title!==undefined&&body.profession_title!==current.profession_title;
      requireCondition(!nameLocked&&!titleLocked,422,'guild_builtin_locked','內建公會只能調整別名。');
    }
    const next={name:body.name??current.name,alias:body.alias,profession_title:body.profession_title??current.profession_title};
    requireCondition(next.name!==current.name||next.alias!==current.alias||next.profession_title!==current.profession_title,422,'guild_profile_unchanged','沒有需要更新的內容。');
    requireCondition(!(await q.query('SELECT 1 FROM positioning_guild_catalog WHERE lower(name)=lower($1) AND guild_key<>$2',[next.name,key])).rowCount,409,'guild_name_exists','已存在相同名稱的公會。');
    await aliasConflicts(q,next.alias,key,next.name);
    const updated=(await q.query('UPDATE positioning_guild_catalog SET name=$2,alias=$3,profession_title=$4,catalog_version=catalog_version+1 WHERE guild_key=$1 RETURNING *',[key,next.name,next.alias,next.profession_title])).rows[0];
    await audit(q,input.admin,'guild_profile_update','guild',key,body.reason,profileSnapshot(current),profileSnapshot(updated));
    return {...updated,aggregate_version:Number(updated.catalog_version)};
  });
}
export async function reviewGuildApplication(pool:Pool,input:AdminCommand,id:string){
  z.uuid().parse(id);const body=z.object({decision:z.enum(['approve','merge','reject']),reason,guild:GuildInput.optional(),merge:MergeTarget.optional()}).strict().parse(input.body);
  const shapeOk=body.decision==='approve'?!!body.guild&&!body.merge:body.decision==='merge'?!!body.merge&&!body.guild:!body.guild&&!body.merge;
  requireCondition(shapeOk,422,'review_details_required','核准需填完整公會設定、併入需選擇公會；拒絕請只填理由。');
  const scoped=async(q:PoolClient,lock=false)=>{const row=(await q.query(`SELECT * FROM guild_creation_applications WHERE application_id=$1 AND community_id=$2${lock?' FOR UPDATE':''}`,[id,input.admin.community_id])).rows[0];requireCondition(row,404,'application_not_found','找不到這個公會申請。');return row;};
  return adminCommand(pool,input,q=>scoped(q),async q=>{
    const previous=await scoped(q,true);checkVersion(previous.aggregate_version,input.expected);requireCondition(previous.state==='pending',409,'application_reviewed','這件申請已完成審查。');
    let guildKey:string|null=null,aliasBefore:string|null=null,aliasAfter:string|null=null,aliasSet='';
    if(body.decision==='approve'||body.decision==='merge')await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['admin-guild-catalog']);
    if(body.decision==='approve'){
      requireCondition((await q.query('SELECT count(*)::int AS n FROM communities')).rows[0].n===1,409,'guild_catalog_scope_required','多社群資料庫需先隔離公會目錄，才能核准建立新公會。');
      requireCondition(!(await q.query('SELECT 1 FROM positioning_guild_catalog WHERE lower(name)=lower($1)',[body.guild!.name])).rowCount,409,'guild_name_exists','已存在相同名稱的公會。');
      requireCondition(body.guild!.skill_book_ids.every(bookId=>communityCatalog.skill_books.some(book=>book.id===bookId)),422,'unknown_skill_book','請從平台技能書目錄選擇。');
      guildKey='guild_custom_'+id.replaceAll('-','');
      const alias=body.guild!.alias??'',title=body.guild!.profession_title??'';
      await aliasConflicts(q,alias,guildKey,body.guild!.name);
      await q.query('INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key,alias,profession_title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[guildKey,'custom_'+id.replaceAll('-',''),body.guild!.name,body.guild!.purpose,body.guild!.first_step,body.guild!.module_key,alias,title]);
      await seedPendingClassification(q,guildKey);
      for(const bookId of body.guild!.skill_book_ids)await q.query('INSERT INTO guild_skill_book_bindings(community_id,guild_key,book_id) VALUES($1,$2,$3)',[input.admin.community_id,guildKey,bookId]);
    }
    if(body.decision==='merge'){
      const target=(await q.query('SELECT * FROM positioning_guild_catalog WHERE guild_key=$1 FOR UPDATE',[body.merge!.guild_key])).rows[0];
      requireCondition(target,404,'guild_not_found','找不到這個公會。');
      guildKey=target.guild_key;aliasBefore=target.alias;aliasAfter=target.alias;
      const alias=body.merge!.alias??'';
      if(alias){
        await aliasConflicts(q,alias,target.guild_key,target.name);
        const renamed=(await q.query('UPDATE positioning_guild_catalog SET alias=$2,catalog_version=catalog_version+1 WHERE guild_key=$1 RETURNING alias',[target.guild_key,alias])).rows[0];
        aliasAfter=renamed.alias;aliasSet=alias;
      }
    }
    const updated=(await q.query(`UPDATE guild_creation_applications SET state=$2,aggregate_version=aggregate_version+1,reviewed_by=$3,reviewed_at=now(),review_reason=$4,approved_guild_key=$5 WHERE application_id=$1 RETURNING *`,[id,body.decision==='reject'?'declined':'approved',input.admin.admin_id,body.reason,guildKey])).rows[0];
    await notifyGuildApplicationReview(q,updated,aliasSet?{alias_set:aliasSet}:undefined);
    const after:Record<string,unknown>={state:updated.state,aggregate_version:updated.aggregate_version,decision:body.decision,guild_key:guildKey,guild:body.guild??null};
    if(body.decision==='merge'){after.alias_before=aliasBefore;after.alias_after=aliasAfter;}
    await audit(q,input.admin,'guild_application_review','guild_application',id,body.reason,{state:previous.state,aggregate_version:previous.aggregate_version},after);return updated;
  });
}
export async function classifyGuild(pool:Pool,input:AdminCommand,key:string){
  const body=ClassificationInput.parse(input.body);
  return adminCommand(pool,input,async()=>{},async q=>{
    const result=await classifyInTransaction(q,input.admin,key,body,input.expected);
    await audit(q,input.admin,'guild_classification','guild',key,body.reason,result.before,result.classification);
    return {classification:result.classification,invalidation_operation_id:result.invalidation_operation_id};
  });
}
export async function backfillGuildPreferencesAdmin(pool:Pool,input:AdminCommand){
  const body=BackfillInput.parse(input.body);
  return adminCommand(pool,input,async()=>{},async q=>backfillInTransaction(q,{communityId:input.admin.community_id,limit:body.limit,dryRun:body.dry_run!==false}));
}
export async function switchGuildPreferencesAdmin(pool:Pool,input:AdminCommand){
  const body=SwitchInput.parse(input.body);
  return adminCommand(pool,input,async()=>{},async q=>switchInTransaction(q,{communityId:input.admin.community_id,acceptBlocked:body.accept_blocked,switchedBy:input.admin.admin_id}));
}
export async function adminGuilds(pool:Pool,admin:AdminActor){
  return (await pool.query(`SELECT g.*,o.aggregate_version AS officer_version,
    CASE WHEN u.user_id IS NULL THEN NULL ELSE jsonb_build_object('user_id',u.user_id,'display_name',u.display_name,'member_tier',(SELECT mm.member_tier FROM positioning_profession_memberships mm WHERE mm.community_id=$1 AND mm.guild_key=g.guild_key AND mm.user_id=u.user_id AND mm.state='active')) END AS guild_master,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id',eu.user_id,'display_name',eu.display_name,'active',e.active,'member_active',eu.active,'member_tier',em.member_tier,'aggregate_version',e.aggregate_version) ORDER BY eu.display_name,eu.user_id)
      FROM positioning_guild_experts e JOIN users eu ON eu.user_id=e.user_id AND eu.community_id=e.community_id
      LEFT JOIN positioning_profession_memberships em ON em.community_id=e.community_id AND em.guild_key=e.guild_key AND em.user_id=e.user_id AND em.state='active'
      WHERE e.community_id=$1 AND e.guild_key=g.guild_key AND e.active AND NOT is_verification_test_account(eu.user_id)),'[]'::jsonb) AS guild_experts,
    (SELECT count(*)::int FROM positioning_profession_memberships m JOIN users mu ON mu.user_id=m.user_id AND mu.community_id=m.community_id AND mu.active JOIN member_account_classification mt ON mt.user_id=mu.user_id AND mt.community_id=mu.community_id AND NOT mt.is_test_account WHERE m.community_id=$1 AND m.guild_key=g.guild_key AND m.state='active') AS member_count,
    (SELECT count(*)::int FROM positioning_profession_memberships m JOIN users mu ON mu.user_id=m.user_id AND mu.community_id=m.community_id AND mu.active JOIN member_account_classification mt ON mt.user_id=mu.user_id AND mt.community_id=mu.community_id AND NOT mt.is_test_account WHERE m.community_id=$1 AND m.guild_key=g.guild_key AND m.state='active' AND m.member_tier='full') AS full_member_count,
    (SELECT count(*)::int FROM positioning_profession_memberships m JOIN users mu ON mu.user_id=m.user_id AND mu.community_id=m.community_id AND mu.active JOIN member_account_classification mt ON mt.user_id=mu.user_id AND mt.community_id=mu.community_id AND NOT mt.is_test_account WHERE m.community_id=$1 AND m.guild_key=g.guild_key AND m.state='active' AND m.member_tier='intern') AS intern_member_count
    FROM positioning_guild_catalog g LEFT JOIN positioning_guild_officers o ON o.guild_key=g.guild_key AND o.community_id=$1 LEFT JOIN users u ON u.user_id=o.user_id AND u.community_id=$1 AND u.active AND NOT is_verification_test_account(u.user_id) ORDER BY g.name,g.guild_key`,[admin.community_id])).rows.map(row=>({...row,officer_version:row.officer_version?Number(row.officer_version):null}));
}
export const AdminGuildCandidateQuery=z.object({
 q:z.string().trim().max(100).refine(value=>!/[\x00-\x1f\x7f]/.test(value),'請使用單行搜尋文字。').default(''),
 scope:z.enum(['eligible','all']).default('eligible'),
 limit:z.coerce.number().int().min(1).max(100).default(20),offset:z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
export async function adminGuildMasterCandidates(pool:Pool,admin:AdminActor,key:string,raw:unknown={}){
 z.string().min(1).max(100).regex(/^(guild_[a-z0-9_]+|guild_custom_[0-9A-Fa-f]{32})$/).parse(key);
 const query=AdminGuildCandidateQuery.parse(raw);
 // Count and page share one snapshot, and eligibility is applied BEFORE LIMIT.
 // This is an admin-only projection; member email never enters public search.
 const result=(await pool.query(`WITH scoped AS (
   SELECT u.user_id,u.display_name,u.email,u.active,
    EXISTS(SELECT 1 FROM positioning_profession_memberships m WHERE m.community_id=u.community_id
      AND m.user_id=u.user_id AND m.guild_key=$2 AND m.state='active') AS joined,
    EXISTS(SELECT 1 FROM positioning_guild_officers o WHERE o.community_id=u.community_id
      AND o.guild_key=$2 AND o.user_id=u.user_id) AS is_current,
    COALESCE((SELECT e.active FROM positioning_guild_experts e WHERE e.community_id=u.community_id AND e.guild_key=$2 AND e.user_id=u.user_id),false) AS is_expert,
    (SELECT e.aggregate_version FROM positioning_guild_experts e WHERE e.community_id=u.community_id AND e.guild_key=$2 AND e.user_id=u.user_id) AS expert_version
   FROM users u JOIN member_account_classification t USING(user_id,community_id) WHERE u.community_id=$1 AND NOT t.is_test_account AND ($3='' OR strpos(lower(u.display_name),lower($3))>0 OR strpos(lower(u.email),lower($3))>0)
 ), matched AS (
   SELECT user_id,display_name,email,active,joined,active AS eligible,
    CASE WHEN NOT active THEN 'inactive' ELSE NULL END AS eligibility_reason,is_current,is_expert,expert_version
   FROM scoped WHERE $4='all' OR active
 ), page AS (SELECT * FROM matched ORDER BY display_name,user_id LIMIT $5 OFFSET $6)
 SELECT EXISTS(SELECT 1 FROM positioning_guild_catalog WHERE guild_key=$2) AS guild_exists,
   (SELECT count(*)::int FROM matched) AS total,
   COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY display_name,user_id) FROM page),'[]'::jsonb) AS items`,
  [admin.community_id,key,query.q,query.scope,query.limit,query.offset])).rows[0];
 requireCondition(result.guild_exists,404,'guild_not_found','找不到這個公會。');
 return {items:result.items,total:result.total,next_offset:query.offset+query.limit<result.total?query.offset+query.limit:null};
}
export async function appointGuildMaster(pool:Pool,input:AdminCommand,key:string){
  const body=z.object({user_id:z.uuid(),reason}).strict().parse(input.body);
  const authorize=(q:PoolClient)=>authorizeGuildAppointee(q,input.admin,body.user_id,key);
  return adminCommand(pool,input,authorize,async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`guild-officer/${input.admin.community_id}/${key}`]);
    const prior=(await q.query('SELECT * FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 FOR UPDATE',[input.admin.community_id,key])).rows[0];
    if(prior)checkVersion(prior.aggregate_version,input.expected);else requireCondition(!input.expected,412,'version_conflict','公會長資料已變更，請重新整理。');
    const membership=await ensureGuildAppointeeMembership(q,input.admin,body.user_id,key,body.reason);
    const row=(await q.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3) ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=$3,appointed_at=now(),aggregate_version=nextval('positioning_guild_officer_revision') RETURNING *`,[input.admin.community_id,key,body.user_id])).rows[0];
    await notifyGuildMasterChange(q,input.admin.community_id,prior?.user_id??null,row);
    await audit(q,input.admin,'appoint_guild_master','guild',key,body.reason,prior?{user_id:prior.user_id,aggregate_version:prior.aggregate_version}:null,{user_id:row.user_id,aggregate_version:row.aggregate_version,membership_joined:membership.membership_joined});return {...row,membership_joined:membership.membership_joined};
  });
}
export async function adminNominees(pool:Pool,admin:AdminActor){
  return (await pool.query(`SELECT a.admin_id,a.email,a.display_name,a.role,a.active,a.created_at,a.aggregate_version,a.access_synced_version,a.access_synced_at,u.user_id,
    u.user_id IS NOT NULL AS member_account_present,u.active AS member_account_active,u.email_verified_at IS NOT NULL AS member_email_verified,
    CASE WHEN u.user_id IS NULL THEN 'no_member_account' WHEN u.email_verified_at IS NULL THEN 'unverified_email_match' ELSE 'verified_email_match' END AS identity_binding
    FROM platform_admins a LEFT JOIN users u ON lower(u.email)=a.email AND u.community_id=a.community_id WHERE a.community_id=$1 ORDER BY a.display_name,a.admin_id`,[admin.community_id])).rows.map(withAdminAccessState);
}
const AdminAppointmentInput=z.object({reason,confirmed:z.literal(true)}).strict();
const AdminStatusInput=z.object({active:z.boolean(),reason,confirmed:z.literal(true)}).strict();
async function scopedAdmin(q:PoolClient,admin:AdminActor,id:string,lock=false){
  const row=(await q.query(`SELECT a.*,(SELECT u.user_id FROM users u WHERE u.community_id=a.community_id AND lower(u.email)=a.email) AS user_id
    FROM platform_admins a WHERE a.admin_id=$1 AND a.community_id=$2${lock?' FOR UPDATE OF a':''}`,[id,admin.community_id])).rows[0];
  requireCondition(row,404,'admin_not_found','找不到這個社群的管理員。');return row;
}
export async function appointPlatformAdmin(pool:Pool,input:AdminCommand,userId:string){
  z.uuid().parse(userId);const body=AdminAppointmentInput.parse(input.body);
  return adminCommand(pool,input,q=>scopedUser(q,input.admin,userId),async q=>{
    const member=await scopedUser(q,input.admin,userId,true);checkVersion(member.aggregate_version,input.expected);
    requireCondition(member.active,422,'active_member_required','請選擇啟用中的會員。');
    const email=member.email.toLowerCase();
    const row=(await q.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name,role)
      VALUES($1,$2,$3,$4,'super_admin') ON CONFLICT(email) DO NOTHING RETURNING *`,[randomUUID(),input.admin.community_id,email,member.display_name])).rows[0];
    requireCondition(row,409,'admin_already_exists','這位會員已有管理員紀錄，請從管理員名單調整狀態。');
    const result=withAdminAccessState({...row,user_id:member.user_id});
    await audit(q,input.admin,'appoint_platform_admin','platform_admin',row.admin_id,body.reason,null,{admin_id:row.admin_id,user_id:member.user_id,email,role:row.role,active:row.active,aggregate_version:result.aggregate_version,access_state:result.access_state});
    return result;
  },true);
}
export async function changePlatformAdminStatus(pool:Pool,input:AdminCommand,id:string){
  z.uuid().parse(id);const body=AdminStatusInput.parse(input.body);
  return adminCommand(pool,input,q=>scopedAdmin(q,input.admin,id),async q=>{
    const prior=await scopedAdmin(q,input.admin,id,true);checkVersion(prior.aggregate_version,input.expected);
    requireCondition(body.active||prior.admin_id!==input.admin.admin_id,409,'self_admin_revocation','不能撤銷自己的管理權限，請由另一位管理員處理。');
    requireCondition(prior.active!==body.active,409,'admin_status_unchanged','管理員已是這個狀態，請重新整理。');
    if(body.active){
      requireCondition((await q.query('SELECT user_id FROM users WHERE community_id=$1 AND lower(email)=$2 AND active FOR SHARE',[input.admin.community_id,prior.email])).rowCount===1,422,'active_member_required','重新任命需要同信箱的啟用中會員帳號。');
    }else{
      requireCondition((await q.query('SELECT count(*)::int AS count FROM platform_admins WHERE community_id=$1 AND active',[input.admin.community_id])).rows[0].count>1,409,'last_admin_required','社群至少需要一位啟用中的管理員。');
    }
    const updated=(await q.query('UPDATE platform_admins SET active=$2,aggregate_version=aggregate_version+1 WHERE admin_id=$1 AND community_id=$3 RETURNING *',[id,body.active,input.admin.community_id])).rows[0];
    const result=withAdminAccessState({...updated,user_id:prior.user_id});
    await audit(q,input.admin,'platform_admin_status','platform_admin',id,body.reason,{active:prior.active,aggregate_version:Number(prior.aggregate_version)},{active:result.active,aggregate_version:result.aggregate_version,access_state:result.access_state});
    return result;
  },true);
}
export async function adminAudit(pool:Pool,admin:AdminActor){
  return (await pool.query(`SELECT a.audit_id,a.action,a.target_type,a.target_ref,a.reason,a.before_state,a.after_state,a.created_at,p.display_name AS admin_name
    FROM platform_admin_audit a JOIN platform_admins p USING(admin_id) WHERE a.community_id=$1 ORDER BY a.created_at DESC,a.audit_id DESC LIMIT 100`,[admin.community_id])).rows;
}
