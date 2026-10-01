import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import type {MessageContent} from './content-types.js';
import {findChatSticker} from './stickers.js';

/** No arbitrary image URLs, HTML, media fetching, or client-supplied quote text. */
export const MessageContentInput=z.object({
  body:z.string().transform(value=>value.replace(/\r\n?/g,'\n').trim())
    .refine(value=>value.length>0,'請輸入訊息內容。')
    .refine(value=>[...value].length<=2000,'訊息最多 2000 字。')
    .refine(value=>!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),'訊息不可包含控制字元。').optional(),
  sticker_id:z.string().refine(value=>Boolean(findChatSticker(value)),'找不到這張貼圖。').optional(),
  reply_to_message_id:z.uuid().transform(value=>value.toLowerCase()).optional(),
}).strict().refine(value=>(value.body===undefined)!==(value.sticker_id===undefined),'請傳送文字或選擇一張貼圖。');
export function storedMessageBody(input:z.infer<typeof MessageContentInput>){
  return input.body??`[貼圖] ${findChatSticker(input.sticker_id)!.label}`;
}
function stickerContent(id:string|null|undefined):Pick<MessageContent,'sticker'>{
  const sticker=findChatSticker(id);return sticker?{sticker:{id:sticker.id,label:sticker.label}}:{};
}
/** One bounded query for quotes of the already-authorized page, never N+1 reads. */
export async function messageContents(q:Pool|PoolClient,rows:any[],kind:'channel'|'direct',viewer:string):Promise<MessageContent[]>{
  const ids=[...new Set(rows.map(row=>row.reply_to_message_id).filter(Boolean))];
  const replies=ids.length?(await q.query(`SELECT m.message_id,m.sender_ref,u.display_name AS sender_name,left(m.body,160) AS body,m.sticker_id
    FROM ${kind==='channel'?'member_channel_messages':'member_direct_messages'} m JOIN users u ON u.user_id=m.sender_ref
    WHERE m.message_id=ANY($1::uuid[]) ${kind==='channel'?"AND (m.kind<>'world' OR m.sender_ref=$2 OR NOT is_verification_test_account(m.sender_ref))":'AND ($2::uuid IS NOT NULL)'}`,[ids,viewer])).rows:[];
  const byId=new Map(replies.map(row=>[row.message_id,row]));
  return rows.map(row=>{const quote=byId.get(row.reply_to_message_id);return {...stickerContent(row.sticker_id),...(quote?{reply_to:{message_id:quote.message_id,sender_ref:quote.sender_ref,sender_name:quote.sender_name,body:quote.body,...stickerContent(quote.sticker_id)}}:{})};});
}
