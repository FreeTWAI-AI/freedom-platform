import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PrincipalRefSchema, ResourceScopeRefSchema } from '../contracts/common/v1/identity.js';

if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Only --check is supported.');
for (const [name, schema] of [['principal-ref', PrincipalRefSchema], ['resource-scope-ref', ResourceScopeRefSchema]] as const) {
  const path = fileURLToPath(new URL(`../contracts/common/v1/${name}.schema.json`, import.meta.url));
  const bytes = JSON.stringify({ ...z.toJSONSchema(schema), $id: `https://freetwai.com/contracts/common/v1/${name}` }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== bytes) throw new Error('Generated common contracts are stale.');
  } else await writeFile(path, bytes);
}
console.log('Common identity references: 2 generated schemas; no execution authority.');
