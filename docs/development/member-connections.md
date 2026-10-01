# 從分享名片到一起參與

本分支回應 [Hao 的 9/30 意見 #42](https://github.com/FreeTWAI-AI/freedom-platform/issues/42)，並支援 [首頁／個人頁推薦 #43](https://github.com/FreeTWAI-AI/freedom-platform/issues/43)。這是提交審查的程式，不是正式站已部署聲明。

## 2026-10-01 查核既有建議

- [#12](https://github.com/FreeTWAI-AI/freedom-platform/issues/12) 已關閉；[#14](https://github.com/FreeTWAI-AI/freedom-platform/pull/14) 的會員體驗修改由維護者整合進 [#17](https://github.com/FreeTWAI-AI/freedom-platform/pull/17)，於 9/28 合併，並保留 Hao0321 原作者紀錄。#14 本身是關閉，不能當成直接合併。
- 正式站 `/api/v1/health` 本次讀取回報 `release_sha=a982a313c8511c881836429d46dd0c735c0cdbca`，其歷史包含 #17 的 `e54f9d08beba94d8a7bfbdf61dfddd8d9748da2c`。這佐證原有預覽入口、明亮／夜航／敘生主題與活動／任務入口已隨整合版部署，不代表本分支已部署。
- 社群任務沿用實際工作與貢獻事實紀錄；固定 XP、收益與完整啟用率政策仍由社群另行制定。維護者的採用範圍見 [#12 回覆](https://github.com/FreeTWAI-AI/freedom-platform/issues/12#issuecomment-5864544617)。
- #42 本次查核仍為 OPEN，尚無討論回覆；下列五項是這次新增的完整流程。

## 逐項行為

| #42 的建議 | 本分支的行為 |
| --- | --- |
| 數位名片分享邀請連結 | 我的名片建立可停用、可換連結的分享頁。訪客可查看精簡名片並建立帳號；加入後回到原名片，自行送出好友邀請。 |
| 簡化註冊、列出全部公會 | 名稱、Email、密碼建立帳號後，列出全部公會，可依名稱與主題篩選；選一個主要公會即可開始。既有 15 題定位保留為稍後補做的選項。 |
| 好友名單頁 | 側欄「認識夥伴 → 我的好友」提供已接受、收到、送出的邀請，搜尋、分頁、私訊、接受、婉拒、取消及移除操作。 |
| 公會 TAG、定期分析 | 公會卡片與快速加入共用六類主題。現有 Worker cron 每天保存一次目錄比對；管理頁提供目的差異與共同技能書，選配真實 Workers AI 分析。 |
| 自動推薦名片 | 每次進入會員首頁或我的名片自動呈現一位夥伴，可查看完整名片、送出邀請或換一位；呈現共同公會／公開能力或跨領域的推薦理由。 |

快速入口改變先前「15 題定位後才開放會員區」的產品規則，需由維護者在 PR 審查確認。登入、CSRF、同社群資料範圍、GitHub 授權、會長／管理員任命及工作驗收規則沿用既有流程。

## 資料與 API

Migration `058_member_connections.sql` 新增 `users.onboarding_entry_mode`、`member_card_shares` 與 `guild_discovery_reports`；既有會員預設為 `assessment`。

- `POST /api/v1/me/onboarding/quick-start`：本人確認的 `guild_keys`、`primary_guild_key`、`confirmed:true`。同交易加入公會、選主要公會、領技能書並開放會員區；保存 `quick` 模式。保留未完成定位草稿，不捏造答案、評分或已完成定位。重播同一操作不重複加入；不同命令同時完成只接受一次。
- `GET/POST /api/v1/me/member-card-share`：分享設定；寫入使用 Idempotency-Key，已有設定使用 If-Match。新建、重新開啟或更新連結產生新的 256-bit 隨機 token。停用即撤銷。
- `GET /api/v1/public/member-cards/:token` 與 `/avatar`：唯一匿名名片 API。每次重新核對啟用狀態、會員有效性、完成加入及驗證帳排除。只包含名稱、目前主要公會、最多三項最後確認的精選能力，以及本人勾選的頭像；不包含會員 ID、Email、聯絡／社群帳號、裝備、定位答案或職業。回應 `no-store` 與 `noindex`。
- `GET /api/v1/member-cards/:token/member`：已登入會員的完整名片，依當下好友／公會／小隊關係提供原本允許的聯絡資料。分享不替訪客建立好友關係。
- `GET /api/v1/friends/directory?scope=accepted|incoming|outgoing&search=&limit=&offset=`：先按有效關係、同社群、有效會員及搜尋篩選再分頁。舊 `/friends` 通知入口保持相容。好友聯絡資料仍由原名片查詢依目前關係計算。
- `GET /api/v1/members/recommendations?limit=1&offset=0`：最多三位。只使用已確認能力與有效公會，不使用 Email、私人定位或聯絡方式。排除本人、好友及待回覆邀請、未完成加入、停用、外社群及驗證帳；同分依會員與台北日期穩定輪替。結果再次核對當下名片與好友狀態。
- `GET /admin/api/guild-discovery`、`POST /admin/api/guild-discovery/refresh`：Access 管理員入口與既有管理 CSRF。更新只處理已到期的報告，不允許連點繞過每日頻率。

## 公會分析與 AI 設定

公會目錄比對不需要付費模型；以共同分類、描述詞及技能書列出最多 12 組可討論的方向，明確標示「依公會目錄與技能書比對」。內建主題對照在 `packages/shared/guild-topics.ts`；自訂公會依公開名稱與目的取得標籤提示。

既有十分鐘 cron 在設定 `FREEDOM_REGISTRATION_COMMUNITY_ID` 的環境呼叫分析。資料庫每日節奏與兩分鐘 lease 防止重複執行；AI 最長等候 15 秒。模型失敗或輸出不合法仍保存目錄比對，並顯示原因狀態；資料庫讀取失敗一小時後可再嘗試。每份報告保留目錄 digest 和更新時間。分析上限 100 個公會，每個最多 50 本目錄技能書。

需要 AI 時，部署者在各環境的私有 overlay 加入：

```json
{
  "ai": { "binding": "AI" },
  "vars": {
    "FREEDOM_GUILD_REVIEW_ENABLED": "true",
    "FREEDOM_GUILD_REVIEW_MODEL": "<支援 JSON mode 的 Workers AI 模型>"
  }
}
```

保留 overlay 原本設定；模型由部署者選擇。未明確啟用不呼叫推論。介面顯示是否已設定 AI，只有通過驗證的模型回應才標記為 AI 分析。來源：[Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/)、[JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)。

送給模型的資料只有公會名稱、目的、標籤與技能書標題，不含會員、答案或聯絡資料。輸出只接受目前目錄內的不同公會鍵、限長理由、目的差異與建議類型；禁止額外欄位。模型沒有合併、改名、移動會員或寫入權。整合決策留在既有管理與真人討論流程。

## 部署與回退

先在隔離資料庫／staging 套用 migration 058，再由維護者部署這個分支；不直接操作正式站會員資料。第一份每日報告可等候下一次 cron，或管理員按「更新到期分析」。Node 本機透過管理頁可執行到期分析，不啟動背景計時器。

回退應用程式時保留 migration 與會員自行選擇的公會／領書事實。舊版仍認得 `onboarding_completed_at`；新欄位與表不需刪除。恢復舊版後，分享的匿名 API 與前端入口不再由該版本提供。

## 驗證

測試全部使用隔離 PostgreSQL schema 和合成帳號。已完成 TypeScript 檢查、前端 build、完整 runtime 683/683、相關瀏覽器 53/53、Worker 14/14，以及平台與 admin-sync 的三環境 dry-run。主題測試最初因第二次按設定按鈕關閉選單而失敗，修正測試後重跑通過；好友列表套用共用名片排列後，五項新增瀏覽器案例再次全部通過。新增 runtime 十項也於最後的 AI 回退調整後重跑通過。

完整測試開始於上游 `3f3b16b`。上游 #67 合併後，本分支已 rebase 到 `a982a31`，無衝突；再次通過 TypeScript、build、平台三環境 dry-run、`member-connections` 與 `github-sync` runtime 43/43，以及重新打包後的真實 workerd 排程／native fetch 案例 1/1。沒有把上游更新前的完整 runtime 宣稱為新 HEAD 的完整重跑。

主要入口：

```sh
npm run typecheck
npm run build
npm test
npx playwright test tests/e2e/member-connections.spec.ts tests/e2e/member-experience.spec.ts tests/e2e/member-directory.spec.ts tests/e2e/onboarding-members.spec.ts tests/e2e/onboarding-recovery.spec.ts tests/e2e/guild-organization.spec.ts tests/e2e/member-settings.spec.ts tests/e2e/navigation-audit.spec.ts
npm run worker:dry-run
npm run worker:dry-run:admin-sync
npm run test:worker
```

Runtime 覆蓋快速加入與併發、私人草稿保留、分享撤銷／輪替／頭像、好友方向與資料權限、推薦排除、每日分析 lease、模型不合法輸出與失敗回退。瀏覽器覆蓋 320px 手機、匿名名片、分享帶來的註冊與好友接受、主題篩選及三種既有外觀；管理分析畫面使用明確合成 fixture，模型 adapter 使用合成回應。實際 provider 推論與正式部署仍需部署者配置後驗收。

## 實際操作截圖

以下為本機隔離測試的合成會員；品牌 Logo、既有圖片與三種主題均沿用原本素材。

- [320px 快速加入公會](../design/member-connections/issue-42-quick-entry-320.png)
- [320px 訪客分享名片](../design/member-connections/issue-42-public-card-320.png)
- [好友列表桌面版](../design/member-connections/issue-42-friends-desktop.png)
- [320px 好友列表](../design/member-connections/issue-42-friends-320.png)
- [320px 敘生主題與公會篩選](../design/member-connections/issue-42-guild-tags-320.png)
