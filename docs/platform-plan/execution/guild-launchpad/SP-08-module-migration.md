# SP-08｜單模組遷移與寫入權威移交

## 1. 文件身分、來源、追蹤與範圍

- **ID／版本：** SP-08 / 0.1.0；2026-10-05
- **狀態：** proposed、待實作、待驗收；本文無移轉正式資料、部署、撤鍵或刪除資料的執行授權
- **來源：**《公會啟動台與可攜式業務空間》v1.0 第 11–15、20、23–24 章及附錄；中央 source `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`
- **決策：** D-11、D-13–18、D-20；**主要需求：** R-041–045；**協作：** R-027、R-031–034、R-046–049、R-052、R-057、R-062
- **驗收：** T-041–045；共同 T-027、T-029、T-031–033、T-036–040、T-046–050、T-054、T-058
- **共用規约：** [contracts.md](contracts.md)、[repository-map.md](repository-map.md)、[資料責任](data-responsibility.md)、[traceability.json](traceability.json)、[decision-log.md](decision-log.md)

責任單位為一個既有 `(tenant_id,instance_id)`，位置從 hosted 或受支持 external binding 搬至另一 binding；tenant、instance、resource identity 不變。本文不包含 SP-12 的平台 legacy tenant 回填，亦不把整套 ERP 搬家當成单 inventory 遷移驗收。

## 2. 使用者流程、前後狀態、非目標與依賴

1. 具 `module.authority.transfer` 權限並通過 SP-02 高風險新驗證的 owner選一個模組及已通過 SP-09 的受控 target binding。預覽相依模組、停寫範圍、資料量、授權、恢復與殘留期限
2. 建立 migration plan，不改 writer。target 完成相容性與隔離還原工具驗證；使用者確認已明示的停寫範圍後 start
3. 來源真正 fencing、排空已接受操作；一致匯出與隔離還原；資料、附件、歷史、inbox/outbox、references 全驗證
4. trusted coordinator 執行 authority CAS，核對獨立 recovery floor，target 按新 epoch 啟動；source 始終保持 fenced
5. 觀察 cross-module 聯動與所有未完成 operation，清理原 hosted 私有副本依 SP-06 明確政策單獨記錄，完成後仍說明歷史備份的到期時間

**目標結果：** A 的 inventory 在獨立部署／DB 正常寫，A shop 透過原領域 port 連動；A 其他模組與 tenant B 不受無關停機影響。同一 instance 在任一時間最多一個**被平台認可且遵守協定**的 writer，可暫時零 writer。中央只保留其原生資料與最小互通／recovery metadata。

**非目標：** 通用 CDC、雙向同步、零停機、跨所有模組的分散式 ACID、任意惡意自架 fork 無法寫自己 DB 的保證、看到健康檢查就視為資料／付款真實、target 寫完後一鍵回到舊 source。

authority transfer/binding 管理預設 owner-only；admin、operator、guild leader 不自動有權，任何放寬需先改具名授權政策與負例。

**依賴：** SP-02 ACL、SP-04 registry/provisioning、SP-05 operation/inbox/outbox、SP-06 data catalog／cleanup、SP-07 完整 bundle、SP-09 服務驗權，及既有 UF recovery/generation 能力的安全擴充。能並行完成 plan/UI/state/cutoff fixtures；未有實際 source fence、外部 recovery authority、服務 adapter 時不能開啟正式 cutover。

## 3. 現有程式與未來檔案對照

| 標記 | 精確檔案／範圍 | 使用方式及目前缺口 |
| --- | --- | --- |
| KEEP | `packages/db/command-core.ts`、`packages/db/member-command.ts`、`packages/db/transaction.ts` | 同交易 command／receipt；授權先於 replay；不在鎖內做跨環境 I/O |
| MODIFY | `packages/scoped-commands/index.ts`、`packages/resource-scopes/index.ts` | 經 SP-02/09 擴充真實 tenant／service backing；現有 member personal/community 不等於 tenant service |
| KEEP | `packages/media-migration/backup-coordinator.ts`、`backup-transfer.ts`、`backup-retention.ts`、`backup-gc-precondition.ts` | 同 snapshot／object pins 與 bounded I/O 模式；不把 whole-schema dump 說成模組 capture |
| KEEP | `packages/media-migration/restore-acl-lockdown.ts` | 舊 restore 的 PUBLIC revoke 修復是必要基線之一，不是本案 epoch／tenant 安全已完成 |
| KEEP／MODIFY | `apps/credential-broker/src/recovery.ts`、`bridge.ts` | 沿既有獨立外部 recovery authority/floor 接點擴充，不讓 bundle 或 restored DB 成新信任根；module-specific floor 屬新增 profile，不能直接把 model credential generation 當 module epoch |
| KEEP | `docs/platform-plan/execution/unified-foundation/04-execution-adapters-release.md`、`18-credential-broker-core.md` | recovery generation 不隨 DB 回退；未知 effects／outbox 先對帳；目前文件及局部 core 不證明全產品已啟用 |
| NEW | `contracts/portability/v1/module-migration.ts` | Migration／CutoverManifest／FenceEvidence／RecoveryDecision 作者來源；共用 SP-07 generation 入口 |
| GENERATED | `contracts/portability/v1/module-migration.schema.json` | schema／SDK／fixtures 從作者來源產出，不手改 |
| NEW | `modules/module-migration/service.ts`、`coordinator.ts`、`repository.ts`、`fencing.ts`、`reconciliation.ts` | domain 狀態、持久 checkpoints、來源 fence、可信 decision 與 recovery；不新造通用 job engine |
| NEW | `apps/platform-api/src/routes/module-migrations.ts` | tenant member 控制面、獨立 service data plane，route safety 分開 |
| NEW | `apps/portal-web/src/modules/module-migrations.tsx` | plan／進度／核對／清理 UI；以當時 shell 風格落地 |
| NEW | `migrations/<next>_module_migrations.sql` | migration/step/fence/cutover/dedupe provenance，與 SP-04 registry schema 單一 owner 整合 |
| NEW | `tests/runtime/module-migration.test.ts`、`module-migration-fencing.test.ts`、`module-migration-recovery.test.ts`、`tests/e2e/module-migration.spec.ts` | 實際獨立 DB/source/target、crash points／late events／reverse transfer |
| KEEP | `tests/runtime/media-session-recovery.test.ts`、`media-backup-transfer.test.ts`、`client-connections.test.ts` | 舊 session 恢復、物件 transfer 與 GET-only credentials 回歸，不能替代本案端到端證據 |

NEW 路徑是後續 PR 的建議落點；本輪只新增文件。migrations 的實際 next 編號、descriptors／generated clients 依合併順序選定，不保留既有數字。

## 4. 資料模型、單 writer 不變量與 cutoff

### 4.1 Migration、Step 與證據

所有 DTO 沿 [contracts.md](contracts.md) 的 OpaqueId、Version/Epoch、Digest、ContractRef、ResourceRef／Operation；不以 JSON number 表示版本。

**Migration required：** `migration_id, tenant_id, instance_id, source_binding_id, target_binding_id, source_epoch, target_epoch, state, operation_id, version, created_at, updated_at, policy_ref, plan_digest, source_release_ref, target_release_ref, contract_ref, dependency_snapshot_ref, rollback_class, cleanup_state`。`target_epoch` 為 source_epoch+1 的預期值，不由 caller 自填，也不是先預約所有未來 epoch；`cutover_manifest_ref` 在 capture 前 nullable。`rollback_class` 是 server-derived `pre_commit_cancel|forward_repair_or_reverse_migration`；後者不可改回前者。

- `(tenant_id,instance_id)` FK 並鎖定目前 owner/registry；identity 欄位 immutable。來源/目標各 composite FK 到同 tenant/instance binding，且彼此不同
- partial unique constraint 保證同 instance 只有一個非終態 migration；`completed|cancelled|failed` 為終態，但 failed 若仍需復原不能釋放互斥，須保持 needs_reconciliation
- `(migration_id,step_key)` 唯一 step journal：`state, attempt_id, operation_id, input_digest, output_ref, started_at, completed_at, version, problem`。attempt 是傳輸／worker 身分，不是新的業務效果
- mutation、step facts、journal/outbox、receipt 同本地 transaction；外部 I/O 前先保存 bounded intent，I/O 後以目前 authority／version 重新驗再寫結果。程序記憶體不足以證明一步完成
- `cleanup_state` 為 `not_started|retaining|eligible|running|completed|blocked`，另有每個副本的 `class,purpose,policy_ref,retain_until,last_verified_at,disposition,evidence_ref`。migration completed 不能掩蓋尚存備份

### 4.2 Writer gate 是實際資料路徑

每個 business mutation、job continuation、scheduled effect、batch/import promotion、event-driven write 必須經同一 InstanceWriteGate；所有 legacy write 路徑亦納入。Gate 取得 instance/fence 的 shared lock，查目前 binding、authority_epoch、recovery_generation、migration fence 及 actor/grant/domain ACL；持有至 domain commit。fence command 取得同列 exclusive lock並設 `accept_new_writes=false`；等待先前 shared-lock transactions 完成後才能成功。凡無法接入這條 gate 的 writer，該模組不具遷移資格。

Fencing 的線性化點是來源資料庫／受支持 provider 實際拒絕新 command 的 durable barrier，不是 UI 按鈕、registry 字段或 healthcheck。來源在 barrier 前已接受的 operation 必須排空至確定 terminal outcome，或列入逐種 schema 已支持的接續清單。初版建議排空；未識別進行中 effect 一律阻擋 snapshot/cutover。

來源 DB 的 authority/fence metadata 不能因還原自己舊備份就重新開寫。每次啟動或恢復，在 gate 開啟前先向**獨立於回退 DB/R2 的既有 recovery authority**取得目前 generation／epoch floor／revocation／未結遷移 intent。來源到不了可信狀態時保持 fenced，不能默認 epoch=1 或採舊 cache。服務授權 cache 和到期策略受 SP-09 約束。

### 4.3 FenceEvidence 與 CutoverManifest

`FenceEvidence` 包含 `migration_id, tenant_id, instance_id, source_binding_id, source_epoch, recovery_generation, fence_version, fenced_at, accepted_operations_ref, outstanding_operations_ref, aggregate_cutoffs_ref, outbox_ref, inbox_ref, capture_id, evidence_digest`。fenced_at 是顯示與稽核時間，判定 cutpoint 依 durable records／versions，不依不同主機時鐘。

`CutoverManifest` 必須 pin SP-07 `manifest_digest`、DB capture evidence、物件 pin set、dataset counts/digests、source/target release/schema/contract refs、FenceEvidence、實際 restore verification report、target write-disable evidence、dependency compatibility results、accepted operation 集合、每 aggregate cutoff、完整未送 outbox/consumer inbox 的保留狀態。

每 aggregate 以 `(tenant_id,source_instance_id,aggregate_type,aggregate_id)` 固定 `final_aggregate_version,final_event_sequence`（無事件以 nullable 表達）。event_sequence 跨 epoch 連續不重設。cutoff event manifest 記每個已提交 `event_id,payload_digest,aggregate_version,event_sequence,authority_epoch`，operation manifest 記 `operation_id,request_digest,outcome,state`；所有記錄在同一致 capture 中核對。

**合法遲到：** old-epoch event 僅可由經目前 service 驗證、狹義 historical-event replay capability 的來源送入；tenant/instance/原 binding、event ID、payload digest、aggregate version、sequence 必須精確命中 cutover pinned 清單。接收端 inbox 以同 event ID 去重、版本不回退。只在 cutoff 以前「發生時間」或聲称已送出不夠。超過 cutoff 的舊 epoch 新事實、同 ID 異 payload、未列 operation、以歷史事件要求新扣庫存，一律拒絕／隔離。

### 4.4 Registry CAS 與 recovery floor

Authority decision 的唯一授權 tuple 為 `(tenant_id,instance_id,binding_id,authority_epoch,registry_version,recovery_generation)`。來源 epoch 不能重用，遷移／reverse migration 都提高 epoch。CAS 同一 DB transaction 驗 `expected_binding_id==source`、`expected_epoch==source_epoch`、`If-Match==registry_version`、migration/manifest/target readiness 未變，更新 binding/epoch/version 並寫不可變 decision、receipt/outbox。只有完整 cutover evidence 的可信 coordinator 能呼叫，使用者 JSON 的 `verified:true` 不構成證明。

**跨儲存不是分散式原子交易：** 在 CAS 前，既有獨立 recovery authority 先保存該 operation 的未完成 intent；CAS 提交後，其新 tuple／decision digest 必須獲 durable monotonic checkpoint，然後 target 才能 activation。兩者間任一步未知，source/target 都保持 fenced，migration=`needs_reconciliation`。同 operation 重讀 DB registry、外部 intent/floor 及 target 狀態完成核對；不得開第二個 operation 或回退 epoch「修正」。若外部 floor 與 DB decision 衝突，保持停寫並人工／受控 recovery；只存在 app DB row 不足以證明 restore-safe。

恢復後 DB registry 低於外部 floor 只能更新／核對到受信任決策，不能以已還原的舊 row 授权；該 floor 不只防數字下降，也 pin binding/decision digest，拒絕同 epoch 不同 binding。此接點延伸既有 UF recovery 體系；具體持久 authority backend 是 OPEN-15 release blocker，不由本文新增另一信任根或宣稱既有 broker 已支持 module CAS。

## 5. API、控制權、事件與錯誤

以下全是 **proposed**。Base `/api/v1/tenants/{tenant_id}/instances/{instance_id}`；控制面經目前 member session/CSRF/tenant ACL。Migration lifecycle operation 使用 tenant-level operation query；被搬遷的已接受 domain operations 仍用 SP-05 instance-level query，以 dependency_refs 連結，不共用 ID 冒充另一種 scope。所有控制 commands 用 `Idempotency-Key` 原 8–128 profile，對被控制 aggregate 帶 `If-Match: "<Version>"`；actor/grants/recovery/context 均 server-derived。

| 方法／相對路徑 | strict input | 回應與條件 |
| --- | --- | --- |
| `POST /migrations` | `{target_binding_id,policy_ref,requested_capabilities}`，capabilities 是待檢查需求而非自授權 | `module.authority.transfer`；If-Match instance；202 Operation，ref migration；同 instance 有未結遷移則 409 |
| `GET /migrations/{migration_id}` | 無 body/query | 目前 `module.operation.read` 與 migration 資料讀權；`{migration,operation,progress,blocking_reasons,source_write_state,target_write_state,cleanup_summary}`，不含私有 rows/URLs/token |
| `POST /migrations/{migration_id}/start` | `{plan_digest,acknowledged_pause_scope,acknowledged_retention_policy_ref}` | If-Match migration；重新驗 plan/ACL/能力／期限，不接受未知改變後舊確認；202 Operation |
| `POST /migrations/{migration_id}/cancel` | `{reason_code}` | If-Match migration；只在權威未提交且可證明 target 未接受 business writes 時成功；202 Operation |
| `POST /migrations/{migration_id}/reconcile` | `{observed_version,requested_step}`；只枚舉該 migration 已知 step | `module.authority.transfer`，需 operational recovery 的部分另經可信操作人；202 Operation；只能查核既有 operation、不能叫 caller 填結果 |
| `POST /migrations/{migration_id}/activate` | `{cutover_manifest_ref}` | If-Match migration；持久请求交 trusted coordinator，不能在 route 直接改 URL；202 Operation |
| `POST /migrations/{migration_id}/cleanup` | `{cleanup_plan_digest,retention_policy_ref}` | `module.authority.transfer`＋明確資料清理權；If-Match migration；202 Operation；沒有有效政策／證據則拒绝 |
| `POST /migrations/{migration_id}/reverse-plans` | `{target_binding_id,policy_ref}` | 新 migration plan，從**目前 target 的最新資料**起步；If-Match current instance；202 Operation，不能回復旧 epoch |
| `GET /api/v1/tenants/{tenant_id}/operations/{operation_id}` | 無 body/query | 共用 Operation；current authority before receipt/read；succeeded 不等於所有備份已清理 |

`acknowledged_pause_scope` 是用戶對 server 計畫範圍的確認，不替代執行授權；plan_digest 改變就要求重新確認。內部 `fence/capture/verify/commit_authority/enable_target` 為不可由 public JSON 直接呼叫的 server-owned ports，輸入由 durable state 決定；每個 port 都有穩定 step operation ID 和受驗 credential，不以返回的 TS object 當跨程序授權。

操作回應共同 `operation{operation_id,state,version,resource_ref?,retry_after_seconds?,problem?}`。遷移 lifecycle 是平台控制面，不是 module-native domain fact；必要 facts 依 contracts.md §8 走既有 scoped/platform journal 的 versioned payload：`module.migration.planned`、`module.migration.source_fenced`、`module.migration.authority_committed`、`module.migration.target_active`、`module.migration.reconciliation_required`、`module.migration.completed`；只含 refs、old/new epoch、cutover digest、固定狀態，不拷貝 CRM。不得捏造 source_instance_id 或把 registry decision 填入 SP-05 module EventEnvelope。只有受控 translator 對已知實際 target、policy 與 source revision 作通知，亦不宣稱那是模組原生業務事件。control transition event 不替代 registry 讀取；event 重放不可重新執行 cutover。

| 錯誤 | client／worker 語意 |
| --- | --- |
| 401 `authentication_required`、403 `capability_denied`、404 `not_found` | 目前身份／tenant 不允許；不回歷史 receipt 或不具權目標狀態 |
| 428 `version_required`、412 `version_conflict`、409 `idempotency_conflict` | 不自動覆蓋；同 operation 查現值，顯示差異 |
| 409 `migration_in_progress`／`authority_changed` | 不建立第二個相同 instance 遷移；重新解析 registry |
| 409 `source_not_fenced`／`pending_effects`／`cutoff_unverified` | 未達安全前置；明列不含私有 payload 的阻擋原因 |
| 409 `cancel_not_safe`／`reverse_migration_required` | target 已接受新寫、commit 未知或無法證明未啟動；不能恢复旧 source |
| 422 `contract_incompatible`／`restore_invalid`／`plan_changed` | 改正 target/profile／重新同意有效 plan；其他模組不封鎖 |
| 429 `quota_exceeded` | 保留既有 progress，不重複 reserve；Retry-After 有界 |
| 503 `dependency_unavailable`／`recovery_authority_unavailable` | 未派送可退避，同步已派送未知則 needs_reconciliation，不承諾失敗即無效果 |

service/data-plane 的錯 audience、scope、environment、舊 epoch 依 SP-09 fail closed；不能把 migration endpoint 放進既有 `fw_read_`。

## 6. 完整狀態機、失敗及 takeover

### 6.1 正常轉移與可核對條件

| 目前 → 下一階段 | 唯一可接受的 guard／原子結果 | crash／失敗處理 |
| --- | --- | --- |
| `planned -> target_ready` | 現行 ACL、依賴、release/license/contract 相容；target 獨立環境、服務身份與 write-disabled 證據；不改 writer | target provision ACK 未知先 query/reconcile，不再創另一實例 |
| `target_ready -> source_fenced` | 計畫確認仍有效；目前 source tuple 未變；實際 write gate barrier 成功；所有 accepted effects 已 terminal 或有已支持 handoff | drain 超時／未知 provider effect 保持 source fenced，needs_reconciliation；不得把 kill worker 視為排空 |
| `source_fenced -> snapshot_exported` | SP-07 同 capture 的 DB/object pins、操作/outbox/inbox 全核對 | exporter crash 不能重開同 snapshot 則新 capture revision；原 pins 待核對，不混包 |
| `snapshot_exported -> restored_verified` | target quarantine 全量復原；counts/digests/IDs/關係/域不變量/重新啟動/讀取全過 | 缺件／schema 不符留隔離可重試，不對外可寫 |
| `restored_verified -> authority_committed` | 外部 recovery intent 已保存；registry exact CAS＋immutable decision＋receipt/outbox；cutover manifest 未變 | CAS ACK 遺失 query same operation；未確認獨立 checkpoint 前 target 仍閉鎖 |
| `authority_committed -> target_active` | registry decision 與外部 floor 一致；target 已接續 IDs/receipts/inbox/outbox/counters；新 credential/grant 綁新 epoch；source fence 仍生效 | activation ACK 遺失查 target active marker／accepted operation ledger；不能取消回舊 source |
| `target_active -> observed` | 用真實跨程序 fixture/受准 probe 驗依賴；late events 按 cutoff、未完成操作對帳；無未知副作用 | 失敗僅封鎖受影響 module/capability，forward repair；不改回舊 source |
| `observed -> cleanup_eligible` | 非時間到即合格：所有 required acceptance/evidence 通過、未知 effects 歸零、支持 release/恢復/policy 成立 | 任一 evidence 過期或撤回重新阻擋 cleanup |
| `cleanup_eligible -> completed` | 原 live private rows 及衍生副本依批准 plan 處理、minimum registry/receipt/tombstone 留存；備份到期計畫可查 | 清理未知單獨 needs_reconciliation；可明列 retained backup，不說已全刪 |

這是業務 migration.state，不是共用 operation.state；中間階段通常對應 running。`observed` 要有具名測試報告，不可只經過任意幾分鐘就自動標記。

### 6.2 取消、失敗、unknown 與恢復

- **pre-commit 取消：** 先在 migration 鎖下保留 cancel intent，阻止併行 commit；查 registry 仍 source、外部無較新 decision、target 无 live activation／accepted writes。撤銷 target 的臨時接續／寫入權，核對 quarantine cleanup，再由可信 source gate 解除 fence；source 現 epoch 不變。這些步驟任一 ACK 未知，留 needs_reconciliation、不能說已取消
- **確定失敗：** 無外部或 DB 效果的 planning/compatibility 錯誤可 failed；失敗後若 source 仍 fenced／target 狀態未知則不是終態，要保存恢復步驟並維持 migration reservation
- **authority commit 已成功：** 不能用 cancel 還原來源。即使暫未見 target 寫入，也不可降 epoch；如要更換 writer，必須新的受控移交 decision。第一版一律採 forward repair 或完整 reverse migration
- **target 有新事實：** 停 target 新寫、排空／核對未知操作，將新資料＋附件＋receipt/outbox/inbox 納入反向 bundle，重新走所有 fence／restore／CAS。任何舊 source copy 不可直接提升。target 不可讀且無可驗最新備份時保持停寫，揭露 RPO／資料缺口，由有權者處理
- **worker restart/takeover：** job lease 到期僅允許另一 worker 接既有 migration，使用 step operation IDs／CAS；先讀目前 auth/recovery/fence/registry，對 outbound intent 作 status lookup。無可靠 status API 的外部效果不盲 retry，轉人工核對
- **撤權：** 開始者會員／grant 被撤銷立即停止新高風險步驟與下載。已 committed decision／終態事實不回滾；source 已 fence 仍維持安全。由目前另具 migration/recovery 權限者接手；系統只能依原 bounded 授權完成必要的安全收尾，不能藉收尾擴大資料轉移
- **不相容版本：** 保持舊 writer 或停寫狀態，阻擋受影響 capability；可用的 read/export/control 不依外部新版本健康。中途換 release 必須重新驗 restore/contract evidence，不繼承舊 report

### 6.3 在途操作與事件接續

初版強制排空不能以 schema 表達的在途 operation；允許移交的種別必須逐項有 `state_schema_ref,accepted_input_digest,last_effect_ref,terminal_status_or_resume_guard,reconciliation_owner`。匯入後歷史 receipt 不直接插入當前授權 receipt space；由 trusted coordinator 對 exact source ledger/cutoff 建去重 provenance。rotation／位置變化不改 business operation_id，transport retry key 可換但不能產第二次 reserve。

來源 outbox 的 `event_id`、payload digest、sequence、delivered/unknown/pending 及各 consumer ack 狀態保留；delivered 不全量重發，unknown 可依 inbox 去重安全重送相同事件。consumer inbox 的 duplicate tombstone 隨所屬模組完整搬移；relay 鎖定範圍不得把中央全部 inbox 打包。receipt／inbox 保存與 SP-05 replay horizon 一致，超窗不以新 operation 自動再做。

## 7. UI、可見性、手機與人工處理

遷移頁明列：哪個 tenant／module、目前 source、新 target、受影響 capability、哪些模組不受影響、資料量估計、停寫和不可直接回復的時點、舊副本/backup retention。沒有明確停寫上限量測就寫「依實際資料量估算中」，不承諾固定零停機。

進度以 durable stage 显示，不用 spinner 隱藏 unknown。`source_fenced` 後相關表單禁止送新 command並給 operation link；其他模組仍可操作；有相依的高風險動作標 paused/pending。瀏覽器返回、重新整理、另一裝置都從 operation 查現狀。舊頁面的 retry 發出前重讀 binding/epoch；不可靠 UI 的「尚未切換」快取授權。

在 target_active 後將按鈕改為「檢查／修復」與「建立反向移轉計畫」，不保留能直接開舊來源的 rollback 按鈕。取消顯示其實際來源是否已恢復、target 是否仍隔離；只發出取消請求不能顯示取消完成。

每個 needs_reconciliation 有固定問題 code、未知步驟／operation refs、已確定/未確定的 writer 狀態、最後成功證據、允許處理者及建議動作。人工輸入不能直接填 `succeeded`；提交外部證據仍需受信 verifier 對帳。下載私有 evidence 另驗 ACL，不在錯誤面板放 payload。

手機優先保留當前階段及安全狀態；多步驟用可折疊清單。鍵盤可 review／start／cancel；dialog focus 回觸發點，失敗焦點移摘要；aria-live 在階段變化提示。tenant 切換清除原資料並忽略舊 request late response。所有高風險控制使用明確標籤，不只 icon／顏色。

## 8. 匯出、清理、legacy 與復原程序

- **Migration package：** SP-07 完整 app/data/attachments/config/interop/operations；沒有完整 dataset catalog／pin／receipt closure 不進切換。保留 IDs，与 clone 新身份規則清楚分開
- **關係／地址：** registry binding 改位置，stable references 不變。caller resolution cache 綁 instance/epoch/version且失效後重讀；跨模組 DB direct join 必須在 SP-05 移除，不能靠複製全 ERP 維持
- **原副本處理：** authority commit 後立即停止舊 writer／新 projection ingestion，不等清理才封。SP-06 allowlist 保留平台原生、必要 interop ref／minimal dedupe/tombstone，不留完整 CRM／客戶歷史作分析後門
- **衍生資料：** 逐項清搜尋、縮圖、摘要、embedding、cache、通知副本、debug trace，保留依法／契約另有責任的受限交易快照，不將 snapshot 擴成全 CRM。cleanup intent/evidence 不可保存被清掉的完整內容
- **備份殘留：** 記每個 backup class/policy/retain_until／access；等待到期前仍標存在，排程 GC 要復用原 storage/retention gate，不能繞過尚未啟用的通用 GC
- **舊 backup restore：** 僅隔離恢复，載入外部 authoritative generation/floors、tombstones、credential/grant revocation，再 reconcile outstanding migration/operations/outbox/R2。所有 public/read/write/dispatch gate 的啟用必須由現況證據決定；session invalidation 單項通過不代表完整恢复安全
- **平台內部演進：** SP-12 expand/backfill/switch/contract 先完成 legacy owner→tenant mapping。歸屬不明／直接 SQL writer 尚未收斂的 instance 不具迁移資格，不能以此阻擋其他資料已清楚的模組。舊 receipt 不改 hash／key；舊 client 缺 epoch/tenant 寫入明確 upgrade-required
- **縮回功能：** release rollback 不得回到不識別目前 tenant/epoch/recovery/receipt schema 的舊版；沿既有 release compatibility floor。关闭新 migration admission 可以，撤掉已迁移 module 的必要 reader/adapter 不可以

## 9. 威脅、最小權限、容量與安全反例

**主要攻擊／失效：** source 假裝已 fenced；target 假報 restore；兩次並發 CAS；舊 registry／credential 恢復；同 event ID 改 payload；以舊 epoch 發切點後事件；移轉 worker 拿全 DB；source/target network partition；權限撤回後 receipt 重播；改 target URL 偷送 CRM。

**防線：** tenant/module read/export/migrate/connection/cleanup 分權；trusted coordinator 讀真實來源 gate／restore evidence，public 声明無法越階段；資料最小化、secret不入 manifest；所有 external endpoints 沿 SP-09。控制面 cert／signature只证明来源及批准 tuple，不证明库存或付款真實。無法約束惡意 fork 的私人 DB，但可拒絕它成為平台認可 writer 或事件來源。

**可信服務／鎖序：** 沿共用 member/service 驗權→tenant membership→instance→binding→migration→domain 順序，revoke/fence/commit 同順序；若同時操作多 instances，以 UUID 排序。post-I/O/receipt 等待後重驗 current clocks/authority。source fence lock 不能持有跨網路等待；先原子封 gate，再獨立 drain/status。所有數值上限先 admission，不能用外部 data 觸發無限 cascade。

**建議 profile，待 decision log：** 同 instance 一件 migration；同 tenant 一個 fencing/cutover worker；bulk copying 可受 quota 平行。drain 建議 60 秒後轉需核對而非強殺；實際停寫可接受上限依資料量/恢復測試由 plan 明示。同步 status request 依共同 10 秒起點；重試／receipt／offline 窗口共用 OPEN-05，不各規格自選。受理後未知狀態不受 transport retry 上限自動判 failed；到上限轉 reconciliation，保留目前安全 fence。

正式 capacity 必須量測 restore、object verify、registry/floor outage、最大 backlog 及其他 tenant latency；沒有容量 policy 不默認無限。所有故障限定受影響 instance/dependencies，不把一個外部 endpoint 失敗變成全站停用。

## 10. 可重現驗收、release gates 與證據

下列一律 **待實作／not_run**。測試 seed 與資料量公開合成；不使用正式 CRM、真實秘密或 admin credential 證明一般權限。

**Fixture topology：** 平台 API/DB A，獨立 inventory provider/API/DB B，獨立 object stores，外部 recovery authority 測試 port 使用與 DB A snapshot 不同生命週期的 durable state；tenant A 的 shop 留平台、inventory 外移，tenant B 同時寫 inventory。每者用受限角色及不同憑證。A 3 SKUs、可核對 reserve/release/status、附件、custom config、已提交未送 event、consumer inbox、1 pending command。fixture event_sequence／versions 超過 JS 安全整數範圍仍精確。

| T-ID | 步驟／故障注入 | 必須觀察與 evidence |
| --- | --- | --- |
| T-041 | 只遷 A inventory；移除 shop 對 source inventory DB 的可見性；shop 保留原部署 | A shop 依 SP-05 port reserve/release/status 正確；B 持續；IDs 不變；中央殘留掃描符合 SP-06 |
| T-042 | gate 前、gate 後分別送寫；capture 同時有 object replace/delete/GC | 先前提交精確納入 cutoff，後者拒絕；DB rows/ref/object digest 同切點；任何缺 pin 阻擋 |
| T-043 | 每相鄰 stage 前後 crash；source fence／registry CAS／外部 checkpoint／activation 各 ACK 丟失；两個 coordinator 競爭 | 每個 barrier 記 writer count 0或1，從不2；epoch嚴格升、同epoch binding唯一；未知時兩端閉鎖；同operation對帳收斂 |
| T-044 | source 在業務提交後 response 消失；pending outbox／inbox移交；worker失去lease後takeover；偽造receipt | operation_id不變、只一次扣量；event/inbox無丟失／重複；偽造歷史不授權，unknown保存可核對refs |
| T-045 | target_active 後新增 reservation/附件；請求 cancel／直接舊source activation | 409 reverse_migration_required；完整反向移交或forwardfix保留新資料，epoch再次增加；source舊快照不能開寫 |
| T-033／T-049 | cutover後送合法cutoff舊event、未列舊event、同ID異payload、撤key後歷史replay | 只有精確cutoff＋目前replay權限者接受；合法事實不丟，其他拒絕；aggregate版本不倒退 |
| T-046 | 完成後掃 DB、projection、search、thumb、summary、cache、logs、backup索引 | 原live私有副本移除；僅allowlist；备份remaining/retain_until可查，cleanup report不用原私有值 |
| T-047 | restore CAS以前DB快照；外部floor保留切換後；再restore revoked credential與tombstone前快照 | startup/dispatch fail closed；不復活source、token、已刪資料；核對到新generation後才可啟用 |
| T-048／T-050 | target可達性/平台/authority分別離線；完全disconnect外部模組 | 本地合法操作保持；平台副作用真實pending/denied；不刪本地資料；未知迁移不擅自改writer |
| T-027／T-037–040 | 保留身份bundle往返、clone對照、缺附件／惡意manifest | stable refs逐一核對；clone另建ID；惡意import不污染；app/data/interop完整 |
| T-054／T-058 | legacy owner不明、legacy writer漏gate；大量資料／慢目標／worker終止 | 仅受影響instance拒迁；其他tenant可用；記peak RSS/locks/bytes/latency與reconcile用時 |

**發布條件：** 必须有真實 source writer gate 覆蓋清單（包括 jobs／legacy）、registry CAS/floor outage 與 restore反例、同fixture hosted/external對等、完整bundle dry run、版本/ACL撤權、late-event exact cutoff及target寫後反向移交證據。tenant/service能力未落地、OPEN-15 recovery host未定、資料catalog不完整、任一未知副作用未核對，都不能宣稱可正式迁移。

後續 PR 納入現有 `npm test`／`npm run test:contracts`／`npm run test:repos`；E2E依先build後隔離測試規則。記錄 source/artifact pins、精確環境、每個 fault point、實際執行指令/結果及 not_run。連回 UF CORE/MEDIA/EXEC-OPS/U7 現有 ledger；未知細項 ID 標 unmapped，不由本新規格自證 foundation 完成。
