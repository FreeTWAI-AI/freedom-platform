# Freedom Platform 規劃與規格

本 workspace 保存 Freedom 大平台的現行產品、社群、組織、技術與交付規格。內容是可拆工的 canonical planning baseline，不代表帳號、repo、雲端資源、功能或 production 已建立、部署或上線；所有測試在實跑前均為「未跑」。

Freedom Platform 是社群的接點、共同資料庫、核心 codebase 協作索引、工作／商業事實帳本與狀態機。Discord 承接討論與讀書會，LINE 承接即時聯絡，GitHub 承接程式版本與 PR；money 的權威事實留在 Seller 的 provider／bank，客戶 raw data 留在 client／Squad storage，平台只保存必要的 ref、digest 與 fact。

本次修訂：**2026-09-19，低維運／共同成果／互助得利。** 首批只承諾一種真需求互助，完整架構保留；不把未來案源當報酬、不把delegate工時藏起來、不預設核心補位。

先讀 [低維運互惠運作契約](./docs/platform-plan/12-low-ops-mutual-benefit.md) 與 [本次變更及接手說明](./CHANGES-2026-09-19.md)。本地靜態檢查結果在 [verification](./docs/platform-plan/verification/2026-09-19-revision-check.md)；API、部署、真人試行仍未完成。

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
