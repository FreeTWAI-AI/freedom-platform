import type { Pool } from 'pg';
import type { Actor } from '../identity-membership/service.js';

// A narrow discovery projection: no owner identity, claim, terms or member profile.
export async function previewTasks(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT work_item_id,title,objective,gain,claim_window_expires_at,due_at
    FROM work_items WHERE community_id=$1 AND state='open' AND claim_window_expires_at>now()
    ORDER BY created_at DESC,work_item_id LIMIT 12`,[actor.community_id])).rows;
}

// This is a transparent, versioned community contribution indicator, not profession XP,
// compensation, or an official credential. Only independent accepted work is counted.
export async function contributionPoints(pool:Pool,actor:Actor) {
  const entries=(await pool.query(`SELECT contribution_id,work_item_id,decision_id,title,accepted_at
    FROM contributions WHERE community_id=$1 AND user_id=$2 ORDER BY accepted_at DESC,contribution_id`,[actor.community_id,actor.user_id])).rows;
  return {policy:'accepted_work_v1',points_per_accepted_work:10,total:entries.length*10,accepted_count:entries.length,
    entries:entries.map(entry=>({...entry,points:10}))};
}
