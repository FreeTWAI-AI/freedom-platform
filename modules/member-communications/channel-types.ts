// Stable DTOs for member guild/squad group channels (migration 037).
// One channel per current active guild or squad membership; channels are never
// created by hand and grant no role. Pages are newest first.
// Sequences are bigint in PostgreSQL and serialized as decimal strings.

export const CHANNEL_KINDS=['guild','squad'] as const;
export type ChannelKind=typeof CHANNEL_KINDS[number];

/** guild: catalog guild_key; squad: lowercase squad UUID. */
export type Channel={kind:ChannelKind;channel_key:string;name:string};
/** unread_count excludes the viewer's own messages. */
export type ChannelSummary=Channel&{unread_count:number;last_message_at:string|null};
/** unread_count: total across all current active channels of the requested kind. */
export type ChannelList={items:ChannelSummary[];unread_count:number;next_offset:number|null};

/** sender_ref is users.user_id. */
export type ChannelMessage={
  message_id:string;kind:ChannelKind;channel_key:string;sequence:string;
  sender_ref:string;sender_name:string;body:string;created_at:string;
};
/** Newest sequence first; unread_count is this channel's unread for the viewer. */
export type ChannelMessagePage={channel:Channel;items:ChannelMessage[];unread_count:number;next_offset:number|null};

export type ChannelMessageInput={body:string};
/** through_message_id must be a message of this channel the viewer has seen. */
export type ChannelReadInput={through_message_id:string};
export type ChannelReadResult={kind:ChannelKind;channel_key:string;read_sequence:string;read_at:string};

export const CHANNEL_PAGE_DEFAULT_LIMIT=20;
export const CHANNEL_PAGE_MAX_LIMIT=50;
export const CHANNEL_PAGE_MAX_OFFSET=10000;
export const CHANNEL_KEY_MAX=100;
/** Counted in Unicode code points after trim and CRLF normalization. */
export const CHANNEL_MESSAGE_BODY_MAX=2000;
// Mirrors the member_chat_channels channel_key CHECK.
export const GUILD_CHANNEL_KEY_PATTERN=/^(guild_[a-z_]+|guild_custom_[0-9A-Fa-f]{32})$/;
export const SQUAD_CHANNEL_KEY_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Left, unknown, foreign or inactive channels all answer 404 with this code. */
export const CHANNEL_NOT_AVAILABLE='channel_not_available';
