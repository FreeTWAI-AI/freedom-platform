// Fixed host rendering reference from FreeTWAI-AI/FreeTWAI-AI.github.io
// approved baseline 01b18397f9c5356a14e4cc66fa46f57216f11154, src/index.mjs.
// Never loaded from a candidate; profile changes require independent review.
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function validateDirectory(input) {
  if (input?.schema_version !== 'freedom.source-directory/v1' || input.organization !== 'FreeTWAI-AI' || !Array.isArray(input.projects) || input.projects.length > 100) throw new TypeError('Expected the FreeTWAI-AI public source directory');
  const seen = new Set();
  for (const project of input.projects) {
    if (!project || !/^(?:\.github|[A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.test(project.repository ?? '') || project.repository.includes('..')) throw new TypeError('Invalid repository name');
    if (seen.has(project.repository.toLowerCase())) throw new TypeError('Duplicate repository');
    seen.add(project.repository.toLowerCase());
    for (const key of ['name', 'description', 'scope']) if (typeof project[key] !== 'string' || !project[key].trim() || project[key].length > 500) throw new TypeError(`Invalid ${key}`);
  }
  return input;
}

export function renderDirectory(input) {
  const directory = validateDirectory(input);
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>FreeTWAI · 專案來源目錄</title><style>body{margin:0;color:#153c33;background:#f4f8f5;font:17px/1.7 system-ui}main{max-width:1120px;margin:0 auto;padding:64px 24px}h1{font-size:clamp(2rem,6vw,3.5rem);line-height:1.2}h2{font-size:1.25rem;margin:0}a{color:#17654b;overflow-wrap:anywhere}.intro{max-width:46rem}.eyebrow{font-size:.8rem;letter-spacing:.18em}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:20px;margin-top:36px}article{background:white;border:1px solid #dce7df;padding:24px;border-radius:18px;display:flex;flex-direction:column}article p{margin:12px 0}.scope{font-size:.9rem;color:#5a6e64}article a{margin-top:auto}footer{margin-top:40px;border-top:1px solid #dce7df;padding-top:24px;color:#5a6e64}</style></head><body><main><header class="intro"><p class="eyebrow">FREETWAI · SOURCE DIRECTORY</p><h1>各自生長，透過共同平台協作。</h1><p>模組有清楚的入口與責任。這份目錄帶你找到程式、模板與協定來源；會員、權限和交易狀態由 Freedom Platform 統一管理。</p><p>目前是建置中的原始碼目錄，不代表各項產品已正式上線或通過認證。</p></header><div class="grid">${directory.projects.map((project) => `<article><h2>${escapeHtml(project.name)}</h2><p>${escapeHtml(project.description)}</p><p class="scope">${escapeHtml(project.scope)}</p><a href="https://github.com/${directory.organization}/${project.repository}" rel="noopener noreferrer">${escapeHtml(project.repository)} ↗</a></article>`).join('')}</div><footer>此頁不載入會員、訂單、登入資訊或 API 金鑰。所有連結指向公開 GitHub 原始碼。本頁經 GitHub Pages 發布；<a href="privacy/discord-bot/">Discord 機器人「小妹」隱私權政策</a>。</footer></main></body></html>`;
}
