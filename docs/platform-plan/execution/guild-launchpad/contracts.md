# 共同契約字典與單一 authoring 責任

版本 0.1；target specification，非已安裝 API。來源基線 `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`。本文件只為 SP 契約定共同語彙，不是第二份 runtime schema。

## 1. Authoring 與相容邊界

目前實際 authoring 在 `contracts/common/v1/identity.ts`、`contracts/preview/v1/definition.mjs` 及 domain 的既有 Zod schema。執行時的 `ResourceScopeRef` 只可解析 personal/community；service/site wire shape 只是預留。`tenant`、外部 module service、tenant Work、inventory port 均為**新增/擴充提案**，不得把 schema parsing 當可用權限。

後续實作先在既有契約責任下新增一個有明確版本的 tenant/module authoring entry（實際路徑由該 domain PR 選定並登記 descriptor），由它生成 JSON Schema、OpenAPI、SDK types/validators/vectors。不得手改 generated files，不另發一套 demo DTO。`docs/platform-plan/contracts/` 的 scaffold 不得直接成為 production pin；本文件亦不得當任意 consumer 的執行信任根。

舊 preview v1、member command receipt/digest、`fw_read_` GET-only、shop key、personal Work/Asset 不原地擴權。新 profile 以版本協商加入；舊 read adapter 可保留，缺少新 tenant/epoch 必要語意的舊 write 明確回 upgrade-required。Guild/tenant/module target shape 在規格先對齊，schema freeze/materialization 才由共同 owner 更新 canonical bytes。

## 2. 型別及封裝

| 名稱 | 精確格式/規則 |
| --- | --- |
| OpaqueId | 重用 `contracts/common/v1/identity.ts` 小寫 UUID，不能以 email、slug、hostname、guild key 或 DB 序號推導 |
| StableKey | 小寫 `[a-z][a-z0-9_.-]{0,159}`；既有 guild keys 原樣保留，不轉 UUID |
| CapabilityKey | `[a-z][a-z0-9_.:-]{0,159}`；支援既有colon與具名dotted key，必須在capability catalog註冊，無wildcard，不能以字串可parse當授權 |
| Version / Epoch / Sequence | 十進位字串 `^[1-9][0-9]{0,18}$`，且 ≤ 9223372036854775807；避免 JS number 遺失 bigint |
| Digest | `{algorithm:"sha256", value:<64 lowercase hex>}`，針對明列 bytes/profile；checksum 不證明來源/法律權利 |
| Timestamp | UTC RFC3339；排序用版本/sequence，不依跨主機時間；deadline 用受信任服務 clock |
| ResourceRef | `{tenant_id, instance_id, resource_type:StableKey, resource_id:OpaqueId}`；不得由不同 tenant 的同字串 ref 借權 |
| ContractRef | `{family:StableKey, version:string, source_commit:<40 hex>, artifact_sha256:<64 hex>, behavior_profile:StableKey}`；相容需 fixtures，不能只看 semver |
| PolicyRef | `{policy_key:StableKey,version:Version}`；解析server登記的immutable policy，不接受caller提供policy內容 |
| Page | `{items:[T], next_cursor:string|null, source_version:Version}`；cursor 綁 tenant/filter/contract，不能攜私有 payload |
| Operation | `{operation_id:OpaqueId,state,version:Version,resource_ref?:ResourceRef,retry_after_seconds?:integer,problem?:Problem}`；state=`requested|running|succeeded|failed|needs_reconciliation|cancelled`；操作成功不是資源永遠同版本 |
| Problem | 沿用實際 HTTP `{type,title,status,code,detail}`，新增 profile 如需 retry/operation metadata 要顯式版本化；不能回 SQL、secret、未授權資源是否存在；既有格式不變 |

所有新增 JSON DTO strict、拒絕未知 top-level 欄位、危險 key/原型及無界巢狀。擴充僅進有命名空間與 schema version 的 `extensions`，未知 extension 必須保存/明確拒絕，不靜默丟棄。UTF-8 byte size、列數、深度及 cursor 上限由具名 capacity profile 宣告，非用 JavaScript 字元數冒充 bytes。

## 3. Target aggregate dictionary

| Aggregate | 最少欄位；權威及 constraints |
| --- | --- |
| GuildCategory | category key 與 taxonomy_version；三類值和逐 guild 分類由 SP-01 定，catalog 為內容權威，不由標籤授權 |
| GuildPrimaryPreference | member/community/category/guild_key/version；同 member+community+category 最多一筆，指向本人有效 membership；分類重檢同交易 |
| Tenant | tenant_id, display_name, state, version, created_at；owner 經 TenantMembership 表達，不等於建立者永久擁有 |
| TenantMembership | tenant_id, principal_id, role, state, version, accepted_at；組合 FK 到真人 principal 與 tenant；不能靠 guild office 建立 |
| Workspace | workspace_id, tenant_id, name, state, version；容器而非第二份 identity/ACL；所有內含 ref 必須同 tenant |
| ApplicationDefinition | application_key, release_ref, module_requirements[], runtime_profiles[], launch_policy_ref, license_state；不是 instance |
| ModuleDefinition | module_key, capabilities[], data_catalog_ref, contract_ref, portable_profile_ref；一類可獨立擁有事實的 domain |
| ModuleInstance | instance_id, tenant_id, module_key, application_release_ref, data_schema_version, contract_ref, status, binding_id, authority_epoch, version；身份不可重綁，location 變而 ID 不變 |
| DeploymentBinding | binding_id, tenant_id, instance_id, mode:`hosted|external`, endpoint_ref?, environment, service_principal_ref?, contract_ref, state, version；一 active binding/instance/epoch；endpoint_ref 是受控 registry 參照，非任意 URL |
| ModuleDependency | caller_instance_id, capability, provider_instance_id, sharing_policy_ref, version；明確 tenant/跨方參與者，不能省略 authorization；禁止未批准循環 |
| IntegrationProjection | projection_id, consumer_instance_id, source_ref, source_epoch, source_version, purpose, field_allowlist, policy_ref, expires_at, status；不是可獨立編修主檔 |
| ModuleOperation | operation_id, tenant_id, instance_id, authority_epoch, operation_kind, request_digest, state, version, receipt_ref, accepted_at；永續 effect identity 和 transport attempt 分開 |
| Migration | migration_id, tenant_id, instance_id, source_binding_id, target_binding_id, source_epoch, target_epoch, state, cutover_manifest_ref, operation_id, version；完整 states 由 SP-08 唯一承接 |

SP-01/02/04/05/07/08 定義各 aggregate 的子欄位及狀態；遇到命名差異，先作同 PR 契約修訂，不以兩個同義欄位各自實作。新的 SQL 檔名在實作時讀最新 main/相依 PR 分配，不在文件預占 migration 數字。

## 4. 身份不是 command 的自填內容

傳輸層以既有 cookie+CSRF 或用途分離的受驗證 service adapter 建立 server-owned VerifiedContext。其 principal、current membership、role、scope、grant、environment、expiry、recovery generation 不能由 caller JSON 自填。URI 的 tenant/instance 只選 target，須驗 membership/domain capability/binding。目前沒有已上線的泛用 tenant service adapter。

新增 commands 的 HTTP 描述共用：Idempotency-Key（原 8–128 字元 profile）、更新用 If-Match（Version）、受支援 ContractRef 協商，body 為 operation-specific strict input。scope/epoch 可能是 caller 的**預期值**供 stale 防護，但服務必須解析目前權威，不以該欄位授權。

權限檢查在同 DB transaction、receipt replay 前以及可能等待的資料鎖/receipt read-write 後重新檢查期限；SQL commit 前不成立就整筆 rollback。接續現有 command-core/scoped adapter 的鎖序，新增 tenant→membership→instance→binding→domain locks 由 SP-02/05 統一測試，不把目前 member context serialize 成 credential。network/provider/object I/O 永遠在鎖外。

本地 receipt namespace 延續既有 profile；未來 tenant/service namespace 必須包含不可混淆的 auth-kind/principal/tenant-or-scope/operation/key，request digest 綁 target、expected version、contract與payload。跨 transport 的 `operation_id` 是獨立 domain effect identity：即使 credential rotation、hosted/external 切換或新 transport key，也不得重複 reserve；移轉只接續已證明的 operation，不能憑匯入 receipt 開權。

## 5. 共用錯誤與讀寫語意

| HTTP/code | 語意及 client 動作 |
| --- | --- |
| 400 invalid_input / invalid_command_json | 修正 strict DTO，不能自動丟欄位再送 |
| 401 authentication_required / session_expired | 重新驗證本人；不偷偷改用 platform key |
| 403 capability_denied / policy_unconfigured | 已知自己範圍內的能力不允許；只影響該 action |
| 404 not_found | 未授權私人 target 與不存在一致，含 lookup/search/download |
| 409 idempotency_conflict | 同 key 異內容，保持原 operation；不得覆蓋 |
| 409 authority_changed / migration_in_progress | 重新解析 binding/同 operation 狀態；不盲送新 effect |
| 412 version_conflict / 428 version_required | 重新讀目前資源/比較差異；receipt 絕不可覆蓋現值 |
| 422 contract_incompatible / import_invalid | 拒絕受影響能力，保留可用 read/export |
| 429 quota_exceeded | 回 bounded retry-after/可行替代；不扣其他 tenant 額度 |
| 503 dependency_unavailable | 未派送可安全重試；已派送結果不明轉 needs_reconciliation |
| 202 + Operation | accepted/running/unknown 是持久狀態，UI 不宣稱完成 |

GET operation 也重新驗目前讀取權；舊 success receipt 保存原結果，不保證目標資源仍存在/同版。操作 list 不帶私有 body、內部 URLs 或 secret。沒有特定安全 policy/capacity profile 時拒絕昂貴新副作用，但普通已授權 read/Stop/export recovery 按獨立政策保留。

## 6. Event、可攜與安全 profile 的單一責任

[SP-05](SP-05-module-interoperability.md) 唯一定 EventEnvelope、inbox/outbox、projection 和補償語意。target 欄位為 event_id,event_type,event_schema_version,contract_ref,source_instance_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_sequence,authority_epoch,occurred_at,correlation_id,causation_id,payload。event_sequence 每 aggregate 連續且跨 epoch 延續；aggregate_version 可跳號。既有 event scaffold/scoped outbox 必須經有來源的 versioned adapter，缺欄位不得捏造。

[SP-07](SP-07-portable-bundle.md) 唯一定 app/data/attachment/interop manifest；[SP-08](SP-08-module-migration.md) 唯一定 cutoff/epoch/fence/handover；[SP-09](SP-09-external-connection-security.md) 唯一定 service binding 的傳输安全要求。它們使用既有 ReleaseSet、credential、recovery 與 Asset engine，不建立另一套簽章信任根、queue 或工作引擎。

資料責任以 [data-responsibility.md](data-responsibility.md) 為共同清單，新增私有欄位/投影/附件要同時更新 schema、export、retention 及測試；同名 ERP entity 不能自行增加一個權威。

## 7. 共用敏感能力名

`module.data.export`、`module.data.import`、`module.authority.transfer`、`module.binding.manage`、`module.connection.manage`、`module.operation.read`、`module.operation.reconcile`均綁精確tenant/instance及用途，不能以有module key當全域權限。Export/import/migrate/binding管理預設owner+所需近期驗證；個別可委派export要限定instance/purpose/expiry。普通admin/operator/read能力不自帶敏感能力。`tenant.ownership.transfer`是tenant經營權，不等於module writer切換。

同步control-plane CRUD可回200/201 typed resource及version；需異步/重啟/unknown處理的命令回Operation。每一route依所屬spec列的成功body，不為方便把所有write變成同一萬能operation。

## 8. Control-plane facts 與 operation routing

SP-05 module EventEnvelope只用於真正module instance擁有的domain facts。Guild preference/classification、tenant建立、registry/provision等platform-native事實走既有scoped/platform控制面journal與明訂versioned payload；tenant建立前或instance尚不存在時不得捏造tenant/source_instance ID。將控制面變更送到具體module時，受控translator需知道實際target、policy與source revision，仍不得宣稱它是該module原生業務事件。

SP-04 `/api/v1/tenants/{tenant_id}/operations/{operation_id}`是registry/provision lifecycle查詢，可能尚無instance或牽涉多個instance，驗其完整target集合的目前權限。SP-05 `/api/v1/tenants/{tenant_id}/instances/{instance_id}/operations/{operation_id}`是該module domain effect查詢，驗exact instance。兩者只共用Operation envelope/既有core，不互稱同一路由、不建立兩份operation truth；registry operation用dependency_refs明連其domain operation，不能用同ID影射另一scope。
