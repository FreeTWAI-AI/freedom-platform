import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { command,checkVersion,digest,journal,type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { text } from '../../packages/shared/validation.js';
import { externalLink,githubCoordinate,inspectGitHubRepository } from './github.js';
import { getMarketingProductSource } from '../catalog-commerce/service.js';

export const projectInput=z.object({
  repository_url:z.string().trim().max(300).transform(value=>`https://github.com/${githubCoordinate(value)}`),
  title:text(120),description:text(2000),use_notes:text(3000),demo_url:externalLink.nullable().default(null),
  relationship:z.enum(['author','maintainer','contributor','curator']),consent_to_share:z.literal(true),
}).strict();
const projectMetadata=z.object({title:text(120),description:text(2000),use_notes:text(3000),demo_url:externalLink.nullable().default(null)}).strict();
const campaignContent=z.object({title:text(120),audience:text(1000),goal:text(1000),draft_text:text(6000)}).strict();
export const campaignInput=campaignContent.extend({source_project_id:z.uuid().nullable().default(null),source_supplier_product_id:z.uuid().nullable().default(null),source_brief:z.string().trim().max(3000).default('')}).strict()
  .refine(body=>{const count=Number(Boolean(body.source_project_id))+Number(Boolean(body.source_supplier_product_id));return count===1?body.source_brief==='':count===0&&body.source_brief.length>0;},{message:'請選一件自己的開源作品或供貨商品，或填寫活動來源簡述。'});
const shareInput=z.object({channel:text(80),share_url:externalLink,note:z.string().trim().max(1000).default('')}).strict();
type ProjectSource=Awaited<ReturnType<typeof inspectGitHubRepository>>;

async function projectView(q:Pool|PoolClient,actor:Actor,id:string) {
  const row=(await q.query(`SELECT p.*,u.display_name AS owner_name,to_jsonb(v) AS current_version
    FROM oss_projects p JOIN users u ON u.user_id=p.owner_ref
    JOIN oss_project_versions v ON v.version_id=p.current_version_id AND v.project_id=p.project_id
    WHERE p.project_id=$1 AND p.community_id=$2`,[id,actor.community_id])).rows[0];
  requireCondition(row,404,'not_found','找不到這件開源作品。');return row;
}
async function ownedProject(q:PoolClient,actor:Actor,id:string,lock=false) {
  const row=(await q.query(`SELECT * FROM oss_projects WHERE project_id=$1 AND community_id=$2 AND owner_ref=$3${lock?' FOR UPDATE':''}`,[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'not_found','找不到可由你管理的開源作品。');return row;
}
async function insertVersion(q:PoolClient,projectId:string,source:ProjectSource) {
  const versionId=randomUUID();
  const {inspected_at:_,...facts}=source,sourceDigest=digest(facts);
  const inserted=(await q.query(`INSERT INTO oss_project_versions(version_id,project_id,repository_id,commit_sha,default_branch,
    repository_full_name,repository_url,readme_url,license_spdx,license_evidence_url,is_fork,archived,source_snapshot,source_sha256,inspected_at,facts_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT(project_id,facts_sha256) DO NOTHING RETURNING version_id`,[versionId,projectId,source.repository_id,source.commit_sha,source.default_branch,
    source.repository_full_name,source.repository_url,source.readme_url,source.license_spdx,source.license_evidence_url,source.is_fork,source.archived,JSON.stringify(source),digest(source),source.inspected_at,sourceDigest])).rows[0];
  return inserted?.version_id??(await q.query('SELECT version_id FROM oss_project_versions WHERE project_id=$1 AND facts_sha256=$2',[projectId,sourceDigest])).rows[0].version_id;
}
export async function listProjects(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT p.*,u.display_name AS owner_name,to_jsonb(v) AS current_version
    FROM oss_projects p JOIN users u ON u.user_id=p.owner_ref JOIN oss_project_versions v ON v.version_id=p.current_version_id AND v.project_id=p.project_id
    WHERE p.community_id=$1 ORDER BY p.created_at DESC,p.project_id LIMIT 100`,[actor.community_id])).rows;
}
export async function importProject(pool:Pool,input:Command) {
  const body=projectInput.parse(input.body);
  return command(pool,input,async()=>{},async q=>{
    // Only bounded public reads; the transaction also guarantees command retries never re-import.
    const source=await inspectGitHubRepository(body.repository_url);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`oss/${input.actor.community_id}/${input.actor.user_id}/${source.repository_id}`]);
    const prior=(await q.query('SELECT project_id FROM oss_projects WHERE community_id=$1 AND owner_ref=$2 AND repository_id=$3',[input.actor.community_id,input.actor.user_id,source.repository_id])).rows[0];
    requireCondition(!prior,409,'project_exists','你已登錄這件作品，請使用更新 GitHub 版本。');
    const id=randomUUID();
    await q.query(`INSERT INTO oss_projects(project_id,community_id,owner_ref,title,description,use_notes,demo_url,repository_id,repository_full_name,repository_url,relationship)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,input.actor.community_id,input.actor.user_id,body.title,body.description,body.use_notes,body.demo_url,source.repository_id,source.repository_full_name,source.repository_url,body.relationship]);
    const versionId=await insertVersion(q,id,source);
    await q.query('UPDATE oss_projects SET current_version_id=$2 WHERE project_id=$1',[id,versionId]);
    await journal(q,input.actor,'oss_project',id,1,'import_public_repository',{repository_id:source.repository_id,commit_sha:source.commit_sha,relationship:body.relationship,relationship_verification:'self_declared'},'freedom.skills.candidate.registered.v1');
    return projectView(q,input.actor,id);
  });
}
export async function refreshProject(pool:Pool,input:Command,id:string) {
  z.object({}).strict().parse(input.body);
  return command(pool,input,q=>ownedProject(q,input.actor,id),async q=>{
    const current=await ownedProject(q,input.actor,id,true);checkVersion(current.aggregate_version,input.expected);
    const source=await inspectGitHubRepository(current.repository_url);
    requireCondition(source.repository_id===current.repository_id,409,'repository_identity_changed','這個 GitHub 網址已指向不同儲存庫；保留原本紀錄，請先確認來源。');
    const versionId=await insertVersion(q,id,source);
    const row=(await q.query(`UPDATE oss_projects SET current_version_id=$2,repository_full_name=$3,repository_url=$4,
      aggregate_version=aggregate_version+1,updated_at=now() WHERE project_id=$1 RETURNING *`,[id,versionId,source.repository_full_name,source.repository_url])).rows[0];
    await journal(q,input.actor,'oss_project',id,row.aggregate_version,'refresh_public_version',{version_id:versionId,commit_sha:source.commit_sha},'freedom.skills.candidate.versioned.v1');
    return projectView(q,input.actor,id);
  });
}
export async function reviseProject(pool:Pool,input:Command,id:string) {
  const body=projectMetadata.parse(input.body);
  return command(pool,input,q=>ownedProject(q,input.actor,id),async q=>{
    const current=await ownedProject(q,input.actor,id,true);checkVersion(current.aggregate_version,input.expected);
    const row=(await q.query(`UPDATE oss_projects SET title=$2,description=$3,use_notes=$4,demo_url=$5,
      aggregate_version=aggregate_version+1,updated_at=now() WHERE project_id=$1 RETURNING *`,[id,body.title,body.description,body.use_notes,body.demo_url])).rows[0];
    await journal(q,input.actor,'oss_project',id,row.aggregate_version,'revise_description',{});
    return projectView(q,input.actor,id);
  });
}

async function ownedCampaign(q:Pool|PoolClient,actor:Actor,id:string,lock=false) {
  const row=(await q.query(`SELECT * FROM marketing_campaign_drafts WHERE campaign_id=$1 AND community_id=$2 AND owner_ref=$3${lock?' FOR UPDATE':''}`,[id,actor.community_id,actor.user_id])).rows[0];
  requireCondition(row,404,'not_found','找不到可由你管理的行銷草稿。');return row;
}
async function campaignView(q:Pool|PoolClient,actor:Actor,id:string) {
  const row=await ownedCampaign(q,actor,id);
  const shares=(await q.query('SELECT * FROM marketing_share_records WHERE campaign_id=$1 ORDER BY created_at DESC,share_id',[id])).rows;
  return {...row,shares};
}
export async function listCampaigns(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT c.*,COALESCE((SELECT jsonb_agg(s ORDER BY s.created_at DESC) FROM marketing_share_records s WHERE s.campaign_id=c.campaign_id),'[]'::jsonb) AS shares
    FROM marketing_campaign_drafts c WHERE c.community_id=$1 AND c.owner_ref=$2 ORDER BY c.created_at DESC,c.campaign_id LIMIT 100`,[actor.community_id,actor.user_id])).rows;
}
export async function createCampaign(pool:Pool,input:Command) {
  const body=campaignInput.parse(input.body);
  return command(pool,input,async q=>{if(body.source_project_id)await ownedProject(q,input.actor,body.source_project_id);if(body.source_supplier_product_id)await getMarketingProductSource(q,input.actor,body.source_supplier_product_id);},async q=>{
    let sourceSnapshot:Record<string,unknown>,versionId:string|null=null,offerId:string|null=null;
    if(body.source_project_id){
      // Lock the source while making the exact-version snapshot, not a mutable pointer.
      await ownedProject(q,input.actor,body.source_project_id,true);
      const project=await projectView(q,input.actor,body.source_project_id);versionId=project.current_version_id;
      sourceSnapshot={kind:'oss_project',project_id:project.project_id,title:project.title,description:project.description,use_notes:project.use_notes,
        relationship:project.relationship,relationship_verification:project.relationship_verification,version_id:versionId,...project.current_version.source_snapshot};
    } else if(body.source_supplier_product_id){
      const product=await getMarketingProductSource(q,input.actor,body.source_supplier_product_id);offerId=product.offer_version_id;
      sourceSnapshot={kind:'supplier_product',...product};
    } else sourceSnapshot={kind:'manual_brief',brief:body.source_brief,provided_by:input.actor.user_id,evidence:'self_declared'};
    const id=randomUUID(),content=campaignContent.parse({title:body.title,audience:body.audience,goal:body.goal,draft_text:body.draft_text});
    await q.query(`INSERT INTO marketing_campaign_drafts(campaign_id,community_id,owner_ref,title,audience,goal,draft_text,source_project_id,source_version_id,source_snapshot,source_sha256,content_sha256,source_supplier_product_id,source_supplier_offer_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,input.actor.community_id,input.actor.user_id,body.title,body.audience,body.goal,body.draft_text,body.source_project_id,versionId,JSON.stringify(sourceSnapshot),digest(sourceSnapshot),digest(content),body.source_supplier_product_id,offerId]);
    await journal(q,input.actor,'marketing_campaign',id,1,'save_private_draft',{source_sha256:digest(sourceSnapshot),content_sha256:digest(content)},'freedom.marketing.campaign.created.v1');
    return campaignView(q,input.actor,id);
  });
}
export async function reviseCampaign(pool:Pool,input:Command,id:string) {
  const body=campaignContent.parse(input.body);
  return command(pool,input,q=>ownedCampaign(q,input.actor,id),async q=>{
    const current=await ownedCampaign(q,input.actor,id,true);checkVersion(current.aggregate_version,input.expected);
    const row=(await q.query(`UPDATE marketing_campaign_drafts SET title=$2,audience=$3,goal=$4,draft_text=$5,content_sha256=$6,
      aggregate_version=aggregate_version+1,updated_at=now() WHERE campaign_id=$1 RETURNING *`,[id,body.title,body.audience,body.goal,body.draft_text,digest(body)])).rows[0];
    await journal(q,input.actor,'marketing_campaign',id,row.aggregate_version,'revise_private_draft',{content_sha256:row.content_sha256});
    return campaignView(q,input.actor,id);
  });
}
export async function recordShare(pool:Pool,input:Command,id:string) {
  const body=shareInput.parse(input.body);
  return command(pool,input,q=>ownedCampaign(q,input.actor,id),async q=>{
    const current=await ownedCampaign(q,input.actor,id,true);checkVersion(current.aggregate_version,input.expected);
    const snapshot={title:current.title,audience:current.audience,goal:current.goal,draft_text:current.draft_text};
    const shareId=randomUUID();
    await q.query(`INSERT INTO marketing_share_records(share_id,campaign_id,channel,share_url,note,content_snapshot,content_sha256,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[shareId,id,body.channel,body.share_url,body.note,JSON.stringify(snapshot),digest(snapshot),input.actor.user_id]);
    const updated=(await q.query('UPDATE marketing_campaign_drafts SET aggregate_version=aggregate_version+1,updated_at=now() WHERE campaign_id=$1 RETURNING aggregate_version',[id])).rows[0];
    await journal(q,input.actor,'marketing_campaign',id,updated.aggregate_version,'record_manual_share',{share_id:shareId,verification_status:'self_reported',content_sha256:digest(snapshot)});
    return campaignView(q,input.actor,id);
  });
}
