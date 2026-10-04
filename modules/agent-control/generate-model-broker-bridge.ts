import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as c from '../../contracts/execution/v2/model-broker-bridge.js';
if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema] of [
  ['model-broker-command', c.ModelBrokerCommandSchema],
  ['model-broker-assertion', c.ModelBrokerAssertionPayloadSchema],
  ['model-broker-protected-header', c.ModelBrokerProtectedHeaderSchema],
  ['model-broker-response-protected-header', c.ModelBrokerResponseProtectedHeaderSchema],
  ['model-broker-request', c.ModelBrokerRequestSchema],
  ['model-broker-response', c.ModelBrokerResponsePayloadSchema],
  ['model-broker-response-envelope', c.ModelBrokerResponseEnvelopeSchema],
] as const) {
  const path = new URL(`../../contracts/execution/v2/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v2/${name}`,
    description: 'Closed reference-only model broker data. Parsing grants no member authentication, secret access, proof or execution authority.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) { if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`); }
  else await writeFile(path, bytes);
}
console.log('Seven closed model broker bridge schemas checked/generated.');
