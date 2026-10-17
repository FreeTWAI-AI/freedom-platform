import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {OfflineOrder} from './offline-order.js';
import {bootCheckoutPage} from './checkout-page.js';
import type { PublicOrder } from '../../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import { formatMinor } from '../../../../modules/agent-commerce/hosted/format.js';
import {
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  STORE_SLUG_PATTERN,
  cartCount,
  isValidCurrency,
  isValidPriceMinor,
  isValidProductSku,
  isValidRevision,
  isValidStoreSlug,
  isValidTitle,
  readCart,
  subscribe,
  writeCart,
  type CartCurrency,
  type StoredCart,
} from './cart-store.js';
import { formatRetryAfterTaipeiTime, formatTaipeiDateTime, formatTaipeiTime } from './format.js';
import {
  PAYMENT_OUTCOME_COPY,
  PAYMENT_REFUSED_COPY,
  classifyQueryPaymentResponse,
  classifyStartPaymentResponse,
  isPublicOrderShape,
  orderEmailNote,
  orderPaymentSectionCopy,
  paymentView,
  type PaymentView,
  type QueryPaymentOutcome,
  type StartPaymentOutcome,
} from './payment-view.js';

const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NON_NEGATIVE_INT_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INT_PATTERN = /^[0-9]+$/;
const QUOTE_DEBOUNCE_MS = 600;

type ErrorKind = 'rate_limited' | 'paused' | 'failed';
type OrderResult =
  | { kind: 'ok'; order: PublicOrder }
  | { kind: 'not_found' }
  | { kind: ErrorKind };

const ERROR_COPY: Record<ErrorKind, string> = {
  rate_limited: '嘗試次數太多，請稍後再試。',
  paused: '商店服務暫停中，請稍後再試。',
  failed: '無法取得訂單，請稍後重試。',
};

const CANCEL_REASON_COPY: Record<NonNullable<PublicOrder['cancel_reason']>, string> = {
  buyer_cancelled: '你取消了訂單',
  seller_cancelled: '店家取消了訂單',
  payment_not_completed: '未在期限內完成付款',
  paid_cancelled: '店家無法出貨，將退款',
};

export function parseQuantityInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!POSITIVE_INT_PATTERN.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LINE_QUANTITY) return null;
  return value;
}

function formatOrderLifecycle(order: PublicOrder): string {
  if (order.lifecycle_state === 'open') return '進行中';
  if (order.lifecycle_state === 'closed') return '已完成';
  const reason = order.cancel_reason ? CANCEL_REASON_COPY[order.cancel_reason] : undefined;
  return reason ? `已取消（${reason}）` : '已取消';
}

async function classifyOrderResponse(response: Response): Promise<OrderResult> {
  if (response.status >= 200 && response.status < 300) {
    try {
      const body: unknown = await response.json();
      if (!isPublicOrderShape(body)) return { kind: 'failed' };
      return { kind: 'ok', order: body };
    } catch {
      return { kind: 'failed' };
    }
  }
  if ([401, 403, 404].includes(response.status)) return { kind: 'not_found' };
  if (response.status === 429) return { kind: 'rate_limited' };
  if (response.status === 503) {
    try {
      const body = (await response.json()) as { code?: unknown };
      if (body && body.code === 'commerce_quarantined') return { kind: 'paused' };
    } catch {
      return { kind: 'failed' };
    }
    return { kind: 'failed' };
  }
  return { kind: 'failed' };
}

async function fetchPublicOrder(storeSlug: string, orderRef: string): Promise<OrderResult> {
  try {
    const response = await fetch(`/api/v1/public/stores/${encodeURIComponent(storeSlug)}/orders/${encodeURIComponent(orderRef)}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const result = await classifyOrderResponse(response);
    if (result.kind === 'ok' && (result.order.order_ref !== orderRef || result.order.store.slug !== storeSlug)) return {kind: 'failed'};
    return result;
  } catch {
    return { kind: 'failed' };
  }
}

async function postRedeemOrder(storeSlug: string, orderRef: string, token: string): Promise<OrderResult> {
  try {
    const response = await fetch(`/api/v1/public/stores/${encodeURIComponent(storeSlug)}/orders/${encodeURIComponent(orderRef)}/access`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    const result = await classifyOrderResponse(response);
    if (result.kind === 'ok' && (result.order.order_ref !== orderRef || result.order.store.slug !== storeSlug)) return {kind: 'failed'};
    return result;
  } catch {
    return { kind: 'failed' };
  }
}

async function postForgetBrowser(): Promise<'ok' | 'failed'> {
  try {
    const response = await fetch('/api/v1/public/order-access/forget', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    return response.status === 204 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

async function startPayment(storeSlug: string, orderRef: string): Promise<StartPaymentOutcome> {
  try {
    const response = await fetch(
      `/api/v1/public/stores/${encodeURIComponent(storeSlug)}/orders/${encodeURIComponent(orderRef)}/payment-handoffs`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    return await classifyStartPaymentResponse(response);
  } catch {
    return { kind: 'failed' };
  }
}

async function queryPayment(storeSlug: string, orderRef: string): Promise<QueryPaymentOutcome> {
  try {
    const response = await fetch(
      `/api/v1/public/stores/${encodeURIComponent(storeSlug)}/orders/${encodeURIComponent(orderRef)}/payment-queries`,
      {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    return await classifyQueryPaymentResponse(response, orderRef);
  } catch {
    return { kind: 'failed' };
  }
}

type PaymentAlertState =
  | { section: 'action' | 'payment'; kind: 'text'; text: string }
  | { section: 'action' | 'payment'; kind: 'hold_expired'; storeSlug: string }
  | null;

function renderPaymentAlert(alert: NonNullable<PaymentAlertState>) {
  if (alert.kind === 'hold_expired') {
    return (
      <p role="alert" className="shop-order-alert shop-pay-alert">
        <span>{PAYMENT_REFUSED_COPY.checkout_hold_expired}</span>{' '}
        <a href={`/shops/${alert.storeSlug}/cart`}>前往購物車</a>
      </p>
    );
  }
  return (
    <p role="alert" className="shop-order-alert">
      {alert.text}
    </p>
  );
}

function consumeAccessHash(): { kind: 'none' } | { kind: 'valid'; token: string } | { kind: 'malformed' } {
  if (!window.location.hash.startsWith('#access=')) {
    return { kind: 'none' };
  }
  const raw = window.location.hash.slice('#access='.length);
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  if (ACCESS_TOKEN_PATTERN.test(raw)) {
    return { kind: 'valid', token: raw };
  }
  return { kind: 'malformed' };
}

interface TokenBox {
  read(): string | null;
  write(next: string): void;
  clear(): void;
}

interface OrderPageProps {
  container: HTMLElement;
  storeSlug: string;
  storeName: string;
  orderRef: string;
  tokenBox: TokenBox;
  malformedAccessLink: boolean;
  emailEnabled: boolean;
}

type ViewState = 'loading' | 'link_prompt' | 'order' | 'not_found' | 'invalid_link' | 'forgotten';

function OrderPage({ container, storeSlug, storeName, orderRef, tokenBox, malformedAccessLink, emailEnabled }: OrderPageProps) {
  const [view, setView] = useState<ViewState>(malformedAccessLink ? 'invalid_link' : 'loading');
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [retryTarget, setRetryTarget] = useState<'get' | 'redeem'>('get');
  const [busy, setBusy] = useState<boolean>(!malformedAccessLink);
  const [redeeming, setRedeeming] = useState<boolean>(false);
  const [forgetting, setForgetting] = useState<boolean>(false);
  const [forgetError, setForgetError] = useState<boolean>(false);
  const [focusHeadingTrigger, setFocusHeadingTrigger] = useState<number>(0);
  const [focusPaymentHeadingTrigger, setFocusPaymentHeadingTrigger] = useState<number>(0);

  const [paymentBusy, setPaymentBusy] = useState<boolean>(false);
  const [redirecting, setRedirecting] = useState<boolean>(false);
  const [pendingHidePayButtons, setPendingHidePayButtons] = useState<boolean>(false);
  const [startRateLimited, setStartRateLimited] = useState<boolean>(false);
  const [queryRateLimited, setQueryRateLimited] = useState<boolean>(false);
  const [paymentAlert, setPaymentAlert] = useState<PaymentAlertState>(null);
  const [queryStatus, setQueryStatus] = useState<string>('');

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const paymentHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const forgetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const forgottenTransitionRef = useRef<boolean>(false);
  const redeemRejectedRef = useRef<boolean>(false);
  const initialTitleRef = useRef<string>(document.title);
  const orderReadGeneration = useRef(0);

  const paymentInFlightRef = useRef<boolean>(false);
  const redirectingRef = useRef<boolean>(false);
  const pendingHideTimerRef = useRef<number | null>(null);
  const startRateLimitTimerRef = useRef<number | null>(null);
  const queryRateLimitTimerRef = useRef<number | null>(null);

  const anyBusy = busy || forgetting || paymentBusy;

  useEffect(() => {
    container.setAttribute('aria-busy', anyBusy ? 'true' : 'false');
  }, [container, anyBusy]);

  useEffect(() => {
    if (view === 'order' && order) {
      document.title = `訂單 ${order.display_number}｜${order.store.name}｜自由工坊`;
    } else {
      document.title = initialTitleRef.current;
    }
  }, [view, order]);

  useEffect(() => {
    if (focusHeadingTrigger > 0) {
      headingRef.current?.focus();
    }
  }, [focusHeadingTrigger, view]);

  useEffect(() => {
    if (focusPaymentHeadingTrigger > 0) {
      paymentHeadingRef.current?.focus();
    }
  }, [focusPaymentHeadingTrigger, order]);

  function clearPendingHideTimer() {
    if (pendingHideTimerRef.current !== null) {
      window.clearTimeout(pendingHideTimerRef.current);
      pendingHideTimerRef.current = null;
    }
  }

  function clearStartRateLimitTimer() {
    if (startRateLimitTimerRef.current !== null) {
      window.clearTimeout(startRateLimitTimerRef.current);
      startRateLimitTimerRef.current = null;
    }
  }

  function clearQueryRateLimitTimer() {
    if (queryRateLimitTimerRef.current !== null) {
      window.clearTimeout(queryRateLimitTimerRef.current);
      queryRateLimitTimerRef.current = null;
    }
  }

  function armPendingHideTimer(seconds: number) {
    clearPendingHideTimer();
    setPendingHidePayButtons(true);
    pendingHideTimerRef.current = window.setTimeout(() => {
      pendingHideTimerRef.current = null;
      setPendingHidePayButtons(false);
    }, seconds * 1000);
  }

  function armStartRateLimitTimer(seconds: number) {
    clearStartRateLimitTimer();
    setStartRateLimited(true);
    startRateLimitTimerRef.current = window.setTimeout(() => {
      startRateLimitTimerRef.current = null;
      setStartRateLimited(false);
    }, seconds * 1000);
  }

  function armQueryRateLimitTimer(seconds: number) {
    clearQueryRateLimitTimer();
    setQueryRateLimited(true);
    queryRateLimitTimerRef.current = window.setTimeout(() => {
      queryRateLimitTimerRef.current = null;
      setQueryRateLimited(false);
    }, seconds * 1000);
  }

  async function runInitialOrRetryGet() {
    const generation = ++orderReadGeneration.current;
    setBusy(true);
    const result = await fetchPublicOrder(storeSlug, orderRef);
    if (generation !== orderReadGeneration.current) return;
    if (result.kind === 'ok') {
      redeemRejectedRef.current = false;
      tokenBox.clear();
      setOrder(result.order);
      setErrorKind(null);
      setView('order');
      setBusy(false);
      return;
    }
    if (result.kind === 'not_found') {
      setErrorKind(null);
      setOrder(null);
      setPaymentAlert(null);
      if (tokenBox.read() !== null) {
        setView('link_prompt');
      } else if (redeemRejectedRef.current) {
        redeemRejectedRef.current = false;
        setView('invalid_link');
      } else {
        setView('not_found');
      }
      setBusy(false);
      return;
    }
    setErrorKind(result.kind);
    setRetryTarget('get');
    setBusy(false);
  }

  async function cancelOfflineOrder() {
    if (paymentInFlightRef.current || busy || forgetting || !order || order.payment_method === 'immediate_card') return;
    const generation = ++orderReadGeneration.current;
    paymentInFlightRef.current = true;
    setPaymentBusy(true);
    setPaymentAlert(null);
    try {
      const response = await fetch(`/api/v1/public/stores/${encodeURIComponent(storeSlug)}/orders/${encodeURIComponent(orderRef)}/cancel`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {Accept: 'application/json', 'Content-Type': 'application/json'}, body: '{}',
      });
      const result = await classifyOrderResponse(response);
      if (generation !== orderReadGeneration.current) return;
      if (result.kind === 'ok' && result.order.order_ref === orderRef && result.order.store.slug === storeSlug) {
        setOrder(result.order);
        setErrorKind(null);
      } else if (result.kind === 'not_found' || response.status === 403) {
        setOrder(null);
        setView('not_found');
      } else {
        await reReadOrderAfterPayment(false);
        setPaymentAlert({section: 'payment', kind: 'text', text: '尚未確認訂單已取消。請查看最新狀態後再試。'});
      }
    } catch {
      if (generation !== orderReadGeneration.current) return;
      await reReadOrderAfterPayment(false);
      setPaymentAlert({section: 'payment', kind: 'text', text: '尚未確認訂單已取消。請查看最新狀態後再試。'});
    } finally {
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
    }
  }

  async function reReadOrderAfterPayment(preserveAlertOnError: boolean): Promise<PublicOrder | null> {
    const generation = orderReadGeneration.current;
    const result = await fetchPublicOrder(storeSlug, orderRef);
    if (generation !== orderReadGeneration.current) return null;
    if (result.kind === 'ok') {
      setOrder(result.order);
      setErrorKind(null);
      setView('order');
      return result.order;
    }
    if (result.kind === 'not_found') {
      setOrder(null);
      setErrorKind(null);
      setPaymentAlert(null);
      setView('not_found');
      return null;
    }
    if (!preserveAlertOnError) {
      setErrorKind(result.kind);
      setRetryTarget('get');
    }
    return null;
  }

  async function handleStartPayment() {
    if (paymentInFlightRef.current || busy || forgetting || redirectingRef.current || startRateLimited) return;
    paymentInFlightRef.current = true;
    setPaymentBusy(true);
    const activeOrderSlug = order?.store.slug ?? storeSlug;
    const outcome = await startPayment(activeOrderSlug, orderRef);

    if (outcome.kind === 'redirect') {
      setPaymentAlert(null);
      redirectingRef.current = true;
      setRedirecting(true);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      window.location.assign(outcome.handoffUrl);
      return;
    }

    if (outcome.kind === 'pending') {
      setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_OUTCOME_COPY.pending });
      armPendingHideTimer(outcome.retryAfterSeconds);
      await reReadOrderAfterPayment(true);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'refused') {
      if (outcome.code === 'checkout_hold_expired') {
        setPaymentAlert({ section: 'action', kind: 'hold_expired', storeSlug: activeOrderSlug });
      } else {
        setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_REFUSED_COPY[outcome.code] });
      }
      await reReadOrderAfterPayment(true);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'rate_limited') {
      const retryTime = formatRetryAfterTaipeiTime(outcome.retryAfterSeconds);
      setPaymentAlert({
        section: 'action',
        kind: 'text',
        text: `操作太頻繁，請在 ${retryTime} 後再試。`,
      });
      armStartRateLimitTimer(outcome.retryAfterSeconds);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'paused') {
      setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_OUTCOME_COPY.paused });
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'payment_unavailable') {
      setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_OUTCOME_COPY.payment_unavailable });
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'not_found') {
      setPaymentAlert(null);
      await reReadOrderAfterPayment(false);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_OUTCOME_COPY.failed });
    paymentInFlightRef.current = false;
    setPaymentBusy(false);
  }

  async function handleQueryPayment() {
    if (paymentInFlightRef.current || busy || forgetting || redirectingRef.current || queryRateLimited) return;
    paymentInFlightRef.current = true;
    setPaymentBusy(true);
    const activeOrderSlug = order?.store.slug ?? storeSlug;
    const outcome = await queryPayment(activeOrderSlug, orderRef);

    if (outcome.kind === 'ok') {
      const nextView = paymentView(outcome.order);
      const nextCopy = orderPaymentSectionCopy(nextView);
      const nextHasQueryButton = outcome.order.lifecycle_state === 'open' && nextCopy.canQueryWhenOpen;
      setOrder(outcome.order);
      setPaymentAlert(null);
      setQueryStatus(`${formatTaipeiTime(Date.now())} 已查詢：${nextCopy.label}`);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      if (!nextHasQueryButton) {
        setFocusPaymentHeadingTrigger(count => count + 1);
      }
      return;
    }

    setQueryStatus('');

    if (outcome.kind === 'pending') {
      setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_OUTCOME_COPY.pending });
      armPendingHideTimer(outcome.retryAfterSeconds);
      const nextOrder = await reReadOrderAfterPayment(true);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      if (nextOrder) {
        const nextCopy = orderPaymentSectionCopy(paymentView(nextOrder));
        if (!(nextOrder.lifecycle_state === 'open' && nextCopy.canQueryWhenOpen)) {
          setFocusPaymentHeadingTrigger(count => count + 1);
        }
      }
      return;
    }

    if (outcome.kind === 'refused') {
      setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_REFUSED_COPY[outcome.code] });
      const nextOrder = await reReadOrderAfterPayment(true);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      if (nextOrder) {
        const nextCopy = orderPaymentSectionCopy(paymentView(nextOrder));
        if (!(nextOrder.lifecycle_state === 'open' && nextCopy.canQueryWhenOpen)) {
          setFocusPaymentHeadingTrigger(count => count + 1);
        }
      }
      return;
    }

    if (outcome.kind === 'rate_limited') {
      const retryTime = formatRetryAfterTaipeiTime(outcome.retryAfterSeconds);
      setPaymentAlert({
        section: 'payment',
        kind: 'text',
        text: `操作太頻繁，請在 ${retryTime} 後再試。`,
      });
      armQueryRateLimitTimer(outcome.retryAfterSeconds);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'paused') {
      setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_OUTCOME_COPY.paused });
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'payment_unavailable') {
      setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_OUTCOME_COPY.payment_unavailable });
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'not_found') {
      setPaymentAlert(null);
      await reReadOrderAfterPayment(false);
      paymentInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_OUTCOME_COPY.failed });
    paymentInFlightRef.current = false;
    setPaymentBusy(false);
  }

  async function runRedeem() {
    const generation = ++orderReadGeneration.current;
    const token = tokenBox.read();
    if (!token) {
      setView('invalid_link');
      return;
    }
    setBusy(true);
    setRedeeming(true);
    const result = await postRedeemOrder(storeSlug, orderRef, token);
    if (generation !== orderReadGeneration.current) return;
    if (result.kind === 'ok') {
      redeemRejectedRef.current = false;
      tokenBox.clear();
      setOrder(result.order);
      setErrorKind(null);
      setRedeeming(false);
      setBusy(false);
      setView('order');
      setFocusHeadingTrigger(count => count + 1);
      return;
    }
    if (result.kind === 'not_found') {
      tokenBox.clear();
      redeemRejectedRef.current = true;
      const followUp = await fetchPublicOrder(storeSlug, orderRef);
      if (generation !== orderReadGeneration.current) return;
      setRedeeming(false);
      setBusy(false);
      if (followUp.kind === 'ok') {
        redeemRejectedRef.current = false;
        setOrder(followUp.order);
        setErrorKind(null);
        setView('order');
        setFocusHeadingTrigger(count => count + 1);
      } else if (followUp.kind === 'not_found') {
        redeemRejectedRef.current = false;
        setOrder(null);
        setErrorKind(null);
        setView('invalid_link');
      } else {
        setErrorKind(followUp.kind);
        setRetryTarget('get');
      }
      return;
    }
    setRedeeming(false);
    setBusy(false);
    setErrorKind(result.kind);
    setRetryTarget('redeem');
  }

  useEffect(() => {
    if (!malformedAccessLink) {
      void runInitialOrRetryGet();
    }
    function handleHashChange() {
      const consumed = consumeAccessHash();
      if (consumed.kind === 'none') return;
      if (consumed.kind === 'malformed') {
        orderReadGeneration.current++;
        redeemRejectedRef.current = false;
        tokenBox.clear();
        setOrder(null);
        setErrorKind(null);
        setRedeeming(false);
        setBusy(false);
        setView('invalid_link');
        return;
      }
      redeemRejectedRef.current = false;
      tokenBox.write(consumed.token);
      setErrorKind(null);
      void runInitialOrRetryGet();
    }
    function handlePageShow(event: PageTransitionEvent) {
      if (!event.persisted && !redirectingRef.current) return;
      redirectingRef.current = false;
      paymentInFlightRef.current = false;
      setRedirecting(false);
      setPaymentBusy(false);
      clearStartRateLimitTimer();
      clearQueryRateLimitTimer();
      setStartRateLimited(false);
      setQueryRateLimited(false);
      setOrder(null);
      setView('loading');
      void runInitialOrRetryGet();
    }
    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      orderReadGeneration.current++;
      window.removeEventListener('hashchange', handleHashChange);
      window.removeEventListener('pageshow', handlePageShow);
      clearPendingHideTimer();
      clearStartRateLimitTimer();
      clearQueryRateLimitTimer();
    };
  }, []);

  function handleRetry() {
    if (retryTarget === 'redeem' && tokenBox.read() !== null) {
      void runRedeem();
    } else {
      void runInitialOrRetryGet();
    }
  }

  function openForgetDialog() {
    setForgetError(false);
    forgottenTransitionRef.current = false;
    dialogRef.current?.showModal();
  }

  async function confirmForget() {
    orderReadGeneration.current++;
    setForgetting(true);
    const outcome = await postForgetBrowser();
    if (outcome === 'ok') {
      forgottenTransitionRef.current = true;
      dialogRef.current?.close();
      setForgetting(false);
      setErrorKind(null);
      setOrder(null);
      setPaymentAlert(null);
      setQueryStatus('');
      setView('forgotten');
      setFocusHeadingTrigger(count => count + 1);
      return;
    }
    setForgetting(false);
    setForgetError(true);
    dialogRef.current?.close();
  }

  const activeSlug = order?.store.slug ?? storeSlug;
  const activeStoreName = order?.store.name ?? storeName;
  const errorBlock = errorKind ? (
    <>
      <p role="alert" className="shop-order-alert">{ERROR_COPY[errorKind]}</p>
      <div className="shop-order-actions">
        <button type="button" className="shop-button shop-button-secondary" disabled={busy} onClick={handleRetry}>
          重試
        </button>
      </div>
    </>
  ) : null;

  if (view === 'loading') {
    return (
      <>
        <h1 id="shop-order-title" ref={headingRef} tabIndex={-1}>訂單</h1>
        {errorBlock ?? <p role="status">正在讀取訂單…</p>}
      </>
    );
  }

  if (view === 'link_prompt') {
    return (
      <>
        <h1 id="shop-order-title" ref={headingRef} tabIndex={-1}>開啟訂單</h1>
        <p role="status">這個訂單連結只能使用一次。開啟後，這個瀏覽器會記住這筆訂單，之後可以直接查看。</p>
        {errorBlock ?? (
          <div className="shop-order-actions">
            <button type="button" className="shop-button shop-button-prompt" disabled={busy} onClick={() => void runRedeem()}>
              {redeeming ? '正在開啟…' : '在這個瀏覽器開啟訂單'}
            </button>
          </div>
        )}
      </>
    );
  }

  if (view === 'not_found') {
    return (
      <>
        <h1 id="shop-order-title" ref={headingRef} tabIndex={-1}>找不到這筆訂單</h1>
        <p role="status">這個瀏覽器沒有這筆訂單的查看權限，或訂單不存在。訂單只能在下單時使用的瀏覽器，或以下單時登入的會員帳號查看。</p>
        {errorBlock}
        <div className="shop-order-actions">
          <a href={`/shops/${activeSlug}/order-access`}>找回訂單</a>
          <a href={`/shops/${activeSlug}`}>回到「{activeStoreName}」</a>
        </div>
      </>
    );
  }

  if (view === 'invalid_link') {
    return (
      <>
        <h1 id="shop-order-title" ref={headingRef} tabIndex={-1}>這個訂單連結無法使用</h1>
        <p role="status">連結可能已經用過、超過 7 天，或不屬於這筆訂單。每個訂單連結只能在一個瀏覽器開啟一次。</p>
        {errorBlock}
        <div className="shop-order-actions">
          <a href={`/shops/${activeSlug}/order-access`}>找回訂單</a>
          <a href={`/shops/${activeSlug}`}>回到「{activeStoreName}」</a>
        </div>
      </>
    );
  }

  if (view === 'forgotten' || !order) {
    return (
      <>
        <h1 id="shop-order-title" ref={headingRef} tabIndex={-1}>這個瀏覽器已忘記你的訂單</h1>
        <p role="status">之後在這個瀏覽器打開訂單網址，會顯示找不到訂單。</p>
        {errorBlock}
        <div className="shop-order-actions">
          <a href={`/shops/${activeSlug}`}>回到「{activeStoreName}」</a>
        </div>
      </>
    );
  }

  const currentPayView = paymentView(order);
  const offline = order.payment_method !== 'immediate_card';
  const isOpenOrder = order.lifecycle_state === 'open';
  const showActionSection =
    !offline && isOpenOrder &&
    (currentPayView === 'ready' ||
      currentPayView === 'expired' ||
      ((currentPayView === 'failed' || currentPayView === 'awaiting') && order.can_resume_payment));
  const paymentSection = orderPaymentSectionCopy(currentPayView);
  const emailNote = offline && emailEnabled ? '請保留訂單網址，也可以用下單時登入的會員帳號查看。' : orderEmailNote(currentPayView, emailEnabled);
  const paymentControlsDisabled = busy || forgetting || paymentBusy || redirecting;

  return (
    <>
      <div className="shop-order-header">
        <h1 id="shop-order-title" ref={headingRef} tabIndex={-1}>訂單 {order.display_number}</h1>
        <p className="shop-order-meta">
          <a href={`/shops/${order.store.slug}`}>{order.store.name}</a>・下單時間 {formatTaipeiDateTime(order.created_at)}
        </p>
        <p className="shop-order-status">訂單狀態：{formatOrderLifecycle(order)}</p>
      </div>
      {errorBlock}

      {offline && <OfflineOrder key={order.order_ref} order={order} disabled={paymentControlsDisabled}
        onCancel={cancelOfflineOrder} onRefresh={() => void runInitialOrRetryGet()} />}

      {showActionSection && (
        <section className="shop-order-section" aria-labelledby="shop-order-action-heading">
          <h2 id="shop-order-action-heading">需要你處理</h2>
          {currentPayView === 'ready' && (
            <>
              <p>請在 {formatTaipeiDateTime(order.pay_by)} 前完成付款，逾時保留的商品會釋出。</p>
              {order.can_resume_payment && !pendingHidePayButtons && (
                <div className="shop-order-actions">
                  <button
                    type="button"
                    className="shop-button shop-pay-primary"
                    disabled={paymentControlsDisabled || startRateLimited}
                    onClick={() => void handleStartPayment()}
                  >
                    {redirecting ? '正在前往付款…' : '前往付款'}
                  </button>
                </div>
              )}
            </>
          )}
          {currentPayView === 'failed' && order.can_resume_payment && (
            <>
              <p>請在 {formatTaipeiDateTime(order.pay_by)} 前重新付款，逾時保留的商品會釋出。</p>
              {!pendingHidePayButtons && (
                <div className="shop-order-actions">
                  <button
                    type="button"
                    className="shop-button shop-pay-primary"
                    disabled={paymentControlsDisabled || startRateLimited}
                    onClick={() => void handleStartPayment()}
                  >
                    {redirecting ? '正在前往付款…' : '重新付款'}
                  </button>
                </div>
              )}
            </>
          )}
          {currentPayView === 'awaiting' && order.can_resume_payment && (
            <>
              <p>如果你沒有完成付款，可以重新付款；我們會先向付款服務確認，不會重複扣款。</p>
              {!pendingHidePayButtons && (
                <div className="shop-order-actions">
                  <button
                    type="button"
                    className="shop-button shop-button-secondary"
                    disabled={paymentControlsDisabled || startRateLimited}
                    onClick={() => void handleStartPayment()}
                  >
                    {redirecting ? '正在前往付款…' : '重新付款'}
                  </button>
                </div>
              )}
            </>
          )}
          {currentPayView === 'expired' && (
            <>
              <p>付款期限已過，保留的商品已釋出。</p>
              <div className="shop-order-actions">
                <a href={`/shops/${order.store.slug}`}>回到「{order.store.name}」</a>
              </div>
            </>
          )}
          {paymentAlert && paymentAlert.section === 'action' && renderPaymentAlert(paymentAlert)}
        </section>
      )}

      <section className="shop-order-section" aria-labelledby="shop-order-payment-heading">
        <h2 id="shop-order-payment-heading" className="shop-pay-section-heading" ref={paymentHeadingRef} tabIndex={-1}>付款</h2>
        <p className="shop-pay-label">{offline && currentPayView === 'paid' ? '已收款（店家確認）' : paymentSection.label}</p>
        {!offline && paymentSection.description && <p>{paymentSection.description}</p>}
        {!offline && isOpenOrder && paymentSection.canQueryWhenOpen && (
          <div className="shop-order-actions">
            <button
              type="button"
              className="shop-button shop-button-secondary"
              disabled={paymentControlsDisabled || queryRateLimited}
              onClick={() => void handleQueryPayment()}
            >
              查詢付款結果
            </button>
          </div>
        )}
        <p role="status" className={queryStatus ? 'shop-pay-status' : 'shop-sr-only'}>
          {queryStatus}
        </p>
        {paymentAlert && (paymentAlert.section === 'payment' || !showActionSection) && renderPaymentAlert(paymentAlert)}
        {emailNote && <p className="shop-order-meta">{emailNote}</p>}
      </section>

      <section className="shop-order-section" aria-labelledby="shop-order-items-heading">
        <h2 id="shop-order-items-heading">商品</h2>
        <ul className="shop-order-lines">
          {order.lines.map(line => (
            <li key={line.sku} className="shop-order-line">
              <p className="shop-order-line-title">{line.title}</p>
              {line.options.length > 0 && (
                <p className="shop-order-line-options">
                  {line.options.map(opt => `${opt.name}：${opt.value}`).join('、')}
                </p>
              )}
              <p className="shop-order-line-numbers">
                <span>數量 {line.quantity}</span>
                <span>單價 {formatMinor(line.unit_price_minor, order.currency)}</span>
                <span className="shop-order-line-subtotal">小計 {formatMinor(line.line_total_minor, order.currency)}</span>
              </p>
            </li>
          ))}
        </ul>
        <dl className="shop-order-totals">
          <div className="shop-order-row">
            <dt>商品小計</dt>
            <dd>{formatMinor(order.merchandise_total_minor, order.currency)}</dd>
          </div>
          {order.discount_total_minor > 0 && (
            <div className="shop-order-row">
              <dt>折扣</dt>
              <dd>−{formatMinor(order.discount_total_minor, order.currency)}</dd>
            </div>
          )}
          <div className="shop-order-row">
            <dt>運費</dt>
            <dd>{formatMinor(order.shipping_total_minor, order.currency)}</dd>
          </div>
          <div className="shop-order-row shop-order-row-total">
            <dt>總額</dt>
            <dd>{formatMinor(order.total_minor, order.currency)}</dd>
          </div>
        </dl>
      </section>

      <section className="shop-order-section" aria-labelledby="shop-order-contact-heading">
        <h2 id="shop-order-contact-heading">聯絡資料</h2>
        {order.redacted || !order.contact ? (
          <p>這筆訂單的聯絡資料已依保存期限遮罩。</p>
        ) : (
          <dl className="shop-order-contact">
            <div className="shop-order-row">
              <dt>姓名</dt>
              <dd>{order.contact.name}</dd>
            </div>
            <div className="shop-order-row">
              <dt>Email</dt>
              <dd>{order.contact.email}</dd>
            </div>
            <div className="shop-order-row">
              <dt>手機</dt>
              <dd>{order.contact.phone}</dd>
            </div>
          </dl>
        )}
      </section>

      <section className="shop-order-section" aria-labelledby="shop-order-browser-heading">
        <h2 id="shop-order-browser-heading">這個瀏覽器</h2>
        <p>這個瀏覽器會記住你在自由工坊商店的訂單。用的是共用電腦的話，看完後請讓這個瀏覽器忘記訂單。</p>
        <div className="shop-order-actions">
          <button
            type="button"
            className="shop-button shop-button-secondary"
            ref={forgetTriggerRef}
            disabled={paymentControlsDisabled}
            onClick={openForgetDialog}
          >
            在這個瀏覽器忘記我的訂單
          </button>
        </div>
        {forgetError && <p role="alert" className="shop-order-alert">無法忘記訂單，請稍後重試。</p>}
        <dialog
          ref={dialogRef}
          className="shop-dialog"
          aria-labelledby="shop-forget-title"
          onCancel={event => {
            if (forgetting) event.preventDefault();
          }}
          onClose={() => {
            if (!forgottenTransitionRef.current) {
              forgetTriggerRef.current?.focus();
            }
          }}
        >
          <h2 id="shop-forget-title">要在這個瀏覽器忘記你的訂單嗎？</h2>
          <p>忘記後，這個瀏覽器就不能再打開你在任何自由工坊商店的訂單。這些商店目前不寄訂單信件；如果你下單時沒有登入會員，之後只能聯絡店家。</p>
          <div className="shop-order-actions">
            <button
              type="button"
              className="shop-button"
              disabled={forgetting}
              onClick={() => void confirmForget()}
            >
              忘記訂單
            </button>
            <button
              type="button"
              className="shop-button shop-button-secondary"
              disabled={forgetting}
              onClick={() => dialogRef.current?.close()}
            >
              取消
            </button>
          </div>
        </dialog>
      </section>
    </>
  );
}

interface AddToCartProps {
  storeSlug: string;
  sku: string;
  title: string;
  priceMinor: number;
  currency: CartCurrency;
  revision: string;
  onCartChanged: () => void;
}

type AddAlertKind = 'max_lines' | 'storage_error' | null;

function AddToCart({ storeSlug, sku, title, priceMinor, currency, revision, onCartChanged }: AddToCartProps) {
  const [rawQuantity, setRawQuantity] = useState<string>('1');
  const [alertKind, setAlertKind] = useState<AddAlertKind>(null);
  const [sheetQuantity, setSheetQuantity] = useState<number>(1);
  const [sheetCapped, setSheetCapped] = useState<boolean>(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const viewCartLinkRef = useRef<HTMLAnchorElement | null>(null);

  const parsedQuantity = parseQuantityInput(rawQuantity);
  const isInvalid = parsedQuantity === null;
  const errorId = 'shop-add-quantity-error';

  function handleAdd() {
    if (parsedQuantity === null) {
      inputRef.current?.focus();
      return;
    }
    setAlertKind(null);
    const currentCart = readCart(storeSlug);
    const existingIndex = currentCart.lines.findIndex(line => line.sku === sku);
    let nextQuantity = parsedQuantity;
    let wasCapped = false;
    const nextLines = currentCart.lines.slice();

    if (existingIndex >= 0) {
      const existing = nextLines[existingIndex];
      const sum = existing.quantity + parsedQuantity;
      if (sum > MAX_LINE_QUANTITY) {
        nextQuantity = MAX_LINE_QUANTITY;
        wasCapped = true;
      } else {
        nextQuantity = sum;
      }
      nextLines[existingIndex] = {
        sku,
        quantity: nextQuantity,
        title,
        price_minor: priceMinor,
        currency,
      };
    } else {
      if (nextLines.length >= MAX_CART_LINES) {
        setAlertKind('max_lines');
        return;
      }
      nextLines.push({
        sku,
        quantity: nextQuantity,
        title,
        price_minor: priceMinor,
        currency,
      });
    }

    const ok = writeCart(storeSlug, {
      revision,
      lines: nextLines,
    });
    if (!ok) {
      setAlertKind('storage_error');
      return;
    }

    setSheetQuantity(nextQuantity);
    setSheetCapped(wasCapped);
    onCartChanged();
    if (dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
    }
    viewCartLinkRef.current?.focus();
  }

  return (
    <>
      <div className="shop-add-controls">
        <label htmlFor="shop-add-quantity" className="shop-add-label">數量</label>
        <input
          id="shop-add-quantity"
          ref={inputRef}
          className="shop-quantity-input"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_LINE_QUANTITY}
          step={1}
          value={rawQuantity}
          aria-invalid={isInvalid ? 'true' : undefined}
          aria-describedby={isInvalid ? errorId : undefined}
          onChange={event => {
            setRawQuantity(event.target.value);
            if (alertKind) setAlertKind(null);
          }}
        />
        <button
          ref={addButtonRef}
          type="button"
          className="shop-button shop-add-submit"
          onClick={handleAdd}
        >
          加入購物車
        </button>
      </div>
      {isInvalid && (
        <p id={errorId} className="shop-field-error">請輸入 1 到 99 的數量。</p>
      )}
      {alertKind === 'max_lines' && (
        <div role="alert" className="shop-add-alert">
          <span>購物車最多放 50 項商品，請先到購物車移除一些商品。</span>
          <a href={`/shops/${storeSlug}/cart`}>查看購物車</a>
        </div>
      )}
      {alertKind === 'storage_error' && (
        <p role="alert" className="shop-add-alert">
          這個瀏覽器無法保存購物車。請允許這個網站儲存資料後再試一次。
        </p>
      )}
      <dialog
        ref={dialogRef}
        className="shop-cart-sheet"
        aria-labelledby="shop-cart-sheet-title"
        onClose={() => {
          addButtonRef.current?.focus();
        }}
      >
        <div className="shop-cart-sheet-top">
          <h2 id="shop-cart-sheet-title">已加入購物車</h2>
          <button
            type="button"
            className="shop-button shop-button-secondary"
            onClick={() => dialogRef.current?.close()}
          >
            關閉
          </button>
        </div>
        <p className="shop-cart-sheet-product">{title}</p>
        <p>購物車裡的數量：{sheetQuantity}</p>
        {sheetCapped && <p>每項商品最多 99 件，已調整為 99 件。</p>}
        <div className="shop-cart-sheet-actions">
          <a
            ref={viewCartLinkRef}
            href={`/shops/${storeSlug}/cart`}
            className="shop-button"
            autoFocus
          >
            查看購物車
          </a>
          <button
            type="button"
            className="shop-button shop-button-secondary"
            onClick={() => dialogRef.current?.close()}
          >
            繼續購物
          </button>
        </div>
      </dialog>
    </>
  );
}

interface CartQuoteOption {
  name: string;
  value: string;
}

type CartQuoteLineState = 'ok' | 'insufficient' | 'unavailable' | 'revision_changed';

interface CartQuoteLine {
  sku: string;
  title: string | null;
  options: CartQuoteOption[];
  unit_price_minor: number | null;
  quantity: number;
  line_total_minor: number | null;
  state: CartQuoteLineState;
  available?: number;
}

type CartQuoteShipping =
  | { state: 'quoted'; groups: { group_ref: string; amount_minor: number }[]; total_minor: number }
  | { state: 'needs_delivery_data' | 'not_configured'; groups: never[]; total_minor: null };

interface CartQuoteResponse {
  publication_revision: string;
  currency: CartCurrency;
  lines: CartQuoteLine[];
  merchandise_total_minor: number;
  discounts: never[];
  shipping: CartQuoteShipping;
  total_minor: number | null;
}

type CartErrorKind = 'rate_limited' | 'paused' | 'not_open' | 'store_not_found' | 'failed';

type CartQuoteResult =
  | { kind: 'ok'; quote: CartQuoteResponse }
  | { kind: CartErrorKind };

const CART_ALERT_COPY: Record<'rate_limited' | 'paused' | 'failed', string> = {
  rate_limited: '更新太頻繁，請稍後再試。',
  paused: '商店服務暫停中，請稍後再試。',
  failed: '無法取得最新價格，請稍後重試。',
};

function cartFullKey(cart: StoredCart): string {
  if (cart.lines.length === 0) return '';
  return `${cart.revision}|${cart.lines.map(line => `${line.sku}:${line.quantity}`).join(',')}`;
}

function isCartQuoteShape(
  value: unknown,
  requestedLines: readonly { sku: string; quantity: number }[],
): value is CartQuoteResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.publication_revision !== 'string' || !isValidRevision(candidate.publication_revision)) {
    return false;
  }
  if (!isValidCurrency(candidate.currency)) return false;
  if (!isValidPriceMinor(candidate.merchandise_total_minor)) return false;
  if (!Array.isArray(candidate.discounts) || candidate.discounts.length !== 0) return false;
  if (candidate.total_minor !== null && !isValidPriceMinor(candidate.total_minor)) return false;

  const shipping = candidate.shipping;
  if (!shipping || typeof shipping !== 'object' || Array.isArray(shipping)) return false;
  const shipRecord = shipping as Record<string, unknown>;
  if (shipRecord.state === 'quoted') {
    if (!Array.isArray(shipRecord.groups) || !isValidPriceMinor(shipRecord.total_minor)) return false;
    for (const group of shipRecord.groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
      const g = group as Record<string, unknown>;
      if (typeof g.group_ref !== 'string' || !isValidPriceMinor(g.amount_minor)) return false;
    }
  } else if (shipRecord.state === 'needs_delivery_data' || shipRecord.state === 'not_configured') {
    if (!Array.isArray(shipRecord.groups) || shipRecord.groups.length !== 0 || shipRecord.total_minor !== null) {
      return false;
    }
  } else {
    return false;
  }

  if (!Array.isArray(candidate.lines) || candidate.lines.length !== requestedLines.length) return false;
  for (let i = 0; i < requestedLines.length; i += 1) {
    const rawLine = candidate.lines[i];
    if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine)) return false;
    const line = rawLine as Record<string, unknown>;
    if (line.sku !== requestedLines[i].sku) return false;
    if (line.quantity !== requestedLines[i].quantity) return false;
    if (line.title !== null && !isValidTitle(line.title)) return false;
    if (!Array.isArray(line.options)) return false;
    for (const opt of line.options) {
      if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return false;
      const optRecord = opt as Record<string, unknown>;
      if (typeof optRecord.name !== 'string' || typeof optRecord.value !== 'string') return false;
    }
    if (line.unit_price_minor !== null && !isValidPriceMinor(line.unit_price_minor)) return false;
    if (line.line_total_minor !== null && !isValidPriceMinor(line.line_total_minor)) return false;
    if (
      line.state !== 'ok' &&
      line.state !== 'revision_changed' &&
      line.state !== 'insufficient' &&
      line.state !== 'unavailable'
    ) {
      return false;
    }
    if (line.state === 'insufficient') {
      if (typeof line.available !== 'number' || !Number.isInteger(line.available) || line.available < 0) {
        return false;
      }
    }
    if (line.state === 'ok' || line.state === 'revision_changed') {
      if (line.unit_price_minor === null || line.line_total_minor === null) return false;
    }
  }

  return true;
}

async function postCartQuote(storeSlug: string, cart: StoredCart): Promise<CartQuoteResult> {
  const requestedLines = cart.lines.map(line => ({
    sku: line.sku,
    quantity: line.quantity,
  }));
  try {
    const response = await fetch(`/api/v1/public/stores/${encodeURIComponent(storeSlug)}/cart-quotes`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        publication_revision: cart.revision,
        lines: requestedLines,
      }),
    });

    if (response.status >= 200 && response.status < 300) {
      try {
        const body: unknown = await response.json();
        if (!isCartQuoteShape(body, requestedLines)) return { kind: 'failed' };
        return { kind: 'ok', quote: body };
      } catch {
        return { kind: 'failed' };
      }
    }
    if (response.status === 429) return { kind: 'rate_limited' };
    if (response.status === 404) return { kind: 'store_not_found' };
    if (response.status === 503) {
      try {
        const body = (await response.json()) as { code?: unknown };
        if (body && body.code === 'commerce_quarantined') return { kind: 'paused' };
      } catch {
        return { kind: 'failed' };
      }
      return { kind: 'failed' };
    }
    if (response.status === 409) {
      try {
        const body = (await response.json()) as { code?: unknown };
        if (body && body.code === 'checkout_not_enabled') return { kind: 'not_open' };
      } catch {
        return { kind: 'failed' };
      }
      return { kind: 'failed' };
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

interface CartPageProps {
  container: HTMLElement;
  storeSlug: string;
  storeName: string;
}

type PendingFocusTarget =
  | { kind: 'heading' }
  | { kind: 'remove'; sku: string }
  | { kind: 'quantity'; sku: string }
  | null;

function CartPage({ container, storeSlug, storeName }: CartPageProps) {
  const [cart, setCart] = useState<StoredCart>(() => readCart(storeSlug));
  const [draftQuantities, setDraftQuantities] = useState<Record<string, string>>({});
  const [matchedQuote, setMatchedQuote] = useState<{ key: string; quote: CartQuoteResponse } | null>(null);
  const [errorState, setErrorState] = useState<{ key: string; kind: CartErrorKind } | null>(null);
  const [removalStatus, setRemovalStatus] = useState<string>('');
  const [pendingFocus, setPendingFocus] = useState<PendingFocusTarget>(null);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const quantityInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const removeButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const latestCartRef = useRef<StoredCart>(cart);
  const inFlightRef = useRef<boolean>(false);
  const debounceTimerRef = useRef<number | null>(null);
  const followUpReadyRef = useRef<boolean>(false);
  const retryInFlightRef = useRef<boolean>(false);
  const unmountedRef = useRef<boolean>(false);

  const currentKey = cartFullKey(cart);
  const quote = matchedQuote && matchedQuote.key === currentKey ? matchedQuote.quote : null;
  const activeError = errorState && errorState.key === currentKey ? errorState.kind : null;
  const isPending = cart.lines.length > 0 && quote === null && activeError === null;

  useEffect(() => {
    container.setAttribute('aria-busy', isPending ? 'true' : 'false');
  }, [container, isPending]);

  useEffect(() => {
    document.title = `購物車｜${storeName}｜自由工坊`;
  }, [storeName]);

  useEffect(() => {
    if (!pendingFocus) return;
    if (pendingFocus.kind === 'heading') {
      headingRef.current?.focus();
    } else if (pendingFocus.kind === 'remove') {
      removeButtonRefs.current.get(pendingFocus.sku)?.focus();
    } else if (pendingFocus.kind === 'quantity') {
      quantityInputRefs.current.get(pendingFocus.sku)?.focus();
    }
    setPendingFocus(null);
  }, [pendingFocus, cart, quote, activeError]);

  function clearDebounceTimer() {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }

  async function executeFetch() {
    if (unmountedRef.current) return;
    const requestCart = latestCartRef.current;
    if (requestCart.lines.length === 0) return;
    if (inFlightRef.current) {
      followUpReadyRef.current = true;
      return;
    }

    inFlightRef.current = true;
    followUpReadyRef.current = false;
    const requestKey = cartFullKey(requestCart);
    const wasRetry = retryInFlightRef.current;
    retryInFlightRef.current = false;

    const result = await postCartQuote(storeSlug, requestCart);
    if (unmountedRef.current) return;
    inFlightRef.current = false;

    const currentCart = latestCartRef.current;
    if (cartFullKey(currentCart) === requestKey) {
      if (result.kind === 'ok') {
        let nextCart = currentCart;
        if (result.quote.publication_revision !== currentCart.revision) {
          nextCart = {
            revision: result.quote.publication_revision,
            lines: currentCart.lines,
          };
          latestCartRef.current = nextCart;
          writeCart(storeSlug, nextCart);
          setCart(nextCart);
        }
        const nextKey = cartFullKey(nextCart);
        setErrorState(null);
        setMatchedQuote({ key: nextKey, quote: result.quote });
        if (wasRetry) {
          setPendingFocus({ kind: 'heading' });
        }
      } else {
        setMatchedQuote(null);
        setErrorState({ key: requestKey, kind: result.kind });
      }
    } else if (currentCart.lines.length > 0 && followUpReadyRef.current && debounceTimerRef.current === null) {
      followUpReadyRef.current = false;
      void executeFetch();
    }
  }

  function scheduleDebouncedQuote(nextCart: StoredCart) {
    clearDebounceTimer();
    followUpReadyRef.current = false;
    retryInFlightRef.current = false;
    if (nextCart.lines.length === 0) {
      setMatchedQuote(null);
      setErrorState(null);
      return;
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void executeFetch();
    }, QUOTE_DEBOUNCE_MS);
  }

  useEffect(() => {
    unmountedRef.current = false;
    if (latestCartRef.current.lines.length > 0) {
      void executeFetch();
    }
    const unsubscribe = subscribe(storeSlug, () => {
      const nextCart = readCart(storeSlug);
      latestCartRef.current = nextCart;
      setDraftQuantities({});
      setCart(nextCart);
      scheduleDebouncedQuote(nextCart);
    });
    return () => {
      unmountedRef.current = true;
      clearDebounceTimer();
      unsubscribe();
    };
  }, [storeSlug]);

  function applyCartChange(nextCart: StoredCart) {
    latestCartRef.current = nextCart;
    writeCart(storeSlug, nextCart);
    setCart(nextCart);
    scheduleDebouncedQuote(nextCart);
  }

  function clearDraftForSku(sku: string) {
    setDraftQuantities(prev => {
      if (!(sku in prev)) return prev;
      const next = { ...prev };
      delete next[sku];
      return next;
    });
  }

  function handleStepQuantity(sku: string, nextQuantity: number) {
    if (nextQuantity < 1 || nextQuantity > MAX_LINE_QUANTITY) return;
    clearDraftForSku(sku);
    const current = latestCartRef.current;
    const nextLines = current.lines.map(line => (line.sku === sku ? { ...line, quantity: nextQuantity } : line));
    applyCartChange({ revision: current.revision, lines: nextLines });
  }

  function handleInputQuantity(sku: string, rawValue: string) {
    setDraftQuantities(prev => ({ ...prev, [sku]: rawValue }));
    const parsed = parseQuantityInput(rawValue);
    if (parsed === null) return;
    const current = latestCartRef.current;
    const existing = current.lines.find(line => line.sku === sku);
    if (!existing || existing.quantity === parsed) return;
    const nextLines = current.lines.map(line => (line.sku === sku ? { ...line, quantity: parsed } : line));
    applyCartChange({ revision: current.revision, lines: nextLines });
  }

  function handleBlurQuantity(sku: string) {
    clearDraftForSku(sku);
  }

  function handleCapToAvailable(sku: string, available: number) {
    if (available < 1 || available > MAX_LINE_QUANTITY) return;
    clearDraftForSku(sku);
    const current = latestCartRef.current;
    const nextLines = current.lines.map(line => (line.sku === sku ? { ...line, quantity: available } : line));
    applyCartChange({ revision: current.revision, lines: nextLines });
    setPendingFocus({ kind: 'quantity', sku });
  }

  function handleRemoveLine(index: number, sku: string, displayTitle: string) {
    clearDraftForSku(sku);
    const current = latestCartRef.current;
    const nextLines = current.lines.filter(line => line.sku !== sku);
    const nextCart: StoredCart = nextLines.length === 0 ? { revision: '', lines: [] } : { revision: current.revision, lines: nextLines };

    setRemovalStatus(`已從購物車移除「${displayTitle}」。`);
    if (nextLines.length === 0) {
      setPendingFocus({ kind: 'heading' });
    } else if (index < nextLines.length) {
      setPendingFocus({ kind: 'remove', sku: nextLines[index].sku });
    } else {
      setPendingFocus({ kind: 'remove', sku: nextLines[nextLines.length - 1].sku });
    }

    applyCartChange(nextCart);
  }

  function handleRetry() {
    clearDebounceTimer();
    followUpReadyRef.current = false;
    retryInFlightRef.current = true;
    setErrorState(null);
    void executeFetch();
  }

  if (cart.lines.length === 0) {
    return (
      <>
        <h1 id="shop-cart-title" ref={headingRef} tabIndex={-1}>購物車</h1>
        {removalStatus && <p className="shop-sr-only" role="status">{removalStatus}</p>}
        <p>購物車是空的。</p>
        <div className="shop-cart-actions">
          <a href={`/shops/${storeSlug}`}>回到「{storeName}」</a>
        </div>
      </>
    );
  }

  const isAlertError = activeError === 'rate_limited' || activeError === 'paused' || activeError === 'failed';
  const hideAmounts = activeError === 'not_open' || activeError === 'store_not_found';
  const hasFlaggedLines = Boolean(
    quote && quote.lines.some(line => line.state === 'insufficient' || line.state === 'unavailable'),
  );

  let merchandiseDisplay = '計算中…';
  let shippingDisplay = '計算中…';
  let totalDisplay = '計算中…';

  if (isAlertError) {
    merchandiseDisplay = '無法取得';
    shippingDisplay = '無法取得';
    totalDisplay = '無法取得';
  } else if (quote) {
    merchandiseDisplay = formatMinor(quote.merchandise_total_minor, quote.currency);
    if (quote.shipping.state === 'quoted') {
      shippingDisplay = formatMinor(quote.shipping.total_minor, quote.currency);
    } else if (quote.shipping.state === 'not_configured') {
      shippingDisplay = '這間店尚未設定配送方式';
    } else {
      shippingDisplay = '於下一步依配送方式計算';
    }

    if (quote.total_minor !== null) {
      totalDisplay = formatMinor(quote.total_minor, quote.currency);
    } else if (hasFlaggedLines) {
      totalDisplay = '處理上面標示的商品後顯示';
    } else if (quote.shipping.state === 'not_configured') {
      totalDisplay = '店家設定配送方式後顯示';
    } else {
      totalDisplay = '選擇配送方式後顯示';
    }
  }

  return (
    <>
      <h1 id="shop-cart-title" ref={headingRef} tabIndex={-1}>購物車</h1>
      {removalStatus && <p className="shop-sr-only" role="status">{removalStatus}</p>}
      {isAlertError && (
        <>
          <p role="alert" className="shop-cart-alert">{CART_ALERT_COPY[activeError]}</p>
          <div className="shop-cart-actions">
            <button
              type="button"
              className="shop-button shop-button-secondary"
              disabled={isPending}
              onClick={handleRetry}
            >
              重試
            </button>
          </div>
        </>
      )}
      {activeError === 'not_open' && (
        <p role="status">這間店目前沒有開放線上購物。購物車會保留在這個瀏覽器。</p>
      )}
      {activeError === 'store_not_found' && (
        <p role="status">這間商店目前沒有公開。</p>
      )}

      <section className="shop-cart-section" aria-labelledby="shop-cart-items-heading">
        <h2 id="shop-cart-items-heading">商品</h2>
        <ul className="shop-cart-lines">
          {cart.lines.map((line, index) => {
            const quoteLine = quote ? quote.lines[index] : null;
            const displayTitle = quoteLine && quoteLine.title !== null ? quoteLine.title : line.title;
            const rawLineQuantity = draftQuantities[line.sku] ?? String(line.quantity);
            const lineInputInvalid = parseQuantityInput(rawLineQuantity) === null;
            const lineErrorId = `shop-cart-qty-error-${line.sku}`;
            const hideQuantityControls =
              quoteLine !== null &&
              (quoteLine.state === 'unavailable' ||
                (quoteLine.state === 'insufficient' && (quoteLine.available ?? 0) === 0));

            const showPriceUpdated = Boolean(
              quote &&
                quoteLine &&
                quoteLine.unit_price_minor !== null &&
                (line.price_minor !== quoteLine.unit_price_minor || line.currency !== quote.currency),
            );

            return (
              <li key={line.sku} className="shop-cart-line">
                <p className="shop-cart-line-title">
                  {quoteLine && quoteLine.title !== null ? (
                    <a href={`/shops/${storeSlug}/products/${line.sku}`}>{quoteLine.title}</a>
                  ) : (
                    line.title
                  )}
                </p>
                {quoteLine && quoteLine.options.length > 0 && (
                  <p className="shop-cart-line-options">
                    {quoteLine.options.map(opt => `${opt.name}：${opt.value}`).join('、')}
                  </p>
                )}
                {!hideAmounts && isPending && (
                  <p className="shop-cart-line-numbers">
                    <span>單價 計算中…</span>
                    <span className="shop-cart-line-subtotal">小計 計算中…</span>
                  </p>
                )}
                {!hideAmounts && isAlertError && (
                  <p className="shop-cart-line-numbers">
                    <span>單價 無法取得</span>
                    <span className="shop-cart-line-subtotal">小計 無法取得</span>
                  </p>
                )}
                {!hideAmounts &&
                  quote &&
                  quoteLine &&
                  (quoteLine.unit_price_minor !== null ||
                    ((quoteLine.state === 'ok' || quoteLine.state === 'revision_changed') &&
                      quoteLine.line_total_minor !== null)) && (
                    <p className="shop-cart-line-numbers">
                      {quoteLine.unit_price_minor !== null && (
                        <span>單價 {formatMinor(quoteLine.unit_price_minor, quote.currency)}</span>
                      )}
                      {(quoteLine.state === 'ok' || quoteLine.state === 'revision_changed') &&
                        quoteLine.line_total_minor !== null && (
                          <span className="shop-cart-line-subtotal">
                            小計 {formatMinor(quoteLine.line_total_minor, quote.currency)}
                          </span>
                        )}
                    </p>
                  )}
                {!hideAmounts && showPriceUpdated && (
                  <p className="shop-cart-price-updated">
                    價格已更新，加入時為 {formatMinor(line.price_minor, line.currency)}
                  </p>
                )}
                {quoteLine?.state === 'insufficient' && (quoteLine.available ?? 0) > 0 && (
                  <>
                    <p className="shop-cart-line-state">
                      數量不足，目前最多可購買 {quoteLine.available} 件。
                    </p>
                    <div className="shop-cart-actions">
                      <button
                        type="button"
                        className="shop-button shop-button-secondary"
                        aria-label={`把${displayTitle}改為可購買數量`}
                        onClick={() => handleCapToAvailable(line.sku, quoteLine.available ?? 1)}
                      >
                        改為可購買數量
                      </button>
                    </div>
                  </>
                )}
                {((quoteLine?.state === 'insufficient' && (quoteLine.available ?? 0) === 0) ||
                  (quoteLine?.state === 'unavailable' && quoteLine.title !== null)) && (
                  <p className="shop-cart-line-state">目前沒有可售數量。</p>
                )}
                {quoteLine?.state === 'unavailable' && quoteLine.title === null && (
                  <p className="shop-cart-line-state">已下架。</p>
                )}
                <div className="shop-cart-line-controls">
                  {!hideQuantityControls && (
                    <div className="shop-cart-stepper">
                      <button
                        type="button"
                        className="shop-button shop-button-secondary shop-button-stepper"
                        aria-label={`減少${displayTitle}數量`}
                        disabled={line.quantity <= 1}
                        onClick={() => handleStepQuantity(line.sku, line.quantity - 1)}
                      >
                        −
                      </button>
                      <input
                        ref={el => {
                          if (el) quantityInputRefs.current.set(line.sku, el);
                          else quantityInputRefs.current.delete(line.sku);
                        }}
                        className="shop-quantity-input"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={MAX_LINE_QUANTITY}
                        step={1}
                        aria-label={`${displayTitle}數量`}
                        aria-invalid={lineInputInvalid ? 'true' : undefined}
                        aria-describedby={lineInputInvalid ? lineErrorId : undefined}
                        value={rawLineQuantity}
                        onChange={event => handleInputQuantity(line.sku, event.target.value)}
                        onBlur={() => handleBlurQuantity(line.sku)}
                      />
                      <button
                        type="button"
                        className="shop-button shop-button-secondary shop-button-stepper"
                        aria-label={`增加${displayTitle}數量`}
                        disabled={line.quantity >= MAX_LINE_QUANTITY}
                        onClick={() => handleStepQuantity(line.sku, line.quantity + 1)}
                      >
                        +
                      </button>
                    </div>
                  )}
                  <button
                    ref={el => {
                      if (el) removeButtonRefs.current.set(line.sku, el);
                      else removeButtonRefs.current.delete(line.sku);
                    }}
                    type="button"
                    className="shop-button shop-button-secondary"
                    aria-label={`從購物車移除${displayTitle}`}
                    onClick={() => handleRemoveLine(index, line.sku, displayTitle)}
                  >
                    移除
                  </button>
                </div>
                {!hideQuantityControls && lineInputInvalid && (
                  <p id={lineErrorId} className="shop-field-error">請輸入 1 到 99 的數量。</p>
                )}
              </li>
            );
          })}
        </ul>
        {!hideAmounts && hasFlaggedLines && (
          <p className="shop-cart-note">商品小計不含上面標示的商品。</p>
        )}
      </section>

      {!hideAmounts && (
        <>
          <section className="shop-cart-section" aria-labelledby="shop-cart-totals-heading">
            <h2 id="shop-cart-totals-heading">金額明細</h2>
            <dl className="shop-cart-totals">
              <div className="shop-cart-row">
                <dt>商品小計</dt>
                <dd>{merchandiseDisplay}</dd>
              </div>
              <div className="shop-cart-row">
                <dt>運費</dt>
                <dd>{shippingDisplay}</dd>
              </div>
              <div className="shop-cart-row shop-cart-row-total">
                <dt>總額</dt>
                <dd>{totalDisplay}</dd>
              </div>
            </dl>
          </section>
          <p>{hasFlaggedLines ? '請先處理上面標示的商品。' : '請到結帳頁選擇取貨與付款方式，核對最新價格。'}</p>
          <div className="shop-cart-actions">
            {!hasFlaggedLines && quote && <a href={`/shops/${storeSlug}/checkout`} className="shop-button shop-pay-primary">前往結帳</a>}
            <a href={`/shops/${storeSlug}`}>繼續購物</a>
          </div>
        </>
      )}

      {activeError === 'not_open' && (
        <div className="shop-cart-actions">
          <a href={`/shops/${storeSlug}`}>回到「{storeName}」</a>
        </div>
      )}
      {activeError === 'store_not_found' && (
        <div className="shop-cart-actions">
          <a href="/">返回自由工坊</a>
        </div>
      )}
    </>
  );
}

function bootCartHeaderLink(): () => void {
  const link = document.querySelector<HTMLElement>('.shop-cart-link[data-store-slug]');
  if (!link) return () => {};
  const targetLink = link;
  const slug = targetLink.dataset.storeSlug ?? '';
  if (!isValidStoreSlug(slug)) return () => {};

  let previousCount = cartCount(readCart(slug));
  targetLink.textContent = previousCount === 0 ? '購物車' : `購物車（${previousCount}）`;

  function syncCount() {
    const nextCount = cartCount(readCart(slug));
    targetLink.textContent = nextCount === 0 ? '購物車' : `購物車（${nextCount}）`;
    if (nextCount !== previousCount) {
      previousCount = nextCount;
      const announcer = document.getElementById('shop-cart-status');
      if (announcer) {
        announcer.textContent = nextCount === 0 ? '購物車是空的' : `購物車有 ${nextCount} 件商品`;
      }
    }
  }

  subscribe(slug, syncCount);
  return syncCount;
}

function bootAddToCart(notifyHeader: () => void) {
  const container = document.getElementById('shop-add-to-cart');
  if (!container) return;
  const storeSlug = container.dataset.storeSlug ?? '';
  const sku = container.dataset.sku ?? '';
  const title = container.dataset.title ?? '';
  const rawPriceMinor = container.dataset.priceMinor ?? '';
  const currency = container.dataset.currency ?? '';
  const revision = container.dataset.revision ?? '';

  if (
    !isValidStoreSlug(storeSlug) ||
    !isValidProductSku(sku) ||
    !isValidTitle(title) ||
    !NON_NEGATIVE_INT_PATTERN.test(rawPriceMinor) ||
    !isValidCurrency(currency) ||
    !isValidRevision(revision)
  ) {
    return;
  }

  const priceMinor = Number(rawPriceMinor);
  if (!isValidPriceMinor(priceMinor)) return;

  createRoot(container).render(
    <AddToCart
      storeSlug={storeSlug}
      sku={sku}
      title={title}
      priceMinor={priceMinor}
      currency={currency}
      revision={revision}
      onCartChanged={notifyHeader}
    />,
  );
}

function bootCartPage() {
  const container = document.getElementById('shop-cart');
  if (!container) return;
  const storeSlug = container.dataset.storeSlug ?? '';
  const storeName = container.dataset.storeName ?? '';
  if (!isValidStoreSlug(storeSlug)) return;

  createRoot(container).render(
    <CartPage
      container={container}
      storeSlug={storeSlug}
      storeName={storeName}
    />,
  );
}

function bootOrderPage() {
  const container = document.getElementById('shop-order');
  if (!container) return;
  const storeSlug = container.dataset.storeSlug ?? '';
  const storeName = container.dataset.storeName ?? '';
  const orderRef = container.dataset.orderRef ?? '';
  if (!STORE_SLUG_PATTERN.test(storeSlug) || !OPAQUE_ID_PATTERN.test(orderRef)) return;

  const initialAccess = consumeAccessHash();
  let accessToken: string | null = initialAccess.kind === 'valid' ? initialAccess.token : null;
  const malformedAccessLink = initialAccess.kind === 'malformed';

  const tokenBox: TokenBox = {
    read: () => accessToken,
    write: (next: string) => {
      accessToken = next;
    },
    clear: () => {
      accessToken = null;
    },
  };

  const emailEnabled = container.dataset.emailEnabled === 'true';

  createRoot(container).render(
    <OrderPage
      container={container}
      storeSlug={storeSlug}
      storeName={storeName}
      orderRef={orderRef}
      tokenBox={tokenBox}
      malformedAccessLink={malformedAccessLink}
      emailEnabled={emailEnabled}
    />,
  );
}

const PAYMENT_RETURN_POLL_INTERVAL_MS = 5000;
const PAYMENT_RETURN_MAX_POLLS = 24;

type ReturnLoadState = 'loading' | 'order' | 'no_access' | 'error';

function paymentReturnHeading(loadState: ReturnLoadState, view: PaymentView | null): string {
  if (loadState === 'no_access') return '無法在這個瀏覽器查看付款結果';
  if (loadState !== 'order' || !view) return '付款結果確認中';
  switch (view) {
    case 'paid':
      return '已收到付款';
    case 'refunded':
      return '已退款';
    case 'review':
      return '付款金額待店家確認';
    case 'checking':
    case 'awaiting':
      return '付款結果確認中';
    case 'failed':
      return '付款未完成';
    case 'ready':
      return '尚未付款';
    case 'expired':
      return '付款期限已過';
    case 'closed':
      return '訂單已取消';
  }
}

interface PaymentReturnPageProps {
  container: HTMLElement;
  storeSlug: string;
  storeName: string;
  orderRef: string;
}

function PaymentReturnPage({ container, storeSlug, storeName, orderRef }: PaymentReturnPageProps) {
  const [loadState, setLoadState] = useState<ReturnLoadState>('loading');
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [loadErrorKind, setLoadErrorKind] = useState<ErrorKind | null>(null);
  const [pollingDone, setPollingDone] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(true);
  const [paymentBusy, setPaymentBusy] = useState<boolean>(false);
  const [redirecting, setRedirecting] = useState<boolean>(false);
  const [pendingHidePayButtons, setPendingHidePayButtons] = useState<boolean>(false);
  const [startRateLimited, setStartRateLimited] = useState<boolean>(false);
  const [queryDisabled, setQueryDisabled] = useState<boolean>(false);
  const [paymentAlert, setPaymentAlert] = useState<PaymentAlertState>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState<{ text: string; visible: boolean }>({
    text: '',
    visible: false,
  });
  const [focusHeadingTrigger, setFocusHeadingTrigger] = useState<number>(0);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const unmountedRef = useRef<boolean>(false);
  const initialLoadedRef = useRef<boolean>(false);
  const lastViewKeyRef = useRef<string | null>(null);
  const pollCountRef = useRef<number>(0);
  const pollTimerRef = useRef<number | null>(null);
  const pollingActiveRef = useRef<boolean>(false);
  const requestInFlightRef = useRef<boolean>(false);
  const redirectingRef = useRef<boolean>(false);
  const pendingHideTimerRef = useRef<number | null>(null);
  const startRateLimitTimerRef = useRef<number | null>(null);
  const queryDisableTimerRef = useRef<number | null>(null);

  const anyBusy = busy || paymentBusy;
  const activeSlug = order?.store.slug ?? storeSlug;
  const activeStoreName = order?.store.name ?? storeName;

  useEffect(() => {
    container.setAttribute('aria-busy', anyBusy ? 'true' : 'false');
  }, [container, anyBusy]);

  useEffect(() => {
    document.title = `付款結果｜${activeStoreName}｜自由工坊`;
  }, [activeStoreName]);

  useEffect(() => {
    if (focusHeadingTrigger > 0) {
      headingRef.current?.focus();
    }
  }, [focusHeadingTrigger, loadState, order, pollingDone]);

  function clearPollTimer() {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function clearPendingHideTimer() {
    if (pendingHideTimerRef.current !== null) {
      window.clearTimeout(pendingHideTimerRef.current);
      pendingHideTimerRef.current = null;
    }
  }

  function clearStartRateLimitTimer() {
    if (startRateLimitTimerRef.current !== null) {
      window.clearTimeout(startRateLimitTimerRef.current);
      startRateLimitTimerRef.current = null;
    }
  }

  function clearQueryDisableTimer() {
    if (queryDisableTimerRef.current !== null) {
      window.clearTimeout(queryDisableTimerRef.current);
      queryDisableTimerRef.current = null;
    }
  }

  function armPendingHideTimer(seconds: number) {
    clearPendingHideTimer();
    setPendingHidePayButtons(true);
    pendingHideTimerRef.current = window.setTimeout(() => {
      pendingHideTimerRef.current = null;
      setPendingHidePayButtons(false);
    }, seconds * 1000);
  }

  function armStartRateLimitTimer(seconds: number) {
    clearStartRateLimitTimer();
    setStartRateLimited(true);
    startRateLimitTimerRef.current = window.setTimeout(() => {
      startRateLimitTimerRef.current = null;
      setStartRateLimited(false);
    }, seconds * 1000);
  }

  function armQueryDisableTimer(seconds: number) {
    clearQueryDisableTimer();
    setQueryDisabled(true);
    queryDisableTimerRef.current = window.setTimeout(() => {
      queryDisableTimerRef.current = null;
      setQueryDisabled(false);
    }, seconds * 1000);
  }

  function applyViewTransition(
    nextLoadState: ReturnLoadState,
    nextView: PaymentView | null,
    source: 'initial' | 'poll' | 'buyer',
  ) {
    const nextKey = nextLoadState === 'order' && nextView ? `order:${nextView}` : nextLoadState;
    if (!initialLoadedRef.current) {
      initialLoadedRef.current = true;
      lastViewKeyRef.current = nextKey;
      return;
    }
    if (lastViewKeyRef.current !== nextKey) {
      lastViewKeyRef.current = nextKey;
      const nextH1 = paymentReturnHeading(nextLoadState, nextView);
      setStatusAnnouncement({ text: nextH1, visible: false });
      if (source === 'buyer') {
        setFocusHeadingTrigger(count => count + 1);
      }
    }
  }

  function scheduleNextPoll() {
    clearPollTimer();
    if (unmountedRef.current || !pollingActiveRef.current) return;
    if (pollCountRef.current >= PAYMENT_RETURN_MAX_POLLS) {
      pollingActiveRef.current = false;
      setPollingDone(true);
      return;
    }
    pollTimerRef.current = window.setTimeout(() => {
      pollTimerRef.current = null;
      void runPoll();
    }, PAYMENT_RETURN_POLL_INTERVAL_MS);
  }

  async function runPoll() {
    if (unmountedRef.current || !pollingActiveRef.current) return;
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setBusy(true);
    pollCountRef.current += 1;

    const result = await fetchPublicOrder(storeSlug, orderRef);
    if (unmountedRef.current) return;
    requestInFlightRef.current = false;
    setBusy(false);
    if (!pollingActiveRef.current) return;

    if (result.kind === 'ok') {
      const nextView = paymentView(result.order);
      setOrder(result.order);
      setLoadState('order');
      setLoadErrorKind(null);
      applyViewTransition('order', nextView, 'poll');
      if (nextView !== 'checking' && nextView !== 'awaiting') {
        pollingActiveRef.current = false;
        clearPollTimer();
        return;
      }
    } else if (result.kind === 'not_found') {
      pollingActiveRef.current = false;
      clearPollTimer();
      setOrder(null);
      setLoadErrorKind(null);
      setLoadState('no_access');
      applyViewTransition('no_access', null, 'poll');
      return;
    }

    if (pollCountRef.current >= PAYMENT_RETURN_MAX_POLLS) {
      pollingActiveRef.current = false;
      setPollingDone(true);
      return;
    }
    scheduleNextPoll();
  }

  async function runInitialOrRetryLoad(source: 'initial' | 'buyer') {
    if (requestInFlightRef.current) return;
    clearPollTimer();
    pollingActiveRef.current = false;
    requestInFlightRef.current = true;
    setBusy(true);

    const result = await fetchPublicOrder(storeSlug, orderRef);
    if (unmountedRef.current) return;
    requestInFlightRef.current = false;
    setBusy(false);

    if (result.kind === 'ok') {
      const nextView = paymentView(result.order);
      setOrder(result.order);
      setLoadErrorKind(null);
      setLoadState('order');
      applyViewTransition('order', nextView, source);
      if (nextView === 'checking' || nextView === 'awaiting') {
        pollCountRef.current = 0;
        pollingActiveRef.current = true;
        setPollingDone(false);
        scheduleNextPoll();
      } else {
        pollingActiveRef.current = false;
        setPollingDone(false);
      }
      return;
    }

    if (result.kind === 'not_found') {
      setOrder(null);
      setLoadErrorKind(null);
      setPaymentAlert(null);
      setLoadState('no_access');
      applyViewTransition('no_access', null, source);
      return;
    }

    setLoadErrorKind(result.kind);
    setLoadState('error');
    if (!initialLoadedRef.current) {
      initialLoadedRef.current = true;
      lastViewKeyRef.current = 'error';
    }
  }

  async function reReadOrderAfterAction(): Promise<void> {
    const result = await fetchPublicOrder(storeSlug, orderRef);
    if (unmountedRef.current) return;
    if (result.kind === 'ok') {
      const nextView = paymentView(result.order);
      setOrder(result.order);
      setLoadErrorKind(null);
      setLoadState('order');
      applyViewTransition('order', nextView, 'buyer');
      return;
    }
    if (result.kind === 'not_found') {
      pollingActiveRef.current = false;
      clearPollTimer();
      setOrder(null);
      setLoadErrorKind(null);
      setPaymentAlert(null);
      setLoadState('no_access');
      applyViewTransition('no_access', null, 'buyer');
    }
  }

  async function handleStartPayment() {
    if (requestInFlightRef.current || busy || paymentBusy || redirectingRef.current || startRateLimited) return;
    clearPollTimer();
    pollingActiveRef.current = false;
    requestInFlightRef.current = true;
    setPaymentBusy(true);
    const outcome = await startPayment(activeSlug, orderRef);
    if (unmountedRef.current) return;

    if (outcome.kind === 'redirect') {
      setPaymentAlert(null);
      redirectingRef.current = true;
      setRedirecting(true);
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      window.location.assign(outcome.handoffUrl);
      return;
    }

    if (outcome.kind === 'pending') {
      setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_OUTCOME_COPY.pending });
      armPendingHideTimer(outcome.retryAfterSeconds);
      await reReadOrderAfterAction();
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'refused') {
      if (outcome.code === 'checkout_hold_expired') {
        setPaymentAlert({ section: 'action', kind: 'hold_expired', storeSlug: activeSlug });
      } else {
        setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_REFUSED_COPY[outcome.code] });
      }
      await reReadOrderAfterAction();
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'rate_limited') {
      const retryTime = formatRetryAfterTaipeiTime(outcome.retryAfterSeconds);
      setPaymentAlert({
        section: 'action',
        kind: 'text',
        text: `操作太頻繁，請在 ${retryTime} 後再試。`,
      });
      armStartRateLimitTimer(outcome.retryAfterSeconds);
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'paused') {
      setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_OUTCOME_COPY.paused });
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'payment_unavailable') {
      setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_OUTCOME_COPY.payment_unavailable });
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'not_found') {
      setPaymentAlert(null);
      await reReadOrderAfterAction();
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    setPaymentAlert({ section: 'action', kind: 'text', text: PAYMENT_OUTCOME_COPY.failed });
    requestInFlightRef.current = false;
    setPaymentBusy(false);
  }

  async function handleManualQuery() {
    if (requestInFlightRef.current || busy || paymentBusy || redirectingRef.current || queryDisabled) return;
    clearPollTimer();
    pollingActiveRef.current = false;
    requestInFlightRef.current = true;
    setPaymentBusy(true);
    const outcome = await queryPayment(activeSlug, orderRef);
    if (unmountedRef.current) return;

    if (outcome.kind === 'ok') {
      const nextView = paymentView(outcome.order);
      setOrder(outcome.order);
      setLoadErrorKind(null);
      setLoadState('order');
      setPaymentAlert(null);
      if (nextView === 'checking' || nextView === 'awaiting') {
        lastViewKeyRef.current = `order:${nextView}`;
        setStatusAnnouncement({
          text: `${formatTaipeiTime(Date.now())} 已查詢，仍在確認中。`,
          visible: true,
        });
      } else {
        applyViewTransition('order', nextView, 'buyer');
      }
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    setStatusAnnouncement(prev => (prev.visible ? { text: '', visible: false } : prev));

    if (outcome.kind === 'pending') {
      setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_OUTCOME_COPY.pending });
      armQueryDisableTimer(outcome.retryAfterSeconds);
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'refused') {
      setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_REFUSED_COPY[outcome.code] });
      await reReadOrderAfterAction();
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'rate_limited') {
      const retryTime = formatRetryAfterTaipeiTime(outcome.retryAfterSeconds);
      setPaymentAlert({
        section: 'payment',
        kind: 'text',
        text: `操作太頻繁，請在 ${retryTime} 後再試。`,
      });
      armQueryDisableTimer(outcome.retryAfterSeconds);
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'paused') {
      setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_OUTCOME_COPY.paused });
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'payment_unavailable') {
      setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_OUTCOME_COPY.payment_unavailable });
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    if (outcome.kind === 'not_found') {
      setPaymentAlert(null);
      await reReadOrderAfterAction();
      requestInFlightRef.current = false;
      setPaymentBusy(false);
      return;
    }

    setPaymentAlert({ section: 'payment', kind: 'text', text: PAYMENT_OUTCOME_COPY.failed });
    requestInFlightRef.current = false;
    setPaymentBusy(false);
  }

  useEffect(() => {
    unmountedRef.current = false;
    void runInitialOrRetryLoad('initial');
    function handlePageShow(event: PageTransitionEvent) {
      if (!event.persisted && !redirectingRef.current) return;
      redirectingRef.current = false;
      requestInFlightRef.current = false;
      setRedirecting(false);
      setPaymentBusy(false);
      clearStartRateLimitTimer();
      clearQueryDisableTimer();
      setStartRateLimited(false);
      setQueryDisabled(false);
      void runInitialOrRetryLoad('initial');
    }
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      unmountedRef.current = true;
      pollingActiveRef.current = false;
      window.removeEventListener('pageshow', handlePageShow);
      clearPollTimer();
      clearPendingHideTimer();
      clearStartRateLimitTimer();
      clearQueryDisableTimer();
    };
  }, []);

  if (loadState === 'loading') {
    return (
      <>
        <h1 id="shop-pay-return-title" ref={headingRef} tabIndex={-1}>付款結果確認中</h1>
        <p role="status">正在向付款服務確認結果…</p>
      </>
    );
  }

  if (loadState === 'error') {
    return (
      <>
        <h1 id="shop-pay-return-title" ref={headingRef} tabIndex={-1}>付款結果確認中</h1>
        <p role="status" className="shop-sr-only">{statusAnnouncement.text}</p>
        {loadErrorKind && <p role="alert" className="shop-order-alert">{ERROR_COPY[loadErrorKind]}</p>}
        <div className="shop-order-actions">
          <button
            type="button"
            className="shop-button shop-button-secondary"
            disabled={anyBusy}
            onClick={() => void runInitialOrRetryLoad('buyer')}
          >
            重試
          </button>
        </div>
      </>
    );
  }

  if (loadState === 'no_access' || !order) {
    return (
      <>
        <h1 id="shop-pay-return-title" ref={headingRef} tabIndex={-1}>無法在這個瀏覽器查看付款結果</h1>
        <p role="status" className="shop-sr-only">{statusAnnouncement.text}</p>
        <p>這個瀏覽器沒有這筆訂單的查看權限。訂單只能在下單時使用的瀏覽器，或以下單時登入的會員帳號查看。</p>
        <div className="shop-order-actions">
          <a href={`/shops/${activeSlug}/order-access`}>找回訂單</a>
          <a href={`/shops/${activeSlug}`}>回到「{activeStoreName}」</a>
        </div>
      </>
    );
  }

  const currentPayView = paymentView(order);
  const headingText = paymentReturnHeading('order', currentPayView);
  const orderHref = `/shops/${activeSlug}/orders/${order.order_ref}`;
  const paymentControlsDisabled = anyBusy || redirecting;

  let bodyText = '';
  switch (currentPayView) {
    case 'paid':
      bodyText = `訂單 ${order.display_number} 的後續進度會顯示在訂單頁。`;
      break;
    case 'refunded':
      bodyText = orderPaymentSectionCopy('refunded').description!;
      break;
    case 'review':
      bodyText = '我們收到的付款和這筆訂單不符，店家會確認並處理退款。請不要再付款。';
      break;
    case 'checking':
    case 'awaiting':
      bodyText = pollingDone
        ? '目前還沒有確認結果。你可以重新查詢，或稍後到訂單頁查看；請不要重複付款。'
        : '已回到商店，正在向付款服務確認結果，請不要重複付款。';
      break;
    case 'failed':
      bodyText = '這次付款沒有完成，沒有扣款。';
      break;
    case 'ready':
      bodyText = `請在 ${formatTaipeiDateTime(order.pay_by)} 前完成付款，逾時保留的商品會釋出。`;
      break;
    case 'expired':
      bodyText = '保留的商品已釋出。';
      break;
    case 'closed':
      bodyText = '這筆訂單已取消，不能再付款。';
      break;
  }

  return (
    <>
      <h1 id="shop-pay-return-title" ref={headingRef} tabIndex={-1}>{headingText}</h1>
      <p className="shop-pay-return-order">訂單 {order.display_number}</p>
      <p>{bodyText}</p>
      <p role="status" className={statusAnnouncement.visible ? 'shop-pay-status' : 'shop-sr-only'}>
        {statusAnnouncement.text}
      </p>
      {paymentAlert && renderPaymentAlert(paymentAlert)}
      <div className="shop-order-actions">
        {currentPayView === 'paid' && (
          <a className="shop-button shop-pay-primary" href={orderHref}>
            查看訂單
          </a>
        )}
        {(currentPayView === 'review' || currentPayView === 'refunded') && <a href={orderHref}>查看訂單</a>}
        {(currentPayView === 'checking' || currentPayView === 'awaiting') && !pollingDone && (
          <a href={orderHref}>查看訂單</a>
        )}
        {(currentPayView === 'checking' || currentPayView === 'awaiting') && pollingDone && (
          <>
            <button
              type="button"
              className="shop-button shop-button-secondary"
              disabled={paymentControlsDisabled || queryDisabled}
              onClick={() => void handleManualQuery()}
            >
              重新查詢
            </button>
            <a href={orderHref}>稍後再看</a>
          </>
        )}
        {currentPayView === 'failed' && (
          <>
            {order.can_resume_payment && !pendingHidePayButtons && (
              <button
                type="button"
                className="shop-button shop-pay-primary"
                disabled={paymentControlsDisabled || startRateLimited}
                onClick={() => void handleStartPayment()}
              >
                {redirecting ? '正在前往付款…' : '重新付款'}
              </button>
            )}
            <a href={orderHref}>查看訂單</a>
          </>
        )}
        {currentPayView === 'ready' && (
          <>
            {order.can_resume_payment && !pendingHidePayButtons && (
              <button
                type="button"
                className="shop-button shop-pay-primary"
                disabled={paymentControlsDisabled || startRateLimited}
                onClick={() => void handleStartPayment()}
              >
                {redirecting ? '正在前往付款…' : '前往付款'}
              </button>
            )}
            <a href={orderHref}>查看訂單</a>
          </>
        )}
        {currentPayView === 'expired' && (
          <>
            <a href={`/shops/${activeSlug}`}>回到「{activeStoreName}」</a>
            <a href={orderHref}>查看訂單</a>
          </>
        )}
        {currentPayView === 'closed' && <a href={orderHref}>查看訂單</a>}
      </div>
    </>
  );
}

function bootPaymentReturnPage() {
  const container = document.getElementById('shop-pay-return');
  if (!container) return;
  const storeSlug = container.dataset.storeSlug ?? '';
  const storeName = container.dataset.storeName ?? '';
  const orderRef = container.dataset.orderRef ?? '';
  const attemptRef = container.dataset.attemptRef ?? '';
  if (
    !STORE_SLUG_PATTERN.test(storeSlug) ||
    !OPAQUE_ID_PATTERN.test(orderRef) ||
    !OPAQUE_ID_PATTERN.test(attemptRef)
  ) {
    return;
  }

  createRoot(container).render(
    <PaymentReturnPage
      container={container}
      storeSlug={storeSlug}
      storeName={storeName}
      orderRef={orderRef}
    />,
  );
}

type OrderAccessOutcome = 'sent' | 'paused' | 'unavailable' | 'failed';

const ORDER_ACCESS_SENT_COPY = '如果資料相符，我們會把查看連結寄到這個 Email。連結 7 天內有效，只能使用一次。';

const ORDER_ACCESS_ERROR_COPY: Record<Exclude<OrderAccessOutcome, 'sent'>, string> = {
  paused: '商店服務暫停中，請稍後再試。',
  unavailable: '這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家。',
  failed: '無法寄送查看連結，請稍後重試。',
};

async function postOrderAccessRequest(
  storeSlug: string,
  email: string,
  displayNumber: string,
): Promise<OrderAccessOutcome> {
  try {
    const response = await fetch(`/api/v1/public/stores/${encodeURIComponent(storeSlug)}/order-access-requests`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        display_number: displayNumber,
      }),
    });
    if (response.status === 202 || response.status === 429) {
      return 'sent';
    }
    if (response.status === 503) {
      try {
        const body = (await response.json()) as { code?: unknown };
        if (body && body.code === 'commerce_quarantined') return 'paused';
      } catch {
        return 'failed';
      }
      return 'failed';
    }
    if (response.status === 409) {
      try {
        const body = (await response.json()) as { code?: unknown };
        if (body && body.code === 'order_access_email_unavailable') return 'unavailable';
      } catch {
        return 'failed';
      }
      return 'failed';
    }
    return 'failed';
  } catch {
    return 'failed';
  }
}

interface OrderAccessPageProps {
  container: HTMLElement;
  storeSlug: string;
  storeName: string;
  initialEmail: string;
  initialDisplayNumber: string;
}

function OrderAccessPage({
  container,
  storeSlug,
  storeName,
  initialEmail,
  initialDisplayNumber,
}: OrderAccessPageProps) {
  const [email, setEmail] = useState<string>(initialEmail);
  const [displayNumber, setDisplayNumber] = useState<string>(initialDisplayNumber);
  const [busy, setBusy] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const inFlightRef = useRef<boolean>(false);

  useEffect(() => {
    container.setAttribute('aria-busy', busy ? 'true' : 'false');
  }, [container, busy]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current || busy) return;
    const trimmedEmail = email.trim();
    const trimmedDisplayNumber = displayNumber.trim();
    if (!trimmedEmail || !trimmedDisplayNumber) {
      setStatusMessage('請填寫 Email 與訂單編號。');
      return;
    }
    inFlightRef.current = true;
    setBusy(true);
    setStatusMessage('');
    const outcome = await postOrderAccessRequest(storeSlug, trimmedEmail, trimmedDisplayNumber);
    inFlightRef.current = false;
    setBusy(false);
    if (outcome === 'sent') {
      setStatusMessage(ORDER_ACCESS_SENT_COPY);
    } else {
      setStatusMessage(ORDER_ACCESS_ERROR_COPY[outcome]);
    }
  }

  return (
    <>
      <h1 id="shop-order-access-title" tabIndex={-1}>找回訂單</h1>
      <p>輸入下單時填寫的 Email 與訂單編號（例如 261015-ABCDEF），我們會把一次性查看連結寄到你的信箱。</p>
      <form className="shop-order-section" noValidate onSubmit={event => void handleSubmit(event)}>
        <div className="shop-order-access-field">
          <label className="shop-add-label" htmlFor="shop-order-access-email">Email</label>
          <input
            id="shop-order-access-email"
            className="shop-text-input"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={254}
            required
            disabled={busy}
            value={email}
            onChange={event => setEmail(event.target.value)}
          />
        </div>
        <div className="shop-order-access-field">
          <label className="shop-add-label" htmlFor="shop-order-access-display-number">訂單編號</label>
          <input
            id="shop-order-access-display-number"
            className="shop-text-input"
            name="display_number"
            type="text"
            autoComplete="off"
            maxLength={80}
            placeholder="261015-ABCDEF"
            required
            disabled={busy}
            value={displayNumber}
            onChange={event => setDisplayNumber(event.target.value)}
          />
        </div>
        <div className="shop-order-actions">
          <button type="submit" className="shop-button shop-pay-primary" disabled={busy}>
            寄送查看連結
          </button>
          <a href={`/shops/${storeSlug}`}>回到「{storeName}」</a>
        </div>
      </form>
      <div role="status">
        {statusMessage && (
          <p className="shop-order-alert">
            {statusMessage}
          </p>
        )}
      </div>
    </>
  );
}

function bootOrderAccessPage() {
  const container = document.getElementById('shop-order-access');
  if (!container) return;
  const storeSlug = container.dataset.storeSlug ?? '';
  const storeName = container.dataset.storeName ?? '';
  if (!STORE_SLUG_PATTERN.test(storeSlug)) return;

  const initialEmail = container.querySelector<HTMLInputElement>('#shop-order-access-email')?.value ?? '';
  const initialDisplayNumber = container.querySelector<HTMLInputElement>('#shop-order-access-display-number')?.value ?? '';

  createRoot(container).render(
    <OrderAccessPage
      container={container}
      storeSlug={storeSlug}
      storeName={storeName}
      initialEmail={initialEmail}
      initialDisplayNumber={initialDisplayNumber}
    />,
  );
}

function bootStorefront() {
  const notifyHeader = bootCartHeaderLink();
  bootAddToCart(notifyHeader);
  bootCartPage();
  bootCheckoutPage();
  bootOrderPage();
  bootPaymentReturnPage();
  bootOrderAccessPage();
}

bootStorefront();
