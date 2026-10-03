import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { BootstrapHttpBeginSchema, BootstrapHttpTokenSchema, BootstrapHttpNonceSchema,
  BootstrapHttpDecisionSchema } from '../../contracts/execution/v1/bootstrap-http.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema] of [
  ['bootstrap-http-begin', BootstrapHttpBeginSchema], ['bootstrap-http-token', BootstrapHttpTokenSchema],
  ['bootstrap-http-nonce', BootstrapHttpNonceSchema], ['bootstrap-http-decision', BootstrapHttpDecisionSchema],
] as const) {
  const path = new URL(`../../contracts/execution/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v1/${name}`,
    description: 'Closed HTTP body shape only. Transport must separately enforce origin, credential kind, real proof and current DB authority. No execution authority or production trust.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Four structural bootstrap HTTP schemas checked/generated.');
