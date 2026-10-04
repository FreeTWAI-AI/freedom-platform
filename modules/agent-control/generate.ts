import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { RuntimePublicJwkSchema, RuntimeRegistrationChallengeBindingSchema, RuntimeRegistrationChallengeSchema } from '../../contracts/execution/v1/runtime-registration.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
const profiles = [
  ['runtime-public-jwk', RuntimePublicJwkSchema],
  ['runtime-registration-binding', RuntimeRegistrationChallengeBindingSchema],
  ['runtime-registration-challenge', RuntimeRegistrationChallengeSchema],
] as const;
for (const [name, schema] of profiles) {
  const path = new URL(`../../contracts/execution/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v1/${name}`,
    description: 'Structural enrollment profile only. Actual curve/signature, exact payload, 300s binding, current member authorization, DB clock and atomic consumption require the server implementation; never execution authority.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Three structural runtime enrollment schemas checked/generated; no execution authority.');
