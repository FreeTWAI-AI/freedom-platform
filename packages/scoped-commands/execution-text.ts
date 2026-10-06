import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {runCommandCore} from '../db/command-core.js';
import {snapshotInput,freezeTree} from '../execution-state/decode.js';
import {requireCondition} from '../shared/problem.js';
import {MachineTextLimits} from '../../contracts/execution/v3/machine-text-execution.js';
import {assertMachineTextCurrent,forgetMachineTextContext,machineTextFactBinding,type MachineTextAuthority,
  type MachineTextContext} from '../../modules/agent-control/machine-text-authority.js';
import {machineTextHash} from '../../modules/agent-control/machine-text-proof.js';
import {registerScopedCommand,authorizeScopedCommand,bindScopedExecutionFact,forgetScopedCommand} from './command-context.js';

const Input=z.object({accessToken:z.string().min(1).max(MachineTextLimits.compactBytes),proof:z.string().min(1).max(MachineTextLimits.compactBytes),
  operation:z.enum(['execute','evidence']),requestSha256:z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/),
  key:z.string().regex(/^[A-Za-z0-9_-]{8,128}$(?![\s\S])/),expected:z.string().regex(/^[1-9][0-9]{0,18}$(?![\s\S])/)}).strict();
export type MachineTextCommandInput=z.infer<typeof Input>;
const response=(raw:unknown)=>{const value=snapshotInput(raw);const json=JSON.stringify(value);
  requireCondition(json!==undefined&&Buffer.byteLength(json)<=32768,500,'invalid_machine_metadata','機器執行中繼資料無效。');return {value:freezeTree(value),json};};
/** Closed machine command admission. The trusted composition supplies the real
 * signed-device authority, never ports or identity claims from request JSON.
 * Both current SQL and wall clocks are checked AFTER receipt sink waits.
 * Responses are bounded server-selected metadata; never return capabilities,
 * context, credentials or private text from the run callback.
 */
export async function executionTextCommand<T>(pool:Pool,authority:MachineTextAuthority,raw:MachineTextCommandInput,
  authorize:(q:PoolClient,context:MachineTextContext)=>Promise<unknown>,
  run:(q:PoolClient,context:MachineTextContext)=>Promise<T>):Promise<T>{
  const input=freezeTree(Input.parse(snapshotInput(raw)));
  requireCondition(BigInt(input.expected)<=9223372036854775807n,400,'invalid_expected_version','版本無效。');
  const operation='execution.machine-text.'+input.operation;let c!:MachineTextContext;
  const namespace=()=>[c.subject_principal.principal_id,c.authn_kind,c.scope.scope_id,operation,input.key];
  try{return await runCommandCore(pool,{
    async authenticateAndLock(q){c=await authority.access(q,{accessToken:input.accessToken,proof:input.proof,operation:input.operation,
      requestSha256:input.requestSha256});registerScopedCommand(c,q,operation);},
    async lockReceipt(q){await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['freedom.execution-text-command/v1',...namespace()])]);},
    requestDigest:()=>machineTextHash(JSON.stringify(['freedom.execution-text-command/v1',c.binding,input.operation,input.expected,input.requestSha256])),
    async readReceipt(q){const prior=(await q.query(`SELECT request_sha256,response FROM scoped_command_receipts
      WHERE principal_id=$1 AND authn_kind=$2 AND scope_id=$3 AND operation=$4 AND idempotency_key=$5`,namespace())).rows[0];
      await assertMachineTextCurrent(q,c);return prior?{request_sha256:prior.request_sha256,response:response(prior.response).value as T}:null;},
    async writeReceipt(q,hash,value){const encoded=response(value),b=machineTextFactBinding(c);
      await q.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,principal_kind,scope_kind,
        target_kind,target_id,request_sha256,response,execution_authorization_id,execution_attempt_id,execution_grant_id,execution_runtime_device_id,execution_connection_id)
        VALUES($1,$2,$3,$4,$5,'person','personal','model_text_step',$6,$7,$8,$9,$10,$11,$12,$13)`,
      [...namespace(),c.binding.stepId,hash,encoded.json,b.authorizationId,b.attemptId,b.grantId,b.runtimeDeviceId,b.connectionId]);
      await assertMachineTextCurrent(q,c);},
  },async q=>{await authorize(q,c);await assertMachineTextCurrent(q,c);authorizeScopedCommand(c);bindScopedExecutionFact(q,c,machineTextFactBinding(c));},
  async q=>response(await run(q,c)).value as T);
  }finally{if(c){forgetScopedCommand(c);forgetMachineTextContext(c);}}
}
