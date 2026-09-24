# Cloudflare＋PlanetScale 遷移現況交接（2026-09-24）

> 快照時點的操作交接，不是部署紀錄。實作皆由 Claude Opus 5.5 執行，原生協調代理只負責審查。後續結果由 root 另行更新本頁。

## 版本與已驗證範圍

| 版本 | 內容 | 已實跑結果 |
| --- | --- | --- |
| `ae4031d` | 應用程式 | 完整 E2E 242 passed |
| `4f3de6a` | 應用程式 alpha artifact（非雲端部署） | image 11 tests passed；typecheck、build、三個環境 dry-run build；本機真實 workerd 7 passed |
| `b9e2603` | 實作整合版本 | 基礎設施 31 tests passed |

本機 workerd 只證明本機可執行，不代表 provider 或遠端已就緒。本文件本輪只做 `git diff --check` 與相對連結／路徑核對，未重跑上表測試。

## 現況（不動範圍）

- 舊站 `freetwai.com` HTTP 200、`staging.freetwai.com` HTTP 302（依 root HTTP 檢查）；舊路由、DNS、Tunnel 未變，沒有流量切換。
- 既有本機服務與資料庫原樣保留；**尚未建立**雲端 Worker、候選 DNS 或任何新資料庫。

## PlanetScale

- OAuth 登入成功，帳下只有一個 organization，不需重新登入。無桌面環境下，每個 `pscale` 子程序都要以 process-local `DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null` 執行，才會走官方 CLI 的檔案 fallback；認證目錄 0700、token 檔 0600。token 內容一律不讀、不提交。
- Tokyo catalog 實際 region slug `ap-northeast`、cluster `PS_5_AWS_ARM`，要求 PostgreSQL 18。
- 已讀[官方 agent-setup prompt](https://planetscale.com/docs/agent-setup/prompt.md) 與 `pscale agent-guide`。建議的 skills／MCP **未安裝**，CLI 已足夠，不新增 MCP 相依；不宣稱 agent setup 完成。

| 目標 DB | 拓撲 | 月費（基本） |
| --- | --- | --- |
| `freedom-staging-next-pg` | single_node，replicas 0 | US$5 |
| `freedom-next-pg` | HA，replicas 2（1 primary＋2 replicas） | US$15 |
| Workers Paid | 已訂閱（見下） | US$5 |

合計 **US$25／月僅為基本費**，另計用量、儲存與稅。這是已授權的目標成本；目前只有 Workers Paid 已訂閱，兩個 DB 仍不存在。

## 卡點：PlanetScale partnership entitlement

- **Workers Paid 已完成**：使用者已升級；root 於 2026-09-24 17:39:58 UTC GET 訂閱，共 13 筆，含 `workers_paid`，US$5／月，狀態 Paid。不需再次付款。
- **目前明確的簽章卡點**：17:48:20 UTC 最後一次 billing 簽章探測，Cloudflare 明確回傳 code 2025：「Account is not entitled to create Cloudflare-billed PlanetScale databases. Purchase the PlanetScale partnership subscription to enable this feature.」此精確錯誤取代先前通用的 `auth.not_authorized`（1009）成為剩餘卡點。PlanetScale partnership **尚未啟用**。
- **待使用者 dashboard 操作**：root 已請使用者從[官方 Hyperdrive PlanetScale 啟用頁](https://dash.cloudflare.com/?step=1&to=%2F%3Aaccount%2Fworkers%2Fhyperdrive%3Fmodal%3D1&type=planetscale)購買／啟用 partnership subscription（既有請求，非新權限迴圈）。未驗證可用的公開 API 啟用 payload，不以 API 代行。
- 診斷紀錄：升級 Paid 後原部署 token 仍得 1009；臨時 Integration Write 探測只有 exit 1 且 stderr 已丟棄，不據此推論原因；最後一枚限定本帳號、一小時效期的臨時 token 取得上述 2025，之後已撤銷（DELETE 200），未保留憑證，真實 HOME 未更動。這**不**證明最小權限對應，也不代表單一 scope 解決了授權。
- 從未取得 billing proof，沒有任何建立 DB 請求抵達 PlanetScale，未做其他 billing 變更。最後一次實際 PlanetScale 唯讀查詢為 DB 數 0、兩個目標名稱皆不存在；之後的簽章探測未呼叫 PlanetScale。失敗 receipt 以 0600 私下保存。

## Cloudflare Access

- 已建立並逐一 GET 驗證 **4 個新 Access app**（最新核對仍未變）：`staging-next.freetwai.com`、`staging-next.freetwai.com/admin`、`next.freetwai.com`、`next.freetwai.com/admin`。全站 session 24h、admin 1h，皆只使用既有已授權的 staging operator 名單。
- 既有 19 個 Access app 驗證未變，總數 23。識別值與名單內容不列於公開文件；root 私人 receipt 不讀取。
- 因候選 Worker 與 DNS 尚不存在，這只是 control-plane 驗證，**不是**瀏覽器端到端保護證明。

## 剩餘步驟（依序）

1. 使用者於 dashboard 啟用 PlanetScale partnership subscription 後，重新確認 entitlement（code 2025 消失）；不重複 Workers Paid 付款。
2. 重新唯讀 preflight，產出 root 審查的計畫。
3. root 決定後只封存失敗的零 DB receipt；再以明確 PG18／PS-5／replicas 0 與 2 建立兩個 DB。
4. 唯讀核對回傳的版本、拓撲、billing 與 readiness，區分「請求被接受」與「獨立證明」。
5. 分開 migrator／app role 並跑 migration（[roles 說明](https://planetscale.com/docs/postgres/connecting/roles)）；staging 只放合成資料，production 候選私下還原。
6. 每環境一個 Hyperdrive binding，所有查詢關閉快取；硬性前提是 provider GET 回傳 `caching.disabled === true`，不得以 no-store 或環境旗標替代（[Hyperdrive＋PlanetScale](https://developers.cloudflare.com/hyperdrive/planetscale/)）。
7. Access 驗證後，以私人設定／secrets 與精確 40 碼 hex release SHA 部署候選站。
8. 遠端驗收（[候選站驗收清單](../../scripts/verify-cloud-candidate.md)）：health／provenance、同源 cookie／auth、授予／撤銷後首次讀取的新鮮度、圖片、權限新鮮度與負載／錯誤量測；不讀一般會員訊息。
9. 經審查的切換：最終寫入凍結、備份與差異處理。切換計畫執行前舊站保持不動。

Worker 與 Hyperdrive 佈建、遠端驗收與切換皆為 `not_run`；DB 建立嘗試在送出 PlanetScale 請求前即被 entitlement 擋下（`blocked`），並非單純未嘗試。使用者已授權建立兩個候選站，本文件不另開新的權限確認迴圈。
