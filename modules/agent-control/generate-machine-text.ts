import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {MachineTextDeviceProofSchema,MachineTextAccessClaimsSchema} from '../../contracts/execution/v3/machine-text-execution.js';
if(process.argv.slice(2).some(value=>value!=='--check'))throw new Error('Only --check is supported.');
for(const [name,schema] of [['proof',MachineTextDeviceProofSchema],['access',MachineTextAccessClaimsSchema]] as const){
  const path=new URL(`../../contracts/execution/v3/machine-text-${name}.schema.json`,import.meta.url);
  const bytes=JSON.stringify({...z.toJSONSchema(schema),$id:`https://freetwai.com/contracts/execution/v3/machine-text-${name}`,
    description:'Structural machine text data only. ES256 proof, pinned issuer and current SQL device/Grant/Attempt admission remain mandatory.'},null,2)+'\n';
  if(process.argv.includes('--check')){if(await readFile(path,'utf8')!==bytes)throw new Error('Machine text schema is stale.');}
  else await writeFile(path,bytes);
}
