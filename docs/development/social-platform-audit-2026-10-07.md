# 自由工坊社群功能盤點：2026-10-07

這是一份具日期的產品／程式盤點。Foundation 的現況仍以
[current-state.json](../platform-plan/execution/unified-foundation/current-state.json) 為準。
本輪由 Hao 明確要求查最新進度、比對其他人的 PR，並提交缺少的社群功能；Codex 協助程式、測試與盤點。
同輪追加需求：保留功能但大改會員版面、首頁直接呈現社群動態、減少說明文字並突出重點，以及一次清除通知／聊天未讀提醒。此快照包含這些實作。

Hao 後續要求以取代 Facebook 為長期目標。候選版尚無超越 Facebook 或最佳版面的證據；[下一階段產品方向](social-platform-product-direction-2026-10-07.md) 將日常交流、找夥伴、完成合作與回報分為可驗證的流程，未完成項目保持提案狀態。

## 已上線與已合併

- 本輪正式站 `/api/v1/health` 回報 `8d2213d7f36fd9b0613d16fbf71858be5001a4ad`、Cloudflare Workers、`money_movement_enabled=false`。
- 開工時主線是 `57b610abe0277e4b0fda711f45dd063540252ad0`。主線比正式站新；未部署的程式不能當作已上線功能。
- #85 聊天與 #87 名片雖以單獨 PR 關閉，已透過 [#110](https://github.com/FreeTWAI-AI/freedom-platform/pull/110) 合入。合併 SHA `d269a8d7605630cab1da605d7cac4d0c254e3258` 是上述部署版本的祖先。#90 的作品簡化已直接合併。
- #167 提供 30 天會員登入；主線另外已有公會啟動台、Tenant 與私人 AI 的基礎程式。功能旗標及部署／使用驗收仍需分開核對。
- 正式站註冊畫面已只要求 Email、密碼，名稱選填，定位可稍後做。真人首次加入能否在 30 秒內完成本輪 **NOT_CHECKED**；沒有建立正式會員來湊成功紀錄。
- Staging 的登入後流程本輪 **NOT_CHECKED**：沒有可用的 Access／會員登入狀態。本輪使用合成帳號與隔離 PostgreSQL 做開發驗證。

## 與日常社群產品的差距

這裡以「容易發文、開始對話、回來繼續互動」作為比較標準，沒有用功能數估算與 Meta 的完成百分比。

| 使用情境 | 主線現況／證據入口 | 本輪或下一步 |
| --- | --- | --- |
| 簡單加入 | Email／密碼、選公會、定位選填；[會員 API](member-api.md) | 已存在；下一步量測真人首訪完成時間與放棄點 |
| 自由開始私訊 | 同社群有效會員可開始對話；`member-communications/service.ts` | 沿用；不另外建立第二套 Messenger |
| 公會／小隊聊天 | 原頻道與即時成員資格檢查；`member-communications/channels.ts` | 已存在；離開頻道不能讀寫，正文不混入總頻道 |
| App 式聊天室 | 手機單窗／返回、桌機雙欄、草稿、四張貼圖、回覆、已讀 | #110 已採用；本輪跑原瀏覽器回歸 |
| 即時傳輸 | 可見對話每秒查 activity；私訊列表每 8 秒更新 | 尚無 WebSocket／SSE 即時推送。輪詢間隔不是端到端延遲保證 |
| 聊天媒體 | 文字與固定貼圖；[聊天升級](social-project-upgrade.md) | 尚缺傳照片、檔案、語音、輸入中與通話 |
| 直接發文 | 原分享區需要外部網址；`community/social-posts.ts` | **本輪新增原生文字貼文**，保留原外部連結 |
| 日常互動 | 原分享區只有推廣點擊與外部分享 | **本輪新增按讚、取消讚、留言、分頁、作者刪除與管理員刪除留言** |
| 動態範圍 | 原列表依社群、時間與外部平台篩選 | 本輪加入工坊貼文分類和手動更新；尚缺追蹤／公會動態、收藏、內容搜尋與推薦 |
| 發布媒體 | 現有縮圖管線處理單張 640×360 圖片 | 本輪沿用管線，可在發布後加入圖片；多圖、影片、全尺寸媒體與發布前附件仍待做 |
| 通知／信任 | 原站內通知、公會資格、作者刪除、平台管理員隱藏 | 本輪新增一次全部已讀；尚缺貼文互動通知、裝置推播、封鎖／靜音、檢舉、申訴與完整處分紀錄 |
| 作品／合作 | #90 簡化作品；已有需求、任務、合作、驗收紀錄 | 沿用真實來源；不把按讚或推廣點擊轉成貢獻、XP 或分潤 |
| 社群電商 | 商品、供貨、商店與合作草稿；正式站金流旗標關閉 | 正式結帳、退款、爭議、實收核對及可執行分潤仍未完成 |
| 規模與速度 | Workers／PostgreSQL／R2；建置主 JS 約 305 KiB gzip | 沒有萬人同時在線壓測、正式聊天 p95 或完整真人 UX 研究證據；不能宣稱 Meta 等級 |

## 本輪實作與操作

首頁直接呈現動態和「建立貼文」，同一個發文／互動元件也提供於「社群分享」。按建立貼文後寫內容、發布；不要求網址或標題。關閉視窗保留草稿，確認發布後回到動態。同社群會員可按讚、留言；外部連結收在「分享外部連結」。

會員區以全域頂部導覽取代固定左側框架；品牌、五個日常入口、通知與帳號集中。桌面首頁為動態主欄與較窄的個人工坊欄，手機先看動態。公會下一步、開始聊天、找夥伴及原有模組保留；名片／推薦、商品／投稿／推廣按需展開。更多功能保留原分組、搜尋、管理資格與舊 hash。正文工具列只有頁名與 44px 工具入口；Esc／關閉恢復焦點。

作者、標題、未讀數與主要操作用字重建立層級，頁面說明縮短；長貼文先顯示四行，可展開完整內容。錯誤與必要限制保持完整。使用原主題 token、頭像與品牌圖，不新增圖片素材；`DESIGN.md` 與頁面說明同步更新。

通知鈴及訊息頁新增「全部標為已讀」，透過同一個 `/me/inbox/read-all` command，一次涵蓋所有通知頁、收到的私訊及目前可存取的聊天室。保留歷史；不讀取已離開的公會或別人的小隊。明確點選後才寫入，GET 不標記。Receipt 重播不消耗第一次操作後的新訊息；詳細鎖與 API 見[會員通知文件](member-communications.md)。

- 原生內容最多 2,000 字；留言最多 1,000 字。沿用每人每日 20 則貼文上限，留言每日最多 100 則。
- 按讚是明確的 `liked=true/false`，有唯一索引；留言與發布使用原會員 command／receipt 交易。
- 網路失敗或不完整 ACK 保留原內容與同一個 key；使用者重試後只建立一筆。尚未確認時鎖住原內容，避免改了內容卻重用 key。
- 發布 ACK 後立即加入列表；列表過期回應不能取代新的篩選。內容由 React 純文字渲染，不執行會員 HTML。
- 原生貼文、留言和圖片只提供給同社群會員。原生貼文不能取得公開推廣連結，公開縮圖路由返回 404；原外部連結分享維持可用。
- 隱藏、刪除、跨社群或撤銷 session 後，新增互動與敏感 creation／comment receipt 重播都拒絕。按讚與留言不增加推廣點擊。
- 新路由沒有加入固定 preview SDK，不調整跨倉 API pin、不啟用任何私人 AI／媒體／金流部署設定。

## 其他人的 PR 與重疊

具體 SHA、全部變更路徑與正規化 diff digest 見
[PR 比對快照](social-platform-pr-overlap-2026-10-07.json)。這是路徑／功能的比對，沒有冒充對其他人的完整安全審查。

| PR | 工作 | 與本輪關係 |
| --- | --- | --- |
| #105 | 社群 ERP／CRM 公開範本入口 | 修改 `Community.tsx`；本輪不重建 ERP／CRM |
| #175 | Tenant 經營權移交／再驗證／復原 | 功能不同；同時使用 migration 124，manifest、migration-plan、release-compatibility 的名稱登錄及 v3 catalog fixture 重疊，合併順序需協調 |
| #187 | native 租約 fixture clock race | 不重複修補該測試 |
| #188 | Guild Launchpad 契約 primitives／schema | 不另建相同契約 |
| #189 | 固定可信 CI runner | 不改對方治理修補 |
| #190 | Guild Launchpad「我的工作」畫面 | 共用 `api.ts`；已讀該 hunk，對方加 PATCH／candidate error，本輪加 DELETE，沒有相同業務實作 |
| #191 | 測試 teardown 等待 SQL clients 關閉 | 測試基礎設施修補；本輪不複製該改動 |
| #192 | 更新 runtime 分流的排程權重與 hosted costs fixture | 測試排程調整，沒有相同社群功能；沿用主線，不複製 |

所有日常 PR 都會更新全倉 inventory；這是機械性合併重疊，應在整合後依最終 Git bytes 重算。

## Migration 與審查注意

只增加 [124_social_feed_interactions.sql](../../migrations/124_social_feed_interactions.sql)，不改歷史 SQL；設定的 last 從 123 到 124，保留 gap 22。
124 是此基底的下一個可用編號，**#175 同時提出 124**。若 #175 先合併，本輪須改為下一個可用編號、重算 manifest／inventory 並重跑驗證；不得把兩個 124 直接合在同一 catalog，也不得新增假 gap 略過別人的 migration。
本輪亦將精確檔名登錄至 release-compatibility 的已知 schema 清單，並更新完整 v3 測試 catalog 的 frontier。名稱登錄不能供給 release／restore／execution 權限，既有 host、完整 digest 與獨立批准要求保持；未知或改名 migration 仍拒絕。
Operator 應先做受控 migration／staging 驗收再部署對應程式；本輪沒有操作 staging／production DB、合併或部署。

`freedom prepare` 對既有社群路徑仍回報 `surface_unmapped`，保守選取全模組；130 個 context chunks 已按索引載入，完整性檢查仍 `complete=false`。
沒有改 descriptor、base 或 scope 掩蓋 blocker。主要規則與受影響的 DB、身份、媒體文件另行核對；這不是治理全覆蓋、可信 CI 或合併授權。
code-cleanup-helper 的同步工具沒有配置公開樹，因此該維度 NOT_CHECKED；其 `packages/skill-upload-client` 缺 `agents/openai.yaml` 的通用 skill 包 finding 不等同於此平台功能故障，本輪未改該包。

## 優先升級順序

1. **完成會員社群循環**：審查此版；在 staging 實際發文／留言／刪除，驗證手機與三個主題，再觀察真人是否找得到入口。
2. **即時與安全互動**：沿用現有 chat service，新增權限受控的更新推送、斷線補讀、傳照片／檔案、封鎖與檢舉。先用實測 p95 與撤權／重連反例驗收，再擴大用戶。
3. **形成關係與成果**：追蹤／公會／最新動態、互動通知、作品到任務及合作的直接入口；衡量首次有效互動、七日回訪與完成合作。
4. **交易與多方回報**：在產品、Seller 與營運規則齊備後驗收正式結帳／退款／實收及分潤；社群互動數不冒充交易成果。

## 本機驗證

Node 24 型別檢查與最終前端建置通過。以專用 PostgreSQL 18 測試容器執行下列 scoped suites，**135 項通過、0 失敗**：

```sh
node --import tsx --test --test-concurrency=1 tests/runtime/social-feed.test.ts tests/runtime/share-promotion.test.ts tests/runtime/social-thumbnail-assets.test.ts tests/runtime/social-preview-assets.test.ts tests/runtime/portal-client-recovery.test.ts tests/worker/share-go.test.ts tests/runtime/member-communications.test.ts tests/runtime/member-channels-core.test.ts tests/runtime/member-channel-access.test.ts tests/runtime/direct-message-receipts.test.ts
```

另跑 `node --test deploy/cloudflare/test/migration-plan.test.mjs deploy/cloudflare/test/migration-reviewed-privileges.test.mjs`：更新因新增 124 而失效的原完整 catalog 編號與 digest 斷言後，**21 項通過、0 失敗**。歷史 SQL 不變。

#193 在候選 `ca40f860763f38f7a4a1f3847f343287a0e083f5` 的首次 CI 部署檢查為 180 pass／276 fail：新增 124 未被相容性清單識別，完整 v3 catalog fixture 也仍固定到 123。本輪補上精確登錄、fixture 及拒絕未知 schema／舊批准的反例；三檔相關測試 130 pass／0 fail。完整部署檢查與最終候選結果附 PR，不能由此局部結果推定 CI 全綠。

Chromium 對改版後的 13 檔共 75 個案例執行驗證，涵蓋首頁直接看動態、發文視窗與關閉保留草稿、按讚／留言、丟失 ACK、貼圖、手機返回、導覽、三主題 320px、原分享／投稿入口及一鍵已讀：

```sh
node scripts/run-e2e.mjs tests/e2e/social-feed.spec.ts tests/e2e/simple-social-experience.spec.ts tests/e2e/chat-stickers.spec.ts tests/e2e/share-promotion.spec.ts tests/e2e/navigation-audit.spec.ts tests/e2e/member-home-next-step.spec.ts tests/e2e/page-tools.spec.ts tests/e2e/page-tools-notification.spec.ts tests/e2e/page-issue-recovery.spec.ts tests/e2e/development-guide.spec.ts tests/e2e/member-experience.spec.ts tests/e2e/audit-shell.spec.ts tests/e2e/calm-experience.spec.ts
```

第一次改版回歸為 74 pass／1 fail：桌面測試在選頁後自動收合的 More 裡，以可見 locator 檢查選中狀態而超時。保留選頁後收合及主要內容焦點要求，修正為檢查原按鈕的 `aria-current`，並加入長文展開／收合與草稿返回驗證。最後候選的實跑結果、commit、tree 與原始輸出摘要附在 PR；先前失敗紀錄保留，不能把 focused pass 當成整庫 E2E。

Git index 的 canonical blob inventory 由 Linux snapshot 驗證，最後檔案 hashes／本機連結數與候選 tree 附在 PR；不驗證 Markdown anchors、外部 URL、runtime、簽章或真人證據。
Full runtime 沒有通過：首次 LOGIN role fixture 受本機 PostgreSQL 密碼驗證影響；專用容器重跑出現 avatar teardown 的 shared-memory 錯誤與 TLS fixture 失敗，725 個案例通過時停止該次全量執行。沒有用未修改基底重跑全套來證明失敗歸因。之後的 scoped final tests 改用專用、loopback、tmpfs、提高 lock 容量的 PostgreSQL 測試容器；沒有改平台或 production 資料庫設定。
Focused pass 不推定成整庫 pass。正式環境負載、端到端時間、真人 30 秒加入、staging 登入後流程、全量 E2E／Worker 皆不由此結果推定。提交為待審 PR，整合前仍須通過 repo 的正式 gates。
