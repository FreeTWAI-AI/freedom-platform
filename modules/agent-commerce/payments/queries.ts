import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {isolatedTransaction} from '../../../packages/resource-scopes/tenant-transaction.js';
import {Problem} from '../../../packages/shared/problem.js';
import {providerEnvironment} from '../operations/admissions.js';
import {applyConfirmedPayment} from '../checkout/payments.js';
import {openException,type PaymentExceptionKind} from '../checkout/exceptions.js';
import {EcpayKeyPair} from '../providers/ecpay/index.js';
import {buildTradeInfoQuery,parseTradeInfoResponse,type TradeInfoResponseResult} from '../providers/ecpay/aio-credit/index.js';
import {activateProviderService,listUsableCredentialVersions,loadServiceCredentials} from './accounts.js';
import type {CommerceCredentialKeyring} from './credentials.js';
import type {PaymentQueryTransport,QueryTransportResult} from './query-transport.js';
import {lockMachinePaymentAttempt,paymentQueryDueAt,hasDefinitePaymentMismatch,settleOrderPayments,PAYMENT_WINDOW_MS,type MachinePaymentAttempt} from './window.js';
import {queuePaymentOutcomeEmail,type CommerceEmailOutbox} from '../operations/notifications/outbox.js';

export type PaymentQueryTrigger='schedule'|'window_end'|'notification'|'browser_return'|'buyer'|'seller'|'repay'|'activation';
export type PaymentQueryError='timeout'|'network'|'response_too_large'|'http_status'|'http_403'|'verify_failed'
  |'merchant_mismatch'|'merchant_trade_no_mismatch'|'platform_mismatch'|'keyring_unavailable'|'credential_unavailable'
  |'throttled'|'tenant_inactive'|'environment_mismatch'|'internal';
export interface PaymentQueryDependencies {
  transport:PaymentQueryTransport; keyring:CommerceCredentialKeyring|null;
  /** Host environment is explicit; providerEnvironment is its sole mapping. */
  freedomEnv:'local'|'staging'|'public'; now?:()=>Date; quarantine?:boolean; signal?:AbortSignal;
  email?:CommerceEmailOutbox;
}
export interface PaymentQueryRun {
  status:TradeInfoResponseResult['kind']|PaymentQueryError|'query_in_progress'|'payment_result_pending'|'skipped';
  externalCalls:0|1; eventId?:string;
}
interface DueRow {due_work_id:string;failure_count:number;lease_until:Date|null;token:string|null}
const timestamp=async(q:PoolClient,deps:Pick<PaymentQueryDependencies,'now'>)=>deps.now?.()??(await q.query<{t:Date}>('SELECT clock_timestamp() AS t')).rows[0].t;
const safeType=(v:string|null)=>v!==null&&/^[A-Za-z0-9_]{1,40}$/.test(v)?v:null;
async function lockEvents(q:PoolClient,id:string) {
  await q.query(`SELECT event_id FROM commerce_hosted_payment_events WHERE attempt_id=$1
    AND source IN ('notification','query') ORDER BY received_at,event_id FOR UPDATE`,[id]);
}
async function dueRow(q:PoolClient,id:string):Promise<DueRow|undefined> {
  return (await q.query<DueRow>(`SELECT *,lease_until::text AS token FROM commerce_due_work
    WHERE kind='payment_query' AND target_id=$1 FOR UPDATE`,[id])).rows[0];
}
async function updateSchedule(q:PoolClient,a:MachinePaymentAttempt,row:DueRow,now:Date,error:PaymentQueryError|null,failureCount:number,unknown=false) {
  const due=await paymentQueryDueAt(q,a,now,failureCount,unknown);
  if(!due)await q.query('DELETE FROM commerce_due_work WHERE due_work_id=$1',[row.due_work_id]);
  else await q.query(`UPDATE commerce_due_work SET due_at=$2,lease_until=NULL,last_error=$3,failure_count=$4,
    updated_at=clock_timestamp() WHERE due_work_id=$1`,[row.due_work_id,due,error,failureCount]);
}
/** Three phases: only immutable identity and in-memory keys leave phase one.
 * isolatedTransaction releases its client before the transport is invoked. */
export async function queryAttempt(pool:Pool,attemptId:string,deps:PaymentQueryDependencies,trigger:PaymentQueryTrigger,
  {leaseToken,tenantId}:{leaseToken?:string;tenantId?:string}={}):Promise<PaymentQueryRun> {
  if(deps.quarantine||deps.signal?.aborted)return {status:'skipped',externalCalls:0};
  const lease=await isolatedTransaction(pool,async q=>{
    const a=await lockMachinePaymentAttempt(q,attemptId,tenantId);
    if(!a)return {run:{status:'skipped',externalCalls:0} as PaymentQueryRun};
    await lockEvents(q,attemptId);
    let row=await dueRow(q,attemptId);
    const now=await timestamp(q,deps);
    if(row?.lease_until && row.lease_until>now && row.token!==leaseToken)
      return {run:{status:'query_in_progress',externalCalls:0} as PaymentQueryRun};
    const due=await paymentQueryDueAt(q,a,now,row?.failure_count??0);
    if(!due || !a.handed_off_at) {
      if(row){
        if(due&&!a.handed_off_at)await q.query('UPDATE commerce_due_work SET attempts=attempts+1 WHERE due_work_id=$1',[row.due_work_id]);
        await updateSchedule(q,a,row,now,null,row.failure_count);
      }
      return {run:{status:'skipped',externalCalls:0} as PaymentQueryRun};
    }
    if(!row)row=(await q.query<DueRow>(`INSERT INTO commerce_due_work(tenant_id,instance_id,kind,target_id,due_at)
      VALUES($1,$2,'payment_query',$3,$4) RETURNING *,lease_until::text AS token`,[a.tenant_id,a.instance_id,a.attempt_id,now])).rows[0];
    const service=(await q.query(`SELECT s.throttled_until,t.status AS tenant_status,i.status AS instance_status
      FROM commerce_provider_account_services s JOIN tenants t ON t.tenant_id=s.tenant_id
      JOIN module_instances i ON i.tenant_id=s.tenant_id AND i.instance_id=s.instance_id
      WHERE s.account_id=$1 AND s.purpose='payment'`,[a.account_id])).rows[0];
    let error:PaymentQueryError|null=service?.throttled_until>now?'throttled'
      :service?.tenant_status!=='active'||service?.instance_status!=='active'?'tenant_inactive'
      :a.environment!==providerEnvironment(deps.freedomEnv)?'environment_mismatch':!deps.keyring?'keyring_unavailable':null;
    let signing:EcpayKeyPair|undefined,verification:{credentialVersion:number;keys:EcpayKeyPair}[]=[];
    if(!error)try {
      signing=(await loadServiceCredentials(q,deps.keyring!,{accountId:a.account_id,purpose:'payment'})).keys;
      for(const version of await listUsableCredentialVersions(q,{accountId:a.account_id,purpose:'payment'})) {
        const c=await loadServiceCredentials(q,deps.keyring!,{accountId:a.account_id,purpose:'payment',credentialVersion:version});
        verification.push({credentialVersion:c.credentialVersion,keys:c.keys});
      }
      if(!verification.length)error='credential_unavailable';
    } catch(e) {
      error=e instanceof Problem && ['commerce_credentials_unavailable','provider_account_not_found'].includes(e.code)?'credential_unavailable':'internal';
      if(error==='internal')console.error('commerce_payment_query_internal');
    }
    if(error) {
      if(error==='throttled')await q.query(`UPDATE commerce_due_work SET due_at=$2,lease_until=NULL,last_error='throttled',
        attempts=attempts+1,updated_at=clock_timestamp() WHERE due_work_id=$1`,[row.due_work_id,service.throttled_until]);
      else {
        await q.query('UPDATE commerce_due_work SET attempts=attempts+1 WHERE due_work_id=$1',[row.due_work_id]);
        await updateSchedule(q,a,row,now,error,row.failure_count+1);
      }
      return {run:{status:error,externalCalls:0} as PaymentQueryRun};
    }
    const claimed=(await q.query<{token:string}>(`UPDATE commerce_due_work SET lease_until=$2::timestamptz+interval '60 seconds',
      attempts=attempts+1,last_query_at=$2,updated_at=clock_timestamp() WHERE due_work_id=$1 RETURNING lease_until::text AS token`,[row.due_work_id,now])).rows[0];
    return {a,token:claimed.token,signing:signing!,verification};
  });
  if(lease.run)return lease.run;
  if(deps.signal?.aborted)return {status:'skipped',externalCalls:0};

  let response:QueryTransportResult|{kind:'error';code:'internal'};
  try {
    // The provider's freshness clock is wall time, even when a local test moves
    // the scheduling clock forward to exercise a confirmation-window deadline.
    const request=buildTradeInfoQuery({environment:lease.a.environment,merchantId:lease.a.merchant_id,
      merchantTradeNo:lease.a.merchant_trade_no,timestampSeconds:Math.floor(Date.now()/1000)},lease.signing);
    response=await deps.transport.send(request,lease.a.environment);
  } catch {
    console.error('commerce_payment_query_internal');response={kind:'error',code:'internal'};
  }

  if(deps.signal?.aborted)return {status:'skipped',externalCalls:1};
  try{return await isolatedTransaction(pool,async q=>{
    if(deps.signal?.aborted)return {status:'skipped',externalCalls:1} as PaymentQueryRun;
    let a=await lockMachinePaymentAttempt(q,attemptId,tenantId);if(!a)throw Error('payment_attempt_missing');
    if(deps.signal?.aborted)return {status:'skipped',externalCalls:1} as PaymentQueryRun;
    await lockEvents(q,attemptId);
    const row=await dueRow(q,attemptId),ours=row?.token===lease.token,now=await timestamp(q,deps);
    let error:PaymentQueryError|null=null,result:TradeInfoResponseResult|undefined,eventId:string|undefined,applied=false;
    if(response.kind==='error')error=response.code;
    else if(response.status===403) {
      error='http_403';
      await q.query(`UPDATE commerce_provider_account_services SET throttled_until=GREATEST(coalesce(throttled_until,$2),$2::timestamptz+interval '30 minutes'),
        version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'
        AND (throttled_until IS NULL OR throttled_until<$2::timestamptz+interval '30 minutes')`,[a.account_id,now]);
    } else if(response.status!==200)error='http_status';
    else {
      result=parseTradeInfoResponse(response.body,lease.verification.map(c=>c.keys),{merchantId:a.merchant_id,
        merchantTradeNo:a.merchant_trade_no,expectedAmountMinor:Number(a.amount_minor),...(a.trade_no?{expectedTradeNo:a.trade_no}:{})});
      if(result.kind==='unknown' && !['missing_field','invalid_field','unrecognized_status'].includes(result.reason)) {
        error=['merchant_mismatch','merchant_trade_no_mismatch','platform_mismatch'].includes(result.reason)
          ?result.reason as PaymentQueryError:'verify_failed';
      } else {
        const r=result,paid=r.kind==='paid'?r:null;
        const inserted=(await q.query<{event_id:string}>(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,
          source,outcome,merchant_trade_no,trade_no,payment_date,payment_type,trade_amt_minor,charge_fee_minor,trade_status,
          handling_charge_minor,unknown_reason,unknown_field,query_trigger,credential_version,body_sha256)
          VALUES($1,$2,$3,$4,'query',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING event_id`,
        [a.tenant_id,a.instance_id,a.account_id,a.attempt_id,r.kind,a.merchant_trade_no,'tradeNo' in r?r.tradeNo:null,
          paid?.paymentDateEpochMs==null?null:new Date(paid.paymentDateEpochMs),paid?safeType(paid.paymentType):null,
          'tradeAmtMinor' in r?r.tradeAmtMinor:null,paid?.chargeFeeMinor??null,
          r.kind==='unknown'?r.tradeStatus??null:r.kind==='unpaid'?'0':r.kind==='failed'?'10200095':'1',
          paid?.handlingChargeMinor??null,r.kind==='unknown'?r.reason:null,r.kind==='unknown'?r.field??null:null,trigger,
          'keyIndex' in r?lease.verification[r.keyIndex].credentialVersion:null,createHash('sha256').update(response.body).digest('hex')])).rows[0];
        eventId=inserted.event_id;applied=await applyQueryResult(q,eventId,{now:()=>now,email:deps.email});
        a=(await q.query<MachinePaymentAttempt>('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[attemptId])).rows[0];
      }
    }
    if(ours && row) {
      if(error==='http_403') {
        const throttle=(await q.query("SELECT throttled_until FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='payment'",[a.account_id])).rows[0].throttled_until;
        await q.query(`UPDATE commerce_due_work SET due_at=$2,lease_until=NULL,last_error='http_403',updated_at=clock_timestamp() WHERE due_work_id=$1`,[row.due_work_id,throttle]);
      } else {
        const failureCount=error || result?.kind==='unknown'?row.failure_count+1:0;
        await updateSchedule(q,a,row,now,error,failureCount,result?.kind==='unknown');
      }
    }
    return {status:eventId&&!applied?'payment_result_pending':error??result?.kind??'internal',externalCalls:1,...(eventId?{eventId}:{})};
  });}catch {
    console.error('commerce_payment_query_internal');
    try{await isolatedTransaction(pool,async q=>{
      const a=await lockMachinePaymentAttempt(q,attemptId,tenantId);if(!a)return;
      await lockEvents(q,attemptId);const row=await dueRow(q,attemptId);
      if(row?.token===lease.token)await updateSchedule(q,a,row,await timestamp(q,deps),'internal',row.failure_count+1);
    });}catch{console.error('commerce_payment_query_internal');}
    throw new PaymentQueryExecutionError();
  }
}

export class PaymentQueryExecutionError extends Error {
  readonly externalCalls=1;
  constructor(){super('payment_query_result_failed');}
}

/** Event application is shared by phase three and ordered deferred replay. */
export async function applyQueryResult(q:PoolClient,eventId:string,options:{now?:()=>Date;updateDueWork?:boolean;email?:CommerceEmailOutbox}={}):Promise<boolean> {
  let e=(await q.query("SELECT * FROM commerce_hosted_payment_events WHERE event_id=$1 AND source='query'",[eventId])).rows[0];
  if(!e || e.applied_at)return false;
  const a=await lockMachinePaymentAttempt(q,e.attempt_id);if(!a)throw Error('payment_attempt_missing');
  e=(await q.query('SELECT *,received_at::text AS receipt_order FROM commerce_hosted_payment_events WHERE event_id=$1 FOR UPDATE',[eventId])).rows[0];
  if(e.applied_at)return false;
  if((await q.query(`SELECT 1 FROM commerce_hosted_payment_events WHERE attempt_id=$1 AND source IN ('notification','query')
    AND applied_at IS NULL AND (received_at,event_id)<($2::timestamptz,$3::uuid) LIMIT 1`,[a.attempt_id,e.receipt_order,eventId])).rowCount)return false;
  const now=options.now?.()??new Date();
  const exception=async(kind:PaymentExceptionKind,once=false)=>{
    if(once && (await q.query('SELECT 1 FROM commerce_exception_cases WHERE kind=$1 AND subject_kind=\'payment_attempt\' AND subject_id=$2 LIMIT 1',[kind,a.attempt_id])).rowCount)return;
    await openException(q,{tenantId:a.tenant_id,instanceId:a.instance_id,orderId:a.order_id,kind,subjectKind:'payment_attempt',subjectId:a.attempt_id});
  };
  const apply=async()=>{
    if(!a.order_id)return null;
    const application=await applyConfirmedPayment(q,{orderId:a.order_id,paymentRef:a.attempt_id,amountMinor:Number(e.trade_amt_minor),currency:a.currency,simulated:false});
    await queuePaymentOutcomeEmail(q,options.email,{tenantId:a.tenant_id,instanceId:a.instance_id,application});
    return application;
  };
  if(e.outcome==='paid') {
    // Recheck against facts recorded during an overlapping notification.
    if(a.trade_no && a.trade_no!==e.trade_no)await exception('contradicting_event',true);
    else if(Number(e.trade_amt_minor)!==Number(a.amount_minor)) {await apply();await exception('amount_mismatch',true);}
    else {
      if(!['paid','confirmed'].includes(a.state))await q.query(`UPDATE commerce_payment_attempts SET state='paid',paid_at=clock_timestamp(),
        trade_no=coalesce(trade_no,$2),payment_date=coalesce(payment_date,$3),payment_type=coalesce(payment_type,$4),
        charge_fee_minor=coalesce(charge_fee_minor,$5),version=version+1 WHERE attempt_id=$1`,[a.attempt_id,e.trade_no,e.payment_date,e.payment_type,e.charge_fee_minor]);
      const application=await apply();
      const cases={unallocatable:'paid_unallocatable',after_cancel:'paid_after_cancel',overpaid:'overpaid'} as const;
      if(application && application.outcome in cases)await exception(cases[application.outcome as keyof typeof cases]);
      if(a.state!=='confirmed')await q.query(`UPDATE commerce_payment_attempts SET state='confirmed',confirmed_at=GREATEST(clock_timestamp(),paid_at),
        payment_date=coalesce(payment_date,$2),payment_type=coalesce(payment_type,$3),charge_fee_minor=coalesce(charge_fee_minor,$4),version=version+1 WHERE attempt_id=$1`,[a.attempt_id,e.payment_date,e.payment_type,e.charge_fee_minor]);
      if(a.kind==='service_activation' && a.state!=='confirmed') {
        await q.query('SAVEPOINT payment_service_activation');
        try {await activateProviderService(q,{accountId:a.account_id,purpose:'payment',activationRef:a.attempt_id});await q.query('RELEASE SAVEPOINT payment_service_activation');}
        catch(error) {
          if(!(error instanceof Problem && error.status===409 && ['provider_service_state','provider_service_conflict'].includes(error.code)))throw error;
          await q.query('ROLLBACK TO SAVEPOINT payment_service_activation');await q.query('RELEASE SAVEPOINT payment_service_activation');
        }
      }
    }
  } else if(e.outcome==='amount_mismatch') {await apply();await exception('amount_mismatch',true);}
  else if(e.outcome==='trade_no_mismatch')await exception('contradicting_event',true);
  else if(e.outcome==='unpaid' || e.outcome==='failed') {
    if(a.state==='paid')await exception('payment_unconfirmed');
    else if(['issued','superseded'].includes(a.state)) {
      if(e.outcome==='failed')await q.query("UPDATE commerce_payment_attempts SET state='failed',failed_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[a.attempt_id]);
      else if(now.getTime()>=a.created_at.getTime()+PAYMENT_WINDOW_MS)await q.query("UPDATE commerce_payment_attempts SET state='expired_unpaid',expired_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1",[a.attempt_id]);
    }
  }
  await q.query('UPDATE commerce_hosted_payment_events SET applied_at=GREATEST(clock_timestamp(),received_at) WHERE event_id=$1',[eventId]);
  if(a.order_id && now.getTime()>=a.created_at.getTime()+PAYMENT_WINDOW_MS)await settleOrderPayments(q,a.order_id);
  if(options.updateDueWork){
    const current=(await q.query<MachinePaymentAttempt>('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[a.attempt_id])).rows[0];
    if(['confirmed','failed','expired_unpaid'].includes(current.state)||await hasDefinitePaymentMismatch(q,current))
      await q.query("DELETE FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[a.attempt_id]);
  }
  return true;
}
