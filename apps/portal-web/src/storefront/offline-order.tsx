import {useRef, useState} from 'react';
import type {PublicOrder} from '../../../../contracts/guild-launchpad/v1/hosted-checkout.js';
import {formatMinor} from '../../../../modules/agent-commerce/hosted/format.js';
import {formatTaipeiDateTime} from './format.js';

/** Private instructions come exclusively from the authorized order response. */
export function OfflineOrder({order, disabled, onCancel, onRefresh}: {
  order: PublicOrder;
  disabled: boolean;
  onCancel: () => Promise<void>;
  onRefresh: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const bank = order.offline_instructions;
  const open = order.lifecycle_state === 'open';
  const unpaid = order.payment_state === 'unpaid';
  async function copy(value: string, label: string) {
    try {await navigator.clipboard.writeText(value); setCopyStatus(`已複製${label}。`);}
    catch {setCopyStatus('無法自動複製，請選取畫面上的資料複製。');}
  }
  return <section className="shop-order-section" aria-labelledby="shop-offline-heading">
    <h2 id="shop-offline-heading">{order.payment_method === 'bank_transfer' ? '銀行匯款' : '面交付款'}</h2>
    {order.payment_state === 'confirmed' ? <p>店家已確認收到付款。</p>
      : order.cancel_reason === 'payment_not_completed' ? <p>付款期限已結束，訂單已取消。如果你已經匯款，請聯絡店家。</p>
      : !open ? <p>這筆訂單已結束。如果你已經付款，請聯絡店家。</p>
      : unpaid && order.reservation_expired ? <p>付款期限已過，保留的商品已釋出。如果你已經匯款，店家仍可能在 {formatTaipeiDateTime(order.payment_grace_until!)} 前確認。</p>
      : unpaid && bank ? <>
        <p>請在 {formatTaipeiDateTime(order.pay_by)} 前匯款 {formatMinor(bank.amount_minor, order.currency)} 到：</p>
        <dl className="shop-order-contact">
          <div className="shop-order-row"><dt>銀行</dt><dd>{bank.bank_code} {bank.bank_name}{bank.branch_name ? ` ${bank.branch_name}` : ''}</dd></div>
          <div className="shop-order-row"><dt>帳號</dt><dd>{bank.account_number}</dd></div>
          <div className="shop-order-row"><dt>戶名</dt><dd>{bank.account_name}</dd></div>
        </dl>
        {bank.note && <p className="shop-preserve-lines">{bank.note}</p>}
        <p>店家確認收款後，這裡會更新。</p>
        <div className="shop-order-actions">
          <button className="shop-button shop-button-secondary" type="button" disabled={disabled} onClick={() => void copy(bank.account_number, '帳號')}>複製帳號</button>
          <button className="shop-button shop-button-secondary" type="button" disabled={disabled} onClick={() => void copy((bank.amount_minor / 100).toFixed(2), '金額')}>複製金額</button>
        </div>
        <p role="status" className={copyStatus ? '' : 'shop-sr-only'}>{copyStatus}</p>
      </> : unpaid && order.payment_method === 'cash_on_meetup' ? <>
        <p>店家會用你留下的手機或 Email 和你約時間地點。</p>
        <p>請在 {formatTaipeiDateTime(order.pay_by)} 前完成面交付款。</p>
      </> : <p>請聯絡店家確認付款狀態。</p>}
    {(order.meetup_notes ?? []).map((note, index) => <p className="shop-preserve-lines" key={index}>{note}</p>)}
    {open && unpaid && <div className="shop-order-actions">
      <button className="shop-button shop-button-secondary" type="button" disabled={disabled} onClick={onRefresh}>更新訂單狀態</button>
      <button className="shop-button shop-button-secondary" type="button" disabled={disabled} ref={cancelTrigger} onClick={() => dialog.current?.showModal()}>取消訂單</button>
    </div>}
    <dialog className="shop-dialog" ref={dialog} aria-labelledby="shop-cancel-order-title" onClose={() => cancelTrigger.current?.focus()}>
      <h2 id="shop-cancel-order-title">要取消這筆訂單嗎？</h2>
      <p>取消後，保留的商品會釋出。如果你已經付款，請先聯絡店家。</p>
      <div className="shop-order-actions">
        <button className="shop-button" type="button" disabled={disabled} onClick={() => {dialog.current?.close(); void onCancel();}}>確認取消訂單</button>
        <button className="shop-button shop-button-secondary" type="button" onClick={() => dialog.current?.close()}>保留訂單</button>
      </div>
    </dialog>
  </section>;
}
