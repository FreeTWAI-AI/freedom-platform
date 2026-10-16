import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
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
import { formatTaipeiDateTime } from './format.js';

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

function isPublicOrderShape(value: unknown): value is PublicOrder {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PublicOrder>;
  return (
    typeof candidate.order_ref === 'string' &&
    typeof candidate.display_number === 'string' &&
    Boolean(candidate.store && typeof candidate.store.slug === 'string' && typeof candidate.store.name === 'string') &&
    Array.isArray(candidate.lines)
  );
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
  if (response.status === 404) return { kind: 'not_found' };
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
    return await classifyOrderResponse(response);
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
    return await classifyOrderResponse(response);
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
}

type ViewState = 'loading' | 'link_prompt' | 'order' | 'not_found' | 'invalid_link' | 'forgotten';

function OrderPage({ container, storeSlug, storeName, orderRef, tokenBox, malformedAccessLink }: OrderPageProps) {
  const [view, setView] = useState<ViewState>(malformedAccessLink ? 'invalid_link' : 'loading');
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [retryTarget, setRetryTarget] = useState<'get' | 'redeem'>('get');
  const [busy, setBusy] = useState<boolean>(!malformedAccessLink);
  const [redeeming, setRedeeming] = useState<boolean>(false);
  const [forgetting, setForgetting] = useState<boolean>(false);
  const [forgetError, setForgetError] = useState<boolean>(false);
  const [focusHeadingTrigger, setFocusHeadingTrigger] = useState<number>(0);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const forgetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const forgottenTransitionRef = useRef<boolean>(false);
  const redeemRejectedRef = useRef<boolean>(false);
  const initialTitleRef = useRef<string>(document.title);

  const anyBusy = busy || forgetting;

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

  async function runInitialOrRetryGet() {
    setBusy(true);
    const result = await fetchPublicOrder(storeSlug, orderRef);
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

  async function runRedeem() {
    const token = tokenBox.read();
    if (!token) {
      setView('invalid_link');
      return;
    }
    setBusy(true);
    setRedeeming(true);
    const result = await postRedeemOrder(storeSlug, orderRef, token);
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
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
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
    setForgetting(true);
    const outcome = await postForgetBrowser();
    if (outcome === 'ok') {
      forgottenTransitionRef.current = true;
      dialogRef.current?.close();
      setForgetting(false);
      setErrorKind(null);
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

      {order.lifecycle_state === 'open' && order.payment_state === 'unpaid' && (
        <section className="shop-order-section" aria-labelledby="shop-order-action-heading">
          <h2 id="shop-order-action-heading">需要你處理</h2>
          {order.reservation_expired ? (
            <>
              <p>付款期限已過，保留的商品已釋出。</p>
              <div className="shop-order-actions">
                <a href={`/shops/${order.store.slug}`}>回到「{order.store.name}」</a>
              </div>
            </>
          ) : (
            <p>請在 {formatTaipeiDateTime(order.pay_by)} 前完成付款，逾時保留的商品會釋出。</p>
          )}
        </section>
      )}

      <section className="shop-order-section" aria-labelledby="shop-order-payment-heading">
        <h2 id="shop-order-payment-heading">付款</h2>
        <p>{order.payment_state === 'confirmed' ? '已付款' : '尚未付款'}</p>
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
            disabled={forgetting}
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

  container.setAttribute('aria-busy', isPending ? 'true' : 'false');

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
    if (quote.shipping.state === 'needs_delivery_data') {
      shippingDisplay = '於下一步依配送方式計算';
    } else if (quote.shipping.state === 'not_configured') {
      shippingDisplay = '這間店尚未設定配送方式';
    } else {
      shippingDisplay = formatMinor(quote.shipping.total_minor, quote.currency);
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
          <p>{hasFlaggedLines ? '請先處理上面標示的商品。' : '結帳功能尚未開放。購物車會保留在這個瀏覽器。'}</p>
          <div className="shop-cart-actions">
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

  createRoot(container).render(
    <OrderPage
      container={container}
      storeSlug={storeSlug}
      storeName={storeName}
      orderRef={orderRef}
      tokenBox={tokenBox}
      malformedAccessLink={malformedAccessLink}
    />,
  );
}

function bootStorefront() {
  const notifyHeader = bootCartHeaderLink();
  bootAddToCart(notifyHeader);
  bootCartPage();
  bootOrderPage();
}

bootStorefront();
