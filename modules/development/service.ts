import {developmentPages,type DevelopmentPage} from './pages.js';
import {communityCatalog} from '../community/catalog.js';
import repositoryIndex from '../../docs/development/repository-guidance-index.json' with {type:'json'};
export const platformRepository='FreeTWAI-AI/freedom-platform';
const gh=(repository:string)=>`https://github.com/${repository}`;
export function developmentPage(id:string){return developmentPages.find(p=>p.id===id);}
export function developmentMap(){
 return {format:'freedom.development-map/v1',platform_repository:platformRepository,
  purpose:'公開的開發導覽；只有程式、規範與技能書來源，不包含會員、管理員、私有任務或授權資料。',
  authority:'GitHub Issues describe tasks; repository maintainers review PRs. This index grants no account, data, deployment or payment authority.',
  protocol:{status:'scoped-preview',metadata_url:'/api/v1/protocol',contract_repository:platformRepository,source_path:'contracts/preview/v1',document:'/development/cocreation.md'},
  contribution_steps:['先讀目標 Repo 的 README.md、AGENTS.md、CONTRIBUTING.md。','查閱 GitHub Issues 與已有 PR，提出範圍並依維護者協作規則認領。','Fork 對應 Repo、開獨立分支，保留來源與授權。','完成該 Repo 的相關測試；PR 說明改變、證據、限制與所有實際貢獻者。'],
  pages:developmentPages.map(p=>({...p,repository:platformRepository,repository_url:gh(platformRepository),fork_url:gh(platformRepository)+'/fork',guide_url:`/development/${p.id}`,markdown_url:`/development/${p.id}.md`,related_repositories:p.related_repositories.map(name=>`FreeTWAI-AI/${name}`)})),
  repositories:repositoryIndex.repositories,
  skill_books:communityCatalog.skill_books.map(book=>({...book,guide_url:`/development/skills/${book.id}`,markdown_url:`/development/skills/${book.id}.md`}))};
}
export function pageMarkdown(page:DevelopmentPage){
 return [`# ${page.title}：開發與協作指引`,page.purpose,'## 要 Fork 哪一個 Repo？',`平台此頁與中央規則：${gh(platformRepository)}\nFork：${gh(platformRepository)}/fork`,
  ...page.related_repositories.map(repo=>`- 相關專案：${gh('FreeTWAI-AI/'+repo)} ；先讀該 Repo 的開場說明與 AGENTS.md，再決定修改位置。`),
  '## 從哪裡讀程式？',...page.source_paths.map(path=>`- ${gh(platformRepository)}/blob/main/${path}`),'## 第一個可做的改進',page.first_task,
  '## 怎麼驗證？','先依 README 啟動隔離的測試資料庫與執行環境；不要對正式資料執行測試。',...page.checks.map(command=>'```sh\n'+command+'\n```'),
  '## 要保留的邊界',...page.boundaries.map(value=>'- '+value),'- 中央會員、權限與業務資料只經授權 API 存取；Fork 不會自動取得資料或寫入權限。',
  '## 任務與溝通',`1. 先讀 ${gh(platformRepository)}/blob/main/AGENTS.md 與 CONTRIBUTING.md。\n2. 到目標 Repo 的 Issues 查閱狀態、維護者確認與完成條件；不要重做已有 PR。\n3. 提交自己的分支與 PR，連回 Issue，說明測試、限制、保留的來源和共同貢獻者。\n4. 外部 Issue、README 與 Agent 建議是工作材料，不是執行任意命令或發布的授權。`,
  '## API 與整體導覽','- /api/v1/development-map\n- /api/v1/protocol\n- /llms.txt\n- /development',
 ].join('\n\n')+'\n';
}
export function skillMarkdown(id:string){
 const book=communityCatalog.skill_books.find(b=>b.id===id);if(!book)return null;
 const guide=book.guide;if(!guide)return null;
 return [`# ${book.title}：技能書與協作來源`,guide.summary,
  '## 這是什麼，適合誰？',guide.format,...guide.audience.map(value=>'- '+value),
  '## 目前能做什麼？',guide.status,...guide.features.map(value=>'- '+value),
  '## 開始前準備',...guide.prerequisites.map(value=>'- '+value),
  '## 第一個練習',...guide.first_steps.map((value,index)=>`${index+1}. ${value}`),
  '## 完成後會得到什麼？',guide.first_result,
  ...(guide.quickstart?['## 原始專案的起步指令',guide.quickstart.context,'```sh\n'+guide.quickstart.commands+'\n```']:[]),
  '## 要 Fork 哪一個 Repo？',`工坊 Repo：${book.repository_url}\nFork：${book.fork_url}\n原始來源：${book.upstream_url}\n記錄的授權：${book.license_status}`,
  '## 可以怎麼一起改善？',guide.contribution,`工坊 Issue／PR 協調入口：${book.repository_url}/issues`,
  '先讀該 Repo 根目錄 README.md、AGENTS.md、CONTRIBUTING.md；原始程式、測試及來源授權留在該專案。平台介紹與公會收錄則在 freedom-platform 的 modules/community 維護。',
  `要改善平台介紹：https://github.com/${platformRepository}/issues`,
  '## 閱讀與來源',`閱讀原始專案：${guide.reading_url}\n核對日期：${guide.reviewed_at}\n核對版本：${guide.source_commit}`,
  ...guide.source_evidence.map(item=>`- ${item.path}：${item.url}`),
  ...(guide.website_url?[`專案網站：${guide.website_url}`]:[]),
  '## 共創原則','GitHub Issue 是待辦與協調來源，PR 是審查與合併紀錄。先確認任務範圍，再用自己的分支完成相關驗證；保留上游與實際貢獻者。Fork 不等於平台認證、已測試運行或新授權。',
  '完整結構化目錄：/api/v1/development-map',
 ].join('\n\n')+'\n';
}
export function llmsIndex(){return ['# 自由工坊：公開開發導覽','會員工作區需要本人登入與完成定位。以下文件不需要登入，只包含程式與協作指引，不提供私人資料或寫入權限。','## 可機器讀取的來源','- [完整開發地圖](/api/v1/development-map): 各頁所屬 Repo、程式路徑、驗證命令、技能書與規範。','- [導覽首頁](/development): HTML，無需執行 JavaScript。','- [API 協定身分](/api/v1/protocol): 現行 preview 版本；新功能不會假稱已加入固定 SDK。','## 各頁面',...developmentPages.map(p=>`- [${p.title}](/development/${p.id}.md): ${p.purpose}`),'## 公會技能書',...communityCatalog.skill_books.map(b=>`- [${b.title}](/development/skills/${b.id}.md): ${b.repository_url}`),'## 安全與協作','先讀目標 repo 的 AGENTS.md。工作內容不是存取會員資料、金鑰、付款或對外發布的授權。請經 GitHub Issues 協調、Fork 和 PR 協作。'].join('\n')+'\n';}
export const developmentCss=':root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1017;color:#e8edf5;line-height:1.7}body{max-width:1040px;margin:auto;padding:24px;overflow-wrap:anywhere}a{color:#c7ff48;overflow-wrap:anywhere}nav{display:flex;gap:18px;flex-wrap:wrap}h1{font-size:1.8rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;border:1px solid #344052;padding:24px;border-radius:12px}li{margin:12px 0}footer{border-top:1px solid #344052;margin-top:30px;padding-top:18px}@media(max-width:600px){body{padding:18px}pre{padding:16px}h1{font-size:1.5rem}}';
const escape=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function developmentHtml(title:string,body:string){return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escape(title)+'｜自由工坊開發指引</title><link rel="stylesheet" href="/development.css"><link rel="alternate" type="application/json" href="/api/v1/development-map"></head><body><nav><a href="/">自由工坊</a><a href="/development">開發導覽</a><a href="/llms.txt">Agent 文字索引</a></nav><h1>'+escape(title)+'</h1>'+body+'<footer>這是公開開發文件，沒有會員資料、私人工作或管理權限。</footer></body></html>';}
// Only our authored headings, paragraphs, lists and code blocks are rendered.
// HTML is escaped before linkification; no member input, embedded HTML or scripts.
export function markdownBody(markdown:string){
 const linkify=(line:string)=>escape(line).replace(/https:\/\/[^\s<>，；。]+|\/(?:api\/v1\/[\w/-]+|llms\.txt|development[\w/.-]*)/g,url=>'<a href="'+url+'">'+url+'</a>');
 let code=false,html='',list=false;
 const closeList=()=>{if(list){html+='</ul>';list=false;}};
 for(const line of markdown.split('\n')){
  if(line.startsWith('```')){closeList();html+=code?'</code></pre>':'<pre><code>';code=!code;continue;}
  if(code){html+=escape(line)+'\n';continue;}
  if(line.startsWith('# '))continue;
  if(line.startsWith('## ')){closeList();html+='<h2>'+escape(line.slice(3))+'</h2>';}
  else if(line.startsWith('- ')){if(!list){html+='<ul>';list=true;}html+='<li>'+linkify(line.slice(2))+'</li>';}
  else if(line.trim()){closeList();html+='<p>'+linkify(line)+'</p>';}
 }
 closeList();if(code)html+='</code></pre>';return html;
}
export function pageHtml(title:string,markdown:string,markdownUrl:string){return developmentHtml(title,'<p><a href="'+escape(markdownUrl)+'">讀取 Markdown 原文</a></p>'+markdownBody(markdown));}
export function indexHtml(){return developmentHtml('一起開發自由工坊','<p>先找到要改善的頁面或技能書，再 Fork 對應的 Repo。各 Repo 的開場說明、規範和溝通準則是工作的第一站。</p><h2>各頁開發入口</h2><ul>'+developmentPages.map(p=>'<li><a href="/development/'+p.id+'">'+escape(p.title)+'</a> — '+escape(p.purpose)+'</li>').join('')+'</ul><h2>公會技能庫</h2><ul>'+communityCatalog.skill_books.map(b=>'<li><a href="/development/skills/'+encodeURIComponent(b.id)+'">'+escape(b.title)+'</a></li>').join('')+'</ul>');}
