import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTenantListCursorCodec, type TenantListCursorBinding } from '../../packages/shared/tenant-list-cursor.js';
import { Problem } from '../../packages/shared/problem.js';
import { nodeRuntime } from '../../apps/platform-api/src/app.js';
import { workerRuntime, type WorkerEnv } from '../../apps/platform-api/src/worker.js';
import { TENANT_CURSOR_TEST_KEY } from './tenant-cursor-fixture.js';

const host = { environment: 'local', origin: 'http://127.0.0.1:4310' };
const binding: TenantListCursorBinding = { purpose: 'work', tenantId: 'tenant-a', principalId: 'principal-a',
  scopeId: 'scope-a', resourceId: 'workspace-a', filter: '草稿' };
const position = { at: '2026-10-08T12:01:02.123456Z', id: '11111111-1111-4111-8111-111111111111' };
const codec = createTenantListCursorCodec(TENANT_CURSOR_TEST_KEY, host);
const rejects = (fn: () => unknown, status = 422, code = 'invalid_cursor') =>
  assert.throws(fn, error => error instanceof Problem && error.status === status && error.code === code);

test('signed cursor preserves exact keyset values, is bounded, and permits only the bound context', () => {
  const token = codec.encode(position, binding);
  assert.ok(token.length <= 512);
  assert.deepEqual(codec.decode(token, binding), position);
  assert.equal(codec.decode(undefined, binding), null);
  for (const change of [
    { purpose: 'results' as const }, { purpose: 'instances' as const }, { purpose: 'installations' as const },
    { tenantId: 'tenant-b' }, { principalId: 'principal-b' }, { scopeId: 'scope-b' },
    { resourceId: 'workspace-b' }, { filter: '另一個篩選' },
  ]) rejects(() => codec.decode(token, { ...binding, ...change }));
});

test('editing keyset or binding, replacing the signature, legacy JSON and noncanonical tokens fail closed', () => {
  const token = codec.encode(position, binding);
  const [body, signature] = token.split('.');
  const envelope = JSON.parse(Buffer.from(body, 'base64url').toString());
  for (const changed of [
    { ...envelope, p: { ...position, at: '2000-01-01T00:00:00.000000Z' } },
    { ...envelope, b: 'forged-context' },
  ]) rejects(() => codec.decode(`${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`, binding));
  for (const malformed of ['', 'abc', body, `${body}.AA`, `${body}.${'A'.repeat(43)}`, `${body}.${signature}=`,
    `${body}.${signature}.extra`, `${body}=.${signature}`, 'A'.repeat(513), Buffer.from(JSON.stringify(position)).toString('base64url')]) {
    rejects(() => codec.decode(malformed, binding));
  }
});

test('even an authentic envelope must use the exact versioned shape', () => {
  const envelope = JSON.parse(Buffer.from(codec.encode(position, binding).split('.')[0], 'base64url').toString());
  for (const value of [null, [], { ...envelope, v: 2 }, { ...envelope, extra: true }, { ...envelope, p: [] }, { ...envelope, p: null }]) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(TENANT_CURSOR_TEST_KEY, 'base64url'))
      .update(JSON.stringify(['freedom.tenant-list-cursor/v1', host.environment, host.origin])).update('\0').update(body).digest('base64url');
    rejects(() => codec.decode(`${body}.${signature}`, binding));
  }
});

test('environment, configured origin, and key rotation separate otherwise identical continuations', () => {
  const token = codec.encode(position, binding);
  for (const other of [
    createTenantListCursorCodec(TENANT_CURSOR_TEST_KEY, { ...host, environment: 'staging' }),
    createTenantListCursorCodec(TENANT_CURSOR_TEST_KEY, { ...host, origin: 'https://cursor.example.test' }),
    createTenantListCursorCodec(Buffer.alloc(32, 0x55).toString('base64url'), host),
  ]) rejects(() => other.decode(token, binding));
});

test('absent, malformed, short and padded keys disable even page one without revealing configuration', () => {
  for (const key of [undefined, '', 'test', 'A'.repeat(42), 'A'.repeat(44), TENANT_CURSOR_TEST_KEY + '=', 'B'.repeat(43)]) {
    const closed = createTenantListCursorCodec(key, host);
    rejects(() => closed.decode(undefined, binding), 503, 'tenant_cursor_unavailable');
    rejects(() => closed.decode('malformed', binding), 503, 'tenant_cursor_unavailable');
    rejects(() => closed.encode(position, binding), 503, 'tenant_cursor_unavailable');
  }
});

test('Node and Worker inject the same purpose key and host binding, and missing Worker key never borrows Node configuration', () => {
  const node = nodeRuntime('local', host.origin, { tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY });
  const env = { FREEDOM_TENANT_CURSOR_SIGNING_KEY: TENANT_CURSOR_TEST_KEY } as WorkerEnv;
  const config = { freedomEnv: 'local' as const, origin: host.origin, release: null, trustConnectingIp: false };
  const worker = workerRuntime(env, config);
  const token = node.tenantListCursors!.encode(position, binding);
  assert.deepEqual(worker.tenantListCursors!.decode(token, binding), position);
  rejects(() => workerRuntime({} as WorkerEnv, config).tenantListCursors!.decode(token, binding), 503, 'tenant_cursor_unavailable');
  rejects(() => nodeRuntime('local', host.origin, { tenantCursorSigningKey: '' }).tenantListCursors!.decode(token, binding), 503, 'tenant_cursor_unavailable');
});
