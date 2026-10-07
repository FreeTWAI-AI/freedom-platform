# SP-05 — 模組邊界、互通契約與可靠聯動

## 1. 文件識別、來源與範圍

- ID：SP-05；版本：0.1.0；狀態：`planned / implementation_not_started / acceptance_not_run`
- 程式基線：`FreeTWAI-AI/freedom-platform@567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`，2026-10-05 讀取；本 PR 只有文件，不註冊路由、不執行 migration、不啟用外部服務
- 意圖來源：《Freedom Guild Launchpad Architecture Plan v1.0》§8–11、§13–14、§20、§24、附錄 A/B/C。本文以完整 Markdown 讀取稿逐條承接；原始 ZIP／JSON 的取得與追蹤校對狀態由來源索引記錄，本文不推定其 validator 已通過
- 主責：D-14–D-16、D-20；R-026、R-028–R-035；T-026、T-028–T-035。協作：D-11、D-13、D-17；R-022、R-025、R-043–R-049；T-022、T-025、T-043–T-049
- 共同定義：[contracts.md](contracts.md)；程式位置：[repository-map.md](repository-map.md)；資料責任：[data-responsibility.md](data-responsibility.md)；待決參數：[decision-log.md](decision-log.md)；完整映射：[traceability.json](traceability.json)
- Foundation 的 [168 項來源要求](../unified-foundation/source-acceptance.md)及 [共同驗收](../unified-foundation/acceptance.md)原樣保留；此文件不重編、不宣稱完成它們。主要延伸 R2:S03–S08、AP:WORK-06/07/10/13/16、AP:OPS-07；映射表示相關責任，不等於同一測試已覆蓋

## 2. 使用流程、非目標與依賴

### 2.1 一條完整的最小垂直流程

1. Tenant A 的 storefront 在 hosted；同一 A 的 inventory 可以 hosted 或 external。Storefront 先保存 `draft` 訂單意圖，再建立持久協調操作
2. Registry 以已授權 tenant、目標 instance、capability 解析當前 binding。Storefront 呼叫 inventory application port 的 reserve，不能讀寫 inventory 私有表
3. Inventory 在自己的短交易中檢查權限、epoch、庫存版本及餘量；原子保存 reservation、receipt、outbox。Storefront 收到確定成功或核對到原操作成功後，才把訂單reservation saga改為 `reserved`
4. ACK 丟失時仍顯示「預留結果確認中」。沿相同 operation/key 查詢；不得另造 key 再 reserve。外部端離線只阻擋此能力，不阻止 A 的其他模組或 B 工作
5. 使用者取消已預留的意圖，另發冪等 release；release 未確定完成時為 `releasing` 或 `needs_reconciliation`。已寄信、出貨或付款不得用刪列假裝回滾

第一個可攜profile僅包含SP-10的reserve/release/status；沒有confirm、consume或fulfill。綁到此profile的商店必須回 `checkout_ready:false`，在另有consume契約與驗收前拒絕付款/出貨。本案例的「庫存已預留」不代表結帳、付款、實收、會計、物流或真實營收已啟用。既有 `merchant_backend_report`／`record_only` 證據邊界繼續有效。

### 2.2 依賴與可先做的工作

- SP-02 提供 tenant membership、target ACL、專門 scopes；SP-04 提供 registry、binding、單一 authority；SP-09 提供服務身分、endpoint 驗證及 replay grant
- SP-06 定義私有副本及保留；SP-07/08 接收穩定身份、receipt／event cutoff 交接；SP-12 提供共同契約發布與可信 consumer 檢查
- 不必等全部公會客製化、ERP 拆分、真實金流或外部 production：可先做雙 adapter 的同一 fixtures、隔離 PostgreSQL、真正 loopback HTTP endpoint、故障注入與合成資料
- 非目標：新 queue 產品、通用 workflow engine、全域同步 DB、跨服務 ACID、時鐘排序、以 event 簽名證明業務內容真實

## 3. 現有程式與精確改動地圖

以下 KEEP/MODIFY 路徑均已在基線讀取；NEW 是提案，不是假稱已有的檔案。實作 PR 應先由 repository-map 的 owner 鎖定共用檔案。

| 類別 | 精確路徑 | 觀察及接續責任 |
| --- | --- | --- |
| KEEP | `packages/db/command-core.ts` | `runCommandCore` 在 receipt lookup 前 authenticate/lock/authorize；沿用 orchestration，不放 HTTP／物件 I/O |
| KEEP | `packages/db/member-command.ts`、`packages/db/legacy-digest.ts` | legacy namespace `user_id/operation/key`、`digest({body,expected:expected??null})`、SQL 及 response 完整保留 |
| MODIFY | `packages/scoped-commands/index.ts`、`packages/scoped-commands/README.md` | 現為 member_session + personal/community；另加經審查 tenant adapter，不能把 service 假裝成 member 或讓 caller 選 receipt profile |
| MODIFY | `packages/resource-scopes/index.ts`、`contracts/common/v1/identity.ts` | 現 resolver 不支持 tenant/service；現 wire scope enum 為 community/personal/site。須以 SP-02 的 backing tables、FK、validator、鎖順序完整延伸，不能只改 enum |
| KEEP | `migrations/076_principal_resource_scopes.sql`、`migrations/078_scoped_member_commands.sql` | 不改已發布 migration；078 的 append-only scoped journal/outbox 沒有 delivery/inbox，不能直接當完整可靠互通 |
| MODIFY | `modules/agent-commerce/orders.ts`、`modules/agent-commerce/distribution.ts`、`modules/agent-commerce/imports.ts` | 現 createOrder 直接 join/update commerce_items，shop-key machine path 亦不等於新 service adapter；分階段以 port 取代，不維持雙 writer |
| MODIFY | `modules/catalog-commerce/service.ts`、`apps/platform-api/src/routes/agent-commerce.ts`、`apps/platform-api/src/routes/commerce.ts` | 既有 domain invariants、舊路由相容及安全狀態保持；新能力與路由明確隔離 |
| KEEP | `packages/db/index.ts`、`packages/shared/problem.ts` | 保留 legacy journal/checkVersion/Problem 語意；不能把舊 community outbox 廣播為 tenant event |
| KEEP | `modules/member-communications/events.ts` | 既有 domain transaction 通知與 source-key 去重可參考；它不是 module EventEnvelope，也不得接收完整 CRM payload |
| MODIFY | `docs/platform-plan/contracts/event-envelope.schema.json` | 現 scaffold 使用 id/type/communityid/aggregateversion/eventsequence；新版需由同一契約 authoring pipeline 顯式版本化，不能原地改壞 v1 |
| KEEP | `packages/sdk/schema.mjs` | 現有手寫bounded-subset validator源碼，由bundle builder複製；不能誤標成generated，也不能假設支持新版完整JSON Schema |
| GENERATED | `contracts/preview/v1/schemas/event-envelope.schema.json`、`packages/sdk/protocol.mjs`、`packages/sdk/client.d.mts` | 現 bundle／SDK 產物；不得手改。`scripts/build-contract-bundle.mjs`由source生成/複製；新版registry/schema/validator/SDK由SP-12同一來源產生、pin及驗證 |
| NEW（提案） | `packages/scoped-commands/tenant-command.ts`、`modules/module-interop/ports.ts`、`modules/module-interop/delivery.ts`、`modules/module-interop/coordinator.ts` | 分別承接 tenant adapter、typed application ports、durable inbox/outbox delivery、特定業務協調；不是另一套 identity/queue/runtime |
| NEW（提案） | `apps/platform-api/src/routes/module-interop.ts`、`tests/runtime/module-interop.test.ts`、`tests/integration/module-adapter-parity.test.ts` | route、DB 故障矩陣及真正 external adapter parity |
| NEW（提案） | 新 additive migration，序號於實作時分配 | tenant receipt/delivery/inbox/sequence/flow 表及約束；不能搶用已存在的 076–115 或改寫歷史 |

現有 `tests/runtime/command-core.test.ts`、`scoped-member-command.test.ts`、`scoped-member-domain-revalidation.test.ts`、`avatar-command-compat.test.ts` 是回歸入口，不是本 spec 驗收已通過的證據。

## 4. 資料模型、authority 與不變量

### 4.1 共用型別與所有權

- `OpaqueId` 沿 `contracts/common/v1/identity.ts` 的小寫 UUID 驗證。`Version`、`Epoch` 是 `^[1-9][0-9]{0,18}$` 且 ≤ PostgreSQL bigint 最大值的十進位字串；禁止 JSON number 損失精度
- `ContractRef`、`ResourceRef`、`ApplicationReleaseRef` 使用 [contracts.md](contracts.md) 單一命名；ContractRef精確為 `{family,version,source_commit,artifact_sha256,behavior_profile}`。本文所有 DTO 為 snake_case；未知 authority、scope、actor、credential 等 body 欄位一律拒絕，不能忽略後假成功
- Registry 的模組實例為 `{instance_id,tenant_id,module_key,application_release_ref,data_schema_version,contract_ref,status,binding_id,authority_epoch,version}`；location/binding 不改 instance/resource identity
- Capability欄位使用共同`CapabilityKey`（允許冒號及點），不是不允許冒號的StableKey；operation/type仍用各自已定義型別。
- 當前 authority 才能寫 domain aggregate。Registry 是控制面的 authority 登錄；outbox/event 是已提交事實；projection 是衍生資料。三者不能相互冒充
- 內部 `VerifiedContext` 含 current principal、authn kind、tenant membership/grant、target instance、capability、binding version、epoch、recovery floor、policy revision；只可由 server 驗證 backing records 建立，不接受序列化 JSON

### 4.2 建議持久實體

| 實體 | 必需欄位／鍵 | 關聯、可變性與敏感範圍 |
| --- | --- | --- |
| `module_command_receipt` | namespace、key_hash、request_digest、operation_id、accepted_at、replay_not_after、response_expires_at、historical_result、result_version | namespace 依共同 tenant adapter 定義且受認證 context 約束；唯一 namespace+key；target instance/tenant 同域 FK；結果不可覆寫成最新資源 |
| `module_command_tombstone` | 同 namespace+key_hash、request_digest、operation_id、terminal marker、compacted_at | 去除 response 後仍拒絕同 key 新副作用；保留到 namespace 永久退役及所有 replay authority 不可恢復。不是保存私有 request 原文 |
| `module_operation` | operation_id、tenant_id、instance_id、state、version、resource_ref?、problem?、retry_after_seconds?；internal request digest/epoch/deadlines | 唯一 operation_id；每次狀態更新 CAS version；只存最小操作 metadata，詳細业务內容在 authoritative module |
| `module_event_stream` | tenant_id、instance_id、aggregate_type、aggregate_id、last_event_sequence、aggregate_version | aggregate 複合唯一；allocate sequence 與業務/outbox 同交易，不用有 rollback 缺號的 PostgreSQL sequence 作 contiguous counter |
| `module_outbox` | EventEnvelope、canonical_digest、created_at | immutable fact；同 event_id 異 digest 衝突。delivery 欄位放獨立 sidecar，不 UPDATE 舊 immutable outbox |
| `module_delivery` | event_id、subscription_id、state、attempt_count、next_attempt_at、lease_fence、lease_until、last_problem_code | 唯一 event+subscription；只允許有限重試；worker lease/fence 撤銷後不能覆蓋較新 attempt |
| `module_inbox` | consumer_instance_id、subscription_id、event_id、digest、source tuple、event_sequence、state、received_at、processed_at? | 去重鍵包含 consumer/subscription/source identity；相同 stream+sequence 只能對同 event/digest；接收 receipt 及本地變更原子提交 |
| `module_projection_cursor` | consumer/subscription/source aggregate tuple、contiguous_event_sequence、source_aggregate_version、as_of、last_verified_at、stale_reason? | 不以 received_at 排序；gap buffer 不前移 contiguous cursor；舊版本不得覆寫新 projection |
| `module_flow` / `module_flow_step` | flow_id、tenant_id、origin_instance_id、order_ref、state、version；step operation_id、request_digest、target_instance_id、status、reservation_ref?、compensation_operation_id? | order intent 到 active flow 唯一；每步恆定 operation/key；已生效步驟不可抹除；secret、完整客戶及外部 URL 不進 flow |

`event_sequence` 起始未發事件時內部 counter 可為 0；wire 的實際事件必須 ≥1。`aggregate_version` 每次 domain transition 增加，可能從 5 跳到 9；公開 event_sequence 必須從 12 接 13，不能因內部未公開 transitions 等待 6、7、8。

### 4.3 跨 tenant 記錄及 CRM 快照

- `shared_transaction_fact` 為提案，含 fact_id、authoritative_instance_id、participants[]（tenant_id、role、accepted_agreement_version、visible_field_set）、resource refs、purpose、snapshot_version、retention_policy_ref、version
- Supplier A/Seller B 仍是兩個 tenant。共同交易只在當前參與 ACL 中授予指定欄位；A 私有成本、B 客戶名單不在預設 allowlist。A owner 不能修改 B 的私有主檔
- 訂單履約快照由 order authority 在建立/合法修訂時保存當次必要姓名／收件資訊及來源版本；不是會跟著 CRM 任意更新的主檔。CRM 私人筆記、完整互動歷史、全量聯絡簿禁止加入快照
- 刪 CRM/撤銷共享立即停止新 CRM 讀取，清除可撤銷顯示 projection；必要 order snapshot 依獨立用途/期限保留。另一方合法交易事實不能由一方 delete cascade；不得以「共同記錄」無限留整份 CRM

## 5. Command、query、event 完整契約

### 5.1 HTTP 與 application port

共同module-domain operation/event基底為 `/api/v1/tenants/{tenant_id}/instances/{instance_id}`。SP-04可在尚無instance或跨instance的registry/provision工作使用tenant層`/api/v1/tenants/{tenant_id}/operations/{operation_id}`；兩者沿同Operation envelope/core，前者不是後者的未授權alias，也不是兩套引擎。Inventory domain唯一API/DTO權威是 [SP-10 §5.2](SP-10-domain-upstream-integration.md)，其基底為 `/api/v1/tenants/{tenant_id}/inventory/instances/{instance_id}`；不得再註冊一組不相容的`/instances/{id}/inventory`變體。下表inventory path相對其domain基底，其餘相對共同基底。

Path只是target selector；server驗current membership/grant並比對tenant/instance真實歸屬。`authority_epoch`依SP-10是caller的expected epoch，必須比對current authority，不能授權或改寫它。Body不接受自填actor/scope/owner。

Mutation使用既有 `Idempotency-Key: [A-Za-z0-9_-]{8,128}`。Reserve沿SP-10每行`expected_version`對對應SKU balance做CAS，按sku_id排序鎖所有行，同交易全成或全退；**不另造inventory ledger aggregate If-Match**。Release用 `If-Match: "<Version>"` 對reservation.version；缺header428、stale412。已授權相同receipt replay不重跑CAS。`operation_id`是持久domain effect identity；header key是transport identity，rotation/切binding後仍不能用新key製造第二份reserve。

| Method／相對path | operation／scope | 嚴格輸入 | 輸出 |
| --- | --- | --- | --- |
| POST `/reservations` | `inventory.reserve`／`inventory:reserve` | SP-10原DTO：`{operation_id,order_ref,authority_epoch,expires_at,lines:[{sku_id,quantity,expected_version}]}`；1–50 distinct SKU，quantity 1..1,000,000，expiry在server現在後60–900秒；這些是SP-10 proposed profile，非已批准營運policy | 共用Operation→Reservation；同步200/201，非同步202；resource_ref指相同reservation |
| POST `/reservations/{reservation_id}/release` | `inventory.release`／`inventory:release` | `{operation_id,authority_epoch,reason}` + reservation If-Match；reason=`cancelled|expired|downstream_failed` | Operation→同Reservation；active→released；expiry worker可expired；fresh-version終態release為成功no-op，stale412 |
| GET `/reservations/{reservation_id}` | `inventory.status`／`inventory:status`＋同order grant | path IDs，無body/query | 完整Reservation DTO由SP-10唯一指定：`{reservation_id,tenant_id,instance_id,operation_id,order_ref,state,lines:[{sku_id,quantity}],expires_at,authority_epoch,version,observed_at}`；state=`active|released|expired`；從authority讀取 |
| GET `/reservations/by-operation/{operation_id}` | `inventory.status`／`inventory:status` | path IDs；同命令target/scope | 同Reservation或已拒命令的原terminal Problem；authority確知不存在才404 `command_not_recorded`，timeout不能偽裝此404 |
| GET `/availability` | query／`inventory:read` | `sku_ids`為1–50 distinct UUID，不混cursor | SP-10原DTO：`{instance_id,authority_epoch,observed_at,items:[{sku_id,available,version}],projection:false}`；不能保證稍後reserve成功 |
| GET `/operations/{operation_id}` | query／`module.operation.read`且原target可見 | path ID | 共用Operation；歷史結果不含最新resource body，client另做authorized query |
| POST `/operations/{operation_id}/reconcile` | `operation.reconcile`／`module.operation.reconcile` | `{}` + operation If-Match；僅已知定義的狀態核對 | 202同Operation或核對子操作ref；不能強制成功或改原業務輸入 |
| POST `/events` | service-only event ingest／`events.deliver` | 單一EventEnvelope；signature/audience/replay proof在認證transport | 202 `{event_id,status}`；status=`received|duplicate|buffered`，ACK僅代表持久接收 |
| GET `/events` | service-only replay／`events.replay` | `aggregate_type,aggregate_id,after_sequence?,limit?,cutoff_ref?` | `{events,next_cursor?,high_watermark,retention_floor}`；越過retention floor410，須authorized snapshot rebuild |

SKU與reservation必須屬target inventory instance。`order_ref`則應指向**已配置dependency允許的同tenant commerce instance**，不要求與inventory同instance；server驗order authority、dependency、當前caller grant及ref歸屬。跨tenant僅在精確agreement/participants/purpose及限定order/instance的服務grant全部成立時可用，不能由seller owner角色推定。第一個移轉proof只測同tenant不同commerce/inventory instances。

普通 owner/editor 不自動獲得 `events.replay`、bulk export、reconciliation 或 migration scope。Hosted adapter 走同 typed port/context/error validation；不得以同 process 為由跳過 scope、version、receipt 或 current authority。

`operation` 統一為 `{operation_id,state,version,resource_ref?,retry_after_seconds?,problem?}`，state 僅 `requested|running|succeeded|failed|needs_reconciliation|cancelled`。`problem` 沿共同 HTTP `{type,title,status,code,detail}` 型別，固定 code 及安全 detail，禁止原始 SQL/provider message；retryable 判定由下方 code 矩陣決定，重試 metadata 只放已定義的 operation 欄位。未接受的請求返回非 2xx Problem，不能建立假成功 operation。

### 5.2 新 tenant adapter 的執行顺序與相容邊界

1. 固定 server-selected operation，嚴格 parse/snapshot 有界 plain JSON；驗證 key/expected/target。保持現有 JSON 安全限制，不以任意 JSON.stringify 接受 accessor/cycle/unsafe integer
2. BEGIN；驗證並鎖 current authentication、principal、tenant membership/grant、target instance/binding/epoch/recovery floor；按照 SP-02/04/09 共用鎖順序，先全局身份，再 target，再 policy。service adapter 不建立假 member session
3. 鎖新 tenant adapter 的明確版本化 receipt namespace；驗 current target ACL、capability、deadline 和 policy，再查 receipt/tombstone。等待後以 DB `clock_timestamp()` 重驗到期，不用 transaction-start `now()`
4. 舊 key + 異 digest →409；同 digest + 有完整 receipt →回歷史 operation ref/result；同 digest + 已 compact →410 `receipt_expired`，可另查原 operation。撤權時即使命中 receipt 也不能重播副作用，讀歷史結果仍需當前 read ACL
5. 新效果才驗 domain CAS，寫 domain、operation、journal、outbox、receipt，同一 client 同交易提交。失敗整批 rollback。Receipt 只保存顯式最小回應，不能自動記整份 request
6. 外部 HTTP／R2／provider I/O 永遠在提交後，使用持久 intent/fence。核對結果回來再開短交易，重驗 authority/epoch/current grant；撤權後只能按許可記最小晚到 evidence，不能觸發新步驟

現 legacy digest、namespace、advisory key 和 scoped profile `freedom.scoped-member-command/v1` 全部保留。新 tenant adapter 的 authoring source/profile 由 contracts.md 唯一指定；不能藉此把歷史 receipt 重算。對已有成功 receipt 的回應不可誤稱資源「目前版本」；前端僅更新 operation，依最新 authorized query/CAS 更新資源。

### 5.3 EventEnvelope（新版本提案）

共同契約的 schema/SDK/validator 只有一個 authoring source；本表是該契約的 required semantic specification，不另維護第二份可執行 JSON schema。此EventEnvelope只用於有真實tenant/instance authority的module domain事件；平台原生guild、會員或tenant-create等尚無instance的控制面事實沿其既有scoped profile，或另經共同owner明定control-plane profile，禁止捏造tenant_id/source_instance_id以套用本envelope。

| 欄位 | 型別／必需性 | 驗證 |
| --- | --- | --- |
| `event_id` | OpaqueId，必需 | immutable；同 id 異內容拒絕 |
| `event_type` | contract catalog 的精確版本化名稱，必需 | 如SP-10的 `inventory.reserved.v1`；不是 caller 自訂 handler |
| `event_schema_version` | Version，必需 | 精確 payload schema revision；與 application/data/binding version 分開 |
| `contract_ref` | ContractRef，必需 | 受支持、fingerprint 驗證的共同 bundle |
| `source_instance_id`,`tenant_id` | OpaqueId，必需 | 與已驗證 sender registration、audience 及 authority 匹配 |
| `aggregate_type`,`aggregate_id` | allowlisted module type + OpaqueId，必需 | 與 source instance 的 registered authority 匹配 |
| `aggregate_version`,`event_sequence`,`authority_epoch` | Version、Version、Epoch，必需 | 前者可跳號；sequence 按 aggregate stream 連續且跨 epoch 不 reset；epoch 非時間戳 |
| `occurred_at` | RFC3339 UTC instant，必需 | 稽核時間，不用于決定排序/遲到合法性 |
| `correlation_id`,`causation_id` | OpaqueId；後者必需但可 null | root correlation 恆定；causation 指前一 operation/event，不能授權 |
| `payload` | event-specific strict object，必需 | Inventory payload由SP-10 §5.5唯一指定，完整最小shape為 `{resource_id,version,state,related_resource_refs}`，state/有序refs依各event精確schema；v1刻意省略quantity/expiry，需以目前授權status query另讀；禁止另造reason_code或不相容Reservation DTO。沒有客戶名單、notes、secret、raw bytes |

Producer 身分與簽章由 SP-09 transport 認證；event 自填 actor/tenant 不是權限。可信 sender 可撒謊或有 bug，故 event 只表示其宣稱且契約可處理的 fact，不是銀行/真人驗收證明。

**舊到新對照必須顯式發版：** scaffold `id/type/time/aggregateid/aggregateversion/eventsequence/data` 分別映射 `event_id/event_type/occurred_at/aggregate_id/aggregate_version/event_sequence/payload`，但 `evt_*`→UUID 需持久 alias ledger；safe integer→decimal string 需無損轉換，0 version 不能冒充1。`communityid` 不是 tenant_id；`source` 不是 instance；`dataschema/contractversion` 需 registry 對照到已 pin contract_ref。缺失 epoch/source/tenant/correlation 映射的舊事件不能推測後發往新邊界。`data.actor` 的 accountability 只可作經最小化的內部 provenance，不能直接變 service credential。既有 scoped outbox payload 另為 subject_principal/authn_kind/scope/aggregate_type/aggregate_id/aggregate_version/data，沒有 contiguous sequence/epoch/tenant；它是另一個需 reviewed translator 的來源，不是 scaffold 的 runtime 實現。

### 5.4 去重、gap、遲到及 retry 的精確規則

- stream key = `(tenant_id,source_instance_id,aggregate_type,aggregate_id)`；consumer cursor 再含 subscription_id。每個 subscription 消費其獲准 aggregate 的完整 integration sequence。只選部分 event types 時，publisher 必須提供受授權且不含隱藏 payload 的 skip-range 記錄；不能把 filter 造成的缺號誤認漏事件。無法安全給 skip metadata 就拒絕這種 subscription
- 驗證 auth/schema/size →INSERT inbox（unique id+digest）→依 stream 鎖取 cursor。N+2 先到只 buffer；fetch N+1，以 inbox+projection+cursor 同交易套用後 drain；不得先把 cursor 跳到 N+2
- 已處理的相同 event 回 duplicate；同 id/sequence 不同 digest →409 `event_identity_conflict`，隔離 offending subscription。較舊 aggregate_version 只記去重/遲到 evidence，永不覆寫较新 snapshot
- Snapshot rebuild 必須由 current authority 返回 scope-filtered snapshot + exact high_watermark/aggregate_version；驗證完成才原子換 projection/cursor，之後 drain 更大的 sequence。不同 instance、epoch、version 或未授權 snapshot 不得使用
- **遷移 cutoff：** SP-08 的 trusted handover 記 `old_epoch,new_epoch,source_binding_id,destination_binding_id`，每 aggregate 的 `final_event_sequence,final_aggregate_version`，及 exact `event_id+canonical_digest` manifest（大型集合用被驗證完整的分塊 hash 清單）、已接受 operation IDs/digests、replay deadline。舊 epoch event 只有在 exact manifest 成員、sequence≤cutoff、digest 相同、具限定歷史 replay grant、未過 deadline 時可處理。來源自稱 occurred_at 較早、排隊較久或「epoch只差1」均不足。cutoff 後的新舊來源命令只允許 current authority，舊來源不得再補造 event。新 authority 承接下一 sequence，不從1重來
- 正常憑證被撤銷，不能繼續用它送 late event。必要歷史重播由新發、限 source/cutoff/event-set 的 replay grant 承載；接收方重新驗證當前資料可見性及 tombstone，撤銷的 projection 不因合法晚到 event 復活
- outbox delivery：短交易 claim lease →commit →send →短交易用 fence 寫 ACK。成功但 ACK 丟失仍同 event 重送；queue 只是 at-least-once wakeup，持久 outbox 是補送來源
- transport timeout/429/可恢復5xx → bounded exponential backoff + jitter；401/403/unsupported contract/異內容重播 →不盲重試。Malformed payload、無法解碼 schema、連續 domain 不變量失敗標 poison；耗盡 attempt 或 deadline 標 `quarantined`，保留可重現 event/digest及safe問題，不阻塞其他 tenant/stream
- 手工 redrive 需 `events.reconcile` + current ACL + If-Match，沿原 event ID/內容；修 bug/schema 後可重試原事件，修正業務內容必須發新的 correction event，不覆寫舊事件。未解決 gap 只降級依賴該 projection 的能力
- full receipt/inbox evidence 到期可按 SP-06 清 payload；compact key/digest marker 防止再次產生效果。超 `replay_not_after` 的外部 operation permit 和 event replay 拒絕，不把 missing receipt 當「一定沒執行」

### 5.5 錯誤矩陣

| HTTP／code | 是否自動重試 | 可見處理 |
| --- | --- | --- |
| 400 `invalid_input` / `invalid_event` | 否 | 修輸入；不回原始值 |
| 401 `authentication_required` | 否 | 重新認證，不建立 operation |
| 403 `capability_denied` / `credential_revoked` | 否 | 停新副作用；只允許明確核對 evidence |
| 404 `not_found` | 否 | tenant/instance錯誤與不存在同形，不洩漏他方存在 |
| 409 `idempotency_conflict` / `event_identity_conflict` | 否 | 保留原事實；不同內容不可同 key/id |
| 409 `authority_changed` / `migration_fenced` | 只核對 | 刷新 registry；先查原 operation，不能改 epoch 自動重做 |
| 409 `insufficient_stock` / `order_binding_invalid`；412 `balance_version_conflict`；422 `expiry_invalid` | 否 | 沿SP-10 domain錯誤；重新讀取/選擇，unknown不能當成缺貨 |
| 410 `receipt_expired` / `replay_window_expired` | 否 | 只讀允許的 operation/稽核；需有證據的人工處理 |
| 412 `version_conflict`；428 `version_required` | 否 | 重新讀取；禁止自動覆蓋新版本 |
| 422 `contract_incompatible` / `snapshot_invalid` | 否 | 只關閉受影響 capability；資料匯出獨立判定 |
| 429 `quota_exceeded`；503 `dependency_unavailable` | 有界 | safe Retry-After；unknown effect 先 reconcile |

## 6. 狀態機、重啟與部分完成

| 對象 | 合法轉換 | 失敗／重啟規則 |
| --- | --- | --- |
| operation | requested→running→succeeded/failed；requested→cancelled；running→needs_reconciliation；needs_reconciliation→running/succeeded/failed/cancelled | cancelled 只有確認未發生效果或補償完成時成立；unknown 不可直接改 failed 再新做。terminal 不原地重啟業務效果 |
| order reservation saga | requested→reserving→reserved→releasing→released；另有failed_known及needs_reconciliation分支 | 沿SP-10唯一domain狀態；共用Operation仍六態。每步原子保存下一intent；重啟依持久command_ref核對。reserve不開payment/fulfillment |
| reservation | active→released或expired；後兩者終態 | 沿SP-10；expiry/release在authority交易中互斥，每行只扣一次reserved。timeout不等於expired；本profile沒有confirm/consume/committed state |
| delivery | pending→leased→acked；leased→retry_wait→leased；→quarantined | lease timeout 可 takeover，但 fence防舊worker改狀態。accepted event永不「因lease過期就重建event」 |
| inbox | received→buffered/applied/ignored_stale/quarantined | receipt+effect+cursor 原子；重啟後復用原行；revoked/tombstoned payload只能最小稽核，不能重新生成可讀 projection |

若發出 reserve 後 grant 被撤，reconcile 可記錄已提交 reservation；是否 release 需現有有效補償授權或具有狹義 scope 的受控系統清理，不從舊 grant 自行推定。持久 operation 標記待人工處置與 reservation expiry，不能持有不存在的授權無限重試。

## 7. UI、可見性與人工接手

- 顯示 tenant、模組名稱、hosted/external、projection來源、as_of與「資料可能已過期」；庫存顯示數量不是預留成功
- Submit後固定 operation，按鈕避免雙提交；刷新、返回、重新登入均查相同 operation。重試只用原key。禁止用success receipt覆蓋較新畫面resource version
- 狀態文案區分「等待庫存」「結果確認中」「取消處理中」「需要有權人確認」；空資料不等於外部連線失敗。離線可讀已授權且未失效快取須明示時效，不能接受新的跨平台副作用
- Tenant切換立即清私有列表/快取/選取項，取消舊request；晚到結果要比對 current tenant+instance+view generation，不能覆蓋新tenant画面
- 手機單欄可讀，操作目標不被sticky面板擋住；鍵盤可操作且焦點返回發起按鈕，狀態以aria-live宣告，錯誤不只顏色。大量表格提供標籤、逐頁查詢而非整表下載
- 人工面板只顯 operation/event/flow refs、safe code、最後確定步驟、下一安全選项；不顯 secrets/raw payload。重新送出、補償、匯出各自檢查scope；沒有通用「標為成功」按鈕

## 8. 匯出、移轉、升級與 legacy 相容

- SP-07 套件包含本模組 domain rows/IDs、必要 event/outbox/inbox cursors、尚在窗口的 dedupe metadata/operation state；只傳當前 tenant及模組責任內資料。密鑰、真人session、另一tenant完整fact均不得匯出
- SP-08 trusted migration 保留 operation/event/aggregate IDs及單 writer權威；clone分配新tenant/instance/resource IDs及明確ref map，不能帶舊namespace作新authority或自動replay source outbox
- Expand/backfill：新增port/tenant mapping，對不明owner quarantined；以shadow read比對但僅舊authority可寫。Switch：切caller到port後撤跨模組SQL權限；Contract：相容窗口結束再移除舊join。不得同時shadow-write兩套真相
- 舊合法read可經映射adapter；缺tenant/必要version的新語意write回明確upgrade required，不能默猜tenant或回200後丟欄位
- 同一輸入跑hosted/external parity；錯誤、大小限制、strict-field與If-Match都一致。契約capability不相容只停那項功能，不能要求所有fork同步main
- 跨模組報表採明確有界批query或來源/時效可查projection；禁止把SQL join逐列換成N+1遠端請求
- 清理遵SP-06；原本沒有tenant的receipt/journal不能透過粗糙community mapping洩漏到新tenant。新的receipt compact流程不擅自刪既有078 append-only rows

## 9. 威脅模型、最小權限與容量

| 反例 | 防線 |
| --- | --- |
| 請求自填另一tenant/epoch/owner，或同process繞port | path+backingACL驗證、複合FK、domain寫入權限、可信import graph檢查 |
| 看receipt得知他方業務、撤scope後replay | 當前auth/target ACL先於receipt，最小回應、non-disclosing404 |
| 惡意external把HTTP拉住DB交易 | 所有network在短交易外；持久intent、deadline、fence；DB鎖觀測測試 |
| 同event變payload、旧epoch补发新事实、時鐘造假 | digest+inbox唯一、exact cutoff membership、trusted replay grant、sequence非時鐘排序 |
| poison/gap使全站停擺、無限重試計費 | 每tenant/stream併發與queue budget、隔離poison、bounded重試、人工入口 |
| 投影被當真庫存/完整CRM，receipt把新state倒退 | authoritative reserve/CAS；投影allowlist/freshness；原結果與現況分開 |

**純 synthetic fixture 的建議測試 profile，全部待決，不是已批准產品policy或已啟用production預設：** command JSON上限沿既有256KiB，integration payload建議32KiB；通用batch最多100，但inventory必須遵SP-10更窄的50行/64KiB及5秒external timeout；單request端到端10秒；transport重試最多12次且總窗口24小時，backoff含jitter，通用單tenant同時8個外部call，但inventory沿SP-10最多4個；offline replay最多7日，full receipt/inbox evidence至少30日。必須驗 `receipt/dedupe retention >= replay deadline + maximum delivery/retry uncertainty + migration overlap`。超窗仍保留minimal tombstone，不能因記錄已過期再做一次。正式值及privacy期限在decision-log按量測/業務用途核准；較短payload retention可保留digest，不可縮短防重播安全邊界。這些數值不改現有各domain限額。

## 10. Fixtures、驗收、發布與未完成

共通fixture：兩tenant A/B；同一人A-owner/B-viewer；會長G不屬A；有範圍service SA；A storefront S、inventory I；B inventory J。Hosted I與真正獨立HTTP/DB的external I跑相同contract fixtures；runtime為非owner、非superuser、無BYPASSRLS角色。固定UUID、controlled DB clocks/latches、synthetic stock10與order qty3；記錄base/candidate SHA、schema/bundle fingerprint、角色權限、網路拓撲與safe evidence。所有下列案例目前 `not_run`。

| T-ID | 可重現步驟／故障注入 | 必須觀察與 evidence |
| --- | --- | --- |
| T-026 | A供貨給B，雙方接受agreement v1；B存一份履約快照；A撤私有CRM共享並刪該主檔；分別以A/B/G讀取及export | A/B只見participants allowlist；B必要訂單快照保留，CRM notes與完整名單不可搜尋/導出；保存欄位差分、ACL矩陣、清理回執 |
| T-028 | hosted port完成reserve；撤storefront DB角色對inventory表全部SQL權，換external I獨立DB後重跑；讓HTTP卡住並從第二DB connection寫無關合法資料 | 兩次均只透過port成功；directSQL/import graph反例被拒；第二交易完成且pg_blocking_pids無遠端I/O持鎖 |
| T-029 | 同JSON vectors跑hosted/external：success、strict unknown field、404跨tenant、If-Match、同key并發、逾時、大小超限、current撤scope | 正規化後response/error/operation/副作用一致；保存adapter矩陣、wire redacted trace與各DB effects |
| T-030 | 舊client合法read；缺tenant mapping/必要新欄位write；舊evt_*、communityid事件與無epoch scoped outbox接translator | 可驗證mapping才相容；缺語意明確拒絕，無200丟欄位/猜tenant；原v1及legacy receipt regression不變 |
| T-031 | 依序在domain write前、outbox insert前、receipt insert前、commit後ACK前殺worker，重啟publisher；再在inbox write後本地effect前殺consumer | 未commit零event；已commit必可補送；receipt/domain/outbox原子；inbox/effect/cursor原子；用DB快照/kill點記錄證明 |
| T-032 | 同key20路并發并跨restart；同event多次、異digest同id、異event同sequence；receipt payload compact後舊key再送；成功後撤session/grant再replay | 一次reservation；異內容409；過期410不重做；撤權先拒；resource升版後舊receipt不得覆寫新值；記effect count与namespace/digest（無secret） |
| T-033 | public sequence12/13对应aggregate5/9，先送13再12；删掉12觸發replay/rebuild；迁移cutoff13，合法舊epoch13晚到、偽造14/錯digest/過deadline及已tombstone projection | 等待的是event sequence非aggregate跳號；只exact cutoff合法事件被接納且不使新projection倒退；missing retained event才走validated snapshot；拒絕理由與cursor軌跡 |
| T-034 | reserve成功丟ACK；查原operation；在下一步失敗后release；release再丟ACK；另以獨立合成通知sink記錄已寄出的不可逆結果，撤權時重啟（不在inventory proof開付款/出貨） | 無重扣；release只一份；unknown保持needs_reconciliation；不可逆保留事實且需人工；補償未授權不執行；operation/flow歷史與business invariant |
| T-035 | 將projection可用量10固定，authority已剩1；fixture提供current expected_version但UI projection仍為10，提交qty3新單；跨tenant切換時延遲返回舊A query；成功後返回舊receipt | authority拒insufficient_stock；UI標陳舊不確認訂單；B不顯A；新resource version不倒退；手機/鍵盤/aria evidence |

補充必跑：poison schema不阻B；retry exhaustion與quarantine/redrive；lease takeover舊ACK；filtered event skip-range；receipt/inbox保存窗口边界；最低current contract與明確不支援fork；export不得夾他方facts/secrets。

**發布門檻：** 新tenant/service scope核心、same-authority fencing、以上runtime+real external endpoint測試、可信contract consumer檢查均通過才開capability；需要staging/production的項目另留release SHA/配置/受限身分證據。舊foundation未通過項繼續closed。此文件PR僅執行文件路徑/連結與`git diff --check`，不把文檔檢查算功能pass。正式quota、retention用途、compatibility window、tenant adapter namespace發布及跨tenant agreement field sets仍須decision-log結案。
