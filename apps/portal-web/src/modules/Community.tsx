import { useEffect, useState } from 'react';
import type { PortalClient } from '../api';
import {SkillBookIntro} from './SkillBookIntro';

export type SiteConfig = { registration_enabled: boolean; demo_accounts_enabled: boolean; public_mode: boolean };
export function BrandPoster({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? 'brand-poster brand-poster-compact' : 'brand-poster'}><img src="/brand/freedom-workshop.webp" alt="自由工坊 — 自由創作，一起實現" width="1280" height="720" fetchPriority={compact ? 'auto' : 'high'}/></div>;
}
export const communityLinks = [
  { label: 'Discord・自由工坊', url: 'https://discord.gg/MtccYqJxCx' },
  { label: 'LINE・Claude', url: 'https://line.me/ti/g2/DPTQR_XE6IYP8c5lBxsbRwsvEUsxI-70p1jWoA' },
  { label: 'LINE・Codex', url: 'https://line.me/ti/g2/qwiG-IhXAyEBMzVNt6J-I1ryqj6dKhNoyCTr2A' },
  { label: 'LINE・Grok', url: 'https://line.me/ti/g2/83dpd53WEvKWbgDROTV2t0z5hXnNSZTUTq17tg' },
];
export function CommunityLinks() {
  return <footer className="community-footer"><div><strong>自由工坊</strong><p>自由創作，讓每一種專業都有位置。</p></div><nav aria-label="自由工坊社群">{communityLinks.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{link.label} ↗</a>)}</nav></footer>;
}
type CatalogBook={id:string;title:string;repository_url:string;fork_url:string|null;description:string;license_status:string;introduction_url?:string|null;upstream_url?:string;source_commit?:string|null};
type CommunityCatalog={name:string;tagline:string;metrics:{label:string;value:number;as_of:string;note:string}[];featured_projects:CatalogBook[];skill_books:CatalogBook[];project_links?:{title:string;url:string;description:string}[]};
export function RepositoryLibrary({client,ids,title='社群技能書'}:{client:PortalClient;ids?:string[];title?:string}){
  const [catalog,setCatalog]=useState<CommunityCatalog|null>(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;void client.get<CommunityCatalog>('/community').then(data=>{if(active)setCatalog(data)}).catch(()=>{if(active)setError('社群技能書暫時無法載入。')});return()=>{active=false};},[client]);
  const books=ids?catalog?.skill_books.filter(book=>ids.includes(book.id)):catalog?.featured_projects;
  return <section className="stack"><header className="section-heading"><h3>{title}</h3><p className="muted">從原作者的公開作品出發，在工坊持續學習與改造。</p></header>{error&&<p role="alert">{error}</p>}{!catalog&&!error&&<p role="status">正在載入技能書…</p>}<div className="card-grid">{books?.map(book=><article className="card skill-book" key={book.id}><h4>{book.title}</h4><p>{book.description}</p>{book.license_status==='NOASSERTION'&&<p className="field-hint">授權尚待確認；使用、修改與再發布前請先閱讀來源說明。</p>}<SkillBookIntro book={book}/></article>)}</div></section>;
}
export function CommunityPanel({ client }: { client: PortalClient }) {
  const [data,setData]=useState<CommunityCatalog|null>(null),[error,setError]=useState('');
  useEffect(()=>{void client.get<CommunityCatalog>('/community').then(setData).catch(()=>setError('社群資料暫時無法載入。'));},[client]);
  return <section className="module-panel"><BrandPoster compact/><header className="section-heading"><p className="eyebrow">FREE TO BUILD TOGETHER</p><h2>這裡是自由工坊</h2><p>從你的專長出發，用技能書做出第一個作品，在公會與小隊找到一起前進的人。</p></header><CommunityLinks/><section className="card stack"><h3>社群足跡</h3>{error&&<p role="alert">{error}</p>}{data?.metrics.map(metric=><div key={metric.label}><strong>{metric.label} · 約 {metric.value.toLocaleString('zh-TW')}</strong><p className="muted">{metric.note} · {metric.as_of}</p></div>)}<p className="muted">由社群提供的概數，不是即時或去重後的人數。</p><a href="https://github.com/Hao0321/freeworkshop-open-data" target="_blank" rel="noopener noreferrer">查看社群開放資料 ↗</a></section><RepositoryLibrary client={client} title="自由工坊的作品與技能書"/>{Boolean(data?.project_links?.length)&&<section className="stack" aria-labelledby="community-project-links"><h3 id="community-project-links">更多工坊作品</h3><div className="card-grid">{data?.project_links?.filter(project=>{try{return new URL(project.url).protocol==='https:'}catch{return false}}).map(project=><article className="card stack" key={project.url}><h4>{project.title}</h4><p className="muted">{project.description}</p><a className="btn btn-ghost" href={project.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看專案網站 ↗</a></article>)}</div></section>}</section>;
}
