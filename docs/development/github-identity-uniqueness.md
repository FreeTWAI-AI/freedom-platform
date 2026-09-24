# GitHub 身分唯一性

一個 GitHub 帳號（以 GitHub 回傳的穩定數字 user ID 判定）在整個平台只能連結一位工坊會員，跨社群也一樣。GitHub username 可改名、email 未驗證，兩者都不當作身分鍵。這是 [FND-03](../platform-plan/execution/specs/FND-03.md) 所要求 `provider+subject` 唯一的 GitHub 子集；它仍不是登入 adapter，也不是完整的 `ExternalIdentity`。

## 行為

- 資料庫：`migrations/034_github_identity_unique.sql` 在 `github_social_connections.github_user_id` 加上唯一約束 `github_social_connections_github_user_unique`。任何路徑（含直接寫 DB）都不能建立第二筆同一 GitHub user ID。
- 連結流程（`GitHubSocial.complete`）：在會員鎖、單次 state 消耗、換 token、向 GitHub 驗證身分之後，於同一 transaction 取得該 GitHub user ID 的 advisory lock，再檢查是否已由其他會員連結。所有 callback 因此依 GitHub user ID 排序；兩位會員同時連同一帳號時只會一位成功。
- 衝突回 `409 github_identity_already_linked`：「這個 GitHub 帳號已連結另一個工坊帳號。請先從原本的工坊帳號解除連結，或改用其他 GitHub 帳號。」訊息不含對方會員 ID、email、名稱，也不回顯 GitHub user ID 或 username。現有 GitHub callback 畫面直接顯示此訊息。
- 衝突時：
  - 已使用的 OAuth state 照常消耗並提交，重送得到 `github_oauth_expired`。
  - 不覆寫、不移動原擁有者的連線與 token，也不呼叫 GitHub 撤銷授權（同一 GitHub App 授權可能就是原擁有者正在使用的 token）。
  - 申請者原本已連的其他 GitHub 帳號保持不變。
- 最後防線：若有 DB 直接寫入繞過 advisory lock，插入會碰到唯一約束。服務以 savepoint 只回滾這筆插入，轉成同樣的 409，state 消耗仍提交；不在已中止的 transaction 上假裝 commit。其他資料庫錯誤照常整筆回滾。
- 同一會員重新連結同一 GitHub 帳號（含 username 改名）原地更新，不建立新身分。依 migration030，重新連結會撤銷該會員既有開發資格，需重新啟用。
- 原擁有者解除連結只刪自己的連線；Star 紀錄（`skill_star_support`，以 GitHub user ID 記）與歷史不刪除。之後另一位會員須用自己新發起的 OAuth state 連結；原擁有者的開發資格與衍生 key 已由 migration030 撤銷，不會轉給新會員或復活。

## 升級既有環境

Migration034 先鎖表並統計重複：若有任何 GitHub user ID 對到多位會員，整個 migration 失敗並回滾，錯誤只列重複的 GitHub user ID 數與連線筆數，不列會員資料：

```
github_identity_duplicate: N GitHub user ID(s) are linked to more than one member (M connection rows)
```

Migration 不會自動選擇擁有者、合併或刪除任何連線。操作端需與相關會員確認誰是本人，由其他會員自行解除連結（或經授權的人工修正並留紀錄）後，再重新套用 migration。2026-09-24 主控端唯讀核對 staging 與 public 的重複群數皆為 0（只看總數）；實際套用時仍以 migration 本身的檢查為準。

## 測試

`tests/runtime/github-identity.test.ts`：衝突與隱私、state 消耗與重放、占用帳號時保留原連線、兩位會員同時連結一勝一 409、同人重連與改名、原擁有者解除後他人以新 state 連結且 Star／已撤銷資格不變、DB 約束與繞過鎖的並行直接寫入、migration 對既有重複 atomic 失敗且資料不變（在獨立 schema 先套到 033 再套 034）。
