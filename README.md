# Freedom Platform

<!-- freedom-repository-guide:start -->
## 在自由工坊的位置

[自由工坊](https://freetwai.com) 讓會員先完成定位、選擇公會並領取 Repo 技能書，再以供貨、商店、開源作品、行銷與小隊共同完成成果。

自由工坊的會員入口、中央資料庫與跨模組業務規則。 已提供 email 註冊、封閉定位、公會與技能書、會員隱私、小隊、供貨與商店草稿、作品共創、行銷紀錄、Access 管理與公會長本人確認。

正式買家結帳、平台代收款、銀行實收核實、通用 Agent 執行授權都不能由目前的預覽紀錄推定已完成。

本 repo 的維護者負責「自由工坊的會員入口、中央資料庫與跨模組業務規則。」這個模組；公會職稱與自填 GitHub slug 不授予寫入權。

程式／內容入口：[apps/portal-web/src/modules/](apps/portal-web/src/modules/)、[apps/platform-api/src/routes/](apps/platform-api/src/routes/)、[modules/](modules/)、[migrations/](migrations/)、[packages/db/](packages/db/)。協作先讀 [CONTRIBUTING.md](CONTRIBUTING.md)，讓 Agent 讀 [AGENTS.md](AGENTS.md)；從[本倉 Issues](https://github.com/FreeTWAI-AI/freedom-platform/issues)認領、[查看既有 PR](https://github.com/FreeTWAI-AI/freedom-platform/pulls)避免重工。

會員、權限、公會、商品、商店、合作和稽核的權威寫入在本 repo 的 API／PostgreSQL。外倉用版本化契約；本機、staging、public 使用分開的資料庫。GitHub Issue／PR 保存程式協作事實；Seller／bank 保存實收事實。 跨 repo 的協定由[中央平台](https://github.com/FreeTWAI-AI/freedom-platform)維護。
<!-- freedom-repository-guide:end -->

本 workspace 保存 Freedom 大平台的完整規格，以及 **0.11.0-guild-library 自由工坊會員入口**。新會員註冊後完成定位，選擇主力公會並取得 Repo 技能書，再進入供貨、商店、作品、行銷與小隊。會員名片有個別聯絡欄位的可見範圍。各模組共用中央會員與 PostgreSQL。

前版 0.9.7 修正 GitHub Star 權限錯誤提示，App 建立流程明確申請 Metadata 讀取，後台提供權限與 Repo 安裝入口。既有 App 仍需在 GitHub 補齊設定；站內連結成功不代表原作已授予 Star 存取。

公開會員入口：<https://freetwai.com>；內部入口：<https://staging.freetwai.com>（Cloudflare Access 限定名單，獨立 DB）。本輪行為與邊界見 [會員入口設計](./docs/development/member-onboarding-release.md)，運行方式見 [公開站手冊](./docs/development/public-operations.md)。

工坊夥伴名冊支援公開資料搜尋、公會篩選、加入日期／暱稱排序與緊湊列表；詳細技能和聯絡方式可展開。舊會員依開站日 2026/9/23 記錄，新會員保存實際加入時間。

名片可新增多個社群帳號或頻道，同平台也可重複加入；每筆獨立編輯、刪除及設定可見範圍，預設只有本人可見。詳見 [會員社群連結](./docs/development/member-social-links.md)。

會員入口已按用途整理：技能書架獨立提供「已解鎖／未解鎖」書目，開源投稿只處理專案登錄；公會與平台管理集中在管理分組，手機使用可展開選單。詳見 [全站導覽審查](./docs/development/workspace-ia-review.md)。

公會頁依「主要與次要」「其他已加入」「未加入」分區。最上方最多三張：一個主要、兩個可自行設定的次要公會；新入會不會擠掉已選次要。卡片只列第一本入門技能，其餘收進公會技能書庫。已領取技能書在退出後保留，未解鎖書目仍可免費預覽。詳見 [公會分組與解鎖書架](./docs/development/guild-library-layout.md)。

公會長與專家各占一列，會長在上、專家在下；頭像、姓名與職稱一起呈現，手機版以精簡人物列保留閱讀寬度。技能書架使用小封面橫列，首頁與模組入口縮減裝飾圖和留白，完整介紹仍可展開閱讀。每個公會最多三位專家；後台可從啟用中的平台會員直接任命，未入會者會同時加入該公會並領取技能書，保留原主要公會與定位。專家標章不增加管理權限，詳見 [公會管理 API](./docs/development/platform-admin-api.md)。

本版包含活動與空間、光影光雕、人類圖研究所三個公會，25 本技能書的一鍵分享與 Agent SKILL.md、公會指定技能標章、真實加星週／月榜，以及會長公告、技能負責人編輯與會長討論區。使用方式與資料邊界見 [公會共作與技能分享](./docs/development/guild-collaboration.md)。

前版新增 GitHub 真實 Stars／Forks／追蹤與更新指標、會員授權後直接加星／取消星星，以及後台 GitHub App 設定，詳見 [GitHub 連結與部署](./docs/development/github-social.md)。前版包含會員頭像、22 本專屬技能書插圖與原作者 Star 連結、任務／商品／小隊篩選，以及後台管理員任命。定位只保留一套流程，調整方向由「重新探索定位」進入。詳見 [0.7 操作與部署](./docs/development/member-toolkit.md)。既有共創與 Repo 指引見 [0.5 版本紀錄](./docs/releases/2026-09-23-collaboration-optimization.md)、[原計畫對照](./docs/development/plan-drift-2026-09-23.md) 與[網站／Agent 開發導覽](./docs/development/agent-development-guide.md)。

各產品模板已依 [九倉分工與串接方式](./docs/development/repository-integration.md) 獨立保存，透過固定版本的 API／SDK 共用中央會員與資料。

## 啟動本機版本

需要 Node.js 24 與 Docker Compose：

```sh
npm ci
npm run demo
```

開啟 <http://127.0.0.1:4310>。示範帳號為 `maker@local.test`、`reviewer@local.test`、`client@local.test`，共用示範密碼 `freedom-local-demo`。

操作方式、架構位置與重跑檢查見 [本機運行手冊](./docs/development/local-runtime.md)；筆電／手機入口見 [Staging＋Access 佈署清單](./docs/development/staging-access-deploy.md)；已完成範圍與驗證見 [模組版本紀錄](./docs/releases/2026-09-23-modules-preview.md)。舊版工作認領、交付驗收與合作流程保留。供貨與合作流程仍屬會員內部預覽，供貨回應屬演練，尚無正式結帳；示範收款紀錄不代表真實收入或銀行核實。

## 完整計畫與營運驗證

Freedom Platform 是社群的接點、共同資料庫、核心 codebase 協作索引、工作／商業事實帳本與狀態機。Discord 承接討論與讀書會，LINE 承接即時聯絡，GitHub 承接程式版本與 PR；money 的權威事實留在 Seller 的 provider／bank，客戶 raw data 留在 client／Squad storage，平台只保存必要的 ref、digest 與 fact。

現行推進：**2026-09-23，封閉式新人定位、主力公會、Repo 技能書與公開會員 Beta。** 完整架構保留，不把未來案源當報酬，不預設核心補位。第一筆真實合作與收款仍待真人證據，見 [首批營運驗證](./docs/development/operating-validation.md)。

先讀 [低維運互惠運作契約](./docs/platform-plan/12-low-ops-mutual-benefit.md) 與 [現況紀錄](./docs/platform-plan/09-handoff-record.md)。[2026-09-19 變更說明](./CHANGES-2026-09-19.md) 與當日 verification 保留作歷史紀錄；本次實跑結果以新版本紀錄為準。

第一次接觸專案，可先讀兩份白話敘事：

- [成員與 Agent 的一天](./docs/platform-plan/10-member-agent-narrative.md)：從真實求助、共同成果與合法重用，看見三種參與模式及實益如何形成。
- [管理者與 Agent 的一天](./docs/platform-plan/11-operator-agent-narrative.md)：從五人核心團隊、委派、A4、labels、事故處理與 Foundation Day 1，看見平台如何運作。

完整入口是 [`docs/platform-plan/README.md`](./docs/platform-plan/README.md)；現況、未建立事實與驗證方式見 [`docs/platform-plan/09-handoff-record.md`](./docs/platform-plan/09-handoff-record.md)。Foundation Day 1 依 `08 §13` 一次建立 O1／O2 與 production／staging 地基，之後依技術依賴推進階段 1A 契約凍結、1B 全形狀 skeleton、1C 真實 sandbox 接線與 2 垂直細節及發布成熟度。

規格涵蓋：

- 八個使用者模組、五個 operating cores，以及唯一 module seams。
- 縱向 Guild、橫向 Squad、Runner → Strategist → Master 與可交接 Officer。
- 五人核心團隊、AI review、成員 A4、Ted 三類 A4 與 evidence labels。
- 開源 Skill、商品 QC、AI 軟體商品化、專業服務與 Opportunity。
- 單一 Seller checkout、Supplier 承諾、seller-owned collection 與 bounded settlement。
- 56 packages、9 repos、12 runtimes／consumers、contracts、tests 與完整交付計畫。

文件中的 adopted／decided 只表示設計已納入現行 baseline，不表示功能已上線。Machine-readable contracts 在階段 1A 凍結，並於後續階段實作、取得驗證 evidence 後，才可能成為可發布的 production contract。

## 一起開發

會員可從「一起開發」找到專案缺少的角色，讀取 GitHub Issues、複製給 Agent 的任務說明，再由維護者審查 PR。詳見 [共創與貢獻紀錄](docs/development/co-creation.md)。示範 repo：[工坊 video-autopilot-kit](https://github.com/FreeTWAI-AI/video-autopilot-kit/issues)。

會員註冊只填一個 Email；登入信箱即聯絡信箱，公開範圍於名片多選設定。現有 15 個公會包含資安、音樂創作與 MV、廣告攝影與影片；公會長未任命時如實顯示待任命。
