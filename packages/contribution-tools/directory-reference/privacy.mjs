// Fixed host rendering reference from FreeTWAI-AI/FreeTWAI-AI.github.io
// approved baseline 01b18397f9c5356a14e4cc66fa46f57216f11154, src/privacy.mjs.
// Never loaded from a candidate; profile changes require independent review.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// Escape first, then link only https URLs and plain e-mail addresses (no raw HTML from data).
const linkify = (text) => escapeHtml(text)
  .replace(/https:\/\/[A-Za-z0-9.\-]+(?:\/[A-Za-z0-9._~\-\/]*)?/g, (match) => {
    const url = match.replace(/[.]+$/, '');
    return `<a href="${url}" rel="noopener noreferrer">${url}</a>${match.slice(url.length)}`;
  })
  .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (mail) => `<a href="mailto:${mail}">${mail}</a>`);

function validateLanguage(lang, key) {
  if (!lang || typeof lang.title !== 'string' || typeof lang.effective !== 'string' || !Array.isArray(lang.sections) || !lang.sections.length) throw new TypeError(`Invalid ${key} policy`);
  for (const section of lang.sections) {
    if (typeof section?.h !== 'string' || !section.h.trim() || !Array.isArray(section.blocks) || !section.blocks.length) throw new TypeError(`Invalid ${key} section`);
    for (const block of section.blocks) {
      const ok = (typeof block?.p === 'string' && block.p.trim()) || (Array.isArray(block?.ul) && block.ul.length && block.ul.every((item) => typeof item === 'string' && item.trim()));
      if (!ok) throw new TypeError(`Invalid ${key} block in "${section.h}"`);
    }
  }
}

export function validatePrivacyPage(input) {
  if (input?.schema_version !== 'freetwai.privacy-page/v1') throw new TypeError('Expected a FreeTWAI privacy page');
  if (typeof input.path !== 'string' || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\/$/.test(input.path)) throw new TypeError('Invalid page path');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effective_date ?? '')) throw new TypeError('Invalid effective date');
  validateLanguage(input.zh, 'zh');
  validateLanguage(input.en, 'en');
  return input;
}

const renderBlocks = (blocks) => blocks.map((block) => block.ul
  ? `<ul>${block.ul.map((item) => `<li>${linkify(item)}</li>`).join('')}</ul>`
  : `<p>${linkify(block.p)}</p>`).join('');

const renderLanguage = (lang, id, langTag) => `<section id="${id}" lang="${langTag}"><p class="eyebrow">${escapeHtml(lang.eyebrow ?? '')}</p><h1>${escapeHtml(lang.title)}</h1><p class="effective">${escapeHtml(lang.effective)}</p>${lang.sections.map((section) => `<h2>${escapeHtml(section.h)}</h2>${renderBlocks(section.blocks)}`).join('')}</section>`;

export function renderPrivacyPage(input) {
  const page = validatePrivacyPage(input);
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(page.zh.title)} · Privacy Policy</title><style>body{margin:0;color:#153c33;background:#f4f8f5;font:17px/1.7 system-ui}main{max-width:820px;margin:0 auto;padding:64px 24px}h1{font-size:clamp(1.8rem,5vw,2.8rem);line-height:1.25;margin:.2em 0}h2{font-size:1.2rem;margin:2em 0 .4em}a{color:#17654b;overflow-wrap:anywhere}.eyebrow{font-size:.8rem;letter-spacing:.18em;margin:0}.effective{color:#5a6e64}nav{margin:0 0 32px;font-size:.95rem}nav a{margin-right:1.2em}section{background:white;border:1px solid #dce7df;border-radius:18px;padding:32px;margin-bottom:32px}li{margin:.4em 0}footer{margin-top:40px;border-top:1px solid #dce7df;padding-top:24px;color:#5a6e64;font-size:.95rem}</style></head><body><main><nav><a href="#zh" lang="zh-Hant">繁體中文</a><a href="#en" lang="en">English</a></nav>${renderLanguage(page.zh, 'zh', 'zh-Hant')}${renderLanguage(page.en, 'en', 'en')}<footer>此頁為靜態頁面，不載入追蹤程式、Cookie 或外部資源。This is a static page with no trackers, cookies or external resources.</footer></main></body></html>`;
}
