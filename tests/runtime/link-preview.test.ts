import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewImageUrl, previewLink, previewTitle, type PreviewFetch } from '../../modules/community/link-preview.js';
import { classifyShareHost, normalizeShareUrl, youtubeVideoId } from '../../packages/shared/share-url.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}
function imageResponse(body: Buffer | string, type = 'image/png', status = 200, extra: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': type, ...extra } });
}

test('share URLs drop tracking, reject local hosts and classify platforms', () => {
  const youtube = normalizeShareUrl('https://WWW.YouTube.COM/watch?v=e2eDemo0001&utm_source=a&fbclid=b&si=c&igshid=d&keep=1#t=9');
  assert.equal(youtube.ok && youtube.url, 'https://www.youtube.com/watch?v=e2eDemo0001&keep=1');
  assert.equal(youtube.ok && youtube.platform, 'youtube');
  assert.equal(classifyShareHost('m.facebook.com'), 'facebook');
  assert.equal(classifyShareHost('threads.com'), 'threads');
  assert.equal(classifyShareHost('twitter.com'), 'x');
  assert.equal(classifyShareHost('youtu.be'), 'youtube');
  assert.equal(classifyShareHost('youtube-nocookie.com'), 'other');
  for (const raw of [
    'http://example.com/a', 'https://user:pass@example.com/a', 'https://127.0.0.1/a', 'https://[::1]/',
    'https://localhost/a', 'https://app.localhost/a', 'https://intranet/a', 'https://printer.local/a',
    'https://svc.internal/a', 'https://nas.lan/a', 'https://example.com:8443/a', 'https://192.168.0.1/a',
    'https://example.com/\n', 'not a url',
  ]) assert.equal(normalizeShareUrl(raw).ok, false, raw);
});

test('youtube ids come from watch, short, live, embed and youtu.be', () => {
  const id = 'e2eDemo0001';
  for (const raw of [
    `https://www.youtube.com/watch?v=${id}&t=3`,
    `https://youtu.be/${id}?si=drop`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
  ]) assert.equal(youtubeVideoId(raw), id, raw);
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(youtubeVideoId('https://example.com/watch?v=e2eDemo0001'), null);
});

test('preview title prefers og:title and resolves a relative og:image', () => {
  const page = '<title>  備用  </title><meta property="og:title" content="  正式標題  "><meta property="og:image" content="/images/a.png">';
  assert.equal(previewTitle(page), '正式標題');
  assert.equal(previewTitle('<title>只有標題</title>'), '只有標題');
  assert.equal(previewTitle('<html></html>'), null);
  assert.equal(previewImageUrl(page, 'https://cdn.example/posts/1'), 'https://cdn.example/images/a.png');
  assert.equal(previewImageUrl('<meta name="twitter:image" content="https://127.0.0.1/x.png">', 'https://cdn.example/p'), null);
});

test('youtube and open-graph previews normalize a thumbnail', async () => {
  const seen: string[] = [];
  const fetcher: PreviewFetch = async input => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith('https://www.youtube.com/oembed')) return new Response(JSON.stringify({ title: '影片標題' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://i.ytimg.com/vi/e2eDemo0001/')) return imageResponse(PNG, 'image/png');
    if (url === 'https://cdn.example/posts/1') return htmlResponse('<meta property="og:title" content="相對圖"><meta property="og:image" content="/images/a.png">');
    if (url === 'https://cdn.example/images/a.png') return imageResponse(PNG);
    return new Response('missing', { status: 404 });
  };
  const video = await previewLink('https://www.youtube.com/watch?v=e2eDemo0001', fetcher, 2000);
  assert.equal(video.title, '影片標題');
  assert.equal(video.source, 'youtube');
  assert.ok(video.image && video.image.length > 16);
  assert.ok(seen.some(url => url === 'https://i.ytimg.com/vi/e2eDemo0001/hqdefault.jpg'));
  const page = await previewLink('https://cdn.example/posts/1', fetcher, 2000);
  assert.equal(page.title, '相對圖');
  assert.equal(page.source, 'page');
  assert.ok(page.image);
});

test('a redirect onto a rejected host is not followed', async () => {
  const fetcher: PreviewFetch = async input => {
    const url = String(input);
    if (url === 'https://example.com/start') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } });
    throw new Error('followed ' + url);
  };
  assert.deepEqual(await previewLink('https://example.com/start', fetcher, 2000), { title: null, image: null, source: null });
});

test('too many redirects, oversized bodies and non-images leave the title without a thumbnail', async () => {
  const fetcher: PreviewFetch = async input => {
    const url = String(input);
    if (url === 'https://example.com/hops') return new Response(null, { status: 302, headers: { location: 'https://example.com/hop-1' } });
    if (url.startsWith('https://example.com/hop-')) {
      const n = Number(url.slice(url.lastIndexOf('-') + 1));
      if (n >= 4) return htmlResponse('<title>too many</title>');
      return new Response(null, { status: 302, headers: { location: `https://example.com/hop-${n + 1}` } });
    }
    if (url === 'https://example.com/huge-html') return htmlResponse('<title>big</title>', 200, { 'content-length': String(2 * 1024 * 1024) });
    if (url === 'https://example.com/text-image') return htmlResponse('<meta property="og:title" content="有標題"><meta property="og:image" content="https://cdn.example/note.txt">');
    if (url === 'https://cdn.example/note.txt') return imageResponse('hello', 'text/plain');
    if (url === 'https://example.com/huge-image') return htmlResponse('<meta property="og:title" content="大圖"><meta property="og:image" content="https://cdn.example/big.png">');
    if (url === 'https://cdn.example/big.png') return imageResponse(PNG, 'image/png', 200, { 'content-length': String(6 * 1024 * 1024) });
    return new Response('missing', { status: 404 });
  };
  assert.equal((await previewLink('https://example.com/hops', fetcher, 2000)).title, null);
  assert.equal((await previewLink('https://example.com/huge-html', fetcher, 2000)).title, null);
  const text = await previewLink('https://example.com/text-image', fetcher, 2000);
  assert.equal(text.title, '有標題');
  assert.equal(text.image, null);
  const huge = await previewLink('https://example.com/huge-image', fetcher, 2000);
  assert.equal(huge.title, '大圖');
  assert.equal(huge.image, null);
});

test('a hung fetch stops at the deadline', async () => {
  const fetcher: PreviewFetch = (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const started = Date.now();
  assert.deepEqual(await previewLink('https://example.com/slow', fetcher, 40), { title: null, image: null, source: null });
  assert.ok(Date.now() - started < 2000);
});

test('a processor failure keeps the title and drops the thumbnail', async () => {
  const fetcher: PreviewFetch = async input => {
    const url = String(input);
    if (url === 'https://example.com/bad') return htmlResponse('<meta property="og:title" content="壞圖"><meta property="og:image" content="https://cdn.example/bad.png">');
    if (url === 'https://cdn.example/bad.png') return imageResponse(Buffer.from('not-a-png'), 'image/png');
    return new Response('missing', { status: 404 });
  };
  const result = await previewLink('https://example.com/bad', fetcher, 2000);
  assert.equal(result.title, '壞圖');
  assert.equal(result.image, null);
  assert.equal(result.source, null);
});
