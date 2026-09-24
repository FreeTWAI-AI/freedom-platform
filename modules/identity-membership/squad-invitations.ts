import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { command,checkVersion,journal,type Command } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { notifyMember } from '../member-communications/notifications.js';
import type { Actor } from './service.js';

// Owner invites, the recipient accepts/declines, the owner may withdraw. Only the
// recipient's accept creates/activates membership, so squad-only contacts stay
// hidden until then. Every write shares changeSquadMembership's per-(squad,member)
// advisory lock, then locks membership before invitation in that fixed order.
// A new invite first takes a per-squad budget lock (budget -> pair), so the
// pending limit holds across recipients; answers never take the budget lock.
// Invite and accept need both parties eligible. Withdraw and decline only need the
// acting party eligible, so a pending row whose other party later became inactive or
// onboarding-incomplete can still be closed and never pins the pending limit.
const eligibleAs=(alias:string)=>`${alias}.active AND (NOT ${alias}.onboarding_required OR ${alias}.onboarding_completed_at IS NOT NULL)`;
const eligible=eligibleAs('u');
// An ineligible party keeps its opaque ref but never its current or stored name.
export const UNAVAILABLE_MEMBER='目前不可用的會員';
const uuid=(value:string)=>z.uuid().parse(value).toLowerCase();
export const OwnerInvitationQuery=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
export const ReceivedInvitationQuery=OwnerInvitationQuery.extend({state:z.enum(['pending','all']).default('pending')}).strict();
const InviteInput=z.object({recipient_ref:z.uuid()}).strict();
const PENDING_LIMIT=50;

async function eligibleMember(q:Pool|PoolClient,communityId:string,userId:string,lock=false) {
  const row=(await q.query(`SELECT u.user_id,u.display_name FROM users u WHERE u.user_id=$1 AND u.community_id=$2 AND ${eligible}${lock?' FOR SHARE':''}`,[userId,communityId])).rows[0];
  requireCondition(row,404,'member_not_found','找不到這位會員。');return row as {user_id:string;display_name:string};
}
// Same-community existence only, locked so the member cannot change community mid-command.
async function communityMember(q:PoolClient,communityId:string,userId:string) {
  const row=(await q.query(`SELECT ${eligible} AS eligible FROM users u WHERE u.user_id=$1 AND u.community_id=$2 FOR SHARE`,[userId,communityId])).rows[0];
  requireCondition(row,404,'member_not_found','找不到這位會員。');return row.eligible as boolean;
}
// Direct service calls get the same current-session and member gate as the HTTP middleware.
async function eligibleActor(q:Pool|PoolClient,actor:Actor) {
  const row=(await q.query(`SELECT ${eligible} AS eligible,EXISTS(SELECT 1 FROM sessions s WHERE s.token_hash=$3 AND s.user_id=u.user_id
    AND s.revoked_at IS NULL AND s.expires_at>now()) AS current_session FROM users u WHERE u.user_id=$1 AND u.community_id=$2`,[actor.user_id,actor.community_id,actor.session_hash])).rows[0];
  requireCondition(row?.current_session,401,'session_expired','請重新登入。');
  requireCondition(row.eligible,403,'onboarding_required','請先完成定位測驗並選擇主要公會。');
}
async function communitySquad(q:Pool|PoolClient,actor:Actor,id:string) {
  const row=(await q.query('SELECT squad_id,name,owner_ref FROM member_squads WHERE squad_id=$1 AND community_id=$2',[id,actor.community_id])).rows[0];
  requireCondition(row,404,'squad_not_found','找不到這個小隊。');return row as {squad_id:string;name:string;owner_ref:string};
}
const shownName=(alias:string)=>`CASE WHEN ${alias}.community_id=i.community_id AND ${eligibleAs(alias)} THEN ${alias}.display_name ELSE '${UNAVAILABLE_MEMBER}' END`;
const projection=`SELECT i.invitation_id,i.squad_id,s.name AS squad_name,i.owner_ref,${shownName('o')} AS owner_name,i.recipient_ref,${shownName('r')} AS recipient_name,
  i.state,i.aggregate_version,i.created_at,i.updated_at,i.resolved_at
  FROM member_squad_invitations i JOIN member_squads s ON s.squad_id=i.squad_id AND s.community_id=i.community_id
  JOIN users o ON o.user_id=i.owner_ref JOIN users r ON r.user_id=i.recipient_ref`;
const iso=(value:unknown)=>value?new Date(value as string).toISOString():null;
function view(row:any) {
  return {invitation_id:row.invitation_id,squad_id:row.squad_id,squad_name:row.squad_name,owner_ref:row.owner_ref,owner_name:row.owner_name,
    recipient_ref:row.recipient_ref,recipient_name:row.recipient_name,state:row.state as 'pending'|'accepted'|'declined'|'withdrawn',
    aggregate_version:String(row.aggregate_version),created_at:iso(row.created_at)!,updated_at:iso(row.updated_at)!,resolved_at:iso(row.resolved_at)};
}
export type SquadInvitationView=ReturnType<typeof view>;
async function invitationView(q:PoolClient,id:string) {return view((await q.query(`${projection} WHERE i.invitation_id=$1`,[id])).rows[0]);}
async function lockPair(q:PoolClient,squadId:string,recipientId:string) {
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`squad-membership/${squadId}/${recipientId}`]);
  return (await q.query('SELECT * FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2 FOR UPDATE',[squadId,recipientId])).rows[0] as {state:string}|undefined;
}
const clip=(text:string,max:number)=>text.length>max?text.slice(0,max-1)+'…':text;
async function notify(q:PoolClient,actor:Actor,invitation:SquadInvitationView,recipient:string,suffix:string,title:string,body:string) {
  await notifyMember(q,{community_id:actor.community_id,recipient_ref:recipient,kind:'squad_invitation',source_key:`squad-invitation:${invitation.invitation_id}${suffix}`,
    title:clip(title,160),body:clip(body,2000),action:{tab:'squads',resource_id:invitation.squad_id}});
}

export async function inviteToSquad(pool:Pool,input:Command,squadId:string) {
  squadId=uuid(squadId);const recipientId=InviteInput.parse(input.body).recipient_ref.toLowerCase();
  requireCondition(recipientId!==input.actor.user_id,422,'squad_self_invitation','不能邀請自己加入小隊。');
  let squad!:Awaited<ReturnType<typeof communitySquad>>;
  return command(pool,input,async q=>{
    await eligibleActor(q,input.actor);squad=await communitySquad(q,input.actor,squadId);
    requireCondition(squad.owner_ref===input.actor.user_id,403,'squad_owner_required','只有小隊發起人可以邀請夥伴。');
    await eligibleMember(q,input.actor.community_id,recipientId,true);
  },async q=>{
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`squad-invitation-budget/${squadId}`]);
    const membership=await lockPair(q,squadId,recipientId);
    requireCondition(membership?.state!=='active',409,'squad_member_already','這位夥伴已經在小隊裡。');
    const pending=(await q.query(`SELECT invitation_id FROM member_squad_invitations WHERE squad_id=$1 AND recipient_ref=$2 AND state='pending' FOR UPDATE`,[squadId,recipientId])).rows[0];
    if(pending)return invitationView(q,pending.invitation_id); // Same pending invite: no new row, version or notification.
    const open=(await q.query(`SELECT count(*)::int AS n FROM member_squad_invitations WHERE squad_id=$1 AND state='pending'`,[squadId])).rows[0].n;
    requireCondition(open<PENDING_LIMIT,409,'squad_invitation_limit',`每支小隊最多同時有 ${PENDING_LIMIT} 份待回覆邀請。`);
    const id=randomUUID();
    await q.query(`INSERT INTO member_squad_invitations(invitation_id,community_id,squad_id,owner_ref,recipient_ref,state) VALUES($1,$2,$3,$4,$5,'pending')`,[id,input.actor.community_id,squadId,input.actor.user_id,recipientId]);
    await journal(q,input.actor,'member_squad_invitation',id,1,'invite',{squad_id:squadId});
    const created=await invitationView(q,id);
    await notify(q,input.actor,created,recipientId,'',`${created.owner_name}邀請你加入小隊「${created.squad_name}」`,'前往小隊集合，接受或婉拒邀請。');
    return created;
  });
}

type Resolution='accept'|'decline'|'withdraw';
const resolvedState={accept:'accepted',decline:'declined',withdraw:'withdrawn'} as const;
export async function resolveSquadInvitation(pool:Pool,input:Command,invitationId:string,action:Resolution) {
  z.object({}).strict().parse(input.body);invitationId=uuid(invitationId);
  let target!:{squad_id:string;owner_ref:string;recipient_ref:string},otherVisible=false;
  const response=await command(pool,input,async q=>{
    await eligibleActor(q,input.actor);
    // Parties are immutable columns; state and version are checked under lock.
    const row=(await q.query('SELECT squad_id,owner_ref,recipient_ref FROM member_squad_invitations WHERE invitation_id=$1 AND community_id=$2',[invitationId,input.actor.community_id])).rows[0];
    requireCondition(row&&(row.owner_ref===input.actor.user_id||row.recipient_ref===input.actor.user_id),404,'squad_invitation_not_found','找不到這份小隊邀請。');
    const squad=await communitySquad(q,input.actor,row.squad_id);
    if(action==='withdraw')requireCondition(squad.owner_ref===input.actor.user_id&&row.owner_ref===input.actor.user_id,403,'squad_owner_required','只有小隊發起人可以撤回邀請。');
    else requireCondition(row.recipient_ref===input.actor.user_id,403,'squad_invitation_recipient_only','只有受邀本人可以回覆這份邀請。');
    const other=input.actor.user_id===row.owner_ref?row.recipient_ref:row.owner_ref;
    if(action==='accept'){await eligibleMember(q,input.actor.community_id,other,true);otherVisible=true;}
    else otherVisible=await communityMember(q,input.actor.community_id,other);
    target=row;
  },async q=>{
    const membership=await lockPair(q,target.squad_id,target.recipient_ref);
    const row=(await q.query('SELECT * FROM member_squad_invitations WHERE invitation_id=$1 FOR UPDATE',[invitationId])).rows[0];
    checkVersion(String(row.aggregate_version),input.expected);
    requireCondition(row.state==='pending',409,'squad_invitation_not_pending','這份邀請已經回覆或撤回。');
    // An earlier accepted join request already made them active: settle the invite only.
    if(action==='accept'&&membership?.state!=='active')await q.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')
      ON CONFLICT(squad_id,user_id) DO UPDATE SET state='active',aggregate_version=member_squad_memberships.aggregate_version+1,updated_at=now()`,[target.squad_id,target.recipient_ref]);
    const updated=(await q.query(`UPDATE member_squad_invitations SET state=$2,aggregate_version=aggregate_version+1,updated_at=now(),resolved_at=now()
      WHERE invitation_id=$1 RETURNING aggregate_version`,[invitationId,resolvedState[action]])).rows[0];
    await journal(q,input.actor,'member_squad_invitation',invitationId,updated.aggregate_version,action,{squad_id:target.squad_id});
    const result=await invitationView(q,invitationId);
    if(action==='accept')await notify(q,input.actor,result,target.owner_ref,':accepted',`${result.recipient_name}接受了小隊「${result.squad_name}」的邀請`,'對方已加入小隊，可以在小隊詳情看到夥伴名單。');
    else if(action==='decline')await notify(q,input.actor,result,target.owner_ref,':declined',`${result.recipient_name}婉拒了小隊「${result.squad_name}」的邀請`,'需要時可以之後再次邀請。');
    else await notify(q,input.actor,result,target.recipient_ref,':withdrawn',`${result.owner_name}撤回了小隊「${result.squad_name}」的邀請`,'這份邀請已不能接受；你仍可以自行申請加入小隊。');
    return result;
  });
  // A replayed receipt keeps its state and version but follows the other party's current visibility.
  if(otherVisible)return response;
  return input.actor.user_id===target.owner_ref?{...response,recipient_name:UNAVAILABLE_MEMBER}:{...response,owner_name:UNAVAILABLE_MEMBER};
}

// Outbound history is visible only to the squad owner. A recipient who is no longer
// eligible stays listed (anonymized) so the owner can still withdraw that pending row.
export async function squadInvitations(pool:Pool,actor:Actor,squadId:string,raw:unknown) {
  squadId=uuid(squadId);const {limit,offset}=OwnerInvitationQuery.parse(raw);
  await eligibleActor(pool,actor);const squad=await communitySquad(pool,actor,squadId);
  requireCondition(squad.owner_ref===actor.user_id,403,'squad_owner_required','只有小隊發起人可以查看送出的邀請。');
  const rows=(await pool.query(`${projection} WHERE i.squad_id=$1 AND i.community_id=$2 AND i.owner_ref=$3 AND r.community_id=$2
    ORDER BY (i.state='pending') DESC,i.updated_at DESC,i.invitation_id LIMIT $4 OFFSET $5`,[squadId,actor.community_id,actor.user_id,limit+1,offset])).rows;
  return {items:rows.slice(0,limit).map(view),next_offset:rows.length>limit?offset+limit:null};
}
// Received invitations are visible only to the recipient; an inactive owner hides them.
export async function receivedSquadInvitations(pool:Pool,actor:Actor,raw:unknown) {
  const {limit,offset,state}=ReceivedInvitationQuery.parse(raw);await eligibleActor(pool,actor);
  const rows=(await pool.query(`${projection} WHERE i.recipient_ref=$1 AND i.community_id=$2 AND ($3='all' OR i.state='pending') AND s.owner_ref=i.owner_ref
    AND o.community_id=$2 AND o.active AND (NOT o.onboarding_required OR o.onboarding_completed_at IS NOT NULL)
    ORDER BY (i.state='pending') DESC,i.updated_at DESC,i.invitation_id LIMIT $4 OFFSET $5`,[actor.user_id,actor.community_id,state,limit+1,offset])).rows;
  return {items:rows.slice(0,limit).map(view),next_offset:rows.length>limit?offset+limit:null};
}
