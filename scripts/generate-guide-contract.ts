import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {guideManifestSchema} from '../packages/public-guide-assets/index.js';
if(process.argv.slice(2).some(arg=>arg!=='--check'))throw Error('Only --check is supported');
const path=new URL('../contracts/guide-packs/manifest.schema.json',import.meta.url);
const text=JSON.stringify(z.toJSONSchema(guideManifestSchema),null,2)+'\n';
if(process.argv.includes('--check')){
  if(await readFile(path,'utf8')!==text)throw Error('Guide asset schema is stale');
}else await writeFile(path,text);
