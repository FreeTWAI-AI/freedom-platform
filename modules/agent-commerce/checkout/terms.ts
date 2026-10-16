/// <reference lib="es2024.string" />
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {isCheckoutText} from '../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import {publicProjection} from '../hosted/publish.js';
import {sharedLines} from '../hosted/shared-quotes.js';
import {bindStore,lockStore,type CheckoutStore,type StoreContext} from './authority.js';

/** PostgreSQL rejects NUL and UTF-8 encoding replaces lone surrogates. Validate
 * raw keys too, before normalization/unknown-field stripping can hide them. */
function checkoutString(value:string) {
  requireCondition(isCheckoutText(value),422,'invalid_checkout_json','結帳資料無效。');
}
export function validateCheckoutStrings(value:unknown):void {
  const pending=[value];
  while(pending.length) {
    const next=pending.pop();
    if(typeof next==='string')checkoutString(next);
    else if(next!==null&&typeof next==='object')for(const [key,child] of Object.entries(next)){checkoutString(key);pending.push(child);}
  }
}
export function canonicalJSON(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonicalJSON).join(',')+']';
  if(value!==null && typeof value==='object')return '{'+Object.keys(value).sort().map(k=>{checkoutString(k);return JSON.stringify(k)+':'+canonicalJSON((value as Record<string,unknown>)[k]);}).join(',')+'}';
  requireCondition(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isSafeInteger(value),422,'invalid_checkout_json','結帳資料無效。');
  if(typeof value==='string')checkoutString(value);
  return JSON.stringify(value);
}
export const hashJSON=(value:unknown)=>createHash('sha256').update(canonicalJSON(value),'utf8').digest('hex');
export const hashKey=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const money=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const contactSchema=z.object({name:z.string().trim().min(1).max(120),email:z.string().trim().toLowerCase().email().max(254),phone:z.string().trim().min(1).max(40)});
const jsonObject=z.record(z.string(),z.unknown());
const inputSchema=z.object({publication_revision:z.string().regex(/^[1-9][0-9]*$/),
  lines:z.array(z.object({sku:z.string().min(1).max(32),quantity:z.number().int().min(1).max(99)})).min(1).max(50),
  contact:contactSchema,delivery:jsonObject,invoice:jsonObject.nullable().optional(),
  consents:z.array(z.object({policy_kind:z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),policy_version_id:z.uuid()})).max(20).default([]),
}).refine(v=>new Set(v.lines.map(l=>l.sku)).size===v.lines.length,'Duplicate SKU');
export type CheckoutInput=z.input<typeof inputSchema>;
export interface ShippingQuotePort {
  /** SQL-local policy only. No provider/network call is permitted in this transaction. */
  quote(q:PoolClient,store:CheckoutStore,input:{lines:readonly {item_id:string;supplier_shop_id:string;quantity:number}[];delivery:Record<string,unknown>}):Promise<unknown>;
}
export interface CheckoutAdmissionPort {allowed(q:PoolClient,store:CheckoutStore):boolean|Promise<boolean>}
export interface UnresolvedOrderPort {find(q:PoolClient,checkoutId:string):Promise<{order_id:string}|null>}
export interface CheckoutPolicyPort {required(q:PoolClient,store:CheckoutStore):Promise<readonly {policy_kind:string;policy_version_id:string}[]>}
export interface CheckoutPaymentHandoff {handoff_url:string;attempt_ref:string;expires_at:string}
export interface CheckoutPaymentSummary {
  payment_state:'unpaid'|'pending'|'simulated'|'confirmed'|'overpaid'|'refunded';
  latest_payment_attempt:null|{attempt_ref:string;state:'ready'|'awaiting_result'|'paid'|'failed'|'expired';created_at:string};
  can_resume_payment:boolean;
}
/** SQL-local inbound payment operations. Implementations must not call a provider. */
export interface CheckoutPaymentPort {
  assertTermsAvailable(input:{currency:string;totalMinor:number;amountsMinor:readonly number[]}):void;
  createOrderAttempt(q:PoolClient,input:{store:CheckoutStore;orderId:string;amountMinor:number;currency:string;environment:'sandbox'|'live'}):Promise<void>;
  issueHandoff(q:PoolClient,input:{store:CheckoutStore;orderId:string}):Promise<CheckoutPaymentHandoff|null>;
  onOrdersCancelled(q:PoolClient,orderIds:readonly string[]):Promise<void>;
  queryable?(q:PoolClient,orderId:string):Promise<boolean>;
  summarize(q:PoolClient,orderIds:readonly string[]):Promise<ReadonlyMap<string,CheckoutPaymentSummary>>;
}
/** Request orchestration owns its transactions and may query a provider only
 * after releasing the client. authorize is rechecked before each commit. */
export interface CheckoutPaymentActions {
  resume(pool:Pool,input:{store:CheckoutStore;orderId:string;network:string;authorize(q:PoolClient):Promise<void>}):Promise<CheckoutPaymentHandoff>;
  query?(pool:Pool,input:{store:CheckoutStore;orderId:string;network:string;trigger?:'buyer'|'seller';authorize(q:PoolClient):Promise<void>}):Promise<'complete'|'query_in_progress'>;
}
export interface CheckoutPorts {paymentActions?:CheckoutPaymentActions;shipping?:ShippingQuotePort;admission?:CheckoutAdmissionPort;policies?:CheckoutPolicyPort;unresolved?:UnresolvedOrderPort;payment?:CheckoutPaymentPort}
export const defaultAdmission:CheckoutAdmissionPort={allowed:()=>false};
const defaultShipping:ShippingQuotePort={async quote(){requireCondition(false,409,'shipping_not_configured','尚未設定配送。');}};
const shippingSchema=z.object({groups:z.array(z.object({group_ref:z.string().min(1).max(80),supplier_shop_id:z.uuid(),method_ref:z.string().min(1).max(80),amount_minor:money})).min(1).max(50)});
export function validateShippingQuote(raw:unknown,bindings:readonly {supplier_shop_id:string}[]) {
  const shipping=shippingSchema.parse(raw);
  const suppliers=new Set(bindings.map(b=>b.supplier_shop_id));
  requireCondition(new Set(shipping.groups.map(g=>g.group_ref)).size===shipping.groups.length && shipping.groups.every(g=>suppliers.has(g.supplier_shop_id))
    && [...suppliers].every(s=>shipping.groups.some(g=>g.supplier_shop_id===s)),422,'shipping_unavailable','商品無法配送。');
  return shipping;
}
/** Quote delivery and checkout delivery/invoice share exactly the same walker. */
export function validateBuyerJSON(value:unknown,maxBytes:number) {
  const pending:{value:unknown;depth:number}[]=[{value,depth:0}];let nodes=0;
  while(pending.length) {
    const next=pending.pop()!;
    requireCondition(++nodes<=2048&&next.depth<=8,422,'invalid_checkout_json','結帳資料過深或過多。');
    if(next.value!==null&&typeof next.value==='object')for(const [key,child] of Object.entries(next.value)) {
      // wireVersionResponses rewrites this key at every depth in JSON replies.
      requireCondition(key!=='aggregate_version',422,'invalid_checkout_json','結帳資料無效。');
      checkoutString(key);pending.push({value:child,depth:next.depth+1});
    }
  }
  requireCondition(Buffer.byteLength(canonicalJSON(value),'utf8')<=maxBytes,422,'checkout_contact_too_large','配送或發票資料過大。');
}
export function parseCheckoutInput(raw:CheckoutInput) {
  validateCheckoutStrings(raw);
  const input=inputSchema.parse(raw);
  validateBuyerJSON(input.delivery,8192);
  if(input.invoice!=null)validateBuyerJSON(input.invoice,4096);
  return {...input,invoice:input.invoice??null};
}
export const contactHash=(input:ReturnType<typeof parseCheckoutInput>,salt:string)=>hashJSON({contact:input.contact,delivery:input.delivery,invoice:input.invoice,salt});

/** Reuse the exact v1 shared binding and price validation with a principal-less
 * supplier resolver. Lifecycle authority was acquired by lockStore beforehand. */
export async function checkoutTerms(q:PoolClient,context:StoreContext,input:ReturnType<typeof parseCheckoutInput>,ports:CheckoutPorts,salt:string) {
  const p=context.profile,projection=publicProjection(p.projection);
  const required=await ports.policies?.required(q,p)??[];
  const policyKey=(v:{policy_kind:string;policy_version_id:string})=>`${v.policy_kind}/${v.policy_version_id}`;
  const actual=input.consents.map(policyKey).sort(),expected=required.map(policyKey).sort();
  requireCondition(new Set(actual).size===actual.length && canonicalJSON(actual)===canonicalJSON(expected),422,'consents_mismatch','同意的政策版本不符。');
  requireCondition(projection.revision===input.publication_revision,409,'terms_changed','商店公開內容已更新。');
  const resolved=await sharedLines(q,{profile:p,shared:{}},input.lines,async id=>{
    const supplier=context.parties.get(id);
    requireCondition(supplier && supplier.currency===p.currency,409,'terms_changed','供貨來源已更新。');
    return supplier;
  });
  const shipping=validateShippingQuote(await (ports.shipping??defaultShipping).quote(q,p,{lines:resolved.bindings,delivery:input.delivery}),resolved.bindings);
  const bindings=resolved.bindings.map(b=>({...b,unit_price_minor:resolved.lines.find(l=>l.sku===b.sku)!.unit_price_minor}));
  const items=resolved.lines.map(l=>({...l,offer_sha256:bindings.find(b=>b.sku===l.sku)!.offer_sha256}));
  const merchandise=items.reduce((n,l)=>n+l.line_total_minor,0),shippingTotal=shipping.groups.reduce((n,g)=>n+g.amount_minor,0),total=merchandise+shippingTotal;
  requireCondition(Number.isSafeInteger(total)&&total>0,422,'checkout_total_invalid','結帳總額無效。');
  ports.payment?.assertTermsAvailable({currency:p.currency,totalMinor:total,amountsMinor:[...items.flatMap(l=>[l.unit_price_minor,l.line_total_minor]),...shipping.groups.map(g=>g.amount_minor),total]});
  const terms={profile:'freedom.checkout-terms/v1' as const,publication_revision:projection.revision,publication_id:p.current_publication_id!,currency:p.currency,
    bindings,items,merchandise_total_minor:merchandise,discount_total_minor:0,discounts:[],shipping,shipping_total_minor:shippingTotal,
    tax_state:'not_assessed',total_minor:total,consents:input.consents,payment_methods:['immediate_card'],contact_sha256:contactHash(input,salt)};
  return {terms,terms_sha256:hashJSON(terms)};
}
export type CheckoutTerms=Awaited<ReturnType<typeof checkoutTerms>>['terms'];
/** Explicit allowlist; the retained terms and their hash remain untouched. */
export function publicCheckoutTerms(terms:CheckoutTerms) {
  return {publication_revision:terms.publication_revision,currency:terms.currency,
    items:terms.items.map(({sku,title,quantity,unit_price_minor,line_total_minor})=>({sku,title,quantity,unit_price_minor,line_total_minor})),
    merchandise_total_minor:terms.merchandise_total_minor,discount_total_minor:terms.discount_total_minor,discounts:terms.discounts,
    shipping:{groups:terms.shipping.groups.map(({group_ref,amount_minor})=>({group_ref,amount_minor}))},
    shipping_total_minor:terms.shipping_total_minor,tax_state:terms.tax_state,total_minor:terms.total_minor,consents:terms.consents,payment_methods:terms.payment_methods};
}
export async function computeCheckoutTerms(q:PoolClient,store:CheckoutStore,raw:CheckoutInput,ports:CheckoutPorts={}) {
  const input=parseCheckoutInput(raw),context=await lockStore(q,store,input.lines.map(l=>l.sku));
  return checkoutTerms(q,context,input,ports,randomBytes(16).toString('hex'));
}
/** Seller-facing label only; knowing an email never grants order access. */
export async function linkCustomerMember(q:PoolClient,customerId:string,memberPrincipalId?:string) {
  if(!memberPrincipalId)return;
  await q.query(`UPDATE commerce_customers c SET member_principal_id=p.principal_id FROM principals p JOIN users u ON u.user_id=p.user_ref
    WHERE c.customer_id=$1 AND c.redacted_at IS NULL AND c.member_principal_id IS NULL AND p.principal_id=$2 AND p.kind='person' AND p.status='active'
      AND u.active AND u.email_verified_at IS NOT NULL AND lower(btrim(u.email))=c.email_normalized`,[customerId,memberPrincipalId]);
}
async function ensureCustomerLocked(q:PoolClient,context:StoreContext,email:string,memberPrincipalId?:string) {
  const p=context.profile,normalized=z.string().trim().toLowerCase().email().max(254).parse(email);
  await q.query(`INSERT INTO commerce_customers(tenant_id,instance_id,email_normalized) VALUES($1,$2,$3)
    ON CONFLICT(instance_id,email_normalized) DO NOTHING`,[p.tenant_id,p.instance_id,normalized]);
  const row=(await q.query<{customer_id:string;member_principal_id:string|null}>(`SELECT customer_id,member_principal_id FROM commerce_customers
    WHERE tenant_id=$1 AND instance_id=$2 AND email_normalized=$3`,[p.tenant_id,p.instance_id,normalized])).rows[0];
  await linkCustomerMember(q,row.customer_id,memberPrincipalId);
  return (await q.query<typeof row>('SELECT customer_id,member_principal_id FROM commerce_customers WHERE customer_id=$1',[row.customer_id])).rows[0];
}
export async function ensureCustomer(q:PoolClient,store:CheckoutStore,email:string,memberPrincipalId?:string) {
  validateCheckoutStrings({email,memberPrincipalId});
  return ensureCustomerLocked(q,await lockStore(q,store),email,memberPrincipalId);
}
interface FrozenCheckout {checkout_id:string;terms:CheckoutTerms;terms_sha256:string;expires_at:Date;version:string}
export async function freezeCheckout(q:PoolClient,store:CheckoutStore,raw:CheckoutInput & {idempotencyKey:string;checkoutId?:string;memberPrincipalId?:string},ports:CheckoutPorts={}) {
  const input=parseCheckoutInput(raw),context=await lockStore(q,store,input.lines.map(l=>l.sku)),p=context.profile;
  requireCondition(/^[A-Za-z0-9_-]{22,128}$/.test(raw.idempotencyKey),422,'invalid_idempotency_key','冪等鍵無效。');
  const key=hashKey(raw.idempotencyKey),request=createHmac('sha256',Buffer.from(raw.idempotencyKey,'utf8')).update(canonicalJSON({input,checkout_id:raw.checkoutId??null}),'utf8').digest('hex');
  const prior=(await q.query<{request_sha256:string;response:FrozenCheckout}>(`SELECT request_sha256,response FROM commerce_checkout_idempotency_keys WHERE instance_id=$1 AND idempotency_key_sha256=$2`,[p.instance_id,key])).rows[0];
  if(prior){requireCondition(prior.request_sha256===request,409,'checkout_idempotency_conflict','冪等鍵已用於其他內容。');return {...prior.response,expires_at:new Date(prior.response.expires_at)};}
  // Customer creation runs under the already held lifecycle/community locks.
  const customer=await ensureCustomerLocked(q,context,input.contact.email,raw.memberPrincipalId);
  // Destroy the contact salt on redaction; retained terms cannot test PII guesses.
  const salt=randomBytes(16).toString('hex'),frozen=await checkoutTerms(q,context,input,ports,salt),contactId=randomUUID();
  let id=raw.checkoutId??randomUUID();
  if(raw.checkoutId){
    const old=(await q.query(`SELECT * FROM commerce_checkouts WHERE checkout_id=$1 AND tenant_id=$2 AND instance_id=$3 FOR UPDATE`,[id,p.tenant_id,p.instance_id])).rows[0];
    requireCondition(old,404,'checkout_not_found','找不到結帳。');
    requireCondition((await q.query('SELECT 1 WHERE $1::timestamptz>clock_timestamp()',[old.expires_at])).rowCount===1,409,'checkout_expired','結帳已到期。');
  }
  await q.query(`INSERT INTO commerce_checkout_contacts(contact_id,checkout_id,tenant_id,instance_id,contact_name,contact_email,contact_phone,delivery,invoice,contact_sha256,contact_salt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[contactId,id,p.tenant_id,p.instance_id,input.contact.name,input.contact.email,input.contact.phone,input.delivery,input.invoice,contactHash(input,salt),salt]);
  const params=[id,p.tenant_id,p.instance_id,customer.customer_id,input.publication_revision,p.currency,frozen.terms,frozen.terms_sha256,contactId,key,request];
  const saved=(raw.checkoutId
    ? await q.query<FrozenCheckout>(`UPDATE commerce_checkouts SET customer_id=$4,publication_revision=$5,currency=$6,terms=$7,terms_sha256=$8,current_contact_id=$9,version=version+1
      WHERE checkout_id=$1 AND tenant_id=$2 AND instance_id=$3 RETURNING checkout_id,terms,terms_sha256,expires_at,version::text`,params.slice(0,9))
    : await q.query<FrozenCheckout>(`INSERT INTO commerce_checkouts(checkout_id,tenant_id,instance_id,customer_id,publication_revision,currency,terms,terms_sha256,current_contact_id,idempotency_key_sha256,request_sha256,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,t,t+interval '24 hours' FROM (SELECT date_trunc('milliseconds',clock_timestamp()) t) n
      RETURNING checkout_id,terms,terms_sha256,expires_at,version::text`,params)).rows[0];
  await q.query(`INSERT INTO commerce_checkout_idempotency_keys(checkout_id,tenant_id,instance_id,idempotency_key_sha256,request_sha256,response) VALUES($1,$2,$3,$4,$5,$6)`,[id,p.tenant_id,p.instance_id,key,request,saved]);
  await bindStore(q,p.tenant_id);return saved;
}
