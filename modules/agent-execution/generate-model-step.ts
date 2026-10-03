import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as c from '../../contracts/execution/v2/model-step.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema] of [
  ['model-step-approval-create', c.ApprovalCreateSchema], ['model-step-approval-read', c.ApprovalReadSchema],
  ['model-step-approval-revoke', c.ApprovalRevokeSchema], ['model-step-approval-metadata', c.ModelStepApprovalMetadataSchema],
  ['model-step-activate', c.ActivateSchema], ['model-step-begin', c.BeginSchema],
  ['model-step-read', c.ReadSchema], ['model-step-control', c.ControlSchema],
  ['model-step-metadata', c.ModelStepMetadataSchema], ['model-step-binding', c.ModelStepBindingSchema],
] as const) {
  const path = new URL(`../../contracts/execution/v2/${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v2/${name}`,
    description: 'Closed structural ModelStep data. Parsing does not authenticate a model, approve an export, establish current authority or mint a private execution capability.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
console.log('Ten structural ModelStep schemas checked/generated; no standalone operational authority.');
