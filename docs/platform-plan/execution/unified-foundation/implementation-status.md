# 共同基礎：本機交付紀錄

查核日期：2026-10-03。本紀錄區分原始產品要求、本機實作、合成測試及尚缺的真實部署證據；不修改原計畫的歷史內容，也不把組件測試轉寫成完整產品 PASS。

最新交付方向依 Ted 指示：完成原計畫 scope 後受控前向 migration，不為提早上線另做多套過渡 release，也不以退回舊應用為交付目標。小批次只是開發／測試的切分，不是分批部署承諾。原計畫的資料保護、撤銷、失敗停機及備份恢復仍保留；staging 驗證先於 live，備份政策另確認。完整決策集中於 [基準與決策](00-baseline-and-decisions.md#本輪發布方向)，不另建一套政策。

## 工程進度估算

以原計畫 U0–U7／UX 及治理工作包的全部工作量估算，目前約四成，合理區間 **35–50%**，約 **50–65%** 尚待完成。這是排程用的主觀區間，不是驗收率、部署率，也不是用測試或檔案數計算。配對、refresh／nonce、封閉 bootstrap／會員 HTTP 已有本機實作；單步模型的明確出口批准、active Attempt／running Run／lease、一次性派送、Asset 與私人 Result，現已接到本人會員 HTTP 及「私人工作與 AI」畫面，完成本機工作建立／編輯、成果歷史、逐次同意與控制流程。模型端仍只以合成 HTTP 實測；正式隔離 broker/vault、外部 recovery、本人 provider 認證與 runtime 驗收尚缺。跨端、七類媒體、legacy 退出與正式治理仍占主要剩餘工作。另一個 65–80% 僅指已選定的 member/scope/command、Asset、人工私人 Work/Result 及本機治理組件，不能稱作全部底層架構完成率。

以下權重是工程量假設，不是原計畫承諾；估算依本頁實作證據與尚缺項目，正式產品驗收仍須逐項取得證據。

| 原里程碑 | 工程量權重 | 本機實作估算 | 主要剩餘工作 |
| --- | --- | --- | --- |
| U0 規格與共用契約 | 5% | 80–90% | 正式批准與版本發布 |
| U1 身分／scope／command | 10% | 70–85% | machine/service Invocation／Grant 的當前驗權與 command adapter；會員映射與受限 machine 登入已有實作 |
| U2 Asset 與私人 ACL | 15% | 65–80% | 完整讀面、正式政策及接線 |
| U3 執行狀態與模型 ports | 15% | 45–60% | 單步 BYOK、active Attempt／Run／lease、本人 HTTP、暫停／停止與 once-only dispatch 已有本機證據；尚缺隔離 broker/vault、外部 recovery、真人模型認證、machine execution auth、訂閱 native CLI、heartbeat/reconcile、多步及 Action |
| U4 兩條垂直流程 | 15% | 45–60% | 頭像回歸及私人 AI 草稿的本人 HTTP／畫面、SQL、Asset 與 Result 已有本機流程；尚缺真正 provider／R2／本人 runtime 及跨端產品驗收 |
| U5 browser／Kit／broker | 15% | 0–10% | 實際 runtime 接線與封裝驗證 |
| U6 媒體搬遷與 restore | 10% | 5–15% | 真實盤點、七類媒體搬遷與還原 |
| U7 legacy 退出 | 5% | 0–5% | 資料遷移、最低安全版本與舊路徑退出 |
| UX affected CI／開發工具 | 5% | 20–35% | 跨語言／跨端覆蓋與工具接線 |
| CG 共同治理 | 5% | 25–45% | 可信 runner/publisher、完整入口與 rollout |

此組權重得 **37–50.25%**，對外取粗略區間 **35–50%**。R2、AP 與 UF 有重疊，不能把三份計畫各自的完成百分比相加。剩餘 50–65% 是工程量估算，不是日曆工期；真實 provider、跨端及搬遷演練仍有不確定性。U4 的調整只計入完成的本機會員流程；原文仍要求實際 CLI/BYOK、R2 與跨端驗收。本輪只推進共同基礎；依 Ted 指示，不整合等待中的其他 PR。備份政策仍另確認。

若「Milestone」指 [AP M0–M6](../../../plans/autopilot-vnext.md#54-遷移步驟)，目前位置是 **M1 基礎已建立、M2 的配對／refresh／nonce／status 完成本機接線，M3 的單步私人 AI 草稿已接會員 HTTP／畫面；M2/M3 的本人模型、runtime 及部署驗收仍未完成**。以下仍只估本機工程，不宣稱已達原文的部署／產品完成條件。

| AP Milestone | 本機工程估算 | 仍缺的完成條件 |
| --- | --- | --- |
| M0 來源與需求 | 80–90% | 正式 protocol／consumer 版本發布與確認 |
| M1 資料與 ACL | 60–75% | 完整 list/detail/search/event/export 讀面矩陣及遷移驗收 |
| M2 認證與只讀觀測 | 50–65% | ModelConnection settings UI／真正模型驗證、本人確認 UI、bootstrap-key exchange、正式 key/host 設定及部署驗收；device pairing／refresh／nonce／status 與 HTTP factory 已有本機證據 |
| M3 私人 AI 草稿 | 50–65% | 本人 HTTP／畫面、出口批准、operational Attempt／lease、一次性派送、typed AI Result 與人工共同歷史已有本機完整流程；尚缺隔離 broker/vault、外部 recovery／本人 BYOK 驗收、訂閱 native CLI 與 runtime 整合 |
| M4 瀏覽器交接 | 0–10% | extension／neo 實接、pause/takeover/resume/revoke、舊 epoch 拒絕及 unknown effect 對帳 |
| M5 業務 actions | 0–5% | 逐 domain 授權、精確 effect、A4 的本人簽章／step-up |
| M6 設計收斂與相容期 | 5–15% | consumer 相容矩陣、schema 收斂、舊路徑退出及正式版本驗證 |

R2 重構已有 ObjectStore／Asset lifecycle、頭像、私人 Result、本機相容性診斷與治理工具；RS-05 多媒體 adapters、RS-06 真實 backfill/verify/restore、RS-10/11 正式 cutover／legacy 退出仍大多待做。前端責任拆分、可信 CI／publisher 及跨平台封裝也未完成。原始 **168 項完整產品驗收仍是 `not_run`**；本機工程已有部分證據，不能據此將整列標成 PASS，也不能用 0/168 反推工程完全沒開始。

## 本機提交與範圍

| 批次 | 本機 commit／位置 | 交付內容 |
| --- | --- | --- |
| 規格 | `e939e2c` | 三份來源快照、七份分工規格、168 項來源驗收及 guardrail 對照 |
| GOV-A | `2c8da89` | ReleaseSet／pin／proof／trust schemas、本機 verifier、preview v1 相容與中央工具 export |
| GOV-B | `5b98bca` | prepare/context/verify、baseline/candidate 影響聯集、module descriptors、版本及 worktree context、三個合成 consumer |
| CORE-0 | `2a40d8f` | neutral command orchestration、相容 member adapter、legacy transaction/digest 抽取、16 項真實 PostgreSQL 回歸 |
| CORE-1 | `5c9afcd` | common identity refs、person/community/personal 映射、受約束 migration、會員 scope context、可重跑分批回填及 27 項新增 runtime 回歸 |
| GOV-C 本機邊界 | `0963bee` | host-owned Git candidate／policy／observation binding、baseline fallback 與 vendor exact-byte 驗證；尚非可信 CI |
| ASSET-A I/O 首段 | `ded9c98`、修正 `5e23d91` | bounded bytes/profile、immutable object port／fake store、digest read-back 與安全錯誤；尚無 DB lifecycle／R2 接線 |
| WORK-A | `c3eae47` | migration 077、私人 owner/scope FK、社群投影與 mutation 隔離、本人私人 list/detail、18 項新增 runtime 回歸 |
| CORE-2 | `40e0f2d`、`4a74b31`、`6f3485f`、`4ea8f47` | migration 078、獨立 scoped member receipts/facts、bounded JSON、當前權限及 DB-clock expiry；28 項新增 runtime 回歸 |
| ASSET-A lifecycle 增量 | `769840a`、`6da6b89`、`bdd05c4`、`0371c19`、`360fc30` | migration 079、封閉頭像 intent/lease/fence/write/finalize、真實 avatar version CAS；14 項 lifecycle 與 23 項獨立 race tests |

目前整合分支為 `feat/foundation-release-20261002`，worktree 同名，從前批 `foundation-lifecycle-20261002` 的 `0f93e1f` 延續；各批次另保留在各自 worktree。全部只在 `~/tmp-scratch/fp_work/` 工作，未 push、建立 PR、merge main 或部署。主 checkout 及其 staged 刪除未更動。下文各批次數字與限制保留當時脈絡，以最新批次說明目前增量。

## GOV-A/B 與 CORE-0 證據

- GOV-A 初版 88 項 Node tests；GOV-B 增量後 106 項，沒有跳過。包括篡改 vendor/lock/簽章、錯誤 purpose/key、缺少可信來源、空／跳過／偽造測試輸出、刪除規則、跨 worktree 與三個獨立合成 consumer。
- 既有契約測試 659 passed、4 skipped；跳過是原有 five-clock 案例不足三個 schema paths。不是新產品驗收通過。
- Preview build 仍為 32 operations／9 artifacts；重產後 `contracts/preview/v1` 與 `packages/sdk` 無差異。
- 交易核心最初 14 項測試在抽取前後均通過；抽取後連同 flows、avatar、access-session 為 56 passed。之後補上 journal／outbox insert 失敗回滾反例。
- 最終完整 `npm test`：898 passed、0 failed、0 skipped，包含上述 16 項 command-core 測試；約 193 秒。`npm run test:worker`：20 passed、0 failed、0 skipped。
- 型別檢查、前端 build、platform／admin-sync／maintainer 的各環境 Worker dry-run 均通過。Build 有既有大型 chunk 警告，未因此改動 UI 或拆包。
- Skill client suite 10 passed。Governance suite 在 CORE-0 worktree 再跑仍為 106 passed。
- Inventory：1,121 個檔案 hash、604 個本機文件／目錄連結，0 failures；`git diff --check` 通過。

失敗及重跑：第一次完整 runtime 執行的測試容器因 512 MB tmpfs 被 WAL 填滿而中斷，後續連線失敗；這次不算通過。重建為 2 GB 上限及較小 WAL/checkpoint 設定後，从頭執行取得 898 passed。Worker 初跑未指定測試連線，之後另遇缺少 admin-sync／maintainer dry-run bundle；補齊隔離連線及全部 bundle 後，从頭執行取得 20 passed。未修改產品程式來略過這些失敗。

資料庫證據來自本輪新建的 PostgreSQL 18.6 容器，image digest 與 repo CI 固定版本相同。容器使用 `network=none`、無 published port、tmpfs 資料及專屬 Unix socket。Runtime 測試取得新建 `fp_foundation` 連線，並各自建立／清理 `fp_*` schema。Worker 的 Hyperdrive 測試另用暫時的 localhost 隨機 port proxy 接到同一 Unix socket，各自建立／清理 `fp_*` 資料庫，測試結束即關閉 proxy。未讀取正式環境憑證或使用 Ted 的資料。

收尾已確認測試 schema／子資料庫全部清理，再停止並移除本輪容器及 socket 目錄；只刪除可由測試重建的合成資料，沒有保留長駐資料庫服務。

## CORE-1 證據與邊界

- `contracts/common/v1/identity.ts` 同源產生 Zod validators、TS types 和兩份 JSON Schema。`check:common-contracts` 驗 exact bytes；runtime 測試另以 Python Draft 2020-12 validator 驗正反例。service/site 只保留 wire kind，DB 和 runtime 仍拒絕啟用。尚未加入公開 ReleaseSet、Rust vectors 或真實 consumer。
- 暫用 migration 076 新增 `principals`／`resource_scopes`，以 FK、CHECK、UNIQUE 及 immutable triggers 限制映射；一般 DML 無法改綁或刪除後重建，status 可明確停用。community 不虛構 owner。migration 不自動回填、不改任何舊表。`environments.json` 的 last 同步為 76、known_gaps 保持 `[22]`；合併前仍需重新確認最小可用編號。
- `withMemberScope` 共用舊會員的 user/session 驗證，新增 principal/scope 當前檢查，之後仍強制 domain authorize。同一交易及鎖順序見 [package README](../../../../packages/resource-scopes/README.md)。它不是 command/receipt/Grant，不能取代 idempotency、version、journal/outbox；舊 route 未接入此 helper。
- `backfillLegacyScopeBatch` 每批最多 500 筆，community/user 分階段交易、`SKIP LOCKED`、timeout、失敗整批 rollback。包含 inactive users，但不產生 session 或權限、不重啟 disabled rows；並行 first-use、並行 backfill、失敗重跑均有實際 PostgreSQL 測試。未建立正式 backfill CLI 或排程。
- 新增 27 項 runtime 測試，含 075 升級前後所有既有表 hash 與原 ledger 不變、舊 receipt replay、真實 row-lock 撤銷競態、非 superuser migrator 及 DML-only runtime。這些是合成會員／測試角色，不是正式 grants-check 或完整私人工作 ACL。
- 完整 `npm test`：925 passed、0 failed、0 skipped，約 193 秒；`test:worker`：20 passed、0 failed、0 skipped。
- 型別檢查、前端 build、三類 Worker 的所有環境 dry-run、common schema check 通過。Preview 重產仍為 32 operations／9 artifacts，preview/SDK 沒有 diff。
- 治理 106 passed、skill client 10 passed、部署前檢查 37 passed，均無 skip。既有契約 659 passed、4 個原有 clock cases skipped。本批沒有執行跨 repo 真實 consumer integration 或瀏覽器 E2E。
- 本批發現 CORE-0 的 deploy preflight 靜態測試還在 `packages/db/index.ts` 找 digest 函式本體，先重現失敗，再改驗 re-export 與 `legacy-digest.ts` 的原始 encoder；未改 digest 邏輯。修正後 37 項部署前測試全數通過。
- 以真正 `origin/main` 執行 `prepare`／`verify`：新 descriptor 與參照有效，governance tests 有執行；總結果仍是 exit 2 `unavailable`。原因包含 baseline 缺治理、未登錄 surface、runtime suite adapter 尚缺。沒有改 base 或把手動 runtime 結果當可信檢查。
- Inventory：1,132 個檔案 hash、619 個本機文件／目錄連結，0 failures；`git diff --check` 通過。

本批另建一個 PostgreSQL 18.6 disposable 容器，沿用上述 image digest、network none、2 GB tmpfs、專用 Unix socket／短期 Worker localhost proxy。全部測試只寫合成 `fp_*` schema/db；結束後查到測試 schema 和 role 都是 0、只剩容器本身的 `fp_foundation`，再清理容器/socket，沒有正式資料或長駐測試服務。遠端 main 收尾查核仍為 `3de70ccbd24362a7925508fb42d36aaa256a0806`。

## 平行批次：GOV-C 邊界、ASSET I/O 與 WORK-A

依 Ted 本輪授權，三隻 GPT-6 Astra 在獨立 worktree 分別實作治理、Asset I/O、私人 Work；另以 Grok CLI 的 `grok-4.7` 執行兩路反例審查，以 agy CLI 的 `claude-opus-4-6-thinking` 執行兩路唯讀 schema/治理審查。四路外援都完成，review worktree 無程式變更。主 agent 負責契約交集、整合與全套驗證，再由 Astra 互審實際差異。CLI review 是意見來源，不能計為測試通過或 Ted 的操作批准。

### 實作與交叉審查

- GOV-C 新增 host-only `verifyHostCandidate`，未放進本機 CLI/consumer exports。host 供應固定 verifier、policy 與 bare Git objects，驗真正 base/head/candidate/tree、來源 pins、實際 vendor bytes 與完整 suite/workflow/harness binding，不執行 candidate 程式。審查發現新 descriptor 可覆蓋原本未知路徑後，補上 baseline ownership fallback 反例。完整可信 observation transport、runner isolation、proof/publisher/source approval 接線及 GitHub check/rules 仍缺；report 一律 local、merge/execution 未授權。
- ASSET-A 首段只交付 effect-phase I/O，不建 DB migration 或啟用路由。固定 scope/asset/representation key、先驗 persistence policy、實際 bytes 上限、嚴格 UTF-8/頭像 profile、immutable PUT 後完整 GET + digest；PUT 結果不明時只能核對 bytes 恢復。store 成功不等於 ready、權限或業務 receipt；intent/fence/finalize/GC、R2/Images 與 read ACL 留待後續。
- 跨 agent 審查另重現兩個原 20 tests 未涵蓋的問題：upstream `AssetStorageError` 原樣重拋可能帶出私密診斷；`Uint8Array` 在型別／長度驗證前複製可能接受 array/numeric 或先分配超限記憶體。修正後新增四例，24/24 通過；原審查者再獨立重跑原漏洞案例，確認固定錯誤不含原訊息、非法 bytes 在 allocation/I/O 前拒絕，合法 Buffer 仍正常。
- WORK-A 的 077 保留舊 Work 事實，私人 owner/user/personal scope 用複合 FK 綁定，模式與身分不能改綁或 DELETE 重建。私人只允許 draft，不填協作條款/期限；Claim/Review/Contribution/Benefit 的生成 discriminator + FK 防止私人資料變成社群事實。site/service 仍拒絕。
- 既有 Work、dashboard、task-board、contribution、benefit 與 command replay 均先限社群模式。新 `/api/v1/me/private-work` list/search/count/page/detail 只認當前會員、person principal 與 personal scope；管理員/公會長不例外。HEAD/Range/條件標頭不能省略授權，回覆 private/no-store。私人寫入、Result、Asset/share/export/run 路由未開放；通知/outbox 無私人 producer，新增 producer 前仍須重驗整張讀取矩陣。
- WORK-A 18 項含同/跨社群枚舉、admin/officer、過期/停用、複合 FK、假協作事實、replay、bigint 精度與真正 `pg_blocking_pids` 鎖等待 barrier。075 升級 fixture 補齊 Work→Claim→Submission→Decision→Contribution/Benefit，固定舊欄位 snapshot 避免新增 metadata 造成假失敗。既有 E2E 只調整 fixture cleanup，改由自有 schema teardown 清理 immutable Work；沒有 UI 變更。
- 失敗及重跑：WORK 定向測試初次 65/66，原因是新增合成 admin fixture 使用不存在的 `admin` enum；改為既有 `super_admin` 後完整定向 suite 69/69。後續強化鎖等待 barrier，再跑 WORK-A 18/18。未刪測試、弱化 SQL constraint 或把模型建議直接當通過證據。

### 整合後實測

| 檢查 | 結果 | 邊界 |
| --- | --- | --- |
| `npm test` | 967 passed，0 failed/skipped；約 204 秒 | 隔離 PostgreSQL，含新 24 ASSET／18 WORK cases |
| `npm run test:worker` | 20 passed，0 failed/skipped | localhost proxy 接合成資料庫；非真實 Cloudflare |
| `npm run test:governance` | 119 passed，0 skipped | 含 13 個新 host-boundary cases；非 GitHub 強制 |
| `npm run test:contracts` | 659 passed，4 個原有 clock cases skipped | 不改原有 skip 條件 |
| Skill client／deploy preflight | 10／37 passed，0 skipped | 既有回歸及靜態發布前檢查 |
| `typed-line-breaks.spec.ts` | Chromium 1 passed | build 後執行受影響 cleanup 的案例，非全套 E2E；GitHub 使用 fixtures |
| typecheck／build／common schemas | 全通過 | build 保留既有 large-chunk 警告 |
| 三類 Worker dry-run | 各環境全通過 | platform、admin-sync、maintainer；沒有上傳部署 |
| preview build | 32 operations／9 artifacts | preview 與 SDK 重產無 diff |
| inventory／diff-check | 1,144 hashes、637 本機連結，0 failures；diff-check 通過 | 不驗外部連結或產品行為 |
| 對真正 `origin/main` prepare／verify | exit 2，unavailable | descriptor/refs、preview、119 governance tests 通過；缺 baseline governance、surface audit 及 runtime suite adapter |

本批使用新的 PostgreSQL 18.6 container（與 repo CI 同 image digest）、network none、無 published port、2 GiB tmpfs、專用 Unix socket。Runtime/E2E 使用新 `fp_*` schema，Worker 使用新 `fp_*` database；不繼承 provider/DB secrets。結束查到 `fp_*` schema/role 都為 0，資料庫僅有本輪 `fp_foundation` 及預設 postgres/template，隨後移除容器和空 socket 目錄。只刪可重建的合成資料，未讀寫 `freedom_local.public`。

migration 076/077 仍是暫用號；整合 manifest last=77、known_gaps=`[22]`，遠端 main 收尾再查仍為 `3de70ccbd24362a7925508fb42d36aaa256a0806`。077 尚無 down migration 或 release-tool rollback floor；舊 binary 的 row spread 可能額外回 metadata，不能宣稱新舊混跑 byte-exact。私人寫入保持關閉，直到回退、命令與新增讀取面驗收齊備。

## 本批：CORE-2 與封閉 Asset lifecycle

三隻 Astra 使用獨立 worktree：一隻實作 scoped command、一隻實作 Asset lifecycle、一隻獨立撰寫競態／原子性反例；整合後互審。外援以唯讀 Grok 4.7 與 Opus 4.6 各做設計及程式審查：Grok 設計、Opus 設計與程式三路完成；Grok 程式審查逾時，未取得結論，不列為通過證據。CLI 輸出僅為建議；與實際程式不符的 replay 順序推測等已排除，不能把建議測試數當成已執行數。

### 實作與修正

- CORE-2 透過同一 transaction 的 `lockMemberScope` 組合，不巢狀開交易。新 `packages/scoped-commands` 與 resource-scopes/command-core 的 module 依賴無循環；新 receipt namespace 為 principal/authn-kind/scope/operation/key，digest 加入固定 profile、typed target、scope、expected version 與 bounded plain JSON。舊 member command/digest/receipt 不變，execution/service 仍拒絕啟用。
- 暫用 078 新增 scoped receipt、journal/outbox 的 owner/scope 複合 FK、metadata 上限及 append-only DML 限制；不寫舊 community outbox，沒有新 fanout。`scopedJournal` 僅接受同一交易、已授權 run 的 live context 與相同 operation。這不是防止 schema owner 停 trigger/TRUNCATE 的機制；另以 DML-only runtime role 跑反例。
- 暫用 079 新增 Asset、不可改寫 representation、upload intent 與 typed avatar sidecar。prepare 固定 manifest/target/version/policy；claim 取得 nonce、遞增 fence 與 lease；source hash/size、轉圖、immutable PUT/read-back 在交易外；新的 scoped command 重驗目前權限、policy、fence/expiry 後存 stored，finalize 再驗 object 並原子寫 ready/pointer/real version/facts/receipt。
- 版本唯一權威是既有 `member_avatars.aggregate_version`。Sidecar `linked_at_version` 只是掛載快照；legacy save/delete 後 `readTarget` 不再回舊 pointer。Finalize 不替換舊 `image_bytes`，因此不能接到現有頭像路由；尚無 HTTP、R2 adapter、完整 Asset reader 或 cutover。
- 整合審查修正 operation ID 不一致、Actor 跨 await 可變、同名 module descriptor，以及 SQL 只驗 UPDATE 卻可直接 INSERT ready/stored 的繞過。現在只允許 pending Asset 與 prepared/no-lease intent 起始狀態，current policy/owner/version、typed ready pointer 及狀態轉移均有回歸。
- 原先 1,030 項整合 runtime 全通過後，交叉審查仍重現另一個真實邊界：session 在 avatar/policy row lock 等待期間到期，Asset inspection 仍可能啟動 source/PUT，或 readTarget 回 metadata；事後 command 拒絕不足以補救。新增兩項 actual `pg_blocking_pids`／DB-clock 測試先 RED，再於最終 DB query 後呼叫共用 `assertCurrentSessionClock`，轉為 GREEN。它要求同一 `q` 已持有 user/session 鎖，不是可單獨呼叫的身分驗證。
- 原審查者獨立重跑最初漏洞腳本：過期 write 的 source/decode/PUT/SQL object 全為 0，過期 readTarget 不回 metadata；中間穿插正常 write/finalize/readTarget 仍成功。再跑 scoped/legacy/lifecycle/race 共 81/81、零 skip。這是獨立合成環境證據，不是真實 R2 或 prod 授權驗收。
- 23 項獨立 race tests 包含同 key 並行只提交一次、相同 expected version 只一個 winner、I/O 暫停時可完成 revoke、lease takeover/fence、policy 變動、legacy save/delete、原子 pointer/journal/outbox/receipt 故障回滾及重試。SQL fault trigger 由另一操作明確移除後重試，未使用會被同交易 rollback 還原的「一次性」旗標。

### 本批驗證及未啟用範圍

最終整合 `npm test` 為 **1,032 passed、0 failed/skipped**，約 218 秒；包含新增 28 scoped、14 lifecycle、23 race cases。修正前 1,030/1,030、修正後獨立定向 81/81 亦完成。以下其他檢查已在本批執行：Worker 20/20、governance 119/119、skill client 10/10、deploy preflight 37/37；既有契約 659 passed／4 個原有 clock cases skipped。Typecheck、build、三類 Worker 的所有環境 dry-run 均通過；common schemas exact-byte check 通過，preview 仍為 32 operations／9 artifacts 且 preview/SDK 無 diff。本批沒有重跑瀏覽器 E2E，沒有 UI 或 route 接線變更。

對真正 `origin/main` 執行 prepare/verify，新增 `asset-lifecycle` 與 `scoped-commands` ownership/refs 有效、119 governance tests 確實執行；總結果仍 exit 2 `unavailable`，原因為 baseline governance、surface audit 與 runtime suite adapters 未齊。手動 runtime 結果不冒充 trusted CI。Inventory 為 1,155 個檔案 hash、650 個本機文件／目錄連結，0 failures；`git diff --check` 通過。

本批另建與 repo CI 同 digest 的 PostgreSQL 18.6 disposable container，network none、無 published port、2 GiB tmpfs、專用 Unix socket；Worker 短期 localhost proxy 在測試後關閉。所有 DB 測試明確指定新 `fp_foundation`，每套各自使用 `fp_*` schema/role/db，沒有連接 `freedom_local.public`。收尾查到測試 schema/role 均為 0，僅剩 `fp_foundation` 及預設 postgres/template，之後移除容器和空 socket 目錄；只刪除可重建的合成資料。兩個外援 review worktree 保持乾淨，沒有程式變更。

目前 migration 076–079 全為未合併暫用號，manifest last=79、known_gaps=`[22]`；本批再查 remote main 仍為 `3de70ccbd24362a7925508fb42d36aaa256a0806`。啟用前仍須真實 policy source、retained-byte quota、GC/deletion fence、backup pins/restore、avatar read bridge/legacy-writer fence 及 rollback floor。預設 1 小時 intent、5 分鐘 lease、最多 3 筆並行 intent／各 128 KiB reservation 是可配置的內部限制，不是累積儲存或收費配額；expired/orphan/retired objects 不會自動刪除。

## 頭像相容串接與實際 consumer 本機接入

本批仍由三隻 Astra 在不同 worktree 分工與獨立審查。以下記錄截至整合 `1aad418` 的 076–083 增量；後續 084 私人 Result schema 與共用 profile engine 另行驗證，不能套用本段測試數。

- 原生 R2 adapter 使用 conditional immutable PUT 與完整 bounded read-back；明確注入 request-scoped `MEDIA`，無 ambient bucket／credential，delete 預設拒絕。缺少 storage 不影響 login/health，也不讓 asset-backed read 回退旧 bytes。Native binding suite 有 16 項 local workerd 測試，不是真實 Cloudflare 帳號。
- 080 加 `storage_source`、legacy-writer fence 與 canonical presence projection；讀取在 object I/O 前後驗當前資格、pointer/version/share generation。本人移除立即清 pointer／retire，沒有同步 object DELETE。083 在原 avatar POST 接入共用 lifecycle，沿用舊 body digest、receipt namespace、response、CSRF/Origin；同一 finalize 交易提交 pointer/version/scoped facts 及原 receipt。舊成功 receipt 不需 storage 也能重播，但仍先驗目前身分與 domain。
- Quota policy 為必要的明確正 bigint 上限，計入同用途 object 實際大小或保守 reservation、retained legacy bytes；expired/orphan/retired/tombstoned 及 GC missing 都不自動扣除。預設 legacy／persistence-disabled，沒有正式啟用或自動清理。
- 081 加 owner-only server 內部私人 Work create/update/archive，真實 Work CAS、scoped receipt/facts、當前 persistence policy；archive 可在 persistence 不可用時停止工作。不新增 mutation HTTP、模型呼叫或 Grant。
- 082 加不可逆 deletion fence、永久 tombstone、late PUT 對帳，以及先建 barrier 再取 bounded snapshot references 的 backup capture/pins；到期 barrier/pins 不暗中釋放保護。GC 只接受 avatar profile；備份 pin/capture 不是 DB dump、object 複本或 restore 成功。預設停用且没有 scheduler。Ted 已同意未完成／無引用物件至少 48 小時、替換舊圖 7 天、使用者刪除立即停止讀取；備份政策另確認，此同意不啟用正式清理。
- Runtime verifier 以固定 baseline、批次 process 及明確隔離 DB 執行實際 runtime tests，拒絕空／skip／cancelled 證據。中央工具另支援 Agent Kit 的直接 Node test suite、精確 scoped package name、repo-root descriptor 與 consumer report schema；不執行 consumer package hooks。未放寬 host trust 或 surface audit。

完整 runtime 首跑 1,168 項有 4 項失敗：bridge 的 metadata helper 誤要求 onboarding，阻擋原有帳號設定流程。修正 `5824348` 保留登入／本人要求、恢復 onboarding 前 metadata 查詢，補 1 項反例並加強既有 HTTP status assertion。定向 52/52 後，完整重跑 **1,169 passed、0 failed/skipped**，約 253 秒；未刪失敗案例。獨立競態審查仍持續，這不代表所有未來 profile 已驗證。

| 本批檢查 | 實際結果 | 證據範圍 |
| --- | --- | --- |
| Runtime | 1,169 passed，0 failed/skipped | 明確指定 disposable PostgreSQL，076–083 |
| Worker | 28 passed，0 failed/skipped | 既有 20 加新 8 native avatar cases；local workerd/R2/Images 與合成 DB |
| Browser | 23 passed | avatar、member e-card、member connections 三套 Chromium；沒有 UI 變更 |
| Governance | 135 passed，0 failed/skipped | local/host-boundary、固定 runner、實際 consumer suite；不是 trusted GitHub check |
| 既有契約 | 659 passed，4 個原有 clock cases skipped | 未改 skip 條件 |
| Skill client／common schema | 10 passed／exact-byte check 通過 | 本機契約回歸 |
| Typecheck／platform dry-run | 通過／各環境通過 | 沒有上傳或部署 |

Agent Kit 真實 repo 另在 `foundation-agent-kit-source-20261002` 本機分支接入，base `201fdab8017e2850bafc7b2f1e8dec7e4c0d6233`、consumer commit `84d30a342cc058b67b64e533e345a98e695d47a3`，固定本機中央 source `1aad41836eefe1b7bee5f8fe9bbba8e66a810e75`。薄 CLI wrapper、中央工具 vendor、descriptor、lock 與 README 已提交；原 preview vendor exact bytes 不變。實際 Node tests **2/2**、build syntax check、local pin check 通過；prepare/verify 使用真正 `origin/main`，回 exit 2 `unavailable`：缺 baseline governance 與 registration behavior audit。這是本機尚未公開的 producer pin，不是已批准 ReleaseSet、可信 CI 或可直接發布的 consumer 升級。Kit 現有功能只有 local demo status read，不能當真實 CLI 模型／Grant adapter。中央 `repositories.lock.json` 未改。

本批 Opus maintenance 唯讀審查完成，補採 capture/pin 索引建議；Grok avatar compatibility 程式審查逾時，沒有結論，不算通過。資料庫仍是同 digest PostgreSQL 18.6、network none、2 GiB tmpfs、專屬 Unix socket；Worker 短期 proxy 已關閉。因後續 Result/engine 測試正在使用，本批容器尚未清理；沒有接觸 `freedom_local.public`。本段尚未重產 inventory 或宣稱最終交付完成。

## 共用 Asset 引擎與人工私人成果

整合至 `ba10127` 的本機版本已包含共用 profile engine、084 schema 與 human Result service；這是人工服務增量，不是模型產稿或 Autopilot 完成。

- `modules/assets/engine.ts` 成為唯一 member-personal upload lifecycle。Avatar adapter 保留原 prepare manifest/digest、API shape 與旧 receipt；private Result adapter 共用 prepare/claim/effect/store/finalize，沒有第二套 upload engine。Purpose/target kind 綁定在任何 lease／source／storage 操作之前，跨 profile 的 avatar claim/write/finalize 均拒絕。
- Prepare 用 `(scope,purpose)` quota advisory lock 序列化不同 Work 的保留容量。Retirement 涉及的舊／新 Asset 在 policy 和 clock check 之前，依 UUID 排序預鎖。獨立測試先重現舊 Asset 被 backup 類 SHARE lock 阻擋後，session 過期仍完成的問題；修正後同一案例拒絕且不開始 GET。
- 084 保留 avatar profile 與舊 rows/receipts，新增精確 owner/scope/private Work typed intent、256 KiB UTF-8 text object、不可變 human Result 與 current pointer。Result 的唯一真實 Work CAS 在 AFTER successful INSERT。獨立測試先重現 conflict-suppressed INSERT 消耗版本，再驗修正；另以兩個交易重現 unique-index 等待後對方 rollback、自己 lease 過期仍 INSERT 的邊界，補 AFTER clock check 後同一反例轉綠。這是受信 SQL invariants 的測試，不聲稱外部 caller 可以選擇服務內生成的 Result UUID。
- `modules/autopilot-work/results.ts` 只提供 member-session server 內部人工服務。實際 Result ID／revision／Work version、intent finalize、facts/outbox/receipt 原子提交；遺失 COMMIT 回覆後相同 key 重播不新增成果。Current/history read 在無 SQL locks 的 bounded verified GET 前後驗目前 owner／Work／session／policy／version；歷史 retired Asset 仍可合法讀取，archive/revoke 不可。返回文字沒有 raw key／presigned URL，Markdown 不執行或渲染。私人 GC、HTTP/UI、機器身分與 AI provenance 均未開放。
- 34 項 service cases、30 項 schema cases、5 項 engine cases、16 項獨立 race/read cases 已整合。獨立審查者在最終 service hardening 後再跑其 16/16 通過；作者組合 suite 156/156。主 agent 另把私人 Work command 的 ID validator 改為中央 `OpaqueId`，補反例後該 suite 23/23。

主整合完整 `npm test` **1,255 passed、0 failed/skipped**，約 269 秒；之前只有 schema/engine 的中間版本 1,210/1,210 亦通過。整合後 Worker 再跑 **28/28**，包括 native R2 avatar cases；governance **137/137**、deploy preflight **37/37**、typecheck 與 platform 三環境 dry-run 通過。Browser 23/23 是本批前述 083 facade/bridge 的回歸，未因新增內部 Result 服務再次宣稱 UI 驗收。資料庫仍只用本輪 disposable PostgreSQL；Worker proxy 結束即關閉，容器留供後續驗證。

Opus 對 engine/schema/Result 的唯讀文字審查已完成。其歷史讀取 412 建議未採：當前規格明確要求 I/O 期間 Work version 改變就拒絕並重新讀取；不可變 history 不能取代目前 Work ACL。關於重複 object rows 的假說由既有 `asset_id` primary key 排除。模型審查不當成執行測試或操作批准。

### 第二個實際 consumer

Storefront base/main `9823df79f8eee86008c269437880ed2e49bdc394` 的獨立本機分支，commit `58edbddb5c17d5acc24053aa349396ed815b6e9e`，固定中央 producer `ba101270d456db7994f539c0788a031e2668fb70`。同一 export generator 產生薄 wrapper 與工具，preview vendor、read client、client-source lock、SDK、UI、templates、package/CI 完全未改。18/18 現有測試與 local client-source/contract-pin checks 通過。

在兩個 consumer 的最後 HEAD 對真正 `origin/main` 重跑：Kit 2/2、Storefront 18/18 的 suite 確實執行，descriptor/pin 檢查通過，總結果均 exit 2 `unavailable`，保留 baseline governance 與 registration behavior audit 缺口。兩者 producer pins 都僅在本機，沒有 approved ReleaseSet 或 remote source availability 的證明。三倉仍未 push、開 PR 或部署，中央 integration sample lock 不變。

## 有限入口原始碼稽核

整合 `7a1c1b2` 新增 host-only AST audit 與獨立反例，不接入 CLI、consumer export 或可信 publisher。固定解析 avatar 四條與 private-read 兩條 route、兩個 mount，以及 baseline/candidate descriptor/test 聯集；候選 source 永遠只當資料，不 import、執行或讓它選 parser。

獨立審查先重現八個局部假通過案例，包括 root 提早 return/throw、條件 return、錯誤最終 receiver、直接／computed method replacement、receiver escape 與 leaf throwing initializer。修正後 **59/59** 定向測試通過。現有 root 的四個 receiver delegates 仍是未覆蓋範圍，沒有以 helper 名稱豁免；輸出十二筆 baseline/candidate 語法資料並標 `fixed-syntax-only`，`structural_status` 和整體均不提供 passed。反例要求新增具體 candidate finding，避免「永遠 unavailable」掩蓋沒抓到變更。

主整合治理 **196/196、0 failed/skipped**，TypeScript 7.0.2 typecheck 通過。Parser 使用獨立 dev dependency `@typescript/typescript6`，不改 runtime 依賴；因其 wrapper 也提供 `tsc` bin，typecheck 明確指定原 TypeScript 7 compiler 路徑，避免 npm 安裝順序切換編譯器。這是本機固定來源解析，沒有替 parser/publisher 配置正式信任。

本機 `npm audit` 另列出既有開發工具鏈 2 moderate／1 high；相關 miniflare、wrangler、undici lock entries 與 `origin/main` 相同，不是本次 parser 增量。尚未另行升版及重新驗證工具鏈，不宣稱 dependency security clean。

## 封閉 EXEC-A 與本批收尾

實作固定版本為 `0308f543591916d5f03ceb5a1d7fa559c30e27d6`。新增中央 execution decision schema、同源 JSON Schema、有界 decoder、不可變 Attempt binding、單一 Run 狀態及轉移矩陣；[模組說明](../../../../packages/execution-state/README.md)明列 actor、控制／租約／恢復世代、unknown effect/usage 與人工控制語意。Module descriptor 登記真實 exports／instructions，兩份新測試加入 protected full-runtime baseline；不新增註冊入口或 migration。

這是 `hypothetical_decision_only`，每個結果均 `operational_authority=false`，activation 固定 unavailable。Caller 的 owner、Grant、policy、model readiness 與時間只是假設輸入，不是可信驗證結果；沒有 durable Run、機器授權、模型呼叫、HTTP 或 AI Result 寫入。084 的 human provenance 不能拿來保存模型成果。Wire、結構 schema 與關係／狀態語意分層檢查，不把 JSON Schema 當成簽章或完整授權。

審查修正 stale recovery/control ACK、終態被遲到 ACK 改寫、resume 後 ACK 撤回 preflight、非 running outcome 恢復執行，以及可能被 Number 四捨五入的數字／非 index array keys。獨立反例另以不變的 task/control epochs、更新後的 recovery generation 重現舊 dispatch 被接受，補原 dispatch generation 等值檢查後轉綠；舊 observation 仍可作有限 metadata evidence，不能重新派送。

第一輪整合 runtime **1,355/1,355** 通過後，連續狀態探索又重現第 77 筆 dispatch 附近的容量死結：已接受的 next snapshot 連 Stop input 都超過 32 KiB。修正改以 **24 KiB control-reserved snapshot + 8 KiB envelope**，預先計入可變狀態／版本／Result 的最大空間，超限前拒絕歷史增長，不刪除紀錄。原樣重跑普通及最大欄寬序列，Stop/revoke、ACK 和 unknown charge 保留均通過。作者 76 項加獨立 29 項，合計 **105/105**；這是 prototype 邊界，不是正式產品歷史保留政策。

### 固定版本最終驗證

對真正 `origin/main`（`3de70ccbd24362a7925508fb42d36aaa256a0806`）執行 prepare/verify，而非自選已治理 base。固定 runner 實跑 **runtime 1,360/1,360（108 files）、governance 196/196（8 files）**，0 failed/skipped/cancelled；各 runtime 子集合是同一批次的覆蓋切片，不額外重複加總。Workspace 未於驗證期間變動，descriptor/schema/ref 及原 preview bytes 檢查通過。

整體仍為 exit 2、local `unavailable`，保留 `baseline_governance_unavailable`、`surface_unmapped`、`registration_behavior_audit_required` 三個真實缺口。有限 source audit 與本機成功測試都沒有取代可信 publisher、host observation transport、完整入口行為或 GitHub 強制。

TypeScript 7 typecheck、common/execution 生成契約 check、deploy preflight **37/37** 通過；既有契約 **659 passed、4 個原有 clock cases skipped**。Preview 重產仍為 32 operations／9 artifacts，preview、SDK 與中央 consumer sample lock 相對 main 無差異。Worker **28/28**、Browser **23/23** 是前述 bridge/Result 批次證據；本次沒有新增 runtime 接線或 UI，不再宣稱重跑這兩組。

收尾已查隔離 PostgreSQL 的 `fp_*` schema、role 及其他 client 都為 0，只剩本輪 `fp_foundation` 與 postgres/template 預設資料庫；停止並自動移除本輪測試容器及空 socket 目錄。只移除可重建合成資料，沒有碰 `freedom_local.public`。Worktrees、提交及 ignored 測試報告保留供查核；沒有殘留本輪 Worker proxy、模型審查程序或長駐測試 DB。遠端 main 再查仍為 `3de70cc`，全程未 push、開 PR、合併或部署。

本批收尾 inventory 為 **1,203 file hashes、679 本機檔案／目錄連結、0 failures**；`git diff --check` 通過。這項檢查不驗外部 URL、產品行為或簽章信任。

## 本批：私人 DB 政策與本機發布相容性

三個 worktree 分別實作私人政策、發布相容性，以及獨立反例；主 agent 整合並補公開 SQL grants。暫用 migration 085 不 seed 允許列，固定 personal owner/scope/purpose、單調 revision 與明確 retained-byte quota；Work／Result 顯式注入同一 resolver，讀取政策持 SHARE lock，等待後重驗 session clock。Archive 不依賴政策，舊 Work read ACL 不改；沒有新增 HTTP/UI、AI、私人 GC 或正式政策值。

整合時先重現 SELECT-only app role 的 resolver 失敗：PostgreSQL row lock 需要 UPDATE 權限。修正只授權生成常數 `scope_kind` 的 column UPDATE；實測 DEFAULT 更新全列不變，其他 policy 欄位／混合賦值及 INSERT/DELETE/TRUNCATE 均拒絕，真正 Work／Result 服務可運作。作者 17、獨立 9 項 PostgreSQL 測試通過。

主 agent 的公開 grants／checker 清除 table 及 column 舊權限，拒絕 inherited／PUBLIC 寫入及 grant option。獨立審查再用真正 app LOGIN、未改寫的 psql template 重現 NOINHERIT + SET ROLE 繞過；因此專用 app role 一律拒絕父角色 membership（含 SET-only／ADMIN-only）與管理屬性，並驗生成常數未漂移。新增 11 項隔離 PostgreSQL 測試已通過；公開 checker 仍是報表，exit 0 不代表欄位全部安全。私有 release helper 尚未接線。

[發布相容性診斷](../../../../deploy/cloudflare/release-compatibility.md) 以精確 source/artifact、完整 SQL ledger、全部 active consumers、已啟用／曾寫入／外部保留的歷史形狀檢查相容性。Schema 077 即使未有 private write 仍需 explicit wire；085 私人形狀另需 server policy。普通 CLI 沒有獨立可信 host 就 unavailable，candidate JSON 不供應批准／時鐘／觀察。所有回覆的 deployment/execution authority、restore proof 均 false。Host 觀察／信任 transport 未實作，跨 DB restore 的歷史 schema／policy 下限也尚缺，不能把 local compatible 當成可還原或可部署。

固定整合 code commit `3b6a0bf8b1c80846a703a2d3ab5342aa7c03db6c`，對真正 `origin/main`（`3de70cc`）執行 prepare／verify；驗證中 tracked workspace 不變。完整 runtime **1,397/1,397（111 files）**、governance **196/196（8 files）** 通過，0 failed/skipped/cancelled；runtime 子集合不重複加總。TypeScript 7、common/execution 生成 bytes、descriptor refs／preview bytes 通過。整體仍 exit 2、local unavailable，明列 `baseline_governance_unavailable`、`surface_unmapped`、`registration_behavior_audit_required`；沒有改 base 或偽造可信 CI。

公開 preflight 全套 **107/107**（含 32 項獨立相容性反例）、Worker **28/28**，0 failed/skipped。Worker 使用既有 dry-run bundle 配新 085 的隔離 fixtures，本批沒有新 Worker/HTTP 接線或 UI，不宣稱重跑瀏覽器。既有契約 **659 passed、4 個原有 clock cases skipped**；沒有新增 skip。

獨立實跑原樣 psql templates：真正分開的 non-superuser migrator/app LOGIN、新建 `fp_*` DB 的 public schema，確認重複套用、app row lock、禁止 policy UPDATE、PUBLIC／SET-only membership 拒絕、生成欄位漂移拒絕，並用原本未授權的 marker table 證明失敗會 rollback 整筆 grants。SQL 使用 `ON_ERROR_STOP=1`；30 checker 仍只印報表，不能只看 exit code。Migrator→grants 之間須保持應用連線關閉，並不是跨整段發布交易已原子化。未讀秘密 release helper，也未驗真實 PlanetScale／Hyperdrive 權限。

本批使用新的 PG18.6 network-none、2 GiB tmpfs、無公開 port 的測試容器；Worker 只用短期 localhost proxy。收尾查得 `fp_*` schemas／roles／其他 clients 全為 0，只剩 `fp_foundation` 與 postgres/template；隨後清理本輪容器和 socket，僅移除可由測試重建的合成資料。第一次容器 init 的 Unix socket mount 不符 entrypoint 預期，修正後才取得連線並開始測試，沒有 fallback 到本機資料庫。

本批 inventory **1,212 file hashes、688 本機連結、0 failures**，diff check 通過。Manifest last=85、known_gaps=`[22]`；076–085 皆為未合併暫用號，合併前重新核對。遠端 main 仍 `3de70cc`；未 push、開 PR、merge、部署或啟用正式清理。備份政策仍另行確認。

## 本批私人 HTTP 與固定行為驗證

三個 Astra 工作位負責私人 HTTP、固定行為 harness 及獨立反例；另以 CLI 完成四路 Grok 4.7、兩路 Opus 4.6 文字審查，不占用 Astra 工作位。部分早期 Grok 請求逾時；Opus 初次遇 429，等待額度重置後才成功，未切換帳號、付費或權限。沒有把啟動程序、逾時或模型意見算成完成／測試證據。

新增 [私人 HTTP factory](../../../../modules/autopilot-work/http-transport.md)：Work create/edit/archive、本人 list/detail、人工 Result list/current/history；重用真實 cookie/CSRF/onboarding、scoped commands、085 policy 及共用 Asset/Result 服務。嚴格驗實際 UTF-8 bytes、重複 JSON keys、Idempotency-Key 與版本；HEAD 仍完整驗權，Range/conditional 不繞過 ACL。正式 app 沒有 import/mount 此 factory，也沒有 upload／分享／AI 或私人寫入啟用。

共用 member middleware 保留既有授權順序及 onboarding 例外。Grok 指出的空 CSRF 邊界經 schema／真實 session 重現：舊表只要求 NOT NULL，空 token 可與缺少 header 作零長度比對。新增非空字串 guard，正式 app 與封閉 factory 的反例和正常登入控制均通過。列表參數由既有 strict validator 檢查，archive 缺版本由既有 `checkVersion` 回 428；Result identity/object metadata 不可更新，政策改動強制增加 revision。這些已存在的保護沒有因文字審查而重造。

[固定行為 harness](../../../../packages/contribution-tools/behavior-harness.md) 對六條既有 route 執行 27 個 host 固定 request/assertion，前後綁定候選／workflow／harness／fixture，限制 response bytes、headers、chunks 及合作式 timeout。不接受 candidate 的測試清單或 passed 報告。成功 observation 不包含 cookie／CSRF／私人正文，也不授予執行、合併或發布權限；真實 transport 認證、隔離與 publisher 仍缺。

獨立反例先重現六個漏檢，再原樣複驗修正：空清單額外 objective／Work ID、Unicode escaped problem 內容、HEAD private header、header／body credential echo。改為精確清單 DTO、decoded JSON 及有界 header sentinel 檢查；不宣稱可抓任意編碼側通道。Auth-negative avatar/remove 另保留獨立缺少版本條件，避免只要 auth 回歸就刪除 fixture。作者 10 加獨立 35 項工具測試通過；真正 createApp + 隔離 PostgreSQL 的 27 個請求也通過，頭像 bytes／version 與 command facts 不變。

固定驗證版本 `ead11c321337a90a0959f9ae386aa088fa58ae12`。對真正 `origin/main` 的 prepare／verify 實跑完整 runtime **1,437/1,437（114 files）**、治理 **241/241（10 files）**，0 failed/skipped/cancelled；runtime 子集合不另加總。新增兩份 HTTP suite 及 actual-app smoke 均納入 protected baseline，descriptor 不把未掛載 factory 宣稱為正式 surface。初次 prepare 抓到根整合者把 instruction 放在不允許的 app 路徑，將文件搬回其 module 並修正連結後重跑，沒有放寬路徑保護。最終仍 exit 2、local unavailable，保留 baseline governance、surface mapping 與 registration behavior audit 三個缺口。

TypeScript 7、前端 build、三類 Worker 的全部環境 dry-run、common/execution 生成 bytes 通過；build 仍有既有大型 chunk 警告。重新建好的 Worker 回歸 **28/28**、公開 preflight **107/107**，均無 skip；既有契約 **659 passed、4 個原有 clock cases skipped**。没有改 migration 或 manifest，076–085 仍是未合併暫用號，last=85、known_gaps=`[22]`。

新 build 的 Chromium 瀏覽器回歸 **23/23**：頭像預覽／儲存／移除、名片 autosave／版本衝突、會員連線／公開分享撤銷，約 1.1 分鐘。只使用合成會員與本輪隔離 schema，無 UI 改動；不把這 23 項當成新增私人草稿 UI 驗收。

部分平行 PG suite 的 assertion 通過後，schema teardown 曾因 `53200 max_locks_per_transaction` 失敗；那些執行不算通過。後續改為序列重跑，再取得上述完整主整合證據；未修改正式 DB 或容器參數來掩蓋失敗。所有資料均屬本輪 network-none／tmpfs disposable PG18.6 與合成 `fp_*` schema/db。

收尾查核沒有其他 client、`fp_*` role 或子資料庫，僅留一次失敗 teardown 的合成 Result schema；核對容器 ID／task label 後，停止並移除本輪容器及空 socket 目錄，該殘留合成資料一併清除，可由測試重建。程式、worktrees 與 ignored 報告保留，沒有殘留本輪 Worker proxy／瀏覽器 server／CLI 審查程序。遠端 main 再查仍 `3de70cc`；未 push、開 PR、merge、部署、處理其他 PR 或啟用正式清理。備份政策仍另確認。

最終 inventory：**1,223 file hashes、696 本機文件／目錄連結、0 failures**，diff check 通過。文件分開保留本機實作、合成測試、進度估算與正式驗收缺口；原始產品驗收仍未改成 PASS。

## 本批封閉 Run 與歷史相容性下限

三個 Astra 工作位分別完成實作、獨立會員競態測試與真正低權限 DB 測試；另外兩路 Grok 4.7、兩路 Opus 4.6 CLI 做限定公開原始碼的文字審查。其中一個 Grok 歷史下限請求逾時、沒有結果，另一路 Grok 與兩路 Opus 完成；文字意見不算實跑測試。沒有 402，也沒有增加付費、變更帳號或權限。

新增 [封閉會員 Run](../../../../modules/agent-execution/README.md) 及暫用 migration 086。紀錄以真正的 personal Work／owner／scope 複合 FK 綁定，保存不可變輸入版本與建立時政策 revision；create/read/pause/stop 使用目前會員權限、Run CAS、task/control epochs、同交易 scoped journal/outbox/receipt。Create 需要目前 DB metadata persistence policy，撤回政策或封存 Work 後仍能讀取及停止既有紀錄；Run 控制不改 Work 版本。只能處於 created/paused/cancelled，不建立假的 Attempt／Grant／runtime／lease／recovery generation，也不掛 HTTP、呼叫模型或啟用 dispatcher；`operational_authority` 固定 false。

真正 non-superuser migrator/app 連線先重現兩個 TEMP 表遮蔽反例：假政策和假 Work 能誤導 INSERT trigger。修正為以 `TG_TABLE_SCHEMA` 限定兩張實體表，保留 invoker 權限；原封不動反例由 RED 轉 GREEN。作者 24、独立行為 29、獨立角色 9，合計 **62/62 PostgreSQL 測試**通過。包含觀測到真正 row-lock 等待的過期／撤權、同 key 一次效果、並發 CAS、三個 scoped sink 故障回滾、政策撤回、Work 封存、身分不可改綁及禁止直接 SQL 啟用執行狀態。它們也已列入完整 runtime 的固定 baseline，不另重複加總。

發布診斷改用 host v2：要求外部保留完整歷史 SQL ledger 與 capability floor，當前觀測和計畫 ledger 都須保留 exact prefix；更換 recovery generation 或關掉 feature 不能擦除歷史要求。獨立審查另重現「歷史 shape 存在、現況 schema 不足，但未來計畫已足夠」的誤判，現在要求現況 schema 已具備該歷史形狀。Run 與 human Result 的歷史 capability 即使沒有 current shape，也必須保留必要 ACL／policy 相依；單純 ACL 不推定曾寫入私人資料或啟用 persistence。根整合者新增 23 項矩陣案例，完整公開 preflight **175/175**，並由另一位 reviewer 重跑通過。

固定整合驗證版本 **`c6696950017eed734e0bda5dc16d8ac623db0cc7`**。對真正 `origin/main` 執行 prepare/verify：完整 runtime **1,499/1,499（117 files）**、治理 **241/241（10 files）**，0 failed/skipped/cancelled。Descriptor 與生成 preview bytes 通過；總結果仍 exit 2、local unavailable，保留 `baseline_governance_unavailable`、`surface_unmapped`、`registration_behavior_audit_required` 三個真實缺口。Host 認證／完整來源覆蓋、可信 publisher、GitHub enforcement、外部歷史保存及同 schema 下撤回政策的 restore 對帳仍未完成；deployment/execution authority 和 restore proof 仍 false。

TypeScript 7、common/execution 生成 bytes 與 diff check 通過；既有契約 **659 passed、4 個原有 clock cases skipped**，沒有新增 skip。Worker **28/28** 通過，使用上一批既有 dry-run bundle 搭配本批 086 隔離 fixtures；本批未改 Worker/HTTP/UI 接線，沒有重新 build 或跑瀏覽器，也不把上一批 23 項 Browser 證據算成本批重跑。

新建 PG18.6 容器使用固定 image digest、network-none、2 GiB tmpfs、無公開 port 與專屬 Unix socket。為平行合成 schema DDL 明確設定 `max_locks_per_transaction=256`，不更改正式 DB。最終查得測試 schemas、roles、其他 clients、子資料庫全為 0，再核對容器 ID/task label，停止並移除容器與空 socket 目錄；只刪除可重建的合成資料。Worktrees、程式提交及 ignored 證據保留，無殘留本輪 Worker proxy 或 CLI 審查程序。

Manifest last=86、known_gaps=`[22]`；076–086 都未合併，不永久預留編號。遠端 main 最後唯讀確認仍是 `3de70cc`。沒有 push、開 PR、合併、部署、處理其他 PR、啟用正式清理或接觸 Ted 的本機真實資料；備份政策仍另確認。本批程式驗證時 inventory 為 **1,232 file hashes、699 本機文件／目錄連結、0 failures**；收尾文件另重產 inventory。本機實作、合成測試與正式驗收分開記錄，168 項原始產品要求仍未改成 PASS。

## 本批 runtime 金鑰登錄

三個 Astra 工作位分別負責中央 proof／契約與低權限測試、登錄服務／SQL，以及獨立競態反例；各自使用獨立 worktree，根整合者補生成工具、descriptor、發布相容性矩陣與完整回歸。額外兩路 Grok 4.7、兩路 Opus 4.6 CLI 僅審查限定的公開原始碼。Grok proof 與兩路 Opus 完成，Grok SQL 審查逾時而沒有結論；沒有 402／429，也未增加付費、變更帳號或權限。模型意見不能充當實跑或操作批准。

[固定工程規格 07](07-runtime-enrollment.md) 與 [模組說明](../../../../modules/agent-control/README.md) 將本批限定為會員核准、對應私鑰持有證明與可撤銷的公鑰登錄。中央型別／validator 及三份結構 JSON Schema 同源，exact-byte check 與五份新 suite 納入固定 runtime baseline；13 個 module descriptors 的路徑、參照、獨占 ownership 及無循環依賴已另行查核。Schema 只驗結構，不冒充實際驗簽、目前授權或完整語意。

- 封閉 ES256／P-256 profile 使用既有 `jose` 驗真正簽章及曲線點，嚴格公鑰欄位、固定 protected header／payload bytes、SHA-256 thumbprint、300 秒 DB-clock challenge，拒重複 key／演算法或用途替換／編碼別名。Host 明確固定 environment；owner／scope／runtime／nonce／期限由 server 產生或解析，不接受 caller 宣稱可信。
- 暫用 migration 087 保存 challenge 與 registration，member-only begin/confirm/read/revoke 使用目前 user/session/person/personal scope/onboarding、scoped command 及固定鎖順序。等待鎖、非同步驗簽與最後 query 後重驗時鐘；consume、registration、journal/outbox/receipt 同交易。過期或已消耗 begin 不再回傳；成功 confirm 的完全相同 receipt 可晚於 challenge TTL 重播，但目前權限與未撤銷登錄仍必要。
- 公開 pending challenge 不獨占 key，防止先提交別人的公鑰搶註。成功確認才取得 environment/key 唯一登錄；owner／scope／runtime／key 不可改綁，revoked tombstone 不可復活，rotation 需新 key。每 owner/environment 的 10 pending、1,000 lifetime challenges、32 registrations 是明列的工程容量限制，不是正式配額政策。
- Nonce 是公開挑戰而非 bearer secret，可在 begin receipt 重播；私鑰不由服務接收或保存，raw JWS 不進任何 durable row／receipt／facts。SQL 只保結構約束，不驗 ES256，也不防持有可信 app 寫入憑證者偽造業務事實。所有 DTO 的 `operational_authority` 固定 false；沒有 HTTP/UI、device flow、machine token、provider、Grant／Attempt／lease 或 dispatch。

### 反例與實際修正

兩個真正 SQL 反例先 RED 再 GREEN：BEFORE UPDATE 比較完整 row 時，NEW 的生成 `scope_kind` 尚未計算，誤擋合法 consume/revoke；改從 immutable 比較排除這個不可指定的生成欄位。JWK JSON null 另能經 SQL 三值邏輯繞过 CHECK；改為明確 string／canonical 座標及 `COALESCE(..., false)`。原樣反例、正常流程與真正 non-superuser migrator/app LOGIN 均重跑通過；未削弱 FK 或取消反例。

獨立測試用真正 `pg_blocking_pids` 證明鎖等待，並把實際 WebCrypto 驗簽延遲到 expiry 之後，沒有 mock verifier=true。涵蓋目前身分停用、錯 owner/environment/purpose/key、同／不同 idempotency key 競態、public-key squatting、三個 fact sink 故障全回滾、TEMP shadow 與不可改綁。另實際驗證同一 payload 的 high-S／low-S 兩種合法 ECDSA 簽章：更換 proof 後同 command key 回 409，改新 key 也不能再次 consume，總共仍只有一筆登錄及一組 confirm facts／receipt。

Opus 對缺少 expectedVersion／變更 begin payload 的假說已由實際 command core 排除，再補兩個獨立反例固定 428／409 與零新效果。Proof review 的結構 parse 與曲線 import 界線補入註解；不把文字意見當新的實作證據。根整合者首次 descriptor 使用不支援的檔名中段 wildcard，工具拒絕後改為精確路徑，未放寬 validator；新測試匯入既有 JS helper 的 TS7016 依 repo 同類測試補明確預期註解，型別檢查重跑通過。

### 固定整合驗證

程式固定於 **`7d8eff3f47c6108600262260a178153ae6bfc0a1`**，驗證期間 tracked workspace 未變；對真正 `origin/main`（`3de70ccbd24362a7925508fb42d36aaa256a0806`）執行 prepare/verify。完整 runtime **1,586/1,586（122 files）**、治理 **241/241（10 files）**，0 failed/skipped/cancelled。新增 **87 項**由 proof 36、service 16、獨立反例 22、grants 12、生成契約 1 組成，已包含在完整 runtime，不重複加總。Descriptor／contract checks 也通過。

整體仍 exit 2、local `unavailable`，保留 `baseline_governance_unavailable`、`surface_unmapped`、`registration_behavior_audit_required`；本批不消除可信 host transport／publisher、完整入口行為及 GitHub enforcement 缺口。真正 token、Grant／Attempt binding、runtime build/capability／provider attestation 和正式部署證據仍沒有。

公開 preflight **187/187**（新增 12 項 enrollment capability／歷史 shape／schema 下限反例），Worker **28/28**，皆零 skip。Worker 使用前批既有 dry-run bundle 搭配本批 087 隔離 fixtures；本批未改 Worker/HTTP/UI 接線，沒有重新 build 或跑 Browser。TypeScript 7、common/execution/runtime-enrollment 生成 bytes 及 diff check 通過；既有契約 **659 passed、4 個原有 clock cases skipped**，Skill client **10/10**。收尾僅另修文件的「公鑰持有」用語為「對應私鑰持有」，不改已驗程式。

本批另建固定 digest 的 PG18.6 disposable 容器：network-none、無公開 port、2 GiB tmpfs、專屬 Unix socket、`max_locks_per_transaction=256`；所有測試明確用新 `fp_foundation`／`fp_*` 合成 schema、role、db。Worker proxy 已結束。收尾確認 schemas／roles／其他 clients／子資料庫全為 0，核對 container ID/task label 後停止並移除容器及空 socket；只移除可重建的合成資料，沒有碰 `freedom_local.public`。程式、worktrees、ignored 報告保留，沒有留下本輪 CLI 審查或 DB 程序。

Manifest last=87、known_gaps=`[22]`；076–087 全為未合併暫用號，合併前須重新核對。19:55 UTC 唯讀確認遠端 main 仍為 `3de70cc`；沒有 push、開 PR、合併、部署、處理其他 PR 或啟用正式清理，備份政策仍另確認。固定程式 inventory 為 **1,249 hashes、709 本機文件／目錄連結、0 failures**；收尾文件重產後為 **1,249 hashes、711 本機連結、0 failures**。本紀錄持續分開本機證據與產品驗收；168 項原始產品要求仍是 `not_run`，不以本批測試數宣稱完成。

## 本批機器連線與 bootstrap 加密基礎

三個工作位在獨立 worktree 分工 connection service／SQL、bootstrap crypto／中央契約及獨立反例；根整合者補共用交易修正、生成與責任對應、CI fixtures、發布診斷和完整回歸。Grok 4.7／Opus 4.6 CLI 各完成一輪限定公開 source 的設計審查及一輪實碼審查，四路都完成、沒有 402／429；實碼審查未找到具體缺陷。缺失來源的假說不當成漏洞或通過證據；文字意見不是實跑證據或操作批准。

[規格 08](08-agent-connections-bootstrap.md) 明確區分 durable record、crypto evidence 及尚未完成的 machine authority；沿用 AP §1.5／4.3、U1／U3，沒有增加過渡發布支線。

- 暫用 088 保存不可改綁的 owner/person/personal scope/runtime/client/environment，30 日 expiry、32 筆 lifetime quota 與 terminal tombstones。Create/read/revoke 沿目前 member/session/onboarding、固定鎖順序及 scoped facts/receipt；create/replay 要求 runtime 仍 enrolled、connection 未撤銷／到期。允許本人讀取／撤銷過期紀錄作清理，但不因此授機器權。這些是封閉工程限制，不是正式 refresh 或配額政策。
- Bootstrap verifier 以實際 `jose` ES256/P-256 驗 issuer/device 簽章、用途／audience／環境／client／binding、method/URI/nonce/ath 及 token/proof/key 的時間區間。嚴格有界 JSON／UTF-8／base64url，拒 decoded duplicate keys、私鑰、未知欄位和非法數字；host/call input 深度快照，時間跨單位運算用 BigInt。
- 三份中央結構 JSON Schema 由同一 Zod 契約生成，exact-byte check 納入固定 runtime baseline。13 個 descriptors 的獨占 ownership、refs、相依關係和無循環另經獨立查核。結構 schema 不等於驗簽；驗簽成功也不等於目前 DB 身分、nonce 消耗或 execution 權。
- 所有 crypto 成功結果保持 `cryptographic_only`、`operational_authority:false`，不輸出可冒充 VerifiedContext 的品牌。合法 high-S／low-S ECDSA 均可驗過；同一合法 proof 重驗也可成功，因此後續必須用 DB nonce／proof jti 原子防重播，不能拿簽章 bytes 去重。本批沒有 token issuer、refresh family、HTTP mount、machine DB validator、Grant／Attempt 或模型呼叫。

### 真正反例與修正

獨立 PostgreSQL 測試先重現 receipt INSERT 等鎖跨過 session expiry 後仍成功提交的漏洞。`6178c15` 在 scoped receipt 讀取／寫入後重驗 DB session clock；原樣反例轉綠，connection、journal、outbox、receipt 全數回滾。檢查屬 commit 前的授權決策，不宣稱回應送達時仍有效；舊 `command()` 和 avatar receipt adapter 未改。

獨立 28 項反例使用真正 non-superuser LOGIN、真實 enrollment 簽章、`pg_blocking_pids` 與合成故障，另有作者 20 項 connection、44 項 crypto 和 1 項生成契約檢查。新增合計 **93 項**，已包含完整 runtime，不重複加總。沒有 mock signature=true，也未放寬失敗案例。

整合審查另發現 CI 原本建立 `freedom_local`，與要求明確 `fp_*` target 的測試不相容；已改為 `fp_foundation_ci`，health/URL 同步。CI-only disposable Postgres 明示 trust 供無密碼低權限 fixture LOGIN 使用，published port 僅綁 `127.0.0.1`；不改測試防護、正式 DB 或 GitHub settings，也不宣稱遠端 CI 已跑過。

### 固定程式驗證

固定整合 commit **`e4a3251764fe53be0118e7b8c33adb37818d1864`**，對真正 `origin/main`（`3de70ccbd24362a7925508fb42d36aaa256a0806`）執行 prepare/verify；期間 tracked workspace 未變。完整 runtime **1,679/1,679（126 files）**、治理 **241/241（10 files）**，0 failed/skipped/cancelled；descriptor／contract checks 通過。定向 121 項是其中子集合，不另累加。

整體仍 exit 2、local `unavailable`，保留 `baseline_governance_unavailable`、`registration_behavior_audit_required`、`surface_unmapped`。可信 host/publisher／GitHub enforcement、完整入口行為與跨端產品驗收仍待交付，沒有改 base 或偽造通過。

發布診斷 **199/199**（新增 connection shape/capability 的 12 項反例），新 build 與三類 Worker 各環境 dry-run 通過，再以新 bundle 跑 Worker **28/28**；均未部署。Typecheck、common/execution/runtime/bootstrap generated checks、Skill client **10/10**、diff check 通過；既有契約 **659 passed、4 個原有 clock cases skipped**。Build 有既有大型 chunk 警告；本批沒改 UI、沒跑 Browser，不沿用舊 Browser 結果宣稱重跑。固定程式 inventory **1,266 hashes、720 本機連結、0 failures**，收尾文件重產後 **1,266 hashes、722 本機連結、0 failures**。

驗證只使用固定 digest PG18.6 的 network-none／無公開 port／2 GiB tmpfs disposable 容器、專屬 Unix socket、明確 `fp_foundation`／`fp_*` fixtures。結束查到測試 schemas／roles／其他 clients／子資料庫全為 0，核對 container ID/task label 後移除容器與空 socket；僅清除可重建的合成資料，程式、worktrees、ignored 報告保留，未碰 Ted 的 `freedom_local.public`。

Manifest last=88、known_gaps=`[22]`，076–088 全未合併／發布，合併前重查最小可用編號。沒有 push、PR、merge、部署、外部規則／金鑰變更或其他 PR 整合。原始 168 項產品驗收仍維持 `not_run`，本機元件測試不冒充整體驗收。

## 本批 bootstrap 即時驗權與本機隔離 supervisor

三個平行工作位分別負責 bootstrap status／SQL、獨立競態反例及隔離 supervisor；根整合者補中央契約、精確時鐘區間、生成工具、責任對應、發布診斷與整體驗證。另以 Grok CLI `grok-4.7` 和 agy CLI `claude-opus-4-6-thinking` 各完成一輪限定公開程式的審查，沒有 402／429。文字審查不是測試通過、正式信任來源或 Ted 的操作批准。文件維護沿既有中央 spec 更新邊界，沒有另建平行規格。

### 封閉機器 admission

[規格 09](09-bootstrap-status.md) 與 [服務說明](../../../../modules/agent-control/bootstrap-status.md) 將 `bootstrap.status.read` 接到真正 DB 狀態及 ES256 驗簽。會員 challenge 仍是內部組合接點；machine read 沒有 Actor、member cookie、caller clock／binding 或可注入的 verifier。它按固定鎖順序核對 active user、onboarding、person/personal scope、runtime、connection 和 nonce，不建立 lazy mapping，不回傳可重用 VerifiedContext，不授私人 Work／Run／Grant／模型或 effect 權。

- 暫用 089 保存不可改綁的 nonce 與身份關聯、一次性 consumption tombstone；同 runtime 的 proof JTI 跨不同 client/connection 唯一。錯簽章／錯 binding／到期／storage failure 不消耗 nonce；已提交的成功不能重播，包含合法 high-S／low-S 等價 ECDSA 簽章。
- Nonce service TTL 取 60 秒與 connection expiry 的較早者；SQL 容許更短但不能延長。8 pending／4,096 lifetime 是明列工程容量，不是正式 retention／GC／付費政策。沒有自動刪除，沒有 raw token/proof/private key 進 durable rows。
- Crypto result 以 BigInt 計算精確 `[validFromMs,validUntilMs)`，涵蓋 token、issuer key 和 floor-based DPoP window。Machine read 在鎖後、真正 crypto await 後及 nonce UPDATE 後重驗 DB clock；最後可能阻塞的 SQL 不會延長有效期。SQL AFTER guard 另防 nonce 在 constraint/index 等待中到期。
- 會員 challenge 的 domain clock 在 receipt I/O 前檢查，其後 scoped adapter 重驗 member session；receipt 等待後可能回傳已到期的公開 nonce，但不延長它，也不授機器權。Spec 明確區別這個公開 challenge 回應與 machine admission 的最後時計，不宣稱回應送達仍有效。
- 五份結構 JSON Schema 同源生成，中央 input/DTO 不在 service 重抄。Schema 只驗 shape；issuer keyset 的來源／撤銷仍由 host 負責。沒有 HTTP、device flow、token issuer、refresh family 或 Grant／Attempt。

新增 22 項作者、26 項獨立 DB 反例及 2 項精確 crypto interval 測試，共 **50 項**，包含在下面完整 runtime。定向 suite **95/95** 是包含既有 crypto／生成案例的子集合，不另累加。反例使用真正非 superuser migrator/app LOGIN、實際 ES256、`pg_blocking_pids` 與延遲真正 WebCrypto 的 expiry races，沒有 mock verifier=true。覆蓋相同 nonce／proof ID 競態、跨 client binding、目前權限撤銷、三個 challenge fact sinks 回滾、最後 nonce UPDATE 跨 token expiry、低權限 DDL／immutable／TEMP shadow 與容量上限。新增 interval 測試初版曾把 token iat 與 proof 的 future-skew 下界混淆；修正測試期待值後重跑，沒有為通過而放寬 verifier。

### 真實隔離與審查修正

[本機 supervisor](../../../../packages/contribution-tools/behavior-supervisor.md) 從指定 commit 的 Git blobs 建立唯讀 snapshot，以 host 固定的 27-case harness 呼叫獨立 Docker container 內的真實 `createApp`。Candidate 只能回有界 HTTP response frames，不能提供通過結果、fixture identity 或測試清單。容器 network-none、無 host home／Git／Docker socket，唯讀 source/dependency/launcher/runtime mounts，限制 CPU、memory、PID、輸出與時間；host 從容器實際狀態、source bytes 及 DB facts 取證，不靠 candidate 自我聲明。

獨立審查發現共享 PostgreSQL socket 若用 trust，candidate 可以冒用 `postgres`；已改 local SCRAM、彼此獨立的隨機 admin/app 密碼，僅從環境傳給各自程序、不進 argv／log／report。真正 candidate 用空密碼、app 密碼嘗試管理員登入與角色升權皆被拒絕。這與普通 trusted runtime fixture 的 disposable trust DB 是兩個不同用途的環境，不能互相當作不可信程式的隔離證據。

另修正 fixture facts 覆蓋不全、host 執行依賴未必等於被 fingerprint 的 cache，以及 supervisor／migration／runtime 身分不足。現在 host 在終止 candidate 與其 DB backends 後，比較全部 public table rows/columns 的 bounded DB-side SHA-256（僅排除合法 session last_seen_at touch）；source、supervisor/fixture/launcher、migration、lockfile、harness 靜態依賴及同一 realpath dependency cache 都有 before/after fingerprint。Node 與列明 linked libraries 有獨立 fingerprint；整個 OS／Docker／供應鏈仍未批准，不能據此取得 publisher trust。

Root 在固定整合版本重跑實際 Docker suite **6/6**，0 skipped：真實 app 27 項行為；host 檔案／網路／唯讀寫入／管理員登入反例；偽造結果、output flood、busy event loop；以及 users.active 等 retained fixture 被篡改時拒絕 observation。三項新 unit checks 包含 alternate dependency cache 拒絕。Docker suite 使用明確 opt-in，沒有混入普通 runtime baseline，也不把缺 Docker 當 passing skip。

審查另發現 PostgreSQL image 自帶匿名 volume，即使 PGDATA 已用 tmpfs 仍可能殘留空 volume；已覆寫該路徑為 bounded tmpfs、拒絕意外 volume mount，並只按本輪隨機 owner label／exact container ID 清理。作者依 Docker event 證據刪除 11 個可歸屬本輪的匿名測試 volumes，刪除不可復原，但僅含可重建測試資料；事件歷史不足以歸屬的舊匿名 volumes 未動，不能宣稱所有舊 volume 都已清除。Root 最終查到本輪 owner-label containers 為 0。

### 固定整合驗證與剩餘邊界

固定程式 **`b3c16101265d99e9b8d868599a35040337bbf814`**，對真正 `origin/main`（`3de70ccbd24362a7925508fb42d36aaa256a0806`）跑 prepare/verify；期間 tracked workspace 未變。完整 runtime **1,729/1,729（128 files）**、治理 **244/244（11 files）**，0 failed/skipped/cancelled；descriptor／contract checks 通過。整體仍 exit 2、local `unavailable`，保留 `baseline_governance_unavailable`、`registration_behavior_audit_required`、`surface_unmapped`。本機容器證據沒有自動接成 trusted publisher、GitHub enforcement 或完整入口審查，這些缺口仍在。

公開發布診斷 **212/212**（新增 13 項 bootstrap capability／歷史 shape／相依下限反例）、新 build、三類 Worker 各環境 dry-run 及 Worker **28/28** 通過；沒有部署。Typecheck、全部四組 generated checks、Skill client **10/10** 通過；既有契約 **659 passed、4 個原有 clock cases skipped**。本批未改 apps／workflow／wrangler 接線或 UI，沒有跑 Browser，也不沿用舊 Browser 證據。固定程式 inventory 為 **1,282 hashes、738 本機連結、0 failures**；本收尾文件另重產。

Runtime／Worker 只用固定 digest PG18.6、network-none／無 published ports／2 GiB tmpfs 的 disposable DB、專屬 Unix socket及明確 `fp_foundation`／`fp_*` fixtures。收尾確認 schemas／roles／其他 clients／子資料庫皆 0，核對 exact container ID/task label 後停止並移除 DB 容器及空 socket，只清可重建合成資料，沒有碰 `freedom_local.public`。Worktrees、程式與 ignored evidence 保留。

Manifest last=89、known_gaps=`[22]`；076–089 全未合併／發布，合併前須重查編號。21:49 UTC 唯讀確認遠端 main 仍為 `3de70cc`。沒有 push、PR、merge、部署、外部規則／金鑰變更或其他 PR 整合；備份政策仍另確認。原始 168 項產品要求仍是 `not_run`，本機增量不代表全部原 scope 完成。

## 本批裝置配對與一次性 bootstrap 交換

三個工作位分別實作中央 crypto／issuer、配對服務／SQL，以及獨立低權限反例，各用獨立 worktree。根整合者維護 [規格 10](10-device-authorization.md)、生成 schema、descriptor、固定測試 baseline 與發布矩陣；[服務說明](../../../../modules/agent-control/device-authorizations.md) 和 [簽章說明](../../../../modules/agent-control/device-pairing-proof.md) 記錄同一契約的責任界線。沒有新增提前部署的過渡版本。

- 新裝置以實際 ES256/P-256 proof 開始，取得一次交付的短效代碼；會員 inspect／decide 綁 exact request digest、client/environment/runtime kind/key，以及 begin 時保存的名稱。本人批准只建立真正 087 challenge，不直接登錄裝置或授權執行。
- Poll 使用獨立用途 proof，綁 code hash、request digest 與 server nonce；交換另驗真實 087 enrollment 簽章。同交易建立 runtime、088 connection、第一個 089 nonce，受限 issuer 簽 bootstrap token，再保存 consumed/token JTI，最後重驗 DB clock，commit 後才回秘密。實測登出原會員 session 後，裝置仍可用真正 token/DPoP 讀一次 bootstrap status，沒有傳送會員 cookie。
- Issuer 只接受匹配 purpose-bound 公鑰的 nonextractable P-256 WebCrypto signing handle，初始化真正 sign/verify，每次發行再驗回 exact header／claims；token 最多 10 分鐘且不超過 connection/key expiry。沒有 callback signer、私鑰 JSON、正式 key discovery 或 execution scope。
- 暫用 090 保存不可變 request/owner、terminal states、append-only poll JTI 與 durable member review bucket；valid early polling 提交 slowdown，wrong proof/code 不消耗合法 throttle。未知短碼及後續 domain rollback 仍保留獨立 current-member 交易的查找 charge。容量與 original 300 秒 deadline 均列入規格，核准不延長期限。
- Raw codes、proofs、token/private key 不進 durable tables、facts 或 generic receipts；失去已提交的秘密回應不偷偷重發。這個 fresh-only 增量明確回 `refreshSupported:false`、`operational_authority:false`，重配對須新 key，沒有完整長期登入、HTTP/UI、正式 issuer trust、模型、Grant 或 Attempt。

### 審查修正及反例

Grok 4.7／Opus 4.6 各完成一輪公開來源的設計審查。採納配對 challenge 可被舊 member confirm 單獨 consume 的旁路風險：090 新 guard 要求 live approval 與經驗證交換的 ledger marker，deferred constraint 要求完整 exchange；marker 不可單獨 commit，原始 deadline 不能繞過，未連入配對的 087 行為不變。087–089 的 migration 檔案完全未改。另排除「savepoint release 等於獨立提交限流」的錯誤建議；實作使用真正獨立交易，不把模型文字當正確答案。

獨立 SQL 審查找到 nullable timestamp CHECK 的三值邏輯漏洞。另一位 agent 用真正 runtime LOGIN 重現五項 RED：approved／denied 的 NULL 或 submillisecond decided_at，以及 genuine exchange 的 NULL consumed_at。修正為明確 nonnull／finite／millisecond constraints 後，原樣六項反例全 GREEN（consumed_at 的 submillisecond 原本已被拒絕）。這是 SQL 結構約束缺口，不宣稱已重現 HTTP 授權繞過；沒有關閉 guard 或刪除反例。

作者 PostgreSQL **23/23**、獨立 PostgreSQL **40/40**、pairing crypto **25/25**、issuer **8/8**、生成契約 **4/4**，本批新增合計 **100 項**。涵蓋 genuine signatures／等價 ECDSA 競態、兩人競爭核准、錯用途／key／environment、original deadline、真實 SQL lock 及簽章 await 跨期、每個交換／批准 sink 故障回滾、不可改綁／TEMP shadow／低權限 DDL、quota 與全表秘密掃描。後續額外程式審查的 Grok 逾時、Opus 未回結論，均不算通過證據；沒有 402／429、帳號／權限／付費變更。

### 固定整合驗證

固定程式 **`84625f96c80418f4490d1bdd94b8b171c80fac74`**，驗證期間 tracked worktree 未變。對真正 `origin/main` 跑 prepare/verify：完整 runtime **1,829/1,829（133 files）**、治理 **244/244（11 files）**，0 failed/skipped/cancelled；上述 100 項已包含其中，不重複加總。Descriptor 與 producer preview bytes 通過。整體仍 exit 2、local `unavailable`：`baseline_governance_unavailable`、`registration_behavior_audit_required`、`surface_unmapped` 未消失，本機測試不是 trusted CI 或發布批准。

公開 preflight **225/225**（新增 13 項 090 shape／capability／歷史相依反例）、Worker **28/28**、TypeScript 7、新 build、三類 Worker 各環境 dry-run、全部五組 generated checks、Skill client **10/10** 均通過。既有契約 **659 passed、4 個原有 clock cases skipped**，未新增 skip。Build 仍有既有 large-chunk 警告；沒有改 UI／apps 接線，未跑 Browser。

另一位 agent 在相同固定 commit 重跑真實隔離 supervisor **6/6**，兩次正向觀測各含 27 個固定 app 請求，另外測偽造 frame、output flood、busy loop 及 retained DB 竄改。12 個本輪容器按六個 exact owner labels 清除，各 label 查核均空，沒有匿名 volume mount；結果仍 local/unavailable，不能取代可信安裝、publisher 或完整入口覆蓋。

Runtime／Worker 使用固定 digest PG18、network-none、無 published ports、2 GiB tmpfs、專屬 Unix socket 與明確 `fp_*` fixtures。收尾 schemas／roles／其他 clients／子資料庫皆 0；核對 exact container ID/task label 後停止並移除容器及空 socket。只清可重建合成資料，沒有碰 `freedom_local.public`；程式、worktrees、ignored evidence 保留。

Manifest last=90、known_gaps=`[22]`；076–090 全為未合併／未部署暫用號，合併前須重查。22:57 UTC 遠端 main 唯讀查核仍為 `3de70cc`。收尾 inventory 為 **1,304 hashes、759 本機連結、0 failures**，diff check 通過。沒有 push、PR、merge、部署、外部設定／金鑰變更或其他 PR 整合，備份政策仍另確認。原始 168 項產品要求仍 `not_run`；本批不把組件測試轉成全產品完成率。

## 本批 refresh 輪替與 nonce 取得

接續 [規格 11](11-bootstrap-sessions.md)，配對交換現在必定同交易建立初始 refresh family/generation，回 `refreshSupported:true`。前批的 false 是當時交付狀態；目前只有這一套前向擴充契約，沒有另保留可選的舊發行模式。中央 schemas、module descriptor、固定 runtime 清單及發布相容性矩陣已同步。

- `createBootstrapSessions` 使用真正 ES256 proof、既有受限 issuer 與不可匯出的 signing handle；refresh 和 nonce 分開固定 typ/purpose/URI。Refresh 不依賴 access token 尚未過期；nonce 取得須有目前有效 token、獨立用途 proof 及 active／未到期 family，不需要舊 nonce 或會員 cookie。
- 每次 refresh 只消耗一代，原子建立下一代、更新 family pointer、寫 proof ledger 及簽 token；family deadline 不延長且不超過 connection expiry。簽章、SQL 或最後 DB clock 檢查失敗全部回滾，回應只在 commit 後交付。
- 保存的 spent handle 通過真正 key/binding/proof 驗證後，先提交整個 family 和 connection 撤銷，再回固定 invalid response；duplicate JTI、quota、完全相同或等價 ECDSA proof 不能提前擋掉 reuse 撤銷。已發 token 由目前 connection/version 檢查拒絕。Wrong secret/key/proof 無權撤銷；遺失已提交的秘密回應沒有 grace reissue。
- 新增暫用 migration 091，以 immutable rows、連續 generation、deferred whole-state constraints 與 connection revoke trigger 保存完整狀態。Raw handle/token/proof 不進 durable tables、facts、一般 receipts 或 logs。087–090 歷史 SQL 未改。

獨立反例找到 family 已到期但 connection 尚有效時，nonce 路徑原會放行；已補上 family lock／時效檢查。SQL 並發審查另補 initial family INSERT 對 connection 的 `FOR SHARE`，避免建立與撤銷互相看不到對方而提交 active family／revoked connection。獨立測試 **67/67** 包含這兩項反例、spent 多代／等價／並發 proof、錯用途／秘密／key、當前會員資格、quota、真實 lock／sign／最後 SQL 跨期、每個 sink 故障回滾與秘密掃描。新增 crypto tests **47/47**、結構契約 **5/5**、完整配對→refresh→nonce→status lifecycle **1/1** 均已包含於下述全套結果，不另加總。Grok 4.7／Opus 4.6 這輪有返回設計審查內容；設計意見不能代替最終程式的獨立測試或可信發布證據。

### 固定整合驗證與 session 恢復

固定程式 **`a7f71c50e59e13f1af80de2c29b7f1e910c4af36`**，對 `origin/main` 基準 **`3de70ccbd24362a7925508fb42d36aaa256a0806`** 完成 prepare/verify。最終本機報告 `.freedom/reports/refresh-sessions-integrated.json` 保存完整逐檔／逐例結果：

| 檢查 | 實際結果 |
| --- | --- |
| 完整 runtime | **1,951/1,951，137 files**；0 failed/skipped/cancelled/todo |
| 治理 unit | **244/244，11 files**；0 failed/skipped/cancelled/todo |
| Descriptor 與 producer preview bytes | passed |
| 整體治理驗證 | local `unavailable`；保留 `baseline_governance_unavailable`、`registration_behavior_audit_required`、`surface_unmapped` |

上一輪亦留下發布相容性 **243/243**、Worker **28/28**、隔離 supervisor **6/6**、typecheck、六組契約生成檢查、新 build 與三類 Worker 各環境 dry-run 通過的回報。它們是本機／隔離證據，不能轉成 staging、真人產品驗收或正式發布綠燈。

2026-10-02 的 session 日誌最後停在 **19:35:38 EDT** 的等待呼叫，沒有對應完成回報；上述最終報告已在 **19:35:59 EDT** 落盤。接手時沒有該測試程序，分支仍乾淨且停在固定程式。恢復查核實際驗證 report schema、137 files／總數、零失敗／跳過，以及目前 HEAD／workspace SHA-256 與報告完全吻合；報告檔案 SHA-256 為 `34ec0d232b74eb8a068deb6f9897d59449450d5eca06c15e8653ec5066a03df5`。因此本批測試已完成，缺的是完成回報與收尾；目前證據不能判定 session 停止回應的具體原因。這次只補文件並核對既有證據，沒有重跑或重算完整 runtime。

恢復時核對本輪 exact Docker container ID／`foundation-refresh-20261002` label，確認 network-none、無 published ports、2 GiB tmpfs、無匿名 volume，以及專用 `fp-refresh-db-BNgBB8` socket。`fp_foundation` 中非預設 schemas、合成 roles、其他 clients、其他 databases 與 public relations 均為 0。隨後停止並移除該容器，僅在 socket 目錄確實為空後用 `rmdir` 清除；同 label 容器剩餘 0。只清可重建合成資料，保留 worktrees、程式與 ignored evidence，沒有碰真實資料或 staging/live。

Manifest last=91、known_gaps=`[22]`；076–091 尚未合併／發布，合併前須重查編號。正式 issuer/key custody、HTTP/UI、ModelConnection／Grant／Attempt、完整入口覆蓋與可信 CI 仍待完成；沒有 push、PR、merge、部署或正式設定／金鑰變更。原始 168 項產品要求仍 `not_run`。

## 本批 bootstrap HTTP 邊界與進度重估

本批依 [12](12-bootstrap-http.md) 接入同一套真實服務：machine begin、用途區分的 token、nonce、status，以及本人 review/decision、connection list/read/revoke。HTTP 以受信設定建構，固定 canonical HTTPS origin/path；member cookie/CSRF 與 machine DPoP 分開，拒絕跨來源、混用憑證、query/encoded path 和錯誤方法。HEAD 不消耗 GET nonce。本人 list 只回最多 32 筆固定 client/environment 的 metadata；revoke 沿用精確 ETag／If-Match、428/412 和既有 receipt replay／撤銷 cascade。

JSON 限 32 KiB、128 chunks、5 秒 body deadline；拒絕 duplicate decoded keys、無效 UTF-8、BOM、prototype keys 及多餘權威欄位。取消卡死的 stream 不阻塞回應。限流使用獨立提交的 DB-clock global/network 預算，失敗 body／crypto 不退還 charge；global 超限時不新增任意 network bucket。沒有受信來源解析器時共用 shared-server，IP forwarding headers 不授新身分。HTTP 工程預算與 retained bucket 的正式容量／清理政策尚未批准。

新增 HTTP／wire tests **44/44** 通過：non-superuser migrator/runtime LOGIN、真正 ES256、公開 challenge 的完整配對、sessionless refresh/nonce/status、重用撤銷、會員 CAS/撤銷、並發與 durable 限流、錯誤去敏，以及相關 machine／receipt／fact 表不保存 raw machine secrets。另實際啟動本機短暫 TLS socket，以 ephemeral self-signed cert 驗 Node adapter 的 signed begin 與 Host 拒絕；沒有測正式 proxy 或 production TLS。正式 `createApp` 的未掛載路徑也實際回 404，沒有配置或啟用 issuer。

TypeScript、七組 structural contract 生成檢查、發布相容性 **243/243**、build 與 platform 三環境 Worker dry-run 通過。這些是本機合成證據；原始 168 項完整產品驗收仍 `not_run`。本頁前段更新 UF 加權工程估算及 AP M0–M6 對照，不以新增測試數推算進度。下一個工程接點為 ModelConnection／Grant／Attempt；staging/live、正式 keys/host、部署與其他 PR 仍未動。

固定程式版本 **`5832f4fd2da4a479dd28f31097047eeb228ad6ba`**，base 為 `3de70ccbd24362a7925508fb42d36aaa256a0806`。完整 runtime **1,995/1,995（139 files）** 通過，0 failed/skipped/cancelled/todo。首輪標準 verifier 的治理套件觸及 60 秒上限，該份 `failed` 報告原樣保留；其他驗證程序結束後，使用標準 runner、原 60 秒上限單獨補驗治理，**244/244（11 files）** 通過，0 failed/skipped/cancelled/todo。兩次之間沒有改 source；另核對同一 head/workspace SHA、完整 selected files 與逐案例 counts。

本機整合紀錄 `.freedom/reports/bootstrap-http-reconciled.json` 明列兩份來源報告及 SHA-256，沒有覆寫首輪失敗或重跑已通過的 runtime。整合紀錄 digest 為 `6e3908d934d45cc0f574607ea1fdd074b538da295008e24a7f914222fe97c0d8`；仍是 local／`unavailable`，保留 `baseline_governance_unavailable`、`registration_behavior_audit_required`、`surface_unmapped`，沒有 trusted CI、merge 或 deployment authority。

Worker 最終 **28/28** 通過：首輪直接傳 Unix socket URL 被 Miniflare Hyperdrive 的必填密碼檢查擋下，改用既有 task-owned loopback TCP→Unix 測試橋接及合成密碼後完整重跑，橋接已關閉。實際隔離 supervisor **6/6** 通過（固定 app requests、偽造結果、卡死程序及 fixture 竄改）；各測試容器 cleanup 已驗證。這些不取代本批 HTTP factory 的來源覆蓋或產品驗收。

本輪 disposable PG18 使用固定 CI image digest、network-none、無公開 ports、2 GiB tmpfs、專屬 socket，明列 `max_locks_per_transaction=256`。收尾查得非預設 schema／role、其他 clients／databases、public tables 全為 0，再核對 exact container ID/task label 移除容器與空 socket 目錄。只移除可重建的合成資料，程式與 ignored 測試證據保留；主 checkout 的既有 staged 狀態雜湊亦保持相同。

## 本批本人模型選擇、限定 Grant 與 blocked Attempt

依 [13](13-member-execution-prerequisites.md) 新增封閉 `createExecutionPrerequisites`：
會員本人可建立／讀取／撤銷 ModelConnection 和 Grant，建立／讀取不可改綁的
Attempt。Model 只保存明確 provider/model/processing/custody/billing 選擇，狀態
固定 unverified 或 revoked；沒有 secretRef、模型驗證或自動 fallback。

Grant 必須明確同意，server 從真正 Runtime／connection／active refresh family、
目前 draft Work／created Run／model／operator policy 推導 immutable binding、
原始 Work version、Run version 與兩個獨立 epochs；TTL 至多一小時且剪裁到
connection/family expiry。正常 refresh rotation 不撤銷同意；重用撤銷、Work
編輯、Run 控制、model/Grant 撤銷或 policy revision 改變均擋住建立和舊成功
receipt。歷史 read／本人 revoke 仍可在後端到期或撤回後使用。

每個 Run 的 Attempt 序號 1–16，原始 Grant snapshot 不可更新、刪除或重綁。
缺真正模型認證及 adapter，故全部 `preflight_blocked`，明列兩個 unavailable
blockers；全部 metadata 都是 `operational_authority:false`。不建立假的 inference、
lease、currentAttempt pointer、recovery authority、模型呼叫或 Result。

092 是 additive migration，076–091 bytes 未動；完整 owner/scope composite FK、
有限時間、immutable tombstones、目前 backing row locks、physical schema-qualified
SQL guards 及 deferred INSERT 時效檢查涵蓋直接 runtime DML。SQL snapshot 在
DB 端把所有 bigint version/epoch 保存為 decimal strings，不經 JS Number。
每人最多 32 model／256 Grant lifetime records，撤銷不回收名額。Runtime 仍用
既有 DML grants，不能改 operator policy、schema 或 disable trigger。

scoped member helper 新增可信第五個 revalidate callback，在真正 receipt SELECT
及 INSERT 等待後重查 domain authority，也在 callback 等待後重查 session。
獨立審查找到初版缺後者：隔離複製程式只移除 post-hook session check，即
4 個案例有 2 個因「未拒絕過期 session」失敗；目前版本 4/4 通過。沒有修改
共享 source 來跑舊反例。Migration 初版語法錯誤及測試 fixture 問題亦先修正，
不把 setup failure 列入通過證據。

三位 GPT-6.1 Sol 分別交付契約、服務／SQL、獨立反例；新增四個檔案合計
**49/49**（作者 20、獨立 20、契約 5、helper 4），均包含於全套結果，不另加總。
涵蓋真正 device pairing／ES256／091 family、non-superuser LOGIN、錯 owner／
environment／client、跨 connection、版本/CAS、policy revision、秘密掃描、
SQL/TEMP/NULL/回溯時間、超過 2^53 精度、lifetime quota 與三類 sink 原子回滾。
實際 `pg_blocking_pids` 確認連線/family 撤銷與 Attempt 等待；receipt SELECT／
INSERT 及 deferred COMMIT 跨 Grant 到期均拒絕並回滾。

Grok CLI 指定 `grok-4.7`，450 秒逾時且無輸出；agy CLI 指定
`claude-opus-4-6-thinking`，exit 0 但沒有可採用的 final 審查內容。兩者均
**沒有可用結論，不列為審查通過**。只送五個有界 repository source files，
Grok 關閉 tools/subagents/web search；Opus 另用唯讀 filesystem sandbox。
四個 code digests 與最終固定程式吻合，spec 鎖序文字後來修正；完整 local
review binding 與無結論紀錄保留 `.freedom/reviews/`、`.freedom/reports/`。

### 固定整合驗證與收尾

固定程式 **`8920c8ea80e6f092736f7c0241030ead76007bb2`**，base
`3de70ccbd24362a7925508fb42d36aaa256a0806`。首輪收集程序以 SIGTERM／143
中止，測試子程序結束但沒有完整報告，**不算通過**；具體中止來源尚無證據。
中止紀錄原樣保留。改用持續落盤的本機 controller，在同一乾淨 HEAD／workspace
重跑標準 verifier，保留原 governance 60 秒、runtime 900 秒上限，未改測試或
放寬限制。最終 `.freedom/reports/member-prerequisites-integrated-retry.json`
SHA-256 為 `f5c534cfbee538ab302d381b8b86ef86b0e4f617e55ed3e9d548069d22dcb094`。

| 檢查 | 實際結果 |
| --- | --- |
| 完整 runtime | **2,044/2,044，143 files**；0 failed/skipped/cancelled/todo |
| 治理 unit | **244/244，11 files**；0 failed/skipped/cancelled/todo |
| 發布／migration 相容性 | **256/256**；新增 13 項 092 shape／history／兩個 binaries 相依反例 |
| Worker | **28/28**；task-owned loopback→Unix Hyperdrive proxy 及合成密碼，完成後關閉 |
| 真實隔離 supervisor | **6/6**；真實 app、host files/network/role 隔離、偽造結果、output flood、busy loop、fixture 竄改；owned test containers 已清理 |
| Typecheck／generated contracts／build／dry-run | passed；八組契約、三類 Worker 各三環境 dry-run；build 保留既有 large-chunk warning |
| Descriptor／producer preview bytes | passed |
| 整體治理 | local **unavailable**；`baseline_governance_unavailable`、`registration_behavior_audit_required`、`surface_unmapped` |

最後核對 HEAD／workspace、143/11 selected files、逐例 counts 與零跳過；沒有
重算或用本機結果偽造可信 CI。Manifest last=92、known_gaps=[22]，仍為未合併／
未部署暫用編號。原始 **168 項完整產品驗收維持 not_run**；全計畫工程約
30–40%、剩餘 60–70%，U3 約 30–40%、AP M2 50–65%、M3 15–25%。

本輪 PG18 固定 CI image digest、network-none、無 published ports、2 GiB tmpfs
與專屬 Unix socket。收尾確認非預設 schema／role、其他 clients／databases、
public relations 都為 0，再核對 exact container ID/task label 移除容器及空 socket。
只清可重建合成資料，程式與 ignored reports 保留；主 checkout 的 staged 狀態
雜湊保持原值。沒有其他 PR 整合、push、PR、merge、正式設定、金鑰或部署，
staging/live 未動。真正模型認證／adapter／token/lease／私人 AI、HTTP/UI 接線、
跨端、媒體搬遷/restore、可信 CI 與正式信任仍待後續完成。收尾 inventory
為 **1,358 hashes、794 本機連結、0 failures**，diff whitespace check 通過。

## 本批：本人 Run／模型選擇／Grant／blocked Attempt HTTP

延續三個 GPT-6.1 Sol 工作位，分別實作中央 wire 契約、閉合 HTTP 入口及獨立
反例；根整合者固定介面、維護 [spec 14](14-member-execution-http.md)、責任對應、
標準 verifier 與交付證據。先查核真正 CLI 的隔離 help/version 及官方說明，
確認安裝不等於模型認證或完整工具隔離；第一條產品模型路徑尚待本人選定。
因此本批完成可獨立交付的真人 HTTP 接線，沒有補預設 provider/model/billing/custody。

### 實作與獨立審查

- 新 `createMemberExecutionHttpTransport` factory 接既有 Run create/read/pause/stop、
  ModelConnection create/read/revoke、Grant create/read/revoke、Attempt create/read。
  真正 cookie／CSRF／onboarding 取得 Actor，DB 服務照原契約重查目前身分、
  owner/personal scope、backing、policy、expiry、versions 及 replay。
- Origin/Host/method/用途明確隔離；Authorization、DPoP、bootstrap connection/nonce
  標頭即使混有有效 cookie 也拒絕。HEAD／OPTIONS 不利用 Hono fallback；
  primary CAS 只取 If-Match，次要 expected versions 在嚴格 body 必填。
  六份 generated JSON Schema 與 Zod/Python Draft 2020-12 parity 同源驗證。
- 抽出共用 `readBoundedHttpJson`，保留 32 KiB／128 chunks／5 秒、actual length、
  fatal UTF-8、decoded duplicate／prototype key、depth/node 與 cancellation 限制。
  既有 bootstrap 42 項回歸通過；會員入口先驗用途、來源及真人，再讀 body。
- 新 `execution_member` 只增加限流 operation，無 migration 或 release shape。
  真正獨立 DB charge 為每 network 60／global 600 每分鐘，domain rollback
  不回退 charge。Source callback 失效即拒絕；錯誤、private/no-store、ETag
  與 strict output DTO 不洩 SQL／Work 文本／憑證，也不變成 operational permit。
- 契約審查者實際重現 remote HTTP trusted configuration 被接受；作者補上
  HTTPS、僅 local explicit loopback 可 HTTP 的限制，再由原審查者驗證。
  新增作者 **10**、獨立 PostgreSQL **19**、契約／reader **7** 項，合計
  **36/36** 通過，均包含在完整 runtime。獨立案例涵蓋真 ES256 配對、
  non-superuser LOGIN roles、SQL 鎖等待跨 session/Grant expiry、receipt INSERT
  回滾、各 owner/path/credential/CAS/body 邊界及實際 network/global 限流。

模型仍 unverified，Grant 只是 bounded consent，Attempt 為 preflight_blocked；
所有 metadata 都 operational_authority false。正式 app／Node／Worker 未掛載，
沒有產品模型 dispatch、lease、private AI Result 或新 Run activation。

Grok CLI `grok-4.7`、agy CLI `claude-opus-4-6-thinking` 各以相同固定 source
做一次 bounded 唯讀審查：Grok 180 秒逾時、沒有 stdout；Opus exit 0 但 final
content 為空。兩路均無可用結論，不列為測試或批准證據。Report 的關鍵字診斷
亦不推論帳單原因；沒有變更其帳號／付費設定。五份 source digests 對應固定
程式，保留於 ignored `.freedom/reviews/` 與 `.freedom/reports/`。

### 固定驗證與收尾

固定程式 **`49591d14ac856cde2f5258909fb5cbb4b76197be`**，base
`3de70ccbd24362a7925508fb42d36aaa256a0806`。Detached controller 完成標準
verifier、原 governance 60 秒／runtime 900 秒限制，約 550 秒；沒有逾時或中斷。
`.freedom/reports/member-execution-http-integrated.json` 的 SHA-256 為
`5bc2fab81c7dff6db9a85f88111035ca3760703ea7c7843c5118e06c7a2a702c`。

| 檢查 | 實際結果 |
| --- | --- |
| 完整 runtime | **2,080/2,080，146 files**；0 failed/skipped/cancelled/todo |
| 治理 unit | **244/244，11 files**；0 failed/skipped/cancelled/todo |
| 發布／migration 相容性 | **256/256**；沒有新增資料形狀或改歷史 migrations |
| Worker | **28/28**；task-owned loopback→Unix proxy，已關閉 |
| 真實隔離 supervisor | **6/6**；owned containers 已清理 |
| Typecheck／generated contracts／build／dry-run | passed；九組生成、三類 Worker 各三環境 dry-run，既有 large-chunk warning 保留 |
| Descriptor／producer preview bytes | passed |
| 整體治理 | local **unavailable**；baseline_governance_unavailable、registration_behavior_audit_required、surface_unmapped |

逐檔 counts、每例 status、selected files 及固定 source SHA 已核對；手跑證據
沒有冒充可信 CI 或產品驗收。完整回歸後僅刪除共用 reader 末端一個空行，
內容除該空行外與固定程式完全相等；證據另記 before/after digests，沒有再改
功能。076–092 SQL bytes、manifest last=92／known_gaps=[22] 及 capabilities 不變。
原始 **168 項完整產品驗收維持 not_run**，整體工程估算仍 **30–40%**。

容器初始化前三次因 socket 權限、entrypoint 預設 socket 及 PG18 parent volume
設定失敗；尚未跑產品測試即更正／重建，失敗證據保留。相關合成容器已移除；
兩個初始匿名 volume 由 exact Docker mount/unmount/container events 確認本輪
來源及無其他 container 引用後移除，未廣泛 prune。成功環境使用固定 PG18.6
CI image、network-none、無 published ports、2 GiB tmpfs 與專屬 Unix socket。
最終非預設 schemas/roles、其他 clients/databases 及 public relations 全為 0，
核對 exact ID/task label 後移除成功容器與空 socket。只清可重建的合成資料。

收尾唯讀核對 remote main 仍為 `3de70cc`；主 checkout staged 狀態雜湊
仍為原值。沒有其他 PR 整合、push、PR、merge、正式資料／金鑰設定或部署，
staging/live 未動。封閉程式、spec 及 ignored evidence 保留在工作分支。
收尾 inventory 為 **1,372 hashes、807 本機文件／目錄連結、0 failures**。
本批相對 `6343d6a` 的 whitespace check 通過；相對 origin/main 的完整 branch
仍有原文快照四處 Markdown hard-break trailing spaces，保留原始文件 bytes。

## 尚未交付

- operational execution/service current-state validators、Invocation/Grant/token/lease adapters，以及有真實 backing record 的 service/site schema；本批限定會員同意 Grant 不取代執行端 Grant，scoped composition/receipt 目前僅支援 member session。
- 正式 avatar policy／quota 值與 storage cutover、備份政策／cloud restore／rollback floor；新增私人 Result/share 的完整讀取矩陣、operational Attempt／lease／模型 broker／私人 AI 草稿及瀏覽器 execution guard。Local R2、bridge、quota、maintenance/pins 已有實作，但不等同正式啟用。
- 已批准 ReleaseSet 的真實 consumer 發布、TS/Rust 共用樣本、Windows/macOS、packaged clients、cloud 備份恢復及 staging/prod 演練。Kit 與 Storefront 已完成本機接入，不能把兩倉本機測試當整組正式治理鏈完成。
- 已批准的 publisher/trust profile、可信 CI publisher／required workflow、GitHub 強制審查與不可繞過的發布限制。

本機 `verify` 面對尚未治理的 main、缺少 surface audit 或未支援的 adapter，明確回 `unavailable`，不是綠燈。手動跑過 runtime tests 不會自動偽造 trusted check。原始 168 項產品驗收仍保留 `not_run`，須逐項取得完整證據再更新。

## 本批：三路模型 adapter 核心與隔離 metadata

本批依 Ted 的最新指示將 Codex 訂閱、Claude Code 訂閱、BYOK 三路分開派工，
不再等待先選一條模型路徑。固定整合程式 commit 為 `6c9df7b7010a1e5174a5cae9606604030f40da1d`，
規格見 [15](15-model-adapter-cores.md)，核心見 [adapters](../../../../modules/agent-execution/adapters/index.ts)。
三路都提供明確 route／private candidate／bounded observation codec；BYOK 另含
OpenAI Responses 與 Anthropic Messages 兩種固定 protocol。沒有 provider/model
預設、keychain/vault resolver、產品模型 request 或正式 HTTP 掛載。全部
`invoke` 固定拒絕 `execution_authority_unavailable`；ModelConnection／Grant／Attempt
仍沿原封閉狀態，不從 codec 成功推定 operational authority。

- 作者測試：Codex **9**、Claude **16**、BYOK **12**，共 **37**。
- 共用／registry／獨立反例：**41**；另有真正 Linux native fixture **6**。
  合計 **84 項新增測試**，零失敗／跳過。真實 fixture 另由非作者獨立重跑 **6/6**。
  mock HTTP 只在 loopback 使用 synthetic header/key fixture，不是供應商認證。
- 已重現並修正：小數用量捨入成整數、Claude／BYOK 未知或巢狀 tool/model metadata、
  Codex 未完成／換 type／hidden event、診斷對原 port 再讀 accessor，以及 bwrap
  對已 unlink snapshot FD 的 path canonicalization 失敗。最後改用 readonly
  `--ro-bind-data` 直接從驗證過的 snapshot FD 建 executable；6 個實際程序反例驗
  無網路／host 檔案／parent env、fresh home、錯 hash／symlink／path／inode mutation、
  stdout flood、卡死、setsid 及父程序退出後仍持有 pipe 的子程序清理。
- 真實已安裝 Codex **0.160.0**、Claude Code **2.1.288** 經新 runner 的 version／help
  查核成功。fresh-home auth_status 回無登入；此結果只適用空的隔離 home，不能
  宣稱 Ted 真實帳戶未登入。兩路仍 `unsupported`／effective_tool_policy_unavailable，
  BYOK 仍 candidate_only／authentication_unavailable；沒有 genuine 模型認證。
- CLI native artifact 最多 512 MiB、程式 3 秒 deadline、合計輸出 32 KiB／256 chunks。
  binary copy 每段 I/O 之間檢查 5 秒期限，不能中斷卡住的 filesystem I/O；不將此
  描述為完整 probe 硬 deadline。僅固定可信 host artifact path，沒有會員 path 輸入。

固定 commit 的標準 verifier 完成：runtime **2,164/2,164**（153 files），治理
unit **244/244**（11 files），零失敗／取消／跳過／todo。完整執行約 **554 秒**。
報告 `.freedom/reports/model-adapters-integrated.json` SHA-256：
`511070bccca5069516c39160d7f94b1956de9a43e650907190275edeb6e3f5c9`；整理證據為
`.freedom/reports/model-adapters-final-evidence.json`。Standard verifier 整體仍
`unavailable`（exit 2）：baseline_governance_unavailable、
registration_behavior_audit_required、surface_unmapped。沒有將本機全過改寫成
可信 CI／publisher／完整入口已完成或正式 release 綠燈。


型別檢查、9 組契約生成檢查、build、發布相容性 **256/256**、Worker **28/28**、
隔離 supervisor **6/6** 與 9 次 dry-run 通過；dry-run 沒有部署。migration 076–092、
既有 platform-api／中央 execution 契約及 release manifest 未改。
Grok 4.7／Opus 4.6 本批未執行外援審查：沒有採用可限制憑證／config／hooks
暴露範圍的 wrapper，不把前批 timeout／空輸出當本批審查證據。

收尾確認 disposable PostgreSQL 的 schemas、測試角色、public relations、其他
clients／databases 全部為 0，再移除本輪專屬 network-none／tmpfs 容器及空 Unix
socket 目錄；沒有剩餘本輪容器。沒有修改主 checkout、Ted 真實資料、正式
credentials 或 staging/live，也沒有 push／PR／merge／部署。Inventory、文件
連結與 whitespace 檢查另在最後文件提交前完成；原始計畫快照 bytes 保留。


全計畫工程估算維持 **30–40%**、剩餘 **60–70%**；U3 **30–40%**、AP M2
**50–65%**、M3 **15–25%**。三路 ports／metadata 不等於 AP M2 正式模型驗證，
也沒有完成 U4／AP M3 的私人 AI Result。原始 **168 項完整產品驗收仍 not_run**。

下一步先做與 085 保存政策分開的 inference export policy、精確 Work version 的
明確本人同意、bounded prompt binding 及一次性消耗；不把 092 active consent
Grant 當出口權。Operational Permit 仍需 genuine auth/tools/transport/budget。
092 blocked Attempt 是不可變歷史；Run 現行狀態只收 created／paused／cancelled，
真正 running／lease／control 必須另以受控前向 migration 及版本化 projection
接線，不能在舊 DTO 中暗藏執行狀態。既有 blocked Attempt 已占流水號，新增
operational subtype 必須接續真實歷史及 cap，不能重編號或補造 inference binding。其後串 provider transport、dispatch journal、
取消／unknown outcome、私人 AI Result finalize，再推跨端、媒體及正式治理。

## 本批：單步文字執行與私人模型成果

Ted 指出進度未接成成果後，本批集中完成 [16](16-private-model-step.md) 的
垂直實作：獨立 inference export policy／本人明確批准、真正 active Attempt／
running Run／lease、一次性 committed dispatch、受限 BYOK host transport、
opaque observation、Asset 寫入、typed private model Result 與人工共同歷史。
正式 HTTPS 程式限明確 platform vault/engine
及 platform Asset custody；其他 custody/subscription 沒有自動 fallback。

本機 fixture 用真實 HTTP、非 superuser PostgreSQL runtime 與 ObjectStore bytes，
全部結果明確帶 `synthetic_local_fixture`／`costStatus:unknown`；沒有呼叫正式
provider、取用真實 key 或正式 recovery source。原 human generated provenance
保留，AI 原始文字沒有進 receipts/facts。076–092 migration bytes 不變，新 schema
為 093／094；兩張 operator policy 都套 dedicated runtime column ACL fence。

完整垂直 fixture 已確認一次派送與 Result Work CAS，成功 replay 零新增 POST／PUT。
AI → 人工 → AI 共用 revision 1/2/3、Work version 2/3/4，讀取面保留實際來源。
會員 Stop／Grant 或 connection/family 撤銷、政策或 recovery/credential 變更後，
舊 capability 不會派送；晚到的回覆不能寫入 Result。provider outcome 不明時保留
unknown／用量預留，不自動重送、不補造取消或零成本。

本批沿用三個 GPT-6.1 Sol 工作位分別實作服務、契約/host 及獨立反例，主 agent
整合 Asset／typed Result／共同歷史與發布相容性。作者服務 **10/10**、契約/host
**10/10**，非作者反例 **18/18**；共 **38 項新增測試**，均在最終完整回歸再次通過。
實測涵蓋真實 ES256 配對、non-superuser runtime、OpenAI／Anthropic 兩路合成
HTTP、真正 SQL receipt 等待跨越期限、policy/family/Grant/control 撤銷、recovery
或 credential 在 Asset GET 後變更、假 observation／錯 host、ACK 遺失及無 DB
鎖跨越 Asset PUT。NULL permit 的 SQL 邊界由審查發現並修正，獨立測試驗證修正後
拒絕；本批沒有修正前執行證據，不聲稱已做 before/after runtime 重現。
Grok 4.7／Opus 4.6 本批未執行外援審查，不沿用前批結果充作本批證據。

功能實作固定於 `36dbdf324551cd000500898c7a9e2c3fca0c74ee`；最終完整驗證固定於
`c65137f958dfe6cf8177e7b4e2c3f898cd10d3d4`。第二個 commit 僅修正 13 個舊測試
fixture/assertion 並更新 inventory；production 程式、migration、契約及 build
source bytes 與功能 commit 相同。驗證途中 tracked workspace 不變。

第一次完整回歸為 **1,889/2,202 通過、313 失敗**，不列為通過。12 個舊 fixture
仍預期只有一張 operator policy，未套用新增的第二張 ACL/lock grant；另一個
Run 測試仍預期實體表不存在 `current_attempt_id`。改為在原交易完整套用兩張
policy 的真實 SQL template，並驗 blocked profile 沒有 active Attempt/Step、
假 current Attempt 被 SQL constraint 拒絕，沒有弱化 production 權限或略過測試。
受影響測試獨立重跑 **336/336**，再從頭執行標準完整 verifier。

最終 runtime **2,202/2,202**（156 files）、governance unit **244/244**（11 files），
零失敗／取消／跳過／todo，完整 verifier 約 **597 秒**。報告
`.freedom/reports/model-step-vertical-integrated.json` SHA-256：
`650805ee7cee2ec75c86afc89b2f37762a32cd9028912ca26ea35988232de272`；彙整證據
為 `.freedom/reports/model-step-vertical-final-evidence.json`。治理總狀態仍為
`unavailable`（exit 2），原因是 `baseline_governance_unavailable`、
`registration_behavior_audit_required`、`surface_unmapped`；不當作可信 CI 或發布批准。

型別檢查、10 組契約生成檢查、build、發布相容性 **280/280**、Worker **28/28**、
隔離 supervisor **6/6** 及三類 Worker 的 9 次 dry-run 通過。組件檢查在功能
commit 執行，production source 與完整驗證 commit 相同；型別檢查亦在完整驗證
commit 通過。未改 UI，本批未跑瀏覽器 E2E，也沒有真人 provider/產品驗收。

收尾查得本輪 disposable PostgreSQL 的 schemas、測試 roles、其他 clients、
其他 databases 及 public relations 全部為 0，再移除本輪 network-none／tmpfs
容器、空 socket 目錄與合成檢查 home，剩餘本輪容器 0。主 checkout status hash
維持 `c5baa881d9476c25a274af274e42b723bfcc643fe55450ff3c72612ee401f19a`。
未 push、開 PR、merge、部署；Ted 的真實資料及 staging/live 未動。

工程估算隨完整垂直實作調整為：全計畫 **35–45%**，剩餘 **55–65%**；U3
**40–55%**、U4 **25–40%**、AP M2 **50–65%**、M3 **35–50%**。估算依工作範圍，
不是測試通過率。原始 **168 項完整產品驗收維持 not_run**，沒有從 loopback
fixture 推定真人 provider／跨端／正式發布已驗收。文件交付另通過 **1,412 file
hashes、823 本機連結、0 failures** 及 `git diff --check`；完整 runtime 證據綁
上述 source commit，文件提交沒有重跑或取代該份證據。

## 本批：私人 AI 的會員 HTTP 與畫面

沿 [17](17-private-ai-product.md) 接完成本人私人工作建立／編輯、current/history、
model Grant、明確逐次出口批准、active Attempt／單次執行／暫停／停止／撤銷的
會員入口。三個 GPT-6.1 Sol 工作位負責 HTTP、UI、獨立反例；主 agent 組合實際
Node app、普通 runtime role 的瀏覽器 fixture、設計／來源紀錄與全套驗證。

定向驗證：作者 HTTP **6/6**，獨立 HTTP **13/13**，與兩個既有私人 HTTP
suite 合跑 **52/52**；shared client **18/18**。瀏覽器以真實 app／隔離 SQL／
合成 loopback provider 完成 **5/5**，未設定服務另跑 **1/1**，沒有 skipped。
同 key 補送沒有新增 provider POST 或 Result；結果遺失、新版本、政策撤回與
重載後的 Stop/revoke 均有實際案例。1440／768／390 截圖、無 overflow 與三項
標準頁面工具已驗證。沒有真實 provider、付費、金鑰或產品本人端驗收。

交叉審查實際重現測試 shutdown 可能刪除同名既有 role：修正後相同 countercase
保留既有合成角色並清理自有 schema；選用證據檔寫入失敗也不再阻止必要清理。
既有 32 KiB Unicode 正例曾因 32,768 個單 byte chunks 超過新增 128 chunk 上限
失敗；保留原失敗紀錄，正例改成 108 chunks，負例仍驗 129 chunks 拒絕。沒有
放寬 production 資源界線。歷史 Step metadata 在政策撤回後仍可供本人控制，是
契約澄清；私人 Work title/objective、Result 文字及新效果仍被當前政策阻擋。

實作 commit 為 `7a0cc3e`，固定完整驗證 source 為 `8a6c91f`。初次完整回歸
**2,221/2,222**，唯一失敗是新增頁面沒有同步既有 human page-help；原失敗報告
保留。补齊繁中操作說明及真正打開說明視窗的 browser assertion，定向 **3/3**
後從頭重跑標準 verifier：158 個 runtime files **2,222/2,222**、11 個治理
files **244/244**，全部沒有 failed/cancelled/skipped/todo，耗時 **578.939 秒**。
新增 source 僅 page-help、受影響 E2E assertion 與 inventory；其他後端來源不變。

發布診斷 **280/280**、Worker **28/28**、真正隔離 supervisor **6/6**、11 組
generated checks、build 與三類 Worker 各環境 dry-run 通過。這些 component 檢查
固定在 `7a0cc3e`；`8a6c91f` 另完成 typecheck/new build，受影響的 help/成功流程
與 default unavailable browser 重跑 **2/2**。先前 6 項瀏覽器案例與這 2 項重跑
分開保存，不加成 8 個唯一案例。1440／768／390 新截圖已檢視。啟動時舊 socket
設定、supervisor bootstrap/未設明確 flag 的失敗均保留，不列為通過。

標準 verifier 仍回 exit 2 **unavailable**，只保留既有
`baseline_governance_unavailable`、`registration_behavior_audit_required`、
`surface_unmapped`；本機 runtime 綠燈不是可信 CI 或發布批准。Opus 4.6 exit 1
沒有 final、Grok 4.7 逾時沒有輸出，兩路都有 exact source hashes，均不列通過。
完整索引為 ignored `.freedom/reports/member-model-product-final-evidence.json`。

所有 schemas、合成 roles、其他 clients/databases、public relations 查核為 0，
只清理本輪 exact container/task label、空 socket 與自有檢查 home，剩餘本輪
容器 0；browser 自有 listener/helpers 已結束。主 checkout status SHA-256
仍為 `c5baa881d9476c25a274af274e42b723bfcc643fe55450ff3c72612ee401f19a`。
收尾 inventory **1,428 hashes、831 本機連結、0 failures**，diff-check 通過。
076–094 migration bytes 未改；沒有 push、PR、merge、部署、正式 keys/設定或
其他 PR 整合，staging/live 未動。168 項完整產品驗收維持 `not_run`。

Ted 補充會員提案已凍結逾 24 小時。本輪唯讀核對中央 GitHub repo 有 9 個 open
PR，尚無 review；不能用既有 verify/deploy-preflight checks 代替本批可信治理。
main 仍 `3de70cc`；沒有修改凍結安排、rulesets 或待審內容。原計畫的 scope
完成後受控前向 migration 決策仍有效；後續並行推工程與可信治理接線。

## 下一批

[17](17-private-ai-product.md) 已接本機會員 HTTP、畫面及單步私人 AI 成果。
下一批優先補正式 vault/recovery 信任來源、明確模型與憑證設定及受批准 exact
provider/model 的本人端驗收；不得把合成 fixture 的認證／成本／恢復 generation
當作真實來源。其後是訂閱 native host、
機器 execution auth、heartbeat/reconciliation、多步調度、媒體/跨端與可信治理。
沒有把 codefactory/local fixture 當正式服務可用，也不重用 storefront/supplier 的
`fw_read` 連線。

治理已推進固定單一 profile 的 [本機隔離 supervisor](../../../../packages/contribution-tools/behavior-supervisor.md)：host harness 透過有界 HTTP response frames 呼叫隔離容器內的 candidate app，由 host 自行判斷結果；不能把 candidate stdout/JSON 當可信測試結果。隔離不成立就 unavailable，並保留 approved host source／runtime、完整入口、publisher/GitHub enforcement 的缺口。下一步是可信安裝、來源與 publisher 接線，不是把本機 observation 宣稱可合併。未掛載 private HTTP、固定行為 harness 與歷史 ledger/capability 診斷不能取代完整入口／外部保存／政策 restore 的證據。migration 076–094 尚未合併或發布；完整私人讀取矩陣與正式 migration／grants／backup 恢復驗證齊備前不啟用正式私人寫入或頭像非 legacy 模式，備份政策仍另確認。不新增提早部署的過渡支線。

早先唯讀查核 #85／#87 的衝突與 migration 重號紀錄保留歷史用途；依 Ted 最新指示，其他 PR 的 rebase／整合現在不在派工範圍。這次沒有修改作者 PR 或把舊 CI 結果當新整合驗收。

推送、PR、合併、GitHub 規則、信任來源／金鑰、正式資料盤點或部署另依 Ted 的操作授權處理；Discord 全文仍須逐則核准。
