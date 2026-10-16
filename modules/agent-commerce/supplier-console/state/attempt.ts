import {SupplyCatalogReceiptSchema,SupplyProductReceiptSchema} from '../../../../contracts/guild-launchpad/v1/hosted-supply-catalog';
import {SupplyMaterialReceiptSchema,SupplyProfileReceiptSchema} from '../../../../contracts/guild-launchpad/v1/supplier-console';
import {SupplyTermsSchema} from '../../../../contracts/guild-launchpad/v1/hosted-supply-terms';
import {SupplyOfferSchema,DistributionSchema} from '../../../../contracts/guild-launchpad/v1/hosted-distribution';
import {ReservationSettingSchema} from '../../../../contracts/guild-launchpad/v1/hosted-shared-order';
import {ApiError} from '../../../../apps/portal-web/src/api';
import type {ConsoleScope} from '../ui/route';
const rule=(schema:{safeParse:(raw:unknown)=>{success:boolean;data?:unknown}},ack:string|null,reads:string[])=>({schema,ack,reads});
export const ATTEMPT_KINDS={
 'material.create':rule(SupplyMaterialReceiptSchema,null,['materials','material']),
 'material.update':rule(SupplyMaterialReceiptSchema,'material_id',['materials','material']),
 'material.copy':rule(SupplyMaterialReceiptSchema,'material_id',['materials','material']),
 'material.access':rule(SupplyMaterialReceiptSchema,'material_id',['materials','material']),
 'material.grant':rule(SupplyMaterialReceiptSchema,'material_id',['materials','material']),
 'material.revoke':rule(SupplyMaterialReceiptSchema,'material_id',['materials','material']),
 'material.withdraw':rule(SupplyMaterialReceiptSchema,'material_id',['materials','material']),
 'profile.setup':rule(SupplyCatalogReceiptSchema,'instance_id',['profile','overview']),
 'profile.update':rule(SupplyProfileReceiptSchema,'instance_id',['profile','owner','overview']),
 'product.create':rule(SupplyProductReceiptSchema,null,['profile','products','overview','product']),
 'product.update':rule(SupplyProductReceiptSchema,'product_id',['products','overview','product']),
 'terms.update':rule(SupplyTermsSchema,'product_id',['products','overview','product','offers','requests']),
 'offer.publish':rule(SupplyOfferSchema,'product_id',['products','overview','product','offers','requests','partners']),
 'offer.withdraw':rule(SupplyOfferSchema,'offer_id',['products','overview','product','offers','requests','partners']),
 'request.decide':rule(DistributionSchema,'selection_id',['request','products','overview','product','offers','requests','partners','partner']),
 'reservation.toggle':rule(ReservationSettingSchema,null,['profile','owner','overview','reservations']),
} as const;
export type AttemptKind=keyof typeof ATTEMPT_KINDS;
export type Attempt=Readonly<{kind:AttemptKind;label:string;scope:ConsoleScope;method:'post'|'patch';path:string;body:Readonly<Record<string,unknown>>;ifMatch?:string;key:string;draft?:string;target:string;productId?:string}>;
function freeze<T>(value:T):T {if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export function createAttempt(input:Omit<Attempt,'key'>,key:string=crypto.randomUUID()):Attempt {return freeze({...input,scope:{...input.scope},body:JSON.parse(JSON.stringify(input.body)),key});}
/** A command refusal (403) locks writes until a profile read that started after the refusal succeeds for the same
 * session and business; only then do the refreshed capabilities decide each action again. */
export function refusalReleased({key='profile',mark,ticket,current,matched}:{key?:string;mark:number|null;ticket:number;current:boolean;matched:boolean}):boolean{return key==='profile'&&mark!==null&&ticket>mark&&current&&matched;}
export type Outcome={state:'success';value:Record<string,unknown>}|{state:'unknown'}|{state:'known';status:number;code?:string;detail?:string};
export function classifyCommandOutcome(attempt:Attempt,result:{response:unknown}|{error:unknown}):Outcome {
 if('response'in result){const rule=ATTEMPT_KINDS[attempt.kind],parsed=rule.schema.safeParse(result.response);
  if(!parsed.success)return {state:'unknown'};
  const value=parsed.data as Record<string,unknown>;if(rule.ack&&value[rule.ack]!==attempt.target)return {state:'unknown'};
  return {state:'success',value};}
 const e=result.error;
 if(!(e instanceof ApiError)||e.network||e.timedOut||e.accessExpired||!e.status||e.status<400||e.status>=500||e.status===401)return {state:'unknown'};
 return {state:'known',status:e.status,code:e.code,detail:e.detail??e.message};
}
