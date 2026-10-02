import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { BootstrapRefreshClaimsSchema, BootstrapNonceClaimsSchema, BootstrapRefreshProofResultSchema,
  BootstrapNonceProofResultSchema, BootstrapRefreshSchema, BootstrapRefreshResultSchema } from '../../contracts/execution/v1/bootstrap-session.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
const profiles = [
  ['bootstrap-refresh-claims', BootstrapRefreshClaimsSchema],
  ['bootstrap-nonce-claims', BootstrapNonceClaimsSchema],
  ['bootstrap-refresh-proof-result', BootstrapRefreshProofResultSchema],
  ['bootstrap-nonce-proof-result', BootstrapNonceProofResultSchema],
  ['bootstrap-refresh', BootstrapRefreshSchema],
  ['bootstrap-refresh-result', BootstrapRefreshResultSchema],
] as const;
for (const [name, schema] of profiles) {
  const path = new URL(`../../contracts/execution/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v1/${name}`,
    description: schema.description ?? 'Closed bootstrap session shape only. Real signatures, exact host and current DB authority, time, replay and committed rotation must be independently checked. No execution authority or approved production trust.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Six structural bootstrap-session schemas checked/generated; no execution authority or approved issuer trust.');
