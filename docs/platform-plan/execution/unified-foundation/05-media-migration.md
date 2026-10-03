# 七類媒體搬遷與恢復規格

Spec ID：`UF-SPEC-MEDIA`；狀態：`profile-io-and-aggregate-inventory-local; domain-backfill-restore-pending`。來源：[R2 原文 §3–11、17–21](../../../plans/platform-restructure-r2.md)、Unified Foundation §05–07、13、16。依賴 [ASSET-WORK](03-assets-private-work.md)；共用 Asset/Principal/Scope，不另建 media 專用身分或儲存真相。

本規格補齊搬遷程序與驗收，不代表已讀取正式資料或配置 R2。七類 schema 來源已取得；每類目前資料量、完整呼叫面及限制仍由實作前的唯讀盤點固定。

## 範圍與 profile registry

下表 purpose 名稱為本組 proposed stable IDs，須在中央 operation/profile schema PR 一次定版。新上傳沿用各 domain 已存在的格式、大小、尺寸、動畫與 metadata 規則；不得把頭像 cap 套到全部圖片。歷史 backfill 不重新轉圖。

| Profile | 現行 bytes source | Typed pointer / variants | 必保留行為 |
| --- | --- | --- | --- |
| member.avatar | member_avatars.image_bytes | asset_id；頭像 representation | 會員資格、版本 URL、清除、分享 opt-in；限制見 ASSET-WORK |
| skill.submission-image | skill_submissions.image_bytes | image_asset_id | 私人草稿/公開狀態、升級投稿、作者歸屬 |
| community.event-banner | community_event_banners.image_bytes | asset_id | 活動 scope、poster orientation、公開 page |
| community.event-video | community_event_videos.media_bytes | asset_id | 現有 MP4/WebM、原大小上限；不新增轉碼服務 |
| community.event-highlight | community_event_highlight_images.bytes | typed asset/variant ref；image、thumb | variants 成對完成、移除權限、公開顯示 |
| community.social-thumbnail | community_social_post_thumbnails.image_bytes | asset_id | 來源 metadata、作者替換/移除、fetch 失敗允許無縮圖；保留 SSRF 防護 |
| member.service-cover | member_service_covers.image_bytes | asset_id | 暫停、隱藏、刪除後舊 URL 不可繞過 |

ASSET-A 提供共同機制，ASSET-B 先接頭像；MEDIA-B/C 再用同一機制接其他六類。靜態 CSS/Logo/built-ins 留在 Git/Workers Assets，未需持久化的名片下載圖留在瀏覽器；salt、hash 等非媒體 bytea 不搬、不禁止。

`media:inventory` 的目標輸出為每類 source table/key/variant、讀寫入口、presence projections、政策及 transform 版本、row/null/empty/orphan/未知 MIME 數、總量及最大 bytes。另掃 base64/text/JSON 與永久 local disk 寫入，不只 image_bytes 字串。正式資料只由有權環境產生去識別彙總；禁止帶原圖、私人 URL、token 到本機或 PR。

實作 PR 附 profile fixture manifest，逐列列出既有數值限制及其 source/test 路徑。未知格式不自動轉成合法；歷史異常明列 exception，不能靜默刪除或公開。

## Store、配置與資料約束

共用 Object I/O 已與固定用途 profile 分離：七類用途／八個 variant profile 保留各自 byte cap，原頭像與小文字驗證維持；通用 bytes/hash 有界上限為 20 MiB。Native R2 的 Range／media GET 以 pull stream 傳遞；partial Range 標記 immutable ETag pin，明列未驗整個物件 SHA-256，完整 verify 仍核對實際 bytes。這是本機 workerd 證據，未完成其他六類 domain／typed pointer／migration adapter。

ObjectStore port 提供 putImmutable、get（含單一已驗 Range）、head、delete；list 僅供有界維運，不作正常 page 的存在判斷。以 Web streams/runtime-neutral metadata 接口隔離 Workers R2 binding 與 ops adapter。若維運需要 S3 SDK，只能在 ops bundle；不為測試要求每人架 MinIO。

每環境一個私有 asset bucket，backup bucket 分離且不綁一般 app Worker。原提議 media bucket 名稱可沿用。此組選 `MEDIA` 作初版 native binding 名稱，logical store ID 與 wire schema 不暴露實體 bucket；已有相容名稱則以 mapping 接入，不為改名搬 bytes。R2 原文 A06、D10 同樣適用這項 mapping。

有權 operations 驗證 staging/prod/bucket/DB 對應、關閉匿名 r2.dev/custom-domain 直讀、CORS 最小化、權限及備份隔離。尚未取得 cloud evidence 時不得標 configured。r2_only 時缺 binding 或 R2 故障回功能級 unavailable，不退回 DB 存 bytes，登入/純文字功能仍可用。

Typed FK 必須驗 asset/target 同 scope、purpose、ready state；variant 唯一且 required variants 全部 verified 才可掛 pointer。既有 NOT NULL/check constraints 必須 expand 成合法 legacy bytes 或有效 pointer，讓 R2-only insert 真正可行；原本可無圖的業務仍可無圖。

Presence projection 使用 active pointer，或「明確未搬遷」legacy bytes。會員、名片、聊天、公會、活動、服務、推廣、onboarding、排行榜、技能清單都要盤點；保持 has_image/avatar_url/版本 DTO，不為了判斷有圖去讀整個 blob 或 LIST bucket。

Object key 不可變，不跨 owner 做 dedupe；實際 bytes 的 SHA-256/size 才是內容證據，R2 ETag 不當內容 hash。重試必須 read-back 驗同內容；相同 key 不同 bytes 不能覆寫。

## 上傳與讀取補充

沿 ASSET-WORK 的 prepare → 交易外處理/PUT → finalize。預留 quota、intent identity、expected version/fence；同 key 同內容只提交一次，同 key 不同內容 409。R2 成功但 PG 失敗不得 ready，variants 部分成功不得掛 pointer；重試舊成功 receipt 不把已被取代的圖掛回。

新 upload 可轉換/去 metadata；backfill 必須保留既存 bytes。SSRF preview 的原始 URL/redirect/private-network/大小限制在下載與存檔前仍有效。第一版不要求 browser 直傳、presigned 或 multipart；將來新增也必須經相同 intent/finalize 與清理規則。

保留 domain URLs 與既有授權入口，不強迫所有媒體換通用公開 route。GET/HEAD/Range/If-Range/304/cache hit 都先驗當前 domain/share ACL。私有及可撤銷內容 no-store，CDN 不可跳过驗權；長效 presigned read 不適用立即撤權。

影片保留 MP4/WebM：單 range、suffix、超界 416、合法 206/Content-Range、HEAD headers、If-Range 不匹配回完整內容；multi-range 首版不產 multipart，忽略該 Range 回 200 完整 representation，不能誤回一個單段為完整內容。staging 用實際 player 驗 seek。HTTP stream 不得因改用 streaming 而放寬格式/大小驗證。

ACL 的承諾是撤銷後的新授權判斷拒絕，不宣稱可收回已下載 bytes；在途 response 的授權快照/線性化點須明載。必测名片撤銷/rotate/取消 avatar opt-in、session/user/guild 失權、活動範圍改變、服務暫停/隱藏/刪除、技能取消公開。

## 線上搬遷階段

| 階段 | 可讀/可寫 | 進下一階段的門檻與回退 |
| --- | --- | --- |
| Expand | 原讀寫；新增 Asset、intent、typed pointer、相容 constraints | 空庫/既有資料 migration；不把 blobs/network 工作放 SQL |
| Bridge | pointer 優先；僅 legacy rows 可 fallback；尚未切換者維持舊寫法 | 全部讀面/projections、所有重疊 Worker 均理解 R2；原 URL 回歸 |
| Cutover | 按環境/類別切 r2_only，新寫入不再存 DB media bytes | 實際 binding/備份/失敗演練；**首筆 R2-only 成功後只可回退 R2-aware bridge** |
| Backfill | 新寫 R2；有界搬既有 bytes，CAS 更新 pointer | 每 row/variant 有可續跑紀錄、實際 hash、競態測試 |
| Verify/delta | 持續新寫及核對變更 | 全量每項可分類，無未處理 missing/cross-scope/dangling；read parity |
| Cleanup | 移除舊 reader，再分批清 bytes，最後 drop schema | 所有七類、支援 client、restore/rollback floor 已通過；獨立 PR |

不能先改舊 migration 016/028/045/050/065/066/067 的 SQL 來「讓新庫直接是新狀態」。依 [過渡決策](00-baseline-and-decisions.md) 使用當下可用 numeric migration；v2 runner/helper 全數相容才切新命名。RS-03 不必等待 v2 才做本機 fixtures/相容數字 schema，但正式切命名的 gate 不降低。

Cutover 以中央 write policy/DB enforcement 阻止舊 writer。只有 column REVOKE 而 table-level INSERT/UPDATE 仍存在，不算證明；必須實測同角色直接 SQL、舊 Worker、重試/queue 路徑都不能新增媒體 bytes。允許的 metadata 更新與清空舊欄位有明確例外，crypto bytea 不誤傷。

Backfill 作業固定 migration ID/source identity，keyset 分頁；建議初始 metadata batch=50、I/O concurrency=2，影片可降 1，另限制總 in-flight bytes。這些是待壓測預設，不是容量承諾。

每筆程序：讀 source revision/bytes → 交易外驗 size/hash、寫 immutable object、read-back 驗證 → 短交易鎖來源並比 revision/刪除狀態 → 掛同 scope pointer/journal → 記錄 checkpoint。無可靠版本欄位時在鎖內比 timestamp 加原 bytes hash；不能只用先前讀到的 hash 推定目前未變。來源改/刪就 skip-stale 或重新排程，不復活舊圖；未引用物件按 GC 對帳。

Verify 報告每 row/variant 必屬 verified-linked、合法 deleted/replaced、或具原因 exception；exception 未解決不宣告全量成功。檢查 dangling pointer、object missing/corrupt、scope/purpose、byte count、實際 digest、presence projection 與授權回歸，持續 delta 到無未分類項。

## GC、備份與恢復

沿共同 Asset lifecycle。R2 原 `abandoned` 在這組對應未 finalize 的 UploadIntent，不建立第二套可見 Asset enum。GC 短交易檢查沒有 live pointer/intent/backup pin，領 deletion fence 後禁止 attach；交易外刪除，之後記結果。lease 逾期與重送可對帳；GC 之後才完成的遲到 PUT 由 orphan scan 再清理。

Ted 於 2026-10-02 同意的頭像清理起點：未完成且未被引用的物件至少保留 48 小時、一般替換的舊圖保留 7 日、使用者刪除後立即不可讀。實際回收仍須同時滿足沒有 live reference/intent/backup pin，並取得 deletion fence；不能只按物件年齡刪除。這項同意不表示正式清理已啟動，也沒有批准備份保留、刪除或還原政策。7 日不是無條件恢復使用者刪除內容的權限，ready object 不做全 bucket 到期清除。原 R2 提議的 intent 24 小時 abandoned 判定仍待實測定版，不能與這次保留政策同意混為一談。

Maintenance 每 run 限批數、物件数、時間與 in-flight bytes，與 GitHub sync 預算分離。使用共同 queue transport 不改 DB 的 truth；單純媒體功能不依賴模型/Grant readiness。

Backup 在取得一致 DB snapshot/reference set 前先與 GC 建立有期限的 reference-capture barrier；集合枚舉完成、逐 object backup pins 已生效才釋放 barrier。pins 可有界續期；此協定必測「拍 snapshot 後原 pointer 被替換」的競態，不能留下先刪物件再加 pin 的空窗。網路複製期間不持有業務 DB row locks。

Manifest 固定 snapshot ID、source release/schema、store mapping、每個 object 的 key/size/實際 digest、複製結果及完備性。新寫入屬下一個 snapshot；required objects 全部驗證後才標 complete。barrier/pin 過期或物件缺失就 incomplete，不把部份備份當成功。

Restore 在隔離 `fp_*` DB/schema 與測試 bucket 演練：還原同一集合、重新驗 hash/ACL/presence，再套不隨舊 snapshot 回退的刪除/撤銷紀錄。受刪除政策禁止恢復者不可重新可見。一般 Worker 沒有 backup delete 權，不能擅自開 bucket lock 而阻擋合法刪除。

含 execution 的環境另外遵 EXEC-OPS recovery generation、停 dispatch、unknown effects/outbox 對帳；只還原 R2 或只還原 DB 均不足。

## 工具、發布與證據

`media:inventory` 已有 [唯讀彙總工具](../../../../packages/media-migration/README.md)，預設 dry-run；只驗過合成 PostgreSQL，正式資料盤點尚未執行。它沒有實際內容 hash／image decode、完整讀寫入口與 base64/local-disk 掃描，不能把 aggregate report 當作搬遷或 restore 證據。`media:backfill/verify/finalize` 仍待實作。修改型命令預設 dry-run，必填 environment、expected DB identity、bucket identity、release SHA、profile/migration ID 及批次界限；不从空環境值退回 freedom_local.public 或正式預設。長作業保存可重啟 checkpoint、bytes/latency/failure metrics；log 不含原內容。

有權操作依 staging smoke → 故障/併發 → bridge → 類別 cutover → 有界 backfill/verify → DB+R2 restore → prod 相同程序。另遵 Ted 發布槽/備份/migrator/grants-check/app-probe/health 流程。schema/release/backup/backfill 不受一般 PR concurrency 自動取消。

| PR | 範圍與前置 | 必要驗收 |
| --- | --- | --- |
| MEDIA-A | 七類限制/入口盤點、ops 私有接線契約 | R2:S01/S11、A06、D10 的 fixture；cloud 接線另外授權/證明 |
| MEDIA-B | 技能、縮圖、服務 profiles；依 ASSET-B | 私人/公開/作者/SSRF/服務狀態，現有 DTO 回歸 |
| MEDIA-C | 活動 banner/video/highlights | variants、scope、Range、實際影片 seek |
| MEDIA-D | backfill/verify/GC/backup/restore；可先用合成資料 | R2:S03–10、M01–07、撤銷/刪除不復活 |
| MEDIA-E | 類別正式 cutover 與全量核對 | 七類 staging/prod 實際 evidence；不是本輪操作授權 |
| MEDIA-F | 清 reader/bytes/schema；依 U7 floor | R2:M08、全部 read parity、支援版本與 restore |

完整原始案例見 [R2/AP 驗收](source-acceptance.md)。所有產品驗收 `not_run`；只有 source/schema 文件不代表資料已搬完。
