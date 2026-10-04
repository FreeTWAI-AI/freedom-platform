# Freedom Unified Foundation
## R2 × Autopilot × Extension × neo：共同基礎、跨 Repo 契約治理與相容性總計畫

版本：`1.1-design` · 日期：2026-10-01（America/New_York）  
狀態：**整合設計提案；未修改程式、資料庫、GitHub、Cloudflare 或部署。**  
建議納入：`docs/plans/unified-foundation.md`


### 1.1 修訂重點

本版在原共同基礎上補入 **§23–31 共同開發治理**：中央契約與 library 發布、既有鎖檔擴充、CodingContextBundle、每頁／每入口對應、可信 PR 驗證、跨 repo 升級與用途分離的 key 規範。新增 CG-01～08 決策、CG-A～G 工作包與 GOV-01～32 驗收要求；保留原 UF-01～12、U0～U7／UX 及 INT-01～28。

**原1.0查核基準是歷史來源，不是本輪重新確認全部repo的最新head。** 本輪另外讀取 platform 的 AGENTS／repositories.lock、Agent Kit 的 contracts.lock／verify-contracts，取得的單檔blob列在§31.5。未重新驗證所有GitHub保護設定、雲端資源或產品執行。

本輪只建立更新後的Markdown與HTML。所有新增工具、library改造、ReleaseSet簽章、可信check與32项產品測試都屬待實作；不代表已部署、不代表Agent必然理解文件，也沒有替使用者修改GitHub或分享秘密。

> 一次改對，指的是一次把身分、資源、業務操作、成果、執行與版本邊界設對；不是一個巨大 PR，也不是保證以後所有 API 都不再改。

本文件整合兩份已讀取全文的來源：

- **[R2]** `freedom-platform-restructure-plan-2026-10-01.md`，1.0，1006 行，查核基準 `3de70ccbd24362a7925508fb42d36aaa256a0806`。
- **[AP]** `Freedom-Autopilot-vNext-Spec-2026-10-01.md`，0.1.0-design，1810 行；platform 基準 `c78efb93cbf47f0812e17006c47413001b649a40`、BrowserOS neo 基準 `53c3799ce014e9fee05569802314a05d0bad3e40`。

本輪重新讀取 platform branch API，main 仍回報 `3de70ccbd24362a7925508fb42d36aaa256a0806`；重新讀取同版 `packages/db/index.ts`。這是 repository 查核，不是 production release 或私人 overlay 的驗收。neo 的程式觀察沿用 [AP] 已列出的固定版本與查核深度，本輪沒有重新建置或完整稽核 neo。

本文件對兩份設計的**交集**提出明確修訂；未修訂部分繼續沿用原章節。正式採納時應更新原 canonical 與兩份文件的交叉引用，不讓三份文件各自維護不同規則。下文新表名、目錄、狀態與工作包是建議的目標，不代表目前存在。

---

## 00. 決策摘要

### 00.1 直接採用的共同方向

1. 平台維持 modular monolith：React/Vite、Hono、Workers、Hyperdrive、PostgreSQL。R2 現在導入，不延後到用量變大。
2. 中央 PostgreSQL 保存業務、授權、工作與執行狀態；R2 保存**允許由平台持久化的**內容 bytes；client journals 保留必要的本機 dispatch／replay 事實，不成為第二份工作真相。
3. 先建立 `Principal + ResourceScope + Command` 共同基礎，再接 R2 媒體與 Autopilot；不能先做只認 member session 的新儲存模組，隔週再重寫一次。
4. 一份中央契約，三種 client adapter；不另建 browser protocol canonical repo，不把 neo 的 stack 搬到 platform。
5. 一份 WorkItem 真相；社群工作、私人工作、網站服務工作有不同規則，但不複製三套 Work 系統。
6. 明確增加 `RunAttempt`：run 是邏輯執行，attempt 固定裝置、Grant、模型與付費來源；交接不能原地改掉已發生事實。
7. 正常 merge 是人授權的確定性操作，AI 只处理需要理解的修復。CI 與 guardrails 使用同一模組／操作映射，不建立一堆同義閘門。
8. 針對新增的非同步 Autopilot 工作，建議本輪採 Cloudflare Queues 作通知／投遞；它不是工作真相、權限伺服器或瀏覽器 executor。這是擴大範圍後的明確修訂，不是聲稱 R2 原計畫已要求 Queues。

9. 共同repo治理依§23–31：固定契約／library／policy組合、分層開工上下文、最終PR獨立驗證；共用公鑰驗證規則，不共用provider／簽章／部署秘密。

### 00.2 本輪不擴大的範圍

不重寫會員制度、強制全員換 browser、增加第二 DB、引入 Redis/Kafka/Temporal、建通用任意腳本 workflow engine、全面改 Chromium renderer、把 runtime-local content 一律備份上雲，或用平台 key 偷補會員額度。原本的公會加入流程、社群 self-claim／獨立驗收規則、正式發布／付款／法律承諾的人類邊界不因抽象化而消失。

### 00.3 優先修訂清單

| UF 決策 | 原設計切面 | 本輪統一方式 |
|---|---|---|
| UF-01 | [R2] media 固定 community／member；[AP] 有 person/service | 共用 Principal／ResourceScope，舊會員映射保留 |
| UF-02 | [R2] finalize 驗 member session；[AP] 要 machine principal | 三種入口驗證、一個交易內核，不能建 fake session |
| UF-03 | [R2] MediaAssets；[AP] 各種 artifact refs | 一個 Asset 儲存生命週期；Result 是業務成果關係，不是另一個 blob store |
| UF-04 | [R2] 全媒體 R2；[AP] 有 local-only data | 平台持久化內容進 R2；不允許上雲的內容只留受控本機並使用 local ref |
| UF-05 | [AP] run 固定 runtime/model，後文又可交接 | 新增不可變 binding 的 RunAttempt；同 Work／Run 接不同 attempt |
| UF-06 | [R2] upload intent；[AP] ActionIntent | 共用識別／稽核／冪等原則，保留各自狀態機，不做一張萬用 intent 表 |
| UF-07 | [R2] storage-only 不需要 queue；[AP] 非同步 model step | 用 Queues 喚醒 PG outbox jobs；Stop／授權不依賴 queue |
| UF-08 | [R2] 不增加無理由服務；[AP] vault 隔離 | broker Worker 是有理由的秘密邊界，主業務不微服務化 |
| UF-09 | [R2] timestamp migration；[AP] next sequence | 全部沿用同一相容 migration v2，不再兩套编号 |
| UF-10 | [R2] App／API 拆責任；[AP] 新增 UI／routes | 在同一 shell／route safety profiles 接新端，禁止再長出例外鏈 |
| UF-11 | [R2] 確定性 merge；[AP] Agent 可做工具操作 | merge 走既有審查資格與原生權限，不借通用 Agent Grant 繞過 |
| UF-12 | 兩份計畫分別定義 rollback | 合併 R2、private ACL、機器身分、契約及 recovery epoch 的最低相容版本 |

---

## 01. 目標架構：共用核心，不是共用所有 runtime

```text
                    人的 Web 工作桌面
                             │
        ┌────────────────────┴────────────────────┐
        │       現有 Platform Worker / Hono        │
        │  人類 API │ execution API │ site API    │
        │  認證入口 → Domain policy → Commands    │
        │                                         │
        │  身分／Scopes   Work／Result   Assets    │
        │  Grant／RunAttempt／Control／Intent      │
        └───────┬──────────────┬───────────┬───────┘
                │              │           │
          Hyperdrive       私有 R2     已提交 Outbox
                │          / Images        │
           PostgreSQL                      ▼
          唯一中央事實                  CF Queues
                │                          │
                └── 狹義 Job/Step 狀態 ─────┤
                                           ▼
                                Private Credential Broker
                                窄 DB role / KEK / provider

  Chrome MV3 ← 同一 execution contract → Freedom neo
      │                                     │
      └── 選配 Native Host / Freedom Agent Kit ┘
                    │
           本人官方 CLI 或本機 API adapter

  Maintainer Worker / Admin-sync Worker 保留原本秘密與責任隔離。
  未來 Cloud Runner 只增加 runtime adapter；不建立第二份 Work/Grant/Asset。
```

這張圖是責任圖。不是每個方塊都建立新 Worker，也不是讓每支 Worker 得到所有 bindings。Platform 仍組裝業務模組，broker 單獨部署的理由是 provider secret custody；媒體工作不進持有 GitHub App private key 的 Maintainer Worker。

`model engine location`、`browser actuator location`、`provider processing location`、`artifact custody` 是四個不同欄位。CLI 程序在本機，不能自動把實際模型服務分類為本機推論；R2 不存內容，也不代表內容沒有被送給外部模型。

---

## 02. 身分與資源範圍：本輪最先定的契約

### 02.1 三個不同問題

| 概念 | 回答什麼 | 不能推定什麼 |
|---|---|---|
| Principal | 誰擁有／行使權利：person 或 service | 有 person ID 不等於可看同社群所有私密資料 |
| ResourceScope | 資源屬於哪個安全範圍：community、personal、site | scope 不等於 public visibility，不是一把通用權限 |
| Invocation | 這次如何驗身分、由哪個 executor 代誰做事 | 呼叫端傳來符合 TypeScript 形狀的 JSON 不等於已驗證 |

第一輪 person principal 與現有 user 一對一映射，保留原 user_id/community 關係。不以 email 相同自動合併跨社群身分，不趁此導入全站 SSO 重建。網站先有明確 owner／SiteApplication，再建立其 service principal；不要用假的會員列滿足舊 FK。

### 02.2 建議資料結構

- `principals`：principal_id、kind、status，以及受約束的 user_ref 或 site_service_ref；person/service backing record 明確互斥。
- `resource_scopes`：scope_id、kind、owner_principal_id、community_ref 或 site_application_ref、status。各 kind 的欄位以 CHECK/FK 驗證，不接受任意 type 字串。
- 既有社群資料回填 community scope；私人 Work 的 scope 由 server 依本人決定；網站服務資料由已驗證 SiteApplication 導出。
- `scope_id` 的不透明性不是授權。新表的 typed references 要同時驗 scope，不能只檢查 UUID 存在。
- 權限 owner 仍是 membership/work/events/commerce 等 domain。Scopes 不複製一份會長／好友／活動可見性規則。

對既有社群表不要求一次全倉把 community_id 改名。先做一個受測的映射入口；新 Asset／Execution 契約使用 scope_id，舊 domain adapter 保留已建立的 community invariants。

### 02.3 Invocation 必須能追溯但不洩密

實際紀錄分清 `subject_principal`（授權主體）、`initiated_by`（發起者）、`executor`（裝置／service connection）、`on_behalf_of`（有明確 delegation 才存在）、`authn_kind`、`operation_id`、`scope_id`、Grant／attempt references。

已驗證 context 只能由 server/native auth module 建立。TypeScript branded type、Rust private constructor 是防誤用工具，不取代 credential 驗證、current state 檢查或權限。

site key 不可帶一個 user_id 就代表他；只有 bootstrap user key 不能控制 browser；provider key 也不能代表本人可讀某個資源。[AP §4.2–4.6]

---

## 03. Command：共用交易，不共用假的真人登入

目前 `command()` 在交易內檢查 active user、member session，並在重播 receipt 前重新執行 authorize；journal 也帶 user/community。這些實際規則不能因 Agent 接入被繞過。[CODE-01]

### 03.1 最小相容改法

```text
舊 command(...) ───→ memberCommand ──→ member session validator ──┐
executionCommand ──→ run/attempt/grant/device validator ──────────┤
serviceCommand ────→ site/service scope validator ────────────────┤
                                                                ▼
                                            transactionalCommandCore
                                       current authority / idempotency
                                       version / domain mutation / audit
```

保留舊呼叫 signature 作 wrapper；不要求所有功能 PR 同時改完。交易核心依赖小型 auth port／neutral types，不反向 import 整個 agent-execution 或 identity service。驗證器在同一個 q 上執行當下授權；不是在交易外建立 VerifiedContext 後永远信它。

新 command receipts 使用明確 principal／authn／operation namespace；歷史 receipt key 與 digest 算法不改。密鑰簽發的原始 secret 不可進普通 response JSONB receipt；用專用一次性交付策略。

### 03.2 各操作驗什麼，不可一律要求模型 ready

| 操作 | 必要檢查 | 不應增加的依賴 |
|---|---|---|
| 開始／推進新的 AI step | 本人模型 binding、Grant、當前 attempt/runtime、scope、budget、data policy | 不得 fallback 網站 key |
| 保存正常人類頭像 | member session、domain 權限、版本、upload intent | 不需先有 AI run／模型 key |
| Agent 提交新的業務修改 | current Grant、attempt、版本、typed operation | 不得借人類 cookie |
| Pause／Stop／Revoke／修 key | 合適的人類／裝置控制權 | 不以 provider 正常為前提 |
| 晚到 receipt／unknown 對帳 | 有限 evidence-submission 身分、已存在 dispatch、來源及大小限制 | 模型過期不應使證據永久無法提交 |
| 重新讀取私人成功 receipt | 當前讀取／主體權限 | 不因之前曾成功就回舊私密內容 |

晚到 evidence 只能新增「觀察／待核對」，不能靠這條路重啟 effect、修改 Grant 或直接將業務改成 accepted。已撤銷 runtime 可由另外定義的最小 receipt-only capability 或 owner-mediated 流程提供證據；不能保留它的通用 execution token。

### 03.3 交易與外部 I/O

R2、Images、模型、GitHub、browser actuator 都不在持有 domain row locks 時執行。共用 prepare / effect / finalize 思路，但不要求每個 operation 都用同一張 intent 表。鎖順序由共享核心與各 typed flow 明確定義、用交錯交易測試驗證；不把整個平台所有工作鎖成單一串行佇列。

---

## 04. Work、Run、RunAttempt：先把交接語意補完整

### 04.1 同一份 WorkItem

WorkItem 增加已提出的 work_mode；保留原 ID 與 community collaboration 行為。私人工作不用虛構自己認領自己的 WorkClaim；網站服務工作不假裝是一位普通會員。[AP §1.4]

私人模式上線前，所有 list/detail/search/dashboard/notification/event/export/artifact read 都必須先有 ACL。UI filter、route 名字叫 autopilot，或只保護詳情頁，都不够。旧客户端的協作列表應明確只投影它理解的 community collaboration，不把新狀態枚舉硬丟給舊 UI。

### 04.2 新增 RunAttempt，而不是原地改 run 的 runtime

```text
WorkItem：要做成什麼
  └─ Run：一次邏輯執行
       ├─ Attempt 1：本機 Chrome + 本人 CLI + Grant rev A
       │     └─ intents / receipts / results / inference attempts
       └─ Attempt 2：neo 或雲端 runner + 明選模型 + Grant rev B
             └─ 新控制版本，不能重用 Attempt 1 的 permit
```

新增 `run_attempts`，欄位至少包含 attempt_id、run_id、attempt_number、runtime_id、connection_id、grant_revision、inference_binding_ref、data_policy_revision、state、started_at、ended_at。實際 run/attempt relationship 在 FK 與 uniqueness 中強制。

`InferenceBinding` 在 attempt 內不可默換。改裝置、付費來源、provider custody 或不相容 policy 時先 fence 舊 attempt，再開新的。Work 和邏輯 Run 可連續；不能將已執行記錄的 runtime_id/billing_source UPDATE 成新值。

普通 provider retry 不是新 RunAttempt；它是同一 step 的 inference_attempt，保留 unknown charge 與 provider request evidence。重新規劃若仍有未知外部 effect，不能靠新 attempt 把未知狀態清掉。

### 04.3 控制版本不能混用

- Task lease epoch：哪個執行 attempt/connection 目前可推进。
- Control epoch：哪個 agent/human 目前可控制特定 browser resource。
- Grant/policy revision：本次批准的權限與規則版本。
- Deployment recovery generation：恢復後旧 token/lease 是否仍可能有效。

Permit 綁定上述相關版本及 target incarnation。相同 browser profile/tab 的重疊 scope 必須解析成同一控制資源；不能靠換一個字串 resource_id 繞過互斥。互不重疊的工作則可並行。

### 04.4 接手與不可逆副作用

Stop 先在本機封鎖尚未執行操作，再回報平台；遠端 offline 不可說已停止。Takeover 要等待已發出 effect 的結果收斂或明確 unknown，再顯示可安全接手的範圍。Resume 重新觀察頁面／帳號／generation，不能拿舊 node ref 接著操作。[AP §4.9–4.10]

平台不能保證對不提供冪等機制的外站 exactly-once；「同 intent 不再 dispatch」和「外站一定只執行一次」是兩件事。

---

## 05. Assets：這次直接做成媒體與工作成果的共同基礎

### 05.1 修訂原 MediaAssets 的中心概念

若尚未落 code，建議以 `modules/assets/` 作共同模組，`modules/media-assets/` 僅作七類媒體 profiles/legacy adapter 或不另建。若已有人完成 MediaAssets，保留相容 export，不為改名製造重寫。重要的是下列責任，不是目錄名稱。

| 物件 | 責任 |
|---|---|
| Asset | 平台已登錄的一個內容版本、scope、owner、purpose、狀態與 policy |
| AssetObject | R2 representation：object key、variant、MIME、大小、digest、轉換版本 |
| ArtifactRef | 跨端引用內容的 wire type；不暴露 bucket credential／私有路徑 |
| WorkResult | 該內容是什麼工作的哪次結果、來源、證據等級、是否提交／由 domain 接受 |
| Domain pointer | 頭像、活動、技能書、商品等對目前版本的 typed 引用與原有 ACL |

檔案 ready 不等於工作 completed；Result submitted 不等於人類驗收、正式發布、實收款項或 XP。

### 05.2 最小新增欄位與約束

`assets`：asset_id、scope_id、owner_principal_id、purpose、created_by_invocation_ref、state、content_policy_revision、created_at、retired_at、delete_after。

`asset_objects`：asset_id、variant、logical_store、object_key、content_type、byte_size、content_sha256、etag、transform_profile_version、verified_at。

`asset_upload_intents`：intent_id、principal/scope、operation、target typed ref、expected_version、attempt_id（適用時）、request_digest、asset_id、lease_token、state、expires_at。

`work_results`：result_id、work_id、run_id/attempt_id（人工成果可無）、artifact_ref、result_revision、provenance、evidence_level、submitted_at。接受／公開仍由其 owner domain 的 command 控制，不另造含所有商業狀態的萬用 result engine。

Typed links 至少維持 scope consistency；保留 domain FK，不把所有關聯改成任意 `owner_type/owner_id` JSON。新增 purpose 要帶 validation、custody、download policy，不是接受任意 bytes 就算支援新格式。

### 05.3 Cloud 與 local 的 ArtifactRef 分支

```text
platform_asset:
  asset_id + content revision + safe representation/digest
  → 平台驗當前 domain/Work ACL → 私有 R2

runtime_local:
  runtime_id + opaque local handle + revision + 允許的 integrity metadata
  → 該 runtime 的受控 local reader
  → 不表示平台 R2 有副本，也不保證 runtime 離線仍能取得
```

這是邏輯形狀，不是已正式發布 JSON Schema。local handle 不得是供外部自由指定的 OS path，也不能拿它讓 broker 去讀檔。禁止上傳 metadata 本身的情境，中央只能保存必要非敏感工作狀態或明示 unavailable；不能以「只是 hash／路徑」保證沒有資料洩漏。

舊 DB media bytes 搬遷到平台 Asset；[AP] 的 private draft/artifact 也直接使用它。不得另生一個 `agent_files` blob table、單獨 filesystem server 或另一種 S3 連線方式。

### 05.4 R2 resources 與權限

沿用每環境 private asset bucket，backup bucket 分離。可沿用既有建議 media bucket 名稱，binding 邏輯稱 ASSETS_STORE 或 MEDIA 由一次契約決定；不為改名搬同一份物件。

Key 採 `v1/<opaque-scope-id>/<asset-id>/<representation-id>`；不包含 email、share token、模型 key 或本機檔名。不可因 key 不可猜就省略 read ACL。公共 UGC 仍由 domain route 提供；private Work 不進公用 asset CDN。[R2 §3/8；CF-02/03]

Asset readiness 限平台已驗證持久化 object；runtime-local artifact 不偽裝成 ready R2 object。R2 缺檔不得 fallback 到可能已撤銷的舊媒體。GET、HEAD、Range、304 與内部 cache 取用都先驗當前讀取資格。

### 05.5 一套 storage commit，三種身分使用

```text
prepare：驗 member / execution / service 身分 + domain/Work policy
   → 外部處理：有界讀取、digest、轉圖或格式驗證
   → immutable R2 write，必要 variants 齊備
   → finalize：重新驗當前 authority、attempt（適用時）、版本、intent fence
   → 一個 PG transaction：ready + typed pointer + result relation + audit/receipt
```

一般頭像不因共用 Assets 被迫建立 Work／AgentRun。反過來，Agent 上傳成功也不得直接呼叫舊 member finalize 來假扮本人。

---

## 06. Data Policy：儲存、推論、觀看、公開四件事分開

### 06.1 必須先定的 policy 軸

`capture_allowed`、`capture_scope`、`model_processing_locations`、`allowed_providers`、`platform_persistence_allowed`、`local_retention`、`platform_retention`、`viewer_scope`、`publication_policy`。

不要用一個 `private=true` 同時表示上述九件事；也不要只根據檔案來自本機就分類成可上雲。授權某模型使用內容不等於授權平台保存 screenshot；授權保存 R2 也不等於授權社群會員看。

### 06.2 具體情境

| 情境 | 模型可讀？ | 中央可存內容？ | 別人可看？ |
|---|---|---|---|
| 普通本人商品草稿，已同意指定 provider | 依 Grant | 依 asset policy，預設 private R2 | 需另有 Work／share policy |
| 僅本機留檔，但允許外部模型處理 | 僅允許指定 provider／傳輸方式 | 不可偷存 R2／logs／events | 預設不可 |
| 連外部模型也不許收到的內容 | 只能真正符合處理位置的模型 | 依各自 policy | 不因本機 CLI 而例外 |
| neo recording | 預設不進模型、非必要不擷取 | metadata-first，capture opt-in 才可存 | 另需 viewer authorization |
| 登入、credential、A4、付款驗證頁 | 不作一般 Agent capture／操作 | 不保留原始敏感內容 | 人類受控流程 |

這是設計 policy matrix，不是對目前供應商資料保留條款的承諾。

### 06.3 Derived artifacts 與 publication

資產來源與更嚴格的資料限制要沿 lineage 傳到衍生成果；模型說「我已遮罩」不能自動降級成 public。發布是一個明確 domain operation，必要時產生新的已去敏公開 representation；不直接把原 private asset 的 bucket 或布林值改成公開。

影片、rrweb event stream、DOM snapshot、模型摘要不能用同一個「錄影」名稱混掉格式／風險。HTML/JS 檔、可執行腳本、壓縮包不因放 R2 就可在主站 origin 執行；非必要首版拒絕，必要下載用 attachment／用途隔離，內容解析和解壓另列受測規則。

### 06.4 Secrets 永不成為一般 Asset

UserAccessKey／SiteCredential 用雜湊與用途明確的交換流程；provider secrets 保存在官方 CLI、本機 keychain 或明選 platform vault。R2 不是 secret vault，private bucket 也不能取代這個邊界。[AP §1.11/4.2/4.5]

---

## 07. Operation Catalog：人、API、MCP 都對到同一個業務操作

### 07.1 為什麼需要

沒有中央操作語意，Web route 可能知道「這是發布」，extension 卻以為「只是 click」，Agent Kit 又當成「儲存草稿」。相容契約不只 DTO 形狀，也要包含真實 effect 和資格。

新增一個小型 operation descriptor registry，對既有 domain command 作映射，不取代 domain code。每個 operation 包含：穩定 ID、owner module、input/output schema refs、target resolver、action/effect family、允許的 invocation kinds、permission policy ref、idempotency/retry class、data policy hooks、human confirmation rule、conformance test IDs。

operation ID 示例：`member.avatar.replace`、`product.description.save_draft`、`work.result.submit`、`repository.pull.merge`。這些是目標命名示例，不宣稱已存在 API。

### 07.2 禁止誤用

不是把全站所有 POST 自動匯出成 MCP tools；不是讓模型自己提交 `effect=safe`；不是讓網站發布任意 JSON flow 就取得執行權。網站 discovery 只能提出候選能力，對應的 trusted adapter 與 registry 才決定可用範圍。

Typed input 並不自動安全；target 帳號、資源版本、收件人、金額／內容 digest 等必須由操作本身驗證。對未知外站的 fill/click，不能猜其沒有 autosave 或送出效果；無法分類就留 assisted/manual。

### 07.3 Client adapter 的依賴方向

```text
Web UI / API / MCP facade / Standard Extension / neo adapter
                           ↓
                  固定操作與 wire contract
                           ↓
                中央 domain command / policy
```

自家平台優先 API command，不用 browser 點擊模擬已存在的後端功能。外站 DOM 操作仍須 runtime 端檢查與中央 permit，不能只過一次 MCP facade 就放行所有原生工具。[AP §0.7/3.5–3.7]

---

## 08. 共同原語，分開狀態機

| 類型 | 可以共用 | 必須保留的差異 |
|---|---|---|
| UploadIntent | principal/scope、版本、request digest、lease/fence、audit | 寫 immutable object 可核對 size/hash 接續；GC 與 refs |
| ActionIntent | operation/target、Grant、dispatch、receipt、unknown | browser click 無天然遠端 dedupe，未知不得自動重按 |
| InferenceAttempt | owner/binding、step、provider ref、usage evidence | timeout 可能已計費；不任意釋放未知 reservation |
| Merge operation | 操作者、審查決定、expected head/base、證據 | 必須驗原生 GitHub 權限與當前 review，不等同普通 AgentGrant |

不建立單一 `jobs` 表承載所有業務状态，也不為每個 intent type 新增獨立 queue framework。共享錯誤分類、trace/correlation IDs、短交易幫手即可。

`command receipt` 記本平台 transaction 已完成的事實；`execution receipt` 記 runtime/provider 回報的證據。不能因名稱都叫 receipt 就混為「已成功、可對外宣布」。

---

## 09. 非同步：Queues 現在接，但只有一份中央狀態

### 09.1 對 R2 原範圍的明確修訂

R2-only 搬檔不必等 Queues 才開工。但整合 Autopilot 後，需要 model step、延遲 provider response、artifact processing 與可恢復 delivery；建議本輪把 Cloudflare Queues 接成共用 transport。不是引入 Redis、另一個任務資料庫或長駐 Agent server。[R2 §0.2/9.3；AP §0.10/1.9]

### 09.2 正確順序

```text
PG transaction：domain state + 有序 outbox row
             ↓ commit
受控 dispatcher：只送 job/attempt/intent ID + schema version
             ↓
Queues consumer：查當前 PG state → 短交易 claim/lease
             ↓
交易外執行對應的有限 I/O
             ↓
短交易記錄結果／對帳狀態，最後 ACK
```

Cloudflare Queues 是 at-least-once；重複訊息屬必測情況。佇列內容不能自行授權、變更模型付費來源或帶出 secret。dispatcher 在 commit 後傳送失敗時靠 outbox 再送；commit 成功但 ACK 遺失以同 ID 去重。[CF-01]

### 09.3 快慢路徑分開

Pause／Stop／Takeover／Grant revoke 走直接控制 API 與 client 本機 fence；不排在影片處理或模型工作後面。Queue 通知遺失或延遲時，以 DB cursor／state 補讀，不把 websocket/queue 當唯一控制狀態。

logical queue lanes 依權限與 noisy-neighbor 分開，例如 model steps 與 asset maintenance，使用同一份 job envelope 與 dispatcher library；不建一個同時握有所有 key 的萬用 consumer，也不為每種檔案各造 queue。

Cloud model step timeout 的已知最大執行範圍要在 pinned Workers runtime 實測；不把 waitUntil 當 durable job。需要 provider async 模式或另一種受控 runner 時，以 operation adapter 明確新增，不讓卡住的推論无限續跑。

### 09.4 暫不新增的權威系統

Durable Objects/WebSocket 可後續作通知或 live view relay；不能另持一份與 PostgreSQL 同時可改的 control lease。Cloudflare Workflows 若未來採用，只作可替換 orchestration adapter，不能與現有 Run/Action 狀態機各自宣稱同一狀態權威。

---

## 10. Credential Broker 與能力／費用隔離

### 10.1 保留獨立 broker Worker

同 repo、獨立部署、private service binding、自己的 DB role 與解密 KEK。主 Platform Worker、Maintainer Worker、media processing consumer 都不應得到 provider 解密能力。這是一個必要秘密隔離，不是每個 domain 微服務化。[AP §1.11；CF-04]

Broker 只接受狹義 `ModelStep(attempt_ref, step_ref, binding_ref, context_ref)`，不接受任意 URL/key/body proxy。收到內部請求也再次查 active attempt、binding owner、Grant/data policy、budget 與 step 唯一性；「來自自己的 Worker」不是跳過授權的理由。

### 10.2 不創造另一種模型登入

官方 CLI adapter 使用官方 binary 與登入流程；provider credential 仍由官方 CLI 管。Native Host 不抽取 CLI OAuth 作為自製 gateway 的 API key，不代填密碼/OTP/CAPTCHA。

純 extension BYOK 使用本人明確同意的 broker custody；Native Host/neo 可使用另有能力證據的 local custody。不能在 local 模式失敗時偷偷改走雲端 broker。[AP §2.2/4.4–4.6]

### 10.3 Capability 必须是可驗證的組合

`usable = runtime supports operation ∩ installed adapter conformance ∩ current Grant ∩ current domain authority ∩ data policy ∩ model/budget conditions`。

capability advertisement、自報已登入、裝置公鑰或同一 OS 的程序名稱，都不是硬體／供應商完整 attestation。對官方 CLI 內建 shell/tools 無法有效限制的組合，維持 assisted，不宣稱 managed。GitHub／支付／正式發布等中央高價值權限依然獨立驗證。

### 10.4 費用與停止

每個 attempt 綁明確 model connection/billing source。API 並行保留與實耗對帳原子化；CLI 不可觀測的餘額顯示 unknown，不偽造精確金額。runtime 離線不再無限喚起新的 model step；已在途 provider response 安全落地或依 policy 丟棄，不能因此再派 browser effect。

---

## 11. 三端契約：讓新增端是 adapter，不是重寫核心

### 11.1 Canonical 資料夾

```text
freedom-platform/contracts/
  preview/v1/             # 既有 consumer 原樣相容
  common/v1/              # PrincipalRef / ScopeRef / ArtifactRef / Error 等共用 wire types
  assets/v1/              # 需要跨端的 upload/read/receipt 契約
  execution/v1/           # Grant / RunAttempt / Action / Control / Events
  operations/v1/          # 操作描述與 schema refs，不放任意可執行程式
```

它们是一個 repo、一條 generator 管線的不同 bounded contracts，不是四個獨立權威。可以按現有工具組織子目錄；不為目錄數量建立對應 npm packages 或服務。

TypeScript/Rust DTO、SDK、schemas、mock fixtures 與來源 manifest 由這裡生成。Runtime-specific implementation 不反向成為 schema source。原 [AP] 六份 draft schemas 只能作設計材料，正式化時需補全 operation、attempt、asset與安全語意。

### 11.2 版本與相容

區分 API schema、operation revision、policy revision、runtime adapter、source commit、asset transform profile、DB migration 集合、deployment recovery generation。不要拿一個 version 字串代表全部。

只有字段相容還不夠：放寬權限／改 effect／改 enum 意義等安全語意不能暗中以 minor 發布。Client 遇到未知必要 policy/operation 必須拒絕該執行；但已授權且相容的普通 read／revoke／人類設定功能仍可工作。

### 11.3 發布相容矩陣

| 組合 | 預期 |
|---|---|
| 新平台 + 舊 preview consumer | 原唯讀／商務能力保持，不自動獲 execution scope |
| 新平台 + 上一個受支援 execution client | 只啟用 manifest 列明安全相容的 capabilities |
| 舊 client 不懂新 policy/permit 欄位 | 拒絕新動作，要求升級，不靜默忽略 |
| 新 client + 舊平台無 execution capability | setup/read-only 提示，不假成功 |
| TS 與 Rust 同 schema 不同解码 | golden/negative fixtures 必須抓出差異 |
| production token + staging API/bucket/runtime | 拒絕；不能依使用者可改網址跳環境 |

保留 [AP] 的 JCS/JOSE/DPoP 設計方向，用標準實作及跨語言反例驗证；舊 digest 不重算。大數、null/missing、unicode、重複 JSON key、nonce、audience 與 epoch 不可各端自行猜語意。

### 11.4 共同開發與發布補充

契約擺放、ReleaseSet、共用library、既有contracts.lock相容與consumer升級細節見§24–25、§29。此處的版本協商必須與那份固定source/policy規範一致；不新增另一個contract canonical repo。

### 11.5 Browser 實作責任

標準 extension 沿用標準 MV3/Native Messaging；neo 保留其 Rust backend/cockpit 與 upstream build。共用 wire contracts/fixtures，不共用 neo 的專屬 manifest 或把全部 upstream backend 搬去 Chrome。[AP §2–3]

Client journal 先落 dispatch 記錄，斷線恢復只補傳結果，不再 click。MV3 worker 會被終止，所以不可把 global variables 當唯一進度。[CH-01]

工具 handler 隨各 client 受控 release 打包；平台發 schema/operation data，不發任意 JavaScript/WASM 讓 extension 執行。本計畫不採可執行遠端 adapter 捷徑。[CH-02]

---

## 12. 效能與交付：不要把每次操作變成十次跨洲往返

共同核心不等於每個 DOM node 都中央驗一次。Observe 用短效、精確範圍的讀取 capability 與最小化 batch；真正會改外站的 operation 才做 bounded intent/permit。語意上不可分割的已註冊動作可由 adapter 定義，但不得把任意腳本偽裝成一個 batch 來逃過權限。

Model step／大型 artifact 外部 I/O 非同步；PG transaction 只持有短期 metadata/authority locks。列表讀 metadata 投影，不逐 asset HEAD，不在 JSON 回 base64。控制信號不依賴重型背景 queue。

初始化時量測各種實際路徑：人類頭像、小型 draft、外站 observe、外站 effect、stop→local fence、artifact TTFB；不要預設導入 R2 或 worker 數變少就保證延遲下降。相同效能證據用於調整 permit/heartbeat/timeouts，保留 fail-closed 行為。

---

## 13. Schema migration：一種 ID、一套 ledger、兩種回放都要測

採 [R2 §11] legacy numeric 保留、新增 timestamp+suffix 的相容格式。新模型表、Asset、Work ACL、RunAttempt、broker vault 都走這條流程；更新 [AP] `{next}_...` 示意，不讓兩條工作線各自發號。

時間戳只解 identity collision，不能保證兩份 SQL 互不衝突。真正相依以明確父 PR／per-migration dependency metadata 表達，metadata 跟 migration file 走，不再讓所有 PR 改同一份 max-number。獨立 migration 需能在不同 merge order 與空庫 replay 得到等價結果。

舊 `name + digest(sql)` ledger 原封不動。完整 migration manifest 在候選 build/release 生成。檢查所有未套用檔案，不只 id > latest；正式 private deploy helper 與本機 runner 一起相容才可用新格式。

不要把 R2 backfill、provider calls、帳號配對或密鑰生成塞進 SQL migration。這些用受控 ops／domain flows，保留 source revisions 與 evidence。

---

## 14. 單一 CI 與 guardrail 設計

### 14.1 相依映射是關鍵

`檔案 → 模組 → operation/contract → 反向相依 consumer → tests`。

Assets/Principal/Command 變動同時影響 media 與 execution，不應被選成「只是換圖片」。修改 dispatch/privacy/permit 的 client PR 要跑雙端 conformance；不因只有兩行 Rust 就只編譯。

| 修改 | 必須追加的跨計畫測試 |
|---|---|
| Principal/Command | 人類既有 session + service 假冒 + execution replay + asset finalize |
| Work ACL/Scope | 所有舊列表/事件/匯出 + 私人 artifact + share/crawler |
| Asset/Upload | 七類媒體 + Agent 結果 + local-only denial + revoke/finalize race |
| RunAttempt/Control | runtime handoff + late receipt + model change + partial upload |
| Broker/Model | owner/budget/custody + queue duplicate + provider timeout |
| Contract/Operation | TS/Rust golden + 不受支援 client 拒絕 + SDK drift |
| Migration tooling | 舊 ledger + 空庫/增量/逆序相依 + private ops helper |
| 純敘述文件 | links/章節與設計引用；runtime MD 不當純 docs |

保留固定 `verify` 彙總，必要時 `review-policy`；trusted selector 不由 PR 自己改成空測試集。取消同 PR 舊驗證，不取消 backfill/schema/backup；full source inventory 在 release/archive 生成。

可信來源與每次PR的執行方式見§28；context報告不作通過證明，CI以最終diff獨立重算。每個page/route/queue/MCP surface的映射依§27，不能只按檔名選測試。

### 14.2 應縮小什麼、不縮小什麼

小型 platform PR 不重建 Chromium；TS/Rust contract fixtures 與原生 guard 單測可在輕量 job 跑。packaged Windows/macOS、真實 Chrome/neo、真實 staging R2/Images/broker 的驗收分開記錄，發版必須有相關 evidence。

不能以 mock、JSON shape validator 或 upstream README 宣稱跨端安全完成。兩份原測試清單全部保留身份與追蹤，重複測試可以合併實作，但原 requirement IDs 仍能映射。

### 14.3 註解與架構說明

每個主要模組只有 Purpose/Owns/Public API/Dependencies/Invariants/Tests，根目錄政策只存一份。函式註解寫鎖、scope、replay、expiry、evidence 層級的理由；不要求全倉逐行解說。

新增共用原語時必须有至少一個反例測試證明它阻止越權／重複 effect／資料外洩；只檢查新檔案存在不算 guardrail。

---

## 15. Review、merge 與 Autopilot 的交界

正常 merge 維持 [R2 §15]：一位符合當前資格、非作者的實質 review + 人明確授權合併；確定性工具查原生 GitHub 權限、最新 review、checks、head/base、hold 與 schema compatibility。不能把普通 ExecutionGrant 當成 repository merge 權限。

Autopilot 可以提出修復／PR 草稿；「讓 AI 修」不自動帶「approve/merge/deploy」。MergeOperation 可引用同一 operation metadata／安全 audit，但不要求先有可用 LLM，因此模型額度耗盡不會讓管理員無法合併。

有 native merge queue 時，由人明確 enqueue；workflow 支援 merge_group，驗最新 base 與前面候選的組合。[GH-01] 未接 queue 時，base freshness 不足就回技術原因，不能只帶 expected head 假稱排除了所有競態。

R2 資源與 policy／broker secrets 的變更仍由有實際權限的人／已授權 operations 執行，不由一份規格或公會職稱推定 cloud admin。正式發布維持原人類決策，不再加第二層「平台審查委員會」。

---

## 16. 回退與 Restore：兩份計畫必須共同升級的底線

### 16.1 版本下限不只有 R2-aware

| 已發生的事 | 最低可回退能力 |
|---|---|
| 已有第一筆 R2-only 內容 | 能正確讀 R2、domain ACL 與 legacy mapping 的 Bridge |
| 已有第一筆 private Work | 所有舊 read surfaces 已排除／正確授權私人工作 |
| 已發生 execution dispatch | 保存 intent/receipt、停止舊 epoch、unknown reconciliation 管理入口 |
| 已接受新契約／機器憑證 | 正確辨識 audience、version/recovery generation，不把 token 當 member |
| 已存 BYOK secret | broker 解密／撤銷與資料保護邊界仍存在，不回退到主 Worker 共用 key |

最低可回退 release 必須同時具備全部已啟用功能的底線。不能只說「舊 UI 還能開」就回退到會洩漏 private rows 的 API。

### 16.2 Emergency stop

停止**新** execution／模型工作；保留人類登入、原會員功能、R2 讀取、控制／撤銷與 evidence 回收入口。已提交外部 effect 不可抹掉；狀態進 reconciling。正常媒體上傳不因暫停 Agent 而被迫停用，除非故障就在共用 Assets。

### 16.3 Restore 不能復活舊授權和舊動作

恢復前 fence 現有 runtime；恢復環境預設不 dispatch outbox/queue。DB+R2 backup set 依 [R2] 完整還原，再對帳刪除／撤銷紀錄與密鑰狀態。

部署端維持不隨舊 DB snapshot 回退的 recovery generation／相應簽發 key epoch；恢復後更新它，舊 access/refresh/grant/permit 不能自動復活。恢復工具需要有權限的操作與 generation 一致性驗證，不能只把 recovery generation 也存進同一個可回退欄位。

Runtime 重新配對／重新確認必要授權，active attempts 進 blocked/reconciling，既有 outbox item 逐類檢查，禁止 queue 重送把昨天已執行的外站動作再做一次。最小必要 tombstone/撤銷紀錄要能與備份對帳；對已刪 private content，不因 backup 存在就重新公開。

---

## 17. 修改地圖：原有工作包如何接在一起

| 範圍 | 原工作 | 統一後修改 |
|---|---|---|
| packages/db/index.ts | [R2] 長 transaction；[AP] P-09/10 | 先抽共用 tx/auth port，legacy command 保留；新模式不 fake session |
| Principal/Scope | [AP] P-13/15/16，原 R2 community-only | 新共用 types+映射+typed scope；不是 agent 專屬身份 |
| packages/asset-storage | [R2] RS-03 | 保留 runtime-neutral adapter，平台 object I/O 唯一入口 |
| modules/media-assets / assets | [R2] RS-03/04/05 | owner/scope/attempt-aware intents；media 為 profiles |
| modules/opportunity-project-work | [AP] P-12/M1 | 一份 Work；私人 read ACL；Result與Asset typed關聯 |
| modules/agent-execution | [AP] P-14 | 明確 RunAttempt、permit、late evidence與control資源 |
| model-connections/broker | [AP] P-15/17/20 | explicit custody/processing location；broker current-state validation |
| runtime.ts/worker.ts | 兩計畫都修改 | ObjectStore、JobDispatcher、ModelStep ports 一次接好 |
| platform-app.ts/routes | [R2] RS-09B；[AP] P-01–08 | safety profile 分 member/execution/service/webhook，不開全域豁免 |
| App.tsx/modules | [R2] RS-09A；[AP] P-28–32 | shell一次拆出；Autopilot/Media UI走同session与navigation |
| contracts/*/SDK | [AP] T0；R2 upload contract | common+assets+execution+operation 同源生成，preview保留 |
| Agent Kit/native host | [AP] T4 | ArtifactRef、RunAttempt、bounded job/event spool、官方CLI |
| standard extension | [AP] T2 | 不存 provider key；runtime-local journal；scope/epoch guard |
| neo guard/cockpit | [AP] T3 | 中央contract+pre-effect guard+local recording policy；不連PG/R2根權限 |
| migrations/deploy/helper | [R2] RS-02；[AP] migrations | 一種新ID，一份legacyledger語意，candidate/restore向量 |
| CI/maintainer | [R2] RS-07/08；[AP] §5.8 | impacted conformance + deterministic merge，不設另一Agentpipeline |
| existing docs/manifest | [R2] RS-00；[AP] M0 | 原canonical更新相同UF決策，原份附deprecated clause指標 |

所有 NEW 路徑實作前先查最新分支是否已有等价模組；若有則修改，不按表格生一套同名副本。既有 consumer contracts、來源作者與未合併分支不要被整批覆蓋。

---

## 18. 交付順序：先共享基礎，再平行交付

| 包 | 交付 | 真正相依 | 是否可獨立進行 |
|---|---|---|---|
| U0 | 同一UF決策、名詞、操作/契約來源、traceability | 原文件/最新source | 可立即開始；R2建立與client fixtures不等它全部寫完 |
| U1 | Principal/Scope/Command legacy compatibility | U0最小契約 | 首批核心PR |
| U2 | Asset contract/schema + Work private ACL + upload intent | U1型別/驗權介面 | Asset與Work ACL可分工，整合時共用scope |
| U3 | Run/Attempt/Grant/Control/Action + model ports | U0/U1 | 與U2並行，不能各自造Principal |
| U4 | 共同垂直流程：頭像回歸 + 私人AI草稿R2 Result | U2/U3；至少一條實際CLI/BYOK路徑 | 不必等完整neo/Chromium build |
| U5 | 標準extension、neo、AgentKit與broker/Queues正式接線 | 已固定契約 + 相應安全能力 | 各自adapter/fixtures可早開始 |
| U6 | 七類media backfill/verify/restore、混合版本驗收 | R2-aware核心；各domain adapters | 媒體可先發，不等所有browser模式完成 |
| U7 | legacy欄位/重複schema退出，版本矩陣與ops收尾 | U6證據與相容下限 | 不以清理名義移除仍需的client支援 |
| UX | affectedCI、inventory移位、merge tool、shell拆責任 | 小型mapping契約 | 全程並行，不等最後才補 |

新增CG-A～G（§31）與U0/UX共同開工：先接現有contract pins與可信verifier，頁面mapping/共用libraries跟U1～U5並行，不等各端完成後才補治理。

這些包是責任與技術相依，不是會議關卡。每包依可審閱範圍拆 PR，並保留關联。不要把所有包塞進一個巨型「平台重寫」PR。

### 18.1 開發一開始就要的兩條測試流程

**A. 保住現在：** 真人原本換頭像 → 同一套 member auth → Images/R2 → 同一份 Asset → 名片／聊天／目錄正確，撤銷仍有效。

**B. 證明未來：** 真人建立私人商品文案工作 → 本人模型 → 指定 runtime/Grant → Agent產出草稿 → 同一份Asset/R2 → Result在本人Web查看 → 人可改稿，Agent不覆寫 → 不自動公開。

A證明沒弄壞會員；B證明基礎不是只做一套新圖片服務。最初平台API/本機adapter可完成B；extension與neo後續實作相同contract，不需重設Asset/Principal。

### 18.2 跨runtime流程不是重新開始另一份任務

B在Chrome暫停，完成未知效果核對後換neo，建立新attempt：原Work、已同意且可讀的成果保留，新device自行登入，舊permit被拒；不複製cookie／CLI auth／整個profile。這是第一個跨端端到端驗收，不是只確認三個UI都有同樣的工作標題。

---

## 19. 新增的跨計畫驗收（全部待實作／實跑）

本清單補充 [R2] S/A/M/D 及 [AP] AUTH/WORK/EXT/NEO/OPS；不取代原有案例，不宣稱原28個schema例子已通過這些測試。

| ID | 情境 | 必須得到的結果 |
|---|---|---|
| INT-01 | 真人與Agent保存相同用途資產 | 共用store/purpose validation；各自auth；無fake session |
| INT-02 | 無modelkey的會員換頭像／撤key | 正常工作，不依賴AIready |
| INT-03 | 同社群另一會員讀私人Work及R2結果 | list/detail/events/export/image全部拒絕或不列出 |
| INT-04 | site key指定他人principal/asset | 無delegation即拒；不能以server-to-server繞過 |
| INT-05 | Agent上傳途中Grant或attempt失效 | finalize拒絕新業務commit；bytes可回收 |
| INT-06 | provider到期但晚到receipt須回報 | 限定evidence可對帳，不能再effect或讀任意private資料 |
| INT-07 | runtime A → B handoff | 舊epoch全部拒絕；新attempt保留可追溯billing/Grant |
| INT-08 | A的local-only artifact交接到cloud | 不自動upload，給missing/custody blocker |
| INT-09 | 有本機CLI但model processing不符policy | 不能因CLIlocation=local就放行 |
| INT-10 | 私人結果要求公開 | 獨立domain publication確認／去敏，不直接翻asset public |
| INT-11 | R2完成，最後DB交易失敗 | 無偽成功；sameintent恢復／回收 |
| INT-12 | queue投遞兩次／ACK遺失 | 無重複modelstep/Result/domaincommit；unknown依provider處理 |
| INT-13 | browser click已發出但receipt遺失 | 不另建intent重按；結果unknown可核對 |
| INT-14 | Queue塞滿媒體工作時Stop | 本機fence/直接controlpath仍可用，不排隊等模型 |
| INT-15 | 舊previewtoken呼叫Asset execution finalize | 不擴scope；原preview讀取不變 |
| INT-16 | 舊client不認新requiredpolicy | 不能execute；提供相容read/升級/停止途徑 |
| INT-17 | 修改Command或ArtifactRef的PR | CI選中media+execution+對應TS/Rustconformance |
| INT-18 | restore舊DB/queue且舊token仍持有 | recovery generation拒舊授權，不重播外部effects |
| INT-19 | 只關Agent新執行／回退UI | R2/privateACL/reconciliation仍存在 |
| INT-20 | 更換模型付費來源 | 新明選binding/attempt，歷史實耗與來源不被覆寫 |
| INT-21 | scope重疊但不同字串target | resolve到同控制資源；不得兩個controller競寫 |
| INT-22 | 本機journal存在，平台工作已被撤銷 | journal不能讓run復活，僅補有限evidence |
| INT-23 | 兩條SQL逆序merge與空庫replay | 相依驗證/結果一致；未套用不被latest篩掉 |
| INT-24 | 沒有人要求merge／僅有AIGrant | 不新增GitHubmerge/approve/deploy副作用 |
| INT-25 | broker收到被篡改的內部step/context | owner/attempt/data/budget重新檢查而拒絕 |
| INT-26 | 下載URL cache/HEAD/Range遇share撤銷 | 下一次授權先拒絕，沒有R2public旁門 |
| INT-27 | remote網站傳「新增工具／執行JS」 | 不成為extension/neo的已批准operation |
| INT-28 | A成功但B垂直流程仍無法接同核心 | 不宣告共同基礎完成；列出不相容責任與修正 |

實作時每项 evidence 至少包含 source SHA、contract/policy/adapter版本、環境、測試指令、結果、未驗證部分。schema shape／mock、local workerd、真實雲端、packagedbrowser和正式部署證據各自標示。

---

## 20. 如何併回兩份原文件

1. 更新 [R2] §2–7：共用Principal/Scope、Assets/ArtifactRef、三種驗權入口；保留七類媒體的詳細搬遷與失敗處理。
2. 更新 [R2] §0.2/9.3：no-queue僅保留為storage-only不依賴它；整合Autopilot的transport依本文件§09，不再寫成全面禁止。
3. 更新 [R2] §10/19：rollback floor增加privateACL、executionevidence與recoverygeneration。
4. 更新 [AP] §1.5/1.6/4.10：共享Principal與Asset型別、RunAttempt、commandcore依賴方向、lateevidence生命週期。
5. 更新 [AP] §1.10/1.11/2.9/3.11/4.5：區分processinglocation與custody；R2只存允許內容，broker界線保留。
6. 更新 [AP] §5.2/migrations：改單一migrationv2；§5.5分工映射U0–U7。
7. 原canonical 00/02/03/04/05/06與AGT文檔指向同一份定案contract；執行期規則由contract/policy實作，歷史計畫不當第二份權威。
8. 兩份原測試案例映射到同一驗收索引，追加INT-01–28。不要重新命名全部舊案例而失去追溯。

這是內容併入規則，並未在本輪實際覆寫原文件或任何repo文件。

---

## 21. 給開發 Agent 的統一交接

1.1補充：本節與§31.4一起使用。開工先取得固定版本CodingContextBundle；跨repo/範圍/基線改變補載；不得把context receipt當成理解或授權證明。

> 先讀目前main的AGENTS/CONTRIBUTING與已採納canonical，再讀本UnifiedFoundation及其[R2]/[AP]引用章節。先核對最新head、正在進行的PR與實際已套用migration，不按舊行號盲改。
>
> 本輪先確立Principal/ResourceScope/Invocation、相容Command、ArtifactRef/Asset/Result、Work/Run/RunAttempt、OperationDescriptor與版本協商。禁止另外建立media專用身分、Agent檔案資料庫、假的member session或第二個protocol真相。
>
> 保留原會員登入與社群規則；私人工作先改所有readACL再啟用寫入。R2用私有bucket/immutableobjects/shorttransactions；平台允許保存的內容才上傳，local-only內容不因有storage就搬上雲。
>
> 人类、execution、service驗身分不同；replay/finalize重新驗當前authority。停止、撤銷、修key和有限lateevidence不能依賴模型健康。R2/模型/GitHub/browser I/O不在domain DB lock內。
>
> 以A真人頭像+B私人AI草稿兩條流程驗共用核心。Run交接建立新attempt，不改寫已發生的runtime/model/billing，未知外部effects先對帳。
>
> 各runtime實作相同contract但保留本身stack；extension不執行遠端JS，neo在所有managed可達execute入口驗Grant。官方CLI credential不抽取、不改造成API代理key。broker只受控代呼叫明選connection。
>
> CI按真正相依執行；普通merge用確定性工具与當前review/nativepermissions。沒有本次明確授權，不建立資源、不讀取秘密、不合併／部署／動正式資料。
>
> 交付報告寫UF/U工作包、source與head、實際diff、契約與測試evidence、not_run和下一項技術相依。設計資產檢查不等於產品驗收，不能抄成已完成。

---

## 22. 成功定義與研究限制

1.1追加的共同開發成功條件與證據限制見§31：所有已接入repo使用可核對source/pins；新入口有scope/operation/測試映射；可信CI拒絕手改bundle、偽造成功與錯用途key。不是保證每個任意Agent永遠記住全部文件。

成功不是「一套萬用framework已完成」，而是新功能不用再改寫身分/資源/交易基礎：同一套人類功能仍正常；機器有真身分；私人Work不洩漏；七類media與允許成果共用R2；runtime換掉不用搬業務真相；權限與結果不混；CI/merge少掉重複往返。

本輪只完成設計整合與文件交付。沒有執行schema migration、產品程式build、CLI/provider登入、Cloudflare建立/讀取私密設定、R2搬遷、真實browser/密碼學測試或production驗收。不以讀過原文件中的28個schema案例報告，推定本計畫的28個INT案例已通過。

### 來源與定位

[R2] 與 [AP] 為上述兩份使用者文件，已全文閱讀。文件中的需求與狀態是來源文件的設計聲明，不自動等於現行程式能力。

- [CODE-01：本輪重新讀取的 command 實作](https://github.com/FreeTWAI-AI/freedom-platform/blob/3de70ccbd24362a7925508fb42d36aaa256a0806/packages/db/index.ts)
- [CODE-02：查核基準 commit](https://github.com/FreeTWAI-AI/freedom-platform/commit/3de70ccbd24362a7925508fb42d36aaa256a0806)
- [CF-01：Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [CF-02：R2 consistency 與 cache](https://developers.cloudflare.com/r2/reference/consistency/)
- [CF-03：R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [CF-04：Workers service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [CH-01：Chrome extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [CH-02：Manifest V3 remote hosted code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
- [GH-01：GitHub native merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)

官方來源於本輪查閱，支撐的是產品能力與限制；上面的模組、資料模型、工作包與整合取捨屬本次設計建議。來源中的價格、方案資格、最新CLI旗標與法律條款未在本文件作新承諾。

---

## 23. 共同開發治理：同一份來源，不靠每個 Agent 自律

### 23.1 本輪新增要求與保證邊界

本輪使用者要求：共同開發平台的每個 coding agent、每個 repo、每個頁面與每次 PR，都必須取得適用契約、使用共用 library、遵守版本更新與同一套金鑰規範。本章將它落成「來源 → 取用 → 依賴 → 驗證 → 執行」的一條鏈，不增加人工閱讀簽到或第二套審核委員會。

**無法用 AGENTS.md、勾選框、雜湊或一段 Agent 聲明，證明模型真的理解並持續記住文件。** 可實際落實的是：受管理啟動器確實提供指定內容；同一工作範圍的輸入版本可追溯；CI 獨立驗證提交物；伺服器與執行端拒絕不合版本／權限的操作。未受管理的 contributor 仍可貢獻，不能要求全世界使用同一個 launcher；它們的 PR 走同樣的產出檢查。

本治理不能控制任意第三方 fork、使用者的 OS root，或擁有 GitHub／Cloudflare 管理權的人惡意撤掉保護。正式宣告的範圍是已接入的組織 repo、受管理 launcher、protected merge/release 入口與平台授權邊界。管理員 emergency bypass 必須可辨識、留理由與 audit，不把 bypass 當一般開發捷徑。

### 23.2 六層控制

| 層次 | 做什麼 | 不能取代什麼 |
|---|---|---|
| Canonical sources | 契約、政策、操作、共用程式各有單一 owner | 文件存在不代表已部署 |
| CodingContextBundle | 把適用內容與確切版本交給當次 Agent／人類工作 | context delivered 不是理解證明 |
| Shared libraries | 呼叫經測試的 transport、validator、domain command | 共用 import 不保證所有業務正確 |
| Trusted PR verification | 按最終 diff 重新推導影響並跑反例／相容測試 | 不能信作者自報 passed |
| Protected merge/release | 固定可信檢查來源與審查资格，拒絕 stale candidate | 未設定 ruleset 的註解沒有強制力 |
| Runtime enforcement | 當下版本、Grant、scope、環境與 key purpose 再驗證 | build 成功不授予執行權 |

所有層共用穩定 rule／operation／module IDs，不是每層重新寫一套同名規則。

### 23.3 原則：少量真實狀態，不造治理資料庫

沿用 `freedom.project.yaml`、`contracts.lock.json`、`repositories.lock.json`、現有 repo-maintainer 與現有驗證入口。新增必要的 module descriptors 與本機 context 工具即可。不建立新的 governance repo、向量資料庫、常駐 LLM 審查者或全組強制安裝的 IDE。

這裡的 `CodingContextBundle` 是**開發任務上下文**，不是 Autopilot ExecutionGrant、也不是可簽發業務權限的 WorkContext。可以共用既有上下文封裝原語，但不得共用不相同的安全語意。

### 23.4 本輪決策

| ID | 決策 |
|---|---|
| CG-01 | `freedom-platform` 保留跨倉契約、治理原始政策與共用 library 的中央來源；consumer 不另編一份 |
| CG-02 | 沿用現有 contract lock／vendor 驗證，擴充為可識別 contract、library、policy、generator 的 immutable ReleaseSet |
| CG-03 | 每個開發工作取得分層 CodingContextBundle；跨模組、換 repo、merge/rebase、lock 變動後重新解析適用內容 |
| CG-04 | 每個頁面／API／任務入口映射 module、operation、必要測試與 client factory；不是每頁一整本手寫規格 |
| CG-05 | 正式 PR 檢查來自可信固定 verifier，對最終 candidate 自算證據；不能藉修改本 PR 的 workflow 放行自己 |
| CG-06 | 共用 public trust configuration 與驗證 library；秘密按環境、用途、主體、部署角色隔離 |
| CG-07 | 版本採固定引用＋相容支援區間＋安全最低版本；不是每次開工抓 latest，也不是永遠接受舊版 |
| CG-08 | 更新與例外沿正常 PR／授權發布；不增加第二次人類簽核，不未經授權自動推送全組 repo |

---

## 24. 契約、文件與 library 的實際擺放

### 24.1 中央 repo 的來源分工

下面是目標路徑，NEW 部分須先查是否已有同責任實作；如已有，沿用並在 manifest 記錄對應，不複製。

```text
freedom-platform/
  contracts/
    preview/v1/                  # KEEP：既有唯讀 preview
    common/v1/                   # PrincipalRef、ScopeRef、ArtifactRef、errors
    assets/v1/                   # 跨端 Asset upload/read/finalize
    execution/v1/                # RunAttempt、Grant、permit、events
    operations/v1/               # operation ID、schemas、effect、policy refs
  governance/                    # NEW：不放秘密、不複製 domain business rules
    rules/                       # 穩定規則 ID、理由、反例測試 refs
    profiles/                    # producer / client / native-fork / resource
    agent-entrypoints/           # AGENTS 等產生模板，不維護不同工具各一套政策
    schemas/                     # lock、module descriptor、context、report 格式
    releases/                    # compatibility／support metadata 的 authoring
    trust/                       # 公開 issuer/audience/用途規範；沒有 private keys
  packages/
    sdk/                         # KEEP/GENERATED：中央 wire DTO 與 validators
    client-connections/          # KEEP：舊唯讀 scope；可留相容 wrapper
    platform-client/             # NEW或沿用既有client：member/execution/service exports
    command-core/                # NEW或沿用既有packages/db：交易機制，server-only
    asset-storage/               # 計畫既有：R2/local/ops 邊界
    policy-core/                 # NEW/抽現有pure policy：確定性檢查，無資料庫副作用
    ui-core/                     # 只抽真正重用的tokens/components，不另造全套UI框架
    contribution-tools/          # NEW/整併現有scripts：context/verify/sync工具實作
  modules/<feature>/
    freedom.module.json          # NEW：此模組的頁面／依賴／操作／測試描述
    README.md                    # Purpose/Owns/Public API/Dependencies/Invariants/Tests
  scripts/freedom.mjs             # 薄入口；不另藏一套validator實作
  .github/workflows/
    verify.yml                   # 本倉檢查與固定結果入口
    consumer-verify.yml           # NEW：中央可重用檢查，固定SHA使用
    contract-release.yml          # NEW或沿用現有發布工具；只有授權release才簽發
```

這是責任分組，不要求每個資料夾都發一個 npm package。能以一個 package 的安全 subpath exports 清楚隔離，就不要拆成十幾個 registry packages。`governance/rules` 描述規範與證據，**domain authorization 仍在中央 domain code**，不能再手寫第二份「公會長有什麼權」的政策引擎。

### 24.2 原始來源與生成資料要一眼分清楚

| 類型 | 唯一 authoring source | consumer 拿到什麼 | 修改方式 |
|---|---|---|---|
| 跨端 wire 契約 | `contracts/*` | 生成 schema／DTO／validator／SDK | 回中央改 source、重生成 |
| 業務權限／操作 | 各 domain implementation＋operation descriptor | 操作名稱／安全需求／錯誤語意；不拿秘密 | domain PR 附規則與反例 |
| 全組開發規則 | `governance/rules` | 固定 policy bundle 與短入口 | 中央正常審查；不由 consumer 覆寫 |
| 共用 TypeScript 實作 | 對應 `packages/*` | exact library artifact | 禁逐 repo 複製修改 |
| Rust／native wire types | 同一 contracts source | 生成的 Rust DTO 與同一 golden fixtures | Rust adapter 可改，生成 DTO 不手改 |
| Repo 在平台的角色 | 各 repo 現有 `freedom.project.yaml` | 本倉維護；中央彙總角色 | 角色升級有對應證據；不能自降類別逃驗 |
| 模組／頁面 mapping | 該模組一份 descriptor | build 產出全站 index | 新頁面更新該模組，不改全組大清單 |
| 雲端實際資源 | 現有環境 manifest＋私有 overlay＋部署 receipt | logical aliases與驗證結果 | 不把 private overlay 複製到policy bundle |
| 實際結果 | CI／release／runtime evidence | 帶SHA與版本的report | 不把規劃表抄成已驗收 |

生成目錄標 `GENERATED`、source ref、generator version；發現 bug 回 source 修。不使用泛用規則「所有 vendor 都不可改」，因為上游 fork 自帶 vendor 有它自己的授權與維護流程；只限制中央 export 所屬 namespace。

### 24.3 既有基礎要直接接續

本輪讀到 Agent Kit `contracts.lock.json` 已固定中央 source commit、protocol digest 與 bundle digest；`scripts/verify-contracts.mjs` 會驗 bundle 檔案集合、checksum、symlink、路徑，並可核對 pinned GitHub source。這是起點，不再新增一個意義重複的 `foundation.lock`。[GOV-C02/03]

本輪 platform `repositories.lock.json` 明寫用途是跨 repo integration tests 的 exact consumer commits。[GOV-C04] 它不等於「所有 repo 當前部署版本」，也不應為每個 consumer 的 UI commit 都強迫中央開 PR。

原核對來自各檔 main 與回傳 blob SHA；**不是**宣稱本輪取得所有 repo 的同一時間點完整 commit，也不是新 feature 已上線的證據。

### 24.4 ReleaseSet：一份不可變的組合，不把所有版本混成一個數字

設計一個 manifest 把下列 immutable artifacts 綁成經驗的組合：contract family/version/digest、library version/integrity、policy revision/digest、generator version、公開 trust-profile 格式版本、conformance fixtures、來源 SHA、適用 repo profiles、支援與撤銷資訊的可信入口。

`release_set_id` 只是一個可讀的組合識別。各欄仍有自己的版本；token signing key rotation 不應逼全組重建 wire contract，文件補字也不必提升 execution protocol major。

發佈順序：受保護 source commit → deterministic build → schema/semantic/consumer tests → 產出 immutable artifacts → 受權發布身分簽署 manifest/驗 provenance → consumer 明確 pin。manifest digest 不含它自己的 signature／self digest，避免自我雜湊循環；簽章作 detached envelope。

Digest 僅證明 bytes 一致，不證明來源可信。必須從已批准的 publisher/repository/workflow 身分驗證發佈；不能讓 PR 同時換 bundle、hash、驗證公鑰，然後自己簽一張「合法」。首版發布 pipeline 未支援某個簽章能力時，列為未完成而非假稱已簽。

### 24.5 發布位置與 GitHub／R2 的分工

首版沿用中央固定 exports／GitHub release artifact＋consumer `vendor/freedom-platform/`，同一 library bytes 發佈一次、各端自動同步，不要求先開 npm 私有 registry。後續需要 registry 時可增加**分發鏡像**，但不能讓 registry 與 vendor 各自成為 source。

R2 可鏡像已發佈 artifact 或保存 evidence；不可把可變 R2 URL 當政策 authoring source，更不能让 browser 在 runtime 下載 JS/WASM 來取代已打包 adapter。協定／policy metadata 是資料；執行程式仍隨受控 client release 發布。

---

## 25. 共用 library：讓「照規範」成為最省力的路徑

### 25.1 建議的共用界面

| 共用層 | 包含 | 不包含 |
|---|---|---|
| Wire SDK | DTO、schema validation、Problem codes、operation IDs | member secret、DB client、R2根key |
| Member client | 同源API、CSRF、版本、Idempotency-Key、redacted errors | device/service token fallback |
| Execution client | device-bound auth、audience、attempt/Grant、safe receipt | 用網站cookie冒充真人 |
| Service client | SiteCredential交換與service scope；server-only | user impersonation、A4 confirm |
| Command core | 短transaction、current validator ports、receipt namespace | 本機cookie複製、provider I/O |
| Asset client／service | upload intent、finalize、stream metadata、共用錯誤 | 每頁自己選bucket、raw key |
| UI primitives | design tokens、表單狀態、錯誤、loading、共用媒體元件 | 把React组件當server ACL |
| Policy helpers | 有界且pure的typed predicates、digest/版本比較 | 通用遠端腳本解譯器、另存一份會員角色表 |

在同一 build target 中，核心 DTO/validator/client 必須來自一個 ReleaseSet 對應的解析結果；檢查 lock 與實際解析圖，避免一半畫面用舊套件一半用新套件。不同部署的 repo 可在公布的相容區間內滾動升級，不要求所有 repo 的所有第三方 dependency 都同版本。

### 25.2 不是只檢查 package.json 有安裝

CI 應檢查實際 import/build graph：跨 repo SDK 必須來自已固定來源；consumer 不另定同名 `ExecutionGrant`／`ArtifactRef` wire schema；頁面不直接匯入 `pg`、R2 ops、vault；指定 API 邊界以外不能另做 platform HTTP client；直接跨 domain SQL mutation／複製 crypto verifier 必須有可識別的禁止路徑與反例。

不是全面禁止 `fetch`／`node:`／SQL 字串：provider adapter、local operations、測試有正当用途。白名單須明確到模組／入口與理由；新增頁面不得以搬到 `utils/` 規避。例外由中央分類，不能在自身PR改manifest加 `*` 放行。

型別系統／AST規則只能抓部分違規；語意分歧以行為與對抗測試抓。不要宣稱「都import同一library，所以不可能有漏洞」。

### 25.3 Rust、Python 與既有 fork

Rust 不強迫載入 TypeScript library。跨語言同一份 schema、canonicalization要求、輸入／輸出／拒絕 golden vectors；native安全實作以受審套件和adapter維護，必須跑同一語意的測試。不能為了shared-code指標把TS runtime硬塞neo。

資源型／技能書 repo 只需它的profile：來源、manifest、授權、輸出契約與必要檢查；不為純影音Python工具注入Hono、會員SDK、R2權限或BrowserOS套件。真正接平台API的repo才啟用相应client驗證。

### 25.4 日常呼叫形狀（待實作API示意）

```ts
// 設計示意；實際名稱由中央client source產生，不宣稱目前已存在。
import { createMemberClient } from '@freedom/platform-client/member';

// app shell只建立同一設定的client，注入feature；頁面不貼key或各設baseURL。
const client = createMemberClient(memberRuntimeConfig);
await client.operations.memberAvatarReplace(input, {
  expectedVersion,
  idempotencyKey,
});
```

member shell、execution background、service process 分別初始化其client profile，不互換憑證。Agent要新增共用能力時先補library，再由相關頁面使用；沒有現成operation就提中央contract/domain變更，不自行硬寫新API路徑當長期解法。

---

## 26. 每個 Agent 都拿到適用內容：CodingContextBundle

### 26.1 三層閱讀，不是把全部文件塞進每個prompt

1. **全組底線**：來源、版本、秘密、安全邊界、不可變歷史、測試真實性。
2. **Repo profile**：本倉角色、入口、stack、指令、上游規則、依賴pins。
3. **本次範圍**：module/page/operation、完整相關契約片段、invariants、共用API範例、必跑測試、相依PR。

章節與規則以ID選取，完整規範保留可讀本地檔；短摘要不能刪掉「不得省略」的安全約束。文件索引指向確切版本與章節，不用搜尋引擎排名決定權威。Context過大要分段讀並列出尚未讀範圍，不能默默截斷後宣稱全讀。

### 26.2 共同入口檔案

每個repo維持根 `AGENTS.md`；其中央管理區塊由同一policy產生，repo自己的說明與上游授權保留。每個大模組再放短AGENTS或模組README入口，不要求每一個React檔放整份政策。

Claude Code等工具按**被測試版本**選薄wrapper：需要時 `CLAUDE.md` 用 `@AGENTS.md`，不複製正文。這避免另一份不同步指令；同時檢查root／parent／local files和工具設定的優先序。當前官方文件已描述某些Claude版本可直接讀AGENTS，但也有CLAUDE檔優先、設定及session差異，不能寫死「所有Claude都一樣」。[GOV-W02]

Codex的AGENTS discovery有啟動目錄、override與大小限制；從repo root啟動不能推定所有子目錄規則都載入。因此wrapper依本次scope主動提供完整相關上下文，不只依靠工具自己的discovery。[GOV-W01]

其他工具／自製Hermes、BAT、Goose協作launcher使用同一context產生器，按它們實際支援的參數或stdin注入；hooks要逐版本驗證。没有hooks不能假裝有強制pre-write攔截，仍用本機prepare＋最終CI。不得擅自修改使用者home中的全域設定或移除官方CLI登入。

### 26.3 共用CLI入口（設計介面，尚未實作）

```sh
# 薄入口呼叫已驗證、固定版本的中央工具；不使用 npx ...@latest。
node scripts/freedom.mjs prepare --base-ref origin/main --scope assets,member-card
node scripts/freedom.mjs context --paths apps/portal-web/src/modules/Membership.tsx
node scripts/freedom.mjs verify --base-ref origin/main --report .freedom/reports/current.json
```

Rust／Python repo可由現有Agent Kit安裝的相同版本工具呼叫，或沿該repo既有包裝命令；不要只為了名字一致在每倉新增node_modules。一個跨平台入口的實作與版本是中央的，不是每倉copy verifier後各修。

prepare預設唯讀解析＋生成本機上下文，**不自動升級lock、登入、取秘密、安裝不可信Skill、發Issue、開PR或推送**。需要取得public artifact時只從已批准來源、exact ref、驗完整性與publisher；下載的內容通過驗證後才可載入工具。

### 26.4 CodingContextBundle最小欄位

- 工作識別、repo full name／stable ID、預期base SHA、當前head SHA、workspace狀態。
- active safety-policy revision/digest、候選contract/ReleaseSet、適用repo profile。
- 實際相關changed/planned paths、module/page/operation IDs；rename/delete反向相依也要納入。
- required document IDs、source refs、content digests、完整必要條款和read/call範例。
- shared library解析來源、guardrail IDs、selected tests與各自理由。
- source缺失、無法下載、版本不相容、context未覆蓋等blockers；不輸出key／prompt／私人問題全文。

bundle與context receipt放 `.freedom/context/`／CI artifact，按工作命名，不commit每次產生的檔案、不讓所有PR修改一張中央context.json。Private repo report不公開到公用R2／PR artifact。相同hash只代表供應的內容相同，不證明LLM讀懂。

### 26.5 哪些時候必須重算

開始新工作、delegation給subagent、切repo／worktree、跨入新模組、修改lock／module descriptor／policy、merge或rebase更新base、context壓縮或session重建、提交PR前。受管理launcher可以觀察這些事件時自動提供delta；無可靠hook時用顯式context命令補讀，不聲稱攔到每個編輯。

不需每按一次鍵重讀整本文件。依路徑與digest cache只補改變或新進範圍；相同上下文可重用。正在工作時不悄悄下載latest替換library；新baseline用明確通知與下一個安全邊界切換。

### 26.6 實際執行準則與候選設計分開

`active_policy`取已批准安全基線；`candidate_contract`可指本次設計PR的候選schema。Agent可修改提案與未發佈schema，但不能以「我正在修改政策」為由取消當下的秘密／授權／測試底線。

PR內的AGENTS、Issue引用、網站文件與程式註解都是候選內容；不能授權讀取production secrets或更改ruleset。多份說明衝突時輸出來源/ID差異並以適用的可信基線限制副作用，不自動升權讓工作通過。

---

## 27. 每個頁面／模組／入口都有可驗證mapping

### 27.1 一份feature descriptor，不是每頁一本規格

在功能擁有者目錄放 `freedom.module.json`（或現有相同用途manifest的版本化擴充）。一份descriptor可以包含多個頁面、API surface、scheduled/queue handlers、MCP工具與native bridge命令，避免只管有UI的路徑。

欄位：module ID、owner角色引用、owned paths與public exports、依賴模組、page IDs／routes、operation IDs、auth profile、contract families、approved clients、必要instruction refs、invariants、test IDs。Owner的角色引用不直接把任何公會職稱當GitHub write。

**安全權限條件不抄在descriptor當第二份ACL**：只引用中央operation/domain policy。Sidebar按鈕是否顯示是UX；server/domain永遠驗目前資格。

### 27.2 示意：私人Autopilot頁（設計樣本）

```json
{
  "schema": "freedom.module/v1-draft",
  "module_id": "autopilot-ui",
  "owned_paths": ["apps/portal-web/src/modules/autopilot/**"],
  "pages": [{
    "page_id": "autopilot.work-detail",
    "entry": "apps/portal-web/src/modules/autopilot/WorkDetail.tsx",
    "auth_profile": "member-session",
    "operation_refs": ["work.read_private", "run.pause", "work.result.read"],
    "client_profile": "platform-client/member"
  }],
  "contract_families": ["common/v1", "assets/v1", "execution/v1"],
  "instruction_refs": ["UF:04", "UF:05", "UF:06", "CG:context"],
  "invariant_refs": ["INT-03", "INT-26"],
  "test_refs": ["private-work-acl", "artifact-read-revocation"]
}
```

範例operation與檔案是目標名稱，不是既有路由證據。正式generator須驗referenced files/operations/tests確實存在；不能保留漂亮但沒接線的ID。

### 27.3 Coverage不是只有檔名符合glob

CI以route/navigation/dispatcher registration加AST/build evidence產生實際surfaces集合，再和descriptor比對。所有可到達的新入口都要有owner/auth/operation/tests；漏頁面、未分類API、隱藏admin/worker/MCP入口要報錯。

Hono動態route、hash導覽、plugin/native dispatch等不能全靠grep。能導出實際route registry就用它；不能靜態識別的入口要有明確registration/test證據，未知保持需處理，不默認public。

前端校驗「該page使用的client/operation」；API校驗「該route掛的auth profile與operation handler」；測試校驗「對方沒權時會拒絕」。三者缺一不可。Manifest的true/false本身沒有安全保證。

### 27.4 既有大型檔與新入口的過渡

現有App／legacy routes先建立module coverage基線，再逐段抽出。已覆蓋區域不允許新增逃逸，未覆蓋部分明確列入遷移工作與必要全套fallback。不能靠將新增檔案放在legacy資料夾永久免檢。

Repo profile降級、owner path縮小、刪除test refs、刪除安全surface必須觸發baseline-vs-candidate差異檢查。文件型repo不跑無關browser suites，但一旦新增平台API／憑證／native執行，trusted classifier提升必要檢查，不信任作者仍自稱resource-only。

---

## 28. 每次 PR 的強制驗證：可信執行，不能自己證明自己

### 28.1 目標流程

```text
本機prepare/context → Agent使用共用library → 本機verify
        ↓
PR或新head
        ↓
可信CI取得base/head/candidate與完整diff
        ↓
驗證pin/source → 決定scope → contract/library/import checks → 選定tests
        ↓
verify結果＋必要的review-policy
        ↓
一位有效reviewer → 人要求merge → latest組合/原生queue → release驗證
```

不要另外增加 `did-you-read-the-docs` 人工勾選。PR報告中的context只幫助審查，CI會自行重算，作者漏跑prepare也不能逃過檢查。

### 28.2 verify中的必要機械判定

| 檢查 | 驗什麼 | 典型拒絕 |
|---|---|---|
| Source/pin | 已批准ReleaseSet、source SHA、artifact/publisher、lock與generator一致 | 手改vendor/hash、公鑰換成自己的、浮動latest |
| Instruction coverage | 最終diff對應required規則/文件來源完整，entrypoints未分歧 | 新模組未被載入、local override隱藏核心規則 |
| Contract conformance | runtime schema、TS/Rust vectors、operation/effect、錯誤與相容性 | 表面型別相同但拒絕語意不同 |
| Library use | 實際import/resolution/build graph、版本一致性 | 多個SDK major、私寫平台fetch／crypto verifier |
| Surface coverage | 新頁/API/queue/MCP/bridge都已registered與有測試 | 只藏UI沒擋API、新route沒有auth |
| Security boundary | secret scan、scope/replay/key-purpose、資料外洩反例 | site token打member、staging驗prod、R2公開旁門 |
| Test integrity | selected tests真的跑、取消/失敗不作成功、baseline反例未被偷刪 | 改selector成空集合或只輸出passed |
| Compatibility | 受影響consumer fixtures/required policy版本與release底線 | 升級server後舊client靜默擴權 |

Secret掃描不是所有私密資料的數學證明，AST不是語意安全證明；它們配合必要行為測試與一次實質review。不要創造「CI全綠=沒有漏洞」的標章。

### 28.3 信任bootstrap：同一個check名字還不夠

首選可用的GitHub ruleset required workflow，從受保護中央repo引用已批准workflow revision；各repo的薄workflow也固定SHA引用中央可重用workflow，不引用可變tag/main。[GOV-W03/04]

**Reusable workflow減少重複，不等於自動防篡改。** 必須同時固定選取policy、工具來源、workflow身分／修訂、測試證據和必需結果；需要支援merge queue時包含merge_group。僅看到名叫verify且app=github-actions，不能證明不是作者改成echo成功。

實際GitHub方案或權限若沒有所需的required-workflow能力：在既有Maintainer整合的同一服務中增加窄權限的 trusted verifier/check publisher（明確需要Checks寫入權，按實際權限授權）。它不執行PR程式、不讀repo密鑰，只根據GitHub取得的canonical run/job/workflow身份和expected suites、以及隔離CI產出的有來源證據，發布可信的必要check。名稱可以仍用verify，但必須限制預期App來源並避免同名冒充。

Checks publisher不能僅轉抄任意artifact的 `passed:true`。可信runner與不可信PR測試的process/filesystem/憑證隔離，報告綁run ID、head、base/candidate tree、verifier revision；作者程式無權自行發布trusted result。

在required workflow或可信publisher尚未接好前，誠實標「普通CI＋人工審查」，不能在文件說已完全強制。這是兩種可選的enforcement接法，不是兩套都要買／都要建。

### 28.4 Fork與不可信程式

`pull_request` 測試環境不帶production、broker、R2、GitHub寫入秘密。不得在有權的pull_request_target流程checkout並執行PR程式。[GOV-W05]

Policy checker使用trusted版本執行；candidate的schemas/descriptors只作有界資料解析。它們不能指定任意shell command／URL／Python hook供有權流程執行。npm lifecycle scripts與native builds也屬不可信候選執行，在隔離低權環境中處理。

Trusted secret/permission checks與需要執行PR程式的tests不能共享可被修改的verifier binary/config/output目錄。現有授權部署與artifact signing步驟只處理已驗證來源，不在PR測試runner執行。

### 28.5 證據綁定與觸發

CI evidence至少綁repo、PR、head、base、實際candidate tree、ReleaseSet、policy digest、verifier SHA、module/page/operation sets、選中測試及結果。平台可產生一份短報告卡，不要求作者手填。

新push重新算；review/label/資格變動只刷新輕量review-policy；改base後由merge queue或新integration evidence重驗。PR head沒變但安全policy被撤銷時，可信gate也要失效並重新評估，不能沿用昨天的綠燈。

治理與技術證據合入現有verify，沒有必要為32個規則建立32條workflow。同一PR新run取消舊run；不取消資料搬遷、production發佈或備份操作。

---

## 29. 版本更新與跨 repo 同步：一致不等於鎖死全組

### 29.1 三份版本資訊，各有用途

- **Consumer contracts.lock.json**：這個checkout實際使用的exact ReleaseSet/artifacts，codegen與build可重現。
- **Producer repositories.lock.json**：中央integration tests取用的consumer snapshots；不是所有線上版本的名冊。
- **Deployment/capability receipts**：實際部署的source、contract、policy、adapter版本；由read-only觀測彙總，不靠每人編輯大JSON。

避免循環pin：中央release不嵌入「之後才會更新的consumer commit」。consumer pin中央release；中央測試可pin先前consumer或本次明確candidate overrides。測試證據引用這組輸入，不為湊兩邊相同SHA做無限更新PR。

### 29.2 升級流程

中央contract/library PR列相容diff與受影響modules/consumers → 驗既有和候選fixtures → 受權發佈immutable ReleaseSet → 人啟動一次sync batch → 每個受影響repo生成一份normal upgrade PR → 消費者測試與正常review → 滾動部署。

同一consumer一個活躍upgrade PR，後續同一授權批次更新內容而不每天開一張重複PR。只更新實際受影響repo；純文件修字不要求neo重新打包，未使用某contract family的resource repo不升它的SDK。

唯讀drift巡查可在已配置排程下執行；寫入Issue/PR/comment/merge仍須對應人類明確授權。一次明示的有限同步批次可授權指定repo/version集合，不需每個檔再問一次；不得把它解釋成永遠自動推送所有repo。

### 29.3 安全相容性

格式相容不等於effect／授權相容。Contract major/minor、policy revision、operation revision、library version分開；放寬權限／改完成語意等由語意diff和人工review把關，不能只看schema diff工具。

Deployment宣告supported contract範圍、最低security-policy/adapter版本、明確withdrawn releases和expiry。Runtime握手只能協商已認可profile；缺能力拒該AI action，但設定、停止、撤銷與原有可安全read保持可用。

舊但仍受支援的client不因中央發了一個無關minor就停工。已知不安全release則即使semver相容也拒絕執行。不要用接受任意 `^1`、或永遠固定一個舊hash，代替真正支援政策。

### 29.4 工作進行中更新

不熱換run attempt的contract、policy或model binding。相容patch依部署策略可於新attempt採用；不相容／緊急撤銷先fence舊attempt，保存late evidence與unknown effects，重新preflight再執行。

Coding agent session也保持exact bundle；基線變動提示只補delta，PR前對新candidate獨立驗證。不得在模型還用舊DTO推理時，底下library已被背景更新成新版。

### 29.5 離線與fetch失敗

可從已驗證cache建立exact checkout/context，在offline fixture繼續寫程式；不得改用未驗证latest或把fetch失敗當最新。PR／release需要可信policy freshness和所需驗證，缺資料回 `verification_unavailable`。

Runtime的local Stop不依賴線上policy fetch。新高影響effect在無法確認有效policy／keyset／Grant時fail closed；可用期限由已簽發permit與server政策限制，不自行延長。分發來源失效不必讓所有一般文件編輯或人類設定一起停擺。

### 29.6 例外管理

只允許有ID、scope、原因、owner、到期條件、替代測試的明確例外；由trusted policy採納，consumer自填沒有生效權。一般代碼債可逐步清理，不容許以例外放行token外洩、假測試、越權或修改已發布SQL。

到期會產生具體blocker及修復指引，不默默續期，不用單一 `allow_all` 或巨量永久allowlist。

---

## 30. 「同一組 key」的正確設計：同信任規則，不共享萬能秘密

### 30.1 三種不同的「同一」

**共同信任來源**：所有端確認同一套被批准的issuer、audience、用途、公鑰與演算法規則。

**同一連線reference**：同一位使用者在被允許的頁面／工作共用他的model_connection_id，由broker按當前資格解析；頁面不重複貼provider key。跨runtime仍驗custody／delegation，ref不是授權。

**不可共用的秘密**：別人的API key、site credential、裝置私鑰、簽發私鑰、vault KEK、GitHub App private key、deployment token，不能因為是同組repo就互相複製。

### 30.2 金鑰矩陣

| 用途 | 可共享／分發 | 私密持有者 | 明確禁止 |
|---|---|---|---|
| Contract/policy release驗證 | 公開trust anchor／publisher identity、signed manifest | 授權release signer | 把私鑰放進bundle／PRrunner |
| Execution token／permit驗證 | 按環境與用途固定的公鑰集合、issuer/audience/alg | 授權token signer | browser持有signing key；拿release key簽execution |
| Device proof | 裝置public JWK／thumbprint | 該裝置／OS keychain | 全組共享device private key |
| User API／CLI connection | opaque ref、本人可見狀態 | 本人官方CLI／local keychain／明選broker | 複製CLI OAuth給網站；A用B的額度 |
| Site/service credential | public site ID、scope metadata | 該站backend或短效workload identity | 前端.env／bundled key；冒充member |
| Vault KEK／DEK | key ID/version與最小metadata | 隔離broker／受權key管理 | R2當vault；主Worker也拿KEK |
| R2 object access | asset ref、server logical binding | 需要該bucket的Worker/ops角色 | 每repo放同一account-wideS3 key |
| GitHub／部署 | 操作結果與workload身份metadata | 既有Maintainer/ops，範圍分開 | 開發Agent或publicfork拿production token |

同一issuer發不同token時也要有互斥驗證規則，不能只驗signature就接受。RFC8725要求處理不同JWT用途的替換問題；typ/audience/claims/key用途都要明確驗證。[GOV-W06]

### 30.3 共用 verifier profile，不把credentials藏進SDK

`governance/trust` 只author公開profile格式與允許來源規則。真實public keyset由受權發布／rotation管理，client內嵌最小可信起点與批准的issuer/取key來源；動態cache必須驗來源、版本與有效期。

Verifier至少驗 algorithm allowlist、issuer、audience、typ、exp/nbf及時鐘容許值、key purpose/kid、環境、device proof、attempt/Grant/epoch與復原世代的相應條件。未知kid可做一次有界的可信keyset更新，仍找不到就拒絕；不採token自帶的任意jku/x5u URL。

不能把一組HMAC signing secret下發到所有extension作「驗證」，因為持有同一secret的端也能簽出憑證。採公開驗證、私密簽發的角色分離與經審查實作；不自寫crypto。

Runtime-public trust config、server-private credentials和domain授權是三份不同資訊。前端可取得公開issuer設定，不等於可以改它來連攻擊者端點；server永遠不從client config導出authority。

### 30.4 Rotation與restore

正常rotation：先可信公布新public key → 驗consumer可辨識 → signer用新kid → 舊key在明定的最長token TTL/clock/cache範圍內只驗不簽 → 移除。緊急撤銷可縮短相容窗口，server/runtime拒已撤版本；離線端只依既有短效許可行為，不能保證離線即時收到撤銷。

Trust-root更新要有原已批准路徑／受控軟體release，不能讓下載內容同時帶新root自證。Contract簽章根與execution簽章根按用途分離；即使同管理系統，也不用同一把private key。

Restore使用§16的不隨舊DB倒退的recovery generation，阻止舊token/refresh/policy撤銷記錄被舊snapshot復活。每個profile加wrong-environment、wrong-purpose、unknown-kid、expired-key、downgrade與restore反例。

### 30.5 實際開發體驗

一般Coding Agent只收到「用哪個client profile、哪個connection ref、允許哪個test環境」。Local/CI使用假key和隔離fixture；需要真實provider或staging權限的測試由有權runner以受控方式執行，report只有安全結果。

不要求每頁一把key、不要求每個Agent申請一個共享admin key，也不將私人secret放進CodingContextBundle。共用的library/config讓大家不需要自行處理秘密；共享帳密則是相反方向。

---

## 31. 實作工作包、反例驗收與併入要求

### 31.1 對原U0～U7的補充

| 工作包 | 實作範圍 | 相依／完成證據 |
|---|---|---|
| CG-A | 盤點各repo的現有AGENTS、lock、verifier、profile；固定治理source與id | 可先做；不重建已有bundle機制 |
| CG-B | ReleaseSet/lock v2相容、共用verifier、library分發 | CG-A；旧preview pins仍可驗，deterministic outputs |
| CG-C | CodingContextBundle/prepare/context入口、工具薄wrapper、subagent交接 | CG-B最小schema；Windows/macOS/Linux可解析路徑；未知Agent明示限制 |
| CG-D | Feature/module/page/operation描述與實際surface coverage | 與U1/U2/UI extraction並行；新入口無漏網 |
| CG-E | 共用libraries與import/resolution邊界 | 與U1～U5並行；雙垂直流程真正用同一核心 |
| CG-F | 可信verify、review-policy、保護設定與fork隔離 | CG-B/D；source-of-check反例；不只文字規則 |
| CG-G | 版本sync batch、runtime相容、key-purpose/rotation/restore | 與U5/U6；無自動跨repo寫入、錯key/舊client拒絕 |

先選 platform＋Agent Kit＋一個client repo試行完整鏈，確認工具輸出與負担，再透過同一repo onboarding流程接其他倉。原生browser不必等整個Chromium建置才加入contract conformance；resource-only repo只接合適的profile。

新repo由template產生正確入口／pins／workflow，再驗GitHub側保護實際存在；**複製template不是已設定ruleset**。中央`.github` repo可作community模板／導覽，但不是另一個契約權威，也不能假設所有repo會自動繼承其強制政策。

### 31.2 必須新增的32項測試（要求，不是已通過）

| ID | 反例／情境 | 預期 |
|---|---|---|
| GOV-01 | consumer修改vendor某DTO | 本機／可信CI拒絕；指向中央source修復 |
| GOV-02 | 同時修改bundle、lock hash、驗證root自簽 | 不被可信publisher基線接受 |
| GOV-03 | 同一build出現兩個互斥SDK版本 | resolution check拒絕，不能只看package.json |
| GOV-04 | 新頁面用私寫platform fetch繞client | import/operation邊界測試抓出，明確白名單不誤傷adapter |
| GOV-05 | 新API／queue／MCP入口未登記 | surface coverage拒絕 |
| GOV-06 | pageID只登記但實際route沒掛auth | behavior negative test拒絕 |
| GOV-07 | 從repo root啟Agent修改deep module | bundle包括該module規則；不只依AGENTS自動發現 |
| GOV-08 | Claude local/parent檔遮住AGENTS | launcher diagnostics顯示差異，wrapper按受測版本補載 |
| GOV-09 | Agent交接子Agent或換worktree | 子工作取得對應repo/head/bundle，不繼承錯repo context |
| GOV-10 | 長session跨模組／context重建 | 重新解析/提供delta，缺scope明示；CI最終scope獨立重算 |
| GOV-11 | 作者偽造context已讀receipt | 不能作verify依據；CI自己產evidence |
| GOV-12 | 刪AGENTS或縮module glob來免檢 | baseline/candidate差異與unknown fallback拒絕逃逸 |
| GOV-13 | PR把workflow改成echo pass | 不滿足可信workflow/publisher identity與suite要求 |
| GOV-14 | PR篡改selector或fixture為空集 | 可信基線／必跑反例仍執行，不能假綠 |
| GOV-15 | fork嘗試存取R2/prod/signing key | 測試環境無此權限／secret，不執行有權程式 |
| GOV-16 | selected job skipped/cancelled/failure | verify不是success |
| GOV-17 | head相同但base前進 | 新integration candidate證據或原生queue重驗 |
| GOV-18 | consumer還在受支援前一版本 | 相容操作正常，未支持的新operation拒絕 |
| GOV-19 | 已撤銷release仍符合semver | 新effect拒絕，不只按版本字串放行 |
| GOV-20 | contract shape不變但effect改成publish | 語意變更審查與安全測試，不能偷偷minor放行 |
| GOV-21 | TS/Rust canonicalization/enum解碼不同 | 相同golden/negative vectors抓出 |
| GOV-22 | 每份repo pin互相依賴造成循環 | release manifests不依賴未來consumer，工具拒自引用／缺artifact |
| GOV-23 | resource-only repo偷偷新增execution code | classifier提升required profile/測試，不能自稱文件型逃避 |
| GOV-24 | sync未授權或同repo已有upgrade PR | 不寫GitHub；有授權時更新同batch不重複開PR |
| GOV-25 | site token當member／permit當login | purpose/typ/audience拒絕 |
| GOV-26 | staging keyset/token打prod | 環境與issuer拒絕 |
| GOV-27 | token帶未知kid／惡意jku | 僅可信來源有界refresh，否則拒；不任意連外 |
| GOV-28 | public SDK含private/HMAC signing secret | secret/build boundary拒絕且查來源；不宣稱靠隱藏可安全 |
| GOV-29 | 修改某頁model ref使用他人額度 | broker驗owner/Grant/data policy拒絕 |
| GOV-30 | rotation與offline client／restore | 按TTL/recovery generation拒舊權限；Stop仍可用 |
| GOV-31 | 不相容policy工作中被升級 | fence/新attempt；歷史binding不被原地覆寫 |
| GOV-32 | 未安裝指定launcher的人類或自製Agent送PR | 仍可貢獻；相同產出驗證，不能由未受管理繞過merge |

測試evidence分「文件/JSON形狀」「本機工具」「隔離CI」「真實GitHub protection」「真實client/runtime」；前兩者PASS不能抄成GOV-01～32全通過。

### 31.3 第一輪可交付的最小成果

不是先生成全組所有文件，而是完成：一份中央policy/contract發布 → Agent Kit pin並用共用validator → 頭像與私人草稿兩頁取得正確context/operation/library → 兩個repo的PR在可信CI驗final diff → 故意手改vendor、改workflow、用錯key都被拒絕。

接著擴展其餘repo/頁面。系統介面呈現「repo/PR實際使用哪版、哪些surface尚未映射、哪個client過舊、缺哪項真實證據」，不要把文件數、agent讀取次數或hash數当治理成效。

### 31.4 Agent交接補充（併入§21，不作新的權限授予）

> 先由固定可信版本的prepare/context工具解析本次repo、base/head、contract/ReleaseSet與受影響modules/pages/operations。已生成的context是工作資料，不是執行授權；不得讀取prod秘密、改GitHub保護或自動升級全部repo。
>
> 優先使用已批准shared client/validator/command/asset library。不能在consumer複製schema、JWT verifier、平台fetch或同名共用function，不能改vendor/hash假裝中央release。缺能力時修改其canonical source並走相容候選契約流程。
>
> 跨repo/模組或base/pin變動後補載scope。交給subagent時包含確切context與可改範圍。最終PR由trusted CI依actual diff重算，不能以Agent自稱read/passed作證據。
>
> 同一套公鑰驗證規則不等於共享秘密。使用指定client profile／opaque connection ref；私人key不進文件、bundles、logs或fixtures。正常merge維持一次實質review＋人要求＋確定性執行。

### 31.5 本輪新增來源與證據限度

以下GitHub檔案本輪經連線讀取，記錄的是blob內容；沒有重新確認所有org repos/head、GitHub方案、規則設定或真實部署。工具與平台官方文件為本輪閱讀版本；實作須固定實際使用版本再驗收。

| ID | 來源／固定內容 | 用途 |
|---|---|---|
| GOV-C01 | platform `AGENTS.md`，blob `e6b8bcef28a0a5a55edb25eb2566ecc3c1d8b486` | 已有repo/目錄閱讀、中央契約與vendor責任 |
| GOV-C02 | Agent Kit `contracts.lock.json`，blob `239919a38b622e41ccb0fb82781c6f3020b82e42` | 已有exact source/protocol/bundle pins |
| GOV-C03 | Agent Kit `scripts/verify-contracts.mjs`，blob `5c4c953186ae92802472db100ad1a0292824d52f` | 已有檔案集合/hash/source核對，不是全組enforcement |
| GOV-C04 | platform `repositories.lock.json`，blob `a7c284a6351c60ef0dec6d251075d7f1f61a6f40` | 跨repo測試snapshot，不是線上inventory |

- [GOV-C01 固定blob](https://api.github.com/repos/FreeTWAI-AI/freedom-platform/git/blobs/e6b8bcef28a0a5a55edb25eb2566ecc3c1d8b486)
- [GOV-C02 固定blob](https://api.github.com/repos/FreeTWAI-AI/freedom-agent-kit/git/blobs/239919a38b622e41ccb0fb82781c6f3020b82e42)
- [GOV-C03 固定blob](https://api.github.com/repos/FreeTWAI-AI/freedom-agent-kit/git/blobs/5c4c953186ae92802472db100ad1a0292824d52f)
- [GOV-C04 固定blob](https://api.github.com/repos/FreeTWAI-AI/freedom-platform/git/blobs/a7c284a6351c60ef0dec6d251075d7f1f61a6f40)
- [GOV-W01 Codex AGENTS discovery](https://developers.openai.com/codex/guides/agents-md)
- [GOV-W02 Claude project instructions與AGENTS](https://code.claude.com/docs/en/memory)
- [GOV-W03 GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GOV-W04 GitHub rulesets與required workflows](https://docs.github.com/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GOV-W05 GitHub secure workflow use](https://docs.github.com/en/actions/reference/security/secure-use)
- [GOV-W06 RFC8725 JWT best practices](https://www.rfc-editor.org/rfc/rfc8725.html)
- [GOV-W07 npm ci（lockfile固定安裝語意）](https://docs.npmjs.com/cli/v11/commands/npm-ci/)

**本版新增的是可實作規格與驗收要求。CodingContextBundle工具、ReleaseSet簽发、module coverage、shared libraries改造、可信check publisher、key rotation演練和32項產品測試都尚未由本輪執行。** 未修改原repo、secret、ruleset、release或deployment；不以這份文件作「全組Agent已受控」的證明。
