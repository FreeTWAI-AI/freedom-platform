import {readdirSync} from 'node:fs';
import {join} from 'node:path';
/** Explicit Miniflare module list for the actual Wrangler broker bundle: the
 * ESM entry plus the Data modules Wrangler emitted for its `rules` (brand). */
export function brokerBundleModules(directory:string){
  const data=readdirSync(directory).filter(name=>name.endsWith('.webp')).sort();
  if(data.length!==1)throw Error('Broker bundle must contain exactly one Data brand module');
  return [{type:'ESModule' as const,path:join(directory,'worker.js')},...data.map(name=>({type:'Data' as const,path:join(directory,name)}))];
}
