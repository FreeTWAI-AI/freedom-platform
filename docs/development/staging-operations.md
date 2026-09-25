# Staging 運行手冊

> 歷史 Castle 運行手冊，2026-09-25 退役。現行 staging 在 Cloudflare Worker，見 [遷移手冊 §14](cloudflare-migration.md#14-切換後現況2026-09-25)。下文不改寫。

## 位置與依賴

- 主機：Castle／`castleridge-ai1`，Linux 使用者 `ted-h`。
- 原始規劃樹 `/home/ted-h/projects/Freedom-Platform` 保留。
- 開發接續副本：`/home/ted-h/tmp-scratch/fp_work/codex-2026-09-20/continuation-main`。
- 運行入口：`~/.local/share/freedom-staging/current`，指向同目錄 `releases/<git-sha>` 的固定版本。
- Node 24、Docker Compose、`~/.local/bin/cloudflared`；user systemd 的 `Linger=yes`。
- 憑證／設定：`~/.config/freedom-staging/`，目錄 0700、檔案 0600，不進 git。
- `app.env`：`FREEDOM_ENV=staging`、`APP_ORIGIN=https://staging.freetwai.com`、`PORT=4310`、`DATABASE_URL`（私密）、`FREEDOM_DATABASE_NAME=freedom_staging`。中央 staging DB 與開發用 `freedom_local` 分開，應用 role `freedom_staging` 為非 superuser；DB 仍在 Castle loopback，尚非 managed cloud。
- `tunnel.token`：由現有 `freedom-staging` tunnel 取得；不放 CLI 參數或日誌。
- `cloudflared.yml`：`metrics: 127.0.0.1:20431`，使用獨立設定避免讀到其他專案的 Tunnel。

## 常駐服務

[部署檔](../../deploy/staging/) 安裝到 `~/.config/systemd/user/`：

- `freedom-staging.service`：啟動 PostgreSQL，然後執行 API／Portal；異常退出自動重啟。
- `freedom-staging-tunnel.service`：獨立 connector，不變動其他專案 Tunnel。
- `freedom-staging-backup.timer`：每日主機時間 04:00 加最多五分鐘隨機延遲，補跑錯過的排程。

```sh
systemctl --user status freedom-staging.service freedom-staging-tunnel.service
systemctl --user list-timers freedom-staging-backup.timer
journalctl --user -u freedom-staging.service -u freedom-staging-tunnel.service -n 60
curl --fail http://127.0.0.1:4310/api/v1/health
curl --fail http://127.0.0.1:20431/ready
```

API、DB、connector metrics 都只綁 loopback。Cloudflare 控制台應顯示 Tunnel Healthy，ingress 是 `staging.freetwai.com → http://127.0.0.1:4310`。302 到 Access 只代表入口要求驗證，不能當成 app 正常證據。

## 更新與回退

1. 在開發副本完成 typecheck、build、runtime／瀏覽器測試、inventory 驗證並推送確切 commit。
2. clone repo 到新的 `releases/<git-sha>`，checkout 該 commit；在新目錄執行 `npm ci`、`npm run build`。
3. `systemctl --user start freedom-staging-backup.service`；若有 schema migration，先審核相容性與回退策略。002–004 為新增會員模組資料表，不重設舊紀錄；用實際 staging role 執行 `npm run db:migrate`（DATABASE_URL 僅從私密檔案載入），不要把密碼放在 CLI 參數。
4. 記下 `readlink -f ~/.local/share/freedom-staging/current`，把 `current` 原子切換到新目錄，再 `systemctl --user restart freedom-staging.service`。
5. 驗證本機 health、connector ready 和經 Access 的 HTTPS UI。失敗就切回記下的舊目錄並 restart；有不向後相容的 DB migration 時，不可只回退程式。

`current` 切換可用同目錄暫存 symlink 加 `mv -Tf`；不要直接在運行版本裡 `git pull` 或 build。Tunnel 的 public hostname 與 Access policy 不需隨每次程式部署改動。

## 備份與還原

```sh
systemctl --user start freedom-staging-backup.service
systemctl --user show freedom-staging-backup.service -p Result
ls -lh ~/.local/state/freedom-staging/backups/
```

備份為 `pg_dump --format=custom`；先寫 `.partial`，成功才改正式檔名。每日檔案目前保留、不自動刪除；需觀察容量。現階段只有本機備份，下一段需異地保存。

還原演練使用 `docker exec freedom-platform-local-postgres-1 createdb -U freedom_local <唯一測試DB>`，透過 stdin 將 dump 傳給同 container 的 `pg_restore -U freedom_local -d <唯一測試DB> --exit-on-error --no-owner`，讀取 users／work_items 確認後只刪除該測試 DB。不要把還原演練指向 `freedom_local` 或 `freedom_staging`。新的 staging dump 不含開發測試 schema；備份服務從私密 app.env 取得 FREEDOM_DATABASE_NAME。

## 完整 HTTPS 驗證

```sh
FREEDOM_ACCESS_TOKEN_FILE=/private/path/short-lived-token.json node scripts/verify-staging.mjs
```

憑證 JSON 只包含所需 `client_id`／`client_secret`。Cloudflare 對此 app 暫時允許該特定 service token（Service Auth），禁止新增 Everyone／Bypass。驗證完在 `finally` 清除新增 policy 與 token，刪除私密檔案；保留 Ted 原有 allow policy。此憑證由操作者建立，驗證腳本不取得帳戶管理權限。

工具分開匿名和已驗證的 cookie jar，以免 Access 登入 cookie 造成匿名驗證假通過。截圖在 `~/.local/state/freedom-staging/verification/`，不含 API token。工具會登入／登出 maker 示範帳，逐頁檢查會員首頁、定位、公會、供貨、零售、開源、行銷與既有協作的桌面／手機畫面，不改工作或收款紀錄。真人 email／OTP 由 Ted 自行驗證。

## 0.2 中央 DB 切換

首次從 `freedom_local` 切到 `freedom_staging`：先在唯一 rehearsal DB 演練 public-only dump／restore 和四個 migration。正式切換時停止 app 寫入，保存舊 app.env 與舊 current，dump `--schema=public`（避免把開發 e2e schemas 帶進 staging）。目標 DB 必須確認沒有任何應用 tables；只在此全新空 DB 刪除空 public schema，再用 `pg_restore --no-owner --no-privileges --role=freedom_staging --single-transaction --exit-on-error` 還原。

新 DB 由 `freedom_staging` role 擁有，套用 migration 後再改 app.env、原子切換版本並重啟。若驗證失敗，停 app、恢復舊 app.env 與 symlink 後啟動；舊 freedom_local 保留原資料。新 DB 上線後若已接受新寫入，回退前必須另存新 DB，不可假定兩份資料仍相同。
