import type {PoolClient} from 'pg';
import {Problem} from '../../../../packages/shared/problem.js';
import type {CheckoutPaymentMethodsPort,CheckoutPaymentPort,PaymentOptionResolution} from '../../checkout/terms.js';
import {scheduleDueWork} from '../../operations/due-work.js';
import {currentOfflineSettings} from './settings.js';
import {OFFLINE_CONFIRMATION_GRACE_MS} from './window.js';

export const OFFLINE_PAYMENT_REQUIRES_MEMBER=true;
const CARD_PROFILE='ecpay.aio.credit.v1';
const BANK_PROFILE='offline.bank_transfer.v1';
const MEETUP_PROFILE='offline.cash_on_meetup.v1';
type Store={tenant_id:string;instance_id:string};
function wholeDollars(currency:string,totalMinor:number,amounts:readonly number[]){
  return currency==='TWD'&&Number.isSafeInteger(totalMinor)&&totalMinor>0&&totalMinor%100===0&&amounts.every(amount=>Number.isSafeInteger(amount)&&amount>=0&&amount%100===0);
}
function meetupSelected(refs:readonly string[]|null){return refs!==null&&refs.every(ref=>ref==='meetup');}
async function activeCard(q:PoolClient,store:Store,environment:'sandbox'|'live'){
  return (await q.query(`SELECT 1 FROM commerce_provider_account_services WHERE tenant_id=$1 AND instance_id=$2 AND environment=$3
    AND purpose='payment' AND state='active' AND profile=$4 LIMIT 1`,[store.tenant_id,store.instance_id,environment,CARD_PROFILE])).rowCount===1;
}
/** Host profiles plus the latest settings. Membership stays on the port flag; resolve does not read a session. */
export function createPaymentMethodsPort(input:{environment:'sandbox'|'live';profiles:readonly string[];card?:CheckoutPaymentPort}):CheckoutPaymentMethodsPort{
  const {environment,profiles,card}=input;
  return {
    offlinePaymentRequiresMember:OFFLINE_PAYMENT_REQUIRES_MEMBER,
    async resolve(q,store,request):Promise<PaymentOptionResolution>{
      const settings=await currentOfflineSettings(q,store.instance_id),money=wholeDollars(request.currency,request.totalMinor,request.amountsMinor);
      const options:PaymentOptionResolution['options'][number][]=[];
      if(profiles.includes(CARD_PROFILE)&&card&&await activeCard(q,store,environment)){
        let available=true;
        try{card.assertTermsAvailable({currency:request.currency,totalMinor:request.totalMinor,amountsMinor:request.amountsMinor});}
        catch(error){if(!(error instanceof Problem)||error.code!=='payment_profile_unavailable')throw error;available=false;}
        options.push({method:'immediate_card',available,reason:available?null:'payment_profile_unavailable'});
      }
      const bank=Boolean(profiles.includes(BANK_PROFILE)&&settings?.document.bank_transfer);
      const meetup=Boolean(profiles.includes(MEETUP_PROFILE)&&settings?.document.cash_on_meetup);
      if(bank)options.push({method:'bank_transfer',available:money,reason:money?null:'payment_profile_unavailable'});
      const meetupOk=money&&meetupSelected(request.shippingMethodRefs);
      if(meetup)options.push({method:'cash_on_meetup',available:meetupOk,reason:meetupOk?null:!money?'payment_profile_unavailable':'meetup_required'});
      const bankAvailable=options.some(option=>option.method==='bank_transfer'&&option.available);
      const meetupAvailable=options.some(option=>option.method==='cash_on_meetup'&&option.available);
      return {options,offline:settings&&(bankAvailable||meetupAvailable)?{settings_version:settings.version,
        bank_transfer_deadline_days:bankAvailable?settings.document.bank_transfer!.deadline_days:null,
        meetup_deadline_days:meetupAvailable?settings.document.cash_on_meetup!.deadline_days:null}:null};
    },
    async onOfflineOrderPlaced(q,placed){
      await scheduleDueWork(q,{tenantId:placed.tenantId,instanceId:placed.instanceId,kind:'offline_payment_window_end',targetId:placed.orderId,dueAt:new Date(placed.expiresAt.getTime()+OFFLINE_CONFIRMATION_GRACE_MS)});
    },
  };
}
