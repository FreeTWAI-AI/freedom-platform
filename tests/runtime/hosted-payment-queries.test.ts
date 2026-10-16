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
import {sealCredential} from '../../modules/agent-commerce/payments/credentials.js';
import {bindStore} from '../../modules/agent-commerce/checkout/authority.js';
import {queryAttempt,type PaymentQueryDependencies} from '../../modules/agent-commerce/payments/queries.js';

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
    await f.x.h.pool.query("UPDATE commerce_due_work SET failure_count=2 WHERE kind='payment_query' AND target_id=$1",[p.payment.attempt_ref]);
    const d=deps(async()=>({kind:'response',status:403,body:''}),{now:()=>now});
    assert.equal((await queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'buyer')).status,'http_403');
    let a=await facts(p);assert.equal(a.due.failure_count,2);assert.equal(a.due.due_at.getTime(),now.getTime()+30*60_000);
    assert.equal((await queryAttempt(f.x.runtime,p.payment.attempt_ref,d,'buyer')).status,'throttled');
    a=await facts(p);assert.equal(a.due.failure_count,2);assert.equal(a.due.last_error,'throttled');assert.equal(a.events.length,0);
    const other=await handed(await f.placed());assert.equal((await run(other,{TradeStatus:'0'})).status,'unpaid');
  });
  for(const refusal of ['unhanded','keyring','environment','inactive','quarantine'] as const)test(`${refusal} makes no provider call`,async()=>{
    const p=await f.placed();if(refusal!=='unhanded')await handed(p);
    if(refusal==='inactive')await f.x.h.pool.query("UPDATE tenants SET status='suspended',version=version+1 WHERE tenant_id=$1",[p.s.tenantId]);
    let calls=0;const result=await queryAttempt(f.x.runtime,p.payment.attempt_ref,deps(async()=>{calls++;throw Error('must not call');},
      refusal==='keyring'?{keyring:null}:refusal==='environment'?{freedomEnv:'public'}:refusal==='quarantine'?{quarantine:true}:{}),'buyer');
    assert.equal(calls,0);assert.equal(result.externalCalls,0);assert.equal(result.status,refusal==='keyring'?'keyring_unavailable':refusal==='environment'?'environment_mismatch':refusal==='inactive'?'tenant_inactive':'skipped');
  });
});
