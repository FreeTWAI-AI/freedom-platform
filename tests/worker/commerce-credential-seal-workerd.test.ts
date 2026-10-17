import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {test} from 'node:test';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {CREDENTIAL_SEAL_VECTOR as vector} from '../../modules/agent-commerce/payments/credential-seal-vector.js';
test('credential vector and random round trip in workerd',async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));mkdirSync(join(root,'.wrangler'),{recursive:true});
  const dir=mkdtempSync(join(root,'.wrangler/commerce-seal-')),outfile=join(dir,'worker.mjs');let mf:Miniflare|undefined;
  try{
    await build({stdin:{resolveDir:root,contents:`
      import {randomBytes,randomUUID} from 'node:crypto';
      import {CommerceCredentialKeyring,sealCredential,unsealCredential} from './modules/agent-commerce/payments/credentials.ts';
      import {CREDENTIAL_SEAL_VECTOR as v} from './modules/agent-commerce/payments/credential-seal-vector.ts';
      export default {fetch(){
        const known=unsealCredential(CommerceCredentialKeyring.parse(v.keyring),v.context,v.row);
        const ring=CommerceCredentialKeyring.parse('random:'+randomBytes(32).toString('base64'));
        const ctx={account_id:randomUUID(),purpose:'payment',environment:'sandbox',credential_version:1};
        const material={hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex')};
        const actual=unsealCredential(ring,ctx,sealCredential(ring,ctx,material));
        return Response.json({known,roundTrip:JSON.stringify(actual)===JSON.stringify(material)});
      }};`},outfile,bundle:true,format:'esm',platform:'neutral',target:'es2023',external:['node:*'],logLevel:'silent'});
    mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'commerce-seal',modules:true,scriptPath:outfile,compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat']}]}));
    await mf.ready;const response=await (await mf.getWorker('commerce-seal')).fetch('https://commerce.internal/seal');
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{known:vector.material,roundTrip:true});
  }finally{await mf?.dispose();rmSync(dir,{recursive:true,force:true});}
});
