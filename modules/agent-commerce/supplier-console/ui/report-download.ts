import {accessAwareFetch,expiredAccessStatus,isExpiredAccessResponse,MEMBER_ACCESS_EXPIRED_MESSAGE} from '../../../../apps/portal-web/src/access-fetch';
import {ApiError,type PortalClient} from '../../../../apps/portal-web/src/api';
import type {ConsoleScope,ReportPeriod} from './route';

export async function fetchSupplierReportCsv(client:PortalClient,scope:ConsoleScope,period:ReportPeriod,signal:AbortSignal):Promise<{blob:Blob;filename:string}> {
 const generation=client.sessionGeneration,csrf=client.csrfToken,abort=new AbortController();
 const cancelled=()=>new ApiError({message:'已取消',code:'aborted',network:true});
 const changed=()=>new ApiError({message:'登入狀態已改變，未下載 CSV。',network:true});
 const check=()=>{if(signal.aborted||abort.signal.aborted)throw cancelled();if(client.sessionGeneration!==generation)throw changed();};
 const currentAuth=()=>!abort.signal.aborted&&client.sessionGeneration===generation&&client.csrfToken===csrf;
 let timer:ReturnType<typeof setTimeout>|undefined,onAbort:()=>void=()=>{};
 const interrupted=new Promise<never>((_,reject)=>{
  onAbort=()=>{abort.abort();reject(cancelled());};
  if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>{abort.abort();reject(new ApiError({message:'下載等候過久，請稍後重試。',network:true,timedOut:true}));},60_000);
 });
 const operation=async()=>{
  check();
  const query=new URLSearchParams({from:period.from,to:period.to});
  const response=await accessAwareFetch(`/api/v1/tenants/${scope.tenantId}/storefronts/${scope.instanceId}/supplier-console/report.csv?${query}`,{
   method:'GET',credentials:'same-origin',headers:{Accept:'text/csv, application/json'},signal:abort.signal,
  });
  if(await isExpiredAccessResponse(response)){
   check();const status=expiredAccessStatus(response);
   if(currentAuth()){client.accessExpired=true;if(status===401||status===403)client.csrfToken=null;client.onUnauthorized?.();}
   throw new ApiError({message:MEMBER_ACCESS_EXPIRED_MESSAGE,status,accessExpired:true});
  }
  check();
  if(currentAuth())client.accessExpired=false;
  if(!response.ok){
   let problem:{detail?:unknown;code?:unknown}|null=null;try{problem=await response.json();}catch{}
   check();
   if(response.status===401&&currentAuth()){client.csrfToken=null;client.onUnauthorized?.();}
   const detail=response.status>=500?'暫時無法產生 CSV，請稍後重試。':typeof problem?.detail==='string'?problem.detail:'無法下載 CSV，請重試。';
   throw new ApiError({message:detail,detail,status:response.status,code:typeof problem?.code==='string'?problem.code:undefined,network:response.status>=500});
  }
  if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/csv')throw new ApiError({message:'CSV 回應不完整，請重試。',network:true});
  const blob=await response.blob();check();
  return {blob,filename:`supplier-report-${period.from}_${period.to}.csv`};
 };
 // After a timeout or abort wins the race, the fetch still settles; keep that late rejection handled.
 const pending=operation();pending.catch(()=>{});
 try{return await Promise.race([pending,interrupted]);}
 catch(cause){if(cause instanceof ApiError)throw cause;check();throw new ApiError({message:'無法下載 CSV，請確認網路後重試。',network:true});}
 finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
}
