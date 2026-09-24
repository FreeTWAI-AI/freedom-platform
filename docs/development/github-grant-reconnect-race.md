# 開發授權與 GitHub 重新連結的競態

2026-09-24 稽核（分支 `audit/grant-race-20260924`，基於 `7951780`）。這是 migration030／`DevelopmentAccess` 既有的競態，**不是** migration034 造成的回歸。

## 範圍與界線

- 受影響的是[公會開發資格](guild-development-access.md)的平台內權限：發 `fpd_` 開發憑證、瀏覽器私人提案、Agent 私人提案端點（`/development-agent/v1/proposals`）。
- 這些權限只是「在平台存一份私人提案」。它們不是 GitHub collaborator／team 權限，也不轉移原作者的 repo 寫入權；GitHub 上的程式寫入仍由會員自己的 GitHub 授權決定。

## 重現的交錯

同一位會員重新連結**同一個** GitHub 帳號（`GitHubSocial.complete` 原地 upsert、`connected_at` 更新），會觸發 migration030 的 `revoke_disconnected_development`，撤銷 grant 並串聯撤銷 key。

修正前：

1. `issueKey`／`saveProposal`／`agent` 取得 user → member-guild 鎖，然後**先讀出未撤銷的 grant 列**（`agent` 也先檢查 key 未撤銷），接著在 `developmentEvidence` 內等待 `github-social/<user>`。
2. 重新連結已排在該鎖前面：它先拿到鎖，upsert 連線，trigger 撤銷 grant 與 key，然後 commit。
3. 等待中的請求拿到鎖後，GitHub 證據（同一 user ID、repo、App、installation）完全相同，於是沿用第 1 步讀到的舊 grant 列：更新 `checked_at`，然後
   - `issueKey`：新增一把 `revoked_at IS NULL` 的 key，指向已撤銷的 grant；
   - `saveProposal`：在撤銷後寫入私人提案；
   - `agent`：用已被撤銷的 key 寫入私人提案。

`disconnect` 和 token 失效刪除連線也使用同一把鎖並撤銷 grant；單純刪除連線時，後續證據檢查會因沒有連線而拒絕。本次實際重現的是同一身分重新連結，因為重新連結後 GitHub 證據仍可能完全相同。

## 修正

- `modules/github-social/service.ts` 匯出 `lockGitHubSocialMember(q,userId)`。`actorLock`、`developmentEvidence` 都改用它，鎖的名稱只定義一次。
- `DevelopmentAccess.authorizeGrant` 會先取得這把鎖，才讀 prerequisites 與 grant。`agent` 則先取得鎖，才檢查 key 是否撤銷。
- 鎖順序維持 user → member-guild → github-social → grant 列。沒有在 social 之前鎖 grant 列。同一 transaction 內重複取得 advisory lock 是可重入的，所以 `developmentEvidence` 再取一次沒有問題。
- 其他路徑的檢查結果：
  - `activate` 讀 grant 前已經透過 `developmentEvidence` 持有 social 鎖，而且讀的是鎖後最新的連線，所以正確。
  - `consent`、`revoke` 不讀 GitHub 狀態，靠 member-guild 鎖和 `issueKey`／提案互相排序。
  - `status` 是唯讀。

## 證明

`tests/runtime/development-access-grant-race.test.ts` 使用真實 PostgreSQL 與獨立 schema，所有 GitHub 呼叫都是合成資料（同一 user ID 42）。流程如下：

1. 先取得待用的 OAuth state。
2. holder transaction 持有 `github-social/<user>`。
3. 送出重新連結的 callback，用 `pg_stat_activity`／`pg_blocking_pids` 確認它在 advisory lock 上被 holder 擋住。
4. 再送出等待的寫入，確認它在同一把鎖上，同時被 holder **和**重新連結擋住（FIFO 排在後面）。
5. 放開 holder。

所有 barrier 都以鎖狀態判斷，不靠 sleep 猜時序。等待中的 promise 一律會被收回，holder 一律 rollback 並釋放，`after` 會刪除 schema。

三個案例：key 發放、瀏覽器提案、Agent 以既有 key 提案。預期結果：重新連結成功，grant 以 `github_connection_changed` 撤銷，請求被拒（`development_grant_required`／`development_key_revoked`），不產生新 key 或提案，既有 key 維持撤銷。

| | 修正前（`7951780`） | 修正後 |
| --- | --- | --- |
| key 發放 | 請求成功；多一把 `revoked_at IS NULL` 的 key 指向已撤銷的 grant（之後使用仍被 grant 檢查拒絕） | 拒絕 `development_grant_required`；沒有新 key |
| 瀏覽器提案 | 請求成功；寫入 1 筆提案 | 拒絕 `development_grant_required`；0 筆 |
| Agent 提案 | 請求成功；以已撤銷的 key 寫入 1 筆提案 | 拒絕 `development_key_revoked`；0 筆，重試仍然拒絕 |
| 既有 key | 維持撤銷（沒有復活） | 維持撤銷 |

修正前三個案例都失敗在「請求不應成功」的斷言上，barrier 都有成立。

## 命令

```sh
npx tsx --test --test-concurrency=1 tests/runtime/development-access-grant-race.test.ts \
  tests/runtime/development-access.test.ts tests/runtime/github-identity.test.ts \
  tests/runtime/github-social.test.ts tests/runtime/github-social-routes.test.ts \
  tests/runtime/github-social-store.test.ts
npm run typecheck
```

2026-09-24 本機結果：

- 修正前：競態測試 3 個案例全部失敗。
- 修正後：上列 50 個測試全部通過；競態測試另外重跑 5 次，每次 3/3 通過。
- `tsc --noEmit` 無錯誤。
- 沒有殘留的 `fp_grant_race_*` schema。

未執行：E2E、全套 `npm test`、contracts、repos（依本輪指示只跑相關測試）。
