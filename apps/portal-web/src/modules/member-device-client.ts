import { z } from 'zod';
import { ApiError, type PortalClient } from '../api.js';
import { OpaqueId } from '../../../../contracts/common/v1/identity.js';
import { ExecutionVersion } from '../../../../contracts/execution/v1/state.js';
import { RuntimeEnvironmentSchema } from '../../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../../contracts/execution/v1/bootstrap.js';
import { BootstrapHttpDecisionSchema } from '../../../../contracts/execution/v1/bootstrap-http.js';
import { DeviceAuthorizationInspectInputSchema, DeviceAuthorizationReviewSchema, DeviceAuthorizationDecisionResultSchema } from '../../../../contracts/execution/v1/device-pairing.js';

export type BootstrapHttpDecision = z.infer<typeof BootstrapHttpDecisionSchema>;
const Version = ExecutionVersion.refine(value => BigInt(value) <= 9223372036854775807n);
const Key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Connection = z.object({ connectionId: OpaqueId, runtimeDeviceId: OpaqueId,
  environment: RuntimeEnvironmentSchema, clientId: BootstrapClientIdSchema, state: z.enum(['active','revoked']),
  aggregateVersion: Version, issuedAt: z.iso.datetime({precision:3}), expiresAt: z.iso.datetime({precision:3}),
  operational_authority: z.literal(false) }).strict();
export type AgentConnectionMetadata = Readonly<z.infer<typeof Connection>>;
const List = z.object({items: z.array(Connection).max(32), operational_authority:z.literal(false)}).strict();
function input<T>(schema:z.ZodType<T>,value:unknown):T {
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw new ApiError({message:'裝置操作資料不完整，請重新確認。',status:400});
  return parsed.data;
}
function output<T>(schema:z.ZodType<T>,value:unknown,write=false):T {
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw new ApiError({message:write?'尚未確認操作結果，請保留原操作後再確認。':'裝置資料回應不完整，請重新讀取。',network:write});
  return parsed.data;
}
/** Current member control only. Commands live in memory; callers explicitly choose any replay. */
export function createMemberDeviceClient(client:Pick<PortalClient,'get'|'post'>) {
  const bindings=new Map<string,string>();
  function bind(key:string,path:string,body:unknown,version?:string) {
    const fingerprint=JSON.stringify([path,body,version??null]),previous=bindings.get(key);
    if(previous!==undefined&&previous!==fingerprint)throw new ApiError({message:'請保留原操作的內容與版本；新的操作需使用新的識別碼。',status:409});
    bindings.set(key,fingerprint);
  }
  return {
    async inspect(userCode:string) {
      const body=Object.freeze(input(DeviceAuthorizationInspectInputSchema,{userCode}));
      return Object.freeze(output(DeviceAuthorizationReviewSchema,await client.post('/me/device-authorizations/inspect',body,{suppressConsole:true})));
    },
    async decide(raw:BootstrapHttpDecision,rawKey:string) {
      const body=Object.freeze(input(BootstrapHttpDecisionSchema,raw)),key=input(Key,rawKey);
      const path='/me/device-authorizations/decide';bind(key,path,body);
      const result=output(DeviceAuthorizationDecisionResultSchema,await client.post(path,body,{idempotencyKey:key,suppressConsole:true}),true);
      if(result.authorizationId!==body.authorizationId||result.requestDigest!==body.requestDigest||result.state!==(body.decision==='approve'?'approved':'denied')) {
        throw new ApiError({message:'尚未確認原裝置操作結果，請保留原操作後再確認。',network:true});
      }
      return Object.freeze(result);
    },
    async list():Promise<{items:readonly AgentConnectionMetadata[];operational_authority:false}> {
      const result=output(List,await client.get('/me/agent-connections',{background:true}));
      return Object.freeze({...result,items:Object.freeze(result.items.map(item=>Object.freeze(item)))});
    },
    async read(rawId:string):Promise<AgentConnectionMetadata> {
      const id=input(OpaqueId,rawId),result=output(Connection,await client.get('/me/agent-connections/'+id,{background:true}));
      if(result.connectionId!==id)throw new ApiError({message:'裝置資料回應不完整，請重新讀取。'});
      return Object.freeze(result);
    },
    async revoke(rawId:string,rawVersion:string,rawKey:string):Promise<AgentConnectionMetadata> {
      const id=input(OpaqueId,rawId),version=input(Version,rawVersion),key=input(Key,rawKey),body=Object.freeze({});
      const path='/me/agent-connections/'+id+':revoke';bind(key,path,body,version);
      const result=output(Connection,await client.post(path,body,{idempotencyKey:key,ifMatch:version,suppressConsole:true}),true);
      if(result.connectionId!==id||result.state!=='revoked')throw new ApiError({message:'尚未確認原裝置操作結果，請保留原操作後再確認。',network:true});
      return Object.freeze(result);
    },
  };
}
export type MemberDeviceClient = ReturnType<typeof createMemberDeviceClient>;
