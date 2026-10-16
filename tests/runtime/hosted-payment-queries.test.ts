import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ECPAY_ORIGINS, EcpayKeyPair, newTradeNumber } from '../../modules/agent-commerce/providers/ecpay/index.js';
import { buildTradeInfoQuery, type EcpayServerRequest } from '../../modules/agent-commerce/providers/ecpay/aio-credit/index.js';
import { createEcpayQueryTransport, createFixtureQueryTransport, assertQueryTransportInstallation } from '../../modules/agent-commerce/payments/query-transport.js';

const request = (environment: 'sandbox' | 'live' = 'sandbox') => buildTradeInfoQuery({
  environment, merchantId: '1234567', merchantTradeNo: newTradeNumber('F'), timestampSeconds: Math.floor(Date.now() / 1000),
}, EcpayKeyPair.of(randomBytes(8).toString('hex'), randomBytes(8).toString('hex')));
const fetchStub = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (url, init) => handler(String(url), init!)) as typeof fetch;

for (const environment of ['sandbox', 'live'] as const)
  test(`query transport sends the library request only to ${environment}`, async () => {
    const input = request(environment);
    let calls = 0;
    const transport = createEcpayQueryTransport({ fetch: fetchStub((url, init) => {
      calls++;
      assert.equal(url, ECPAY_ORIGINS.payment[environment] + '/Cashier/QueryTradeInfo/V5');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
      assert.deepEqual(init.headers, { 'Content-Type': input.contentType });
      assert.equal(init.body, input.bodyText());
      assert(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
      return new Response('signed=response');
    }) });
    assert.deepEqual(await transport.send(input, environment), { kind: 'response', status: 200, body: 'signed=response' });
    assert.equal(calls, 1);
  });
test('query transport refuses every other host, environment, path and URL adornment before fetch', async () => {
  let calls = 0;
  const transport = createEcpayQueryTransport({ fetch: fetchStub(() => { calls++; throw Error('must never fetch'); }) });
  const origin = ECPAY_ORIGINS.payment.sandbox, path = '/Cashier/QueryTradeInfo/V5';
  for (const url of ['https://other.example.test' + path, ECPAY_ORIGINS.payment.live + path,
    ECPAY_ORIGINS.logistics.sandbox + path, 'http://payment-stage.ecpay.com.tw' + path,
    origin + ':8443' + path, origin + '/Cashier/AioCheckOut/V5', origin + path + '/',
    origin + path + '?credential=redacted', origin + path + '#fragment',
    'https://user:password@payment-stage.ecpay.com.tw' + path, 'invalid']) {
    await assert.rejects(transport.send({ url } as EcpayServerRequest, 'sandbox'), { message: 'transport_host_refused' });
  }
  assert.equal(calls, 0);
});
test('query transport distinguishes timeout and network failures with fixed codes', async () => {
  for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
    const transport = createEcpayQueryTransport({ fetch: fetchStub(() => { throw new DOMException('do not retain provider details', name); }) });
    assert.deepEqual(await transport.send(request(), 'sandbox'), { kind: 'error', code: name === 'TypeError' ? 'network' : 'timeout' });
  }
});
test('query transport aborts both fetch and a stalled response stream after ten seconds', async () => {
  const signals: AbortSignal[] = [];
  let now = 0;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    assert.equal(ms, 10_000); now++;
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException('expired', 'TimeoutError')));
    signals.push(controller.signal); return controller.signal;
  };
  try {
    const transport = createEcpayQueryTransport({ fetch: fetchStub(async (_url, init) => {
      await Promise.resolve(); init.signal!.throwIfAborted(); throw Error('unreachable');
    }) });
    assert.deepEqual(await transport.send(request(), 'sandbox'), { kind: 'error', code: 'timeout' });
    const streaming = createEcpayQueryTransport({ fetch: fetchStub((_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }); },
    }))) });
    assert.deepEqual(await streaming.send(request(), 'sandbox'), { kind: 'error', code: 'timeout' });
    assert.equal(now, 2); assert(signals.every(signal => signal.aborted));
  }
  finally { AbortSignal.timeout = originalTimeout; }
});
test('query transport accepts exactly 64 KiB and stops reading the first oversized chunk', async () => {
  const exact = createEcpayQueryTransport({ fetch: fetchStub(() => new Response('a'.repeat(65536))) });
  const result = await exact.send(request(), 'sandbox');
  assert.equal(result.kind, 'response'); if (result.kind === 'response') assert.equal(result.body.length, 65536);
  let pulls = 0, cancelled = 0;
  const oversized = createEcpayQueryTransport({ fetch: fetchStub(() => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(32769)); },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 }))) });
  assert.deepEqual(await oversized.send(request(), 'sandbox'), { kind: 'error', code: 'response_too_large' });
  assert.equal(pulls, 2); assert.equal(cancelled, 1);
});
test('query transport limits bytes rather than UTF-16 code units', async () => {
  const transport = createEcpayQueryTransport({ fetch: fetchStub(() => new Response('字'.repeat(22000))) });
  assert.deepEqual(await transport.send(request(), 'sandbox'), { kind: 'error', code: 'response_too_large' });
});
test('query transport retains 403 and other statuses without reading or following them', async () => {
  for (const status of [302, 307, 403, 429, 500]) {
    let cancelled = 0, reads = 0;
    const transport = createEcpayQueryTransport({ fetch: fetchStub((_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 }),
        { status, headers: { Location: 'https://other.example.test/private' } });
    }) });
    assert.deepEqual(await transport.send(request(), 'sandbox'), { kind: 'response', status, body: '' });
    assert.equal(reads, 0); assert.equal(cancelled, 1);
  }
});
test('fixture query transport requires an explicit local environment at construction and installation', async () => {
  for (const environment of ['staging', 'public'] as const)
    assert.throws(() => createFixtureQueryTransport(async () => ({ kind: 'error', code: 'network' }), environment), { message: 'payment_fixture_requires_local' });
  const fixture = createFixtureQueryTransport(async input => ({ kind: 'response', status: 200, body: input.bodyText() }), 'local');
  const input = request();
  assert.deepEqual(await fixture.send(input, 'sandbox'), { kind: 'response', status: 200, body: input.bodyText() });
  assertQueryTransportInstallation(fixture, 'local');
  for (const environment of ['staging', 'public'] as const)
    assert.throws(() => assertQueryTransportInstallation(fixture, environment), { message: 'payment_fixture_requires_local' });
});

import {describe,before,beforeEach,after} from 'node:test';
import {hostedPaymentHarness} from '../e2e/hosted-payment-fixture.js';
import {encodeForm,signFields,aio} from '../../modules/agent-commerce/providers/ecpay/index.js';
import {applyDeferredPaymentEvents} from '../../modules/agent-commerce/payments/events.js';
import {lockMachinePaymentAttempt,endPaymentWindow,paymentQueryDueAt,settleOrderPayments} from '../../modules/agent-commerce/payments/window.js';
import {cancelUnpaidOrder} from '../../modules/agent-commerce/checkout/orders.js';
import {sweepDueCheckoutHolds} from '../../modules/agent-commerce/checkout/settlement.js';
import {sealCredential} from '../../modules/agent-commerce/payments/credentials.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {queryAttempt,applyQueryResult,type PaymentQueryDependencies} from '../../modules/agent-commerce/payments/queries.js';

describe('payment query engine',()=>{
  let f:Awaited<ReturnType<typeof hostedPaymentHarness>>;
  type Placed=Awaited<ReturnType<typeof f.placed>>;
  before(async()=>{f=await hostedPaymentHarness('fp_payment_queries');});
  beforeEach(async()=>f.reset());
  after(async()=>f?.stop());
  const facts=async(p:Placed)=>({
    attempt:(await f.x.h.pool.query('SELECT * FROM commerce_payment_attempts WHERE attempt_id=$1',[p.payment.attempt_ref])).rows[0],
    due:(await f.x.h.pool.query("SELECT *,lease_until::text AS token FROM commerce_due_work WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref])).rows[0],
    events:(await f.x.h.pool.query("SELECT * FROM commerce_hosted_payment_events WHERE attempt_id=$1 ORDER BY received_at,event_id",[p.payment.attempt_ref])).rows,
    applications:(await f.x.h.pool.query('SELECT * FROM commerce_checkout_payment_applications ORDER BY created_at,application_id')).rows,
    cases:(await f.x.h.pool.query('SELECT * FROM commerce_exception_cases ORDER BY created_at,case_id')).rows,
  });
  async function handed(p:Placed){await f.x.h.pool.query(`UPDATE commerce_payment_attempts SET journaled_at=clock_timestamp(),handed_off_at=clock_timestamp(),version=version+1 WHERE attempt_id=$1`,[p.payment.attempt_ref]);return p;}
  async function response(p:Placed,overrides:Record<string,string>={},material=p.provider.material){
    const a=(await facts(p)).attempt;
    return encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:a.merchant_trade_no,TradeStatus:'1',TradeNo:'T1234567',TradeAmt:'5',PaymentDate:'2026/10/15 10:20:30',PaymentType:'Credit_CreditCard',HandlingCharge:'0.2',PaymentTypeChargeFee:'0.3',...overrides},EcpayKeyPair.of(material.hash_key,material.hash_iv),'sha256'));
  }
  const deps=(handler:Parameters<typeof createFixtureQueryTransport>[0],extra:Partial<PaymentQueryDependencies>={}):PaymentQueryDependencies=>({transport:createFixtureQueryTransport(handler,'local'),keyring:f.ring,freedomEnv:'local',...extra});
  async function run(p:Placed,overrides:Record<string,string>={},extra:Partial<PaymentQueryDependencies>={}){const body=await response(p,overrides);return queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>({kind:'response',status:200,body}),extra),'buyer');}
  test('paid facts are committed and the client released before the provider call; one application on replay',async()=>{
    const p=await handed(await f.placed()),body=await response(p);
    const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{
      assert.equal(f.x.runtime.totalCount,f.x.runtime.idleCount,'no client may stay checked out during transport');
      const a=await facts(p);assert(a.due.lease_until);assert.equal(a.due.attempts,1);assert(a.due.last_query_at);
      return {kind:'response',status:200,body};
    }),'buyer');
    assert.equal(result.status,'paid');const a=await facts(p);
    assert.equal(a.attempt.state,'confirmed');assert.equal(a.applications.length,1);assert.equal(a.applications[0].outcome,'converted');
    assert.equal(a.events[0].source,'query');assert(a.events[0].applied_at);assert.equal(a.events[0].credential_version,1);
    assert.equal(a.events[0].handling_charge_minor,'20');assert.equal(a.attempt.charge_fee_minor,'30');assert.equal(a.due,undefined);
    assert.equal((await run(p)).externalCalls,0);assert.equal((await facts(p)).applications.length,1);
  });
  test('a paid query without PaymentDate is applied',async()=>{
    const p=await handed(await f.placed());assert.equal((await run(p,{PaymentDate:''})).status,'paid');
    const a=await facts(p);assert.equal(a.attempt.state,'confirmed');assert.equal(a.attempt.payment_date,null);assert.equal(a.events[0].payment_date,null);
  });
  test('current credentials sign each new request while an older usable version verifies the response',async()=>{
    const p=await handed(await f.placed()),material={hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex')};
    const sealed=sealCredential(f.ring,{account_id:p.provider.accountId,purpose:'payment',environment:'sandbox',credential_version:2},material);
    await f.x.tx(async q=>{await bindStore(q,p.s.tenantId);await q.query(`INSERT INTO commerce_provider_credentials(account_id,purpose,credential_version,tenant_id,instance_id,environment,key_id,sealed,created_by_principal_id)
      SELECT account_id,'payment',2,tenant_id,instance_id,environment,$2,$3,created_by_principal_id FROM commerce_provider_accounts WHERE account_id=$1`,[p.provider.accountId,sealed.key_id,sealed.sealed]);await q.query("UPDATE commerce_provider_account_services SET credential_version=2,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'",[p.provider.accountId]);});
    const body=await response(p);
    assert.equal((await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async req=>{
      assert(aio.verify(req.bodyText(),EcpayKeyPair.of(material.hash_key,material.hash_iv)).ok);
      assert.equal(aio.verify(req.bodyText(),EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv)).ok,false);
      return {kind:'response',status:200,body};
    }),'buyer')).status,'paid');assert.equal((await facts(p)).events[0].credential_version,1);
  });
  test('each retry rebuilds its timestamp and signature',async()=>{
    const p=await handed(await f.placed()),body=await response(p,{TradeStatus:'0'}),requests:string[]=[],original=Date.now;
    let wall=original();Date.now=()=>wall;
    try{const d=deps(async req=>{requests.push(req.bodyText());return {kind:'response',status:200,body};});
      await queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'buyer');wall+=1000;await queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'buyer');
    }finally{Date.now=original;}
    const first=new URLSearchParams(requests[0]),second=new URLSearchParams(requests[1]);
    assert.equal(Number(second.get('TimeStamp'))-Number(first.get('TimeStamp')),1);assert.notEqual(first.get('CheckMacValue'),second.get('CheckMacValue'));
  });
  test('two live queries take one lease and make one call',async()=>{
    const p=await handed(await f.placed()),body=await response(p,{TradeStatus:'0'});let release!:()=>void,entered!:()=>void,calls=0;
    const waiting=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
    const d=deps(async()=>{calls++;entered();await waiting;return {kind:'response',status:200,body};});
    const first=queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'buyer');await started;
    const before=await facts(p),second=await queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'buyer');
    assert.equal(second.status,'query_in_progress');assert.deepEqual((await facts(p)).due,before.due);
    release();assert.equal((await first).status,'unpaid');assert.equal(calls,1);
  });
  test('lost lease still records and applies paid facts without changing the new lease',async()=>{
    const p=await handed(await f.placed()),body=await response(p);let token:string|undefined;
    const r=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{
      token=(await f.x.h.pool.query("UPDATE commerce_due_work SET lease_until=clock_timestamp()+interval '2 minutes' WHERE kind='payment_query' AND target_id=$1 RETURNING lease_until::text token",[p.payment.attempt_ref])).rows[0].token;
      return {kind:'response',status:200,body};
    }),'buyer');assert.equal(r.status,'paid');const a=await facts(p);assert.equal(a.attempt.state,'confirmed');assert.equal(a.due.token,token);assert.equal(a.applications.length,1);
  });
  for(const [label,fields,error] of [
    ['merchant',{MerchantID:'7654321'},'merchant_mismatch'],['trade',{MerchantTradeNo:newTradeNumber('F')},'merchant_trade_no_mismatch'],
    ['platform',{PlatformID:'1234567'},'platform_mismatch'],['signature',{},'verify_failed'],
  ] as const)test(`a ${label} failure stores no body or event`,async()=>{
    const p=await handed(await f.placed());let body=await response(p,fields);
    if(label==='signature')body=body.replace(/CheckMacValue=[A-F0-9]+/i,'CheckMacValue='+'0'.repeat(64));
    const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>({kind:'response',status:200,body})),'buyer');
    assert.equal(result.status,error);const a=await facts(p);assert.equal(a.events.length,0);assert.equal(a.due.last_error,error);assert.equal(a.due.failure_count,1);
  });
  for(const body of ['', 'invalid', 'MerchantID=1234567', 'x=%FF', 'a=1&A=2', 'x='+'a'.repeat(66000)])test(`unverified form ${body.length} bytes leaves no event`,async()=>{
    const p=await handed(await f.placed());const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>({kind:'response',status:200,body})),'buyer');
    assert.equal(result.status,'verify_failed');assert.equal((await facts(p)).events.length,0);
  });
  for(const [label,fields,reason,field,status] of [
    ['missing',{TradeNo:''},'missing_field','TradeNo',null],['invalid',{TradeAmt:'invalid'},'invalid_field','TradeAmt',null],
    ['unknown',{TradeStatus:'777'},'unrecognized_status',null,'777'],
  ] as const)test(`verified ${label} response keeps only its parsed facts`,async()=>{
    const p=await handed(await f.placed());assert.equal((await run(p,fields)).status,'unknown');const a=await facts(p);
    assert.equal(a.events.length,1);assert.equal(a.events[0].unknown_reason,reason);assert.equal(a.events[0].unknown_field,field);
    assert.equal(a.events[0].trade_status,status);assert.equal(a.events[0].credential_version,null);assert.equal(a.due.failure_count,1);assert.equal(a.due.last_error,null);
  });
  for(const code of ['timeout','network','response_too_large'] as const)test(`${code} backs off without an event`,async()=>{
    const p=await handed(await f.placed());assert.equal((await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>({kind:'error',code})),'buyer')).status,code);
    const a=await facts(p);assert.equal(a.events.length,0);assert.equal(a.due.failure_count,1);assert.equal(a.due.last_error,code);assert.equal(a.due.lease_until,null);
  });
  for(const status of [302,500])test(`HTTP ${status} becomes a fixed http_status error`,async()=>{
    const p=await handed(await f.placed());assert.equal((await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>({kind:'response',status,body:'private'})),'buyer')).status,'http_status');assert.equal((await facts(p)).events.length,0);
  });
  test('HTTP 403 throttles payment queries on that account without advancing failure count',async()=>{
    const p=await handed(await f.placed()),now=new Date();
    await f.x.tx(async q=>{
      await bindStore(q,p.s.tenantId);
      for(const [purpose,profile] of [['logistics','ecpay.logistics.domestic.v1'],['invoice','ecpay.invoice.b2c.v1']] as const){
        const sealed=sealCredential(f.ring,{account_id:p.provider.accountId,purpose,environment:'sandbox',credential_version:1},{hash_key:randomBytes(8).toString('hex'),hash_iv:randomBytes(8).toString('hex')});
        await q.query(`INSERT INTO commerce_provider_account_services(account_id,purpose,tenant_id,instance_id,environment,profile,credential_version)
          SELECT account_id,$2,tenant_id,instance_id,environment,$3,1 FROM commerce_provider_accounts WHERE account_id=$1`,[p.provider.accountId,purpose,profile]);
        await q.query(`INSERT INTO commerce_provider_credentials(account_id,purpose,credential_version,tenant_id,instance_id,environment,key_id,sealed,created_by_principal_id)
          SELECT account_id,$2,1,tenant_id,instance_id,environment,$3,$4,created_by_principal_id FROM commerce_provider_accounts WHERE account_id=$1`,[p.provider.accountId,purpose,sealed.key_id,sealed.sealed]);
      }
    });
    const untouched=(await f.x.h.pool.query("SELECT * FROM commerce_provider_account_services WHERE account_id=$1 AND purpose<>'payment' ORDER BY purpose",[p.provider.accountId])).rows;
    await f.x.h.pool.query("UPDATE commerce_due_work SET failure_count=2 WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref]);
    const d=deps(async()=>({kind:'response',status:403,body:''}),{now:()=>now});
    assert.equal((await queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'buyer')).status,'http_403');
    let a=await facts(p);assert.equal(a.due.failure_count,2);assert.equal(a.due.due_at.getTime(),now.getTime()+30*60_000);
    assert.equal((await queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'buyer')).status,'throttled');
    a=await facts(p);assert.equal(a.due.failure_count,2);assert.equal(a.due.last_error,'throttled');assert.equal(a.events.length,0);
    assert.deepEqual((await f.x.h.pool.query("SELECT * FROM commerce_provider_account_services WHERE account_id=$1 AND purpose<>'payment' ORDER BY purpose",[p.provider.accountId])).rows,untouched);
    const other=await handed(await f.placed());assert.equal((await run(other,{TradeStatus:'0'})).status,'unpaid');
  });
  for(const refusal of ['unhanded','keyring','environment','inactive','quarantine'] as const)test(`${refusal} makes no provider call`,async()=>{
    const p=await f.placed();if(refusal!=='unhanded')await handed(p);
    if(refusal==='inactive')await f.x.h.pool.query("UPDATE tenants SET status='suspended',version=version+1 WHERE tenant_id=$1",[p.s.tenantId]);
    let calls=0;const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{calls++;throw Error('must not call');},
      refusal==='keyring'?{keyring:null}:refusal==='environment'?{freedomEnv:'public'}:refusal==='quarantine'?{quarantine:true}:{}),'buyer');
    assert.equal(calls,0);assert.equal(result.externalCalls,0);assert.equal(result.status,refusal==='keyring'?'keyring_unavailable':refusal==='environment'?'environment_mismatch':refusal==='inactive'?'tenant_inactive':'skipped');
  });
  test('an unhanded scheduled run increments runs without a provider timestamp or failure',async()=>{
    const p=await f.placed(),a=(await facts(p)).attempt;
    const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{throw Error('must_not_call');},{now:()=>new Date(a.created_at.getTime()+600_000)}),'schedule');
    assert.equal(result.externalCalls,0);const current=await facts(p);assert.equal(current.due.attempts,1);assert.equal(current.due.failure_count,0);assert.equal(current.due.last_query_at,null);assert.equal(current.due.due_at.getTime(),a.created_at.getTime()+1200_000);
  });
  test('an unusable host keyring backs off without a query or retained key material',async()=>{
    const p=await handed(await f.placed());let calls=0;
    const {CommerceCredentialKeyring}=await import('../../modules/agent-commerce/payments/credentials.js');
    const ring=CommerceCredentialKeyring.parse('wrong:'+randomBytes(32).toString('base64'))!;
    const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{calls++;throw Error('must_not_call');},{keyring:ring}),'buyer');
    assert.equal(result.status,'credential_unavailable');assert.equal(calls,0);const current=await facts(p);assert.equal(current.due.failure_count,1);assert.equal(current.due.last_error,'credential_unavailable');assert.equal(current.events.length,0);
  });
  test('an overlapping 403 preserves a longer throttle on a retired payment service',async()=>{
    const p=await handed(await f.placed()),now=new Date(),longer=new Date(now.getTime()+40*60_000);
    await f.x.h.pool.query("UPDATE commerce_provider_account_services SET state='retired',version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'",[p.provider.accountId]);
    await f.x.h.pool.query("UPDATE commerce_due_work SET failure_count=2 WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref]);
    const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{
      // Another in-flight query can commit a later throttle after this lease.
      await f.x.h.pool.query("UPDATE commerce_provider_account_services SET throttled_until=$2,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'",[p.provider.accountId,longer]);
      return {kind:'response',status:403,body:''};
    },{now:()=>now}),'buyer');
    assert.equal(result.status,'http_403');assert.equal(result.externalCalls,1);
    const a=await facts(p);assert.equal(a.due.failure_count,2);assert.equal(a.due.last_error,'http_403');
    assert.equal(a.due.due_at.getTime(),longer.getTime());assert.equal(a.due.lease_until,null);assert.equal(a.events.length,0);
    const service=(await f.x.h.pool.query("SELECT * FROM commerce_provider_account_services WHERE account_id=$1 AND purpose='payment'",[p.provider.accountId])).rows[0];
    assert.equal(service.state,'retired');assert.equal(service.throttled_until.getTime(),longer.getTime());
  });
  test('an inactive instance refuses machine queries without an HTTP error or external call',async()=>{
    const p=await handed(await f.placed());await f.x.h.pool.query("UPDATE module_instances SET status='suspended' WHERE instance_id=$1",[p.s.instanceId]);
    const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{throw Error('must_not_call');}),'schedule');assert.equal(result.status,'tenant_inactive');assert.equal(result.externalCalls,0);assert.equal((await facts(p)).due.last_error,'tenant_inactive');
  });
  for(const state of ['suspended','retired'] as const)test(`queries reconcile a ${state} service and an unlisted profile`,async()=>{
    const p=await handed(await f.placed());await f.x.h.pool.query("UPDATE commerce_provider_account_services SET state=$2,version=version+1,updated_at=clock_timestamp() WHERE account_id=$1 AND purpose='payment'",[p.provider.accountId,state]);f.settings.providerProfiles=[];
    assert.equal((await run(p)).status,'paid');assert.equal((await facts(p)).attempt.state,'confirmed');
  });
  async function setState(p:Placed,state:string){
    if(state==='issued')return;
    if(state==='confirmed'){await run(p);return;}
    await f.x.h.pool.query(`UPDATE commerce_payment_attempts SET state=$2,version=version+1,
      paid_at=CASE WHEN $2='paid' THEN clock_timestamp() ELSE paid_at END,
      trade_no=CASE WHEN $2='paid' THEN 'T1234567' ELSE trade_no END,
      failed_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE failed_at END,
      superseded_at=CASE WHEN $2='superseded' THEN clock_timestamp() ELSE superseded_at END,
      expired_at=CASE WHEN $2='expired_unpaid' THEN clock_timestamp() ELSE expired_at END WHERE attempt_id=$1`,[p.payment.attempt_ref,state]);
  }
  async function event(p:Placed,outcome:string,now?:Date,apply=true){
    return f.x.tx(async q=>{
      await lockMachinePaymentAttempt(q,p.payment.attempt_ref);
      const e=(await q.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome,
        merchant_trade_no,trade_no,trade_amt_minor,credential_version,body_sha256,query_trigger,unknown_reason,trade_status)
        SELECT tenant_id,instance_id,account_id,attempt_id,'query',$2,merchant_trade_no,
        CASE WHEN $2 IN ('paid','amount_mismatch','trade_no_mismatch') THEN CASE WHEN $2='trade_no_mismatch' THEN 'TOTHER' ELSE 'T1234567' END END,
        CASE WHEN $2='paid' THEN amount_minor WHEN $2='amount_mismatch' THEN amount_minor+100 END,
        CASE WHEN $2<>'unknown' THEN credential_version END,repeat('a',64),'schedule',
        CASE WHEN $2='unknown' THEN 'unrecognized_status' END,CASE WHEN $2='unknown' THEN '777' END
        FROM commerce_payment_attempts WHERE attempt_id=$1 RETURNING event_id`,[p.payment.attempt_ref,outcome])).rows[0];
      if(apply)assert(await applyQueryResult(q,e.event_id,{...(now?{now:()=>now}:{}),updateDueWork:true}));return e.event_id as string;
    });
  }
  for(const state of ['issued','superseded','paid','confirmed','failed','expired_unpaid'])
    for(const outcome of ['paid','amount_mismatch','trade_no_mismatch','unpaid','failed','unknown'])
      test(`result table: ${state} receives ${outcome}`,async()=>{
        const p=await handed(await f.placed());await setState(p,state);await event(p,outcome);
        const a=await facts(p),expected=outcome==='paid'?'confirmed':outcome==='failed'&&['issued','superseded'].includes(state)?'failed':state;
        assert.equal(a.attempt.state,expected);
        const expectedCase=outcome==='amount_mismatch'?'amount_mismatch':outcome==='trade_no_mismatch'?'contradicting_event':state==='paid'&&['unpaid','failed'].includes(outcome)?'payment_unconfirmed':null;
        assert.deepEqual(a.cases.map(c=>c.kind),expectedCase?[expectedCase]:[]);
        if(outcome==='paid')assert.equal(a.applications.length,1);
        else if(outcome==='trade_no_mismatch')assert.equal(a.applications.length,state==='confirmed'?1:0);
        else if(outcome==='amount_mismatch'){assert.equal(a.applications.length,1);assert.equal(a.applications[0].outcome,state==='confirmed'?'converted':'amount_mismatch');}
      });
  for(const minute of [0,9,10,19,20,39,40,59])test(`slot schedule at minute ${minute}`,async()=>{
    const p=await handed(await f.placed()),a=(await facts(p)).attempt,now=new Date(a.created_at.getTime()+minute*60_000);
    await run(p,{TradeStatus:'0'},{now:()=>now});const due=(await facts(p)).due;
    assert.equal(due.due_at.getTime(),a.created_at.getTime()+[10,20,40,60].find(m=>m>minute)!*60_000);
  });
  test('transport backoff follows 1/2/5/10 minutes, caps at slots, and resets on a definite result',async()=>{
    const p=await handed(await f.placed()),a=(await facts(p)).attempt;let now=new Date(a.created_at.getTime()+60*60_000);
    for(const minutes of [1,2,5,10,10]){
      const d=deps(async()=>({kind:'error',code:'timeout'}),{now:()=>now});await queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'schedule');
      const due=(await facts(p)).due;assert.equal(due.due_at.getTime(),now.getTime()+minutes*60_000);now=due.due_at;
    }
    // A pre-window definite response keeps the attempt queryable and resets failures.
    now=new Date(a.created_at.getTime()+9*60_000+59_000);
    await run(p,{TradeStatus:'0'},{now:()=>now});const due=(await facts(p)).due;
    assert.equal(due.failure_count,0);assert.equal(due.due_at.getTime(),a.created_at.getTime()+10*60_000);
  });
  test('verified unknown after the window uses ten minutes and stops at 24 hours with an exception',async()=>{
    const p=await handed(await f.placed()),a=(await facts(p)).attempt,window=a.created_at.getTime()+60*60_000;
    await run(p,{TradeStatus:'777'},{now:()=>new Date(window)});assert.equal((await facts(p)).due.due_at.getTime(),window+10*60_000);
    let calls=0;const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{calls++;throw Error();},{now:()=>new Date(window+24*60*60_000)}),'schedule');
    assert.equal(calls,0);assert.equal(result.status,'skipped');const actual=await facts(p);assert.equal(actual.due,undefined);assert.deepEqual(actual.cases.map(c=>c.kind),['payment_unconfirmed']);
  });
  test('paid-but-unconfirmed opens its 60-minute case and stops after 24 hours',async()=>{
    const p=await handed(await f.placed());await setState(p,'paid');const a=(await facts(p)).attempt;
    await run(p,{TradeStatus:'777'},{now:()=>new Date(a.paid_at.getTime()+60*60_000)});
    assert.deepEqual((await facts(p)).cases.map(c=>c.kind),['payment_unconfirmed']);assert((await facts(p)).due);
    assert.equal((await run(p,{TradeStatus:'777'},{now:()=>new Date(a.paid_at.getTime()+24*60*60_000)})).externalCalls,0);assert.equal((await facts(p)).due,undefined);
  });
  for(const handedOff of [false,true])for(const state of ['issued','superseded','paid','confirmed','failed','expired_unpaid'])
    test(`window end: ${state}, handed off ${handedOff}`,async()=>{
      const p=await f.placed();if(handedOff||state==='confirmed')await handed(p);await setState(p,state);
      const a=(await facts(p)).attempt,now=new Date(a.created_at.getTime()+60*60_000);
      assert.equal(await endPaymentWindow(f.x.runtime,p.payment.attempt_ref,{now:()=>now}),'completed');
      const actual=await facts(p);assert.equal(actual.attempt.state,!handedOff&&['issued','superseded'].includes(state)?'expired_unpaid':state);
      assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM commerce_due_work WHERE target_id=$1 AND kind='payment_window_end'",[p.payment.attempt_ref])).rows[0].n,0);
      const order=(await f.x.h.pool.query('SELECT lifecycle_state FROM commerce_checkout_orders WHERE order_id=$1',[p.order.order_ref])).rows[0];
      assert.equal(order.lifecycle_state,!handedOff&&['issued','superseded'].includes(state)?'cancelled':'open');
    });
  test('unpaid at window end expires and cancels; a late paid fact applies after_cancel',async()=>{
    const p=await handed(await f.placed()),a=(await facts(p)).attempt,now=new Date(a.created_at.getTime()+60*60_000);
    await run(p,{TradeStatus:'0'},{now:()=>now});assert.equal((await facts(p)).attempt.state,'expired_unpaid');
    assert.equal((await f.x.h.pool.query('SELECT cancel_reason FROM commerce_checkout_orders WHERE order_id=$1',[p.order.order_ref])).rows[0].cancel_reason,'payment_not_completed');
    await event(p,'paid',now);const actual=await facts(p);assert.equal(actual.attempt.state,'confirmed');assert.equal(actual.applications[0].outcome,'after_cancel');assert.equal(actual.cases[0].kind,'paid_after_cancel');
    // Cancellation replay has no inventory, token or due-work side effects.
    await f.x.tx(async q=>{await lockMachinePaymentAttempt(q,p.payment.attempt_ref);assert.equal(await settleOrderPayments(q,p.order.order_ref),false);});
  });
  test('a deferred failed notification precedes a paid query without a contradicting case',async()=>{
    const p=await handed(await f.placed()),a=(await facts(p)).attempt;
    await f.x.h.pool.query(`INSERT INTO commerce_hosted_payment_events(tenant_id,instance_id,account_id,attempt_id,source,outcome,merchant_trade_no,rtn_code,simulate_paid,credential_version,body_sha256,dedupe_key)
      VALUES($1,$2,$3,$4,'notification','failed',$5,0,false,1,repeat('a',64),repeat('b',64))`,[a.tenant_id,a.instance_id,a.account_id,a.attempt_id,a.merchant_trade_no]);
    assert.equal((await run(p)).status,'payment_result_pending');let actual=await facts(p);assert(actual.events.every(e=>!e.applied_at));assert.equal(actual.applications.length,0);
    assert.deepEqual(await applyDeferredPaymentEvents(f.x.runtime),{applied:2,failed:0,skipped:0});actual=await facts(p);
    assert.equal(actual.attempt.state,'confirmed');assert.equal(actual.applications.length,1);assert.equal(actual.cases.length,0);assert(actual.events[0].applied_at<=actual.events[1].applied_at);
  });
  test('mismatch cases remain closed and neither window end nor another query cancels or reopens them',async()=>{
    const p=await handed(await f.placed());assert.equal((await run(p,{TradeAmt:'6'})).status,'amount_mismatch');let a=await facts(p);
    assert.equal(a.due,undefined);assert.equal(a.applications[0].outcome,'amount_mismatch');assert.equal(a.applications[0].amount_minor,'600');
    // Case closure is a seller operation; its durable payment marker remains.
    await f.x.h.pool.query("UPDATE commerce_exception_cases SET status='resolved',resolution_code='checked',resolution_note='synthetic checked',resolved_by_principal_id=(SELECT principal_id FROM principals WHERE user_ref=$2),updated_at=clock_timestamp(),version=version+1 WHERE case_id=$1",[a.cases[0].case_id,p.s.owner.user.user_id]);
    assert.equal((await run(p)).externalCalls,0);
    await endPaymentWindow(f.x.runtime,p.payment.attempt_ref,{now:()=>new Date(a.attempt.created_at.getTime()+60*60_000)});
    a=await facts(p);assert.equal(a.attempt.state,'issued');assert.equal(a.cases.length,1);assert.equal(a.cases[0].status,'resolved');
    assert.equal((await f.x.h.pool.query('SELECT lifecycle_state FROM commerce_checkout_orders WHERE order_id=$1',[p.order.order_ref])).rows[0].lifecycle_state,'open');
  });

  test('unapplied query paid protects expired holds and prevents cancellation until deferred application',async()=>{
    const s=await f.x.store(5),provider=await f.setup(s),due=await f.x.due(s,5);
    await f.x.tx(q=>f.runtime.commercePorts!.payment!.createOrderAttempt(q,{store:s,orderId:due.order_id,amountMinor:500,currency:'TWD',environment:'sandbox'}));
    const attempt=(await f.x.h.pool.query('SELECT attempt_id FROM commerce_payment_attempts WHERE order_id=$1',[due.order_id])).rows[0];
    const p={s,provider,order:{order_ref:due.order_id},payment:{attempt_ref:attempt.attempt_id}} as Placed;
    await event(p,'paid',undefined,false);await setState(p,'failed');
    assert.equal(await sweepDueCheckoutHolds(f.x.runtime),0);
    await f.x.tx(async q=>{await lockMachinePaymentAttempt(q,attempt.attempt_id);assert.equal(await settleOrderPayments(q,due.order_id),false);});
    assert.equal((await f.x.h.pool.query('SELECT state FROM commerce_inventory_reservations WHERE order_id=$1',[due.order_id])).rows[0].state,'held');
    assert.deepEqual(await applyDeferredPaymentEvents(f.x.runtime),{applied:1,failed:0,skipped:0});
    const actual=await facts(p);assert.equal(actual.attempt.state,'confirmed');assert.equal(actual.applications[0].outcome,'converted');assert.equal(actual.cases.length,0);
  });
  for(const order of ['notification_first','query_first'])test(`notification and query racing: ${order}, one application`,async()=>{
    const p=await handed(await f.placed()),a=(await facts(p)).attempt,body=await response(p);
    const notify=async()=>{
      const raw=encodeForm(signFields({MerchantID:'1234567',MerchantTradeNo:a.merchant_trade_no,TradeNo:'T1234567',TradeAmt:'5',RtnCode:'1',SimulatePaid:'0',PaymentDate:'2026/10/15 10:20:30',PaymentType:'Credit_CreditCard'},EcpayKeyPair.of(p.provider.material.hash_key,p.provider.material.hash_iv),'sha256'));
      const r=await f.app.fetch(new Request(f.origin+'/api/v1/provider-callbacks/ecpay/'+p.provider.accountRef+'/payment',{method:'POST',body:raw,headers:{'Content-Type':'application/x-www-form-urlencoded'}}));assert.equal(r.status,200);assert.equal(await r.text(),'1|OK');
    };
    await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{if(order==='notification_first')await notify();return {kind:'response',status:200,body};}),'buyer');
    if(order==='query_first')await notify();const actual=await facts(p);assert.equal(actual.attempt.state,'confirmed');assert.equal(actual.applications.length,1);assert.equal(actual.cases.length,0);
  });
  test('query facts, exceptions, scheduling and logs never retain provider canaries or key material',async()=>{
    const p=await handed(await f.placed()),canary=randomBytes(16).toString('hex'),logs:unknown[][]=[],original=console.error;
    const body=await response(p,{TradeStatus:'777',card4no:canary,auth_code:canary,RtnMsg:canary});console.error=(...args)=>{logs.push(args);};
    try{await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>({kind:'response',status:200,body})),'buyer');}finally{console.error=original;}
    const a=await facts(p),text=JSON.stringify({events:a.events,cases:a.cases,due:a.due,attempt:a.attempt,applications:a.applications,logs,journal:[...f.journal.objects.values()]});
    for(const secret of [canary,p.provider.material.hash_key,p.provider.material.hash_iv,p.provider.material.credit_check_code])assert(!text.includes(secret));
    assert(!text.includes('CheckMacValue'));
  });

  const queryPath=(p:Placed)=>f.root(p.s)+'/orders/'+p.order.order_ref+'/payment-queries';
  function installBuyer(p:Placed,body:string){let calls=0;f.install({commerceQueryTransport:createFixtureQueryTransport(async()=>{calls++;return {kind:'response',status:200,body};},'local')});return {get calls(){return calls;}};}
  test('buyer query applies during the request and returns the parsed public DTO',async()=>{
    const p=await handed(await f.placed()),t=installBuyer(p,await response(p));const r=await f.http('POST',queryPath(p),{},p.cookie);
    assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.payment_state,'confirmed');assert.equal(r.data.latest_payment_attempt.state,'paid');assert.equal(r.data.can_resume_payment,false);assert.equal(t.calls,1);
    assert.equal(r.response.headers.get('Cache-Control'),'no-store');assert.equal(r.response.headers.get('Referrer-Policy'),'no-referrer');assert.equal((await facts(p)).events[0].query_trigger,'buyer');
  });
  test('buyer query with no eligible attempt still charges all budgets and makes no call',async()=>{
    const p=await f.placed(),t=installBuyer(p,await response(p));const r=await f.http('POST',queryPath(p),{},p.cookie);assert.equal(r.status,200);assert.equal(t.calls,0);
    assert.equal((await f.x.h.pool.query("SELECT count(*)::int n FROM auth_rate_limits WHERE bucket LIKE 'commerce:paymentQuery%'")).rows[0].n,3);
    const limited=await f.http('POST',queryPath(p),{},p.cookie);assert.equal(limited.status,429);assert(Number(limited.response.headers.get('Retry-After'))>0);
  });
  for(const outcome of ['unknown','transport','lease'] as const)test(`buyer query ${outcome} maps to the prescribed HTTP response`,async()=>{
    const p=await handed(await f.placed()),body=await response(p,{TradeStatus:'777'});
    f.install({commerceQueryTransport:createFixtureQueryTransport(async()=>outcome==='transport'?{kind:'error',code:'timeout'}:{kind:'response',status:200,body},'local')});
    if(outcome==='lease')await f.x.h.pool.query("UPDATE commerce_due_work SET lease_until=clock_timestamp()+interval '1 minute' WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref]);
    const r=await f.http('POST',queryPath(p),{},p.cookie);assert.equal(r.status,outcome==='lease'?409:200,JSON.stringify(r.data));if(outcome==='lease')assert.equal(r.data.code,'payment_result_pending');
  });
  test('buyer query uses ordinary access, JSON and Origin gates',async()=>{
    const p=await handed(await f.placed()),t=installBuyer(p,await response(p));
    assert.equal((await f.http('POST',queryPath(p),{})).status,404);
    assert.equal((await f.http('POST',queryPath(p),{unexpected:true},p.cookie)).status,422);
    assert.equal((await f.http('POST',queryPath(p),{},p.cookie,{Origin:'https://foreign.example.test'})).status,403);assert.equal(t.calls,0);
  });

});
