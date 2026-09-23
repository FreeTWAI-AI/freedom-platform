import {useEffect,useId,useRef,useState} from 'react';
import './SkillBookIntro.css';

export type IntroBook={title:string;description:string;repository_url:string;fork_url?:string|null;introduction_url?:string|null;upstream_url?:string;source_commit?:string|null;license_status?:string};
function httpsLink(value?:string|null){
  try {const url=new URL(value??'');return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function SkillBookIntro({book,guildName,label='查看技能書介紹'}:{book:IntroBook;guildName?:string;label?:string}){
  const [open,setOpen]=useState(false),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
  const repository=httpsLink(book.repository_url),upstream=httpsLink(book.upstream_url)||repository;
  const website=httpsLink(book.introduction_url),fork=httpsLink(book.fork_url);
  const source=upstream?new URL(upstream):null;
  const account=source?.hostname==='github.com'?source.pathname.split('/').filter(Boolean)[0]:null;
  useEffect(()=>{
    if(open&&!dialog.current?.open)dialog.current?.showModal();
    else if(!open&&dialog.current?.open)dialog.current.close();
  },[open]);
  function close(){setOpen(false);trigger.current?.focus();}
  return <><button ref={trigger} type="button" className="btn btn-ghost skill-intro-trigger" aria-haspopup="dialog" onClick={()=>setOpen(true)}>{label}</button>
    <dialog ref={dialog} className="skill-intro-dialog" aria-labelledby={id} onCancel={event=>{event.preventDefault();close();}} onClose={()=>setOpen(false)}>
      <div className="stack"><header className="skill-intro-header"><div><p className="eyebrow">自由工坊 · 公會藏經閣</p><h2 id={id}>{book.title}</h2></div><button className="btn btn-ghost" type="button" onClick={close} autoFocus aria-label="關閉技能書介紹">關閉</button></header>
        {guildName&&<p className="badge">{guildName} 的技能書</p>}
        <section className="stack"><h3>這本技能書能做什麼？</h3><p>{book.description}</p></section>
        <section className="stack"><h3>適合誰？</h3><p>{guildName?`想在${guildName}學習、實作或與夥伴協作的會員。`:'對這個主題有興趣，想從公開專案學習、實作或參與協作的會員。'}</p></section>
        <section className="stack"><h3>從這裡開始</h3><ol><li>先讀專案說明，了解目前功能、使用條件與授權。</li><li>選一個最小範例，留下你的問題或實作成果。</li><li>需要自己的副本時再 Fork；想共創可到專案的 Issues 看待辦與合作方式。</li></ol></section>
        <section className="skill-intro-source stack"><h3>作者與來源</h3><p>{account?`來源 GitHub 帳號：${account}`:'來源資訊請見下方專案連結。'}</p>
          {upstream&&<a href={upstream} target="_blank" rel="noopener noreferrer">查看來源專案 ↗</a>}
          {book.license_status&&<p className="field-hint">{book.license_status==='NOASSERTION'?'授權尚待確認，使用與再發布請以來源說明為準。':`記錄的授權：${book.license_status}；以對應來源版本為準。`}</p>}
          {book.source_commit&&/^[0-9a-f]{40}$/.test(book.source_commit)&&<p className="field-hint">收錄來源版本：<code>{book.source_commit.slice(0,12)}</code></p>}
        </section>
        <div className="actions">{repository&&<a className="btn btn-primary" href={repository} target="_blank" rel="noopener noreferrer">閱讀技能書 ↗</a>}{website&&<a className="btn btn-ghost" href={website} target="_blank" rel="noopener noreferrer">專案介紹網站 ↗</a>}{repository&&<a className="btn btn-ghost" href={repository} target="_blank" rel="noopener noreferrer">GitHub 原始碼 ↗</a>}{fork&&<a className="btn btn-ghost" href={fork} target="_blank" rel="noopener noreferrer">Fork 到我的 GitHub ↗</a>}</div>
        <p className="field-hint">閱讀與 Fork 會另開來源網站；Fork 由你在 GitHub 確認。</p>
      </div>
    </dialog>
  </>;
}
