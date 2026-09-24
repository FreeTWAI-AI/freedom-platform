import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {PortalClient} from '../api';
import {useModuleMutation} from './shared';
import './MemberSocialLinks.css';

type Audience='public'|'friends'|'squad'|'guild';
type Platform='facebook'|'instagram'|'youtube'|'threads'|'tiktok'|'linkedin'|'x'|'website'|'other';
type LinkFields={platform:Platform;label:string;url:string;audiences:Audience[]};
type OwnLink=LinkFields&{link_id:string;aggregate_version:number;created_at:string;updated_at:string;verified:false};
type VisibleLink=Pick<OwnLink,'link_id'|'platform'|'label'|'url'|'verified'>;
type LinkPage<T>={items:T[];total:number;next_offset:number|null};
type Draft=LinkFields&{link_id?:string;aggregate_version?:number};
type Receipt=OwnLink|{link_id:string;deleted:true;aggregate_version:number};
const platforms:[Platform,string][]=[['facebook','Facebook 粉絲專頁'],['instagram','Instagram'],['youtube','YouTube'],['threads','Threads'],['tiktok','TikTok'],['linkedin','LinkedIn'],['x','X'],['website','個人網站'],['other','其他連結']];
const audiences:[Audience,string][]=[['public','平台公開'],['friends','平台好友'],['squad','小隊夥伴'],['guild','公會夥伴']];
const platformName=(value:Platform)=>platforms.find(([key])=>key===value)?.[1]??'社群連結';
const failure=(cause:unknown)=>cause instanceof Error?cause.message:'無法載入社群連結，請重試。';
const audienceLabel=(value:Audience[])=>value.includes('public')?'平台公開':value.length?value.map(item=>audiences.find(([key])=>key===item)?.[1]).filter(Boolean).join('、'):'不公開';
function safeUrl(value:string){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}

export function SocialLinksList({client,memberId,self=false}:{client:PortalClient;memberId:string;self?:boolean}){
  const [items,setItems]=useState<VisibleLink[]>([]),[next,setNext]=useState<number|null>(null),[total,setTotal]=useState<number|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const generation=useRef(0),offsetRef=useRef(0),lock=useRef(false);
  const load=useCallback(async(offset=0)=>{
    const sequence=++generation.current;offsetRef.current=offset;setError('');setLoading(true);lock.current=true;
    if(offset===0){setItems([]);setNext(null);setTotal(null);}
    try{const data=await client.get<LinkPage<VisibleLink>>(`/members/${encodeURIComponent(memberId)}/social-links?limit=6&offset=${offset}`);if(sequence!==generation.current)return;setItems(current=>offset?[...new Map([...current,...data.items].map(item=>[item.link_id,item])).values()]:data.items);setTotal(data.total);setNext(data.next_offset);}
    catch(cause){if(sequence===generation.current){setError(failure(cause));setItems([]);setNext(null);setTotal(null);}}
    finally{if(sequence===generation.current){setLoading(false);lock.current=false;}}
  },[client,memberId]);
  useEffect(()=>{
    void load();
    const refresh=(event:Event)=>{if((event as CustomEvent<{memberId:string}>).detail?.memberId===memberId)void load();};
    const focus=()=>{void load();};
    window.addEventListener('freedom-social-links-updated',refresh);window.addEventListener('focus',focus);
    return()=>{generation.current++;window.removeEventListener('freedom-social-links-updated',refresh);window.removeEventListener('focus',focus);};
  },[load,memberId]);
  return <section className="member-social-display" aria-label="社群帳號與網站"><h4>社群帳號與網站</h4>{error?<div role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重讀社群連結</button></div>:<><div className="member-social-buttons">{items.map(item=>{const href=safeUrl(item.url);return href?<a className="member-social-link" key={item.link_id} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><span>{platformName(item.platform)}</span><strong>{item.label}</strong><span aria-hidden="true">↗</span></a>:null;})}</div>{!loading&&total===0&&<p className="field-hint">{self?'尚未新增社群連結。':'沒有對你公開的社群連結。'}</p>}{loading&&<p className="field-hint">正在載入社群連結…</p>}{next!==null&&<button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>{if(!lock.current)void load(next);}}>查看更多社群連結</button>}</>}</section>;
}

export function MemberSocialLinks({client,memberId}:{client:PortalClient;memberId:string}){
  const [items,setItems]=useState<OwnLink[]>([]),[next,setNext]=useState<number|null>(null),[total,setTotal]=useState<number|null>(null),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState(''),[draft,setDraft]=useState<Draft|null>(null),[fieldError,setFieldError]=useState('');
  const generation=useRef(0),offsetRef=useRef(0),loadLock=useRef(false),draftLabel=useRef<HTMLInputElement>(null),id=useId();
  const {mutate,busy,error,setError}=useModuleMutation(client);
  const load=useCallback(async(offset=0)=>{
    const sequence=++generation.current;offsetRef.current=offset;setLoadError('');setLoading(true);loadLock.current=true;
    if(offset===0){setItems([]);setNext(null);setTotal(null);}
    try{const data=await client.get<LinkPage<OwnLink>>(`/me/social-links?limit=20&offset=${offset}`);if(sequence!==generation.current)return false;setItems(current=>offset?[...new Map([...current,...data.items].map(item=>[item.link_id,item])).values()]:data.items);setTotal(data.total);setNext(data.next_offset);return true;}
    catch(cause){if(sequence===generation.current)setLoadError(failure(cause));return false;}
    finally{if(sequence===generation.current){setLoading(false);loadLock.current=false;}}
  },[client,memberId]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  useEffect(()=>{if(draft)draftLabel.current?.focus();},[draft?.link_id,draft!==null]);
  function edit(item?:OwnLink){setDraft(item?{link_id:item.link_id,aggregate_version:item.aggregate_version,platform:item.platform,label:item.label,url:item.url,audiences:[...item.audiences]}:{platform:'facebook',label:platformName('facebook'),url:'',audiences:[]});setNotice('');setFieldError('');setError(null);}
  function cancel(){setDraft(null);setFieldError('');setError(null);}
  async function refreshAfterMutation(message:string){const confirmed=await load();setNotice(confirmed?message:`${message}清單暫時無法更新，請重新載入。`);window.dispatchEvent(new CustomEvent('freedom-social-links-updated',{detail:{memberId}}));}
  async function save(event:FormEvent){
    event.preventDefault();if(!draft||busy)return;setFieldError('');setNotice('');
    const url=safeUrl(draft.url.trim());if(!url){setFieldError('請填寫完整的 https:// 連結。');return;}
    const body:LinkFields={platform:draft.platform,label:draft.label.trim(),url,audiences:draft.audiences};
    const saved=await mutate<Receipt>(draft.link_id?`/me/social-links/${encodeURIComponent(draft.link_id)}/edit`:'/me/social-links',body,draft.aggregate_version);
    if(saved){const edited=Boolean(draft.link_id);setDraft(null);await refreshAfterMutation('deleted' in saved?'這個連結已移除。':edited?'社群連結已更新。':'社群連結已新增。');}
  }
  async function remove(item:OwnLink){if(busy)return;setNotice('');setFieldError('');const result=await mutate<Receipt>(`/me/social-links/${encodeURIComponent(item.link_id)}/delete`,{},item.aggregate_version);if(result){if(draft?.link_id===item.link_id)setDraft(null);await refreshAfterMutation(`已移除「${item.label}」。`);}}
  function visibility(value:Audience){if(!draft)return;if(value==='public'){setDraft({...draft,audiences:draft.audiences.includes('public')?[]:['public']});return;}setDraft({...draft,audiences:draft.audiences.includes(value)?draft.audiences.filter(item=>item!==value):[...draft.audiences,value]});}
  return <section className="card stack social-links-editor" aria-labelledby={`${id}-title`}><div className="card-head"><div><h3 id={`${id}-title`}>社群連結</h3><p className="field-hint">Facebook、IG 可以各放多個。每筆連結分開設定公開範圍。</p></div><button type="button" className="btn btn-primary" disabled={busy||draft!==null} onClick={()=>edit()}>＋ 新增連結</button></div>
    {notice&&<p role="status" className="status-note">{notice}</p>}{loadError&&<div role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" disabled={busy||loading} onClick={()=>void load(offsetRef.current)}>重新載入社群連結</button></div>}
    {error&&<div role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{cancel();void load();}}>重讀清單，放棄草稿</button></div>}
    {draft&&<form className="social-link-form stack" aria-label={draft.link_id?'編輯社群連結':'新增社群連結'} onSubmit={save}><div className="social-link-fields"><label className="field">平台<select value={draft.platform} disabled={busy} onChange={event=>{const platform=event.target.value as Platform;setDraft({...draft,platform,label:draft.label===platformName(draft.platform)?platformName(platform):draft.label});}}>{platforms.map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label><label className="field">連結名稱<input ref={draftLabel} required maxLength={80} value={draft.label} disabled={busy} onChange={event=>setDraft({...draft,label:event.target.value})} placeholder="例如：我的工作室粉絲專頁"/></label></div><label className="field">連結網址<input type="url" inputMode="url" required maxLength={2048} value={draft.url} disabled={busy} onChange={event=>setDraft({...draft,url:event.target.value})} placeholder="https://www.facebook.com/你的粉絲專頁" autoComplete="off"/></label>
      <fieldset className="fieldset social-link-audiences" disabled={busy}><legend>誰可以看見這個連結？</legend><label className="checkbox-row"><input type="checkbox" checked={!draft.audiences.length} onChange={()=>setDraft({...draft,audiences:[]})}/>不公開</label>{audiences.map(([value,label])=><label className="checkbox-row" key={value}><input type="checkbox" checked={draft.audiences.includes(value)} disabled={value!=='public'&&draft.audiences.includes('public')} onChange={()=>visibility(value)}/>{label}</label>)}</fieldset><p className="field-hint">可複選好友、小隊與公會。平台公開包含所有已登入會員。</p>{fieldError&&<p role="alert">{fieldError}</p>}<div className="actions"><button className="btn btn-primary" disabled={busy}>{busy?'正在保存…':'保存連結'}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={cancel}>取消</button></div></form>}
    <div className="social-link-own-list">{items.map(item=><article className="social-link-own-row" key={item.link_id} data-link-id={item.link_id}><div><span className="social-link-platform">{platformName(item.platform)}</span><strong>{item.label}</strong>{safeUrl(item.url)&&<a href={safeUrl(item.url)!} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{item.url}</a>}<span className="social-link-visibility">{audienceLabel(item.audiences)}</span></div><div className="actions"><button type="button" className="btn btn-ghost" disabled={busy||draft!==null} aria-label={`編輯 ${item.label}`} onClick={()=>edit(item)}>編輯</button><button type="button" className="btn btn-ghost" disabled={busy||draft!==null} aria-label={`移除 ${item.label}`} onClick={()=>void remove(item)}>移除</button></div></article>)}</div>
    {loading&&<p className="field-hint">正在載入你的社群連結…</p>}{!loading&&total===0&&!loadError&&<p className="muted">尚未新增社群連結。</p>}{total!==null&&total>0&&<p className="field-hint">顯示 {items.length} / {total} 筆連結</p>}{next!==null&&!loadError&&<button type="button" className="btn btn-ghost" disabled={busy||loading} onClick={()=>{if(!loadLock.current)void load(next);}}>載入更多我的連結</button>}
  </section>;
}
