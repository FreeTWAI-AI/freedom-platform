import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { nodeRuntime, createApp } from '../../apps/platform-api/src/app.js';
import { workerRuntime, type WorkerEnv, type WorkerConfig } from '../../apps/platform-api/src/worker.js';

const origin = 'http://127.0.0.1:4310';
test('reservation admission is explicit in both host adapters and independent of existing launchpad installation', () => {
  for (const option of [undefined, false, 'true', 1]) {
    assert.equal(nodeRuntime('local', origin, { guildLaunchpadEnabled: true, hostedReservationsEnabled: option as boolean }).hostedReservationsEnabled, false);
  }
  assert.equal(nodeRuntime('local', origin, { hostedReservationsEnabled: true }).hostedReservationsEnabled, true);
  for (const flag of [undefined, 'false', 'TRUE', '1', ' true', 'true']) {
    const runtime = workerRuntime({ FREEDOM_HOSTED_RESERVATIONS_ENABLED: flag, FREEDOM_GUILD_LAUNCHPAD_ENABLED: 'true' } as WorkerEnv,
      { origin, release: '0'.repeat(40), trustConnectingIp: false } as WorkerConfig);
    assert.equal(runtime.hostedReservationsEnabled, flag === 'true');
    assert.equal(runtime.guildLaunchpadEnabled, true);
  }
});

test('buyer recovery routes require the actual member cookie even with admission and launchpad OFF', async () => {
  let connections = 0;
  const pool = { connect: () => { connections++; throw new Error('unauthenticated request must not open DB'); }, query: () => { connections++; throw new Error('unauthenticated request must not query DB'); } } as unknown as Pool;
  const app = createApp(pool, origin, 'local');
  for (const key of ['fw_read_synthetic', 'fw_shop_synthetic']) {
    const response = await app.request(origin + '/api/v1/me/hosted-orders/00000000-0000-4000-8000-000000000001', { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'Cookie');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  assert.equal(connections, 0);
});
