import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, PortalClient } from '../../apps/portal-web/src/api.js';
import { uploadMemberAvatar } from '../../apps/portal-web/src/modules/avatar-client.js';
import { uploadEventBanner, uploadEventVideo } from '../../apps/portal-web/src/modules/event-banner-client.js';
import { uploadHighlightImage } from '../../apps/portal-web/src/modules/highlight-media.js';
import type { CommunityEvent } from '../../apps/portal-web/src/modules/EventsPanel.js';

const file = new File([new Uint8Array([1, 2, 3])], 'synthetic.png', { type: 'image/png' });
const event = { event_id: 'synthetic-event', aggregate_version: 3 } as CommunityEvent;
const uploads: [string, (client: PortalClient) => Promise<unknown>][] = [
  ['avatar', client => uploadMemberAvatar(client, file, 3, 'synthetic-key')],
  ['banner', client => uploadEventBanner(client, event, file)],
  ['video', client => uploadEventVideo(client, event, file)],
  ['highlight', client => uploadHighlightImage(client, event.event_id, 'photo', file, 'landscape', '', 'synthetic-key')],
];

for (const [name, upload] of uploads) {
  for (const accessExpired of [false, true]) {
    test(`${name}: a delayed ${accessExpired ? 'Access denial' : '401'} never signs out a new member`, async t => {
      let respond!: (response: Response) => void;
      let started!: () => void;
      const requested = new Promise<void>(resolve => { started = resolve; });
      const fetcher = t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), 'old-session');
        return new Promise<Response>(resolve => { respond = resolve; started(); });
      });
      const client = new PortalClient(); client.csrfToken = 'old-session';
      let expired = 0; client.onUnauthorized = () => { expired++; };
      const pending = upload(client);
      await requested;
      client.csrfToken = 'new-session';
      respond(accessExpired
        ? new Response('<html>Expired Access</html>', { status: 403 })
        : Response.json({ detail: 'Expired session' }, { status: 401 }));
      await assert.rejects(pending, ApiError);
      assert.equal(client.csrfToken, 'new-session');
      assert.equal(client.accessExpired, false);
      assert.equal(expired, 0);
      assert.equal(fetcher.mock.callCount(), 1, 'uploads are never replayed automatically');
    });
  }

  test(`${name}: a current session 401 still clears authentication`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Expired session' }, { status: 401 }));
    const client = new PortalClient(); client.csrfToken = 'current-session';
    let expired = 0; client.onUnauthorized = () => { expired++; };
    await assert.rejects(upload(client), ApiError);
    assert.equal(client.csrfToken, null);
    assert.equal(expired, 1);
  });
}

test('banner decoding cannot transfer an upload to the member who signed in while it was pending', async t => {
  let decoded!: (bitmap: ImageBitmap) => void;
  let closed = false;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: () => new Promise<ImageBitmap>(resolve => { decoded = resolve; }) });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'createImageBitmap', previous);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  });
  const fetcher = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const client = new PortalClient(); client.csrfToken = 'old-session';
  const pending = uploadEventBanner(client, event, file);
  client.csrfToken = 'new-session';
  decoded({ width: 100, height: 200, close: () => { closed = true; } } as ImageBitmap);
  await assert.rejects(pending, (cause: unknown) => cause instanceof ApiError && cause.status === 409);
  assert.equal(closed, true);
  assert.equal(fetcher.mock.callCount(), 0);
});
