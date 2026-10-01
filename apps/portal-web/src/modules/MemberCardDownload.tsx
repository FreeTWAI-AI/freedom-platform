import {useEffect,useRef,useState,type ReactNode} from 'react';

export function MemberCardDownload({children,shareUrl,disabled=false}:{children:ReactNode;shareUrl:string;disabled?:boolean}){
  const root=useRef<HTMLDivElement>(null),generation=useRef(0),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{generation.current++;setBusy(false);setNotice('');return()=>{generation.current++;};},[shareUrl,disabled,children]);
  async function download(){
    const node=root.current?.querySelector<HTMLElement>('.ecard');if(!node||disabled||busy)return;
    const current=generation.current;setBusy(true);setNotice('');
    try{
      // Load the export library only on demand. Avatars and QR stay on this origin.
      const {toBlob}=await import('html-to-image');await document.fonts.ready;
      const blob=await toBlob(node,{pixelRatio:2,cacheBust:false,includeQueryParams:true,skipFonts:true});
      if(current!==generation.current)return;
      if(!blob)throw Error('empty image');
      const url=URL.createObjectURL(blob),anchor=document.createElement('a');
      anchor.href=url;anchor.download='freedom-workshop-card.png';anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),10000);setNotice('名片圖片已產生。更新連結後，請重新下載。');
    }catch{if(current===generation.current)setNotice('圖片暫時無法下載，請重試或直接分享名片連結。');}
    finally{if(current===generation.current)setBusy(false);}
  }
  return <div className="ecard-download" ref={root}>{children}{shareUrl&&<div className="ecard-export-actions"><button type="button" className="btn btn-ghost" disabled={disabled||busy} onClick={()=>void download()}>{busy?'正在產生圖片…':'下載名片 PNG'}</button>{disabled&&<p className="field-hint">保存分享設定後即可下載含 QR Code 的名片。</p>}{notice&&<p role="status" className="field-hint">{notice}</p>}</div>}</div>;
}
