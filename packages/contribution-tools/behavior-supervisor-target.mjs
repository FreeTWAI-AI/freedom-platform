// Fixed host-installed adapter, executed ONLY inside the disposable candidate
// container. This process and everything it imports remain untrusted to host.
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
const require = createRequire('/candidate/package.json');
const { Pool } = require('pg');
const { createApp } = await import('/candidate/apps/platform-api/src/app.ts');
const pool = new Pool({ host: '/database', database: 'fp_behavior_supervisor', user: 'behavior_app', password: process.env.FP_BEHAVIOR_DB_PASSWORD,
  max: 4, connectionTimeoutMillis: 2000, statement_timeout: 2000 });
const app = createApp(pool, 'http://127.0.0.1:4310');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const input = JSON.parse(line);
  const response = await app.request(new Request(input.url, { method: input.method, headers: input.headers,
    ...(input.body === null ? {} : { body: Buffer.from(input.body, 'base64') }), redirect: 'error' }));
  const bytes = Buffer.from(await response.arrayBuffer());
  process.stdout.write(JSON.stringify({ id: input.id, status: response.status,
    headers: [...response.headers], body: bytes.toString('base64') }) + '\n');
}
await pool.end();
