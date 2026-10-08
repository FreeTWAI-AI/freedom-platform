import {accessAwareFetch,expiredAccessStatus,isExpiredAccessResponse,MEMBER_ACCESS_EXPIRED_MESSAGE} from '../access-fetch';
import {ApiError,type PortalClient} from '../api';

export type MessageImage={content_type:'image/webp';byte_size:number};
export type UploadedMessageImage=MessageImage&{image_id:string};
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
  if(!payload||typeof payload.image_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.image_id)||payload.content_type!=='image/webp'||typeof payload.byte_size!=='number')throw new ApiError({message:'回應未完整收到，請重試以確認圖片上傳結果。',network:true});
  return payload as UploadedMessageImage;
}
