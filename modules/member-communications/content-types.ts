import type {ChatSticker} from './stickers.js';

export type MessageReply={message_id:string;sender_ref:string;sender_name:string;body:string;sticker?:ChatSticker};
/** Text-only DTOs keep their existing shape. Rich fields are additive and optional. */
/** Direct messages only. The bytes are read through an authenticated API route; there is no URL here. */
export type MessageImage={content_type:'image/webp';byte_size:number};
export type MessageContent={sticker?:ChatSticker;image?:MessageImage;reply_to?:MessageReply};
export type MessageContentInput={body?:string;sticker_id?:string;reply_to_message_id?:string};
export type DirectMessageContentInput=MessageContentInput&{image_id?:string};
