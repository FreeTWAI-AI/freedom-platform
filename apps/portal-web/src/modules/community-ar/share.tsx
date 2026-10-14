import {useEffect,useState} from 'react';
import {useLocalAction} from '../../useLocalAction';
import {PlatformLogo} from '../SocialCrossPlatformShare';
import {SHARE_PLATFORMS,SHARE_LABELS,socialShareUrl,type SharePlatform} from '../../social-share';

export function ArPhotoShare({file,text,onClose}:{file:File;text:string;onClose:()=>void}){
  const [selected,setSelected]=useState<SharePlatform[]>([]),[notice,setNotice]=useState(''),[manual,setManual]=useState(false),[preview,setPreview]=useState('');
  const action=useLocalAction([file,text]);
  useEffect(()=>{const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
  let canShare=false;try{canShare=!!navigator.share&&navigator.canShare?.({files:[file]})===true;}catch{/* explicit file download remains available */}
  function download(){const a=document.createElement('a');a.href=preview;a.download=file.name;a.click();}
  return <section className="ar-photo-share" aria-label="分享 AR 照片">
    <header className="ar-row"><h3>這張照片，準備好了</h3><button className="btn btn-ghost" type="button" disabled={!!action.pending} onClick={onClose}>關閉預覽</button></header>
    {preview&&<img src={preview} alt="剛拍攝的相機與 AR 合成照片"/>}
    <p className="muted">照片保留在這台裝置。選好平台後，由你在該平台完成發布。</p>
    <fieldset disabled={!!action.pending}><legend>分享到哪些平台？</legend><div className="social-share-logos">
      {SHARE_PLATFORMS.map(platform=><button key={platform} className="social-share-platform" type="button" aria-label={SHARE_LABELS[platform]} aria-pressed={selected.includes(platform)} onClick={()=>setSelected(value=>value.includes(platform)?value.filter(p=>p!==platform):[...value,platform])}><span className="social-share-logo"><PlatformLogo platform={platform}/><span className="social-share-light"/></span><span>{SHARE_LABELS[platform]}</span></button>)}
    </div></fieldset>
    <div className="ar-actions"><button className="btn btn-ghost" type="button" onClick={download}>下載照片</button><button className="btn btn-ghost" type="button" disabled={!!action.pending} onClick={()=>{void action.run('copy',()=>navigator.clipboard.writeText(text)).then(result=>{if(result.status==='done')setNotice('介紹已複製。');if(result.status==='failed'){setManual(true);setNotice('可以從下方選取介紹後複製。');}});}}>複製介紹</button>
      {canShare&&<button className="btn btn-primary" type="button" disabled={!!action.pending} onClick={()=>{void action.run('share',()=>navigator.share({files:[file],text})).then(result=>{if(result.status==='done')setNotice('已交給裝置的分享選單，請在選擇的平台完成發布。');if(result.status==='failed')setNotice('分享已取消或未完成。可以重試，或下載照片。');});}}>用裝置分享</button>}
    </div>
    {manual&&<textarea readOnly aria-label="分享介紹" value={text} onFocus={event=>event.target.select()} rows={3}/>}
    {!!selected.length&&<div className="ar-actions">{selected.map(platform=><a key={platform} className="btn btn-ghost" href={socialShareUrl(platform,text)} target="_blank" rel="noopener noreferrer" onClick={()=>setNotice(`已請求開啟 ${SHARE_LABELS[platform]}，請加入照片並完成發布。`)}>開啟 {SHARE_LABELS[platform]}</a>)}</div>}
    {!canShare&&<p className="field-hint">這個瀏覽器未提供檔案分享。先下載照片、複製介紹，再開啟選擇的平台。</p>}
    <p role="status" aria-live="polite">{notice}</p>
  </section>;
}
