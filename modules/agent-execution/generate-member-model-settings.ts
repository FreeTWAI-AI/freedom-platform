import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { MemberModelSettingsOverviewSchema, MemberModelSettingsSetupSchema } from '../../contracts/execution/v2/member-model-settings.js';

if (process.argv.slice(2).some(value => value !== '--check')) throw new Error('Only --check is supported.');
for (const [name,schema] of [['member-model-settings-overview',MemberModelSettingsOverviewSchema],
  ['member-model-settings-setup',MemberModelSettingsSetupSchema]] as const) {
  const path = new URL(`../../contracts/execution/v2/${name}.schema.json`,import.meta.url);
  const bytes = JSON.stringify({...z.toJSONSchema(schema),$id:`https://freetwai.com/contracts/execution/v2/${name}`,
    description:'Closed owner metadata only. Parsing establishes no provider readiness, secret capture or operational authority.'},null,2)+'\n';
  if (process.argv.includes('--check')) {
    if (await readFile(path,'utf8') !== bytes) throw new Error(`Generated ${name} schema is stale.`);
  } else await writeFile(path,bytes);
}
console.log('Two member model settings metadata schemas checked/generated.');
