import {useState} from 'react';
import {MemberAvatar} from './MemberAvatar';
import {BrandIcon,brandForUrl,brandPlatform} from './BrandIcon';
import './MemberECard.css';

export const cardDesigns=[['calm','清新'],['workshop','工坊'],['night','夜空'],['classic','經典名片']] as const;
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

function LinkBody({platform,label,handle}:{platform:string;label:string;handle:string|null}){
  return <><BrandIcon platform={platform}/><span className="ecard-link-text"><span>{label}</span>{handle?<small>{handle}</small>:null}</span></>;
}
function CopyLink({platform,label,handle}:{platform:string;label:string;handle:string}){
  const [copied,setCopied]=useState(''),[manual,setManual]=useState(false);
  async function copy(){
    try{
      if(!navigator.clipboard?.writeText)throw new Error('missing');
      await navigator.clipboard.writeText(handle);
      setCopied('已複製');setManual(false);
    }catch{setCopied('');setManual(true);}
  }
  return <><button type="button" className="ecard-link" aria-label={copyName(platform)} onClick={()=>void copy()}><LinkBody platform={platform} label={label} handle={handle}/></button>
    {manual&&<input className="ecard-copy-fallback" readOnly value={handle} aria-label={fallbackName(platform)}/>}
    <span className="ecard-copy-status" role="status" aria-live="polite">{copied}</span></>;
}
function CardAnchor({url,platform,label,handle}:{url:string;platform:string;label:string;handle:string|null}){
  const mail=url.toLowerCase().startsWith('mailto:');
  return <a className="ecard-link" href={url} {...(mail?{}:{target:'_blank',rel:'noopener noreferrer nofollow ugc'})}><LinkBody platform={platform} label={label} handle={handle}/></a>;
}

export function MemberECard({design,nickname,headline,guildName,capabilities,avatarUrl,links,profileLinks=[],heading='h1'}:{design:CardDesign;nickname:string;headline:string|null;guildName:string|null;capabilities:string[];avatarUrl:string|null;links:CardLink[];profileLinks?:CardProfileLink[];heading?:'h1'|'p'}){
  const Title=heading,line=headline?.trim()||null;
  const rows=[
    ...profileLinks.map((item,index)=>({key:`profile-${index}-${item.platform}-${item.label}`,platform:brandPlatform(item.platform),label:item.label,handle:item.handle,url:item.url})),
    ...links.map((item,index)=>({key:`manual-${index}-${item.url}`,platform:brandForUrl(item.url),label:item.label,handle:linkDomain(item.url)||null,url:item.url})),
  ];
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
    {rows.length>0&&<ul className="ecard-links">{rows.map(item=><li key={item.key}>{item.url?<CardAnchor url={item.url} platform={item.platform} label={item.label} handle={item.handle}/>:item.handle?<CopyLink platform={item.platform} label={item.label} handle={item.handle}/>:<span className="ecard-link"><LinkBody platform={item.platform} label={item.label} handle={null}/></span>}</li>)}</ul>}
  </article>;
}
