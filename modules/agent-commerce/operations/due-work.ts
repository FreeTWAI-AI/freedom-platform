import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool,PoolClient} from 'pg';
import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {queryAttempt,PaymentQueryExecutionError,type PaymentQueryDependencies,type PaymentQueryTrigger} from '../payments/queries.js';
import {endPaymentWindow,lockMachinePaymentAttempt,paymentQueryDueAt} from '../payments/window.js';
import {endOfflinePaymentWindow} from '../payments/offline/window.js';
import type {EffectJournalPort} from './journal/journal.js';
import {deliverCommerceEmail} from './notifications/delivery.js';
import type {CommerceEmailOutbox,CommerceEmailSender} from './notifications/email-port.js';
export type CommerceDueWorkKind = 'payment_query' | 'payment_window_end' | 'email' | 'offline_payment_window_end';
/** Scheduling never postpones existing work and never changes its tenant. The
 * caller owns the transaction; this helper performs no external operation. */
export async function scheduleDueWork(q: PoolClient, input: {
  tenantId: string;
  instanceId: string;
  kind: CommerceDueWorkKind;
  targetId: string;
  dueAt: Date | string;
}): Promise<void> {
  const result = await q.query(`INSERT INTO commerce_due_work(tenant_id,instance_id,kind,target_id,due_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,target_id) DO UPDATE
    SET due_at=LEAST(commerce_due_work.due_at,EXCLUDED.due_at),updated_at=clock_timestamp()
    WHERE commerce_due_work.tenant_id=EXCLUDED.tenant_id AND commerce_due_work.instance_id=EXCLUDED.instance_id`, [input.tenantId, input.instanceId, input.kind, input.targetId, input.dueAt]);
  if (result.rowCount !== 1)
    throw new Error('due_work_binding_invalid');
}

interface ClaimedWork {due_work_id:string;tenant_id:string;kind:string;target_id:string;token:string}
export interface DueCommerceWorkDependencies {
  transport?:PaymentQueryDependencies['transport'];
  keyring?:PaymentQueryDependencies['keyring'];
  freedomEnv:PaymentQueryDependencies['freedomEnv'];
  now?:()=>Date;
  quarantine?:boolean;
  signal?:AbortSignal;
  email?:CommerceEmailOutbox;
  emailEnabled?:boolean;
  emailSender?:CommerceEmailSender;
  journal?:EffectJournalPort;
  origin?:string;
}
export interface DueCommerceWorkOptions {limit?:number;maxExternalCalls?:number;deadlineMs?:number;targets?:readonly string[];signal?:AbortSignal;trigger?:PaymentQueryTrigger}
const afterResponseSignal=new AsyncLocalStorage<AbortSignal>();
/** A single shared timeout wrapper lets a late transport return abandon its
 * lease rather than write after the request host has started closing its pool. */
export async function runAfterResponseWork(work:()=>Promise<void>,timeoutMs=25_000):Promise<void>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([
    afterResponseSignal.run(controller.signal,async()=>{await work();}),
    new Promise<void>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve();},timeoutMs);}),
  ]);}finally{if(timer)clearTimeout(timer);}
}
export function detachAfterResponse(work:()=>Promise<void>):void{
  void runAfterResponseWork(work).catch(()=>console.error('commerce_after_response_failed'));
}
/** Cross-tenant claiming holds no domain locks and commits before dispatch.
 * Every handler resolves and checks the claimed tenant in its own transaction. */
export async function runDueCommerceWork(pool:Pool,deps:DueCommerceWorkDependencies,options:DueCommerceWorkOptions={}){
  const {limit=200,maxExternalCalls=50,deadlineMs=300_000,targets}=options;
  if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(maxExternalCalls)||maxExternalCalls<0||maxExternalCalls>50
    ||!Number.isFinite(deadlineMs)||deadlineMs<0||deadlineMs>300_000)throw Error('commerce_due_work_limits_invalid');
  const counts={claimed:0,completed:0,failed:0,externalCalls:0,released:0,unknown:0};
  if(deps.quarantine)return counts;
  const signal=options.signal??afterResponseSignal.getStore(),started=Date.now();
  const handlers:Record<string,(row:ClaimedWork)=>Promise<{externalCalls:number}>>={};
  if(deps.keyring&&deps.transport){
    const paymentDeps:PaymentQueryDependencies={transport:deps.transport,keyring:deps.keyring,freedomEnv:deps.freedomEnv,now:deps.now,quarantine:deps.quarantine,signal,email:deps.email};
    handlers.payment_query=row=>queryAttempt(pool,row.target_id,paymentDeps,options.trigger??'schedule',{leaseToken:row.token,tenantId:row.tenant_id});
    handlers.payment_window_end=async row=>{await endPaymentWindow(pool,row.target_id,{now:deps.now,leaseToken:row.token,tenantId:row.tenant_id,signal});return {externalCalls:0};};
  }
  handlers.offline_payment_window_end=async row=>{await endOfflinePaymentWindow(pool,row.target_id,{now:deps.now,leaseToken:row.token,tenantId:row.tenant_id,signal});return {externalCalls:0};};
  if(deps.emailEnabled&&deps.emailSender&&deps.journal&&deps.origin){
    const emailDeps={sender:deps.emailSender,journal:deps.journal,origin:deps.origin,now:deps.now,quarantine:deps.quarantine,signal};
    handlers.email=row=>deliverCommerceEmail(pool,row.target_id,emailDeps,{dueWorkId:row.due_work_id,leaseToken:row.token,tenantId:row.tenant_id});
  }
  const kinds=Object.keys(handlers);
  if(!kinds.length||signal?.aborted||deadlineMs===0)return counts;
  const rows=await isolatedTransaction(pool,async q=>{
    const now=deps.now?.()??null;
    const claimed=(await q.query<ClaimedWork>(`SELECT w.* FROM commerce_due_work w
      WHERE due_at<=coalesce($2::timestamptz,now()) AND (lease_until IS NULL OR lease_until<coalesce($2::timestamptz,now()))
      AND ($3::uuid[] IS NULL OR target_id=ANY($3::uuid[])) AND kind=ANY($4::text[]) ORDER BY due_at,due_work_id FOR UPDATE SKIP LOCKED LIMIT $1`,[limit,now,targets??null,kinds])).rows;
    if(!claimed.length)return [];
    return (await q.query<ClaimedWork>(`UPDATE commerce_due_work SET lease_until=coalesce($2::timestamptz,clock_timestamp())+interval '2 minutes',
      updated_at=clock_timestamp() WHERE due_work_id=ANY($1::uuid[]) RETURNING *,lease_until::text AS token`,[claimed.map(r=>r.due_work_id),now])).rows
      .sort((a,b)=>claimed.findIndex(r=>r.due_work_id===a.due_work_id)-claimed.findIndex(r=>r.due_work_id===b.due_work_id));
  });
  counts.claimed=rows.length;
  const release=async(remaining:ClaimedWork[])=>{
    for(const r of remaining)counts.released+=(await pool.query(`UPDATE commerce_due_work SET lease_until=NULL,updated_at=clock_timestamp()
      WHERE due_work_id=$1 AND lease_until=$2::timestamptz`,[r.due_work_id,r.token])).rowCount??0;
  };
  for(let i=0;i<rows.length;i++){
    if(counts.externalCalls>=maxExternalCalls||Date.now()-started>=deadlineMs||signal?.aborted){await release(rows.slice(i));break;}
    const row=rows[i],handler=handlers[row.kind];
    if(!handler){console.warn('commerce_due_work_unknown_kind',row.kind);counts.unknown++;continue;}
    try{counts.externalCalls+=(await handler(row)).externalCalls;counts.completed++;}
    catch(error){
      counts.failed++;if(error instanceof PaymentQueryExecutionError)counts.externalCalls+=error.externalCalls;
      console.error(JSON.stringify({event:'commerce_due_work_failed',kind:row.kind,code:'internal'}));
      try{await isolatedTransaction(pool,async q=>{
        if(row.kind==='email'||row.kind==='offline_payment_window_end'){
          const current=(await q.query(`SELECT *,lease_until::text AS token FROM commerce_due_work WHERE due_work_id=$1 FOR UPDATE`,[row.due_work_id])).rows[0];
          if(!current||current.token!==row.token)return;
          const now=deps.now?.()??new Date();
          await q.query(`UPDATE commerce_due_work SET due_at=$2::timestamptz+interval '1 minute',lease_until=NULL,last_error='internal',
            failure_count=$3,updated_at=clock_timestamp() WHERE due_work_id=$1`,[row.due_work_id,now,current.failure_count+1]);
          return;
        }
        const a=await lockMachinePaymentAttempt(q,row.target_id,row.tenant_id);if(!a)return;
        const current=(await q.query(`SELECT *,lease_until::text AS token FROM commerce_due_work WHERE due_work_id=$1 FOR UPDATE`,[row.due_work_id])).rows[0];
        // A query may already have extended the claim. Its own lease expires;
        // this runner never releases or overwrites somebody else's token.
        if(!current||current.token!==row.token)return;
        const now=deps.now?.()??new Date(),failure=current.failure_count+1;
        const due=await paymentQueryDueAt(q,a,now,failure);
        if(due)await q.query(`UPDATE commerce_due_work SET due_at=$2,lease_until=NULL,last_error='internal',failure_count=$3,
          updated_at=clock_timestamp() WHERE due_work_id=$1`,[row.due_work_id,due,failure]);
      });}catch{console.error(JSON.stringify({event:'commerce_due_work_failed',kind:row.kind,code:'internal'}));}
    }
  }
  return counts;
}
