import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ApiError,type PortalClient} from '../api';
import {BrandIcon} from './BrandIcon';
import {MemberCardShareActions} from './MemberCardShareActions';
import {MemberECard,cardDesigns,parseCardLink,type CardDesign,type CardLink,type CardProfileLink} from './MemberECard';
import './MemberConnections.css';

type ProfileItem=CardProfileLink&{source:string;shown:boolean};
type ShareSettings={enabled:boolean;include_avatar:boolean;aggregate_version:number|string|null;share_path:string|null;design:CardDesign;headline:string|null;links:CardLink[];show_profile_links:boolean;profile_link_prefs:Record<string,boolean>;profile_links:ProfileItem[]};
type DraftLink=CardLink&{id:string};
type SocialItem={link_id:string;label:string;url:string};
type PreviewMember={nickname:string;avatar_url?:string|null;primary_guild:{name:string}|null;capabilities:string[];custom_capabilities?:string[];featured_capabilities?:string[]};
type Preview={userId:string;nickname:string;guild:string|null;capabilities:string[];avatarUrl:string|null};
type Local={includeAvatar:boolean;design:CardDesign;headline:string;links:DraftLink[];showProfileLinks:boolean;prefs:Record<string,boolean>;profileLinks:ProfileItem[];sharePath:string|null;enabled:boolean};
type SaveKind='idle'|'dirty'|'saving'|'saved'|'error'|'conflict';
type Explicit={enabled:boolean;rotate:boolean};
const control=/[\u0000-\u001f\u007f]/;
const chars=(value:string)=>Array.from(value).length;
const SAVED='已自動儲存，分享頁就是這個樣子。';
const blank:Local={includeAvatar:false,design:'calm',headline:'',links:[],showProfileLinks:true,prefs:{},profileLinks:[],sharePath:null,enabled:false};
function headlineIssue(value:string){if(control.test(value))return '一句話介紹請使用單行文字。';if(chars(value.trim())>60)return '一句話介紹最多 60 個字。';return '';}
function versionNum(value:number|string|null|undefined){if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}
function signature(state:Local){
  const prefs=Object.keys(state.prefs).sort().map(key=>[key,state.prefs[key]]);
  return JSON.stringify({include_avatar:state.includeAvatar,design:state.design,headline:state.headline.trim(),links:state.links.map(link=>[link.label,link.url]),show:state.showProfileLinks,prefs});
}
function visibleProfile(state:Local):CardProfileLink[]{
  if(!state.showProfileLinks)return [];
  const urls=new Set(state.links.map(link=>link.url));
  return state.profileLinks.filter(item=>item.shown&&!(item.url&&urls.has(item.url))).map(({platform,label,handle,url})=>({platform,label,handle,url}));
}
function featuredNames(member:PreviewMember,labels:Record<string,string>){
  const available=[...member.capabilities,...(member.custom_capabilities??[]).map(value=>`custom:${value}`)];
  return (member.featured_capabilities??available).filter(id=>available.includes(id)).slice(0,3).map(id=>id.startsWith('custom:')?id.slice(7):labels[id]??id);
}

export function MemberShare({client}:{client:PortalClient}){
  const [local,setLocal]=useState<Local>(blank),[ready,setReady]=useState(false),[draftLabel,setDraftLabel]=useState(''),[draftUrl,setDraftUrl]=useState(''),[editing,setEditing]=useState<DraftLink|null>(null),[importOpen,setImportOpen]=useState(false),[social,setSocial]=useState<SocialItem[]|null>(null),[socialError,setSocialError]=useState(''),[socialLoading,setSocialLoading]=useState(false),[preview,setPreview]=useState<Preview|null>(null),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState(''),[headlineError,setHeadlineError]=useState(''),[status,setStatus]=useState<{kind:SaveKind;message:string}>({kind:'idle',message:''}),[actionBusy,setActionBusy]=useState(false);
  const profileGeneration=useRef(0),fetchGen=useRef(0),localRef=useRef(blank),serverRef=useRef<{enabled:boolean;version:number|null}>({enabled:false,version:null}),editGen=useRef(0),lastSavedSig=useRef(''),explicitRef=useRef<Explicit|null>(null),running=useRef(false),pumpAgain=useRef(false),refreshSerial=useRef(0),debounce=useRef(0),unsavedRef=useRef(false);
  const refreshRef=useRef<()=>void>(()=>{});
  unsavedRef.current=status.kind==='dirty'||status.kind==='saving'||status.kind==='error'||Boolean(headlineError);
  function apply(data:ShareSettings){
    window.clearTimeout(debounce.current);
    const next:Local={includeAvatar:data.include_avatar,design:data.design??'calm',headline:data.headline??'',links:(data.links??[]).map(link=>({...link,id:crypto.randomUUID()})),showProfileLinks:data.show_profile_links??true,prefs:data.profile_link_prefs??{},profileLinks:data.profile_links??[],sharePath:data.share_path,enabled:data.enabled};
    localRef.current=next;serverRef.current={enabled:data.enabled,version:versionNum(data.aggregate_version)};lastSavedSig.current=signature(next);editGen.current+=1;setLocal(next);setHeadlineError('');setEditing(null);setReady(true);
  }
  async function reloadConflict(){
    const data=await client.get<ShareSettings>('/me/member-card-share');
    apply(data);setStatus({kind:'conflict',message:'名片設定在其他地方更新了，已重新載入最新版本。'});
  }
  const pumpRef=useRef<()=>Promise<void>>(async()=>{});
  pumpRef.current=async()=>{
    for(;;){
      pumpAgain.current=false;
      const job=explicitRef.current;explicitRef.current=null;
      const issue=headlineIssue(localRef.current.headline);
      if(issue){setHeadlineError(issue);break;}
      const sig=signature(localRef.current);
      if(!job&&sig===lastSavedSig.current){setStatus({kind:'saved',message:SAVED});break;}
      const gen=editGen.current,sentRefresh=refreshSerial.current,snapshot=localRef.current;
      setStatus({kind:'saving',message:'儲存中…'});
      try{
        const result=await client.post<ShareSettings>('/me/member-card-share',{
          enabled:job?job.enabled:serverRef.current.enabled,include_avatar:snapshot.includeAvatar,rotate:job?job.rotate:false,design:snapshot.design,
          headline:snapshot.headline.trim()||null,links:snapshot.links.map(({label,url})=>({label,url})),show_profile_links:snapshot.showProfileLinks,profile_link_prefs:snapshot.prefs,
        },{idempotencyKey:crypto.randomUUID(),ifMatch:versionNum(serverRef.current.version)??undefined});
        serverRef.current={enabled:result.enabled,version:versionNum(result.aggregate_version)};
        // A response never replaces text typed while it was in flight. Profile rows refreshed mid-flight stay too.
        const base={...localRef.current,enabled:result.enabled,sharePath:result.share_path};
        const next=editGen.current===gen&&refreshSerial.current===sentRefresh?{...base,profileLinks:result.profile_links,showProfileLinks:result.show_profile_links,prefs:result.profile_link_prefs??{}}:base;
        localRef.current=next;setLocal(next);
        if(editGen.current===gen){lastSavedSig.current=signature(next);setStatus({kind:'saved',message:SAVED});setNotice(job?.rotate?'連結已更新，舊連結已失效。':job&&!job.enabled?'分享名片已關閉。':'');}
        else setStatus({kind:'dirty',message:'有變更尚未儲存'});
      }catch(cause){
        if(cause instanceof ApiError&&cause.status===412){try{await reloadConflict();}catch(reloadError){setStatus({kind:'error',message:reloadError instanceof Error?reloadError.message:'名片設定暫時無法載入。'});}break;}
        setStatus({kind:'error',message:cause instanceof Error?cause.message:'名片設定暫時無法儲存。'});break;
      }
      if(job)setActionBusy(explicitRef.current!==null);
      if(explicitRef.current||editGen.current!==gen||pumpAgain.current)continue;
      break;
    }
  };
  function kick(){
    if(running.current){pumpAgain.current=true;return;}
    running.current=true;
    void pumpRef.current().finally(()=>{running.current=false;setActionBusy(explicitRef.current!==null);if(explicitRef.current||pumpAgain.current||(signature(localRef.current)!==lastSavedSig.current&&!headlineIssue(localRef.current.headline)))kick();});
  }
  function assign(partial:Partial<Local>,when:'now'|'debounce'|'none'){
    const previous=localRef.current,next={...previous,...partial};
    localRef.current=next;setLocal(next);setHeadlineError(headlineIssue(next.headline));
    if(signature(next)===signature(previous))return;
    editGen.current+=1;
    if(signature(next)===lastSavedSig.current&&!running.current&&!explicitRef.current){window.clearTimeout(debounce.current);setStatus({kind:'saved',message:SAVED});return;}
    setStatus({kind:'dirty',message:'有變更尚未儲存'});
    if(headlineIssue(next.headline)||when==='none'){window.clearTimeout(debounce.current);return;}
    if(when==='debounce'){window.clearTimeout(debounce.current);debounce.current=window.setTimeout(()=>{if(!headlineIssue(localRef.current.headline))kick();},800);return;}
    window.clearTimeout(debounce.current);kick();
  }
  function runExplicit(job:Explicit){
    window.clearTimeout(debounce.current);
    const issue=headlineIssue(localRef.current.headline);
    if(issue){setHeadlineError(issue);return;}
    explicitRef.current=job;setActionBusy(true);kick();
  }
  async function refreshProfile(){
    const serial=++fetchGen.current;
    try{
      const data=await client.get<ShareSettings>('/me/member-card-share');
      if(serial!==fetchGen.current)return;
      const got=versionNum(data.aggregate_version),current=serverRef.current.version;
      if(current!==null&&(got===null||got<current))return;
      const clean=signature(localRef.current)===lastSavedSig.current&&!headlineIssue(localRef.current.headline);
      if(!ready){apply(data);setStatus({kind:'idle',message:''});return;}
      if(got!==current){if(clean){apply(data);setStatus({kind:'idle',message:''});}return;}
      refreshSerial.current+=1;
      if(clean){
        const next={...localRef.current,profileLinks:data.profile_links??[],showProfileLinks:data.show_profile_links,prefs:data.profile_link_prefs??{}};
        localRef.current=next;lastSavedSig.current=signature(next);setLocal(next);return;
      }
      const prefs=localRef.current.prefs;
      const next={...localRef.current,profileLinks:(data.profile_links??[]).map(item=>Object.hasOwn(prefs,item.source)?{...item,shown:Boolean(prefs[item.source])}:item)};
      localRef.current=next;setLocal(next);
    }catch(cause){if(serial===fetchGen.current&&!ready)setLoadError(cause instanceof Error?cause.message:'分享設定暫時無法載入。');}
  }
  refreshRef.current=()=>{void refreshProfile();};
  useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(!unsavedRef.current)return;event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
  useEffect(()=>{setLoadError('');void refreshProfile();
    const profile=++profileGeneration.current;void (async()=>{try{
      const account=await client.get<{user_id:string;nickname:string;avatar:{avatar_url:string|null}}>('/me/account');
      const [member,labels]=await Promise.all([client.get<PreviewMember>(`/members/${account.user_id}`),client.get<{capability_categories:{options:{id:string;label:string}[]}[]}>('/assessment-definition').then(definition=>Object.fromEntries(definition.capability_categories.flatMap(group=>group.options.map(option=>[option.id,option.label])))).catch(()=>({} as Record<string,string>))]);
      if(profile!==profileGeneration.current)return;setPreview({userId:account.user_id,nickname:member.nickname||account.nickname,guild:member.primary_guild?.name??null,capabilities:featuredNames(member,labels),avatarUrl:member.avatar_url??account.avatar.avatar_url});
    }catch{if(profile===profileGeneration.current)setPreview(null);}})();
    const refresh=()=>refreshRef.current();
    window.addEventListener('focus',refresh);window.addEventListener('freedom-profile-updated',refresh);window.addEventListener('freedom-social-links-updated',refresh);
    return()=>{profileGeneration.current++;fetchGen.current++;window.clearTimeout(debounce.current);window.removeEventListener('focus',refresh);window.removeEventListener('freedom-profile-updated',refresh);window.removeEventListener('freedom-social-links-updated',refresh);};},[client]);
  function commit(label:string,url:string,ignore?:string){const parsed=parseCardLink(label,url);if(!parsed.ok){setNotice(parsed.message);return null;}if(localRef.current.links.some(link=>link.url===parsed.link.url&&link.id!==ignore)){setNotice('這個連結已經在名片上。');return null;}setNotice('');return parsed.link;}
  function addLink(event:FormEvent){event.preventDefault();if(localRef.current.links.length>=8){setNotice('名片連結最多 8 個。');return;}const link=commit(draftLabel,draftUrl);if(!link)return;assign({links:[...localRef.current.links,{...link,id:crypto.randomUUID()}]},'now');setDraftLabel('');setDraftUrl('');}
  function move(index:number,delta:number){const next=index+delta,links=localRef.current.links;if(next<0||next>=links.length)return;const copy=[...links];const [item]=copy.splice(index,1);copy.splice(next,0,item!);assign({links:copy},'now');}
  function finishEdit(event:FormEvent){event.preventDefault();if(!editing)return;const link=commit(editing.label,editing.url,editing.id);if(!link)return;assign({links:localRef.current.links.map(item=>item.id===editing.id?{...item,...link}:item)},'now');setEditing(null);}
  async function toggleImport(){const open=!importOpen;setImportOpen(open);if(!open||social||socialLoading)return;setSocialError('');setSocialLoading(true);try{const data=await client.get<{items:SocialItem[]}>('/me/social-links?limit=50');setSocial(data.items);}catch(cause){setSocialError(cause instanceof Error?cause.message:'社群連結暫時無法載入。');}finally{setSocialLoading(false);}}
  function importLink(item:SocialItem){
    if(chars(item.label.trim())>30){setNotice('這個名稱超過 30 個字，請先在社群連結改短再加入名片。');return;}
    if(localRef.current.links.length>=8){setNotice('名片連結最多 8 個。');return;}
    const link=commit(item.label,item.url);if(!link)return;assign({links:[...localRef.current.links,{...link,id:crypto.randomUUID()}]},'now');
  }
  const url=local.enabled&&local.sharePath?new URL(local.sharePath,window.location.origin).href:'';
  const pending=(status.kind==='dirty'||status.kind==='saving')&&!headlineError;
  const blocked=pending||Boolean(headlineError)||status.kind==='error';
  return <section className="card stack member-share-settings" aria-label="分享我的工坊名片"><h2>分享我的工坊名片</h2><p>朋友打開連結就能看到你選的樣式、一句話介紹、連結，以及你設為「平台公開」的聯絡方式和社群連結（可逐項隱藏），並從名片加入自由工坊。所有變更都會自動儲存。</p>
    {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" onClick={()=>void client.get<ShareSettings>('/me/member-card-share').then(apply).catch(cause=>setLoadError(cause instanceof Error?cause.message:'分享設定暫時無法載入。'))}>重讀分享設定</button></div>}
    {!ready&&!loadError&&<p role="status">正在載入分享設定…</p>}
    {ready&&<div className="member-share-layout"><div className="member-share-fields">
      <label className="checkbox-row"><input type="checkbox" checked={local.includeAvatar} onChange={event=>assign({includeAvatar:event.target.checked},'now')}/>在分享頁顯示我的頭像</label>
      <div className="ecard-design-picker" role="group" aria-label="名片樣式">{cardDesigns.map(([key,name])=><button type="button" className="ecard-design-option" key={key} aria-pressed={local.design===key} onClick={()=>assign({design:key},'now')}><span className={`ecard-swatch ecard-swatch-${key}`} aria-hidden="true"/>{name}</button>)}</div>
      <label className="field">一句話介紹<input value={local.headline} onChange={event=>assign({headline:event.target.value},'debounce')} onBlur={()=>{window.clearTimeout(debounce.current);if(!headlineIssue(localRef.current.headline)&&signature(localRef.current)!==lastSavedSig.current)kick();}} placeholder="例如：做開源的人"/></label>
      <p className="field-hint">最多 60 個字。留白就只顯示公會和專長。</p>
      {headlineError&&<p role="alert">{headlineError}</p>}
      <div className="ecard-link-editor"><h3>名片連結</h3><p className="field-hint">最多 8 個。按鈕會顯示名稱，下面附上網址的網域。</p>
        <ul className="ecard-link-list">{local.links.map((link,index)=><li key={link.id}>{editing?.id===link.id?<form className="ecard-link-draft" onSubmit={finishEdit}><label className="field">連結名稱<input required maxLength={30} value={editing.label} onChange={event=>setEditing({...editing,label:event.target.value})}/></label><label className="field">連結網址<input type="url" required maxLength={300} value={editing.url} onChange={event=>setEditing({...editing,url:event.target.value})}/></label><div className="ecard-link-row"><button className="ecard-icon-btn">完成編輯</button><button type="button" className="ecard-icon-btn" onClick={()=>setEditing(null)}>取消</button></div></form>:<div className="ecard-link-row"><div className="ecard-link-meta"><strong>{link.label}</strong><span>{link.url}</span></div><button type="button" className="ecard-icon-btn" disabled={index===0} aria-label={`上移第 ${index+1} 個連結 ${link.label}`} onClick={()=>move(index,-1)}>上移</button><button type="button" className="ecard-icon-btn" disabled={index===local.links.length-1} aria-label={`下移第 ${index+1} 個連結 ${link.label}`} onClick={()=>move(index,1)}>下移</button><button type="button" className="ecard-icon-btn" disabled={editing!==null} aria-label={`編輯第 ${index+1} 個連結 ${link.label}`} onClick={()=>setEditing({...link})}>編輯</button><button type="button" className="ecard-icon-btn" aria-label={`移除第 ${index+1} 個連結 ${link.label}`} onClick={()=>assign({links:localRef.current.links.filter(item=>item.id!==link.id)},'now')}>移除</button></div>}</li>)}</ul>
        {local.links.length<8&&editing===null&&<form className="ecard-link-draft" onSubmit={addLink}><label className="field">連結名稱<input maxLength={30} value={draftLabel} onChange={event=>setDraftLabel(event.target.value)}/></label><label className="field">連結網址<input type="url" inputMode="url" maxLength={300} value={draftUrl} onChange={event=>setDraftUrl(event.target.value)} placeholder="https://"/></label><button type="submit" className="btn btn-ghost">加入連結</button></form>}
        <button type="button" className="ecard-text-btn" aria-expanded={importOpen} onClick={()=>void toggleImport()}>從我的社群連結加入</button>
        {importOpen&&<div className="ecard-import"><p className="field-hint">這些連結目前只有符合你設定的會員看得到，要點「加入名片」才會出現在分享頁。</p>{socialError&&<p role="alert">{socialError}</p>}{socialLoading&&<p role="status">正在讀取社群連結…</p>}{social&&social.length===0&&<p className="field-hint">尚未新增社群連結。</p>}<ul className="ecard-import-list">{social?.map(item=><li className="ecard-import-row" key={item.link_id}><div className="ecard-link-meta"><strong>{item.label}</strong><span>{item.url}</span></div><button type="button" className="ecard-import-add" aria-label={`把「${item.label}」加入名片`} onClick={()=>importLink(item)}>加入名片</button></li>)}</ul></div>}
      </div>
      <section className="ecard-profile-editor" aria-label="社群與聯絡方式" onFocus={()=>refreshRef.current()}><h3>社群與聯絡方式</h3>
        <label className="checkbox-row"><input type="checkbox" checked={local.showProfileLinks} onChange={event=>assign({showProfileLinks:event.target.checked},'now')}/>自動放上我設為「平台公開」的聯絡方式和社群連結</label>
        <p className="field-hint">拿到名片連結的任何人（不必登入）都看得到這些項目。</p>
        {local.profileLinks.length===0?<p>你還沒有設為「平台公開」的聯絡方式或社群連結。在這頁上方的聯絡方式或社群連結設定公開對象後，就會出現在這裡。</p>:<ul className="ecard-profile-list">{local.profileLinks.map(item=><li className="ecard-profile-row" key={item.source}><BrandIcon platform={item.platform}/><div className="ecard-profile-copy"><strong>{item.label}</strong>{item.handle&&<span>{item.handle}</span>}</div><label className="checkbox-row"><input type="checkbox" checked={item.shown} aria-label={`顯示 ${item.label} 在名片上`} onChange={event=>{const shown=event.target.checked;assign({prefs:{...localRef.current.prefs,[item.source]:shown},profileLinks:localRef.current.profileLinks.map(row=>row.source===item.source?{...row,shown}:row)},'now');}}/>顯示在名片上</label>{item.source==='contact:email'&&<p className="field-hint">Email 是你的登入帳號，預設不放上名片。</p>}</li>)}</ul>}
      </section>
    </div>
    <div className="member-share-preview"><aside className="ecard-preview" aria-label="名片預覽"><div className="ecard-preview-head"><h3>名片預覽</h3><p className="ecard-save-status" role="status">{status.message}{status.kind==='error'&&<button type="button" className="btn btn-ghost" onClick={()=>{setStatus({kind:'dirty',message:'有變更尚未儲存'});kick();}}>重試</button>}</p></div><div className="ecard-preview-stage" data-design={local.design}><MemberECard design={local.design} nickname={preview?.nickname||'會員'} headline={local.headline} guildName={preview?.guild??null} capabilities={preview?.capabilities??[]} avatarUrl={local.includeAvatar?preview?.avatarUrl??null:null} links={local.links} profileLinks={visibleProfile(local)} heading="p"/></div></aside>
      {local.enabled&&url?<MemberCardShareActions client={client} target={preview?.userId} title={preview?.nickname?`${preview.nickname}的工坊名片`:'工坊名片'} url={url} pending={pending} blocked={blocked}/>:<div className="actions"><button type="button" className="btn btn-primary" disabled={actionBusy} onClick={()=>runExplicit({enabled:true,rotate:false})}>建立分享連結</button></div>}
      {local.enabled&&url&&<div className="actions"><button type="button" className="btn btn-ghost" disabled={actionBusy} onClick={()=>runExplicit({enabled:true,rotate:true})}>更新連結</button><button type="button" className="btn btn-ghost" disabled={actionBusy} onClick={()=>runExplicit({enabled:false,rotate:false})}>停用分享</button></div>}
    </div></div>}
    {notice&&<p className="field-hint">{notice}</p>}
  </section>;
}
