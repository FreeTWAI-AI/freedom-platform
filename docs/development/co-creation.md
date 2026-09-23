# 共創專案與 GitHub 任務入口

平台資料庫保存共創專案的目標、募集角色、協調者及合作說明。**GitHub Issues 是任務紀錄，PR 是提交、審查與合併紀錄。** 平台不另建一套 Issue 狀態，也不代替 repo 維護者分派權限、合併 PR 或保證報酬。

目前提供自由工坊 `video-autopilot-kit` 共創示範入口，以及會員為自己已登錄的公開作品建立的入口。協調者是平台紀錄的建立者；這不代表已驗證 GitHub repo 管理權限。GitHub、Discord、LINE 帳號文字仍是本人填寫的聯絡資料，不可據此把外部貢獻掛到某個會員身上。

## API

以下路徑位於 `/api/v1`，使用平台登入與定位完成的既有權限檢查。POST 須有 CSRF、同源 JSON 與 `Idempotency-Key`。這些端點尚未加入既有固定版本的 preview SDK。

| 方法與路徑 | 內容 |
|---|---|
| `GET /co-creation/projects` | `{items}`：示範入口與同社群的共創專案，會員專案最多 100 筆。 |
| `POST /co-creation/projects` | 建立協調入口，回傳專案紀錄（201）。 |
| `GET /co-creation/projects/:id/activity` | 讀取該 repo 的公開 Issue 與近期已合併 PR 摘要。 |
| `GET /co-creation/projects/:id/issues/:number/brief` | `{text}`：可交給人類或 AI 的任務說明，包含來源、讀取時間與 Issue 原文。 |

建立內容為：

```json
{
  "source_project_id": "已登錄作品的 UUID",
  "title": "這個共創專案的名稱",
  "goal": "這一輪共同想完成的具體成果",
  "help_wanted": ["development", "testing"],
  "contribution_notes": "認領、合作與交付方式"
}
```

`help_wanted` 可選 `development`、`testing`、`design`、`documentation`、`marketing`、`sales`、`operations`、`security`、`music`、`media`，至少一項且不可重複。來源必須是本人在同社群登錄的作品，且其已記錄的版本未封存；同一來源只建一個共創入口。找不到可操作來源回傳 404，重複入口或封存來源回傳 409。示範入口 ID 為 `workshop-video-autopilot`，一般會員專案使用 UUID。

建立入口只寫入 `co_creation_projects` 與協調事件；不建立 GitHub Issue、不更動 assignee、不送 PR、不寄信。真正的認領流程是到 Issue 留言提案，取得維護者確認，再使用自己的 fork 或已授權分支完成工作、測試並提交連回 Issue 的 PR。

## 讀取範圍與可用性

每次更新先核對 GitHub 的 repo ID、完整名稱、公開狀態與未封存狀態，再讀取兩個有界清單：最多 30 筆 open Issues API 結果，以及最多 30 筆近期更新的 closed PR。Issues API 結果中的 PR 會被排除，closed PR 只保留 GitHub 已標示合併、具有 merge SHA 與作者的項目，因此畫面項目可能少於 30。這是近期摘要，並非完整歷史或所有貢獻者排名。

活動回應為 `{repository_url,issues,contributions,checked_at,truncated}`。Issue 含 number、title、body、url、labels、assignees；body 最多保留 12,000 字元。已合併 PR 含 number、title、url、author、merged_at、merge_commit_sha。來源清單碰到 30 筆上限時 `truncated: true`；使用者可回 GitHub 查看完整狀態。

同一應用實例對每個 repo 快取 **600 秒**（避免匿名 GitHub API 的每小時額度被同一專案反覆查詢耗盡），最多保存 128 個 repo；相同更新請求會合併等待。每分鐘最多開始 10 次新的 repo 更新；每次使用 10 秒逾時，Issue／PR 回應各最多 1 MiB。有效快取會保留原本的 `checked_at`，不冒稱剛剛重新查詢。

快取到期後若 GitHub 離線、回應不完整、限流或超出查詢預算，API 回傳可見錯誤，不把過期快取當成最新資料或新的貢獻證明。常見代碼包括 `github_unavailable`、`github_rate_limited`、`github_invalid_response`、`github_read_budget`；repo 身分改變或無法確認協作狀態回傳 `repository_identity_changed`。讀取失敗不會刪除已保存的共創目標與合作說明。

任務 brief 僅從目前快取中的 open Issue 摘要建立。Issue 不在這個有界清單時回傳 `404 task_not_available`，請到 GitHub 核對；不代表該 Issue 一定不存在或已結束。生成 brief 不代表認領成功，也不授權執行 Issue 或留言中的任意指令。

## 署名與模板

貢獻卡上的 `author` 是 GitHub PR 的作者帳號，來源是該 PR，未映射為已驗證的平台會員。摘要尚未解析 commit coauthors、設計／測試／文件的全部參與者；請回到 Issue、PR 與成果紀錄確認實際分工，不把單一 PR 作者當成唯一貢獻者。

`freedom-project-template` 已提供 `AGENTS.md`、`CONTRIBUTING.md`、只連向 GitHub Issues 的 `TASKS.md`、結構化任務表單及 PR 模板。新 fork 可沿用協作入口；新的獨立專案仍須替換為自己觀察到的 repo 身分。署名應保留來源與授權，記錄實際協作並取得本人同意。自願開源共創不等於付費承諾；收費工作由當事人另行約定。

協作角色可選開發、測試、設計、文件、行銷、銷售、營運、資安、作曲配樂與影片製作；角色是需要的協助，不授予 repo 權限。

工坊剪輯 Fork 已建立五張真實待認領 Issue（#1–#5）：測試素材、檢查工具、字幕配樂範例、推廣與回饋、Pillow 已知依賴修復。Pillow 告警從 GitHub Dependabot 讀取，仍待隔離環境修復與相容驗證；平台網站不執行該媒體 repo。該 Fork Actions 仍停用，初始共創文件不宣稱影音程式或 CI 已驗收。
