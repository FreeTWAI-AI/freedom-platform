# 0.5.0 社群協作優化

原本技能書介紹過於籠統、各頁缺少直接的開發路線，單獨接手一個 Repo 的人也難以看懂整體分工。本版讓每本書先說清用途與第一個成果，再帶到正確來源；各頁提供預設收起的開發入口，28 個 Repo 都有獨立的用途、規範與協作說明。

## 使用者可見變更

- 統一名稱「公會技能庫」，維持主力／次要公會排序與書籍歸屬。
- 22 本技能書逐本補上內容、適用對象、準備、步驟、成果、來源 commit、授權狀態與貢獻入口。介紹頁保留手機收合與可固定操作的關閉鈕。
- 19 個頁面與技能書都有無須 JavaScript 的 HTML／Markdown；`/llms.txt` 和 `/api/v1/development-map` 讓 Agent 找到目標 Repo、程式路徑與測試。
- 原計畫缺少的本人實益回報已補上：工作開始後，雙方可各自選填，展開才讀取，私人敘述不互相公開。未知、沒有回報與沒有收穫分開，並保留追加修正紀錄；不影響成果驗收、資格或款項。
- 新工作不再產生 `local-demo-author-consent` 示範授權值。新條款明列未記錄授權、仍需權利人同意；既有 Work／Claim 的條款 bytes 與 hash 不回寫。

## 協作與原計畫

28 倉新增或強化共 84 份 README／AGENTS／CONTRIBUTING，保留上游原文及授權。27 個周邊 docs commits 已先推送，中央九個來源 pins 隨本版更新。新開啟 9 個 fork 的 Issues，加上原本已開啟的 2 個 fork，11 個上游工具 fork 都可在自己的 Issue／PR 協作。這些 fork 的 Actions 維持原設定；不宣稱上游媒體／桌面程式因此已跑過或已部署。

[原計畫對照矩陣](../development/plan-drift-2026-09-23.md) 區分後來的明確產品決策、已交付功能與真正缺口。保留強制新人定位、能力與裝備可略過、名片最多三項精選能力及既有直覺流程。未以新驗證表、工時或積分變成入會門檻。

後續仍包含小隊共同目標與結案、工作放棄／回饋改派、一般帳號恢復、外部通知及完整雲端執行拓撲。本版沒有把書籍、fork 或自報數量當作這些功能已完成。

獨立審查實際執行：Claude Code `opus` 回應 `claude-opus-5-5`；Codex CLI `gpt-6-sol`；Grok CLI 請求 `grok-4.7`，回應使用紀錄為 `grok-4.7-build`。採納並核實的修正包含 vendor 分工、來源／工坊貢獻路徑、不同工具的成熟度、中文標點造成的錯誤 Repo 網址，以及瀏覽器測試前需要先 build。

遠端第一輪 browser CI 額外抓到保存回報時狀態提示選擇不夠明確，以及長版本碼在不同手機字型下超寬。本輪修正測試定位、獨立工作卡範圍與文字換行，並加入 320px／390px 檢查；不能只憑原本本機綠燈發布。

## 驗證與部署

整合 checkout：TypeScript、production build、140 runtime、20 browser、5 跨倉測試通過；Python 契約／工具測試 628 passed、4 skipped。九個周邊 client／template 的 Verify 和 CodeQL 共 18 個 workflow 通過。核心 CI、實際部署 SHA 與 HTTPS 驗證以該次 GitHub run／deployment 狀態為準。

新增 migration `015_benefit_observations.sql`，只增加回報表與索引。部署先備份、staging 驗證，再更新 public；不重設資料或重新 seed 正式環境。歷史回報、會員、公會及任命保持原有資料。正式站驗證只建立有清楚標記的合成會員，完成後撤銷其 session 並停用該精確帳號。

管理員的真人 OTP 與本人帳號連結仍由當事人操作；測試簽章和機器 staging Access 測試不能代替這個步驟。完整功能範圍見 [開發導覽](../development/agent-development-guide.md) 與 [實益回報](../development/benefit-observations.md)。
