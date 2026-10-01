const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function hostIs(host: string, domain: string) {
  return host === domain || host.endsWith('.' + domain);
}

// Pure parser. Callers must not fetch the URL. Returns null unless the URL is a
// YouTube watch, short, live or embed link with an 11-character video id.
export function youtubeVideoId(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let id = '';
  if (hostIs(host, 'youtu.be')) id = parts[0] ?? '';
  else if (hostIs(host, 'youtube.com')) {
    if (parts[0] === 'watch') id = url.searchParams.get('v') ?? '';
    else if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') id = parts[1] ?? '';
    else return null;
  } else return null;
  id = id.split(/[?#]/)[0];
  return VIDEO_ID.test(id) ? id : null;
}

export function youtubeThumbnailUrl(raw: string): string | null {
  const id = youtubeVideoId(raw);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
