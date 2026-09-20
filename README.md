# Freedom Platform

本 workspace 保存 Freedom 大平台的完整規格，以及 **0.1.0-local-core 本機可運行版本**。目前可跑通「登入 → 認領工作 → 提交 → 驗收 → 看見成果」，也可操作「作品曝光 → 商機 → 合作 → 外部收款回報及雙方確認」。資料存入 PostgreSQL，重啟後保留。

## 啟動本機版本

需要 Node.js 24 與 Docker Compose：

```sh
npm ci
npm run demo
```

開啟 <http://127.0.0.1:4310>。示範帳號為 `maker@local.test`、`reviewer@local.test`、`client@local.test`，共用示範密碼 `freedom-local-demo`。

操作方式、架構位置與重跑檢查見 [本機運行手冊](./docs/development/local-runtime.md)；已完成範圍、驗證結果與下一階段見 [版本紀錄](./docs/releases/2026-09-20-local-core.md)。這是本機開發版本，尚未對外部署；示範收款紀錄不代表真實收入或銀行核實。

## 完整計畫與營運驗證

Freedom Platform 是社群的接點、共同資料庫、核心 codebase 協作索引、工作／商業事實帳本與狀態機。Discord 承接討論與讀書會，LINE 承接即時聯絡，GitHub 承接程式版本與 PR；money 的權威事實留在 Seller 的 provider／bank，客戶 raw data 留在 client／Squad storage，平台只保存必要的 ref、digest 與 fact。

現行推進：**2026-09-20，可運行核心與兩條首批營運驗證路徑。** 真需求互助與作品／商機／合作／實收並行；完整架構保留，不把未來案源當報酬，不預設核心補位。第一筆真實合作與收款仍待真人證據，見 [首批營運驗證](./docs/development/operating-validation.md)。

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
