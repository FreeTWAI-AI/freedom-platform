/** Retry only this application's failed optional module, using a fresh module-map key. */
export function shareModuleRetryUrl(cause:unknown,origin:string,attempt:number):string|null{
  if(!(cause instanceof Error)||cause.message.length>2048||!Number.isInteger(attempt)||attempt<1||attempt>3)return null;
  for(const match of cause.message.matchAll(/https?:\/\/[^\s"'<>]+/g)){
    try{
      const url=new URL(match[0]);
      if(url.origin!==origin||url.username||url.password||url.hash||!/^\/assets\/SocialCrossPlatformShare-[a-zA-Z0-9_-]+\.js$/.test(url.pathname))continue;
      if(url.search&&(!/^\?share-retry=[1-3]$/.test(url.search)||attempt<=Number(url.searchParams.get('share-retry'))))continue;
      url.searchParams.set('share-retry',String(attempt));return url.toString();
    }catch{/* Unknown loader errors keep the draft editor available. */}
  }
  return null;
}
