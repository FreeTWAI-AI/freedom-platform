import type { CreditCheckoutForm } from '../providers/ecpay/aio-credit/index.js';
export const escapePaymentHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
function document(title: string, body: string, script = false): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapePaymentHtml(title)}｜自由工坊</title><link rel="stylesheet" href="/pay/ecpay/handoff.css">${script ? '<script src="/pay/ecpay/handoff.js" defer></script>' : ''}</head><body><main><h1>${escapePaymentHtml(title)}</h1>${body}</main></body></html>`;
}
export function handoffErrorPage(message: string, back?: string): string {
  return document('付款連結', `<p>${escapePaymentHtml(message)}</p><a href="${escapePaymentHtml(back ?? '/')}">${back ? '返回訂單' : '返回首頁'}</a>`);
}
export function handoffFormPage(form: CreditCheckoutForm, action: string, attemptId: string): string {
  const fields = form.fields.map(([name, value]) => `<input type="hidden" name="${escapePaymentHtml(name)}" value="${escapePaymentHtml(value)}">`).join('');
  return document('前往付款', `<p id="handoff-status" role="status">正在前往綠界付款頁…</p><form method="post" action="${escapePaymentHtml(action)}">${fields}<button id="handoff-manual" type="submit" hidden>前往綠界付款</button><noscript><button type="submit">前往綠界付款</button></noscript></form><p id="handoff-help" hidden>如果畫面一直沒有變化，請按「前往綠界付款」。</p><a id="handoff-back" href="/pay/ecpay/back/${escapePaymentHtml(attemptId)}" hidden>返回訂單</a>`, true);
}
export const HANDOFF_SCRIPT = `(() => {
  const form = document.querySelector('form');
  const status = document.getElementById('handoff-status');
  const manual = document.getElementById('handoff-manual');
  const help = document.getElementById('handoff-help');
  const back = document.getElementById('handoff-back');
  if (!form || !status || !manual || !help || !back) return;
  let submitted = false, restored = false, timer;
  manual.addEventListener('click', event => {
    event.preventDefault();
    if (restored || manual.disabled || manual.hidden) return;
    manual.disabled = true;
    HTMLFormElement.prototype.submit.call(form);
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    restored = true;
    clearTimeout(timer);
    form.hidden = true;
    manual.hidden = true;
    manual.disabled = true;
    help.hidden = true;
    back.hidden = false;
    status.textContent = '已前往付款頁。要重新付款，請回到訂單頁。';
  });
  window.addEventListener('load', () => {
    if (submitted || restored) return;
    submitted = true;
    timer = setTimeout(() => { if (!restored) { manual.hidden = false; help.hidden = false; } }, 10000);
    HTMLFormElement.prototype.submit.call(form);
  }, { once: true });
})();`;
export const HANDOFF_CSS = `:root{color-scheme:light;--page:#f6f8fb;--text:#1c2636;--action:#c4ff20;--action-text:#101500}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Noto Sans TC","Microsoft JhengHei",sans-serif}main{max-width:680px;margin:0 auto;padding:48px 24px}h1{font-size:24px;line-height:1.4;margin:0 0 16px}p{margin:0 0 24px}a{color:inherit;text-underline-offset:4px;display:inline-block;min-height:44px;padding:8px 0}button{font:inherit;min-height:44px;border:0;border-radius:24px;padding:8px 16px;background:var(--action);color:var(--action-text);cursor:pointer}a:focus-visible,button:focus-visible{outline:2px solid currentColor;outline-offset:4px}a:hover,button:hover{filter:brightness(.9)}[hidden]{display:none!important}`;
