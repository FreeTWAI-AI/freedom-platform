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
} from './cart-store.js';
import { formatTaipeiDateTime } from './format.js';

const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NON_NEGATIVE_INT_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INT_PATTERN = /^[0-9]+$/;

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
  bootOrderPage();
}

bootStorefront();
