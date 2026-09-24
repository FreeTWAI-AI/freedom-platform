import type {SkillBook} from './catalog.js';
import type {SkillBookGuide} from './skill-book-guides.js';

// Author credits supplied by the platform owner; these do not link or verify a member account.
// Repositories and source commits checked through GitHub on 2026-09-24.
const sources = {
  'local-workspace-mcp': {author:'Mini',repo:'arumwu/local-workspace-mcp',sha:'71dfd5d6c4884c218b0c2365eb68fb8dde5d7cc1',license:'MIT',title:'Local Workspace MCP 本機工作助手',reading:'README.md',evidence:['README.md','LICENSE']},
  'editkin': {author:'Hao',repo:'Hao0321/Editkin',sha:'5b74f9a31e64d76d49169bc6847c9c6fbdeb8f3f',license:'GPL-3.0-or-later',title:'Editkin 本機影片剪輯器',reading:'README.zh-TW.md',evidence:['README.zh-TW.md','package.json','LICENSE']},
  'positioning-companion': {author:'Jason',repo:'jason201385-commits/positioning-companion',sha:'d06da737b7ad10955b2f0d974bf4acf841492572',license:'MIT',title:'定位小書僮',reading:'README.md',evidence:['README.md','SKILL.md','LICENSE']},
  'freedom-party-guild-lounge': {author:'David',repo:'davidni0729/freedom-party-guild-lounge',sha:'3e86cfcbf4bbd7975be77878cf1aec960f29b169',license:'NOASSERTION',title:'巫師公會交誼廳',reading:'README.md',evidence:['README.md']},
};
type Id=keyof typeof sources;
type Details=Omit<SkillBookGuide,'author_name'|'reading_url'|'source_commit'|'reviewed_at'|'source_evidence'|'contribution_url'>;
const details:Record<Id,Details> = {
  'local-workspace-mcp': {
    format:'本機 MCP 工具',summary:'讓 AI 對話透過私人通道處理自己的檔案、文件與 Python 工作。',
    audience:['需要整理本機文件的人','想驗證 MCP 工作流程的 AI 開發者'],
    status:'目前為 alpha，來源支援 macOS／Linux，原生 Windows 尚不支援；實際帳號連線與使用環境需自行驗證。',
    features:['本機檔案搜尋與文件產出','文件模式與完整工具模式分開選擇','透過私人 MCP 通道接入對話'],
    prerequisites:['自己的 macOS 或 Linux 電腦及 Python／uv 環境','文件工作需 Docker；依原作說明建立自己的通道與受限金鑰','完整模式可執行目前使用者有權執行的操作；先確認所需範圍'],
    first_steps:['閱讀安裝與權限說明，選擇符合需求的模式。','依原作文件設定私人通道，只用合成檔案做第一次測試。','請 AI 把一份範例 CSV 整理成報表，核對結果與產出位置。'],
    first_result:'一份由合成 CSV 產生、經本人核對數值與位置的本機報表。',
    contribution:'向原作回報可重現的連線或文件處理問題，附環境與合成案例；保留 Mini 與第三方引擎的來源聲明。',
    beginner:{category:'作品與開源',purpose:'讓 AI 使用自己的本機檔案，完成一份可核對的文件或報表。',for_whom:'想把 AI 對話接上本機工作流程的人。',make:'一份使用合成資料製作的報表與檢查紀錄。',workshop_use:'在 AI 開發及 AI 導入與驗證公會分享連線方法與去識別測試。',next_step:'先閱讀文件模式與完整模式的差異，再用合成 CSV 試作。'},
  },
  'editkin': {
    format:'影片剪輯器原始碼',summary:'以可編輯時間軸整理影片，透過結構化指令與 AI 協作剪輯。',
    audience:['影音製作者','想開發剪輯工具與 AI 工作流程的人'],
    status:'社群原始碼版；Web 介面與完整桌面版的依賴不同，尚無通過正式發行審查的官方安裝包。',
    features:['可修改的影片時間軸','共用 EditGraph 與結構化 AI 指令','合成示範素材及可重現的開發流程'],
    prerequisites:['Node.js 22.13 以上；桌面建置另需 Rust 與平台媒體依賴','使用自製、合成或已取得使用權的影片素材','閱讀 GPL-3.0-or-later、第三方聲明與 DCO 貢獻規則'],
    first_steps:['閱讀繁中說明與 BUILDING.md，確認要驗證 Web 還是桌面流程。','依原作步驟建置，用合成素材調整一個時間軸片段。','記錄預覽、存檔與輸出各自實際驗證的結果，再向 Hao 的原作提 PR。'],
    first_result:'一份包含時間軸修改、合成素材與實測範圍的剪輯試作紀錄。',
    contribution:'依原作 CONTRIBUTING.md 改善剪輯、無障礙或測試，以 DCO 簽署提交小型 PR，保留 Hao 與實際協作者署名。',
    beginner:{category:'內容與行銷',purpose:'用可修改的時間軸，把影片素材整理成一段剪輯試作。',for_whom:'影音製作者與想研究 AI 剪輯工具的開發者。',make:'一段合成素材的時間軸試作，以及可重現的驗證紀錄。',workshop_use:'在影音自動化公會交換剪輯案例，與既有影片工具包搭配研究。',next_step:'從原作繁中說明開始，先用合成素材修改一個片段。'},
  },
  'positioning-companion': {
    format:'對話 Skill 與提問框架',summary:'透過逐步提問與真實證據，整理一個由本人選擇、可以驗證的方向。',
    audience:['正在整理下一步方向的人','陪伴夥伴探索工作與創作方向的人'],
    status:'可直接貼給 AI 或按原作方式安裝 Skill；提供方向假設與檢查框架，不保證收入，也不替本人決定轉職。',
    features:['快速草稿與完整探索兩種模式','比較方向前先檢查限制與反向條件','以定位卡和最小實驗記錄可推翻的假設'],
    prerequisites:['一個自己想釐清的情境與可投入時間','可對話的 AI 或文字筆記工具','只使用本人願意分享的去識別資料'],
    first_steps:['閱讀 README，從一鍵貼上版或 SKILL.md 選擇使用入口。','一次回答一題，分清自己的說法、AI 推測與待查證項目。','自行選擇一個小實驗，寫下要蒐集的證據與回顧方式。'],
    first_result:'一張本人確認的定位卡，附一項可推翻方向假設的最小實驗。',
    contribution:'以去識別案例改善原作的提問與護欄；衍生版本保留 Jason 的 based on 來源與護欄說明，再回饋原作 PR。',
    beginner:{category:'定位與社群',purpose:'把想走的方向整理成有證據、由自己決定的一個小實驗。',for_whom:'正在探索方向，或願意陪夥伴一起釐清下一步的人。',make:'一張定位卡與一項可驗證的小實驗。',workshop_use:'在定位與陪跑公會交流去識別的方向探索，不取代工坊會員定位。',next_step:'打開原作一鍵貼上版，以一個真實情境開始對話。'},
  },
  'freedom-party-guild-lounge': {
    format:'活動互動網站',summary:'串起手機報到、角色名牌、大屏展示與本人同意的現場媒合。',
    audience:['社群活動主辦者','現場主持人與活動工具開發者'],
    status:'原作提供活動報到與媒合網站；完整運作需 Worker、D1、R2。Repo 未附明確授權文件，收錄不表示取得重用授權。',
    features:['手機建立並預覽角色識別名牌','自行選擇大屏展示與媒合意願','主持人啟動倒數、媒合與活動資料清理'],
    prerequisites:['先閱讀原作流程與授權狀態，重用程式或素材前向 David 確認','完整測試需獨立 Worker、D1、R2 環境及工作人員憑證','以合成參與者測試，正式活動另取得本人同意'],
    first_steps:['閱讀 README，分清參與者手機、大屏與主持人三個入口。','先用合成名牌檢查手機版與同意選項，不把工作人員連結公開。','由有權的主辦者在測試環境驗證報到、媒合與活動結束後清理。'],
    first_result:'一份以合成參與者核對報到、名牌、媒合與資料清理的活動演練表。',
    contribution:'先向 David 確認授權與協作範圍，再以合成案例改善報到、無障礙或媒合流程；提案與修改回到原作討論。',
    beginner:{category:'定位與社群',purpose:'讓活動夥伴用手機報到、製作名牌，再依本人意願認識彼此。',for_whom:'活動主辦者、主持人與想改善社群互動的人。',make:'一份報到、展示、媒合與清理的活動演練紀錄。',workshop_use:'在社群經營與活動空間公會討論迎新與破冰流程。',next_step:'先閱讀三種角色的操作入口，並確認原作授權與使用條件。'},
  },
};
export const memberSkillBookGuides:Record<string,SkillBookGuide>=Object.fromEntries(Object.entries(sources).map(([id,source])=>[id,{
  ...details[id as Id],author_name:source.author,reading_url:`https://github.com/${source.repo}/blob/${source.sha}/${source.reading}`,
  source_commit:source.sha,reviewed_at:'2026-09-24',contribution_url:`https://github.com/${source.repo}/issues`,
  source_evidence:source.evidence.map(path=>({path,url:`https://github.com/${source.repo}/blob/${source.sha}/${path}`})),
}]));
export const memberSkillBooks:SkillBook[]=Object.entries(sources).map(([id,source])=>({
  id,title:source.title,description:details[id as Id].summary,kind:'reference',license_status:source.license,
  repository_url:`https://github.com/${source.repo}`,upstream_url:`https://github.com/${source.repo}`,fork_url:`https://github.com/${source.repo}/fork`,
  source_commit:source.sha,introduction_url:null,
}));
