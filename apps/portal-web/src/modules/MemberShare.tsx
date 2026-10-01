import {useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {useModuleMutation} from './shared';
import './MemberConnections.css';
type ShareSettings={enabled:boolean;include_avatar:boolean;aggregate_version:number|null;share_path:string|null};
export function MemberShare({client}:{client:PortalClient}){
  const [settings,setSettings]=useState<ShareSettings|null>(null),[includeAvatar,setIncludeAvatar]=useState(true),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState('');
  const generation=useRef(0),{mutate,busy,error}=useModuleMutation(client);
  async function load(){const current=++generation.current;setLoadError('');try{const data=await client.get<ShareSettings>('/me/member-card-share');if(current===generation.current){setSettings(data);setIncludeAvatar(data.include_avatar);}}catch(cause){if(current===generation.current)setLoadError(cause instanceof Error?cause.message:'分享設定暫時無法載入。');}}
  useEffect(()=>{void load();return()=>{generation.current++;};},[client]);
  async function save(enabled:boolean,rotate=false){if(!settings)return;setNotice('');const result=await mutate<ShareSettings>('/me/member-card-share',{enabled,include_avatar:includeAvatar,rotate},settings.aggregate_version??undefined);if(result){setSettings(result);setIncludeAvatar(result.include_avatar);setNotice(enabled?rotate?'連結已更新，舊連結已失效。':'分享名片已開啟。':'分享名片已關閉。');}}
  const url=settings?.share_path?new URL(settings.share_path,window.location.origin).href:'';
  async function share(native:boolean){setNotice('');try{if(native&&navigator.share)await navigator.share({title:'自由工坊・我的名片',text:'一起加入自由工坊，找到夥伴、學習與創作。',url});else{await navigator.clipboard.writeText(url);setNotice('名片邀請連結已複製。');}}catch(cause){if(cause instanceof DOMException&&cause.name==='AbortError')return;setNotice('分享未完成，你可以選取下方連結手動複製。');}}
  return <section className="card stack member-share-settings" aria-label="分享我的工坊名片"><h2>分享我的工坊名片</h2><p>朋友開啟連結即可看到你的名稱、主要公會和三項精選專長，並從名片加入自由工坊。聯絡方式仍依你原本的設定提供給已登入會員。</p>
    {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重讀分享設定</button></div>}
    {error&&<div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void load()}>重讀分享設定</button></div>}
    {!settings&&!loadError&&<p role="status">正在載入分享設定…</p>}
    {settings&&<><label className="checkbox-row"><input type="checkbox" checked={includeAvatar} disabled={busy} onChange={event=>setIncludeAvatar(event.target.checked)}/>在分享頁顯示我的頭像</label>
      {settings.enabled&&url?<><label className="field">名片邀請連結<input readOnly value={url} onFocus={event=>event.currentTarget.select()}/></label><div className="actions"><button type="button" className="btn btn-primary" onClick={()=>void share(true)}>分享名片</button><button type="button" className="btn btn-ghost" onClick={()=>void share(false)}>複製連結</button><a className="btn btn-ghost" href={settings.share_path!} target="_blank" rel="noopener noreferrer">預覽分享頁 ↗</a></div>
        <div className="actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void save(true)}>保存分享設定</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void save(true,true)}>更新連結</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void save(false)}>停用分享</button></div>
      </>:<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void save(true)}>建立分享連結</button>}
    </>}{notice&&<p role="status" className="field-hint">{notice}</p>}
  </section>;
}
