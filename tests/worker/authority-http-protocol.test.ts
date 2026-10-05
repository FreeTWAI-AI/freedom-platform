import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createSignedRecoverySource } from '../../apps/credential-broker/src/recovery.js';
import { createSignedCaptureReadiness } from '../../apps/credential-broker/src/worker-readiness.js';
import { AuthorityProfileSchema, AUTHORITY_ORIGIN, AUTHORITY_PATHS } from '../../apps/private-ai-authority/src/profile.js';

const key = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
const stateKey = key(), readinessKey = key(), unrelatedKey = key();
const state = { purpose: 'recovery-state', environment: 'staging-next', authority: 'synthetic-state', keyId: 'synthetic-state-key', generation: '7' } as const;
const floor = { purpose: 'recovery-floor', environment: 'staging-next', authority: 'synthetic-floor', generation: '7' } as const;
const readiness = { purpose: 'capture-readiness', environment: 'staging-next', authority: 'synthetic-readiness', keyId: 'synthetic-readiness-key', setupOrigin: 'https://setup.example.test', capturePolicySha256: 'a'.repeat(64), capturePolicyVersion: '1' } as const;
const uri = (purpose: keyof typeof AUTHORITY_PATHS) => AUTHORITY_ORIGIN + AUTHORITY_PATHS[purpose];
let directory: string, mf: Miniflare;
before(async () => {
  await mkdir(resolve('.wrangler'), { recursive: true }); directory = await mkdtemp(resolve('.wrangler/authority-http-'));
  const bundle = join(directory, 'authority.mjs');
  await build({ entryPoints: [resolve('apps/private-ai-authority/src/worker.ts')], outfile: bundle, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'] });
  const framing = join(directory, 'framing.mjs');
  await build({ stdin: { contents: `import handler,{AuthorityGeneration} from './apps/private-ai-authority/src/worker.ts';export {AuthorityGeneration};export default {fetch(_req,env){return handler.fetch(new Request('https://freedom-private-ai.internal/internal/credential-recovery/state',{method:'GET',headers:{'content-length':'2'}}),env)}};`, resolveDir: process.cwd(), sourcefile: 'framing-fixture.ts' }, outfile: framing, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'] });
  function worker(name: string, profile: typeof state | typeof floor | typeof readiness, signingKey?: object, overrides: Record<string, string> = {}) {
    return { name, modules: true, scriptPath: bundle, compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
      bindings: { FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED: 'true', FREEDOM_AUTHORITY_PURPOSE: profile.purpose, FREEDOM_AUTHORITY_ENVIRONMENT: profile.environment,
        FREEDOM_AUTHORITY_PROFILE: JSON.stringify(profile), ...(signingKey ? { FREEDOM_AUTHORITY_SIGNING_KEY: JSON.stringify(signingKey) } : {}), ...overrides },
      durableObjects: { AUTHORITY_GENERATION: { className: 'AuthorityGeneration', useSQLite: true } } };
  }
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [worker('state', state, stateKey), worker('floor', floor), worker('readiness', readiness, readinessKey),
    worker('off', state, stateKey, { FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED: 'false' }),
    worker('wrong-env', state, stateKey, { FREEDOM_AUTHORITY_ENVIRONMENT: 'next' }),
    worker('wrong-purpose', state, stateKey, { FREEDOM_AUTHORITY_PURPOSE: 'capture-readiness' }),
    worker('extra-profile', state, stateKey, { FREEDOM_AUTHORITY_PROFILE: JSON.stringify({ ...state, extra: true }) }),
    worker('extra-key', state, { ...stateKey, extra: true }),
    worker('mismatched-key', state, { ...stateKey, x: unrelatedKey.x }),
    worker('floor-with-secret', floor, stateKey), worker('missing-key', state),
    { ...worker('framing', state, stateKey), scriptPath: framing },
    worker('missing-policy-version', readiness, readinessKey, { FREEDOM_AUTHORITY_PROFILE: JSON.stringify({ ...readiness, capturePolicyVersion: undefined }) }),
  ] })); await mf.ready;
});
after(async () => { await mf?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });
const call = async (worker: string, url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => (await mf.getWorker(worker)).fetch(url, init);
const publicKey = (jwk: typeof stateKey) => crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);

test('production HTTP authority state and readiness pass genuine broker verifiers with exact closed response bodies', async () => {
  const recovery = createSignedRecoverySource({ authority: state.authority, environment: state.environment,
    pinnedKeys: [{ keyId: state.keyId, key: await publicKey(stateKey) }],
    readSignedState: async () => { const r = await call('state', uri('recovery-state')); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'private, no-store'); const body = await r.json() as any; assert.deepEqual(Object.keys(body), ['signedState']); return body.signedState; },
    readMonotonicFloor: async () => { const r = await call('floor', uri('recovery-floor')); assert.equal(r.status, 200); const body = await r.json() as any; assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'generation']); return body; },
  });
  assert.equal((await recovery.recover()).generation, '7');
  const readSignedReadiness = async () => { const r = await call('readiness', uri('capture-readiness')); assert.equal(r.status, 200); const body = await r.json() as any; assert.deepEqual(Object.keys(body), ['signedReadiness']); return body.signedReadiness; };
  const pins = new Map([[readiness.keyId, await publicKey(readinessKey)]]);
  await createSignedCaptureReadiness({ environment: readiness.environment, authority: readiness.authority, origin: readiness.setupOrigin, pinnedKeys: pins, readSignedReadiness })({ origin: readiness.setupOrigin, purpose: 'credential-ingest' });
  await assert.rejects(createSignedCaptureReadiness({ environment: 'next', authority: readiness.authority, origin: readiness.setupOrigin, pinnedKeys: pins, readSignedReadiness })({ origin: readiness.setupOrigin, purpose: 'credential-ingest' }));
  await assert.rejects(createSignedRecoverySource({ authority: state.authority, environment: 'next',
    pinnedKeys: [{ keyId: state.keyId, key: await publicKey(stateKey) }],
    readSignedState: async () => { const body = await (await call('state', uri('recovery-state'))).json() as any; return body.signedState; },
    readMonotonicFloor: async () => await (await call('floor', uri('recovery-floor'))).json() as any,
  }).recover());
});

test('production HTTP boundary rejects other paths, origins, methods, query and declared request body', async () => {
  for (const [url, init, expected] of [
    [uri('capture-readiness'), undefined, 404], [uri('recovery-state') + '/extra', undefined, 404],
    [uri('recovery-state') + '?extra=true', undefined, 400], ['https://foreign.example.test' + AUTHORITY_PATHS['recovery-state'], undefined, 400],
    [uri('recovery-state'), { method: 'POST', body: '{}' }, 405], [uri('recovery-state'), { method: 'PUT', body: '{}' }, 405],
  ] as const) { const r = await call('state', url, init); assert.equal(r.status, expected); const body = await r.json() as any; assert.deepEqual(Object.keys(body), ['code']); }
  // Service-binding fetch normalizes framing headers; construct the declared-body
  // native Request inside workerd, then pass it to the unchanged production handler.
  const framed = await call('framing', uri('recovery-state')); assert.equal(framed.status, 400);
  assert.deepEqual(await framed.json(), { code: 'private_ai_authority_request_rejected' });
});

test('production HTTP fails closed for OFF, wrong profile environment/purpose, extra JSON and mismatched signing identities', async () => {
  for (const name of ['off', 'wrong-env', 'wrong-purpose', 'extra-profile', 'extra-key', 'mismatched-key', 'missing-key']) {
    const r = await call(name, uri('recovery-state')); assert.equal(r.status, 503, name); assert.deepEqual(await r.json(), { code: 'private_ai_authority_unavailable' });
  }
  for (const [name, purpose] of [['floor-with-secret', 'recovery-floor'], ['missing-policy-version', 'capture-readiness']] as const) {
    const r = await call(name, uri(purpose)); assert.equal(r.status, 503, name); assert.deepEqual(await r.json(), { code: 'private_ai_authority_unavailable' });
  }
});

test('offline authority profiles are closed, local forbidden, and all deployment defaults stay OFF with private DO bindings', async () => {
  for (const p of [state, floor, readiness]) { assert(AuthorityProfileSchema.safeParse(p).success); assert(!AuthorityProfileSchema.safeParse({ ...p, environment: 'local' }).success); assert(!AuthorityProfileSchema.safeParse({ ...p, d: 'not-a-private-key' }).success); }
  const raw = await readFile('wrangler.private-ai-authority.example.jsonc', 'utf8');
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.equal(config.vars.FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED, 'false');
  for (const entry of Object.values(config.env) as any[]) { assert.equal(entry.vars.FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED, 'false'); assert.equal(entry.workers_dev, false); assert.equal(entry.preview_urls, false); assert.deepEqual(entry.durable_objects.bindings, [{ name: 'AUTHORITY_GENERATION', class_name: 'AuthorityGeneration' }]); assert.equal(entry.routes, undefined); }
});
