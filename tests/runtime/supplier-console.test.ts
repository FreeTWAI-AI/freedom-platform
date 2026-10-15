import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { createApp, nodeRuntime } from '../../apps/platform-api/src/app.js';
import { ReadinessError } from '../../apps/platform-api/src/readiness.js';
import { readWorkerConfig, workerRuntime, type WorkerConfig, type WorkerEnv } from '../../apps/platform-api/src/worker.js';

const origin = 'http://127.0.0.1:4310';
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
after(async () => { await pool.end(); });

function env(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return { HYPERDRIVE: { connectionString: 'postgres://synthetic@localhost/synthetic' }, ASSETS: { fetch: async () => new Response('fixture') }, FREEDOM_ENV: 'local', APP_ORIGIN: origin, ...overrides } as WorkerEnv;
}

test('SC-FLAG-01 Node supplier console defaults off and accepts only boolean true', () => {
  for (const option of [undefined, false, 'true', 1, true]) {
    assert.equal(nodeRuntime('local', origin, { supplierConsoleEnabled: option as boolean }).supplierConsoleEnabled, option === true);
  }
});

test('SC-FLAG-02 Worker supplier console accepts only the exact true string', () => {
  for (const flag of [undefined, 'false', 'TRUE', '1', ' true', 'true']) {
    const runtime = workerRuntime({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: flag, FREEDOM_GUILD_LAUNCHPAD_ENABLED: 'true' } as WorkerEnv,
      { origin, release: '0'.repeat(40), trustConnectingIp: false } as WorkerConfig);
    assert.equal(runtime.supplierConsoleEnabled, flag === 'true');
    assert.equal(runtime.guildLaunchpadEnabled, true);
  }
});

test('SC-FLAG-03 Worker readiness rejects supplier console flag typos', () => {
  for (const flag of ['TRUE', '1', ' true']) {
    assert.throws(() => readWorkerConfig(env({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: flag, FREEDOM_GUILD_LAUNCHPAD_ENABLED: 'true' })),
      new ReadinessError('Supplier console flag must be true or false.'));
  }
});

test('SC-FLAG-04 Worker readiness requires launchpad when supplier console is enabled', () => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    assert.throws(() => readWorkerConfig(env({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: 'true', FREEDOM_GUILD_LAUNCHPAD_ENABLED: flag })),
      new ReadinessError('Supplier console requires guild launchpad.'));
  }
});

test('SC-FLAG-05 Worker readiness accepts disabled, absent and complete enabled configurations', () => {
  for (const flag of [undefined, 'false']) {
    assert.doesNotThrow(() => readWorkerConfig(env({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: flag })));
  }
  assert.doesNotThrow(() => readWorkerConfig(env({ FREEDOM_SUPPLIER_CONSOLE_ENABLED: 'true', FREEDOM_GUILD_LAUNCHPAD_ENABLED: 'true' })));
});

test('SC-FLAG-06 site supplier console flag requires both launchpad and console without database reads', async () => {
  for (const guildLaunchpadEnabled of [undefined, false, true]) {
    for (const supplierConsoleEnabled of [undefined, false, true]) {
      const app = createApp(pool, origin, 'local', { guildLaunchpadEnabled, supplierConsoleEnabled });
      const response = await app.request('/api/v1/site');
      assert.equal(response.status, 200);
      assert.equal((await response.json()).supplier_console_enabled, guildLaunchpadEnabled === true && supplierConsoleEnabled === true);
    }
  }
  assert.equal(pool.totalCount, 0);
});
