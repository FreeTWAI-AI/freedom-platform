# 2026-09-24 商務、工作與管理頁稽核

> 這是各組執行當時的審查與分階段證據；最終合併、完整回歸與發布結果見 [整合總報告](./audit-2026-09-24.md)。
## 範圍與執行方式

本組負責 `supplier`、`retail`、`marketing`、`workbench`、`showcase`、`engagement`、`admin`、`guild-workspace`，另處理名片中的 ClientConnections。以 `8338a424a40ec959e9fc7e22ba77cce64192301e` 建立獨立 worktree；未部署、未推送，也未操作正式或 staging 會員。

稽核、程式與計畫修改實際使用本機 `claude -p --model claude-opus-5-5`，原生協調代理負責分工、差異審查、執行驗證及彙整本報告。完成的 editor、lock、plan、client、recovery、retry 六份 CLI JSON 都回報 `is_error: false`，`modelUsage` 含 `claude-opus-5-5`；證據位於 `/tmp/freedom-audit-operations-<工作名>-claude.json`。初始廣泛稽核 CLI 後來被協調代理中止，不將該次未完成的全套執行列為通過。

已讀 AGENTS、CONTRIBUTING、DESIGN、README。以下十份計畫完整閱讀，並比對 `/home/ted-h/projects/Freedom-Platform/docs/platform-plan` 的同名舊副本：

1. `03-domain-events-state-machines.md`
2. `04-module-specifications.md`
3. `06-delivery-plan.md`
4. `execution/acceptance-matrix.md`
5. `execution/first-work-batch.md`
6. `execution/milestones.md`
7. `execution/specs/FND-03.md`
8. `execution/specs/FND-04.md`
9. `execution/specs/FND-06.md`
10. `execution/specs/WRK-01.md`

舊副本缺少目前會員 beta 的部分實作與最新需求覆寫；以本次開發 repo 及使用者最新需求校正，沒有用舊副本覆蓋新決策，也沒有修改歷史 verification。

## 逐頁發現、修正與證據

嚴重度：高＝授權或資料正確性；中＝會阻斷、誤導或容易誤操作；低＝重複內容與版面。

| 頁面 | 嚴重度與發現 | 本次修正 | 桌面／手機與資料來源 |
| --- | --- | --- | --- |
| supplier | 中：供貨回覆預選接受，容易沒作決定就送出；非固定庫存仍顯示數量；低：重複導言。 | 回覆必須明確選擇；只在固定庫存時顯示必填數量；標題直接說明操作，更新中停用刷新。 | 1280×900、390×844 實際 browser。隔離 PG 完成商品刊登、銷售者選品、供貨請求及拒絕回覆；驗證未選回覆時沒有 POST。 |
| retail | 中：已有店家仍把新建表單置頂；空目錄缺少入口，停用選品沒有明確下一步。 | 已有商店時折疊新增表單；空目錄可前往供貨中心；提示先建立商店；未知狀態不顯示空白。 | 兩尺寸實際 browser；隔離 PG 驗證店家／商品／選品／精確供貨快照，跨帳號讀取保存後結果。 |
| marketing | 低：次要技能書介紹先於主要工作；內容來源存在空選項群。 | 建立草稿提前，技能書移到次要位置；隱藏空群組，保留簡短來源提示。 | 兩尺寸實際 browser，實際會員 API 的隔離測試資料；驗證表單順序、非空 optgroup。此輪沒有測外部社群發布。 |
| workbench | 中：分類文案與可認領項目不符；自己發布及缺職業身分時不清楚為何無法認領。 | 說清楚哪些列表可認領、自己的工作等待夥伴、缺少公會身分的下一步。 | 兩尺寸實際 browser；既有 journey 在隔離 PG 完成認領、開始、提交、指定審查者接受，重載及重新登入仍保留成果。 |
| showcase | 中：提出需求／合作後只叫人去另一頁，沒有入口；成果引用不容易理解。 | 依角色提示下一個動作者；提供合作紀錄連結；說明成果代號與檔案分享方式。 | 兩尺寸實際 browser；隔離 PG 由不同合成會員發布作品、提需求及提合作，按連結切頁。 |
| engagement | 中：空頁及等待中合作缺少可操作下一步，容易被誤認卡住。 | 空頁連到作品與需求；按角色及狀態說明等待同意、交付、接受或確認回報。保留平台不代收及不核實銀行入帳的界線。 | 兩尺寸實際 browser；隔離 PG 完成雙方合作、交付、接受、自行回報與確認；這不是實際付款或銀行驗證。 |
| admin | 中：缺失時間顯示 Invalid Date；低：手機導覽組名斷成兩行。 | 缺失／無效時間顯示「時間未記錄」；有效時間保留語意化 time；手機組名獨立一列，按鈕在下方換行。 | 兩尺寸的已驗證管理員 API fixtures，實際打開會員、公會、維護者、紀錄四頁籤；另以獨立 PG 及注入的測試身分驗證器完成任命、同步狀態、撤銷、恢復及公會長候選操作。未聯絡真實 Cloudflare。 |
| guild-workspace | 高：已任命維護者即使未入任一 AI 公會仍可編輯；退會／receipt replay 有繞過風險。中：失去公會資格後只有錯誤、首載失敗無重試；手機頁籤擠成多行。 | 編輯需指定任命且當前加入兩個 AI 公會之一，GET／保存／replay 一致檢查；同序鎖避免退會競態；保留草稿、停用保存、新分頁入會及重新核對；首載錯誤有重試；手機頁籤改 grid。 | 兩尺寸包含已任命缺公會、退會中編輯、重新核對失敗及恢復的 UI fixtures；另有真 PG 18 項 workspace runtime，涵蓋真實權限與三種 DB 競態。既有六項 browser 測公告版本衝突、結構化任務保存、議事回覆、任命／撤銷及延遲回應，並非只測空狀態。 |
| ClientConnections（附加） | 中：載入中或失敗時誤顯示無連線；查代碼錯誤也混成列表錯誤。 | 分離列表及查碼狀態、加重試、保留既有連線、只讓最新請求更新；縮短重複說明。 | 兩項 browser API fixtures 測 delayed loading→503→重試成功、查碼失敗仍保留列表，以及帶目前 version／CSRF 的撤銷並重新讀取。不宣稱這兩項證明外部客戶端整合。 |

所有七個會員頁在兩個尺寸檢查：一個 h1、欄位有 label、沒有水平溢出、沒有 pageerror。admin 另檢查各頁籤寬度及手機導覽按鈕尺寸。沒有把「沒有溢出」等同完整 WCAG 驗收。

## 公會與技能書權限的具體決策

詳見 [skill-editor-guild-access.md](skill-editor-guild-access.md)。共同資格 helper 供開發入口與編輯授權共用公會 keys。維護者任命和公會身分是兩個條件：

- 只有任命、只有 AI 公會身分，皆不能編輯。
- 兩個 AI 公會任一仍有效即可；離開最後一個後，GET、保存、相同 idempotency receipt replay 都拒絕。
- 重新加入只恢復當前仍有效任命的編輯資格，不復活被撤銷的開發 grant／key。
- 管理任命不替本人加入 AI 公會；一般 `skill.submit` 投稿範圍不縮減；公開讀取不變。
- `guildWorkspace()` 在公會／會長列鎖之前取得會員公會 advisory lock。DB barrier 測試曾以舊順序重現 `40P01`，修正後通過；另兩項保存／退會競態測試不使用 sleep 猜時間。

前端以 `ApiError.code === 'skill_editor_guild_required'` 識別可入會恢復的情況；任命撤銷的 403 不會錯誤地宣稱只需入會。回應 DTO 新欄位採 optional 以兼容較舊 UI fixtures。全站 Workspace 導覽同頁入退會更新由 root 負責整合，不在本組 App 修改範圍。

## 計畫對齊與真實缺口

本組計畫修正已單獨提交 `17bb0d5`：

- 區分已有會員 beta runtime 與完整 canonical 架構；移除目前沒有登入／session／runtime 的過時描述。
- 以最新新人必須完成定位覆寫舊的可跳過流程；保留歷史決策的時間脈絡。
- 校正 benefit-observation 的 POST／GET、尚未實作的 participation-terms API，以及只寫本地 outbox、尚未連接 canonical dispatch 的事件。
- 說明已存在的 static fixture tests；不將其誤稱為 runtime 或完整模組驗收。
- T27–T34 整體仍為「未跑」，列出 T27／28／31／32／34 的局部實作證據；milestone 與 package 不虛報完成。

仍需後续交付的原計畫項目包括 canonical ExternalIdentity／合併與復原、LINE／Discord 登入、credential broker／KMS／R2、站外備份、八種 canonical entitlement／ReviewerAppointment、完整多參與者工作與五時鐘／fencing、跨節點事件與真實付款驗證。詳情在上述十份已校正計畫；本次 UI 稽核不等同全部架構完成。

發現 GitHub 同一 `github_user_id` 可能綁多個平台會員，已交 root 實作唯一性／競態修復並同步 FND-03／04，不能以本組的 mock UI 測試宣稱修好。另已把共用開發入口的觸控尺寸、API machine code 外露與 README 舊數量交相應組整合；本組不覆蓋他組所有的全域樣式或導航。

## 實跑驗證與重現

1. `npm run typecheck`：通過（各次實際 Opus CLI 修改後執行）。
2. `npx tsx --test --test-concurrency=1 tests/runtime/guild-workspace.test.ts tests/runtime/guild-experts.test.ts tests/runtime/development-access.test.ts`：**43 passed，0 failed**（18 + 15 + 10），真實隔離 PostgreSQL。
3. `python3 -m pytest -q -p no:cacheprovider docs/platform-plan/contracts/tests docs/platform-plan/execution/tools/tests`：**628 passed，4 skipped**；`check_specs.py` 21 specs、`check_package_dag.py` 56 packages 通過。
4. 最新前端 `npm run build`：通過。
5. 以下七個 spec 的最終定向 Playwright：**32 passed，0 failed（38.8 秒）**，Chromium、1 worker、新建隔離 schema。所有新 browser 測試以 baseURL 工作，不把 4323 寫入正式 spec。

```sh
AUDIT_EVIDENCE_DIR=/tmp/freedom-audit-operations-evidence \
npx playwright test --config playwright.audit-operations.config.ts \
  tests/e2e/audit-operations.spec.ts \
  tests/e2e/skill-editor-guild-access.spec.ts \
  tests/e2e/client-connections-recovery.spec.ts \
  tests/e2e/guild-workspace.spec.ts \
  tests/e2e/commerce-modules.spec.ts \
  tests/e2e/journeys.spec.ts \
  tests/e2e/admin.spec.ts
```

為與其他工作組隔離，當次使用不提交的 config／server 副本，只把既有 4311 改為 4323；仍由既有 schema helper 建立／清理測試 schema。root 正式 harness 已新增 `FREEDOM_E2E_PORT`，整合後可用正式 config 重跑同一列表。

完整 stdout：`/tmp/freedom-audit-operations-targeted.log`。畫面證據在 `/tmp/freedom-audit-operations-evidence/`：

- `baseline-{page}-{desktop,mobile}.png`：七個會員頁修改前。
- `after-{page}-{desktop,mobile}.png`：七個會員頁最終版。
- `after-admin-{會員管理,公會管理,會長與維護者,操作紀錄}-{desktop,mobile}.png`。
- `after-admin-nav-groups-{desktop,mobile}.png`。
- `after-skill-editor-{guild-required,lost-guild}-{desktop,mobile}.png`。

上述檔案為此工作機的本次證據，沒有提交假截圖或產生中的結果。完整整合版的全站回歸、正式 GitHub／Cloudflare provider 流程與部署由 root 最後處理；本組不以定向 32 項冒充全站通過。
