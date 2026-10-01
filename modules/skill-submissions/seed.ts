import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { journal } from '../../packages/db/index.js';
import type { Actor } from '../identity-membership/service.js';
import { lockMemberDrafts, MAX_ACTIVE_DRAFTS } from './limits.js';
import { catalogBookForRepository, repositoryKey } from './repository-match.js';

export interface RegistrationProject {
  project_id: string;
  title: string;
  description: string;
  use_notes: string;
  demo_url: string | null;
  relationship: string;
  repository_full_name: string;
}

async function memberOwnsRepository(q: PoolClient, actor: { user_id: string; community_id: string }, key: string) {
  const rows = (await q.query(`SELECT payload->>'repository_url' AS payload_url, seed->>'repository_url' AS seed_url
    FROM skill_submissions WHERE community_id=$1 AND owner_ref=$2 AND status IN ('awaiting_upload','ready_for_review','published')`,
    [actor.community_id, actor.user_id])).rows;
  return rows.some(row => repositoryKey(row.payload_url) === key || repositoryKey(row.seed_url) === key);
}

// Called only when a manual registration has just inserted a new project, inside that command's transaction.
// Skips leave the registration itself committed. A command replay never reaches this function.
export async function seedDraftFromRegistration(q: PoolClient, actor: { user_id: string; community_id: string }, project: RegistrationProject) {
  const key = repositoryKey(`https://github.com/${project.repository_full_name}`);
  if (!key || catalogBookForRepository(key)) return;
  await lockMemberDrafts(q, actor.user_id);
  if (await memberOwnsRepository(q, actor, key)) return;
  const active = Number((await q.query(`SELECT count(*) FROM skill_submissions WHERE community_id=$1 AND owner_ref=$2
    AND status IN ('awaiting_upload','ready_for_review')`, [actor.community_id, actor.user_id])).rows[0].count);
  if (active >= MAX_ACTIVE_DRAFTS) return;
  const id = randomUUID();
  const seed = {
    repository_url: `https://github.com/${project.repository_full_name}`,
    title: project.title,
    description: project.description,
    use_notes: project.use_notes,
    demo_url: project.demo_url,
    relationship: project.relationship,
  };
  await q.query(`INSERT INTO skill_submissions(submission_id,community_id,owner_ref,source_project_id,seed)
    VALUES($1,$2,$3,$4,$5)`, [id, actor.community_id, actor.user_id, project.project_id, JSON.stringify(seed)]);
  await journal(q, actor as Actor, 'skill_submission', id, 1, 'seed_from_manual_registration',
    { project_id: project.project_id, repository_full_name: project.repository_full_name });
}
