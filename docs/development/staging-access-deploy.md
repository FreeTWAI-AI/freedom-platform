# Staging：內部預覽與雲端遷移

## 目前可用的入口

<https://staging.freetwai.com>。Cloudflare Access 的真人名單只有 `ted@ted-h.com`。通過 email／OTP 後，可用頁面的三個示範帳號操作會員首頁、定位／公會、供貨、開店、開源、行銷，以及既有工作與合作紀錄；密碼是頁面列出的 `freedom-local-demo`。

```text
瀏覽器 → Cloudflare DNS / HTTPS → Access
       → freedom-staging Tunnel
       → Castle：Node / Hono API + React Portal（127.0.0.1:4310）
       → Castle：freedom_staging PostgreSQL／獨立 role（127.0.0.1:54339）
```

這是內部 staging。程式與資料仍在 Castle；Workers、Hyperdrive、managed Postgres 尚未部署。示範帳號不是自然人；合作／收款回報不是銀行核實，平台不執行付款。

2026-09-23 接手時，DNS 和 Access 已存在，但 Tunnel inactive、DB 停止、接續副本未同步 staging 修正。修復包含恢復資料庫、同步程式、啟動專用 Tunnel、systemd 自動重啟、每日備份與實際備份還原。操作方式見 [staging 運行手冊](staging-operations.md)。

## 實際驗證與限制

- Cloudflare 與 Google 公共 DNS 均可解析；TLS 正常。
- 公共 HTTPS 經 Access 機器身分驗證後可讀健康端點；未驗證訪客會被導向 Access。
- Chromium 經真實 HTTPS／Tunnel 完成示範登入、讀取會員模組與既有工作流程、重整、桌面／手機版與登出；session cookie 使用 Secure／HttpOnly。
- 測試用 Access service token 和 policy 在測試後刪除，真人名單維持只有 Ted。
- 備份實際還原到獨立暫存 DB，沒有覆寫 staging。
- 真人 email／OTP 仍由 Ted 確認；機器測試不能代替收信或真人登入證據。
- 備份目前留在同一台 Castle；主機損毀的異地復原尚未具備。整機 reboot 未測；已設定 linger、開機啟動、程序自動重啟。

可重跑的 HTTPS 驗證：[scripts/verify-staging.mjs](../../scripts/verify-staging.mjs)。該工具使用短效且限此 Access application 的機器憑證；不修改真人 allow policy，不新增 bypass。依 [Cloudflare service token 文件](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) 使用 Service Auth，測完刪除 policy 與 token。

## 下一段：逐步搬到雲端

| 順序 | 交付 | 需要 Ted 的部分 |
| --- | --- | --- |
| 1 | 獨立 managed Postgres staging；migrate、seed、備份／還原與既有資料轉移計畫 | 選定 provider／SKU 後確認確切新增費用 |
| 2 | Hono Workers adapter、Hyperdrive、分環境 secrets；保留相同 UI／API 行為 | 若現有方案不足，確認 Workers Paid 訂閱 |
| 3 | GitHub staging environment、部署 workflow、健康檢查、上一版回退、異地備份 | 實際需新增付費資源時確認 |
| 4 | 按已實作功能接 Queues、outbox dispatcher、R2／quarantine | 決定通知收件人、上傳與保留政策 |
| 5 | 真實會員登入、核心團隊 Access 名單、Discord 入口 | 提供成員名單與對應帳號 |

每一段都以可操作網址和可重跑結果驗收。九個 repo 的存在不代表全部 runtime 已部署；簽章、支付與正式公開發布另依實際功能推進。付款、法律文件、對外正式發布維持 Ted 決定；已授權的程式、設定、測試與 push 持續進行。
