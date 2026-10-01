# 儲存庫維護者（階段 1a 觀察，階段 1b 認領，階段 1c 公會歸屬）

階段 1a 只觀察。GitHub 仍是事實來源。平台把審查需要的事實鏡像下來：拉取請求、變更檔案、審查、檢查。它依路徑與變更大小寫出注意事項，再推出佇列狀態與原因。沒有風險等級，也沒有 SLA。線上的項目維持穩定，一筆拉取請求就停在佇列裡，直到有人處理。

階段 1b 加上人工認領和管理頁「PR 審核」。認領是軟鎖，讓兩個人不要同時審同一筆拉取請求。預設不設到期；管理員仍可把 `claim_hours` 設成 1–168。認領不是審查證據。審查仍以 GitHub 上的 review 為準。

階段 1c 把「誰可以審」從審查者名單改成儲存庫歸屬。一個儲存庫屬於一個公會，類型是模組、技能書或未分類。新鏡像的儲存庫沒有公會，並開放公會長認領；目錄裡的 `official_guild_keys` 不會自動變成歸屬。管理員仍可把單一儲存庫改成只限管理員。開放時，任何現任公會長都能審，第一筆完成的公會長審查會把儲存庫歸到那位公會長的公會。背景只做兩件事：鏡像 GitHub 事實，以及既有的請求審查者鏡像。沒有自動處理，也沒有 AI。

這一階段不做這些事：

- 不在 GitHub 上送審查、留言、標籤或合併。
- 不呼叫 AI。
- 儲存庫 mode 只有 `off` 與 `observe`。其他值回 422。
- 把認領鏡像成 GitHub requested reviewer 已經接上。沒有另外設定時，認領會請求審查者。本機 Worker 變數仍是 `off`；staging 與 production 是 `requested_reviewers`。三個條件都成立才會寫，見「要求審查者」。

會員用的 GitHub App（`modules/github-social`）不變：不留私鑰、不擴權、webhook 關閉。維護者 App 是另一個私有 App。

## 元件

| 元件 | 位置 | 做什麼 |
| --- | --- | --- |
| 資料表 | `migrations/061_repo_maintainer.sql`、`migrations/062_maintainer_review_claims.sql`、`migrations/068_maintainer_review_scope.sql` | 儲存庫、歸屬變更、單列排程、webhook 投遞紀錄、工作、拉取請求鏡像、檔案、檢查、審查、認領、`maintainer_eligible_reviewers`。068 把新儲存庫預設改成開放認領，並加上技能書審查範圍 |
| 政策 | `modules/repo-maintainer/policy.ts` | 注意事項、遷移編號、佇列狀態、認領覆寫。沒有 I/O。版本 `2026-10-01.2` |
| 推導 | `modules/repo-maintainer/derive.ts` | `rederivePull`：用已存的鏡像、子表、資格視圖裡的 GitHub id、`migration_reasons` 與進行中的認領重算一筆。不重新推導遷移原因 |
| Webhook | `POST /api/v1/maintainer/github/webhook` | 驗簽、正規化、寫一筆投遞、必要時排入 `reconcile_pull`。不呼叫 GitHub。只有這個精確的 POST 在會員驗證之前；同一路徑的 GET 回 401 `login_required` |
| 維護 Worker | `apps/platform-api/src/maintainer-worker.ts` | 每分鐘跑一次 tick：安裝同步、認領生命週期、掃 open PR、執行工作 |
| 管理 API 與頁面 | `/admin/api/review-center/*`、後台「PR 審核」 | 讀鏡像、認領、指派、暫停、改模式與設定、改歸屬、看誰可以審。見 [platform-admin-api.md](platform-admin-api.md) |
| 公會審查 API 與頁面 | `/api/v1/guild-reviews`、公會管理「PR 審核」 | 現任公會長看自己公會，以及沒有公會且已開放認領的拉取請求。只靠技能書任命的人只看自己那本書的工坊。同時是兩者的人看到聯集。都可以認領或放棄自己的認領。見下方「公會長與技能書維護者」 |

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

App 建立時就包含下面的權限。Pull requests 從一開始就是 Read & write，所以之後打開請求審查者時，不必再請組織重新同意。

| 權限 | 存取 |
| --- | --- |
| Metadata | Read |
| Pull requests | Read & write |
| Checks | Read |
| Commit statuses | Read |
| Contents | Read。只在拉取請求碰到遷移目錄時，讀 base 分支的檔名清單 |

寫入只對被認領的那一位審查者呼叫 requested reviewers。Issues、Actions 與 Contents 寫入仍不使用。沒有 Pull requests write 時，鑄 token 失敗為 `github_permission_missing`，工作失敗且不重試，認領不受影響。

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

成功時有一行 JSON，只有計數：刪掉的投遞與工作、重新推導的筆數、忽略的帳號、停權的 installation、寫入與移除的儲存庫、掃過的儲存庫、完成／失敗／放回的工作、GitHub 請求數、`claims_expired`、`claims_released`、`claims_completed`、`repositories_adopted`、`writes`（只會是 `off`、`requested_reviewers` 或 `invalid`），以及 `stopped`（`null`、`budget`、`time` 或 `rate_limit`）。沒有 token、私鑰、連線字串或 GitHub 原文。`writes` 不是這三個值時，這次 tick 失敗，錯誤名稱是 `maintainer_result_invalid`。

失敗時這次 cron 被標成失敗。訊息固定是 `Maintainer synchronization failed; the next minute retries.` 日誌只有 `maintainer_tick_failed` 與錯誤名稱。下一分鐘會再跑。

## 歸屬與誰可以審查

每個鏡像下來的儲存庫有 `guild_key`（沒有就是沒有公會）、`scope_kind`（`module` 模組、`skill_book` 技能書，或空的未分類）和 `open_to_guilds`。新列的預設是沒有公會、`open_to_guilds` true。安裝同步不寫這兩欄，也不從技能書目錄的 `official_guild_keys` 指派公會。已指定公會時不能同時開放所有公會長認領。遷移會把既有、沒有公會、尚未開放、而且沒有任何歸屬變更的列改成開放，並把 `aggregate_version` 加一。已經有歸屬變更，或已經屬於公會的列，維持原狀。

安裝同步會把 `full_name` 和技能書目錄的 `repository_url` 比對（不分大小寫，去掉結尾斜線與 `.git`，主機是 github.com）。對上的新列把 `scope_kind` 設成 `skill_book`，並寫入那個 `skill_book_id`。既有列只有在 `scope_kind` 與 `skill_book_id` 都是空的、而且沒有歸屬變更時才補上。管理員已經選過的類型不會被蓋掉。這是分類，不是把儲存庫歸給公會，也不讀 `official_guild_keys`。同一社群裡一本書只對到一個儲存庫；那本書已經被另一列用掉時，這次同步跳過分類。

`maintainer_eligible_reviewers` 是唯一的資格來源，TypeScript 不再寫第二套規則：

- `acting_as=admin`：這個社群裡每位啟用中的平台管理員，對上同社群、email 相同（不分大小寫）、帳號啟用且 email 已驗證的會員，而且該會員有 GitHub OAuth 連結。未驗證的會員帳號不能借管理員的 email。每個儲存庫都算。`skill_book_id` 是空的。
- `acting_as=guild_leader`：現任公會職位，加上同一公會的有效成員關係、啟用中的會員，以及 GitHub 連結。公會要等於儲存庫的公會；或者儲存庫沒有公會且已開放公會長認領。`skill_book_id` 是空的。
- `acting_as=skill_book_maintainer`：`skill_book_maintainers` 對這個儲存庫的 `skill_book_id`、同一社群、任命仍有效、會員啟用，而且有 GitHub OAuth 連結。任命是資格的依據：具名、只限那本書、可撤回、由管理員任命。技能書編輯用的開發公會門檻不是審查資格。這一列的 `guild_key` 是空的。儲存庫屬於哪個公會、有沒有開放認領，都不影響這一列。

同一人可以出現多次（管理員，幾個公會的公會長，或那本書的維護者）。認領時選定一列 `(user_id, acting_as, guild_key, skill_book_id)`。

有效核准：這位審查者最新的決定性審查是 `APPROVED`、落在目前的 head SHA、GitHub id 在資格視圖裡，而且不是作者。`CHANGES_REQUESTED` 會擋住，若它來自資格內的人，或關聯是 OWNER、MEMBER、COLLABORATOR。資格外的人在目前 head 上核准，佇列仍是待審，並附上 `approval_not_eligible`。作者本人也在資格裡時，不能核准自己的 PR（`author_is_reviewer`）。`needs_decision`（畫面「待決定」）只來自非預設分支。

管理員改歸屬走 `POST /review-center/repositories/:id/ownership`，If-Match 是儲存庫的 `aggregate_version`。理由 3–1000 字。主體含 `skill_book_id`，可以是 null。類型是技能書時，可以選目錄裡的技能書，也可以不指定。沒有變更回 409 `maintainer_ownership_unchanged`。公會不在目錄回 422 `maintainer_guild_not_found`。又指定公會又開放認領回 422 `maintainer_ownership_invalid`。技能書不在目錄，或類型不是技能書卻帶了技能書，回 422 `maintainer_skill_book_invalid`。這本書已經對到另一個儲存庫回 409 `maintainer_skill_book_taken`。寫入一筆 `maintainer_ownership_changes`（`source=admin`，含 `skill_book_id`），並把該儲存庫未關閉的拉取請求 `recheck_at` 設成現在。不再符合資格的認領留到下一次 tick 放開，不在這支 API 裡處理。

公會長的認領完成時才會歸屬。`acting_as=guild_leader`，而且儲存庫當時沒有公會、又是開放認領，才把 `guild_key` 設成這筆認領的公會、`open_to_guilds` 設成 false，並寫 `source=adopted`。歸屬變更會帶上當時的 `skill_book_id`，不會把它清掉。理由是「審完 {full_name}#{number} 後歸到這個公會。」同一輪裡兩個不同公會都完成時，依 `pull_id` 順序只有第一筆更新得到列。管理員的認領不會歸屬。技能書維護者的認領也不會歸屬。已經有公會的儲存庫也不會被這一步改掉。

設定 schema 仍然嚴格。`sla_hours` 已移除；客戶端還送這個欄位會得到 422。`claim_hours` 省略表示不自動釋放，送 `null` 也是 422。待審依 `head_observed_at` 由早到晚，再依 `pull_id`。其他清單依 `github_updated_at` 新到舊。

## 階段 1b–1c：認領

一筆認領記下審查者的會員 id、GitHub 數字 id、login、`acting_as`（`admin`、`guild_leader` 或 `skill_book_maintainer`）、公會和技能書。`skill_book_maintainer` 的公會是空的、技能書不是空的。管理員和公會長的技能書是空的。login 是當時的快照，給畫面和請求審查者鏡像用。同一筆拉取請求同時只能有一筆 `state=active` 的認領。自己認領或被指派都一樣。認領當下的 head SHA 記在認領上，只供對照，不拿來判斷審查算不算數。儲存庫模式是 `off`、拉取請求不是 open、仍是草稿，或該筆已暫停，都不能認領或指派。

`expires_at` 空著表示這筆認領不會到期。有設 `claim_hours` 時，到期時間是現在加上那個小時數。進行中的認領（空的到期，或到期還在未來）只會把 `awaiting_review` 改成 `in_review`，並加上 `review_claimed`。管理員的句子是「{login}（管理員）正在審查。」公會長是「{login}（{公會}・公會長）正在審查。」技能書維護者是「{login}（{書名}・技能書維護者）正在審查。」只有公會長、而且這筆認領會歸屬時，才再加「審完後這個儲存庫會歸到{公會}。」有設到期再加「認領到期後會自動釋放。」沒有帶這筆認領時的預設句是「已有人正在審查。」merged、closed、paused、draft、非預設分支、needs_author、waiting_ci、ci_not_run、ready、needs_decision 都不會被認領蓋掉。

Tick 在重新推導之前結束認領。每一步先依 `pull_id` 順序鎖住候選的拉取請求，再更新那些拉取請求上仍是 `active` 的認領，所以較早的條件先算：

1. `expires_at` 不是空且已到 → `expired`。`end_reason` 維持空。空的到期不會被這一步選到。
2. 拉取請求已關閉或已合併 → `released`，`end_reason=pull_closed`。
3. 資格視圖沒有對上 `(repository, reviewer_user_id, reviewer_github_id, acting_as, guild_key, skill_book_id)` 的列 → `released`，`reviewer_not_eligible`。職位卸下、退出公會、技能書任命被撤回、帳號或管理員停用、GitHub 連結換了、儲存庫改到別的公會或別的技能書，都走這裡。若 GitHub 請求狀態是 `requested`，改成 `removing`。
4. 這位審查者在認領的 `created_at` 之後送出 `APPROVED` 或 `CHANGES_REQUESTED`（任何提交都算）→ `completed`，`review_submitted`。同一筆交易裡，符合條件的公會長認領會嘗試歸屬（見上一節）。`COMMENTED` 不結束認領。這也不等於拉取請求已核准。

`end_reason` 還有畫面用的 `self_released`（本人放棄認領）和 `admin_released`（管理員已釋放）。不再使用 `reviewer_inactive` 與 `reviewer_rank_too_low`。

離開 `active` 的認領會立刻 `rederivePull`，所以管理頁在同一筆交易裡看得到新的佇列狀態。認領 API、指派、釋放、暫停與恢復也走同一條。

暫停一筆拉取請求不會放開它的認領。佇列會顯示暫停；恢復之後若認領還在，而且推導結果回到 `awaiting_review`，可再蓋成 `in_review`。

公會職位、成員關係、管理員與 GitHub 連結的變更發生在這個模組外面，不會來改維護者的表。一次成功且清單沒被截斷的儲存庫掃描結束時，會把該儲存庫未關閉、`recheck_at` 仍是空的拉取請求設成現在，讓接下來的 tick 用視圖重算（只讀資料庫，不打 GitHub，每次最多 100 筆）。這樣職位變更之後，過期的「已核准」最多隔一次掃描間隔。認領不靠這個：每分鐘的第 3 步都會看視圖。

### 公會長與技能書維護者

會員路由掛在 `/api/v1`，和公會工作區一樣，走 session、Origin 與 CSRF。寫入用 `command()`：要 `Idempotency-Key`，改既有列要 `If-Match`。`40P01` 回 409 `maintainer_write_conflict`。

不是現任公會長（職位加上有效成員），也沒有任何有效的技能書任命，回 403 `review_access_required`。現任公會長看得到自己負責的公會，以及沒有公會且已開放認領的拉取請求。只靠技能書任命的人，只看得到 `skill_book_id` 是自己被任命的書的拉取請求，不管那個儲存庫屬於哪個公會、有沒有開放。同時是公會長和技能書維護者的人，看到兩邊的聯集。看清單不需要 GitHub 連結，和公會長一樣；認領需要，因為認領選項來自資格視圖。其他的回 404 `maintainer_pull_not_found`，不透露別的公會有沒有這筆。技能書維護者不能改歸屬、指派、暫停或設定。審完不會把儲存庫歸到公會。

公會工作區用 `can_review_pulls` 決定要不要顯示「PR 審核」。現任公會長，或至少有一筆有效的技能書任命，就是 true。這不看 `managed_books`，也不看技能書編輯的開發公會門檻。

| 方法與路徑 | 主體與結果 |
| --- | --- |
| `GET /guild-reviews?queue=&limit=&offset=` | queue 為 `awaiting_review`、`in_review`、`mine`、`ready`、`open`。回 `{guilds, skill_books, viewer, items, next_offset}`。沒有 GitHub 連結時 `viewer.reason` 是「請先在會員資料連結 GitHub，才能認領審查。」 |
| `GET /guild-reviews/:pullId` | 與管理端細節相同，但不含 `eligible_reviewers`。另有 `claim_options`（這位會員自己在這個儲存庫的公會長或技能書維護者視圖列，含書名）和 `can_release`。 |
| `POST /guild-reviews/:pullId/claim` | `{acting_as?, guild_key?, skill_book_id?}`，If-Match 是拉取請求版本。201 回細節。只有一個公會時，`{guild_key}` 或空主體都可以。技能書維護者送 `{acting_as: skill_book_maintainer, skill_book_id}`。沒有 GitHub 回 409 `maintainer_claim_identity_required`。看得到但沒有可認領的列，或選不到那一列，回 403 `maintainer_guild_scope`。多個公會卻沒選公會，回 422 `maintainer_guild_required`，句子仍是「你是多個公會的公會長，請選擇審完後要歸到哪個公會。」身分裡含技能書、又超過一個選項卻沒選，同一個碼，句子是「你有多個可以審的身分，請選擇要以哪個公會或哪本技能書認領。」作者本人回 409 `maintainer_claim_author`。已有認領回 409 `maintainer_claim_exists`。 |
| `POST /guild-reviews/claims/:claimId/release` | `{}`，If-Match 是認領版本。只能放棄自己的有效認領，否則 403 `maintainer_claim_not_yours`。`end_reason=self_released`。這筆拉取請求不在可見範圍時回 404 `maintainer_claim_not_found`。技能書維護者即使不是公會長，也可以放棄自己的認領。 |

這個頁面沒有暫停、恢復、重新同步、指派或改歸屬。審查在 GitHub 送出。這項畫面不授予 GitHub 寫入權。

### 要求審查者

沒有另外設定時會請求審查者。三個條件都要成立才寫入 GitHub：

1. 維護者 App 的 Pull requests 權限是 Read & write。App 建立時就包含這項，不必事後重新同意。沒有這個權限時，鑄 token 失敗為 `github_permission_missing`，工作失敗且不重試，認領不受影響。
2. 維護 Worker 的 `GITHUB_MAINTAINER_WRITES` 正好是 `requested_reviewers`。本機 dry-run 的值是 `off`。`staging-next` 與 `next` 是 `requested_reviewers`。沒給、或任何其他字（含大小寫不同）都當成 `invalid`，不會寫。
3. 該儲存庫設定 `request_reviewers`。沒有這個欄位時當成 true。管理員明確設成 false 就維持 false。

GitHub 拒絕（例如 422，因為這個人不是 collaborator）記在認領上，不會擋下認領。

認領或指派時，設定是 true 就把 `github_request_state` 設成 `pending` 並排入 `request_reviewer`；否則是 `not_requested`，不排工作。工作執行當下會再讀這三個開關。請求工作在狀態仍是 `pending` 時，不允許就標 `skipped`（`writes_disabled`），不呼叫 GitHub。認領已經不是 active、但狀態仍是 `pending`，就標 `skipped`（`claim_inactive`）。狀態已經不是這次工作預期的 `pending`（請求）或 `removing`（移除）時，不更新那一列，工作以 `claim_state_changed` 結束。這樣重跑不會把已經 `requested` 或 `removed` 的列改成 `skipped`。

允許時，只為那一個儲存庫鑄 `{ metadata: read, pull_requests: write }` 的 token，然後 `POST` 或 `DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers`，body 是 `{ "reviewers": ["<認領列上的 reviewer_login>"] }`。不碰其他人，也不碰 team reviewer。POST 201 是 `requested`，DELETE 200 是 `removed`。成功只看狀態碼；回應正文可能是整份拉取請求，超過 64 KiB 也不當成錯誤，因為 GitHub 已經套用，重試會再寫一次。

422、沒有速率限制標頭的 403，或 token 沒有 pull_requests write，標 `failed` 且不重試。鑄 token 時的 403（無速率限制標頭）或 422 同樣標 `github_permission_missing`，不重試。速率限制、預算與時間沿用既有規則：放回工作、不計入這一次嘗試。Login 只是顯示用，改名之後可能過期；422 可以是這個人不是 collaborator，或 login 已經改了。

認領若在 POST 回來之前被放開，工作不握著列鎖。201 之後再鎖一次認領：仍是 active，或結束原因是 `pull_closed`，就標 `requested`。GitHub 會在這個人送出審查之後清掉請求；拉取請求關閉時，請求留在原處，維護者也留著，不另外移除。其他結束原因改成 `removing` 並排入 `remove_reviewer_request`，避免放開之後 GitHub 上還留著請求。

### 在畫面上暫停一筆

後台「PR 審核」打開該筆，填理由後按「暫停」。這把該筆的 `paused` 設成 true，並把 `aggregate_version` 加一，不改儲存庫模式，也不放開認領。已經暫停再暫停回 409 `maintainer_pull_already_paused`；沒有暫停卻恢復回 409 `maintainer_pull_not_paused`。即使佇列狀態不變（例如已合併或已關閉），版本也會增加，舊的 If-Match 得到 412。恢復時再填理由。儲存庫整個關掉仍用模式 `off`。模式 `off` 的拉取請求不能認領或指派，跟單筆暫停一樣回 409 `maintainer_claim_unavailable`。

## 暫停

任選一種，效果由快到慢：

1. 在管理 API 把儲存庫 `mode` 設成 `off`。Webhook 改記 ignored，tick 不再掃這個儲存庫，也不跑它的 `reconcile_pull`。已經排進去的 `request_reviewer` 與 `remove_reviewer_request` 仍會跑，因為那是人認領之後的寫入，跟觀察模式無關。請求工作在三個開關沒開時標 `skipped`，不會呼叫 GitHub。移除工作在開關關掉時標 `failed`（`writes_disabled`），因為 GitHub 上可能還留著請求。單筆暫停用上一節，不需要把整個儲存庫關掉。
2. 刪掉平台 Worker 的 `GITHUB_MAINTAINER_WEBHOOK_SECRET`。Webhook 回 503，已經在佇列裡的工作仍會跑。
3. 在 Cloudflare 停掉這支 Worker 的 cron。
4. 刪掉維護 Worker。刪的是 `freedom-maintainer-staging-next` 或 `freedom-maintainer-next`，不是平台 Worker。

```sh
npx wrangler delete --config <maintainer-overlay.jsonc> --env staging-next
npx wrangler delete --config <maintainer-overlay.jsonc> --env next
```

## 資料保留

每次 tick 會刪掉 30 天前的 webhook 投遞，以及 14 天前已結束（done、failed、cancelled）的工作。拉取請求鏡像、歸屬變更與儲存庫列不會因這個期限被刪。投遞表只存正規化欄位與 body 的 sha256，不存 payload。Token 與私鑰不進資料庫。

## 已知限制

- 遷移目錄的 contents 回 404 視為那個目錄不存在（空的 base 清單），不是儲存庫消失。拉取請求本身 404 或 410 才會把工作標成 `github_not_found` 並要求安裝同步。
- 安裝清單 `GET /app/installations` 用 App JWT。想要的組織 installation 若 `suspended_at` 有值，不鑄 token、也不列儲存庫，並計入 `suspended_installations`；這次清單若完整，它名下已登錄的儲存庫會標成 removed。GitHub 的 `installation` unsuspend 會排下一次安裝同步，同步後再標回 active。沒有停權的 installation 鑄一張只有 `{ permissions: { metadata: "read" } }` 的 token，不帶 `repository_ids`、也不帶 `repositories`，再用這張 token 呼叫 `GET /installation/repositories`。掃與 reconcile 另鑄 token，權限是 metadata、pull requests、checks、statuses、contents，全部 read，並帶該儲存庫的 `repository_ids`。
- 變更檔案最多讀 10 頁，也就是 1000 個檔。清單被截斷，或 GitHub 回報的 `changed_files` 多於實際列到的檔案時，加上注意事項 `changed_files_truncated`，鏡像仍會寫入。審查與 check run 碰到頁數上限則會重試，不會把不完整的清單當成完整結果。
- `is_fork` 只看 head 是不是這份 base：`head.repo` 為 null，或 `head.repo.id` 不等於 `base.repo.id`。`head.repo.fork` 只表示那個儲存庫本身另有上游，不用來判斷這次拉取請求。
- freedom-platform 的驗證路徑另外包含 `repositories.lock.json`、`.npmrc`、`.gitattributes` 與 `.gitmodules`。測試檔在 `tests/` 裡改名，或檔名仍是 `*.test.*` / `*.spec.*`，不算 `test_removed`。離開測試路徑，或拿掉測試檔名，才算。刪除測試檔會留下 `test_removed`。
- 注意事項依檔案列出的順序，以及規則寫下的第一條相符順序。文件、一般程式、產生檔、點陣圖和沒有對上規則的路徑不產生注意事項。超過 20 個檔案或 800 行是 `size_large`；超過 60 個檔案或 3000 行是 `size_huge`。`changed_files_truncated` 放在最後。列表上的「下一步」是佇列原因的第一句，不是注意事項。
- 遷移編號撞到 base 上已有的檔案是 `migration_number_collision`。編號小於 base 目前最新、但那個編號並不存在（中間有空號）是 `migration_number_behind`。兩種都會停在 needs_author。訊息裡的分支名是這次拉取請求的 base ref，預設儲存庫不一定是 `main`。這些原因另外寫在 `migration_reasons`。模式改成關閉再改回觀察時，佇列會先暫停，再依這欄回到 needs_author，不必再打 GitHub。
- 同一個拉取請求已經有排隊中的 `reconcile_pull` 時，新的 webhook 或管理員重新同步不會再插一筆。若那筆的 `run_after` 比這次更晚，會把 `run_after` 提前，嘗試次數不變；沒有更晚可提前時，這次不算新排入。
- 只有精確的 `POST /api/v1/maintainer/github/webhook` 在會員驗證之前執行，不需要 session。同一個路徑的 GET 走一般會員驗證，沒有 cookie 時回 401 `login_required`。
- 沒有 SLA，也沒有 `sla_due_at`。`recheck_at` 只用於 CI 寬限，以及歸屬或掃描之後要重算的拉取請求。
- 必要檢查只有 `success` 與 `neutral` 算過。`skipped` 算失敗。`action_required` 是 `ci_not_run`，請人去 GitHub 核准 workflow。狀態還不是 `completed` 時（queued、in_progress、waiting、requested、pending）視為還在跑，是 `waiting_ci`。
- GitHub 不限制檢查名稱與 status context 的長度。過長的字串先截成 200 個碼位再存，標籤名稱截成 100 個碼位。同名的 check run 留 id 較大的那一筆。combined status 以 `per_page=100` 讀取。
- GET 沿用既有的 `readGitHub`，User-Agent 仍是 `Freedom-Platform-public-registry`。鑄 token 的 POST 使用 `Freedom-Platform-maintainer`。
- 一次 tick 最多 60 個 GitHub 請求、50 秒。速率限制會寫上該 installation 所有儲存庫的 `rate_limited_until`（1 分鐘到 1 小時），並放回工作、不計入這一次嘗試。
- 資料庫必須恰好有一個社群，否則 tick 失敗。Hyperdrive 必須 caching disabled，而且一個資料庫一份設定。列租約用單次 `UPDATE ... FOR UPDATE SKIP LOCKED`，不使用 session advisory lock，避免 transaction 模式的連線池把鎖留在別的連線上。
- 安裝清單或儲存庫清單若被頁數上限截斷，不會把沒出現的儲存庫標成 removed。Open PR 清單被截斷時，仍排新的、有變的，以及最多 20 筆已列出的舊鏡像，但不把沒出現的視為已關閉。
- 認領當下看的是資格視圖。之後職位、成員、管理員或 GitHub 連結變了，下一次 tick 的第 3 步會以 `reviewer_not_eligible` 放開。佇列上的「已核准」則要等成功掃描把 `recheck_at` 設上，再由後續 tick 重算，而且每次最多 100 筆。
- 寫入順序一律先鎖拉取請求列，再鎖認領列。釋放認領先讀認領取得 `pull_id`（不鎖），再鎖拉取請求，然後才鎖認領並重查 `active` 與版本。Tick 結束認領時先依 `pull_id` 鎖住候選拉取請求，再更新認領；歸屬那一步接著鎖儲存庫列，再鎖其他未關閉的拉取請求。管理員改歸屬是先鎖儲存庫、再鎖拉取請求。這兩種順序相反，同時發生時 PostgreSQL 可能回 `40P01`。Tick 碰到 `40P01` 仍把那一步重試一次。API 不重試，把 `40P01` 回成 409 `maintainer_write_conflict`；交易已回復，用同一個 Idempotency-Key 再送是安全的。
- 認領上的 login 是快照。人在 GitHub 改了 login 之後，資格仍用數字 id 比對，所以認領不會因此被放開；請求審查者那次 POST 可能得到 422。
- 兩個公會的公會長在同一輪完成開放儲存庫的審查時，只有 `pull_id` 排序較前的那筆歸屬成功。後一筆的條件更新對不上列，儲存庫留在先歸屬的公會。
- 移除請求時若 Worker 變數或儲存庫設定已經關掉，認領標 `failed`（`writes_disabled`），工作失敗。GitHub 上可能還留著這位 requested reviewer。要清掉就得把三個開關打開再跑，或到 GitHub 上手動移除。
- `requested_reviewers` 欄位只鏡像使用者（`id` 與 `login`），給畫面與生命週期用。`requested_teams` 不存。這欄不是審查證據。
