// Installed launcher, executed ONLY inside the untrusted candidate container.
// Neither its output nor candidate code can decide the host verdict.
import { createInterface } from 'node:readline';
import { request } from 'node:http';

const origin = 'http://127.0.0.1:4310';
async function fixtureFetch(input, options = {}) {
  const url = new URL(String(input));
  if (url.origin !== origin || url.search || url.hash || options.redirect !== 'error') throw Error('fixture_origin_required');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: '/fixture/http.sock', path: url.pathname,
      method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)),
      signal: options.signal, timeout: 2000 }, response => {
      const chunks = []; let count = 0;
      response.on('data', bytes => { if ((count += bytes.length) > 65536) req.destroy(Error('fixture_response_limit')); else chunks.push(bytes); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers,
      })));
    });
    req.on('timeout', () => req.destroy(Error('fixture_timeout')));
    req.on('error', reject); req.end(options.body);
  });
}

const cli = process.argv[2] === 'kit-cli';
const entries = cli ? null : await import('/candidate/src/index.mjs');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line), input = JSON.parse(Buffer.from(frame.body, 'base64'));
  let status = 200, result;
  try {
    if (cli) {
      if (input.repository !== 'FreeTWAI-AI/freedom-agent-kit') throw Error('unsupported_consumer');
      // This process remains untrusted. Host HTTP traces, not this captured output,
      // decide the verdict. The real CLI receives only fixed synthetic argv.
      const logs = []; let bytes = 0;
      const originalLog = console.log;
      console.log = (...args) => {
        const value = args.map(String).join(' '); bytes += Buffer.byteLength(value);
        if (bytes > 65536 || logs.length) throw Error('cli_output_limit'); logs.push(value);
      };
      globalThis.fetch = fixtureFetch;
      process.argv = [process.execPath, '/candidate/src/cli.mjs', origin + '/api/v1', 'maker'];
      try {
        await import('/candidate/src/cli.mjs');
        if (process.exitCode || logs.length !== 1) throw Error('cli_failed');
        result = JSON.parse(logs[0]);
      } finally { console.log = originalLog; }
    } else if (input.repository === 'FreeTWAI-AI/freedom-agent-kit') {
      const { PlatformClient } = await import('/candidate/packages/client/index.mjs');
      const client = new PlatformClient({ baseUrl: origin + '/api/v1', cookie: input.credential, fetcher: fixtureFetch });
      await client.assertCompatible();
      result = await entries.loadMemberWorkspace(client);
    } else if (input.repository === 'FreeTWAI-AI/freedom-storefront') {
      result = await entries.loadConnectedStorefront({ origin, token: input.credential, fetcher: fixtureFetch });
    } else if (input.repository === 'FreeTWAI-AI/freedom-supplier-client') {
      result = await entries.loadSupplierWorkspace(new entries.ScopedReadClient({ origin, token: input.credential, fetcher: fixtureFetch }));
    } else throw Error('unsupported_consumer');
  } catch (error) { status = 422; result = { error: true, status: Number.isInteger(error?.status) ? error.status : null }; }
  process.stdout.write(JSON.stringify({ id: frame.id, status, headers: [['content-type', 'application/json']],
    body: Buffer.from(JSON.stringify(result)).toString('base64') }) + '\n');
}
