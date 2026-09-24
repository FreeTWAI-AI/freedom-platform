// Stable DTOs for member notifications and direct messages (migration 035).
// All pages are newest first; limit 1..50 (default 20), offset >= 0.

export const NOTIFICATION_KINDS=[
  'friend_request','friend_accepted','friend_declined','squad_invitation',
  'guild_application_approved','guild_application_rejected',
  'guild_expert_appointed','guild_expert_revoked',
  'guild_master_appointed','guild_master_revoked',
] as const;
export type NotificationKind=typeof NOTIFICATION_KINDS[number];

export const NOTIFICATION_ACTION_TABS=['members','squads','guilds','guild-workspace','messages'] as const;
export type NotificationActionTab=typeof NOTIFICATION_ACTION_TABS[number];

// members/messages/squads carry a member or squad UUID; guilds/guild-workspace
// carry a canonical guild key. resource_id null opens the tab itself.
export type NotificationAction=
  |{tab:'members';resource_id:string|null}
  |{tab:'messages';resource_id:string|null}
  |{tab:'squads';resource_id:string|null}
  |{tab:'guilds';resource_id:string|null}
  |{tab:'guild-workspace';resource_id:string|null};

export type Notification={
  notification_id:string;kind:NotificationKind;title:string;body:string;
  created_at:string;read_at:string|null;action:NotificationAction|null;
};
export type NotificationList={items:Notification[];unread_count:number;next_offset:number|null};

export type Message={
  message_id:string;sender_ref:string;recipient_ref:string;body:string;
  created_at:string;read_at:string|null;
};
export type Participant={user_id:string;display_name:string;avatar_url:string|null};
export type Conversation={participant:Participant;can_send:boolean;last_message:Message;unread_count:number};
/** unread_count: total unread direct messages for the viewer. */
export type ConversationPage={items:Conversation[];unread_count:number;next_offset:number|null};
/** unread_count: unread messages from this participant to the viewer. */
export type MessagePage={participant:Participant;can_send:boolean;items:Message[];unread_count:number;next_offset:number|null};

export const COMMUNICATION_PAGE_DEFAULT_LIMIT=20;
export const COMMUNICATION_PAGE_MAX_LIMIT=50;
export const NOTIFICATION_SOURCE_KEY_MAX=200;
export const NOTIFICATION_TITLE_MAX=160;
export const NOTIFICATION_BODY_MAX=2000;
export const DIRECT_MESSAGE_BODY_MAX=2000;
