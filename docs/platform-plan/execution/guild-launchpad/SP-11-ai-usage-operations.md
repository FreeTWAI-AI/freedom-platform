# SP-11｜AI、用量與營運生命週期

## 1. 文件身分、來源與範圍

- **ID／版本／狀態：** SP-11／0.1.0／draft specification；本文定義待實作的 tenant 擴充，並未啟用 AI、模型 key、正式儲存、付費方案或部署
- **規劃來源：**《自由工坊｜公會啟動台與可攜式業務空間》v1.0（2026-10-05）第 16、18–20、24 章、D/R/T 附錄；可用的是完整 1,251 行附件文字，未取得原始 ZIP／schema 檔
- **中央 source pin：** `FreeTWAI-AI/freedom-platform@567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`；靜態查閱 `docs/plans/autopilot-vnext.md`、identity/resource-scopes、agent-control/execution、Work/Result/Asset 與相應 contracts；不把舊規劃的設計狀態或測試記載當本輪正式驗收
- **D：** D-07、D-11、D-12、D-14–D-21；**R：** R-016、R-018、R-044、R-048–R-051、R-053–R-056、R-060、R-063；**T：** T-016、T-018、T-044、T-049–T-053、T-057–T-059
- **唯一責任：**啟動台如何消費既有 Principal／Connection／Runtime／Grant／Work／Action／Result；可撤銷 tenant/module 授權、explicit 模型選擇、usage 與成本透明、離會／離 tenant／方案改變時的行為
- **共同來源：** [contracts.md](contracts.md)、[data-responsibility.md](data-responsibility.md)、[decision-log.md](decision-log.md)、[repository-map.md](repository-map.md)、[traceability.json](traceability.json)

硬不變式：人工表單、筆記、工作、商店、匯出等按其一般授權即可使用，**不以模型／key／AI grant 作前置**。AI 才要求本人選定的模型來源、當前 runtime/connection、精確 data/tool grant。平台系統 key 永遠不是會員沒有 key、失敗、額度不足或 provider 不可達的隱藏備援。

## 2. 使用者流程、前後狀態與依賴

### 2.1 人工與 AI 的同一個 Work

1. 成員在公會入口選 tenant，人工新建／編輯／保存 Work 與 Result；這是 SP-10 的真實 workflow，無 AI 環境也能完成
2. 使用者自行按「用 AI 協助」才進 preflight：顯示本人 connection/runtime、model/provider、CLI 或 BYOK custody、計費方、資料將送到哪裡、精確 Work／module refs 與限制
3. 缺 prerequisites 時回具體 blockers，Work 保持可編輯；不可自動建立高權限 connection、轉用另一供應商、較貴模型或平台 key
4. 使用者同意此 Work 版本、context digest、允許工具／資源、runtime／model、expiry、spend/usage limits，建立既有 Grant 的 tenant profile；service runtime 僅在交集範圍調用與人相同的 domain command
5. 相同 execution engine 建立 Run／Attempt／ActionIntent，先預留 quota，dispatch 時重驗 current grant、epoch、scope、binding；模型輸出保存為 Result 草稿，不能自動正式發布／付款／形成貢獻驗收
6. 使用者可 pause／stop／接手；已 dispatch 結果不明先 reconciliation，讓人看見「可能已消耗」。本人改寫 Work 使舊版 AI Result CAS 失敗，不能覆蓋人稿

### 2.2 依賴與不必等待的部分

| 依賴 | owner／使用方式 | 先行工作 |
|---|---|---|
| 人／service principal、tenant role、module scopes | SP-02＋現有 identity；新增 tenant-aware auth adapter | preflight schema／UI／負例可先做，不能假稱 `withMemberScope` 已接受 tenant/service |
| Work、notes、Result、Asset | SP-10＋既有 Work/Asset engine | 人工文字／附件流程不等模型認證或多工具 Agent |
| command／operation／event／fencing | SP-05、SP-08／09 | 持久化 intents、明確 role、same-key restart fixture |
| persistence/export/retention／recovery | SP-06／07 | 未決 policy 用 synthetic profile；正式隱私／外送 policy 未核定則 deny |
| runtime、CLI／BYOK custody、可信發布 | 既有 Autopilot foundation＋SP-12 | 沿現有 adapters，單步 draft 先做；不要求所有未來 runtime 一起完成 |

非目標：新的公會 AI runtime、共享萬能 key、替 user 繞過 provider 帳號限制、以模型自報代替授權、無限 hosted 算力、會員未授權的 recurring dispatch、付款／銀行驗證、自動抽成或盈利保證。重渲染／影片／大型匯出交適當外部或配對 runtime；普通 HTTP request 不承擔任意長工作。

## 3. 已有程式、KEEP／MODIFY／NEW／GENERATED

### 3.1 現況不可被規劃文字蓋過

- `contracts/common/v1/identity.ts` 已有 person/service **reference**，但 reference schema 不是 operational service authority；`packages/resource-scopes/index.ts` 實際 member adapter 只處理 personal/community
- `contracts/execution/v1/state.ts` 是共同 decision contract；其 `RunSnapshot` 的 owner 限 person、scope 限 personal。現有 tenant 執行不能只加 `tenant_id` 後送進去
- `modules/opportunity-project-work/private-commands.ts`／`modules/autopilot-work/results.ts`、`runs.ts`、`prerequisites.ts`、model-step service 已有精確個人分支、CAS、政策和撤權檢查；不同閉合 slice 的存在不表示完整公會 Agent 已上線
- `contracts/execution/v2/model-step.ts` 目前限制 `inputBytes=16384, outputBytes=16384, outputTokens=4096, steps=1, calls=1`；usage 只有 `not_dispatched|unknown|known`，cost metadata 固定 `unknown`。下述 estimated/reserved/actual/cost ledger 是**待增量實作**，不能從 token 已知推論已核對金額
- current member metadata 的 `operational_authority:false` 必須保留語意；解析 DTO、active consent record、舊 receipt、runtime 自稱 online 都不是 bearer permit

### 3.2 精確改動圖

| 類別 | 精確檔案 | 責任 |
|---|---|---|
| KEEP／ALIGN | `docs/plans/autopilot-vnext.md` | 同一 Principal／Connection／Runtime／Grant／Work／Action／Result 模型；以明確增補標示 tenant 與原 personal 設計差異 |
| KEEP／MODIFY（SP-02 owner） | `contracts/common/v1/identity.ts`、`packages/resource-scopes/index.ts`、`packages/scoped-commands/index.ts` | additive tenant/service verified context；保留 personal/community deny defaults，不造 guild key |
| KEEP | `modules/agent-control/runtime-registration.ts`、`agent-connections.ts`、`bootstrap-sessions.ts`、`model-broker-authorizations.ts` | 既有配對／connection／proof／broker 信任鏈；不同新 scope 由其明確 extension 接入 |
| MODIFY | `modules/agent-execution/runs.ts`、`prerequisites.ts`、`model-step-service.ts`、`model-step-state.ts` | tenant context 以辨識清楚的 branch 使用既有 engine／Run／Grant／Attempt；保留原個人 schema 與限額 |
| KEEP／MODIFY | `modules/agent-execution/model-step-host.ts`、`model-step-runner.ts`、`model-step-invocation.ts`、`export-policy.ts` | opaque verified binding／current checks、外送最小化、重啟／unknown 接續；不接受 caller 自填 VerifiedContext |
| KEEP | `modules/agent-execution/member-model-settings.ts`、`provider-target.ts`、`openrouter-profile.ts` | 本人 provider/model/custody 選擇；不因開新 guild 改全域模型 |
| MODIFY | `modules/agent-execution/model-results.ts`、`modules/autopilot-work/results.ts`、`modules/assets/engine.ts` | tenant-safe Result profile、human/model provenance 與同一 Asset lifecycle |
| MODIFY | `packages/execution-state/index.ts`、`decode.ts`、`vectors.ts` | 與 canonical tenant extension 一致的純 decision kernel＋負例；不複製另一決策器 |
| NEW | `contracts/execution/v2/tenant-context.ts`、`contracts/execution/v2/usage.ts` | additively author tenant binding/grant/usage schema；不把 v1 personal DTO 偷改成通用 scope |
| NEW | `modules/agent-execution/tenant-context.ts`、`modules/agent-execution/usage.ts`、`modules/agent-execution/operating-policy.ts` | current authority resolver、唯一 usage accounting service、policy resolver；沒有第二 scheduler |
| NEW | `apps/platform-api/src/routes/tenant-execution.ts` | 本文 proposed tenant routes；既有 `/me` 個人入口保留相容 |
| MODIFY | `apps/portal-web/src/modules/PrivateWorkAI.tsx`、`ModelSettings.tsx`、`DeviceConnections.tsx` | 接入同 Work 的 AI entry、scope preview、usage unknown、人工接手；不得強迫人工使用者配對 |
| MODIFY | `modules/agent-execution/generate-model-step.ts`、`generate-member-execution.ts`、`packages/execution-state/generate.ts` | canonical schema 生成流程 extension，由共同 owner 檢查 version compatibility |
| GENERATED | `contracts/execution/v2/tenant-grant.schema.json`、`contracts/execution/v2/tenant-preflight.schema.json`、`contracts/execution/v2/usage-entry.schema.json`、`contracts/execution/v2/usage-summary.schema.json` | 相對於前述 v2 目錄的建議具名輸出；只由上述 generator 產生，consumer pin bundle digest |
| NEW（logical ID） | `tenant-execution-usage` migration | 尚無 SQL 檔名；fresh main／stacked PR／migration runner policy 核對後由整合 owner 配發，不能預占數字 |
| NEW | `tests/runtime/tenant-execution-usage.test.ts`、`tests/runtime/tenant-execution-revocation.test.ts`、`tests/e2e/guild-manual-ai-boundary.spec.ts` | proposed fixtures；與既有 execution/model-step/private-result suites 同時驗 |

所有表列修改均屬後續實作 PR，這個 spec PR 不改功能、keys、policy、schema、config 或部署。`repository-map.md` 是跨包整合圖，source owner 不因使用者從不同公會進入而改變。

## 4. 資料模型、權威與容量帳本

### 4.1 既有 entity 的 tenant extension

| 概念／現有責任 | 擴充資料／不變式 | authority 與留存 |
|---|---|---|
| Principal | person 仍是會員本人；service 是有獨立驗證身份的 runtime/operator，不可設 `user_id` 冒充 | identity owner；guild officer/title 不授權 |
| Connection／Runtime | `connection_id,runtime_id`＋verified environment/build/capability refs；與本人 principal 綁定 | agent-control；credential 原 custody，不存在 guild 私藏全員模型 key |
| Model connection／selection | exact provider_ref/model_ref、engine/processing location、credential/artifact custody、billing source；original person owner immutable | 原 model connection owner；tenant transfer 不移交個人 API key／CLI login |
| Work | same `work_items` 的 tenant_execution branch、tenant/instance/workspace refs、version | Work module；tenant owner 不是公會；人工內容獨立於 AI |
| Grant | existing Grant family 的 additive tenant profile：work_id/work_version、tenant_id、resource/module refs、capabilities、runtime/connection/model versions、context digest、expiry、budget policy revision | 授權者必須對每項資料／effect 有現行權限且模型來源是本人；delegation 是授權交集，不能由角色名稱擴大 |
| Run／Attempt／Action | same execution engine；每個 attempt pin grant、模型、binding、task/control epoch；action pin operation+request digest | execution module；機器 effect 先 durable ActionIntent，receipt 不能繞 current grant |
| Result | human 或 model_draft provenance 由可信 adapter 寫入、原 Work version、Asset refs、必要 lineage | Work/Result/Asset，內容歸 tenant；model completion 不建立 Claim／付款／XP |
| `execution_usage_entries` NEW | immutable UUID、tenant_id、person_principal_id、work_id/run_id/attempt_id/dispatch_id、metric、phase、quantity?、unit、cost?、price_ref?、evidence_ref?、recorded_at、revision | 同一 execution usage service；不放正文／key／cookie／provider raw response |
| `execution_usage_reservations` NEW | `(tenant_id,dispatch_id,metric)` unique、amount、held/released/settled/unknown exposure；同一 transaction 驗 budget＋hold | quota accounting；不知道結果不能當零或自動釋放 exposure |
| `tenant_operating_policies` NEW | revisioned capacities、lifecycle rules、retention refs、pricing ref、effective_at、source approval evidence | 可信操作政策 owner；普通 tenant member 不可提供允許型 policy function |

所有 references 使用共同 UUID `OpaqueId`；version/epoch 為正十進位字串（signed bigint 界限），計量 quantity 為非負整數十進位字串，money 使用 `{currency,amount_minor}` 的非負整數字串；未知值為 null＋reason，不能填零。parent [contracts.md](contracts.md) 的 `ModuleInstance` shape 原樣消費，不把 binding_id/runtime_id 或各種 epoch 互換。

### 4.2 用量的四種必要事實

1. **estimated：**尚未 dispatch 的成本／token 上下界估計，保存 price catalog revision、模型、估法與有效期限；不是實收、不是 quota 已扣
2. **reserved：**dispatch 前把該次最大允許資源量從可用 quota 扣成 hold；相同 dispatch 重送不再 hold。有效餘額＝limit−已結算 actual−尚未釋放 hold；不把估計和 hold 再加一次
3. **actual：**可信 adapter/provider evidence 報告的實耗；有 input/output tokens 不代表有貨幣費用。不同維度各自 actual/unknown，例如 tokens actual、provider_charge unknown
4. **unknown：**已 dispatch 而回覆／用量／費用證據遺失，或 provider 未提供金額；保留保守 exposure、可查核原因與最後查核時間；pending 不允許顯示「免費」「未使用」

Ledger append-only 記修正／release，不改舊 evidence。unique `(dispatch_id,metric,phase,evidence_ref)`（無 evidence 的估計／預留用固定 server event identity）；provider event ID 僅在該 provider-account pseudonym 下唯一，異內容同 ID 409 並告警。單一 dispatch 的實耗只結算一次；晚到更正以 adjustment 並引用原記錄，不能另一筆重收。platform invoice 的 charge identity 也必须唯一且可對帳；本規格不開帳單扣款功能。

人類存儲/API、provider tokens/charges、runtime CPU/bytes、備份／匯出、支援工時分別量測。私人內容不進 shared telemetry，跨 tenant 聚合只用無內容的計數；未觀察到價格就回 unknown。CLI 訂閱不是按 token 推算一筆實收，也不推定額外呼叫免費。

## 5. Proposed API／command／query／event

### 5.1 共同規則及核心 DTO

base `/api/v1/tenants/{tenant_id}`。member current auth＋CSRF＋tenant ACL；runtime 用 SP-09 validated service proof／audience／grant／instance binding，不接受 caller `actor`／role／policy。所有新 wire snake_case，unknown keys／重複 query key 拒絕。current personal camelCase interfaces 由型別明確 adapter 映射，不改原 wire。

mutation 必填 `Idempotency-Key` 8–128 `[A-Za-z0-9_-]`，更新必填 `If-Match:"{version}"`；428 missing、412 stale。受理回共同 `Operation={operation_id,state,version,resource_ref?,retry_after_seconds?,problem?}`，state 僅 `requested|running|succeeded|failed|needs_reconciliation|cancelled`；Run／Grant／usage 不使用此 enum 冒充其 domain state。所有 reads／receipt replay 重新驗目前權限；任何 response `private,no-store`，HEAD、history、Range、conditional request 也必須授權。

`TenantGrantDTO={grant_id,tenant_id,work_id,work_version,run_id,version,state,expires_at,connection_id,runtime_id,model_connection_id,selection,resource_refs,capabilities,context_sha256,policy_revision,budget_limits,binding_refs}`；state active/revoked/expired；`selection={provider_ref,model_ref,engine_location,processing_location,credential_custody,artifact_custody,billing_source}`，selection 是 metadata 不是密鑰。Resource ref 由 shared contract，必含精確 tenant/instance/resource 或具名集合範圍；本 profile 不接受 `*`。

`UsageSummary={tenant_id,period:{from,to},policy_revision,metrics:[{metric,unit,estimated,held,actual,unknown_count,unknown_exposure,limit,remaining}],costs:[{currency,estimated_minor,held_minor,actual_minor,unknown_count,price_ref?}],as_of}`；各 nullable amount 必須有 unknown reason；幣別分列不做無來源換算，remaining 只對可證的 quota 維度計算。

`UsageEntry={entry_id,tenant_id,work_id,run_id,attempt_id,dispatch_id,metric,phase,quantity,unit,cost,price_ref,evidence_ref,unknown_reason,recorded_at,revision}`；metric 為 `input_tokens|output_tokens|provider_calls|runtime_cpu_ms|retained_bytes|export_bytes|provider_charge`，phase 為 `estimated|reserved|actual|unknown|released|adjustment`。quantity 為非負整數字串或 null，cost 為 `{currency,amount_minor}` 或 null；unknown 必填具名原因，actual 必須有可信 evidence_ref。adjustment 另帶 `adjusts_entry_id` 與 `direction:increase|decrease`，不使用負數或改寫原列。tenant 篩選與 current ACL 先於分頁／彙總；非本人無權 provider 資料採安全投影，不能靠一次 generic usage:read 取得私有帳號內容。

### 5.2 API surface

| Proposed route | 完整輸入／輸出 | authorization／特定錯誤 |
|---|---|---|
| `GET /works/{work_id}/ai/preflight` | query `model_connection_id?,runtime_id?`；回 `{work_id,work_version,ready,blockers:[{code,resource_ref?}],available_selections:[metadata],required_scopes,policy_revision,estimated_usage,manual_work_available:true}` | `work:read`＋`ai:inspect`；只回本人 model connections；不發 provider 請求、不建 Grant、不扣 quota；ready 是瞬時提示非 permit |
| `POST /works/{work_id}/ai/context-previews` | `{expected_work_version,model_connection_id,runtime_id,resource_refs:[exact refs]}`；≤50 refs；回 `{preview_id,version,context_sha256,input_byte_size,source_refs,destination,expires_at,omitted_refs:[{ref,reason}],policy_revision}` | `ai:prepare`＋每 ref read/export 權；preview 保存 metadata 與 digest，不複製完整 CRM；正文預覽透過既有受控內容讀取，禁止先外送才求同意 |
| `POST /works/{work_id}/runs` | `{expected_work_version}`；回 Operation→`{run_id,work_id,tenant_id,run_state:created,version,task_epoch,control_epoch}` | `work:write`；建立 record 不授權 dispatch、不需模型 key；同一 key 只一 Run |
| `POST /runs/{run_id}/grants` | `{work_version,context_preview_id,context_preview_version,context_sha256,connection_id,connection_version,runtime_id,runtime_version,model_connection_id,model_version,capabilities:[allowed capability],resource_refs:[exact refs],binding_refs:[{instance_id,binding_id,authority_epoch}],budget_limits:[{metric,unit,max_quantity}],spend_limit?:{currency,amount_minor},expires_at,consent:true}`＋If-Match Run version | 回 Operation→TenantGrantDTO；`ai:grant` 且本人 model owner／每 effect delegation 權；expiry 不晚於全部 backing expiry、最長由 policy；409 context_changed／binding_stale、403 scope_not_delegable |
| `GET /grants/{grant_id}` | 無 body/query；TenantGrantDTO | current grant visibility；不能據此 DTO 執行；隱藏已非 tenant member 的資料 |
| `POST /grants/{grant_id}/revoke` | `{reason:user_request\|membership_removed\|security\|binding_changed}`＋If-Match；Operation→revoked Grant | 本人 grant owner／有權 tenant security actor；普通 caller 只能 user_request；current authority 不可因舊 consent replay 免驗 |
| `POST /runs/{run_id}/attempts` | `{grant_id,grant_version,context_preview_id}`＋If-Match；Operation→`{attempt_id,run_id,run_state,version,blockers,dispatch_ready:false\|true}` | runtime／member 的 `ai:execute` 只是受理；server preflight 後 atomic quota hold，request 不收 key／provider endpoint／caller verification |
| `POST /runs/{run_id}/control` | `{action:pause\|stop\|resume,reason?:string<=300}`＋If-Match；Operation→`{run_id,run_state,version,task_epoch,control_epoch}` | human `ai:control`；resume 重驗 all grants/bindings/policy，unknown dispatch 時 409 reconciliation_required；stop 不是保證 provider 沒花費 |
| `GET /runs/{run_id}` | 無 body/query；回 `{run_id,work_id,tenant_id,run_state,version,current_attempt_id?,task_epoch,control_epoch,waiting_reason?,result_ref?,usage_summary,actions:[{action_id,operation_ref,state}]}`，actions 最多 50 另 cursor | `work:read`＋`ai:inspect`；不回 traces secrets 或別人 model account 資料 |
| `POST /runs/{run_id}/reconcile` | `{dispatch_id,evidence_ref?}`＋If-Match；Operation | `ai:reconcile`；ref 必須既有可信 evidence 或受控 provider-status check；caller 不能直接報 `charged:0/success:true`；缺權／離線維持 needs_reconciliation |
| `GET /usage` | `from,to` UTC，窗口≤31 天、`work_id?`,`cursor?`,`limit`1–100 default20 | `{summary:UsageSummary,items:[sanitized UsageEntry],next_cursor:string\|null,source_version:Version}`；`usage:read` 僅允 tenant 可見 aggregate＋本人 detail，owner 可看租戶費用但不自動看 provider 個人帳單 |
| `GET /operating-policy` | 無 body/query；回 `{revision,effective_at,capacity,retention_policy_refs,pricing_ref?,renewal_options,export_access_rules,production_enabled}` | tenant member；公開定價／retention 說明可另從經核准公開頁讀，不能回 private billing/credentials |

context-preview 是 server 組出確定 bytes 的 Work/version＋授權 resource 快照；`context_sha256` 只證明確認哪份內容，仍須 current source ACL／freshness。第一個 profile 只允精確 title/objective，最大 16 KiB；CRM／多附件 context 屬後續受控 capability，未通過 policy 與測試就 409 `context_profile_unavailable`，不因 refs 格式能表達便偷偷傳送。

真正 model dispatch、ActionIntent、result publication 仍沿現有 operational host／Autopilot API，不另提供「公會 run 任意 tool」入口。`inventory.reserve`、CRM write、publish 等每一步都要與既有 domain rules＋grant 的交集比對；source prompt、Skill、MCP output 不能授予 capability。第一個 AI profile 只產 draft，不能隱藏啟用商務 side effects。

### 5.3 Usage internal port 及事件

唯一 `UsagePort`（server-only）完整輸入：

- `estimate({tenant_id,work_id,model_selection_ref,context_sha256,input_bytes,max_output_tokens,price_ref})` → `{estimate_id,metrics,costs,expires_at,version}`；無認證 provider／價格就保留 unknown，無外送
- `reserve({dispatch_id,tenant_id,person_principal_id,run_id,attempt_id,grant_id,grant_version,estimate_id,policy_revision,limits})` → `{reservation_id,state:held,version,held_metrics}`；同 dispatch 相同內容重播；異內容 409；在當前 authority transaction 鎖 budget row，超量 429
- `record({dispatch_id,evidence_ref,observed_metrics,observed_costs?,outcome:known|unknown})` → `{usage_entry_refs,reservation_state,version}`；只有 opaque verified host evidence，不能公眾 HTTP 提交；重複 evidence no-op，異內容 409
- `release_undispatched({dispatch_id,reason,evidence_ref})` → `{reservation_id,state:released,version}`；必須可證 Action 未 dispatch；未知不准用此方法釋放
- `reconcile({dispatch_id,evidence_ref})` → `{usage_entry_refs,reservation_state,remaining_unknown_metrics,version}`；可信新證據才把 exposure 改 actual／release，保留歷史

execution 控制面事件透過既有 scoped/platform outbox `execution.usage_updated.v1`、`execution.control_changed.v1`、`execution.grant_revoked.v1`，data 允 `{run_id,dispatch_id?,grant_id?,version,state,metric_names,unknown_count}`；不放 prompt／Result 正文／provider account email。這三種是 execution 控制面 facts，不使用 SP-05 module EventEnvelope，不捏造 source_instance_id；各自 envelope/schema 由既有 execution 契約 owner 明訂。事件只能通知已授權 consumer 重新讀，不構成執行 permit。usage、quota hold、action dispatch intent 同本地交易提交；外部 provider 網路 I/O 在 commit 之後。

共同錯誤沿 contracts.md：400 invalid_input，401 authentication_required/session_expired，403 capability_denied/policy_unconfigured，404 not_found，409 idempotency_conflict/authority_changed；本域另有 409 model_unavailable/runtime_offline/context_changed/binding_stale/grant_revoked/reconciliation_required。其餘 412 version_conflict，413 payload_too_large，422 validation_failed/contract_incompatible，428 version_required，429 quota_exceeded，503 dependency_unavailable。quota 回安全 limits／retry_after_seconds，不顯示另一 tenant 消耗；401/403 不透過替換系統 key「修復」。

## 6. 狀態機、retry、撤權與生命週期

### 6.1 沿用共同 execution engine

`contracts/execution/v1/state.ts` 的 canonical Run states 包含 created/preflighting/ready/running/waiting_human/waiting_engine/paused/blocked/reconciling/cancelling/cancelled/completed/failed/manual_unknown。本文不建立另一個 guild state machine；tenant extension 必須使用相同 decision kernel 並補 vectors。現有單步 model-step 的 reserved/dispatched/awaiting_result/outcome_unknown/cancelled/succeeded 是 **step 狀態**；legacy DB 閉合 slice 的 succeeded 與 canonical completed 的轉換必須由 explicit adapter 驗證完成條件，不能字串改名宣稱整個 Run 完成。

| 事件 | 必要動作／狀態 | 不允許的捷徑 |
|---|---|---|
| 缺模型／policy／quota／runtime | preflight → blocked/waiting_engine；人工 Work 可繼續 | 不選平台 key，不自動變更 custody 或較貴模型 |
| 同 key retry／重啟 | 讀既有 Run/Attempt/dispatch identity，重驗 current ACL，接續原 operation | 不另建 attempt 再計費，不從 process 記憶空白推斷未 dispatch |
| dispatch 前的已知失敗 | 釋放 hold，failed 或 blocked，保留失敗證據 | 不把已離開 process 的請求誤判為尚未送出 |
| provider timeout／ACK 遺失 | step outcome_unknown，Run reconciling；保留 usage unknown/exposure | 不盲目重送、不顯示零成本 |
| provider 晚回 | 核对 dispatch/evidence/authority epoch 與 target version；可補 usage | 被撤權後不能 attach／發布；不得丟掉已發生的費用證據 |
| 人類 pause／接手 | 原子增 control/task fence；拒新 dispatch；in-flight 先排空／核對，重新觀察人工改動 | 不宣稱取消能追回 provider 已花費用；不搬 cookie／CLI session |
| stop | 未 dispatch → cancelled；已 dispatch → cancelling/reconciling 直到可證或 manual_unknown | 不刪 Run/Action 假裝從未執行 |
| Grant/Connection/Model 撤銷 | fence 後拒新 effect 與 execution receipt replay；metadata 只供授權稽核 | receipt/digest 不是繼續執行權 |
| 模組 binding 遷移 | SP-08 切點凍結相關 Action；未結結果搬遷／核對，新 endpoint 重驗 audience/grant | 舊 endpoint 的 tool grant 不能無條件套新位置 |
| contract 不相容 | HTTP 422，只阻擋受影響 capability，提示 supported ref | 不把整個 tenant 關閉，不降級直接 SQL；人工／export 按獨立權限使用 |

**Provider 重試：**同 dispatch 的本地重送不可重複計量／收費；provider 若不保證 idempotency，不自動再送未知 call。若需新的推論 attempt，先辨明未結 exposure，顯示這是另一個可能收費的 call，且現有預算／授權涵蓋才執行；超界需新同意。無 provider 核對能力時保留 manual_unknown，透過 policy 的人工對帳程序處理，不假造「已退款」。

### 6.2 離會、tenant 與方案生命週期

| 情境 | 確定的即時效果 | 資料／續用／AI |
|---|---|---|
| 換主力／加入其他公會 | 只改推薦／入口 context | 不改 tenant ACL、owner、Work/Result 或 model connection |
| 離會／full 降級 | 不再取得該公會的新啟用資格；既有 instance 依公開 plan policy 處理 | 不刪資料、不移給會長；新增 Grant 時重驗需要的資格，與 tenant 權限分開 |
| 移除 tenant membership | 拒該 tenant 讀寫／export，撤銷由其在該 tenant 授予的 active Grant，fence 受影響 Run | 不移除其他 tenant Grant、不拿走其 person 模型；資料仍歸 tenant |
| 移交 tenant owner | SP-02 受讓確認、最後 owner 保護與 version pin | 不轉移原 owner 私人 BYOK/CLI credential；未結 Run 停止或取得新本人授權，不能繼承 model connection |
| hosted 容量到限／方案到期 | 按公開 policy 拒新增資源／AI dispatch，保留已受理 effect 的核對 | grace/read-only 時間待 policy；按合法權限提供匯出與續用，不扣資料當欠費籌碼 |
| 安全停權 | 可立即阻擋風險 API/dispatch、撤 key/Grant 並稽核 | 保存歸屬和必要恢復資料；匯出限制須有明確安全政策與恢復程序，不假稱所有停權都可下載 |
| 完全自架／終止平台連線 | 撤平台 integration Grant/token，停止平台 event/API | 不遠端沒收合法本地程式或資料；本地 AI 用本地授權與模型，重接須新 pairing |

離會不默認清除 model connection，也不將公會 membership 永遠嵌入私有資料 owner。精確 grace 期／免費額度／plan 價格由具名營運政策決定；正式 activation gate 必須有 revisioned policy 與 UI 公告。

## 7. UI、失敗、可見性與人工接手

- Work 主畫面的「保存」「筆記」「上傳成果」不依 AI 設定；AI 是可選入口。沒有連線只顯示原因與本人模型設定，不用全屏鎖住人工功能
- 一次授權摘要顯示 Work／tenant、具名資源、tool effect、provider/model、CLI/API、processing location、credential/artifact custody、billing source、數量／費用上限、到期時間；平台系統與使用者模型清楚分開
- 不要求每一步重複確認；只有 scope、endpoint、模型、內容 digest、費用上限等改變使原授權不涵蓋時才需新同意。摘要不透露 API key 或 provider account 秘密
- 同時呈現 estimate、hold、actual、unknown。例如「已預留 1 次呼叫；供應商結果尚未確認，可能已產生費用」。貨幣未知時仍可顯示已核實 tokens，不能把 unknown 畫成零
- 接手面板有 pause/stop/control、排空中的 Action 和待核對狀態；人已改 Work 時，舊模型稿只能另存可審查結果，不覆蓋人稿
- tenant 切換清除前 tenant query/cache/preview；晚到 response 按 tenant/request generation 丟棄，不跨 tenant 保存 prompt 草稿。360px 手機、鍵盤、focus-visible、error aria-describedby、status aria-live、dialog Esc／焦點返回都驗收
- 成果只標示真實狀態，例如「草稿已保存」，不寫已獲收入／已驗收／已付款。模式、source build、contract version 可查；未啟用能力明示原因

## 8. 匯出、遷移、清理、恢復與相容

- **Expand/backfill/switch/contract：**既有 personal Work、model connection、Grant 不自動搬到 tenant；須明確 owner mapping 與授權。新 tenant profile 使用不同 discriminator/composite FK/policy rows；舊 `/me` API/schema 在相容期保留，缺 tenant 語意的寫入不靜默成功
- **Export：**tenant Work/Result/Asset、必要 Run/Action/status、usage facts/unknown markers 與去重資料可按 export scope 帶走；不含平台 service key、個人 provider credential、CLI OAuth、cookie、session、其他 tenant 資料。跨人模型 metadata 只留業務需要的假名及 provider/model
- **Import/migration：**usage ledger/receipt 是歷史與去重資料，不是 live Grant；model connection/runtime/endpoint/audience 重新配對驗證。保留 stable ID、来源、unknown 狀態，不能把 outcome_unknown 匯成 succeeded
- **暫存／retention：**context preview、trace、telemetry 採最少欄位；私人內容不進公會知識庫。期限由 SP-06 的 dataset policy 管理，credential 沿原 custody/revocation lifecycle；archive 不是 erasure
- **Cleanup：**materialized context、模型 output 暫存、private search cache、通知片段、export staging、failed Asset orphan 列入資料責任。Result 與 provider 留存是不同系統，不能承諾平台刪除等於 provider 刪除
- **Recovery：**恢復 backup 先套 grant/token revocation floor、binding authority epoch、control/task/recovery generation floor、tombstone、已結算 usage 去重，再 dispatch。provider 可能已執行而 backup 較舊時進 reconciling，不能因沒有 receipt 而自動重跑
- **未知保留：**terminal manual_unknown 可停止自動 dispatch，仍不等於費用核對完成；提供查核入口、證據、政策期限。刪私有內容與最低 usage metadata 可分離，不為對帳保留 prompt 正文

## 9. 威脅、最小權限、成本與公開政策

### 9.1 威脅與反例

| 威脅 | 必要控制 |
|---|---|
| 提示／MCP 輸出要求擴權、讀秘密 | 不可信內容不參與授權；server 依實際 operation/target 分類，拒不在 Grant 的 effect |
| active Grant／scope DTO 被當 permit | 驗 current backing rows、runtime proof、exact model binding；偽造 DTO 在 dispatch 前拒絕 |
| service 冒充 member／跨 tenant | separate principal adapter、tenant/module/resource composite checks、audience/epoch；錯 tenant receipt 不可重播 |
| 隱藏平台 key fallback | user AI host 只接受本人 CLI/BYOK 对應的 billing label；system key 不在 fallback；故障注入證明 platform dispatch 為零 |
| 撤銷／dispatch 競態 | 最後 blocking query 後重验時間、Grant/policy/fences；commit intent 再 I/O；晚到 evidence 只能對帳，不能復權 |
| 任意 provider endpoint／秘密洩漏 | 沿 `provider-target.ts` 與 SP-09 allowlist/SSRF；拒 caller 任意 URL；key 不進 prompt/receipt/log/frontend/export |
| 重複 quota／欠帳被清除 | dispatch unique、hold 與 actual 互抵、unknown exposure 不清零、evidence 去重；cancel/delete 不抹除 provider 消耗 |
| 離會沒收 tenant／owner 取得個人模型 | membership/ownership 分離，key 不隨 tenant 轉移；會長或 UI 管理身份不增加資料讀權 |
| 長工作拖垮其他 tenant | bounded queue、quota/lease/timeout、重工作不在一般 HTTP；AI 與 human API 預算分開 |

### 9.2 明確 policy 決策與非正式建議 profile

以下是**建議測試預設，非收費承諾、production SLA、provider 限制或已批准 retention**。只在隔離 synthetic 環境以固定 policy revision 使用。實際 Cloudflare/provider 限制於實作／deployment gate 再查當時官方資料驗證，不由本表推定 Workers 可跑任意 CLI。

| 維度 | 建議 non-production profile | 正式 policy 必決項／啟用前 owner |
|---|---|---|
| 人工功能 | 100 Work/tenant；文字 Result ≤256 KiB，retained 10 MiB；無 AI 仍可用 | SP-04/06 容量、MIME、留存；營運 owner 公開 plan revision |
| AI one-step | 每 dispatch 1 call/1 step；context/output 各 ≤16 KiB，output ≤4096 tokens；每 Run 最多 16 attempts，unknown 不自動重試 | 與既有 model-step 上限對齊；擴大前驗安全／成本／runtime |
| concurrency | 每 tenant/person 各 2 個 active AI attempts，取較低可用值；human CRUD 獨立限流 | 公平調度、租戶隔離、實際成本量測；SP-11 維護者 |
| Grant/context | context preview 10 分鐘；Grant 最多 15 分鐘且不超過 backing expiry | 正式可用性與風險，維持即時 revoke；過期 resume 須重新授權 |
| timeout | synthetic provider 30 秒後 unknown；status backoff 1/2/4/8/30 秒封頂，不重送 effect | provider idempotency/status 能力、觀察窗口與人工查核程序 |
| quota | 每日 20 calls、81920 output tokens；每 Run 4096 output tokens；price fixture 明標 synthetic | hosted quota、reset 時區／週期、unknown exposure、超額／續用／自架 |
| retention | fixture context cache ≤10 分鐘、合成 trace ≤24 小時；test DB 用 fixture teardown，不代表正式 GC | Work/Result/usage/audit/backup/export 各自期限、刪除例外及公告；SP-06＋營運 owner |
| pricing | production disabled；缺 price_ref 費用未知；不發票／不扣款 | 方案、貨幣、稅、費率來源及有效期；provider 帳單與平台費分開，不猜固定成本／毛利 |
| 離會／到期 | fixture 拒新 provision／AI dispatch，read/export 沿 ACL | 公開 grace/read-only/renewal/security suspension；未定期限不自動刪資料 |

公開 policy 必須包括 hosted 容量、AI 額度、費用來源／計量／未知結果、grace/read-only/renewal、export/recovery、儲存與 backup 期限、外部 provider 帳單責任。未定項是**具名 production activation 決策阻擋**，不是重問產品方向；fixture、人工 UI、規格可並行。實際付款、承諾、法律條款沿原確認／業務機制；guild 職稱、PR 數、模型呼叫數、SIM 交易不產生永久分潤。

## 10. 可重現 fixtures、驗收、證據與發布

所有本節案例 **planned/not_run**；已有 source tests 可復用，但本輪沒有執行模型、正式 key、provider 付款、schema 改動或產品驗收。

### 10.1 測試環境

顯式 disposable PostgreSQL／`fp_*` schema、真實受限 runtime role；至少 2 tenant、2 person、1 service、1 guild officer。模型／provider fake 不用真 key；platform/runtime 分開 HTTP process，第三個 fault proxy 注入 drop ACK、late evidence、timeouts。A owner 同時是 B viewer；synthetic connections 分本人 CLI、本人 BYOK、platform-system。錯 audience、已撤 Connection、過期 Grant、Work 版本變更、假 usage、同 event 異 digest 等 fixture 固定 seed/digest。真 provider／Cloudflare 實跑另需明示授權及費用上限，synthetic 不能冒充該證據。

### 10.2 Planned acceptance

| T-ID | 操作與故障注入 | 輸出／evidence |
|---|---|---|
| T-051 | 無模型/key，逐 guild 人工 create/update/note/Asset Result；AI preflight 拒絕 | 人工閉環成功，provider dispatch=0，沒有強迫連線／AI Grant |
| T-051／T-053 | 本人模型撤銷、provider offline、quota 滿、缺 CLI，只有系統模型可用 | AI 拒絕，system dispatch=0；共同 engine/SDK call trace，無另一授權器 |
| T-052 | 同 dispatch 100 併發 retry、drop ACK 後 restart、provider 晚回、dispatch 前後 cancel、重送 usage event | 一個 hold、一次已核對 actual；unknown 非零，異 digest 拒絕；ledger 可重算平衡 |
| T-052 | tokens 已知但 charge 未知、CLI 訂閱、不同貨幣、費率過期 | 分維度／幣別顯示；不把 unknown 當零，不推算實收或隱藏額外費用 |
| T-049／T-051 | 在 lock wait、dispatch/result CAS 前撤 Grant／使 session 到期；偽 permit／跨 tenant ref | 每個 effect 前重驗；撤權後不執行或 attach；晚到費用可對帳但不復活 Grant |
| T-016 | 換主力、離會、移除 A membership、owner 移交、到期／安全停權 | 資料不刪／不歸會長；只撤相關 A Grant，不轉個人 credential |
| T-044 | A inventory binding 改 epoch，runtime 持舊 Grant；unknown Action/usage 外移及 restore | 舊 Grant/endpoint 拒絕，pending outcome 可核對、不重扣、不重跑 provider |
| T-050 | 斷平台連線後純本地 Work；嘗試平台 effect／重接舊 token | 本地資料可用、平台 effect pending/拒絕；重新 pairing 才接回 |
| T-053／T-057 | candidate 改 validator／假 green check／绕 SDK，source 有 UI 但 feature 關閉 | trusted gate 拒繞過；source/test/deploy/release enablement 分別記錄 |
| T-055／T-058 | 360px／keyboard、tenant 晚回、A 的 10 倍 quota 壓力、runtime 故障 | B 人工/API 可用；A 內容不進 B；unknown/control 可操作；容量配置可重現 |
| T-059 | model Result 完成、假付款/SIM、guild 職務或 PR 數變更 | 無自動薪資／分潤／實收／驗收；Benefit/commerce 的原 domain 證據仍必要 |

### 10.3 後續實作驗證入口與 gate

先跑 `tests/runtime/execution-state.test.ts`、`tests/runtime/execution-state-adversarial.test.ts`、`tests/runtime/execution-runs-grants.test.ts`、`tests/runtime/model-step-service.test.ts`、`tests/runtime/model-step-revocation-races.test.ts`、`tests/runtime/private-results.test.ts`，再跑新增 tenant suites。contract generator 用 `npm run check:execution-contracts`、`npm run check:member-execution`、`npm run check:model-step-contracts`；改 UI 先 `npm run build` 再 E2E，最後 typecheck、相應 aggregate tests、SP-12 trusted gate。這些是計畫命令，**不是本 spec PR 已執行結果**。

每個 evidence 記 head/source SHA、contract bundle digest、runtime/build、policy/price revision、fixture seed、DB role、command／UTC、pass/fail/not_run、dispatch 與 usage ledger 對帳。log 只有合成資料或已清除敏感內容的 metadata。production activation 前完成 tenant/service authority、manual-only workflow、model custody/auth、revoke/unknown/restore、policy/retention/pricing、provider/runtime limits 驗證；缺項保持該 capability 關閉，不影響其他已驗的人工 profile 或規格合併。不能以畫面存在宣稱已上線。
