import type {PoolClient} from 'pg';
import {notifyMember} from './notifications.js';

// Domain hooks for existing member/admin commands. Each runs inside the
// caller's command transaction, after its authorization and version checks,
// so a notification exists exactly when the domain change commits. Stable
// source keys make replays and concurrent retries insert at most once.
// Copy is plain text built from display names and catalog names only: never
// emails, tokens, admin identities or other private identifiers.

const clip=(text:string,max:number)=>{const chars=[...text.trim()];return chars.length<=max?chars.join(''):chars.slice(0,max-1).join('')+'…';};
async function displayName(q:PoolClient,communityId:string,userId:string){
  return clip((await q.query('SELECT display_name FROM users WHERE user_id=$1 AND community_id=$2',[userId,communityId])).rows[0]?.display_name??'一位會員',60);
}
async function guildName(q:PoolClient,guildKey:string){
  return clip((await q.query('SELECT name FROM positioning_guild_catalog WHERE guild_key=$1',[guildKey])).rows[0]?.name??'公會',100);
}

type FriendshipRow={low_ref:string;high_ref:string;requester_ref:string;state:'pending'|'accepted'|'removed';aggregate_version:string|number};
/**
 * prior is the locked row before the change (undefined when none existed);
 * result is the row the command returned. Only real transitions notify:
 * a new/renewed request → invitee, accept → original requester, and the
 * invitee removing a pending request (decline) → requester. A requester
 * cancelling, removing an accepted friend, or a no-op re-request is silent.
 */
export async function notifyFriendshipChange(q:PoolClient,communityId:string,actorId:string,prior:FriendshipRow|undefined,result:FriendshipRow){
  if(prior&&String(prior.aggregate_version)===String(result.aggregate_version))return null;
  const other=result.low_ref===actorId?result.high_ref:result.low_ref;
  const kind=result.state==='pending'?'friend_request'
    :result.state==='accepted'&&prior?.state==='pending'?'friend_accepted'
    :result.state==='removed'&&prior?.state==='pending'&&prior.requester_ref===other?'friend_declined':null;
  if(!kind)return null;
  const name=await displayName(q,communityId,actorId);
  const copy={
    friend_request:{title:'新的好友邀請',body:`${name} 想加你為好友。`},
    friend_accepted:{title:'好友邀請已接受',body:`${name} 接受了你的好友邀請。`},
    friend_declined:{title:'好友邀請未被接受',body:`${name} 沒有接受你的好友邀請。`},
  }[kind];
  return notifyMember(q,{community_id:communityId,recipient_ref:other,kind,
    source_key:`friendship/${result.low_ref}/${result.high_ref}/${result.aggregate_version}/${kind}`,
    ...copy,action:{tab:'members',resource_id:actorId}});
}

export async function notifyGuildApplicationReview(q:PoolClient,application:{application_id:string;community_id:string;user_id:string;name:string;state:string;aggregate_version:string|number;review_reason:string|null;approved_guild_key:string|null}){
  const approved=application.state==='approved',name=clip(application.name,100);
  // The applicant already reads review_reason from their own application list.
  const reason=application.review_reason?`審查說明：${clip(application.review_reason,1000)}`:'';
  return notifyMember(q,{community_id:application.community_id,recipient_ref:application.user_id,
    kind:approved?'guild_application_approved':'guild_application_rejected',
    source_key:`guild-application/${application.application_id}/${application.aggregate_version}`,
    title:approved?'公會申請已核准':'公會申請未通過',
    body:[approved?`你申請的「${name}」已核准成立。`:`你申請的「${name}」這次未通過審查。`,reason].filter(Boolean).join('\n'),
    action:{tab:'guilds',resource_id:approved?application.approved_guild_key:null}});
}

/** Call only for a real inactive↔active change; a no-op rewrite still bumps the version. */
export async function notifyGuildExpertChange(q:PoolClient,communityId:string,row:{guild_key:string;user_id:string;active:boolean;aggregate_version:string|number}){
  const guild=await guildName(q,row.guild_key);
  return notifyMember(q,{community_id:communityId,recipient_ref:row.user_id,
    kind:row.active?'guild_expert_appointed':'guild_expert_revoked',
    source_key:`guild-expert/${row.guild_key}/${row.user_id}/${row.aggregate_version}`,
    title:row.active?'你已獲任命為公會專家':'公會專家任命已解除',
    body:row.active?`你已獲任命為「${guild}」的公會專家。`:`你在「${guild}」的公會專家任命已解除。`,
    action:{tab:'guilds',resource_id:row.guild_key}});
}

/**
 * officer is the row after the change; priorUserId is the previous holder
 * read from the database (canonical UUID text), or null when the seat was
 * empty. Reappointing the same person notifies nobody.
 */
export async function notifyGuildMasterChange(q:PoolClient,communityId:string,priorUserId:string|null,officer:{guild_key:string;user_id:string;aggregate_version:string|number}){
  if(priorUserId===officer.user_id)return;
  const guild=await guildName(q,officer.guild_key),source=`guild-master/${officer.guild_key}/${officer.aggregate_version}`;
  await notifyMember(q,{community_id:communityId,recipient_ref:officer.user_id,kind:'guild_master_appointed',source_key:`${source}/appointed`,
    title:'你已成為公會長',body:`你已成為「${guild}」的公會長，可以開始管理公會工作區。`,action:{tab:'guild-workspace',resource_id:officer.guild_key}});
  if(priorUserId)await notifyMember(q,{community_id:communityId,recipient_ref:priorUserId,kind:'guild_master_revoked',source_key:`${source}/revoked`,
    title:'公會長任命已變更',body:`你在「${guild}」的公會長任命已由另一位會員接任。`,action:{tab:'guilds',resource_id:officer.guild_key}});
}
