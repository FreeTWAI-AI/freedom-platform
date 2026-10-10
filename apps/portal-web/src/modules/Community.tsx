import { useEffect, useState } from 'react';
import type { PortalClient } from '../api';
import type { TabId } from '../types';
import { SkillBookCard, type IntroBook } from './SkillBookIntro';
import {SkillDiscoveryFilters,type SkillDiscoveryView} from './SkillDiscovery';
import {useSkillDiscovery,type SkillDiscoveryBook} from './skill-discovery-client';
import {useLanguage} from '../language';

export type SiteConfig = { registration_enabled: boolean; password_recovery_enabled?: boolean; demo_accounts_enabled: boolean; public_mode: boolean; guild_launchpad_enabled?: boolean; hosted_store_photos_enabled?:boolean; hosted_store_photo_uploads_enabled?:boolean; community_discovery_enabled?: boolean; message_images_enabled?:boolean; member_blocking_enabled: boolean; unified_sharing_enabled?: boolean; community_search_enabled?: boolean; community_relations_enabled?: boolean; personal_content_enabled?: boolean; notification_preferences_enabled?: boolean; first_participation_enabled?: boolean; event_participation_enabled?: boolean };
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
  const {t}=useLanguage();
  return <footer className="community-footer"><div><strong>自由工坊</strong><p>{t('community.tagline')}</p></div><nav aria-label={t('community.links')} data-guide-anchor="community:links">{communityLinks.map(link => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{link.label} <span aria-hidden="true">↗</span></a>)}</nav></footer>;
}

export type CatalogBook = IntroBook & { id: string; fork_url: string | null; license_status: string };
type CommunityCatalog = { name: string; tagline: string; metrics: { label: string; value: number; as_of: string; note: string }[]; featured_projects: CatalogBook[]; skill_books: CatalogBook[]; project_links?: { title: string; url: string; description: string }[] };

// Both shelves read one catalog request; a failed request is forgotten so the next read retries.
const catalogs = new WeakMap<PortalClient, Promise<CommunityCatalog>>();
export function loadCommunityCatalog(client: PortalClient) {
  let request = catalogs.get(client);
  if (!request) {
    const next = client.get<CommunityCatalog>('/community');
    catalogs.set(client, next); request = next;
    next.catch(() => { if (catalogs.get(client) === next) catalogs.delete(client); });
  }
  return request;
}
/** A guild designates the book (statically or by an approved binding), or the member already holds it. The rest are 社群技能書. */
export function isGuildBook(book: CatalogBook, discovery: SkillDiscoveryBook | undefined, unlocked: readonly string[] = []) {
  return Boolean(book.official_guild_keys?.length || discovery?.official_guild_keys.length) || unlocked.includes(book.id);
}
/** Case-insensitive match over the text a reader sees on a skill book. */
export function matchesSkillSearch(term: string, values: (string | null | undefined)[]) {
  const needle = term.trim().toLocaleLowerCase();
  return !needle || values.join(' ').toLocaleLowerCase().includes(needle);
}

export function RepositoryLibrary({ client, ids, excludeIds, access, title = '社群技能書', compact = false, shelf, headingLevel }: { client: PortalClient; ids?: string[]; excludeIds?:string[]; access?:'unlocked'|'locked'; title?: string; compact?: boolean; shelf?: 'guild'; headingLevel?: 2|3|4 }) {
  const [catalog, setCatalog] = useState<CommunityCatalog | null>(null), [error, setError] = useState('');
  const [search,setSearch]=useState(''),[category,setCategory]=useState(''),[reload,setReload]=useState(0),[view,setView]=useState<SkillDiscoveryView>('all');
  const discovery=useSkillDiscovery();
  useEffect(() => {
    let active = true;
    setError('');setCatalog(null);
    void loadCommunityCatalog(client).then(data => { if (active) setCatalog(data); }).catch(() => { if (active) setError('社群技能書暫時無法載入。'); });
    return () => { active = false; };
  }, [client,reload]);
  const bookMeta=new Map(discovery.data?.books.map(book=>[book.book_id,book]));
  // The guild shelf holds only guild-designated books; 社群技能書 have their own shelf.
  const available=(catalog?.skill_books??[]).filter(book=>(!ids||ids.includes(book.id))&&(!excludeIds||!excludeIds.includes(book.id))&&(shelf!=='guild'||ids!==undefined||isGuildBook(book,bookMeta.get(book.id))));
  const categories=[...new Set(available.map(book=>book.guide?.beginner?.category).filter((value):value is NonNullable<typeof value>=>!!value))];
  const discovered=available.filter(book=>{
    if(view==='all')return true;
    if(discovery.error)return false;
    const meta=bookMeta.get(book.id);
    if(!meta)return false;
    return view==='official'?meta.official_guild_keys.length>0:view==='today'?meta.is_new_today:view==='week'?meta.week_rank!==null:meta.month_rank!==null;
  });
  if(view==='week'||view==='month')discovered.sort((a,b)=>(view==='week'?bookMeta.get(a.id)!.week_rank!:bookMeta.get(a.id)!.month_rank!)-(view==='week'?bookMeta.get(b.id)!.week_rank!:bookMeta.get(b.id)!.month_rank!));
  const books=discovered.filter(book=>(!category||book.guide?.beginner?.category===category)&&matchesSkillSearch(search,[book.title,book.description,book.guide?.author_name,book.upstream_url,...Object.values(book.guide?.beginner??{})]));
  return <section className="stack community-library" aria-label={title}>
    {!compact && <header className="community-library-heading">
      <div><p className="home-eyebrow">THE SHARED LIBRARY</p><h3>{title}</h3></div>
      <img src="/art/rpg/skill-codex.webp" alt="" width="360" height="240" loading="lazy"/>
    </header>}
    {error && <div role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" onClick={()=>setReload(value=>value+1)}>重新載入技能書</button></div>}
    {!catalog && !error && <p role="status">正在載入技能書…</p>}
    {catalog&&available.length===0&&<p className="muted">目前沒有可顯示的技能書。</p>}
    {catalog&&available.length>0&&<><SkillDiscoveryFilters value={view} onChange={setView} official={shelf!=='guild'}/><div className="skill-library-filters"><label className="field">搜尋技能書<input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="例如：貼文、商店、剪輯、找方向…"/></label><label className="field">依工坊用途篩選<select value={category} onChange={event=>setCategory(event.target.value)}><option value="">全部用途</option>{categories.map(value=><option key={value} value={value}>{value}</option>)}</select></label></div><p className="skill-library-count" role="status">顯示 {books.length} / {available.length} 本技能書</p></>}
    <div className="card-grid community-book-grid">{books.map(book=><SkillBookCard key={book.id} book={book} className="community-book" access={access} headingLevel={headingLevel}/>)}</div>
    {catalog&&available.length>0&&!books.length&&<p className="muted">{view!=='all'&&discovery.error?'請重讀徽章與榜單，或先查看全部技能。':view!=='all'&&discovery.loading&&!discovery.data?'正在載入技能書…':(view==='week'||view==='month')&&!discovered.length?'目前還沒有上榜的技能書。連結 GitHub，Star 你喜歡的技能。':view==='today'&&!discovered.length?'今天尚未收錄新技能。':view==='official'&&!discovered.length?'目前尚未指定官方公會技能。':'沒有符合的技能書。試試另一個關鍵字或用途。'}</p>}
  </section>;
}

export function CommunityPanel({ client, onNavigate }: { client: PortalClient; onNavigate: (id: TabId) => void }) {
  const [data, setData] = useState<CommunityCatalog | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    void client.get<CommunityCatalog>('/community').then(value => { if (active) setData(value); }).catch(() => { if (active) setError('社群資料暫時無法載入。'); });
    return () => { active = false; };
  }, [client, reload]);
  return <section className="module-panel freedom-community">
    <header className="community-entry-hero">
      <div className="community-entry-copy"><h2>加入社群</h2><p>到 Discord 與 LINE 找夥伴、交流作品。</p></div>
      <BrandPoster compact/>
    </header>
    <CommunityLinks/>
    <section className="card stack community-project" aria-labelledby="community-erp-demo-title">
      <h3 id="community-erp-demo-title">ERP／CRM 產業範本試用</h3>
      <p>mars-tw 的 MIT 個人開源專案，提供零售、批發、服務、餐飲、製造、電商、專案及一般企業八種範本。每位訪客建立自己的模擬工作區，只使用測試幣與虛構商品。</p>
      <div className="actions"><a className="btn btn-ghost" href="https://freedom-erp-crm-demo.digimkt.workers.dev/" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">建立我的模擬測試系統 ↗</a><a className="btn btn-ghost" href="https://github.com/mars-tw/freedom-erp-crm" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看開源程式與一指令建立 ↗</a></div>
      <p className="hint">開啟獨立站點，不轉送工坊會員資料。公開測試資料閒置 72 小時後清除；沒有接入真實財務。</p>
    </section>
    <section className="community-footprint" aria-labelledby="community-footprint-title">
      <header><p className="home-eyebrow">OUR FOOTPRINT</p><h3 id="community-footprint-title" data-guide-anchor="community:footprint">社群足跡</h3></header>
      {error && <div role="alert" className="banner banner-error"><p>{error}</p><button type="button" className="btn btn-ghost" onClick={() => setReload(value => value + 1)}>重新載入社群足跡</button></div>}
      {!data && !error && <p role="status">正在載入社群足跡…</p>}
      <div className="community-metrics">{data?.metrics.map(metric => <div className="community-metric" key={metric.label}>
        <p>{metric.label}</p><strong><span>約</span> {metric.value.toLocaleString('zh-TW')}</strong><p>{metric.note} · {metric.as_of}</p>
      </div>)}</div>
      <div className="community-metric-source"><a href="https://github.com/Hao0321/freeworkshop-open-data" target="_blank" rel="noopener noreferrer">查看社群開放資料 ↗</a></div>
    </section>
    <button className="btn btn-ghost" onClick={() => onNavigate('skills')}>前往技能書架</button>
    {Boolean(data?.project_links?.length) && <section className="stack community-projects" aria-labelledby="community-project-links">
      <header className="home-section-heading"><div><p className="home-eyebrow">MADE IN THE WORKSHOP</p><h3 id="community-project-links">更多工坊作品</h3></div></header>
      <div className="card-grid">{data?.project_links?.filter(project => { try { return new URL(project.url).protocol === 'https:'; } catch { return false; } }).map(project => <article className="card stack community-project" key={project.url}>
        <span className="community-project-orbit" aria-hidden="true">↗</span><h4>{project.title}</h4><p className="muted">{project.description}</p><a className="btn btn-ghost" href={project.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">查看專案網站 ↗</a>
      </article>)}</div>
    </section>}
  </section>;
}
