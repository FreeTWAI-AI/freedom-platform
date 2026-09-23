# 公開會員 Beta 運行手冊

入口 `https://freetwai.com`；staging 保留 `https://staging.freetwai.com` 與 Ted-only Access。公開站由 Castle 的 loopback `127.0.0.1:4312` 經現有 Freedom Tunnel 提供，不是 managed-cloud runtime。Playwright 測試仍使用 4311，兩者不衝突。

## 隔離與設定

- 公開 DB：`freedom_public`，同名非 superuser role；原 staging `freedom_staging` 與開發 `freedom_local` 分開。
- 私密設定：`~/.config/freedom-public/app.env`，0600。FREEDOM_ENV=public、APP_ORIGIN、DATABASE_URL、FREEDOM_DATABASE_NAME、FREEDOM_REGISTRATION_COMMUNITY_ID、FREEDOM_TRUST_CF=true、FREEDOM_BACKUP_SCOPE=freedom-public。
- 原始碼運行版本：`~/.local/share/freedom-public/releases/<sha>`；current symlink 固定到已驗證 commit。不要在運行副本 git pull 或修改檔案。
- 公開 server 啟動要求明確 community、獨立非 superuser DB，且不得存在 local.test 示範帳。公開註冊也拒絕這個保留網域。
- 只信任來自 loopback Tunnel socket 的 CF-Connecting-IP；其他來源不能用偽造標頭繞過限流。

公開資料庫只套用 migration 並建立空的「自由工坊」community；禁止執行 seedLocal。密碼只存 salted scrypt hash；新會員、Client token 和聯絡設定都在這個 DB。沒有同步私人 staging 資料到公開 DB。

## 發布順序

1. 通過 TypeScript、build、runtime、跨倉、瀏覽器、contract 和 inventory checks；把精確 commit 推到 main。
2. 在新 release clone 安裝依賴、build；備份已運行的同環境 DB。
3. 以同環境 DB role 執行已審查 migration。首次只新增空 community，不複製示範資料。原子切换 current，再啟動 `freedom-public.service`。
4. 確認 loopback health、public /site、沒有示範帳提示，以及拒絕匿名會員 API。
5. 才新增 Tunnel ingress `freetwai.com → http://127.0.0.1:4312` 和這個 zone 的 apex proxied CNAME；完整保留 staging ingress／Access。CF 管理環境檔的預設 zone 不一定是 freetwai.com，必須先核對 zone 名稱。
6. 執行 `node scripts/verify-public.mjs` 驗證真 HTTPS 註冊、定位、名片、登入與手機畫面。測試只產生明確命名的驗證會員；依私密 verification-account.json 的 UUID＋email 雙重對照停用該帳，撤銷其 session／讀取連線，不能清空 users 或整個 DB。

公開 beta 上線是本輪使用者明示授權的動作，不代表金流、真人成交、Email 驗證或商業資格驗收已完成。購買服務、對外訊息與自動上游工作流不在此部署動作內。

## 備份與回退

`freedom-public-backup.timer` 每日 04:15 加隨機延遲，透過同一個 backup.sh 產生僅公開 DB 的 custom dump；檔案在 `~/.local/state/freedom-public/backups`，UMask 0077。首次上線後做一次唯一 temporary DB 的 restore rehearsal；只刪除該演練 DB。尚未有異地備份。

換版失敗就回到同環境上一個 release；若涉及不相容 schema，需要先保存新寫入並用對應 migration／資料恢復計畫。新站首次失敗可移除本次新增的 apex DNS／ingress，保留私密 DB 與診斷資料，不停用 staging 或其他專案 Tunnel。

每日觀察失敗登入、API errors、DB／磁碟與備份結果。營運管理與會長任命介面已實作，見 [管理 API](platform-admin-api.md)，透過獨立 Access 驗證而非一般未驗證會員 Email 取得權限。一般 Email 寄送、帳號恢復、異地備份與 managed PostgreSQL 為後續工作；不得以未驗證聯絡方式直接認領或重設他人帳號。
