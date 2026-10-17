# 供應商營運中心（Supplier Console）

把現在的供貨商品庫長頁改成完整的私人供應事業工作台。依據是《Freedom Supplier Console 供應商營運中心產品重構計畫 v1.0》（來源檔與雜湊見 [sources.md](sources.md)），程式基準為 `efaf314d`。

2026-10-15 收到 v1.1 物流、履約與售後補充（隨 Commerce 規劃包）：原 R1 範圍與編號不變、照原計畫交付；新增的 SC-L01～18／SC-LAT01～24 屬 Commerce C2，頁面規格見 [SC-SPEC-07](SC-SPEC-07-fulfilment.md)，領域與資料由 Commerce 的 EC-SPEC03／05／06 負責。

本目錄是規格與工作切分，不是進度系統：整體進度沿用 [#234](https://github.com/FreeTWAI/freedom-platform/issues/234)，實作與驗收結果以 PR、commit 與測試證據為準；發布與驗收的現況見 [WP-07](WP-07-release-evidence.md)，沒有實跑的驗收保持 `not_run`。

## 文件

| 文件 | 內容 |
| --- | --- |
| [WP-00-baseline.md](WP-00-baseline.md) | 現況、可重用的 API 與畫面、缺口 G-01～G-14、角色對照 |
| [sources.md](sources.md) | 來源雜湊、盤點方法、Agent 盤點的更正紀錄 |
| [refferq-adoption.md](refferq-adoption.md) | 從 Refferq 借用與不借用的部分 |
| [pages.md](pages.md) | SC-01～12 每頁的操作、資料、權限與缺口 |
| [SC-SPEC-01](SC-SPEC-01-ia-visual.md) | 資訊架構、路由、版面、狀態語言、可存取性、視覺驗收 |
| [SC-SPEC-02](SC-SPEC-02-shell-session-recovery.md) | 殼層、身分、controller、操作恢復、412 草稿、離開保護 |
| [SC-SPEC-03](SC-SPEC-03-commerce-reads-writes.md) | 新讀取、`PATCH supply-profile`、純供貨照片、沿用的命令 |
| [SC-SPEC-04](SC-SPEC-04-materials-settings-reports.md) | 設定、合作素材、營運報表、資料責任 |
| [SC-SPEC-05](SC-SPEC-05-tests-ci-guild-dev.md) | 測試層級、沿用測試、效能、CI、公會開發 |
| [SC-SPEC-06](SC-SPEC-06-release-rollback-pilot.md) | 功能設定、資料相容、發布順序、回退、試用、舊頁退場 |
| [WP-07](WP-07-release-evidence.md) | 固定候選、合成供應商驗收腳本、回退證據清單與未執行項 |
| [SC-SPEC-07](SC-SPEC-07-fulfilment.md) | v1.1 補充：履約與寄件設定、出貨工作台、包裹、例外與退回、費用（SL-01～05，Commerce C2） |
| [work-plan.md](work-plan.md) | 工作包、批次、分工、共用檔案、依賴、決策 D-01～D-14 |
| [first-journey.md](first-journey.md) | 第一條供貨旅程（S1）與測試計畫 |

公開契約：`contracts/guild-launchpad/v1/supplier-console.ts`。

## 界線

- 這份計畫與這些文件不授予合併、部署、修改正式資料、付款、寄信或聯絡會員的權限。
- 沿用既有 tenant／instance、商品、offer、selection、order、hold、Asset 與共同 command，不建第二份權威。
- 公會身分不授予任何私人資料；公會區塊維持入口與有限讀取。
- `cost_minor` 是供貨單價，不是製造成本；預留不是成交；供貨價差不是佣金；讀取失敗不顯示成 0。
- 結果不明的操作沿用原 key、內容與版本恢復；登入或事業切換後，舊操作不能借用新身分。
