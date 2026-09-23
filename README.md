# Freedom Platform

本 workspace 保存 Freedom 大平台的完整規格，以及 **0.3.0-member-beta 自由工坊會員入口**。新會員註冊後完成定位，選擇主力公會並取得 Repo 技能書，再進入供貨、商店、作品、行銷與小隊。會員名片有個別聯絡欄位的可見範圍。各模組共用中央會員與 PostgreSQL。

公開會員入口：<https://freetwai.com>；內部入口：<https://staging.freetwai.com>（Cloudflare Access 限定名單，獨立 DB）。本輪行為與邊界見 [會員入口設計](./docs/development/member-onboarding-release.md)，運行方式見 [公開站手冊](./docs/development/public-operations.md)。

各產品模板已依 [九倉分工與串接方式](./docs/development/repository-integration.md) 獨立保存，透過固定版本的 API／SDK 共用中央會員與資料。

## 啟動本機版本

需要 Node.js 24 與 Docker Compose：

```sh
npm ci
npm run demo
```

開啟 <http://127.0.0.1:4310>。示範帳號為 `maker@local.test`、`reviewer@local.test`、`client@local.test`，共用示範密碼 `freedom-local-demo`。

操作方式、架構位置與重跑檢查見 [本機運行手冊](./docs/development/local-runtime.md)；筆電／手機入口見 [Staging＋Access 佈署清單](./docs/development/staging-access-deploy.md)；已完成範圍與驗證見 [模組版本紀錄](./docs/releases/2026-09-23-modules-preview.md)。舊版工作認領、交付驗收與合作流程保留。這是內部預覽，供貨回應屬演練，尚無正式結帳；示範收款紀錄不代表真實收入或銀行核實。

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
