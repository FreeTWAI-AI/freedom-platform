import type { Pool } from 'pg';
import { z } from 'zod';
import { publicPath } from './service.js';

// Published-only, explicitly sanitised projections for public pages. A row is
// visible only while its owner is active and onboarded and the pinned project
// version it was published with still exists. No owner ids, emails, drafts or
// grant/key metadata ever leave through these functions.
const PUBLISHED = `FROM skill_submissions s
  JOIN users u ON u.user_id=s.owner_ref AND u.community_id=s.community_id
  JOIN oss_projects p ON p.project_id=s.project_id AND p.owner_ref=s.owner_ref AND p.community_id=s.community_id
  JOIN oss_project_versions v ON v.version_id=s.project_version_id AND v.project_id=s.project_id
  WHERE s.status='published' AND s.consent_to_share AND NOT p.official
    AND u.active AND (NOT u.onboarding_required OR u.onboarding_completed_at IS NOT NULL)`;
const COLUMNS = `s.submission_id,s.payload,s.project_id,s.published_at,s.image_bytes IS NOT NULL AS has_image,
  v.repository_full_name,v.repository_url,v.commit_sha,v.license_spdx,v.license_evidence_url,v.is_fork,v.archived`;

function summary(row: any) {
  const payload = row.payload;
  return {
    submission_id: row.submission_id as string,
    title: payload.title as string,
    description: payload.description as string,
    repository_url: row.repository_url as string,
    relationship: payload.relationship as 'author' | 'maintainer' | 'contributor' | 'curator',
    relationship_verification: 'self_declared' as const,
    official: false as const,
    project_id: row.project_id as string,
    public_path: publicPath(row.submission_id),
    illustration_url: row.has_image ? `/api/v1/skill-submissions/${row.submission_id}/illustration` : null,
    share_introductions: [...payload.share_introductions] as string[],
    source: {
      repository_full_name: row.repository_full_name as string, repository_url: row.repository_url as string,
      commit_sha: row.commit_sha as string, license_spdx: row.license_spdx as string,
      license_evidence_url: (row.license_evidence_url ?? null) as string | null,
      is_fork: Boolean(row.is_fork), archived: Boolean(row.archived),
    },
    published_at: new Date(row.published_at).toISOString(),
  };
}
export type PublishedSkillSubmission = ReturnType<typeof summary>;

export async function listPublishedSkillSubmissions(pool: Pool, limit = 100): Promise<PublishedSkillSubmission[]> {
  const bounded = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 100));
  return (await pool.query(`SELECT ${COLUMNS} ${PUBLISHED} ORDER BY s.published_at DESC,s.submission_id LIMIT $1`, [bounded])).rows.map(summary);
}

export async function readPublishedSkillSubmission(pool: Pool, id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const row = (await pool.query(`SELECT ${COLUMNS} ${PUBLISHED} AND s.submission_id=$1`, [id.toLowerCase()])).rows[0];
  if (!row) return null;
  return { ...summary(row), use_notes: row.payload.use_notes as string, demo_url: (row.payload.demo_url ?? null) as string | null };
}

export async function readPublishedSkillIllustration(pool: Pool, id: string): Promise<{ bytes: Buffer; mime_type: 'image/webp' } | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const row = (await pool.query(`SELECT s.image_bytes ${PUBLISHED} AND s.submission_id=$1 AND s.image_bytes IS NOT NULL`, [id.toLowerCase()])).rows[0];
  return row ? { bytes: row.image_bytes as Buffer, mime_type: 'image/webp' } : null;
}
