import type {SkillBook} from './catalog.js';
import type {SkillBookGuide} from './skill-book-guides.js';

// Community names supplied by the platform owner; no member identity is inferred.
// Pinned upstream documentation reviewed 2026-09-24; upstream apps were not run.
export const communityAuthorSources = {
  'bidding-radar-concept':{author:'綠豆',repo:'greenQQQ/bidding-radar-concept',sha:'a02db6cb6ef754bff3622e88eb10167cf772ca72',title:'領標雷達：標案與補助設計',reading:'README.md',evidence:['README.md','實作指南.md','LICENSE'],guilds:['guild_opportunity_partnership','guild_ai_field']},
  'aiwff-runtime':{author:'隊長',repo:'zaxardery8011-design/aiwff-runtime',sha:'8d3eabf0cb614f74b6c1d3a0b9316e5c9f2fcc19',title:'小主腦：本機 AI 任務系統',reading:'README.zh-TW.md',evidence:['README.zh-TW.md','AGENTS.md','LICENSE'],guilds:['guild_ai_vibe','guild_ai_field']},
  'n8n-marketing-flows':{author:'Yuri',repo:'YuriCrystal/n8n-marketing-flows',sha:'46c8e2535430ebe1e9bb4d8b6b335465c4702ffb',title:'n8n 行銷自動化模板',reading:'README.md',evidence:['README.md','LICENSE'],guilds:['guild_marketing','guild_ai_field']},
  'anti-gambling-trader-tw':{author:'阿軒哥哥（阿軒割割）',repo:'mars-tw/anti-gambling-trader-tw',sha:'9d938b64c80ee29363aed496ba4e61d9110a7222',title:'反詐投資王：交易統計與驗證',reading:'README.md',evidence:['README.md','docs/user-guide.md','LICENSE'],guilds:['guild_ai_field']},
  'web-card-game-skill':{author:'阿軒哥哥（阿軒割割）',repo:'mars-tw/web-card-game-skill',sha:'d690b88ea23333d53d9126c51127ded6b24b4927',title:'裂潮卡牌：網頁卡牌遊戲 Skill',reading:'README.md',evidence:['README.md','SKILL.md','LICENSE'],guilds:['guild_ai_vibe']},
  'ai-avatar-bot':{author:'Yuri',repo:'YuriCrystal/ai-avatar-bot',sha:'d9276a227ea342eebfb9967f9245256406de7d23',title:'會說話的網站虛擬人',reading:'README.md',evidence:['README.md','LICENSE'],guilds:['guild_ai_vibe','guild_member_operations']},
  'ai-manga-translator':{author:'綠豆',repo:'greenQQQ/ai-manga-translator',sha:'964734a9366b872b4c7ac2069be72124eb3d332e',title:'AI 漫畫圖片翻譯',reading:'README.md',evidence:['README.md','LICENSE'],guilds:['guild_ai_field','guild_media_automation']},
  'line-persona':{author:'隊長',repo:'zaxardery8011-design/line-persona',sha:'8b44f432a8b8e847c7164290f656bcca9164aaec',title:'LINE 影分身',reading:'README.md',evidence:['README.md','AGENTS.md','LICENSE'],guilds:['guild_member_operations','guild_ai_field']},
};
type Id=keyof typeof communityAuthorSources;
type Details=Omit<SkillBookGuide,'author_name'|'reading_url'|'source_commit'|'reviewed_at'|'source_evidence'|'contribution_url'>;
const details:Record<Id,Details>={
  'bidding-radar-concept':{
    format:'概念與設計文件（不含程式碼）',summary:'從公開資料設計標案搜尋、追蹤、決標分析與公司補助資格比對。',
    audience:['尋找標案或補助的團隊','想依自己的需求開發資料工具的人'],
    status:'原作僅公開概念與設計，沒有可安裝程式。可交給 AI 參考再自行開發；資料取得須依來源規範，資格與期限回到官方公告確認。',
    features:['標案搜尋、追蹤與決標行情的設計思路','以公司描述逐條比對補助條件，附符合／可能符合／不符合理由','區分公開資料來源、條件篩選與 AI 輔助分析'],
    prerequisites:['閱讀 README、實作指南與各資料來源規範','準備去識別公司描述及可查證的官方補助公告','自行選擇開發環境與本機或雲端模型；模型可能另計費'],
    first_steps:['先讀設計與資料來源：標案搜尋包含 g0v 整理的 API，決標與補助資料另連官方公開來源。','選一份官方補助公告，用虛構公司描述逐條整理資格與證據。','讓自己的 Agent 依設計製作最小試作，保留待確認項目與人工覆核。'],
    first_result:'一份附官方出處、資格理由與待查事項的補助比對試作規格。',
    contribution:'向綠豆的原作回饋資料來源更新、資格比對案例或設計修正；不把尚未公開的程式描述成已取得。',
    beginner:{category:'小隊與協作',purpose:'把找標案、找補助的需求整理成能自行開發的設計。',for_whom:'想為公司找機會，或研究公開資料工具的人。',make:'一份補助條件比對表與最小開發規格。',workshop_use:'在機會與合作公會交流需求，於 AI 導入與驗證公會核對資料與理由。',next_step:'從一份官方公告開始，先核對條件再請 Agent 參考設計。'},
  },
  'aiwff-runtime':{
    format:'本機 Agent 任務執行系統',summary:'交辦任務、查看背景進度，將成果檔案留在自己的電腦。',
    audience:['想入門 Agent 的開發者','需要整理檔案或資料處理流程的人'],
    status:'MIT 開源；預設 mock 模擬模式免費、不需 API key。真正執行 AI 任務需自己的 Claude CLI 帳號與費用；接 Claude 或 Telegram 時會有資料傳往相應服務。',
    features:['WebUI 建立任務並追蹤背景 worker','以本機檔案保存任務、進度與成果','先用模擬模式驗流程，再接自己的工具與 Claude CLI'],
    prerequisites:['Node.js 18 以上及自己的測試資料夾','閱讀繁中安裝文件與 AGENTS.md，限定可操作範圍','真實 Claude 與 Telegram 為另行設定的服務'],
    first_steps:['依原作安裝文件啟動預設 mock 模式，先不接付費服務。','建立一個示範任務，從 WebUI 找到進度與 data/artifacts 成果檔。','核對成功與失敗結果後，再自行決定是否接真實 Claude worker。'],
    first_result:'一筆可由 WebUI 追蹤、能找到本機成果檔的模擬任務。',
    contribution:'改善原作任務失敗提示、成果檔檢查或新手文件；提交可重現紀錄，區分模擬與真實 Claude 結果。',
    beginner:{category:'作品與開源',purpose:'讓任務從交辦、背景執行到交回檔案形成完整流程。',for_whom:'想拆解 Agent 系統、親手加一項能力的人。',make:'一筆模擬任務及其可核對的本機成果。',workshop_use:'在 AI 開發與 AI 導入與驗證公會交流任務處理及驗收方法。',next_step:'先跑免費模擬模式，確認任務與結果的檔案位置。'},
  },
  'n8n-marketing-flows':{
    format:'n8n 工作流 JSON 模板',summary:'匯入新聞整理、貼文草稿與行銷流程，再接自己的模型與服務。',
    audience:['行銷與內容工作者','想學習 n8n 串接的人'],
    status:'MIT 模板庫，包含本機 Ollama 版本與待接 API 的 skeleton。架構範本的匯入檢查不代表已驗證真實平台發布；外部服務費用與授權另計。',
    features:['新聞彙整、文案草稿與敏感字檢查','本機模型及通用雲端模型版本','各模板標示節點、憑證與待設定範圍'],
    prerequisites:['自己的 n8n 環境','本機版所需的 Ollama 模型，或自行申請的外部 API 憑證','閱讀模板說明與 CREDITS，發布及廣告操作先用測試帳號核對'],
    first_steps:['選一支產生草稿的模板，確認檔名是本機版、通用版或 skeleton。','匯入自己的 n8n，填測試參數並檢查節點與服務設定。','手動執行並核對輸出，確認後再自行開啟排程或發布節點。'],
    first_result:'一份由自己手動跑出的新聞摘要或貼文草稿，附節點測試紀錄。',
    contribution:'回饋一支可匯入的模板 JSON、中文說明與實際測試範圍，移除憑證與私人收件人，保留 Yuri 與方法論致謝。',
    beginner:{category:'內容與行銷',purpose:'把重複的行銷整理工作接成看得見的自動化流程。',for_whom:'想從現成模板開始學習 n8n 的行銷夥伴。',make:'一份手動確認過的摘要或內容草稿。',workshop_use:'在行銷公會交流模板，在 AI 導入與驗證公會檢查節點與失敗情境。',next_step:'先選產出草稿的本機模板，確認輸出後再接發布。'},
  },
  'anti-gambling-trader-tw':{
    format:'本機交易統計工具與 Skill',summary:'用交易紀錄檢查期望值、樣本外表現與偏差，練習以證據判讀績效。',
    audience:['想理解交易統計的人','研究資料驗證與回測工具的開發者'],
    status:'MIT 開源，核心統計在本機處理。提供統計輔助，不保證獲利，也不構成投資建議；產生的交易專案預設 PaperBroker，真實券商連線需另行實作與驗證。',
    features:['勝率、盈虧比、期望值與顯著性檢定','樣本外驗證及倖存者偏差檢查','反詐話術檢視、報表與紙上交易程式骨架'],
    prerequisites:['Python 3.10 以上','合成或去識別交易紀錄，保留完整樣本與費用假設','Excel、OCR 等功能另有依賴；首次練習不接真實交易帳號'],
    first_steps:['閱讀原作方法論與使用指南，先用範例交易紀錄。','比較完整樣本與樣本外結果，檢查費用、資料缺漏和樣本量。','保存報表與假設，若研究程式生成則使用預設紙上模擬。'],
    first_result:'一份標明樣本、假設與限制的合成交易統計報表。',
    contribution:'以合成資料補統計邊界、輸入解析或報表測試；保留 PaperBroker 預設與實盤保護，不把歷史回測寫成獲利承諾。',
    beginner:{category:'作品與開源',purpose:'用可重現的資料檢查交易績效主張與統計限制。',for_whom:'對統計驗證、反詐與本機工具有興趣的人。',make:'一份可重跑且註明限制的統計報告。',workshop_use:'在 AI 導入與驗證公會交流資料品質、測試與判讀方式。',next_step:'先跑原作範例，分清統計證據、假設與尚無法下的結論。'},
  },
  'web-card-game-skill':{
    format:'原生網頁卡牌遊戲與開發 Skill',summary:'研究卡牌對戰、開包與牌組系統，從可玩的原生網頁遊戲開始改造。',
    audience:['想做網頁遊戲的人','以 Agent 學習前端與遊戲規則的開發者'],
    status:'MIT 原始碼，遊戲執行期無外部依賴；本機開發及測試另需工具。AI 美術生成可選，需自行準備服務與費用，素材依 CREDITS 核對。',
    features:['回合制卡牌對戰與電腦對手','開卡包、收藏、牌組與本機存檔','SKILL、資料模型與美術生成流程'],
    prerequisites:['Node.js 20 以上、npm 與原作要求的靜態伺服器環境','閱讀 SKILL.md、AGENTS.md 與卡牌資料格式','修改素材前核對 CREDITS 與個別授權'],
    first_steps:['依 README 從 repo 根目錄啟動，先玩一局並匯出測試存檔。','請 Agent 閱讀 SKILL.md，選一項卡牌規則或手機操作問題。','用既有規則及瀏覽器測試核對修改，再回饋原作。'],
    first_result:'一個可重現的規則或介面改進，附測試存檔與驗證結果。',
    contribution:'改善卡牌規則、存檔相容性或手機無障礙；保留阿軒哥哥與原作素材來源，向 mars-tw 的原作送 PR。',
    beginner:{category:'作品與開源',purpose:'從一款可玩的卡牌遊戲學習前端、狀態與規則設計。',for_whom:'想用 AI 一起製作網頁遊戲的人。',make:'一項經規則與畫面驗證的小改版。',workshop_use:'在 AI 開發公會交流遊戲規則與 Agent 協作實作。',next_step:'先跑原作並完成一局，再挑一個小問題修改。'},
  },
  'ai-avatar-bot':{
    format:'可嵌入網站的語音虛擬人',summary:'讓網站角色結合知識庫、語音回覆與嘴型同步，並可換成自己的角色。',
    audience:['網站接案與品牌經營者','想研究語音角色互動的開發者'],
    status:'專案自有程式採 MIT；Live2D Cubism Core 與 Haru 示範模型另有專有授權，不包含在 MIT 中。語音、模型服務與部署費用需依自己的設定確認。',
    features:['Live2D／VRM 角色與語音嘴型同步','知識庫問答與網站嵌入','角色替換與管理介面'],
    prerequisites:['閱讀 README 的部署、環境設定與第三方授權章節','準備自己有權使用的角色與知識內容','依所選模型與語音服務設定自己的憑證'],
    first_steps:['先閱讀原作 Demo 與安裝說明，辨識程式及示範素材各自的授權。','用合成 FAQ 與有權使用的角色建立測試網站。','檢查語音、嘴型、回答來源與關閉麥克風的操作，再測嵌入自己的頁面。'],
    first_result:'一個使用合成 FAQ、可核對回答與語音互動的網站角色試作。',
    contribution:'向 Yuri 的原作回饋嵌入、語音、角色切換或無障礙問題；附去識別重現，不隨 PR 散布未授權模型。',
    beginner:{category:'作品與開源',purpose:'替網站加入可以回答問題、會說話的角色。',for_whom:'做網站、經營品牌或想玩語音虛擬人的夥伴。',make:'一個以合成資料測試的角色問答頁。',workshop_use:'在 AI 開發與社群經營公會討論網站接待與角色互動。',next_step:'先確認角色與引擎授權，再用一小份 FAQ 試作。'},
  },
  'ai-manga-translator':{
    format:'Chrome／Edge 圖片翻譯擴充',summary:'將譯文疊回漫畫對話框，利用作品詞彙表保持跨頁人名一致。',
    audience:['想閱讀外語漫畫的人','研究圖片翻譯與瀏覽器擴充的開發者'],
    status:'MIT 開源擴充；自備看圖模型的 API 或本地模型。雲端模式會傳送待翻譯圖片給所選服務，可能計費；定位與翻譯準確度依模型和圖片而異。',
    features:['圖片、截圖與框選翻譯，譯文原位覆蓋','依作品保存人名、術語與劇情記憶','可移動、修改譯文及清理本機快取'],
    prerequisites:['Chrome 或 Edge 與原作安裝包／原始碼','自行選擇可看圖的模型與服務，了解資料傳輸方式','先用自製或有權使用的範例圖片測試'],
    first_steps:['依 README 載入擴充，選擇自己的雲端 API 或本機模型。','用兩張有共同人名的自製圖片測試翻譯與跨頁詞彙表。','核對文字與對話框位置，嘗試改字、移框及清除作品記憶。'],
    first_result:'一組經人工核對、跨頁人名一致的範例翻譯紀錄。',
    contribution:'以自製範例回報對話框定位、快取或詞彙表問題，附瀏覽器與模型設定但移除金鑰，向綠豆的原作提案。',
    beginner:{category:'內容與行銷',purpose:'在原圖上閱讀翻譯，並整理整部作品一致的名字與術語。',for_whom:'閱讀外語圖片，或想研究翻譯擴充的人。',make:'兩頁人名一致且經核對的圖片翻譯案例。',workshop_use:'在 AI 導入與驗證及影音自動化公會討論圖片處理與翻譯品質。',next_step:'先用自製圖片測試模型，再調整文字位置與詞彙表。'},
  },
  'line-persona':{
    format:'LINE AI 分身框架',summary:'把自己的介紹與知識接到 LINE，讓分身依設定口吻回答常見問題。',
    audience:['想整理服務常見問答的人','學習聊天機器人與 Agent 設定的人'],
    status:'MIT 開源，支援相容雲端或本機模型。LINE 訊息仍經 LINE 服務；雲端模型也會收到問答資料，並非所有資料都只留本機。服務額度與模型費用另計。',
    features:['Markdown 人格與知識資料','可切換相容雲端或本機模型','AGENTS.md 引導設定與資料蒸餾流程'],
    prerequisites:['Node.js 18 以上及自己的 LINE Messaging API channel','由本人私下設定 channel token、secret 與模型憑證','HTTPS webhook 與願意提供給分身使用的資料'],
    first_steps:['請自己的 Agent 先讀原作 AGENTS.md 與使用手冊，再依需要協助設定。','用虛構人物資料編寫 persona/profile.md 與 persona/knowledge.md。','本人完成 LINE 與模型設定後測試一題 FAQ，核對回答、webhook 與停止服務方式。'],
    first_result:'一個能以測試人格回答合成 FAQ 的 LINE 分身。',
    contribution:'回饋知識整理、回覆邊界或 webhook 錯誤處理；只附合成對話，保留隊長原作署名與憑證的私人設定。',
    beginner:{category:'定位與社群',purpose:'把個人介紹與常見問題交給住在 LINE 裡的分身回答。',for_whom:'希望用自己的資料做 LINE 接待工具的人。',make:'一個已測試問答與停止方式的 LINE bot。',workshop_use:'在社群經營及 AI 導入與驗證公會交流接待情境與回覆品質。',next_step:'先讀 AGENTS.md，用合成 FAQ 確認流程後再放入本人願意分享的資料。'},
  },
};
export const communityAuthorGuides:Record<string,SkillBookGuide>=Object.fromEntries(Object.entries(communityAuthorSources).map(([id,source])=>[id,{
  ...details[id as Id],author_name:source.author,reading_url:`https://github.com/${source.repo}/blob/${source.sha}/${source.reading}`,
  source_commit:source.sha,reviewed_at:'2026-09-24',contribution_url:`https://github.com/${source.repo}/issues`,
  source_evidence:source.evidence.map(path=>({path,url:`https://github.com/${source.repo}/blob/${source.sha}/${path}`})),
}]));
export const communityAuthorBooks:SkillBook[]=Object.entries(communityAuthorSources).map(([id,source])=>({
  id,title:source.title,description:details[id as Id].summary,kind:'reference',license_status:'MIT',
  repository_url:`https://github.com/${source.repo}`,upstream_url:`https://github.com/${source.repo}`,fork_url:`https://github.com/${source.repo}/fork`,source_commit:source.sha,introduction_url:null,
}));
