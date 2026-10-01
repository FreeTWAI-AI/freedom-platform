// Browser-safe share URL rules. No DNS lookups and no Node-only modules.
export const SOCIAL_PLATFORMS = ['youtube', 'instagram', 'facebook', 'threads', 'tiktok', 'x', 'other'] as const;
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number];

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads', tiktok: 'TikTok', x: 'X', other: '其他',
};

const PLATFORM_HOSTS: readonly [string, SocialPlatform][] = [
  ['youtube.com', 'youtube'], ['youtu.be', 'youtube'],
  ['instagram.com', 'instagram'],
  ['facebook.com', 'facebook'], ['fb.watch', 'facebook'],
  ['threads.net', 'threads'], ['threads.com', 'threads'],
  ['tiktok.com', 'tiktok'],
  ['x.com', 'x'], ['twitter.com', 'x'],
];

const TRACKING = new Set(['fbclid', 'igshid', 'si']);

/** The workshop's own site. A /go/ link posted back into the zone would score one visit twice. */
export function isOwnWorkshopHost(host: string, publicOrigin: string) {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'freetwai.com' || name.endsWith('.freetwai.com')) return true;
  try {
    const originHost = new URL(publicOrigin).hostname.toLowerCase().replace(/\.$/, '');
    return originHost.length > 0 && name === originHost;
  } catch { return false; }
}

export function classifyShareHost(host: string): SocialPlatform {
  const name = host.toLowerCase().replace(/\.$/, '');
  for (const [domain, platform] of PLATFORM_HOSTS) {
    if (name === domain || name.endsWith('.' + domain)) return platform;
  }
  return 'other';
}

function ipLiteral(host: string): boolean {
  if (host.includes(':')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^\d+$/.test(host)) return true;
  return false;
}

export type ShareUrl =
  | { ok: true; url: string; host: string; platform: SocialPlatform }
  | { ok: false };

/** https only. Lowercase host, drop fragment and known tracking params, reject local and IP hosts. */
export function normalizeShareUrl(raw: string): ShareUrl {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false };
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { return { ok: false }; }
  if (parsed.protocol !== 'https:') return { ok: false };
  if (parsed.username || parsed.password) return { ok: false };
  if (parsed.port) return { ok: false };
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return { ok: false };
  if (ipLiteral(host)) return { ok: false };
  if (!host.includes('.')) return { ok: false };
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return { ok: false };
  const kept = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING.has(lower)) continue;
    kept.append(key, value);
  }
  parsed.hash = '';
  parsed.hostname = host;
  parsed.search = kept.toString() ? `?${kept.toString()}` : '';
  const url = parsed.href;
  if (url.length > 2048) return { ok: false };
  return { ok: true, url, host, platform: classifyShareHost(host) };
}

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

/** YouTube watch, short, live, embed and youtu.be ids. Anything else is null. */
export function youtubeVideoId(raw: string): string | null {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const take = (value: string | null | undefined) => value && VIDEO_ID.test(value) ? value : null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be' || host.endsWith('.youtu.be')) return take(parts[0]);
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (parts[0] === 'watch') return take(parsed.searchParams.get('v'));
    if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') return take(parts[1]);
  }
  return null;
}
