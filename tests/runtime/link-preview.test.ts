import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { previewImageUrl, previewLink, previewTitle, type PreviewFetch } from '../../modules/community/link-preview.js';
import { normalizeRemoteThumbnail } from '../../modules/skill-submissions/payload.js';
import { runWithImageProcessor, type ImageProcessor } from '../../packages/shared/image-runtime.js';
import { classifyShareHost, isOwnWorkshopHost, normalizeShareUrl, youtubeVideoId } from '../../packages/shared/share-url.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}
function imageResponse(body: Buffer | string, type = 'image/png', status = 200, extra: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': type, ...extra } });
}

test('own-site hosts are refused and other hosts are not', () => {
  assert.equal(isOwnWorkshopHost('freetwai.com', 'https://example.com'), true);
  assert.equal(isOwnWorkshopHost('www.freetwai.com', 'https://example.com'), true);
  assert.equal(isOwnWorkshopHost('share.freetwai.com', 'https://example.com'), true);
  assert.equal(isOwnWorkshopHost('preview.example', 'https://preview.example'), true);
  assert.equal(isOwnWorkshopHost('notfreetwai.com', 'https://freetwai.com'), false);
  assert.equal(isOwnWorkshopHost('youtube.com', 'https://freetwai.com'), false);
});

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

function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

test('remote thumbnails sniff the bytes and drop animation or gif', async () => {
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: 'red' } }).png().toBuffer();
  const apng = Buffer.concat([png.subarray(0, 33), pngChunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])), png.subarray(33)]);
  const animatedWebp = await sharp(await Promise.all(['red', 'blue'].map(background => sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer())), { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const pages: Record<string, { body: Buffer; type: string }> = {
    'https://cdn.example/labeled-jpeg': { body: png, type: 'image/jpeg' },
    'https://cdn.example/apng': { body: apng, type: 'image/png' },
    'https://cdn.example/awebp': { body: animatedWebp, type: 'image/webp' },
    'https://cdn.example/gif': { body: gif, type: 'image/gif' },
  };
  const fetcher: PreviewFetch = async input => {
    const url = String(input);
    const image = pages[url];
    if (image) return imageResponse(image.body, image.type);
    const name = url.split('/').pop();
    return htmlResponse(`<meta property="og:title" content="${name}"><meta property="og:image" content="https://cdn.example/${name}">`);
  };
  const labeled = await previewLink('https://example.com/labeled-jpeg', fetcher, 2000);
  assert.equal(labeled.title, 'labeled-jpeg');
  assert.ok(labeled.image && labeled.image.length > 16);
  assert.equal(labeled.image.subarray(0, 4).toString('ascii'), 'RIFF');
  const canonical = labeled.image;
  const passer: ImageProcessor = { name: 'pass', normalize: async () => canonical };
  await runWithImageProcessor(passer, async () => {
    for (const name of ['apng', 'awebp', 'gif']) {
      const result = await previewLink(`https://example.com/${name}`, fetcher, 2000);
      assert.equal(result.title, name);
      assert.equal(result.image, null);
      assert.equal(result.source, null);
    }
  });
  const bulky = await sharp({ create: { width: 1200, height: 800, channels: 3, background: 'navy' } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(bulky.length > 512 * 1024 && bulky.length <= 5 * 1024 * 1024, `png was ${bulky.length}`);
  const wide = await normalizeRemoteThumbnail(bulky);
  assert.ok(wide.length > 16 && wide.length <= 512 * 1024);
  await assert.rejects(normalizeRemoteThumbnail(Buffer.alloc(5 * 1024 * 1024 + 1)));
});
