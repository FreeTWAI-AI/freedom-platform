# GitHub 指標與站內 Star

技能書讀取原作者 Repo 的 Stars、Forks、追蹤人數、未結 Issues／PR 合計及最近程式推送時間。原作和工坊副本的 Fork 入口分開；點 Fork 仍由 GitHub 選擇擁有者與建立副本。`open_issues_count` 包含 PR，不能標成單純 Issue 數；`subscribers_count` 才是追蹤數，不使用與 Star 重複的 `watchers_count`。

GitHub 數據每小時快取，附核對時間；讀取失敗保留舊快照並標示，從未取得的數值是 null。Cloudflare Workers 的出口 IP 由多個服務共用，GitHub 未驗證請求的每 IP 額度（每小時 60 次）實際上已被用完，所以雲端環境另設 Worker secret `GITHUB_METRICS_TOKEN`：只讀公開 Repo、不給任何權限的 fine-grained token，只用於讀這些公開數據，不代替會員操作 Star。GitHub 拒絕這個 token 時，本次改用未驗證請求並記錄 `github_metrics_token_rejected`；沒有設定時一律用未驗證請求。GitHub App 的 client ID／secret 不能提高這個額度（GitHub 回 401）。公開 HTML 技能書只讀已存快照，不呼叫外部服務、不讀會員授權，資料庫暫時不可用時仍提供完整介紹。React 卡片只在可見時讀取，重複卡片與介紹共用讀取結果。

星星圖示與數量是同一個操作入口。尚未連結的會員點星星，到 GitHub 同意後回到工坊；連結本身不會加星。連結後按空心星星加星、實心星星取消，才使用該會員的 user access token 修改原作。Fork 圖示與數量連到原作的 Fork 入口，來源與其他數據可展開查看。收到 GitHub 204 後才顯示成功，數量由 GitHub 重新讀取，不自行加減。自填 GitHub slug 不當作身分證明，連結不修改平台登入、會員權限或聯絡方式公開範圍。

## 公開介紹頁的操作入口

公開 `/development/skills/:id` 的 Stars、Forks、Watch 數字都是操作入口，會員介紹視窗也保留 Fork 連結。登入且已連結 GitHub 的會員可直接在介紹頁 Star／取消 Star；尚未連結時走原有 OAuth，完成後回到同一本書，再由本人按 Star。允許的返回值只有原有工坊 hash 或目錄中精確的技能書路徑，外部網址、查詢參數、未知書目與路徑穿越都拒絕。

HTML 仍只包含公開快照；獨立的 `assets/skill-social.js` 在訪客瀏覽器內讀自己的 session，重用會員書架的 GitHub 元件和 API。未登入、停用 JavaScript 或讀取 session 失敗時保留原作連結；GitHub 權限不足也顯示前往原作 Star 的替代入口。伺服器的 `no-store` 同樣適用此固定名稱的 script，不把舊入口長期快取。

Fork 連到原作 `/fork`，由本人在 GitHub 選擇擁有者與確認建立。Watch 連到原作頁，使用 GitHub 的 Watch 選單設定通知；`subscribers_count` 是專案追蹤數，不是作者粉絲數。Follow 原作者另連作者帳號頁。這些入口不假稱已建立 Fork 或已追蹤，也不新增 App 權限。GitHub 操作說明見 [Watch 通知設定](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)。

## 初次啟用

1. 操作端在 public／staging 的私有環境各設定 `GITHUB_SOCIAL_TOKEN_KEY`：32 bytes 隨機值的標準 base64。保留金鑰以供資料庫還原；不寫進 repo、瀏覽器或日誌。
2. 套用 migration018、019，部署這個版本。既有 Access 後台權限不變。
3. 管理員開 `/admin` →「GitHub 連結」→「建立 GitHub App」。以 FreeTWAI-AI 組織擁有者身分，在 GitHub 按 Create GitHub App；回到工坊完成設定。這是一次性的外部帳號操作。
4. App 明確申請 `starring:write` 與 `metadata:read`，並在建立完成時驗證兩項都存在。公開專案可讀不代表 Star 寫入具備所需權限；不能以隱含讀取取代 manifest 的 Metadata 權限。不申請 repository content write、Issue、PR、Email、組織或管理權限。Webhook 關閉、沒有事件訂閱；每個環境使用自己的 App 與回呼。
5. Repo 擁有者從後台的「安裝到技能書 Repo」入口安裝 App，只選擇技能書對應的原作 Repo。原作在其他人的帳號時，要由該擁有者授予 Repo 存取；會員連結 GitHub 不等於 App 已安裝到原作。
6. 會員在自己的名片或技能書連結 GitHub，再按 Star。不能用管理員或伺服器的 GitHub CLI token 代替會員授權。

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

## Star 權限錯誤

`github_permission_required` 代表 GitHub 拒絕這次存取，不能顯示成暫時斷線或保證稍後重試會成功。先檢查 App 的 Starring 寫入、Metadata 讀取及目標專案存取；後台提供權限設定入口。舊版 manifest 只申請 Starring，既有 App 需由擁有者在 GitHub 修改；部署新程式不會自動更動外部 App。若 GitHub 要求更新安裝或會員授權，須完成該流程再驗證。

App 已連結只代表設定已保存。讀取星數、OAuth 回呼及單元測試通過，都不代表對原作者專案的實際 Star 寫入已通過。修正外部權限後，應由本人對選定的技能書操作並核對 GitHub 回應；不改用管理員 token，也不悄悄擴大到 OAuth `public_repo` 或程式碼寫入權限。

## 驗證

Runtime 測試使用隔離 PostgreSQL 與合成提供者，覆蓋真實路由、session／state 隔離、加密、刷新、設定重試與拒絕過度權限。UI 測試驗證按鈕、數據、錯誤、跨帳號清理、解除連結和 manifest 表單。實際 GitHub 授權／Star 需要 App 已建立及本人同意，不能用 mock 通過冒稱真實授權已完成。

官方規格：[GitHub Starring API](https://docs.github.com/en/rest/activity/starring)、[GitHub App user token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)。
