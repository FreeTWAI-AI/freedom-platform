import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {isSellerCalendarDate,ResolveWithEvidenceInputSchema,RetryAllocationInputSchema} from '../../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
import {checkVersion} from '../../../packages/db/index.js';
import {requireCondition} from '../../../packages/shared/problem.js';
import {unavailableTenantListCursor} from '../../../packages/shared/tenant-list-cursor.js';
import type {Actor} from '../../identity-membership/service.js';
import {effectiveStoreCapabilities} from '../hosted/capabilities.js';
import {retryAllocation} from './payments.js';
import {quarantineGate} from './public-commands.js';
import {sellerCheckoutCommand,type SellerCheckoutContext} from './seller-command.js';
import {CASE_RESOLUTION_CODES,sellerCheckoutRead,sellerCursorPosition,sellerExceptionRows,sellerExceptionView,type SellerCheckoutReadOptions} from './seller-orders.js';
import {canonicalJSON} from './terms.js';

export const SellerExceptionQuerySchema=z.object({view:z.literal('retailer'),state:z.enum(['open','closed']).optional(),cursor:z.string().max(512).optional(),
  limit:z.string().regex(/^[0-9]+$(?![\s\S])/).transform(Number).pipe(z.number().int().min(1).max(50)).optional()}).strict();
export {isSellerCalendarDate,ResolveWithEvidenceInputSchema,RetryAllocationInputSchema} from '../../../contracts/guild-launchpad/v1/hosted-seller-checkout.js';
export function validateSellerDate(value:string,today:string,code='validation_failed',earliest?:string) {
  requireCondition(isSellerCalendarDate(value)&&value<=today&&(earliest===undefined||value>=earliest),422,code,'日期無效。');
}
export async function sellerToday(q:PoolClient) {
  return (await q.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD') AS today")).rows[0].today as string;
}
async function caseRow(q:PoolClient,context:SellerCheckoutContext,id:string,lock=false) {
  const [row]=await sellerExceptionRows(q,context,`e.case_id=$3${lock?' FOR UPDATE OF e':''}`,[id]);
  requireCondition(row,404,'exception_case_not_found','找不到例外案件。');return row;
}
export async function projectSellerException(q:PoolClient,context:SellerCheckoutContext,id:string) {
  return sellerExceptionView(q,context,await caseRow(q,context,id),await effectiveStoreCapabilities(q,context.tenant,context.profile.instance_id));
}
export function readSellerException(pool:Pool,actor:Actor,tenantId:string,instanceId:string,id:string) {
  return sellerCheckoutRead(pool,actor,tenantId,instanceId,'store:orders:read',(q,context)=>projectSellerException(q,context,id));
}
export async function listSellerExceptions(pool:Pool,actor:Actor,tenantId:string,instanceId:string,raw:unknown,options:SellerCheckoutReadOptions={}) {
  const query=SellerExceptionQuerySchema.parse(raw);
  return sellerCheckoutRead(pool,actor,tenantId,instanceId,'store:orders:read',async(q,context)=>{
    const state=query.state??'open',codec=options.cursors??unavailableTenantListCursor,binding={purpose:'exception-cases' as const,tenantId,principalId:context.tenant.principal_id,scopeId:context.tenant.scope.scope_id,resourceId:instanceId,filter:canonicalJSON({view:query.view,state})};
    const after=sellerCursorPosition(codec,query.cursor,binding),size=query.limit??20,open=state==='open',column=open?'e.due_at':'e.updated_at';
    const rows=await sellerExceptionRows(q,context,`e.status${open?'=':'<>'}'open'
      AND ($3::timestamptz IS NULL OR (${column},e.case_id)${open?'>':'<'}($3::timestamptz,$4::uuid))
      ORDER BY ${column}${open?'':' DESC'},e.case_id${open?'':' DESC'} LIMIT $5`,[after?.at??null,after?.id??null,size+1]);
    const page=rows.slice(0,size),keys=await effectiveStoreCapabilities(q,context.tenant,instanceId),items=[];
    for(const row of page)items.push(await sellerExceptionView(q,context,row,keys));
    // Preserve database microseconds rather than a millisecond Date boundary.
    let next_cursor=null;
    if(rows.length>size){const last=page[page.length-1];next_cursor=codec.encode({at:open?last.cursor_due_at:last.cursor_updated_at,id:last.case_id},binding);}
    return {items,next_cursor};
  });
}
export async function closeSellerException(q:PoolClient,id:string,principalId:string,code:'refunded'|'allocated'|'confirmed'|'checked_with_provider',note:string) {
  await q.query(`UPDATE commerce_exception_cases SET status='resolved',resolution_code=$2,resolution_note=$3,resolved_by_principal_id=$4,updated_at=clock_timestamp(),version=version+1 WHERE case_id=$1 AND status='open'`,[id,code,note,principalId]);
}
function available(row:Awaited<ReturnType<typeof caseRow>>,action:'resolve_with_evidence'|'retry_allocation') {
  requireCondition(row.status==='open'&&(action==='retry_allocation'?row.kind==='paid_unallocatable':row.kind!=='paid_unallocatable'),409,'exception_action_unavailable','目前無法處理這個例外。');
}
export async function actOnSellerException(pool:Pool,actor:Actor,tenantId:string,instanceId:string,id:string,action:'resolve_with_evidence'|'retry_allocation',raw:unknown,key:string,expected:string,options:SellerCheckoutReadOptions={}) {
  quarantineGate(options);
  const body=action==='resolve_with_evidence'?ResolveWithEvidenceInputSchema.parse(raw):RetryAllocationInputSchema.parse(raw);
  return sellerCheckoutCommand(pool,actor,tenantId,instanceId,'store:orders:manage',`commerce.exception_case.${action}`,{kind:'commerce_exception_case',id},body,key,expected,async(q,context)=>{
    const peek=await caseRow(q,context,id);available(peek,action);
    let code:'refunded'|'allocated'|'confirmed'|'checked_with_provider',note:string;
    if(action==='retry_allocation') {
      requireCondition(peek.order_id,409,'exception_action_unavailable','目前無法處理這個例外。');
      await retryAllocation(q,{storefront_shop_id:context.profile.storefront_shop_id},peek.order_id);
      code='allocated';note='補貨後已重新配貨。';
    } else {
      const input=ResolveWithEvidenceInputSchema.parse(body);
      requireCondition(CASE_RESOLUTION_CODES[peek.kind as keyof typeof CASE_RESOLUTION_CODES].includes(input.code),422,'resolution_code_invalid','結案代碼不適用。');
      code=input.code;
      if(code==='confirmed') {
        // Attempts precede cases: payment paths can open the same case while
        // holding the attempt. Taking these in reverse order could deadlock.
        const attempt=peek.subject_kind==='payment_attempt'?(await q.query('SELECT state FROM commerce_payment_attempts WHERE attempt_id=$1 AND tenant_id=$2 AND instance_id=$3 FOR SHARE',[peek.subject_id,tenantId,instanceId])).rows[0]:null;
        requireCondition(attempt?.state==='confirmed',409,'payment_not_confirmed','付款尚未確認。');note='付款已向綠界確認。';
      } else {
        const evidence=input as Exclude<typeof input,{code:'confirmed'}>;
        validateSellerDate(evidence.provider_date,await sellerToday(q));
        note=code==='refunded'?`店家已在綠界後台退款（${evidence.provider_date}，參考號 ${evidence.provider_reference}）。`:`店家已在綠界後台核對（${evidence.provider_date}，參考號 ${evidence.provider_reference}）。`;
      }
    }
    // Always last, after allocation's order/attempt/application/item locks or
    // the confirmed evidence's attempt lock. Any conflict rolls back all work.
    const locked=await caseRow(q,context,id,true);available(locked,action);checkVersion(locked.version,expected);
    await closeSellerException(q,id,context.tenant.principal_id,code,note);return {id};
  },projectSellerException);
}
