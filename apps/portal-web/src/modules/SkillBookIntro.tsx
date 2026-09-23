import {useEffect,useId,useRef,useState} from 'react';
import type {SkillBookGuide} from '../../../../modules/community/skill-book-guides';
import './SkillBookIntro.css';

export type IntroBook={id?:string;book_id?:string;title:string;description:string;repository_url:string;fork_url?:string|null;introduction_url?:string|null;upstream_url?:string;source_commit?:string|null;license_status?:string;guide?:SkillBookGuide};
function httpsLink(value?:string|null){
  try {const url=new URL(value??'');return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function SkillBookIntro({book,guildName,label='查看技能書介紹'}:{book:IntroBook;guildName?:string;label?:string}){
  const [open,setOpen]=useState(false),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
  const guide=book.guide,repository=httpsLink(book.repository_url),upstream=httpsLink(book.upstream_url)||repository;
  const reading=httpsLink(guide?.reading_url)||repository,website=httpsLink(book.introduction_url)||httpsLink(guide?.website_url),fork=httpsLink(book.fork_url),contribute=httpsLink(guide?.contribution_url);
  const source=upstream?new URL(upstream):null,account=source?.hostname==='github.com'?source.pathname.split('/').filter(Boolean)[0]:null;
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();else if(!open&&dialog.current?.open)dialog.current.close();},[open]);
  function close(){setOpen(false);trigger.current?.focus();}
  return <><button ref={trigger} type="button" className="btn btn-ghost skill-intro-trigger" aria-haspopup="dialog" onClick={()=>setOpen(true)}>{label}</button>
    <dialog ref={dialog} className="skill-intro-dialog" aria-labelledby={id} data-book-id={book.id??book.book_id} onCancel={event=>{event.preventDefault();close();}} onClose={()=>setOpen(false)}>
      <div className="stack"><header className="skill-intro-header"><div><p className="eyebrow">自由工坊 · 公會技能庫</p><h2 id={id}>{book.title}</h2></div><button className="btn btn-ghost" type="button" onClick={close} autoFocus aria-label="關閉技能書介紹">關閉</button></header>
        <div className="tag-list">{guide&&<span className="badge">{guide.format}</span>}{guildName&&<span className="badge">{guildName}</span>}</div>
        <p className="skill-intro-purpose">{guide?.summary??book.description}</p>
        {guide?<><p className="muted">適合：{guide.audience.join('、')}</p><section className="skill-intro-result"><p className="eyebrow">你的第一個成果</p><p>{guide.first_result}</p></section>
          <section className="stack"><h3>現在能做什麼</h3><ul className="skill-intro-features">{guide.features.map(feature=><li key={feature}>{feature}</li>)}</ul><p className="skill-intro-status">{guide.status}</p></section>
          <details className="skill-intro-details"><summary>開始練習：準備與步驟</summary><div className="stack"><section><h3>先準備</h3><ul>{guide.prerequisites.map(item=><li key={item}>{item}</li>)}</ul></section><section><h3>跟著做第一輪</h3><ol>{guide.first_steps.map(step=><li key={step}>{step}</li>)}</ol></section>{guide.quickstart&&<section className="stack"><h3>開發者啟動指令</h3><p className="field-hint">{guide.quickstart.context}</p><pre className="skill-intro-command"><code>{guide.quickstart.commands}</code></pre></section>}</div></details>
          <details className="skill-intro-details"><summary>想一起改進這個專案</summary><div className="stack"><p>{guide.contribution}</p>{contribute&&<a href={contribute} target="_blank" rel="noopener noreferrer">查看工坊專案的任務與討論 ↗</a>}<p className="field-hint">先在專案討論清楚這一輪要做的事，再提交修改給維護者審查。</p></div></details>
        </>:<p className="muted">這本技能書的詳細練習正在整理，可先閱讀來源專案的說明。</p>}
        <div className="actions">{(book.id??book.book_id)&&<a className="btn btn-ghost" href={`/development/skills/${encodeURIComponent((book.id??book.book_id)!)}`} target="_blank" rel="noopener noreferrer">開啟技能書完整指南 ↗</a>}{reading&&<a className="btn btn-primary" href={reading} target="_blank" rel="noopener noreferrer">閱讀技能書 ↗</a>}{website&&<a className="btn btn-ghost" href={website} target="_blank" rel="noopener noreferrer">專案介紹網站 ↗</a>}{fork&&<a className="btn btn-ghost" href={fork} target="_blank" rel="noopener noreferrer">Fork 到我的 GitHub ↗</a>}</div>
        <details className="skill-intro-details skill-intro-source"><summary>作者、授權與收錄來源</summary><div className="stack"><p>{account?`來源 GitHub 帳號：${account}`:'來源資訊請見下方專案連結。'}</p><div className="actions">{upstream&&<a href={upstream} target="_blank" rel="noopener noreferrer">查看來源專案 ↗</a>}{repository&&<a href={repository} target="_blank" rel="noopener noreferrer">GitHub 原始碼 ↗</a>}</div>{book.license_status&&<p>{book.license_status==='NOASSERTION'?'來源未明確宣告授權條款；Fork 不代表額外取得作品、素材或程式的使用權。':`來源記錄的程式授權：${book.license_status}。素材與引用內容請另外查看專案說明。`}</p>}{guide&&<><p className="field-hint">介紹核對：{guide.reviewed_at} · 依以下收錄版本，不代表外部服務今天的運作狀態。</p><ul>{guide.source_evidence.map(evidence=>{const url=httpsLink(evidence.url);return url?<li key={evidence.path}><a href={url} target="_blank" rel="noopener noreferrer">{evidence.path} ↗</a></li>:null;})}</ul></>}{book.source_commit&&/^[0-9a-f]{40}$/.test(book.source_commit)&&<p className="field-hint">收錄版本：<code>{book.source_commit.slice(0,12)}</code></p>}</div></details>
      </div>
    </dialog>
  </>;
}
