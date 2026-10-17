import {randomBytes} from 'node:crypto';
import type {PoolClient} from 'pg';
import {findCdnBlockedTerm} from '../providers/ecpay/index.js';
const alphabet='0123456789abcdefghjkmnpqrstvwxyz';
export const PROVIDER_ACCOUNT_REF=/^[0-9a-hjkmnp-tv-z]{26}$/;
function candidate(entropy:(size:number)=>Buffer):string {
  const bytes=entropy(16);if(bytes.length!==16)throw new Error('Provider account route generation failed.');
  let bits=BigInt('0x'+bytes.toString('hex')),ref='';
  for(let i=0;i<26;i++){ref=alphabet[Number(bits&31n)]+ref;bits>>=5n;}return ref;
}
const blocked=(ref:string)=>[
  `/api/v1/provider-callbacks/ecpay/${ref}/payment`,
  `/api/v1/provider-callbacks/ecpay/${ref}/logistics`,
  `/api/v1/provider-callbacks/ecpay/${ref}/invoice-allowance`,
  `/pay/ecpay/return/${ref}`,
].some(path=>findCdnBlockedTerm(path)!==null);
/** Insert on the account creation transaction; references never leave account DTOs. */
export async function createProviderAccountRoute(q:PoolClient,input:{tenantId:string;instanceId:string;accountId:string},entropy:(size:number)=>Buffer=randomBytes):Promise<void>{
  for(let i=0;i<16;i++){
    const ref=candidate(entropy);if(blocked(ref))continue;
    const inserted=await q.query(`INSERT INTO commerce_entry_routes(route_kind,route_key,tenant_id,instance_id,target_id)
      VALUES('provider_account',$1,$2,$3,$4) ON CONFLICT(route_kind,route_key) DO NOTHING`,[ref,input.tenantId,input.instanceId,input.accountId]);
    if(inserted.rowCount===1)return;
  }
  throw new Error('Provider account route generation failed.');
}
export async function resolveProviderAccountRoute(q:PoolClient,ref:string):Promise<{tenant_id:string;instance_id:string;account_id:string}|null>{
  if(!PROVIDER_ACCOUNT_REF.test(ref))return null;
  return (await q.query<{tenant_id:string;instance_id:string;account_id:string}>(`SELECT tenant_id,instance_id,target_id AS account_id FROM commerce_entry_routes
    WHERE route_kind='provider_account' AND route_key=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())`,[ref])).rows[0]??null;
}
