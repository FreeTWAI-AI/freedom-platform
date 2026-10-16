import {accessAwareFetch,expiredAccessStatus,isExpiredAccessResponse,MEMBER_ACCESS_EXPIRED_MESSAGE} from '../../../../apps/portal-web/src/access-fetch';
import {ApiError,type PortalClient} from '../../../../apps/portal-web/src/api';
import {SUPPLY_MATERIAL_IMAGE_SOURCE_MAX_BYTES,SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES,SUPPLY_MATERIAL_VIDEO_MAX_BYTES,SUPPLY_MATERIAL_VIDEO_TYPES} from '../../../../contracts/guild-launchpad/v1/supplier-console';
import {materialAcknowledgement,type MaterialUploadAttempt} from '../state/material-upload';
export const MATERIAL_UPLOAD_UNKNOWN='尚未確認上傳結果。檔案仍保留，請按重試原操作確認後再離開。';
export const MATERIAL_VIDEO_PROBLEM='影片需為 MP4 或 WebM，最多 20 MB。請先壓縮（建議 H.264／AAC、720p、60 秒內）再上傳。';
export function materialFileProblem(kind:'image'|'video',file:Pick<File,'type'|'size'>){
 if(kind==='video')return !(SUPPLY_MATERIAL_VIDEO_TYPES as readonly string[]).includes(file.type)||file.size<1||file.size>SUPPLY_MATERIAL_VIDEO_MAX_BYTES?MATERIAL_VIDEO_PROBLEM:null;
 if(!(SUPPLY_MATERIAL_IMAGE_SOURCE_TYPES as readonly string[]).includes(file.type))return '圖片請選擇 PNG、JPEG 或 WebP。';
 return file.size<1||file.size>SUPPLY_MATERIAL_IMAGE_SOURCE_MAX_BYTES?'圖片需在 2 MB 以下，請選擇完整的靜態圖。':null;
}
export async function sendMaterialUpload(client:PortalClient,a:MaterialUploadAttempt){
 if(!client.csrfToken)throw new ApiError({message:MEMBER_ACCESS_EXPIRED_MESSAGE,status:401,accessExpired:true});
 const csrf=client.csrfToken,generation=client.sessionGeneration,abort=new AbortController();
 const check=()=>{if(client.sessionGeneration!==generation||abort.signal.aborted)throw new ApiError({message:MATERIAL_UPLOAD_UNKNOWN,network:true});};
 const currentAuth=()=>client.sessionGeneration===generation&&client.csrfToken===csrf;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new ApiError({message:MATERIAL_UPLOAD_UNKNOWN,network:true,timedOut:true}));},60_000);});
 const operation=async()=>{
  const response=await accessAwareFetch(`/api/v1/tenants/${a.tenantId}/storefronts/${a.instanceId}/supply-materials/${a.materialId}/content`,{method:'POST',credentials:'same-origin',signal:abort.signal,
   headers:{Accept:'application/json','Content-Type':a.file.type,'X-CSRF-Token':csrf,'Idempotency-Key':a.key,'If-Match':`"${a.expected}"`},body:a.file});check();
  const expired=await isExpiredAccessResponse(response);check();
  if(expired){const status=expiredAccessStatus(response);if(currentAuth()){client.accessExpired=true;if(status===401||status===403)client.csrfToken=null;client.onUnauthorized?.();}throw new ApiError({message:MEMBER_ACCESS_EXPIRED_MESSAGE,status,accessExpired:true});}
  if(currentAuth())client.accessExpired=false;
  if(response.status===401){if(currentAuth()){client.csrfToken=null;client.onUnauthorized?.();}throw new ApiError({message:'登入已過期，請重新登入。',status:401});}
  let payload:unknown;try{payload=await response.json();}catch{throw new ApiError({message:MATERIAL_UPLOAD_UNKNOWN,network:true});}check();
  if(!response.ok){const p=payload as {detail?:unknown;code?:unknown};const known=response.status>=400&&response.status<500&&typeof p?.code==='string';const detail=typeof p?.detail==='string'?p.detail:'素材上傳未完成。';throw new ApiError({message:detail,detail,status:response.status,code:typeof p?.code==='string'?p.code:undefined,network:!known});}
  const ack=materialAcknowledgement(payload,a);if(!ack)throw new ApiError({message:MATERIAL_UPLOAD_UNKNOWN,network:true});return ack;
 };
 const pending=operation();pending.catch(()=>{});
 try{return await Promise.race([pending,deadline]);}catch(e){if(e instanceof ApiError)throw e;throw new ApiError({message:MATERIAL_UPLOAD_UNKNOWN,network:true});}finally{clearTimeout(timer);}
}
