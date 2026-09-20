# 0.1.0-local-core — 本機工作與合作流程

日期：2026-09-20。這次交付把規格接成能實際操作、重新啟動後保留資料的會員工作台。完整 56 packages／9 repos／12 runtimes 的架構保留；此版本是其中的本機垂直流程，尚未完成整套架構或 production readiness。

## 已完成

- 示範帳密登入、持久 session、登出撤銷；React Portal、Hono API、真實 PostgreSQL migration／seed。
- 發布有限自願工作 → 閱讀條款 → 原子認領 → 開始 → 提交 → 指定需求者驗收／要求補件 → 重提 → 成果紀錄。認領鎖定原條款，驗收接受 exact submission digest；成果持久保存。
- 本人同意展示作品 → 另一成員提出商機 → 提供者報價 → 需求者同意 exact terms → 交付／驗收 → 外部收款回報 → 對方確認。合作內容只向雙方顯示；作品限同社群展示。
- 同一 transaction 保存 aggregate、不可覆寫的提交／決定、Contribution、transition journal、outbox 與 idempotency receipt；重試檢查當下身分與權限。並發認領只成功一次；故障回滾不留下半套驗收結果。
- FW-12 typed retract success body／ETag／412 已合入 OpenAPI，舊 proposal 改記 applied；FW-11 stage-1A README 與已存在的 schema／fixtures 對齊。其餘現有契約納入重跑，未宣稱所有對應 runtime 完成。
- Jason 的定位／陪跑／training 供給角色、Hao 的行銷／社群角色已恢復一致。依 Mini／Hao 回饋，有限互助與作品／商機／合作／實收列為平行首批驗證；找客戶不必先完成十次免費互助。
- 提供鎖版依賴、固定 PostgreSQL image digest、GitHub Actions 與當版檔案 inventory。舊 verification 與原交接筆記保留，不以舊雜湊證明新內容。

## 實跑證據

以下由本次接手者在 continuation checkout 實際執行，並非沿用先前 session 的綠燈：

| 檢查 | 結果 | 範圍 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | API、Portal、DB、測試 TypeScript |
| `npm run build` | exit 0 | Vite Portal 靜態建置 |
| `npm ci`、`npm run demo` | 安裝及啟動成功 | migration／seed 可重跑；health、Portal、JS／CSS assets 均 HTTP 200 |
| `npm test` | **16 passed，0 failed** | 真實 PostgreSQL；兩條流程、並發、權限／撤銷、session／CSRF／Origin、重播、故障回滾、跨社群、金額／日期、canonical claim 與參與條款 schema |
| `npm run test:e2e` | **4 passed，0 failed** | Chromium；完整工作、完整合作／收款回報、localhost 登入、390px 手機、重載／重新登入、錯誤密碼、API 中斷、登出 |
| `npm run test:contracts` | **591 passed，4 skipped，0 failed** | 現有契約／fixtures 與 execution tools；四項 skip 為五種時間 catalog 不足三個 schema paths 的不適用參數組合 |
| `npm run verify:inventory` | **224 個檔案雜湊、166 個本地連結、0 failures** | 當版來源與 Markdown 相對檔案連結；不是簽章／正式 release attestation |

本機 Chromium 初次因系統 `/tmp` 配額耗盡失敗，改用有空間的 `TMPDIR` 後完整重跑通過；沒有把失敗計為通過。測試用獨立暫存 PostgreSQL schema，不覆寫示範工作。CI 以新的 PostgreSQL service 重跑同一組命令，遠端執行狀態以 GitHub Actions 的實際紀錄為準。

Grok 4.6 協助 Portal、契約與文件，並做一次只讀程式審查。審查提出 localhost Origin 不一致，接手者已修正並加入 API／瀏覽器回歸測試；另修正工作建立的逾期重播與參與條款文字長度。未宣稱具名真人 reviewer、Claude verification、A4 或正式 QC 已通過。

## 明確範圍

本機帳號是虛構角色，不是驗證過的自然人。工作驗收只產生 `official=false` 的 Contribution；不產生 XP、rank、QC entitlement、付款或正式認證。

收款僅記 `self_reported`／`counterparty_confirmed`，且只支援一次全額、同幣別。沒有 provider／bank 核實、退款、分期、分潤結算、平台代收或 money movement。真實成交與實收案例仍未知，不能把本機示範計入業績。

`apps/platform-api` 使用 loopback Node adapter，未部署 Cloudflare Worker。新工作目前限本人發布、exclusive user claim、自願貢獻；沒有 team／squad claim、檔案上傳、工作放棄／重開、review route 改派、通知、跨 Work／Coaching 容量保留或到期背景排程。認領後不因邀請到期刪除責任。一般工作驗收安排不是商品 QC 的 ReviewerAppointment。

認領 API 與現有 OpenAPI 的 request／response 相容子集有實測；其他新 endpoint 是本機應用 API，未宣稱完整 production ServiceEngagement／SOW／A4 契約。Journal／outbox 已持久保存，尚未提供正式事件 dispatcher。尚無 OIDC／OAuth、Agent grant／lease／fence、broker／signer、正式 signed release 或可執行 Skill overlay。

## 可接續的下一刀

1. 依本機實作整理 typed API 邊界／adapter，補工作放棄與驗收改派，避免長期停留在待驗收狀態；接真實 identity 之前補帳號建立、membership 與角色生命週期。
2. 推進 FW-13～FW-15：當事人實益回報、跨 Work／Coaching 容量與可核實營運觀察；不擴張無人承諾的服務。
3. 補正式 runtime／queue／broker／signer 地基與 staging，逐項對照既有 56-package acceptance；不能用此本機版本勾掉 Infrastructure Ready、完整 1B、T01–T34 或真人 UAT。
4. 依[首批營運驗證](../development/operating-validation.md)取得第一筆可追溯的社群合作及外部實收證據；證據只能由真實當事人與外部收款來源產生。

啟動及復原見[本機運行手冊](../development/local-runtime.md)。
