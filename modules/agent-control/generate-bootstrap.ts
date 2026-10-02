import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { BootstrapAccessClaimsSchema, BootstrapDpopClaimsSchema, BootstrapProofResultSchema } from '../../contracts/execution/v1/bootstrap.js';
import { BootstrapNonceSchema, BootstrapStatusSchema } from '../../contracts/execution/v1/bootstrap-status.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
const profiles = [
  ['bootstrap-access-claims', BootstrapAccessClaimsSchema],
  ['bootstrap-dpop-claims', BootstrapDpopClaimsSchema],
  ['bootstrap-proof-result', BootstrapProofResultSchema],
  ['bootstrap-nonce', BootstrapNonceSchema],
  ['bootstrap-status', BootstrapStatusSchema],
] as const;
for (const [name, schema] of profiles) {
  const path = new URL(`../../contracts/execution/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v1/${name}`,
    description: schema.description ?? 'Structural DPoP claims only. The server must verify the signature, issuer/device/host binding, encoding, time and nonce. Parsing this schema does not authenticate a machine or grant execution permission.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Five structural bootstrap schemas checked/generated; schema parsing grants no machine or execution authority.');
