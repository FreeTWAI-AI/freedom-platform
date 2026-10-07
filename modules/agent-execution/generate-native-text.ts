import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { NativeTextBindingSchema, NativeTextContextSchema, NativeTextReceiptSchema } from '../../contracts/execution/v3/native-text-invocation.js';
if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema] of [['binding', NativeTextBindingSchema], ['context', NativeTextContextSchema], ['receipt', NativeTextReceiptSchema]] as const) {
  const path = new URL(`../../contracts/execution/v3/native-text-${name}.schema.json`, import.meta.url);
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/execution/v3/native-text-${name}`,
    description: 'Structural native CLI data only. No device verification, current Grant/Attempt authority, provider attestation or private Result authority.' }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error(`Native text ${name} schema is stale.`);
  } else await writeFile(path, bytes);
}
