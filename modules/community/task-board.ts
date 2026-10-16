import type { Pool } from 'pg';
import {z} from 'zod';
import { readWithMemberSession } from '../../packages/db/member-session.js';
import type { Actor } from '../identity-membership/service.js';

// A narrow discovery projection: no owner identity, claim, terms or member profile.
export async function previewTasks(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT work_item_id,title,objective,gain,claim_window_expires_at,due_at
    FROM work_items WHERE community_id=$1 AND work_mode='community_collaboration' AND state='open' AND claim_window_expires_at>clock_timestamp()
    ORDER BY created_at DESC,work_item_id LIMIT 12`,[actor.community_id])).rows;
}

// Durable accepted-work facts. Scoring remains a separate, future policy;
// claim, decision and acting profession references make recalculation possible.
const ContributionPage=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).default(0)}).strict();
export async function contributionRecords(pool:Pool,actor:Actor,raw:unknown) {
  return readWithMemberSession(pool,actor,async q=>{
    const {limit,offset}=ContributionPage.parse(raw);
    const result=(await q.query(`WITH records AS MATERIALIZED (
        SELECT c.contribution_id,c.claim_id,c.work_item_id,c.decision_id,c.title,c.accepted_at,
          wc.acting_profession_membership_ref,d.reviewer_ref
        FROM contributions c JOIN work_claims wc ON wc.claim_id=c.claim_id
        JOIN work_items w ON w.work_item_id=c.work_item_id AND w.work_mode='community_collaboration'
        JOIN work_decisions d ON d.decision_id=c.decision_id
        WHERE c.community_id=$1 AND c.user_id=$2),
      page AS (
        SELECT * FROM records ORDER BY accepted_at DESC,contribution_id DESC LIMIT $3 OFFSET $4)
      SELECT (SELECT count(*)::int FROM records) AS accepted_count,
        COALESCE((SELECT jsonb_agg(p ORDER BY accepted_at DESC,contribution_id DESC) FROM page p),'[]'::jsonb) AS entries`,
    [actor.community_id,actor.user_id,limit,offset])).rows[0];
    const acceptedCount=Number(result.accepted_count),entries=result.entries as Record<string,unknown>[];
    return {policy:'accepted_work_facts_v1',accepted_count:acceptedCount,entries,
      next_offset:offset+entries.length<acceptedCount?offset+limit:null};
  });
}

export async function acceptedWorkFeed(pool:Pool,actor:Actor) {
  return (await pool.query(`SELECT c.contribution_id,c.title,c.accepted_at,u.display_name AS member_name
    FROM contributions c JOIN users u ON u.user_id=c.user_id
    JOIN work_items w ON w.work_item_id=c.work_item_id AND w.work_mode='community_collaboration'
    WHERE c.community_id=$1 AND (c.user_id=$2 OR NOT is_verification_test_account(c.user_id)) ORDER BY c.accepted_at DESC,c.contribution_id DESC LIMIT 30`,[actor.community_id,actor.user_id])).rows;
}
