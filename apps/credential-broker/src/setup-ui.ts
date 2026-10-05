import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BrokerModelSelectionSchema } from '../../../contracts/execution/v2/model-credential.js';
import { OpaqueId } from '../../../contracts/common/v1/identity.js';
import { snapshotInput } from '../../../packages/execution-state/decode.js';

const SetupDocumentSchema=z.object({selection:BrokerModelSelectionSchema,operation:z.enum(['create','rotate']),
  modelConnectionId:OpaqueId,csrfToken:z.string().length(43).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/),
  expiresAt:z.iso.datetime({precision:3}),operational_authority:z.literal(false)}).strict();
export type ProtectedCredentialSetupDocument=z.infer<typeof SetupDocumentSchema>;
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

/** This renderer cannot attest that capture is disabled. The installed broker
 * must obtain that evidence before calling it or returning its key document. */
export function renderProtectedCredentialSetup(raw:ProtectedCredentialSetupDocument){
  const data=SetupDocumentSchema.parse(snapshotInput(raw));
  if(Date.parse(data.expiresAt)<=Date.now())throw new Error('credential_ingest_unavailable');
  const title=data.operation==='rotate'?'替換模型金鑰':'設定模型金鑰';
  const consequence=data.operation==='rotate'
    ?'完成替換後，舊金鑰與原模型連線會停用；原有執行授權不能轉用新連線。'
    :'金鑰由平台加密保管，送交所選模型服務處理；私人工作的內容仍需逐次取得你的同意。';
  return {contentSecurityPolicy:"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    html:`<!doctype html><html lang="zh-Hant" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · 自由工坊</title><link rel="stylesheet" href="/credential-setup.css"><script src="/credential-setup.js" defer></script></head><body><main class="credential-setup" data-protected-surface="credential-ingest" data-no-capture="true" data-csrf="${escape(data.csrfToken)}" data-expires="${escape(data.expiresAt)}"><img class="credential-brand" src="/credential-setup-brand.webp" alt="自由工坊"><h1>${title}</h1><p class="credential-lede">${escape(consequence)}</p><dl class="credential-details"><div><dt>模型服務</dt><dd>${escape(({openai:'OpenAI',anthropic:'Anthropic',openrouter:'OpenRouter'} as const)[data.selection.providerRef])}</dd></div><div><dt>模型</dt><dd>${escape(data.selection.modelRef)}</dd></div><div><dt>金鑰保管</dt><dd>平台加密保管</dd></div></dl><form id="credential-form" autocomplete="off" novalidate><div class="credential-field"><label for="credential-key">你的模型服務 API 金鑰</label><input id="credential-key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="4096" required aria-describedby="credential-key-hint"><p id="credential-key-hint" class="credential-hint">金鑰只會直接送到此設定服務。保管完成後，仍需確認模型可用性。</p></div><label class="credential-consent"><input id="credential-consent" type="checkbox" required><span>我同意以上保管方式與處理範圍${data.operation==='rotate'?'，並停用原有金鑰與連線':''}。</span></label><div class="credential-actions"><button id="credential-submit" class="primary" type="submit" disabled>${data.operation==='rotate'?'確認替換':'加密儲存金鑰'}</button></div></form><p id="credential-status" role="status" aria-live="polite"></p><p id="credential-expiry" class="credential-hint"></p><p class="credential-hint">若逾時或未收到回覆，請回主站查詢設定結果。重新設定需由你重新開啟，不會自動重送金鑰。</p><noscript><p>請啟用 JavaScript 後，回主站重新開啟設定。</p></noscript></main></body></html>`};
}

/** Explicit public brand bytes; no runtime credential/default port is loaded. */
export function loadProtectedCredentialBrand():Uint8Array{
  return new Uint8Array(readFileSync(new URL('../../portal-web/public/brand/freedom-workshop.webp',import.meta.url)));
}

// Reuses light-theme.css / styles.css / rpg-theme.css tokens and type scale.
// No shared portal SPA, analytics or capture listeners execute on this document.
export const protectedCredentialSetupStyles=`
:root{--bg:#f6f8fb;--bg-elev:#ffffff;--ink:#1c2636;--muted:#566376;--line:#dce3eb;--green:#9ed400;--green-2:#89bd00;--danger:#a3253d;--focus:#4262d3;--radius:16px;color-scheme:light;font-family:"Segoe UI","PingFang TC","Hiragino Sans CNS","Noto Sans TC","Microsoft JhengHei",sans-serif;color:var(--ink);background:var(--bg);font-size:16px;line-height:1.65}
*,*::before,*::after{box-sizing:border-box}body{margin:0;background:var(--bg)}button,input{font:inherit}h1,p,dl{margin:0}h1{font-size:1.45rem;line-height:1.45}h1,.credential-lede{margin-bottom:16px}.credential-setup{width:min(100% - 32px,640px);margin:32px auto;padding:24px;background:var(--bg-elev);border:1px solid var(--line);border-radius:var(--radius)}.credential-brand{display:block;width:172px;max-width:100%;height:auto;margin-bottom:24px}.credential-lede,.credential-hint{color:var(--muted)}.credential-details{border-block:1px solid var(--line);padding-block:16px;margin-bottom:24px}.credential-details>div{display:grid;grid-template-columns:96px minmax(0,1fr);gap:16px;margin-block:4px}.credential-details dt{color:var(--muted)}.credential-details dd{margin:0;overflow-wrap:anywhere}.credential-field{display:grid;gap:8px;margin-bottom:16px}.credential-field label{font-weight:600}.credential-field input{min-height:44px;width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:8px;color:var(--ink);background:var(--bg-elev)}.credential-hint{font-size:.89rem;overflow-wrap:anywhere}.credential-consent{display:flex;align-items:flex-start;gap:8px;padding-block:8px;min-height:44px;cursor:pointer}.credential-consent input{width:20px;height:20px;flex:none;margin-top:4px;accent-color:var(--focus)}.credential-actions{margin-block:16px}.primary{border:0;border-radius:999px;background:var(--green);color:#101500;min-height:44px;padding:8px 20px;font-weight:700;cursor:pointer}.primary:hover:enabled{background:var(--green-2)}.primary:disabled{opacity:.55;cursor:default}:focus-visible{outline:3px solid var(--focus);outline-offset:2px}#credential-status{margin-block:16px;overflow-wrap:anywhere}#credential-status[data-error="true"]{color:var(--danger)}#credential-expiry{margin-bottom:8px}@media(max-width:480px){.credential-setup{margin:16px auto;padding:16px}.primary{width:100%}}`;

export const protectedCredentialSetupScript=String.raw`
'use strict';
(() => {
  const root=document.querySelector('.credential-setup'),form=document.getElementById('credential-form');
  const key=document.getElementById('credential-key'),consent=document.getElementById('credential-consent');
  const submit=document.getElementById('credential-submit'),status=document.getElementById('credential-status'),expiry=document.getElementById('credential-expiry');
  if(!root||!form||!key||!consent||!submit||!status||!expiry)return;
  const csrf=root.dataset.csrf,expires=Date.parse(root.dataset.expires||'');delete root.dataset.csrf;
  let consumed=false,bytes,controller,timer;
  const available=()=>Number.isFinite(expires)&&Date.now()<expires;
  const show=(text,error=false)=>{status.textContent=text;status.dataset.error=String(error);};
  const refresh=()=>{const seconds=Math.max(0,Math.ceil((expires-Date.now())/1000));
    expiry.textContent=available()?'本次設定還有 '+seconds+' 秒。':'本次設定已到期，請回主站重新開啟。';
    submit.disabled=consumed||!available()||!consent.checked||!/^[A-Za-z0-9._-]{1,4096}$/.test(key.value);
    if(!available()){key.value='';key.disabled=true;consent.disabled=true;if(controller)controller.abort();if(bytes)bytes.fill(0);}};
  const clear=()=>{key.value='';if(bytes)bytes.fill(0);bytes=undefined;if(controller)controller.abort();if(timer)clearTimeout(timer);};
  const stopTimer=setInterval(refresh,1000);
  window.addEventListener('pagehide',()=>{clear();clearInterval(stopTimer);},{once:true});
  key.addEventListener('input',refresh);consent.addEventListener('change',refresh);refresh();
  form.addEventListener('submit',async event=>{
    event.preventDefault();refresh();if(submit.disabled||consumed||!csrf)return;
    consumed=true;submit.disabled=true;consent.disabled=true;
    bytes=new TextEncoder().encode(key.value);key.value='';key.disabled=true;
    controller=new AbortController();timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(5000,expires-Date.now())));
    show('正在加密儲存…');
    try{
      const prepare=await fetch('/credential-setup/prepare',{method:'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',
        headers:{'Content-Type':'application/json','X-FP-Broker-CSRF':csrf},body:JSON.stringify({consent:true}),signal:controller.signal});
      if(!prepare.ok)throw new Error('setup_failed');
      const prepared=await prepare.json();
      if(!prepared||prepared.operational_authority!==false||typeof prepared.expiresAt!=='string'||!available()||Date.parse(prepared.expiresAt)<=Date.now())throw new Error('setup_failed');
      clearTimeout(timer);timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(5000,expires-Date.now(),Date.parse(prepared.expiresAt)-Date.now())));
      const response=await fetch('/credential-setup/secret',{method:'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',
        headers:{'Content-Type':'application/octet-stream','X-FP-Broker-CSRF':csrf},body:bytes,signal:controller.signal});
      if(!response.ok)throw new Error('outcome_unknown');
      // The signed envelope is not browser execution authority. The main owner
      // metadata endpoint is the source for the actual committed outcome.
      show('已收到設定服務回覆。請回主站查看金鑰保管結果與模型狀態。');
    }catch{show('未能確認儲存結果。請回主站查詢；需要再設定時，請重新開啟。',true);}
    finally{clear();clearInterval(stopTimer);expiry.textContent='本次設定已結束。';}
  });
})();`;
