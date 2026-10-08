import type { Pool } from 'pg';
import type { Actor } from '../identity-membership/service.js';

export interface PersonalContentItem {
  kind: 'showcase' | 'skill_submission' | 'event' | 'social_post';
  id: string;
  title: string;
  status: string;
  version: string | null;
  path: string;
  visibility: string;
  actions: string[];
}

// Owner inventory reads the original aggregates, including closed records. It
// does not grant publication or bypass the source commands' authorization.
export async function listPersonalContent(pool: Pool, actor: Actor): Promise<{ items: PersonalContentItem[] }> {
  const scope = [actor.community_id, actor.user_id];
  const [showcases, skills, events, posts] = await Promise.all([
    pool.query(`SELECT showcase_id,title,status,aggregate_version,visibility,created_at FROM showcases
      WHERE community_id=$1 AND owner_ref=$2 ORDER BY created_at DESC,showcase_id`, scope),
    pool.query(`SELECT submission_id,status,aggregate_version,COALESCE(payload->>'title',seed->>'title','技能投稿草稿') AS title,
      (grant_hash IS NULL AND seed IS NULL) AS manual,created_at FROM skill_submissions
      WHERE community_id=$1 AND owner_ref=$2 ORDER BY created_at DESC,submission_id`, scope),
    pool.query(`SELECT e.event_id,e.title,e.state,e.aggregate_version,e.visibility,e.starts_at,e.created_at,
      EXISTS (SELECT 1 FROM positioning_profession_memberships m WHERE m.community_id=e.community_id
        AND m.user_id=$2 AND m.guild_key=e.guild_key AND m.state='active' AND m.member_tier='intern')
        AND e.event_kind='guild_skill_exchange' AS writes_blocked
      FROM community_events e WHERE e.community_id=$1 AND e.organizer_ref=$2 ORDER BY e.created_at DESC,e.event_id`, scope),
    pool.query(`SELECT post_id,title,state,created_at FROM community_social_posts
      WHERE community_id=$1 AND author_user_id=$2 ORDER BY created_at DESC,post_id`, scope),
  ]);
  const ready = !actor.onboarding_required || Boolean(actor.onboarding_completed_at);
  const entries: { item: PersonalContentItem; created: number }[] = [];
  for (const row of showcases.rows) entries.push({ created: new Date(row.created_at).getTime(), item: {
    kind: 'showcase', id: row.showcase_id, title: row.title, status: row.status, version: String(row.aggregate_version),
    path: `#my-content/showcases/${row.showcase_id}`, visibility: row.visibility,
    actions: row.status === 'published' ? ['view', 'withdraw'] : row.status === 'draft' ? ['edit', 'publish', 'withdraw'] : ['edit', 'publish'],
  } });
  for (const row of skills.rows) {
    const actions = row.status === 'published' ? ['view'] : row.status === 'revoked' ? [] : ['continue', 'withdraw'];
    if (row.status === 'ready_for_review' && ready) {
      if (row.manual) actions.push('edit');
      actions.push('publish');
    }
    entries.push({ created: new Date(row.created_at).getTime(), item: {
      kind: 'skill_submission', id: row.submission_id, title: row.title, status: row.status, version: String(row.aggregate_version),
      path: row.status === 'published' ? `/development/submissions/${row.submission_id}` : `#opensource?submission=${row.submission_id}`,
      visibility: row.status === 'published' ? 'public' : 'private', actions,
    } });
  }
  for (const row of events.rows) {
    const actions = ['view'];
    if (!row.writes_blocked) {
      if (row.state === 'pending' && new Date(row.starts_at).getTime() > Date.now()) actions.push('edit');
      if (row.state === 'pending' || row.state === 'published') actions.push('cancel');
    }
    entries.push({ created: new Date(row.created_at).getTime(), item: {
      kind: 'event', id: row.event_id, title: row.title, status: row.state, version: String(row.aggregate_version),
      path: `#events/${row.event_id}`, visibility: row.state === 'published' ? row.visibility : 'private', actions,
    } });
  }
  for (const row of posts.rows) entries.push({ created: new Date(row.created_at).getTime(), item: {
    kind: 'social_post', id: row.post_id, title: row.title, status: row.state,
    // Social removal has no lifecycle version; media_version is not that version.
    version: null, path: '#social', visibility: row.state === 'active' ? 'community' : 'private',
    actions: row.state === 'active' ? ['view', 'withdraw'] : row.state === 'hidden' ? ['withdraw'] : [],
  } });
  entries.sort((a, b) => b.created - a.created || a.item.kind.localeCompare(b.item.kind) || a.item.id.localeCompare(b.item.id));
  return { items: entries.map(entry => entry.item) };
}
