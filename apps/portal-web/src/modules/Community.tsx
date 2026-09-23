import { useEffect, useState } from 'react';
import type { PortalClient } from '../api';
import { SkillBookCard, type IntroBook } from './SkillBookIntro';

export type SiteConfig = { registration_enabled: boolean; demo_accounts_enabled: boolean; public_mode: boolean };
export function BrandPoster({ compact = false }: { compact?: boolean }) {
  return <div className={`brand-poster brand-poster-original${compact ? ' brand-poster-compact' : ''}`}><img src="/brand/freedom-workshop.webp" alt="自由工坊 — 自由創作，一起實現" width="1280" height="720" fetchPriority={compact ? 'auto' : 'high'}/></div>;
}
export const communityLinks = [
  { label: 'Discord・自由工坊', url: 'https://discord.gg/MtccYqJxCx' },
  { label: 'LINE・Claude', url: 'https://line.me/ti/g2/DPTQR_XE6IYP8c5lBxsbRwsvEUsxI-70p1jWoA' },
  { label: 'LINE・Codex', url: 'https://line.me/ti/g2/qwiG-IhXAyEBMzVNt6J-I1ryqj6dKhNoyCTr2A' },
  { label: 'LINE・Grok', url: 'https://line.me/ti/g2/83dpd53WEvKWbgDROTV2t0z5hXnNSZTUTq17tg' },
];
export function CommunityLinks() {
  return <footer className="community-footer"><div><strong>自由工坊</strong><p>自由創作，讓每一種專業都有位置。</p></div><nav aria-label="自由工坊社群">{communityLinks.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{link.label} <span aria-hidden="true">↗</span></a>)}</nav></footer>;
}

type CatalogBook = IntroBook & { id: string; fork_url: string | null; license_status: string };
type CommunityCatalog = { name: string; tagline: string; metrics: { label: string; value: number; as_of: string; note: string }[]; featured_projects: CatalogBook[]; skill_books: CatalogBook[]; project_links?: { title: string; url: string; description: string }[] };

export function RepositoryLibrary({ client, ids, title = '社群技能書' }: { client: PortalClient; ids?: string[]; title?: string }) {
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(null), [error, setError] = useState('');
  const [search,setSearch]=useState(''),[category,setCategory]=useState(''),[reload,setReload]=useState(0);
  useEffect(() => {
    let active = true;
    setError('');setCatalog(null);
    void client.get<CommunityCatalog>('/community').then(data => { if (active) setCatalog(data); }).catch(() => { if (active) setError('社群技能書暫時無法載入。'); });
    return () => { active = false; };
  }, [client,reload]);
  const available=ids?catalog?.skill_books.filter(book=>ids.includes(book.id))??[]:catalog?.skill_books??[];
  const categories=[...new Set(available.map(book=>book.guide?.beginner?.category).filter((value):value is NonNullable<typeof value>=>!!value))];
  const term=search.trim().toLocaleLowerCase();
  const books=available.filter(book=>(!category||book.guide?.beginner?.category===category)&&(!term||[book.title,book.description,...Object.values(book.guide?.beginner??{})].join(' ').toLocaleLowerCase().includes(term)));
  return <section className="stack community-library">
    <header className="community-library-heading">
      <div><p className="home-eyebrow">THE SHARED LIBRARY</p><h3>{title}</h3></div>
      <img src="/art/rpg/skill-codex.webp" alt="" width="360" height="240" loading="lazy"/>
    </header>
    {error && <div role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" onClick={()=>setReload(value=>value+1)}>重新載入技能書</button></div>}
    {!catalog && !error && <p role="status">正在載入技能書…</p>}
    {catalog&&<><div className="skill-library-filters"><label className="field">搜尋技能書<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="例如：貼文、商店、剪輯、找方向…"/></label><label className="field">依工坊用途篩選<select value={category} onChange={event=>setCategory(event.target.value)}><option value="">全部用途</option>{categories.map(value=><option key={value} value={value}>{value}</option>)}</select></label></div><p className="skill-library-count" role="status">顯示 {books.length} / {available.length} 本技能書</p></>}
    <div className="card-grid community-book-grid">{books.map(book=><SkillBookCard key={book.id} book={book} className="community-book"/>)}</div>
    {catalog&&!books.length&&<p className="muted">沒有符合的技能書。試試另一個關鍵字或用途。</p>}
  </section>;
}

export function CommunityPanel({ client }: { client: PortalClient }) {
  const [data, setData] = useState<CommunityCatalog | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void client.get<CommunityCatalog>('/community').then(value => { if (active) setData(value); }).catch(() => { if (active) setError('社群資料暫時無法載入。'); });
    return () => { active = false; };
  }, [client]);
  return <section className="module-panel freedom-community">
    <header className="community-entry-hero">
      <div className="community-entry-copy"><p className="home-eyebrow">FREE TO BUILD TOGETHER</p><h2>這裡是<br/><span>自由工坊</span></h2><p>從你的專長出發，用技能書做出第一個作品，<br/>在公會與小隊找到一起前進的人。</p><span className="community-entry-signoff">每一種專業，都有自己的位置。 <span aria-hidden="true">✦</span></span></div>
      <BrandPoster compact/>
    </header>
    <CommunityLinks/>
    <section className="community-footprint" aria-labelledby="community-footprint-title">
      <header><p className="home-eyebrow">OUR FOOTPRINT</p><h3 id="community-footprint-title">社群足跡</h3></header>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">正在載入社群足跡…</p>}
      <div className="community-metrics">{data?.metrics.map(metric => <div className="community-metric" key={metric.label}>
        <p>{metric.label}</p><strong><span>約</span> {metric.value.toLocaleString('zh-TW')}</strong><p>{metric.note} · {metric.as_of}</p>
      </div>)}</div>
      <div className="community-metric-source"><p>由社群提供的概數，不是即時或去重後的人數。</p><a href="https://github.com/Hao0321/freeworkshop-open-data" target="_blank" rel="noopener noreferrer">查看社群開放資料 ↗</a></div>
    </section>
    <RepositoryLibrary client={client} title="自由工坊的作品與技能書"/>
    {Boolean(data?.project_links?.length) && <section className="stack community-projects" aria-labelledby="community-project-links">
      <header className="home-section-heading"><div><p className="home-eyebrow">MADE IN THE WORKSHOP</p><h3 id="community-project-links">更多工坊作品</h3></div></header>
      <div className="card-grid">{data?.project_links?.filter(project => { try { return new URL(project.url).protocol === 'https:'; } catch { return false; } }).map(project => <article className="card stack community-project" key={project.url}>
        <span className="community-project-orbit" aria-hidden="true">↗</span><h4>{project.title}</h4><p className="muted">{project.description}</p><a className="btn btn-ghost" href={project.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看專案網站 ↗</a>
      </article>)}</div>
    </section>}
  </section>;
}
