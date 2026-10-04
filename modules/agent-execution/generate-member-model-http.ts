import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as c from '../../contracts/execution/v2/member-model-http.js';
if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name,schema] of [
  ['member-model-http-approval-create',c.MemberModelHttpApprovalCreateSchema],
  ['member-model-http-activate',c.MemberModelHttpActivateSchema],
  ['member-model-http-empty',c.MemberModelHttpEmptySchema],
  ['member-model-http-overview',c.MemberModelHttpOverviewSchema],
] as const) {
  const path = new URL(`../../contracts/execution/v2/${name}.schema.json`,import.meta.url);
  const bytes = JSON.stringify({...z.toJSONSchema(schema),$id:`https://freetwai.com/contracts/execution/v2/${name}`,
    description:'Closed member HTTP ModelStep data. Parsing grants no authentication, export approval or operational authority.'},null,2)+'\n';
  if (process.argv.includes('--check')) { if (await readFile(path,'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`); }
  else await writeFile(path,bytes);
}
console.log('Four closed member ModelStep HTTP schemas checked/generated.');
