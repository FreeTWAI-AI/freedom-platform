import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { BootstrapAccessClaimsSchema, BootstrapDpopClaimsSchema, BootstrapProofResultSchema } from '../../contracts/execution/v1/bootstrap.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
const profiles = [
  ['bootstrap-access-claims', BootstrapAccessClaimsSchema],
  ['bootstrap-dpop-claims', BootstrapDpopClaimsSchema],
  ['bootstrap-proof-result', BootstrapProofResultSchema],
] as const;
for (const [name, schema] of profiles) {
  const path = new URL(`../../contracts/execution/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v1/${name}`,
    description: 'Structural bootstrap crypto profile only. The server verifier checks signatures, trusted issuer/key purpose and validity, exact host identity/URI/binding, canonical encoding, signed-64-bit version and time bounds. Caller-provided keys/time/binding are not authenticated by this schema. No current DB authority, nonce consumption, replay prevention, machine authentication or execution permission.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Three structural bootstrap crypto schemas checked/generated; no machine or execution authority.');
