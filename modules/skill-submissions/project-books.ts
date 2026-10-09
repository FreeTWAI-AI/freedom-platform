import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { publishedWorkFrom } from './public.js';
import { catalogBookForRepository, repositoryKey, type CatalogBookMatch } from './repository-match.js';

type Queryable = Pool | PoolClient;
export type SkillBookProject = { project_id: string; owner_ref: string; repository_url: string };
export type ProjectSkillBook = {
  status: 'published' | 'ready_for_review' | 'awaiting_upload';
  submission_id: string | null;
  public_path: string | null;
  catalog_book: CatalogBookMatch | null;
  can_edit: boolean;
};

/** A project card exposes private draft status only to the draft's owner. */
export async function projectSkillBookLinks(q: Queryable, actor: Actor, projects: SkillBookProject[]) {
  const links = new Map<string, ProjectSkillBook>();
  if (!projects.length) return links;
  const ids = projects.map(project => project.project_id);
  const repositories = projects.map(project => repositoryKey(project.repository_url)).filter((key): key is string => key !== null);
  // Use the same live publication rule as the book shelf, including its pinned
  // project version and the owner's active/onboarded/non-test status.
  const published = (await q.query(`SELECT s.submission_id,s.project_id,v.repository_url ${publishedWorkFrom}
    AND s.community_id=$1 AND (s.project_id=ANY($2::uuid[]) OR lower(v.repository_full_name)=ANY($3::text[]))
    ORDER BY s.published_at DESC,s.submission_id`, [actor.community_id, ids, repositories])).rows;
  const drafts = (await q.query(`SELECT submission_id,COALESCE(payload->>'repository_url',seed->>'repository_url') AS repository_url,status,
    (grant_hash IS NULL AND seed IS NULL) AS manual FROM skill_submissions
    WHERE community_id=$1 AND owner_ref=$2 AND status IN ('ready_for_review','awaiting_upload')
    ORDER BY CASE WHEN status='ready_for_review' THEN 0 ELSE 1 END,created_at DESC,submission_id`, [actor.community_id, actor.user_id])).rows;
  for (const project of projects) {
    const key = repositoryKey(project.repository_url);
    const catalog = catalogBookForRepository(key);
    if (catalog) {
      links.set(project.project_id, { status: 'published', submission_id: null, public_path: catalog.public_path, catalog_book: catalog, can_edit: false });
      continue;
    }
    // A published upgrade wins over its earlier simple book without changing
    // the original project's identity. Do not pick another member's book just
    // because that member independently registered the same repository.
    const book = published.find(row => row.project_id === project.project_id);
    if (book) {
      const matched = catalogBookForRepository(repositoryKey(book.repository_url));
      links.set(project.project_id, { status: 'published', submission_id: book.submission_id,
        public_path: matched?.public_path ?? `/development/submissions/${book.submission_id}`, catalog_book: matched, can_edit: false });
      continue;
    }
    if (project.owner_ref !== actor.user_id || key === null) continue;
    const draft = drafts.find(row => repositoryKey(row.repository_url) === key);
    if (draft) links.set(project.project_id, { status: draft.status, submission_id: draft.submission_id,
      public_path: null, catalog_book: null, can_edit: draft.status === 'ready_for_review' && Boolean(draft.manual) });
  }
  return links;
}
