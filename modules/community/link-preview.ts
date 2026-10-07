import { normalizeRemoteThumbnail } from '../skill-submissions/payload.js';
import { normalizeShareUrl } from '../../packages/shared/share-url.js';
import { youtubeVideoId } from '../../packages/shared/youtube-video-id.js';

export const PREVIEW_USER_AGENT = 'FreedomWorkshopPreview/1.0 (+https://freetwai.com)';
const HTML_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 5 * 1024 * 1024;

export type PreviewFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type LinkPreview = { title: string | null; image: Buffer | null; source: 'youtube' | 'page' | null };

function decodeEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function attributes(tag: string) {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    found[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? '');
  }
  return found;
}

function meta(html: string, key: string) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if ((attrs.property || attrs.name || '').toLowerCase() === key && attrs.content?.trim()) return attrs.content.trim();
  }
  return null;
}

function finishTitle(value: string) {
  // Already decoded. Drop brackets before whitespace collapsing and the length cap.
  return value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}

export function previewTitle(html: string) {
  const og = meta(html, 'og:title');
  if (og) return finishTitle(og);
  const titled = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  return finishTitle(decodeEntities(titled));
}

export function previewImageUrl(html: string, pageUrl: string) {
  for (const key of ['og:image', 'og:image:secure_url', 'twitter:image']) {
    const raw = meta(html, key);
    if (!raw) continue;
    try {
      const absolute = new URL(raw, pageUrl).href;
      const normalized = normalizeShareUrl(absolute);
      if (normalized.ok) return normalized.url;
    } catch { /* skip a broken image address */ }
  }
  return null;
}

async function readBounded(response: Response, max: number) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { await reader.cancel().catch(() => {}); return null; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function fetchChecked(fetcher: PreviewFetch, start: string, deadline: number, accept: string, max: number) {
  let current = start;
  for (let hop = 0; hop <= 3; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const guard = normalizeShareUrl(current);
    if (!guard.ok) return null;
    current = guard.url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetcher(current, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': PREVIEW_USER_AGENT, Accept: accept } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        if (hop === 3) return null;
        const location = response.headers.get('location');
        if (!location) return null;
        try { current = new URL(location, current).href; } catch { return null; }
        continue;
      }
      if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return null; }
      const body = await readBounded(response, max);
      if (!body) return null;
      return { url: current, type: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), body };
    } catch { return null; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return null;
}

async function asThumbnail(bytes: Buffer, type: string) {
  // Any declared image/* is accepted. The format comes from the bytes, never from Content-Type.
  if (!type.startsWith('image/')) return null;
  try { return await normalizeRemoteThumbnail(bytes); } catch { return null; }
}

/** Best-effort title and 640×360 thumbnail. Failures return nulls; they never throw. */
export async function previewLink(rawUrl: string, fetcher: PreviewFetch, timeoutMs = 6000): Promise<LinkPreview> {
  const empty: LinkPreview = { title: null, image: null, source: null };
  const normalized = normalizeShareUrl(rawUrl);
  if (!normalized.ok) return empty;
  const deadline = Date.now() + timeoutMs;
  const video = youtubeVideoId(normalized.url);
  if (video) {
    const oembed = await fetchChecked(fetcher, `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(normalized.url)}`, deadline, 'application/json', HTML_LIMIT);
    let title: string | null = null;
    if (oembed && (oembed.type === 'application/json' || oembed.type === 'text/json' || oembed.type.endsWith('+json'))) {
      try { const parsed = JSON.parse(oembed.body.toString('utf8')) as { title?: unknown }; title = typeof parsed.title === 'string' ? parsed.title.replace(/\s+/g, ' ').trim().slice(0, 120) || null : null; } catch { title = null; }
    }
    const image = await fetchChecked(fetcher, `https://i.ytimg.com/vi/${video}/hqdefault.jpg`, deadline, 'image/jpeg,image/png,image/webp', IMAGE_LIMIT);
    const thumb = image ? await asThumbnail(image.body, image.type) : null;
    return { title, image: thumb, source: thumb ? 'youtube' : null };
  }
  const page = await fetchChecked(fetcher, normalized.url, deadline, 'text/html', HTML_LIMIT);
  if (!page || page.type.startsWith('image/')) return empty;
  const html = page.body.toString('utf8');
  const title = previewTitle(html);
  const imageUrl = previewImageUrl(html, page.url);
  if (!imageUrl) return { title, image: null, source: null };
  const image = await fetchChecked(fetcher, imageUrl, deadline, 'image/jpeg,image/png,image/webp', IMAGE_LIMIT);
  const thumb = image ? await asThumbnail(image.body, image.type) : null;
  return { title, image: thumb, source: thumb ? 'page' : null };
}
