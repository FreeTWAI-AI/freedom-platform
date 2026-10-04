import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  MemberExecutionHttpRunCreateSchema, MemberExecutionHttpEmptySchema, MemberExecutionHttpModelCreateSchema,
  MemberExecutionHttpGrantCreateSchema, MemberExecutionHttpAttemptCreateSchema, MemberExecutionHttpRunMetadataSchema,
} from '../../contracts/execution/v1/member-execution-http.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema] of [
  ['member-execution-http-run-create', MemberExecutionHttpRunCreateSchema],
  ['member-execution-http-empty', MemberExecutionHttpEmptySchema],
  ['member-execution-http-model-create', MemberExecutionHttpModelCreateSchema],
  ['member-execution-http-grant-create', MemberExecutionHttpGrantCreateSchema],
  ['member-execution-http-attempt-create', MemberExecutionHttpAttemptCreateSchema],
  ['member-execution-http-run-metadata', MemberExecutionHttpRunMetadataSchema],
] as const) {
  const path = new URL(`../../contracts/execution/v1/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v1/${name}`,
    description: schema.description ?? 'Closed member execution HTTP body shape only. Transport separately checks current member authentication, exact Origin/CSRF, idempotency and primary If-Match CAS. No model or operational execution authority.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Six structural member execution HTTP schemas checked/generated; no model or operational execution authority.');
