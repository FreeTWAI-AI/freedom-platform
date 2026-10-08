# Tenant list cursor：金鑰設定與發布程序

這是尚未執行的操作程序，供下一次明確核准的 release 使用。合併程式碼不表示已設定
金鑰或已發布；Round 10 的 production-go、helper、receipt 和 backup pins 不能沿用為
這次變更的授權。不得先部署程式再補金鑰：啟用 launchpad 的環境若缺少合法金鑰，
已授權的 Work、Result revisions、module instances、application installations 列表，
以及使用 Work 列表的 `launchpad-context`，連第一頁都回 503 `tenant_cursor_unavailable`。
一般 health 成功不能證明此設定可用。

## 發布前的依賴

- 每個環境各自產生 32 個隨機 bytes，以 canonical、無 padding 的 base64url 編碼為
  43 字元，放入 `FREEDOM_TENANT_CURSOR_SIGNING_KEY` secret binding。local、staging、
  production 不共用金鑰，也不借用 CSRF、session、webhook 或其他用途的金鑰。
- Node 從自己的 server environment 讀取；Worker 只讀自己的 binding。`FREEDOM_ENV`
  與 `APP_ORIGIN` 必須是受信任的 host configuration，不能由 request header 決定。
- 下一版 operator helper 必須把這個 secret 名稱列為 **required**，其 metadata
  allowlist 仍拒絕未知名稱，並保留既有必要 secrets。既有 Round 10 helper 只接受兩個
  release secrets 加 optional `GITHUB_METRICS_TOKEN`，會拒絕新增 cursor 名稱；它也
  沒有 provision cursor key 的能力。先在獨立 future journal 準備並審查 helper、
  mock 驗證 required-name/錯誤 target/缺少 approval 的拒絕行為，不能修改舊 receipt
  或把舊 helper 的檢查關掉。
- release approval 要固定 merged source SHA、artifact、實際 schema ledger、每個
  target 的 Worker/origin、金鑰新增或輪替範圍、staging 驗收與 production 放行條件，
  以及 backup/pin transition。此 PR 沒有執行這些 provider 或備份操作。

## 給已審查 operator helper 的設定步驟

1. 按核准的 target 與既有備份程序完成發布前檢查；確認現行 Worker、來源 SHA、
   schema ledger 和 backup pin 相符。不得用缺 Worker 時自動建立的分支代替目標核對。
2. helper 從既有私有 credential source 在程序內取得憑證，不輸出內容。為本次 target
   在記憶體產生 `randomBytes(32).toString('base64url')`，確認解碼長度 32、重新編碼
   完全相同；第二個環境獨立產生，不複製第一個值。值只經非 TTY stdin 傳給鎖定版本
   的 Wrangler，不進 argv、ordinary vars、shell history、暫存 JSON 或 journal。
3. helper 使用下列 CLI argument shape（角括號是 operator 的私有路徑，不是 shell
   範例中的實際值）；憑證只存在 child environment，secret value 只存在 stdin：

   ```text
   node <reviewed-checkout>/node_modules/wrangler/bin/wrangler.js secret put FREEDOM_TENANT_CURSOR_SIGNING_KEY --config <reviewed-private-overlay> --env staging-next
   node <reviewed-checkout>/node_modules/wrangler/bin/wrangler.js secret list --config <reviewed-private-overlay> --env staging-next --format json
   ```

   installed Wrangler 4.138.0 的 `secret put` 在非 TTY 時使用 stdin；這是 provider
   寫入，可能建立新的已部署 Worker version，不能當作純讀取或隱含 deploy approval。
   若 provider 拒絕未部署的最新 version，停止並核對狀態，不臨時改用 versions/deploy
   命令。helper 應關閉 telemetry/debug、截住 child stdout/stderr、只記錄固定狀態與
   允許的 metadata；不得把原始 provider error 或 key 貼入日誌。
4. `secret list` 只讀回名稱/type，確認恰有必要 cursor binding 且既有 secrets 保留。
   名稱存在不能證明值的格式；格式由本機 generation/validation 證明，功能由下一步
   驗收。若上傳結果未知，先 reconcile metadata/Worker version；不能盲目產生新值
   重試，造成未記錄的輪替。journal 只保存 target、secret 名稱、操作狀態、時間、
   Worker version、release SHA 與驗收結果，不保存 secret、cursor、會員資料或 session。
5. 依新的 release plan 發布相同的已審查 artifact 到 staging，完成下面的驗收。需要
   production 放行時，取得該 exact release/configuration 的明確核准後，對 `next`
   以自己的金鑰重做同一流程；不能把 staging 的成功或 Round 10 授權當 production-go。
   每個環境完成後按新計畫核對 actual release/schema 與 backup pins，保留失敗狀態。

以上是 future helper 的操作介面與要求，並非聲稱 repo 已提供可執行的 provision
helper。versioned `deploy/cloudflare/preflight.mjs` 仍是唯讀工具；本文件不增加其寫入權。

## 驗收與隔離

使用核准的測試會員與資料，分別記錄環境、source SHA、HTTP status 及 pass/fail，
不記錄 cookie、raw cursor 或列表本文：

| 檢查 | 預期 |
| --- | --- |
| 已授權的上述四種列表，第一頁與 continuation | 200，排序與資料邊界正確 |
| 同一個 cursor 改動 keyset/signature，或換 purpose、caller、tenant、parent/filter | 可存取目標時 422 `invalid_cursor` |
| 無權存取的 tenant/resource 搭配壞 cursor | 保持既有拒絕回應；不得先洩漏 cursor/key 狀態 |
| 登出或撤销會員／instance 權限後續頁 | 重新驗權，不能因持有 cursor 取得權限 |
| 換 host-configured environment、origin 或 signing key | 原 cursor 不再被接受 |

codec 以 HMAC 綁定 purpose、principal、tenant/scope、parent 和 normalized filter；
每次服務讀取先檢查目前權限，再 decode。HTTP edge 的參數形狀檢查仍可能先回 422，
不能把所有格式錯誤都宣稱為 authorization-first。page size 可改；cursor 不是加密，
不是 authority，也沒有 TTL。隔離測試證明程式行為，不能代替真實環境的 key provisioning
與 authenticated smoke；本輪沒有在 staging/production 執行這些驗收。

## 輪替與回復

輪替不改資料或 schema，沒有 old-key grace。舊 unsigned cursor、舊 key、舊 origin
或 environment 的 cursor 均須重新從無 cursor 的第一頁開始；不要為相容性加 unsigned
fallback。未知上傳結果先停止/reconcile；若來源碼尚未發布，不以缺 key 的 source
繼續 rollout。若已發布後 key 無效，按已核准的 recovery plan 修復 binding 或使用保留
簽名檢查的相容 build；不要把 503 當成發布驗收成功。

回退至沒有簽名檢查的舊 reader 會重新引入此次修復的完整性缺口，不能稱為等價的安全
rollback。金鑰疑似外洩時不能恢復舊 key；一般設定錯誤的 key 恢復也必須由新的明確
operator 決策處理，並重新驗收。schema 135 已套用時，Round 10 pinned ledger 只到
134，其 preflight 會拒絕直接 redeploy；本次 cursor 修復沒有 down-migration。需要
recovery build 時，必須同時相容實際 schema、保留商店資料/管理路徑與簽名驗證，
不得修改已套用的 migration 或 ledger。
