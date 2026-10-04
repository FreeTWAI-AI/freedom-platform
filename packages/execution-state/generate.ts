import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ExecutionInputSchema } from '../../contracts/execution/v1/state.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
const path = fileURLToPath(new URL('../../contracts/execution/v1/decision-input.schema.json', import.meta.url));
const bytes = JSON.stringify({ ...z.toJSONSchema(ExecutionInputSchema),
  $id: 'https://freetwai.com/contracts/execution/v1/decision-input',
  description: 'Hypothetical decision inputs only; no authentication, runtime authority, dispatch or durable state.' }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== bytes) throw new Error('Generated execution decision schema is stale.');
} else await writeFile(path, bytes);
console.log('Execution decision schema checked/generated; operational activation remains unavailable.');
