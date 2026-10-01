import type {Pool} from 'pg';
import {highlightShareImage, listHighlightEvents, readHighlightCursor, readHighlightEvent, readHighlightMode} from './event-highlights.js';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const modeLabel: Record<string, string> = {online: '線上', in_person: '實體', hybrid: '線上＋實體'};
const kindLabel: Record<string, string> = {reading_group: '線上讀書會', meetup: '聚會', guild_skill_exchange: '公會技能交流', other: '其他活動'};
const platformLabel: Record<string, string> = {youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', x: 'X', vimeo: 'Vimeo', google_drive: 'Google 雲端硬碟', google_photos: 'Google 相簿', other: '連結'};
const dayFormat = new Intl.DateTimeFormat('zh-TW', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'});
const timeFormat = new Intl.DateTimeFormat('zh-TW', {timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});

export function highlightWhen(starts: string, ends: string) {
  const start = new Date(starts), end = new Date(ends);
  const same = dayFormat.format(start) === dayFormat.format(end);
  return same ? `${dayFormat.format(start)} ${timeFormat.format(start)}–${timeFormat.format(end)}` : `${dayFormat.format(start)} ${timeFormat.format(start)} – ${dayFormat.format(end)} ${timeFormat.format(end)}`;
}
export function highlightMetaDescription(description: string | null | undefined) {
  const collapsed = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '自由工坊社群活動回顧：海報、照片與錄影連結。';
  const chars = [...collapsed];
  return chars.length <= 160 ? collapsed : chars.slice(0, 160).join('');
}
function absolute(origin: string, url: string) { return url.startsWith('https://') || url.startsWith('http://') ? url : origin + url; }
function head(origin: string, path: string, title: string, description: string, image: {url: string; width: number; height: number; alt: string}, type: 'website' | 'article') {
  const url = origin + path, src = escape(absolute(origin, image.url));
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="canonical" href="${escape(url)}"><meta name="description" content="${escape(description)}"><meta property="og:type" content="${type}"><meta property="og:site_name" content="自由工坊"><meta property="og:locale" content="zh_TW"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(url)}"><meta property="og:image" content="${src}"><meta property="og:image:width" content="${image.width}"><meta property="og:image:height" content="${image.height}"><meta property="og:image:alt" content="${escape(image.alt)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${src}"><meta name="twitter:image:alt" content="${escape(image.alt)}"><link rel="stylesheet" href="/highlights.css"></head>`;
}
function shell(inner: string, footer: string) {
  return `<body><header class="hl-top"><a href="/"><img class="hl-logo" src="/brand/freedom-workshop.webp" alt="自由工坊" width="1280" height="720"></a><a href="/highlights">活動集錦</a></header><main>${inner}</main><footer class="hl-foot">${footer}<p>自由工坊活動集錦</p></footer></body></html>`;
}
const brandImage = {url: '/brand/freedom-workshop.webp', width: 1280, height: 720, alt: '自由工坊'};

function cover(item: {cover: {kind: string; url: string} | null; mode: string; starts_at: string; ends_at: string; title: string}) {
  if (!item.cover) return `<div class="hl-placeholder"><span>${escape(modeLabel[item.mode] ?? item.mode)}</span><span>${escape(highlightWhen(item.starts_at, item.ends_at))}</span></div>`;
  const referrer = item.cover.kind === 'youtube' ? ' referrerpolicy="no-referrer"' : '';
  return `<img src="${escape(item.cover.url)}" alt="" loading="lazy"${referrer}>`;
}

export async function highlightsListHtml(pool: Pool, origin: string, query: {mode?: string; before?: string}) {
  const mode = readHighlightMode(query.mode, true);
  const cursor = readHighlightCursor(query.before, true);
  const page = await listHighlightEvents(pool, {communityId: null, viewerId: null, mode, cursor});
  const chips = (['all', 'online', 'in_person'] as const).map(value => {
    const href = value === 'all' ? '/highlights' : `/highlights?mode=${value}`;
    const label = value === 'all' ? '全部' : value === 'online' ? '線上' : '實體';
    return `<a href="${href}"${mode === value ? ' aria-current="page"' : ''}>${label}</a>`;
  }).join('');
  const cards = page.items.map(item => `<article class="hl-card"><a class="hl-cover" href="${escape(item.public_path)}">${cover(item)}</a><h2><a href="${escape(item.public_path)}">${escape(item.title)}</a></h2><p>${escape(highlightWhen(item.starts_at, item.ends_at))}</p><p><span class="hl-mode hl-mode-${escape(item.mode)}">${escape(modeLabel[item.mode] ?? item.mode)}</span> ${escape(item.organizer_name)}</p><p>${item.attending_count} 人參加 · 影片 ${item.counts.links}・照片 ${item.counts.photos}・海報 ${item.counts.posters}</p></article>`).join('');
  const href = page.next_cursor ? `/highlights?${mode === 'all' ? '' : `mode=${mode}&`}before=${encodeURIComponent(page.next_cursor)}` : '';
  const more = page.next_cursor ? `<p class="hl-more"><a href="${escape(href)}">較早的活動</a></p>` : '';
  const empty = page.items.length ? '' : '<p class="hl-empty">還沒有已結束的活動。活動結束後會自動出現在這裡。</p>';
  const canonical = new URLSearchParams();
  if (mode !== 'all') canonical.set('mode', mode);
  if (cursor && query.before) canonical.set('before', query.before);
  const path = canonical.size ? `/highlights?${canonical.toString()}` : '/highlights';
  const body = `<h1>活動集錦</h1><p>活動結束後會自動收進這裡，公開分享海報、照片與影片連結。</p><nav class="hl-chips" aria-label="活動形式">${chips}</nav><div class="hl-grid">${cards}</div>${empty}${more}`;
  return head(origin, path, '活動集錦｜自由工坊', '自由工坊社群活動回顧：海報、照片與錄影連結。', brandImage, 'website') + shell(body, '<a href="/">加入自由工坊</a>');
}

function paragraphs(description: string) {
  return description.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => `<p>${escape(line)}</p>`).join('') || '<p>這場活動沒有留下說明。</p>';
}

export async function highlightsDetailHtml(pool: Pool, origin: string, eventId: string) {
  const detail = await readHighlightEvent(pool, {communityId: null, viewerId: null, eventId});
  const image = await highlightShareImage(pool, eventId);
  const posters = detail.items.filter(item => item.kind === 'poster');
  const links = detail.items.filter(item => item.kind === 'link');
  const photos = detail.items.filter(item => item.kind === 'photo');
  const banner = detail.banner_url ? `<figure><img src="${escape(detail.banner_url)}" alt="${escape(detail.title)} 海報" loading="lazy"></figure>` : '';
  const posterHtml = posters.map(item => `<figure><img src="${escape('image_url' in item ? item.image_url : '')}" alt="${escape(item.title || '海報')}" loading="lazy">${item.title ? `<figcaption>${escape(item.title)}</figcaption>` : ''}</figure>`).join('');
  const posterSection = banner || posterHtml ? `<section><h2>海報</h2><div class="hl-posters">${banner}${posterHtml}</div></section>` : '';
  const linkHtml = links.map(item => {
    const platform = 'platform' in item ? String(item.platform ?? 'other') : 'other';
    const thumb = 'thumbnail_url' in item && item.thumbnail_url ? `<img src="${escape(item.thumbnail_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="hl-placeholder">${escape(platformLabel[platform] ?? '連結')}</span>`;
    const url = 'url' in item ? item.url : '';
    return `<article class="hl-link">${thumb}<h3>${escape(item.title || '相關連結')}</h3><p class="hl-platform">${escape(platformLabel[platform] ?? '連結')}</p><p><a href="${escape(String(url))}" target="_blank" rel="noopener noreferrer">開啟影片 ↗</a></p></article>`;
  }).join('');
  const photoHtml = photos.map(item => `<a href="${escape('image_url' in item ? item.image_url : '')}"><img src="${escape('thumb_url' in item ? item.thumb_url : '')}" alt="${escape(item.title || '活動照片')}" loading="lazy"></a>`).join('');
  const empty = detail.items.length ? '' : '<p class="hl-empty">還沒有人補上內容。參加過的夥伴可以上傳照片、海報或貼上影片連結。</p>';
  const summary = `<h1>${escape(detail.title)}</h1><p>${escape(highlightWhen(detail.starts_at, detail.ends_at))} · ${escape(modeLabel[detail.mode] ?? detail.mode)} · ${escape(kindLabel[detail.event_kind] ?? detail.event_kind)}</p><p>主辦 ${escape(detail.organizer_name)} · ${detail.attending_count} 人參加</p><div class="hl-copy">${paragraphs(detail.description)}</div>`;
  const body = `${summary}${posterSection}<section><h2>錄影與影片</h2>${linkHtml ? `<div class="hl-links">${linkHtml}</div>` : ''}</section><section><h2>活動照片</h2>${photoHtml ? `<div class="hl-photos">${photoHtml}</div>` : ''}</section>${empty}`;
  const footer = `<a href="/">加入自由工坊</a><a href="/#highlights/${escape(eventId)}">會員登入後補上照片或影片連結</a>`;
  return head(origin, `/highlights/${eventId}`, `${detail.title}｜自由工坊活動集錦`, highlightMetaDescription(detail.description), image, 'article') + shell(body, footer);
}

export function highlightsNotFoundHtml(origin: string) {
  const body = '<h1>找不到這場活動</h1><p>這場活動還沒有公開的活動集錦，或連結不正確。</p><p><a href="/highlights">回到活動集錦</a></p>';
  return head(origin, '/highlights', '找不到活動｜自由工坊活動集錦', '自由工坊社群活動回顧：海報、照片與錄影連結。', brandImage, 'website') + shell(body, '<a href="/">加入自由工坊</a>');
}

export const highlightsCss = `:root{color-scheme:light;--bg:#f6f8fb;--ink:#1c2636;--muted:#566376;--line:#dce3eb;--card:#fff;--link:#315500;--chip:#f2f8dc;--info:#eef4ff;--blue:#344cbd}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#08090b;--ink:#f4f6ef;--muted:#aeb5c2;--line:#333943;--card:#14161b;--link:#c4ff20;--chip:#222c12;--info:#181f38;--blue:#9ba7ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main,header,footer{width:min(1080px,100%);margin:auto;padding:1rem}img{max-width:100%;height:auto}a{color:var(--link)}a:focus-visible,button:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
.hl-top,.hl-foot{display:flex;flex-wrap:wrap;gap:.8rem 1rem;align-items:center}.hl-top{border-bottom:1px solid var(--line)}.hl-foot{border-top:1px solid var(--line);margin-top:1.5rem}.hl-logo{width:min(220px,70vw);height:auto;display:block}
.hl-chips{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.hl-chips a{min-height:44px;display:inline-flex;align-items:center;padding:.35rem .85rem;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--ink);background:var(--card)}.hl-chips a[aria-current]{background:var(--chip);color:var(--link);border-color:var(--link)}
.hl-grid,.hl-links{display:grid;grid-template-columns:minmax(0,1fr);gap:.8rem}.hl-card,.hl-link{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.8rem;overflow-wrap:anywhere}.hl-card h2 a{color:inherit;text-decoration:none}.hl-cover{display:block;aspect-ratio:16/9;overflow:hidden;border-radius:10px;background:var(--info);color:inherit;text-decoration:none}.hl-cover img,.hl-placeholder{width:100%;height:100%;object-fit:cover;display:block}.hl-placeholder{display:grid;place-items:center;align-content:center;gap:.25rem;min-height:8rem;background:var(--info);color:var(--ink);border:1px dashed var(--line);border-radius:10px;text-align:center;padding:.6rem}
.hl-mode{display:inline-flex;align-items:center;min-height:1.6rem;padding:.1rem .5rem;border-radius:999px;background:var(--info);color:var(--blue);font-size:.85rem}.hl-mode-in_person{background:var(--chip);color:var(--link)}.hl-mode-hybrid{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--blue)}.hl-platform{display:inline-flex;align-items:center;min-height:1.6rem;padding:.1rem .5rem;border-radius:999px;border:1px solid var(--line);color:var(--ink);background:var(--card);font-size:.85rem}
.hl-posters figure{margin:.6rem 0}.hl-posters img{width:100%;max-height:70vh;object-fit:contain;background:#14161b;border-radius:12px}.hl-photos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem}.hl-photos img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px;background:var(--info)}.hl-link img,.hl-link .hl-placeholder{width:100%;aspect-ratio:16/9;height:auto;object-fit:cover;display:block;border-radius:10px}.hl-links{align-items:start}.hl-photos a{display:block;min-width:0}.hl-more a,.hl-foot a{min-height:44px;display:inline-flex;align-items:center}
h1{font-size:1.6rem;line-height:1.3}h2{font-size:1.15rem}p{overflow-wrap:anywhere}@media(min-width:700px){.hl-grid,.hl-links{grid-template-columns:repeat(2,minmax(0,1fr))}.hl-photos{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(min-width:1100px){.hl-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.hl-photos{grid-template-columns:repeat(4,minmax(0,1fr))}}
`;

