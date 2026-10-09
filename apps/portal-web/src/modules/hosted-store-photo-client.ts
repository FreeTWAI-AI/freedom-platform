import { accessAwareFetch,expiredAccessStatus,isExpiredAccessResponse,MEMBER_ACCESS_EXPIRED_MESSAGE } from '../access-fetch';
import { ApiError,type PortalClient } from '../api';
import { photoAcknowledgement,type PhotoAttempt } from './hosted-store-photo-state';

export function productPhotoFileError(file:File){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))return '請選擇 PNG、JPEG 或 WebP 照片。';
  if(file.size<1||file.size>2*1024*1024)return '請選擇 2 MiB 以下的完整照片。';
  return null;
}
export async function sendProductPhoto(client:PortalClient,attempt:PhotoAttempt){
  if(!client.csrfToken)throw new ApiError({message:MEMBER_ACCESS_EXPIRED_MESSAGE,status:401,accessExpired:true});
  const csrf=client.csrfToken,generation=client.sessionGeneration;
  const path=`/api/v1/tenants/${attempt.tenantId}/storefronts/${attempt.instanceId}/products/${attempt.productId}/photo${attempt.action==='remove'?'/remove':''}`;
  let response:Response;
  try {response=await accessAwareFetch(path,{method:'POST',credentials:'same-origin',
    headers:{Accept:'application/json','Content-Type':attempt.file?.type??'application/json','X-CSRF-Token':csrf,'Idempotency-Key':attempt.key,'If-Match':`"${attempt.expected}"`},body:attempt.file??'{}'});}
  catch{throw new ApiError({message:'照片操作結果尚未確認，請重試原操作。',network:true});}
  if(await isExpiredAccessResponse(response)){
    const status=expiredAccessStatus(response);
    if(client.sessionGeneration===generation&&client.csrfToken===csrf){client.accessExpired=true;if(status===401||status===403)client.csrfToken=null;client.onUnauthorized?.();}
    throw new ApiError({message:MEMBER_ACCESS_EXPIRED_MESSAGE,status,accessExpired:true});
  }
  if(client.sessionGeneration!==generation)throw new ApiError({message:'登入狀態已改變，照片操作結果尚未確認。',network:true});
  // A platform JSON 401 is distinct from Cloudflare Access expiry. Notify the
  // shell before reading the error body, while fencing out an older session.
  client.accessExpired=false;
  if(response.status===401){
    client.csrfToken=null;client.onUnauthorized?.();
    throw new ApiError({message:'登入已過期，請重新登入。',status:401});
  }
  let payload:unknown;try{payload=await response.json();}catch{throw new ApiError({message:'照片回應未完整收到，請重試原操作。',network:true});}
  if(!response.ok){const problem=payload as {detail?:string;code?:string};throw new ApiError({message:typeof problem?.detail==='string'?problem.detail:'照片操作未完成。',status:response.status,code:problem?.code,network:response.status>=500});}
  const ack=photoAcknowledgement(payload,attempt);
  if(!ack)throw new ApiError({message:'照片回應未完整收到，請重試原操作。',network:true});
  return ack;
}
