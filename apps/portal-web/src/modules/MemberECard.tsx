import {useEffect,useRef,useState} from 'react';
import {useLanguage} from '../language';
import {useLocalAction} from '../useLocalAction';
import {MemberCardQr} from './MemberCardQr';
import {MemberAvatar} from './MemberAvatar';
import {BrandIcon,brandForUrl,brandPlatform} from './BrandIcon';
import './MemberECard.css';
import './MemberEditorialCard.css';

export const cardDesigns=[['editorial','工坊誌'],['calm','清新'],['workshop','工坊'],['night','夜空'],['classic','經典名片']] as const;
export type CardDesign=(typeof cardDesigns)[number][0];
export type CardLink={label:string;url:string};
export type CardProfileLink={platform:string;label:string;handle:string|null;url:string|null};
const control=/[\u0000-\u001f\u007f]/;
const chars=(value:string)=>Array.from(value).length;

export function parseCardLink(label:string,url:string):{ok:true;link:CardLink}|{ok:false;message:string}{
  if(control.test(label))return {ok:false,message:'連結名稱請使用單行文字。'};
  const name=label.trim();
  if(chars(name)<1||chars(name)>30)return {ok:false,message:'連結名稱需要 1 到 30 個字。'};
  if(control.test(url))return {ok:false,message:'名片連結只接受 https 網址。'};
  const raw=url.trim();
  if(!raw||chars(raw)>300)return {ok:false,message:chars(raw)>300?'名片連結網址最多 300 個字。':'名片連結只接受 https 網址。'};
  let parsed:URL|undefined;try{parsed=new URL(raw);}catch{/* invalid */}
  if(!parsed||parsed.protocol!=='https:')return {ok:false,message:'名片連結只接受 https 網址。'};
  if(parsed.username||parsed.password)return {ok:false,message:'名片連結不可包含帳號或密碼。'};
  if(chars(parsed.href)>300)return {ok:false,message:'名片連結網址最多 300 個字。'};
  return {ok:true,link:{label:name,url:parsed.href}};
}
export function linkDomain(url:string){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}}

function copyName(platform:string){return platform==='discord'?'複製 Discord 帳號':platform==='line'?'複製 LINE ID':`複製${platform}`;}
function fallbackName(platform:string){return platform==='discord'?'Discord 帳號':platform==='line'?'LINE ID':'帳號';}

function LinkBody({platform,label,handle,feedback=''}:{platform:string;label:string;handle:string|null;feedback?:string}){
  return <><BrandIcon platform={platform}/><span className="ecard-link-text"><span className={feedback?'ecard-link-feedback-row':undefined}>{feedback?<><span className="ecard-link-label">{label}</span><small className="ecard-copy-visible" aria-hidden="true">{feedback}</small></>:label}</span>{handle?<small>{handle}</small>:null}</span></>;
}
function CopyLink({platform,label,handle}:{platform:string;label:string;handle:string}){
  const [copied,setCopied]=useState(''),[manual,setManual]=useState(false);
  const {t}=useLanguage(),action=useLocalAction([platform,handle]),field=useRef<HTMLInputElement>(null);
  useEffect(()=>{setCopied('');setManual(false);},[platform,handle]);
  useEffect(()=>{if(manual){field.current?.focus();field.current?.select();}},[manual]);
  async function copy(){
    const result=await action.run('copy',()=>{setCopied('');setManual(false);return navigator.clipboard.writeText(handle);});
    if(result.status==='done')setCopied('已複製');
    else if(result.status==='failed')setManual(true);
  }
  return <><button type="button" className="ecard-link" aria-label={copyName(platform)} aria-busy={action.pending!==null} disabled={action.pending!==null} onClick={()=>void copy()}><LinkBody platform={platform} label={label} handle={handle} feedback={action.pending?t('action.copying'):copied}/></button>
    {manual&&<input ref={field} className="ecard-copy-fallback" readOnly value={handle} aria-label={fallbackName(platform)}/>}
    <span className="ecard-copy-status" role="status" aria-live="polite">{action.pending?t('action.copying'):copied}</span></>;
}
function cardLinkHref(url:string|null):string|null{
  if(!url)return null;
  let parsed:URL|undefined;try{parsed=new URL(url);}catch{return null;}
  if(parsed.username||parsed.password)return null;
  if(parsed.protocol!=='https:'&&parsed.protocol!=='mailto:')return null;
  return parsed.href;
}
function CardAnchor({url,platform,label,handle}:{url:string;platform:string;label:string;handle:string|null}){
  const mail=url.startsWith('mailto:');
  return <a className="ecard-link" href={url} {...(mail?{}:{target:'_blank',rel:'noopener noreferrer nofollow ugc'})}><LinkBody platform={platform} label={label} handle={handle}/></a>;
}

export function MemberECard({design,nickname,headline,guildName,capabilities,avatarUrl,links,profileLinks=[],heading='h1',shareUrl=''}:{design:CardDesign;nickname:string;headline:string|null;guildName:string|null;capabilities:string[];avatarUrl:string|null;links:CardLink[];profileLinks?:CardProfileLink[];heading?:'h1'|'h3'|'p';shareUrl?:string}){
  const Title=heading,line=headline?.trim()||null;
  const rows=[
    ...profileLinks.map((item,index)=>({key:`profile-${index}-${item.platform}-${item.label}`,platform:brandPlatform(item.platform),label:item.label,handle:item.handle,url:item.url})),
    ...links.map((item,index)=>({key:`manual-${index}-${item.url}`,platform:brandForUrl(item.url),label:item.label,handle:linkDomain(item.url)||null,url:item.url})),
  ];
  if(design==='editorial')return <article className="ecard ecard-editorial" data-design="editorial" aria-label={`${nickname}的工坊名片`}>
    <header className="editorial-masthead"><span>自由工坊<span className="editorial-brand-en">FREEDOM WORKSHOP</span></span><span className="editorial-edition">MEMBER CARD <span aria-hidden="true">↗</span></span></header>
    <div className="editorial-hero">
      <div className="editorial-person"><p className="ecard-kicker">一起，把想法做出來。</p><Title className="ecard-name" aria-label={heading==='h3'?nickname:`${nickname}的工坊名片`}>{nickname}</Title>{line&&<p className="ecard-headline">{line}</p>}</div>
      <div className="editorial-portrait"><div className="editorial-orbit" aria-hidden="true"/><span className="editorial-cross" aria-hidden="true">＋</span><MemberAvatar nickname={nickname} avatarUrl={avatarUrl}/></div>
    </div>
    <div className="editorial-details"><div className="editorial-affiliation"><p className="editorial-label"><span aria-hidden="true">01 / </span>所屬公會</p><p className="ecard-guild">{guildName??'自由工坊夥伴'}</p></div><div className="editorial-skills"><p className="editorial-label"><span aria-hidden="true">02 / </span>擅長的事</p>{capabilities.length>0?<ul className="ecard-capabilities">{capabilities.slice(0,3).map((label,index)=><li key={`${index}-${label}`}>{label}</li>)}</ul>:<p className="editorial-empty">專長探索中</p>}</div></div>
    {rows.length>0&&<ul className="ecard-links">{rows.map(item=>{const href=cardLinkHref(item.url);return <li key={item.key}>{href?<CardAnchor url={href} platform={item.platform} label={item.label} handle={item.handle}/>:!item.url&&item.handle?<CopyLink platform={item.platform} label={item.label} handle={item.handle}/>:<span className="ecard-link"><LinkBody platform={item.platform} label={item.label} handle={item.handle}/></span>}</li>;})}</ul>}
    <footer className="editorial-footer"><div><span className="editorial-connect">LET’S<br/>CONNECT<span aria-hidden="true">.</span></span><p>學習・創作・共創</p></div>{shareUrl?<MemberCardQr url={shareUrl}/>:<p className="editorial-qr-pending">FREETWAI.COM<br/>自由工坊・共創夥伴</p>}</footer>
  </article>;
  return <article className="ecard" data-design={design}>
    <div className="ecard-identity">
      <MemberAvatar nickname={nickname} avatarUrl={avatarUrl}/>
      <div className="ecard-copy">
        <p className="ecard-kicker">FREEDOM WORKSHOP</p>
        <Title className="ecard-name">{nickname}的工坊名片</Title>
        {line&&<p className="ecard-headline">{line}</p>}
        <p className="ecard-guild">{guildName??'自由工坊夥伴'}</p>
      </div>
    </div>
    {capabilities.length>0&&<ul className="ecard-capabilities">{capabilities.map((label,index)=><li key={`${index}-${label}`}>{label}</li>)}</ul>}
    {rows.length>0&&<ul className="ecard-links">{rows.map(item=>{const href=cardLinkHref(item.url);return <li key={item.key}>{href?<CardAnchor url={href} platform={item.platform} label={item.label} handle={item.handle}/>:!item.url&&item.handle?<CopyLink platform={item.platform} label={item.label} handle={item.handle}/>:<span className="ecard-link"><LinkBody platform={item.platform} label={item.label} handle={item.handle}/></span>}</li>;})}</ul>}
    {shareUrl&&<MemberCardQr url={shareUrl}/>}
  </article>;
}
