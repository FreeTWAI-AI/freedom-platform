# PR／Issue 審核中心（Freedom Maintainer）設計

> 設計稿，2026-09-30，對照 main `4d8eee1`。尚未實作、未部署；Maintainer GitHub App、`main` ruleset、高風險路徑的必要審核規則都還沒建立。本文的「採用」只代表設計決定，不代表功能已上線；所有測試在實跑前都是 `not_run`。

**一句話：人先審；時間到了還沒人審，才交給 AI；能不能合併，由寫在程式裡、有版本號的規則決定；所有審核與合併事實都留在 GitHub。**

## 1. 為什麼要做

以下是 2026-09-30 從程式碼與 GitHub 讀到的現況：

- `main` 沒有 branch protection，也沒有 ruleset（`gh api repos/FreeTWAI-AI/freedom-platform/branches/main/protection` 回 404）。`verify` 沒過一樣能合併；[repository-integration](../development/repository-integration.md) 也寫明中央 ruleset 尚未配置。
- 外部 PR 的 CI 可能根本沒跑。例：#46 來自 fork（首次貢獻者），38 個檔、+1781／−180，`statusCheckRollup` 是空的、與 main 衝突，新增的 `048_agent_shops.sql`、`049_commerce_distribution.sql` 和 main 既有的 048／049 撞號。最後由維護者另開 #61，改成 055／056、補修後合併（2026-09-30）。這正是審核中心要提早標出來的情況。
- 平台已經能同步 Issue／PR 的標題與狀態（#59，`github_items`），但沒有 head SHA、CI 結果、review 資料，也沒有 webhook。會員用的 GitHub App 只有 `starring`／`issues` 寫入，webhook 關閉，私鑰建立後就丟棄（`migrations/019_github_app_setup.sql`）。
- 程式裡沒有 App JWT，也沒有 installation token。會員 App 的 manifest 檢查只接受 `starring`／`metadata`／`issues` 三種權限，全平台也只允許一個 App（`modules/github-social/setup.ts`），不能直接擴權來用。
- 沒有任何 webhook 接收端。全站中介層要求非 GET 請求帶允許的 Origin、內容是 JSON 且不超過 32 KiB（`apps/platform-api/src/platform-app.ts`），GitHub 的投遞會被擋下。
- 管理員只有 `super_admin` 一種角色（`migrations/011_platform_admin.sql` 的 CHECK）；[member-toolkit](../development/member-toolkit.md) 也要求不另造有限權限的管理角色。
- 程式裡沒有任何 LLM 呼叫、Queue、Workflow 或 Durable Object。
- 幾份文件對「誰能合併」說法不一致（見 §9.1）。

## 2. 範圍

**做：**

- 後台「PR／Issue 審核中心」：跨 repo 的待審清單、認領、SLA 倒數、CI 狀態、風險分級、「為什麼還不能合併」的逐項說明。
- AI 審核：人工按鈕＋逾時備援。沿用 [06 §3.3](../platform-plan/06-delivery-plan.md) 的 Grok 對抗式審查＋Claude 驗證；AI 只發 COMMENT，不發 APPROVE。
- 合併規則（policy gate）：先乾跑；Ted 決定後，才對低風險 PR 真的合併。
- Issue 分流：人工分類為主，AI 只產生建議，不自動留言。

**不做：**

- AI 自己改程式、開 PR（修復模式，另案；見 §13 階段 5）。
- 部署。合併到 `main` 不等於正式 release；production 仍走既有 release 流程與 Ted 的發布類 A4（06 §3.3、ADR-019）。
- 用 AI 或 bot 冒充真人核准。
- 讓 Issue／PR 內容改變任何設定或權限。

## 3. 設計原則

1. **GitHub 是事實來源。** 平台只保存索引、衍生狀態、決策與稽核紀錄；review、合併、merged SHA 以 GitHub 為準（AGENTS.md、[agent-development-guide](../development/agent-development-guide.md)）。
2. **一切綁在 head SHA。** 審核、CI、AI 結果、合併決策都記錄對應的 commit；作者一 push，舊結果全部失效。
3. **AI 給意見，程式做決定。** Policy 只讀 AI 輸出中的列舉值（`pass`／`concerns`／`blocking`），不解析自由文字；AI 不能改規則，也不能單獨放行高風險修改。
4. **能寫 GitHub 的鑰匙不放在對外的 Worker。** 公開網站只拿 webhook secret；Maintainer App 私鑰只在沒有對外路由的維護 Worker（比照 `admin-sync-worker`）。
5. **觀察 → 建議 → 乾跑 → 真合併。** 每一步都有開關，可以隨時退回上一步。
6. **v1 不新增雲端產品。** 只用現有 Worker、cron、Hyperdrive PostgreSQL 與 row lease（#59 的做法）；Queues／Workflows／Sandbox 等到真的有需要才加。
7. **失敗時停下，不猜。** 資料讀不到、預算用完、模型出錯，一律留在人工佇列並說明原因，不自動放行。

## 4. 架構

```text
GitHub（PR／Review／Check／Issue 事件）
   │ webhook（X-Hub-Signature-256 驗簽）
   ▼
freedom-platform Worker（既有，對外）
   ├─ POST /api/v1/maintainer/github/webhook
   │     驗簽 → 以 X-GitHub-Delivery 去重 → 只記錄＋排工作（不呼叫 GitHub，快速回 202）
   └─ /admin 審核中心 API 與畫面（Access JWT＋管理員名單＋CSRF）
   │
   ▼
PostgreSQL（同一個 caching-disabled Hyperdrive）
   maintainer_*：repo 設定、事件、PR 鏡像、檢查、審核、認領、AI 審核、決策、工作佇列
   ▲
   │ 每分鐘 cron；工作以單一 UPDATE row lease 認領
freedom-maintainer Worker（新，沒有路由）
   ├─ 持有 Maintainer App 私鑰；每個工作換短效、依用途降權的 installation token
   ├─ reconcile：讀 PR、files、reviews、checks → 重算風險與狀態
   ├─ SLA：逾時 → 排 AI 審核
   ├─ AI 審核：呼叫 xAI／Anthropic API → 以 bot 身分發一則 COMMENT review
   └─ policy gate：重讀 GitHub 最新狀態 → 乾跑紀錄／帶 sha 合併
```

| | freedom-platform（既有、對外） | freedom-maintainer（新、無路由） |
| --- | --- | --- |
| 觸發 | HTTP | 每分鐘 cron |
| 新增職責 | 收 webhook；審核中心 API 與畫面 | 同步 GitHub、SLA、AI 審核、policy、合併 |
| GitHub 憑證 | 只有 `GITHUB_MAINTAINER_WEBHOOK_SECRET`（選填；沒設時 webhook 回 503 `maintainer_webhook_unavailable`，不影響全站） | `GITHUB_MAINTAINER_APP_ID`、`GITHUB_MAINTAINER_PRIVATE_KEY`（PKCS#8） |
| AI 憑證 | 無 | `XAI_API_KEY`、`ANTHROPIC_API_KEY`（選填；沒設就沒有 AI 審核） |
| 設定檔 | `wrangler.jsonc` | 新增 `wrangler.maintainer.jsonc`，比照 `wrangler.admin-sync.jsonc`：只 export `scheduled`，無 routes、無 workers.dev／preview URL |

**為什麼 v1 不用 Queues／Workflows：** 目前沒有 open PR、只有 3 張 open Issue；cron＋row lease 已經在 #59 驗證過；平台計畫也寫「Server 上不必常駐一隻 LLM agent」（08）。Cloudflare 的排程 Worker 單次最長 15 分鐘 wall time（Paid 的 CPU 上限 30 秒，等模型回應不算 CPU），一次 AI 審核放得進去。之後若需要長時間等待外部事件，再把 `maintainer_jobs` 的工作搬到 Workflows；資料表已經照步驟拆好。

**webhook 只是提示，GitHub API 才是事實。** Webhook 只觸發「重新同步某張 PR」。GitHub 不會自動重送失敗的 webhook，所以維護 Worker 每 30 分鐘另做一次全量補查（分頁讀完，沒有 100 筆上限），補回漏掉或延遲的事件。補查會重新同步這幾種 PR：新的、head 或 `updated_at` 變了的、已經不在 open 清單上的；必要檢查還在跑、或 GitHub 還沒算出能不能合併，而且超過 10 分鐘沒同步的；以及超過 6 小時沒同步的所有 open PR。CI 跑完不會改 PR 的 `updated_at`，漏掉的 check webhook 要靠後面兩條補回。

**Webhook 路由的邊界：**

- 路由登記在會員驗證中介層（`/api/v1/*`）之前，只認 `POST /api/v1/maintainer/github/webhook` 這一個精確路徑。全站中介層只對它跳過 Origin 與 32 KiB JSON 檢查，改由路由自己檢查 `Content-Type: application/json`、2 MiB 上限與三個 GitHub 標頭。
- 先驗簽（只用 CPU），通過後才碰資料庫。簽章錯誤只記一行 log、回 401，不寫資料庫，別人無法用假投遞灌滿資料表。
- 只存正規化後的提示（delivery ID、事件、repo 與 installation 的數字 ID、PR 編號或 head SHA）和原始內容的 sha256，不存 payload 本身，對齊 [05 整合契約](../platform-plan/05-integration-contracts.md) 的 WebhookInbox 規則。

**維護 Worker 的額度：** 每次 cron 最多 60 個 GitHub 請求、約 50 秒；installation token 每小時至少有 5,000 次額度，這樣每小時最多用 3,600 次。遇到 rate limit 就記下重置時間，該 installation 的工作延到那時再做。

## 5. 身分與權限

| 身分 | 是誰 | 能做什麼 | 憑證位置 |
| --- | --- | --- | --- |
| 會員 GitHub App（既有 `freedom-workshop-*`） | 會員 | Star、用自己的身分發 Issue | 不變，不擴權 |
| Freedom Maintainer App（新，staging／production 各一） | bot | 讀 PR／Issue／CI；發 AI 審核 COMMENT；認領時加 requested reviewer；階段 4 起才能合併 | 私鑰只在 maintainer Worker |
| Owner | Ted | 設定、repo 範圍與模式、預算、審核員名單、全域停用、高風險核准 | 既有 admin 身分＋GitHub `teddashh` |
| 審核員 | 管理員從「已驗證 GitHub 連結的會員」中指派；以 GitHub 數字 ID 為準，登入名只供顯示；每人設定可審的最高風險 | 在 GitHub 送出 review，核准依風險等級計入規則；本身是管理員的審核員，才能在後台認領 | 自己的 GitHub 帳號 |
| AI 審核者 | xAI／Anthropic 模型 | 只產生 COMMENT review | API key 只在 maintainer Worker |

**後台只給管理員，不新增角色。** 管理員目前都是 `super_admin`，文件也不允許另造有限權限的管理角色，所以所有管理員都能看審核中心、都能指派。「審核員」是一張指派名單（比照 `skill_book_maintainers`），只決定誰在 GitHub 上的核准算數，不是新的後台權限。不是管理員的審核員直接在 GitHub 上審。

**管理員怎麼對到 GitHub 帳號：** 沿用既有做法，`platform_admins.email` 對到同社群、同 email 的會員，再對到該會員已驗證的 `github_social_connections`（GitHub 數字 ID 全平台唯一，見 [github-identity-uniqueness](../development/github-identity-uniqueness.md)）。沒有連結 GitHub 的管理員可以看、可以指派別人，但不能認領給自己。

**Maintainer App 和會員 App 分開：** Maintainer App 設為私有（只能裝在 FreeTWAI-AI），維護 Worker 也會忽略其他帳號的 installation。會員 App 的規則（不留私鑰、不擴權、webhook 關閉）不變。

**Maintainer App 權限依階段開放：**

| 權限 | 階段 1–3 | 階段 4（真合併） |
| --- | --- | --- |
| Metadata | Read | Read |
| Pull requests | Read & write（發 AI 審核、加 requested reviewer） | Read & write |
| Issues | Read & write（標籤；v1 不自動留言） | Read & write |
| Checks、Commit statuses | Read | Read |
| Actions | 階段 3 起 Read（確認 `verify` 來自 `.github/workflows/verify.yml`） | Read |
| Contents | Read（讀 base branch 的 migration 清單、AGENTS.md、檔案內容） | **Read & write**（合併需要） |

事件：Pull request、Pull request review、Check suite、Check run、Status、Issues、Issue comment（installation 事件自動送出）。安裝時選「Only select repositories」。之後替 App 增加權限，GitHub 會要求 org owner 重新同意，這一步就是 Ted 的人工停點。

**Installation token 降權：** 每個工作呼叫 `POST /app/installations/{id}/access_tokens` 時，都帶 `repositories` 與 `permissions`，只取這一步需要的權限。例如同步只拿 read，發 AI 審核只加 `pull_requests: write`，只有合併那一步才拿 `contents: write`。

## 6. 資料模型

每個階段各一支純新增 migration。main 目前最新的是 056（#61），本案從 **057** 開始；編號以合併當時為準，合併前再確認一次。規則照舊：只新增、不改已套用的 migration、不使用 preflight 禁用的語法，背景工作用單一 UPDATE row lease，不用 session advisory lock。GitHub 的 repo、使用者、review 一律存數字 ID（文字欄位、`^[0-9]+$`，比照 053），名稱只供顯示。

**階段 1a（057）：**

| 表 | 用途 | 重點欄位 |
| --- | --- | --- |
| `maintainer_repositories` | installation 裡的 repo 與每個 repo 的模式 | `github_repository_id`（改名也不變）、`installation_id`、`full_name`（顯示用，會更新）、`default_branch`、`installation_state`、`mode`（`off`／`observe`／`ai_review`／`merge_dry_run`／`merge`，新 repo 預設 `observe`）、`settings` jsonb（SLA、CI 等待時間；之後加 AI 備援、合併方式、每日上限）、`next_sweep_at`（補查排程兼 row lease）、`rate_limited_until` |
| `maintainer_webhook_deliveries` | 去重與稽核 | `delivery_id` PK、`event`、`action`、`installation_id`、`github_repository_id`、`target_number` 或 `head_sha`、`outcome`（`queued`／`ignored`）、`payload_sha256`；驗簽失敗的不寫入；不存完整 payload，30 天後清除 |
| `maintainer_worker_state` | 全域排程（單列） | `next_installation_sync_at`（installation 同步的排程兼 row lease）、`last_installation_sync_at`、`last_error` |
| `maintainer_jobs` | 工作佇列 | `kind`（階段 1a 只有 `reconcile_pull`；installation 同步用上一列的排程；之後加 `request_reviewer`、`ai_review`、`evaluate_policy`、`merge`）、`dedupe_key`（排隊中唯一）、`state`、`attempts`、`run_after`、`lease_until`、`last_error`（只存錯誤代碼） |
| `maintainer_pull_requests` | PR 鏡像與衍生狀態 | `head_sha`、`head_observed_at`、`is_draft`、`is_fork`、`author_github_id`、`author_login`、`author_association`、`mergeable`、`mergeable_state`、`labels`、`risk_class`、`risk_reasons`、`queue_state`、`queue_reasons`、`sla_due_at`、`recheck_at`、`paused`、`synced_at` |
| `maintainer_pull_files` | 最新 head 的檔案清單 | `path`、`previous_path`、`status`、`additions`、`deletions` |
| `maintainer_checks` | head SHA 的檢查結果 | `source`（check run 或 commit status）、`name`、`app_key`（check run 的 app 數字 ID；commit status 為空字串）、`app_slug`、`status`、`conclusion`、`check_suite_id`、`completed_at` |
| `maintainer_reviews` | GitHub review 鏡像 | `github_review_id`、`reviewer_github_id`、`reviewer_login`、`reviewer_type`、`reviewer_association`、`state`、`commit_id`、`submitted_at` |
| `maintainer_reviewers` | 管理員指派的審核員 | `github_user_id`、`github_login`、`user_id`（來源會員）、`max_risk`（`low`／`medium`／`high`）、`active`、`appointed_by`（管理員） |

**階段 1b（058）：** `maintainer_review_claims`（`reviewer_id`、`claimed_by_admin`、`head_sha`、`expires_at`、`state`、`release_reason`、`github_request_state`；每張 PR 同時只有一個有效認領）。

**階段 2：** `maintainer_ai_reviews`（`head_sha`、`provider`、`role`、`model`、`trigger`、`state`、`verdict`、`findings`、`input_tokens`、`output_tokens`、`cost_usd_micros`、`github_review_id`、`prompt_version`）、每月預算帳、`maintainer_issue_triage`（以既有 `github_items` 為清單來源；`state` 為 `new`／`triaged`／`needs_info`／`duplicate`／`declined`）。

**階段 3：** `maintainer_policy_decisions`（`head_sha`、`policy_version`、`mode`、`decision`、`reasons`、`executed_at`、`merge_commit_sha`、`execution_error`）。

後台操作（認領、釋放、指派審核員、改設定、重新同步）沿用管理 API 的 `adminCommand()`：檢查 idempotency key、在交易內重新確認管理員仍有效、用 `platform_admin_receipts` 重播；同一個交易內用 `audit()` 寫 `platform_admin_audit`（含理由與前後狀態）。要改的列以 `If-Match` 帶 `aggregate_version`。交易裡不等 GitHub 或模型回應：先記下意圖，由維護 Worker 呼叫，再用另一個交易記結果（比照 039／040 的 pending 列）。

**認領不另造一份權威狀態。** [agent-development-guide](../development/agent-development-guide.md) 規定「平台不另造一份認領狀態」。因此「我來審」會同時把審核員加成 GitHub requested reviewer；平台只多記一個到期時間，用來自動釋放。認領只是避免重工的軟鎖，不算貢獻或審核證據。

## 7. 審核流程與狀態

```text
PR 開啟／有新 commit／轉為 ready
  → reconcile：讀 PR、files、reviews、checks → 風險分級 → 狀態
  → draft：不進佇列
  → CI 沒跑、失敗、衝突、migration 撞號：「待作者」並寫明原因
  → CI 綠：進「待審」，開始 SLA 計時
      ├─ 管理員按「我來審」或「指派給…」→ GitHub requested reviewer＋認領期限
      │     ├─ 在 GitHub 送 APPROVE → 已核准
      │     ├─ 送 REQUEST_CHANGES → 待作者
      │     └─ 期限到仍沒送出 → 自動釋放，回到待審
      ├─ 任何人按「交給 AI 審」→ AI 雙審（僅供參考）
      └─ SLA 到期仍沒人審
            ├─ 該風險允許 AI 備援 → AI 雙審
            └─ 不允許 → 需要 Ted
  → policy gate：乾跑紀錄／合併／需要 Ted／阻擋
  → 作者 push 新 commit：該 PR 的審核、CI、AI 結果全部失效，重新 reconcile
```

| 狀態 | 條件（一律以目前 head SHA 判斷） | 後台分頁 |
| --- | --- | --- |
| `draft` | PR 是 draft | 不列入 |
| `waiting_ci` | 必要檢查尚未完成；或 head 更新不到 15 分鐘、檢查還沒出現 | 等 CI |
| `ci_not_run` | 超過 15 分鐘仍沒有 `verify`（fork PR 多半在等維護者核准 workflow），或檢查結果是 `action_required` | 待作者／需處理 |
| `needs_author` | CI 失敗、衝突、migration 撞號，或有未解除的「要求修改」 | 待作者 |
| `awaiting_review` | CI 綠，沒有有效審核，也沒有人認領 | 待審（依 SLA 排序） |
| `in_review` | 有人認領且未過期，或 AI 審核進行中 | 審核中 |
| `needs_owner` | 高風險；或 SLA 已過但不允許 AI 備援；或 AI 結果是 `concerns` | 需要 Ted |
| `ready` | 規則全部通過（乾跑模式下顯示「會合併」） | 可合併 |
| `paused` | 人工暫停、repo 模式為 `off`，或熔斷 | 已暫停 |
| `merged`／`closed` | — | 已完成 |

**SLA 預設（可在後台調整）：**

| 作者 | 低風險 | 中風險 | 高風險 |
| --- | --- | --- | --- |
| 外部與社群 | 24 小時後交 AI | 48 小時後提醒，AI 只做預審 | 不逾時，一律等 Ted |
| Owner 自己（`teddashh`，多半是 agent 寫的） | 立即交 AI | 立即交 AI | 立即交 AI 預審，合併仍由 Ted |

Owner 自己的 PR 沒有其他人會審，也不能自己核准自己，所以立即交給 AI；這也符合 06 §3.3「routine software PR 不等待真人 review」。

## 8. 風險分級

分級是純函式（`modules/repo-maintainer/policy.ts`），輸入檔案清單與 PR 資訊，輸出 `low`／`medium`／`high` 和理由；規則有版本號，決策紀錄會存下當時的版本。

**高風險（一律需要 Ted 在 GitHub 核准；由 ruleset 的路徑審核規則強制，見 §12）：**

- `freedom.project.yaml` 宣告的 `sensitive_paths`：`freedom.project.yaml`、`.github/**`、`SECURITY.md`、`LICENSE`、`site/assets/brand/**`。
- 會改變驗證方式的檔案：`package.json`、`package-lock.json`、`.tool-versions`、`tsconfig.json`、`playwright.config.ts`、`scripts/**`、`docs/platform-plan/verification/verify_revision.py`、`docs/platform-plan/execution/tools/**`（`npm run test:contracts` 會跑）、`repositories.lock.json`（`npm run test:repos` 會 checkout 並執行裡面列的 commit），以及 `.npmrc`、`.gitattributes`、`.gitmodules`（目前不存在，新增時能改套件來源、檔案處理或拉進外部程式碼）。PR 的 CI 跑的是 PR 自己那一版的 workflow 與 scripts，改到這些檔案的 PR 可以讓 `verify` 假綠（R-SKL-08）。
- 資料與部署：`migrations/**`、`deploy/**`、`wrangler*.jsonc`、`compose.yaml`、`packages/db/**`。
- 登入、權限、金流與憑證：`apps/platform-api/src/{worker,env,readiness,admin-sync-worker}.ts`、`apps/platform-api/src/routes/admin.ts`、`modules/{platform-admin,identity-membership,github-social,development-access,catalog-commerce}/**`。
- 協作規則與契約：`AGENTS.md`、`**/AGENTS.md`、`CONTRIBUTING.md`、`contracts/**`、`docs/platform-plan/contracts/**`。
- 維護系統自己：`modules/repo-maintainer/**`、`apps/platform-api/src/maintainer-worker.ts`、`wrangler.maintainer.jsonc`。
- 刪除任何測試檔，或把測試檔改名到測試位置以外（例如移出 `tests/**`，或 `*.test.*` 改成不是測試的檔名）。在測試位置之內改名不算。

**中風險：** 其他在 `apps/**`、`modules/**`、`packages/**`、`tests/**` 的新增與修改，以及沒有被其他規則涵蓋的路徑。`packages/**` 裡的 Markdown 也算中風險：`scripts/generate-runtime-text.mjs` 會把 `packages/shop-agent/*.md`、`packages/skill-upload-client/{SKILL,protocol}.md` 編進執行期文字。SVG、`brand` 目錄裡的圖片（例如 `apps/portal-web/public/brand/**`）、`docs/**` 裡的程式檔也算中風險。

**低風險：** 只改文件（`docs/**`，不含上面列出的契約、驗證工具與程式檔）、任何層級的 `README.md`、根目錄其他說明文件（`DESIGN.md`、`CHANGES-*.md`）、`brand` 目錄以外的點陣圖片。產生檔（`apps/platform-api/src/generated/runtime-text.ts`、file inventory JSON）本身不提高等級，由 CI 驗證它們與來源一致。

**升級規則：**

- 首次貢獻或非 org 成員的 fork PR（`author_association` 為 `FIRST_TIME_CONTRIBUTOR`／`FIRST_TIMER`／`NONE`）至少中風險。
- head 來自另一個 repo 的 PR（head repo 的 ID 和 base repo 不同，或 head repo 已刪除）至少中風險。repo 本身是上游的 fork、但 PR 來自同一個 repo 的分支，不算 fork PR。
- 超過 20 個檔或 800 行（不含產生檔）至少中風險；超過 60 個檔或 3000 行為高風險（太大，AI 不能代替人審）。平台最多讀前 1000 個變更檔案（GitHub 最多列 3000 個），列不完的 PR 直接算高風險。
- Bot 開的 PR：AI 結果不能取代人審。

其他 repo 先用保守預設：`.github/**` 高風險、文件低風險，其餘中風險；之後再依 repo 自己的 AGENTS 補規則。

**各等級的審核要求（初始值）：**

| 風險 | 有效審核 | AI 備援 | 可由 policy 合併 |
| --- | --- | --- | --- |
| 低 | 一位審核員核准，或 AI 雙審都 `pass` | 允許（SLA 到期後） | 階段 4 開啟後可以 |
| 中 | 一位審核員核准；owner 自己的 PR 另可用 AI 雙審 `pass`（需 Ted 開啟） | 只做預審，不取代人 | 有效審核後可以 |
| 高 | 可審高風險的審核員核准（初始只有 Ted） | 只做預審 | 不自動合併 |

有效核准的條件：審核員在名單內且仍有效、可審等級不低於 PR 的風險、review 狀態是 APPROVED、`commit_id` 等於目前 head SHA、審核員不是作者。會擋住 PR 的「要求修改」只算名單內審核員與 GitHub 上 `OWNER`／`MEMBER`／`COLLABORATOR` 的 review，路人無法用 REQUEST_CHANGES 卡住 PR。

## 9. 合併規則（policy gate）

### 9.1 先處理文件之間的矛盾

| 來源 | 內容 |
| --- | --- |
| 平台計畫 06 §3.3、11 | routine software PR 不等待真人 review；Grok 對抗式審查＋Claude 驗證＋自動 checks 形成 review evidence；Ted 只對付款、法律文件、對外正式 release 做 A4 |
| `AGENTS.md` | Agent 不自動 force-push、合併、發版 |
| `freedom.project.yaml` | `minimum_human_reviews: 1`、`production_human_approval: true`（檔內註明這是意圖，不是已強制的 ruleset） |
| [co-creation](../development/co-creation.md) | 平台不另造 Issue 狀態，也不代替維護者指派權限或合併 |
| [guild-development-access](../development/guild-development-access.md) | 會員資格不授予合併、發版、部署；原維護者保留合併決定 |
| [05 整合契約](../platform-plan/05-integration-contracts.md) | CI 與 Agent 的結果只是證據（EvidenceRef），決定要由另一位已驗證的人簽署 |

**建議的解法（需要 Ted 決定）：**

- 階段 1–3 符合現行所有文件：AI 只發 COMMENT、佇列狀態只是 GitHub 事實的衍生檢視、認領同步成 GitHub requested reviewer、合併只乾跑。需要改文件的只有階段 4（policy 合併、AI 雙審代替人審）；那一步的 PR 同時修改上表所有文件。
- 合併到 `main` 不是正式 release。Production 部署仍是 Ted 的發布類 A4，不因本案改變。
- `AGENTS.md` 的禁令繼續適用於「寫程式的 agent」：寫程式的 agent 永遠不合併自己的工作。只有 Maintainer policy gate 能自動合併；它是另一個身分，規則有版本號，由 owner 授權。階段 4 的 PR 把這段補進 `AGENTS.md`。
- `freedom.project.yaml` 的 `minimum_human_reviews` 改為依風險等級：高風險 1（Ted），中、低風險依本文 §8。

在 Ted 決定以前，系統只跑到乾跑（`merge_dry_run`）。

### 9.2 合併前逐項檢查

合併前一律重新向 GitHub 讀最新資料，不用快取。任何一項不成立就不合併，並記下原因代碼：

1. Repo 模式為 `merge`（乾跑模式只寫紀錄），全域開關未關，maintainer Worker 的 `FREEDOM_MAINTAINER_WRITES` 為 `on`。
2. PR 仍 open、不是 draft，base 是預設分支，head SHA 等於評估時的 SHA。
3. `mergeable` 為 true，沒有衝突。
4. 必要檢查 `verify` 在 head SHA 上成功，而且確實由 GitHub Actions 產生、來自 `.github/workflows/verify.yml`，不接受同名的其他來源。
5. 沒有未解除的真人 REQUEST_CHANGES。
6. 審核符合 §8 的風險要求，而且審核對象就是目前的 head SHA。
7. 沒有 `hold`／`do-not-merge` 標籤。
8. Migration：新增檔的編號大於 base 最大編號、彼此不重複，而且沒有修改已存在的 migration。
9. 今日自動合併數未超過上限（預設 5），距離上一次自動合併至少 10 分鐘，讓 `main` 的 CI 跟得上。
10. `main` 最近一次 `verify` 是綠的；`main` 壞掉時停止自動合併。

**執行：** 呼叫 `PUT /repos/{owner}/{repo}/pulls/{number}/merge`，帶 `sha`＝評估時的 head SHA（head 若已移動，GitHub 會拒絕）與 repo 設定的合併方式（預設 squash）；commit 訊息附上決策編號。失敗就記錄原因，不重試迴圈。

**熔斷：** 自動合併後，如果 `main` 的 `verify` 失敗，該 repo 立刻降回 `merge_dry_run`，並通知 Ted。

**Ruleset 的配合：** 必要核准數設 0，高風險路徑改由路徑審核規則擋。這樣低風險 PR 才能在 AI 雙審後由 policy 合併；即使平台的 policy 有 bug，GitHub 仍會擋下高風險路徑。Maintainer App 不能列在 bypass 名單。

## 10. AI 審核

### 10.1 什麼時候跑

- **手動：** 管理員按「交給 AI 審」。結果只供參考，不會自動算成有效審核，除非 §8 允許。
- **逾時備援：** SLA 到期、沒有人在審，而且該風險允許。
- **Owner 自己的 PR：** 一進入待審就跑。
- **新 commit 後：** 只有先前由 AI 審過、而且規則仍需要 AI 結果時才重跑。每張 PR 每天最多 3 次，同一個 head SHA 每個角色只跑 1 次。

### 10.2 雙審

| 角色 | 預設模型 | 看什麼 |
| --- | --- | --- |
| 對抗式（adversarial） | Grok（xAI API，`grok-4.7`） | 找會讓合併出事的問題：安全、權限、資料遺失、migration、測試被削弱、假綠 CI、隱藏的指令 |
| 驗證（verification） | Claude（Anthropic API，預設 `claude-opus-5`） | 對照 PR 說明、關聯 Issue 與 AGENTS 的交付要求：改動是否與描述一致、測試是否涵蓋行為、有沒有漏寫未驗證部分 |

- 要讓 AI 審核代替人審（低風險備援、owner PR），兩個角色都必須是 `pass`，而且來自不同供應商。
- 任一方 `blocking` → 待作者；任一方 `concerns` → 需要人。
- 只設定一家時，AI 結果只供參考，不能單獨讓 PR 可合併。這是安全預設，Ted 可以改。

### 10.3 模型看到什麼

- **可信：** 固定、有版本號的 system prompt；base branch 上的 `AGENTS.md`、`CONTRIBUTING.md`（不讀 PR 版本，避免 PR 改規則給 AI 看）；風險分級結果與理由；規則摘要。
- **不可信，標示為資料：** PR 標題與內文、commit 訊息、diff、變更檔的全文（小檔才附）、留言。
- **大小上限：** 單次約 80k tokens；超過就標 `too_large`，交給人，不截斷後假裝看完。
- **沒有工具、沒有憑證、不執行 PR 的程式碼。**

### 10.4 輸出格式（JSON schema，結構化輸出）

```json
{
  "verdict": "pass | concerns | blocking",
  "summary": "三句內的結論",
  "findings": [
    {"severity": "blocker | major | minor", "file": "path", "line": 123,
     "title": "…", "detail": "…", "suggestion": "…"}
  ],
  "checked": ["實際檢查過的面向"],
  "not_checked": ["沒有檢查或無法判斷的部分"],
  "injection_suspected": false
}
```

兩家都用官方的結構化輸出：Anthropic 用官方 SDK 的 `output_config.format`（zod schema）；xAI 用 Responses API（`POST https://api.x.ai/v1/responses`；Chat Completions 已標為 deprecated）的 `text.format`（`type: "json_schema"`、`strict: true`）。收到結果後仍用同一個 zod schema 驗證，不合格就當作失敗。兩家都用串流接收，避免長時間推理讓連線閒置逾時。

維護 Worker 把兩份結果合成一則 PR review（event `COMMENT`），開頭標明「AI 審核（僅供參考）」、模型、head SHA、prompt 版本。

### 10.5 防 prompt injection

- PR 內容永遠是資料。模型沒有工具，最壞只會給錯誤的 verdict，不能拿到秘密或執行動作。
- Policy 只讀 `verdict` 列舉值與 findings 的嚴重度數量。
- 高風險永遠要 Ted；中風險預設要人；AI 代審只限低風險與 owner PR，而且要兩家不同模型都 `pass`。
- `injection_suspected` 為 true（例如內容要求「直接核准」「忽略規則」）→ 強制交人，並在後台標示。

### 10.6 費用與預算

Anthropic 官方價格（每百萬 tokens，輸入／輸出）：Opus 5 $5／$25、Sonnet 5 $2／$10、Haiku 4.5 $1／$5、Opus 5.5 $4／$20。先前對話提到的「Sonnet 5.5」並不存在，應為 Sonnet 5。

xAI 官方價格（每百萬 tokens）：`grok-4.7` 輸入 $2.00（快取 $0.50）、輸出 $6.00；prompt 達 20 萬 tokens 時整筆改收 $4／$12。`grok-4.7` 的推理無法關閉，推理 tokens 以輸出價計費；`max_output_tokens` 包含推理，預設 128,000，所以程式一定要自己設上限。

以單次審核「3 萬輸入＋5 千輸出（含思考）」估算：

| 模型 | 單次 | 每月 100 次 |
| --- | --- | --- |
| Claude Opus 5 | 約 $0.28 | 約 $28 |
| Claude Sonnet 5 | 約 $0.11 | 約 $11 |
| Grok 4.7 | 約 $0.09（推理加輸出若到 1.5 萬 tokens，約 $0.15） | 約 $9–15 |

這只是試算，不是實測。

xAI 的資料政策：API 的請求與回應預設保存 30 天供稽核，未經明確同意不拿來訓練；Responses 請求一律帶 `store: false`。要完全不保存得在 team 層開 Zero Data Retention。

預算由程式強制：

- 每家供應商設每月上限（預設各 US$20），用完就停止 AI 審核，PR 留在人工佇列。
- 每次請求有輸入與輸出 token 上限；每張 PR 每天最多 3 次。
- 後台顯示本月已用與剩餘額度。

Cloudflare 方面，多一個每分鐘執行的 cron Worker，每月約 4.3 萬次，遠低於 Workers Paid 內含的 1,000 萬 requests。

### 10.7 訂閱制

平台自己的 AI 審核用 API 計費；個人訂閱不能當網站共用的模型額度。能用訂閱的，是已經整合在 GitHub 上、由廠商執行的官方審核機器人；平台不持有它們的憑證，只把它們當成**外部審核者**：同步它們留下的 review，確認 `commit_id` 等於目前 head 後，在後台與 AI 結果並列。以下查證日期為 2026-09-30：

| 來源 | 官方文件確認的事 | 在本設計的用法 |
| --- | --- | --- |
| Codex code review（ChatGPT 方案） | 在 Codex 設定對 repo 開「Automatic review」，或留言 `@codex review`；只標 P0／P1；review 由 `chatgpt-codex-connector[bot]` 發出；API key 方案沒有這項雲端功能 | 建議 Ted 對 `freedom-platform` 開自動審核，平台只負責同步。「bot 留言能否觸發」「用誰的方案額度」文件沒寫，不依賴 |
| GitHub Copilot code review | 可用 REST API 把 `copilot-pull-request-reviewer[bot]` 加為 reviewer；bot 發起時費用記在 org；org 要先在 Copilot 政策開啟 | 選用。org 有 Copilot 才考慮 |
| Claude Code GitHub Actions（Claude 訂閱） | 官方有 `claude setup-token` 的設定方式；但 Pro／Max 額度以一般個人使用為前提，組織共用時文件建議改用 API key | 不當作平台的審核來源 |
| Grok 訂閱（SuperGrok 等） | 訂閱額度涵蓋 Chat、Imagine、Voice、Build 等產品；API 另外用預付 credits 或月結計費；沒有找到讓訂閱拿來呼叫 API 的方案 | 平台的對抗式審核用 xAI API key（預付 credits）。grok CLI 屬於 Build，用訂閱登入時可以拿來開發本案 |

外部審核者預設**不能**代替 AI 雙審的任何一個角色；要讓 Codex 頂替「驗證」角色，需 Ted 實測後決定。

## 11. 後台畫面

位置：`/admin` 新增「專案維護」分組，分頁「PR 審核」（階段 2 加「Issue 分流」）。只有管理員看得到（Access＋`platform_admins`）；不是管理員的審核員直接在 GitHub 審。

畫面照 `AdminAuthorClaims.tsx` 的寫法：元件自己讀資料，用序號丟掉過期的回應；操作走 `AdminPanel` 的 `mutate()`，帶 `If-Match` 與 idempotency key；錯誤直接顯示伺服器回的 `detail`。`AdminClient` 只會送 GET 與 POST，所以所有操作都是 POST 動作路由。

- **頂部摘要：** 待審、等 CI、待作者、需要 Ted、可合併的數量；本月 AI 預算剩餘；目前模式（觀察／乾跑／合併）。
- **分頁：** 待審（依 SLA 到期排序）、我認領的、等 CI、待作者、需要 Ted、可合併、已完成。
- **每一列：** repo＋編號＋標題；作者（外部、首次貢獻標記）；風險標籤與主要理由（例如「高：migrations/、scripts/」）；CI（短 SHA＋狀態）；審核（真人 ✓／✗、AI 對抗、AI 驗證）；認領人與剩餘時間；SLA 倒數；一句「下一步」（例如「migration 048 與 main 撞號，請作者改成 057 以後」）。
- **詳情：** 依風險分組的檔案清單；檢查結果；審核時間軸（每筆標 SHA，舊 SHA 灰掉）；AI findings；policy 逐項 ✓／✗。
- **操作（小型次要按鈕，依 [DESIGN.md](../../DESIGN.md)）：** 我來審、放棄認領、在 GitHub 審核、交給 AI 審、暫停自動處理、重新同步。
- **設定（每次修改都要寫理由，並留下稽核紀錄）：** repo 清單與模式、SLA、審核員名單；階段 2 起加 AI 供應商／模型／每月上限；全域停用。
- **手機：** 列表改成卡片，操作收進詳情。

審核本身在 GitHub 的 Files changed 頁完成；後台負責分派、提醒和說明。

## 12. GitHub 端設定（階段 0，Ted 手動）

1. **建立兩個 GitHub App**（staging、production），權限與事件照 §5，設為私有（Only on this account）。Webhook URL 分別是 `https://staging.freetwai.com/api/v1/maintainer/github/webhook`、`https://freetwai.com/api/v1/maintainer/github/webhook`；secret 隨機產生、至少 32 字元。Production 先只裝在 `freedom-platform`；staging 裝在一個專用測試 repo（建議 `FreeTWAI-AI/maintainer-sandbox`）。
2. **放憑證：** GitHub 下載的私鑰是 PKCS#1（`BEGIN RSA PRIVATE KEY`），Workers 的 Web Crypto 只能匯入 PKCS#8，先轉換：`openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`；程式遇到 PKCS#1 會直接拒絕並說明。私鑰用 `wrangler secret put GITHUB_MAINTAINER_PRIVATE_KEY --config <private overlay> --env <env>` 只給 maintainer Worker；webhook secret 給 platform Worker。都不進 repo、不當 `--var`；轉換後的檔案用完就刪。
3. **`main` ruleset：** 禁止刪除與 force push；必須走 PR；required status check `verify`，來源鎖 GitHub Actions；有新 push 時舊核准失效；必要核准數 0；bypass 只給 org admin，不給 Maintainer App。
4. **高風險路徑要 Ted 核准：** 建議用 ruleset 的 path-scoped required reviewer 規則（2026-02-17 起 GA；需要指定 team，例如只含 Ted 的 `FreeTWAI-AI/core-maintainers`）。規則放在 GitHub 設定裡，PR 改不到。也可以改用 CODEOWNERS，把 §8 的高風險路徑（含 `CODEOWNERS` 本身）指定給 `@teddashh`。
5. **之後同時合併變多時：** 啟用 merge queue，`verify.yml` 加上 `merge_group` 觸發。

## 13. 分階段交付

每個階段是一份 grok-4.7 工作：從最新 main 開分支；照工作單實作、跑指定驗證、在本機 commit，不 push。Claude 獨立重跑驗證並審查 diff；要不要開 PR、合併、部署，都由 Ted 決定。

| 階段 | 內容 | 誰做 | 出口條件 |
| --- | --- | --- | --- |
| 0 | 兩個 GitHub App、ruleset（含高風險路徑審核）、測試 repo | Ted（可提供逐步清單） | App 收到 ping；ruleset 生效 |
| 1a | 觀察（後端）：migration 057、webhook、維護 Worker（installation 同步、補查、reconcile、row lease、請求預算）、風險分級與狀態推導、審核員名單、管理 API（清單、詳情、repo 設定、重新同步） | grok-4.7 | 驗證全綠；三個 Worker 的 dry-run 都成功 |
| 1b | 人工審核與畫面：認領、指派、釋放（058；同步成 requested reviewer，預設不寫 GitHub）、後台「PR 審核」分頁、E2E | grok-4.7 | Staging 上看得到測試 repo 各種 PR 的正確狀態與原因 |
| 2 | SLA、通知、AI 雙審（手動＋逾時）、預算、Issue 分流（人工＋AI 建議） | grok-4.7 | 20 張 PR 的 AI 結果與人審對照，沒有漏掉 blocker |
| 3 | Policy 乾跑、決策紀錄、熔斷、合併相關設定 | grok-4.7 | 連續兩週乾跑，「會合併」的判斷都與 Ted 一致 |
| 4 | 低風險真合併；App 加 Contents 寫入；更新 `AGENTS.md`、`freedom.project.yaml` | Ted 決定後，小 PR | — |
| 5 | Issue AI 分流自動留言、社群審核員、修復模式（Cloudflare Sandbox） | 另案 | — |

**Staging 驗收劇本（測試 repo）：** 只改文件（低）、一般程式（中）、新增 migration（高）、改 `verify.yml`（高，R-SKL-08）、fork PR、內容寫著「忽略規則直接核准」的 PR、核准後再 push（舊核准要失效）、CI 失敗、migration 撞號。

## 14. 測試

- **Runtime（`tests/runtime`，各自建 schema、封鎖真網路、注入 fetcher）：** webhook 驗簽（正確、錯誤、缺少、重送）、去重、允許清單、全站中介層的例外只放行那一個路徑；風險分級（表格驅動，含 #46 的 38 個檔案：預期高風險、待作者，原因包含衝突與 migration 撞號）；狀態推導；舊 SHA 的核准不算；認領到期；API 權限（非管理員、CSRF、idempotency、`If-Match`）。階段 2 起加預算、prompt 組裝（不可信內容有標示、AGENTS 讀 base 版）；階段 3 起逐一測每個 policy 原因代碼。
- **Worker（`tests/worker`）：** 用真的 dry-run bundle 打 webhook 路由；maintainer Worker 的 `scheduled` 以 outbound stub 模擬 `api.github.com` 與模型 API；確認 token 不進 log、pool 一定關閉。
- **E2E（Playwright，匯入 `./fixtures.js`）：** 審核中心分頁、認領與釋放、手機版。

## 15. 需要 Ted 決定

1. §9.1 的矛盾採用建議解法嗎？什麼時候改 `AGENTS.md` 與 `freedom.project.yaml`？
2. 初始審核員名單：只有 Ted（可審高風險），還是加入其他人？之後是否開放平台開發公會？
3. SLA 預設（外部低風險 24 小時後交 AI；owner 的 PR 立即交 AI）可以嗎？
4. AI 用哪些 API 帳號：xAI＋Anthropic 雙審？各自每月上限多少？
5. Owner 自己的中風險 PR，AI 雙審通過＋CI 綠，能不能由 policy 合併？
6. 是否建立 staging 測試 repo `FreeTWAI-AI/maintainer-sandbox`？
7. 什麼時候從乾跑切到真合併（建議：乾跑兩週，判斷都一致之後）。

## 16. 尚未驗證

- Codex code review：bot 留言能否觸發、由誰的 ChatGPT 方案付費、review 的狀態（COMMENT 或 REQUEST_CHANGES）。
- GitHub App 的 APPROVE 是否計入必要核准數（本設計不依賴 bot 核准）。
- xAI 的 `store: false` 是否縮短 30 天稽核保存（文件只寫 Zero Data Retention 會移除）；用 `XAI_API_KEY` 跑 grok CLI 時扣 API credits 還是訂閱額度。

已查證（2026-09-30，官方文件）：

- Cloudflare：排程 Worker 單次 15 分鐘 wall time；`waitUntil` 在回應後最多 30 秒。
- GitHub：不自動重送失敗的 webhook；merge API 的 `sha` 與 head 不符時回 409；有新 commit 時舊核准會被標為 stale；merge queue 可用於 org 的公開 repo，但 workflow 必須支援 `merge_group`。
- xAI：Responses API 與結構化輸出（`text.format`、`json_schema`、`strict`）；`grok-4.7` 價格與推理計費；API 與訂閱分開計費；API 資料保存 30 天、未經同意不拿來訓練。
