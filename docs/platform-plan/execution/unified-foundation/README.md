# 自由工坊共同基礎開發規格

這組 spec 將 [Unified Foundation 1.1 計畫](../../../plans/unified-foundation.md) 轉成可分批開發、審查及驗收的工作。結論是可以依此計畫開發；先交付固定契約與開工工具、相容的身分及交易核心，再完成「會員換頭像」與「本人私人 AI 草稿」兩條完整流程。

版本：`0.2-draft`；查核日期：2026-10-02。已讀完 Unified Foundation 1.1、R2 及 Autopilot 原文並完成規格對照；沒有新增產品實作或產品測試證據。中央程式查核基準為 `3de70ccbd24362a7925508fb42d36aaa256a0806`。

## 文件與開工順序

| 文件 | 對應計畫 | 開工狀態 |
| --- | --- | --- |
| [現況與過渡決策](00-baseline-and-decisions.md) | U0、CG-A、UF-09、UF-12 | 三份原文已齊；記錄來源優先序、衝突修訂及剩餘實機證據 |
| [契約發布與開發治理](01-contracts-and-governance.md) | CG-A/B/C/D/F，CG-E/G 的開發工具部分，UX | 可先實作本機 schema、相容 verifier、context 與反例；發布信任及 GitHub 強制需操作證據 |
| [身分範圍與交易核心](02-principal-command.md) | U1、UF-01/02/06 | 可先做 legacy 回歸與相容核心；機器入口待 execution/service 驗證器接妥才開放 |
| [資產與私人工作](03-assets-private-work.md) | U2、U4、UF-03/04/10 | 依 U1 介面實作；私人寫入須等讀取矩陣通過 |
| [執行端與發布收尾](04-execution-adapters-release.md) | U3/U5/U6/U7、UX、CG-G | 共用 attempt、broker、queue、migration 及恢復邊界 |
| [七類媒體搬遷](05-media-migration.md) | R2 RS-00–06/10/11、U6/U7 | 完整搬遷程序；正式資料盤點與 cloud/restore 實測另做 |
| [Autopilot API 與瀏覽器](06-browser-runtime.md) | AP M0–M6/T0–T5、U3/U5 | API/auth、MV3/native/neo guard、journal；實際 source audit 與 capability 另做 |
| [共同基礎驗收](acceptance.md) | INT-01–28、GOV-01–32 | 60 項原要求，全部 `not_run` |
| [R2/AP 原始驗收](source-acceptance.md) | R2 S/A/M/D、AP AUTH/WORK/EXT/NEO/OPS | 108 項原要求，加 24 條 guardrails/invariants 對照，全部未驗收 |

原有 [execution spec index](../spec-index.md) 的 FND、BLD、WRK、AGT packages 繼續保留。本組為增量規格，不將 2026-09 的歷史 planning 列改成 implemented。`UF:INT-01` 表示統一計畫的 INT 驗收，避免與既有 `INT-01` LINE integration package 混淆；原始需求 ID 不重新編號。

來源優先序：Ted 的當次安全/操作限制 → 本輪明列的相容修訂 → Unified Foundation **1.1** 的整合決策 → R2/AP 詳細設計。1.0 unified Markdown/HTML 是舊版，不覆蓋 1.1；AP Markdown/HTML 是同份設計的不同格式。原文快照只作可追溯參考，修訂集中在本組 spec，不平行維護三套政策。

## 首批交付

第一批為三個可分別審查的 PR 範圍，實際 PR 尚未建立：

1. **契約及治理資料**：新增 ReleaseSet、module descriptor、context/report schema 與合成反例，保留 preview v1 的 bytes 及取用方式。先完成本機驗證；沒有可信發布證据時回報 unavailable。
2. **開工與檢查工具**：中央共用 `prepare/context/verify`、baseline 與 candidate 的影響聯集、legacy surface 清單，以及 platform、Agent Kit、storefront 三倉的固定版本測試。
3. **相容交易核心**：保留既有 `command()` 介面、digest、receipt、鎖順序及驗權時機，加入 neutral ports 與 principal/scope 映射，先驗真人會員流程。

可信 CI 的實作與 GitHub 設定跟第一批銜接；它是治理完成條件。上述 PR 不能因尚未完成強制機制就自称已有抗繞過保護。

接著交付 Asset 頭像與 private Work ACL，再把 RunAttempt／一條明確模型路徑接進私人草稿。完整共同基礎的完成條件同時包含 A 頭像、B 私人 AI 草稿及治理反例；第一批完成不能取代這三類證據。

## 開發與交付規則

Ted 在規格完成後已明確授權由目前 agent 直接實作並持續推進，不再要求所有產品程式交給 grok 4.7；需要外援時可把範圍清楚的小工作交給 grok 4.7。派工仍須提供固定 source SHA、此組 spec、可改檔案、預期反例及隔離測試方式。此授權不自動包含推送、合併、部署、正式設定或公告。

工作限於 `~/tmp-scratch/fp_work/` 的獨立 worktree。主 checkout 及其 staged 刪除保留。所有 DB 測試只使用本輪建立、名稱以 `fp_` 開頭的 schema 或資料庫；禁止對 `freedom_local.public` 執行 migration、seed 或 truncate。

每個實作 PR 附來源需求、前後行為、實際 SHA、相依 PR、已跑及 `not_run` 項目。合計 168 項原始驗收保留來源命名空間；schema／mock 通過、本機 runtime 通過、真實 GitHub 強制、staging/provider、packaged client、production 的證據分開記錄。缺少 AP 舊附件 ZIP 不妨礙建立正式中央 schema/vectors，但不能引用原作者的樣本 PASS 當本輪證據。

目前仍需每次 push 前重產 inventory 並執行 `npm run verify:inventory`。本機文件產出不等於授權推送、合併、設定 ruleset、簽發 release、部署或發布 Discord 公告。
