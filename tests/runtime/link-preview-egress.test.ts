import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LookupAddress } from 'node:dns';
import { createNodePreviewFetch, isPublicPreviewAddress } from '../../apps/platform-api/src/node-preview-fetch.js';
import { previewLink } from '../../modules/community/link-preview.js';

const empty = { title: null, image: null, source: null };

test('preview IP policy excludes non-global IPv4/IPv6, including mapped and transition addresses', () => {
  for (const address of [
    '0.1.2.3', '10.0.0.1', '100.64.0.0', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.0', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '64:ff9b::a00:1', '2001::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1', 'not-an-ip',
  ]) assert.equal(isPublicPreviewAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicPreviewAddress(address), true, address);
  }
});

test('public-looking names with private, mixed, empty or inconsistent DNS answers cannot publish a preview', async () => {
  const answers: LookupAddress[][] = [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: 'fc00::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [], [{ address: '1.1.1.1', family: 6 }],
  ];
  for (const addresses of answers) {
    const transport = createNodePreviewFetch(async () => addresses);
    await assert.rejects(transport('https://public-looking.test/'), /preview_destination_rejected/);
    assert.deepEqual(await previewLink('https://public-looking.test/', transport), empty);
  }
});

test('redirects to private DNS and private thumbnail hosts never expose their metadata', async () => {
  const privateTransport = createNodePreviewFetch(async () => [{ address: '10.0.0.1', family: 4 }]);
  assert.deepEqual(await previewLink('https://public.test/redirect', (input, init) => input === 'https://public.test/redirect'
    ? Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://private-looking.test/' } }))
    : privateTransport(input, init)), empty);
  const image = await previewLink('https://public.test/image', (input, init) => input === 'https://public.test/image'
    ? Promise.resolve(new Response('<title>Safe page</title><meta property="og:image" content="https://private-looking.test/secret.png">', { headers: { 'Content-Type': 'text/html' } }))
    : privateTransport(input, init));
  assert.deepEqual(image, { title: 'Safe page', image: null, source: null });
});

test('aborting while DNS is pending rejects promptly rather than waiting for resolution', async () => {
  let release!: (addresses: LookupAddress[]) => void;
  const pending = new Promise<LookupAddress[]>(resolve => { release = resolve; });
  const abort = new AbortController();
  const request = createNodePreviewFetch(() => pending)('https://public-looking.test/', { signal: abort.signal });
  abort.abort();
  try { await assert.rejects(request, /preview_aborted/); }
  finally { release([{ address: '127.0.0.1', family: 4 }]); }
});

test('preview deadline remains active after response headers while body is stalled', { timeout: 2000 }, async () => {
  const result = await previewLink('https://public.test/stalled', async (_input, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); },
  }), { headers: { 'Content-Type': 'text/html' } }), 40);
  assert.deepEqual(result, empty);
});
