# SP-07｜模組可攜套件

## 1. 文件身分、來源、追蹤與範圍

- **ID／版本：** SP-07 / 0.1.0；2026-10-05
- **狀態：** proposed、待實作、待驗收。本文只制定目標契約，不新增可用 API、schema、匯出權限或正式服務
- **來源：**《公會啟動台與可攜式業務空間》v1.0 第 12–14、20、23–24 章、附錄 A–C；中央原始碼 `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`
- **決策：** D-11、D-13、D-15–18、D-20；**主要需求：** R-027、R-037–040；**協作需求：** R-015、R-023、R-042、R-044、R-046–047、R-059、R-062
- **主要驗收：** T-027、T-037–040；共同驗收 T-015、T-023、T-036、T-042、T-044、T-047、T-056、T-058
- **共同規約：** [contracts.md](contracts.md)、[資料責任](data-responsibility.md)、[repository-map.md](repository-map.md)、[traceability.json](traceability.json)。數值及產品保留政策以 [decision-log.md](decision-log.md) 收斂；以下建議 profile 不是已批准的正式額度

本文定義一個 tenant 的一個 module instance，連同執行所需應用、私有資料、附件、設定、必要歷史與互通接續資料的交付。應用發版信任屬 SP-10，資料分類屬 SP-06，寫入權威移交屬 SP-08。匯出檔本身不能授予三者的權限。

## 2. 使用者流程、前後狀態、非目標與依賴

1. 具目前 `module.data.export` 權限並通過 SP-02 高風險新驗證的 tenant 操作人選擇 instance、`backup|migration|clone` 目的及已支持的 runtime profile，看到資料類別、估計 bytes、應用授權及保存期限
2. API 建立 durable operation；worker 僅使用該 tenant／instance 的 server-issued export 工作權限。取得一致 DB／物件版本切點後流式產生套件，完成後才顯示可下載
3. 每次查 manifest、下載 chunk、续傳均重驗目前讀取／匯出權，使用短效可撤銷的下載授權；撤權立即停止新 chunk 存取
4. 目標先建立 quarantine import，驗證完整 bundle、schema、引用、容量、授權與相容性，再隔離還原；資料可讀驗證通過仍不表示有正式寫入權
5. Migration 由 SP-08 發出已核對的 activation 決策；clone 在新身份下走 SP-04 新實例啟動；獨立 backup restore 必須另有恢復授權及目前 recovery floor

**前後不變量：** 匯出不改 owner、binding、authority epoch；import 不能從檔內宣告取得 tenant ACL；相同完整輸入的續傳只重用已驗 chunk；失敗不讓部分資料進入 live scope。

**非目標：** 任意 DB 引擎互轉、整庫 dump 對一般會員開放、平台帳號／秘密搬家、任意 SQL／install script 在平台匯入時執行、匯出等同移交、以 CSV 取代完整套件、零停機或通用 CDC。

高風險權限預設限 owner 並需新驗證；admin 不自動具有 export/import/transfer 權。窄範圍 export 可依 SP-02 明確委派，不能因一般編輯權取得。

**前置：** SP-02 真實 tenant／ACL backing、SP-04 instance registry、SP-05 版本化領域 port／事件、SP-06 export allowlist、SP-10 可分發應用 release。可先做合成 manifest／惡意匯入 fixtures、streaming parser 及相容性測試；不用等 ERP 全功能、公會客製或模型服務。正式 export route 不得在 tenant backing／ACL 未完成時用 personal/community scope 假裝 tenant。

## 3. 現有程式對照與檔案責任

相對路徑均由 repo root 起算；NEW 是後續 PR 建議位置，不是本次存在的實作。共享檔案由 [repository-map.md](repository-map.md) 指定單一整合者。

| 標記 | 精確檔案／範圍 | 對接與限制 |
| --- | --- | --- |
| KEEP | `packages/db/command-core.ts`、`packages/db/member-command.ts`、`packages/db/transaction.ts` | 復用交易、目前驗權先於 receipt、舊 digest；網路／object I/O 不進 callback |
| MODIFY | `packages/resource-scopes/index.ts`、`packages/scoped-commands/index.ts`、`contracts/common/v1/identity.ts` | 經 SP-02 擴充真實 tenant domain 綁定；現在僅 person、personal/community，service/site wire 保留不是實作 |
| KEEP | `packages/asset-storage/index.ts`、`packages/asset-storage/r2.ts`、`packages/asset-storage/profiles.ts` | 復用 ObjectStore 與 byte/digest 核對；目前小型 profile 的 bounded accumulation 不是大型整包 streaming |
| KEEP／MODIFY | `packages/media-migration/backup-coordinator.ts`、`backup-transfer.ts`、`backup-retention.ts`、`backup-evidence.ts`、`restore-acl-lockdown.ts` | 沿用 snapshot/pin/renew/verify 原理及已核准 host；現行整 schema／七種媒體流程不得直接暴露為模組匯出 |
| KEEP | `docs/platform-plan/contracts/portable-activation.schema.json`、`portable-activation.example.json`、`docs/platform-plan/contracts/README.md` | 既有 control-Skill／Plan／Contract supply-chain 規劃；沿用來源 pin、safe extraction 及 release 信任邊界，不能將其 activation lock 當 tenant 業務資料 bundle |
| NEW | `contracts/portability/v1/module-bundle.ts`、`contracts/portability/generate.ts` | 作者來源、strict validator、canonical digest 與 fixture schema；新契約需納入既有 release/generation 管線 |
| GENERATED | `contracts/portability/v1/module-bundle.schema.json` | 僅由前列作者來源產出，禁止另一份手寫真相 |
| NEW | `modules/module-portability/service.ts`、`export.ts`、`import.ts`、`manifest.ts`、`repository.ts` | 封閉 tenant export/import 工作、quarantine、狀態／receipt；只以 SP-06 登記 dataset adapter 存取 |
| NEW | `apps/platform-api/src/routes/module-portability.ts` | 本文目標 API 的 route safety、身份及大小限制 |
| NEW | `apps/portal-web/src/modules/module-portability.tsx` | 匯出／匯入流程；副檔名依當時 shell 組織落地 |
| NEW | `migrations/<next>_module_portability.sql` | operation/export/import/chunk/quarantine metadata；合併時決定編號，不改既有 SQL |
| NEW | `tests/runtime/module-portability.test.ts`、`tests/runtime/module-portability-streaming.test.ts`、`tests/e2e/module-portability.spec.ts` | 真實 DB 角色、物件 store、streaming、中斷與 UI 驗收 |
| KEEP | `tests/runtime/media-backup-transfer.test.ts`、`media-backup-evidence.test.ts`、`media-backup-retention.test.ts` | 回歸舊媒體 pin／restore 契約，不以它們代替新模組往返測試 |

## 4. 資料模型、識別、完整性與責任

### 4.1 共用型別與 envelope

新 DTO 一律 snake_case。`OpaqueId` 沿現有 common validator 的 canonical UUID；`Version`／`Epoch` 沿共同 `^[1-9][0-9]{0,18}$` 且不大於 signed bigint 上限的正十進位字串（不經 JS Number）；`Count`／`ByteCount` 為非負十進位字串，零允許、拒絕前置零及負值；`Digest` 沿共同 `{algorithm:"sha256",value:<64 lowercase hex>}`，不得另用字串前綴表示。時間是 UTC RFC3339；原始碼 pin 必須完整 commit，release 以含 digest 的不可變 ref 表示；`ContractRef` 固定 `{family,version,source_commit,artifact_sha256,behavior_profile}`，`PolicyRef` 固定 `{policy_key,version}`，都是 server registry 已存在且目前允許的版本，不能由 caller 自填政策內容。

共同 Instance 必須保留 `instance_id, tenant_id, module_key, application_release_ref, data_schema_version, contract_ref, status, binding_id, authority_epoch, version`；不得另造 `module_instance_id` alias。資料 row 的 `version` 與 schema/release version 是不同欄位。

**ModuleBundleManifest required：**

| 欄位 | 型別／必要語意 |
| --- | --- |
| `schema` | 固定 `freedom.module-bundle/v1`；與 control-Skill activation schema 分開 |
| `bundle_id, export_id, source_tenant_id, source_instance_id` | OpaqueId；來自受驗證 export 工作，不以 manifest 值建立權限 |
| `purpose` | `backup|migration|clone`；migration 另必須有 `migration_id`；其他情況該欄禁止 |
| `created_at, expires_at, export_policy_ref` | 產生時間、下載／保存期限、當次 server 採用的資料 allowlist 與政策版本 |
| `module_key, application_release_ref, data_schema_version, contract_ref, runtime_profile` | 精確版本／相容 profile，不接受 `latest` |
| `source_binding_id, authority_epoch` | 原位置及 epoch 的歷史紀錄，永不當 import 授權 |
| `cutoff` | 下述 Cutoff；所有 dataset、附件及操作歷史屬同一切點 |
| `application` | ApplicationPackage，包含實際可分發 code／runtime artifact 與重建資料，不能只有 repo URL |
| `datasets` | 非空 DatasetEntry 陣列；依 SP-06 清冊，每個必須 dataset 恰一份，零筆也要明列 |
| `objects_manifest, configuration_manifest, continuation_manifest, interop_manifest` | 各為 FileRef，缺一即不完整；空資料亦以 count=0 的受驗 manifest 表示 |
| `files` | 全部 payload 的 FileEntry；path 唯一、case-fold 唯一；不列 `manifest.json` 自身 |
| `totals` | `{record_count, object_count, file_count, uncompressed_bytes, stored_bytes}`；與各項加總完全一致 |
| `secret_material_included` | 必须為 false；並非替代實際秘密排除／檢查 |
| `retention_policy_ref, provenance` | 原副本／備份政策 ref；來源 release、工具 release、schema pins 及授權審查證據 ref；不含客戶完整值 |

`manifest.json` 為 strict JSON，reject duplicate keys、未知 top-level fields 及非 JSON 值。`manifest_digest` 放在受授權 export record／外層傳輸 metadata，值為 manifest 的 RFC8785 JCS bytes SHA-256，避免自我參照。檔案 SHA-256 則計算**實際未壓縮 bytes**；傳輸另記 stored bytes digest。驗 hash 只證明 bytes 相符，不證明來源有權、業務正確或程式安全。

### 4.2 必需內容與布局

- `application/`：來源 archive 或可重建 source tree、每個上游的 immutable source／release digest、dependency lock files、runtime/deployment profile、build/run/healthcheck 文件、版本化設定 schema、受信任 runner 可識別的 migration artifacts、LICENSE／NOTICE／第三方 notices。容器若需 build，包含 build recipe 及不可變基底 pins；若宣告離線啟動，還必須包含可分發的所需 runtime artifacts。未具分發權的依賴不得假稱完整可攜
- `data/<dataset_key>/<chunk_id>.ndjson`：UTF-8、一行一個 strict record；依 stable resource ID 排序，無重複 JSON key；領域 adapter 定義列 schema、允許欄位、關係及 custom namespace
- `objects/manifest.json` 加 `objects/chunks/`：邏輯 asset／representation ID、owner tenant／instance、原始版本、content type、bytes、digest、版本 pin、各 chunk FileRef；signed URL 不是身份或唯一 payload
- `configuration/manifest.json`：主題、workflow、custom fields、locale 等完整 schema／namespace／version 與 FileRef。未知 namespace 可原樣保存但不得啟用；`required_for_runtime=true` 卻無支持 validator 則拒絕啟動
- `operations/manifest.json`：accepted commands、outbox、consumer inbox 去重狀態、terminal receipts、pending delivery 及 cutoff 清單的 FileRef；無憑證、session、grant bearer、秘密或任意可執行重試 closure
- `interop/manifest.json`：stable resource references、相依 capability、contract ref、原 binding 的非秘密位置資訊、允許分享欄位的政策 ref、重新配對步驟。只列當前 tenant 有權帶走的映射，未匯出的依賴標為 `external_reference`
- `licenses/`：依 artifact／素材記錄原作、授權文本、NOTICE、分發限制與 `license_review_ref`。平台、ERP 原作、商標及會員素材逐項判定，MIT 不能覆蓋整包

**DatasetEntry：** `dataset_key, schema_ref, owner_class, record_count, uncompressed_bytes, digest, chunks, relation_profile_ref` 全部 required。`owner_class` 只能 SP-06 可匯出的 `tenant_private` 或明確核准的 `shared_fact_snapshot`，平台 users／全站會員不在清單。每個 chunk 含 `chunk_id, file_ref, record_count, first_resource_id, last_resource_id, uncompressed_bytes, digest`；空 dataset 用空 chunks 及空串流 digest。dataset digest 為 ordered raw chunk bytes 串接的 SHA-256；完整 chunk list 納入 manifest digest。不能只驗 count。

**FileEntry／FileRef：** `file_id, path, media_type, uncompressed_bytes, digest, stored_bytes, stored_digest, encoding`；`file_id` 是 export 綁定的 OpaqueId，供下載 route 選檔；FileRef 指向已列出的 file_id/path/digest，不接受任意 URL。`encoding` 建議初版 `identity|gzip`，一檔最多一層壓縮。gzip decoder 必須拒絕尾隨未描述 bytes／多 member 混淆；檔案布局而非整包一次解壓是 canonical，ZIP 只能是另經驗收的傳輸封裝，不能暗示已支持 ZIP import。

### 4.3 Cutoff 與操作接續

Cutoff 包含 `capture_id, captured_at, source_authority_epoch, db_snapshot_evidence_ref, object_pin_set_ref, aggregate_cutoffs_ref, accepted_operations_ref, outbox_ref, inbox_ref`。Migration 再包含 `source_fence_receipt_ref`，由 SP-08 控制面核對其可信來源。snapshot evidence 是實際 capture 的不可變証據 ref，不輸出 DB URL、底層憑證或可利用的 host 路徑。

`aggregate_cutoffs` 每項固定 `(tenant_id, source_instance_id, aggregate_type, aggregate_id, final_aggregate_version, final_event_sequence)`；sequence 為正十進位字串，從未發出事件者用明確 nullable 值，不能把 `0` 當 Version。精確 `event_id,payload_digest,authority_epoch,aggregate_version,event_sequence` 清單與 accepted `operation_id,request_digest,state` 一起 pin。遲到事件按 SP-05/08 的已提交 cutoff 及狹義 replay grant 核對，不能依抵達時間猜測。

歷史 receipts 是**資料**：`origin_principal_ref, origin_authn_kind, operation_id, request_digest, outcome_ref, committed_at, source_binding_id, authority_epoch` 可保留必要最小欄位，敏感 response 依匯出政策裁剪。匯入它們不得直接 insert 到可信 live receipt namespace，不得重建 session／Grant 或讓 caller 藉 receipt 取得資料。可信 migration coordinator 與目前 source operation ledger 對帳後建立有來源的去重／接續映射；沒有這條可信來源時，只准歷史查閱，pending side effects 留 `needs_reconciliation`。所有新操作重新驗目前身份與領域權限。

### 4.4 持久化、唯一性與 clone

Export、Import、ChunkCheckpoint 均以 `(tenant_id, instance_id, operation_id)` 完整 FK 到 SP-04；`(import_id, manifest_digest, chunk_id)` 唯一。quarantine rows 用獨立 import namespace，不能被 live query 或搜尋索引找到；promote 以同交易切換已驗 import revision／活躍資料 pointer，不能逐頁公開。大資料可分批写 staging，但不得分批成為 live。

Migration 保留 tenant、instance、所有 owned resource／asset／operation／event IDs。實際 object locator／DB 自增序列及 hostname 可換，引用不得靠 URL。Clone 先經 SP-04 在新的 tenant 或經明確批准的目的 tenant 建立隔離的新 instance，再產生新 owned resource／asset IDs，持久化 `clone_id + source_ref -> target_ref` 映射並原子驗證閉合圖；另立 origin provenance。共有 canonical definitions、外部相依 refs 僅在仍具權且明確確認時保留；新事件／操作產生新 IDs，舊事件只作歷史，不重發業務副作用。clone 不複製 binding、authority、credentials 或 grants，不能用原 instance ID 開第二個 writer。

## 5. 目標 API、command、query、event 與錯誤

**以下路徑、欄位與 capability 均為 proposed，沒有宣稱已部署。** 業務目標 Base 為 `/api/v1/tenants/{tenant_id}/instances/{instance_id}`；export/import 是平台 lifecycle operation，查詢使用 tenant-level `/api/v1/tenants/{tenant_id}/operations/{operation_id}`，其 target 仍驗精確 instance。Browser route 沿 session、Origin／CSRF；server 從受驗證身份解析 tenant context，body 的 ID 只是 target，不能自行帶 `Actor` 或 VerifiedContext。

異步回應為共同 `operation{operation_id,state,version,resource_ref?,retry_after_seconds?,problem?}`；state 僅 `requested|running|succeeded|failed|needs_reconciliation|cancelled`。`202` 表示已持久受理，不代表匯出完成。`GET /api/v1/tenants/{tenant_id}/operations/{operation_id}` 只向目前具 `module.operation.read` 且有該資料讀權者返回此 DTO；receipt replay 亦重驗目前權限。

| 方法與相對路徑 | 完整 body／query | 權限、結果與條件 |
| --- | --- | --- |
| `POST /exports` | `{purpose,runtime_profile,retention_policy_ref,migration_id?}` strict；不得傳 SQL、table 名、任意欄位清單或下載目標 URL | `module.data.export`；`If-Match` 對 instance version；202 operation，resource_ref 指 export |
| `GET /exports/{export_id}` | 無 body/query | export 權及目前可讀；`{export_id,instance_id,state,version,manifest_digest?,totals?,expires_at,completed_chunks,total_chunks,problem?}`；不回 bytes/secret |
| `GET /exports/{export_id}/manifest` | 無 body/query | ready、未過期且未撤銷，200 strict manifest、ETag 為 digest、no-store |
| `POST /exports/{export_id}/download-sessions` | `{manifest_digest}` | `module.data.export`；If-Match export version；202 operation 的 resource_ref 指一次下載 session metadata，不能在 receipt 存 bearer |
| `GET /exports/{export_id}/files/{file_id}` | 只接受 server file_id 對應 manifest；可有 RFC 相容單一 Range／If-Range | 當前 session＋export ACL；200/206 stream、ETag、Content-Range；不支持範圍回 416；每次新 request 重驗，無任意 path proxy |
| `POST /exports/{export_id}/revoke` | `{reason_code}` | export 管理；If-Match export version；202 operation；阻止新下載、排程清理，既已取走 bytes 無法收回 |
| `POST /imports` | `{purpose,manifest_digest,manifest,source_export_ref?,migration_id?,clone_target?}` | `module.data.import`，clone 額外 SP-04 create；If-Match instance；202 operation/ref import，先只建立 quarantine，不信 manifest owner |
| `PUT /imports/{import_id}/chunks/{chunk_id}` | binary body；Content-Type／Content-Length 與 manifest 一致；完整 digest header | 專用 import upload capability；If-Match import version＋Idempotency-Key；200 `{chunk_id,digest,stored_bytes,verified:true}`，不同 bytes 同 ID 為 conflict |
| `GET /imports/{import_id}` | 無 body/query | import 權＋可讀；`{import_id,state,version,manifest_digest,verified_chunks,missing_chunk_ids,validation_report_ref?,problem?}`；missing IDs 分頁，cursor 綁定 import/manifest |
| `POST /imports/{import_id}/validate` | `{manifest_digest}` | If-Match import；202 operation；驗全包、域規則及目標相容，不執行 package code |
| `POST /imports/{import_id}/restore` | `{validation_report_ref,manifest_digest}` | If-Match import；202 operation；只寫隔離目標；migration 尚不能啟動 |
| `POST /imports/{import_id}/cancel` | `{reason_code}` | If-Match import；202 operation；已 activation 的 import 不可用此路徑回滾，回 `recovery_requires_migration` |

初版上傳以完整有界 chunk 為續傳單位；掉線後重傳同 chunk，不以 client 聲稱 byte offset 延長已驗內容。export Range 可以恢復下載；客戶端在使用 chunk 前仍重驗完整 digest。chunk endpoint 只允許 manifest 已登錄 ID，永不讓 path/body 選擇檔案系統位置。操作建立／控制用既有 `Idempotency-Key` `[A-Za-z0-9_-]{8,128}`；`If-Match: "<Version>"` 必要，無值 428、過舊 412。相同 key 不同 target/body/version/manifest 為 409；不因 upload retry 建第二份 import。

非秘密控制面 facts：`module.export.ready`、`module.export.revoked`、`module.import.validated`、`module.import.restore_verified`、`module.import.failed`，依 contracts.md §8 走既有 scoped/platform journal 的 versioned payload，只含操作/resource refs、manifest digest、counts、固定 code；不得假扮 SP-05 的 module-native EventEnvelope 或捏造 source_instance_id。新增歷史資料的 import 不得把所有歷史領域事件再次當新事件發出。

| HTTP／code | 判定與恢復 |
| --- | --- |
| 400 `invalid_manifest`／`invalid_version`／`idempotency_required` | strict parse 或 header 不合；修正輸入，沒有寫 live 資料 |
| 401 `authentication_required`；403 `export_scope_required`／`import_scope_required` | 未驗身份／目前無相應 capability；不回私有 manifest、receipt |
| 404 `resource_not_found` | 不屬 tenant／instance 或不可見；不洩漏另一 tenant 是否存在 |
| 409 `idempotency_conflict`／`chunk_conflict`／`instance_busy` | 同 key/ID 不同內容或遷移互斥；原有已驗資料保留 |
| 409 `restore_requires_authority`／`recovery_requires_migration` | 權威切換不由 import shortcut 執行 |
| 410 `export_expired`／`download_revoked` | 保持私有，不自動重新產生 export；使用者可建立新工作 |
| 413 `capacity_exceeded`／`decompression_limit` | 任一實際 bytes／ratio／record／object 預算超標；中斷讀取並清理 staging |
| 422 `schema_incompatible`／`missing_reference`／`ownership_mismatch`／`unsupported_extension`／`license_unresolved`／`digest_mismatch` | 回固定 code、受限 entry index 與可處理指引；不回真實資料片段 |
| 429 `rate_limited` | bounded Retry-After；不消耗第二份容量 reservation |
| 503 `source_unavailable`／`pin_unavailable`／`recovery_authority_unavailable` | 無法確定 pin／cutoff／目前 floor，停止新效果；同 operation 重查，不假成功 |

## 6. 狀態機與失敗／重啟語意

Export domain state：`requested -> capturing -> streaming -> verifying -> ready -> expired|revoked -> purged`；`capturing/streaming/verifying` 可進 `failed|needs_reconciliation|cancelled`。operation state 對應 requested、running、succeeded 等共同狀態，不把 domain state 填入 operation.state。

- `capturing` 必須取得已核對 cutpoint＋immutable object pins；pin 失效或 dataset adapter 不支持一致 capture 就停，不能拼接不同時間的頁面
- `streaming` 每 chunk 在原子 metadata commit 前先完成 bytes＋digest；不把半檔標 verified。續跑確認 manifest draft/capture/pin 全相同才重用 chunk
- `ready` 只在全檔、counts、IDs、關係、業務不變量、bytes/digest、continuation 清單全過時進入。response 遺失查同 operation，不重做 snapshot 冒充原結果
- 撤權與 expiry 先阻止新下載；worker 在每 chunk／publish 前重驗工作授權與 DB clock。已不可撤回的下載須如實記錄，不說對方副本被刪除
- snapshot exporter crash 且無法重開同切點：原 capture 失敗，pins 待核對後釋放；新 capture 必須新 revision／manifest，不能沿用旧分頁 cursor 混包

Import domain state：`created -> uploading -> verifying -> validated -> restoring -> restored_verified -> awaiting_activation -> activated`；前六個非 live 階段可取消／失敗；`needs_reconciliation` 可從任何有未知儲存或 promotion 效果的階段進入。

- `validated` 只表示格式、授權、完整性通過；`restored_verified` 加上實際隔離 DB、object refs、重新啟動與領域讀取測試；兩者都不讓 public route／job dispatch 看見資料
- promote／activation response 遺失先讀可信 import revision＋registry＋SP-08 operation；不能重建另一套目的資料或反向刪除已活躍目標
- schema／release 變更導致驗證證據過期時回到 verifying；必須取得新驗證報告，不能重用舊 ready 標記
- 一般 operator 可查 progress；重試 unknown provider effects、啟動、取消遷移、刪除殘留依各自 capability，不能用 support 身份直接拿 DB 管理權
- worker lease 只有工作排程效力；lease 到期後接手者讀持久 checkpoints，CAS `version`，不代表 ownership／authority 被重設

## 7. UI、可見性、錯誤與人工接手

入口顯示 tenant／module／source release 及現在 writer；會長非 tenant 操作人不顯示匯出 CTA，後端仍獨立拒絕。無 export scope 顯示權限說明；無資料顯示合法空 datasets，不把空業務當匯出錯誤。

匯出頁分辨等待 snapshot、正在產生、驗證、可下载、過期、已撤銷。顯示已驗 chunk／bytes，不拿估計值作成功百分比。下載前說明包含哪些私有資料、授權及保留時間；不顯示 token。重新整理／返回依 operation_id 恢復；tenant 切換取消舊 request，晚回應不得渲染在另一 tenant。

匯入先展示來源聲明與**尚未驗證**，通過後才展示 server 驗證報告。缺附件、custom schema 未支持、source license 未解決要逐項可理解；unknown 字段不能靜默變成「完成」。Migration 頁連回 SP-08；「還原已驗證」與「正式啟動」使用不同文字。

手機保留狀態、取消及問題詳情，不以拖拉檔案作唯一上傳方式；鍵盤可選檔、讀 progress、展開錯誤。進度 aria-live 不逐 chunk 轟炸；錯誤 focus 移至摘要，retry 不清掉可用 checkpoints。人工接手取得 operation/ref、固定錯誤、safe counts 與缺失類別；私有檔案僅透過另授權下載，日誌不得附樣本 CRM／signed URL。

## 8. 匯出、匯入、升級、清理、恢復與 legacy

1. **一致性實作：** 初版 migration 沿 SP-08 停該模組寫入；backup 也必須用可信一致 capture，不以隨時間翻頁替代 snapshot。PostgreSQL snapshot 与 references 使用相同 snapshot；R2 immutable version/pin 先保護後傳輸，I/O 不持 SQL row lock。不能直接把共用 DB 的 `pg_dump` 交給會員
2. **受支持環境：** 建議第一版採現行受維護 PostgreSQL＋ObjectStore profile；實際 runtime/runtime versions 由 application release 宣告且在乾淨環境驗收。新引擎需另有 adapter 與相同 fixtures；「相容 S3」不是自動已驗 R2 語意
3. **schema upgrade：** 只執行平台隨可信 release 發布的版本轉換 adapter。bundle 內附的 migration artifact 是重建／自架資料，不是可在中央直接執行的權限；adapter 無明確 source→target 版本或會丟 namespace，拒絕。保留原 manifest、轉換工具 pin、前後 digest 及可逆性報告
4. **未知資料：** 結構上准許的版本化 extension 原樣保留；不支持的 required extension 阻擋啟動，optional extension 可 dormant，UI 說明。拒絕無 schema 的任意 payload 混入正常欄位
5. **legacy：** 舊商務 owner→tenant 映射由 SP-12 expand/backfill/switch/contract 完成。歸屬不明記錄阻擋受影響 instance 匯出，不分配全域 tenant、不默認目前會員；不阻擋其他已清楚資源。舊 resource ID 及原 receipt 保留，新 exporter 讀顯式 mapping
6. **cleanup：** aborted imports 清 staging、search/cache/thumbnail；published bundle 到期刪 payload，保留最小 operation/digest/count/audit 與刪除證據。依政策保留 pins 到傳輸／未知效果核對結束，不在 error handler 直接 GC 所有物件
7. **restore floor：** 舊備份只進 fenced 隔離環境；在恢復對外服務前重載可信、獨立於該 DB/R2 snapshot 的 recovery generation、authority floor、revocation、tombstone 及 retention。Bundle 中的舊許可／epoch 不能提高、降低或替換目前 floor
8. **刪除語意：** 匯出／外移不授權刪來源。SP-06/08 分別追蹤主資料、衍生資料、備份副本期限；不得聲稱「所有副本已刪」而仍有合法保留備份

## 9. 威脅、最小權限、秘密與容量

- **橫向讀取：** 只用 `(tenant_id,instance_id)` 的受限 dataset adapter、合成 cross-tenant FK 負例；download manifest/chunk/cache/query 都重新驗 ACL。路徑 prefix／opaque ID 不是授權
- **不可信套件：** 路徑只接受相對正規 ASCII、不得 `..`／absolute／反斜線／NUL／device name／大小寫碰撞；拒 symlink、hardlink、device、FIFO、reparse point、archive ACL/xattr。以 private staging root＋beneath-root open 驗證，拒 duplicate entries／覆蓋 verified chunk
- **非執行型匯入：** 不執行 SQL、shell、JavaScript、template code、dependency install 或 URL fetch。應用 build 僅由受信 release 在隔離 runner／使用者自架環境執行；manifest 不提供平台執行批准
- **SSRF：** 預設不从任意 manifest URL 抓附件／依賴，使用已上傳 bytes 或 SP-09 批准 origin/route 的受限 source。任何受准 fetch 仍在每次連線驗 DNS/IP/TLS/redirect
- **秘密：** 採 allowlist 排除 sessions/cookies/platform keys/DB DSN/model credentials/CLI OAuth、bearer grant、presigned URL；也檢查 configuration/history/trace。掃描器僅防漏，不能以「掃不到」取代 schema 排除。明文敏感資料不進 debug、公共 CI、PR 或查詢字串
- **存取：** 存放 encrypted-at-rest、TLS 傳輸、no-store，下載 session 綁 user/current scope/export/expiry/revocation；只持 URL 不足。外部目的不可自動收到匯出，另需具體授權目的地

**建議測試／工程 profile（須 decision log 定案，未設定即拒绝 admission）：** manifest ≤2 MiB、單 JSON record ≤1 MiB、單 NDJSON chunk ≤16 MiB 未壓縮、單 job ≤100 GiB 未壓縮／10 million records／100,000 objects、壓縮比 ≤100:1、解壓深度 1、每 instance 同時 1 個 export 或 import、每 tenant 2 個傳輸 worker、worker memory ceiling 128 MiB。物件大於 chunk 則 manifest 明列分塊 offsets／lengths、整物件及各 chunk digest；復用 ObjectStore 所允許 profile，不靜默放寬現有媒體限制。不能因 header 宣稱較小而越限。

容量 reservation 在 admission 原子取得，失敗／取消僅在清理已證實後釋放；chunk 超標即停止 stream、取消 reader、回收暫存。建議 export payload 保存 24 小時、下載 session 5 分鐘、失敗 staging 24 小時待清理；具體保存／重試窗口與 SP-05/08/09 必須一致。大型匯出採 off-request worker，HTTP 僅建立／查工作；要求超出 runtime profile 則明示拒絕而非 OOM 影響其他 tenant。

## 10. Fixtures、T-ID、發布條件與未完成證據

全部以下是**待實作／not_run**；本文件的靜態盤點不是 runtime 通過證據。

**共同 fixture：** tenant A owner／export-only／operator-no-export，tenant B owner，非 owner 會長；A inventory 有 3 SKUs、2 reservations、1 release、2 獨立內容附件及 1 空 dataset；加 namespace `example.custom/v1`、工作流配置、terminal receipt、1 尚未送達 outbox、consumer inbox duplicate、獨立 retained 交易快照。使用 canonical UUID、故意 >`2^53` 的 Version/Count、合成 bytes。中央與目標分開程序、分開 PostgreSQL DB／DML-only role、分開物件儲存，不能共用 admin connection 假裝外移。

| T-ID | 可重現操作／故障注入 | 必要斷言與 evidence |
| --- | --- | --- |
| T-027 | migration export/import；再 clone 同 bundle 至新獨立業務 | migration IDs/引用逐一相等；clone owned refs 全新且 mapping 閉合，原 binding/credential 無效；保存 ID 差異報告 |
| T-037 | 在無平台 DB／內部 registry 存取的乾淨受支持環境用包啟動 | source/lock/license/設定/bytes 全可用；以本地認證讀寫原業務，依賴互通明列尚未配對；record health/read/write 證據 |
| T-038 | round-trip custom schema、workflow、歷史、附件；加入 unknown optional/required namespace | 無丟欄位；required 未支持拒啟動，optional dormant 明示；逐 dataset/attachment digest 和引用比對 |
| T-039／T-015 | A operator／B／會長猜 export ID；owner 下載中撤權；包中注入敏感 denylist fixture | manifest／chunk／replay 均拒絕越權；未產出全站 users、token、CLI session；日誌及 receipt 無 secret |
| T-040 | 每次改一項：digest、count、跨 tenant ref、duplicate ID/key、缺 chunk、路徑穿越、symlink、gzip bomb、超容量、任意 SQL | live DB/objects/index hash 保持原值；固定錯誤且 quarantine 可清；禁止網路／腳本 execution evidence |
| T-042／T-023 | snapshot capture 後並行寫 row／覆 object、GC、pin 到期 | bundle 要么精確原切點、要么失敗；沒有缺附件；pin renewal/GC 證據；實际 bytes digest 相符 |
| T-044 | 每個 chunk 完成前／後 crash、lost ACK、重啟；偽造歷史 success receipt 後呼叫 live command | 續傳只重用已核對 bytes；不重做副作用；未經可信 reconciliation 的 history 無 live authority |
| T-047 | 還原包含舊 credential、較舊 epoch／tombstone 的合法舊包 | 隔離可讀歷史；目前 floor 先驗，不能 dispatch/恢復已刪資料或舊 writer |
| T-036／T-056 | 來源 schema/release 不相容或某素材缺許可 | 只阻擋該 runtime/import activation；原 tenant 合法讀取及可用 export 繼續；授權差異清單 |
| T-058 | 16 MiB chunks 合成大串流至 profile 上限並超限，慢來源／取消／另一 tenant 併發 | 記錄 peak RSS、總 bytes、timeout、FD/SQL 釋放、其他 tenant 延遲；memory 不隨整包大小線性成長 |

發布 gate：SP-02/04/05/06/10 依賴有精確 source/release pins；契約 generated bytes 對帳；低權角色的 schema/FK、隔離、resume、實際 DB+object 往返、受信 supply-chain 與復原 floor 全部通過；公開 API 的 export/download/import ACL 已測；正式容量／retention policy 已定案。連結既有 UF CORE／MEDIA／EXEC-OPS ledger，尚未映射的細項標 `unmapped`，不聲稱 ledger 完成。

後續 implementation PR 應附 commands、環境與 source SHA、fixture seed、實際輸出、未跑原因。推薦將新案例納入現有 `npm test`、`npm run test:contracts`、`npm run test:repos` 及 UI 的 build/E2E；本次不執行 production export、migration、storage cleanup、安裝或部署。
