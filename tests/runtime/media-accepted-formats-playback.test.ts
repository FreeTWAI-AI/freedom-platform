import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { chromium, type Browser } from '@playwright/test';
import { planObjectHttpRequest } from '../../packages/asset-storage/http-range.js';
import { sha256 } from '../../packages/asset-storage/index.js';
import { loadAcceptedMediaFixtures, mp4TopLevelBoxes } from '../../scripts/media-format-fixtures.js';

// Local playback of the committed H.264 fixture through the same range planner
// the event-video route uses. This is not a live R2 or staging acceptance run.
test('Chromium decodes the portable MP4 fixture, seeks, and receives an exact byte range', { timeout: 60_000 }, async () => {
  const fixtures = await loadAcceptedMediaFixtures();
  assert.equal(fixtures.manifest.liveAcceptance, false);
  assert.equal(fixtures.manifest.evidence, 'local_synthetic_fixture');
  const boxes = mp4TopLevelBoxes(fixtures.video);
  assert.equal(boxes[0]?.type, 'ftyp');
  assert.equal(boxes[0]?.offset, 0);
  assert.deepEqual(boxes.map(box => box.type).filter(type => type === 'moov' || type === 'mdat').sort(), ['mdat', 'moov']);
  const etag = await sha256(fixtures.video);
  const ranges: { header: string | undefined; status: number; length: number }[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><meta charset="utf-8"><title>Local MP4 fixture</title><video id="event-video" controls preload="metadata" aria-label="Synthetic fixture 的活動影片"><source src="/video" type="video/mp4"></video>`);
      return;
    }
    if (request.url !== '/video') {
      response.writeHead(404);
      response.end();
      return;
    }
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
    const plan = planObjectHttpRequest({
      method, byteSize: fixtures.video.length, contentType: 'video/mp4', etag,
      rangeHeader: request.headers.range, ifRangeHeader: request.headers['if-range'],
    });
    const slice = plan.range ?? { offset: 0, length: fixtures.video.length };
    ranges.push({ header: request.headers.range, status: plan.status, length: plan.sendBody ? slice.length : 0 });
    response.writeHead(plan.status, plan.headers);
    if (!plan.sendBody) {
      response.end();
      return;
    }
    response.end(fixtures.video.subarray(slice.offset, slice.offset + slice.length));
  });
  const origin = await listen(server);
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(origin + '/');
    const played = await page.evaluate(async (seekSeconds: number) => {
      const video = document.querySelector('video');
      if (!video) return { error: 'missing_video' };
      video.muted = true;
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 1) resolve();
        else {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error('metadata_error')), { once: true });
        }
      });
      const start = video.currentTime;
      await video.play();
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          if (video.currentTime > start + 0.2) { clearInterval(timer); resolve(); }
        }, 40);
        setTimeout(() => { clearInterval(timer); reject(new Error('play_timeout')); }, 5000);
      });
      video.pause();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('seek_timeout')), 5000);
        video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.currentTime = seekSeconds;
      });
      const partial = await fetch('/video', { headers: { Range: 'bytes=32-63' } });
      const partialBytes = Array.from(new Uint8Array(await partial.arrayBuffer()));
      return {
        width: video.videoWidth, height: video.videoHeight, duration: video.duration, time: video.currentTime,
        rangeStatus: partial.status, rangeType: partial.headers.get('content-type'), rangeHeader: partial.headers.get('content-range'),
        partialBytes,
      };
    }, fixtures.manifest.video.seekSeconds);
    assert.equal('error' in played, false, JSON.stringify(played));
    if (!('width' in played)) throw new Error('playback_result_missing');
    assert.equal(played.width, 160);
    assert.equal(played.height, 90);
    assert.ok(played.duration >= fixtures.manifest.video.seekSeconds);
    assert.ok(Math.abs(played.time - fixtures.manifest.video.seekSeconds) < 0.35, String(played.time));
    assert.equal(played.rangeStatus, 206);
    assert.equal(played.rangeType, 'video/mp4');
    assert.equal(played.rangeHeader, `bytes 32-63/${fixtures.video.length}`);
    assert.deepEqual(Buffer.from(played.partialBytes), fixtures.video.subarray(32, 64));
    assert.ok(ranges.some(range => range.status === 206 && range.length === 32));
    assert.equal(ranges.some(range => range.header === 'bytes=32-63'), true);
  } finally {
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('fixture_port_missing'));
      else resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
