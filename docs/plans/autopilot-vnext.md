<a id="overview"></a>

# Freedom Autopilot vNext — 三端整合設計規格

**平台端 × Chrome Extension × BrowserOS neo**  
版本：`0.1.0-design`　研究基準日：2026-10-01（America/New_York）  
狀態：**待實作的設計提案；不是已合併、已部署或已通過產品驗收的能力聲明。**

## 本次交付

本規格將「人與 Agent 共用工作網站、不同瀏覽器執行端、使用者自帶 CLI／API 模型能力」接入現有 FreeTWAI。保留中央會員與 PostgreSQL、公會／小隊／商店／作品、既有 Cloudflare 部署與人類確認邊界，不另造第二套會員或任務真相。

使用者要求落成以下產品決策：

- 使用者可以使用自己的 Freedom 存取憑證，也必須為 AI 工作綁定自己的模型來源：本人已登入的官方 CLI，或本人有權使用的 API key。
- 網站有獨立服務身分與自己的平台系統模型 key；不能因為使用者沒有模型連線，就偷偷用網站的 key 代跑。
- 不裝專用 browser 的使用者可以使用 Chrome extension。純 extension 採 BYOK API 模式；使用本機 CLI 時另需 Native Host。這個 Native Host 不是另一個瀏覽器。
- BrowserOS neo 使用同一份工作、授權、成果契約，但保留原本的 Rust browser backend、MCP、cockpit 與本機 replay。
- AI 設定是 **AI 開始執行的必要條件**，不是瀏覽社群、閱讀技能書、配對裝置或人工工作的登入門檻。

## 閱讀順序

| 文件 | 用途 |
|---|---|
| [00-architecture-and-decisions.md](#section-00) | 全局架構、研究後修正、產品模式、責任邊界 |
| [01-platform-spec.md](#section-01) | 平台 API、資料模型、工作狀態、UI、model broker |
| [02-extension-spec.md](#section-02) | MV3、權限、DOM action、安全與 native bridge |
| [03-browser-neo-spec.md](#section-03) | neo 實際目錄修改、Rust dispatch guard、cockpit／recording |
| [04-protocol-identity-auth.md](#section-04) | 使用者／網站 key、CLI／API 登入、token、執行協定 |
| [05-change-map-migration-acceptance.md](#section-05) | 逐檔修改、遷移、實作依賴、驗收案例與 CI |
| [06-research-source-index.md](#section-06) | 固定 commit、原始碼查證範圍與官方文件來源 |
| `contracts-draft/` | 六個核心 JSON Schema 的設計起稿，不是完整 OpenAPI 或可發布 ContractBundle |
| `fixtures/` | 假資料的正向／反向驗證案例，不含真實 key、帳號或客戶資料 |
| `tools/validate_spec.py` | 驗證本交付檔案、schema 與範例；不替代 repo 測試 |

文件中的 `[Pxx]`、`[Nxx]`、`[Rxx]`、`[Wxx]` 對應研究來源索引。**KEEP / MODIFY / NEW / GENERATED** 區分既有檔案與提議新增路徑。NEW 不是聲稱該目錄目前存在。

## 確定的研究基準

- `FreeTWAI-AI/freedom-platform`：`c78efb93cbf47f0812e17006c47413001b649a40`。
- `browseros-ai/BrowserOS`：`53c3799ce014e9fee05569802314a05d0bad3e40`。neo 與一般 BrowserOS 在同一個 monorepo，不能混用兩者 backend。
- Agent Kit、Skill Registry、Storefront、Supplier Client、Growth Automation：查閱各 repo 的 main 文件與指定檔案，索引記錄取得的 blob SHA；未把 blob SHA 假稱為整倉 commit。

本次已作原始碼與官方文件閱讀；未啟動正式網站的敏感操作、未跑上游完整測試、未建置 Chromium／neo、未用真實會員憑證登入供應商。現有 repo 的所有推送、分支、PR、正式資料與部署均未更動。

## 第一個應完成的端到端成果

會員登入 FreeTWAI → 配對 extension 或 neo → 自行完成 CLI 登入／BYOK 綁定 → 建立私人工作 → 一次授權指定資料與工具範圍 → Agent 產出商品或行銷草稿 → 人可暫停與接手 → 工作回報成果但不自動正式發布、不自動形成付款或貢獻驗收事實。

三端的介面可以同步開發；正式副作用只能在相應的授權與技術防護完成後啟用。這是技術依賴，不是增加委員會或反覆人工審批。

## 交接與檢查

[開發 Agent 接手指令](#handoff) · [本地檢查結果](#validation)。完整契約草稿與fixture請使用ZIP分章包；單檔版便於整體閱讀。


---

<a id="section-00"></a>

# 00｜全局架構與設計決策

## 0.1 目標與非目標

**目標：**把 FreeTWAI 從會員與協作入口，擴展為人與 Agent 共用的工作平台。使用者提出工作、選擇本人模型與執行端、授予有限權限；平台掌握工作真相；Agent 在允許範圍自主完成；需要人時精確交接。

**不是：**重寫 ERP、強制全員換 browser、把所有網站都用畫面點擊操作、用平台訂閱帳號代跑所有人、讓多套 runtime 自行維護互相衝突的任務資料庫。

通用核心使用 Person／Service Principal、Work、Grant、Runtime、Action、Result；公會、技能書、小隊、Seller 等繼續作為 Freedom 業務模組。未來其他網站可串接，不需要複製自由工坊的公會概念才能使用。

## 0.2 查證後必須修正的假設

| 原先容易誤解的說法 | 查證結果與本版決定 | 來源 |
|---|---|---|
| neo 是普通 BrowserOS 的 Bun Agent loop | neo 的 backend 是 `apps/claw-server-rust`；`apps/server` 是另一產品 | [N01] [N07] |
| neo dashboard extension 可直接裝到 Chrome | manifest 使用自訂 `browserOS` 權限；普通 Chrome 另寫標準 MV3 adapter | [N05] |
| 分頁 ownership 已經隔離 Agent | neo dispatch 明確把 ownership 作提示而非阻擋；Freedom-managed 模式需要強制 guard | [N04] |
| 網站直接連 localhost MCP 就能控制 | neo MCP 拒絕帶 browser Origin／sec-fetch-site 的請求；使用受信 bridge，不解除此檢查 | [N03] |
| 已有 client token 就能給 Agent 寫資料 | 現行 `fw_read_` 只讀 storefront／supplier；保持原範圍 | [P04] [P05] |
| 現有 command 可以換 user_id 供 Agent 用 | `command()` 會驗證真人 session；必須拆出 machine principal 驗證 | [P06] |
| WorkItem 已天然支援私人 Autopilot | 目前工作是社群協作、禁止 self-claim，且列表按 community 讀取；需新增私人模式與 ACL | [P07] |
| 有 MCP server 目錄代表已有正式執行 | Agent Kit README 與 preview metadata 明確未啟用通用執行 | [P08] [R01] |
| checkpoint 等於搬移登入 session | 本版只搬邏輯工作上下文與允許的成果；cookie、CLI OAuth、profile 不自動搬移 | 本版設計 |
| 一個 Boolean human_control 能處理接手 | 改用單一控制權 lease、epoch、排空中的動作與重新觀察 | 本版設計 |

## 0.3 目標拓撲

```text
                         FreeTWAI / Autopilot Web
                        人的工作桌面與核准入口
                                   │
                      Hono API + PostgreSQL 權威資料
                 會員 / 工作 / Grant / Lease / Result / Audit
                     │                         │
           Execution API + cursor      Credential Broker + Model Step
                     │                 使用者 BYOK / 平台系統連線
          ┌──────────┼────────────┐             │
          │          │            │             └→ provider API
   Chrome Extension  │       未來 Cloud Runner
   標準 MV3         │       獨立登入與隔離環境
          │     Freedom Browser（neo）
   選配 Native Host  Rust guard + MCP + cockpit
          │          │
          └──────┬───┘
           Freedom Agent Kit
          官方 CLI adapter / 工作 MCP facade
                 │
       本人登入的 Codex / Claude Code 等
```

圖中 model engine 與 actuator 分開：**CLI／API 模型負責提出下一步，extension／neo 負責執行；policy engine 才有權決定哪些下一步能執行。**任務可以使用 API 模型加本機 extension，也可以使用本機 CLI 加 neo，不把「模型供應商」和「瀏覽器種類」綁定。

## 0.4 五個明確產品模式

| 模式 ID | 使用者裝什麼 | 模型來源 | 工作在哪執行 | vNext 定位 |
|---|---|---|---|---|
| `extension_byok` | Chrome extension | 本人 API key，明確同意平台 vault／broker 保管 | 本機 Chrome；模型請求經 broker | 首發完整路徑 |
| `extension_cli` | Chrome extension + Freedom Native Host | 本人已登入的官方 CLI | 模型與瀏覽器操作在本機 | 首發完整路徑 |
| `neo_cli` | Freedom neo distribution + 已有 CLI | 本人已登入的官方 CLI | 本機 neo | 首發完整路徑 |
| `neo_byok` | Freedom neo distribution | 本人 API key；本機 broker 或同一平台 broker 明選其一 | 本機 neo | 共用 BYOK 契約，非另一套權限 |
| `cloud_byok` | 只用工作網站 | 明確綁定雲端執行的本人 API key | 獨立雲端 browser／runner | 契約預留；沒有建置驗收不得宣稱可用 |

CLI 模式須有 native process，不宣稱 extension 本身能 spawn CLI。[W01] 網站只是 UI 時也不可能單憑一般 JavaScript 取得使用者所有分頁／CLI。不同模式的安裝說明與「開始工作」條件在 UI 清楚分開。

`neo_byok` 首版優先復用平台 broker，減少本機不同 provider SDK；確有「key 不離機」需求時才啟用 Agent Kit 本機 provider adapter。此模式不可暗中轉成平台 custody。模型呼叫的位置、資料將離開的範圍都必須顯示。

## 0.5 Repository 責任

| Repository | 定位 | 是否持有中央業務資料 |
|---|---|---|
| `freedom-platform`（KEEP/MODIFY） | 執行契約唯一 authoring source、身份／工作／授權／結果／對外業務 API | 是，PostgreSQL |
| `freedom-agent-kit`（MODIFY） | SDK consumer、官方 CLI adapters、Native Host、工作 MCP facade | 否；只保留本機設定／spool／授權快取 |
| `freedom-browser-extension`（NEW，建議名稱） | 標準 Chrome MV3 client、DOM actuator、side panel、native bridge | 否 |
| `freedom-browser`（NEW，建議 fork 名稱） | 固定 neo upstream，增加 Freedom-managed execution 與 cockpit | 否；本機 replay／session DB 不作工作真相 |
| 既有 store／supplier／growth／registry | 消費同一契約；各自維護 adapter 與業務工具 | 否 |

不建立第二個 `freedom-agent-browser-protocol` canonical repo。本版更正前面對話的提議：協定放 `freedom-platform/contracts/execution/v1/`，由現有 bundle 流程產出 pinned SDK、JSON Schema、Rust DTO consumer。外倉不能手改 vendor。

## 0.6 核心不變式

| ID | 必須維持的規則 |
|---|---|
| INV-01 | 未登入本人有效 CLI、也沒有可用本人 API 連線，不能啟動使用者 AI run；配對／人工／公開閱讀仍可用 |
| INV-02 | 平台登入、模型登入、網站服務身分與 browser 控制權各自驗證，互不冒充 |
| INV-03 | 長效 user key／site key 不直接授予執行；每個 run 綁定可撤銷 Grant 與特定 runtime |
| INV-04 | 只有平台改寫中央工作、會員、權限與成果事實；本機資料為執行證據或暫存 |
| INV-05 | 相同控制範圍只有一個控制者；舊 epoch／lease 的命令一律不得執行 |
| INV-06 | 所有副作用先有 ActionIntent；timeout 不當成可安全重送，先 reconciliation |
| INV-07 | 外部頁面／Skill／MCP 輸出都不能新增權限或取得秘密 |
| INV-08 | API key、OAuth、cookie、refresh token 不放 model prompt／log／event／repo／前端 bundle |
| INV-09 | 純 extension 不宣稱具備 OS sandbox、跨 profile 隔離或 browser 關閉後繼續執行 |
| INV-10 | AgentRun completed 不等於付款、正式發布、人類驗收、XP 或貢獻成立 |
| INV-11 | 同一平台只有一份 WorkItem 真相；GitHub code collaboration 仍以 GitHub issue／PR 為準 |
| INV-12 | 額度不足只能等待、換本人明選的連線或取消；不得自動改用網站 key／更貴模型 |

## 0.7 不以 prompt 代替 enforcement

`ActionIntent.effect = "draft"` 是模型的宣稱，不是可信分類。中央 policy 与已安裝 adapter 必須交叉驗證命令、目標帳號、資料欄位與真正要呼叫的 operation。對自家平台直接使用有權限的業務 API，不用 browser 點擊繞過交易規則。

對未知第三方網站，不能保證任何 click 都無副作用。「草稿編輯」可能自動保存、按 Enter 可能送出、瀏覽 URL 也可能觸發操作。無法判斷時只允許受監督操作、提升確認或回 `effect_unclassified`，不可把未知行為假稱 A1。

## 0.8 安全能力等級，而非誇張的“完全受控”

| 等級 | 執行環境 | 可信邊界 |
|---|---|---|
| `assisted_local` | 一般 Chrome profile + extension | 工具代理可限制命令，但不是對抗同 OS 惡意軟體／使用者自行修改的安全邊界 |
| `managed_local` | Freedom neo + enforced dispatch + 經配對的 CLI | 對經 Freedom 執行路徑的命令強制授權；原生 CDP／OS 權限仍須額外封閉 |
| `isolated_remote` | 驗收過的隔離雲端 runner | 另外檢查租戶網路、profile、檔案、secret 邊界；不是只開一個 tab 就成立 |

服務端不能把自報 `managed_local=true` 當硬體 attestation。需保存 build 身分、版本、檢查證據與信任分類；高敏工作可要求較高級別，沒有相符環境就明確拒絕該執行，不阻止普通參與。

## 0.9 一次授權、範圍內自主

使用者確認一次工作範圍：能讀什麼、可以改什麼、哪個網站／帳號、哪些接收者、模型與成本上限、何時停止。模型的每一步仍走機器 policy check，但不每一步彈出人類核准。

A4 繼續依現有 canonical 的精確決策定義，不能把全部「click」或全部「publish」機械分類成同一級。正式／production release、付款與法律承諾維持現有簽署邊界。UI 顯示簡單的「可自行完成／完成後請我核准」，技術規格保存 exact digest、actor authority 與來源。

## 0.10 技術棧控制

平台保留 React/Vite、Hono、PostgreSQL、jose、zod、Cloudflare Worker/Hyperdrive。[P01] [P10] 不因 neo 使用 Rust、Bun、Go，就把平台改寫成同一套。首版排程採既有 PostgreSQL outbox 加短工作 consumer；不新增 Redis、Kafka、Temporal 或另一個權限後端。

新增 Cloudflare Queue 可作 outbox 通知 transport；DB commit 後才能 dispatch，queue 只放 IDs，不是任務真相。WebSocket／Durable Object 可後續改善即時通知，但 API cursor replay 與 DB lease 必須在沒有它時也正確。原本公開與 staging 路由、DB isolation、Hyperdrive 關閉查詢快取全部保留。


---

<a id="section-01"></a>

# 01｜平台端規格

## 1.1 現況與修改切面

原始碼查證：平台使用 runtime-neutral `createPlatformApp()`，Node 與 Cloudflare 分別作 host adapter；資料 mutation 經 `packages/db/index.ts`；目前公開 preview 協定沒有通用 external job execution。[P01] [P02] [P06] [P08]

本版不把 Agent 接在既有 cookie middleware 後假裝真人，也不改掉 `client-api/v1` 的唯讀性。新增四個內聚模組：

| 新模組（NEW） | 唯一責任 |
|---|---|
| `modules/agent-control/` | AgentConnection、裝置配對、execution token、Grant、principal 驗證 |
| `modules/agent-execution/` | Run、TaskLease、ControlLease、ActionIntent、checkpoint、receipt、reconciliation |
| `modules/model-connections/` | 模型連線 metadata、驗證狀態、InferenceBinding、預算與用量 |
| `modules/site-applications/` | 站點 client／service principal、站點 credential、origin／redirect registry |

`modules/opportunity-project-work/` 保持 WorkItem 與人類協作的 owner；新增 personal-execution mode 與 ACL，不把整個 work domain 複製到 agent-execution。

## 1.2 登入與首次使用 UI

保留既有 email/member onboarding。新增「AI 與裝置」設定：

1. **連線到 Freedom**：已登入會員配對 extension／neo／native host；顯示裝置名稱、平台環境、要求範圍與到期日。
2. **選擇本人模型來源**：`使用我已登入的 CLI` 或 `綁定我的 API key`。不能預選平台 key。
3. **驗證可用性**：CLI 透過官方 adapter 檢查，API 經最低成本權限驗證；需要模型試呼叫時先告知。存狀態與證據級別，不存驗證過程的秘密輸出。
4. **選執行端與網站範圍**：extension／neo、已授權的網站、需要處理的資料、最大步數與期限。
5. **開始工作**：server 重新驗證，而非只相信前端綠色 Ready。

狀態文案：

| 狀態 | 畫面與可行動作 |
|---|---|
| `unpaired` | 連接裝置；仍可瀏覽會員功能 |
| `engine_missing` | 請登入你的 CLI 或綁定 API key；不得呼叫模型 |
| `engine_auth_required` | 前往官方 CLI 登入或重綁 key |
| `runtime_offline` | 裝置離線；可存草稿，不假裝執行 |
| `ready` | 顯示模型、付費來源、執行位置與允許範圍 |
| `quota_exhausted` | 暫停等待本人處理；不換付費來源 |
| `permission_required` | 缺指定網站、檔案或能力的授權，其他會員功能不受影響 |

「我有 CLI」不是已登入；「key 格式正確」不是驗證成功；「之前成功」不等於今天仍有效。

## 1.3 人與 Agent 共看的工作頁

保留現有 `App.tsx`／`Navigation.tsx`／`TabId` 結構，新增 `autopilot` 與 `agent-connections` 入口；先不為此引入新 router。可用 hash 深連結至特定工作，API 始終用實體 ID。UI 維持現有 DESIGN tokens，不重作另一套 dashboard 品牌。[P09]

### 工作首頁

同一頁呈現 `需要我處理`、`執行中`、`等待裝置／額度`、`已提交成果`。數量從有權看的 API projection 算出；本機已報告成功但尚未核對的任務不能塞進「已驗收」。

### 工作詳情

固定欄位：目標、owner／小隊、工作版本、模型／費用來源、runtime 與能力級別、Grant 摘要、最近可信狀態、完成條件、來源與成果。提供 Pause、Take over、Resume、Cancel、Revoke、Review artifact。

畫面／replay 區為選配，沒有畫面分享權限時仍提供狀態與簡明 action timeline。「人與 Agent 共看」表示共用工作事實，**不等於自動直播整台電腦或所有私人分頁**。

Agent 說明只保存可公開的執行摘要、選擇理由、tool result 與疑問，不要求或展示模型隱藏 chain-of-thought。GameConsole 只接安全的 projection event，不作權限判斷或憑證輸入框。

### A4 頁

使用獨立可信的同源人類確認頁，顯示 immutable artifact、目標與後果；本人的有效 session、CSRF、當前權威及必要 step-up 驗證後簽署。Agent 工具不得操作此頁，也不能接受一般聊天「OK」代替簽章。使用 WebAuthn 時 challenge 綁 artifact digest；在此驗證尚未實作前維持現有手動確認路徑，不虛稱已有 A4 cryptographic assurance。

## 1.4 WorkItem 的改法：不要只放寬 self-claim

目前 `createWork` 產生 voluntary contribution，`listWorks` 以 community 查詢，`claimWork` 禁止 owner 認領自己的工作。[P07] 直接去掉 self-claim 檢查會破壞協作／貢獻規則。

新增：

| 欄位 | 語意與遷移 |
|---|---|
| `work_mode` | `community_collaboration`（舊資料預設）、`personal_execution`、`service_operation` |
| `visibility` | 舊資料維持原本 `community`；私人新工作預設 `private`；可明確改 `squad`／`organization` |
| `owner_principal_id` | 新的 Person／Service principal；舊 `owner_ref` 保留與 person backfill，直到相容遷移完成 |
| `execution_policy_revision` | 執行模型、接手、資料出口的不可變版本參考 |
| `external_work_ref` | GitHub issue／PR 等權威來源；平台只維護對應關係与執行紀錄 |
| `requires_ai` | 依 command／workflow server 派生，client 不可設 false 逃避模型綁定 |

個人工作由 owner 授權自己的 AgentRun，不需要建立一個「別人認領自己」的虛構 WorkClaim。協作工作仍需有效人類 Claim，AgentRun 引用該 Claim 執行。平台服務工作需獨立 ServicePrincipal，不借用管理员的人類 session。

ACL 必須同時涵蓋：list、detail、search、dashboard、events cursor、notifications、artifact fetch、share link、export。所有查詢先由伺服器解析 principal／community；不得只在 React filter 列表。新增 private mode 之前必須先落 query ACL，避免新列被現有全 community API 洩漏。

三類完成分開：`AgentRun completed` → `Result submitted` → 業務 `accepted/published/confirmed`。不跨層自動跳狀態。

## 1.5 資料模型與索引

以下為邏輯 schema。SQL migration 採實作當下的下一個 sequence，**不覆寫既有 migration，也不假設目前最後號碼**。新 canonical UUID 沿用現有資料庫 ID 風格；不要為這次整合把全部舊 ID 重寫。

| Table（NEW unless noted） | 核心欄位 | 關鍵約束／索引 |
|---|---|---|
| `execution_principals` | id、community_id、kind=user/service、user_id 或 site_application_id、status | owner 二擇一；user 不能偽造 service；tenant 複合唯一 |
| `runtime_devices` | id、owner_principal_id、kind、public_jwk、jkt、build_ref、capability_snapshot、status、last_seen_at、revocation_version | 公開 key 不授業務權；device/environment 唯一 |
| `agent_connections` | id、principal_id、runtime_id、client_id、bootstrap_scopes、refresh_hash、expires_at、revoked_at、version | refresh family/reuse detection；原 `member_client_connections` 不變 |
| `model_connections` | id、owner_principal_id、provider、mode、custody、secret_ref 或 local_handle、auth_evidence、status、verified_at、expires_at | 禁明文 key；模式與 custody 一致；owner+ID 查詢 |
| `site_applications` | id、owner_principal_id、name、verified_origins、redirect_uris、allowed_scopes、status、version | public ID 不等於 auth；domain 驗證不授會員權 |
| `principal_access_keys` | key_id、principal_id、prefix、hash、scopes、environment、expiry、revoked_at | 僅 hash；絕不把 provider key 放此表 |
| `site_credentials` | key_id、site_application_id、hash 或 public_jwk、purpose、expiry、revoked_at | server credential，只允許 service scope |
| `execution_grants` | id、principal_id、agent_connection_id、runtime_id、site_id、work_id、revision、digest、scope_snapshot、state、validity、revocation_version | immutable scope；擴權要新 grant，不能原地修改 |
| `agent_runs` | id、work_id、claim_id?、principal_id、runtime_id、grant_id、model_connection_id、inference_binding、state、version、current_lease_epoch | 一個 run 固定付費來源；改來源是顯式新 binding/revision |
| `task_leases` | run_id、holder_connection_id、epoch、lease_expires_at、heartbeat_at | run_id current lease 唯一；CAS fencing |
| `browser_session_bindings` | id、run_id、runtime_id、local_session_ref、profile_scope_ref、tab_scope_digest、state | external ref 不授權；scope 不由 self-report 擴大 |
| `control_leases` | scope_id、controller=agent/human/none、epoch、state、expires_at | 一個 tab/profile resource lock 對應唯一 active controller |
| `action_intents` | id、run_id、step_id、effect_class、target_ref、args_digest、artifact_digest、state、permit_nonce、dispatch_id、provider_ref | unique(run_id,step_id)；相同 id 不得換 payload |
| `execution_receipts` | id、intent_id、runtime_id、lease_epoch、evidence_kind、result_ref、result_digest、received_at | unique(intent_id,dispatch_id)；late evidence只進 reconcile |
| `execution_checkpoints` | id、run_id、sequence、safe_state_ref、completed_intent_ids、unknown_intent_ids、digest | unique(run_id,sequence)；不含 cookies/auth caches |
| `execution_events` | run_id、sequence、event_id、type、safe_payload、received_at | unique(run_id,sequence)、event_id dedupe；cursor per-authorized stream |
| `inference_attempts` | run_id、step_id、attempt、connection_id、status、reserved_units、usage、provider_request_ref | 唯一 attempt；provider timeout 記 unknown，不無限重送 |
| `execution_budget_reservations` | owner、period、run、currency、reserved_minor、consumed_minor、status | 原子 reserve；CLI unknown usage 不捏造 dollars |
| `credential_vault` | ref、ciphertext、wrapped_dek、nonce、key_version、owner、rotation metadata | 隔離 role；只有 broker 解密；不可經一般 domain API 讀取 |

最小首版可以將 session binding／control lease 放同一個狹義 execution 模組，不拆成獨立服務。不要因表多就建立同等數量的 Worker。

## 1.6 command() 改造

現行 `command()` 鎖 active user 與真人 session、檢查授權後處理 command_receipts，再在 transaction 內執行。[P06]

改成三層，保留舊呼叫端：

```text
memberCommand(old Command) ─→ validateMemberSession ─┐
                                                   ├→ transactionalCommandCore
executionCommand(machine context) → validateRun ───┤     idempotency / expected version
                                                   │     domain mutation / journal/outbox
serviceCommand(site actor) → validateServiceScope ──┘
```

`validateRun` 必查 active owner、current connection、model readiness（AI 命令）、grant、runtime、lease epoch、target、scope 與 revocation；不建立假的 `session_hash`。domain function 改收已驗證的 principal context，不能直接信任任意 object 符合 TypeScript interface。

舊 `command_receipts` 不強改 key 空間；新 `execution_command_receipts` 或共用表的明確 discriminator 保存 principal+operation+idempotency scope。相同 key 不同 body 回 conflict。重新授權失效後的 replay 不得洩漏舊私人回應。

金鑰簽發、token rotation 不走可保存原始 response 的一般 receipt 模式。使用一次性 secret 交付加短 TTL 加密重播，或明確丟失即重新配對；不把 secret 放 `response JSONB`。[P06] 新跨語言簽章使用 JCS；舊 `digest()` 產出的歷史 digest 保持原算法版本，不重算。[W10]

## 1.7 平台 API 範圍與 mount 規則

新規格選擇 `execution-api/v1` 為 machine surface，human 設定仍 `/api/v1`。舊 planning 的泛用 `/api/v1/agent-runs` 等路徑在 canonical 修訂中明確改為此 surface；**不默默維持兩條授權行為不同的 alias**。現有 member／client／shop API 完整保留。

下表是目標 API，不是現在已存在的 endpoints。所有 mutation 必須做 schema validation、body limit、版本／idempotency／權限檢查。

### 人類 UI（cookie + CSRF + Origin + member/owner）

| 方法與路徑 | 動作 | 必要規則 |
|---|---|---|
| GET `/api/v1/me/agent-overview` | 裝置與模型總覽 | 本人 scope；不回 secret |
| POST `/api/v1/me/access-keys` | 簽發本人 Freedom key | 指定期限與 bootstrap scopes；一次顯示 |
| POST `/api/v1/me/access-keys/{id}:revoke` | 撤銷 | owner + expected version |
| POST `/api/v1/agent-pairings/{code}:approve` | 核准 device | exact client/device/environment/scopes |
| GET `/api/v1/me/agent-connections` | 列出與健康狀態 | live/last_seen 分開 |
| POST `/api/v1/me/agent-connections/{id}:revoke` | 停用裝置連線 | cascade 禁止新 permit，in-flight reconcile |
| POST `/api/v1/me/model-connections` | 建本人 BYOK metadata 或 CLI binding | provider/custody allowlist；server derives owner |
| POST `/api/v1/me/model-connections/{id}:verify` | 最小驗證 | 節流；有費用試呼叫需明示 |
| POST `/api/v1/me/model-connections/{id}:revoke` | 停止後續模型請求 | 無法抹掉已發生的 provider charge |
| POST `/api/v1/me/credential-ingests` | 一次性 provider secret 傳入 | 專用無 body logging path；不納普通 receipts |
| POST `/api/v1/me/site-applications` | 註冊本人網站 | public client ID；verification 狀態分開 |
| POST `/api/v1/me/site-applications/{id}:issue-key` | 簽發網站 backend key | 不可下發給前端；不能簽 A4 |
| POST `/api/v1/autopilot/works` | 建個人工作 | private default；引用同一 work_items |
| POST `/api/v1/execution-grants` | 一次授權工作範圍 | 人類確認 snapshot；不依模型自報擴權 |
| POST `/api/v1/execution-grants/{id}:revoke` | 撤銷工作授權 | epoch/revocation 遞增 |
| POST `/api/v1/autopilot/runs` | 人類要求開始 run | 共用 start service，不繞 engine/grant 檢查 |
| GET `/api/v1/autopilot/works/{id}` | 共用工作桌面 | ACL 對 work/result/screenshots 都成立 |
| POST `/api/v1/autopilot/runs/{id}:pause` | 排空並暫停 | 不能把已送出操作當未發生 |
| POST `/api/v1/autopilot/runs/{id}:takeover` | 取得 human control | 改 epoch、等待 actuator acknowledge |
| POST `/api/v1/autopilot/runs/{id}:resume` | 放回 Agent | fresh observation + preflight |
| POST `/api/v1/autopilot/runs/{id}:cancel` | 終止新工作 | 已發生副作用保留與核對 |
| POST `/api/v1/signature-requests/{id}:confirm` | 精確 A4 簽署 | human-only、artifact digest、step-up；無 machine alias |

### Agent／runtime（device-bound token，不收 member cookie）

| 方法與路徑 | 動作 | 必要規則 |
|---|---|---|
| POST `/execution-api/v1/auth/device-authorizations` | 啟動配對 | 無執行權；rate limit；code TTL |
| POST `/execution-api/v1/auth/token` | device exchange／refresh／bootstrap-key exchange | token family、DPoP、audience；不得換到 A4 |
| GET `/execution-api/v1/bootstrap` | 最小 status/feed | bootstrap read only；不直接取私人完整頁面 |
| PUT `/execution-api/v1/runtimes/{id}/capabilities` | 能力聲明 | authenticated runtime；聲明不等於驗收/授權 |
| POST `/execution-api/v1/model-connections/{id}:observe-auth` | 本機 CLI 驗證回報 | device proof；明列 local_observed；不回 OAuth |
| POST `/execution-api/v1/runs:preflight` | 檢查一次候選工作 | 結構化 blockers；不發副作用 |
| POST `/execution-api/v1/runs` | 建 run 與首個 TaskLease | 同 transaction；驗 Grant＋本人模型 |
| POST `/execution-api/v1/runs/{id}:advance` | 排入下一個模型步驟 | 本人已綁定模型／預算／Grant；同step冪等，回202，不接任意proxy payload |
| POST `/execution-api/v1/runs/{id}:heartbeat` | renew current lease | CAS epoch；不偷偷改 runtime |
| GET `/execution-api/v1/runs/{id}/commands?after=...` | 領取有序指令 | 只供本 runtime；bounded cursor |
| POST `/execution-api/v1/runs/{id}/events` | 有序狀態回報 | idempotent，缺口處理，不直接改任意 Work |
| POST `/execution-api/v1/runs/{id}/checkpoints` | logical checkpoint | schema safe fields，無 cookies／CLI auth |
| POST `/execution-api/v1/runs/{id}/actions` | 提出 ActionIntent | service 重新分類 effect／解析 target |
| POST `/execution-api/v1/actions/{id}:authorize` | mint narrow action permit | grant/current epoch/target/data policy；短效單次 |
| POST `/execution-api/v1/actions/{id}:begin` | 原子標記 dispatch | permit digest + nonce，重播禁止再次執行 |
| POST `/execution-api/v1/actions/{id}/receipts` | 提交結果 | evidence type／source；unknown 必走核對 |
| POST `/execution-api/v1/runs/{id}:complete` | 完成執行 | 無 unknown action；不等於業務 accepted |
| POST `/execution-api/v1/runs/{id}:fail` | 失敗／等待資訊 | safe reason，不把 token/stack 回傳 |
| POST `/execution-api/v1/runs/{id}/signature-requests` | 請人簽署 | 只能建立 request，不能 approve |

### Model broker

Browser client 不提供任意 provider URL＋key 的一般代理 API。平台 orchestrator 在授權後呼叫內部 `ModelStep` service：輸入 `{run_id, step_id, binding_ref, context_ref, allowed_tool_catalog_ref}`，回覆結構化建議或 error；只有 broker 解析 `secret_ref`。

user-facing `:advance` 只能喚起一個既有 run 的下一步，不可直接夾帶任意 payload 通過 owner 的 key 代發第三方 HTTP。回傳 202/operation ref，避免 extension 在一次 fetch 等長時間模型推論。

## 1.8 Run 與 action 狀態機

本版定義 execution-v1 狀態；需同步修訂原 planning state 文件與 fixtures，不能另外留一組同名但不同語意的 enum。

```text
created → preflighting → ready → running → completed
                │                    ├→ waiting_human → ready
                │                    ├→ waiting_engine → ready
                │                    ├→ paused → ready
                │                    ├→ blocked（runtime_offline）→ preflighting
                │                    ├→ blocked（runtime_offline）→ preflighting
                │                    ├→ blocked（runtime_offline）→ preflighting
                │                    ├→ reconciling → running / waiting_human / failed
                │                    └→ failed
                └→ blocked → preflighting
created/ready/running/waiting*/paused/blocked → cancelling → cancelled
```

`completed` 需要所有 required outcomes 已保存、沒有未查明副作用。`cancelling` 不立即等於 cancelled；要收斂在途 effects。若無法確定，標 reconciling 並顯示「已停止新操作，仍在確認先前結果」。

```text
ActionIntent:
proposed → authorized → dispatching → succeeded
               │             ├→ failed_known
               │             └→ result_unknown → reconciling → succeeded / failed_known / manual_unknown
               └→ expired / revoked
```

使用 provider 冪等 key 的動作可依 provider 規則重送；browser click 沒有天然冪等性，不能把「我們有 intent_id」誤當外站已 dedupe。unknown 時先觀察外站資料或請人核對。

## 1.9 排程、lease 與資料一致性

使用現有 journal/outbox transaction 模式。`startRun` 在同一 DB transaction 鎖 active principal → connection → grant → work → run/lease，建立 run、epoch、outbox。不得先送 Queue 再 commit。

建議初值（都是本版設計預設，不是現行實作）：run lease 90 秒、active heartbeat 20 秒、action permit 5 秒、每個 scope 最多一個 mutation in-flight。讀取／模型思考可以非同步，但 effect 提交以目前 lease 為準。全域 lock order 在 helper 內統一，revoke 與 renew 採相同順序。

掉線後新的副作用停止；過期 lease 只容許 late evidence 入 reconcile，不容許舊 runtime 再 commit 工作狀態。平台不能收回已送到外站的 HTTP 或已發生的 click；UI 不承諾 instant rollback。對已發出的 5 秒 permit 存在有界撤銷競態，收到本機 revoke 後立即拒絕未執行指令，還未收到則以 permit 到期封口。

首版採 cursor HTTP polling。活躍頁2–5秒刷新通知；idle退避30–60秒；真正狀態與事件可補讀。不要讓 UI refresh 長期佔用 DB connection，也不要用平台 cron 的10分鐘頻率假裝即時控制。

## 1.10 model broker 與費用

每個使用者 run 綁 `InferenceBinding`：`owner_principal_id`、`model_connection_id`、`provider`、`model_id`、`execution_location`、`billing_source`、`max_steps`、`max_input/output_tokens`、`budget_policy`、`fallback=none`。run 建立後不可默默切換。

平台系統的索引摘要／站內服務工作使用 `platform_system` 連線與 ServicePrincipal，與 `user_api`／`user_cli_subscription` 的成本分開。這不表示平台取得會員網站 session 或可用系統 key 代表會員對外發送。

API 模式每步先保留 token／成本上限，再呼叫 provider，完成釋放差額。價格表帶來源與觀測日期；未知價錢不亂估。timeout 已可能計費，存 `usage_unknown`，不要在 UI 把它清零。

CLI 訂閱的精確剩餘額度未必可觀測，狀態用 `available/limited/unknown/exhausted`，不捏造剩餘百分比。額度耗盡暫停，不自動換 API。CLI 還有自己的內建工具與費用行為，若 adapter 無法實施相應 cap，capability 顯示 unsupported，不能聲稱精確的美元 hard cap。

`provider_endpoint` 採明確 allowlist。自訂兼容端點需獨立登錄與風險說明；禁止 redirect 帶出 Authorization、禁止 metadata／private-network SSRF、禁止把別人傳入的 baseURL 當可信。API key 無法證明某自然人身分相同，因此 UI 是「本人聲明有權使用，服務驗證可用」，不是「供應商已驗明本人」。

## 1.11 credential vault 與基礎設施

新增最小隔離 broker Worker/服務邊界，public API worker 不持有解密 KEK。可與同 repo 共用 build，但使用獨立 service binding／部署權限／DB credential role。明確理由是保護使用者 provider secrets，不是一般業務模組微服務化。

Vault 存 per-record AEAD ciphertext、nonce、wrapped DEK、key version；正常 DB domain 只存 ref。開發用假的測試 key，不用正式 provider key。Secret ingest path 不套 body logging、tracing capture、WAF payload留存；無法關閉該資料捕捉就不啟用此 custody。

網站服務 key、platform signing key、GitHub App private key、vault KEK 的用途分離。沿用現有 maintainer Worker 與公開 Worker 的 key 分離，不為了省檔案把其秘密合併。[P10]

預設中央只保存任務必要 metadata 與經同意的 artifact。客戶機密禁止中央持久化時，模型 context 由允許的本機路徑傳遞；不能為了「回放」放進 R2。新增 R2/Queue binding 要在每個環境明確配置及 readiness checks，零值 template 不當資源不存在的證據。

## 1.12 網站自己的 key 與嵌入整合

`SiteApplication` 支援自由工坊本身及其他擁有者註冊的網站。前端只看到 public `site_id`；backend 透過自己的服務 key／私鑰交換短效 service token。網站 key 只能做站點允許的操作，例如提供該站資料、提出工作草稿、查自己的執行摘要。

涉及會員工作時必須同時具備 membership/owner policy 和本人 delegation；site key 不帶 `user_id` 就可變成任何人。沒有 backend 的靜態網站不放秘密，改用 public ID + 會員授權 flow。站點宣告的工具 discovery 是候選資訊，不可跳過平台 registry 審查與工具範圍。

網站自己的 LLM API key 是一筆 owner=site/service 的 `ModelConnection`，不是 `SiteCredential`。使用者 AI 工作預設不消耗它。將來若做贊助額度，需獨立產品政策、provider允許、本人明示與獨立計費，不用 fallback 偷渡。


---

<a id="section-02"></a>

# 02｜Chrome Extension 端規格

## 2.1 產品邊界

建議新 repo：`FreeTWAI-AI/freedom-browser-extension`（NEW；本次未建立）。標準 Manifest V3、TypeScript、React、Vite，與中央產出的 execution SDK 共用 DTO。不要複製 neo `claw-app` manifest、`browserOS` 自訂權限或全部記錄行為。[N05] [N06]

目標是「原有 Chrome 的工作 side panel + 受授權 DOM actuator」，不是完整 Chrome replacement。支援既有網站登入，但**不代表 extension 要讀取或匯出 cookie**。在已授權頁面執行仍可能使用該 profile 的登入狀態，這是需要向使用者清楚告知的風險。

MVP 不提供任意 `eval`、通用 CDP console、讀整個硬碟、全 profile 匯出、無人授權跨網站操作或假的持續背景運算。對普通 Chrome 的限制要回傳 capability unavailable，而非暗中改用其他工具。

## 2.2 兩種正式使用路徑

### A. 不安裝任何本機工具：extension + 本人 API key

```text
Side panel → 配對 Freedom → 本人 BYOK 綁定與驗證
   ↓
建立／選工作 → 平台產生 model step → 提出結構化 ActionIntent
   ↓
平台 policy 發短效 permit → extension 檢查本機 scope／epoch／page
   ↓
已打包的 DOM executor → safe receipt → 平台下一步
```

模型 key 預設在使用者同意的中央 vault；extension 只持連線 ref 與 Freedom 短效 token。這是為了免裝 native host 的明確取捨。沒有同意 cloud key custody，就選本機模式，不能假裝「key 不離機」卻送到平台。

### B. 使用本人 CLI：extension + Native Host

```text
Side panel → Native Messaging → Freedom Native Host
                                    ↓
                          官方 CLI 本人登入／本機模型執行
                                    ↓
                         工作 MCP facade / proposed actions
                                    ↓
                   平台 Grant → extension actuator → receipt
```

Native Host 由簽署安裝程式註冊，UI 明示一次安裝；extension 不能自己任意執行 shell 安裝。Chrome 提供與已註冊 host 的訊息通道，並不把 extension 變成可隨便啟動 CLI 的 OS 程序。[W01]

同一份 extension build 可宣告 optional nativeMessaging；實際 release 的 manifest／商店權限檢查需驗收，不能以本稿 manifest 當商店保證。未安裝 host 時 `native_host_missing`，API 模式仍可用。

## 2.3 建議目錄（全部 NEW）

```text
src/
  background/
    index.ts                 # MV3 事件註冊，不能持有唯一工作狀態
    pairing.ts               # Freedom 配對／refresh
    command-poller.ts        # cursor / backoff / bounded fetch
    action-dispatcher.ts     # local policy + permit + command routing
    permission-manager.ts    # host grant + application grant 雙檢查
    native-host.ts           # connectNative bridge
    state-store.ts           # safe cache / dispatch journal
  sidepanel/
    main.tsx
    App.tsx
    WorkList.tsx
    WorkDetail.tsx
    ConnectionSetup.tsx
    GrantSummary.tsx
    HandoffControls.tsx
  content/
    observer.ts              # 授權頁面 structured snapshot
    executor.ts              # 僅打包好的 action vocabulary
    target-registry.ts       # document-bound node refs
    redaction.ts             # capture 前遮罩
  adapters/
    platform.ts              # 優先業務 API，不讀任意私有資料
    generic-dom.ts           # assisted 級別，不宣稱語意保證
    sites/                   # 隨 extension release 打包的網站 adapter
  protocol/
    client.ts                # 生成 SDK 的薄 wrapper
  security/
    local-policy.ts
    sender-validation.ts
    protected-origins.ts
    schema.ts
  options/
    index.html
    main.tsx
manifest.template.json
vendor/freedom-platform/      # GENERATED / pinned，禁止手改
contracts.lock.json
native-host-manifest/        # template，不含使用者私有路徑／key
 tests/{unit,integration,e2e,fixtures}/
```

建置流程以 `tsc`、`vite build`、schema驗證、manifest檢查為主，不因 extension 再引入全套 backend framework。中央 UI component 不硬搬；可共用 design tokens 和安全展示 helpers，不共用 cookie client。

## 2.4 Manifest 與權限策略

最低 Chrome **API 相容基線**建議120（side panel 與 worker alarm 功能足夠）；安全支援政策只覆蓋仍被 upstream 維護的版本。120 不是建議使用者停留在古老版本，也不是本次實測結果。[W02] [W05]

```json
{
  "manifest_version": 3,
  "name": "Freedom Autopilot",
  "version": "0.1.0",
  "minimum_chrome_version": "120",
  "background": {"service_worker": "background.js", "type": "module"},
  "action": {"default_title": "Freedom Autopilot"},
  "side_panel": {"default_path": "sidepanel.html"},
  "permissions": ["sidePanel", "storage", "scripting", "activeTab", "alarms"],
  "optional_permissions": ["nativeMessaging", "downloads"],
  "host_permissions": ["https://freetwai.com/*"],
  "optional_host_permissions": ["https://*/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

這是功能模板，不是已發布 manifest；實際產物需依 Vite output paths核對。staging 使用獨立 build/ID/平台origin，production 不接受任意 URL 切換到攻擊者網站。

未預設要求：`cookies`、`history`、`bookmarks`、`debugger`、`unlimitedStorage`、`<all_urls>` 安裝即授權、neo 專屬 `browserOS`。讀取選定 tab 的工作不等於需要所有歷史資訊。

`optional_host_permissions` 的廣泛**可申請範圍**不等於已擁有全部網站權限。每次 task 依已同意的 origin 動態 request，必須有 user gesture；已存在 permissions 時仍驗工作 Grant。`activeTab` 是暫時且受使用者動作限制的權限，不適合當成持久跨網站自動化許可。[W03] [W04]

**兩層撤銷：**平台 Grant 撤銷立即禁止本 extension 新動作；Chrome 已核准 host permission 是另一份狀態。無其他工作使用時再 best-effort remove，不可為撤銷一件工作把別人的仍有效工作權限意外移除。即使 Chrome remove失敗，application grant 仍已失效。

## 2.5 可信訊息鏈

只有 extension own pages／background 可以使用 Freedom token 或 Native Messaging。content script 只能傳 safe observation／action result，不得讀 token。

background 對每個 message 驗證：`sender.id`、tab、frame、documentId、origin、當前 session binding、控制 epoch、message schema、size。來源頁面可改 DOM；不能由頁面 `postMessage({user_id,...})` 授予身份。[W01]

首版不用 `externally_connectable.matches=*`；平台網頁不能給 extension 一段任意 shell/action。工作控制經已認證 execution API 派送。若未來提供網站喚起 extension，只接受受登錄 origin 的一次性 opaque work reference；extension 再向平台解析，不信任頁面附帶的指令或 secret。

Native Host `allowed_origins` 只列已發布 extension IDs；production/staging 分開。host 接收 `get_engine_status`、`start_authorized_run`、`cancel_run` 等固定命令，**沒有 `exec(command)` 或 `read_file(path)` 通用透傳**。

## 2.6 Capability profile

使用狀態 `available | user_gesture_required | requires_native_host | requires_site_adapter | unsupported`，不是所有功能填 true。

| 能力 | Standard extension | 重要限制 |
|---|---|---|
| `page.observe` | available，已授權頁面 | DOM不可見內容、cross-origin frame、closed shadow tree可能無法讀取 |
| `page.navigate` | available，scope內 | 跨origin需要新permission，redirect後重驗 |
| `form.fill` | requires_site_adapter 或 assisted | 網站可能autosave，不能一律視為無副作用 |
| `element.click` | assisted；policy確認 | 不以按鈕label猜安全，無法分類就停 |
| `artifact.download` | optional downloads + scope | 限來源、大小、目的，不能任意下載執行檔 |
| `artifact.upload` | user_gesture_required／已驗收adapter | 先由人選檔或用受授權artifact；不能讀任意本機路徑 |
| `screenshot.capture` | user_gesture／可用tab條件 | 可能擷取敏感資料；不是任意背景所有tab直播 |
| `human.handoff` | available | 需lease/epoch，不能只有UI toggle |
| `browser.profile.isolated` | unsupported | tab group不等於cookie/profile隔離 |
| `engine.cli` | requires_native_host | 純extension不能啟動CLI |
| `run.after_browser_exit` | unsupported | 本機Chrome關閉就停止此actuator |
| `runtime.raw_cdp` | unsupported首版 | 不加debugger以繞過policy |

特定網站需要更深控制時，單獨評估enhanced profile，不自動把standard users升到debugger。若官方業務API可用，優先加API adapter，而非擴大瀏覽器權限。

## 2.7 DOM 工具合約

首版固定 vocabulary：`observe_page`、`navigate`、`fill_field`、`select_option`、`activate_element`、`scroll_view`、`request_file_selection`、`capture_visible_page`、`report_observation`。payload 不允許 JavaScript 字串、任意函式、任意 fetch URL 或可執行模板。

觀察輸出：`tab_ref`、`document_ref`、`navigation_generation`、`origin`、`page_title_redacted`、`visible_elements[{node_ref,role,label_redacted,input_type,editable}]`、`warnings`。node_ref由extension對當前document產生；不是server傳來的CSS selector直接可操作。

執行前：

1. 取得背景程序發出的 bound dispatch，不接受content script自行發起新effect。
2. 驗current tab/document/generation、node still attached、visible/editable條件、frame origin、current control epoch。
3. 驗grant/permit、目標帳號可觀測狀態、允許資料及effect class；拒絕過期或未知的網站操作。
4. 使用已打包的有限DOM handler操作。合成input/click是否被網站接受由adapter實測；不保證所有網站接受。
5. 再觀察結果；receipt區分 `executed_observed` 與 `provider_confirmed`。DOM有提示「成功」不自動變成銀行／正式發布confirmed。

document換頁、SPA重要路由變更或人接手後必須失效node refs。tab ID被Chrome重用也不代表同一授權session。

## 2.8 MV3 lifecycle與可靠性

service worker可能被終止，global variables不是持久工作狀態；使用event-driven處理、bounded fetch與safe metadata persist。[W02]

每個指令先在local dispatch journal寫 `received`；真正執行前寫 `begin_requested`／收到server begin後 `dispatching`；執行後存receipt再上送。同一dispatch重送先查journal，不再做第二次click。若在begin與effect之間crash，該intent進result_unknown，不能假定沒執行。

Idle alarm只用來恢復polling，不保證準時心跳。local lease過期後即使worker被喚醒，也不能沿用舊permit。UI open和active native port可改善活躍工作，但不用空訊息迴圈偽造永不休眠；不能宣稱這是daemon。

瀏覽器關閉：平台run轉blocked（reason=runtime_offline），依lease到期處理。平台BYOK model step尚在途時只保存結果，不派新browser effect；不因Chrome關閉繼續花錢無限思考。

## 2.9 Storage與登入

| 儲存區 | 允許 | 禁止 |
|---|---|---|
| `storage.session` | 短效access token、配對狀態、當次runtime metadata | provider API key、完整網站資料 |
| extension IndexedDB | 非可匯出device CryptoKey（可行性需實測）、安全的dispatch journal／cursor | 宣稱等同硬體key、rawpage全文永久保存 |
| `storage.local` | UI preferences、safe IDs、capability metadata | 明文長效provider或website secret |
| `storage.sync` | 預設不用；最多非敏感偏好 | token、工作內容、profile identifiers |
| Native Host OS keychain | Freedom refresh／device私鑰、本機自有provider key | 自動讀取並搬運官方CLI OAuth cache |

Chrome storage不是為秘密提供完整OS憑證保護的vault。[W06] 純extension首版可讓refresh限當次browser session，browser重啟需重新確認；如果之後增加persistent refresh，必須明示儲存風險、rotate與device綁定，不能「加密key和密文放同處」就聲稱安全。

配對時從已知平台origin開人類確認頁。extension不取用平台cookie，不要求使用者貼整份CLI auth.json。BYOK入口可在可信平台頁輸入，extension只取得model_connection_id。

## 2.10 人機接手與protected surfaces

side panel永遠提供Stop，local stop立即封鎖排隊中的effect，再通知平台。Take over是 `requested → draining → human_active`；先改控制epoch、停止派新命令、結算已inflight，再顯示「你已接手」。若inflight結果不明，顯示具體情況，不能假說已安全停止所有effects。

Resume必須由人按下，snapshot與auth/Grant重新驗證，新的epoch與node refs；不得把人剛操作後的頁面配上舊selector繼續。

protected surfaces包括平台A4/credential設定、CLI登入、密碼管理／付款驗證、Chrome內部頁、extension store等。Agent拒絕操作；需要本人時開啟受保護手動流程並暫停capture。OTP與CAPTCHA不透過模型自動繞過。

## 2.11 內容／畫面資料與Web Store

預設僅傳目標工作需要的結構化文字與metadata；每run顯示送往哪個模型、在哪保管、是否紀錄。錄影不是預設必需品。許可錄制時限當前task tabs、可見範圍、明確TTL；登入與機密欄位先於任何persist／upload遮罩。

網站改版的adapter程式透過extension signed release更新；provider回應只能是資料。不得從平台下載JavaScript/WASM執行、用LLM輸出eval，或把通用遠端程式解譯器偽裝成JSON工作流。MV3 remote hosted code規則與商店審核需獨立通過，規格不保證上架。[W07]

## 2.12 Extension驗收底線

至少在Windows與macOS的實際Chrome、乾淨測試profile與假fixture網站驗收：reload、worker killed、browser restart、tab reused、跨origin redirect、permission revoke、frame mismatch、native host缺失、expired key、模型quota不足、takeover競態、重送同dispatch、敏感欄位遮罩。Linux標待實測，不因JavaScript可build就寫支援完成。

自動測試不需要讀使用者真實Gmail／銀行／私人商店；受控fixture提供成功、模糊timeout、autosave、SPA換頁及惡意prompt injection畫面。真人帳號驗證只由本人在測試帳號／授權sandbox完成，結果獨立記錄。


---

<a id="section-03"></a>

# 03｜Freedom Browser（BrowserOS neo）端規格

## 3.1 正確的上游基礎

本次查的是 `browseros-ai/BrowserOS`，固定 commit `53c3799ce014e9fee05569802314a05d0bad3e40`。neo 與一般 BrowserOS 共存，使用不同的 backend／extension。neo 的 MCP／HTTP backend 為 Rust Axum；其 cockpit 是 WXT + React；不是把一般 BrowserOS `apps/server` 的 Bun agent loop 直接加幾條路由。[N01] [N07]

建議 fork/distribution repo 名稱 `FreeTWAI-AI/freedom-browser`（NEW）。保留 upstream remote、作者、授權、上游 commit pin。首輪不改 Chromium renderer／network engine；先在 neo 的 Rust dispatch、安全通道與 cockpit integration 落實工作範圍。若實際隔離要求不能在此層滿足，再以單獨ADR決定原生Chromium patch，不能默默擴大fork surface。

## 3.2 保留／修改／不採用

| 處理 | 範圍 | 原因 |
|---|---|---|
| KEEP | Chromium patch/build system、CDP bindings、瀏覽 primitives | 不重造瀏覽器引擎 |
| KEEP | cockpit session UI、tab activity、local replay基礎、cancel結構 | 作為人與Agent共看的本機工作檢視 |
| MODIFY | MCP身份與dispatch guard、session/target binding | 把Freedom的Grant/lease真正放在工具執行之前 |
| MODIFY | recording/telemetry/capture consent | 上游預設不足以代表自由工坊的多方資料分享同意 |
| MODIFY | 自有產品ID、profile namespace、update/signing配置 | 避免冒用上游更新與共用正式profile |
| NEW | Freedom connect、GrantClient、ControlLease、RunContext、safe event relay | 連接中央權威，不直接讀DB |
| NOT ADOPT | 一般BrowserOS完整Bun agent backend當neo後端 | 不是此次產品路徑；避免兩套model orchestration |
| NOT ADOPT | 把neo manifest改名後發布成普通Chrome extension | 含專有API／browserOS權限，另有標準extension實作 |

## 3.3 上游目前能做什麼、不能推定什麼

上游 `AppState` 已含 sessions、profiles、browser service、recordings、replay、audit、harness、skills與cockpit，本機使用 `browserclaw.sqlite`。[N02] 這可以保留為瀏覽器執行資料，不是第二套中央業務DB。

但上游 `ToolIdentity`、`SessionId`、`ClientIdentity` 只是在neo中識別呼叫者／會話；它們不等於FreeTWAI會員身分，不等於已登入官方CLI，也不等於可執行平台A2/A3的權限。[N04]

最重要：上游dispatch把ownership當提示而非guard，允許Agent操作別的Agent或人的tab。[N04] Freedom模式必須有相反且清楚的規則：**未被當前Run授權的tab/profile/account不得操作，即使上游知道它是誰的tab。**

## 3.4 Managed模式與Standalone模式不能互相繞過

Freedom管理的工作使用專用profile、專用server instance與明確的 `managed_mode=freedom`。在這個instance中，任何可到達同一browser控制面的入口都必須要求Freedom上下文；不能另留不驗Grant的 `/mcp`、raw evaluate或CDP代理作旁門。

使用者仍可另開原版BrowserOS neo作私人工作，但必須不同profile／server，且不能共用Freedom管理的session、profile cookies與tab control endpoint。不能靠UI裡選一個Standalone就對同一profile關掉guard。

對同一OS擁有完整權限的惡意程序，純本機軟體不能保證不可讀cookie或重啟Chromium繞過。此等級只保護受管理的工具路徑；高安全場景需要OS隔離或遠端sandbox，且須以實測證據宣告，不能改個mode字串就算完成。

## 3.5 Rust資料結構（目標草案）

新增run context，從已驗證的配對／執行token與伺服器狀態組合，不由MCP JSON arguments自行宣告principal。

```rust
// 設計形狀，不是已編譯 patch；實作使用生成 DTO 與現有 ID types。
struct FreedomRunContext {
    platform_origin: String,
    contract_digest: String,
    principal_ref: String,
    agent_connection_ref: String,
    runtime_ref: String,
    run_ref: String,
    grant_ref: String,
    grant_digest: String,
    task_lease_epoch: u64,
    control_epoch: u64,
    browser_session_binding_ref: String,
    inference_binding_ref: String,
    policy_revision: String,
}
```

`ToolCall` 增加 `freedom_context: Option<VerifiedFreedomRunContext>`；在managed mode中 None 即拒絕，不能退回上游自由操作。`Verified*` constructor只供auth module使用，不讓普通deserialize建立已驗證物件。

本地pending操作保存 `intent_id`、`dispatch_id`、permit digest、target incarnation、lease/control epoch、begin state。metadata不含provider key；本機auth custody由Agent Kit/OS keychain或官方CLI自身處理。

## 3.6 Tool dispatch修改順序

目前 `api/mcp/dispatch.rs` 已有 `ToolGuard`、GUARDS、EFFECTS、OBSERVERS 與 cancel token。[N04] 加入Freedom guard，不把它放在事後audit observer才發現違規。

```text
收到MCP request
 → native caller與Freedom token驗證
 → 找到綁定run/session，不接受任意run_id冒名
 → schema/tool catalog檢查
 → browser connected + navigation scheme檢查
 → Freedom managed guard
     principal / connection / model readiness
     current grant / expiry / revocation
     task lease + human/agent control epoch
     tab/profile/account/document scope
     action intent + typed effect + safe args digest
     one-time permit / current target incarnation
 → :begin 原子標記dispatch
 → execute_tool
 → post-observation + safe evidence
 → audit/receipt/outbox，處理unknown
```

讀取與寫入分級：部分已授權觀察可使用短效read capability而不每個DOM節點往返中央；任何mutation要精確intent/permit。scope外讀取也禁止，不能把「read-only」誤當可讀所有人的分頁。

## 3.7 關閉間接繞過

上游標識 `run`、`evaluate` 為 arbitrary script tools。[N04] 首版Freedom-managed tool catalog不公開它們，接收到直接call也回 `tool_not_allowed`；只藏UI不夠。

`api/mcp/script_hook.rs`、`helper_runtime.rs`及深層execute path需在實作時完整稽核，確保沒有另一個可執行跨tab/任意腳本的入口。本次已核對路徑存在，但未聲稱逐行驗證全部內部實作。[N08]

CLI內建shell、網路、檔案工具是另一個旁門。官方adapter需要用供應商支援的工具限制／permissions設定，只把Freedom允許的工具暴露給當次browser工作。若做不到，該adapter只能標 `assisted_local`；不能因用了MCP就宣稱任意CLI的所有行為都由平台控制。不得修改官方CLI binary或移除其官方登入方法來達成這件事。[W09]

資料經網頁可能被prompt injection污染。MCP工具輸出與頁面文字永不當成system policy；本機工具只能拿opaque credential ref，不能拿「請把所有cookie印出來」變成合法工具動作。

## 3.8 HTTP與loopback安全

上游 `/mcp` 特別拒絕browser-origin請求；部分HTTP回應使用廣泛CORS。這是上游的本機使用模式，不是可直接對外提供的多租戶API。[N03]

Freedom新增本機namespace `/freedom/v1/*`（NEW），只服務已配對native caller或已辨識的本產品extension；要求短效本機access token、固定host／origin allowlist與request nonce。非必要listen限loopback；不接受0.0.0.0、不把CDP port經public tunnel發布。

平台網站不直接跨origin fetch localhost MCP。neo bridge向平台建立authenticated outbound poll／connection，receive opaque commands後從中央讀取authorized work。HTTP/CORS檢查不是credential；local service token也不能冒充平台human signature。

新功能不應改弱上游 `/mcp` 的request hygiene；對原本dashboard合法請求另作明確audience而不是用`*`放行所有網站。

## 3.9 精確逐檔修改表

以下相對於 `packages/browseros-agent/`；MODIFY表示已查到存在的路徑，部分檔案只確認路徑，深度在來源索引說明。

| 路徑 | 動作 | 具體修改 |
|---|---|---|
| `apps/claw-server-rust/src/app.rs` | MODIFY | 注入Freedom services、typed verified context與safe relay；不連中央DB |
| `apps/claw-server-rust/src/config.rs` | MODIFY | 新增platform origin、managed mode、namespace與signing root配置；禁止把長效user/model key明文放一般config |
| `apps/claw-server-rust/src/api/http/mod.rs` | MODIFY | 掛載明確Freedom本機路由，auth middleware／限origin；保留MCP hygiene |
| `apps/claw-server-rust/src/api/http/sessions.rs` | MODIFY | cancel與handoff接入run/control lease；session結束回報不是自動accept工作 |
| `apps/claw-server-rust/src/api/http/connections.rs` | MODIFY | 區分已安裝harness、Freedom配對與模型login health三種狀態 |
| `apps/claw-server-rust/src/api/mcp/service.rs` | MODIFY | call入口驗證connection/run；managed tool catalog；不可用client label作身份 |
| `apps/claw-server-rust/src/api/mcp/dispatch.rs` | MODIFY | pre-execution Freedom guard、permit與target incarnation、one-time dispatch |
| `apps/claw-server-rust/src/api/mcp/guards/mod.rs` | MODIFY | 明確導出Freedom guard；managed mode required |
| `apps/claw-server-rust/src/api/mcp/guards/freedom_grant.rs` | NEW | 授權、scope、epoch、permit、expiry；共用negative fixtures |
| `apps/claw-server-rust/src/api/mcp/script_hook.rs` | MODIFY | managed mode拒絕任意script或所有nested action逐項受guard，首版採拒絕 |
| `apps/claw-server-rust/src/api/mcp/helper_runtime.rs` | MODIFY | 不能成為無Grant的間接工具通道 |
| `apps/claw-server-rust/src/api/mcp/observers/audit.rs` | MODIFY | 記safe intent/evidence refs，敏感content採capture policy |
| `apps/claw-server-rust/src/services/freedom/mod.rs` | NEW | 狹義模組入口，不侵入全部upstream services |
| `.../services/freedom/{connection,policy,control,relay}.rs` | NEW | 平台client／local cache／control lease／bounded outbox |
| `apps/claw-server-rust/src/db/` | MODIFY+NEW migration | 只存平台refs、dispatch journal、event spool，不複製中央業務schema |
| `apps/claw-app/wxt.config.ts` | MODIFY | 自有產品ID／update來源／必要permissions；分開neo與普通Chromemanifest |
| `apps/claw-app/entrypoints/background.ts` | MODIFY | Freedom bridge狀態、safe events、recipient驗證 |
| `apps/claw-app/entrypoints/newtab/` | MODIFY | 原cockpit保留，加入work mapping與Grant／engine狀態 |
| `apps/claw-app/screens/freedom/` | NEW | 配對、連線健康、work detail、人機handoff |
| `apps/claw-app/modules/freedom/` | NEW | typed API consumer與safe projection；不放business policy |
| `apps/claw-app/entrypoints/recorder.content.ts` | MODIFY | task-scoped opt-in、pause protected pages、more-than-password redaction |
| `apps/claw-server-rust/src/api/http/recordings.rs` | MODIFY | session綁定與consent／retention驗證；不得由任意sender upload錄影 |
| `apps/claw-server-rust/src/api/http/live.rs` | MODIFY | viewer ACL、短效grant、masked frame；不公開本機全量stream |
| `crates/claw-api/`, `packages/claw-api/`, `packages/claw-api-client/` | GENERATED/有限MODIFY | 上游API改動經上游codegen；Freedom wire contract另從中央生成並adapter，不手改兩份DTO |
| `apps/claw-onboard/` | MODIFY | Freedom connect與本人CLI/BYOK提示；不預設import全部cookies |
| `packages/browseros/resources/`（repo根相對） | MODIFY | logo、bundle/application ID、簽署、installer與update ownership；保留NOTICE |

上游private helper函式名稱／插入位置若在實作前變動，先rebase至新pin重新核對。不能只按舊行號patch；也不能因為編譯過就認為guard覆蓋所有side effects。

## 3.10 Browser cockpit

保留neo看每個session目前頁面與歷史操作的強項，新增Freedom欄位：Work ID、本人/小隊、模型來源、Grant scope、控制者、expiry、最近action/result。新tab／side panel只展示本人有權資料，不自動列出平台其他會員工作。

頁面可顯示 `Live local view`；平台遠端看畫面需額外 ViewerGrant和明確同意，scope到run而非整個profile。多人觀看不代表多人可控制。所有Approve/Take over動作送回中央驗證，不能在cockpit本機寫一個approved=true就作A4。

## 3.11 Recording不是授權、也不是checkpoint

上游recorder在all_urls的main-frame注入rrweb，設定明確遮罩password，但不能推定其他敏感欄位已保護；記錄重播是DOM事件回放，不應一概稱為MP4視訊。[N06]

Freedom模式首版：中央metadata-only；本機錄製也須task-scoped consent。預設不錄登入／credential／付款驗證／A4頁；敏感文字、token欄位與私人標記先遮罩，禁止把完整DOM傳到中央再遮罩。

本機recording store和replay retention可沿用，但設定需明確用途、TTL與刪除方式；已撤回的分享ViewerGrant要立即拒絕未來讀取。不要刪改source record造成錯誤稽核聲明；若須移除私人內容，保存最小非敏感tombstone。

`checkpoint`只包含safe logical state、完成的intent refs與待確認effects。不要藉恢復功能匯出cookie／CLI token／整個profile。切換runtime時在新runtime自行登入，重新取得能力與grant後執行，原runtime先fence。

## 3.12 CLI／模型接入

Neo善於被外部MCP agent控制，不代表它已提供Freedom的模型登入驗證。本版借Agent Kit統一官方CLI adapter。harness「安裝／連接成功」與provider login「可使用模型」是兩個API欄位。[N01] [R01]

執行browser工作時，CLI只拿最小WorkContext、允許的工具catalog與run-scoped execution credentials；provider登入仍由官方CLI持有。外部MCP client沒有可驗證的本人模型來源時可以看連線設定，但不能開始Freedom user AI run。支援的harness需逐個版本驗收，不因README列出很多產品就一次宣稱全支援。

## 3.13 Build、更新、授權

保留上游Bun lock/Rust crates/Go dev tooling；平台沒有因此新增Bun或Rust部署。Freedom patch應集中在上述integration seams，存`upstream.lock`和patch inventory，更新時測guard不會因上游dispatch新路徑失效。

neo目前文件說明macOS/Windows產品，而上游dev supervisor是macOS限定；Windows/Linux可以跑部分checks不等於可用同一dev command啟動。[N07] Freedom首版要分別記錄packaged Windows與macOS實機測試；Linux保持not_verified，不能套一般BrowserOS的Linux支援。

上游AGPL與檔案內license/NOTICE必須保留，修改／分發／網路互動的對應原始碼義務需依實際組合檢查；獨立repo或IPC本身不構成自動豁免。產品名稱／圖示不要造成上游背書誤解。這些是發布前工程合規工作，不代表本文件提供完整法律結論。[N01] [N06]

已查證的上游驗證入口（本次**未執行**）：

```sh
cd packages/browseros-agent
bun run check
bun test
bun run test:rust
bun run lint:rust
bun run fmt:rust
# 只有修改上游API契約時需要：
bun run codegen:claw-api
bun run test:claw-api-contract
```

開發可使用fresh profile的dev variant，但上游supervisor有清理佔用port/process行為；不能在正式正在工作的profile上隨意試。安全關鍵patch的驗收需同時包含單元與實際browser scenario，不只編譯。


---

<a id="section-04"></a>

# 04｜共用協定、身分、金鑰與CLI/API登入

## 4.1 協定定位

名稱：`freedom.execution/v1`。這是Freedom的工作／授權語意與API契約，不宣稱發明新的通用網路transport。HTTP JSON為基線、MCP為工具facade、Native Messaging為本機bridge；對外MCP使用固定版本 `2025-11-25` 授權規格作整合基準，不宣稱它永遠是最新版本。[W11]

Canonical authoring source唯一為 `freedom-platform/contracts/execution/v1/`（NEW）。本交付 `contracts-draft/` 只是設計起稿，不能直接被production channel當正式ContractBundle。正式化PR必須同步更新planning、schema、生成SDK、fixtures、source pins與metadata。

`protocol_version`、`capability_revision`、`provider_adapter_version`、`policy_revision`、`db_migration`分開。minor只做相容新增；移除欄位、改授權語意或改enum意義升major。未知method拒絕；未知event可以在安全範圍標示unrecognized而不假裝已套用。

## 4.2 「使用者有key、網站也有key」的完整定義

這裡明確同時涵蓋**平台存取key**與**模型API key**，避免兩種需求混為一談。

| 名稱 | 誰擁有／誰可看到 | 用來做什麼 | 絕對不能代表什麼 |
|---|---|---|---|
| `UserAccessKey` | 本人；簽發後只顯示一次 | 自有CLI／整合取得bootstrap權或交換token | 不等於provider額度、網站密碼或無限執行 |
| `SiteCredential` | 網站backend／ServicePrincipal | 站點以自己身分連接Freedom | 不能冒充任何會員或批准A4 |
| `ProviderConnection` | 本人或站點各自有一份 | 使用自己的LLM API額度或官方CLI登入 | 不能授予他人網站、FreedomDB或browser控制權 |
| `DeviceProofKey` | runtime裝置私鑰；平台只存公鑰 | 證明token由已配對裝置持有 | 不證明裝置未被攻擊，也不授業務權 |
| `ExecutionToken` | 指定runtime，短效、bound audience | 存取特定run／grant範圍 | 不能簽人類決策、不能被轉交其他resource server |
| `HumanSignature` | 本人認證器／受驗人類session | 確認特定artifact/revision/digest與意思 | 不是模型說“approved”或機器有API key即可產生 |

使用者不必手動管理六個值。一般UX只看到「Freedom已連接」「我的模型已連接」「本次工作權限」。進階設定才管理user/site access keys。

### 網站模型key的用途

Freedom網站自己的provider API key放site/service ModelConnection，支援平台系統工作。每位會員自己的AI run則必須引用本人有權使用的CLI/API連線。網站key可存在，但預設不是會員的免費fallback，不能用它掩飾本人尚未登入或額度不足。

### 長效key生命週期（本版設計初值）

高熵至少32byte random secret，帶可辨識非秘密prefix與key_id；DB僅存key hash，最後使用時間不帶原文。預設90天到期，使用者可選更短。rotate建立新key、短暫overlap後撤舊key；reset不能找回原secret。key本身只給列明scopes，禁止`*`。

新裝置首次用user key仍須device配對與run授權。只有key而沒有Grant/裝置proof/owner/model binding不會開始AI。網站服務key交換的是service token，不是member token。

## 4.3 機器配對與登入流程

### 基線flow：device authorization + proof-bound connection

所有runtime共用一個device flow，UI不同而已。參考RFC8628的短效代碼、輪詢節流与使用者確認語意；Freedom額外綁runtime public key與允許scope。[W08]

```text
Runtime:
  產生device key → POST device-authorizations(client_id, public_jwk, runtime_kind)
Platform:
  存device_code_hash/user_code_hash/expiry/requested_scopes
  回device_code、user_code、verification_uri、expires_in=300、interval=5
Human:
  在可信平台登入 → 核對裝置/環境/代碼 → approve exact request
Runtime:
  poll token + device proof → 取得bootstrap token與refresh handle
  用bootstrap讀最小status → 綁定本人模型
  人類授予ExecutionGrant → 交換run-scoped execution token
```

短碼不能作secret，device_code才是poll secret；避免暴力猜碼和釣魚代碼配對。使用者在網站看到要求的agent/client來源，不能只看到一個漂亮名稱。驗證origin與environment，staging代碼不得換到production。

member session cookie永不送到extension/native host。成功配對不複製browser登入狀態、GitHub安裝權限或model quota。原本readonly pairing保持原API和scope，不改造成執行配對。[P04] [P05]

### Token security profile

採OAuth DPoP（RFC9449）型的proof-bound access token；實作使用審核過的jose／Rust JOSE library，不自創雜湊驗證器。[W12]

access token目標TTL10分鐘；execution token最長5分鐘，實際到期不得晚於Grant；refresh最長30天、每次rotation且偵測重用後撤整個family。這些是設計預設，可縮短，不能讓client加長。DPoP驗證method、URI、issued time、nonce/replay、access-token hash與公鑰thumbprint。TLS仍必需。

`ExecutionToken`欄位至少：issuer、audience、subject/principal、community、connection、runtime、run、grant、grant_revision、policy_revision、`cnf.jkt`、iat/exp/jti。從credential上下文派生，不接受client自行選另一個user/community。scope只A0–A3能力，**沒有signature.confirm**。

MCP session ID不是auth，CLI process名稱也不是auth。對外MCP OAuth token不可原封不動pass through到provider API或另一個resource server。[W11]

## 4.4 CLI登入規格

### 支援策略

首版指定Codex與Claude Code兩個adapter實作目標；其他Goose/BAT/Hermes或新CLI經相容性fixture與實機驗收後加入，不因它能接MCP就宣稱已通過登入與權限檢查。

Codex官方文件支援ChatGPT登入與API key兩條路，提供`codex login`、`codex login status`與credential storage選項。[W13] Claude Code須用未修改官方binary及本人官方登入，不能收集／代理會員Claude.ai OAuth credentials。[W09]

這些是provider特定限制：不能把某家CLI支援的auth方法當作全產業可通用，也不把訂閱登入token當成可帶進自寫model gateway的API key。

### Adapter interface（NEW in Agent Kit）

```text
detect() -> installed/version/binary_origin
inspectAuth() -> state/auth_method/provider_account_hint/evidence_level
beginOfficialLogin() -> human_instructions/local_process_ref
validateToolsProfile() -> supported/restrictions/unsupported_features
startAuthorizedRun(context, tool_endpoint) -> process_ref
streamSafeEvents(process_ref) -> progress/tool_call/result/error
cancel(process_ref) -> stopped_or_inflight_unknown
getUsageEvidence(process_ref) -> known_usage_or_unknown
```

`beginOfficialLogin()`只啟動或引導供應商官方登入；不能自己收帳密、替人填OTP、上傳`auth.json`或讀OAuth cache後改餵自製API client。

`inspectAuth()`利用官方status／可支援的API；輸出只取allowlist欄位。沒有可靠status時回unknown，需要本人在官方工具確認；絕不能把存在某個config檔當成登入成功。provider account hint只供本人核對，不以email相同猜測法律身份。

每次run開始都驗binary version、auth狀態、可用的tool restriction、provider配置與實際付費來源。使用者選subscription時，不可悄悄繼承環境變數API key造成付費切換；adapter以官方能力做配置檢查，無法確認就阻擋該模式並給出修正方法。

供應商正式CLI的既有登入method不可被Freedom改版移除。Freedom要求的是“此run必須有可用且本人選定的模型來源”，不是重寫CLI登入機制。

### 兩種本機驗證強度

`local_observed`：配對native host觀測本機CLIstatus並簽署nonce/版本/時間；可防止隨便一個web頁自稱已登入，但**不是供應商不可偽造的attestation**。

`provider_verified`：由合法API/供應商支援機制驗證可用帳號與scope；只宣稱該機制實際證明的內容。

任何root/local admin仍可能修改runtime，因此涉及中央高價值權限不能單憑local_observed放行。平台API仍獨立驗業務權限、A4與結果。

## 4.5 API key登入與custody

`ProviderConnection.mode=user_api`，owner由會員session導出。首次貼key在可信connection setup，不從content script收集。用一次性ingest通道寫vault、回opaque reference；verify透過固定provider endpoint最小驗證。無法確認模型access時不顯示ready。

custody有且只有以下一種：

- `platform_vault`：使用者同意受控broker解密代呼叫；key不發到extension或一般Agent。適用免native host模式。
- `local_keychain`：native host保管自己的API key，本機provider adapter呼叫；平台只收到metadata。不能在之後自動升為cloud custody。
- `official_cli`：第三方官方CLI自己處理OAuth/API認證；Freedom不取出secret。

一般settings JSON、localStorage、clipboard歷史、logs、model prompts、GitHub Issues都不能成為secret儲存。跨runtime交接只傳connection reference與requirements，新runtime不能因此取得不允許export的key。

## 4.6 Run preflight的強制條件

server依下式驗證，不能只在前端disable按鈕：

```text
allow_user_ai_start =
  active_member && completed_required_membership_onboarding
  && active_agent_connection && active_runtime_binding
  && model_connection.owner == authorized_user_principal
  && selected_model_auth_is_usable && provider_mode_is_allowed
  && immutable_grant_is_current && grant_matches_work
  && runtime_capabilities_cover_required_actions
  && data_policy_allows_model_and_execution_location
  && budget_is_available && no_conflicting_control_lease
```

AI prerequisite只作用於AI commands；配對／revoke／人類讀取／key修復都不能依賴AI正常，否則會出現沒有key就無法設定key的死結。對純service system operation另用service policy，不能user run自己設 `kind=service`逃避條件。

blocker回機器碼＋人類文案＋修正入口，例如`model_auth_required`、`runtime_offline`、`permission_required`、`grant_required`、`data_custody_denied`、`budget_exhausted`。不自動付款、申請更多額度或切模型。

## 4.7 通用message envelope

跨runtime訊息只帶必要IDs與安全payload。下例是虛構示意，非可用token。

```json
{
  "protocol": "freedom.execution/v1",
  "message_id": "msg_example_001",
  "type": "action.proposed",
  "run_ref": "run_example_001",
  "runtime_ref": "runtime_example_001",
  "sequence": 17,
  "lease_epoch": 4,
  "control_epoch": 9,
  "occurred_at": "2026-10-01T23:30:00Z",
  "correlation_ref": "work_example_001",
  "payload": {"intent_ref": "intent_example_001"}
}
```

Envelope不是token，principal不由payload決定；運輸通道驗證身份，平台將`runtime_ref/run_ref`與token比對。事件clock是runtime自報，server另記received_at；不以自報時間決定expiry。sequence是run stream順序，亂序buffer/gap repair；duplicate message同payload去重，不同payload拒絕。

bounded JSON預設64KiB，單safe event建議<=8KiB；大artifact用受授權object reference與checksum，不塞event。此限制與舊平台全域32KiB需以精確route policy處理，不全站放大。

## 4.8 ExecutionGrant與ActionIntent

Grant內容包括principal、work、connection、runtime、site、A-level ceiling、action families、resource refs、origins、account refs、資料出口、時間、次數、費用與revocation版本。Grant的自訂網站scope不等於Chrome host permission；兩者都成立才可用。

人類最初核准的是可讀懂的範圍與immutable digest，不必每個安全步驟再簽一次。改模型付費來源、換網站帳號、擴大收件人或把本機內容送上雲都需新revision/同意；這不是每次click要人按。

ActionIntent最少：`intent_id/run_id/step_id`、工具版本、effect_class、target（origin/account/resource/document/generation）、args/artifact digest、required_grant_ref、最大影響、期望結果。敏感值本身不放audit事件；它們放受控artifact或僅留本機，權限token也不得包含完整private payload。

語意分類的owner是已核准adapter＋policy，不是LLM自行提供的effect label。unknown effect只得停在assisted/manual；A4 artifact signature不由普通browser許可取代。

## 4.9 ActionPermit、fencing與duplicate handling

permit以受控server signing key簽署，綁定：intent/digest、runtime/device、run、Grant revision、target generation、lease/control epoch、nonce、max_uses=1、expires_at。runtime驗platform固定信任根與允許algorithm，不接受任意`jku`導向未知key站。

執行步驟：

1. 平台建立intent；只在當前Grant/lease有效時authorize。
2. runtime在local journal記intent/dispatch準備狀態，重新觀察target。
3. `:begin`原子消耗permit nonce並把intent標dispatching；回固定dispatch_id。
4. runtime在確認本地epoch未變、permit未過期後執行一次。
5. 成功／已知失敗／未知結果各自回receipt。網路重送只重播receipt，不再執行。

若`:begin`回應丟失，不能拿一個新intent自動重做；先讀dispatch狀態。重複begin可回同dispatch狀態，但不是第二次操作許可。崩潰時某個effect究竟有沒有發生若不確定，進reconcile。外站若沒有idempotency能力，平台不能強迫網路exactly-once。

## 4.10 ControlLease與Runtime handoff

控制scope可以是一個task tab集合或一個專用profile；server發唯一epoch。agent與human不能同時持有mutation控制權。

```text
agent_active
 → handoff_requested (epoch++, 停止新Agent effect)
 → draining (in-flight結果確認)
 → human_active (actuator確認已交接)
 → resume_requested
 → reobserve + preflight + new lease/epoch
 → agent_active
```

本機Stop不等平台回應才封鎖佇列。遠端發Stop若runtime離線，要如實顯示`stop_requested/offline`，不能聲稱已收到。到期permit與lease提供有界風險，已發生或在途effect由reconcile收斂。

跨runtime handoff：舊run租約封存/停止 → 保存安全checkpoint → 選新runtime → 在新環境完成自己的登入与權限 → 新grant/session binding → 重新觀察 → 接續未完成步驟。舊run_id可維持工作關聯，新的執行attempt/epoch須明確。

**不做**：自動複製Chrome cookies、CLI OAuth、password manager、開啟中的bank session；「Move to Cloud」不是把本機profile直接打包。遇到雲端登入障礙，原雲端session需透過受控remote-human-view完成，或改在本機以新session續跑；在本機登入不會自動替雲端cookie解鎖。

## 4.11 MCP工具facade

在Agent Kit `mcp/freedom-work-server/`實作下列工具（NEW，不把目錄存在當已完成）：

```text
freedom.get_context
freedom.list_work
freedom.preflight
freedom.start_run
freedom.propose_action
freedom.observe_page
freedom.execute_authorized_action
freedom.checkpoint
freedom.submit_result
freedom.request_human
freedom.get_run_status
```

`execute_authorized_action`不接shell/js字串，只接canonical intent reference。`observe_page`同樣驗scope；內容最小化。response不含secrets。這是可理解的一層facade；真正的後端與actuator仍強制檢查，否則Agent繞過facade直接呼叫neo原工具就會破功。

首版不必同時把平台全部business endpoints變成MCP tools，避免公開無法穩定授權的通用工具。自家API adapter具體對接draft商品／campaign／work等已核准operations。

## 4.12 Skill與來源合約

技能書／repo catalog目前只是公開來源或指引，並非已驗證可執行的skill installation。[R02] 加入execution skill時至少保存source repo+exact commit、license、manifest digest、required capabilities、input/output schema、data policy、publisher/revocation證據。

未簽或未隔離domain skill只能用於資格／來源描述，不得以“下載了SKILL.md”為理由執行任意腳本。既有 `freedom-build-system` 與規劃的signed overlay邊界保留；BrowserAdapter不能偷偷新增一條任意安裝權限。remote skill內容不進extension當runtime executable code。[W07]

## 4.13 Errors與可恢復性

| HTTP／Code | 語意 | 正確處理 |
|---|---|---|
| 401 `connection_expired` | Freedom連線過期 | refresh或重新配對，不能讀cookie補救 |
| 401 `model_auth_required` | 本人模型無效 | 等本人官方登入／key修復 |
| 403 `grant_required` / `grant_scope_denied` | 無該工作／目標權限 | 請人提供精確授權，不換不受管工具 |
| 403 `tool_not_allowed` | 任意script或不允許能力 | 停止該步 |
| 403 `data_custody_denied` | 不能送到該模型／雲端 | 改符合政策的明選模式 |
| 409 `stale_lease` / `stale_control_epoch` | 控制權已改 | 丟棄未執行queue，重新讀狀態 |
| 409 `target_changed` | 換頁／帳號／artifact版本已變 | 重新觀察與重新授權 |
| 409 `idempotency_conflict` | 同ID不同payload | 拒絕；不覆蓋舊intent |
| 409 `effect_unclassified` | 無法判定真實effect | supervised/manual，不標安全成功 |
| 412 `version_conflict` | 業務版本衝突 | 讀新版本，需時重確認 |
| 422 `contract_unsupported` | capability／schema版本不合 | 升級或選合格runtime |
| 429 `quota_exhausted` / `budget_exhausted` | 額度不足 | waiting_engine，不自動換付費來源 |
| 503 `runtime_offline` | actuator無連線 | 存草稿／等裝置 |
| 202 `result_unknown` | 外部結果尚不能確定 | reconciliation，不盲目重送 |

## 4.14 跨語言相容與測試資產

新execution payload的簽署／digest採RFC8785 JCS + SHA-256，禁duplicate JSON keys、NaN、不一致unicode處理；金額用minor-unit字串，不用浮點數。[W10] token簽署是JOSE標準流程，不把JCS當加密。

TypeScript與Rust共用golden fixtures、時間凍結、nonce重播、wrong audience、錯誤device proof、中文unicode／大數／null vs missing邊界。正式ContractBundle包含schema digest、generator version與來源SHA；兩端不能手寫相似但不同的enum或默默寬鬆解碼。

本交付六個schema只涵蓋重要邊界，完整production契約仍需在實作PR補齊每個endpoint的request/response、Problem Details、auth metadata及SDK生成。附帶validator驗證的是設計樣本，**不驗證密碼學、provider登入或真實browser行為**。


---

<a id="section-05"></a>

# 05｜逐檔修改、遷移、驗收與開發交接

## 5.1 這份規格如何進現有設計

本交付是提案，不直接覆寫repo。實作時先開設計PR，把下列canonical文件更新為同一決策；不要把本包永遠放成與舊設計矛盾的第N套規格。

| 既有文件／位置 | 需要怎麼改 |
|---|---|
| `docs/platform-plan/00-current-requirements-baseline.md` | 增列三端架構、自備CLI/BYOK、網站key分離、AI gate不阻擋普通會員、舊唯讀key不擴權 |
| `docs/platform-plan/02-system-architecture.md` | 新增extension/browser兩個consumer；Agent Kit native bridge；平台仍單一work/auth真相 |
| `docs/platform-plan/03-domain-events-state-machines.md` | 同步execution-v1 Run/Action/ControlLease狀態、events、fencing、unknown/reconcile |
| `docs/platform-plan/04-module-specifications.md` | 新增Autopilot UX與private work mode；保留公會／商店／協作邊界 |
| `docs/platform-plan/05-integration-contracts.md` | 修改machine surface、六類credential、model binding、runtime capability與MCP語意 |
| `docs/platform-plan/06-delivery-plan.md` | 以本章技術依賴編排tracks，淘汰只寫文件卻宣稱runtime已實作的描述 |
| `docs/platform-plan/execution/specs/AGT-01-agent-protocol.md` | WorkContext/Connection/Run/Lease+private work實作範圍 |
| `docs/platform-plan/execution/specs/AGT-02-grants-intents-signatures.md` | Grants/A4/ActionIntent加server與runtime雙重檢查 |
| `docs/platform-plan/execution/specs/AGT-04-cli-adapters-and-partner-runtime.md` | CLI/extension/neo各adapter支援profile與驗收；禁止只有MCP目錄的假完成 |
| `docs/platform-plan/execution/specs/AGT-05-human-ai-journey-and-concierge.md` | onboarding的model readiness、一次授權、quota等待與revocation |
| root `contracts/`與source pins | 只產生一份正式execution bundle；planning copies改為derived或reference |
| repo `README.md`／`AGENTS.md` | 明列已完成／尚未實作、禁止token混用與禁止繞過managed guard |

這些是已存在的planning切面（部分來自本次search／前文已提供內容）；新增章節與精確行號要依實作branch核對，不宣稱本次已逐行重審所有大型planning文件。

## 5.2 Platform逐檔改動清單

| ID | 路徑 | 處理 | 修改要點／完成條件 |
|---|---|---|---|
| P-01 | `apps/platform-api/src/platform-app.ts` | MODIFY | 加route assembly，將new machine auth與cookie auth明確隔離；無全站Origin豁免 |
| P-02 | `apps/platform-api/src/routes/agent-control.ts` | NEW | device pairing/token、bootstrap、scoped execution surfaces |
| P-03 | `apps/platform-api/src/routes/autopilot.ts` | NEW | human work/run/review/control UI endpoints，CSRF保留 |
| P-04 | `apps/platform-api/src/routes/model-connections.ts` | NEW | 本人model metadata/verify；secret ingest專用路徑 |
| P-05 | `apps/platform-api/src/routes/site-applications.ts` | NEW | site registry與service key；不能冒充member |
| P-06 | `apps/platform-api/src/routes/client-connections.ts` | KEEP | 不擴大readonly路由、不接受execution token當readtoken |
| P-07 | `modules/client-connections/service.ts` | KEEP | 原fw_read語意不變；UX可共用，authority不共用 |
| P-08 | `apps/platform-api/src/routes/agent-commerce.ts` | KEEP/有限MODIFY | shop keys保留purpose；若納入execution adapter仍驗shop scope，不直接升級既有key |
| P-09 | `packages/db/index.ts` | MODIFY | 拆共用transaction core、人／機／service validators；舊command wrapper兼容 |
| P-10 | `packages/db/execution-command.ts` | NEW | current authority、lease、idempotency、journal以verified principal執行 |
| P-11 | `modules/identity-membership/service.ts` | 有限MODIFY | 不改登入制度；增加可信principal轉換入口，不能讓machine生成Actor/session |
| P-12 | `modules/opportunity-project-work/work.ts` | MODIFY | work_mode/visibility/ACL；personal run不走協作self-claim；全read surfaces防洩漏 |
| P-13 | `modules/agent-control/` | NEW | connection、grant、principal、token、revoke服務 |
| P-14 | `modules/agent-execution/` | NEW | run/lease/control/intent/reconcile/events，業務完成與執行完成分離 |
| P-15 | `modules/model-connections/` | NEW | model binding與預算、auth evidence，不保管明文key |
| P-16 | `modules/site-applications/` | NEW | user網站與platform system service身分 |
| P-17 | `apps/credential-broker/` | NEW | 隔離解密與provider calls；private service binding、無generic fetch proxy |
| P-18 | `apps/platform-api/src/runtime.ts`／`worker.ts` | MODIFY | 注入broker/dispatcher adapters，保持runtime-neutral測試；不把native程序放Worker |
| P-19 | `wrangler.jsonc` | MODIFY | 僅必要service binding/queue/config readiness；保留環境與Hyperdrive no-cache條件 |
| P-20 | `wrangler.credential-broker.jsonc` | NEW | 獨立vault role/key；不從publicworker繼承任意admin secrets |
| P-21 | `migrations/{next}_execution_identity.sql` | NEW | principals/device/connection/keys/model metadata；next於merge時分配 |
| P-22 | `migrations/{next}_execution_work_acl.sql` | NEW | work mode/visibility/backfill/query indexes，先保護查詢再啟用private work |
| P-23 | `migrations/{next}_execution_runs.sql` | NEW | grants/run/lease/intent/receipt/control/events與constraints |
| P-24 | `migrations/{next}_credential_vault.sql` | NEW | ciphertext與專用role，不包含真實key，migration log不得洩密 |
| P-25 | `contracts/execution/v1/` | NEW canonical | OpenAPI＋JSON Schema＋event catalog＋fixtures＋generated sources manifest |
| P-26 | `contracts/preview/v1/metadata.json` | KEEP/相容MODIFY | 既有preview false不提前翻true；新增execution discovery獨立advertise |
| P-27 | `packages/sdk/` | GENERATED | 由central schemas生成，existing preview SDK仍可用 |
| P-28 | `apps/portal-web/src/App.tsx`、`Navigation.tsx`、`types.ts` | MODIFY | 新tab/路由類型，避免把workflow邏輯塞進App |
| P-29 | `apps/portal-web/src/api.ts` | MODIFY | human UI typed calls，key body不進shared logger；machine client另包 |
| P-30 | `apps/portal-web/src/modules/autopilot/` | NEW | Work list/detail/Review/Control view |
| P-31 | `apps/portal-web/src/modules/agent-connections/` | NEW | pairing、CLI/BYOK、runtime/sitekey設定 |
| P-32 | `apps/portal-web/src/GameConsole.tsx`相關安全事件層 | 有限MODIFY | safe projection；不存prompt secrets或作authority |
| P-33 | `tests/`新增execution suites | NEW | 權限、跨tenant、private mode、replay、revoke/race、key-redaction |
| P-34 | `.github/workflows/verify.yml` | MODIFY | extension/neo conformance以pinned fixture證明；不要每個PR重buildChromium |

MODIFY中少數supporting檔案是由已讀source imports/目錄確定位置，未逐行檢視；正式實作前須在這些檔案核對具體signature。不得以表格當現成可套用的diff。

## 5.3 Agent Kit與其他現有repo

| 路徑／repo | 處理與要求 |
|---|---|
| Agent Kit `src/cli.mjs` | MODIFY：保留demo為明確subcommand，新增真正login/connect/run，不將demo帳密拿到production。[R01] [R06] |
| Agent Kit `src/native-host/` | NEW：stdio bridge，限定命令、sender/size/nonce、keychain、生命周期 |
| Agent Kit `adapters/codex/` | NEW：官方status/login/stream/cancel，配置與模型付費來源驗證 |
| Agent Kit `adapters/claude-code/` | NEW：官方binary、官方登入、工具限制與版本fixture |
| Agent Kit `mcp/freedom-work-server/` | MODIFY既有scaffold：實作scoped facade，不能只回dummy成功 |
| Agent Kit `packages/client/`／`packages/protocol/` | GENERATED wrappers：pin中央execution bundle，不手寫第二份契約 |
| Agent Kit `contracts.lock.json`／verify scripts | MODIFY：記錄execution bundle exact release/digest與相容範圍 |
| Agent Kit `packages/runtime-core/` | NEW：native/API runtime共用模型事件normalization、dispatch journal介面；不承擔中央權限真相 |
| Skill Registry `templates/starter-skill/` | MODIFY：新增capability/data-policy/input-output與license/source manifest；不能自動把舊指引當可執行skill。[R02] |
| Skill Registry `registry/packages.yaml` | KEEP聲明性：不把installed state塞進repo；空清單不代表網站沒有技能書 |
| Storefront `packages/storefront-sdk/` | 相容MODIFY：execution client只能呼叫本人明授的draft operation；舊readonlyclient保留。[R03] |
| Supplier `client/`／`client-source.lock.json` | KEEP readonly：新寫入流程不偷偷更新舊scope；transport變更仍由平台產生。[R04] |
| Growth `services/publication-worker/`等 | 由preview逐步接typed job；名稱叫worker不代表已有scheduler。正式發布要有效scope／signature。[R05] |
| Growth `packages/channel-adapters/` | NEW具體provider adapter時帶驗收；manual share仍self_reported，不能改成verified |

新的browser與extension逐檔細節見02、03章；不能把上游AGPL程式直接搬入另一repo卻刪掉license。普通extension可獨立實作標準browser APIs，共用自家公開wire schema，授權仍按實際採用檔案處理。

## 5.4 遷移步驟

### M0｜固定需求與來源

在實作branch記錄main與neo commit、目標protocol revision、各consumer相容範圍。設計與API變更先落同一個canonical PR。現行網站不停止服務。

### M1｜先加資料結構與保護查詢

新增nullable/backfillable欄位與表、索引；舊WorkItem回填`community_collaboration`與原有visibility，不偷偷改成private或全部公開。升級所有list/detail/search/event/export的ACL後才允許建立private work。補principal欄位到journal/receipt時保留舊user欄位的讀取相容性，不偽造service user來滿足FK。

### M2｜獨立認證與只讀觀測

部署新的pairing/bootstrap與model connection settings。尚無完整runtime時，UI只顯示setup／capability not available。舊fw_read/shop/skill-upload/development keys維持原用途，不能自動匯成ExecutionGrant。會員不被要求重設平台密碼。

### M3｜受控端到端草稿

啟用一個私人草稿工作：本人CLI或BYOK、準確scope、native/extension/neo至少一條已驗收path。結果只建draft。新flow完成前不把metadata `external_job_execution`全局標true；改由execution discovery列已驗收capability與環境。

### M4｜兩種瀏覽器完整交接

extension與neo共用相同contract fixtures，完成pause/takeover/resume/revoke。驗證舊epoch不能操作任何tab。逐網站adapter記錄可觀測能力，unknown effect不得默認低風險。

### M5｜擴大有權限的業務actions

依據已有domain command逐項啟用，不一口氣把所有POST API暴露給Agent。A4對應的產品路徑只有在人類簽章/step-up/precise effect綁定完成後開啟；否則維持人在網站手動完成。既有付款／bank/seller facts來源不變。

### M6｜舊設計收斂與相容期

消除重複schema／state enum；既有preview clients仍支援，execution clients另行pair。若API major改版，給明確deprecated時間與consumer狀態，不為了新browser打斷供貨者舊工具。舊key不授新scope。

### Rollback

一鍵關閉**新執行**入口、撤銷新permits、停止新model calls；會員／社群／原本商店與唯讀client仍工作。已在途effects進reconcile。append-only新表不在緊急rollback時drop，避免失去作業證據；UI可回舊版但保留run reconciliation管理入口。生成schema與DB版本向前相容，回滾不能使舊憑證意外多出權限。

## 5.5 平行開發與技術依賴

| Track | 範圍 | 依賴 | 可獨立交付 |
|---|---|---|---|
| T0 Contract/Auth | schemas、principal、pairing、Grant、fixtures | 無；source基線已定 | SDK與mock transport |
| T1 Platform | Work ACL、run/lease、UI、broker、events | T0核心DTO與auth | 私人draft API＋明確not-ready UI |
| T2 Extension | MV3 panel、typed executor、native bridge | T0 fixtures；實跑需T1 | 打包extension與fixture網站測試 |
| T3 Neo | Rust guard、MCP身份、recording、cockpit | T0 fixtures；實跑需T1 | isolated tests＋managed fake platform |
| T4 Agent Kit | 官方CLI adapters、native host、模型auth證據 | T0，CLI官方版本 | 本人login＋最小tool conformance |
| T5 Business adapters | 商品/行銷草稿、後續發布 | T1 domain auth，T2/T3必要能力 | 每operation的scope／effect證據 |

不新增每個track都要真人開會核准。共用contract互相相容即可並行；涉及secret、正式發布、權限變更等使用既有owner與安全審查。控制面不可用時，client可以在fixture環境持續開發，不因沒有production key而使用假成功。

## 5.6 第一個垂直場景與完成條件

**場景：本人商品介紹草稿。**

Input：本人已存在商品、允許的公開作品資料、目標語言、草稿欄位、所選模型。Output：版本化draft artifact與來源ref。不要求支付／正式上架權限。

平台讀商品用業務API；需要查外部公開頁才派browser。原有商品／supplier records不搬到client DB。Agent修改內容先寫draft，回網站讓人預覽。人工接手後重新觀察，不覆寫人修改。取消之後不再花新模型額度、不再操作tab，已發生操作留清楚狀態。

完成必須同時出現：website與client同Work ID、本人model binding、精確Grant、真實runtime actions、receipt、可重試但不重複副作用、no secret logs、結果不自動official。這不是展示mock UI即可算完成。

## 5.7 驗收案例（需實作並實跑，不是本次聲稱已過）

### 身分／金鑰／模型

| Test ID | 測試與預期 |
|---|---|
| AUTH-01 | 無登入讀private work →401/404，不回metadata |
| AUTH-02 | fw_read token打execution mutation →拒絕，原readonly仍正常 |
| AUTH-03 | shop machine key打execution/LLM endpoint →拒絕 |
| AUTH-04 | site key填另一會員user_id →拒絕，不建立fake session |
| AUTH-05 | 無本人CLI/BYOK開始user AI run →model_auth_required |
| AUTH-06 | 沒有模型時仍可配對、撤key與瀏覽普通會員功能 |
| AUTH-07 | 本人CLI登入成功但不支持工具限制 →assisted profile，不能宣稱managed |
| AUTH-08 | CLI檔案存在但status無效 →不是ready |
| AUTH-09 | 已選subscription但環境API key會override →阻擋或請本人明選，不暗中計費 |
| AUTH-10 | CLI quota耗尽 →waiting_engine，未呼叫platform provider key |
| AUTH-11 | A的BYOK connection綁到B的run →拒絕 |
| AUTH-12 | refresh重播 →撤family，既有in-flight進明確狀態 |
| AUTH-13 | DPoP錯誤key、audience、method、URI、過期／重放 →拒絕 |
| AUTH-14 | 專用secret mint重試 →不把明文secret寫command_receipts/log |
| AUTH-15 | production憑證用在staging或反向 →拒絕 |
| AUTH-16 | userAccessKey擴權請求A4 →拒絕；human confirm必走獨立驗證 |

### 工作／控制／一致性

| Test ID | 測試與預期 |
|---|---|
| WORK-01 | 個人可以建立並執行自己的私人工作，不走舊self-claim |
| WORK-02 | 社群協作仍禁止自我驗收與虛假貢獻 |
| WORK-03 | private工作不出現在別人的list/search/events/export/notifications |
| WORK-04 | Agent完成只提交結果，不自動accepted／XP／official |
| WORK-05 | 一個scope兩Agent同時claim →只有一個currentlease |
| WORK-06 | 舊lease/epoch的commands、receipts →阻止新effect，late evidence只reconcile |
| WORK-07 | grant撤銷與authorize競態 →依鎖順序，無越權新permit |
| WORK-08 | take over時queue有命令 →舊epoch全部失效；inflight列明 |
| WORK-09 | 人手動改了頁面後resume →新observation，舊node ref不能用 |
| WORK-10 | begin成功但回應丢失 →查询同dispatch，不另建intent重送 |
| WORK-11 | browser click後斷線 →result_unknown，不再次click |
| WORK-12 | 同intent不同args digest →409 |
| WORK-13 | event重複/亂序/gap →去重與補讀，不跳state |
| WORK-14 | 取消後晚到model結果 →保存／忽略明示，不派新effect |
| WORK-15 | 換runtime →舊epoch被fence，新環境自行登入，不複製cookie |
| WORK-16 | result_unknown未解決 →不能宣告run completed |

### Chrome Extension

| Test ID | 測試與預期 |
|---|---|
| EXT-01 | 無Native Host的純extension仍可BYOK模式；CLI明示missing |
| EXT-02 | 訊息sender/frame/document不符 →拒絕，不能啟動nativecommand |
| EXT-03 | permission只給A站，redirect到B站 →停止並請權限 |
| EXT-04 | Grant撤但Chromehostperm仍在 →不得新操作 |
| EXT-05 | 殺掉MV3worker/reload →恢復cursor/journal，不重click |
| EXT-06 | browser重開token已失效 →重新授權，不沿用舊permit |
| EXT-07 | tabID重用/SPA換頁/DOMnode detached →target_changed |
| EXT-08 | file upload未選檔 →user gesture required，不讀任意路徑 |
| EXT-09 | JSON夾JS/eval/remotehandler →schema拒絕 |
| EXT-10 | 模型/頁面要求讀其他tab cookies →拒絕 |
| EXT-11 | recording遇password/token/A4/login頁 →capture前遮罩或暫停 |
| EXT-12 | key寫入storage.sync或bundle →CI fail |
| EXT-13 | localStop不等網路 →立即拒絕新effect，UI顯示pending reconcile |
| EXT-14 | browser關閉 →localexecution停止，不承諾24/7 |

### neo／MCP

| Test ID | 測試與預期 |
|---|---|
| NEO-01 | managed MCP無Freedomcontext →拒絕，不退到upstream無限制路徑 |
| NEO-02 | 跨Agent／人類tab，即使upstream ownership提示存在 →scope拒絕 |
| NEO-03 | raw `run`／`evaluate`直接call →拒絕，不只藏catalog |
| NEO-04 | helper/scriptnestedexecution →guard一致，無旁門 |
| NEO-05 | 使用未授權localREST/CORS請求控制 →拒絕 |
| NEO-06 | 手動改Standalone設定控制同managedprofile →拒絕／獨立instance |
| NEO-07 | MCP session label自稱Ted但token不是 →拒絕 |
| NEO-08 | app更新後guard仍覆蓋所有execute paths；property test檢查 |
| NEO-09 | upstreamrecordingcontent不自動上傳平台 |
| NEO-10 | generatedDTO被手改與schema不一致 →CI fail |
| NEO-11 | Windows packaged launch與macOS dev實測分開，Linux不捏造支持 |
| NEO-12 | cancel後遲到effect audit不能改成業務accepted |

### 隱私／成本／維運

| Test ID | 測試與預期 |
|---|---|
| OPS-01 | providerURLredirect／私網／metadataSSRF →拒絕 |
| OPS-02 | 公開worker拿不到vault解密key；普通DBrole不能讀secret |
| OPS-03 | budget並行reserve →不超出平台可保證的cap；未知charge不歸零 |
| OPS-04 | 使用者撤BYOK →停止新推論，系統key不fallback |
| OPS-05 | Queue重送／outbox重派 →唯一effect/idempotentjob |
| OPS-06 | main API rollback →既有會員/readonly仍可用，execution新動作停用 |
| OPS-07 | DB restore後key已撤狀態不因舊backup復活；rotate/denylist核對 |
| OPS-08 | 分享ViewerGrant撤銷 →原viewer不能取新recording/artifact |
| OPS-09 | privatework新增以前所有舊querysurface已加ACL |
| OPS-10 | 技能書未簽／未驗證 →來源可讀，不會偷偷runtime install |
| OPS-11 | adversarial page篡改effect label／收件人 →policy拒絕或人工處理 |
| OPS-12 | provider unavailable／model renamed →blocker，禁止猜測成功或替換 |

共70項案例。它們是驗收要求，並非本文件validator已驗證的產品行為。

## 5.8 CI與release設計

現有平台 `verify.yml` 已包含build、typecheck、contract生成漂移、PostgreSQL測試、worker dryrun及E2E。[P11] 延伸它，不再新增數十個內容相同但名字不同的gate。

日常PR只跑受影響範圍與共用auth/contract關鍵suite；schema改動必須跑TS/Rust consumer conformance。固定required aggregate job能真正反映必跑tests，不能因路徑skip而假綠。全量跨平台／Chromium發版build可獨立release workflow；文件PR不必重建整個browser。

安全關鍵測試包括Grant、device proof、privateworkACL、dispatch、secret redaction，不能為精簡CI直接刪掉。可刪重複環境、重複contractlint和不可達mock測試，但要保留可追溯mapping。

沒有必要每個repo同時更新所有大版本。中央發布immutablebundle → consumer各自pin →相容性manifest綠燈；正式browser release需要production簽署與既有A4規則，不由codingAgent因所有測試通過就自行發布。

## 5.9 必須提供的交接證據

每個PR列：baseSHA、改動檔案、contractdigest、設計決策ID、真正執行過的命令、測試環境、失敗與not_run項目。native/neo/extension須附假資料scenario的安全紀錄；不附真實key/profile/cookie。平台API通過不代表實機browser通過，UI能看不代表effect被強制授權。

本次交付只對文件及附帶JSON樣本做本地驗證；沒有repo checkout/build、真實CLIauth、Chrome商店審核、Chromiumbuild或productiondeployment。這些不得在後續README被寫成已完成。


---

<a id="section-06"></a>

# 06｜研究來源、版本與查證範圍

查證日：2026-10-01（America/New_York）。此索引區分**讀過的程式段、README產品聲明、僅核對的路徑，以及設計提案**。GitHub與官方文件均由工具實際讀取；本地無完整checkout，未建置或執行這些repo。

## 6.1 固定版本

- Platform commit：`c78efb93cbf47f0812e17006c47413001b649a40`。
- BrowserOS/neo commit：`53c3799ce014e9fee05569802314a05d0bad3e40`。
- 其他repo取得單檔blob SHA，以下「固定內容」連結是Git blob API；不是repo commit。main連結可能日後改變，以blob SHA界定本次讀取內容。
- 所有NEW路徑是本規格建議；MODIFY檔案若僅核對存在，需在實作PR開工前進一步讀全文。

## 6.2 Platform 原始碼

<a id="source-p01"></a>

### P01｜`package.json`
查證深度：全文。Blob：`ff7f992ef5a4ea58e10e8fd04dc1865753b907af`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/package.json)
支持的結論：Node/TypeScript/Hono/pg/React/Vite 與既有測試入口；不因新端改換平台 stack。

<a id="source-p02"></a>

### P02｜`apps/platform-api/src/platform-app.ts`
查證深度：第1–260行。Blob：`ceaee5e8c2209c6560d0952350d9ccf00721e522`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/apps/platform-api/src/platform-app.ts)
支持的結論：現有 app assembly、cookie actor／Origin與機器路由切面；不是整個檔案的逐行安全稽核。

<a id="source-p03"></a>

### P03｜`apps/platform-api/src/routes/agent-commerce.ts`
查證深度：全文。Blob：`d6b785f79b22162d913dc31b928e78c1e00740f4`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/apps/platform-api/src/routes/agent-commerce.ts)
支持的結論：shop machine key 與 shop-api 的用途；不可推定通用 Agent 模型／執行權。

<a id="source-p04"></a>

### P04｜`apps/platform-api/src/routes/client-connections.ts`
查證深度：全文。Blob：`c8a8e45181af7fda2a98d17b9b4efc7f1f02844f`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/apps/platform-api/src/routes/client-connections.ts)
支持的結論：現有配對與唯讀 client routes。

<a id="source-p05"></a>

### P05｜`modules/client-connections/service.ts`
查證深度：全文。Blob：`e6407f7fc63125324dda50df217a34be9b4f70bb`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/modules/client-connections/service.ts)
支持的結論：storefront/supplier 類型、fw_read 憑證、配對期限、owner與撤銷。

<a id="source-p06"></a>

### P06｜`packages/db/index.ts`
查證深度：全文。Blob：`8aaa71b1a10561731efe5e40a98555c962ffb159`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/packages/db/index.ts)
支持的結論：command 的真人 session驗證、receipt、transaction、journal/outbox、digest；新機器 principal 需另驗。

<a id="source-p07"></a>

### P07｜`modules/opportunity-project-work/work.ts`
查證深度：全文。Blob：`374866fdd09bae0227b6e6eb9f79d7c4725e2e67`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/modules/opportunity-project-work/work.ts)
支持的結論：voluntary/community work、self-claim禁止與現有讀取範圍；私人Autopilot不能只放寬self-claim。

<a id="source-p08"></a>

### P08｜`contracts/preview/v1/metadata.json`
查證深度：全文。Blob：`050768624b16da954afc0b65bc92e2d42f065665`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/contracts/preview/v1/metadata.json)
支持的結論：preview 宣告 member session / external job execution=false；設計存在不代表已上線。

<a id="source-p09"></a>

### P09｜`apps/portal-web/src/App.tsx`
查證深度：第1–105行。Blob：`5e95268b3063ed5fd5c7d3c6bef41afe10608fed`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/apps/portal-web/src/App.tsx)
支持的結論：既有Navigation、TabId、hash導覽與UI模組匯入；只查此範圍，相關component多為路徑核對。

<a id="source-p10"></a>

### P10｜`wrangler.jsonc`
查證深度：全文。Blob：`b795da562a2651d4d47dfc1403c9e7e19d501280`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/wrangler.jsonc)
支持的結論：Worker/Hyperdrive/環境/maintainer邊界。模板ID不是資源已配置或未配置的現場證據。

<a id="source-p11"></a>

### P11｜`.github/workflows/verify.yml`
查證深度：全文。Blob：`b1439175b6924a871ffd24fa35ba5654b1d9bfbd`。
[固定commit來源](https://github.com/FreeTWAI-AI/freedom-platform/blob/c78efb93cbf47f0812e17006c47413001b649a40/.github/workflows/verify.yml)
支持的結論：現有CI工具與命令；本次未執行這些流程。

<a id="source-p12"></a>

### P12｜Platform tree／planning路徑清單
[固定tree](https://api.github.com/repos/FreeTWAI-AI/freedom-platform/git/trees/eac164d57a8be1f0e9cc9eaf4970b058d53f6b79?recursive=1)
確認目錄、migrations、routes、modules與planning AGT檔名；不是這些檔案全部的內容稽核。大型planning中WorkContext／Grant相關片段另經GitHub search與當前對話提供內容核對。
正確planning名稱包括 `02-system-architecture.md`、`AGT-01-agent-protocol.md`、`AGT-02-grants-intents-signatures.md`、`AGT-03-work-feed.md`、`AGT-04-cli-adapters-and-partner-runtime.md`、`AGT-05-human-ai-journey-and-concierge.md`。

## 6.3 BrowserOS neo 原始碼

<a id="source-n01"></a>

### N01｜`README.md`
查證深度：全文／產品與架構段。Blob：`cc40ab4e6540db442ef7d2dba5256765c7a2f5b2`。
[固定commit來源](https://github.com/browseros-ai/BrowserOS/blob/53c3799ce014e9fee05569802314a05d0bad3e40/README.md)
支持的結論：區分BrowserOS neo與一般BrowserOS；neo為Rust backend/cockpit，產品支援與AGPL說明。

<a id="source-n02"></a>

### N02｜`packages/browseros-agent/apps/claw-server-rust/src/app.rs`
查證深度：第1–190、213–340行。Blob：`0a2e2139c424ce95e4d36bef6650870f33504496`。
[固定commit來源](https://github.com/browseros-ai/BrowserOS/blob/53c3799ce014e9fee05569802314a05d0bad3e40/packages/browseros-agent/apps/claw-server-rust/src/app.rs)
支持的結論：AppState服務、session/profile/browser/audit與本機SQLite；不等於平台工作資料庫。

<a id="source-n03"></a>

### N03｜`packages/browseros-agent/apps/claw-server-rust/src/api/http/mod.rs`
查證深度：第1–220行。Blob：`0ec35408a522fb6b69931c90f79f4944f94bde8c`。
[固定commit來源](https://github.com/browseros-ai/BrowserOS/blob/53c3799ce014e9fee05569802314a05d0bad3e40/packages/browseros-agent/apps/claw-server-rust/src/api/http/mod.rs)
支持的結論：MCP browser-origin拒絕、HTTP路由與CORS切面；不可直接當多租戶遠端API。

<a id="source-n04"></a>

### N04｜`packages/browseros-agent/apps/claw-server-rust/src/api/mcp/dispatch.rs`
查證深度：第1–205行。Blob：`bee1f7424a181cfb253bb4a18d309a89b9a7f046`。
[固定commit來源](https://github.com/browseros-ai/BrowserOS/blob/53c3799ce014e9fee05569802314a05d0bad3e40/packages/browseros-agent/apps/claw-server-rust/src/api/mcp/dispatch.rs)
支持的結論：guard/effect/observer結構；ownership明確非guard；run/evaluate需處理。

<a id="source-n05"></a>

### N05｜`packages/browseros-agent/apps/claw-app/wxt.config.ts`
查證深度：全文。Blob：`3a1ff1e423669a0d21f624c4f1b7902d49694262`。
[固定commit來源](https://github.com/browseros-ai/BrowserOS/blob/53c3799ce014e9fee05569802314a05d0bad3e40/packages/browseros-agent/apps/claw-app/wxt.config.ts)
支持的結論：專屬browserOS permission與其他permissions；不能原封裝到普通Chrome。manifest key為公開extension識別材料，不應誤報為洩漏API秘密。

<a id="source-n06"></a>

### N06｜`packages/browseros-agent/apps/claw-app/entrypoints/recorder.content.ts`
查證深度：全文。Blob：`bab8b0eb0bc284cf0822b46c93f9b66da32522d0`。
[固定commit來源](https://github.com/browseros-ai/BrowserOS/blob/53c3799ce014e9fee05569802314a05d0bad3e40/packages/browseros-agent/apps/claw-app/entrypoints/recorder.content.ts)
支持的結論：rrweb、password mask、注入範圍與local recording；不能推定完整敏感資料遮罩。

<a id="source-n07"></a>

### N07｜`packages/browseros-agent/CONTRIBUTING.md`
查證深度：全文。Blob：`4d81e43e38777acb358e6d0be866a3410bf8725d`。
[固定commit來源](https://github.com/browseros-ai/BrowserOS/blob/53c3799ce014e9fee05569802314a05d0bad3e40/packages/browseros-agent/CONTRIBUTING.md)
支持的結論：Axum/SeaORM/rmcp/WXT與codegen/testing、macOS dev supervisor；命令未實跑。

<a id="source-n08"></a>

### N08｜neo src／API／extension路徑清單
[Rust src目錄](https://api.github.com/repos/browseros-ai/BrowserOS/contents/packages/browseros-agent/apps/claw-server-rust/src?ref=53c3799ce014e9fee05569802314a05d0bad3e40)
[API subtree](https://api.github.com/repos/browseros-ai/BrowserOS/git/trees/e75591cb3ed66f0465c34da466d0630dae7bb8e0?recursive=1)
[claw-app entrypoints](https://api.github.com/repos/browseros-ai/BrowserOS/contents/packages/browseros-agent/apps/claw-app/entrypoints?ref=53c3799ce014e9fee05569802314a05d0bad3e40)
config.rs、db/、API helper/guard/service/session/recording/live等及extension background/newtab的路徑核對；未宣稱已逐行追完所有nested browser execution paths。這是首輪managed-mode實作必做的完整覆蓋測試工作。

## 6.4 關聯repo

<a id="source-r01"></a>

### R01｜`FreeTWAI-AI/freedom-agent-kit` · `README.md`
查證深度：該檔全文。Blob：`30c17279485d7af27b3d623411bab3ec41a15175`。
[可讀main來源](https://github.com/FreeTWAI-AI/freedom-agent-kit/blob/main/README.md) · [固定內容](https://api.github.com/repos/FreeTWAI-AI/freedom-agent-kit/git/blobs/30c17279485d7af27b3d623411bab3ec41a15175)
pinned protocol／demo CLI；device flow、ExecutionGrant、可執行MCP仍未完成。

<a id="source-r02"></a>

### R02｜`FreeTWAI-AI/freedom-skill-registry` · `README.md`
查證深度：該檔全文。Blob：`a9ffd0fc6b08fc85abe2ca2e775b49e8a86f3240`。
[可讀main來源](https://github.com/FreeTWAI-AI/freedom-skill-registry/blob/main/README.md) · [固定內容](https://api.github.com/repos/FreeTWAI-AI/freedom-skill-registry/git/blobs/a9ffd0fc6b08fc85abe2ca2e775b49e8a86f3240)
starter template與聲明性registry，不等於已安全安裝可執行skills。

<a id="source-r03"></a>

### R03｜`FreeTWAI-AI/freedom-storefront` · `README.md`
查證深度：該檔全文。Blob：`19f63d92c403d8d357c23e0c0959e40e45313ad2`。
[可讀main來源](https://github.com/FreeTWAI-AI/freedom-storefront/blob/main/README.md) · [固定內容](https://api.github.com/repos/FreeTWAI-AI/freedom-storefront/git/blobs/19f63d92c403d8d357c23e0c0959e40e45313ad2)
preview/read-only/template能力，不推定正式付款／對外publish已完成。

<a id="source-r04"></a>

### R04｜`FreeTWAI-AI/freedom-supplier-client` · `README.md`
查證深度：該檔全文。Blob：`64413da611a73e90d64d59eaa788274afafb636d`。
[可讀main來源](https://github.com/FreeTWAI-AI/freedom-supplier-client/blob/main/README.md) · [固定內容](https://api.github.com/repos/FreeTWAI-AI/freedom-supplier-client/git/blobs/64413da611a73e90d64d59eaa788274afafb636d)
唯讀會員client與local key custody，非通用Agent執行端。

<a id="source-r05"></a>

### R05｜`FreeTWAI-AI/freedom-growth-automation` · `README.md`
查證深度：該檔全文。Blob：`203c1e9f9c4d4f6121cad05fe0b9f773c0725ed0`。
[可讀main來源](https://github.com/FreeTWAI-AI/freedom-growth-automation/blob/main/README.md) · [固定內容](https://api.github.com/repos/FreeTWAI-AI/freedom-growth-automation/git/blobs/203c1e9f9c4d4f6121cad05fe0b9f773c0725ed0)
草稿、pure functions、manual share；worker路徑名稱不是scheduler部署證明。

<a id="source-r06"></a>

### R06｜`FreeTWAI-AI/freedom-agent-kit` · `src/cli.mjs`
查證深度：該檔全文。Blob：`49dda5c24b11427f531b3ad62ac21f7c3bf26e36`。
[可讀main來源](https://github.com/FreeTWAI-AI/freedom-agent-kit/blob/main/src/cli.mjs) · [固定內容](https://api.github.com/repos/FreeTWAI-AI/freedom-agent-kit/git/blobs/49dda5c24b11427f531b3ad62ac21f7c3bf26e36)
明確localhost示範登入／read workspace／logout；正式登入與native bridge需新增。

## 6.5 官方技術來源

官方網站會持續更新；以下為本次讀取依據，不把未來版本視為已驗收。未列價格與任何未核對的模型名稱。

<a id="source-w01"></a>

### W01｜Chrome Native Messaging
[官方來源](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
extension需獨立native host才能啟動本機CLI；sender與manifest驗證。

<a id="source-w02"></a>

### W02｜Extension service worker lifecycle
[官方來源](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
MV3非永久daemon；journal/reconnect設計必需。

<a id="source-w03"></a>

### W03｜Chrome permissions API
[官方來源](https://developer.chrome.com/docs/extensions/reference/api/permissions)
按需請求／移除origin與optional能力；不等於Freedom業務授權。

<a id="source-w04"></a>

### W04｜Chrome activeTab
[官方來源](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
user gesture取得臨時current-tab存取，非全瀏覽器授權。

<a id="source-w05"></a>

### W05｜Chrome Side Panel API
[官方來源](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
工作面板與user-gesture開啟條件。

<a id="source-w06"></a>

### W06｜Chrome storage API
[官方來源](https://developer.chrome.com/docs/extensions/reference/api/storage)
storage的session/local/sync生命週期；不將其當OS secret vault。

<a id="source-w07"></a>

### W07｜Manifest V3 remote hosted code
[官方來源](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
不能下載／執行任意遠端JS；typed資料與執行程式分開。

<a id="source-w08"></a>

### W08｜RFC 8628 — Device Authorization Grant
[官方來源](https://www.rfc-editor.org/rfc/rfc8628.html)
裝置代碼、使用者確認、poll節流的基準。

<a id="source-w09"></a>

### W09｜Claude Code legal and compliance
[官方來源](https://code.claude.com/docs/en/legal-and-compliance)
官方CLI、終端使用者官方登入；不得蒐集／中介訂閱OAuth憑證。不是禁止所有官方CLI整合的概括結論。

<a id="source-w10"></a>

### W10｜RFC 8785 — JSON Canonicalization Scheme
[官方來源](https://www.rfc-editor.org/rfc/rfc8785.html)
新跨語言digest採標準canonicalization；不修改歷史digest。

<a id="source-w11"></a>

### W11｜MCP authorization specification 2025-11-25
[官方來源](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
本版明確固定的MCP授權基準；session不等於身份，token audience不能任意轉用。

<a id="source-w12"></a>

### W12｜RFC 9449 — DPoP
[官方來源](https://datatracker.ietf.org/doc/html/rfc9449)
proof-bound token的標準依據；仍需TLS與完整replay/nonce驗證。

<a id="source-w13"></a>

### W13｜Codex authentication — official documentation
[官方來源](https://learn.chatgpt.com/docs/auth)
本次由developers.openai.com/codex/auth/導向此官方頁；CLI登入、API選項、status與credential處理。

## 6.6 研究限制與待實機驗證

本次無真實供應商登入／模型扣款、Chrome Web Store上架、Windows或macOS packaged browser啟動、Chromium build、正式DB migration、實際多租戶壓力或完整prompt-injection測試。供應商條款可能變更，發版時需再次查核。
程式碼中已存在的功能，也不等於正式站目前部署了該commit；此文件是repo版本設計，不是線上站點滲透測試報告。
70項驗收案例是未來產品必須實跑的要求。附帶工具只驗證本交付的JSON schema、假資料與文件完整性；實際結果另存 VALIDATION.md，兩者不可混稱。


---

<a id="handoff"></a>

# 開發 Agent 接手指令

請先讀 README 與00–06章，使用本次研究的固定commit作比較基準，但真正修改前重新取得repository HEAD與既有PR，避免覆寫別人的變更。

此任務是將Freedom Autopilot的platform、標準Chrome extension、BrowserOS neo接入現有架構。不要重新發明會員系統，不擴權fw_read/shop/skill-upload keys，不把CLI OAuth當API key，不使用平台key替會員補額度，不把本稿的schema草稿當正式ContractBundle。

先依05章M0/M1更新canonical planning與execution契約，保留preview consumer，再依T0–T5分工。使用者AI run須本人官方CLI登入或本人API連線；一般會員瀏覽、配對與人工工作不受此gate限制。

平台重點：packages/db的真人session transaction切面、private work ACL、機器principal、run/Grant/lease、broker與credentials分離。

Extension重點：標準MV3、已授權task tabs、任務工作面板、typed DOM executor、Native Host可選、worker終止後安全恢復。

neo重點：Rust MCP dispatch的pre-effect guard，而不是只加UI；managed profile全部入口一致驗Grant，關閉raw run/evaluate旁門；不要複製neo manifest到標準Chrome。

逐項對照KEEP/MODIFY/NEW表。無法定位的supporting檔案先讀原始碼確認，不按推測建立同名替代品。新增runtime/Worker/依賴須有明確理由，不把不同client的stack搬入中央平台。

實作交付請附真正diff、pinned contract版本、跑過的命令與環境、70項驗收案例的實際pass/fail/not_run。生成型檔案不可手改。任何本稿中的待實作或測試要求都不能抄成「已完成」。不自行merge、正式release或動正式資料。


---

<a id="validation"></a>

# 本交付的檢查結果

狀態：**本地設計資產檢查 PASS**。

已執行 `python tools/validate_spec.py`（Python／jsonschema 4.26.0）：六份draft2020-12 schema可載入；28個假資料案例符合預期，其中8個正向接受、20個反向拒絕。另核對39個研究來源ID、相對Markdown檔案連結、程式碼區塊及70個不重複的產品驗收需求ID。完整機器輸出在 `validation-report.json`。

**未執行**：70項產品驗收測試本身、平台build/DB migration/E2E、官方CLI實際登入、provider扣款、Chrome/neo實機、DPoP/簽章驗證、Chrome商店審核、正式部署。

這28個案例只測schema與假資料，不能證明run授權、跨租戶隔離、prompt injection防護或外部副作用正確。沒有任何真實key、cookie或會員資料用於這些檢查。

重跑方式（在解壓後資料夾）：

```sh
python -m pip install -r tools/requirements.txt
python tools/validate_spec.py --json-report validation-report.json
```

檔案完整性可用 `SHA256SUMS.txt` 驗證；這是交付完整性摘要，不是平台production signing。

[P01]: #source-p01

[P02]: #source-p02

[P03]: #source-p03

[P04]: #source-p04

[P05]: #source-p05

[P06]: #source-p06

[P07]: #source-p07

[P08]: #source-p08

[P09]: #source-p09

[P10]: #source-p10

[P11]: #source-p11

[P12]: #source-p12

[N01]: #source-n01

[N02]: #source-n02

[N03]: #source-n03

[N04]: #source-n04

[N05]: #source-n05

[N06]: #source-n06

[N07]: #source-n07

[N08]: #source-n08

[R01]: #source-r01

[R02]: #source-r02

[R03]: #source-r03

[R04]: #source-r04

[R05]: #source-r05

[R06]: #source-r06

[W01]: #source-w01

[W02]: #source-w02

[W03]: #source-w03

[W04]: #source-w04

[W05]: #source-w05

[W06]: #source-w06

[W07]: #source-w07

[W08]: #source-w08

[W09]: #source-w09

[W10]: #source-w10

[W11]: #source-w11

[W12]: #source-w12

[W13]: #source-w13
