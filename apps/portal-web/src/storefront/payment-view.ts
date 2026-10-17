import {PublicOrderSchema, type PublicOrder} from '../../../../contracts/guild-launchpad/v1/hosted-checkout.js';

export type PaymentView =
  | 'review'
  | 'paid'
  | 'refunded'
  | 'checking'
  | 'closed'
  | 'awaiting'
  | 'expired'
  | 'failed'
  | 'ready';

export type PaymentOrderInput = Pick<
  PublicOrder,
  'payment_state' | 'lifecycle_state' | 'latest_payment_attempt' | 'reservation_expired'
>;

export function paymentView(order: PaymentOrderInput): PaymentView {
  if (order.payment_state === 'overpaid') return 'review';
  if (order.payment_state === 'confirmed') return 'paid';
  if (order.payment_state === 'refunded') return 'refunded';
  if (order.payment_state === 'pending') return 'checking';
  if (order.lifecycle_state !== 'open') return 'closed';
  const attemptState = order.latest_payment_attempt?.state;
  if (attemptState === 'paid') return 'checking';
  if (attemptState === 'awaiting_result') return 'awaiting';
  if (order.reservation_expired) return 'expired';
  if (attemptState === 'failed' || attemptState === 'expired') return 'failed';
  return 'ready';
}

const NON_NEGATIVE_INTEGER_PATTERN = /^[0-9]+$(?![\s\S])/;
const HANDOFF_URL_PATTERN = /^\/pay\/ecpay\/[A-Za-z0-9_-]{43}$(?![\s\S])/;

export function parseRetryAfter(header: string | null | undefined): number {
  if (typeof header !== 'string') return 60;
  const trimmed = header.trim();
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(trimmed)) return 60;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return 60;
  if (value < 1) return 1;
  if (value > 3600) return 3600;
  return Math.trunc(value);
}

export function isHandoffUrl(value: unknown): value is string {
  return typeof value === 'string' && HANDOFF_URL_PATTERN.test(value);
}

export function isPublicOrderShape(value: unknown): value is PublicOrder {
  return PublicOrderSchema.safeParse(value).success;
}

export type StartPaymentRefusedCode =
  | 'checkout_hold_expired'
  | 'payment_already_applied'
  | 'payment_attempts_exhausted'
  | 'checkout_order_closed'
  | 'payment_handoff_unavailable'
  | 'checkout_not_enabled';

export type QueryPaymentRefusedCode = 'checkout_not_enabled';

const START_REFUSED_CODES = new Set<StartPaymentRefusedCode>([
  'checkout_hold_expired',
  'payment_already_applied',
  'payment_attempts_exhausted',
  'checkout_order_closed',
  'payment_handoff_unavailable',
  'checkout_not_enabled',
]);

function isStartRefusedCode(code: unknown): code is StartPaymentRefusedCode {
  return typeof code === 'string' && START_REFUSED_CODES.has(code as StartPaymentRefusedCode);
}

export type StartPaymentOutcome =
  | { kind: 'redirect'; handoffUrl: string }
  | { kind: 'pending'; retryAfterSeconds: number }
  | { kind: 'refused'; code: StartPaymentRefusedCode }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'paused' }
  | { kind: 'payment_unavailable' }
  | { kind: 'not_found' }
  | { kind: 'failed' };

export type QueryPaymentOutcome =
  | { kind: 'ok'; order: PublicOrder }
  | { kind: 'pending'; retryAfterSeconds: number }
  | { kind: 'refused'; code: QueryPaymentRefusedCode }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'paused' }
  | { kind: 'payment_unavailable' }
  | { kind: 'not_found' }
  | { kind: 'failed' };

async function readErrorCode(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return undefined;
    return (body as { code?: unknown }).code;
  } catch {
    return undefined;
  }
}

export async function classifyStartPaymentResponse(response: Response): Promise<StartPaymentOutcome> {
  if (response.status === 201) {
    try {
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') return { kind: 'failed' };
      const handoffUrl = (body as { handoff_url?: unknown }).handoff_url;
      if (!isHandoffUrl(handoffUrl)) return { kind: 'failed' };
      return { kind: 'redirect', handoffUrl };
    } catch {
      return { kind: 'failed' };
    }
  }
  if (response.status === 409) {
    const code = await readErrorCode(response);
    if (code === 'payment_result_pending') {
      return {
        kind: 'pending',
        retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
      };
    }
    if (isStartRefusedCode(code)) {
      return { kind: 'refused', code };
    }
    return { kind: 'failed' };
  }
  if (response.status === 429) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
    };
  }
  if (response.status === 503) {
    const code = await readErrorCode(response);
    if (code === 'commerce_quarantined') return { kind: 'paused' };
    return { kind: 'payment_unavailable' };
  }
  if (response.status === 404) {
    return { kind: 'not_found' };
  }
  return { kind: 'failed' };
}

export async function classifyQueryPaymentResponse(
  response: Response,
  expectedOrderRef: string,
): Promise<QueryPaymentOutcome> {
  if (response.status === 200) {
    try {
      const body: unknown = await response.json();
      if (!isPublicOrderShape(body) || body.order_ref !== expectedOrderRef) {
        return { kind: 'failed' };
      }
      return { kind: 'ok', order: body };
    } catch {
      return { kind: 'failed' };
    }
  }
  if (response.status === 409) {
    const code = await readErrorCode(response);
    if (code === 'payment_result_pending') {
      return {
        kind: 'pending',
        retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
      };
    }
    if (code === 'checkout_not_enabled') {
      return { kind: 'refused', code: 'checkout_not_enabled' };
    }
    return { kind: 'failed' };
  }
  if (response.status === 429) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
    };
  }
  if (response.status === 503) {
    const code = await readErrorCode(response);
    if (code === 'commerce_quarantined') return { kind: 'paused' };
    return { kind: 'payment_unavailable' };
  }
  if (response.status === 404) {
    return { kind: 'not_found' };
  }
  return { kind: 'failed' };
}

export const PAYMENT_REFUSED_COPY: Record<StartPaymentRefusedCode, string> = {
  checkout_hold_expired: '保留時間已結束，請回到購物車重新下單。',
  payment_already_applied: '這筆訂單已收到付款。',
  payment_attempts_exhausted: '付款次數已達上限，請聯絡店家。',
  checkout_order_closed: '這筆訂單已結束，不能再付款。',
  payment_handoff_unavailable: '目前無法前往付款，請稍後再試。',
  checkout_not_enabled: '這間店目前沒有開放線上付款。',
};

export const PAYMENT_OUTCOME_COPY = {
  pending: '暫時無法確認這次付款的結果，請不要重複付款。',
  paused: '商店服務暫停中，請稍後再試。',
  payment_unavailable: '付款服務暫時無法使用，訂單與保留的商品不受影響，請稍後再試。',
  failed: '無法完成，請稍後重試。',
} as const;

export interface OrderPaymentSectionCopy {
  label: string;
  description: string | null;
  canQueryWhenOpen: boolean;
}

export function orderPaymentSectionCopy(view: PaymentView): OrderPaymentSectionCopy {
  switch (view) {
    case 'paid':
      return { label: '已付款', description: null, canQueryWhenOpen: false };
    case 'refunded':
      return {
        label: '已退款',
        description: '店家已登記退回這筆訂單收到的全部款項。入帳時間依發卡銀行而定，沒有收到時請聯絡店家。',
        canQueryWhenOpen: false,
      };
    case 'review':
      return {
        label: '付款金額待店家確認',
        description: '我們收到的付款和這筆訂單不符，店家會確認並處理退款。請不要再付款。',
        canQueryWhenOpen: false,
      };
    case 'checking':
      return {
        label: '付款確認中',
        description: '正在向付款服務確認結果，請不要重複付款。',
        canQueryWhenOpen: true,
      };
    case 'awaiting':
      return {
        label: '付款確認中',
        description: '還沒收到這次付款的結果。',
        canQueryWhenOpen: true,
      };
    case 'failed':
      return {
        label: '付款未完成',
        description: '這次付款沒有完成，沒有扣款。',
        canQueryWhenOpen: false,
      };
    case 'ready':
    case 'expired':
    case 'closed':
      return { label: '尚未付款', description: null, canQueryWhenOpen: false };
  }
}

const PRE_PAYMENT_EMAIL_NOTE_VIEWS = new Set<PaymentView>([
  'ready',
  'awaiting',
  'checking',
  'failed',
  'expired',
]);

export function orderEmailNote(view: PaymentView, emailEnabled: boolean): string | null {
  if (!emailEnabled) {
    return '這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家。';
  }
  if (PRE_PAYMENT_EMAIL_NOTE_VIEWS.has(view)) {
    return '付款確認後，訂單成立信會寄到你填寫的 Email。';
  }
  return null;
}
