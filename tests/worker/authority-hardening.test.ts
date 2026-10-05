import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Wrapper exists only inside this test bundle. It exposes arbitrary caller
// headers to the actual DO to prove the installed environment is authoritative.
const source = `import {AuthorityGeneration} from './apps/private-ai-authority/src/durable-generation.ts';
import {authorityObjectName} from './apps/private-ai-authority/src/profile.ts';
export {AuthorityGeneration};
export default {async fetch(req,env){let p=JSON.parse(env.FREEDOM_AUTHORITY_PROFILE);return env.AUTHORITY_GENERATION.get(env.AUTHORITY_GENERATION.idFromName(authorityObjectName(p))).fetch('https://freedom-private-ai-authority.internal/current',{headers:{'x-fp-authority-profile':req.headers.get('x-test-profile')||JSON.stringify(p)}})}};`;
const profile = (version: string, digest: string) => ({ purpose: 'capture-readiness', environment: 'staging-next', authority: 'synthetic-authority', keyId: 'synthetic-key', setupOrigin: 'https://setup.example.test', capturePolicyVersion: version, capturePolicySha256: digest.repeat(64) });

test('native SQLite DO persists policy revision across process restart and rejects rollback, equivocation and forged caller profiles', async () => {
  await mkdir(resolve('.wrangler'), { recursive: true });
  const directory = await mkdtemp(resolve('.wrangler/authority-hardening-'));
  let mf: Miniflare | undefined;
  try {
    const bundle = join(directory, 'worker.mjs');
    await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'authority-hardening-fixture.ts' }, outfile: bundle, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'] });
    async function boot(p: object, enabled = 'true') {
      await mf?.dispose();
      mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'persist'), workers: [{ name: 'authority-hardening', modules: true, scriptPath: bundle, compatibilityDate: '2026-09-21',
        bindings: { FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED: enabled, FREEDOM_AUTHORITY_PURPOSE: 'capture-readiness', FREEDOM_AUTHORITY_ENVIRONMENT: 'staging-next', FREEDOM_AUTHORITY_PROFILE: JSON.stringify(p) },
        durableObjects: { AUTHORITY_GENERATION: { className: 'AuthorityGeneration', useSQLite: true } } }] }));
      await mf.ready;
    }
    const call = (p?: object) => mf!.dispatchFetch('https://fixture.test/', { headers: p ? { 'x-test-profile': JSON.stringify(p) } : {} });
    await boot(profile('1', 'a'));
    assert.equal((await call(profile('999', 'f'))).status, 503, 'forged header cannot initialize storage');
    assert.equal((await call({ ...profile('1', 'a'), environment: 'next' })).status, 503, 'caller cannot select another environment');
    assert.equal((await call({ ...profile('1', 'a'), authority: 'foreign-authority' })).status, 503, 'caller cannot select another authority');
    assert.equal((await call()).status, 200);
    await boot(profile('2', 'b')); assert.equal((await call()).status, 200);
    await boot(profile('1', 'a')); assert.equal((await call()).status, 503, 'old release cannot overwrite revision2 after restart');
    await boot(profile('2', 'a')); assert.equal((await call()).status, 503, 'same revision cannot change digest');
    await boot({ ...profile('2', 'b'), setupOrigin: 'https://other.example.test' }); assert.equal((await call()).status, 503, 'same revision cannot change origin');
    await boot(profile('2', 'b')); assert.equal((await call(profile('3', 'c'))).status, 503, 'caller cannot advance installed version');
    assert.equal((await call()).status, 200, 'denied attempts leave accepted storage intact');
    await boot(profile('2', 'b'), 'false'); assert.equal((await call()).status, 503, 'direct DO access respects disabled installation');
    await boot(profile('3', 'c')); assert.equal((await call()).status, 200, 'reviewed higher policy revision remains possible');
  } finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('native recovery state and floor retain independent monotonic namespaces across restart', async () => {
  await mkdir(resolve('.wrangler'), { recursive: true });
  const directory = await mkdtemp(resolve('.wrangler/authority-generations-'));
  let mf: Miniflare | undefined;
  try {
    const bundle = join(directory, 'worker.mjs');
    await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'authority-generation-fixture.ts' }, outfile: bundle, bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'] });
    const profiles = (state: string, floor: string) => [
      { purpose: 'recovery-state', environment: 'staging-next', authority: 'synthetic-state', keyId: 'synthetic-state-key', generation: state },
      { purpose: 'recovery-floor', environment: 'staging-next', authority: 'synthetic-floor', generation: floor },
    ];
    async function boot(state: string, floor: string) {
      await mf?.dispose();
      mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'persist'), workers: profiles(state, floor).map(p => ({ name: p.purpose, modules: true, scriptPath: bundle, compatibilityDate: '2026-09-21',
        bindings: { FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED: 'true', FREEDOM_AUTHORITY_PURPOSE: p.purpose, FREEDOM_AUTHORITY_ENVIRONMENT: p.environment, FREEDOM_AUTHORITY_PROFILE: JSON.stringify(p) },
        durableObjects: { AUTHORITY_GENERATION: { className: 'AuthorityGeneration', useSQLite: true } } })) }));
      await mf.ready;
    }
    const call = async (purpose: string, forged?: object) => (await mf!.getWorker(purpose)).fetch('https://fixture.test/', { headers: forged ? { 'x-test-profile': JSON.stringify(forged) } : {} });
    await boot('1', '1');
    for (const name of ['recovery-state', 'recovery-floor']) assert.deepEqual(await (await call(name)).json(), { kind: 'generation', value: '1' });
    await boot('3', '2');
    assert.deepEqual(await (await call('recovery-state')).json(), { kind: 'generation', value: '3' });
    assert.deepEqual(await (await call('recovery-floor')).json(), { kind: 'generation', value: '2' });
    await boot('2', '2');
    assert.equal((await call('recovery-state')).status, 503, 'state rollback rejected after full restart');
    assert.equal((await call('recovery-floor')).status, 200, 'independent floor remains on2');
    await boot('3', '1');
    assert.equal((await call('recovery-state')).status, 200, 'denied state rollback did not change high water');
    assert.equal((await call('recovery-floor')).status, 503, 'floor rollback independently rejected');
    await boot('3', '2');
    assert.equal((await call('recovery-state', profiles('3', '2')[1])).status, 503, 'floor profile cannot advance or read state namespace');
    for (const name of ['recovery-state', 'recovery-floor']) assert.equal((await call(name)).status, 200);
  } finally { await mf?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
