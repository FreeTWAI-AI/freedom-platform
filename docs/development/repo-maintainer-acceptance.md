# PR／Issue 審核中心：既有功能驗收清單

日期：2026-10-04。對應 [Issue #72](https://github.com/FreeTWAI-AI/freedom-platform/issues/72) 與[設計 §§12–16](../plans/repo-maintainer-review-center.md#12-github-端設定階段-0ted-手動)。

[PR #73](https://github.com/FreeTWAI-AI/freedom-platform/pull/73)（1a–1c）與 [PR #91](https://github.com/FreeTWAI-AI/freedom-platform/pull/91)（1d、2a）已合併，且都包含在本次候選的 main 祖先中。這份清單整理已存在的程式與驗證邊界，不重做審核中心，也不表示 Issue #72 可以關閉。

本輪檢查對照 PR 108 固定版本 `29d91ad13347f9cd7db55ed36d0535fd7bfc1960` 上的整合候選；實跑結果見[整合報告](integration-pr85-104-future108.md)。測試中的 App、JWT、GitHub 回應與會員都是合成資料，不代表已安裝真實 App 或設定正式權限。

## 本地程式與測試對照

以下是既有 coverage 的精確範圍。Runtime 實跑與瀏覽器 `not_run` 分開記錄，不能因為有測試檔就勾選正式驗收。

| 驗收項目 | 既有測試／入口 | 已檢查的範圍 |
| --- | --- | --- |
| Webhook HMAC 與去重 | [repo-maintainer-webhook.test.ts](../../tests/runtime/repo-maintainer-webhook.test.ts)：`a signed delivery is stored and a duplicate does nothing else`、`rejected and malformed deliveries never touch the database` | 簽章正確才保存／排工作；重送不新增；錯誤 HMAC、格式、JSON、content type 不落資料庫；含 2 MiB 上限與未啟用 repo |
| Webhook 唯一例外路徑 | 同檔：`POST webhook runs before member auth, GET requires a session, and a missing secret is 503` | 合法 POST 不需要會員 cookie；惡意 Origin、GET、尾斜線及額外路徑不取得例外；未設 secret 回 503。這不是 Access 安裝驗收 |
| 真實簽章的管理員身分 | [admin-access.test.ts](../../tests/runtime/admin-access.test.ts)：`admin identity requires verified human Access signature and exact issuer/audience/time claims` | issuer、audience、時間、human claims；未驗證 email header、會員 cookie、畸形 JWT 與缺設定不能授權 |
| 後台讀寫權限 | [repo-maintainer-admin.test.ts](../../tests/runtime/repo-maintainer-admin.test.ts)：`review center reads require the provisioned admin and hide secrets`、`settings writes enforce csrf, idempotency, version and the phase-1a mode limit` | 未配置管理員拒絕；讀取不洩漏私鑰／token；Origin、CSRF、版本、重播與模式限制 |
| 公會與技能書審核範圍 | [repo-maintainer-guild.test.ts](../../tests/runtime/repo-maintainer-guild.test.ts)：`the eligibility view follows admins, leaders, open repositories and a departed officer`、`a guild leader sees their own and open pulls, claims one guild, and releases only their claim` | 管理員、公會長、一般會員、跨公會範圍、離任／退會與 GitHub 連結；不同公會長不能釋放別人的認領 |
| 技能書維護者不是全站角色 | 同檔：`a skill-book maintainer who is not a guild leader lists, claims and releases the book pull`、`a finished skill-book maintainer claim does not adopt the repository`、`revoking a skill-book appointment releases the claim on the next settlement` | 只限被任命書籍；認領／釋放；完成不收編 repo；撤回任命後結算釋放 |
| 認領／指派／釋放／競爭 | [repo-maintainer-claims.test.ts](../../tests/runtime/repo-maintainer-claims.test.ts)：`claim, assign, release, pause and resume enforce identity, version and the queue filters`、`two concurrent claims leave exactly one active row` | 未連結／作者本人／draft／關閉／暫停等拒絕，版本與重播、稽核、同時認領只有一筆 active、撤權／到期結算 |
| requested reviewer 寫入開關與拒絕 | 同檔：`request_reviewers off stores not_requested and enqueues nothing`、`requested-reviewer jobs honor the worker switch, the status code and a release during the call` | 關閉時零請求；僅指定 repo 的最小 token 權限；422／權限缺少記錄失敗；限流延後；release race 補償移除 |
| 不重送已完成的 reviewer 寫入 | 同檔：`a request_reviewer re-run leaves an already requested claim requested`、`a remove_reviewer_request re-run leaves an already removed claim removed` | 完成後重播為零網路呼叫；禁止寫入時移除工作顯示失敗，不假裝成功 |
| 認領不是核准／合併授權 | [repo-maintainer-policy.test.ts](../../tests/runtime/repo-maintainer-policy.test.ts)：`deriveQueueState uses eligible reviewers and has no sla fields`、`an active claim turns only awaiting review into in_review` | 需要目前 head 的有效真人核准與指定來源 CI；舊 SHA、外人、自審、COMMENTED 不變 ready；認領只是協調，不因等待時間授權 |
| 本機交接只生成任務與稽核 | [repo-maintainer-handoff.test.ts](../../tests/runtime/repo-maintainer-handoff.test.ts)：`an admin fix handoff records the row, the audit, and replays the same id`、`admin handoffs reject a merge that is not ready, a moved head, a paused pull, a missing GitHub link, a closed repository, and a bad body`、`members hand off only the repositories they can review`、`untrusted text stays inside the json block, and unsafe names use the fallback` | 任務檔、資格／head／ready gate、重播、歷史與稽核；不可信標題留在 JSON 資料區，不安全的名稱使用 fallback；生成命令不等於執行命令 |
| 鏡像與背景補查 | [repo-maintainer-sync.test.ts](../../tests/runtime/repo-maintainer-sync.test.ts)：`installation sync keeps the organization and lists its repositories with one metadata token`、`reconcile stores the mirror and an out-of-order run does not overwrite it` | organization allowlist、metadata-only token 與較舊結果不覆蓋；注入合成 GitHub transport |

### 不可過度宣稱的細節

- 本輪補強 `requested-reviewer jobs…`：422 後明確 assert 平台 claim 仍為 `active`；下一次 synthetic tick 零外呼、零完成／失敗工作，保留拒絕原因。這是本地 negative coverage，仍需補驗真實 GitHub 拒絕時認領可用、畫面有原因。
- 技能書 eligibility 測試現在除了任命／GitHub 連結，也直接切換 `users.active`，確認停用後失去資格、重新啟用後恢復原有任命範圍；對應 [071 eligibility view](../../migrations/071_maintainer_review_scope.sql)。
- [handoffs.ts](../../modules/repo-maintainer/handoffs.ts) 保存／生成本機任務，沒有 GitHub client；[github.ts](../../modules/repo-maintainer/github.ts) 的 repo 寫入限 requested reviewer 的新增／移除。本輪在 admin fix／merge／issue、重播／讀取歷史，以及 member handoff 範例加入 fetch blocker、零外呼和零 GitHub job 斷言。這只涵蓋列出的本機交接路徑，不能宣稱已端到端證明所有任意讀取／認領路徑都不會留言、審查、標籤或合併。
- 選擇交接工具、下載任務檔不會執行工具；本輪沒有啟動任何本機或雲端 coding agent。

## 瀏覽器與 Worker 的現有入口

- [admin-review-center.spec.ts](../../tests/e2e/admin-review-center.spec.ts)：後台桌面／手機認領、指派、釋放、歸屬、舊 SHA review 顯示與本機任務下載
- [guild-reviews.spec.ts](../../tests/e2e/guild-reviews.spec.ts)：公會長與技能書維護者範圍、認領與任務下載；技能書釋放已有 runtime coverage
- [workerd.test.ts](../../tests/worker/workerd.test.ts)：真實 bundle 的 webhook 無 secret → 503、錯簽 → 401；不是有效 GitHub delivery 的完整部署驗收
- [maintainer-scheduled.test.ts](../../tests/worker/maintainer-scheduled.test.ts)：合成 PKCS#8 key 與 outbound stub 的排程 Worker，不是真實 App 安裝

本輪瀏覽器案例 `not_run`：現有 Chromium 啟動被 socket 權限阻擋，支援的雲端瀏覽器也無法導向本機預覽網址。未用換位址、代理或安全設定繞過。既有 Worker 檔案未因這份清單重新跑全套；整合報告列出先前已跑的 scoped Worker 結果。

## 仍需實際環境證據的驗收

以下全部保留未勾選。程式、合成測試、已合併 PR、config 中的 placeholder 都不能代替安裝狀態；本輪沒有讀取或修改正式安裝設定。

- [ ] staging／production 各自的私有 Maintainer App：selected repos、permissions、events、installation ID 正確；Member App 不變
- [ ] webhook secret 只在平台 Worker，PKCS#8 App key 只在無公開路由的 maintainer Worker；環境 overlay、資料庫與不快取的 Hyperdrive 分離，交接不含 secret
- [ ] Access 只放行指定 webhook 例外，其他 staging／admin 路徑仍受保護；真實 GitHub delivery 202、錯簽 401、重送去重
- [ ] 真實排程 Worker 更新 installation／repo／PR／check／review 鏡像，補回漏事件，錯誤與日誌不洩漏憑證
- [ ] 真實管理員、公會長、技能書維護者與無資格者在 staging 的範圍、認領／釋放、撤權與拒絕提示正確
- [ ] collaborator requested reviewer 能新增／移除；非 collaborator 或 App 拒絕時平台認領仍可使用，並明確呈現失敗
- [ ] 實際 `main` ruleset：PR-only、禁止刪除／force push、GitHub Actions `verify`、新 push 使舊核准失效、僅 org admin bypass、App 不 bypass；sandbox 是否同樣配置另待決定
- [ ] 設計 §13 staging 劇本：docs／code／migration／workflow／fork、新 push、CI 失敗、migration 撞號、非 default base、歸入與變更歸屬
- [ ] 真實本機 CLI 任務執行驗收另行取得授權；本輪只檢查任務生成與相關 gate
- [ ] 階段 2b cloud-agent 選型／授權尚待產品決定；此清單不安裝 App、不建立 agent、不接另一套 PR 108 身分／publisher 路徑

## 重跑方式

先依[本地 runtime 說明](local-runtime.md)準備只含合成資料的 PostgreSQL，設定指向該資料庫的 `TEST_DATABASE_URL`。各檔案自建 schema，使用單一 sequential runner：

```sh
CLOUDFLARE_CF_FETCH_ENABLED=false node --import tsx --test --test-concurrency=1 \
  tests/runtime/admin-access.test.ts \
  tests/runtime/repo-maintainer-webhook.test.ts \
  tests/runtime/repo-maintainer-admin.test.ts \
  tests/runtime/repo-maintainer-guild.test.ts \
  tests/runtime/repo-maintainer-claims.test.ts \
  tests/runtime/repo-maintainer-handoff.test.ts \
  tests/runtime/repo-maintainer-policy.test.ts \
  tests/runtime/repo-maintainer-sync.test.ts
```

上述命令不包含真實 App 或外部登入驗收。若後續可以使用支援的瀏覽器 runner，先 `npm run build`，再以既有單一 worker、run-specific schema 跑兩份 review-center spec。不得用正式資料庫或停用授權斷言來取得通過結果。
