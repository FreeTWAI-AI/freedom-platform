import {useEffect,useId,useRef,useState} from 'react';
import type {SkillBookGuide} from '../../../../modules/community/skill-book-guides';
import { SkillBookCover, SkillBookStar,skillBookStarUrl } from './SkillBookCover';
import {SkillBookBadges} from './SkillBookBadges';
import {useSkillDiscovery} from './skill-discovery-client';
import {SkillShare,fetchSkillShareContent,skillSharePath} from './SkillShare';
import './SkillBookIntro.css';
import './GitHubSocial.css';

export type IntroBook={id?:string;book_id?:string;title:string;description:string;summary_override?:string;repository_url:string;fork_url?:string|null;introduction_url?:string|null;upstream_url?:string;source_commit?:string|null;license_status?:string;guide?:SkillBookGuide;cover_url?:string;star_url?:string};
function httpsLink(value?:string|null){
  try {const url=new URL(value??'');return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function SkillBookIntro({book,guildName,label='閱讀技能書'}:{book:IntroBook;guildName?:string;label?:string}){
  const [open,setOpen]=useState(false),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
  const [cooperation,setCooperation]=useState<{purpose:string;summary:string}|null>(null),[cooperationError,setCooperationError]=useState('');
  const [illustration,setIllustration]=useState<{bookId:string;url:string;alt:string}|null>(null);
  const bookId=book.id??book.book_id,discovery=useSkillDiscovery(),summaryOverride=discovery.data?.books.find(item=>item.book_id===bookId)?.summary_override??book.summary_override;
  const guide=book.guide,beginner=guide?.beginner,repository=httpsLink(book.repository_url),upstream=httpsLink(book.upstream_url)||repository;
  const original=skillBookStarUrl(book),reading=httpsLink(guide?.reading_url)||repository,website=httpsLink(book.introduction_url)||httpsLink(guide?.website_url),fork=original?`${original}/fork`:httpsLink(book.fork_url),workshopFork=httpsLink(book.fork_url),contribute=httpsLink(guide?.contribution_url);
  const source=upstream?new URL(upstream):null,account=source?.hostname==='github.com'?source.pathname.split('/').filter(Boolean)[0]:null;
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();else if(!open&&dialog.current?.open)dialog.current.close();},[open]);
  useEffect(()=>{
    if(!open||!bookId)return;
    const controller=new AbortController();let active=true;setCooperation(null);setCooperationError('');
    void fetch(`/api/v1/skills/${encodeURIComponent(bookId)}/collaboration`,{credentials:'omit',signal:controller.signal,headers:{Accept:'application/json'}}).then(async response=>{if(!response.ok)throw new Error('unavailable');const data=await response.json();if(typeof data.purpose!=='string'||typeof data.intent?.summary!=='string')throw new Error('invalid');if(active)setCooperation({purpose:data.purpose,summary:data.intent.summary});}).catch(()=>{if(active)setCooperationError('協作說明暫時無法更新，請開啟分享頁查看。');});
    return()=>{active=false;controller.abort();};
  },[open,bookId]);
  useEffect(()=>{
    if(!open||!bookId)return;
    const controller=new AbortController();setIllustration(null);
    // The landscape illustration is supplementary; a missing asset or content leaves the compact cover in place.
    void fetchSkillShareContent(bookId,controller.signal).then(content=>{if(!controller.signal.aborted&&content.illustration_url)setIllustration({bookId,url:content.illustration_url,alt:content.illustration_alt});}).catch(()=>{});
    return()=>controller.abort();
  },[open,bookId]);
  function close(){dialog.current?.close();setOpen(false);trigger.current?.focus();}
  return <><span className="skill-intro-entry"><button ref={trigger} type="button" className="btn btn-ghost skill-intro-trigger" aria-haspopup="dialog" onClick={()=>setOpen(true)}>{label}</button>{guildName&&<SkillBookBadges bookId={bookId}/>}</span>
    <dialog ref={dialog} className="skill-intro-dialog" aria-labelledby={id} aria-describedby={`${id}-purpose`} data-book-id={book.id??book.book_id} onCancel={event=>{if(event.target!==event.currentTarget)return;event.preventDefault();close();}} onClose={event=>{if(event.target===event.currentTarget)setOpen(false);}}>
      <div className="stack"><header className="skill-intro-header"><div><p className="eyebrow">自由工坊 · 公會技能庫</p><h2 id={id}>{book.title}</h2></div><button className="btn btn-ghost" type="button" onClick={close} autoFocus aria-label="關閉技能書介紹">關閉</button></header>
        <div className="skill-intro-cover"><div className="skill-intro-cover-copy"><div className="tag-list">{beginner&&<span className="badge">{beginner.category}</span>}{guide&&<span className="badge">{guide.format}</span>}{guildName&&<span className="badge">{guildName}</span>}</div>
        {open&&<SkillBookBadges bookId={bookId}/>}<p className="skill-intro-purpose" id={`${id}-purpose`}>{cooperation?.purpose??summaryOverride??beginner?.purpose??guide?.summary??book.description}</p></div>{open&&<SkillBookCover book={book} className="skill-intro-art"/>}</div>
        {open&&illustration&&illustration.bookId===bookId&&<figure className="skill-intro-illustration"><img src={illustration.url} alt={illustration.alt} width="1200" height="630" decoding="async" onError={()=>setIllustration(null)}/></figure>}
        <div className="actions skill-intro-primary-actions">{reading&&<a className="btn btn-primary" href={reading} target="_blank" rel="noopener noreferrer">閱讀技能書 ↗</a>}{upstream&&<a className="btn btn-ghost" href={upstream} target="_blank" rel="noopener noreferrer">開啟專案 ↗</a>}{fork&&<a className="btn btn-ghost" href={fork} target="_blank" rel="noopener noreferrer">Fork 專案 ↗</a>}{workshopFork&&workshopFork!==fork&&<a className="btn btn-ghost" href={workshopFork} target="_blank" rel="noopener noreferrer">Fork 工坊版本 ↗</a>}</div>
        {open&&<SkillBookStar book={book} showFork={false}/>}
        <SkillShare bookId={bookId} title={book.title}/>
        {bookId&&<section className="skill-intro-collaboration"><h3>一起開發</h3><p>{cooperation?.summary??guide?.contribution??'在專案任務中認領一項修改，完成後提交 PR。'}</p>{cooperationError&&<p className="field-hint">{cooperationError}</p>}<div className="actions"><a className="btn btn-primary" href={skillSharePath(bookId)} target="_blank" rel="noopener noreferrer">查看里程碑與任務 ↗</a><a className="btn btn-ghost" href={`${skillSharePath(bookId)}/SKILL.md`} target="_blank" rel="noopener noreferrer">交給 Agent ↗</a></div></section>}
        {guide&&<><p className="skill-intro-example">{guide.first_result}</p>
          <details className="skill-intro-details"><summary>練習與設定</summary><div className="stack"><section><h3>準備</h3><ul>{guide.prerequisites.map(item=><li key={item}>{item}</li>)}</ul></section><section><h3>練習</h3><ol>{guide.first_steps.map(step=><li key={step}>{step}</li>)}</ol></section>{guide.quickstart&&<section className="stack"><h3>啟動指令</h3><p className="field-hint">{guide.quickstart.context}</p><pre className="skill-intro-command"><code>{guide.quickstart.commands}</code></pre></section>}{(book.id??book.book_id)&&<a href={`/development/skills/${encodeURIComponent((book.id??book.book_id)!)}`} target="_blank" rel="noopener noreferrer">完整指南 ↗</a>}</div></details>
          <details className="skill-intro-details"><summary>功能與使用範圍</summary><div className="stack"><p className="skill-intro-status">{guide.status}</p><p className="muted">{guide.audience.join('、')}</p><ul className="skill-intro-features">{guide.features.map(feature=><li key={feature}>{feature}</li>)}</ul>{website&&<a href={website} target="_blank" rel="noopener noreferrer">專案網站 ↗</a>}</div></details>
          <details className="skill-intro-details"><summary>參與開發</summary><div className="stack"><p>{guide.contribution}</p>{contribute&&<a href={contribute} target="_blank" rel="noopener noreferrer">查看專案任務 ↗</a>}<p className="field-hint">先在專案討論清楚這一輪要做的事，再提交修改給維護者審查。</p></div></details>
        </>}
        <details className="skill-intro-details skill-intro-source"><summary>作者、授權與收錄來源</summary><div className="stack"><p>{account?`來源 GitHub 帳號：${account}`:'來源資訊請見下方專案連結。'}</p><div className="actions">{upstream&&<a href={upstream} target="_blank" rel="noopener noreferrer">查看來源專案 ↗</a>}{repository&&<a href={repository} target="_blank" rel="noopener noreferrer">工坊協作版本 ↗</a>}</div>{book.license_status&&<p>{book.license_status==='NOASSERTION'?'來源未明確宣告授權條款；Fork 不代表額外取得作品、素材或程式的使用權。':`來源記錄的程式授權：${book.license_status}。素材與引用內容請另外查看專案說明。`}</p>}{guide&&<><p className="field-hint">介紹核對：{guide.reviewed_at} · 依以下收錄版本，不代表外部服務今天的運作狀態。</p><ul>{guide.source_evidence.map(evidence=>{const url=httpsLink(evidence.url);return url?<li key={evidence.path}><a href={url} target="_blank" rel="noopener noreferrer">{evidence.path} ↗</a></li>:null;})}</ul></>}{book.source_commit&&/^[0-9a-f]{40}$/.test(book.source_commit)&&<p className="field-hint">收錄版本：<code>{book.source_commit.slice(0,12)}</code></p>}</div></details>
      </div>
    </dialog>
  </>;
}

export function SkillBookCard({book,className='',access}:{book:IntroBook;className?:string;access?:'unlocked'|'locked'}) {
  const beginner=book.guide?.beginner,discovery=useSkillDiscovery(),summaryOverride=discovery.data?.books.find(item=>item.book_id===(book.id??book.book_id))?.summary_override??book.summary_override;
  return <article className={`card skill-book skill-book-volume skill-library-book ${className}`} data-book-id={book.id??book.book_id} data-access={access}>
    <div className="skill-library-heading"><SkillBookCover book={book}/><div className="skill-library-copy"><p className="eyebrow skill-library-meta"><span>{beginner?.category??'公會技能書'}</span>{access&&<span className={`skill-unlock-state ${access}`}>{access==='unlocked'?'✓ 已解鎖':'未解鎖'}</span>}</p><h4>{book.title}</h4></div></div>
    <div className="skill-library-description"><p className="skill-library-purpose">{summaryOverride??beginner?.purpose??book.description}</p><SkillBookBadges bookId={book.id??book.book_id}/>{book.license_status==='NOASSERTION'&&<p className="field-hint">授權待確認</p>}</div>
    <div className="skill-library-actions"><SkillBookIntro book={book} label={access==='locked'?'預覽技能書':'閱讀技能書'}/><SkillShare bookId={book.id??book.book_id} title={book.title}/></div>
    <SkillBookStar book={book} compact/>
  </article>;
}
