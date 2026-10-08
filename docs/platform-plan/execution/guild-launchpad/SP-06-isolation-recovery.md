# SP-06 — 資料責任、租戶隔離、儲存與恢復

## 1. 文件識別、來源與範圍

- ID：SP-06；版本：0.1.0；狀態：`planned / implementation_not_started / acceptance_not_run`
- 2026-10-07 註：上一行是 2026-10-05 規格草案的狀態，保留不改。之後 P-C2（#181，merge `57b610ab`，migration 123）已實作本規格的一部分並合併到 main；部署、啟用與驗收的目前狀態只記在 [README「目前狀態」](README.md#目前狀態)。
- 程式來源：`FreeTWAI-AI/freedom-platform@567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`，2026-10-05 讀取；意圖來源：完整《Freedom Guild Launchpad Architecture Plan v1.0》§8、§14、§20、§24及附錄 A/B
- 主責：D-10、D-11、D-17；R-021–R-025、R-046–R-047；T-021–T-025、T-046–T-047。協作 D-13、D-15、D-18、D-20；R-026、R-039–R-045；T-026、T-039–T-045
- 單一資料責任清單：[data-responsibility.md](data-responsibility.md)；共同DTO：[contracts.md](contracts.md)；精確路徑：[repository-map.md](repository-map.md)；參數/未決：[decision-log.md](decision-log.md)；追蹤：[traceability.json](traceability.json)
- Foundation 的 [168 項來源驗收](../unified-foundation/source-acceptance.md)與 [共同驗收](../unified-foundation/acceptance.md)不被覆蓋。延伸 R2:S01–S12/A01–A08/M01–M08、AP:WORK-03/06/13、AP:OPS-07；此引用不宣稱新spec已實作或來源ledger已完成

本PR只寫spec，不創建DB/bucket/排程，不調policy，不讀寫正式tenant資料。來源文件中的歷史部署/恢復紀錄是「該文件記錄」，本輪未重跑，不能擴張成全module或所有媒體已production驗收。

## 2. 使用流程、前後狀態、非目標與依賴

### 2.1 正常與故障流程

1. 有權成員選tenant/instance；server確認當前membership及target ACL。資料只從該scope query，下載metadata/bytes亦驗相同scope，關聯不能指向另一tenant
2. 檔案採prepare→外部immutable write/readback→fresh authorize/finalize，bytes在R2、metadata在PG。失敗保留同intent，未ready附件不出現在成功結果
3. Owner以獨立backup/export scope請求單module一致備份。模組先取得backup-owned暫時pause token並受控停寫，已開始操作依SP-08 drain/核對，再固定DB snapshot、object pins及event/receipt切點；成功、取消或失敗均依§6.2的CAS release恢復原先合法可寫狀態，不能把備份pause當遷移永久fence
4. restore進隔離空環境，先驗內容/引用/權限/independent recovery floor，再放行；不存在「把舊dump蓋回production就立即可用」
5. 外移完成後，source維持fenced，建立可審查的清理計畫；線上主表、R2、衍生副本及備份分別列狀態/期限。仍在合法保留備份中的內容如實標記，不能承諾所有歷史副本當下消失

### 2.2 前置及不必等待事項

- SP-02 tenant/member/scope與SP-04 instance建立是新tenant資料啟用前置；不能拿目前personal/community scope宣稱tenant隔離已存在
- SP-05提供最小event/receipt/projection；SP-07 portable manifest唯一責任；SP-08單writer切換及cutoff；SP-09憑證/revocation/recovery authority；SP-12 legacy轉換及發布門檻
- 可先以synthetic資料完成catalog差分檢查、受限DB角色、RLS/FK反例、真R2 runtime、isolated restore及故障測試；不必等公會客製化、所有外部模組、正式金流
- 非目標：宣稱tenant有不受限制的法律資料所有權、另建競爭storage服務、跨DB+R2原子交易、零RPO/PITR、任意DB引擎轉換、立即抹除已送到第三方的所有資料

## 3. 既有入口及 KEEP／MODIFY／NEW／GENERATED

| 類別 | 已驗證的精確路徑 | 接續方式及目前限制 |
| --- | --- | --- |
| KEEP | `packages/asset-storage/index.ts`、`packages/asset-storage/r2.ts`、`packages/asset-storage/profiles.ts` | 沿immutable PUT、bounded GET/readback digest、profile上限；native R2 delete預設關閉，ETag不是內容hash |
| MODIFY | `modules/assets/engine.ts`、`modules/assets/index.ts`、`modules/assets/media-domain.ts`、`modules/assets/schema.ts` | 沿既有lifecycle engine加入經審查tenant附件purpose/typed target；不能直接使personal Asset適用任意tenant |
| MODIFY | `modules/assets/maintenance.ts`、`modules/assets/object-write-effects.ts` | 沿permanent deletion fence、live-reference/pin/barrier與late PUT處理；加入module ownership和copy cleanup核對，不另造一套GC |
| KEEP | `migrations/079_asset_upload_lifecycle.sql`、`migrations/082_asset_maintenance.sql`、`migrations/098_domain_media_asset_profiles.sql`、`migrations/108_domain_media_gc_write_effects.sql` | 現有schema/constraints/用途的歷史migration不改；新tenant scope/ownership/FK以additive migration延伸 |
| MODIFY | `packages/resource-scopes/index.ts`、`packages/scoped-commands/index.ts` | 本來只處理member personal/community；需SP-02/05的新tenant context及fresh ACL，不能用body.owner_id代替 |
| KEEP | `packages/db/transaction.ts`、`packages/db/member-command.ts` | 舊交易及receipt相容邊界保持；新的tenant transaction wrapper需處理pool安全而不靜默改舊入口 |
| MODIFY | `packages/media-migration/backup-coordinator.ts`、`packages/media-migration/backup-transfer.ts` | 現same-exported-snapshot整schema/representation備份可重用；新增tenant/module篩選且維持snapshot/pin一致，不把整庫dump直接交會員 |
| MODIFY | `packages/media-migration/backup-archive.ts`、`packages/media-migration/backup-evidence.ts` | 現sealed recovery set、streaming digest、逐表evidence及empty-target restore可重用；module backup另有versioned envelope與scope驗證 |
| MODIFY | `packages/media-migration/backup-retention.ts`、`packages/media-migration/backup-gc-precondition.ts`、`packages/media-migration/backup-daily.ts` | 現retention規劃/GC precondition/daily runner不是所有雲端操作已啟用；module保留/cleanup不可跳過原barrier |
| KEEP | `packages/media-migration/restore-acl-lockdown.ts` | 現恢復後撤PUBLIC execute是特定reviewed definer程序的lockdown，不是完整tenant/RLS/credential recovery authority |
| KEEP | `contracts/execution/v2/credential-recovery-floor.schema.json` | 是既有broker structural floor例子；僅parse不給權，不能當通用module恢復服務已存在 |
| KEEP | `docs/platform-plan/execution/unified-foundation/r2-recovery-retirement-2026-10-04.md`、`docs/platform-plan/execution/unified-foundation/handoff-2026-10-04.md` | 保留已記錄來源狀態：GC/legacy bytes清除仍有gate；五類媒體及其他未驗範圍不被新spec宣稱完成 |
| NEW（提案） | `packages/resource-scopes/tenant-transaction.ts`、`modules/module-data/catalog.ts`、`modules/module-data/cleanup.ts`、`modules/module-data/recovery.ts` | tenant transaction、catalog coverage、cleanup協調、recovery admission；仍使用既有核心，不新增另一個通用job引擎 |
| NEW（提案） | `apps/platform-api/src/routes/module-data.ts`、`tests/runtime/tenant-data-isolation.test.ts`、`tests/integration/module-recovery.test.ts` | 新server路由及受限role/真实R2/isolated restore驗收 |
| NEW（提案） | 新additive migration（實作時分配下一可用序號） | tenant asset mapping、dataset catalog version refs、cleanup/recovery operations、RLS/FK；未在本文預占序號 |
| GENERATED | 新tenant/module authoring entry的JSON Schema/SDK/fixture outputs | 路徑由SP-12登記；不手寫第二份schema，不把本Markdown表當已發布validator |

回歸入口已存在：`tests/runtime/resource-scopes.test.ts`、`asset-lifecycle.test.ts`、`asset-lifecycle-races.test.ts`、`asset-maintenance.test.ts`、`asset-r2.test.ts`、`media-backup-transfer.test.ts`、`media-backup-archive.test.ts`、`media-backup-retention.test.ts`、`tests/integration/media-backup-restore.test.ts`。這些測試的存在不證明新tenant行為已驗收。

## 4. 資料模型、目錄與隔離約束

### 4.1 資料責任目錄是實作輸入

[data-responsibility.md](data-responsibility.md)為跨spec唯一authoritative catalog；後續machine-readable source由共同owner從該責任轉成可驗證schema。每個dataset必須含：

`dataset_key, catalog_version, physical_locations[], classification, authoritative_module, tenant_resolution, identity_keys, readable_by, writable_by, export_scope, dependency_refs, sensitivity, sharing_purpose, field_allowlist, central_retention, derived_copies[], deletion_and_restore, verification_refs`。

- physical_locations需列實際table/column或object purpose/variant、cache key namespace、search index/collection、queue/outbox payload、notification、summary/embedding/model trace、backup archive及operator evidence，不只主表
- tenant_resolution選`direct`或具名FK鏈/受驗證ref resolver；必須有negative fixture。不適用tenant的平台原生資料亦要說明scope及不可隨模組刪除的原因
- retention記purpose、policy revision、期限或明確event-based終點、access class、hold審批/expiry、delete propagation及recovery處理；`forever`、`needed`、`analytics`不是足夠用途
- 每個新私有欄位和衍生寫入必須有catalog映射；schema、query與copy-inventory掃描發現未登錄資料時CI失敗，不能只靠人工說「無敏感欄位」

### 4.2 提案實體與constraint

| 實體／型別 | 最小欄位與唯一性 | 權威／敏感性 |
| --- | --- | --- |
| 既有domain row的tenant擴充 | tenant_id、instance_id、resource_id、version、catalog_version；UNIQUE(tenant_id,instance_id,resource_id)；tenant/instance複合FK | domain authority單writer；tenant不可任意UPDATE重綁；既有resource ID保持 |
| `module_asset_ownership`（提案） | asset_id、tenant_id、instance_id、purpose、target_ref、ownership_version、policy_ref；typed composite FK到Asset+instance+target | 描述模組歸屬，不等於上傳者永久owner；必須先完成tenant-compatible Asset scope/constraints，不能單靠sidecar绕過personal restrictions |
| `module_asset_reference`（提案） | tenant_id、instance_id、target_ref、asset_id、representation_id、variant、ref_state、version | 默認同tenant FK；跨tenant只能另用明確shared reference+policy，不以裸asset_id連結 |
| `module_backup`（提案） | backup_id、tenant_id、instance_id、operation_id、state、version、catalog_version、contract_ref、cutoff_ref、capture_id、manifest_ref、manifest_digest、created_at、retention_until | 私有；不含download bearer URL。retention及hold以獨立版本policy控制 |
| `module_backup_pause`（提案） | pause_token_id、owner_operation_id、tenant_id、instance_id、binding_id、authority_epoch、pause_version、prior_write_mode、state=`held|release_requested|released|blocked|needs_reconciliation`；token唯一且不可轉給其他operation | 只擁有本backup暫時pause；不代表migration/security fence；release不能降低epoch或清除其他gate |
| `module_cleanup_plan` / step | plan_id、tenant_id、instance_id、source_binding_id、migration_ref?、policy_ref、inventory_digest、approval_ref、state、version；step dataset/copy_kind、status、last_observation、deadline、problem_code | 只計劃指定source copy，不能刪current external authority；approval_ref須current backing record，非JSON自證 |
| `module_tombstone` | tenant_id、instance_id、resource_type、resource_id、deletion_generation、effective_at、reason_code、scope_of_delete、digest | 最小身份/阻復活資料；不可帶原內容；tenant與module tombstone不同於單asset fence |
| `module_recovery_gate` | recovery_id、tenant_id、instance_id、backup_id、state、version、observed_floor、validated_manifest_digest、activation_permit_ref? | app DB中的結果快取，不能是獨立recovery authority本身 |
| independent recovery record | environment、instance_id、authority_epoch_floor、binding_id、recovery_generation、revocation_watermark、tombstone_watermark、version、checked_at、valid_until | 由不隨該app DB回滾的可信控制面提供；認證接口/保存位置須獨立驗收，缺失時不准activation |

本spec的`policy_ref`使用共同`PolicyRef={policy_key:StableKey,version:Version}`；server解析registered immutable policy revision，不能接受caller自帶policy內容或自行授權。所有IDs使用共同`OpaqueId`，version/epoch/generation使用正十進位`Version/Epoch`字串。內部計數可非負，wire version不能number或0。`ContractRef`精確為 `{family,version,source_commit,artifact_sha256,behavior_profile}`，型別詳contracts.md。

### 4.3 三層tenant隔離

1. **query/domain層：** 每一list/get/search/export/job/aggregation從已認證server context解析tenant+instance，查詢明列predicate。共同/私有頁分開；不得從slug/email/header/body推導authority；所有batch逐ref驗證，同batch混A/B拒絕而非partial洩漏
2. **資料約束層：** tenant內unique keys含tenant與正確module作用域；child FK使用`(tenant_id,instance_id,parent_id)`，不得只有全域UUID FK。跨module使用registered stable ResourceRef+port，跨tenant關係經participants/field policy，不建立默認私有join
3. **RLS第二防線：** 對新tenant私有表採ENABLE及必要FORCE RLS，SELECT/UPDATE/DELETE USING及INSERT/UPDATE WITH CHECK同時覆蓋；缺tenant context fail-closed。Runtime非table owner、非superuser、無BYPASSRLS/CREATE/SET ROLE到owner、無TRUNCATE、無未審核SECURITY DEFINER。RLS不取代實際member/role/target ACL；能直接以被攻陷runtime設定任意context的攻擊，不可聲稱由GUC本身解決

可信tenant transaction wrapper在同一connection/transaction以transaction-local context設定server已驗證tenant，所有受控query限該callback。Begin前/交易外查私有表拒絕；不得將connection交給外部I/O。commit/rollback後LOCAL context清除；exception/cancel/timeout必定rollback，rollback失敗則destroy該pool connection，不可放回池供下一request。長jobs每個batch重新認證grant/tenant，不能沿用先前request context。測試要核對真runtime_role與pool reuse，不以admin SELECT無洩漏當通過。

### 4.4 中央留存及所有副本

| 類別 | 外移後可留的精確方向 | 不可留／清理責任 |
| --- | --- | --- |
| 平台原生 | 平台會員/公會資格、instance registry/binding、最小授權/稽核事實，依各自policy | 外移不刪整個會員/公會，亦不可因平台原生名稱而無限收集业务內容 |
| 私有主檔 | 完成cutover後source暫時fenced的恢复副本，期限及理由列cleanup plan | CRM全表、跟進notes、附件、完整私有工作不得以「同步/搜尋」永久保留 |
| 互通projection | source_ref、purpose、allowlisted display fields、source epoch/version、as_of/expiry；撤share後不可見及清除 | 不得轉成第二可編輯CRM、不帶未授權成本/客戶清單/自由文字 |
| 交易必要快照 | order authority的當次履約欄位、參與方/約定版本/必要事實與明確期限 | CRM刪除不cascade對方合法order；order snapshot不提供完整CRM search/export後門，最新名稱需current read grant |
| command/event/通知 | 最小refs/digests/outcome/code；保留必要去重/訂閱進度 | 不保存原request/完整CRM作調試；email/推播已送副本需列受控邊界，不能承諾收回對方收件匣 |
| 備份/證據 | 隔離access、明確retention/hold、最小manifest/evidence；還原受tombstone/revocation限制 | 不能承諾立刻從所有歷史archive消失；公開PR證據只synthetic/aggregate，無私有payload或逐人hash |

快取、搜尋、縮圖、summary、embedding、分析、notification payload及錯誤trace全部是copy。刪主要表只完成其中一步。跨tenant全域content-hash dedup初版不採用；即使bytes相同也不洩漏他方檔案是否存在，不因A刪除移掉B合法reference。

## 5. API、command、query、event、錯誤及並行

### 5.1 HTTP與內部ports

以下全為**proposed target APIs**，基底 `/api/v1/tenants/{tenant_id}/instances/{instance_id}`。身份來自current member或受驗service adapter；path target必須匹配server認證上下文與真實FK。Cookie路徑沿existing CSRF；credential/keys不放body、URL或receipt。

| Method／相對path | 權限與嚴格input | output與效果 |
| --- | --- | --- |
| GET `/data-catalog` | `data.catalog.read`；可選已知catalog_version | `{catalog_version,datasets:[authorized metadata],source_instance_id}`，不回實際客戶內容/內部key |
| POST `/assets/intents` | `assets.write`及target-domain write；Idempotency-Key；If-Match target version；`{target_ref,purpose,content_type,byte_size,sha256}` | 202 Operation→intent ref；caller不能給object_key/bucket/verified=true/profile caps |
| POST `/assets/intents/{intent_id}/claim` | `assets.write`；key+If-Match intent；`{}`；先前lease到期且intent仍可續時才單調增fence | 202 Operation→同intent ref；GET intent取得該次lease metadata，不把claim receipt當current lease |
| GET `/assets/intents/{intent_id}` | current owner/domain read；path intent的tenant/target必須匹配 | `{intent_id,asset_id,state,version,expires_at,fence?:Version,lease_token?,lease_expires_at?}`；lease只回有當前續寫權的人；fence初始內部0尚不可write且wire省略；已claim的wire fence為正Version |
| PUT `/assets/intents/{intent_id}/content` | 當前scope/intent/fence/lease驗證；`X-Upload-Fence: Version`、`X-Upload-Lease: OpaqueId`、Idempotency-Key，stream bytes，server-bounded size/deadline；opaque correlation lease不是bearer權限 | 202 Operation；immutable object只寫同intent身份，unknown PUT先HEAD+完整GET驗digest，不換key重做 |
| POST `/assets/intents/{intent_id}/finalize` | `assets.write`；key+If-Match target；`{fence:Version,lease_token:OpaqueId}` | 202 Operation→asset ref；先transaction外verify bytes，再短transaction驗fresh ACL/policy/version/fence、atomically publish pointer |
| GET/HEAD `/assets/{asset_id}/representations/{variant}` | `assets.read`+target-domain read；每次含cache/304/Range均先ACL | bytes/headers或metadata；不回raw R2 key；missing/corrupt object→503，不退回舊DB私有blob |
| POST `/backups` | 專門`module.data.export`（不等於普通edit）；key+If-Match instance；`{policy_ref,reason_code}`，reason_code為`user_requested|pre_migration|scheduled_policy`，最後一項限當前專門系統grant | 202 Operation→backup ref；scope由path和catalog解析，不接受任意table list/SQL/storage URL |
| GET `/backups/{backup_id}` | 當前`module.data.export` | `{backup_id,state,version,cutoff_ref,manifest_digest,created_at,retention_until,problem?}`，不泄漏object paths |
| POST `/restores` | `module.data.import`+target管理批准；key+If-Match instance；`{backup_ref,target_binding_ref,mode:"isolated_validation"}` | 202 Operation→recovery ref；僅隔離驗證，不自動activation；replace/migrate由SP-07/08專門流程 |
| POST `/cleanup-plans` | `module.cleanup.plan`；key+If-Match instance；`{source_binding_ref,migration_ref?,policy_ref}` | 202 Operation→plan ref；生成dry-run inventory+摘要，不刪任何bytes |
| POST `/cleanup-plans/{plan_id}/execute` | current `module.cleanup.execute`、明確target/批准；key+If-Match plan；`{approved_inventory_digest}` | 202 Operation；inventory變動需重新plan/approve，不擴大刪除範圍 |
| GET `/cleanup-plans/{plan_id}` | `module.cleanup.read` | `{plan_id,state,version,steps:[{copy_kind,state,deadline?,problem?}],remaining_backup_until?,limitations[]}`；不宣稱total erasure |
| GET `/operations/{operation_id}` | current `module.operation.read`且target可讀 | 共用Operation；operation成功只是該步已完成，不代表備份已部署或所有copies不存在 |

Mutation回應统一 `{operation_id,state,version,resource_ref?,retry_after_seconds?,problem?}`。State只有 requested/running/succeeded/failed/needs_reconciliation/cancelled。Idempotency-Key沿既有8–128字元profile，If-Match wire為quoted decimal ETag `"<Version>"`；舊namespace/digest保持，tenant adapter由SP-05延伸。成功receipt replay只讀原結果，不能重新attach已被取代資產或覆蓋新pointer。

**內部端口（非caller JSON）**：`TenantContextResolver`、`CatalogResolver`、`AuthorizedSnapshotWriter`、`ObjectStore`、`BackupProtection`、`RestoreAuthorization`、`RecoveryAuthority`。每個port持有經審查implementation/identity/policy；client不能upload一份“VerifiedContext”或manifest grant使其trusted。Snapshot writer可短期持有PG exported snapshot讀交易，絕不在domain row lock期間做object/network I/O。

### 5.2 Event與錯誤

Event沿SP-05唯一EventEnvelope，僅最小payload：`freedom.module.backup.verified.v1`帶backup_id/cutoff_ref/manifest_digest；`freedom.module.cleanup.progressed.v1`帶plan_id/step summary/version；`freedom.module.restore.blocked.v1`帶recovery_id/fixed problem code。Publisher是本模組authority；tenant permission先於inbox/receipt。私有asset不因event進公共community feed。

Problem wire沿 `{type,title,status,code,detail}`。以下code為新profile提案，不改舊route：400 `invalid_input`；401 `authentication_required`；403 `capability_denied|policy_unconfigured`；404 `not_found`（跨tenant與不存在同形）；409 `idempotency_conflict|backup_in_progress|cleanup_inventory_changed|recovery_floor_conflict|asset_fenced`；412 `version_conflict`；428 `version_required`；410 `backup_expired|replay_window_expired`；422 `import_invalid|catalog_incomplete`；429 `quota_exceeded`；503 `dependency_unavailable|recovery_authority_unavailable|object_unavailable`。未知I/O結果以operation needs_reconciliation呈現，不用503當成可任意新key再做。

Policy/revocation須在receipt前及最後阻塞鎖等待後重驗DB decision clock。錯tenant、endpoint、scope、epoch先拒絕；不能先查backup存在再決定是否有權。昂貴prepare前預留quota，同receipt只預留一次；未確定清除的bytes與orphan仍計費用/配額，不能因一次404釋放。

## 6. 狀態機、一致切點及恢復演算法

### 6.1 備份與附件狀態

| 對象 | 狀態及轉換 | unknown／重啟 |
| --- | --- | --- |
| upload | prepared→processing→stored→finalized；lease fence單調增加 | PUT/verify不確定保留identity；DB finalize失敗不能報ready；過期/撤權不自動抹除仍有晚到PUT可能的object |
| backup | requested→quiescing→capturing→pinned→copying→verifying→verified；任一未確定→needs_reconciliation；明確無效→failed | content verified與pause release分開記錄；ordinary backup外層Operation只有在owned pause已確認release（或原本沒有取得pause）才可succeeded。失敗/取消也持久排程CAS release；pins不因timeout自動釋放 |
| cleanup | planned→approved→running→verified_with_retention / needs_reconciliation / blocked | partial完成逐step保存；不能回滾永久fence；still-in-backup與第三方不可控制copy需明示 |
| recovery | requested→isolated_restore→validating→floor_reconciling→ready_for_activation / blocked | 這些是domain狀態，外層Operation仍共用六態；ready_for_activation不是已對外服務 |

### 6.2 單模組同一cutoff備份

1. 鎖定tenant/instance/binding及catalog/contract版本，建立stable backup operation與容量reservation。普通backup以write-admission gate取得**備份自有的暫時pause token**，原子記owner operation、原binding/epoch、gate version及prior write mode；不能設定SP-08的永久source fence或增加authority epoch。列出in-flight operation，每筆drain/核對，不把unknown刪掉。遷移導出的backup由migration既有永久fence保護，backup不擁有解除該fence的token
2. 先提交capture deletion barrier，再建立DB一致read snapshot。從同snapshot讀所有catalog責任rows、資產ref、outbox/inbox/receipt及per-aggregate sequence/aggregate_version高水位
3. 受限snapshot exporter及pin collector必須使用**同一exported snapshot**；在同cutoff產生immutable object representation ID、size、digest、policy revision清單。不能把一般先SELECT列表再pg_dump當同一切點。共用DB的tenant資料使用受驗scope-aware selective export；整庫dump只可在隔離可信operator環境還原後選取，不交付租戶
4. Pins由實際持久metadata/FK核對、按ID順序保存；barrier覆蓋enumeration→pin窗口。若為可續跑而lease過期，保護fail-closed，直到受控reconcile/abort/release；不准TTL自動unpin
5. Snapshot完成後釋放DB snapshot connection；每個immutable object在交易外bounded streaming copy，完整readback SHA-256而非只ETag/HEAD。缺一個variant、digest錯或容量中斷使backup未完成；保留已存在副作用供續跑
6. Seal manifest（schema/catalog/contract/application refs、cutoff、row/refs evidence、objects digest、receipt/event接點、tenant排除證據、retention）並從實際目的地重新download驗全部成員。Manifest format由SP-07唯一authoring；不新增與其競爭的bundle
7. restore drill在隔離環境驗IDs/FK/domain invariants/object bytes/cursors/receipt replay，不僅row count。完成、取消及所有failure出口均持久化`release_requested`給同backup pause，而非只在process finally清狀態；重啟worker必續這個release步驟。刪除保護pins另按backup retention/reconcile核准釋放，**解除暫時停寫不等於unpin或宣稱copy已完成**
8. Pause release開短交易重新驗目前authority與policy，以`pause_token_id + owner_operation_id + binding_id + authority_epoch + pause_version` CAS；僅當token仍held/release_requested、binding/epoch未變、沒有獨立migration/security fence，且原write mode本來可寫時，移除本backup的pause gate。不能清其他gate、倒退epoch、把原本readonly的instance改可寫。未取得token或已confirmed released是可核對no-op；token/binding/epoch不同或新安全fence使release blocked，交current authority處理，不能強制重開
9. Release commit後ACK丟失沿同token查gate/operation狀態，不新建token，不猜已resume；結果不明為needs_reconciliation。UI分別顯示備份內容verified與「原模組恢復寫入確認中」。普通backup不能以內容verified掩蓋仍由自己pause的source；cancel/failed亦保留cleanup/release責任到有確定結果。遷移備份絕不走ordinary release，source保持SP-08 fence直到其受控流程決定

現`createConsistentAssetBackup`要求至少兩個pool connection，維持snapshot直到pin capture與dump完成；這個現有限制不能被新wrapper忽略。2026-10-04歷史每日備份文件記錄的是dump後immutable object superset、依賴GC OFF且零deletion fences；不能直接宣稱其具module cutoff/pins/PITR。新流程不得開GC來假裝清理，需先滿足現有backup保護前置。

暫時pause release與backup內容/retention是不同持久狀態：即使copy已失敗，只有本backup的pause可以在上述guard通過時解除，使原合法工作恢復；未完整backup仍為failed，immutable已寫物件及pins留reconcile。原backup token不能在後續migration/revoke後復活舊writer。

### 6.3 Restore anti-resurrection gate

1. 建立空的隔離DB/object target；無公開binding、無queue消費/cron/notification/外部dispatch。驗指定source/target環境、release/schema ledger、archive/member digests及scope；任一錯誤保持隔離
2. 還原rows/objects是data import，不接受dump內的session/credentials/role grants/replay permit作權限。必要身份只保留refs；credentials重新認證，舊runtime/operation不得自動續跑
3. 從**不隨本次app DB rollback**的可信recovery authority取得最新、未過期、environment/instance-bound的recovery generation、current binding/authority epoch floor、撤銷高水位和刪除tombstone高水位。只把denylist一起放進同dump再還原無效。其具體storage/認證部署需SP-09/12證據；未建立就blocked
4. 先補套所有cutoff之後的resource/asset tombstones、share撤銷、membership/grant/token/refresh-family撤銷、operation/dispatch fence，直到各watermark≥independent floor。Delete歷史可以阻止reinsert/attach及projection再生；不是只讓目前主表查不到
5. Registry的epoch不得低於floor，綁定不能回旧writer。SP-08的binding/epoch CAS與independent floor不是跨系統原子交易：CAS成功但floor確認unknown時兩端維持fenced，沿同migration/recovery operation查證，禁止「先開再補」
6. 恢復新tenant RLS/actual-role grants/FORCE設定，撤dump可能帶回的PUBLIC execute。沿`restore-acl-lockdown.ts`修復特定既有definer ACL，另逐項驗新tenant ACL；不把此工具回success當完整恢復權限
7. 原outbox/notification/已接受command只進reconciliation；查exact operation/event identity與當前authority後判斷是否可續。沒有provider receipts的外部結果維持unknown，不能因dump內pending就再次付款/寄信/預留
8. 以真runtime角色執行A/B及revoked actor讀寫/下載/Range/export/job負測試，核對物件引用/業務不變量/cutoff後，再向trusted控制面申請短期activation permit，綁recovery generation、manifest digest、instance、binding、epoch。服務每次admission驗current floor，舊permit不可在restore後重用

Floor不可用或過期：不啟用新寫、外部dispatch或私有恢復資料讀取。既有外部模組的獨立純本地工作按SP-09本地政策處理，不把中央recovery故障當沒收本地資料理由。完成驗證只代表可申請activation，實際部署/切換另需授權與證據。

### 6.4 清理與遲到write

先停止source私有read與write、標tombstone/永久deletion fence，立即撤可撤投影/下載授權；物理delete稍後做。每step先短transaction驗current plan/copy identity/live refs/backup pins/intent/write-effect，再commit，外部delete/HEAD在鎖外，最後以lease fence記 `missing|present|unknown`。

Unknown DELETE不等於全部刪除；晚到PUT可以重建同key，永久fence使其不可attach/read，reconciler以同key重掃直到policy可宣告受控步驟完成。禁止刪除後清fence重用ID。跨tenant合法share/pin的byte還在使用時不得收回。清理不能擅自reset既有append-onlyreceipt，compact需獨立reviewed lifecycle。

## 7. UI、可見性、空狀態與人工接手

- Tenant storage panel顯示current module、代管位置、live/pending/retired/pinned bytes、backup latest verified cutoff與恢復範圍；unknown不是0 bytes
- Backup頁顯示「等待停寫／複製附件／核對／需處理」，只對verified backup開受控download；download每次重新驗scope，過期則明確說明，不放永久public URL
- Restore preview顯示target、備份cutoff、會保留的IDs、tombstone/撤權套用、權威/epoch差異、未解決operation及不會自動dispatch。無寫權的人看不到操作鈕，但server仍拒絕
- 清理確認列受影響dataset/copy類型、總bytes/數量（當前權限內）、source位置、不可逆steps、backup残留最晚期限/hold、不可控制第三方副本；拒絕「全部刪除」含糊單一checkbox
- 任何stage失敗保留operation ref、safe問題及下一安全步驟；retry沿原operation。資產metadata已ready但object不可用顯「附件暫時無法讀取」，不能fallback私有legacy bytes
- 手機單欄，鍵盤可完成preview/cancel/retry，loading/errors用aria-live/文字，焦點回原動作。切tenant清空所有私有assets/previews/download queue；late response比對tenant/instance/view generation
- 人工恢復工具的權限與一般使用者UI分離；詳情可查approved cutoff/digest/steps，不顯DB URL、bucket key、tokens或真正客戶payload。沒有「略過floor」捷徑

## 8. 匯出／匯入／升級／legacy轉換

- 私有module export按catalog白名單覆蓋主表、設定、extensions、附件全variants、必要歷史與event/receipt接點；平台原生會員及授權只带合法refs，不能附全users/session/API secrets
- Import驗schema、scope、refs、尺寸、digest及data policy；進isolated staging，任一不合法不污染正式module。可攜資料不能給受讓者原租戶以外權限；clone新identity與map，migration保留ID與唯一authority
- Legacy採expand→bounded backfill→compare→switch→contract。從真owner/FK映射tenant，多品牌/共同業務/無主/歧義逐列列帳，不落全域default tenant或當前登入者。未知資源暫停高風險export/migrate，不阻已明確資料正常工作
- 現public/member avatar與公會event media不因其uploader屬某tenant就被搬成tenant私有附件；需按原domain/public-share政策分類。已存在asset不以UPDATE owner方式轉移；新typed mapping或明確合法copy有新asset身份/對照
- 舊合法media URL沿既有ACL/bridge/r2-only和安全redirect相容，仍每次驗target state；不因URL不變允許匿名新私有讀取。新upload不得新增DB media blob，crypto bytea等非media例外維持原用途
- 現legacy bytes清理/GC仍受foundation recovery gate；對尚未完成來源驗收的用途不擅自開delete。清理前dry-run diff必列scope、row/asset/ref counts、歧義、permission change與保留原因
- 正式backfill/清理/restore要另有授權及恢復備份；本spec提供演算法和fixtures，不是執行這些操作的批准

## 9. 威脅模型、成本、容量與待決policy

| 風險／反例 | 必要防線 |
| --- | --- |
| 猜asset UUID、variant、object prefix、backup URL | current target ACL在GET/HEAD/304/Range前；private bucket；secret-free refs；URL/prefix不授權 |
| A連線pool殘留到B、錯誤後LOCAL context外洩 | 同connection transaction、fail-closed RLS、rollback/destroy、真runtime role + pool重用故障矩陣 |
| 跨tenant FK、job/cache/search繞scope | composite constraints、server context、catalog-covered派生key、每batch授權、索引filter後端強制 |
| 備份snapshot與object列表分時，GC删走附件 | 同snapshot refs + committed barrier + pins，full bytes digest；expiry不能自動unpin |
| 舊備份復活撤銷key、舊writer、deleted CRM或cache | independent floor、tombstone/revocation先套用、dispatch gate、activation permit與current authority checks |
| log/summary/notification成永久CRM副本 | 明確field allowlist及purpose、受控生成、secret/payload-safe traces、derived cleanup steps |
| caller送任意table/URL/path，zip bomb或超大文件 | server catalog選擇、typed ref、bounded streaming/counts、隔離import、archive路徑規則由SP-07 |
| quota耗盡、pins長持阻GC、其他tenant受牽連 | per-tenant預留/實耗/unknown分帳、bounded工作與global/tenant公平併發、超窗人工reconcile；不能取消pins冒資料損失 |

**純synthetic acceptance profile，建議且未定案：** 測試10,000 module rows、1,000 immutable附件（每件沿既有purpose cap）、500MiB匯出上限、100行/頁、每tenant1個backup、global2個capture、2條object streams、30秒stream idle deadline。另加上限+1拒絕及10倍資料分頁/拒絕的邊界測試。既有backup-transfer實際10,000 references及20MiB/object等bound不被此提案無條件改大；新profile需先測native runtime/記憶體/DB连接预算。

Retention沒有已批准的通用天數：各dataset live/retired/orphan/projection/full receipt/backup/hold分別定policy，窗口須滿足SP-05 replay/dedupe及SP-08handover不變量。來源maintenance文件的48h/7d是其特定測試/起始保留，不是所有tenant資料的production預設。測試可用受控clock壓縮期限，不能把短測試deadline部署正式。RPO/RTO、legal用途/retention、獨立recovery authority實體部署、cross-account災難隔離與GC啟用均為decision-log的明確未完成項；不承諾零資料損失。

## 10. 可重現fixtures、T-ID驗收、發布與證據

共通環境：disposable `fp_*` schema/DB、與migrator不同的實際DML runtime role；非owner/非superuser/無BYPASSRLS。PG pool設max1用來強制A/B重用（backup snapshot案例另用≥2）；兩tenant A/B，各有相同人不同role、asset/CRM/订单/notification及一個foreign guild officer；原生Miniflare R2或受控staging private R2，真外部module endpoint與獨立DB。所有資料synthetic，不使用其他tenant production。下列全為`not_run`。

| T-ID | 前置／操作與注入 | 通過條件與 evidence |
| --- | --- | --- |
| T-021 | 从candidate schema、SQL query/寫入位置、object purposes、cache/search/summary/notification/outbox及backup列inventory；逐項對catalog；故意加未登錄CRM note/index欄位 | CI拒未登錄private copy；每dataset有owner/read/write/export/share/retention/restore；保存catalog版本、location差分及negative fixture，不只人工勾選 |
| T-022 | A/B各建立同名customer與asset；用A改path/body/header/resource ref指B；逐API/query/job/search/cache/FK/batch/export及projection訂閱測試；A→B晚回request | 無B行/bytes/存在性洩漏；cross-FK/UPDATE tenant被DB拒；job每batchfresh check；batch混tenant整筆拒；缓存及UI無串租戶。保存按入口矩陣/SQL constraint錯誤與safeHTTP |
| T-023 | 真R2上傳A附件全部variants，直接猜B asset/key/variant；測GET/HEAD/304/Range/export；斷PUT ACK、損坏object、DB finalize故障；完成export→restore | 全入口先ACL；no publicbucket；DB不新增blob；unknown sameintent核對；完整bytes+digest/metadata一致；不fallback legacy；保存R2 readback、DB列及replay效果數 |
| T-024 | 记录current_user/session_user/role flags/table owner/FORCE RLS；max1 pool依A→B→無context循環；插入exception、cancel、statement timeout、rollback失敗；試directSQL跨tenant、TRUNCATE、owner-role切換 | A/B無cross rows或write；missingcontext拒；LOCAL清除；rollback失敗connection丢弃；runtime不可owner/BYPASS/DDL/definer bypass；記pg_backend_pid、context與拒絕結果，admin測試不算 |
| T-025 | A CRM外移完成；生成central retention allowlist/inventory；掃source表、projection、cache、search、summary/embedding、outbox、notification與trace；保留合法order snapshot | 中央無完整CRM/notes可讀或未登錄copy；只留明列fields/purpose/expiry；order snapshot被限制用途；backup殘留單獨列access/到期，不能以主表零行宣稱全刪 |
| T-046 | 建立所有copy類型及兩份共享capture的backup；一份仍hold；cutover後清理，注入各step失敗、DELETE ACK丢失、晚到PUT、expired pin及另一tenant合法ref | 逐step可重啟、current authority不被刪、live/pinned/ref objects不被GC；latePUT不可attach且可重掃；共同capture仍被keep set使用時不釋pin；UI如實列remaining backup/第三方限制 |
| T-047 | backup在epoch3/gen4取得；之後delete customer+asset、撤share/session/grant/key，遷移至epoch4/gen5；還原舊dump+objects；令floor服務不可用/過期/給錯instance；重放舊receipt/outbox/activation permit | 隔離target始終無服務/dispatch直到新floor；tombstones先套、撤權仍拒、舊binding不寫、舊projection不復活；unknown副作用不再執行；完整role/FK/object/cursor驗證後才ready_for_activation |

**普通backup pause fixture：**開始時記token、binding/epoch/gate version；分別在成功、copy失敗、使用者取消、worker crash各出口重啟，驗同token只release一次、原可寫source恢復且backup失敗不變成功。注入release ACK丟失，保持needs_reconciliation直到讀回；pause後另加security fence或遷移改binding/epoch，舊token release必被拒，且migration source不能恢復寫入。既有readonly source不因備份完成變可寫；backup pins與暫時write gate各自核對。

**同cutoff專案fixture（支援T-023/T-047及SP-08 T-042）：** exporter固定snapshot；在pin collector等待期間替換附件並讓GC嘗試舊representation；DB export僅引用snapshot中版本，pins保護該版，copy/readback恢復一致。另故意給不同snapshot token、缺variant、破壞digest、pin到期、copy中撤權、pool只有1 connection；必須有明确fail/blocked且保護仍在，不製造verified半備份。Restore驗row內容/IDs/refs/domain invariants、event_sequence/receipt狀態，不只counts。

**發布門檻：** catalog coverage及三層隔離、真runtime-role/pool/R2、同cutoff restore、independent floor/fencing、全copy cleanup與保留顯示全部有candidate SHA/policy/release/環境證據才啟用對應capability。GC/retention、production restore、真網路bucket ACL、所有媒體用途各自有gate，不能以單一綠色CI名稱取代。現Foundation source ledger仍保持原狀；新證據逐項追加，不以文件存在改為passed。

本次docs-only驗證：檔案/引用核對及`git diff --check`；以上功能測試均未執行。後續實作PR要記實跑命令、通過/失敗/not_run、fault注入點、角色/grant、safeSQL/HTTP/object evidence、剩餘阻擋及回復方式；不得公開原始客戶資料、private URL、credentials或operator私有archive。
