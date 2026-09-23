# GitHub 指標與站內 Star

技能書讀取原作者 Repo 的 Stars、Forks、追蹤人數、未結 Issues／PR 合計及最近程式推送時間。原作和工坊副本的 Fork 入口分開；點 Fork 仍由 GitHub 選擇擁有者與建立副本。`open_issues_count` 包含 PR，不能標成單純 Issue 數；`subscribers_count` 才是追蹤數，不使用與 Star 重複的 `watchers_count`。

GitHub 數據每小時快取，附核對時間；讀取失敗保留舊快照並標示，從未取得的數值是 null。公開 HTML 技能書只讀已存快照，不呼叫外部服務、不讀會員授權，資料庫暫時不可用時仍提供完整介紹。React 卡片只在可見時讀取，重複卡片與介紹共用讀取結果。

會員按「連結 GitHub 後 Star」，到 GitHub 同意後回到工坊。連結本身不會加星；接著按 Star 或取消 Star，才使用該會員的 user access token 修改原作。收到 GitHub 204 後才顯示成功，數量由 GitHub 重新讀取，不自行加減。自填 GitHub slug 不當作身分證明，連結不修改平台登入、會員權限或聯絡方式公開範圍。

## 初次啟用

1. 操作端在 public／staging 的私有環境各設定 `GITHUB_SOCIAL_TOKEN_KEY`：32 bytes 隨機值的標準 base64。保留金鑰以供資料庫還原；不寫進 repo、瀏覽器或日誌。
2. 套用 migration018、019，部署這個版本。既有 Access 後台權限不變。
3. 管理員開 `/admin` →「GitHub 連結」→「建立 GitHub App」。以 FreeTWAI-AI 組織擁有者身分，在 GitHub 按 Create GitHub App；回到工坊完成設定。這是一次性的外部帳號操作。
4. App 只申請 `starring:write`（以及 GitHub 隱含的 metadata read），不申請 repository content write、Issue、PR、Email、組織或管理權限。Webhook 關閉、沒有事件訂閱；每個環境使用自己的 App 與回呼。
5. 會員在自己的名片或技能書連結 GitHub，再按 Star。不能用管理員或伺服器的 GitHub CLI token 代替會員授權。

後台透過 GitHub 的 manifest flow 產生設定；回呼受 Access、管理員 CSRF、管理員綁定的短效 state 保護。Server 交換代碼，驗證擁有者、站點及權限後加密保存 client secret。PEM、webhook secret 不保留。成功 receipt 可安全重讀；提供者失敗不顯示完成。若 GitHub 已消耗代碼而設定未收到，需重新建立 App；不以另一個 App 覆蓋既有連結。

OAuth 採 PKCE 與單次 state，綁定同一工坊 session，回到 `/github/callback` 後由同源 POST 完成交換，因此不降低既有 Strict cookie。Token 與 refresh token 在 DB 中以 AES-256-GCM 加密，綁定 App／社群／會員。更新 token 時重驗 GitHub user ID。只有伺服器使用憑證，API／稽核不輸出秘密。

「我的名片」可解除連結。工坊立即移除本地憑證，並嘗試撤銷 GitHub token；若 GitHub 撤銷失敗，畫面會保留前往 GitHub 授權設定的入口。停用會員或撤銷 session 後，舊請求不能操作 Star。Star 不產生 XP、名聲或職務認證。

## API

這些是會員 Beta 的附加 API，未假稱已加入固定的 preview SDK bundle。

| 路徑 | 用途 |
| --- | --- |
| `GET /api/v1/github/books/:id/metrics` | 公開的目錄原作數據；只接受收錄的技能書 ID |
| `GET /api/v1/me/github` | 自己的連結狀態與已驗證 GitHub username |
| `POST /api/v1/me/github/connect` | `{return_to:"#community"}`；產生授權連結 |
| `POST /api/v1/me/github/complete` | `{state,code}`；交換授權，無自動 Star |
| `GET /api/v1/me/github/books/:id/star` | 自己是否已 Star |
| `POST /api/v1/me/github/books/:id/star` | `{starred:true|false,confirmed:true}`；明確設定狀態 |
| `POST /api/v1/me/github/disconnect` | `{}`；移除自己的連結 |
| `GET /admin/api/github-app` | 管理員查看 App 是否完成設定 |
| `POST /admin/api/github-app/start` | `{}`；建立單次設定 manifest |
| `POST /admin/api/github-app/complete` | `{state,code}`；完成設定，憑證不回傳瀏覽器 |

所有會員操作須既有 session、同源與 CSRF，且完成定位。GitHub API 僅使用固定 host／路徑、timeout、回應大小上限與併發限制；公開數據依原作座標共用快取。失敗不推定為未加星或零人氣。

## 驗證

Runtime 測試使用隔離 PostgreSQL 與合成提供者，覆蓋真實路由、session／state 隔離、加密、刷新、設定重試與拒絕過度權限。UI 測試驗證按鈕、數據、錯誤、跨帳號清理、解除連結和 manifest 表單。實際 GitHub 授權／Star 需要 App 已建立及本人同意，不能用 mock 通過冒稱真實授權已完成。

官方規格：[GitHub Starring API](https://docs.github.com/en/rest/activity/starring)、[GitHub App user token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)。
