import type {ChannelKind,ChannelMessage} from '../../../../modules/member-communications/channel-types';
import type {DirectMessageContentInput} from '../../../../modules/member-communications/content-types';
import type {Message} from '../../../../modules/member-communications/types';
import {findChatSticker} from '../../../../modules/member-communications/stickers';
import {accessAwareFetch,expiredAccessStatus,isExpiredAccessResponse,MEMBER_ACCESS_EXPIRED_MESSAGE} from '../access-fetch';
import {ApiError,type PortalClient} from '../api';

export type MessageImage={content_type:'image/webp';byte_size:number};
export type UploadedMessageImage=MessageImage&{image_id:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
const isUuid=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value);
const timestamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function isMessageImage(value:unknown):value is MessageImage{
  return record(value)&&value.content_type==='image/webp'&&Number.isInteger(value.byte_size)&&Number(value.byte_size)>0&&Number(value.byte_size)<=1024*1024;
}
/** Match only the canonical fields the server actually projects. No image id is
 * exposed in Message.image; its presence/type/bounded size are the available ACK.
 * An unrecognised 2xx is unknown, never permission to discard a keyed tuple. */
export function matchesDirectMessageAck(value:unknown,expected:{sender:string;recipient:string;payload:DirectMessageContentInput}):value is Message{
  if(!record(value)||!isUuid(value.message_id)||value.sender_ref!==expected.sender||value.recipient_ref!==expected.recipient||!isUuid(value.sender_ref)||!isUuid(value.recipient_ref)||!timestamp(value.created_at)||(value.read_at!==null&&!timestamp(value.read_at)))return false;
  return matchesMessageContentAck(value,expected.payload);
}
/** A channel acknowledgement must name the original room and a canonical sequence. */
export function matchesChannelMessageAck(value:unknown,expected:{sender:string;kind:ChannelKind;channelKey:string;payload:DirectMessageContentInput}):value is ChannelMessage{
  if(!record(value)||!isUuid(value.message_id)||value.sender_ref!==expected.sender||!isUuid(value.sender_ref)||value.kind!==expected.kind||value.channel_key!==expected.channelKey||typeof value.sender_name!=='string'||!timestamp(value.created_at))return false;
  if(typeof value.sequence!=='string'||!/^\d{1,19}$/.test(value.sequence)||BigInt(value.sequence)<=0n||BigInt(value.sequence)>9223372036854775807n)return false;
  return expected.payload.image_id===undefined&&matchesMessageContentAck(value,expected.payload);
}
function matchesMessageContentAck(value:Record<string,unknown>,input:DirectMessageContentInput):boolean{
  const sticker=findChatSticker(input.sticker_id);
  const body=input.body!==undefined?input.body.replace(/\r\n?/g,'\n').trim():input.image_id!==undefined?'[圖片]':sticker?`[貼圖] ${sticker.label}`:undefined;
  if(body===undefined||value.body!==body)return false;
  if(input.image_id!==undefined?!isMessageImage(value.image):value.image!==undefined)return false;
  if(input.sticker_id!==undefined){
    if(!sticker||!record(value.sticker)||value.sticker.id!==sticker.id||value.sticker.label!==sticker.label)return false;
  }else if(value.sticker!==undefined)return false;
  if(input.reply_to_message_id!==undefined){
    const reply=value.reply_to;
    // The authorized server projection can redact the quotation after commit.
    // Require the exact original target identity; an arbitrary missing reply is unknown.
    if(reply===undefined)return isUuid(value.reply_to_message_id)&&value.reply_to_message_id===input.reply_to_message_id.toLowerCase();
    if(value.reply_to_message_id!==undefined&&value.reply_to_message_id!==input.reply_to_message_id.toLowerCase())return false;
    if(!record(reply)||reply.message_id!==input.reply_to_message_id.toLowerCase()||!isUuid(reply.sender_ref)||typeof reply.sender_name!=='string'||typeof reply.body!=='string'||[...reply.body].length>160)return false;
    if(reply.sticker!==undefined){
      if(!record(reply.sticker)||typeof reply.sticker.id!=='string')return false;
      const quotedSticker=findChatSticker(reply.sticker.id);
      if(!quotedSticker||reply.sticker.label!==quotedSticker.label)return false;
    }
  }else if(value.reply_to!==undefined||value.reply_to_message_id!==undefined)return false;
  return true;
}
/** Only a first decoder rejection is known to precede upload preparation. A
 * later rejection cannot disprove an earlier unknown commit, even for this code. */
export function isFirstImageDecoderRejection(cause:unknown,stage:'upload'|'message'|undefined,hadUnknown:boolean):boolean{
  return stage==='upload'&&!hadUnknown&&cause instanceof ApiError&&cause.status===422&&cause.code==='invalid_message_image'&&!cause.network&&!cause.timedOut&&!cause.accessExpired;
}
export const messageImageUrl=(peerId:string,messageId:string)=>`/api/v1/me/conversations/${encodeURIComponent(peerId)}/messages/${encodeURIComponent(messageId)}/image`;
export function messageImageFileError(file:File):string|null{
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))return '圖片僅支援 JPEG、PNG 或 WebP。';
  if(file.size>2*1024*1024)return '圖片大小不可超過 2 MiB。';
  return null;
}
/** Keep key stable for the selected file: an interrupted upload may already have committed. */
export async function uploadMessageImage(client:PortalClient,peerId:string,file:File,key:string):Promise<UploadedMessageImage>{
  const error=messageImageFileError(file);
  if(error)throw new ApiError({message:error,status:400});
  if(!client.csrfToken)throw new ApiError({message:'登入狀態已變更，請重新整理後再試。',status:400});
  const requestCsrfToken=client.csrfToken;
  let response:Response;
  try{
    response=await accessAwareFetch(`/api/v1/me/conversations/${encodeURIComponent(peerId)}/images`,{
      method:'POST',credentials:'same-origin',body:file,
      headers:{Accept:'application/json','Content-Type':file.type,'X-CSRF-Token':requestCsrfToken,'Idempotency-Key':key},
    });
  }catch{throw new ApiError({message:'連線中斷，圖片上傳結果尚未確認。重試會安全重用同一操作。',network:true});}
  if(await isExpiredAccessResponse(response)){
    const status=expiredAccessStatus(response);
    if(client.csrfToken===requestCsrfToken){client.accessExpired=true;if(status===401||status===403)client.csrfToken=null;client.onUnauthorized?.();}
    throw new ApiError({message:MEMBER_ACCESS_EXPIRED_MESSAGE,status,accessExpired:true});
  }
  if(client.csrfToken===requestCsrfToken){client.accessExpired=false;if(response.status===401){client.csrfToken=null;client.onUnauthorized?.();}}
  let payload:Record<string,unknown>;
  try{payload=await response.json();}catch{throw new ApiError({message:'回應未完整收到，請重試以確認圖片上傳結果。',network:true});}
  if(!response.ok)throw new ApiError({message:typeof payload?.detail==='string'?payload.detail:'圖片未能上傳，請稍後重試。',status:response.status,code:typeof payload?.code==='string'?payload.code:undefined,network:response.status>=500});
  if(!record(payload)||!isUuid(payload.image_id)||!isMessageImage(payload))throw new ApiError({message:'回應未完整收到，請重試以確認圖片上傳結果。',network:true});
  return payload as UploadedMessageImage;
}
