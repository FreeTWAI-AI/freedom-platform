import {useMemo} from 'react';
import QRCode from 'qrcode';

// Encode only the current opt-in capability URL, never account IDs or contacts.
export function memberCardQr(url:string,origin:string){
  try{
    const parsed=new URL(url);
    if(parsed.origin!==origin||!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash||!/^\/member-cards\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname))return null;
    const qr=QRCode.create(parsed.href,{errorCorrectionLevel:'M'}),size=qr.modules.size;
    let path='';
    for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.modules.get(y,x))path+=`M${x+4} ${y+4}h1v1h-1z`;
    return {url:parsed.href,size:size+8,path};
  }catch{return null;}
}

export function MemberCardQr({url}:{url:string}){
  const qr=useMemo(()=>memberCardQr(url,window.location.origin),[url]);
  if(!qr)return null;
  return <a className="ecard-qr" href={qr.url} aria-label="開啟這張工坊名片">
    <svg role="img" aria-label="這張名片的專屬 QR Code" xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${qr.size} ${qr.size}`} width="148" height="148" shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="#fff"/><path d={qr.path} fill="#08090b"/>
    </svg><span>掃碼認識我 <span aria-hidden="true">↗</span></span>
  </a>;
}
