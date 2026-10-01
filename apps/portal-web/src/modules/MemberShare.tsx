import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {PortalClient} from '../api';
import {MemberCardShareActions} from './MemberCardShareActions';
import {MemberCardDownload} from './MemberCardDownload';
import {MemberECard,cardDesigns,parseCardLink,type CardDesign,type CardLink} from './MemberECard';
import {useModuleMutation} from './shared';
import './MemberConnections.css';

type ShareSettings={enabled:boolean;include_avatar:boolean;aggregate_version:number|null;share_path:string|null;design:CardDesign;headline:string|null;links:CardLink[]};
type DraftLink=CardLink&{id:string};
type SocialItem={link_id:string;label:string;url:string};
type PreviewMember={nickname:string;avatar_url?:string|null;primary_guild:{name:string}|null;capabilities:string[];custom_capabilities?:string[];featured_capabilities?:string[]};
type Preview={userId:string;nickname:string;guild:string|null;capabilities:string[];avatarUrl:string|null};
const control=/[\u0000-\u001f\u007f]/;
const chars=(value:string)=>Array.from(value).length;
function headlineIssue(value:string){if(control.test(value))return '一句話介紹請使用單行文字。';if(chars(value.trim())>60)return '一句話介紹最多 60 個字。';return '';}
function featuredNames(member:PreviewMember,labels:Record<string,string>){
  const available=[...member.capabilities,...(member.custom_capabilities??[]).map(value=>`custom:${value}`)];
  return (member.featured_capabilities??available).filter(id=>available.includes(id)).slice(0,3).map(id=>id.startsWith('custom:')?id.slice(7):labels[id]??id);
}

export function MemberShare({client}:{client:PortalClient}){
  const [settings,setSettings]=useState<ShareSettings|null>(null),[includeAvatar,setIncludeAvatar]=useState(false),[design,setDesign]=useState<CardDesign>('calm'),[headline,setHeadline]=useState(''),[links,setLinks]=useState<DraftLink[]>([]),[draftLabel,setDraftLabel]=useState(''),[draftUrl,setDraftUrl]=useState(''),[editing,setEditing]=useState<DraftLink|null>(null),[importOpen,setImportOpen]=useState(false),[social,setSocial]=useState<SocialItem[]|null>(null),[socialError,setSocialError]=useState(''),[socialLoading,setSocialLoading]=useState(false),[preview,setPreview]=useState<Preview|null>(null),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState('');
  const generation=useRef(0),profileGeneration=useRef(0),{mutate,busy,error}=useModuleMutation(client);
  function apply(data:ShareSettings){setSettings(data);setIncludeAvatar(data.include_avatar);setDesign(data.design??'calm');setHeadline(data.headline??'');setLinks((data.links??[]).map(link=>({...link,id:crypto.randomUUID()})));setEditing(null);}
  async function load(){const current=++generation.current;setLoadError('');try{const data=await client.get<ShareSettings>('/me/member-card-share');if(current===generation.current)apply(data);}catch(cause){if(current===generation.current)setLoadError(cause instanceof Error?cause.message:'分享設定暫時無法載入。');}}
  async function loadPreview(){const profile=++profileGeneration.current;try{
    const account=await client.get<{user_id:string;nickname:string;avatar:{avatar_url:string|null}}>('/me/account');
    const [member,labels]=await Promise.all([client.get<PreviewMember>(`/members/${account.user_id}`),client.get<{capability_categories:{options:{id:string;label:string}[]}[]}>('/assessment-definition').then(definition=>Object.fromEntries(definition.capability_categories.flatMap(group=>group.options.map(option=>[option.id,option.label])))).catch(()=>({} as Record<string,string>))]);
    if(profile!==profileGeneration.current)return;setPreview({userId:account.user_id,nickname:member.nickname||account.nickname,guild:member.primary_guild?.name??null,capabilities:featuredNames(member,labels),avatarUrl:member.avatar_url??account.avatar.avatar_url});
  }catch{if(profile===profileGeneration.current)setPreview(null);}}
  useEffect(()=>{void load();void loadPreview();const refresh=()=>void loadPreview();window.addEventListener('freedom-profile-updated',refresh);return()=>{generation.current++;profileGeneration.current++;window.removeEventListener('freedom-profile-updated',refresh);};},[client]);
  async function save(enabled:boolean,rotate=false){
    if(!settings)return;setNotice('');const issue=headlineIssue(headline);if(issue){setNotice(issue);return;}
    const wasEnabled=settings.enabled,result=await mutate<ShareSettings>('/me/member-card-share',{enabled,include_avatar:includeAvatar,rotate,design,headline:headline.trim()||null,links:links.map(({label,url})=>({label,url}))},settings.aggregate_version??undefined);
    if(result){apply(result);setNotice(!enabled?'分享名片已關閉。':rotate?'連結已更新，舊連結已失效。':wasEnabled?'名片設定已保存。':'分享名片已開啟。');}
  }
  function commit(label:string,url:string,ignore?:string){const parsed=parseCardLink(label,url);if(!parsed.ok){setNotice(parsed.message);return null;}if(links.some(link=>link.url===parsed.link.url&&link.id!==ignore)){setNotice('這個連結已經在名片上。');return null;}setNotice('');return parsed.link;}
  function addLink(event:FormEvent){event.preventDefault();if(links.length>=8){setNotice('名片連結最多 8 個。');return;}const link=commit(draftLabel,draftUrl);if(!link)return;setLinks(current=>[...current,{...link,id:crypto.randomUUID()}]);setDraftLabel('');setDraftUrl('');}
  function move(index:number,delta:number){const next=index+delta;if(next<0||next>=links.length)return;setLinks(current=>{const copy=[...current];const [item]=copy.splice(index,1);copy.splice(next,0,item!);return copy;});}
  function finishEdit(event:FormEvent){event.preventDefault();if(!editing)return;const link=commit(editing.label,editing.url,editing.id);if(!link)return;setLinks(current=>current.map(item=>item.id===editing.id?{...item,...link}:item));setEditing(null);}
  async function toggleImport(){const open=!importOpen;setImportOpen(open);if(!open||social||socialLoading)return;setSocialError('');setSocialLoading(true);try{const data=await client.get<{items:SocialItem[]}>('/me/social-links?limit=50');setSocial(data.items);}catch(cause){setSocialError(cause instanceof Error?cause.message:'社群連結暫時無法載入。');}finally{setSocialLoading(false);}}
  function importLink(item:SocialItem){
    if(chars(item.label.trim())>30){setNotice('這個名稱超過 30 個字，請先在社群連結改短再加入名片。');return;}
    if(links.length>=8){setNotice('名片連結最多 8 個。');return;}
    const link=commit(item.label,item.url);if(!link)return;setLinks(current=>[...current,{...link,id:crypto.randomUUID()}]);
  }
  const url=settings?.share_path?new URL(settings.share_path,window.location.origin).href:'';
  const unsaved=!settings||settings.design!==design||settings.include_avatar!==includeAvatar||(settings.headline??'')!==headline.trim()||JSON.stringify(settings.links)!==JSON.stringify(links.map(({label,url})=>({label,url})));
  // The owner's versioned avatar refreshes immediately after edits. Only a saved
  // opt-in preview can be exported; PNG contains pixels, never the avatar URL.
  const previewAvatar=includeAvatar?preview?.avatarUrl??null:null;
  return <section className="card stack member-share-settings" aria-label="分享我的工坊名片"><h2>分享我的工坊名片</h2><p>朋友開啟連結即可看到你選的名片樣式、一句話介紹、連結、名稱、主要公會和三項精選專長，並從名片加入自由工坊。聯絡方式與未加入名片的社群連結仍只依原本的設定提供給已登入會員。</p>
    {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重讀分享設定</button></div>}
    {error&&<div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void load()}>重讀分享設定</button></div>}
    {!settings&&!loadError&&<p role="status">正在載入分享設定…</p>}
    {settings&&<><label className="checkbox-row"><input type="checkbox" checked={includeAvatar} disabled={busy} onChange={event=>setIncludeAvatar(event.target.checked)}/>在分享頁顯示我的頭像</label>
      <div className="ecard-design-picker" role="group" aria-label="名片樣式">{cardDesigns.map(([key,name])=><button type="button" className="ecard-design-option" key={key} aria-pressed={design===key} disabled={busy} onClick={()=>setDesign(key)}><span className={`ecard-swatch ecard-swatch-${key}`} aria-hidden="true"/>{name}</button>)}</div>
      <label className="field">一句話介紹<input maxLength={60} value={headline} disabled={busy} onChange={event=>setHeadline(event.target.value)} placeholder="例如：做開源的人"/></label>
      <p className="field-hint">最多 60 個字。留白就只顯示公會和專長。</p>
      <div className="ecard-link-editor"><h3>名片連結</h3><p className="field-hint">最多 8 個。按鈕會顯示名稱，下面附上網址的網域。</p>
        <ul className="ecard-link-list">{links.map((link,index)=><li key={link.id}>{editing?.id===link.id?<form className="ecard-link-draft" onSubmit={finishEdit}><label className="field">連結名稱<input required maxLength={30} value={editing.label} disabled={busy} onChange={event=>setEditing({...editing,label:event.target.value})}/></label><label className="field">連結網址<input type="url" required maxLength={300} value={editing.url} disabled={busy} onChange={event=>setEditing({...editing,url:event.target.value})}/></label><div className="ecard-link-row"><button className="ecard-icon-btn" disabled={busy}>完成編輯</button><button type="button" className="ecard-icon-btn" disabled={busy} onClick={()=>setEditing(null)}>取消</button></div></form>:<div className="ecard-link-row"><div className="ecard-link-meta"><strong>{link.label}</strong><span>{link.url}</span></div><button type="button" className="ecard-icon-btn" disabled={busy||index===0} aria-label={`上移第 ${index+1} 個連結 ${link.label}`} onClick={()=>move(index,-1)}>上移</button><button type="button" className="ecard-icon-btn" disabled={busy||index===links.length-1} aria-label={`下移第 ${index+1} 個連結 ${link.label}`} onClick={()=>move(index,1)}>下移</button><button type="button" className="ecard-icon-btn" disabled={busy||editing!==null} aria-label={`編輯第 ${index+1} 個連結 ${link.label}`} onClick={()=>setEditing({...link})}>編輯</button><button type="button" className="ecard-icon-btn" disabled={busy} aria-label={`移除第 ${index+1} 個連結 ${link.label}`} onClick={()=>setLinks(current=>current.filter(item=>item.id!==link.id))}>移除</button></div>}</li>)}</ul>
        {links.length<8&&editing===null&&<form className="ecard-link-draft" onSubmit={addLink}><label className="field">連結名稱<input maxLength={30} value={draftLabel} disabled={busy} onChange={event=>setDraftLabel(event.target.value)}/></label><label className="field">連結網址<input type="url" inputMode="url" maxLength={300} value={draftUrl} disabled={busy} onChange={event=>setDraftUrl(event.target.value)} placeholder="https://"/></label><button type="submit" className="btn btn-ghost" disabled={busy}>加入連結</button></form>}
        <button type="button" className="ecard-text-btn" disabled={busy} aria-expanded={importOpen} onClick={()=>void toggleImport()}>從我的社群連結加入</button>
        {importOpen&&<div className="ecard-import"><p className="field-hint">這些連結目前只有符合你設定的會員看得到，要點「加入名片」才會出現在分享頁。</p>{socialError&&<p role="alert">{socialError}</p>}{socialLoading&&<p role="status">正在讀取社群連結…</p>}{social&&social.length===0&&<p className="field-hint">尚未新增社群連結。</p>}<ul className="ecard-import-list">{social?.map(item=><li className="ecard-import-row" key={item.link_id}><div className="ecard-link-meta"><strong>{item.label}</strong><span>{item.url}</span></div><button type="button" className="ecard-import-add" disabled={busy} aria-label={`把「${item.label}」加入名片`} onClick={()=>importLink(item)}>加入名片</button></li>)}</ul></div>}
      </div>
      <aside className="ecard-preview" aria-label="名片預覽"><h3>名片預覽</h3><p className="field-hint">自動帶入你的名稱、公會與精選專長；頭像依上方設定顯示。保存後更新分享頁，開啟分享才會產生 QR Code。</p>{preview?<MemberCardDownload shareUrl={url} disabled={unsaved||busy}><MemberECard design={design} nickname={preview.nickname} headline={headline} guildName={preview.guild} capabilities={preview.capabilities} avatarUrl={previewAvatar} links={links} heading="p" shareUrl={url}/></MemberCardDownload>:<p role="status">{loadError?'':'名片資料尚未載入。'}<button type="button" className="btn btn-ghost" onClick={()=>void loadPreview()}>重讀名片資料</button></p>}</aside>
      {settings.enabled&&url?<><MemberCardShareActions kind="member_card" target={preview?.userId} title={preview?.nickname||'自由工坊名片'} label="分享" url={url} onNotice={setNotice}/><div className="actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void save(true)}>保存分享設定</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void save(true,true)}>更新連結</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void save(false)}>停用分享</button></div></>:<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void save(true)}>建立分享連結</button>}
    </>}{notice&&<p role="status" className="field-hint">{notice}</p>}
  </section>;
}
