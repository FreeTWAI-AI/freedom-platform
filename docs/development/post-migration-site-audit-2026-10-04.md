# 移植後網站檢查與登入恢復修正

2026-10-04。來源基底為已合併 #108 的 `main`／`a8aea1f`；本輪以獨立分支 `fix/post-migration-site-audit-20261004` 接續[移植後計畫](../platform-plan/execution/unified-foundation/post-migration-plan-2026-10-04.md)的網站穩定性與 P0 查核。此文件記錄本輪實跑結果，不代表部署或全部 P0–P3 完成。

## 已重現及修正

- **舊請求把新登入登出**：同一頁面先失效或登出，再登入另一帳號，舊通知／工作請求才回傳 401 或 Access HTML 403。原本會清除新 CSRF、觸發登出。PortalClient、管理端、頭像／海報／影片／活動集錦上傳現在只讓請求所屬的登入狀態接收認證更新。
- **逾時後仍改登入狀態**：請求已超過期限，但延遲抵達的 401 仍會觸發登出；現在逾時請求不再更新認證狀態。舊 session 的成功回應也不會清除新 session 的 Access 過期提示。
- **舊工作頁回呼再次登出**：只保護 API client 不足以處理工作 mutation 的 `onSessionExpired`。瀏覽器已實際重現：舊工作認領延遲回傳 401，經舊 Workspace 回呼仍會清掉新登入。入口現在依既有 session generation 拒絕這類舊回呼。
- **海報解碼跨帳號**：`createImageBitmap` 完成前若換帳號，原本會拿新帳號 CSRF 送出先前選取的檔案。現在在送出前核對原登入，狀態已變更就停止，且釋放 bitmap。

真正的當前 session 401 仍清除登入；CSRF、Origin、伺服器到期時間和外部 GitHub 權限沒有放寬。不自動重送 mutation，也沒有加入 Passkey 或延長現有八小時 session。

## 正式站與備份查核

於本輪 17:24–17:36 UTC 讀取：

| 項目 | 實際結果 |
| --- | --- |
| 正式首頁／health | 200；health 為 `ok`，runtime `9cc283c6976a920b5f481ec605a7f468044e3a1b` |
| Staging 未授權入口 | 302，仍經 Access 保護 |
| 正式頁面 Chromium | 1366／390／320px 登入入口可用，無水平溢出、無 pageerror；未登入 `/session` 401 為預期 |
| 正式／staging 備份服務 | 最近執行 exit 0，兩個 timer 均保留 |
| Credential renewal | 最近執行 exit 0，既有 timer 保留 |
| 正式最新 archive | 4,958,046 bytes；完整 SHA-256 符合 sidecar；離線 `pg_restore --list` 成功，1,616 entries |
| Staging 最新 archive | 1,381,487 bytes；完整 SHA-256 符合 sidecar；離線 `pg_restore --list` 成功，1,616 entries |
| Retention | 兩環境當時各有 14 份 archive |

上述是可讀性／完整性檢查；本輪沒有宣稱異地副本、同 snapshot 摘要或獨立新庫恢復已完成。這些仍依 P0 計畫接續。正式會員資料未更動，測試使用專用 localhost PostgreSQL／隔離 schema；Private AI、broker、machine、非 legacy 媒體 policy 沒有啟用。

## 會員回報的現況

[登入摩擦 #107](https://github.com/FreeTWAI-AI/freedom-platform/issues/107) 同時提出裝置生物辨識需求。本輪修復已確認的登入競態；不能推定所有登入抱怨由此造成，也不把本輪當作 Passkey 完成。

[技能書 Star #109](https://github.com/FreeTWAI-AI/freedom-platform/issues/109) **仍未解決**。本輪以新庫唯讀 backup role、`BEGIN READ ONLY` 查詢限定七日的診斷彙總，Star endpoint 有 6 次 `github_permission_required`／403，涉及 2 位會員，最近一次為 15:57:28 UTC。只讀取彙總數，不輸出會員識別、tokens 或 provider 回應內容。

GitHub `/apps/{slug}` 回讀顯示兩個工坊 App 均已宣告 `starring:write` 與 `metadata:read`；其中一個另有 `issues:write`。組織 installation 未停用，repository selection 為 all。這不能證明每位會員的現行授權及每個外部原作 Repo 都可寫入；下一步需要受影響會員重新授權後的真實結果，或與該次 GitHub 請求相符的 provider 診斷。不能以重試、代用操作者 token 或模擬成功關閉 Issue。本輪未替會員執行 Star／取消 Star。

## 驗證

單元測試：`tsx --test tests/runtime/portal-client-recovery.test.ts tests/runtime/media-session-recovery.test.ts tests/runtime/admin-access-session.test.ts`，50／50 通過。新增的四個 PortalClient 反例先在修正前失敗，再於修正後通過；Workspace 舊 mutation 回呼也先以瀏覽器重現失敗。

`npm run typecheck`、`npm run build` 通過。Build 仍提示既有 JavaScript chunk 大於 500 kB；本輪沒有做 bundle 拆分。

最終瀏覽器驗證 **53／53 通過（1.3 分鐘）**，涵蓋登入／註冊、工作交付與驗收、合作紀錄、換帳號延遲回應、桌機與手機導覽、名片頭像、活動與集錦、GitHub 卡片、通知／私人訊息、定位保存恢復、管理端與憑證面板。所有資料均為隔離環境的合成案例；GitHub 操作使用明示 fixtures，不能當作真人 GitHub 成功證據。

```sh
# TEST_DATABASE_URL 必須是隔離的本機測試 DB；本輪使用 127.0.0.1:55434。
FREEDOM_E2E_PORT=4344 npm run test:e2e -- \
  tests/e2e/session-recovery.spec.ts tests/e2e/journeys.spec.ts \
  tests/e2e/avatar.spec.ts tests/e2e/events-past.spec.ts tests/e2e/event-highlights.spec.ts \
  tests/e2e/admin.spec.ts tests/e2e/admin-credentials.spec.ts \
  tests/e2e/audit-shell.spec.ts tests/e2e/navigation-audit.spec.ts \
  tests/e2e/github-social.spec.ts tests/e2e/onboarding-recovery.spec.ts \
  tests/e2e/member-settings-real.spec.ts
```

整合測試期間曾發現新案例依賴被前一個 journey 消耗的示範工作，已改為每次建立自己的一張合成工作；另一次誤啟動重疊 E2E 被占用埠拒絕，以及一次本機測試 DB 連線逾時。這些不列為通過；確認資料庫可用後，以單一 worker 完整重跑得到上述 53／53 結果。

其他首頁／側欄／聊天與名片 PR 保留原負責分支處理。本輪修復未部署；線上仍以 health 的 release SHA 為準。合併時若 inventory 衝突，依實際整合樹重跑 `python3 scripts/update-inventory.py`，不得沿用另一分支的舊 hash。
