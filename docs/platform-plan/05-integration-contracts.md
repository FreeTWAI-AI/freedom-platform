# 外部接點與契約規格

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

1A 契約凍結時，以當時官方文件／sandbox fixture 固定 Provider-specific headers、簽章與限制；支援聲明以該 evidence 為準。

## 1. 接點設計目標

Freedom Platform 不複製 Discord、LINE、GitHub、Agent CLI、賣家金流、社群渠道或媒體供應商；它以一致契約連接它們，保存中央身份、Profession/Work、狀態、交易、簽名與成果事實。Discord 是討論／讀書會，LINE 是即時聊天／提醒，GitHub 是 code review/release 真相；平台是接點、database、非 code PR、狀態機與帳本核心。

所有 connector 都遵守同一條可靠性模型：

```text
Domain transaction
  → write aggregate + outbox in one DB transaction
  → worker claims outbox
  → provider call with stable idempotency/deduplication key
  → save delivery/provider reference
  → normalized fact event
  → projections and next action

Provider webhook
  → capture raw body
  → verify signature/timestamp
  → inbox dedupe
  → acknowledge quickly
  → async normalize and apply command
  → save fact + outbox in one transaction
  → reconciliation catches omissions
```

系統承諾 at-least-once delivery 與冪等 business effect，不宣稱網路上存在 exactly-once delivery。

## 2. 契約版本與 artifact hierarchy

1A 契約凍結後，正式契約的唯一authoring source位於`freedom-platform/contracts/`，並以immutable `ContractBundle` release發布；CI再從該exact release生成`@freedom/contracts`與各語言client。現在的`docs/platform-plan/contracts/`只是在正式目錄尚未materialize前的planning scaffolds，不能被production channel或runtime當成另一套契約。初次正式化必須在同一PR把1A 已凍結的scaffold內容移植／補齊到root contracts、發布第一個ContractBundle，並讓後續PlanBundle只嵌入該release的byte-identical derived snapshot與source release digest。`packages/`只保存SDK／runtime consumers，不維護第二份可手改契約。所有第一方repo、Store forks、Skill repos與Agent adapters pin相容release，不假設repo數量固定：

| Artifact | 描述 | 相容性規則 |
| --- | --- | --- |
| OpenAPI 3.1 | 同步 commands/queries/webhook ingress | additive 可在同 major；移除／改語意升 major |
| JSON Schema | Domain event data 與設定檔 | event `type` 尾端含 major |
| AsyncAPI catalog | producer/consumer、topic、retry 語意 | 新 event additive；舊 consumer 不猜新 major |
| TypeScript SDK | request/response/types/signature helper | 由 schema 生成，禁止手工漂移 |
| Provider fixtures | webhook、錯誤、亂序、重送範例 | connector CI 必跑 |
| Config schemas | Discord map、LINE templates、entitlements、channels | 每次 publish immutable version/hash |
| Agent tool contract | WorkContextBundle、WorkItem、ExecutionGrant、ActionIntent、Signature、DraftArtifact | capability discovery；非code platform-native PR用immutable DraftArtifact revisions；`ChangeProposal`只作UI別名，A-level與exact digest語意不可由client放寬 |

版本識別要分開：

- API contract version：介面結構。
- Domain event schema version：事實 payload。
- Database migration：儲存實作。
- Ruleset/config version：社群規則。
- Provider adapter version：第三方轉換實作。

它們不可共用一個模糊的 `version=2`。

## 3. 同步 API 通則

### 3.1 URL、身份與租戶

- Base path：`/api/v1`；公開店面 BFF 使用 `/storefront/v1`。
- resource path 用 plural nouns；動作使用 `POST /resource/{id}:verb`。
- `user_id`、`community_id`、`organization_id` 從 authentication/authorization context 推導；不信任 client 自稱 owner。本文的「Workspace」只指交付／repo 工作空間，不作資料 tenant 名稱。
- ID 使用 opaque UUIDv7/ULID。外部 display name、email、handle、channel name、repo path 和 URL 永不當主鍵。
- 外部身份以 `(provider, provider_tenant_id, provider_subject_id)` 唯一，與 `identity.external_identities` 同名；非身份的 provider resource／delivery 仍使用 `ExternalRef.external_id` 或具體的 `provider_external_id`，不得把兩者混成會員 subject。

各 surface 的認證不能混用：

| Surface／operation | Credential | CSRF／scope 規則 |
| --- | --- | --- |
| Portal browser | `Secure; HttpOnly; SameSite=Lax/Strict` platform session cookie | 所有 state-changing request 驗 CSRF token＋Origin；cookie 不交給外部 app |
| Pre-run guest session | server-set HttpOnly guest cookie＋CSRF，無外部身份 | 只可建 guest-capable intent；不能操作 User/Entitlement，不使用 IP/fingerprint 當身份 |
| Guest AssessmentRun | 高熵短效 guest bearer，僅限一個 `run_id` | 不能操作 User/Entitlement；claim 另需一次性 claim secret＋已登入 session |
| Guest checkout/order view | 短效 signed order-intent／magic-link token | 綁 store/order/purpose/nonce；不可讀其他買家或改金額 |
| Storefront browser | public store client identifier＋短效 signed checkout token | client identifier 不是 auth；privileged request 必須經店面 backend 或 purpose token |
| First-party server/worker | OAuth2 client credential／mTLS-capable service token | audience＋精確 scope＋community；不可模擬任意 `user_id` |
| User Agent CLI／MCP client | device/browser approval建立AgentConnection；connection token只有`agent.bootstrap.read`可讀本人最小Status／Feed，再依active grant換execution token | execution token綁audience、principal、Connection、grant、A0–A3 ceiling、acting ProfessionMembership與scope；A1–A3必須有grant，可提出A4 request但兩層token都不含簽名權，不接受client自稱Master |
| Provider webhook | provider signature over raw body＋timestamp/delivery ID | 不接受 Bearer/User cookie；先驗簽、再去重、再 normalize |
| Guild Lounge companion | 一次性 exchange code 換 activity-scoped session | 只允許該 activity/actor 的操作；host/display credentials 分 scope |

Guest bootstrap／claim 流程：browser 先以同源 `POST /auth/guest-sessions` 取得 server-set、短效、可輪替的 guest session cookie與 CSRF token，再建立 run。Create idempotency scope 是 `guest_session_id + operation + Idempotency-Key`；key 不是 credential，另一 guest session 使用相同 key不會取得原 secrets，也不使用 IP/fingerprint 猜同一人。之後 client 持 run-scoped bearer 保存／提交；登入後以 user session＋一次性 `claim_secret` 呼叫 `POST /assessment-runs/{id}:claim`。server 驗 hash、期限、尚未被認領後原子綁定並輪替／註銷 guest token；request 不接受 `claimed_by_user_id`。Legacy 匿名列若有產生當時的可驗證身份證據，標 `legacy_resolution_required` 並由人工留 audit 後連結；沒有者是 terminal `legacy_unclaimable`，不可用 email/name 補猜。

### 3.2 Request／response

Service／worker request 範例：

```http
Authorization: Bearer <scoped-token>
Content-Type: application/json
Idempotency-Key: <client-stable-key>
If-Match: "resource-version"
X-Request-Id: <optional-client-id>
```

Portal browser 不送上述 `Authorization`，由 HttpOnly session cookie 認證；所有 state-changing request 另送 `X-CSRF-Token` 並通過 Origin 檢查。Guest endpoint 用相應 purpose bearer；provider webhook 用 raw-body signature。`Content-Type`、`Idempotency-Key`、`If-Match` 與 `X-Request-Id` 的語意跨 surface 一致，但只在相應 operation 必填。

成功 response：

```json
{
  "data": {
    "id": "ord_01...",
    "version": 4
  },
  "meta": {
    "request_id": "req_01...",
    "contract_version": "1.0.0"
  }
}
```

列表使用 opaque cursor：

```json
{
  "data": [],
  "meta": {
    "next_cursor": "opaque...",
    "has_more": false
  }
}
```

### 3.3 Idempotency 與 concurrency

- 所有 create、state-changing command、付款 session、通知、publication、render 與 settlement 支援 `Idempotency-Key`。
- 所有 Agent／connector 的 external effect 先建 canonical `ActionIntent`；key scope包含 principal、agent client、operation、target、request hash與 grant。Agent重啟、CLI更換或TaskLease交接仍沿用同一 intent/provider operation key。
- key scope 至少包含 actor/client、operation 和 target aggregate；保存 request hash、response status/body ref 與期限。
- 同 key＋同 body 回原 response；同 key＋不同 body 回 `409 idempotency_key_reused`。
- 含一次性 guest access／claim secret 的 create response：secret 只生成一次；idempotency store 在最短必要 window 以加密 response blob 重播相同 `201`，並回 `Cache-Control: no-store`。TTL 後不能由 hash 還原，client 必須另建 run；不得因 network retry 產生同 run 的第二個 secret。
- 可修改 aggregate 回傳 `ETag`；stale `If-Match` 回 `412 version_conflict` 和 current version/link。
- 從 LINE／Discord postback 進來的 delegated command 不能略過 concurrency：一次性 action token 必須綁 target aggregate ID、允許 action 與 `expected_version`；純 system command 則在 signed body 帶 `expected_version`。舊按鈕遇到新版 aggregate 一樣回 conflict，不可覆寫較新的進度。
- DB unique constraints 是最後防線，不能只靠「先查有沒有」。

### 3.3.1 人類簽名與 A0–A4 authorization

- A0 read/explain、A1 draft/test不產生正式副作用；A2 bounded reversible、A3 bounded public必須引用 active `ExecutionGrant`的principal、agent、acting role、resource/action、cap、validity與revocation version。
- A4（price/split、Supplier acceptance、建立／修改SettlementMandate、超scope payout/refund、official QC、contract、代表本人對外且有精確承諾後果的named application、任何 official／production immutable release）每個決策送`SignatureRef`，server重新解析signed artifact並驗`artifact_type/id/revision/digest + signer + authority + meaning`。自助加入Guild、學習、裝備、一般submission、低風險WorkItem與Master welcome明文排除。符合已簽Mandate條件的per-order transfer引用該signature自動執行；mutable URL、聊天「OK」或一般OAuth consent不足。純內部／non-production snapshot可用A1／A2，但不得使用`v*` tag、public GitHub Release、production／Pages發佈或official標識。
- Agent只能提出 `SignatureRequest`與deep link；signature actor必須是human user。Organization signature另須可查的代表 authority。
- 同一自然人即使換GitHub帳號、Profession、Agent或session，仍是一個independence principal；需要獨立review時server按verified human去重。

### 3.4 Error contract

使用 RFC 9457 Problem Details：

```json
{
  "type": "https://contracts.freedom.example/problems/version-conflict",
  "title": "資料已被更新",
  "status": 412,
  "code": "version_conflict",
  "detail": "請重新載入最新版本後再送出。",
  "instance": "/api/v1/offers/ofr_01...",
  "request_id": "req_01...",
  "current_version": 8,
  "actions": [
    {"label": "重新載入", "href": "/offers/ofr_01..."}
  ]
}
```

共通 error codes：

| HTTP | Code | 語意／使用者下一步 |
| --- | --- | --- |
| 400 | `validation_failed` | 欄位級 errors＋修法 |
| 401 | `authentication_required` | 重新登入，不改會員狀態 |
| 403 | `capability_required` | 缺哪個 scoped capability＋如何取得／聯絡 |
| 404 | `resource_not_found` | 不洩漏跨租戶存在性 |
| 409 | `state_conflict` | 現在狀態與合法動作 |
| 409 | `idempotency_key_reused` | 換 key 或使用原 request |
| 409 | `stale_job_lease` | worker 停止寫入；目前 lease owner 繼續或重新 claim，舊結果不得提交 |
| 412 | `version_conflict` | reload/merge |
| 422 | `business_rule_failed` | 公開規則 ref＋具體修法，不用「不合格」籠統文案 |
| 429 | `rate_limited`／`quota_exhausted` | `Retry-After` 或補充哪個 BillingSource；不改 entitlement |
| 502 | `provider_failed` | connector degraded、可重試／改人工路徑 |
| 503 | `temporarily_unavailable` | request 未遺失時提供 operation ID |

## 4. Domain event 與 webhook envelope

平台 Domain Event 使用 `03 §4` 的 canonical envelope。外部 webhook 不直接冒充 Domain Event；adapter 驗證、去重、解析後才產生平台 fact。

Event minimum：

```json
{
  "specversion": "1.0",
  "id": "evt_01J7PAYMENT1234567890XYZAB",
  "type": "freedom.commerce.payment.confirmed.v1",
  "source": "urn:freedom:service:commerce",
  "subject": "payment/pay_01J7PAYMENT1234567890XYZAB",
  "time": "<RFC3339 timestamp>",
  "datacontenttype": "application/json",
  "dataschema": "https://contracts.freedom.example/events/freedom.commerce.payment.confirmed.v1.schema.json",
  "correlationid": "cor_01J7PAYMENT1234567890XYZAB",
  "causationid": "evt_01J7ORDER1234567890XYZABC",
  "communityid": "com_01J7ABCDEF1234567890XYZABC",
  "traceid": "trc_01J7PAYMENT1234567890XYZAB",
  "contractversion": "1.0.0",
  "aggregateid": "pay_01J7PAYMENT1234567890XYZAB",
  "aggregateversion": 4,
  "eventsequence": 2,
  "data": {
    "actor": {"type": "integration", "id": "con_01J7PAYMENT1234567890XYZAB", "acting_as": "payment_adapter"},
    "rule_refs": [],
    "order_id": "ord_01J7PAYMENT1234567890XYZAB",
    "payment_fact_id": "payf_01J7PAYMENT1234567890XYZA",
    "amount": {"amount_minor": "120000", "currency": "TWD"},
    "provider_connection_id": "con_01J7PAYMENT1234567890XYZAB"
  }
}
```

規則：

- event 不帶 token、銀行帳號、地址、私人訊息全文、問卷自由文字或大型 media。
- `time` 是 domain fact 發生時間；provider occurred time 可驗證時沿用，否則用 durable received time並記 time source/quality；另存 received/processed time。
- CloudEvents extensions 只用 primitive value；結構化 actor/rule refs 在 `data`。Aggregate event 帶 `aggregateid/aggregateversion/eventsequence`；`aggregateversion` 是每次內部 transition 都遞增的 state version，公開 events 之間可以跳號。
- ordered consumer 只在收到 `last_contiguous_event_sequence + 1` 時於同 transaction 套用 effect/inbox/cursor；較大 `eventsequence` 先 durable buffer 並要求 replay 缺口，較舊序號去重或 quarantine，不允許直接跳號。Gap timeout 進 reconciliation，不猜測遺失事件；完整 protocol 見 03 §4.3。
- event retention 不能小於 projection rebuild 與財務稽核需要；payload 內敏感引用可依 retention policy tombstone。
- dead-letter 只表示 integration work 未完成，不把 user/entitlement 標成 failed。

## 5. 共通 integration 與 Agent execution 物件

### 5.1 `Connection`

代表一個可撤銷的外部帳號／app installation／provider account。

```text
id, community_id, provider, connection_type
owner_type, owner_id
provider_tenant_id, provider_account_id
capabilities[], granted_scopes[]
secret_ref, token_expires_at
status, last_verified_at, last_success_at, last_error_code
config_version, version, created_by, timestamps
```

```text
pending → active ↔ degraded → reauth_required → active
   │         │          │             │
   └─────────┴──────────┴─────────────┴──→ revoked
```

`secret_ref`是不透明reference，只有Credential Broker解析。它只能指向兩種核准custody：(a) provider自己保管、Platform不可匯出的connection handle；或(b) Platform為代理operation確實必須持有的dynamic OAuth refresh/API token，此時reference指向隔離PostgreSQL `credential_vault` record，內容只有per-record AEAD ciphertext、wrapped DEK與rotation metadata。一般Connection/domain table仍只存ref；固定environment root、vault KEK、GitHub App key與status-signing key才放purpose-scoped secret manager／核准KMS，且broker與signer分離。資料庫任何一般schema、event、log、瀏覽器或fork repo都不保存明文 secret。Owner／有權 operator 可從任一非終止狀態立即 revoke；revoke 停止新 credential issuance/job claim，已在途但結果不明的 external operation 進 reconciliation，不能為了「取消」而盲目重送。

### 5.2 `ResourceBinding`

把平台 resource 與 provider resource 連起來：

```text
id, connection_id
internal_resource_type/id, purpose
external_resource_type/id
external_display_ref
direction=inbound|outbound|bidirectional
visibility, capability_snapshot
config_ref/version, state, last_synced_at, version
```

例如 CareerTrack→Discord channel、SkillPackage→GitHub repository、Store→deploy origin、Campaign→channel account。

### 5.3 `WebhookInbox`

```text
id, community_id, connection_id
provider, provider_tenant_id, delivery_id
event_type, raw_payload_object_ref?, payload_hash
signature_status, signature_key_version, occurred_at, received_at
state, processing_attempt, processed_at, normalized_event_ids[]
last_error_code, next_retry_at
```

```text
received → verified → processing → processed
        ↘ rejected              ↘ retry_wait → processing
                                     ↘ dead_letter
```

raw body 先驗簽再 parse；`community_id+provider+provider_tenant_id+delivery_id` unique。Ingress 先以 route/provider tenant 找 candidate Connection，再用該 `connection_id` 的 active/overlap key versions 驗簽；payload tenant 與 Connection community/tenant 不一致時拒絕，不能以 client 傳入的 community 決定隔離範圍。HTTP ingress在同一PostgreSQL transaction完成canonical Inbox dedupe＋normalized receipt＋outbox/job ID後快速2xx；dispatcher之後才把ID送Cloudflare Queue，domain processing非同步，不能由ingress同時direct-write DB與Queue。

Raw webhook只在設定的最大body size內以bounded memory/stream buffer收取，超限在durable domain processing前拒絕；驗簽使用exact raw bytes，完成後預設立即丟棄，只在Inbox保存digest、signature result、provider IDs與allowlisted normalized receipt。只有connector data-classification明示允許、且不屬禁存類型的payload，才能把raw bytes加密寫入獨立受控object bucket並設明確短TTL／operator scope；client-confidential內容、payment instrument／bank raw payload與其他`08 §5.3`禁存資料一律不得持久化到中央R2、backup、log或dead-letter，即使為除錯也不例外。簽章失敗同樣只留digest與非內容metadata。TTL、法律保留與provider重送窗在connector config明示，不能無限期保存整包PII。

### 5.4 `OutboundDelivery`

```text
domain_event_id, connection_id, binding_id
operation, destination_ref
payload_schema/version, payload_hash, receipt_capability_snapshot
idempotency_key, attempt
state, provider_external_id, accepted_at, delivered_at
next_retry_at, last_error_class/code, redacted_response_ref
```

```text
queued → sending → accepted ──positive receipt──→ delivered
                         ├─ receipt timeout → result_unknown
                         └─ negative receipt → retry_wait / failed_permanent
              │       └─ no_receipt capability → accepted_no_receipt (terminal success)
              ├→ retry_wait → sending
              ├→ result_unknown → reconciling → accepted/accepted_no_receipt/delivered/retry_wait/manual_unknown
              └→ failed_permanent / dead_letter
```

send 或 receipt timeout 後是 `result_unknown`，不是直接 retry create；先以 idempotency key/external lookup 查回。Provider 宣告 `no_receipt` 時，成功 HTTP/provider accept 進 `accepted_no_receipt` 即為該 connector 可觀測的終止成功，不永遠卡在 accepted；若 ambiguous timeout 後 reconcile 查回 accepted，亦依 snapshot 的 no-receipt capability 直接進此 terminal。若有 receipt capability 才回 `accepted` 等待 delivered。明確 negative receipt 依 provider 是否證明「未交付且可安全重試」進 retry_wait，否則 failed_permanent；未知不得猜成失敗後重送。`reconciling` 每次必須可收斂到 accepted、accepted_no_receipt、delivered、safe-to-retry 或 `manual_unknown`，不能成無出口狀態。

`dead_letter` 僅可由已知 safe-to-retry 的 `retry_wait` 在策略耗盡後進入；`reconciling` 查詢能力耗盡時必須進 `manual_unknown`。兩者不可合併，否則 operator 可能把「外部其實已成功」的未知副作用當成失敗重新送出。

### 5.5 `ProviderJob`與`ReleaseStatusJob`

`ProviderJob`用於 payment session、publication、transcript、render 等外部長任務：保存 canonical job ID、跨 lease attempts 不變的 `provider_operation_key`、provider job ID、request hash、callback/polling state、attempts、result refs、estimated/actual cost。provider job 狀態只轉成相應 domain fact，不直接跨模組改 aggregate。其job type不是自由字串；active immutable `job_registry_version`把每個`GeneralProviderJobType`固定映射到唯一executor group與唯一Queue consumer：

| GeneralProviderJobType | executor group | Queue／唯一active consumer |
| --- | --- | --- |
| `payment_session`、`settlement_transfer`、`notification_delivery`、`github_sync`、`provider_reconciliation` | `integration` | `integration-jobs queue` → `integration-worker` |
| `channel_publication` | `growth` | `growth-jobs queue` → `growth-worker` |
| `media_transcript`、`media_render` | `media` | `media-jobs queue` → `media-worker` |

跨 repo provider worker只走scoped general/provider Job API：

```text
POST /api/v1/internal/jobs:claim        → exact requested_job_id + opaque queue delivery handle → lease/fence/input refs
POST /api/v1/internal/jobs/{id}:begin-provider-operation → atomic leased→running with stable operation key
POST /api/v1/internal/jobs/{id}:heartbeat
POST /api/v1/internal/jobs/{id}:complete → output refs, usage, provider refs
POST /api/v1/internal/jobs/{id}:fail     → retryable/error class/checkpoint
{INTEGRATION|GROWTH|MEDIA}_CREDENTIAL_BROKER.issueJobCapability / proxyProviderOperation
    → exact group-specific named entrypoint; lease-bound capability or brokered provider call
```

Dispatcher的Queue payload固定只有`job_id + queue_delivery_id + queue_delivery_handle + wakeup_reason`。Handle是高熵、短效、one-time/current opaque值；PostgreSQL只存其hash並在canonical delivery row綁exact job、delivery、source Queue、executor group、`job_registry_version`、worker OAuth audience、lifecycle與不晚於Queue retention的expiry，raw handle必須從log/trace/error redact。這不引入新的簽章key，handle也不是business truth或provider credential，server仍須重讀canonical row。claim body必填`requested_job_id + queue_delivery_id + source_queue + queue_delivery_handle + job_registry_version + executor_group + job_types`，以constant-time hash check在同一transaction將current handle消耗到一個lease，只可能lease該requested row，絕不掃group或換成另一筆工作。Server以OAuth client註冊的executor group為權威，eligible set固定是request、該client的server-side type allowlist與active registry的交集，且每個type的registry group必須與client、handle binding及來源Queue相同；request自報group不會取得權力。Schema-invalid type/group/Queue回`400`；valid-shaped但random/mismatched handle、OAuth client、canonical binding或用status job ID呼叫任一`/internal/jobs*` mutation回`403`，皆零side effect。registry／current lease／expired delivery conflict回`409`並retry或由sweeper建立新delivery＋handle；已消耗handle的redelivery只查同一job，只有exact row已terminal／superseded的`204`可直接ack。schema的closed `GeneralProviderJobType` enum本身就不能表達release-status type。

begin/heartbeat/complete/fail 都帶 lease 與 fencing token；crash 後 lease 可被同executor group的新 worker接手，舊worker的晚到完成以 `409 stale_job_lease`拒絕且沒有任何quota/output side effect。只有尚未開始外部副作用的`leased` job過期可回queued；worker在呼叫provider前必須先由canonical`:begin-provider-operation` transaction驗current lease/fence/stable key、job family、registry group與OAuth client allowlist並持久化`running`，且只有`running`可complete。Credential Broker只對running general/provider job發capability。`needs_input`僅在沒有未查明外部副作用時進`manual_unknown`並保存checkpoint；running lease過期只進`result_unknown → reconciling`，查回明確未接受後才可retry。Job input/output只含`connection_ref`、signed object refs與版本化schema，不給growth/media repo直連core DB，也永不夾帶長效OAuth/API token。完整transition見machine-readable`provider_job` state machine。

`ReleaseStatusJob`是另一個job family、另一個registry、另一個OAuth client/scope與隔離Queue，只供`release-status-worker`核對exact release／QC／A4／revocation facts並呼叫private status-signer：

```text
POST /api/v1/internal/release-status-jobs:claim  → exact requested_job_id + dedicated opaque Queue delivery handle
POST /api/v1/internal/release-status-jobs/{id}:begin-verification
POST /api/v1/internal/release-status-jobs/{id}:heartbeat
POST /api/v1/internal/release-status-jobs/{id}:complete
POST /api/v1/internal/release-status-jobs/{id}:fail
```

這組schema只接受closed `ReleaseStatusJobType` enum；claim同樣必帶exact `requested_job_id + queue_delivery_id + source_queue=release-status + queue_delivery_handle`，其DB hash binding固定status Queue、registry與dedicated OAuth audience並原子消耗，不能掃描或替換另一列。lease／result只有status intent、exact release subject、verification evidence refs與lease proof；明確沒有`connection_ref`、`provider_operation_key`、`provider_ref`、capability或credential欄位。Claim使用`release-status-jobs.claim`，其餘mutation使用`release-status-jobs.execute`；兩者不蘊含`jobs.*`或任何Credential Broker binding/method。一般job type／錯誤Queue等schema-invalid body回`400`；valid-shaped但一般worker/scope、錯誤handle/canonical family或非dedicated client回`403`，都沒有side effect。verifying lease結果不明時先進`verification_unknown → reconciling`，不得盲目重簽或重撤銷；完整transition見machine-readable`release_status_job` state machine。

#### Canonical public Pages live-status

唯一public widget contract由Platform Trust擁有、`platform-api`以cache-disabled status DB binding提供：

```text
GET /api/v1/public/projects/{projectId}/release-status
    ?repository_id={stable-github-repository-id}
    &release_tag={immutable-v-semver-tag}
    &commit_sha={exact-40-hex-sha}
```

它不收cookie、bearer token或manifest自訂endpoint/key；四個subject欄位必須逐一對上canonical project與published immutable release，server再從protected registry推導attestation URL、issuer/key與核准Pages origin。`200 status=official`必須同時回exact subject（含resolved release ID）、currentness registry digests與attestation proof identity/digests/有效期；任一attestation缺失、subject/assets/QC/A4不符、過期、撤銷、supersede或issuer/key不可信都只回`200 status=unverified`且**不得**夾帶attestation proof。Canonical registry無法驗freshness時回`503`，不可回舊official；malformed/unknown exact subject用`400/404`。Widget對所有非`200 official + valid/current proof`、schema錯誤、timeout或network error一律顯示Unverified。

所有response都`Cache-Control: no-store`、`Pragma: no-cache`及`Vary: Origin`。Request沒有Origin時照常回公開資料；Origin只有逐字等於protected registry中該project的canonical Pages origin時才回相同`Access-Control-Allow-Origin`，不得用`*`或`Access-Control-Allow-Credentials: true`。不核准Origin仍可由curl/server讀公開response，但browser script拿不到CORS grant；CORS不是status authenticity。Generated widget的path/query shape、5秒timeout與最長60秒recheck由central full-SHA-pinned generator固定，project manifest/page script不得改endpoint、刪subject欄位或把offline狀態變成Official。

#### Credential Broker

跨 repo worker不讀core secrets-manager path。Credential Broker沒有public hostname、HTTP route、default RPC methods或service OAuth fallback；它使用四個deploy-time private Service Bindings，分別指向四個具名`WorkerEntrypoint`，而不是讓所有caller共享一個superset RPC interface：

- `CREDENTIAL_LIFECYCLE_BROKER → CredentialLifecycleEntrypoint`只配置給`platform-api`，class只export `storeOAuthCallbackCredential/rotateConnectionCredential/revokeConnectionCredential`。
- `INTEGRATION_CREDENTIAL_BROKER → IntegrationJobCredentialEntrypoint`、`GROWTH_CREDENTIAL_BROKER → GrowthJobCredentialEntrypoint`、`MEDIA_CREDENTIAL_BROKER → MediaJobCredentialEntrypoint`只配置給各自worker；每個class hard-code自己的executor group，只export `issueJobCapability/proxyProviderOperation`。

Authority來自受保護的deployment config是否持有指向exact named entrypoint的binding，以及該entrypoint真正export的方法；一般Cloudflare RPC不被假定會自動帶calling Worker名稱，request body/header/argument也不能選role。Cloudflare官方把named entrypoints列為建立permission-role-specific RPC methods的機制，見[Service bindings：Named entrypoints](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/#named-entrypoints)。三個executor entrypoints收到`job_id/lease_id/fencing_token/connection_ref`後，在secret lookup／unwrap前以hard-coded group與canonical DB重驗current running lease、Connection status/community、job type及active registry mapping，再取allowed scopes交集並回provider原生short-lived token，或只被provider egress proxy接受的opaque capability，由proxy注入長效secret。`release-status-worker`、`status-signer`、public/portal web、webhook ingress、Agents與任何其他deployable都不持Broker binding；即使向RPC arguments偽造caller/group也不取得權力。共同約束如下：

- `aud` 固定為 adapter/provider egress，不可拿去呼叫 Platform 一般 API；`scope` 固定為本 job 必要 operation/resource，另帶 community、connection、job 與 lease binding。
- TTL 不超過目前 lease 與 10 分鐘中的較短者；不發 refresh token。Heartbeat 後若仍是 current lease 可重新 exchange，舊 fencing token 立即失效。
- Connection revoke／secret rotation 立即停止新 exchange；rotation 使用短 overlap window 驗 callback，worker 不需知道新舊 secret。Provider 不支援短效 token 時只走 egress proxy，不把底層長效 credential 解封給 worker。
- audit 只記 credential issuance ID、subject、aud/scope、connection/key version、expiry 與結果；token、Authorization header、query secret、provider raw body 都由 structured redaction 移除。Object refs 仍需 purpose/TTL 驗證。

### 5.6 `ReconciliationRun`

```text
id, provider, connection_id, resource_scope
range_start/end, cursor_start/end
started_at/completed_at, state
observed_count, matched_count, missing_platform_count
missing_provider_count, mismatch_count, repaired_count
report_object_ref, last_error
```

每個 connector 定義查回能力與頻率；無 list API 的 provider 用 delivery receipt、status polling 或人工匯入報表降級。

### 5.7 `AgentConnection`、`WorkContextBundle`、`TaskLease`、`ActionIntent` 與 `DraftArtifact`

`freedom-agent-kit`（或相容 MCP/CLI adapter）只能透過與公開 OpenAPI 同源的 Agent Control API 工作，不直連 domain DB。Agent tool manifest／SDK 宣告 capability 與其所需 A-level；階段 1B 的 canonical HTTP surface 是：

```text
POST /api/v1/agent-connections/device-authorizations
POST /api/v1/agent-connections/device-authorizations/{userCode}:approve
POST /api/v1/agent-connections/device-token
POST /api/v1/agent-connections/refresh-token
POST /api/v1/agent-connections/{agentConnectionId}:revoke
GET  /api/v1/me/work-context
GET  /api/v1/me/work-feed?cursor=...
POST /api/v1/me/onboarding-bundles
GET  /api/v1/me/onboarding-journeys/current
POST /api/v1/me/member-skill-installations
POST /api/v1/me/member-skill-installations/{installationId}:verify
POST /api/v1/me/day-one-execution-grants
POST /api/v1/work-items/{workItemId}:claim
POST /api/v1/execution-grants
POST /api/v1/execution-grants/{grantId}:mint-token
POST /api/v1/execution-grants/{grantId}:revoke
POST /api/v1/agent-runs
POST /api/v1/action-intents
POST /api/v1/action-intents/{actionIntentId}:sign
POST /api/v1/action-intents/{actionIntentId}:execute
POST /api/v1/draft-artifacts
GET  /api/v1/draft-artifacts/{draftArtifactId}
POST /api/v1/draft-artifacts/{draftArtifactId}/revisions
```

Device/browser flow先顯示client instance與principal給human核准，再發只含`agent.bootstrap.read`的短效connection token；它只讀本人purpose-minimized Status／Feed／下一個grant入口，沒有A1–A3 domain工作權。`POST /api/v1/agent-connections/refresh-token`只續期這條AgentConnection session，必須驗sender-constrained client-instance proof並原子rotation，舊refresh material在同transaction失效，重播無法取得第二組有效token。只有已命名同一AgentConnection的active ExecutionGrant可由`:mint-token`換成短效、grant／profession／audience-scoped execution token；兩者都不含A4 signing authority。Credential Broker的worker job capability是綁current lease/fencing/audience的單次短效exchange，永遠不發refresh token；到期只能持新鮮有效lease重新交換。

`POST /api/v1/agent-runs` 在同一 command 建立 AgentRun 與第一個短效 TaskLease；沒有讓 process 搶走人類 Claim 的另一條 claim API。Client不提交`equipped_skill_version_refs`：server從immutable WorkItem的required SkillVersion refs推導exact set；WorkItem未要求domain Skill時該set可為空，否則要求每項仍在current WorkContext equip且與grant/task相容，再於lease response與AgentRun provenance回傳／保存。Response與provenance的`domain_skill_runtime_mode`是`eligibility_and_provenance_only_v1 | signed_isolated_overlay_v1`兩值enum；前者是default／fail-closed，opaque domain refs只作matching／資格／稽核，launcher不fetch、materialize、discover或execute。只有`BLD-05` signed overlay artifact、另一自然人的exact runtime-scope QC、current publisher authority、current revocation、`runtime_roots_set_digest`所綁roots與server-derived WorkItem exact set相等，且per-run isolated loading全數通過，server才可選用後者；client不得自報mode、overlay或roots。任一驗證失敗回`capability_unavailable`，且零domain Skill execution／consequential effect。Singular signed activation root＋dependency closure另代表Freedom控制Skill執行環境，兩者不可混欄或互相授權。若WorkItem綁owner-controlled external document，response另帶server-derived exact source requirement；bound local Agent透過`POST /api/v1/agent-runs/{agentRunId}/external-source-verifications`在owner端抓exact ref/revision、重算SHA-256，只回傳current lease/fence與最小receipt。該receipt是authenticated／fenced Agent assertion與provenance，不是server對remote host bytes的獨立attestation，也不替代review／signature／A4。任一required source未verified不得submit output、authorize／execute consequential ActionIntent；known unavailable／denied／missing revision／digest mismatch必須記receipt、fail run且零 consequential effects。非code platform-native PR使用唯一canonical `DraftArtifact` model：每個`draft_artifact_id`是一個immutable revision aggregate，`lineage_id`串successors。首版發`freedom.work.draft_artifact.created.v1`；`POST /api/v1/draft-artifacts/{draftArtifactId}/revisions`原子把path所指舊版轉superseded並發`freedom.work.draft_artifact.revised.v1`，同lineage建立新ID/draft並發created；ActionIntent成功套用exact revision才發`freedom.work.draft_artifact.applied.v1`。Create/revise只保存pinned schema、完整immutable content、base target version、digest與deterministic diff，review後仍須另建ActionIntent才可apply；`ChangeProposal`只作UI概念別名。GitHub draft-PR等高階tools也由同一versioned tool manifest暴露，分別落到owning aggregate command或connector；未進 OpenAPI 前client不可自行猜一條未版本化HTTP path。`:execute`是allowlisted typed command入口，server必須從execution token／grant推回principal、AgentConnection與acting profession，並重驗current TaskLease/fencing、artifact/consequence digests、A4 signature或signed mandate basis；它不能把draft、舊簽名或client自報角色變成授權。

`WorkContextBundle`短效且purpose-bound，只含：principal、confirmed ProfessionMemberships、equipped SkillPackageVersions、`work_direction_basis`、可見WorkItems及reason/gain/effort、Claim/Squad/Project refs、grant摘要、required reviews/signatures與resource refs。Person variant固定`type=member_work_intent + work_intent`；organization variant固定`type=organization_work_policy + organization_work_policy_ref + operator_user_ref + acting_profession_membership_refs + authorized_work_types + revision`，不得借用operator或其他會員未揭露的CareerProfile／私人WorkIntent。Bundle也不得含全部定位自由文字、私聊、payment secret或未授權Opportunity。

`WorkItem Claim`屬human/team/Squad；`TaskLease`屬AgentRun，帶短效lease/fencing token。Agent crash只讓TaskLease到期，人的Claim不釋放。Agent可在AgentRun前代principal執行claim，但這固定是A2，execution token／grant必須明示`work.claim`及該WorkItem scope，claim owner仍是人／Team／Squad。WorkItem的`execution_mode=exclusive|collaborative|competitive`決定可有幾個Claims/Submissions，不能由Agent猜。

所有真正副作用先建立 `ActionIntent`：

```yaml
common:
  authorization_principal_ref: {type: user, id: usr_01...}
  acting_role_ref: prm_01...
  action_type: github.pull_request.create
  target_ref: repo:123456789@base-sha
  expected_target_version: 12
  artifact_sha256: sha256:...
  request_sha256: sha256:...
  consequence_summary_sha256: sha256:...
  authorization_basis_snapshot_ref: abs_01...
  idempotency_key: work-item/submission/operation
one_origin_only:
  principal_session: authenticated_session_and_acting_role
  agent_run: [agent_run_id, work_item_id, claim_id, agent_connection_ref, execution_grant_snapshot_ref]
  system_mandate: [settlement_instruction_ref, mandate_ref, mandate_bound_ref, mandate_usage_reservation_ref]
```

三種origin互斥：直接人類操作不製造假的AgentRun；agent origin必須有current claim／lease／fence；system-mandate origin沒有agent process，必須引用exact signed bound及原子capacity reservation。Server以Operation Registry判斷所需A-level，不接受client把A4標成A2。各domain typed endpoint與`:execute`共用同一intent/idempotent command handler，只能把同一intent結果落帳一次，不能形成兩條副作用路徑。每次AgentRun必填保存agent connection與client/model/tool contract version、server計算的WorkContext hash、acting ProfessionMembership、server-derived domain Skill exact set及兩值`domain_skill_runtime_mode`、nullable overlay artifact digest／statement digest／`runtime_roots_set_digest`、signed control-Skill activation、input/output artifact、HumanSignature、Result refs及outcome；既有八輸入control `activation_digest`不變，overlay digests另欄保存。未知scalar用明確`null`、不存在的refs用空陣列，不以省略欄位混淆「未收集」與「不存在」，也不保存chain-of-thought。

### 5.8 Connector ownership 與唯一寫入路徑

| 接點 | Connection／secret owner | Webhook／callback ingress | Job／adapter executor | 唯一 domain write command |
| --- | --- | --- | --- | --- |
| Login adapter（LINE proposed first） | Foundation／Identity Ops | Platform API auth callback | Identity adapter | Identity `LinkExternalIdentity`／session rotation |
| LINE Messaging | Community Ops 的 OA；secret custody 為 Platform Ops | Platform webhook ingress | integration-worker | bound Community/Coaching command；明確進件只可呼叫`opportunity-project-work`的`CreateSubmissionDraft` |
| Discord | server/bot owner | Platform webhook ingress | integration-worker | Community/Coaching/Skill command；明確進件只可呼叫`opportunity-project-work`的`CreateSubmissionDraft`，bot 不直寫 tables |
| GitHub | App installation owner | Platform webhook ingress | integration-worker | Skill sync/evidence-candidate command |
| Storefront | Store owner；deploy/server token 分開 | Storefront BFF／Platform API | store backend＋platform-api | Commerce 建 Order；Storefront Control 寫 Binding |
| Seller collection | Seller擁provider account；provider-managed credential不匯出，需Platform代理的dynamic token則只進encrypted credential vault；Connection只存ref | payment webhook ingress | payment adapter／integration-worker經Credential Broker取得job-scoped capability | Commerce append verified PaymentFact；Ledger依signed source建立SupplierPayable或明示CommissionObligation |
| Payer disbursement／Beneficiary destination | Payer擁purpose-tagged發款connection、beneficiary擁purpose-tagged destination；Platform只存vault/token ref | payout webhook／status query | `integration-worker`內的settlement adapter＋provider/bank adapter，經Credential Broker取job-scoped capability | Settlement append TransferFact；只有confirmed SupplierPayable命令Commerce authorize SupplyOrder |
| Agent CLI／MCP | human/org principal；Agent Control擁grant | OAuth/device callback；無任意webhook impersonation | Claude/Codex/Grok adapter | owning domain command經ActionIntent；intake grant只可`CreateSubmissionDraft`；Agent Control寫run/provenance |
| Local document reference | 文件與raw客戶資料由human/org/Squad端點持有；Platform無其storage credential | owner session或Agent connection的outbound Platform API | local agent/document adapter | `opportunity-project-work`的`CreateSubmissionDraft`只送opaque external ref、digest、revision與media metadata；confirm只記owner acknowledgement，之後bound local Agent才以owner-side access讀exact revision、本機驗digest並回receipt，不上傳raw內容 |
| Marketing channel | campaign/account owner；provider-managed credential不匯出，代理所需dynamic token只進encrypted credential vault；Connection只存ref | channel callback ingress | growth/publication worker＋Credential Broker/egress | Marketing complete PublicationJob；不得改 Order |
| Media/AI provider | BillingSource owner；provider-managed credential不匯出，代理所需dynamic token只進encrypted credential vault；Connection只存ref | provider callback ingress | growth/media worker＋Credential Broker/egress | Media complete attempt/asset；Quota append consume/release |
| Guild Lounge | Activity host；display/control scope 分離 | compatibility BFF | Lounge backend＋community adapter | Community Events 寫 `Participation`、`MatchRound`（round／timer）、assignment、encounter facts |

本表是 O1–O4 owner 分類的 integration ownership 依據；分類定義與逐模組接點地圖見 `02 §4.7`。

同一 provider callback 只由一個 ingress durable capture；同一 job type 只由一個 executor group claim。表中 owner 是營運／技術責任，不是讓一般使用者排隊審批。每個 ModuleStewardship仍由一個Guild Master/accountable team負責contract方向，routine connector review可委派。

## 6. Retry、reconciliation 與人工修復

錯誤分類：

| 類型 | 例子 | 行為 |
| --- | --- | --- |
| transient | timeout、connection reset、429、部分 5xx | exponential backoff＋jitter，尊重 `Retry-After` |
| auth | token expired/revoked、scope missing | refresh 一次；失敗設 reauth_required，通知 owner |
| invalid request | provider 4xx、resource removed | permanent failure，顯示可修改內容／binding |
| result unknown | create timeout、callback 遺失 | 不重建；先 query/reconcile |
| poison payload | schema major 不支援、反覆 domain error | dead-letter＋人工 inspect/replay |
| security | signature invalid、replay too old | reject、metric/alert，不 domain retry |

人工工具只能執行安全 command：replay inbox/outbox、rebind resource、attach unknown external fact、mark false duplicate、rotate/revoke connection。工具不可讓 operator 直接 update ledger 或改已發布 SkillVersion；修正仍產生 reversal／superseding fact 和 audit。

## 7. LINE 接點

### 7.1 接點分離

| Connection type | 用途 | 身份／scope |
| --- | --- | --- |
| LINE Login | 首個建議登入 adapter、會員 identity link | channel-scoped subject＋OIDC/OAuth claims |
| Messaging API / Official Account | 通知、postback、真人 handoff | OA/channel connection |
| LIFF/deep link | 從訊息安全回到特定 Portal action | 短效一次性 action token |

不同 LINE channel 下的 subject 不假設相同；只有完成明確 link flow 才對應同一 `user_id`。

### 7.2 Login／link flow

```text
Portal creates auth transaction(state, nonce, PKCE where supported, return path)
→ redirect to allowlisted LINE authorization endpoint
→ callback verifies state/nonce/issuer/audience/code
→ resolve (provider, tenant, subject)
→ create/link User in transaction
→ rotate platform session
→ emit freedom.membership.identity.linked.v1
```

- `state` 一次性、短效並綁瀏覽器 transaction；return path 必須 allowlist。
- login callback 不接受 client 傳 `user_id`。
- linking 到已被別人使用的 subject 進 conflict UI，不自動 merge。
- revoke/unfollow 只改該 connection/link 健康與通知路徑，不 pause 會員。

### 7.3 Inbound messaging

- 驗證 raw body signature、timestamp/replay window（依 provider 能力）與 delivery/event ID。
- postback data 只含短效、purpose-bound、一次性 action token；不得含可改的 `user_id`、price、entitlement 或 admin command。
- 可支援：陪跑 `done/stuck/reschedule`、support request、活動 check-in、打開 status/settlement/order。
- Messaging worker 以 `serviceOAuth(coaching.write/community.attendance.write)` 呼叫專用 internal command；server 由已驗 webhook connection＋external identity＋一次性 action-token binding 解析真正 User/Activity/Checkpoint，worker 不傳一個可任意 impersonate 的 `user_id`。Portal cookie endpoints 與 internal service endpoints 分開，後者不用 CSRF但必驗 audience/scope/binding。
- 會員可用明確、purpose-bound的「建立進件草稿」command把一個message revision送成owner-private `SubmissionDraft`。Worker只能以`intake.drafts.create`送verified normalized delivery ref與typed target proposal；server由active ExternalIdentity推導owner。未連結、多人對應、source hash衝突或被撤回時不建draft，只回一次性link／Portal deep link。
- 自由文字預設留在 LINE。若會員明確選擇「把這段加入 checkpoint」，才保存必要文字/evidence 並記 consent context。
- LINE用於即時聊天、提醒與Portal deep link；MVP的reply/postback不是A4 HumanSignature。價格、分配、Supplier acceptance、Mandate／超scope付款退款、QC、合約或任何official／production immutable release一律回Portal顯示exact digest後簽名。
- LINE message、webhook或delivery 的 provider timestamp 只可作外部 `occurred_at`／replay evidence；它不是 invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof 同物件的 `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at` 或 evidence `valid_until` 中任何一種時間。

### 7.4 Outbound 通知

`line-template-map.yaml` 定義 template key、version、allowed data fields、deep-link action、quiet-hour policy 和 fallback：

```yaml
schema_version: freedom.line-templates/v1
templates:
  coaching_checkpoint_due:
    version: 3
    variables: [display_name, action_title, due_local, action_token]
    categories: [coaching_reminder]
    fallback: portal_inbox
```

- 尊重 opt-in、category preference、timezone 與 quiet hours。
- delivery key 固定為 `event_id + user_id + template_version + destination`。
- 私人配對只通知「結果已準備」並 deep link 回授權 Portal；不把他人完整個資推到 LINE。
- 送不到時 Status View 仍顯示 Next，並提供重新連結或改 Discord/Portal。

### 7.5 LINE 成功定義與 reconciliation

- provider accepted 不等於人已讀；UI 使用 `queued/accepted/delivered(if available)/failed` 真實字眼。
- 監控 last successful webhook、delivery failure、unfollow、token refresh。
- 依 provider 可查能力執行狀態 reconcile；不可查時以固定 delivery history＋Portal fallback 完成。

## 8. Discord 接點

### 8.1 Identity 與 installation 分離

- User OAuth link：證明哪個 Discord subject 對應平台 User。
- Bot installation：平台 bot 可在哪個 Discord guild 操作。
- ResourceBinding：某 CareerTrack、Skill、StudyGroup、Opportunity/Squad 或 Activity 對應哪個 channel/thread/event。
- Discord role 是展示／使用便利性，不是平台 API entitlement 真相。

### 8.2 `discord-channel-map.yaml`

```yaml
schema_version: freedom.discord-map/v1
bindings:
  - key: track-ai-deployment
    purpose: career_guild
    guild_external_id: "..."
    channel_external_id: "..."
    visibility: public-community
    managed_by: platform
  - key: skill-example-discussion
    purpose: skill_discussion
    guild_external_id: "..."
    channel_external_id: "..."
    visibility: public-community
```

設定發布會做 ID 可達性、bot capability 與重複 purpose 檢查；failure 只阻止該 binding 啟用，不擋 SkillPackage 或 CareerTrack 保存／發布。

### 8.3 Outbound／inbound

Outbound：活動／讀書會公告、SkillVersion 發布、Opportunity 開放、session 提醒、Result 分享（限本人同意的 public fields）。

Inbound：slash command/button interaction、Scheduled Event 狀態、明確 RSVP/check-in、`/status`、`/help`。Bot command 呼叫 Platform API，不在 bot process 另建會員／進度 DB。

Bot可以讀公開或已授權給該Discord context的pinned SpecVersion、SkillVersion與WorkItem refs，在channel回答「這版規格怎麼做」、列可認領工作，並提供canonical claim／Portal deep link，讓社群成員與其Agent一起讀同一份spec。回答必須顯示source ref/version且只用該channel可見scope；不能帶出private Opportunity、個人WorkContext、未公開SOW或其他私密資料。對話、emoji、bot回答或「我要做」都不建立ExecutionGrant、HumanSignature、WorkClaim或canonical domain state；認領與正式動作仍回Platform typed command。

討論或讀書會訊息可由本人觸發「建立進件草稿」並附deep link；adapter只以verified interaction、active ExternalIdentity與immutable message revision建立owner-private `SubmissionDraft`，不直接建立WorkItem／OpportunityStub。未連結或owner不唯一時只導向link flow。只有owner在Portal可confirm為一個draft WorkItem或private OpportunityStub，Discord不能直接形成claim、ExecutionGrant、QC approval、Supplier acceptance、Engagement allocation、付款授權、合約或release。Formal action回Portal exact-diff SignaturePanel，或GitHub原生review（僅code）。

不可推導的事實：

- 加入 server、加入 voice、訊息數或 emoji 不等於技能完成。
- attendance 不等於 ResultEvent。
- Discord role 名稱不等於 CareerTrack、Maintainer 或 Entitlement。
- 討論全文不鏡像進平台；只保存 binding、deep link、interaction fact 與經同意摘要。
- Discord message、interaction或Scheduled Event的timestamp只可作外部 `occurred_at`／replay evidence；它不是 invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof 同物件的 `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at` 或 evidence `valid_until` 中任何一種時間。

### 8.4 Degraded mode

Bot 權限不足、channel 被刪或 Discord outage 時：binding 設 degraded、通知 coordinator、保留 Portal 的活動／skill/opportunity 與結果入口。重綁 channel 不改內部 resource ID 或歷史 events。

## 9. GitHub 接點

### 9.1 三種關係

| 關係 | 目的 | 不代表 |
| --- | --- | --- |
| GitHub user identity | attribution、本人操作 | 擁有任何 repo 或平台維護權 |
| GitHub App installation | read webhooks/metadata、可選建 PR/check | 某位會員已是 maintainer |
| Repository binding | SkillPackage 指到 stable repo/manifest | branch HEAD 是已發布 SkillVersion |

Repository binding 保存：

```text
installation_id
repository stable numeric ID
owner/name display path
manifest path
default branch
selected commit SHA
release/tag ref
manifest hash
last webhook delivery ID
last successful sync
repository state/visibility snapshot
```

### 9.2 Import／release flow

```text
member selects installed repository
→ adapter resolves stable repository ID and commit SHA
→ minimal repository/commit/name/source-relationship check
→ platform immediately creates public candidate metadata-only package/version
→ fetch or scaffold full manifest at that commit
→ schema/reference/capability readiness report
→ mark only the supported automated capabilities ready
→ bind one or more Discord discussions by purpose/level
→ later push/release creates version candidate, never overwrites published version
```

Validator 是 automation-readiness contract：缺 manifest、entrypoint 找不到、semver/commit/hash 矛盾時回 path、actual、expected 與 scaffold/PR 修法，只停用依賴該欄位的自動安裝、同步或商業QC申請。作品仍可公開、討論、fork 與取得協助；缺 license 顯示 `NOASSERTION` 並建補資料 WorkItem。它不是程式安全、人格背書或 candidate 可見性條件。

此處「不擋 visibility」只適用candidate：任何人可提交／討論／fork。`official`、commercial binding或可售SellerListing仍須平台指向exact commit的independent human QualityReview signature；manifest validator不能替代QC。

### 9.3 Webhook normalization

處理 installation/repository、push、release、repository rename/transfer/archive/delete、pull_request merged 與 check_run。規則：

- repo rename/transfer 依 stable repository ID 延續，更新 display path。
- event 重送以 delivery ID 去重；亂序依 provider timestamps＋current API reconciliation，不倒退 version。
- PR merge 可產生 evidence candidate；只有 package recipe／本人提交／確認流程才成 ResultEvent。
- GitHub permission 不自動授予平台 Maintainer；需 invitation/acceptance 或版本化的明確同步規則。
- installation removed、repo private/delete 不刪歷史 SkillVersion，標 unavailable/degraded 與替代方式。
- registry 索引不表示平台執行不受信任的 repo code；若需執行，使用隔離 runner、最小網路／secret scope 與 cost limit。
- GitHub webhook、commit、review、check或release timestamp只可作外部 `occurred_at`／reconciliation evidence；它不是 invite／claim `expires_at`、delivery `due_at`、TaskLease／lease proof 同物件的 `expires_at`＋`fencing_token`、`ExecutionGrant.expires_at` 或 evidence `valid_until` 中任何一種時間。

GitHub是code artifact的canonical PR/review/check/merge/release authority；平台只保存repo/commit/PR refs、WorkItem/Claim、Agent provenance與Result/Contribution。Listing、QC decision、Campaign、Opportunity、SOW／Allocation等非code artifact使用平台canonical `DraftArtifact(base target version + schema + immutable content/digest + deterministic diff + review)`，再由ActionIntent按目標A-level套用；`ChangeProposal`只是UI別名，不得另建aggregate，也不得硬塞GitHub issue文字當正式business revision。

QualityReview綁`repository_id + commit_sha + artifact_digest + ReviewProtocolVersion`。CI/Agent test只是EvidenceRef；另一位verified human reviewer必須在Portal看到測試環境、findings與digest後簽decision。Community software／Skill QC永遠零費，只建立Field/Vibe ContributionRecord；客戶funded testing/review/development是另一個customer-sponsored Project／ServiceEngagement，由Squad以SOW／milestones／AllocationPlan記帳，不能把同一免費QC改名收費。Commit變動或protocol要求的artifact變動後舊signature不適用。

`CommercialEdition`以`POST /api/v1/commercial-editions`綁exact repository stable ID、commit SHA／SkillVersion、artifact digest、偵測與人工確認的license／obligation evidence、commercial delivery mode及QualityReview refs；repo HEAD、Store fork或後續license文字改變都不能倒改既有edition。新commit／license evidence要發新revision並重新走適用QC。Open AI Product & Skills Division再以具名、本人接受的`ProductRoleAssignment`，把同一edition的AI Vibe（build）、AI Field／FAE（test／deployment／support）與AI Project（opportunity／SOW／sale）角色接到Project/Squad；commercial-ready validator按`human_user_id`要求三個不同自然人，不能靠同人換Profession／Agent湊齊，QC reviewer亦不得是exact artifact submitter。exact product/QC/license已齊但三人未湊齊時保持`product_ready`，仍可開源開發、試驗與fork但不標commercial-ready；進入／恢復`ready`時重驗三個active、自行接受且不同自然人的assignments，離任令`team_ready`回`product_ready`或令`ready`暫停future offers，均不改舊Order。這些assignment與貢獻evidence不自動產生ownership、royalty或專案分配。

## 10. Agent CLI／MCP 接點

### 10.1 Login、capability discovery 與職業選擇

Claude、Codex、Grok CLI 與其他相容 Agent 使用上述 device/browser flow 登入。Platform 顯示 client instance、principal、固定 `agent.bootstrap.read` 與 expiry；核准後的 connection token 可 A0 讀本人最小 Status／Feed，但要由 active ExecutionGrant 另換 execution token 才能執行 A1–A3。新註冊會員須先完成平台的封閉定位與主要公會；這個帳號前提同樣適用 Agent，不得用 `onboarding-bundles` 或 WorkIntent 繞過。已完成者與既有 `onboarding_required=false` 會員，可從定位 draft 確認，或以 `POST /api/v1/me/onboarding-bundles` 用 stable profession key 自行確認後續公會、WorkIntent、equipped set 與相關 refs；重新定位、公會歡迎與安裝旅程仍可略過，不是每次工作的前置條件。agent／UI 不得要求手貼 opaque ID。之後可建立 `day1.learn-equip-and-claim` 短效 A0–A2 grant，server 由 journey 解析單一 profession、starter package 與 first low-risk WorkItem；它不是 A4 或未來合約同意。Agent 不能代簽、不自行推定 Master 或工作承諾。Organization 不得以員工的隱藏定位資料填空。

### 10.2 每日工作與標準交付

Agent讀Daily Work Feed後，以淺顯方式提出：「有哪幾個商品可賣／貼文可發／客服可處理／PR或QC待做／Supplier待onboard／implementation可加入」，逐項顯示reason、effort、gain、acting role、required review/signature。使用者可選全部、部分、自己做或略過。

Code工作標準路徑：WorkItem/Claim → resolve repo/issue/base SHA → GitHub fork/branch → Agent A2 commit/draft PR → GitHub review/check → skill owner/delegate review → 任何official／production immutable release均驗exact A4 `ReleaseApproval` → platform ingest accepted contribution。純內部／non-production snapshot可委派A1／A2，但不用`v*` tag、public GitHub Release、production／Pages發佈或official標識。非code工作走Platform DraftArtifact immutable revision/review/ActionIntent apply。所有tool call透過ActionIntent與idempotency，external refs回寫Provenance。

### 10.3 Tool surface與安全邊界

- `read_work_context/list_work/claim_work/start_run`：A0/A2；Claim屬人/Squad，lease屬AgentRun。
- `create_submission_draft`：A1；只接受typed target proposal與verified／opaque source ref，依grant推導principal；永遠不能confirm／reject或建立正式target。
- `verify_external_source`：A0 provenance step；只容許bound local Agent以current TaskLease/fence讀owner-side exact ref/revision、本機hash並回最小receipt，raw bytes／credential不進Platform。Known failure令run失敗且不能產生任何consequential effect。
- `create_branch/commit/create_draft_pr/run_tests`：A1/A2；GitHub token只含所需repo scope。
- `draft_listing/draft_campaign/draft_sow/submit_evidence`：A1/A2；不直接發布。
- `publish_under_policy/support_under_policy`：A3；驗channel/template/time/count cap。
- `request_signature`：任何Agent可建立request，但A4 execute只接受human signature ref。
- `create_or_change_mandate/out_of_scope_transfer/refund/accept_distribution/approve_qc/apply_contract/release_official_or_production`：固定A4，不提供client override；release action包含所有semver major／minor／patch及production／Pages publication，`execute_transfer_under_mandate`由server驗已簽Mandate與cap後自動執行。

Agent output與tool logs不得包含secret、銀行資料、未授權private Opportunity或聊天全文。Revoke AgentConnection／ExecutionGrant立即停止新ActionIntent；已送外部的未知副作用仍reconcile。Platform保存decision/provenance，不保存chain-of-thought。

### 10.4 SubmissionDraft intake bridge

四種來源共用同一aggregate、同一dedupe算法與同一terminal commands：

| Source adapter | 建立時可信綁定 | 中央只保存 | Raw custody／失敗行為 |
| --- | --- | --- | --- |
| Portal | authenticated user session＋CSRF；organization另驗operator capability | server-derived owner、portal intent ref、revision、digest、typed proposal、必要redacted summary | 本人輸入只依明示purpose保存；validation failure不建draft |
| LINE | verified webhook connection＋delivery/message revision＋active ExternalIdentity | normalized delivery ref、revision、digest、typed proposal | 原文留LINE；未link／ambiguous identity只回link deep link |
| Discord | verified installation／interaction＋guild/channel/message revision＋active ExternalIdentity | normalized interaction ref、revision、digest、typed proposal | 原文留Discord；scope／binding不符不建draft |
| Document/local Agent | user session或bound Agent execution token＋owner-controlled immutable document ref | opaque external ref、revision、digest、media type／size、classification、typed proposal | external-client-owned raw留owner／Squad端點；ref不得含URL credential；confirm不連端點，actual access/digest verification延至bound local Agent run |

`POST /api/v1/submission-drafts`只執行create；service OAuth只授予verified LINE／Discord adapter且scope為`intake.drafts.create`，Agent token另需grant明列`intake.draft`，兩者的owner皆由server binding推導。`GET /api/v1/submission-drafts/{id}`、`:confirm`與`:reject`均做resource-scoped owner／organization operator authorization；terminal writes只接受Portal user session＋CSRF、`If-Match`與Idempotency-Key，不接受service或Agent token。

Source dedupe key由`community + source_type + trusted connection/delivery或document ref + source_revision`正規化後hash。同key＋同source hash回原draft；同key＋不同hash回conflict。Idempotency-Key的canonical request hash不同亦conflict。Confirm重驗owner、target kind、aggregate version，並要求request的`acknowledged_source_ref/revision/content_sha256`逐欄等於saved immutable tuple；文件access-policy若已在Platform明示revoked則conflict。除此之外confirm不dereference external ref、不接觸bytes，也不宣稱source當下可達或未漂移，故端點outage本身不阻擋。在同一DB transaction內呼叫恰好一個`CreateDraftWorkItem`或`CreatePrivateOpportunityStub` owning command並保存target ref；文件WorkItem同時綁exact source requirement。OpportunityStub可維持metadata-only，confirm不授予Agent source access；若日後接受Opportunity並建立的Project／WorkItem要讀文件，該WorkItem須明示複製exact immutable requirement後才能由bound local Agent驗證。reject／expire不得有target。外部訊息永遠不構成A4，confirm也只建立draft/private target，不open、publish、claim、grant、QC、簽約、付款或release。

Event／log／prompt只可出現SubmissionDraft ID、source type、opaque ref、digest、revision、classification、最小redacted summary與result refs；不得包含LINE／Discord全文、external-client-owned document body、可重用下載credential或任意remote fetch URL。需讀外部文件的後續工作由bound local Agent在current grant與TaskLease/fence下，以owner-side authority取得exact ref/revision並本機重算digest；Platform只保存success／known-failure receipt與provenance。`source_unavailable/access_denied/revision_unavailable/digest_mismatch`留下可稽核failure但不建立DraftArtifact／PR／Result／Contribution、不執行ActionIntent，也不產生provider effect。

### 10.5 Opportunity／Service system bridge

CRM、email或Partner系統可只建立private `OpportunityStub`：external ref、kind、owner、privacy scope、next action與最小redacted summary；原proposal/customer transcript留在source system。當團隊決定追蹤才建立Project/Squad/WorkItems。Adapter不得把外部lead自動公開或自動授權Agent讀取。

AI implementation／professional-service bridge只交換versioned refs：Proposal/SOWVersion、Milestone/WorkPackage、DeliveryEvidence/Acceptance、ChangeRequest、SupportPeriod與EngagementAllocationPlan。客戶acceptance與Squad allocation都走A4 exact-digest human signatures。ServicePayable不由GitHub contribution、QC次數或Platform規則自動推算；只有客戶接受exact milestone，且該milestone pinned的active signed AllocationPlan含明示payment trigger時，`opportunities-results`才發布`freedom.ledger.service_payable.accrued.v1`。外部contract/e-sign provider若接入，也必須normalize為同一Signature/ArtifactRef語意。

Canonical write surface固定為：`POST /api/v1/service-engagements`、`POST /api/v1/service-engagements/{engagementId}/sow-versions`、`POST /api/v1/service-engagements/{engagementId}/sow-versions/{sowVersionId}:sign`、`POST /api/v1/service-engagements/{engagementId}/allocation-plans`、`POST /api/v1/service-engagements/{engagementId}/allocation-plans/{allocationPlanId}:sign`、`POST /api/v1/service-engagements/{engagementId}/milestones/{milestoneId}:submit`、`POST /api/v1/service-engagements/{engagementId}/milestones/{milestoneId}:decide`與`POST /api/v1/service-engagements/{engagementId}/change-requests`。Connector只能呼叫這些typed commands，不能以同步CRM row或聊天內容直接建立allocation、milestone acceptance或payable。

## 11. Storefront 接點

Storefront 的 public BFF 由 `freedom-platform/apps/platform-api` 部署並承載 `/storefront/v1`；`freedom-storefront` 是可 fork 的 Master Store/reference client，不是全球商家或另一個可直寫 domain 的 backend。Master Store可不綁Seller且不能checkout；每個實際seller fork/store綁唯一SellerParty。BFF只提供public catalog、checkout intent、purpose-token order/supply status與binding health，將合法command轉給owning module。

### 11.1 Credential 與 binding

- public store client identifier：只識別 store、讀公開 catalog，受 origin/rate controls；它可被看見，因此絕不當 authentication／authorization。
- deploy token：只可建立／更新一個 store/environment binding；不可下單或讀訂單。
- signed checkout token：短效、綁 store/order intent/OfferVersion/nonce。
- server credential：店面 backend 的 scoped client；secret 不進 browser bundle。
- seller binding：`store_mode=seller_store`必須綁唯一SellerParty、collection Connection、support/refund contact；`reference` mode只能browse/fork。

Browser 只把 public client identifier 送到 `/storefront/v1/stores/{publicId}/catalog`，並以 BFF 核發、短效且綁 store/origin/OfferVersion/intent/nonce 的 token 送 checkout；自行架 backend 的 fork 才可持 `orders.create` scoped service credential。兩條路徑最後都由 Platform 伺服器重算價格與 attribution，且只由 Commerce 建 Order。

Binding handshake：

```json
{
  "store_id": "sto_01...",
  "environment": "production",
  "origin": "https://shop.example.org",
  "contract_version": "1.2.0",
  "deploy_commit": "full-sha",
  "challenge": "short-lived-challenge",
  "capabilities": ["catalog.read", "order_intent.create"]
}
```

Platform 驗 challenge signature、origin allowlist、contract compatibility 後啟用 binding。已 fork 的 repo 不能被遠端刪；撤銷只停 scoped handshake/API 與官方 active 標示。

### 11.2 Catalog／checkout contract

- public catalog 可 cache，回 ETag、SellerListingRevision、actual price、advisory MSRP/floor、QC badge、Supplier acceptance validity、availability、唯一Seller/fulfillment/return summary。建議價格不得被client或server當自動拒售門檻。
- checkout intent時Platform重新讀exact listing/OfferVersion、applicable QC signature、DistributionAcceptance、庫存/capacity、Seller `seller_collection` connection與attribution，以server coupon policy算effective item price，並在同一serialized transaction建立短效per-line SupplyReservations。該價必須落在Supplier已接受schedule；絕不使用client傳來的price、seller、supplier payable或commission。
- attribution priority 第一版：accepted manual claim（有 canonical order/payment）或最近 eligible signed link；coupon 另算。確切政策為 versioned ruleset。
- 一次checkout只可含同一SellerParty；不同Seller cart intent先分segment。BuyerOrder可含多Supplier，成立時保存buyer、actual listing/Offer、QC/acceptance、responsibility/split/return snapshots，並在同transaction建立per-Supplier SupplyOrders。
- CORS 只開 active origins；public read 與 privileged write endpoints 分開。

SDK 必須定義 `listing_changed`、`quality_review_missing`、`distribution_acceptance_expired`、`seller_mismatch`、`availability_changed`、`payment_connection_unavailable`、`attribution_invalid`、`contract_upgrade_required` 等 errors 和 UI fallback。

### 11.3 SellerListing／DistributionAcceptance handshake

Canonical aggregate只有`DistributionAcceptance`；「Supplier acceptance／供貨承諾」在本節只表示其decision或accepted revision snapshot，不存在另一個平行aggregate。

```json
{
  "distribution_acceptance_id": "dac_01...",
  "seller_listing_revision_id": "slr_01...",
  "artifact_digest": "sha256:...",
  "seller_party_id": "pty_seller...",
  "supplier_party_id": "pty_supplier...",
  "actual_price": {"amount_minor": "180000", "currency": "TWD"},
  "accepted_effective_price_schedule": {
    "type": "enumerated_or_rule_snapshot",
    "rule_ref": "price-schedule:psv_01...",
    "digest": "sha256:..."
  },
  "price_guidance": {
    "msrp": {"amount_minor": "200000", "currency": "TWD"},
    "recommended_floor": {"amount_minor": "170000", "currency": "TWD"},
    "enforcement": "advisory_only"
  },
  "quality_signature_ref": "sig_qc...",
  "distribution_agreement_version_id": "dav_01...",
  "supplier_decision": "accepted",
  "supplier_signature_ref": "sig_supply..."
}
```

Acceptance API必須把actual price、Seller coupon/discount後可出現的effective item price schedule、Supplier net、fulfillment/return、validity與responsibility matrix一起呈現並綁digest。任何Seller-controlled discount若改有效單價，必須落在已接受schedule或先發新revision；checkout不可有hidden discount。Shipping/tax分項保存，不用來繞過price acceptance。價格/critical term變更即新revision；舊signature不得沿用。Supplier可request changes、decline或對future orders revoke；server以effective time停止新order intent。已建立／已付款BuyerOrder保存原acceptance snapshot，不呼叫「重新確認售價」來逃避既有承諾。

Revoke與reservation create以同一acceptance aggregate version／DB lock或serializable constraint排序：revoke先成功則新reservation失敗；reservation先成功則該reservation僅在`expires_at`前有效，revoke仍阻止後續reservation。Provider checkout session expiry必須`<= SupplyReservation.expires_at`，付款前callback與webhook依provider occurred time再驗。TTL後先cancel intent/session再拒charge；adapter無法強制deadline者不得用於此live flow。若provider違反deadline仍late-charge，進exception後void/refund且不authorize fulfillment。

## 12. Seller collection 與自動 Financial Obligation payout 接點

### 12.1 Payment adapter interface

從既有討論結果，第一個 adapter 可對接 seller-owned ECPay 帳號；正式實作前須以當時官方 sandbox/API 文件確認簽章與事件細節。domain interface 不寫死單一 provider：

```ts
interface SellerPaymentAdapter {
  verifyConnection(input): Promise<ConnectionHealth>;
  createCheckout(input: CanonicalCheckoutRequest): Promise<CheckoutResult>;
  verifyWebhook(rawBody, headers): VerifiedProviderEvent;
  normalizePayment(event): PaymentFactCandidate[];
  getPayment(externalId): Promise<ProviderPaymentSnapshot>;
  listPayments?(range, cursor?): Promise<Page<ProviderPaymentSnapshot>>;
  refund?(input): Promise<ProviderOperationResult>;
}

interface SellerPayoutAdapter {
  verifyConnection(input): Promise<ConnectionHealth>;
  tokenizeDestination(input): Promise<PayoutDestinationRef>;
  initiateTransfer(input: CanonicalTransferRequest): Promise<ProviderOperationResult>;
  getTransfer(externalIdOrOperationKey): Promise<ProviderTransferSnapshot>;
  listTransfers?(range, cursor?): Promise<Page<ProviderTransferSnapshot>>;
  reverseTransfer?(input): Promise<ProviderOperationResult>;
}
```

Collection與Payout可以是同一provider的不同capabilities，也可以是兩個connections。Adapter只取得Credential Broker發的job-scoped capability；input不含raw `secret_ref`、銀行帳號或長效token。Supplier destination使用provider vault/token reference。Provider沒有payout initiation capability時在Connection snapshot明示 `manual_export_only`，不可假裝自動。

### 12.2 Canonical collection → settlement → fulfillment sequence

下列 sequence 是 `authorized_mandate` 路徑：`money_movement_enabled=true`、Payer 對 exact `SettlementMandate` 的 A4 與 Ted 對同一 digest 的付款類一鍵 A4 都存在時適用。每個 Seller 預設的 `record_only` 路徑只建立／對帳明細與人工處理事實，不建立可執行 TransferJob。

```mermaid
sequenceDiagram
  participant SF as Storefront
  participant BFF as Platform Storefront BFF
  participant CO as Commerce/Ledger
  participant JW as Collection/Settlement Worker
  participant CB as Credential Broker/Egress
  participant PA as Seller Payment Adapter
  participant PI as Webhook Ingress
  participant DB as Platform Inbox/Outbox
  participant IW as Inbox/Outbox Consumer

  SF->>BFF: create checkout intent (purpose token + Idempotency-Key)
  BFF->>CO: validate one-Seller cart segment
  CO->>CO: recalc OfferVersion/price/signed obligation-source snapshot
  CO->>CO: atomically create active SupplyReservations with short TTL
  CO->>CO: accept BuyerOrder + create awaiting-payment SupplyOrders + payment job
  JW->>CO: claim job (lease + fencing; gets connection_ref)
  JW->>CB: exchange current lease for scoped capability
  JW->>PA: create checkout through credential egress
  PA-->>JW: provider redirect/session reference
  JW->>CO: complete job with sanitized refs
  BFF-->>SF: sanitized redirect/session result
  PA->>PI: signed payment webhook
  PI->>PI: verify exact raw bytes; discard prohibited body
  PI->>DB: one DB tx: Inbox dedupe + normalized receipt + outbox ID
  PI-->>PA: 2xx after DB commit
  DB-->>IW: dispatcher / Queue wakes consumer with Inbox ID
  IW->>CO: claim current row + normalized PaymentFact command
  CO->>CO: append authorization or paid fact
  CO->>CO: verified paid consumes reservations
  CO->>CO: accrue SupplierPayables + only explicit CommissionObligations
  CO->>CO: create SettlementInstructions from accrued obligations
  CO->>CO: resolve exactly one Mandate bound + atomically reserve cap
  JW->>CO: claim transfer job; recheck Mandate + reservation
  JW->>CB: exchange for payer-owned disbursement capability
  JW->>PA: initiate per-recipient transfer with stable operation key
  PA-->>CO: signed webhook/query-confirmed TransferFact
  CO->>CO: consume cap + settle obligation; SupplierPayable only authorizes fulfillment
  BFF->>CO: scoped order/payment status query
  BFF-->>SF: buyer-safe payment/supply status
```

### 12.3 不變量

- 平台不保存卡號，不代管交易或分潤款。
- 一個BuyerOrder恰有一個SellerParty/payment collector；多Supplier只拆SupplyOrders與SettlementInstructions，不讓買家分頭結帳。跨Seller必須分checkout。
- 純Promoter不向Buyer收款；要收款者必須以SellerParty綁自己的collection並承擔buyer-facing責任。其reseller margin不是CommissionObligation，同人有Promoter身份也不自動雙重計酬。
- `reseller|sales_agent` arrangement snapshot明示seller_of_record、payment_collector、invoice_issuer、refund_owner、price_owner、fulfillment_party；adapter不靠名稱推定責任。
- 同一person／organization Party可同時是Supplier與Seller，但connector仍要求exact arrangement/listing/DistributionAcceptance、唯一Seller-owned collection及獨立QC；不因self-supply省略snapshot或帳本。
- reseller line只有在verified paid且可追到該line的signed DistributionAcceptance revision時，才以`freedom.ledger.supplier_payable.accrued.v1`建立SupplierPayable。Seller retained margin是價差projection，不是commission或另一筆payable。
- CommissionObligation只適用明示sales-agent／referral signed rule及具名beneficiary，發`freedom.ledger.commission_obligation.accrued.v1`；沒有signed rule、只有click／PR／QC／rank都不能建立commission。
- SupplierPayable、CommissionObligation與ServicePayable共用`source_type/source_version/beneficiary/amount/currency`；Supplier與Commission另綁order line，Service另綁ServiceEngagement、accepted milestone及EngagementAllocationPlan。欄位不以null假裝同型，每種producer只寫自己有權的aggregate。
- checkout前每個line均驗exact SellerListing actual price、server-computed effective item price（含coupon/discount）、QC與Supplier acceptance schedule；shipping/tax另列。MSRP/recommended floor只顯示建議，不得實作自動below-floor拒售。Supplier可revoke future acceptance，已paid order按原snapshot。
- Supplier revoke只阻止新SupplyReservations；既有reservation在TTL內保護buyer，payment session deadline不得更晚。Provider occurred time在TTL後的payment不可授權SupplyOrder fulfillment。
- provider transaction unique key 包含 connection/tenant。
- browser redirect／screenshot／client-supplied amount 不足以確認 paid。
- DB/domain money 以 int64/bigint minor unit＋ISO currency；價格、付款、cap、應付與退款 amount 使用non-negative或strictly-positive型別，只有明示delta使用signed型別。JSON wire的`amount_minor`是對應custom format的decimal string，validator同時驗regex、上下界與正負限制；SDK以`bigint`／decimal處理。付款amount/currency必須對上Order容許狀態。
- authorized、paid、partial refund、refund、chargeback 是不同 immutable PaymentFacts。
- payment、fulfillment、order 狀態正交；paid 不等於 delivered。
- create timeout 使用同 idempotency key query/reconcile，不能直接再扣一次。
- partial refund 按 Order snapshot 對每筆受影響原obligation追加`freedom.ledger.obligation.reversed.v1`；不得 update 原 accrual，累計反轉不得超過原額。
- 每一筆 partial refund 都發自己的 `freedom.commerce.payment.refund.confirmed.v1`，可在 `partially_refunded` 自循環；最後累計等於 paid amount 才轉 `refunded`。Chargeback 發 `freedom.commerce.payment.chargeback.recorded.v1` 獨立 fact，reversal 只沖尚未反轉的餘額。
- refund command 的權威 owner 是 Commerce：先驗 buyer/seller scope、RefundRequest/Order state、可退餘額與 currency，再要求 seller adapter 執行。Adapter callback／reconcile 只提出 PaymentFact candidate，不能自行改 Order/Ledger；provider 不支援 refund 時回明確 manual seller path。
- seller connection 分 sandbox/live，分開 secret、external IDs 與 ledger namespace。
- 線下／人工付款先建立 `PaymentEvidence(status=reported)`；不可直接建立 paid projection 或顯示成 provider-verified。只有相對方確認、provider reconciliation 或授權人工 resolve 後，才建立帶 `counterparty_confirmed/operator_resolved` 等級的 PaymentFact。

### 12.4 Settlement automation contract

Commerce connection固定三種purpose：`seller_collection`收Buyer款、`payer_disbursement`從付款方帳戶發起／匯出付款、`beneficiary_payout_destination`標示受益人收款處。底層同一provider account可以支援多個purpose binding，但任何一個connection ref都不授予另一種權限。

每個 Seller 預設使用 `record_only`，平台層預設 `money_movement_enabled=false`。`authorized_mandate` 的 action invariants 包含 Payer 在 Portal 對 exact `SettlementMandate` 完成的人類 A4，以及 Ted 對同一 exact digest 完成的付款類一鍵 A4。Reseller 的 Payer 通常是 Seller，ServiceEngagement 可以另指定付款方。Mandate固定payer principal、payer-owned disbursement connection、allowed obligation actions、每一beneficiary及其purpose-tagged destination、currency、source scope、single/calendar-period cap、IANA timezone、effective/expiry、revocation與exact terms digest。calendar week固定Monday開始。它讓平台在bound內真正呼叫payer-owned provider，不是把「提醒付款方自行匯款」稱為自動化。

同一Mandate的`bound_id`必須唯一；相同beneficiary/destination/currency/action且scope相交的bounds不得重疊，故一個Instruction只能命中一個bound。建立自動ActionIntent前，系統以單一transaction建立`SettlementMandateUsageReservation`：用bound時區算出calendar day/week/month bucket，對`reserved + consumed + 本次amount`檢查period cap及per-transfer cap。併發workers不能共用剩餘額度；provider accepted、executing、result_unknown、reconciling都保留capacity，confirmed才consume，只有尚未送provider或reconciliation證明無外部效果才release。

每個已成立的SupplierPayable、明示CommissionObligation或ServicePayable依immutable source snapshot建立同一種`SettlementInstruction`。共同欄位是obligation type/id、source type/version、payer/disbursement connection、beneficiary/destination、amount/currency、due與unique obligation key；SupplierPayable另帶BuyerOrder/SupplyOrder/order line/split，Commission另帶BuyerOrder/order line/signed rule，Service另帶Engagement/accepted milestone/signed AllocationPlan。沒有matching Mandate時應付仍存在，Instruction停在`authorization_required`而不假裝自動轉帳：

```text
created ── no matching bound ──→ authorization_required ── new signed bound + reserve ──→ ready
   └──── exact bound + atomic capacity reservation + system ActionIntent ─────────────────→ ready
ready ── mandate revoked/expired/superseded ──→ authorization_required（release reserved capacity）
ready → executing → provider_accepted → confirmed（consume capacity）
                  ↘ result_unknown → reconciling → confirmed / ready / authorization_required / manual_required
ready ── provider明示無initiation API ──→ manual_required
```

- Mandate revoke／expire／supersede在每次execute重新檢查：`ready`停止並釋出capacity；`executing/provider_accepted/result_unknown`保留capacity及operation key先reconcile，不盲目重送。
- Timeout／worker crash後先`getTransfer/listTransfers` reconcile，不能用新key再發一筆。
- Transfer confirmed只能由signed webhook、provider query，或雙方/evidence的audited resolution成立。只有SupplierPayable transfer confirmed才由Commerce authorize相應SupplyOrder fulfillment；Commission／ServicePayable settlement不觸發商品履約。已簽credit-term例外帶policy snapshot。
- `manual_required`可產付款檔、deep link與evidence workflow；未確認前只顯示pending/manual，不發布transfer confirmed。若它承接仍reserved的ambiguous transfer，verified evidence確認時必須原子consume該capacity；已因證明no-effect或明示manual fallback而released者不可重複consume。
- Refund/chargeback建立generic FinancialObligationReversal，可另行reverse transfer或依signed source rule抵未來settlement；原obligation、TransferFact與LedgerEvent不覆寫，平台不形成wallet/debt pool。
- Overdue只提醒、列work feed與escalation；不自動封鎖整個Seller。Supplier若要停止供貨，以future DistributionAcceptance revocation處理，不影響既成單責任。

有 `listPayments` 能力時每日／每批比較 provider payments/refunds 與 platform PaymentFacts；沒有 list API 時以 `getPayment`、delivery receipt、status polling 或 seller 匯入報表降級。差異進工作箱，禁止直接以 provider report overwrite ledger。

Payout同樣每日／每批比較provider transfers與TransferFacts；`listTransfers`缺失時以`getTransfer`、webhook、recipient confirmation或Seller匯入報表降級。Reconciliation只追加fact／case，不直接overwrite obligation或ledger。

## 13. 行銷渠道接點

### 13.1 Channel capability contract

每個 `ChannelConnection` 公開 capability snapshot：

```json
{
  "content_types": ["text", "image", "video"],
  "max_text_length": 5000,
  "media_constraints": [{"kind": "video", "max_bytes": 1073741824}],
  "supports_native_schedule": false,
  "supports_delete": true,
  "supports_metrics": ["impressions", "clicks"],
  "required_scopes": ["provider-specific-scope"],
  "adapter_version": "1.0.0",
  "observed_at": "<RFC3339 timestamp>"
}
```

平台 `ContentItem` 是 channel-neutral source；每個 `PublicationJob` 保存 provider variant、connection、schedule、external post ID 與 state。不同 provider 的 impression/reach 不宣稱完全等價；normalized metric 仍帶 provider/definition/version。

### 13.2 發布可靠性

- owner 可選每次A4 exact-content signature，或對某template/connection/time/count明確簽A3 scheduled autopublish grant；這是本人發布設定，不是平台 compliance 審查。每個PublicationJob仍有ActionIntent與content digest。
- provider accepted、實際 published、後續 deleted 分開。
- retry 先查 idempotency/external ID；不能因 timeout 產生兩篇。
- token revoked 設 connection reauth_required，保留 ContentItems/queue；owner 可改 connection 或下載素材。
- 平台 outage 延遲排程時保存 intended_at/actual_at 與 drift，不偷偷改歷史時間。
- prompt context 不能包含私人問卷全文、LINE/Discord 對話、付款資料或 secret。

## 14. 媒體／自動剪輯接點

### 14.1 Upload 與 asset access

```text
begin upload → short-lived multipart signed URLs
→ upload to quarantine prefix
→ complete with expected hash/size
→ MIME magic-byte/decode/limit checks
→ optional scan/transcode
→ promote to owned MediaAsset
```

- object key 由 server 產生；client 不可指定任意 key。
- access 以 owner/purpose/signed short-lived URL；不提供永久公開的 `GET /photo?key=...`。
- `image/*` header 不足以信任內容；SVG/HTML/active content 不同源直接 serve，優先轉成安全 raster 或隔離下載。
- raw、working、output prefix 分開；render 不覆寫 source。
- remote ingest 防 SSRF：allowlisted scheme、DNS/IP recheck、size/time limit、redirect limit。

### 14.2 Provider job 與 quota

```text
request job
→ estimate and reserve quota
→ provider submit
→ callback verify or polling
→ output hash/metadata verify
→ success: consume actual, release remainder
→ failure/cancel: release unused reservation
→ result_unknown: reconcile before charge/retry
```

RenderAttempt 與 RenderJob 分開；retry 保留 job identity，新增 attempt。output 保存 source hashes、timeline/template/prompt/model/renderer versions。Marketing 只引用 `MediaAssetId`，不複製 base64。

Media/publication worker 從 Job API 只拿 `connection_ref` 與 signed input refs；provider call 前依 §5.5 Credential Broker 交換短效、job-scoped capability。任何 fixture、checkpoint、render metadata、FFmpeg command log 或 provider error 都不得落入 Authorization header／token；log redaction contract 是 connector test 的必測項。

## 15. Guild Lounge legacy adapter

Guild Lounge 是 `community-events` 的 migration source／可選活動體驗，不是第九個主模組，也不能使用 positioning/coaching 事件名稱表達現場角色或配對。

### 15.1 Platform → Lounge

Portal 先建立一次性、60 秒內到期且只能使用一次的 exchange code，browser 只把 code 送到 Lounge backend；Lounge backend 經 HTTPS backchannel＋client authentication 交換 activity session。session token 不放 query string、QR、HTML、analytics 或 `localStorage`，以 HttpOnly cookie／server session 保存。

具體入口是 Portal `POST /api/v1/activities/{id}/exchange-codes`，Lounge backend 再以 `activities.exchange` service scope 呼叫 `POST /api/v1/activity-sessions:exchange`。後續 compatibility write 走 `POST /api/v1/internal/activities/{id}/participation-actions`，同時要求 service OAuth 與 redacted `X-Activity-Session` proof，並帶 Idempotency-Key、If-Match／body expected version；body 不接受 `user_id`。如此 guest 與 linked user 使用同一 application command，又不把 Portal cookie 或全能 host token交給 legacy browser。

```json
{
  "community_id": "com_01...",
  "activity_id": "act_01...",
  "session_id": "ase_01...",
  "actor": {"type": "user", "id": "usr_01...", "acting_as": "participant"},
  "participation": {"participation_id": "par_01...", "state": "registered", "aggregate_version": 1},
  "activity_session_token": "short-lived-scoped-token",
  "aud": "urn:freedom:activity-lounge",
  "scopes": ["participation.write", "encounter.write"],
  "public_config": {
    "registration_open": true,
    "wall_enabled": true,
    "matching_enabled": true,
    "badge_download_enabled": true
  },
  "contract_version": "1.0.0"
}
```

Guest 使用 `actor={type: activity_guest, id: agt_..., acting_as: participant}`，ID 只在該 activity 有效，不借用假 `user_id`。QR 只帶 activity entry slug／opaque code，不帶 exchange code、participant edit secret、照片 key 或 host token。Legacy UI 過渡期由 compatibility backend 代換舊 token；cutover 後關閉舊 query-token endpoint並 rotate secret。

### 15.2 Lounge → Platform

- activity registration/participation。
- event-local presentation role、raw skill labels、social-energy preference。
- wall/matching preference、presence。
- directed match assignment 與 encounter self-report 分開。

Host 從 Portal 以 scoped capability 建 `POST /api/v1/activities/{id}/match-rounds`；server timer 以 `activities.round.write` service identity 和 expected version 呼叫 `POST /api/v1/match-rounds/{id}:complete`。Participant 自己的 encounter 可在 Portal 呼叫 `POST /api/v1/encounter-reports`，或由 Lounge backend 以 `activities.encounter.write`＋同一 activity-session proof 呼叫 `POST /api/v1/internal/activities/{id}/encounter-reports`；兩條路徑共用同一 dedupe key／`community_encounter_report` aggregate owner，均不把 assignment 自動當 encounter。

新增 canonical events：

- `freedom.community.activity.registration.recorded.v1`
- `freedom.community.activity.participation.updated.v1`
- `freedom.community.match.round.completed.v1`
- `freedom.community.encounter.reported.v1`

禁止把 directed assignment 發成 `freedom.coaching.enrollment.matched.v1`，也禁止把「系統指向某人」自動記成雙方已見面。

### 15.3 安全與退場條件

- display 使用 `display.read` credential；check-in、round control、archive 各自 scope，不保留全能 host token。
- participant create 用 DB unique constraint/transaction，防止兩個 token 都 200 且覆寫內容。
- 照片搬到 MediaAsset signed access，拒絕 arbitrary R2 key 與 active SVG。
- server 擁有 countdown/round completion，big screen 不再是 timer owner。
- `reset` 改 archive activity＋明確 retention action，不清全域會員或無法確認的 object set。
- legacy endpoint 只在 migration window 保持 compatibility，記錄 contract version、error mapping、deprecation 和 cutover 日期。

## 16. Integration 資料最小化矩陣

| 接點 | 平台保存 | 預設不保存／不傳播 |
| --- | --- | --- |
| LINE | tenant-scoped subject、link、message ID、delivery、opt-in、明確 checkpoint | 私聊全文、通訊錄、無關 profile |
| Discord | user link、guild/channel/thread/event IDs、interaction fact、deep link | 頻道全文、私訊、voice presence 當成果 |
| Document intake | opaque owner-controlled document ref、revision、digest、media type／size、classification、access-policy ref | external-client-owned文件原文、可重用URL credential、任意remote fetch、文件全文進event/log/prompt |
| GitHub | stable repo/user/install IDs、commit/hash、manifest、PR/issue refs | access token 明文、整個 repo 複本、commit 數當資格 |
| Agent CLI | client/principal、acting profession、context hash、grant/signature/tool/action/output refs | chain-of-thought、完整私聊/定位原文、secret、未授權Opportunity |
| Payment | seller collection/payout connection refs、recipient destination token ref、provider payment/transfer refs、amount/status/hash；ordinary domain tables 只存 opaque credential ref | 卡號、銀行帳號、provider secret 明文、完整不必要 payload；provider-managed credential 留在 provider，必須由 Platform 代理的動態 token 僅能 envelope-encrypted 存於隔離 credential vault |
| Storefront | origin、deploy commit、contract health、canonical checkout/order refs | DB credential、admin token、他店訂單 |
| Marketing | publication ID、content/version、metrics definition | 私人問卷／聊天、付款／銀行資料進 prompt |
| Media | owned object refs、hash、metadata、lineage、job cost | 永久公開 key、secret、無限期 working files |
| Guild Lounge | activity participant、event-local choices、assignment／encounter facts | nickname/photo 自動合併、活動角色變權限 |

## 17. Provider outage 的使用者 fallback

Portal 不重做聊天，但核心 command 必須有最小 web fallback：

| 外部接點失效 | 仍可做 | 暫時做不到／真實文案 | 恢復後 |
| --- | --- | --- | --- |
| LINE Login | guest 瀏覽／assessment；已有 session 繼續使用；可切另一已驗 identity | 新 LINE 驗證／訊息送達；顯示「LINE 暫時無法連線」 | 完成 callback/link，不重建 User |
| LINE Messaging | Portal 看 Next、回報 checkpoint、查單／求助 | 即時 LINE 提醒／真人對話捷徑 | 只補送仍有效且符合偏好的通知，不重送過期轟炸 |
| Discord | Portal 查活動、Skill、Opportunity、session agenda；下載資源 | channel 討論／語音現場 | binding reconcile/rebind；不補造 attendance/message |
| Owner document endpoint | Portal仍可看、acknowledge exact saved tuple並confirm／reject既有SubmissionDraft，或另行手動建立；confirm明示尚未驗current source | bound local Agent不能讀raw文件、submit source-derived output或執行consequential ActionIntent；run記`source_unavailable`且零 consequential effects | owner恢復端點／grant後由新的current-lease run重驗同ref/revision/digest；不同bytes必須新revision／新進件，不能覆寫原draft或把舊confirm當驗證 |
| GitHub | 看已發布 immutable Skill snapshot、下載既有 artifact／文件 | 新 repo import、PR/commit sync | 依 stable repo ID reconcile；不重複 Result candidate |
| Agent provider／CLI | Portal自行看Feed、Claim、review/sign；既有AgentRun可取消 | 自動tool execution；不把provider outage當會員失效 | 沿ActionIntent/TaskLease恢復，不重複副作用 |
| Collection provider | 保留 Order intent、查狀態、選 Seller 提供的人工付款路徑 | 不顯 paid、不重扣；新 checkout 可被 scoped pause | query/reconcile 後追加唯一 PaymentFact |
| Payout provider | 保留 SettlementInstructions；只有Connection明示`manual_export_only`才進`manual_required` | 不宣稱受益人已收；不因Commission/Service付款觸發商品履約 | 沿同operation key reconcile/execute，追加唯一TransferFact |
| Marketing channel | 編輯／下載 ContentItem、取消未送 job | 外部 publish/metrics | 先查 external ID，再 retry，避免重貼 |
| Media provider | 上傳、保存 project/timeline、使用既有 outputs | 新 transcript/render | 從 checkpoint 重試，quota effect 收斂 |
| Guild Lounge companion | Portal 活動名單／人工報到表／主持人下載備援 | 即時牆／自動配對視覺 | 匯入 event-local facts；不依暱稱猜 User |

「仍可做」只包含狀態、表單、deep link 與人工接點，不在 Portal 複製 Discord 討論或 LINE 即時聊天。

## 18. Connector contract tests

每個 connector 必須共享以下 fixtures：

1. valid event、invalid signature、過期 timestamp、replay。
2. duplicate delivery、同 payload 不同 delivery、同 delivery 不同 payload。
3. events out of order、callback before local poll、resource deleted after queue。
4. 429 with Retry-After、timeout before/after provider acceptance、5xx、permanent 4xx。
5. token refresh success/failure、scope removed、owner disconnect。
6. provider display name/URL change而 stable ID 不變。
7. dead-letter repair/replay 不產生重複 domain effect。
8. log/trace snapshot 不含 secret、完整 PII 或聊天正文。
9. connection degraded 時 Portal fallback 仍可完成核心動作。
10. reconciliation 找出 missing/mismatch，修復後 canonical facts 收斂。
11. `no_receipt` connector 在 `accepted_no_receipt` terminal 收斂；有 receipt connector 才等待 delivered，reconciling 的五種出口都有 fixture。
12. worker 只見 connection ref；Credential Broker exchange 的 stale lease、錯 audience/scope/community、revoked connection、rotation 與 log redaction negative tests 全通過，回應結構不得含refresh token。
13. Agent Operation Registry拒絕client把A4降級；expired/revoked grant、wrong principal/acting role、changed digest、同人假冒獨立review與TaskLease/Claim分離均有negative fixtures。
14. 每個ActionIntent在Agent/worker crash、CLI更換與provider timeout後仍只有一個external effect；unknown先reconcile。
15. Agent device code的wrong client-instance proof、denied/expired approval與重播都不發token；AgentConnection refresh驗sender-constrained proof並原子rotation，舊refresh material併發／重播最多一個成功。Connection token只有`agent.bootstrap.read`並只能讀本人最小Status／Feed，不能執行A1–A3 typed work；只有同Connection的active grant可mint短效execution token，且A4 scope無法寫入兩層token。
16. Person WorkContext只回member WorkIntent basis；organization WorkContext缺policy、具名operator或operator ProfessionMembership即拒絕，並有「不得偷帶個人定位／私人WorkIntent」的schema與authorization negative fixture。
17. Exclusive WorkItem併發claim只有一個成功；collaborative／competitive依pinned capacity可有多個獨立WorkClaims。任一Agent TaskLease expiry／reclaim都不改WorkClaim owner或別人的submission。
18. `ActionIntent:execute`只接受registry allowlisted typed command；wrong token/grant/lease/fencing、stale aggregate、changed artifact/consequence digest與missing A4 basis均無domain或provider side effect。
19. Submission intake涵蓋Portal／LINE／Discord／document四個正例，以及未link／ambiguous external identity、spoofed owner、同source同hash replay、同source異hash、同Idempotency-Key異request、confirm-vs-reject競態、stale version、acknowledged ref／revision／digest不符、Platform已知access-policy revoked、service或Agent token嘗試terminal command、raw內容／credential進event-log-prompt的反例；只有owner Portal command可建立恰好一個draft WorkItem或private OpportunityStub。Document endpoint offline時exact acknowledgement仍可confirm且confirm不得fetch／聲稱驗證；OpportunityStub不能被當source authority。後續bound local Agent的unavailable／denied／missing revision／digest mismatch各自保存failure receipt並保持零 consequential effects；success receipt只是fenced provenance且不能繞過review／A4。

額外驗收：

- Payment：one Seller checkout/multi-Supplier SupplyOrders、verified paid建立每line SupplierPayable、Seller margin不成commission、只有signed referral rule建立CommissionObligation、partial/full refund generic obligation reversal、三種connection purpose隔離、Mandate overlapping-bound拒絕、併發cap reservation、revoke race、transfer confirm/result unknown、manual-required與collection/disbursement/payout-destination每日差異。
- Service：SOW與AllocationPlan逐方exact-digest簽名、milestone submit/accept/change、只有pinned signed payment trigger建立唯一ServicePayable，以及community QC／PR不得建立ServicePayable的negative fixtures。
- Agent：WorkContextBundle最小化、A0–A4、GitHub draft PR、platform DraftArtifact create/revise/review/apply、`ChangeProposal`不得成第二aggregate、human exact-digest signature、revoke與provenance replay。
- Intake：四種adapter都只建立同一owner-private SubmissionDraft；document原文留owner端，LINE／Discord原文留provider；confirm／reject resource authorization、exact saved-tuple acknowledgement、source dedupe與terminal race fixture全通過。External document confirm不是reachability／bytes proof；OpportunityStub沒有Agent source authority。只有bound local Agent其後的exact-ref/revision本機digest success receipt才解除source-bound run的output／consequential-action限制，且receipt只是fenced assertion、不替代review／A4；failure只記provenance且零 consequential effects。External message永遠不被當成A4。
- GitHub：rename/transfer/private/delete、same version different hash、PR webhook 亂序。
- Discord：channel delete、bot scope removed、attendance 不產生 skill result。
- LINE：login/link conflict、unfollow、重複 postback、quiet hours。
- Storefront：origin/CORS、price tamper、contract drift、官方模板與 fork。
- Marketing：重試不重複貼文、metric 定義不混用。
- Media：偽 MIME、SVG、壓縮炸彈、大檔、callback 遺失、quota reservation。
- Lounge：0/1/2/3/奇數人、退出、重複輪次、server timer、照片授權、concurrent create。

### 18.1 低維運互惠接點增量

新條款與實益API見OpenAPI及`work-participation.schema.json`。`PUT participation-terms`以原Work owner、CSRF、If-Match與idempotency產生revision；Agent只能在明示grant內草擬，不能虛構當事人容量、金錢或簽名。Claim必須綁閱見的terms revision/hash；legacy明示unclassified，不默認有真人服务。

`POST benefit-observations`只接受本人session／有權組織代表，不接受Agent token或LINE／Discord訊息直接確認。Reporter與role由server按當事人關係驗；重送不增量，改版用新revision。私密gain與工時只向本人、相關授權角色及去識別統計投影開放，不放公共Feed或外部通知全文。

普通提醒採opt-in摘要、scope＋episode去重及一次回饋提醒上限，不建立無限Council補位卡。付費履約、付款、安全與正式權益通知維持原有責任及升級路徑。所有副作用仍遵循ActionIntent／outbox／重送規則；新增靜態測試不能冒充真通知或授權E2E。

## 19. 每個新 connector 的 Definition of Ready

新接點開始 coding 前，PR 必須回答：

- provider 與 platform 各自擁有哪些 source of truth？
- Connection/Binding type、最小 OAuth/API scopes、secret owner 是誰？
- worker 使用 provider-native short-lived token 還是 broker egress proxy？aud/scope/TTL、rotation、revoke 與 redaction contract 是什麼？
- inbound/outbound schema、唯一 ID 與簽章如何驗？
- success、accepted、delivered、failed、result_unknown 各代表什麼？
- idempotency、retry、out-of-order、rate limit 怎麼處理？
- 哪些資料是 PII，保存多久，會不會進 event/log/AI prompt？
- provider outage 時會員仍能完成哪條 Portal fallback？
- reconciliation API／報表／人工途徑是什麼？
- disconnect、resource delete、repo transfer、帳號被 block 後如何降級？
- mock/sandbox/fixtures/contract tests 與 production credential owner 是否就緒？
- 若是Agent tool：所需A-level、human signature、acting profession、WorkItem/Claim/TaskLease、ActionIntent與可見provenance是什麼？
- 若會動錢：是哪一種SupplierPayable／明示CommissionObligation／ServicePayable、signed source version、seller collection／payer disbursement／beneficiary destination各由誰持有、Mandate及usage-reservation limits、refund/chargeback generic reversal與「平台不持有資金」如何成立？

缺少上述答案時可以做 spike，但不能宣告 connector production-ready。
