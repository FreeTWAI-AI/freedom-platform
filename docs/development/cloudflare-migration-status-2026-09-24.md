# Cloudflare＋PlanetScale 遷移現況交接（2026-09-24）

2026-09-25 已切換完成。本檔是 2026-09-24 的歷史紀錄，下文不改寫。
正式環境與 staging 現況見 [遷移手冊 §14](cloudflare-migration.md#14-切換後現況2026-09-25)。

> 2026-09-24 候選站階段的完成紀錄，**不是切換紀錄**。`staging-next` 與 `next` 都已部署，舊站照常運作並持續接受寫入，**未切換**。§7 所選的 10 個驗收階段全部通過，臨時資源已清理，該段最後一次觀察是 20:15:39。§9 於 22:00–23:30 UTC 補上整合分支 `9912e87` 的本機全套檢查，以及兩站的新會員註冊與會員訊息驗收（皆 `overall=pass`、`cloud_proof=true`），臨時 Access 與合成會員亦已清理；該段最後一次觀察是 23:29:40。各項以所列 UTC 時間為準。截至 §7 所述的實作與私有 helper 由 Claude Opus 5.5（`claude-opus-5-5`）撰寫，協調者負責審查、執行已審查的部署／維運工具與測試。§9 的操作與作者另記。程序、架構與回退見 [遷移手冊](cloudflare-migration.md)。

## 1. 版本與已驗證範圍

| 版本 | 內容 | 已實跑結果 |
| --- | --- | --- |
| `ae4031d` | 應用程式 | 完整 E2E 242 passed |
| `4f3de6a` | 應用程式 alpha artifact（非雲端部署） | image 11 tests passed；typecheck、build、三個環境 dry-run build；本機真實 workerd 7 passed |
| `b9e2603` | 實作整合版本 | 基礎設施 31 tests passed |
| `aed75a2636a0680b2fb9cf1ecd31ed14cbcb6293` | 兩個候選站部署的應用程式 release | 所選 10 個驗收階段／132 項檢查，兩站皆 PASS，見 §7 |
| `9bec626`（接在 `3a4c434` 之後） | 遠端驗收工具（verifier）；root 已 cherry-pick 到整合分支 | typecheck／build passed（`3a4c434`）；verifier 21/21 passed（`9bec626`） |

本機 workerd 只證明本機可執行。早期版本的結果是歷史紀錄，本輪未重跑。Verifier 修正與本頁文件都不改變已部署的 app SHA；兩站都沒有重新部署。

## 2. 舊站與切換

- `freetwai.com`、`staging.freetwai.com` 的 DNS、Tunnel 與 runtime 寫入全部照舊；**沒有切換**，候選站不是 live 的替代品。
- 舊站持續接受寫入，所以 next 只是 18:51 備份的演練還原，不與 live 同步，也不是最新來源。
- 20:14:49 UTC root 唯讀快照：2 筆受保護的舊 DNS 記錄（`freetwai.com` 1 筆、`staging.freetwai.com` 1 筆）與記錄下的 3 個基準完全相符；舊 public HTTP 200、舊 staging 302；zone Worker routes 目前為 0。沒有歷史 route 完整 fingerprint，因此「期間從未有 route」沒有獨立證明，但沒有任何舊 routing 變更或切換操作。19:54:02 另讀到舊 public／staging 本機服務、port、本機 health、Tunnel 與備份 timer 皆正常，既有 staging Access 未變。
- 唯一與舊容器相關的操作是 §5 經既有官方 `freedom-public-backup.service` 的一次 oneshot 備份。
- 正式切換仍需另一次審查與授權：write freeze → 新的最終備份 → 還原與驗證 → 以審查過的 secret 轉移設定相符的 live key 並另外驗證真實 GitHub → 處理回退期間的新寫入（[手冊 §10–11](cloudflare-migration.md#10-切換本輪不做需另一次明確授權)）。

## 3. 計費與 PlanetScale 資料庫

- **Workers Paid**：使用者啟用；root 於 17:39:58 UTC 讀回 `workers_paid`、US$5／月、state Paid。
- **PlanetScale partnership**：使用者啟用後，先前的 Cloudflare code 2025 已解除；18:21:19 UTC 重新產生 billing signature 成功。兩個 DB 都以 Cloudflare billing signature 經 stdin 直接交給 `pscale database create` 建立。臨時 billing token 已撤銷（200）。不需再開通或再申請權限。此結果**不**證明最小權限組合，也不是完整帳單核對。
- Organization `ted-ted-h`，region `ap-northeast`（Tokyo），PostgreSQL 18（以實際 SQL 驗證）：

| DB | cluster | 拓撲 | 狀態 | 月基本費 |
| --- | --- | --- | --- | --- |
| `freedom-staging-next-pg` | `PS_5_AWS_ARM` | replicas 0 | ready | US$5 |
| `freedom-next-pg` | `PS_5_AWS_ARM` | replicas 2（1 primary＋2 replicas） | ready | US$15 |
| Workers Paid | — | — | Paid | US$5 |

月基本費 **US$25**，不含 storage、用量與稅；不承諾 10k 併發容量。依 Cloudflare 官方說明價格與直接向 PlanetScale 購買相同；實際月帳單尚未觀察到。

## 4. Cloudflare Access

- 4 個新 app（`staging-next`／`next` 的全站與 `/admin`）已建立，17:35 UTC 逐一 GET 驗證；只使用既有 staging 授權名單。原有 19 個受保護 app 未變，總數 23。ID、AUD、名單內容不入 repo。
- 每站驗收都用自己的臨時 Access policy 與 service token（next 為 1 小時 grant，7 項 proof PASS）。兩站清理後 receipt 皆為 cleaned，臨時 credential 檔皆不存在，原有的單一 email operator 與 admin policy 已還原且一致（next 於 20:14:13 UTC 確認：意外多出 0、錯誤 0、未解決 0）。

## 5. 資料庫 bootstrap 與還原（已驗證）

共同規則：runtime app role 只有 DML（無 CREATEDB、TEMP、CREATE SCHEMA、ledger 寫入、提升權限旗標或 role membership）；migrator 擁有所有 public objects。只有 TLS 連線 username 帶 branch 後綴，SQL role 名稱不帶。兩環境各用過的一小時臨時 provider admin role 都已明確刪除（successor 為 `postgres`），新 roles 讀回正確，沒有殘留 admin。

### staging-next（合成資料）

18:42:45 UTC 驗證：PG18；ledger 36 筆 name／checksum（001–037，缺 022）；81 張 public table；一個新的合成 community；初始 0 帳號。18:55 UTC 另以授權建立一個合成驗收帳號，因此不再是 0 帳號。

### next（production 候選演練還原）

1. **來源備份**：root 於 18:51:51 UTC 以既有 `freedom-public-backup.service` oneshot 對 `freedom_public` 做唯讀 `pg_dump`，只新增一個備份檔；沒有來源 SQL 寫入、服務設定變更或保留期刪除，舊 public 主服務持續運作。檔案 2,132,783 bytes，SHA-256 `e8c584d5b16512d5ced178c8bfc908b7565529e5894aefc48a3a13c1fb3bf73a`，私下複製前後皆核對。取代 14:49 的快照；期間沒有待套用的 migration。
2. **還原**：一次性本機 `postgres:18-alpine` image 容器（image 已固定，其 `pg_restore` 版本為 18.6），`--network host`，只掛載私有檔案，libpq service 檔走驗證 TLS（argv 無秘密、不覆寫 HOME）。`pg_restore --no-owner --no-privileges --exit-on-error --single-transaction` 於 19:04:47 UTC 成功，目標是 migrator 擁有的**空** `freedom_next`；未觸及任何受保護的舊 DB。TOC 528 entries：81 tables、8 functions、8 triggers、1 sequence，僅 `public`；沒有 schema、extension、ACL、comment 或 security label 項目。
3. **Ledger**：還原後 36 筆 name／checksum 與整合 repo 完全一致；19:05:05 UTC repo migration runner 為 no-op（36→36）。
4. **Sessions**：候選 DB 共 317 筆，其中 248 筆原未撤銷者全部撤銷，之後 0 筆未撤銷。其他 key、grant 或資料都沒有撤銷。
5. **GitHub key**：bootstrap 從未讀取或複製 live `GITHUB_SOCIAL_TOKEN_KEY`。部署時設定新的候選 key，secret 名稱已讀回（見 §7）。
6. **還原後驗證**（`verified_after_admin_delete`，19:11:34.948 UTC）：PG18、81 張 public table、1 community、226 users、0 個本機示範帳號、0 筆未撤銷 session；app／migrator 的 ownership 與 grants 正確；app 與 migrator 新 TLS 登入成功；臨時 admin 不存在。
7. **還原後、驗收帳號建立前的歷史計數**（19:12:42 UTC，唯讀）：81 tables 共 7,801 rows；226 users（193 active）；317 sessions（0 未撤銷）；1 community。這是當時的目標端快照，不是最新總數，也不是與來源逐項相等的證明；還原證明以 exit 0、ledger 與 schema 比對為主。
8. **合成驗收帳號**：19:17:20 UTC 另經授權建立一個 next 專用合成帳號，恰好 6 筆自身 INSERT，由佈建端另行唯讀驗證。還原來的來源會員資料未變動；上列計數不含此帳號。
9. **GitHub 設定隔離（候選站專用）**：第一次 next 驗收（`next-account-1`）判定 FAIL：guild status 回 503 `github_setup_unavailable`，因為 `readSocialConfig` 要用新 key 解密還原來的 GitHub App 設定 client secret。沒有繞過 verifier，也沒有改產品 runtime；該報告保留為失敗紀錄。root 審查後於 20:11 UTC 執行 sanitizer（exit 0，commit 後重新驗證）：只在候選 `freedom_next` 移除恰好 1 筆 GitHub App 設定與 1 筆以 FK 相依的已使用 setup receipt，移除前先加密備份並驗證。之後 `readSocialConfig` 為 `null_unconfigured`，7 項新檢查全為 true；會員 GitHub 連結、OAuth state 與 audit 三組資料不變。未讀取或複製 live key、未發 GitHub 請求、未寫來源 DB；18/18 離線 guard 通過。會員既有的加密 credential 仍留在 DB，但新 key 無法解密；候選站的 GitHub 刻意維持未設定。這是「還原資料＋新 key」演練的必要步驟，不是切換程序。

### Schema 比對

staging-next 與還原後的 next 共比對 1,990 行 metadata。原始 fingerprint 只有 3 個 CHECK constraint 的括號不同：`member_chat_channels_check`、`member_notifications_body_check`、`member_notifications_title_check`。staging 為 `(A AND B) AND C`，還原後為 `A AND B AND C`；OR 子樹不變，含 NULL 在內語意相同。沒有修改任何 schema。

- 原始雜湊不同照實保留：`schema_digest_equal_strict: false`。
- `semantic match: true` 只適用這三組經 root 審查、以 line hash 釘住的行；其餘任何差異都拒絕。比對器的測試會拒絕 AND／OR 混合重組、數值範圍、constraint 名稱或其他欄位的改變。
- 這**不**表示原始雜湊相同，也不是一般性的 CHECK 等價判定。

## 6. 工具與 repo 範圍

- `deploy/cloudflare` 的 preflight 仍是 GET-only、沒有 execute。上述佈建與 SQL 都由 operator 的私有 helper 在版本化工具之外執行。
- Repo 的 `wrangler.jsonc` Hyperdrive id 保持全零 template；真實 id 只在私有 overlay。全零表示「只靠 repo 不能部署」，不表示資源不存在。
- PlanetScale 官方 agent setup 已讀，建議的 skills／MCP 未安裝，不宣稱 agent setup 完成。
- OCI 上 3 台既有 VM 未動，也沒有任何 OCI 佈建。D1 不是 drop-in（依賴 PG transaction、lock、JSONB）。

## 7. 遠端部署與驗收 evidence

只記 UTC 時間、結果、計數與私有報告的檔名／SHA-256；ID、AUD、email、私有路徑與原始 JSON 不入 repo。沒有記錄的時間就不寫。

### 部署

| 項目 | staging-next | next |
| --- | --- | --- |
| 應用程式 release SHA | `aed75a2636a0680b2fb9cf1ecd31ed14cbcb6293` | 同左 |
| provider 核對 | 9 個 gate 全部 PASS | 19:44:51 UTC 最終驗證 9 個 gate 全部 PASS（provider GET＋新的 DoH／TLS）。最初的佈建 receipt 為 `partial_stopped`，原因只是 operator 本機 DNS `ENOTFOUND`；該 receipt 保留，最終驗證另列 addendum |
| Hyperdrive | provider GET 讀回 `caching.disabled === true`；strict TLS，自訂 CA ISRG Root X2 已上傳並讀回 | 同左 |
| Secrets | 兩個新 secret 名稱讀回 | 名稱讀回，含新的候選 `GITHUB_SOCIAL_TOKEN_KEY` |
| Worker、custom domain、DNS | 完成；沒有修改任何舊目標 | 完成；沒有修改任何舊目標 |
| Cache Rules | 19:19:48 UTC 最終 addendum：`no_applicable_cache_rule`（適用規則 0、zone cache phase ruleset 0、Page Rules 0，account 層級不適用），`cache_clear: true` | 19:44:51 UTC 最終 addendum：結果同左 |
| health | root 直接讀：HTTP 200，`runtime: cloudflare-workers`，release SHA 同上 | 驗收 health phase 12 項 PASS（runtime 與 release SHA） |

20:14:49 UTC：兩個候選 hostname 都能由 operator 一般 resolver 解析，結果與新的 DoH 相同；匿名存取 `/` 與 `/admin` 皆為有效 TLS 的 302。20:14:52 兩站匿名 `/api/v1/health` 亦為 302（Access 攔下）。驗收期間的 resolver wrapper 只在單一 process／Chromium 內固定這兩個候選 hostname，沒有改全域 DNS 或 hosts 檔。

### 驗收

所選 10 個驗收階段：preflight、health、protocol、assets、anonymous、session、browser、guild-cache、avatar、logout（verifier `9bec626`）。

| 項目 | staging-next | next |
| --- | --- | --- |
| 所選 10 個驗收階段／132 項檢查 | 19:39 UTC：`cloud_proof: true`、overall pass。報告 `staging-next-account-3.json`，SHA-256 `eb72f47345324d3ccfd4def159a11fcb71fa6c517851e6bc9f7f9ede42cb774f` | 20:12:32 UTC：`cloud_proof: true`、overall pass。各階段檢查數：preflight 5、health 12、protocol 2、assets 15、anonymous 16、session 14、browser 12、guild-cache 42、avatar 10、logout 4。報告 `next-account-2.json`，SHA-256 `b127674d48a830a71b9aa853e86cc6673eb871ea181d57e589daa68ba93e9e94` |
| guild-cache | PASS | PASS：grant／revoke 後的**第一次**讀取、stale 412、idempotency receipt replay |
| 會員訊息 | 瀏覽器自動發出的 inbox 請求全部攔下，未讀任何 response body | 同左（8 個 inbox 請求攔下；route／page／teardown 錯誤 0） |
| `github-handoff`／GitHub | 未選（not_run） | 未選（not_run）；`app_configured: false` 是 §5 隔離的刻意結果，不是 GitHub 整合證明 |
| 有上限的匿名負載（另跑） | `staging-next-load-1.json`：120/120 HTTP 200、0 error；p50 66.5 ms、p95 104.6 ms、p99 212.2 ms；約 12 秒、10 rps、concurrency 4 | 19:52:10 UTC `next-load-1.json`（SHA-256 `43bc4ea08aa5c1661a5446be65f405f6b0ff3d37e240411326f2695e12abf1bd`）：120/120 HTTP 200、0 error；p50 70.7 ms、p95 118.8 ms、p99 933.3 ms；約 12 秒、10 rps、concurrency 4 |
| 合成帳號清理 | 19:43:17 UTC：帳號停用，8 個自身 session 全撤銷、無 active，avatar 圖 0，歷史紀錄保留 | 20:15:18 UTC commit，20:15:39 獨立唯讀驗證 PASS：帳號停用，5 個自身 session 全撤銷、無 active，avatar 圖 0，歷史紀錄保留 |

- 兩站都沒有刪除帳號或動到一般會員資料。臨時 Access 清理見 §4。
- Cache Rules 的證據只代表這兩個觀察時點，不是永久保證。以 child token 查特定 entrypoint 回 403（照實保留）；規則不存在是由 parent token 取得的完整 zone Rulesets 列表（200）確認，不是每個請求都成功。
- 負載只打 health 與 2 張靜態圖，從 operator 主機以新的 DoH 結果精確覆寫候選 DNS。**不是**台灣延遲、DB 負載或 10k 容量證明。next 的負載在 §5 GitHub 隔離之前執行，量測的路徑不受該隔離影響。
- 失敗紀錄照實保留，不算通過證據：staging-next 第一次嘗試因本機 verifier 瀏覽器 `route.abort` 未處理 rejection 中止、沒有 JSON；next 第一次報告 `next-account-1` 為 FAIL（原因見 §5）。兩者都被之後的正式 132 項 PASS 報告取代。
- Verifier 修正：`3a4c434` 處理瀏覽器 routing 與 teardown；`9bec626` 要求 body version 是實際的數字，並接受與它完全對應的 strong 或 weak response ETag，送出的 If-Match 仍為 strong。兩者都只改驗收工具。
- 驗收工具與關卡見 [候選站驗收清單](../../scripts/verify-cloud-candidate.md)。先前 alpha 修正的遠端 Images targeted proof 6/6 只保留為歷史紀錄。

## 8. 尚未驗證

- 所選階段仍不是全 app 的端到端行為。候選站的新會員註冊與會員訊息驗收見 §9。
- 完整 GitHub OAuth／App consent／安裝與按星、fork、follow；候選站 GitHub 刻意未設定。
- 台灣實測延遲、PlanetScale 原生 backup／PITR 的額外還原演練、DB 負載與 10k 併發容量。訊息速率限制（20／60 秒）、`next` 的公會頻道，以及 §9 那兩次執行未選的 `github-handoff`／`load`，見 §9。
- 實際月帳單（目前只有 US$25 基本費報價）。
- 切換尚未進行：新的最終備份、還原與驗證、live key 轉移、真實 GitHub 驗證與回退。舊站**未切換**。`next` 在任何切換前必須從最終備份再還原一次；§9 的合成列是演練資料。

## 9. 2026-09-24 22:00–23:30 UTC 補驗：整合分支本機全套檢查、審查修正、候選新會員註冊與會員訊息驗收

### 本機全套檢查

整合分支 HEAD `9912e87a912cd71c73c13719531871806742256a`，2026-09-24T21:59:52Z→22:10:20Z，主機 castleridge-ai1，Node v24.21.0。隔離的 PG schema 在本機 54339 容器，E2E port 4391。

| 檢查 | 結果 |
| --- | --- |
| typecheck | pass |
| build | pass |
| runtime tests | 514/514 |
| skill-client | 10/10 |
| check:runtime-text | pass |
| worker:dry-run（local／staging-next／next） | pass |
| test:worker | 7/7 |
| deploy/cloudflare tests | 31/31 |
| preflight `all` dry-run | ok（`deployment_ready=false` 是設計如此） |
| contracts | 659 passed／4 skipped |
| contracts:build | no diff |
| E2E | 248 passed |
| `git diff --check` | clean |
| 跑完後的工作樹 | clean |

這只是本機證據。此 SHA 尚無 GitHub run。私有證據：`~/.local/state/freedom-integration-checks-20260924/baseline-9912e87/`（RESULT.md 與帶 sha256 的 logs）。

### 審查與本分支修正

grok-4.7 唯讀審查 `main..9912e87`。證據：`~/.local/state/freedom-integration-checks-20260924/review-9912e87-grok-4.7.md`。沒有查證到的 runtime 缺陷：Worker／Node 共用的 Origin／CSRF／session、每個請求的 pool cleanup、scrypt 格式、image decoder 的拒絕、health 欄位精確吻合。六個會員 todo 保留。

三項工具發現已在本分支修正。修正後 deploy/cloudflare tests 34/34。

| commit | 修正 |
| --- | --- |
| `12f07f6` | DNS listing 分頁。候選 hostname 只有在清單被證明完整時才是 `absent`；否則 `incomplete_listing` 阻擋 readiness。基準值 `exists` 改名 `taken` |
| `608070d` | OCI 失敗只回報 exit code 與 allowlisted code |
| `65d1864` | plan 的 exit-code 用詞 |

### Verifier 擴充

`7bd4aef`、`86514c0`、`ea1d4c4` 加入 phases `registration`、`messages`、`messages-mobile`。會員由工具自行建立，位址形如 `cand-reg-<8hex>@example.invalid`。real-history guard：目標 `next` 沒有 guild-channel route。

grok-4.7 對抗審查（證據：`~/.local/state/freedom-integration-checks-20260924/adversarial-review-verifier-phases-grok-4.7.md`）發現 2 high／1 medium／1 low，已由 `8d97614` 與 `4343df1` 修正。本機 harness：26 tests pass。

| commit | 修正 |
| --- | --- |
| `8d97614` | 公會選擇改走 `GET /api/v1/guilds` 加上本人的 preferences，不再用 `/guilds/directory`（該端點帶有其他會員的姓名）。半註冊會員的 session 會撤銷，並回報其 label。恆真檢查已移除。scrub 測試加強 |
| `4343df1` | `next` 上每個 phase 的精確請求清單 |

### 雲端驗收

已部署的 app `aed75a2636a0680b2fb9cf1ecd31ed14cbcb6293`。health：runtime `cloudflare-workers`，release SHA 與上列完全一致，version `0.13.0-member-messages`。兩次皆 `overall=pass`、`cloud_proof=true`、`redaction_applied=false`。報告的 leak scan 乾淨（沒有 email／uuid／cookie／CSRF；只有 label）。

| 項目 | staging-next | next |
| --- | --- | --- |
| mode | staging | public（18:51Z 備份的演練還原） |
| 時間 | 2026-09-24T22:44:03Z→22:46:38Z | 2026-09-24T23:27:11Z→23:29:11Z |
| verifier 內容 | `ea1d4c4`（修正前；directory 讀取只看到合成社群） | `4343df1` |
| preflight | 5/5 | 5/5 |
| health | 12/12 | 12/12 |
| registration | 16/16（todo：positioning done、primary guild done、GitHub unavailable） | 16/16（todo 狀態相同；候選站 GitHub 刻意未設定） |
| messages | 44/44（guild_channel pass；次要公會 `guild_commerce_sales` join／leave pass 並已 restored；rate_limit not_covered） | 34/34（guild_channel not_run，原因 `real_history_guarded`；rate_limit not_covered） |
| messages-mobile | 12/12（390×844，跨來源 0，teardown clean） | 12/12 |
| 報告 | `staging-next-registration-messages-1.json`，SHA-256 `8e11976d3f509bb9975c2ad5a37687cc471cd5593fb342e3bd5efff6db79b741` | `next-registration-messages-1.json`，SHA-256 `3bd15fb85635e7d586446d41e9dd7f86d75490b15753432ec61e645c20cf184e` |
| 會員 label | `cand-reg-e55afa1e`、`cand-reg-b9d1dea1` | `cand-reg-37ea0707`、`cand-reg-69396540` |

Access：每個目標一個臨時 1 小時 service token，加上一個 `non_identity` policy，只加在該目標的全站 app。helper 目錄 `candidate-test-access-20260924T224350Z`。最小權限的原有設定未改。每次跑完立即清理（token 已刪、credential 已移除、沒有 drift、未解決 0）。staging-next：grant 22:43:53Z，cleanup 22:46:56Z。next：grant 23:27:07Z，cleanup 23:29:11Z。

會員清理用新的私有 helper `registration-acceptance-cleanup-20260924/registration-cleanup.mjs`（18 個離線測試）。守衛是 exact email，且 `created_at` ≥ 該次執行開始。停用語句與管理員 `changeMemberStatus` 相同，不刪除任何列。

| 項目 | staging-next | next |
| --- | --- | --- |
| 時間 | 22:47:15Z | 23:29:40Z |
| 停用 | 2 | 2 |
| 總數不變 | users 3、sessions 13、direct messages 2、channel messages 4、squads 1 | users 229、sessions 328、direct messages 3、channel messages 2、squads 2 |
| 驗證 | 獨立驗證通過 | 驗證通過 |

staging-next 的 sessions updated 0（工具已經撤銷）。

預期殘留：每位候選的停用會員列、receipt、定位、成員關係、一個小隊、訊息、通知。

仍未覆蓋：訊息速率限制（20／60 秒）、`next` 的公會頻道、GitHub OAuth／App 流程（未設定）、這兩次執行未選的 `github-handoff` 與 `load`（兩站各這兩項，共四個階段）、台灣延遲、DB 負載、PITR 演練、切換。`next` 在任何切換前必須從最終備份再還原一次；這些合成列是演練資料。

私有證據根目錄：`~/.local/state/freedom-cloudflare-migration/registration-messages-acceptance-20260924/`（plan.md、results.md、reports、stderr）。

### 操作與作者

2026-09-24 由一個 Claude Fable 5.1 session 操作。本節所涉程式變更皆由 grok-4.7 經 grok CLI 撰寫。審查為 grok-4.7。驗證執行由該 operator session 執行。
