import type {ChatSticker} from './stickers.js';

export type MessageReply={message_id:string;sender_ref:string;sender_name:string;body:string;sticker?:ChatSticker};
/** Text-only DTOs keep their existing shape. Rich fields are additive and optional. */
export type MessageContent={sticker?:ChatSticker;reply_to?:MessageReply};
export type MessageContentInput={body?:string;sticker_id?:string;reply_to_message_id?:string};
