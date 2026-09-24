import type {PoolClient} from 'pg';
import {z} from 'zod';
import {
  NOTIFICATION_ACTION_TABS,NOTIFICATION_BODY_MAX,NOTIFICATION_KINDS,NOTIFICATION_SOURCE_KEY_MAX,NOTIFICATION_TITLE_MAX,
  type NotificationAction,type NotificationKind,
} from './types.js';

const uuid=z.string().uuid();
const guildKey=z.string().max(100).regex(/^guild_(?:[a-z_]+|custom_[0-9a-fA-F]{32})$/);
const action=z.discriminatedUnion('tab',[
  z.object({tab:z.literal('members'),resource_id:uuid.nullable()}).strict(),
  z.object({tab:z.literal('messages'),resource_id:uuid.nullable()}).strict(),
  z.object({tab:z.literal('squads'),resource_id:uuid.nullable()}).strict(),
  z.object({tab:z.literal('guilds'),resource_id:guildKey.nullable()}).strict(),
  z.object({tab:z.literal('guild-workspace'),resource_id:guildKey.nullable()}).strict(),
]);
const notifyInput=z.object({
  community_id:uuid,
  recipient_ref:uuid,
  kind:z.enum(NOTIFICATION_KINDS),
  source_key:z.string().min(1).max(NOTIFICATION_SOURCE_KEY_MAX),
  title:z.string().trim().min(1).max(NOTIFICATION_TITLE_MAX),
  body:z.string().trim().min(1).max(NOTIFICATION_BODY_MAX),
  action:action.nullable(),
}).strict();
// Keep the zod tab list and the exported tuple in lockstep.
const _tabs:readonly NotificationAction['tab'][]=NOTIFICATION_ACTION_TABS;void _tabs;

export type NotifyMemberInput={
  community_id:string;recipient_ref:string;kind:NotificationKind;source_key:string;
  title:string;body:string;action:NotificationAction|null;
};

/**
 * Records one in-app notification inside the caller's transaction, so it
 * commits or rolls back with the domain change. Returns null when the same
 * (community, recipient, source_key) was already recorded (safe replay).
 * The recipient only has to exist in the community; readiness or activity is
 * not required and nothing here grants roles or sends email/external traffic.
 * Invalid input or cross-community routing is a programming error and throws.
 */
export async function notifyMember(q:PoolClient,input:NotifyMemberInput):Promise<{notification_id:string}|null>{
  const parsed=notifyInput.safeParse(input);
  if(!parsed.success)throw new Error(`notification_input_invalid: ${parsed.error.issues.map(i=>i.path.join('.')||'input').join(',')}`);
  const n=parsed.data;
  const recipient=await q.query('SELECT 1 FROM users WHERE user_id=$1 AND community_id=$2',[n.recipient_ref,n.community_id]);
  if(!recipient.rowCount)throw new Error('notification_recipient_outside_community');
  const inserted=await q.query<{notification_id:string}>(
    `INSERT INTO member_notifications(community_id,recipient_ref,kind,source_key,title,body,action_tab,action_resource_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (community_id,recipient_ref,source_key) DO NOTHING
     RETURNING notification_id`,
    [n.community_id,n.recipient_ref,n.kind,n.source_key,n.title,n.body,n.action?.tab??null,n.action?.resource_id??null]);
  return inserted.rows[0]?{notification_id:inserted.rows[0].notification_id}:null;
}
