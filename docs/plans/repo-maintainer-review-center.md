# PR／Issue 審核中心（Freedom Maintainer）設計

> 設計稿，2026-10-01 改版，對照 main `82b9112`。階段 1a–1c 在 PR #73（分支 `feat/repo-maintainer-review-center-20260930`）實作，驗證結果記在 PR #73。Maintainer GitHub App 與 `main` ruleset 還沒建立，所以鏡像 Worker 還沒部署；在那之前，後台與「公會管理」的「PR 審核」清單都是空的。本文的「採用」只代表設計決定，不代表功能已上線。
>
> 2026-10-01 Ted 決定：公會長審自己公會的模組與技能書；管理員什麼都能審，審完可以指定歸屬；不設風險分級和 SLA；沒有人按按鈕，就不自動處理；AI 一開始用各人自己的訂閱。舊版的風險分級、SLA、逾時交 AI 與 policy 自動合併已移除。

**一句話：公會長審自己公會的，管理員什麼都能審並決定歸屬；沒有人按按鈕，系統就不在 GitHub 上做任何事；審核與合併的事實都留在 GitHub。**

## 1. 為什麼要做

以下是 2026-09-30 從程式碼與 GitHub 讀到的現況：

- `main` 沒有 branch protection，也沒有 ruleset（`gh api repos/FreeTWAI-AI/freedom-platform/branches/main/protection` 回 404）。`verify` 沒過一樣能合併；[repository-integration](../development/repository-integration.md) 也寫明中央 ruleset 尚未配置。
- 外部 PR 的 CI 可能根本沒跑。例：#46 來自 fork（首次貢獻者），38 個檔、+1781／−180，`statusCheckRollup` 是空的、與 main 衝突，新增的 `048_agent_shops.sql`、`049_commerce_distribution.sql` 和 main 既有的 048／049 撞號。最後由維護者另開 #61，改成 055／056、補修後合併（2026-09-30）。這正是審核中心要提早標出來的情況。
- 平台已經能同步 Issue／PR 的標題與狀態（#59，`github_items`），但沒有 head SHA、CI 結果、review 資料，也沒有 webhook。會員用的 GitHub App 只有 `starring`／`issues` 寫入，webhook 關閉，私鑰建立後就丟棄（`migrations/019_github_app_setup.sql`）。
- 程式裡沒有 App JWT，也沒有 installation token。會員 App 的 manifest 檢查只接受 `starring`／`metadata`／`issues` 三種權限，全平台也只允許一個 App（`modules/github-social/setup.ts`），不能直接擴權來用。
- 沒有任何 webhook 接收端。全站中介層要求非 GET 請求帶允許的 Origin、內容是 JSON 且不超過 32 KiB（`apps/platform-api/src/platform-app.ts`），GitHub 的投遞會被擋下。
- 管理員只有 `super_admin` 一種角色（`migrations/011_platform_admin.sql` 的 CHECK）；[member-toolkit](../development/member-toolkit.md) 也要求不另造有限權限的管理角色。
- 公會長已經有正式的任命資料（`positioning_guild_officers` 加上該公會的有效成員資格），社群活動審核也已經用「該公會的現任會長或管理員」這條規則（`modules/community/events.ts`）。
- 程式裡沒有任何 LLM 呼叫、Queue、Workflow 或 Durable Object。

## 2. 範圍

**做：**

- 後台「PR 審核」：跨 repo 的待審清單、認領、CI 狀態、注意事項，以及「為什麼還不能合併」的逐項說明。
- 公會長的「PR 審核」頁（會員端「公會管理」）：只列自己公會的項目，以及管理員開放認領的項目。
- 歸屬：每個 repo（模組或技能書）屬於哪個公會，由管理員指定；開放認領的 repo 由第一位審完的公會長歸到他的公會。
- 階段 2 的按鈕：有人按下，才讓 AI 修改並推送 PR、合併，或把 Issue 做成 PR。一開始用按的人自己的訂閱。

**不做：**

- 任何自動處理：沒有 SLA、沒有逾時交給 AI、沒有自動合併。上線的東西都是穩定的，PR 可以放著等人。
- 風險分級。路徑與大小只產生「注意事項」，不分等級，也不決定誰能審。
- 部署。合併到 `main` 不等於正式 release；production 仍走既有 release 流程與 Ted 的發布類 A4（06 §3.3、ADR-019）。
- 用 AI 或 bot 冒充真人核准。
- 讓 Issue／PR 內容改變任何設定或權限。

## 3. 設計原則

1. **GitHub 是事實來源。** 平台只保存索引、衍生狀態、認領、歸屬與稽核紀錄；review、合併、merged SHA 以 GitHub 為準（AGENTS.md、[agent-development-guide](../development/agent-development-guide.md)）。
2. **一切綁在 head SHA。** 審核、CI 與之後的按鈕動作都記錄對應的 commit；作者一 push，舊核准就不算目前這一版。
3. **沒有人按，就不動作。** 背景工作只負責把 GitHub 的事實同步進來。寫 GitHub 的事（requested reviewer、階段 2 的按鈕）都要有人按，也都有開關。
4. **誰能審由現有資料推導，不另造名單。** 管理員來自 `platform_admins`，公會長來自正式任命；審核中心只多存「repo 屬於哪個公會」。
5. **能寫 GitHub 的鑰匙不放在對外的 Worker。** 公開網站只拿 webhook secret；Maintainer App 私鑰只在沒有對外路由的維護 Worker（比照 `admin-sync-worker`）。
6. **v1 不新增雲端產品。** 只用現有 Worker、cron、Hyperdrive PostgreSQL 與 row lease（#59 的做法）。
7. **失敗時停下，不猜。** 資料讀不到、權限不足、GitHub 拒絕，一律留在佇列並說明原因。

## 4. 架構

```text
GitHub（PR／Review／Check 事件）
   │ webhook（X-Hub-Signature-256 驗簽）
   ▼
freedom-platform Worker（既有，對外）
   ├─ POST /api/v1/maintainer/github/webhook
   │     驗簽 → 以 X-GitHub-Delivery 去重 → 只記錄＋排工作（不呼叫 GitHub，快速回 202）
   ├─ /admin 後台「PR 審核」API 與畫面（Access JWT＋管理員名單＋CSRF）
   └─ /api/v1/guild-reviews 公會長的審核 API（會員 session＋Origin＋CSRF＋公會長任命）
   │
   ▼
PostgreSQL（同一個 caching-disabled Hyperdrive）
   maintainer_*：repo 設定與歸屬、事件、PR 鏡像、檢查、審核、認領、工作佇列；
   maintainer_eligible_reviewers 檢視表推導誰能審
   ▲
   │ 每分鐘 cron；工作以單一 UPDATE row lease 認領
freedom-maintainer Worker（新，沒有路由）
   ├─ 持有 Maintainer App 私鑰；每個工作換短效、依用途降權的 installation token
   ├─ installation 同步、30 分鐘補查、reconcile：讀 PR、files、reviews、checks → 注意事項與佇列狀態
   ├─ 認領的收尾：PR 關閉、審核人不再符合資格、已送出審查、（有設時效才有的）到期
   └─ 三個開關都打開時，才把認領同步成 GitHub requested reviewer
```

| | freedom-platform（既有、對外） | freedom-maintainer（新、無路由） |
| --- | --- | --- |
| 觸發 | HTTP | 每分鐘 cron |
| 新增職責 | 收 webhook；後台與公會長的審核 API 與畫面 | 同步 GitHub、推導狀態、認領收尾、選用的 requested reviewer |
| GitHub 憑證 | 只有 `GITHUB_MAINTAINER_WEBHOOK_SECRET`（選填；沒設時 webhook 回 503 `maintainer_webhook_unavailable`，不影響全站） | `GITHUB_MAINTAINER_APP_ID`、`GITHUB_MAINTAINER_PRIVATE_KEY`（PKCS#8） |
| AI 憑證 | 無 | 無。階段 2 的 AI 用按的人自己的訂閱（§10），平台不保存模型金鑰 |
| 設定檔 | `wrangler.jsonc` | `wrangler.maintainer.jsonc`，比照 `wrangler.admin-sync.jsonc`：只 export `scheduled`，無 routes、無 workers.dev／preview URL |

**為什麼不用 Queues／Workflows：** cron＋row lease 已經在 #59 驗證過；平台計畫也寫「Server 上不必常駐一隻 LLM agent」（08）。拿掉逾時交 AI 之後，維護 Worker 只做同步與收尾，更沒有長時間等待的工作。

**webhook 只是提示，GitHub API 才是事實。** Webhook 只觸發「重新同步某張 PR」。GitHub 不會自動重送失敗的 webhook，所以維護 Worker 每 30 分鐘另做一次全量補查（分頁讀完，沒有 100 筆上限），補回漏掉或延遲的事件。補查會重新同步這幾種 PR：新的、head 或 `updated_at` 變了的、已經不在 open 清單上的；必要檢查還在跑、或 GitHub 還沒算出能不能合併，而且超過 10 分鐘沒同步的；以及超過 6 小時沒同步的所有 open PR。CI 跑完不會改 PR 的 `updated_at`，漏掉的 check webhook 要靠後面兩條補回。每次補查完，也會把該 repo 的 open PR 排進重新推導，讓公會長或管理員異動在一個補查週期內反映到「已核准」與否（只讀資料庫，不呼叫 GitHub）。

**Webhook 路由的邊界：**

- 路由登記在會員驗證中介層（`/api/v1/*`）之前，只認 `POST /api/v1/maintainer/github/webhook` 這一個精確路徑。全站中介層只對它跳過 Origin 與 32 KiB JSON 檢查，改由路由自己檢查 `Content-Type: application/json`、2 MiB 上限與三個 GitHub 標頭。
- 先驗簽（只用 CPU），通過後才碰資料庫。簽章錯誤只記一行 log、回 401，不寫資料庫，別人無法用假投遞灌滿資料表。
- 只存正規化後的提示（delivery ID、事件、repo 與 installation 的數字 ID、PR 編號或 head SHA）和原始內容的 sha256，不存 payload 本身，對齊 [05 整合契約](../platform-plan/05-integration-contracts.md) 的 WebhookInbox 規則。

**維護 Worker 的額度：** 每次 cron 最多 60 個 GitHub 請求、約 50 秒；installation token 每小時至少有 5,000 次額度，這樣每小時最多用 3,600 次。遇到 rate limit 就記下重置時間，該 installation 的工作延到那時再做。

## 5. 身分與權限

| 身分 | 是誰 | 能做什麼 | 憑證位置 |
| --- | --- | --- | --- |
| 會員 GitHub App（既有 `freedom-workshop-*`） | 會員 | Star、用自己的身分發 Issue | 不變，不擴權 |
| Freedom Maintainer App（新，staging／production 各一） | bot | 讀 PR／CI／review；三個開關都開時，認領同步成 requested reviewer | 私鑰只在 maintainer Worker |
| 管理員 | `platform_admins` 的有效成員 | 審任何 repo；指定 repo 歸屬；指派、釋放任何認領；暫停、重新同步；改設定 | 後台：Access＋管理員名單；GitHub：自己的帳號 |
| 公會長 | 正式任命的公會長（`positioning_guild_officers`），而且仍是該公會的有效成員 | 在會員端「公會管理 → PR 審核」看自己公會的項目與開放認領的項目，認領給自己、放棄自己的認領 | 會員 session；GitHub：自己的帳號 |
| 作者 | 開 PR 的人 | 不能核准自己的 PR | — |

**誰的核准算數（有效核准）：** 審核本身在 GitHub 上完成。平台只判斷那一則 GitHub review 能不能算這個項目的有效核准：

- 管理員：任何 repo 都算。管理員的後台身分以 email 對到同社群、**email 已驗證**的會員，再對到該會員用 OAuth 連結的 GitHub 帳號（GitHub 數字 ID 全平台唯一，見 [github-identity-uniqueness](../development/github-identity-uniqueness.md)）。要求 email 已驗證，是因為未驗證的會員帳號可以借用管理員的 email。
- 公會長：只有該公會的 repo，以及管理員開放認領的 repo 才算。公會長以會員身分登入，不靠 email 對應；同樣要用 OAuth 連結 GitHub。
- 不是作者本人；review 狀態是 APPROVED；`commit_id` 等於目前 head SHA。

這條規則只寫一次，放在資料庫檢視表 `maintainer_eligible_reviewers`；推導狀態、認領、指派、收尾都讀它，不另外維護審核員名單。沒有連結 GitHub 的管理員或公會長看得到清單，但不能認領，他們在 GitHub 上的 review 也對不到人。

**這不授予 GitHub 寫入權。** AGENTS.md：「公會職稱與自填 GitHub slug 不授予寫入權」。「有效核准」只是佇列的判斷：PR 變成「已核准」，合併仍要由在 GitHub 上有寫入權的人操作。

**後台與公會長頁分開：** 後台只給管理員（Access＋`platform_admins`），不新增後台角色。公會長沒有後台權限，所以在會員端另開一頁，只能看與認領自己範圍內的項目，不能指派別人、改歸屬、暫停或改設定。

**Maintainer App 和會員 App 分開：** Maintainer App 設為私有（只能裝在 FreeTWAI-AI），維護 Worker 也會忽略其他帳號的 installation。會員 App 的規則（不留私鑰、不擴權、webhook 關閉）不變。

**Maintainer App 權限：**

| 權限 | 階段 1（預設，不寫 GitHub） | 打開 requested reviewer |
| --- | --- | --- |
| Metadata | Read | Read |
| Pull requests | Read | Read & write（加、移除 requested reviewer） |
| Checks、Commit statuses | Read | Read |
| Contents | Read（讀 base branch 的 migration 清單） | Read |

事件：Pull request、Pull request review、Check suite、Check run、Status（installation 事件自動送出）。安裝時選「Only select repositories」。之後替 App 增加權限，GitHub 會要求 org owner 重新同意，這一步就是 Ted 的人工停點。階段 2 的按鈕預設用按的人自己的 GitHub 身分（§10），Maintainer App 不需要 Contents 寫入。

**Installation token 降權：** 每個工作呼叫 `POST /app/installations/{id}/access_tokens` 時，都帶 `repository_ids` 與 `permissions`，只取這一步需要的權限。例如同步只拿 read，加 requested reviewer 才加 `pull_requests: write`。唯一不帶 repository 的是安裝同步：`GET /installation/repositories` 要用 installation token，而這時還不知道 repository id，所以那張 token 只拿 `metadata: read`。

## 6. 資料模型

本案用兩支 migration：**061、062**。main 最新的是 058（#77，平台憑證）；同時開著的 PR 由 CI 先通過的用最小的空號，所以 #79、#80 用 059、060，#68 的整合 PR 之後改用 063、064（2026-10-01 與各 PR 的工作階段協調）。新增 migration 的 PR 要一併把 `deploy/cloudflare/environments.json` 的 `database_defaults.migrations.last` 改成新的最後編號（#70）；preflight 不接受清單外的空號。這兩支（原暫定 059／060）合併前沒有在任何正式環境套用過，所以階段 1c 直接修改，不另開新號。規則照舊：不改已套用的 migration、不使用 preflight 禁用的語法，背景工作用單一 UPDATE row lease，不用 session advisory lock。GitHub 的 repo、使用者、review 一律存數字 ID（文字欄位、`^[0-9]+$`，比照 053），名稱只供顯示。

**061（觀察）：**

| 表 | 用途 | 重點欄位 |
| --- | --- | --- |
| `maintainer_repositories` | installation 裡的 repo 與每個 repo 的模式 | `github_repository_id`（改名也不變）、`installation_id`、`full_name`（顯示用，會更新）、`default_branch`、`installation_state`、`mode`（只有 `off`／`observe`，新 repo 預設 `observe`；之後的 AI 動作是按鈕，不是 repo 模式）、`settings` jsonb（必要檢查、CI 等待時間、暫停標籤、migration 目錄、認領時效、requested reviewer 開關）、`next_sweep_at`（補查排程兼 row lease）、`rate_limited_until` |
| `maintainer_webhook_deliveries` | 去重與稽核 | `delivery_id` PK、`event`、`action`、`installation_id`、`github_repository_id`、`target_number` 或 `head_sha`、`outcome`（`queued`／`ignored`）、`payload_sha256`；驗簽失敗的不寫入；不存完整 payload，30 天後清除 |
| `maintainer_worker_state` | 全域排程（單列） | `next_installation_sync_at`（installation 同步的排程兼 row lease）、`last_installation_sync_at`、`last_error` |
| `maintainer_jobs` | 工作佇列 | `kind`（`reconcile_pull`、`request_reviewer`、`remove_reviewer_request`）、`dedupe_key`（排隊中唯一）、`state`、`attempts`、`run_after`、`lease_until`、`last_error`（只存錯誤代碼） |
| `maintainer_pull_requests` | PR 鏡像與衍生狀態 | `head_sha`、`head_observed_at`、`is_draft`、`is_fork`、`author_github_id`、`author_login`、`author_association`、`mergeable`、`mergeable_state`、`labels`、`attention_reasons`、`queue_state`、`queue_reasons`、`migration_reasons`（佇列提早停下時仍保留遷移問題，重新推導不必再打 GitHub）、`recheck_at`、`paused`、`synced_at` |
| `maintainer_pull_files` | 最新 head 的檔案清單 | `path`、`previous_path`、`status`、`additions`、`deletions` |
| `maintainer_checks` | head SHA 的檢查結果 | `source`（check run 或 commit status）、`name`、`app_key`（check run 的 app 數字 ID；commit status 為空字串）、`app_slug`、`status`、`conclusion`、`check_suite_id`、`completed_at` |
| `maintainer_reviews` | GitHub review 鏡像 | `github_review_id`、`reviewer_github_id`、`reviewer_login`、`reviewer_type`、`reviewer_association`、`state`、`commit_id`、`submitted_at` |

**062（認領與歸屬）：**

| 物件 | 用途 | 重點欄位 |
| --- | --- | --- |
| `maintainer_repositories` 新增欄位 | repo 的歸屬 | `guild_key`（負責的公會；空值＝沒有歸屬）、`scope_kind`（`module` 模組／`skill_book` 技能書；空值＝未分類）、`open_to_guilds`（沒有歸屬時，是否開放任何公會長認領；預設否）。有公會時不能同時開放 |
| `maintainer_ownership_changes` | 歸屬的異動紀錄（只新增） | `guild_key`、`scope_kind`、`open_to_guilds`、`source`（`admin` 管理員指定／`adopted` 公會長審完後歸入）、`changed_by_admin` 或 `changed_by_user`、`pull_id`（歸入時是哪一張 PR）、`reason` |
| `maintainer_eligible_reviewers`（檢視表） | 誰能審哪個 repo | `repository_id`、`user_id`、`github_user_id`、`github_login`、`acting_as`（`admin`／`guild_leader`）、`guild_key`。由管理員、公會長任命、公會成員資格與 GitHub 連結即時推導，不存資料 |
| `maintainer_review_claims` | 認領（軟鎖） | `reviewer_user_id`、`reviewer_github_id`、`reviewer_login`（快照，顯示與 requested reviewer 用）、`acting_as`、`guild_key`（公會長代表哪個公會）、`claimed_by_admin` 或 `claimed_by_user`、`assignment`（`self`／`assigned`；指派時要寫理由）、`head_sha`、`expires_at`（空值＝不會到期）、`state`（`active`／`released`／`expired`／`completed`）、`end_reason`（`self_released`／`admin_released`／`pull_closed`／`reviewer_not_eligible`／`review_submitted`）、`github_request_state`。每張 PR 同時只有一個有效認領 |
| `maintainer_pull_requests.requested_reviewers` | GitHub 上目前的 requested reviewer | 只供顯示 |

後台操作（認領、指派、釋放、指定歸屬、改設定、暫停、重新同步）沿用管理 API 的 `adminCommand()`：檢查 idempotency key、在交易內重新確認管理員仍有效、用 `platform_admin_receipts` 重播；同一個交易內用 `audit()` 寫 `platform_admin_audit`（含理由與前後狀態）。公會長頁的認領與放棄沿用會員端的 `command()`（idempotency key 存在 `command_receipts`），認領列本身記下是誰按的。要改的列以 `If-Match` 帶 `aggregate_version`。交易裡不等 GitHub 回應：先記下意圖，由維護 Worker 呼叫，再用另一個交易記結果（比照 039／040 的 pending 列）。

**認領是審核人之間的協調，不是任務認領。** [agent-development-guide](../development/agent-development-guide.md) 規定「平台不另造一份認領狀態」，指的是程式任務；任務仍以 GitHub Issue／PR 為準。審核認領只讓公會長與管理員之間不要重工（Ted，2026-10-01），不算貢獻或審核證據，審核仍以 GitHub 上的 review 為準。三個開關都開時（App 的 Pull requests write、maintainer Worker 的 `GITHUB_MAINTAINER_WRITES=requested_reviewers`、儲存庫設定 `request_reviewers`），認領會同步成 GitHub requested reviewer；預設都關。

## 7. 審核流程與狀態

```text
PR 開啟／有新 commit／轉為 ready
  → reconcile：讀 PR、files、reviews、checks → 注意事項 → 狀態
  → draft：不進佇列
  → CI 沒跑、失敗、衝突、migration 撞號：「待作者」並寫明原因
  → 目標不是預設分支：「待決定」
  → CI 綠：進「待審」，等多久都不會自動處理
      ├─ 公會長或管理員按「我來審」，或管理員「指派給…」
      │     ├─ 在 GitHub 送 APPROVE → 已核准
      │     ├─ 送 REQUEST_CHANGES → 待作者
      │     └─ 放棄認領，或不再符合資格 → 回到待審
      └─ 有效核准（§5）→ 已核准；合併由有寫入權的人在 GitHub 操作，或階段 2 由人按按鈕
  → 作者 push 新 commit：舊核准不算目前這一版，重新 reconcile
```

| 狀態 | 條件（一律以目前 head SHA 判斷） | 分頁 |
| --- | --- | --- |
| `draft` | PR 是 draft | 不列入 |
| `waiting_ci` | 必要檢查尚未完成；或 head 更新不到 15 分鐘、檢查還沒出現 | 等 CI |
| `ci_not_run` | 超過 15 分鐘仍沒有 `verify`（fork PR 多半在等維護者核准 workflow），或檢查結果是 `action_required` | 待作者 |
| `needs_author` | CI 失敗、衝突、migration 撞號，或有未解除的「要求修改」 | 待作者 |
| `needs_decision` | 目標分支不是預設分支 | 待決定 |
| `awaiting_review` | CI 綠，沒有有效核准，也沒有人認領 | 待審（等最久的排最前面） |
| `in_review` | 有人認領 | 審核中 |
| `ready` | 有效核准，而且其他條件都過 | 已核准 |
| `paused` | 人工暫停、有暫停標籤，或 repo 模式為 `off` | 已暫停 |
| `merged`／`closed` | — | 已完成 |

**會擋住 PR 的「要求修改」：** 只算符合資格的公會長或管理員，以及 GitHub 上 `OWNER`／`MEMBER`／`COLLABORATOR` 的 review；路人無法用 REQUEST_CHANGES 卡住 PR。

**注意事項（不分級）：** 路徑與大小只用來提醒審核的人，不決定誰能審，也不改變狀態。規則是純函式（`modules/repo-maintainer/policy.ts`，有版本號），`freedom-platform` 用下列規則，其他 repo 先只看 `.github/**`、`AGENTS.md`、`CONTRIBUTING.md`、`SECURITY.md` 與授權檔：

| 代碼 | 什麼時候出現 |
| --- | --- |
| `sensitive` | `freedom.project.yaml` 宣告的 `sensitive_paths`：`freedom.project.yaml`、`.github/**`、`SECURITY.md`、`LICENSE*`、`site/assets/brand/**` |
| `verification` | 會改變驗證方式的檔案：`package.json`、`package-lock.json`、`.tool-versions`、`tsconfig*.json`、`playwright.config.*`、`scripts/**`、`docs/platform-plan/verification/verify_revision.py`、`docs/platform-plan/execution/tools/**`、`repositories.lock.json`、`.npmrc`、`.gitattributes`、`.gitmodules`。PR 的 CI 跑的是 PR 自己那一版的 workflow 與 scripts，改到這些檔案的 PR 可以讓 `verify` 假綠（R-SKL-08） |
| `data_deploy` | `migrations/**`、`deploy/**`、`wrangler*.jsonc`、`compose.yaml`、`packages/db/**` |
| `authority` | 登入、權限與管理 API：`apps/platform-api/src/{worker,env,readiness,admin-sync-worker,maintainer-worker}.ts`、`routes/admin.ts`、`modules/{platform-admin,identity-membership,github-social,development-access,catalog-commerce,repo-maintainer}/**` |
| `contract` | `AGENTS.md`、`**/AGENTS.md`、`CONTRIBUTING.md`、`contracts/**`、`docs/platform-plan/contracts/**` |
| `maintainer` | `wrangler.maintainer.jsonc` |
| `test_removed` | 刪除測試檔，或把測試檔改名到測試位置以外 |
| `package_markdown`、`brand`、`svg`、`docs_code` | `packages/` 裡會被編進執行期文字的 Markdown、品牌目錄的圖、SVG、文件目錄裡的程式 |
| `size_large`、`size_huge` | 超過 20 個檔或 800 行；超過 60 個檔或 3000 行（建議作者拆小）。產生檔不計 |
| `changed_files_truncated` | GitHub 沒有列出全部變更檔案 |

首次貢獻、fork、Bot 不另寫成注意事項，清單上的標記已經顯示。

## 8. 歸屬與審核資格

**單位是 repo。** 在這個專案裡，模組與技能書各自是一個 repo（AGENTS.md：「本 repo 的維護者負責……這個模組」）。所以歸屬記在 `maintainer_repositories`：屬於哪個公會，類型是模組、技能書或未分類。

| repo 的歸屬 | 誰能審 | 審完之後 |
| --- | --- | --- |
| 屬於某公會 | 該公會的現任公會長、所有管理員 | 不變 |
| 沒有歸屬、開放公會長認領 | 任何現任公會長、所有管理員 | 公會長透過「我來審」審完（送出 APPROVE 或 REQUEST_CHANGES），repo 就歸到他認領時選的公會；管理員審完不會改歸屬 |
| 沒有歸屬、只限管理員（新 repo 的預設） | 所有管理員 | 管理員可以指定歸屬 |

- **新 repo 預設只限管理員。** 這樣新裝的中央 repo 不會因為某位公會長先審了一張 PR，就整個歸到他的公會。要讓公會長自行認領，管理員把 repo 設成「開放公會長認領」。這是設計時的安全預設，Ted 可以改（§15）。
- **管理員指定歸屬：** 在 repo 設定或 PR 詳情按「變更歸屬…」，選公會（或只限管理員／開放認領）與類型，寫理由。會套用到整個 repo，留下異動紀錄與稽核。
- **歸入只發生在認領完成時。** 沒有按「我來審」直接在 GitHub 審的公會長，核准一樣算數，但不改歸屬（同時是多個公會的公會長時，系統無從判斷要歸到哪裡）。兩位不同公會的公會長同時審同一個開放 repo 的不同 PR，先完成的那位歸入，另一位的認領在下一次收尾時因不再符合資格而釋放。
- **資格即時計算。** 公會長卸任、離開公會、帳號停用、改連另一個 GitHub 帳號，或 repo 改歸別的公會，他的認領會在下一分鐘被釋放（`reviewer_not_eligible`），核准也不再算數。
- **還沒做的：** `freedom-platform` 一個 repo 裡有多個模組；1c 先以 repo 為單位，路徑層級（類似 CODEOWNERS）等需要時再做。也可以之後依技能書目錄（`repository_url`、公會指定書）在指定歸屬時提供建議。

## 9. 合併

不做自動合併。PR 變成「已核准」之後，由在 GitHub 上有寫入權的人合併；階段 2 加上「合併」按鈕時，仍然要有人按。

### 9.1 和現有文件的關係

| 來源 | 內容 |
| --- | --- |
| 平台計畫 06 §3.3、11 | routine software PR 不等待真人 review；Grok 對抗式審查＋Claude 驗證＋自動 checks 形成 review evidence；Ted 只對付款、法律文件、對外正式 release 做 A4 |
| `AGENTS.md` | Agent 不自動 force-push、合併、發版；公會職稱不授予寫入權；保留真實 GitHub 作者、review 與 merged SHA |
| `freedom.project.yaml` | `minimum_human_reviews: 1`、`production_human_approval: true`（檔內註明這是意圖，不是已強制的 ruleset） |
| [co-creation](../development/co-creation.md) | 平台不另造 Issue 狀態，也不代替維護者指派權限或合併 |
| [guild-development-access](../development/guild-development-access.md) | 會員資格不授予合併、發版、部署；原維護者保留合併決定 |
| [05 整合契約](../platform-plan/05-integration-contracts.md) | CI 與 Agent 的結果只是證據（EvidenceRef），決定要由另一位已驗證的人簽署 |
| [07 決策與追溯](../platform-plan/07-decisions-risks-traceability.md) RQ-059、ADR-060、RQ-065 | 自然人審核人以具名、有範圍、可撤回的任命成立；AI review 不建立審核資格；Ted 可把任命權委派給公會長 |

新設計不和這些文件衝突：沒有自動合併；有效核准是真人在 GitHub 送出的 review，審核資格來自公會長任命（具名、限該公會、可撤回）與管理員名單；按鈕要有人按，而且預設用按的人自己的 GitHub 身分，GitHub 會照他原本的權限決定能不能推送或合併，merged_by 也是他本人。只有將來改成由 Maintainer App 代為合併時，才需要回頭修改上表的文件。

### 9.2 合併按鈕的檢查（階段 2）

按下「合併」前，一律重新向 GitHub 讀最新資料，不用快取。任何一項不成立就不合併，並顯示原因：

1. PR 仍 open、不是 draft，base 是預設分支，head SHA 等於畫面上顯示的 SHA。
2. `mergeable` 為 true，沒有衝突。
3. 必要檢查 `verify` 在 head SHA 上成功，而且確實由 GitHub Actions 產生，不接受同名的其他來源。
4. 沒有未解除的「要求修改」。
5. 有效核准（§5），而且核准對象就是目前的 head SHA。
6. 沒有 `hold`／`do-not-merge` 標籤。
7. Migration：新增檔的編號大於 base 最大編號、彼此不重複，而且沒有修改已存在的 migration。

**Ruleset 的配合：** 必要核准數設 0（平台的有效核准由審核中心判斷，GitHub 只強制 PR 與 `verify`）；Maintainer App 不列在 bypass 名單。

## 10. AI 按鈕（階段 2）

**只有人按才跑，用按的人自己的訂閱。** 平台不保存模型金鑰，也不替大家付模型費用。候選的按鈕：

| 按鈕 | 做什麼 |
| --- | --- |
| 讓 AI 修 | 依審核意見、CI 失敗或衝突修改，推到這張 PR 的分支 |
| 讓 AI 合併 | 跑 §9.2 的檢查，通過才合併 |
| 把 Issue 做成 PR | 依 Issue 開分支、實作、開 PR |

**候選機制（還沒決定，§15）：**

| 機制 | 怎麼運作 | 好處 | 要確認的事 |
| --- | --- | --- | --- |
| 本機 CLI 交接（建議先做） | 平台產生一份任務包（repo、分支、PR／Issue、head SHA、CI 結果、注意事項、AGENTS 的規則與驗證命令），按的人用自己的 Claude Code、Codex CLI 或 grok CLI 在本機執行；平台之後從 GitHub 同步結果 | 用各人自己的訂閱與 GitHub 權限；commit、PR、merged_by 都是本人；平台不需要任何新的寫入權限 | 任務包的格式；本機需要能跑測試的環境 |
| Codex cloud（ChatGPT 方案） | 在 PR 或 Issue 留言 `@codex …`，由 Codex 在雲端處理 | 不需要本機環境 | 用會員 App 以本人身分代發留言能不能觸發；用誰的方案額度；結果由 `chatgpt-codex-connector[bot]` 送出 |
| GitHub Copilot coding agent | 把 Issue 指派給 Copilot，由它開 PR | 原生支援「Issue 做成 PR」 | org 要有 Copilot 並開啟政策；費用記在 org，不是個人訂閱 |

不管哪一種，AI 的結果都只是一般的 commit 與 PR，要照常經過 CI 與公會長或管理員的審核；AI 不送 APPROVE，也不能代替真人核准。PR、Issue 內容一律當成資料，不能改變設定、權限或要求讀取秘密（AGENTS.md）。

**個人訂閱的範圍：** 個人訂閱是給本人用的，不能拿來當網站共用的模型額度。本機 CLI 交接正好符合這點：每個人用自己的額度做自己按下的工作。

**以後如果要平台自己跑：** 就要改用 API 計費，並由程式強制每月上限。2026-09-30 查到的官方價格（每百萬 tokens，輸入／輸出）：Claude Opus 5 $5／$25、Sonnet 5 $2／$10、Haiku 4.5 $1／$5；xAI `grok-4.7` $2.00／$6.00（prompt 達 20 萬 tokens 時整筆改收 $4／$12，推理 tokens 以輸出價計費）。以一次「3 萬輸入＋5 千輸出」估算，Opus 5 約 $0.28、Sonnet 5 約 $0.11、Grok 4.7 約 $0.09–0.15；這只是試算，不是實測。

## 11. 畫面

**後台（`/admin` → 專案維護 → PR 審核）：** 只有管理員看得到。畫面照 `AdminAuthorClaims.tsx` 的寫法：元件自己讀資料，用序號丟掉過期的回應；操作走 `AdminPanel` 的 `mutate()`，帶 `If-Match` 與 idempotency key；錯誤直接顯示伺服器回的 `detail`。

- **頂部摘要：** 待審、審核中、等 CI、待作者、待決定、已核准的數量；各 repo 目前模式與歸屬。
- **分頁：** 待審（等最久的在前）、審核中、我認領的、等 CI、待作者、待決定、已核准、已暫停、已完成。另可依 repo 或公會篩選。
- **每一列：** repo＋編號＋標題；作者（首次貢獻、fork、Bot 標記）；佇列狀態與「下一步」（例如「編號 048 已存在於 main，請改用 063 或之後的編號」）；歸屬（公會、開放認領）；認領人；CI。
- **詳情：** 注意事項（附路徑）；檔案清單（各自的注意事項）；檢查結果；審核時間軸（每筆標 SHA，標出有效核准、不算有效核准、舊提交）；歸屬與最近的異動。
- **操作（小型次要按鈕，依 [DESIGN.md](../../DESIGN.md)；都放在詳情裡）：** 我來審、指派給…（只列符合資格的人）、放棄認領、變更歸屬…、到 GitHub 審查、暫停／恢復、重新同步。
- **審核人：** 唯讀。列出每位管理員能不能審（沒有同 email 的會員、email 未驗證、未連結 GitHub）、每個公會的公會長與 GitHub 連結、各公會負責的 repo，以及開放認領與只限管理員的 repo。
- **設定（每次修改都要寫理由，並留下稽核紀錄）：** repo 模式、必要檢查、CI 等待時間、暫停標籤、認領時效（空白＝不自動釋放）、requested reviewer；歸屬另外儲存。

**公會長頁（會員端 → 公會管理 → PR 審核）：** 只有現任公會長看得到。分頁：待審、審核中、我認領的、已核准、全部未完成。列表與詳情和後台相同，只少了管理操作；操作只有「我來審」（同時是多個公會的公會長時，認領開放 repo 要選審完歸到哪個公會）、「放棄認領」和「到 GitHub 審查」。沒有連結 GitHub 時顯示原因，不顯示「我來審」。

**手機：** 列表改成卡片，操作收進詳情。審核本身在 GitHub 的 Files changed 頁完成；平台負責分派、提醒和說明。

## 12. GitHub 端設定（階段 0，Ted 手動）

1. **建立兩個 GitHub App**（staging、production），權限與事件照 §5 的「階段 1」欄（全部唯讀），設為私有（Only on this account）。Webhook URL 分別是 `https://staging.freetwai.com/api/v1/maintainer/github/webhook`、`https://freetwai.com/api/v1/maintainer/github/webhook`；secret 隨機產生、至少 32 字元。Production 先只裝在 `freedom-platform`；staging 裝在一個專用測試 repo（建議 `FreeTWAI-AI/maintainer-sandbox`）。
2. **放憑證：** GitHub 下載的私鑰是 PKCS#1（`BEGIN RSA PRIVATE KEY`），Workers 的 Web Crypto 只能匯入 PKCS#8，先轉換：`openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`；程式遇到 PKCS#1 會直接拒絕並說明。私鑰用 `wrangler secret put GITHUB_MAINTAINER_PRIVATE_KEY --config <private overlay> --env <env>` 只給 maintainer Worker；webhook secret 給 platform Worker。都不進 repo、不當 `--var`；轉換後的檔案用完就刪。
3. **`main` ruleset：** 禁止刪除與 force push；必須走 PR；required status check `verify`，來源鎖 GitHub Actions；有新 push 時舊核准失效；必要核准數 0；bypass 只給 org admin，不給 Maintainer App。
4. **之後同時合併變多時：** 啟用 merge queue，`verify.yml` 加上 `merge_group` 觸發。
5. **審核資格的前置：** 要在後台認領給自己，管理員帳號要對到 email 已驗證、而且連結了 GitHub 的會員帳號（可在會員登入頁用「忘記密碼」重設一次密碼來驗證 email）；公會長要在會員資料連結 GitHub。

## 13. 分階段交付

每個階段是一份 grok-4.7 工作：照工作單實作、跑指定驗證、在本機 commit。Claude 寫工作單、獨立重跑驗證、審查 diff 並在瀏覽器檢查畫面；要不要合併、部署，都由 Ted 決定。

| 階段 | 內容 | 誰做 | 狀態／出口條件 |
| --- | --- | --- | --- |
| 0 | 兩個 GitHub App、ruleset、測試 repo | Ted（可提供逐步清單） | App 收到 ping；ruleset 生效 |
| 1a | 觀察：migration 061、webhook、維護 Worker（installation 同步、補查、reconcile、row lease、請求預算）、狀態推導、管理 API | grok-4.7 | 已完成（PR #73） |
| 1b | 認領、指派、釋放（062；可選的 requested reviewer，預設不寫 GitHub）、後台「PR 審核」分頁 | grok-4.7 | 已完成（PR #73） |
| 1c | 依公會分工：歸屬、資格檢視表、公會長的審核頁、審完歸入；拿掉風險分級、SLA 與預設到期 | grok-4.7 | 已完成（PR #73）；出口要等階段 0：Staging 上公會長與管理員各自看得到正確的範圍與狀態 |
| 2 | 按鈕：任務包（讓 AI 修、把 Issue 做成 PR）、合併按鈕與 §9.2 的檢查；Issue 也列進審核中心 | grok-4.7 | Ted 先決定 §15 的機制與誰能按 |
| 之後 | 路徑層級的模組歸屬、依技能書目錄建議歸屬、通知 | 另案 | — |

**Staging 驗收劇本（測試 repo）：** 只改文件、一般程式、新增 migration、改 `verify.yml`（注意事項要列出）、fork PR、核准後再 push（舊核准不算）、CI 失敗、migration 撞號、目標不是預設分支；公會長審自己公會的 repo、看不到別的公會；開放 repo 審完歸入；管理員改歸屬後原公會長的認領被釋放。

## 14. 測試

- **Runtime（`tests/runtime`，各自建 schema、封鎖真網路、注入 fetcher）：** webhook 驗簽（正確、錯誤、缺少、重送）、去重、允許清單、全站中介層的例外只放行那一個路徑；注意事項（表格驅動，含 #46 的 38 個檔案：待作者，原因包含衝突與 migration 撞號）；狀態推導；舊 SHA 的核准不算；資格檢視表（管理員、公會長、開放 repo、卸任與離開公會）；認領、指派、釋放、歸屬、歸入與競爭；API 權限（非管理員、非公會長、CSRF、idempotency、`If-Match`）。
- **Worker（`tests/worker`）：** 用真的 dry-run bundle 打 webhook 路由；maintainer Worker 的 `scheduled` 以 outbound stub 模擬 `api.github.com`；確認 token 不進 log、pool 一定關閉。
- **E2E（Playwright，匯入 `./fixtures.js`）：** 後台的分頁、認領與釋放、歸屬、審核人；公會長頁的範圍、認領（含選公會）、放棄；手機寬度與三種主題。

## 15. 需要 Ted 決定

**已決定（2026-10-01）：**

- 公會長預設只審自己公會的模組與技能書；沒有歸屬的項目，公會長審完就歸到他的公會。
- 管理員可以審任何公會或模組的項目，審完後可以指定到合適的公會或模組。
- 不設風險分級與 SLA；上線的東西都是穩定的，PR 放著等人。
- 沒有人按按鈕就不自動處理；AI 一開始用各人自己的訂閱。
- 認領是公會長與管理員之間的協調，不是任務認領（取代舊版的第 8 項）。
- 舊版第 1、3、4、5、7、10 項（文件矛盾的解法、SLA、AI API 帳號與上限、owner PR 由 policy 合併、何時切到真合併、認領時效）隨上述決定不再需要。

**待決定：**

1. 新 repo 的預設：維持「只限管理員」（建議，避免中央 repo 被意外歸入），還是預設「開放公會長認領」？
2. 初始歸屬：哪些 repo 歸哪個公會（例如 `freedom-platform` 歸平台工程公會），哪些先開放公會長認領？
3. 階段 2 的機制：先做本機 CLI 交接（建議），還是也接 Codex cloud 或 Copilot coding agent？
4. 誰能按會寫 GitHub 的按鈕（修改推送、合併）：建議凡是能審這個項目的人都能按，但動作用他自己的 GitHub 身分執行，由 GitHub 依他原本的權限決定成不成功。若要改由 Maintainer App 代為合併，就要先改 AGENTS.md 等文件（§9.1）。
5. 是否建立 staging 測試 repo `FreeTWAI-AI/maintainer-sandbox`？
6. 什麼時候打開 requested reviewer 寫入：App 加 Pull requests write（org owner 要重新同意）、maintainer Worker 設 `GITHUB_MAINTAINER_WRITES=requested_reviewers`、各儲存庫打開 `request_reviewers`。
7. 要不要把 deploy 的 preflight 測試（`node --test deploy/cloudflare/test/*.test.mjs`）加進 CI？目前 CI 不跑，所以 migration 編號的 pin 過時也不會被發現（#70）。
8. 技能書維護者（後台「會長與維護者」任命的 `skill_book_maintainers`）要不要也算有效審核人，可以審該技能書 repo 的 PR？目前只有公會長與管理員算數。

## 16. 尚未驗證

- Codex cloud：會員 App 以本人身分代發的 `@codex` 留言能否觸發；由誰的 ChatGPT 方案付費；回覆的形式。
- GitHub Copilot coding agent 在這個 org 的方案與費用。
- 兩件只照 GitHub 文件、沒有實測的行為：installation token 帶 `repository_ids` 時的 422；PR 關閉後 requested reviewer 是否保留。

已查證（2026-09-30，官方文件）：

- Cloudflare：排程 Worker 單次 15 分鐘 wall time；`waitUntil` 在回應後最多 30 秒。
- GitHub：不自動重送失敗的 webhook；merge API 的 `sha` 與 head 不符時回 409；有新 commit 時舊核准會被標為 stale；requested reviewer 送出 review 後就不再是 requested reviewer；merge queue 可用於 org 的公開 repo，但 workflow 必須支援 `merge_group`。
- Codex code review（ChatGPT 方案）：可在 Codex 設定對 repo 開「Automatic review」或留言 `@codex review`，review 由 `chatgpt-codex-connector[bot]` 送出；API key 方案沒有這項雲端功能。
- xAI：API 與訂閱分開計費；`grok-4.7` 價格與推理計費如 §10。
