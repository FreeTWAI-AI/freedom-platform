import { deepFreeze } from './errors.js';
import { isKnownPostalPrefix, isOutlyingPostalPrefix } from './postal.js';
import { findCdnBlockedTerm } from '../../providers/ecpay/index.js';

export type RecipientValidationCode =
  | 'required'
  | 'format'
  | 'too_short'
  | 'too_long'
  | 'unknown_postal_code'
  | 'blocked_term';

export interface RecipientValidationError {
  readonly field: string;
  readonly code: RecipientValidationCode;
}

export type FieldValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: RecipientValidationCode };

export interface HomeRecipient {
  readonly name: string;
  readonly mobile: string;
  readonly postal_code: string;
  readonly address: string;
  readonly postal_prefix: string;
  readonly outlying: boolean;
}

export interface CvsRecipient {
  readonly name: string;
  readonly mobile: string;
}

export interface NormalizedCvsStore {
  readonly sub_type: 'UNIMARTC2C' | 'FAMIC2C' | 'HILIFEC2C';
  readonly store_id: string;
  readonly store_name: string;
  readonly store_address: string;
  readonly outlying: boolean;
}

export type HomeRecipientResult =
  | { readonly ok: true; readonly recipient: HomeRecipient }
  | { readonly ok: false; readonly errors: readonly RecipientValidationError[] };

export type CvsRecipientResult =
  | { readonly ok: true; readonly recipient: CvsRecipient }
  | { readonly ok: false; readonly errors: readonly RecipientValidationError[] };

export type CvsStoreSelectionResult =
  | { readonly ok: true; readonly store: NormalizedCvsStore }
  | { readonly ok: false; readonly errors: readonly RecipientValidationError[] };

/**
 * Validates recipient name:
 * - NFKC, trim
 * - empty -> required
 * - ^(?:\p{Script=Han}|[A-Za-z])+$ (flag u) else format
 * - weight: 2 per Han char, 1 per ASCII letter
 * - weight < 4 -> too_short, > 10 -> too_long
 */
export function validateRecipientName(raw: unknown): FieldValidationResult<string> {
  if (raw === undefined || raw === null) {
    return { ok: false, code: 'required' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'format' };
  }

  const name = raw.normalize('NFKC').trim();
  if (name.length === 0) {
    return { ok: false, code: 'required' };
  }

  if (!/^(?:\p{Script=Han}|[A-Za-z])+$/u.test(name)) {
    return { ok: false, code: 'format' };
  }

  let weight = 0;
  for (const ch of name) {
    if (/\p{Script=Han}/u.test(ch)) {
      weight += 2;
    } else if (/[A-Za-z]/.test(ch)) {
      weight += 1;
    }
  }

  if (weight < 4) {
    return { ok: false, code: 'too_short' };
  }
  if (weight > 10) {
    return { ok: false, code: 'too_long' };
  }

  if (findCdnBlockedTerm(name) !== null) {
    return { ok: false, code: 'blocked_term' };
  }

  return { ok: true, value: name };
}

/**
 * Normalizes mobile number:
 * - NFKC, remove spaces, -, (, )
 * - ^\+8869[0-9]{8}$ becomes 0 + last 9 digits
 * - must match ^09[0-9]{8}$ else format
 */
export function normalizeMobile(raw: unknown): FieldValidationResult<string> {
  if (raw === undefined || raw === null) {
    return { ok: false, code: 'required' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'format' };
  }

  let s = raw.normalize('NFKC');
  if (s.trim().length === 0) {
    return { ok: false, code: 'required' };
  }

  s = s.replace(/[\s\-()]/g, '');

  if (/^\+8869[0-9]{8}$/.test(s)) {
    s = '0' + s.slice(4);
  }

  if (!/^09[0-9]{8}$/.test(s)) {
    return { ok: false, code: 'format' };
  }

  return { ok: true, value: s };
}

function cleanAddressText(raw: unknown): FieldValidationResult<string> {
  if (raw === undefined || raw === null) {
    return { ok: false, code: 'required' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'format' };
  }

  let s = raw.normalize('NFKC');
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  s = s.replace(/\s+/g, ' ').trim();

  if (s.length === 0) {
    return { ok: false, code: 'required' };
  }

  if (/[<>&]/.test(s)) {
    return { ok: false, code: 'format' };
  }

  const codePointCount = [...s].length;
  if (codePointCount <= 6) {
    return { ok: false, code: 'too_short' };
  }
  if (codePointCount > 60) {
    return { ok: false, code: 'too_long' };
  }

  if (findCdnBlockedTerm(s) !== null) {
    return { ok: false, code: 'blocked_term' };
  }

  return { ok: true, value: s };
}

function validatePostalCode(raw: unknown): FieldValidationResult<{ code: string; prefix: string }> {
  if (raw === undefined || raw === null) {
    return { ok: false, code: 'required' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'format' };
  }

  let s = raw.normalize('NFKC').replace(/[\s\-]/g, '');
  if (s.length === 0) {
    return { ok: false, code: 'required' };
  }

  if (!/^(?:[0-9]{3}|[0-9]{5}|[0-9]{6})$/.test(s)) {
    return { ok: false, code: 'format' };
  }

  const prefix = s.slice(0, 3);
  if (!isKnownPostalPrefix(prefix)) {
    return { ok: false, code: 'unknown_postal_code' };
  }

  return { ok: true, value: { code: s, prefix } };
}

export function validateHomeRecipient(raw: unknown): HomeRecipientResult {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const errors: RecipientValidationError[] = [];

  const nameRes = validateRecipientName(input.name);
  if (!nameRes.ok) {
    errors.push({ field: 'name', code: nameRes.code });
  }

  const mobileRes = normalizeMobile(input.mobile);
  if (!mobileRes.ok) {
    errors.push({ field: 'mobile', code: mobileRes.code });
  }

  const postalRes = validatePostalCode(input.postal_code);
  if (!postalRes.ok) {
    errors.push({ field: 'postal_code', code: postalRes.code });
  }

  const addressRes = cleanAddressText(input.address);
  if (!addressRes.ok) {
    errors.push({ field: 'address', code: addressRes.code });
  }

  if (errors.length > 0) {
    return deepFreeze({ ok: false, errors });
  }

  const postalVal = postalRes.ok ? postalRes.value : { code: '', prefix: '' };
  return deepFreeze({
    ok: true,
    recipient: {
      name: nameRes.ok ? nameRes.value : '',
      mobile: mobileRes.ok ? mobileRes.value : '',
      postal_code: postalVal.code,
      address: addressRes.ok ? addressRes.value : '',
      postal_prefix: postalVal.prefix,
      outlying: isOutlyingPostalPrefix(postalVal.prefix),
    },
  });
}

export function validateCvsRecipient(raw: unknown): CvsRecipientResult {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const errors: RecipientValidationError[] = [];

  const nameRes = validateRecipientName(input.name);
  if (!nameRes.ok) {
    errors.push({ field: 'name', code: nameRes.code });
  }

  const mobileRes = normalizeMobile(input.mobile);
  if (!mobileRes.ok) {
    errors.push({ field: 'mobile', code: mobileRes.code });
  }

  if (errors.length > 0) {
    return deepFreeze({ ok: false, errors });
  }

  return deepFreeze({
    ok: true,
    recipient: {
      name: nameRes.ok ? nameRes.value : '',
      mobile: mobileRes.ok ? mobileRes.value : '',
    },
  });
}

const CVS_OUTLYING_KEYWORDS: readonly string[] = Object.freeze([
  '澎湖縣',
  '金門縣',
  '連江縣',
  '馬公市',
  '湖西鄉',
  '白沙鄉',
  '西嶼鄉',
  '望安鄉',
  '七美鄉',
  '金城鎮',
  '金湖鎮',
  '金沙鎮',
  '金寧鄉',
  '烈嶼鄉',
  '烏坵鄉',
  '南竿鄉',
  '北竿鄉',
  '莒光鄉',
  '東引鄉',
  '琉球鄉',
  '綠島鄉',
  '蘭嶼鄉',
]);

export function normalizeCvsStoreSelection(raw: unknown): CvsStoreSelectionResult {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const errors: RecipientValidationError[] = [];

  // 1. sub_type
  let subType: 'UNIMARTC2C' | 'FAMIC2C' | 'HILIFEC2C' | null = null;
  if (input.sub_type === undefined || input.sub_type === null) {
    errors.push({ field: 'sub_type', code: 'required' });
  } else if (typeof input.sub_type !== 'string') {
    errors.push({ field: 'sub_type', code: 'format' });
  } else {
    const st = input.sub_type.normalize('NFKC').trim();
    if (st.length === 0) {
      errors.push({ field: 'sub_type', code: 'required' });
    } else if (st === 'UNIMARTC2C' || st === 'FAMIC2C' || st === 'HILIFEC2C') {
      subType = st;
    } else {
      errors.push({ field: 'sub_type', code: 'format' });
    }
  }

  // 2. store_id
  let storeId: string | null = null;
  if (input.store_id === undefined || input.store_id === null) {
    errors.push({ field: 'store_id', code: 'required' });
  } else if (typeof input.store_id !== 'string') {
    errors.push({ field: 'store_id', code: 'format' });
  } else {
    const sid = input.store_id.normalize('NFKC').trim();
    if (sid.length === 0) {
      errors.push({ field: 'store_id', code: 'required' });
    } else if (/^[0-9A-Za-z]{1,6}$/.test(sid)) {
      storeId = sid;
    } else if (/^[0-9A-Za-z]{7,9}$/.test(sid)) {
      errors.push({ field: 'store_id', code: 'too_long' });
    } else {
      errors.push({ field: 'store_id', code: 'format' });
    }
  }

  // 3. store_name
  let storeName: string | null = null;
  if (input.store_name === undefined || input.store_name === null) {
    errors.push({ field: 'store_name', code: 'required' });
  } else if (typeof input.store_name !== 'string') {
    errors.push({ field: 'store_name', code: 'format' });
  } else {
    let sn = input.store_name.normalize('NFKC');
    sn = sn.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    sn = sn.replace(/\s+/g, ' ').trim();
    if (sn.length === 0) {
      errors.push({ field: 'store_name', code: 'required' });
    } else {
      const len = [...sn].length;
      if (len > 10) {
        errors.push({ field: 'store_name', code: 'too_long' });
      } else {
        storeName = sn;
      }
    }
  }

  // 4. store_address
  let storeAddress: string | null = null;
  if (input.store_address === undefined || input.store_address === null) {
    errors.push({ field: 'store_address', code: 'required' });
  } else if (typeof input.store_address !== 'string') {
    errors.push({ field: 'store_address', code: 'format' });
  } else {
    let sa = input.store_address.normalize('NFKC');
    sa = sa.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    sa = sa.replace(/\s+/g, ' ').trim();
    if (sa.length === 0) {
      errors.push({ field: 'store_address', code: 'required' });
    } else {
      const len = [...sa].length;
      if (len > 60) {
        errors.push({ field: 'store_address', code: 'too_long' });
      } else {
        storeAddress = sa;
      }
    }
  }

  // 5. outside
  let outside: '0' | '1' | null = null;
  let outsideProvided = false;
  if (input.outside !== undefined && input.outside !== null) {
    if (typeof input.outside !== 'string') {
      errors.push({ field: 'outside', code: 'format' });
    } else {
      const o = input.outside.normalize('NFKC').trim();
      if (o.length > 0) {
        if (o === '0' || o === '1') {
          outside = o;
          outsideProvided = true;
        } else {
          errors.push({ field: 'outside', code: 'format' });
        }
      }
    }
  }

  if (errors.length > 0) {
    return deepFreeze({ ok: false, errors });
  }

  let outlying: boolean;
  if (outsideProvided) {
    outlying = outside === '1';
  } else {
    const compactAddress = storeAddress!.replace(/\s+/g, '');
    outlying = CVS_OUTLYING_KEYWORDS.some(name => compactAddress.includes(name));
  }

  return deepFreeze({
    ok: true,
    store: {
      sub_type: subType!,
      store_id: storeId!,
      store_name: storeName!,
      store_address: storeAddress!,
      outlying,
    },
  });
}
