# 共同基礎現況與過渡決策

## 2026-10-04：隔離candidate已部署，資料移植與驗收仍分開

9cc的真正hosted Verify已完成196檔／2,620項全部通過，Worker60/60、synthetic restore2/2與UI413pass／5既有skip；CodeQL security仍failure。新隔離PG18.6已套110個canonical migrations through111並完成ownership／ACL／runtime及operator grants readback，0users／demo／backfill approvals。私有R2與兩個cache-OFF Hyperdrive，以及兩個全新private main/operator Workers均已建立／部署並由provider API核對；flags OFF、無routes/crons/workers.dev/previews/customdomains，現有Worker etags未改。

此不等於正式資料已copy或真人HTTPS flow已驗收；caller／backfill未啟動。已授權的新DB移植仍選一致snapshot restore→canonical pending migrations→ACL lockdown/grants→驗收，最後short writefreeze/drain＋finaldump/restore才cutover；不另造schema／generic delta或逐表COPY。新target寫入後rollback須一致reconcile／forward fix。以下較早「target不存在／未deploy」為歷史。詳見[最新交付紀錄](implementation-status.md)與[release readiness](release-readiness.md)；保留未知ACK／正式gate與安全核定限制。

## 2026-10-04：已授權隔離新環境與資料移植次序

Ted允許新增臨時Postgres、migration後關閉，也允許新DB／表承接資料以避開live原地改造；同範圍不重問資源permission。採既有一致snapshot dump／restore到新空DB，再跑canonical pending migrations與restore ACL lockdown／grants，先驗收，最後短writefreeze／排空背景寫入／final dump後cutover。不採逐表COPY到另造schema；既有media delta不是generic DB replication。若已有R2 pointers，dump與object pins須共用exported snapshot。正式data read／restore／cutover仍未執行。

根已實建私有 `freedom-foundation-candidate-20261004-media`（public URL disabled、custom domains0、default7-day incomplete-multipart abort）及同prefix `-pg`（Tokyo PS5 ARM、single／0 replicas、ready；US$5/月base＋usage）；metadata-only讀查已發生，臨時計費token已revoke。舊auth／resource unknown只是歷史，不公開account/token IDs或credentials。新DB寫入後舊DB回退需一致reconcile或forward fix；不以新資源或local PASS推定Worker已部署、安全gate完成或資料已移植。最新CI失敗與test-only修正見[交付紀錄](implementation-status.md)。

本文件記錄 2026-10-02 查核所得，以及把設計提案接到現行平台所需的過渡規則。以下 proposed 決策供這組 spec 使用，尚未改變線上政策或正式發布工具。

## 來源與查核範圍

| 來源 | 已知結果 | 證據限制 |
| --- | --- | --- |
| 完整 Markdown 計畫 | 已讀完並原文納入 [unified-foundation.md](../../../plans/unified-foundation.md) | `1.1-design`，不是已發布契約 |
| 治理摘錄 | 從 §23 起與完整 Markdown 的相應內容完全相同 | 不建立第二份可編輯政策 |
| HTML 閱讀版 | 正文正規化後對應 Markdown；頁尾記錄相同 SHA-256 | 未做瀏覽器視覺驗收；不影響規格內容判讀 |
| 原文 SHA-256 | `aca0218d1a76a52eadc4f023bb107c9695570b8b93a373139a535e3694ee2ab5` | 對應上傳的完整 Markdown bytes |
| R2 原始 Markdown | 已讀完並原文納入 [platform-restructure-r2.md](../../../plans/platform-restructure-r2.md)；1.0 | SHA-256 `4b8015a1b6e5654c3ba8bcf59b82c9cb957241a3f26125ce7001adcb3a22c11e`；不是已搬遷狀態 |
| Autopilot 原始 Markdown | 已讀完並原文納入 [autopilot-vnext.md](../../../plans/autopilot-vnext.md)；0.1.0-design | SHA-256 `819e54304d7532c8ff0f319f69f2a8d4892f731baa6f7d218a458e6513e8cdcf`；研究基準較舊 |
| platform 遠端 main | `3de70ccbd24362a7925508fb42d36aaa256a0806` | 以 `git ls-remote` 重新查核；本輪未查 prod/staging health |
| Agent Kit 遠端 main | `201fdab8017e2850bafc7b2f1e8dec7e4c0d6233` | 查讀 commit、lock、verifier；沒有建置整倉 |
| storefront 遠端 main | `9823df79f8eee86008c269437880ed2e49bdc394` | 查讀 commit、lock；選作首批 consumer fixture |
| GitHub rulesets | repo rulesets 與 main 適用 rules API 回傳空集合 | 是目前帳號可見的 API 結果；不推定所有 org/admin 能力 |
| main branch protection | API 回覆 404 `Branch not protected` | 不能用 workflow 註解聲稱 required check 已實際生效 |
| migration | repo manifest `last=75`、`known_gaps=[22]` | prod/staging 已套用 075 來自 Ted 交接，本輪沒有連 DB 驗證 |

初稿缺少的 R2/AP 原文已由 Ted 補齊，本版完整讀取並原樣保存；七類媒體、AP API/runtime、38+70 項驗收已接入本組 spec。舊 unified 1.0 不當主規格。新補 HTML 僅作閱讀版身分核對，未宣稱其全文/視覺已另行驗收。

AP 所述六份 schema、28 個假資料案例、validator/validation-report/SHA256SUMS 附件不在這次 Markdown/HTML 中；原文內的「本地設計資產檢查 PASS」是作者當時紀錄，不是本輪重跑或產品通過。neo 完整 source audit、實機/CLI/provider、cloud 配置、正式資料盤點仍未做。這些按對應 PR 驗證，不把文件已取得等同 runtime-ready。

## 現行程式可沿用與需補之處

| 邊界 | 現行證據 | spec 所需改動 |
| --- | --- | --- |
| 指令與責任 | [AGENTS.md](../../../../AGENTS.md) 已要求讀受影響目錄，中央擁有 API/DTO/驗證 | 擴充分層 context，不另寫一套工具專屬政策 |
| Contract source | [contracts/README.md](../../../../contracts/README.md) 指定 preview definition；SDK 中 client/schema 是手寫來源 | 新 family 加到同一產線；不能把全部 `packages/sdk` 誤標成 generated |
| Consumer pins | Kit 與 storefront 都 pin producer `b221d2ba1bcf014dc785e95212455ba6f157ec6d`、preview v1 及 bundle digest | v2 相容 reader；舊 pin 不自動獲 execution capability |
| Consumer set | [repositories.lock.json](../../../../repositories.lock.json) pin integration test snapshots | 不用它當線上部署清單，也不為本輪 docs 改 pins |
| Command | [packages/db/index.ts](../../../../packages/db/index.ts) 在同一交易鎖 user/session、序列化 key、authorize 後才 replay | 必須保留原語意再抽 core；不能只把 actor 改 union 就開機器入口 |
| Avatar | [avatars.ts](../../../../modules/identity-membership/avatars.ts) 的 `normalizeAvatar` 在 command callback、row lock 之後執行 | 將轉圖與 object I/O 移到交易外，以 prepare/finalize 重驗權限與版本 |
| Work read | [work.ts](../../../../modules/opportunity-project-work/work.ts) 的 list/scoped read 依 community 過濾 | private Work 啟用前補齊全部讀取及投影，不只新增一條私有詳情 route |
| CI | [verify.yml](../../../../.github/workflows/verify.yml) 執行 checkout 中的 scripts，沒有 merge_group | 獨立可信 verifier、可信 evidence 與 GitHub 強制；沿用原測試入口 |
| Migration | [local runner](../../../../scripts/database.ts) 掃所有 SQL 名稱，ledger 存 `digest(sql)`；[deploy scanner](../../../../deploy/cloudflare/lib/migrations.mjs) 要求三位數前綴 | scanner、runner、manifest、private helper 必須共同相容後才可改新 ID |
| Inventory | [verify_revision.py](../../verification/verify_revision.py) 核對 source bytes 與相對連結 | UX 遷移前繼續現行 push 檢查 |

2026-10-02 查到 open PR 為 #85、#87、#100、#101、#102、#103。此為避免重疊的索引，未審其程式內容；後續 UI／shell 修改前要重新讀各 PR 最終差異。#103 是交接筆記之後新增的側欄工作。

## 過渡決策

### 2026-10-03 交付重心修正

Ted 以 #108 `946d67b` 的 source／CI 查核指出本機安全核心與雲端、媒體、恢復及可信 CI 的進度失衡。本輪保留既有核心，將實作轉到四條原有交付線：目標 Worker／隔離 broker、七類媒體／搬遷／restore、可信 GitHub gate、原 scope 的執行端。這是原計畫的交付順序修正，不另建更大的規格或縮減完成條件。

進度以四個實際成果回報：真實隔離 staging 流程、七類全量搬遷報告、DB＋R2 隔離還原報告、真實惡意 PR 被必要 check 擋下。Schema、local workerd、合成 provider、工具測試及可審閱配置均不能取代它們；歷史 40–55% 是主觀工作包估算，不作部署完成率或 ETA。

當時維持完成原 scope 後一次受控正式切換；此發布範圍已被下節 2026-10-03 的基底優先指示更新。搬遷工具、合成資料預演與隔離 staging 驗證繼續並行。真實環境、模型呼叫／費用、金鑰或 GitHub 保護設定仍按具體目標確認後才執行，目前沒有部署授權變更。

當時的審查建議允許低耦合 PR 另行維護；Ted 的最新指示明確不先處理其他 PR，因此本輪不沿用該建議派工。#108 仍不因清空等待佇列而提早合入未具 migration 條件的重構；本輪未替他人 review、merge 或更改 repo 保護設定。

### 2026-10-03 基底優先的最新指示

Ted 明確指示：「以把基本要上線的基底做好，變成能上線為最快原則」，並表示不打算先處理其他 PR。這更新先前「全部原 scope 完成才正式 migrate」的發布範圍：先使既有會員平台完成必要移植、七類媒體接線／搬遷、一致備份／恢復、權限與可信發布驗證，再依精確候選版本評估合併與 staging/live。未驗收的 Autopilot／機器執行、多步 Action、跨端產品維持關閉，仍保留在原計畫，不用關閉功能冒充原 scope 完成。

基底發布仍須保留現有會員流程、私人 ACL、各媒體格式／大小／variants／影片 Range、當前撤銷與刪除效力。正式資料盤點、全量與增量比對、DB＋R2 還原、目標 Cloudflare 接線及真實 GitHub 必要檢查缺一項，就保留對應未完成狀態；不能用本機測試數、可 merge 或缺設定的 dry-run 代替。

工作集中同一 Draft #108，其他 PR 不派工。GPT‑6.1 Sol、agy Opus 5.5 與 grok Grok 4.7 均派 coding 工作；外部 CLI 失敗或沒有回傳程式不算完成。已授權的普通 feature push／Draft PR 更新可繼續；本指示未提供具體的 merge、遠端 trust／keys／rules、正式資料存取或 deploy 目標授權。先完成可審閱的候選與演練證據，再提出精確發布操作。

### 2026-10-02 歷史發布方向

Ted 於 2026-10-02 當時明確選擇先完成原計畫 scope，再做受控的前向 migration；不為提早分批上線另做多個相容過渡 release，也不以退回舊應用版本作本輪交付目標。先前提出的獨立過渡 release 不列入派工。

這項決策不刪除原計畫的資料完整性、備份／災難恢復、撤銷紀錄、權限及版本用途隔離要求，也不代表 migration 失敗時忽略錯誤繼續。發布仍先確認發布槽、停止不相容的舊 consumers、備份、以 migrator 完成 schema 與 grants，驗證後才啟動新程式；staging 驗收先於 live，不同環境不合併成同一次未驗證操作。維護窗口與正式切換時間待實際發布前確認。既有診斷與歷史 floor 保留作資料安全證據，不再據此新增一條提早上線支線；備份保留政策仍另確認。

| ID | 本組 spec 的 proposed 決策 | 解除或切換條件 |
| --- | --- | --- |
| UF-S01 | 首批沿用數字 migration；本次沒有配置或保留 076 | 合併時取當下最小可用號碼並同步 manifest；新 ID 待 UF-S02 |
| UF-S02 | migration v2 獨立交付，歷史 ledger/name/hash 不變 | repo 與私有發布 helper 均通過空庫、增量、不同合併順序及實際 preflight |
| UF-S03 | 先用 platform、Agent Kit、storefront 證明契約治理 | storefront 只證明既有 consumer 相容；browser execution 能力另由 extension/neo 驗收 |
| UF-S04 | 純 TS shared core 先以安全 subpath/現有包組織 | 有實際 import 或 runtime 隔離理由才新增 package |
| UF-S05 | local ReleaseSet 驗證可先做；發布信任缺失必須 unavailable | 完成批准 publisher/trust profile、artifact provenance、撤銷來源及受保護發布 |
| UF-S06 | GitHub enforcement 選 required workflow 或窄權 publisher 其中一條 | 實查 org 能力及權限後選定，並用真實測試 PR 驗證不可繞過 |
| UF-S07 | private Work 寫入預設關閉，read ACL 先上 | legacy list/detail/search/dashboard/events/export/notification/artifact 全部有可追溯測試 |
| UF-S08 | 第一條 AI 模型路徑由實際可用 adapter 決定並鎖版本 | Kit 本機官方 CLI 若不能受限執行就維持 assisted；改採 broker 必須明選 custody，不自動 fallback |
| UF-S09 | U6 先完成頭像 bridge/restore，再按七類 profile 分批接入 | 原文已補齊；仍須現行限制/呼叫面/資料量盤點及逐 profile 測試，見 MEDIA |
| UF-S10 | 既有 inventory 規則持續有效 | 新 affected verification 與 release inventory 同時落地、有回退與驗收後才能搬移 |
| UF-S11 | 原文保留作快照；整合修訂集中本組，正式 contract 尚需生成與驗證 | 不手改已發布 preview/legacy schema 或引用未取得的舊 ZIP 測試結果 |
| UF-S12 | TaskLease 保留 expires_at；native binding 初版沿用 MEDIA 映射 | 與既有 AGT-01 相容；任何改名需獨立契約/部署遷移，不靠字串替換 |

`076` 是查核時的下一個候選號碼；其他 PR 先合併就重新解析。任何實作 agent 不得把本表當永久發號單。

## 原文整合差異

| 原文設計或誤差 | 本組採用規則 | Owner |
| --- | --- | --- |
| R2 MediaAssets、AP execution_principals 各自擁有資料 | 共用 Principal/ResourceScope/Asset；domain profiles、相容 exports 可保留，不能雙寫成兩套真相 | CORE、ASSET-WORK |
| AP Run 固定 runtime/model 卻另允許交接 | Work/Run 不搬；不可變 binding 落 RunAttempt，effects/receipts/lease/token 明綁 attempt | EXEC-OPS、BROWSER |
| AP lease_expires_at | [現有 AGT-01](../specs/AGT-01.md) 明確撤回改名；保留 expires_at | CORE、BROWSER |
| AP blocked(runtime_offline) 在狀態圖重複三次 | 同一 blocked reason，中央只生成一個 enum/轉移集合 | BROWSER |
| AP validateRun 一律查 model-ready | 新 AI step 才 gate；Stop/Revoke、人類功能、限定 late evidence 不被模型到期阻擋 | CORE、EXEC-OPS |
| R2 先 migration v2、AP 使用 next numeric | 首批沿用現有 numeric；完整 runner/private helper 相容才切 v2，不預占號 | EXEC-OPS、MEDIA |
| AP 把 packages/sdk 全部當 generated | definition/產物與手寫 client/schema 分清；保留現有 source of truth | GOV |
| AP 引用不存在於本基準的 planning 長檔名 | 使用 [02-architecture-repositories.md](../../02-architecture-repositories.md) 與 execution/specs/AGT-01.md 至 AGT-05.md；不照錯名建替代 canonicals | GOV、BROWSER |
| R2 abandoned 與 Asset/intent 生命周期的分工 | abandoned 用於未完成 intent；Asset states 由共同 schema 一次固定，含 deleting fence | ASSET-WORK、MEDIA |
| R2 MEDIA 與 unified ASSETS_STORE 的命名選項 | 一份 logical store，初版 native binding MEDIA；不為改名搬物件 | MEDIA |
| AP 本機 engine/recording 與一般檔案 ref | 明分 provider processing/custody/data policy；platform_asset/runtime_local，不偷偷上雲 | ASSET-WORK、BROWSER |

以上是開發草案中的明示相容修訂；正式 schema/SQL/AGT planning 實作 PR 需同步落地及測試，這輪未把歷史 planning 的狀態改成完成。

## 設計尚缺的參數與交付責任

以下缺項需在相應實作 PR 的 reviewable artifact 中具體化；不要求 Ted 先替實作者選每一個 routine 細節。

- CG-B/F：受信任 publisher/workflow/revision、proof 格式及驗證器套件、policy freshness 上限、撤銷來源、允許 bypass 的實際身分。先用明確 non-production fixture；實際設定由有權 operations 執行。
- U3/U5：首版 model adapter/provider 版本、實際工具限制、時鐘偏差、local journal 上限與 expiry；BROWSER 已列 AP 提議 TTL/heartbeat，仍需測量及契約定版才開 managed mode。
- U2/U6：新 draft 保留期限、各 media profile 既有數值/transform 的 source mapping、備份保留與刪除對帳仍需補齊。Ted 於 2026-10-02 同意頭像清理起點：未完成且未被引用的物件至少保留 48 小時、替換下來的舊圖保留 7 天、使用者刪除後立即停止讀取。這是開發設定與測試的政策依據，不表示正式環境已啟動清理；備份保留、刪除及還原政策另行確認。活躍引用、intent、備份 pin 與刪除 fence 仍優先限制回收，不能只按物件年齡刪除。沿用既有限制，未知格式先拒絕。
- U6：recovery generation 的環境權威存放點及更新人；必須不隨 DB snapshot 回退。沒有 restore 演練不得開新 execution dispatch。

## CI 判斷的官方依據

GitHub 能以 ruleset 指定必需 workflow，也能限制 required status check 的預期 App；實際 repo 必須有相應設定才生效。[GitHub rulesets](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

有權 workflow 不得執行未信任 PR 的程式、建置腳本或 dependency hooks；另一個 workflow 的 artifact 也需視為不可信資料。[GitHub workflow security](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

以上文件於本輪讀取，支撐 CI 邊界；本輪未修改 GitHub、Cloudflare、金鑰或發布配置。
