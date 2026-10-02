# 資產與私人工作規格

Spec ID：`UF-SPEC-ASSET-WORK`；狀態：`draft-ready-after-core`。來源：U2/U4、UF-03/04/10、統一計畫 §04–07、16、18。依賴 [CORE](02-principal-command.md) 的身分、scope 與交易介面，以及 [GOV](01-contracts-and-governance.md) 的新契約驗證。

第一個完成條件是會員換頭像仍正常；第二個是本人建立私人文案工作、以明選模型產出草稿，成果經同一 Asset 核心保存並只供本人查看及修改。第二條需 EXEC 的最小 RunAttempt/Grant adapter 才能完成。

## 現有入口與首版範圍

頭像沿用 [API routes](../../../../apps/platform-api/src/routes/avatars.ts)、[domain](../../../../modules/identity-membership/avatars.ts)、既有 member auth 及分享名片讀取資格。新的 `modules/assets/` 擁有儲存生命週期；`packages/asset-storage/` 擁有 runtime-neutral object I/O port。先查是否已有等價實作再新增。

Work 延伸現有 [work_items domain](../../../../modules/opportunity-project-work/work.ts)，保留舊 ID、Claim、參與條款與獨立驗收。私人工作不建立自己認領自己的 Claim，不因模型輸出就新增 Contribution、XP 或 official。

首版只接頭像及 UTF-8 私人文字草稿。其他媒體透過 profile 逐項接入；壓縮包、可執行檔、任意 HTML/JS 及不明格式先拒絕。完整七類 profiles、cutover/backfill/backup/cleanup 見已補齊的 [MEDIA](05-media-migration.md)。

## 資料與生命週期

| 物件 | 必要欄位 | 關係與唯一性 |
| --- | --- | --- |
| assets | asset_id、scope_id、owner_principal_id、purpose、state、content policy revision、created_by invocation、retired_at/delete_after | 一個不可變內容版本；替換產生新 asset，不覆寫原 object |
| asset_objects | asset_id、variant、logical_store、object_key、MIME、size、content SHA-256、etag、transform version、verified_at | `(asset_id,variant)` 唯一，object key 唯一；digest 來自已驗 bytes |
| asset_upload_intents | principal/scope、operation、typed target、expected version、可選 attempt、request digest、asset_id、lease/fence、state、expiry | requester 的 idempotency namespace 與 request digest 固定；不得改 target/attempt |
| domain pointers | 現有頭像/WorkResult 的 typed asset FK 與版本 | 驗同 scope、正確 purpose 及 ready 狀態；不以任意 owner_type JSON 取代 FK |
| work_results | result_id、work_id、可選 run/attempt、artifact ref、revision、provenance、evidence level、submitted_at | 若有 attempt，須屬同 run/work/scope；人工成果可無 attempt |

建議狀態由正式 schema 固定：Asset `pending → ready → retired → deleting → deleted`，驗證失敗可進 `rejected`；UploadIntent `prepared → processing → stored → finalized`，提交前可進 `expired/rejected/abandoned`。claim/lease takeover 必須增加 fence；舊 worker 的 finalize 不能提交。

`stored` 只表示 object 已驗存在；只有 finalize 交易成功才可 ready 並更新 domain pointer。WorkResult 的 submitted/accepted/publication 語意由 Work/domain 管理，不由 Asset state 推導。

GC 只處理無有效 reference、無進行中 finalize、已滿 retention/grace 的 object；鎖定 deletion 狀態後禁止建立新引用，交易外 delete，再記錄結果。重複 GC、delete timeout 與 finalize race 都需可恢復；不能只掃 bucket 名稱就刪除。

## ArtifactRef 及資料政策

`platform_asset` 包含 asset ID、內容 revision、safe representation/digest；reader 先經 domain/Work ACL，再存取私有 R2。wire response 不暴露 bucket credentials、raw object key 或可長期繞過 ACL 的 download URL。

`runtime_local` 包含 runtime ID、opaque handle、revision 及 policy 允許的 integrity metadata。handle 不接受 OS path；只有該 runtime 的受控 reader 可解析。不能上傳 metadata 的情境只回必要 non-sensitive 狀態或 unavailable。此 branch 不建立假的 ready R2 object。

Data policy 分開描述 capture、model processing location/provider、platform persistence、local/platform retention、viewer、publication。禁止上雲時連 request logs、events、error traces 也不能帶原文；asset upload prepare 直接拒絕。衍生結果繼承來源限制，發布需独立 domain operation 及必要去敏 representation。

## Upload 交易與 API 行為

新增 operation IDs `asset.upload.prepare`、`asset.upload.write`、`asset.upload.finalize`、`asset.read`；target profile 引用 `member.avatar.replace` 或 `work.result.submit`。operation registry 決定允許的 auth kinds，caller 不能自填 profile 取得權限。

建議 member HTTP 入口為 `/api/v1/assets/upload-intents` 及 `/:id/content`、`/:id/finalize`；實際路由於 schema PR 固定。execution/service 可以有不同 auth route 組，最後呼叫同一 typed service。不能為新 route 放寬全站 member CSRF/Origin。

1. **Prepare**：短交易驗當前 credential、domain 權限、scope、用途、target version 及配額；建立 intent/lease、固定 request digest。真人頭像不需 Work、模型或 Grant。
2. **處理及寫入**：交易外 bounded streaming、實際檔案格式/尺寸驗證、digest 與轉換，寫 immutable R2 key。傳輸端 content-length 不能取代讀取上限；required variants 齊備才可進 stored。
3. **Finalize**：短交易重驗目前 credential、domain、scope、version、intent fence/expiry 及適用的 attempt/Grant；原子提交 ready、typed pointer、Result 關係、journal/outbox、成功 receipt。
4. **失敗對帳**：R2 成功但 PG 失敗可用同 intent 核對 object 後重試 finalize；若目前權限已失效則拒絕。無引用 bytes 由 GC 回收，不回報假成功。

同 intent 的重試不可另建目標、覆寫 object、重複 Result 或略過 version。已 finalize 的 replay 先驗目前讀取資格；原成功 receipt 不保證失權後仍可取得私人內容。epoch/Grant 失效後只保留有限 evidence，不允許再次 finalize 業務寫入。

現有頭像單次 POST 可作相容 facade，在內部走 prepare/effect/finalize，保留原 idempotency request identity 及 response；無需強迫現有頁面一開始全部改新三步 API。facade 在效果外完成轉圖，不能仍持有 user/session/domain locks。

## 首版驗證 profiles

頭像保持目前輸入上限 2 MiB、靜態 JPEG/PNG/WebP、最大 4096×4096；輸出沿用 256×256 WebP、128 KiB 上限與已存在的 metadata stripping/動畫拒絕測試。transform profile 單獨版控；變更輸出規格需明示相容性。

私人文字草稿建議首版限制 256 KiB UTF-8，purpose=`work.private-draft`，MIME 為 `text/plain` 或 `text/markdown`；這是本 spec 的 proposed 新預設，實作 PR 固定 schema/測試。預覽將內容視為不可信文字；若渲染 Markdown，禁 raw HTML、script 及未驗 URL。尚未固定 retention/grace 前，不啟用自動永久刪除。

讀取 GET/HEAD/Range/條件請求都先驗當前 ACL。私人/可撤銷 share 的回覆與 cache 必須經相同授權；首版採 private/no-store，不能讓 304 或 CDN cache 略過驗權。已下載的本機 bytes 無法追回，產品不得承諾撤銷能刪除訪客既有副本。

R2 缺檔回受控 unavailable/not-found 並產生安全診斷，不 fallback 已撤銷舊 bytes。所有 bucket 預設 private，key 格式不帶 email、share token 或本機檔名。

## Private Work 相容及 ACL

新增 work mode：community collaboration、personal、site service，具體 wire enum 在 schema PR 固定。既有 rows 回填 community mode；personal owner/scope 由 server 決定。site service 保留設計但首版不開，待真實 site principal 支援。

私人工作不能沿舊 community 列表把新 rows 交給旧 UI 過濾；舊 endpoints 必須明確只投影舊模式。所有 mutation 同樣驗 Work 模式與目前權限，不能只堵 read。

| 讀取面 | 私人工作規則 | 必跑反例 |
| --- | --- | --- |
| list/detail/search/count/pagination | 只供 owner；舊 community endpoint 不列出且不洩漏總數 | 同社群 B 搜尋 A 的私人標題及枚舉 ID |
| dashboard/review queue/leaderboard | 不進社群公開/審查投影，不自動加 XP | A 建私人 Work，B 的 dashboard 與統計無可識別變化 |
| notification/event/outbox consumer | 以允許 audience 發最小 metadata，消費時再驗權 | legacy community fanout 不收到私人標題/內容 |
| export/activity/game console | 與來源 Work 相同 ACL；export 不能漏過 mode | B 匯出/觀看活動摘要拿不到 A 私有資料 |
| Result/Asset/share/crawler/HEAD/Range/304 | 每次讀取仍驗當前 Work/domain/share policy | 知道 asset ID、快取 ETag 或舊 share URL 仍不可越權 |
| command replay | 重新驗目前讀權 | 失權後相同 key 不回舊 private response |

實作 PR 以查詢、route/consumer registration 建立完整 surface 清單，表中不存在的入口需附 absent 證據；新增入口自動納入 GOV coverage。相關投影/ACL 未全部通過前，server 的私人寫入 feature gate 保持關閉。

私人工作成果可有人工/Agent 多版本。人編輯後提高版本；Agent 帶舊 expected version finalize 必須 412，保存其待核對產物而不覆蓋人稿。Result submitted 不自動 publish，公開是一項另有權限及確認的 operation。

## Migration 與 bridge

先加 Asset/intent/typed pointer 及 Work scope/mode，再以相容讀取 bridge 支援 legacy bytes 和新 Asset。legacy fallback 只適用明確仍是 legacy 的 row；已切換 Asset 的 row 缺 object 不回舊內容。

backfill 由受控 ops 流程以固定 source revision 讀取及核對 hash；切 pointer 的短交易檢查原 row version，遇到會員同時改圖就重新讀取而非覆蓋。備份、restore、撤銷及對帳證據齊備前保留舊欄位。首筆 R2-only/private Work 成功後，rollback floor 必須支援兩者。

## 可交付 PR 與驗收

| PR | 內容 | 完成條件 |
| --- | --- | --- |
| ASSET-A | Asset schema、ports、intent 状態及假 store | size/format/scope/fence、R2 成功 PG 失敗及 GC race 測試 |
| WORK-A | 舊 Work 所有讀面及投影的 mode/ACL | feature gate 關閉下的正反例；既有 community Claim/Review 回歸 |
| ASSET-B | 頭像 R2 bridge、短交易及共用 client | 真人頭像全流程、名片/聊天/目錄讀取、撤銷與版本競態 |
| WORK-B | 私人草稿/Result、人稿版本、execution finalize | 同核心 A+B；真實指定模型產稿及 owner-only 讀取 |

最少覆蓋 UF:INT-01/02/03/05/08/10/11/26/28。加入 U1 revoke/finalize、外部 I/O lock-duration 測試：讓假 store/processor 暫停時，另一連線仍可完成撤銷，之後 finalize 被拒。真實 R2/Images 另由有權 staging runner 驗，mock store 通過不能當雲端證據。

沿用現有 `npm test`、`npm run test:worker`、`npm run test:e2e`、`npm run test:repos`；UI 有變更先 build。所有新增 cases 均需實作 PR 登記 test IDs；本輪產品驗收 `not_run`。
