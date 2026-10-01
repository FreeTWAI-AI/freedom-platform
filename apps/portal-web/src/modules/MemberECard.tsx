import {MemberAvatar} from './MemberAvatar';
import './MemberECard.css';

export const cardDesigns=[['calm','清新'],['workshop','工坊'],['night','夜空'],['classic','經典名片']] as const;
export type CardDesign=(typeof cardDesigns)[number][0];
export type CardLink={label:string;url:string};
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

export function MemberECard({design,nickname,headline,guildName,capabilities,avatarUrl,links,heading='h1'}:{design:CardDesign;nickname:string;headline:string|null;guildName:string|null;capabilities:string[];avatarUrl:string|null;links:CardLink[];heading?:'h1'|'p'}){
  const Title=heading,line=headline?.trim()||null;
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
    {links.length>0&&<ul className="ecard-links">{links.map(link=><li key={`${link.label}\u0000${link.url}`}><a className="ecard-link" href={link.url} target="_blank" rel="noopener noreferrer nofollow ugc"><span>{link.label}</span><small>{linkDomain(link.url)}</small></a></li>)}</ul>}
  </article>;
}
