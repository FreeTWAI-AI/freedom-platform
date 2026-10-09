import {useEffect,useId,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {isGuildBook,loadCommunityCatalog,matchesSkillSearch,type CatalogBook} from './Community';
import {SkillBookCard,httpsLink} from './SkillBookIntro';
import {SkillBookCover} from './SkillBookCover';
import {CommunityBadge} from './SkillBookBadges';
import {SkillShare,isSkillIllustrationUrl,submissionSharePath} from './SkillShare';
import {GitHubSourceLinks} from './GitHubSocial';
import {relationshipLabels} from './SkillUpload';
import {useSkillDiscovery} from './skill-discovery-client';
import {client as sessionClient} from '../portal-session';
import {EventOutcomeBacklinks} from './EventOutcomeBacklinks';
import './SkillBookIntro.css';

type Submission={submission_id:string;title:string;description:string;relationship:keyof typeof relationshipLabels;cover_url:string;illustration_url:string|null;
  source:{repository_full_name:string;repository_url:string;commit_sha:string;license_spdx:string;license_evidence_url:string|null;archived:boolean}};
type Detail={submissionId:string;useNotes:string;demoUrl:string|null};
type Entry={kind:'submission';item:Submission}|{kind:'book';book:CatalogBook};

/** 社群技能書: member-shared works (newest first), then catalog books no guild designates; every entry is the same skill-book card. */
export function CommunitySkillBooks({client,revision=0,guildIds=[]}:{client:PortalClient;revision?:number;guildIds?:readonly string[]}){
  const [books,setBooks]=useState<CatalogBook[]|null>(null),[bookError,setBookError]=useState(false);
  const [items,setItems]=useState<Submission[]|null>(null),[itemError,setItemError]=useState(false);
  const [retry,setRetry]=useState(0),[search,setSearch]=useState(''),discovery=useSkillDiscovery();
  useEffect(()=>{
    let active=true;setBookError(false);
    void loadCommunityCatalog(client).then(data=>{if(active)setBooks(data.skill_books);}).catch(()=>{if(active)setBookError(true);});
    return()=>{active=false;};
  },[client,retry]);
  useEffect(()=>{
    let active=true;setItemError(false);
    void client.get<{items:Submission[]}>('/skill-submissions/published').then(result=>{if(active)setItems(result.items);}).catch(()=>{if(active)setItemError(true);});
    return()=>{active=false;};
  },[client,revision,retry]);
  const meta=new Map(discovery.data?.books.map(book=>[book.book_id,book]));
  // Approved guild bindings arrive with discovery; wait for it (or its failure) so a guild book never flashes on this shelf.
  const designationsKnown=Boolean(discovery.data||discovery.error);
  const entries:Entry[]=[...(items??[]).map(item=>({kind:'submission' as const,item})),...(books??[]).filter(book=>!isGuildBook(book,meta.get(book.id),guildIds)).map(book=>({kind:'book' as const,book}))];
  const shown=entries.filter(entry=>entry.kind==='submission'?matchesSkillSearch(search,[entry.item.title,entry.item.description,entry.item.source.repository_full_name])
    :matchesSkillSearch(search,[entry.book.title,entry.book.description,entry.book.guide?.author_name,entry.book.upstream_url,...Object.values(entry.book.guide?.beginner??{})]));
  const loading=(books===null&&!bookError)||(items===null&&!itemError)||!designationsKnown;
  return <div className="stack community-skill-library">
    {(bookError||itemError)&&<div role="alert"><p>{bookError&&itemError?'社群技能書暫時無法載入。':'部分社群技能書暫時無法載入。'}</p><button type="button" className="btn btn-ghost" onClick={()=>setRetry(value=>value+1)}>重新載入社群技能書</button></div>}
    {loading?<p role="status">正在載入社群技能書…</p>:entries.length>0?<>
      <div className="skill-library-filters"><label className="field">搜尋社群技能書<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="例如：漫畫、角色、交易…"/></label></div>
      <p className="skill-library-count" role="status">顯示 {shown.length} / {entries.length} 本社群技能書</p>
      <div className="card-grid community-book-grid">{shown.map(entry=>entry.kind==='submission'
        ?<SubmissionBookCard key={`submission:${entry.item.submission_id}`} item={entry.item}/>
        :<SkillBookCard key={entry.book.id} book={entry.book} className="community-book" headingLevel={3} community/>)}</div>
      {!shown.length&&<p className="muted">沒有符合的社群技能書。</p>}
    </>:!bookError&&!itemError&&<p className="muted">目前還沒有社群技能書。</p>}
  </div>;
}

function SubmissionBookCard({item}:{item:Submission}){
  const repository=httpsLink(item.source.repository_url);
  return <article className="card skill-book skill-book-volume skill-library-book community-book" data-submission-id={item.submission_id}>
    <div className="skill-library-heading"><SkillBookCover book={{cover_url:item.cover_url}}/><div className="skill-library-copy"><p className="eyebrow skill-library-meta"><span>社群技能書</span></p><h3 className="skill-library-title">{item.title}</h3></div></div>
    <div className="skill-library-description"><p className="skill-library-purpose multiline-text">{item.description}</p><p className="field-hint">原作：{item.source.repository_full_name}</p><div className="skill-book-badges" aria-label="技能書徽章"><CommunityBadge/></div></div>
    <div className="skill-library-actions"><SubmissionIntro item={item}/><SkillShare submissionId={item.submission_id} title={item.title}/><a className="btn btn-ghost" href="#opensource">管理作品介紹</a></div>
    {repository&&<GitHubSourceLinks repositoryUrl={repository}/>}
  </article>;
}

// Mirrors SkillBookIntro: the published page, SKILL.md and share content are the same public projection.
function SubmissionIntro({item}:{item:Submission}){
  const [open,setOpen]=useState(false),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
  const [detail,setDetail]=useState<Detail|null>(null),[detailError,setDetailError]=useState(''),[reload,setReload]=useState(0),[illustration,setIllustration]=useState(true);
  const repository=httpsLink(item.source.repository_url),page=submissionSharePath(item.submission_id),license=item.source.license_spdx;
  const current=detail?.submissionId===item.submission_id?detail:null,demo=httpsLink(current?.demoUrl),evidence=httpsLink(item.source.license_evidence_url);
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();else if(!open&&dialog.current?.open)dialog.current.close();},[open]);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController(),submissionId=item.submission_id;setDetailError('');
    void fetch(`/api/v1/skill-submissions/${encodeURIComponent(submissionId)}`,{credentials:'omit',signal:controller.signal,headers:{Accept:'application/json'}}).then(async response=>{
      if(!response.ok)throw new Error('unavailable');
      const data=await response.json() as {use_notes?:unknown;demo_url?:unknown};
      if(typeof data.use_notes!=='string')throw new Error('invalid');
      if(!controller.signal.aborted)setDetail({submissionId,useNotes:data.use_notes,demoUrl:typeof data.demo_url==='string'?data.demo_url:null});
    }).catch(()=>{if(!controller.signal.aborted)setDetailError('使用說明暫時無法載入，可以重試或開啟介紹頁查看。');});
    return()=>controller.abort();
  },[open,item.submission_id,reload]);
  function close(){dialog.current?.close();setOpen(false);trigger.current?.focus();}
  return <><span className="skill-intro-entry"><button ref={trigger} type="button" className="btn btn-ghost skill-intro-trigger" aria-haspopup="dialog" onClick={()=>setOpen(true)}>閱讀技能書</button></span>
    <dialog ref={dialog} className="skill-intro-dialog" aria-labelledby={id} aria-describedby={`${id}-purpose`} data-submission-id={item.submission_id} onCancel={event=>{if(event.target!==event.currentTarget)return;event.preventDefault();close();}} onClose={event=>{if(event.target===event.currentTarget)setOpen(false);}}>
      <div className="stack"><header className="skill-intro-header"><div><p className="eyebrow">自由工坊 · 社群技能書</p><h2 id={id}>{item.title}</h2></div><button className="btn btn-ghost" type="button" onClick={close} autoFocus aria-label="關閉技能書介紹">關閉</button></header>
        <div className="skill-intro-cover"><div className="skill-intro-cover-copy">{open&&<div className="skill-book-badges" aria-label="技能書徽章"><CommunityBadge/></div>}<p className="skill-intro-purpose multiline-text" id={`${id}-purpose`}>{item.description}</p></div>{open&&<SkillBookCover book={{cover_url:item.cover_url}} className="skill-intro-art"/>}</div>
        {open&&illustration&&isSkillIllustrationUrl(item.illustration_url)&&<figure className="skill-intro-illustration"><img src={item.illustration_url} alt={`${item.title}功能示意圖`} width="1200" height="630" decoding="async" onError={()=>setIllustration(false)}/></figure>}
        <p className="field-hint">分享者自行聲明為{relationshipLabels[item.relationship]??'推薦／整理者'} · 原作：{item.source.repository_full_name}</p>
        <div className="actions skill-intro-primary-actions">{repository&&<a className="btn btn-primary" href={repository} target="_blank" rel="noopener noreferrer">開啟原作 ↗</a>}{demo&&<a className="btn btn-ghost" href={demo} target="_blank" rel="noopener noreferrer">開啟展示 ↗</a>}<a className="btn btn-ghost" href={page} target="_blank" rel="noopener noreferrer">開啟介紹頁 ↗</a></div>
        {repository&&<GitHubSourceLinks repositoryUrl={repository}/>}
        <SkillShare submissionId={item.submission_id} title={item.title}/>
        {open&&<EventOutcomeBacklinks client={sessionClient} kind="skill_book" sourceId={item.submission_id} publicRead={!sessionClient.csrfToken}/>}
        {repository&&<section className="skill-intro-collaboration"><h3>一起開發</h3><p>查看專案任務，認領一項修改並提交 PR。</p><div className="actions"><a className="btn btn-primary" href={`${repository}/issues`} target="_blank" rel="noopener noreferrer">查看專案任務 ↗</a><a className="btn btn-ghost" href={`${page}/SKILL.md`} target="_blank" rel="noopener noreferrer">交給 Agent ↗</a><a className="btn btn-ghost" href={`${repository}/pulls`} target="_blank" rel="noopener noreferrer">查看原作 PR ↗</a><a className="btn btn-ghost" href={`${repository}/fork`} target="_blank" rel="noopener noreferrer">Fork 原作 ↗</a></div><p className="field-hint">修改以 PR 回饋原作，由原作維護者審查；Fork 不會自動回饋原作。</p></section>}
        <details className="skill-intro-details"><summary>開始使用</summary><div className="stack">{current?<pre className="skill-intro-command"><code>{current.useNotes}</code></pre>:detailError?<div role="alert"><p>{detailError}</p><button type="button" className="btn btn-ghost" onClick={()=>setReload(value=>value+1)}>重新載入使用說明</button></div>:<p role="status">正在載入使用說明…</p>}</div></details>
        <details className="skill-intro-details skill-intro-source"><summary>作者、授權與收錄來源</summary><div className="stack"><p>分享者與來源的關係為自行聲明，尚未核實作者身分；收錄不代表公會指定。</p><p>{license==='NOASSERTION'?'來源未明確宣告授權條款；Fork 不代表額外取得作品、素材或程式的使用權。':`來源記錄的程式授權：${license}。素材與引用內容請另外查看專案說明。`}</p>{evidence&&<a href={evidence} target="_blank" rel="noopener noreferrer">閱讀授權 ↗</a>}{item.source.archived&&<p className="field-hint">來源 Repo 已封存。</p>}{/^[0-9a-f]{40}$/.test(item.source.commit_sha)&&<p className="field-hint">收錄版本：<code>{item.source.commit_sha.slice(0,12)}</code></p>}</div></details>
      </div>
    </dialog>
  </>;
}
