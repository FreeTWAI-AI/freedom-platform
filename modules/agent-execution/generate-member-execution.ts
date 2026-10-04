import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  ModelSelectionSchema, CreateModelConnectionInputSchema, ReadModelConnectionInputSchema, RevokeModelConnectionInputSchema,
  ModelConnectionMetadataSchema, CreateExecutionGrantInputSchema, ReadExecutionGrantInputSchema, RevokeExecutionGrantInputSchema,
  ExecutionGrantMetadataSchema, CreateExecutionAttemptInputSchema, ReadExecutionAttemptInputSchema, ExecutionAttemptMetadataSchema,
} from '../../contracts/execution/v1/member-execution.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
const profiles = [
  ['model-selection', ModelSelectionSchema],
  ['create-model-connection-input', CreateModelConnectionInputSchema],
  ['read-model-connection-input', ReadModelConnectionInputSchema],
  ['revoke-model-connection-input', RevokeModelConnectionInputSchema],
  ['model-connection-metadata', ModelConnectionMetadataSchema],
  ['create-execution-grant-input', CreateExecutionGrantInputSchema],
  ['read-execution-grant-input', ReadExecutionGrantInputSchema],
  ['revoke-execution-grant-input', RevokeExecutionGrantInputSchema],
  ['execution-grant-metadata', ExecutionGrantMetadataSchema],
  ['create-execution-attempt-input', CreateExecutionAttemptInputSchema],
  ['read-execution-attempt-input', ReadExecutionAttemptInputSchema],
  ['execution-attempt-metadata', ExecutionAttemptMetadataSchema],
] as const;
for (const [name, schema] of profiles) {
  const path = new URL(`../../contracts/execution/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v1/${name}`,
    description: schema.description ?? 'Closed member execution prerequisite shape only. Server revalidates current identity, backing bindings, versions, consent, expiry and policy. Parsing never grants model or operational execution authority.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Twelve closed member execution prerequisite schemas checked/generated; parsing grants no model or execution authority.');
