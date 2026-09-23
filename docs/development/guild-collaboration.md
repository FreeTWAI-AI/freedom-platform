# 公會共作與技能分享

本輪來源版本為 `0.9.0-guild-collaboration`。實際部署 commit、CI 和 HTTPS 驗證結果另記於交接；本文件不是部署成功證明。

## 公會與第一本技能書

| 公會 | 範圍 | 技能 Repo |
| --- | --- | --- |
| 活動與空間公會 | 場地、動線、活動執行、實體讀書會 | [freedom-skill-event-space](https://github.com/FreeTWAI-AI/freedom-skill-event-space) |
| 光影光雕公會 | 投影、場域光影、光雕作品協作 | [freedom-skill-projection-mapping](https://github.com/FreeTWAI-AI/freedom-skill-projection-mapping) |
| 人類圖研究所 | 讀書會、解讀框架與自我探索交流 | [freedom-skill-human-design](https://github.com/FreeTWAI-AI/freedom-skill-human-design) |

原社群經營公會保留接待與社群運作。新公會不虛構會長，由平台管理員另行任命。人類圖內容是文化與探索資料，不把解讀當作醫療、心理診斷或職業能力證明。

加入、主力／次要排序和技能書領取沿用原流程。定位維持 15 題，新增偏好選項；已完成者不強迫重做。

## 標章與排行榜

- **官方公會技能**：工坊公會指定的技能书，不表示第三方原作者背書、認證或已驗證全部功能。
- **每日新技能**：依實際上架紀錄與 `Asia/Taipei` 當日判定。既有技能書沒有可靠的原始上架日期就保留未知，不重新標成今日新書。
- **工坊週榜／月榜**：近 7／30 天首次經工坊加星，且最近核對仍保留星星的 GitHub 帳號數。只在會員操作取得 GitHub 成功回覆後記錄；同一 GitHub 帳號／Repo 一票，重按或取消重加不刷新首次日期。同票同名次；沒有紀錄就顯示空榜。

排行榜不是 GitHub 全站新增星星，不能用作 XP、資格或收入證明。工坊外取消星星會在下一次本人 Star 狀態核對時反映；榜單不是對所有 GitHub 帳號的持續即時監看。個人 GitHub 身分不出現在公開榜單 API。

公開聚合：`GET /api/v1/skills/discovery`。GitHub 原作總指標仍使用 `/api/v1/github/books/:id/metrics`，不拿站內排行榜數字取代。

## 分享與 Agent 協作

技能書分享連到無需登入的 `/development/skills/:id`，提供封面、摘要、Repo、Fork 位置、協作方向與任務。原生分享不可用時複製網址；失敗時顯示可手動複製的網址，不假報成功。

- 每本技能書：`/development/skills/:id/SKILL.md`。
- 每個平台頁面：`/development/:pageId/SKILL.md`。
- 結構化協作資料：`/api/v1/skills/:id/collaboration`。
- 全站索引：`/llms.txt`、`/api/v1/development-map`。

Agent 指引包含目標 Repo／分支、先讀文件、任務來源、驗收命令、完成條件與交接欄位。指引不授予部署、帳號、私人資料或付款權限。原作者 Repo 與工坊 fork 的 PR 目標明確區分。

Hao 的 autopilot 以工坊共作 fork 的現行文件為入口，標示上游 Editkin v4 路線。建議任務在維護者確認前仍是提案；GitHub Issues／PR 是認領、審查和程式合併的實際記錄。

## 公會管理與編輯

會長從「公會與技能管理」发布自己公會的公告；公會成員在已加入公會下閱讀。公告支援草稿、發布、封存與版本核對，其他公會會員不能越權讀取或編輯。

平台管理員在後台指定技能書負責人。負責人可修改公開摘要、共作介紹、里程碑與 tasks；Repo、來源授權及系統權限不是任意內容欄位。保存後分享頁與 Agent 文件同步更新。

站內 task 的 todo／in_progress／done 是負責人維護的狀態；即使附 GitHub Issue，也不代表 Issue 已關閉、PR 已合併或已部署。正文純文字呈現，外部文字不能變成 Agent 的高權限指令。

會長討論區僅開放現任會長及平台管理員，獨立於公開分享頁。會長職務以正式任命、有效會員及即時權限為準，不依暱稱、自填 slug 或歷史快取授權。

新增 API 是既有會員／管理端的擴充；固定 preview SDK bundle 不冒稱已包含全部新入口。中央寫入仍經授權 API／PostgreSQL。

## 圖像與驗證入口

三張新增封面由 built-in imagegen 產生，保存於 `apps/portal-web/public/art/skills/{event-space,projection-mapping,human-design}.webp`。完整提示詞及 hashes 在 [skill-book-art-manifest.json](../design/skill-book-art-manifest.json)。自由工坊原始品牌圖不變。

依改動範圍執行 runtime／route、瀏覽器、契約與跨 Repo 驗證，再以真實 HTTPS 檢查分享頁、Agent 文件和手機操作。測試使用隔離資料與合成會員；不替真人點 Star、發布真公告或冒充會長發言。
