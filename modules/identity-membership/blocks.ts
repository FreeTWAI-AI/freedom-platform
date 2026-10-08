import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {command,checkVersion,journal,transaction} from '../../packages/db/index.js';
import type {Command} from '../../packages/db/index.js';
import {lockMemberSession,assertCurrentSessionClock} from '../../packages/db/member-session.js';
import {requireCondition} from '../../packages/shared/problem.js';
import {BlockStateSchema,BlockListSchema} from '../../packages/shared/member-blocking.js';
import type {BlockState,BlockList} from '../../packages/shared/member-blocking.js';
import type {Actor} from './service.js';

export const BlockListQuery=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
const Empty=z.object({}).strict();
const eligible=(alias:string)=>`${alias}.active AND (NOT ${alias}.onboarding_required OR ${alias}.onboarding_completed_at IS NOT NULL)`;
function targetId(actor:Actor,raw:string){
  const id=z.uuid().parse(raw).toLowerCase();
  requireCondition(id!==actor.user_id.toLowerCase(),422,'self_block','不能封鎖自己。');return id;
}
export async function assertInteractionMember(q:PoolClient,actor:Actor){
  const row=(await q.query(`SELECT ${eligible('u')} AS ready FROM users u WHERE user_id=$1 AND community_id=$2`,[actor.user_id,actor.community_id])).rows[0];
  requireCondition(row?.ready,403,'onboarding_required','請先選擇主要公會，完成加入後即可使用會員功能。');
}
/** One unordered pair lock, acquired in authorization before receipt SELECT/replay.
 * Actor/session SHARE locks precede it; peer SHARE locks cannot upgrade them. */
export async function lockInteractionPair(q:PoolClient,actor:Actor,id:string){
  const [low,high]=[actor.user_id.toLowerCase(),id.toLowerCase()].sort();
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`friend/${actor.community_id}/${low}/${high}`]);
  await assertCurrentSessionClock(q,actor);await assertInteractionMember(q,actor);
}
export async function assertCanContact(q:PoolClient,actor:Actor,id:string){
  const blocked=(await q.query(`SELECT 1 FROM member_interaction_blocks WHERE community_id=$1 AND state='active'
    AND ((owner_ref=$2 AND target_ref=$3) OR (owner_ref=$3 AND target_ref=$2)) LIMIT 1`,[actor.community_id,actor.user_id,id])).rowCount;
  requireCondition(!blocked,409,'recipient_unavailable','目前無法與這位會員聯絡。');
}
async function ownState(q:PoolClient,actor:Actor,id:string):Promise<BlockState>{
  const row=(await q.query(`SELECT u.user_id,
    (${eligible('u')} AND NOT is_verification_test_account(u.user_id)) AS ready,
    own.state AS own_state,own.aggregate_version
    FROM users u LEFT JOIN member_interaction_blocks own ON own.community_id=$1 AND own.owner_ref=$2 AND own.target_ref=u.user_id
    WHERE u.community_id=$1 AND u.user_id=$3`,[actor.community_id,actor.user_id,id])).rows[0];
  requireCondition(row&&(row.ready||row.own_state),404,'member_not_found','找不到這位會員。');
  return BlockStateSchema.parse({user_id:id,blocked_by_me:row.own_state==='active',aggregate_version:row.aggregate_version===null?null:Number(row.aggregate_version)});
}
async function privateRead<T>(pool:Pool,actor:Actor,run:(q:PoolClient)=>Promise<T>):Promise<T>{
  return transaction(pool,async q=>{await lockMemberSession(q,actor);await assertInteractionMember(q,actor);const result=await run(q);await assertCurrentSessionClock(q,actor);return result;});
}
export async function blockState(pool:Pool,actor:Actor,raw:string):Promise<BlockState>{
  const id=targetId(actor,raw);return privateRead(pool,actor,q=>ownState(q,actor,id));
}
export async function listBlocks(pool:Pool,actor:Actor,raw:unknown):Promise<BlockList>{
  const {limit,offset}=BlockListQuery.parse(raw);
  return privateRead(pool,actor,async q=>{
    const rows=(await q.query(`SELECT b.target_ref AS user_id,CASE WHEN ${eligible('u')} AND NOT is_verification_test_account(u.user_id) THEN u.display_name ELSE NULL END AS nickname,b.blocked_at,b.aggregate_version
      FROM member_interaction_blocks b JOIN users u ON u.user_id=b.target_ref AND u.community_id=b.community_id
      WHERE b.community_id=$1 AND b.owner_ref=$2 AND b.state='active'
      ORDER BY b.blocked_at DESC,b.target_ref LIMIT $3 OFFSET $4`,[actor.community_id,actor.user_id,limit+1,offset])).rows;
    return BlockListSchema.parse({items:rows.slice(0,limit).map(row=>({user_id:row.user_id,nickname:row.nickname,blocked_at:new Date(row.blocked_at).toISOString(),aggregate_version:Number(row.aggregate_version)})),next_offset:rows.length>limit?offset+limit:null});
  });
}
export async function changeBlock(pool:Pool,input:Command,raw:string,action:'block'|'unblock'):Promise<BlockState>{
  Empty.parse(input.body);const id=targetId(input.actor,raw);
  const authorize=async(q:PoolClient)=>{
    await lockInteractionPair(q,input.actor,id);
    // Own retained setting authorizes removal even when the peer is no longer eligible.
    const peer=(await q.query(`SELECT ${eligible('u')} AND NOT is_verification_test_account(u.user_id) AS ready FROM users u WHERE u.user_id=$1 AND u.community_id=$2 FOR SHARE`,[id,input.actor.community_id])).rows[0];
    const own=(await q.query('SELECT 1 FROM member_interaction_blocks WHERE community_id=$1 AND owner_ref=$2 AND target_ref=$3',[input.actor.community_id,input.actor.user_id,id])).rowCount;
    requireCondition(peer&&(peer.ready||action==='unblock'&&own),404,'member_not_found','找不到這位會員。');
    await assertCurrentSessionClock(q,input.actor);
  };
  await command(pool,{...input,operation:`POST /api/v1/me/blocks/${id}/${action}`},authorize,async q=>{
    const prior=(await q.query('SELECT block_id,state,aggregate_version FROM member_interaction_blocks WHERE community_id=$1 AND owner_ref=$2 AND target_ref=$3 FOR UPDATE',[input.actor.community_id,input.actor.user_id,id])).rows[0];
    if(prior)checkVersion(String(prior.aggregate_version),input.expected);
    else requireCondition(!input.expected,412,'version_conflict','資料已更新，請重新整理後再操作。');
    if(!prior&&action==='unblock')return {updated:false};
    const state=action==='block'?'active':'removed';
    if(prior?.state===state)return {updated:false};
    const row=(await q.query(`INSERT INTO member_interaction_blocks(community_id,owner_ref,target_ref,state) VALUES($1,$2,$3,$4)
      ON CONFLICT(community_id,owner_ref,target_ref) DO UPDATE SET state=$4,aggregate_version=member_interaction_blocks.aggregate_version+1,
        blocked_at=CASE WHEN $4='active' THEN clock_timestamp() ELSE member_interaction_blocks.blocked_at END,updated_at=clock_timestamp()
      RETURNING block_id,aggregate_version`,[input.actor.community_id,input.actor.user_id,id,state])).rows[0];
    if(action==='block'){
      const [low,high]=[input.actor.user_id,id].sort();
      // Removal is deliberately silent: a decline notification would reveal the setting.
      await q.query(`UPDATE member_friendships SET state='removed',aggregate_version=aggregate_version+1,updated_at=clock_timestamp()
        WHERE community_id=$1 AND low_ref=$2 AND high_ref=$3 AND state<>'removed'`,[input.actor.community_id,low,high]);
      // Pair barrier also serializes invite/accept; close pending invitations
      // without a notification, retaining accepted invitations and memberships.
      await q.query(`UPDATE member_squad_invitations SET state='withdrawn',aggregate_version=aggregate_version+1,
        updated_at=clock_timestamp(),resolved_at=clock_timestamp()
        WHERE community_id=$1 AND state='pending' AND ((owner_ref=$2 AND recipient_ref=$3) OR (owner_ref=$3 AND recipient_ref=$2))`,
        [input.actor.community_id,low,high]);
    }
    await journal(q,input.actor,'member_interaction_block',row.block_id,row.aggregate_version,action,{});
    return {updated:true};
  },async q=>{await assertInteractionMember(q,input.actor);});
  // Receipts contain no private setting or peer profile; known success reads current authority.
  return blockState(pool,input.actor,id);
}

/** Recheck after asynchronous card projection so a newly committed block does not
 * return a candidate selected before the block. Never expose the block direction. */
export async function contactableIds(q:Pick<Pool,'query'>,actor:Actor,ids:string[]):Promise<Set<string>>{
  if(!ids.length)return new Set();
  const rows=(await q.query(`SELECT id FROM unnest($3::uuid[]) AS candidate(id)
    WHERE NOT EXISTS(SELECT 1 FROM member_interaction_blocks b WHERE b.community_id=$1 AND b.state='active'
      AND ((b.owner_ref=$2 AND b.target_ref=id) OR (b.owner_ref=id AND b.target_ref=$2)))`,[actor.community_id,actor.user_id,ids])).rows;
  return new Set(rows.map(row=>String(row.id)));
}
