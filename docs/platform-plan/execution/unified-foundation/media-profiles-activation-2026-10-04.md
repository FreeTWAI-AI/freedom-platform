# 其餘五類媒體的實際 R2 啟用（2026-10-04）

接續[頭像／海報搬移與舊庫退役](r2-recovery-retirement-2026-10-04.md)，本輪完成技能圖片、活動影片、活動精華、社群縮圖、服務封面的 staging 正例，再部署至正式站並驗證真實寫入。兩環境仍使用 #110 的 `d269a8d7605630cab1da605d7cac4d0c254e3258`；這次改的是經核對的 Worker 配置與 SQL storage policy，沒有把未合併 PR 程式混入部署。

六個媒體 flags（包括前輪已啟用的 banner）均為 ON，七類 storage policy 均為 bridge。頭像沿既有安裝，不另有 avatar flag。Private AI、broker／machine 執行仍未啟用；GC 關閉；新庫中的歷史 bytea 副本與所有恢復物件保留。

## 操作前置與部署

| 範圍 | 實際核對 |
| --- | --- |
| staging | 五類均無既有非空 bytes；使用現行 staging logical DB／migrator／MEDIA bucket。 |
| 正式 | 技能投稿 metadata 有 7 列，但 image bytes 為 0；其餘四類 bytes 表為 0 列。不是把 metadata 列數當檔案數。 |
| 新 policy | 五類 `mode=bridge`、`persistence_allowed=true`、revision `media-profiles-20261004-v1`、每一既有 policy scope 的 retained quota 64 MiB。既有每檔大小限制未變。 |
| 啟用競爭 | 正式切 policy 的 transaction 先鎖五類 policy rows，再重查非空 bytes 仍為 0，才更新並 commit；未重跑資料庫移植或清除原資料。 |
| staging Worker | `5cfdce7d-3e99-4d35-bbb4-a4d0bb52eb39`，health／首頁 200，release SHA d269。 |
| 正式 Worker | `ea51ed37-abf6-4bb5-93e2-8143aaad7abe`，health／首頁 200，release SHA d269。 |

Private release helper 先完成 staging／production 分開的 30 項 floor 正反例，再以兩環境六媒體 ON 的 22 項檢查驗證 source pin、flags、Tokyo placement 與 bucket identity。canonical helper 與 `release-latest.txt` 已指向新正式 plan。舊 banner-only 或 all-OFF template 不可再次部署；未來 source SHA 更新仍須核對 reader 相容性，不能只改 pin。

## 實際 HTTPS 與瀏覽器驗收

staging 以真實 HTTP 註冊、登入及 onboarding 建立兩個自己管理的帳號，沒有直接鑄造 session。共 167 項明列 assertion 通過，分別保存原始 receipts；數量不是完整產品驗收的替代品。

| 用途 | 本輪實際驗證 |
| --- | --- |
| 服務封面 | 建立服務、上傳、owner／public 同 bytes、與 R2 metadata digest 相符、同 key 重播、其他會員寫入與錯誤 CSRF 拒絕、替換、暫停後公開不可見、移除、新寫入 SQL bytes 為 NULL。 |
| 活動影片 | 上傳有效 3 秒 VP9 WebM、完整 digest、ETag／If-Range、206 部分內容、416 越界、舊 If-Range 回完整內容、待審核時 peer／public 隱藏、重播、公開 GET／HEAD／Range、移除及取消。Chromium 真正解碼 160×90、播放時間前進，再 seek 至 1.8 秒成功；沒有使用只有 signature 的假影片充當播放證據。 |
| 技能圖片 | 一次性 grant 實際 Agent API 上傳、owner 私人讀取、peer／未發表 public 拒絕、同 payload 重播、改 payload 的同 grant 拒絕、撤回後 grant 401；本人可保留私人草稿圖片是現有行為，未偽稱撤回等於刪除 R2 物件。 |
| 社群縮圖 | 作者手動上傳、owner／peer／public 同 bytes、重播不新增 object、非作者寫入與錯誤 CSRF 拒絕、替換、刪文後所有測試讀取 404。 |
| 活動精華 | 由自己建立的活動 fixture 上傳照片，image／thumb 兩份 R2 representation 完整 digest、公開讀取、重播不新增 media、非作者移除拒絕、移除後兩份 URL 均 404，SQL pair bytes 為 NULL。 |

staging 公開媒體驗證帳號使用保留的 `.test` domain，明確屬於受控 fixture；另一帳號使用 `example.invalid`。部分公開路徑刻意排除 verification-test 帳號，因此不能用被排除帳號的 404 宣稱公開正例成功。活動的已發布／已結束條件僅對本輪自建 IDs 以 migrator 設置，未冒充真人審核流程；社群手動縮圖 fixture 的 metadata 也由限定 owner 的 SQL 前置建立，沒有將其記成外部 preview 驗收。

正式環境使用另一個 `example.invalid` 自有帳號：五類 writer 全部實際上傳，四類 owner HTTP bytes 與 R2 digest 相符，活動精華 pair 另直接完整讀回 R2；六份 representation 均核對 SQL bytes 為 NULL。正式公開精華與技能的隱藏條件仍有效。

正式另以真實 `POST /api/v1/social-posts` 分享本組 GitHub repo URL，實際取得網頁 preview、經 IMAGES 正規化後保存 R2，驗證 pointer、HTTP digest、receipt replay，再立即刪除該測試貼文與確認 public 404。這補的是自動 preview writer，不能用手動上傳代替。

本輪有幾項測試腳本修正，失敗原始紀錄均保留：registration 的多餘欄位被 strict schema 422 拒絕；highlight SQL bytes 欄名改正；Playwright evaluation 的 TypeScript／序列化問題修正後才取得播放成功。正式社群縮圖原先預期 test-account public 404，實際為 200；查核現行 source／既有測試後確認 active 社群貼文縮圖本就公開，未更改此權限來迎合測試，改核對原有公開行為及刪文後 404。不能將測試信箱當成所有模組的全站隱藏保證。

## 恢復與收尾

staging 實際同 snapshot DB＋R2 archive 已上傳到獨立 recovery bucket、完整下載比 SHA，再還原到自有隔離 PostgreSQL 18 及原生 Miniflare R2。18 個 objects、30,056 bytes 全部核對，DB references 與 capture manifest 一致。Archive 1,546,240 bytes，SHA-256 `dfa378bc0a438e063e7fdffd49e8b6d34483cc1b15231de509ad1fbfec799ead`；不是只有 TOC 或上傳成功。

正式於 22:03:45 UTC 完成本輪新 snapshot 的同樣恢復：37 個 objects、382,316 bytes，包含前輪 30 個物件與本輪新增的 7 份 representation。Archive 5,744,640 bytes，SHA-256 `957b20c4bdcffb2459f6f82adab43e2739c9fe628b37172707f478211053070d`；SQL dump 5,114,193 bytes，SHA-256 `9783c0efd4869f0261aeb2f7488ef408f276eda28c2987f32de3c5643c04d294`。完整下載、隔離 PG restore、DB references 及 native R2 bytes 均通過；兩個本輪 restore DB 均由 finally 移除。這不冒充另一雲端供應商的 failover。

正式最後 20 項清理驗證通過，一個自有帳號 inactive／sessions revoked，服務、貼文與精華移除、影片移除與活動取消、技能 grant 撤銷並回 401。staging 兩帳號已 inactive、sessions revoked；公開 fixture 媒體已移除，兩活動取消。撤回的私人技能草稿與 retired objects 保留；不啟用 GC。新的日備份沿現有 timers／offsite steps 執行，staging 21:57:56 UTC、正式 22:07:14 UTC 的 offsite readback 均成功；它們仍是 dump 後 immutable object superset，與本節的同 snapshot restore 證據不同。

最後重新核對兩環境首頁／health 200、匿名 session 401、d269 release、六個 media flags ON、Private AI OFF、六筆 domain policy 加獨立 avatar policy 均 bridge、GC OFF 且 deletion fences 為 0。兩份臨時 Access grant 均已撤銷；撤銷後 staging 正常回 Access 302，正式 health 200。自有測試容器確認無其他 client 後移除，其他容器與原 checkout 未動。

## 交付邊界

七類媒體現在有實際 R2 路徑與新寫入核對，既有正式頭像／海報已搬完。仍保留 bridge／legacy bytes；未完成的 GC／legacy purge 前置不因本輪成功就自動批准。影片本輪真人瀏覽器 proof 是 WebM；未把 MP4、所有 highlight kinds、真實 GitHub 發表審核或所有跨瀏覽器組合標成已重跑。

此工作不完成 P2 的全組可信 library／入口治理，也不完成 P3 的本人模型、配對與 Stop／Revoke 真人流程。Public aggregates 隨 repo 提交；帳號、cookies、keys、object keys、SQL row references、原始 dumps 與完整 API receipts 只在 `freedom-media-profiles-20261004` 私有 journal。

## P1 補充：受控瀏覽器與 synthetic 帳號 HTTPS 驗收及新封存

本輪在 staging 的 `d269a8d7605630cab1da605d7cac4d0c254e3258` release，以兩個新建、由操作人管理的 synthetic 帳號補驗 MP4 與精華媒體變體；帳號 provision 的 11 項檢查通過。這是實際 HTTPS／Cloudflare／R2 路徑與受控瀏覽器操作的證據；帳號及內容仍是測試 fixture，不代表一般會員或所有裝置的全面驗收。以下補充前節 WebM-only 的當輪邊界，未改寫先前紀錄。

| 補驗範圍 | 實際結果 |
| --- | --- |
| H.264 MP4 | 160×90、2.4 秒影片，實際上傳、完整 digest、R2、SQL 無新檔案 bytes、Range／If-Range／416、peer 404 與 receipt replay，共 21 項檢查通過。 |
| Chromium 播放 | 播放時間前進 0.448 秒、seek 至 1.8 秒及 HTTP 206，共 7 項檢查通過。首輪曾出現 `decode_error`，未保存足夠診斷供判定原因；其後同一 URL 重讀成功。首次解碼失敗仍是未釐清的紀錄，後續成功不消除它。 |
| 精華圖片與連結 | PNG photo、JPEG portrait poster、WebP photo 及 link，共 51 項檢查通過；三張圖片及其 thumbnail 均經實際 Cloudflare 路徑、R2 與 SQL 無新檔案 bytes 核對。 |

第一次 PNG POST 在 60 秒時逾時，服務端實際已發布。操作人查核原 `command_receipt` 後，以同一 idempotency key 重播取回結果，確認沒有重複資料。這次 timeout 與其恢復方式一併保留，不把逾時當成沒有寫入，也未換 key 重新建立。

這些結果補足指定 MP4 與圖片／link 變體的受控正例；尚非跨瀏覽器、平板或所有裝置組合的全面證明。其他 P1 的 GC、reader floor 與 legacy bytes 清理仍未啟用，既有保留與相容性要求不變。

### 本輪新的同 snapshot 恢復集

2026-10-05 00:58:32 UTC 的新 staging archive 使用 operator source `93e470e9b3f7b93c05cf63ccf6bc1fa5a4c1a253`。192 個 tables、4,018 rows、2 個 sequences（advance 為 0）、25 個 objects（44,267 bytes）完成 restore、evidence comparison、完整 remote readback 與 native R2 驗證。狀態為 `quarantine_not_approved_for_exposure`，GC OFF 已確認，自有 restore 資源已清理，readback cleanup 為 true；沒有據此批准對外 exposure 或 GC。

| 證據 | SHA-256 |
| --- | --- |
| Recovery-set manifest | `83b8c41c1d4df580aec7534361386b05cea0f0bbe99095e6910c5d6713b4402c` |
| SQL dump | `6e6a67b655d5cef7829fa078fc5cf1fa1f7d957cc5a7a088fb749db0993d2a4c` |
| TAR archive | `4eb305ff94d09bfdc35a9744b98f42613b2476cbb92a782b3ae4d26a0e5c5746` |

清理後，既有 staging daily backup service 於 2026-10-05 01:02:35 UTC 完成 main step，01:02:54 UTC 完成 offsite post step。操作人核對完成 receipt 時間為 `2026-10-05T01:02:54.035Z`：25 個 objects、44,267 bytes，archive 1,607,680 bytes，SHA-256 `fc9a00f1b8a8b53af7c04f8d6d5f8654a402c71daedfb89cd1b6ccddde08ae87`，`fullReadbackVerified:true`、`requiresGcDisabled:true`。這仍是既有 dump 後 immutable object superset 方法；完整 readback 成功與上列新 coordinator 同 snapshot archive 的恢復證據分別記錄，不能視為 daily service 已切換新流程。

### Lifecycle 收尾與目前邊界

後續 36 項 lifecycle 檢查通過：移除本輪 video、images 與 link，取消兩個 events，停用兩個自有 synthetic users 並撤銷其 sessions。新建的臨時 Access policy／token 已撤銷、刪除。收尾核對正式 health 為 200、release 仍為 d269；staging 回到 Access 302。

本節僅保存操作人提供的彙總與 digest metadata。私有原始紀錄定位為 `freedom-platform-push-20261004/media-variants-live`；此文件不包含其內容、帳號、憑證、object keys 或原始 receipts。P3 本人模型與配對的驗收邊界不因本輪 P1 媒體補驗而改變。
