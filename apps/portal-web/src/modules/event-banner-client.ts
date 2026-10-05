import { accessAwareFetch, expiredAccessStatus, isExpiredAccessResponse, MEMBER_ACCESS_EXPIRED_MESSAGE } from '../access-fetch';
import { ApiError, type PortalClient } from '../api';
import type { CommunityEvent } from './EventsPanel';

export async function uploadEventBanner(client:PortalClient,event:CommunityEvent,file:File):Promise<CommunityEvent>{
  if(!client.csrfToken)throw new ApiError({message:'登入狀態已變更，請重新整理後再試。',status:400});
  const requestCsrfToken=client.csrfToken;
  let response:Response;
  let orientation:'portrait'|'landscape'='landscape';
  try{const image=await createImageBitmap(file);orientation=image.height>image.width?'portrait':'landscape';image.close();}catch{/* Server still validates the image; use a landscape canvas. */}
  if(client.csrfToken!==requestCsrfToken)throw new ApiError({message:'登入狀態已變更，請重新整理後再試。',status:409});
  try{response=await accessAwareFetch(`/api/v1/events/${event.event_id}/banner`,{
    method:'POST',credentials:'same-origin',body:file,
    headers:{Accept:'application/json','Content-Type':file.type,'X-Poster-Orientation':orientation,'X-CSRF-Token':client.csrfToken,'Idempotency-Key':crypto.randomUUID(),'If-Match':`"${event.aggregate_version}"`},
  });}catch{throw new ApiError({message:'連線中斷；活動已保存，請在活動卡片重試 Banner。',network:true});}
  if(await isExpiredAccessResponse(response)){
    const status=expiredAccessStatus(response);
    if(client.csrfToken===requestCsrfToken){client.accessExpired=true;if(status===401||status===403)client.csrfToken=null;client.onUnauthorized?.();}
    throw new ApiError({message:MEMBER_ACCESS_EXPIRED_MESSAGE,status,accessExpired:true});
  }
  if(client.csrfToken===requestCsrfToken){client.accessExpired=false;if(response.status===401){client.csrfToken=null;client.onUnauthorized?.();}}
  let payload:Record<string,unknown>;
  try{payload=await response.json();}catch{throw new ApiError({message:'Banner 保存結果尚未確認，請重新整理活動查看。',network:true});}
  if(!response.ok)throw new ApiError({message:typeof payload.detail==='string'?payload.detail:'Banner 未能保存，請稍後重試。',status:response.status,code:typeof payload.code==='string'?payload.code:undefined,network:response.status>=500});
  return payload as CommunityEvent;
}

export async function uploadEventVideo(client:PortalClient,event:CommunityEvent,file:File):Promise<CommunityEvent>{
  if(!client.csrfToken)throw new ApiError({message:'登入狀態已變更，請重新整理後再試。',status:400});
  const requestCsrfToken=client.csrfToken;
  let response:Response;
  try{response=await accessAwareFetch(`/api/v1/events/${event.event_id}/video`,{
    method:'POST',credentials:'same-origin',body:file,
    headers:{Accept:'application/json','Content-Type':file.type,'X-CSRF-Token':client.csrfToken,'Idempotency-Key':crypto.randomUUID(),'If-Match':`"${event.aggregate_version}"`},
  });}catch{throw new ApiError({message:'連線中斷；活動已保存，請在活動卡片重試影片。',network:true});}
  if(await isExpiredAccessResponse(response)){
    const status=expiredAccessStatus(response);
    if(client.csrfToken===requestCsrfToken){client.accessExpired=true;if(status===401||status===403)client.csrfToken=null;client.onUnauthorized?.();}
    throw new ApiError({message:MEMBER_ACCESS_EXPIRED_MESSAGE,status,accessExpired:true});
  }
  if(client.csrfToken===requestCsrfToken){client.accessExpired=false;if(response.status===401){client.csrfToken=null;client.onUnauthorized?.();}}
  let payload:Record<string,unknown>;
  try{payload=await response.json();}catch{throw new ApiError({message:'影片保存結果尚未確認，請重新整理活動查看。',network:true});}
  if(!response.ok)throw new ApiError({message:typeof payload.detail==='string'?payload.detail:'影片未能保存，請稍後重試。',status:response.status,code:typeof payload.code==='string'?payload.code:undefined,network:response.status>=500});
  return payload as CommunityEvent;
}
