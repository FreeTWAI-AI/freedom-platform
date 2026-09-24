import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import type {Actor} from '../identity-membership/service.js';
import {command,journal,type Command} from '../../packages/db/index.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {text} from '../../packages/shared/validation.js';

export const contributionRoles=['development','testing','design','documentation','marketing','sales','operations','security','music','media'] as const;
export const pilotProject={
  project_id:'workshop-video-autopilot',source_project_id:null,
  title:'自動剪輯共創：一起把可用的底層疊起來',
  goal:'一起完善 Hao 的 video-autopilot-kit：剪輯流程、測試素材、文件與擴充介面。從有完成條件的 Issue 開始，通用改善優先回饋原作。',
  guild_keys:['guild_media_automation','guild_ai_vibe','guild_ai_field'],
  help_wanted:[...contributionRoles],
  contribution_notes:'先在 GitHub Issue 說明想接的範圍，由維護者確認避免撞工。保留來源授權與作者；禁止提交私人影片、金鑰或未授權素材。是否合併由 repo 維護者審查。這是自願開源共創，沒有報酬保證；收費合作另由當事人約定。',
  repository_id:'1382968090',repository_full_name:'FreeTWAI-AI/video-autopilot-kit',
  repository_url:'https://github.com/FreeTWAI-AI/video-autopilot-kit',
  upstream_url:'https://github.com/Hao0321/video-autopilot-kit',
  coordinator_ref:null,coordinator_name:'自由工坊',aggregate_version:1,source_kind:'community_pilot',
};
const createInput=z.object({source_project_id:z.uuid(),title:text(120),goal:text(3000),
  guild_keys:z.array(z.string().regex(/^guild_[a-z_]+$/)).max(5).refine(v=>new Set(v).size===v.length,'公會不可重複').default([]),
  help_wanted:z.array(z.enum(contributionRoles)).min(1).max(contributionRoles.length).refine(v=>new Set(v).size===v.length,'角色不可重複'),
  contribution_notes:text(3000)}).strict();
async function view(q:Pool|PoolClient,actor:Actor,id?:string){
  return (await q.query(`SELECT c.*,u.display_name AS coordinator_name,p.repository_id,p.repository_url,p.repository_full_name,
    'member_project' AS source_kind,NULL::text AS upstream_url,
    ARRAY(SELECT cg.guild_key FROM co_creation_project_guilds cg WHERE cg.project_id=c.project_id ORDER BY cg.guild_key) AS guild_keys
    FROM co_creation_projects c JOIN users u ON u.user_id=c.coordinator_ref AND u.active
    JOIN oss_projects p ON p.project_id=c.source_project_id AND p.community_id=c.community_id
    WHERE c.community_id=$1 ${id?'AND c.project_id=$2':''} ORDER BY c.created_at DESC,c.project_id LIMIT 100`,id?[actor.community_id,id]:[actor.community_id])).rows;
}
export async function listCoCreation(pool:Pool,actor:Actor){return [pilotProject,...await view(pool,actor)];}
export async function listCoCreationGuilds(pool:Pool){return (await pool.query('SELECT guild_key,name FROM positioning_guild_catalog ORDER BY name,guild_key')).rows;}
export async function getCoCreation(pool:Pool,actor:Actor,id:string){
  if(id===pilotProject.project_id)return pilotProject;
  z.uuid().parse(id);const row=(await view(pool,actor,id))[0];
  requireCondition(row,404,'not_found','找不到這個共創專案。');return row;
}
export async function createCoCreation(pool:Pool,input:Command){
  const body=createInput.parse(input.body);
  const authorize=async(q:PoolClient)=>{
    const guilds=await q.query('SELECT guild_key FROM positioning_guild_catalog WHERE guild_key=ANY($1::text[])',[body.guild_keys]);
    requireCondition(guilds.rowCount===body.guild_keys.length,422,'invalid_guild','請選擇現有的公會分類。');
    const source=(await q.query(`SELECT p.*,v.archived FROM oss_projects p JOIN oss_project_versions v ON v.version_id=p.current_version_id
      WHERE p.project_id=$1 AND p.community_id=$2 AND p.owner_ref=$3`,[body.source_project_id,input.actor.community_id,input.actor.user_id])).rows[0];
    requireCondition(source,404,'not_found','請先登錄自己的開源作品，再募集共創。');
    requireCondition(!source.archived,409,'repository_archived','封存的 repo 無法接受新的共創，請先確認維護狀態。');return source;
  };
  return command(pool,input,authorize,async q=>{
    const source=await authorize(q);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`co-creation/${body.source_project_id}`]);
    requireCondition(!(await q.query('SELECT 1 FROM co_creation_projects WHERE source_project_id=$1',[body.source_project_id])).rowCount,409,'co_creation_exists','這件作品已經有共創入口。');
    const id=randomUUID();await q.query(`INSERT INTO co_creation_projects(project_id,community_id,source_project_id,coordinator_ref,title,goal,help_wanted,contribution_notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,input.actor.community_id,body.source_project_id,input.actor.user_id,body.title,body.goal,JSON.stringify(body.help_wanted),body.contribution_notes]);
    await q.query('INSERT INTO co_creation_project_guilds(project_id,guild_key) SELECT $1,unnest($2::text[])',[id,body.guild_keys]);
    await journal(q,input.actor,'co_creation_project',id,1,'open_collaboration',{repository_id:source.repository_id,guild_keys:body.guild_keys,authority:'coordination_only',tasks_system_of_record:'github'});
    return (await view(q,input.actor,id))[0];
  });
}
