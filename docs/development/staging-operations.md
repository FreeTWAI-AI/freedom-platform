# Staging 運行手冊

## 位置與依賴

- 主機：Castle／`castleridge-ai1`，Linux 使用者 `ted-h`。
- 原始規劃樹 `/home/ted-h/projects/Freedom-Platform` 保留。
- 開發接續副本：`/home/ted-h/tmp-scratch/fp_work/codex-2026-09-20/continuation-main`。
- 運行入口：`~/.local/share/freedom-staging/current`，指向同目錄 `releases/<git-sha>` 的固定版本。
- Node 24、Docker Compose、`~/.local/bin/cloudflared`；user systemd 的 `Linger=yes`。
- 憑證／設定：`~/.config/freedom-staging/`，目錄 0700、檔案 0600，不進 git。
- `app.env`：`FREEDOM_ENV=staging`、`APP_ORIGIN=https://staging.freetwai.com`、`PORT=4310`。DB 使用既有 loopback demo DB；不是雲端 DB。
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
3. `systemctl --user start freedom-staging-backup.service`；若有 schema migration，先審核相容性與回退策略。本次 infrastructure 變更無新 migration。
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

還原演練使用 `docker exec freedom-platform-local-postgres-1 createdb -U freedom_local <唯一測試DB>`，透過 stdin 將 dump 傳給同 container 的 `pg_restore -U freedom_local -d <唯一測試DB> --exit-on-error --no-owner`，讀取 users／work_items 確認後只刪除該測試 DB。不要把未演練的還原指向 `freedom_local`。

## 完整 HTTPS 驗證

```sh
FREEDOM_ACCESS_TOKEN_FILE=/private/path/short-lived-token.json node scripts/verify-staging.mjs
```

憑證 JSON 只包含所需 `client_id`／`client_secret`。Cloudflare 對此 app 暫時允許該特定 service token（Service Auth），禁止新增 Everyone／Bypass。驗證完在 `finally` 清除新增 policy 與 token，刪除私密檔案；保留 Ted 原有 allow policy。此憑證由操作者建立，驗證腳本不取得帳戶管理權限。

工具分開匿名和已驗證的 cookie jar，以免 Access 登入 cookie 造成匿名驗證假通過。截圖在 `~/.local/state/freedom-staging/verification/`，不含 API token。工具會登入／登出 maker 示範帳，不改工作或收款紀錄。真人 email／OTP 由 Ted 自行驗證。
