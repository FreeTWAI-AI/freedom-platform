import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
let directory: string, mf: Miniflare;
before(async () => {
  await mkdir(resolve('.wrangler'), { recursive: true });
  directory = await mkdtemp(resolve('.wrangler/openrouter-provider-'));
  await build({ entryPoints: [resolve('tests/worker/broker-fixtures/openrouter-provider-client.ts')], outfile: join(directory, 'client.mjs'), bundle: true, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'] });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'client', modules: true, scriptPath: join(directory, 'client.mjs'), compatibilityDate: '2026-09-21', outboundService: 'synthetic-provider' },
    { name: 'synthetic-provider', modules: true, compatibilityDate: '2026-09-21', script: `let calls=[];export default {async fetch(request){const u=new URL(request.url);if(u.pathname==='/counts')return Response.json(calls);calls.push({host:u.host,path:u.pathname,method:request.method,authorization:request.headers.get('authorization'),anthropic:request.headers.get('x-api-key')});if(u.host!=='openrouter.ai')throw Error('foreign origin');if(u.pathname.endsWith('/redirect'))return new Response('',{status:302,headers:{Location:'https://foreign.test/'}});if(u.pathname.endsWith('/oversized'))return new Response('x'.repeat(32769),{headers:{'content-type':'application/json'}});if(request.method==='POST'){const b=await request.json();if(b.model!=='openai/synthetic'||b.max_completion_tokens!==8||b.tools.length||b.provider.allow_fallbacks!==false)throw Error('bad request');}return Response.json({synthetic:true});}};` },
  ] })); await mf.ready;
});
after(async () => { await mf?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });
const call = (url: string, method = 'GET') => mf.getWorker('client').then(worker => worker.fetch('https://fixture.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, method }) }));
const counts = async () => (await (await mf.getWorker('synthetic-provider')).fetch('https://openrouter.ai/counts')).json() as Promise<any[]>;
test('native workerd sends only fixed OpenRouter requests and preserves isolated Bearer credentials', async () => {
  for (const path of ['/api/v1/key', '/api/v1/model/openai/synthetic']) assert.equal((await call('https://openrouter.ai' + path)).status, 200);
  assert.equal((await call('https://openrouter.ai/api/v1/chat/completions', 'POST')).status, 200);
  const rows = await counts(); assert.equal(rows.length, 3);
  for (const row of rows) { assert.equal(row.host, 'openrouter.ai'); assert.equal(row.authorization, 'Bearer SYNTHETIC_OPENROUTER_WORKER_ONLY'); assert.equal(row.anthropic, null); }
});
test('native workerd rejects wrong origins before socket, follows no redirects and bounds approved-path responses', async () => {
  const before = (await counts()).length;
  for (const url of ['https://api.anthropic.com/api/v1/chat/completions', 'https://openrouter.ai.evil.test/api/v1/key', 'https://openrouter.ai/api/v1/key?secret=x', 'http://openrouter.ai/api/v1/key']) assert.deepEqual(await (await call(url)).json(), { code: 'invalid_input' });
  assert.equal((await counts()).length, before);
  assert.deepEqual(await (await call('https://openrouter.ai/api/v1/model/openai/redirect')).json(), { code: 'outcome_unknown' });
  assert.deepEqual(await (await call('https://openrouter.ai/api/v1/model/openai/oversized')).json(), { code: 'response_limit' });
  assert.equal((await counts()).length, before + 2);
});
