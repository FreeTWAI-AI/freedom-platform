import type { Pool } from 'pg';
import type { Actor } from '../identity-membership/service.js';

// A narrow discovery projection: no owner identity, claim, terms or member profile.
export async function previewTasks(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT work_item_id,title,objective,gain,claim_window_expires_at,due_at
    FROM work_items WHERE community_id=$1 AND state='open' AND claim_window_expires_at>now()
    ORDER BY created_at DESC,work_item_id LIMIT 12`,[actor.community_id])).rows;
}

// Durable accepted-work facts. Scoring remains a separate, future policy;
// claim, decision and acting profession references make recalculation possible.
export async function contributionRecords(pool:Pool,actor:Actor) {
  const entries=(await pool.query(`SELECT c.contribution_id,c.claim_id,c.work_item_id,c.decision_id,c.title,c.accepted_at,
      wc.acting_profession_membership_ref,d.reviewer_ref
    FROM contributions c JOIN work_claims wc ON wc.claim_id=c.claim_id
    JOIN work_decisions d ON d.decision_id=c.decision_id
    WHERE c.community_id=$1 AND c.user_id=$2 ORDER BY c.accepted_at DESC,c.contribution_id`,[actor.community_id,actor.user_id])).rows;
  return {policy:'accepted_work_facts_v1',accepted_count:entries.length,entries};
}

export async function acceptedWorkFeed(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT c.contribution_id,c.title,c.accepted_at,u.display_name AS member_name
    FROM contributions c JOIN users u ON u.user_id=c.user_id
    WHERE c.community_id=$1 AND (c.user_id=$2 OR NOT is_verification_test_account(c.user_id)) ORDER BY c.accepted_at DESC,c.contribution_id DESC LIMIT 30`,[actor.community_id,actor.user_id])).rows;
}
