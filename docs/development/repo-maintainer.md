# 儲存庫維護者（階段 1a）

階段 1a 只觀察。GitHub 仍是事實來源。平台把審查需要的事實鏡像下來：拉取請求、變更檔案、審查、檢查。它依規則算出風險，再推出佇列狀態與原因，並提供管理員讀取 API、儲存庫設定與審查者名單。

這一階段不做這些事：

- 不在 GitHub 上送審查、留言、標籤、requested reviewer 或合併。
- 不呼叫 AI。
- 沒有管理畫面，也沒有認領。認領、管理頁與 E2E 是階段 1b。
- 不產生 `in_review`。那個狀態留給認領。
- 設定裡的 `ai_review`、`merge_dry_run`、`merge` 會回 422。資料表已經允許這些值，避免之後還要改欄位，但 API 現在只收 `off` 與 `observe`。

會員用的 GitHub App（`modules/github-social`）不變：不留私鑰、不擴權、webhook 關閉。維護者 App 是另一個私有 App。

## 元件

| 元件 | 位置 | 做什麼 |
| --- | --- | --- |
| 資料表 | `migrations/057_repo_maintainer.sql` | 儲存庫、單列排程、webhook 投遞紀錄、工作、拉取請求鏡像、檔案、檢查、審查、審查者 |
| 政策 | `modules/repo-maintainer/policy.ts` | 風險、遷移編號、佇列狀態。沒有 I/O。版本 `2026-09-30.1` |
| Webhook | `POST /api/v1/maintainer/github/webhook` | 驗簽、正規化、寫一筆投遞、必要時排入 `reconcile_pull`。不呼叫 GitHub |
| 維護 Worker | `apps/platform-api/src/maintainer-worker.ts` | 每分鐘跑一次 tick：安裝同步、掃 open PR、執行工作 |
| 管理 API | `/admin/api/review-center/*` | 讀鏡像、改儲存庫模式與設定、指派審查者。見 [platform-admin-api.md](platform-admin-api.md) |

Webhook 只是提示。漏掉的投遞不會由 GitHub 重送。Worker 每 30 分鐘掃一次到期的儲存庫，把新的、`updated_at` 或 head SHA 變了的、以及清單裡已經不見的 open PR 排進去重算。

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

之後的階段才會用到 Pull requests 寫入、Issues、Actions 與 Contents 寫入。現在不要開寫入。App 增加權限時，GitHub 會要求組織擁有者重新同意。

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

成功時有一行 JSON，只有計數：刪掉的投遞與工作、重新推導的筆數、忽略的帳號、寫入與移除的儲存庫、掃過的儲存庫、完成／失敗／放回的工作、GitHub 請求數，以及 `stopped`（`null`、`budget`、`time` 或 `rate_limit`）。沒有 token、私鑰、連線字串或 GitHub 原文。

失敗時這次 cron 被標成失敗。訊息固定是 `Maintainer synchronization failed; the next minute retries.` 日誌只有 `maintainer_tick_failed` 與錯誤名稱。下一分鐘會再跑。

## 暫停

任選一種，效果由快到慢：

1. 在管理 API 把儲存庫 `mode` 設成 `off`。Webhook 改記 ignored，tick 不再掃、也不跑該儲存庫的工作。
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

- 掃儲存庫時，head SHA 與 `updated_at` 都沒變、也還在 open 清單裡的拉取請求不會重抓。若 `check_suite` webhook 漏了，檢查結果會停到下一次 head 變更、PR 從 open 清單消失，或管理員按重新同步。
- 遷移目錄的 contents 回 404 視為那個目錄不存在（空的 base 清單），不是儲存庫消失。拉取請求本身 404 或 410 才會把工作標成 `github_not_found` 並要求安裝同步。
- 安裝與儲存庫清單用 App JWT。這一步還不知道 repository id，所以不另鑄一張只有 metadata 的 installation token。掃與 reconcile 才鑄 token，權限是 metadata、pull requests、checks、statuses、contents，全部 read，並帶 `repository_ids`。
- 超過 SLA 之後會留下 `sla_overdue` 與 `sla_due_at`，但 `recheck_at` 改成空，避免每分鐘重寫同一列。
- 風險裡多了一個說明用的 `approval_rank_too_low`：審查者的風險上限低於這次變更時，那個核准不算，原因會寫出來。
- 必要檢查只有 `success` 與 `neutral` 算過。`skipped` 算失敗。`action_required` 是 `ci_not_run`，請人去 GitHub 核准 workflow。
- GET 沿用既有的 `readGitHub`，User-Agent 仍是 `Freedom-Platform-public-registry`。鑄 token 的 POST 使用 `Freedom-Platform-maintainer`。
- 一次 tick 最多 60 個 GitHub 請求、50 秒。速率限制會寫上該 installation 所有儲存庫的 `rate_limited_until`（1 分鐘到 1 小時），並放回工作、不計入這一次嘗試。
- 資料庫必須恰好有一個社群，否則 tick 失敗。Hyperdrive 必須 caching disabled，而且一個資料庫一份設定。列租約用單次 `UPDATE ... FOR UPDATE SKIP LOCKED`，不使用 session advisory lock，避免 transaction 模式的連線池把鎖留在別的連線上。
- 安裝清單或儲存庫清單若被頁數上限截斷，不會把沒出現的儲存庫標成 removed。Open PR 清單被截斷時，只排新的與有變的，不把沒出現的視為已關閉。
