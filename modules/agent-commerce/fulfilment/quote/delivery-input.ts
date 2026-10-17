import type {DeliveryFieldErrorCode,ShippingMethodRef} from '../../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {isOutlyingPostalPrefix} from '../rules/postal.js';
import {normalizeMobile,validateCvsRecipient,validateHomeRecipient,validatePostalCode} from '../rules/recipient.js';

const METHODS=['home','cvs:UNIMARTC2C','cvs:FAMIC2C','cvs:HILIFEC2C','meetup'] as const;
type Method=(typeof METHODS)[number];
export interface DeliveryField {readonly path:string;readonly code:DeliveryFieldErrorCode}
export type ParsedDelivery={ok:true;method:ShippingMethodRef;outlying:boolean}|{ok:false;fields:readonly DeliveryField[]};

const HOME_KEYS=['method','name','mobile','postal_code','address'];
const RECIPIENT_KEYS=['method','name','mobile'];
const LIMITS={name:40,mobile:20,postal_code:10,address:120} as const;
/** CheckoutErrorSchema accepts `delivery` or `delivery.` plus an ASCII identifier, at most 80 characters. */
const SAFE_DELIVERY_KEY=/^[A-Za-z_][A-Za-z0-9_]*$/;
/** A valid surrogate pair is one code point. Only an unpaired half is malformed. */
const LONE_SURROGATE=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** C0, DEL, and C1. Meetup names are not ECPay names, so weight and blocked-term rules do not apply. */
const MEETUP_CONTROLS=/[\u0000-\u001F\u007F-\u009F]/u;

function isRecord(value:unknown):value is Record<string,unknown> {
  return typeof value==='object'&&value!==null&&!Array.isArray(value);
}
function capFields(fields:DeliveryField[]):DeliveryField[] {
  if(fields.length<=20)return fields;
  const generic=fields.findIndex(field=>field.path==='delivery');
  const head=fields.slice(0,20);
  if(generic<0||generic<20)return head;
  return [...head.slice(0,19),fields[generic]!];
}
function fail(fields:DeliveryField[]):ParsedDelivery {
  return {ok:false,fields:capFields(fields)};
}
/** Missing method is required; any other method value is format. Other keys wait until the method is known. */
function readMethod(raw:Record<string,unknown>):{ok:true;method:Method}|{ok:false;fields:DeliveryField[]} {
  if(!Object.prototype.hasOwnProperty.call(raw,'method')||raw.method===undefined)return {ok:false,fields:[{path:'delivery.method',code:'required'}]};
  if(typeof raw.method!=='string'||!(METHODS as readonly string[]).includes(raw.method))return {ok:false,fields:[{path:'delivery.method',code:'format'}]};
  return {ok:true,method:raw.method as Method};
}
function unknownField(key:string):DeliveryField {
  const path=`delivery.${key}`;
  if(SAFE_DELIVERY_KEY.test(key)&&path.length<=80)return {path,code:'format'};
  return {path:'delivery',code:'format'};
}
/** Unsafe keys share one generic path and are never copied into the field list. */
function pushUnknown(raw:Record<string,unknown>,allowed:readonly string[],fields:DeliveryField[]) {
  for(const key of Object.keys(raw)) {
    if(allowed.includes(key))continue;
    const field=unknownField(key);
    if(field.path==='delivery'){if(!fields.some(existing=>existing.path==='delivery'))fields.push(field);}
    else fields.push(field);
  }
}
function takeString(raw:Record<string,unknown>,key:keyof typeof LIMITS,required:boolean,fields:DeliveryField[]) {
  const path=`delivery.${key}`;
  if(!Object.prototype.hasOwnProperty.call(raw,key)||raw[key]===undefined){if(required)fields.push({path,code:'required'});return false;}
  if(typeof raw[key]!=='string'){fields.push({path,code:'format'});return false;}
  if((raw[key] as string).length>LIMITS[key]){fields.push({path,code:'too_long'});return false;}
  return true;
}
function addRecipient(fields:DeliveryField[],errors:readonly {field:string;code:DeliveryFieldErrorCode}[]) {
  for(const error of errors) {
    const path=`delivery.${error.field}`;
    if(!fields.some(field=>field.path===path))fields.push({path,code:error.code});
  }
}
/** Lone surrogates and controls are checked before and after NFKC so a control strip cannot join two halves. Code-point length applies after normalize. */
function meetupName(raw:string):{ok:true}|{ok:false;code:DeliveryFieldErrorCode} {
  if(LONE_SURROGATE.test(raw)||MEETUP_CONTROLS.test(raw))return {ok:false,code:'format'};
  const name=raw.normalize('NFKC').trim();
  if(LONE_SURROGATE.test(name)||MEETUP_CONTROLS.test(name))return {ok:false,code:'format'};
  if(name.length===0)return {ok:false,code:'required'};
  if([...name].length>40)return {ok:false,code:'too_long'};
  return {ok:true};
}
function pushMeetupName(raw:Record<string,unknown>,fields:DeliveryField[]) {
  if(!Object.prototype.hasOwnProperty.call(raw,'name')||raw.name===undefined){fields.push({path:'delivery.name',code:'required'});return;}
  if(typeof raw.name!=='string'){fields.push({path:'delivery.name',code:'format'});return;}
  // D5's structural bound is raw UTF-16 units. Installed Zod max(40) counts code points, so it cannot supply this guard.
  if(raw.name.length>LIMITS.name){fields.push({path:'delivery.name',code:'too_long'});return;}
  const name=meetupName(raw.name);
  if(!name.ok)fields.push({path:'delivery.name',code:name.code});
}

/** Structural bounds and recipient rules as one field list. Values are never copied into the result. */
export function parseCheckoutDelivery(raw:unknown):ParsedDelivery {
  if(!isRecord(raw))return fail([{path:'delivery',code:'format'}]);
  const method=readMethod(raw);
  if(!method.ok)return fail(method.fields);
  const allowed=method.method==='home'?HOME_KEYS:RECIPIENT_KEYS;
  const fields:DeliveryField[]=[];
  pushUnknown(raw,allowed,fields);
  const mobileOk=takeString(raw,'mobile',true,fields);
  let outlying=false;
  if(method.method==='home') {
    takeString(raw,'name',true,fields);takeString(raw,'postal_code',true,fields);takeString(raw,'address',true,fields);
    const recipient=validateHomeRecipient(raw);
    if(!recipient.ok)addRecipient(fields,recipient.errors);
    else outlying=recipient.recipient.outlying;
  } else if(method.method==='meetup') {
    pushMeetupName(raw,fields);
    if(mobileOk){const mobile=normalizeMobile(raw.mobile);if(!mobile.ok)fields.push({path:'delivery.mobile',code:mobile.code});}
  } else {
    takeString(raw,'name',true,fields);
    const recipient=validateCvsRecipient(raw);
    if(!recipient.ok)addRecipient(fields,recipient.errors);
  }
  return fields.length?fail(fields):{ok:true,method:method.method,outlying};
}

/** Cart delivery is method and, for home, an optional postal code. A present code uses the home postal rule. */
export function parseCartDelivery(raw:unknown):ParsedDelivery {
  if(!isRecord(raw))return fail([{path:'delivery',code:'format'}]);
  const method=readMethod(raw);
  if(!method.ok)return fail(method.fields);
  const allowed=method.method==='home'?['method','postal_code']:['method'];
  const fields:DeliveryField[]=[];
  pushUnknown(raw,allowed,fields);
  let outlying=false;
  if(method.method==='home'&&Object.prototype.hasOwnProperty.call(raw,'postal_code')&&raw.postal_code!==undefined) {
    if(takeString(raw,'postal_code',true,fields)) {
      const postal=validatePostalCode(raw.postal_code);
      if(!postal.ok)fields.push({path:'delivery.postal_code',code:postal.code});
      else outlying=isOutlyingPostalPrefix(postal.value.prefix);
    }
  }
  return fields.length?fail(fields):{ok:true,method:method.method,outlying};
}
