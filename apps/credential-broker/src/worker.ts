import {z} from 'zod';
import type {Pool} from 'pg';
import {createRequestPool} from '../../../packages/db/index.js';
import {parseBoundedJson} from '../../../packages/execution-state/decode.js';
import {createR2ObjectStore,type AssetR2Binding} from '../../../packages/asset-storage/r2.js';
import {CredentialRecoveryFloorSchema} from '../../../contracts/execution/v2/model-credential.js';
import {createModelBrokerAuthorizations} from '../../../modules/agent-control/model-broker-authorizations.js';
import {bindPrivateAiJsonService,MODEL_BROKER_BINDING_URI,type PrivateAiServiceBinding} from '../../platform-api/src/model-broker-service-binding.js';
import {createSignedRecoverySource} from './recovery.js';
import {createCredentialVault} from './vault.js';
import {createBrokerModelExecution} from './execution.js';
import {createBrokerBridge} from './bridge.js';
import {createBrokerServiceBindingReceiver} from './service-binding.js';
import {brokerRequestSql} from './worker-request-sql.js';
import {BrokerWorkerProfileSchema,BrokerWorkerResponseKeySchema,BrokerWorkerKekSchema} from './worker-profile.js';
export interface BrokerWorkerBindings{
  FREEDOM_BROKER_ENABLED?:string;FREEDOM_BROKER_ENVIRONMENT?:string;APP_ORIGIN?:string;FREEDOM_BROKER_PROFILE?:string;
  FREEDOM_BROKER_RESPONSE_KEY?:string;FREEDOM_BROKER_KEKS?:string;
  CIPHER_HYPERDRIVE?:{connectionString:string};EXECUTOR_HYPERDRIVE?:{connectionString:string};MEDIA?:AssetR2Binding;
  CREDENTIAL_RECOVERY_STATE?:PrivateAiServiceBinding;CREDENTIAL_RECOVERY_FLOOR?:PrivateAiServiceBinding;
}
const unavailable=()=>Response.json({code:'model_broker_unavailable'},{status:503,headers:{'Cache-Control':'private, no-store'}});
const assemblies=new WeakMap<object,Promise<{sql:ReturnType<typeof brokerRequestSql>;receiver:ReturnType<typeof createBrokerServiceBindingReceiver>;profile:z.infer<typeof BrokerWorkerProfileSchema>}>>();
function json(raw:string|undefined,max:number){if(!raw||raw.length>max)throw Error();return parseBoundedJson(raw);}
async function publicKeys(pins:{keyId:string;publicJwk:JsonWebKey}[]){const keys=new Map<string,CryptoKey>();for(const pin of pins){if(keys.has(pin.keyId))throw Error();keys.set(pin.keyId,await crypto.subtle.importKey('jwk',pin.publicJwk,{name:'Ed25519'},false,['verify']));}return keys;}
async function compose(env:BrokerWorkerBindings){
  const profile=BrokerWorkerProfileSchema.parse(json(env.FREEDOM_BROKER_PROFILE,32768));
  if(profile.environment!==env.FREEDOM_BROKER_ENVIRONMENT||profile.platformOrigin!==env.APP_ORIGIN
    ||profile.platformOrigin!==new URL(profile.platformOrigin).origin
    ||profile.platformOrigin!==(profile.environment==='staging-next'?'https://staging.freetwai.com':'https://freetwai.com')
    ||profile.databaseName!==(profile.environment==='staging-next'?'freedom_staging_next':'freedom_next')
    ||profile.cipherRole!==profile.databaseName+'_broker'||profile.executorRole!==profile.databaseName+'_broker_executor'
    ||!env.CIPHER_HYPERDRIVE||!env.EXECUTOR_HYPERDRIVE||env.CIPHER_HYPERDRIVE===env.EXECUTOR_HYPERDRIVE
    ||env.CIPHER_HYPERDRIVE.connectionString===env.EXECUTOR_HYPERDRIVE.connectionString||!env.MEDIA
    ||!env.CREDENTIAL_RECOVERY_STATE||!env.CREDENTIAL_RECOVERY_FLOOR||env.CREDENTIAL_RECOVERY_STATE===env.CREDENTIAL_RECOVERY_FLOOR)throw Error();
  const signer=await crypto.subtle.importKey('jwk',BrokerWorkerResponseKeySchema.parse(json(env.FREEDOM_BROKER_RESPONSE_KEY,4096)),{name:'Ed25519'},false,['sign']);
  const requestKeys=await publicKeys(profile.requestKeys),recoveryKeys=await publicKeys(profile.recoveryKeys);
  const keys=new Map<string,CryptoKey>();for(const item of BrokerWorkerKekSchema.parse(json(env.FREEDOM_BROKER_KEKS,16384))){if(keys.has(item.keyId))throw Error();keys.set(item.keyId,await crypto.subtle.importKey('jwk',item.jwk,{name:'AES-GCM'},false,['encrypt','decrypt']));}
  const current=keys.get(profile.currentKekId);if(!current)throw Error();
  const readState=bindPrivateAiJsonService(env.CREDENTIAL_RECOVERY_STATE),readFloor=bindPrivateAiJsonService(env.CREDENTIAL_RECOVERY_FLOOR);
  const recovery=createSignedRecoverySource({environment:profile.environment,authority:profile.recoveryAuthority,pinnedKeys:[...recoveryKeys].map(([keyId,key])=>({keyId,key})),
    readSignedState:async()=>(await readState('https://freedom-private-ai.internal/internal/credential-recovery/state',z.object({signedState:z.string().max(4096)}).strict())).signedState,
    readMonotonicFloor:()=>readFloor('https://freedom-private-ai.internal/internal/credential-recovery/floor',CredentialRecoveryFloorSchema)});
  const vault=createCredentialVault({recover:recovery.recover,kek:{current:async()=>({keyId:profile.currentKekId,key:current}),readById:async id=>keys.get(id)??null}});
  const sql=brokerRequestSql(),authorizations=createModelBrokerAuthorizations(sql.executor,{environment:profile.environment,clientId:profile.clientId,issuer:profile.issuer,audience:profile.requestAudience,recover:recovery.recover});
  const execution=createBrokerModelExecution({cipherPool:sql.cipher,executorPool:sql.executor,environment:profile.environment,clientId:profile.clientId,vault,recover:recovery.recover,store:createR2ObjectStore(env.MEDIA),authorizations});
  const bridge=await createBrokerBridge({environment:profile.environment,clientId:profile.clientId,issuer:profile.issuer,requestAudience:profile.requestAudience,brokerId:profile.brokerId,responseAudience:profile.responseAudience,responseSigningKey:signer,responseKeyId:profile.responseKeyId,requestKeys,authorizations,execution});
  return {sql,receiver:createBrokerServiceBindingReceiver(bridge),profile};
}
async function verifyRole(pool:Pool,role:string,database:string,cipher:boolean){
  const row=(await pool.query(`SELECT current_user AS role,current_database() AS database,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,
    (SELECT count(*)::int FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS memberships,
    has_table_privilege(current_user,'broker_credential_vault','SELECT') AS vault_read,
    has_table_privilege(current_user,'broker_credential_vault','INSERT') AS vault_write,
    has_any_column_privilege(current_user,'broker_credential_vault','SELECT') AS vault_column_read,
    has_any_column_privilege(current_user,'broker_credential_vault','INSERT') AS vault_column_write FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if(!row||row.role!==role||row.database!==database||row.rolsuper||row.rolcreatedb||row.rolcreaterole||row.rolreplication||row.rolbypassrls||row.rolinherit||row.memberships!==0||row.vault_read!==cipher||row.vault_write!==cipher||!cipher&&(row.vault_column_read||row.vault_column_write))throw Error();
}
export default {async fetch(request:Request,env:BrokerWorkerBindings):Promise<Response>{
  if(env.FREEDOM_BROKER_ENABLED!=='true')return unavailable();
  if(request.url!==MODEL_BROKER_BINDING_URI||request.method!=='POST'||['Origin','Cookie','Authorization','DPoP','Content-Encoding','Sec-Fetch-Site'].some(name=>request.headers.has(name)))return Response.json({code:'model_broker_authorization_invalid'},{status:403});
  let cipher:Pool|undefined,executor:Pool|undefined;
  try{
    let pending=assemblies.get(env);if(!pending){pending=compose(env);assemblies.set(env,pending);pending.catch(()=>assemblies.delete(env));}
    const assembly=await pending;
    cipher=createRequestPool(env.CIPHER_HYPERDRIVE!.connectionString);executor=createRequestPool(env.EXECUTOR_HYPERDRIVE!.connectionString);
    await Promise.all([verifyRole(cipher,assembly.profile.cipherRole,assembly.profile.databaseName,true),verifyRole(executor,assembly.profile.executorRole,assembly.profile.databaseName,false)]);
    return await assembly.sql.run({cipher,executor},()=>assembly.receiver.fetch(request));
  }catch{return unavailable();}finally{await Promise.allSettled([cipher?.end(),executor?.end()]);}
}};
