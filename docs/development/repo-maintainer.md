# 儲存庫維護者（階段 1a 觀察，階段 1b 認領）

階段 1a 只觀察。GitHub 仍是事實來源。平台把審查需要的事實鏡像下來：拉取請求、變更檔案、審查、檢查。它依規則算出風險，再推出佇列狀態與原因，並提供管理員讀取 API、儲存庫設定與審查者名單。

階段 1b 加上人工認領和管理頁「PR 審核」。認領是有期限的軟鎖，讓兩個人不要同時審同一筆拉取請求。認領不是審查證據。審查仍以 GitHub 上的 review 為準。

這一階段不做這些事：

- 不在 GitHub 上送審查、留言、標籤或合併。
- 不呼叫 AI。
- 設定裡的 `ai_review`、`merge_dry_run`、`merge` 會回 422。資料表已經允許這些值，避免之後還要改欄位，但 API 現在只收 `off` 與 `observe`。
- 把認領鏡像成 GitHub requested reviewer 已經接上，預設關閉。三個開關都打開才會寫，見「要求審查者」。

會員用的 GitHub App（`modules/github-social`）不變：不留私鑰、不擴權、webhook 關閉。維護者 App 是另一個私有 App。

## 元件

| 元件 | 位置 | 做什麼 |
| --- | --- | --- |
| 資料表 | `migrations/057_repo_maintainer.sql`、`migrations/058_maintainer_review_claims.sql` | 儲存庫、單列排程、webhook 投遞紀錄、工作、拉取請求鏡像、檔案、檢查、審查、審查者、認領 |
| 政策 | `modules/repo-maintainer/policy.ts` | 風險、遷移編號、佇列狀態、認領覆寫。沒有 I/O。版本 `2026-09-30.2` |
| 推導 | `modules/repo-maintainer/derive.ts` | `rederivePull`：用已存的鏡像、子表、啟用中的審查者、`migration_reasons` 與進行中的認領重算一筆。不重新推導遷移原因 |
| Webhook | `POST /api/v1/maintainer/github/webhook` | 驗簽、正規化、寫一筆投遞、必要時排入 `reconcile_pull`。不呼叫 GitHub。只有這個精確的 POST 在會員驗證之前；同一路徑的 GET 回 401 `login_required` |
| 維護 Worker | `apps/platform-api/src/maintainer-worker.ts` | 每分鐘跑一次 tick：安裝同步、認領生命週期、掃 open PR、執行工作 |
| 管理 API 與頁面 | `/admin/api/review-center/*`、後台「PR 審核」 | 讀鏡像、認領、指派、暫停、改儲存庫模式與設定、指派審查者。見 [platform-admin-api.md](platform-admin-api.md) |

Webhook 只是提示。漏掉的投遞不會由 GitHub 重送。Worker 每 30 分鐘掃一次到期的儲存庫，把新的、`updated_at` 或 head SHA 變了的、以及清單裡已經不見的 open PR 排進去重算。清單裡沒變、但鏡像已舊的 open PR 也會重算：`synced_at` 超過 10 分鐘，而且佇列是 `waiting_ci` 或 `mergeable` 仍是空的；或者 `synced_at` 超過 6 小時。這種重新整理每次掃描最多 20 筆，`synced_at` 舊的先排。新的、有變的、以及清單裡不見的不受這 20 筆限制。

## 每個環境要給的名稱

不要把真實的 App id、installation id、Hyperdrive id、webhook secret 或私鑰提交進 repo。Committed 的 Hyperdrive id 是全零，App id 是 `0`，這兩個都會讓沒有 overlay 的部署失敗或在排程裡被拒絕。

平台 Worker（`wrangler.jsonc` 的私有 overlay）：

| 名稱 | 種類 | 沒給會怎樣 |
| --- | --- | --- |
| `GITHUB_MAINTAINER_WEBHOOK_SECRET` | secret，至少 32 字 | 只有 webhook 回 503 `maintainer_webhook_unavailable`。網站其他路徑不受影響。`readWorkerConfig` 不要求它 |

維護 Worker（`wrangler.maintainer.jsonc` 的私有 overlay）：

| 名稱 | 種類 | 說明 |
| --- | --- | --- |
| `HYPERDRIVE` | binding | 該環境平台 Worker 已經在用、caching disabled 的那一份。staging 與 production 不要共用 |
| `GITHUB_MAINTAINER_APP_ID` | var | 數字，不能是 0 |
| `GITHUB_MAINTAINER_ORG` | var | 這個檔寫 `FreeTWAI-AI`。其他帳號的 installation 只計數，不寫入 |
| `GITHUB_MAINTAINER_PRIVATE_KEY` | secret | PKCS#8（`BEGIN PRIVATE KEY`）。PKCS#1（`BEGIN RSA PRIVATE KEY`）會被拒絕 |

本機 dry-run 不讀 committed 的資料庫網址。只有在隔離的本機資料庫上，才在 shell 設 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`。不要把網址寫進 jsonc。

## GitHub App

另建一個私有 App，只裝在 FreeTWAI-AI，安裝時選「Only select repositories」。不要改會員 App。

階段 1a 實際用到的權限都是讀：

| 權限 | 階段 1a |
| --- | --- |
| Metadata | Read |
| Pull requests | Read |
| Checks | Read |
| Commit statuses | Read |
| Contents | Read。只在拉取請求碰到遷移目錄時，讀 base 分支的檔名清單 |

階段 1b 只有在下面三個開關都打開時，才會用 Pull requests 的 write，而且只對被認領的那一位審查者呼叫 requested reviewers。Issues、Actions 與 Contents 寫入仍不使用。App 增加權限時，GitHub 會要求組織擁有者重新同意；在擁有者同意之前，鑄 token 會失敗，工作記成 `github_permission_missing`，不重試。

事件：`pull_request`、`pull_request_review`、`check_suite`、`check_run`、`status`。`installation` 與 `installation_repositories` 會自動送出，用來提前做安裝同步。`ping` 只記錄、不排工作。Issues 與 issue comment 這一階段會被記成 ignored。

Webhook URL：

- staging：`https://staging.freetwai.com/api/v1/maintainer/github/webhook`
- production：`https://freetwai.com/api/v1/maintainer/github/webhook`

Content type 用 `application/json`。Secret 與平台 Worker 的 `GITHUB_MAINTAINER_WEBHOOK_SECRET` 相同，至少 32 字。驗簽失敗只記固定碼 `maintainer_webhook_rejected signature`，不寫資料庫，也不把 body 寫進日誌。

私鑰若是 PKCS#1，先轉成 PKCS#8 再上傳：

```sh
openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem
```

貼上時若把換行存成字面 `\n`，Worker 會先換成真正的換行再讀。

## 部署

Repo 只做 dry-run，不部署、不打 Cloudflare API：

```sh
npm run worker:dry-run:maintainer
```

真正的 secret 與部署只走私有 overlay。先 staging，確認一次 tick 之後再做 production。

```sh
npx wrangler secret put GITHUB_MAINTAINER_WEBHOOK_SECRET --config <platform-overlay.jsonc> --env staging-next
npx wrangler secret put GITHUB_MAINTAINER_PRIVATE_KEY --config <maintainer-overlay.jsonc> --env staging-next
npx wrangler deploy --config <platform-overlay.jsonc> --env staging-next
npx wrangler deploy --config <maintainer-overlay.jsonc> --env staging-next
```

`next` 把 `--env staging-next` 換成 `--env next`。不要用 `--var` 傳 secret。不要拿 repo 裡的 template 直接 deploy。

## 確認一次 tick

```sh
npx wrangler tail --config <maintainer-overlay.jsonc> --env staging-next --format json
```

成功時有一行 JSON，只有計數：刪掉的投遞與工作、重新推導的筆數、忽略的帳號、停權的 installation、寫入與移除的儲存庫、掃過的儲存庫、完成／失敗／放回的工作、GitHub 請求數、`claims_expired`、`claims_released`、`claims_completed`、`writes`（只會是 `off`、`requested_reviewers` 或 `invalid`），以及 `stopped`（`null`、`budget`、`time` 或 `rate_limit`）。沒有 token、私鑰、連線字串或 GitHub 原文。`writes` 不是這三個值時，這次 tick 失敗，錯誤名稱是 `maintainer_result_invalid`。

失敗時這次 cron 被標成失敗。訊息固定是 `Maintainer synchronization failed; the next minute retries.` 日誌只有 `maintainer_tick_failed` 與錯誤名稱。下一分鐘會再跑。

## 階段 1b：認領

一筆認領綁一位審查者與一個拉取請求，到期時間是現在加上該儲存庫的 `claim_hours`（1–168，預設 24）。同一筆拉取請求同時只能有一筆 `state=active` 的認領。自己認領或被指派都一樣。認領當下的 head SHA 記在認領上，只供對照，不拿來判斷審查算不算數。

進行中、而且 `expires_at` 還在未來的認領，只會把原本的 `awaiting_review`，或原因含 `high_risk_requires_owner` 的 `needs_owner`，改成 `in_review`，並加上 `review_claimed`。merged、closed、paused、draft、非預設分支、needs_author、waiting_ci、ci_not_run、ready 都不會被認領蓋掉。過期的認領不算。

Tick 在重新推導之前，用資料庫結束認領，每一步都是一筆 `UPDATE … RETURNING`，而且仍要求 `state=active`，所以較早的條件先算：

1. `expires_at` 已到 → `expired`。`end_reason` 維持空。
2. 拉取請求已關閉或已合併 → `released`，`end_reason=pull_closed`。
3. 審查者已停用 → `released`，`reviewer_inactive`。
4. 審查者的 `max_risk` 低於這筆拉取請求目前存著的 `risk_class` → `released`，`reviewer_rank_too_low`。
5. 這位審查者在認領的 `created_at` 之後送出 `APPROVED` 或 `CHANGES_REQUESTED`（任何提交都算）→ `completed`，`review_submitted`。`COMMENTED` 不結束認領。這也不等於拉取請求已核准。

離開 `active` 的認領會立刻 `rederivePull`，所以管理頁在同一筆交易裡看得到新的佇列狀態。認領 API、指派、釋放、暫停與恢復也走同一條。

會員重新連結另一個 GitHub 帳號之後，不能再用舊的審查者列認領；已經存在的認領不會因此被放開。暫停一筆拉取請求不會放開它的認領。佇列會顯示暫停；恢復之後若認領還在，可回到 `in_review`。

### 要求審查者

預設不寫 GitHub。三個開關都要開：

1. 維護者 App 的 Pull requests 權限是 write。組織擁有者必須在 GitHub 重新同意，否則鑄 token 會得到 403 或 422。
2. 維護 Worker 的 `GITHUB_MAINTAINER_WRITES` 正好是 `requested_reviewers`。Committed 的值是 `off`。沒給、或任何其他字（含大小寫不同）都當成 `invalid`，不會寫。
3. 該儲存庫設定 `request_reviewers` 是 true。

認領或指派時，設定是 true 就把 `github_request_state` 設成 `pending` 並排入 `request_reviewer`；否則是 `not_requested`，不排工作。工作執行當下會再讀這三個開關。不允許就標 `skipped`（`writes_disabled`），不呼叫 GitHub。認領已經不是 active 就標 `skipped`（`claim_inactive`）。

允許時，只為那一個儲存庫鑄 `{ metadata: read, pull_requests: write }` 的 token，然後 `POST` 或 `DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers`，body 是 `{ "reviewers": ["<這位審查者的 login>"] }`。不碰其他人，也不碰 team reviewer。POST 201 是 `requested`，DELETE 200 是 `removed`。成功只看狀態碼；回應正文可能是整份拉取請求，超過 64 KiB 也不當成錯誤，因為 GitHub 已經套用，重試會再寫一次。

422、沒有速率限制標頭的 403，或 token 沒有 pull_requests write，標 `failed` 且不重試。鑄 token 時的 403（無速率限制標頭）或 422 同樣標 `github_permission_missing`，不重試。速率限制、預算與時間沿用既有規則：放回工作、不計入這一次嘗試。Login 只是顯示用，改名之後可能過期；422 可以是這個人不是 collaborator，或 login 已經改了。

認領若在 POST 回來之前被放開，工作不握著列鎖。201 之後再鎖一次認領：仍是 active，或結束原因是 `pull_closed`，就標 `requested`（GitHub 在審查送出或拉取請求關閉時會自己清掉請求）。其他結束原因改成 `removing` 並排入 `remove_reviewer_request`，避免放開之後 GitHub 上還留著請求。

### 在畫面上暫停一筆

後台「PR 審核」打開該筆，填理由後按「暫停自動處理」。這只把該筆的 `paused` 設成 true，不改儲存庫模式，也不放開認領。恢復時再填理由。儲存庫整個關掉仍用模式 `off`。

## 暫停

任選一種，效果由快到慢：

1. 在管理 API 把儲存庫 `mode` 設成 `off`。Webhook 改記 ignored，tick 不再掃這個儲存庫，也不跑它的 `reconcile_pull`。已經排進去的 `request_reviewer` 與 `remove_reviewer_request` 仍會跑，因為那是人認領之後的寫入，跟觀察模式無關；沒開上面三個開關時，這些工作會標 `skipped`，不會呼叫 GitHub。單筆暫停用上一節，不需要把整個儲存庫關掉。
2. 刪掉平台 Worker 的 `GITHUB_MAINTAINER_WEBHOOK_SECRET`。Webhook 回 503，已經在佇列裡的工作仍會跑。
3. 在 Cloudflare 停掉這支 Worker 的 cron。
4. 刪掉維護 Worker。刪的是 `freedom-maintainer-staging-next` 或 `freedom-maintainer-next`，不是平台 Worker。

```sh
npx wrangler delete --config <maintainer-overlay.jsonc> --env staging-next
npx wrangler delete --config <maintainer-overlay.jsonc> --env next
```

## 資料保留

每次 tick 會刪掉 30 天前的 webhook 投遞，以及 14 天前已結束（done、failed、cancelled）的工作。拉取請求鏡像、審查者與儲存庫列不會因這個期限被刪。投遞表只存正規化欄位與 body 的 sha256，不存 payload。Token 與私鑰不進資料庫。

## 已知限制

- 遷移目錄的 contents 回 404 視為那個目錄不存在（空的 base 清單），不是儲存庫消失。拉取請求本身 404 或 410 才會把工作標成 `github_not_found` 並要求安裝同步。
- 安裝清單 `GET /app/installations` 用 App JWT。想要的組織 installation 若 `suspended_at` 有值，不鑄 token、也不列儲存庫，並計入 `suspended_installations`；這次清單若完整，它名下已登錄的儲存庫會標成 removed。GitHub 的 `installation` unsuspend 會排下一次安裝同步，同步後再標回 active。沒有停權的 installation 鑄一張只有 `{ permissions: { metadata: "read" } }` 的 token，不帶 `repository_ids`、也不帶 `repositories`，再用這張 token 呼叫 `GET /installation/repositories`。掃與 reconcile 另鑄 token，權限是 metadata、pull requests、checks、statuses、contents，全部 read，並帶該儲存庫的 `repository_ids`。
- 變更檔案最多讀 10 頁，也就是 1000 個檔。清單被截斷，或 GitHub 回報的 `changed_files` 多於實際列到的檔案時，風險升為高（`changed_files_truncated`），鏡像仍會寫入。審查與 check run 碰到頁數上限則會重試，不會把不完整的清單當成完整結果。
- `is_fork` 只看 head 是不是這份 base：`head.repo` 為 null，或 `head.repo.id` 不等於 `base.repo.id`。`head.repo.fork` 只表示那個儲存庫本身另有上游，不用來判斷這次拉取請求。
- freedom-platform 的高風險驗證路徑另外包含 `repositories.lock.json`、`.npmrc`、`.gitattributes` 與 `.gitmodules`。測試檔在 `tests/` 裡改名，或檔名仍是 `*.test.*` / `*.spec.*`，不算 `test_removed`。離開測試路徑，或拿掉測試檔名，才算。刪除測試檔仍是高風險。
- 遷移編號撞到 base 上已有的檔案是 `migration_number_collision`。編號小於 base 目前最新、但那個編號並不存在（中間有空號）是 `migration_number_behind`。兩種都會停在 needs_author。訊息裡的分支名是這次拉取請求的 base ref，預設儲存庫不一定是 `main`。這些原因另外寫在 `migration_reasons`。模式改成關閉再改回觀察時，佇列會先暫停，再依這欄回到 needs_author，不必再打 GitHub。
- 同一個拉取請求已經有排隊中的 `reconcile_pull` 時，新的 webhook 或管理員重新同步不會再插一筆。若那筆的 `run_after` 比這次更晚，會把 `run_after` 提前，嘗試次數不變；沒有更晚可提前時，這次不算新排入。
- 只有精確的 `POST /api/v1/maintainer/github/webhook` 在會員驗證之前執行，不需要 session。同一個路徑的 GET 走一般會員驗證，沒有 cookie 時回 401 `login_required`。
- 超過 SLA 之後會留下 `sla_overdue` 與 `sla_due_at`，但 `recheck_at` 改成空，避免每分鐘重寫同一列。
- 風險裡多了一個說明用的 `approval_rank_too_low`：審查者的風險上限低於這次變更時，那個核准不算，原因會寫出來。
- 必要檢查只有 `success` 與 `neutral` 算過。`skipped` 算失敗。`action_required` 是 `ci_not_run`，請人去 GitHub 核准 workflow。狀態還不是 `completed` 時（queued、in_progress、waiting、requested、pending）視為還在跑，是 `waiting_ci`。
- GitHub 不限制檢查名稱與 status context 的長度。過長的字串先截成 200 個碼位再存，標籤名稱截成 100 個碼位。同名的 check run 留 id 較大的那一筆。combined status 以 `per_page=100` 讀取。
- GET 沿用既有的 `readGitHub`，User-Agent 仍是 `Freedom-Platform-public-registry`。鑄 token 的 POST 使用 `Freedom-Platform-maintainer`。
- 一次 tick 最多 60 個 GitHub 請求、50 秒。速率限制會寫上該 installation 所有儲存庫的 `rate_limited_until`（1 分鐘到 1 小時），並放回工作、不計入這一次嘗試。
- 資料庫必須恰好有一個社群，否則 tick 失敗。Hyperdrive 必須 caching disabled，而且一個資料庫一份設定。列租約用單次 `UPDATE ... FOR UPDATE SKIP LOCKED`，不使用 session advisory lock，避免 transaction 模式的連線池把鎖留在別的連線上。
- 安裝清單或儲存庫清單若被頁數上限截斷，不會把沒出現的儲存庫標成 removed。Open PR 清單被截斷時，仍排新的、有變的，以及最多 20 筆已列出的舊鏡像，但不把沒出現的視為已關閉。
- 認領當下用的是已經存著的 `risk_class`，不是當場重算。若鏡像還是舊的低風險，低上限的審查者可能先認領成功；下一次 tick 把風險升上去之後，會以 `reviewer_rank_too_low` 放開。
- Tick 先鎖認領再鎖拉取請求。認領 API 先鎖拉取請求再新增認領。兩條路交錯時可能死鎖一次；tick 碰到 `40P01` 會重試那一步一次。API 不重試。
- 移除請求時若 Worker 變數或儲存庫設定已經關掉，工作標 `skipped`（`writes_disabled`），GitHub 上可能還留著這位 requested reviewer。要清掉就得把三個開關打開再跑，或到 GitHub 上手動移除。
- `requested_reviewers` 欄位只鏡像使用者（`id` 與 `login`），給畫面與生命週期用。`requested_teams` 不存。這欄不是審查證據。
