# 參與這個專案

<!-- freedom-repository-guide:start -->
## 自由工坊：從一個成果到一個 PR

自由工坊的會員入口、中央資料庫與跨模組業務規則。 已提供 email 註冊、封閉定位、公會與技能書、會員隱私、小隊、供貨與商店草稿、作品共創、行銷紀錄、Access 管理與公會長本人確認。

先看[本倉 Issues](https://github.com/FreeTWAI-AI/freedom-platform/issues)與[現有 PR](https://github.com/FreeTWAI-AI/freedom-platform/pulls)。提出問題、這一輪範圍、完成條件與可投入時間，在 Issue 認領並協調重疊工作；維護者已直接派工時不必重複等待，將約定連回交接即可。使用自己的 fork／分支，PR 送到 **FreeTWAI-AI/freedom-platform:main**。

交給 Agent 前先讓它讀 [AGENTS.md](AGENTS.md)。PR 寫明變更用途、使用者可見結果、驗證命令、限制與原 Issue；附上可公開的合成案例或重現方式。Issue／PR 是程式協作的記錄，平台名片與公會身分不取代 repo 維護者的審查。

會員、權限、公會、商品、商店、合作和稽核的權威寫入在本 repo 的 API／PostgreSQL。外倉用版本化契約；本機、staging、public 使用分開的資料庫。GitHub Issue／PR 保存程式協作事實；Seller／bank 保存實收事實。

### 這個模組怎麼驗證

選擇與修改範圍相符的既有入口：

```sh
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:contracts
npm run test:repos
```

命令列在這裡不表示本輪已執行。先核對依賴與隔離的 PostgreSQL 測試環境；每次更改前端後，先 `npm run build` 再跑瀏覽器測試，避免驗到舊畫面。再記錄實際結果；缺工具、桌面、媒體或授權時寫 `not_run` 與原因，不能補造成功。純文件修改以連結／路徑核對與 `git diff --check` 為主。

### 署名與上游

本 repo 的維護者負責「自由工坊的會員入口、中央資料庫與跨模組業務規則。」這個模組；公會職稱與自填 GitHub slug 不授予寫入權。 保留原作者與授權檔，另列真正完成文件、測試、設計、程式或協作的人。使用 AI 時如實交代協作範圍；只有實際 GitHub PR／review／合併紀錄可以作為對應貢獻證據，不能靠自填帳號推定。

自願貢獻不保證案源、XP、收益或雇用。若產生付費合作，由當事人另定條款與 Seller 外部收款；平台不代收。秘密、客戶資料、真實交易單據與未授權素材不進公開 Issue／PR。
<!-- freedom-repository-guide:end -->
