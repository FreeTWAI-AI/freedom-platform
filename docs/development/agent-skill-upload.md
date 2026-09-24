# Agent 技能草稿上傳

會員可以讓自己的 AI agent 把一個公開 GitHub 技能 repo 整理成 **私人草稿** 並上傳。agent 只能建立和上傳草稿。查看、撤回、公開以及金鑰管理，都只能由會員本人用瀏覽器操作。公開時平台才讀取 GitHub，固定 commit 與授權，關係標示為「自述」，`official=false`。

程式位置：

- 資料表：[`migrations/028_skill_submissions.sql`](../../migrations/028_skill_submissions.sql)
- 規則：[`modules/skill-submissions/`](../../modules/skill-submissions/)（`payload.ts` 驗證與圖片、`service.ts` 狀態與憑證、`public.ts` 公開讀取）
- 路由：[`apps/platform-api/src/routes/skill-submissions.ts`](../../apps/platform-api/src/routes/skill-submissions.ts)
- CLI：[`packages/skill-upload-client/`](../../packages/skill-upload-client/)（[協定](../../packages/skill-upload-client/protocol.md)、[Agent 指引](../../packages/skill-upload-client/SKILL.md)）
- 測試：[`tests/runtime/skill-submissions.test.ts`](../../tests/runtime/skill-submissions.test.ts)、`packages/skill-upload-client/test/`

## 狀態

`awaiting_upload` → `ready_for_review` → `published`；未公開前可轉為 `revoked`。

| 動作 | 誰 | 條件 |
| --- | --- | --- |
| 建立草稿＋一次性授權 | 瀏覽器或 agent 金鑰 | 會員啟用中且完成定位；未公開草稿最多 30 份 |
| 上傳內容 | 一次性授權（`fpg_`） | 只限該草稿、60 分鐘、只能用一次 |
| 重發授權 | 瀏覽器 | 只在 `awaiting_upload`；舊授權立即失效 |
| 撤回 | 瀏覽器 | 未公開；授權同時失效 |
| 公開 | 瀏覽器 | `ready_for_review`、`consent_to_share:true`、`If-Match` 為目前版本 |

## 瀏覽器 API（`/api/v1`，session＋CSRF＋完成定位）

`createSkillSubmissionRoutes(pool, origin)`：

- `GET /me/skill-submissions` → `{items:[submission]}`
- `POST /me/skill-submissions` `{}`＋`Idempotency-Key` → 201 `{submission, upload_grant:{token,expires_at,submit_url}}`；重送回同一份 `submission`，`upload_grant:null`
- `GET /me/skill-submissions/:id` → `submission`（`ETag`）
- `GET /me/skill-submissions/:id/illustration` → 本人預覽 `image/webp`
- `POST /me/skill-submissions/:id/grant` `{}`＋`If-Match`＋`Idempotency-Key` → `{submission, upload_grant}`
- `POST /me/skill-submissions/:id/revoke` `{}`＋`If-Match`＋`Idempotency-Key` → `submission`
- `POST /me/skill-submissions/:id/publish` `{consent_to_share:true}`＋`If-Match`＋`Idempotency-Key` → `submission`
- `GET /me/skill-upload-keys` → `{items:[key]}`
- `POST /me/skill-upload-keys` `{label:1–80字, expires_in_days:1–90（預設30）}`＋`Idempotency-Key` → 201 `{key, token}`；重送 `token:null`；有效金鑰最多 10 把
- `POST /me/skill-upload-keys/:id/revoke` `{}`＋`Idempotency-Key` → `key`

`submission`：`submission_id, status, aggregate_version, payload|null, project_id|null, public_path|null, illustration_url|null, grant_expires_at|null, grant_consumed_at|null, grant_revoked_at|null, created_at, updated_at`。`payload` 不含 `cover_image`，圖片另存並以 `illustration_url` 提供。`grant_expires_at` 同時考慮來源金鑰的到期時間；`grant_revoked_at` 也反映來源金鑰已撤銷。一般回應不會出現授權、雜湊或圖片位元組。

`key`：`key_id, label, scope:'skill:submit', expires_at, revoked_at, created_at, last_used_at`。

## Agent API（`/agent-api/v1`，不經 cookie middleware）

`createAgentSkillSubmissionRoutes(pool, origin, network?)`：

- `POST /skill-submissions`：`Bearer fpk_…`、`Idempotency-Key`、內文 `{}`（≤ 8 KiB）→ 201 草稿＋一次性授權。以金鑰與識別碼寫入 `skill_agent_receipts`，只存中繼資料；重送 `upload_grant:null`。
- `POST /skill-submissions/:id`：`Bearer fpg_…`、完整內容（≤ 800 KiB）→ `{submission_id,status,grant_consumed_at,review_url}`。

其他方法回 405，其他路徑回 404。cookie 與讀取連線 token（`fw_read_`）都不能驗證；金鑰不能直接上傳。

每次請求依序：網路限流（`skill-agent-network`，每小時 120 次；在讀取憑證與內文之前）→ 檢查 `Content-Type`／`Content-Length` → 查憑證雜湊 → 會員限流（`skill-agent-owner`，每小時 60 次）→ 以串流讀取有上限的內文（不依賴 `Content-Length`）→ 在交易外驗證並重新編碼圖片 → 交易內依序鎖定會員（`FOR SHARE`）、原始金鑰、草稿，然後重新檢查。

- 相同內容（NFC、前後空白整理後的 JSON 摘要，加上原始圖片的 SHA-256）以同一授權重送時，回傳相同確認。內容不同回 409 `upload_grant_consumed`。
- 授權過期、被重發或撤回、草稿撤回、原始金鑰撤銷或到期、會員停用（401）或未完成定位（403），重送也會被拒絕。

內容驗證見 CLI 的 [protocol.md](../../packages/skill-upload-client/protocol.md)：剛好 100 則不重複的單行分享介紹；`strict` 物件，不接受 `consent_to_share`、`official` 或會員 ID；示意圖只接受標準 base64 的靜態 PNG／JPEG／WebP，≤ 512 KiB、≤ 4096×4096、≤ 16M 像素。先比對檔頭，再拒絕 APNG 與動態 WebP，由 sharp 以 5 秒上限重新編碼成 1200×630 的 WebP（深色留邊、保留完整構圖），並移除中繼資料。

## 公開流程與重試

`publishSubmission` 在一個 `command()` 交易中完成：鎖住草稿，確認版本、狀態與同意後，才透過 [`importProjectWithinTransaction`](../../modules/opensource-marketing/service.ts) 讀取 GitHub 的公開資料。匯入與公開在同一個交易提交，失敗時兩者一起回滾；同一個 `Idempotency-Key` 重送會直接讀取已提交的 receipt，不會再讀 GitHub。完成後記錄 `project_id` 與當時的 `project_version_id`（固定 commit 與授權），狀態改為 `published`，`public_path` 為 `/development/submissions/<id>`。若會員已手動登錄同一個 repo，就沿用那件作品並補上當下版本，不會覆寫原有的標題與說明。

## 公開讀取（供根路由與頁面使用）

`modules/skill-submissions/public.ts`：

- `listPublishedSkillSubmissions(pool, limit=100)` → `{submission_id,title,description,repository_url,relationship,relationship_verification:'self_declared',official:false,project_id,public_path,illustration_url,share_introductions,source:{repository_full_name,repository_url,commit_sha,license_spdx,license_evidence_url,is_fork,archived},published_at}[]`
- `readPublishedSkillSubmission(pool, id)` → 上述欄位加上 `use_notes`、`demo_url`，找不到時回 `null`
- `readPublishedSkillIllustration(pool, id)` → `{bytes, mime_type:'image/webp'}` 或 `null`

只列出已公開、擁有者仍啟用且完成定位、固定版本仍存在的投稿。不輸出擁有者 ID、email、草稿或授權資料。公開圖片網址為 `/api/v1/skill-submissions/:id/illustration`，由根路由提供。

## 根路由整合注意

- 全站 JSON middleware 必須用 `isAgentSkillUploadPath(method, path)` 跳過兩個 agent POST，避免內文先被讀掉。可另外使用 `checkAgentSkillHeaders`、`agentSkillBodyLimit`、`readAgentSkillSubmissionBody`。
- 建議傳入 `network`（例如 `authNetwork`）。預設值 `'shared-server'` 會讓所有 agent 共用同一個網路限流額度。

## 驗證

```sh
npx tsx --test --test-concurrency=1 tests/runtime/skill-submissions.test.ts
(cd packages/skill-upload-client && npm test)
```
