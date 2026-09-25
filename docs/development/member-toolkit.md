# 0.7 — 會員頭像、技能書與管理員任命

會員在「我的名片」上傳、預覽、保存或移除頭像；名片、首頁與右上角使用同一張圖片。技能書各有專屬插圖、短摘要、閱讀／專案／Fork／原作者 Star 連結。共創任務、供貨目錄與小隊各自提供搜尋篩選；篩選不替使用者認領或加入。

「我的定位」只顯示已確認的結果、公會與技能書，不再放另一份合作偏好／職業方向表單。「重新探索定位」開啟原定位流程，帶入已選公會；草稿不覆蓋已公布名片，確認完成後才更新。舊版獨立偏好資料與 API 保留相容性，但不再作為會員頁面的第二套定位來源。

網站文案採直接動作，不加「能做什麼／先做哪一步」導讀。技能書詳細練習與來源可展開閱讀。品牌原始 Logo 保持原檔；22張插圖使用內建 imagegen 各別生成，提示集、尺寸與雜湊見 [插圖 manifest](../design/skill-book-art-manifest.json)。

## 管理員操作

後台「會員管理」搜尋暱稱或 Email，按「任命管理員」，核對人選與權限後確認。現有管理員皆為 super_admin，能管理會員、公會及管理員，不另虛構有限權限角色。「管理員名單」可停用或重新啟用他人；停用會員和停用管理權限是不同操作。管理權限變更立即在 API 生效，Access 精確信箱名單另行同步。

新任命顯示待同步，操作服務讀回 Cloudflare 名單完全一致後才顯示可登入。使用者仍須本人完成 Access 信箱驗證；平台不代取 OTP、不寄假邀請。真實地址保存在私有資料庫與操作環境，不寫入 repo。

## 部署與復原

1. 備份既有資料庫，安裝 lockfile 依賴（含 Sharp），build。
2. 套用 migration016（頭像）及017（管理員版本／同步）。兩者皆為追加結構，不刪除會員或既有定位資料。
3. Web server 仍使用既有 Access issuer、audience、CSRF secret；不加入 Cloudflare API token。
4. 獨立 worker 以私有環境執行 `node --import tsx scripts/sync-admin-access.ts`，每15秒重試。設定 DATABASE_URL、CF_ACCOUNT_ID、CF_API_TOKEN、FREEDOM_ADMIN_SYNC_APP_ID、FREEDOM_ADMIN_SYNC_POLICY_ID、FREEDOM_ADMIN_SYNC_DOMAIN（例如受保護的host/admin）。以最小 Access application policy 編輯權限供應操作憑證。
5. 初次以 `--force` 讀回整份名單；之後有未同步版本才呼叫提供者，另每15分鐘用 `--force` 檢查偏移。正式與staging使用各自 DB、app/policy ID，不混用。
6. 要讓 Castle 關機後名單仍更新，改部署沒有 route 的 cron Worker。設定名稱、secret、發布、確認與回退見 [deploy/cloudflare README](../../deploy/cloudflare/README.md) 的「管理員 Access 同步 Worker」。不要和這個 timer 同時跑。Timer 是該 Worker 失常時的回退。

同步程式只接受單一社群、指定 self-hosted app 與唯一 `Nominated Freedom super administrators` allow policy，保留逐一信箱條件；不改成 everyone、不加 bypass。所有角色變更與同步共用交易鎖；不同步過期快照。提供者失敗或設定不符時維持 pending 並退出非零，下一次重試。權限資料以 DB 為準，舊私有 bootstrap 清單只建立初始人選，不能在部署時復活已停用管理員或覆蓋後台新增人選。

復原應回退程式 release，保留追加欄位與會員資料；停止 worker 後可由受信操作人員核对 DB 及 Access。不要以舊的五人靜態名單覆蓋現行管理名單。既有 DB 備份包含頭像；刪除頭像不等於立即從歷史備份抹除。

## 驗證入口

`npm run typecheck`、`npm run build`、`npm test`、`npm run test:e2e`、`npm run test:contracts`、`npm run test:repos`。頭像測試驗證格式／限額／持久性／跨社群拒絕／版本重試；管理員測試使用合成 Access 身分與隔離 DB，同步測試只替換提供者 HTTP。瀏覽器覆蓋頭像、單一定位、22本導讀、搜尋及任命。線上驗證腳本只建立明確標示的測試会员，結束後由私有cleanup撤銷帳號和session；不以真人管理員進行測試任命。
