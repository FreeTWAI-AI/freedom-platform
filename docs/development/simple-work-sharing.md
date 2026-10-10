# 自由工坊：簡單分享作品與投稿工具

## 這一版解決什麼

Hao 希望自由工坊成為 AI 時代的共創社群與商業合作入口。這一版先完成最基本的旅程：**分享作品 → 看見夥伴 → 提出合作需求**，以及 **投稿工具 → 公開作品頁 → 分享連結／邀請一起開發**。

原本一般作品要填 `artifact:template-v1` 等內部代號；開源投稿先呈現 Agent 指令、JSON、金鑰與多個入口。新版直接提供可操作的表單，使用既有三款主題與品牌資產。

## 使用者流程

### 展示作品

1. 填作品名稱與一句介紹；作品網站、影片或文章連結選填。
2. 勾選社群可見，按「發布作品」。
3. 完成區提供查看剛發布的作品和找合作夥伴；其他會員可按「我想找你合作」。

成果引用由 API 自動產生。已有成果代號的整合仍可使用進階選填欄位。展示作品只給社群會員查看；沒有新增匿名作品公開頁。外部作品連結只開新分頁，不抓取、不內嵌。

發布成功後直接以 API 回傳的真實作品更新列表，省掉再次載入作品／需求的請求；不以樂觀畫面假裝寫入成功。

### 投稿開源工具

1. 貼 GitHub 網址、填名稱與一句介紹，選擇本人與來源的關係。預設推薦／整理者，不推定作者。
2. 「預覽投稿」只在目前頁面預覽，不產生憑證、不寫入 API。可回頭修改。
3. 勾選同意公開，按「確認並公開」。系統先保存私人草稿，再沿用正式投稿服務查驗公開 GitHub 來源、固定版本與授權。
4. 成功後建立公開作品頁，列入社群技能書，提供複製連結與一起開發入口。

使用說明、展示網址收在選填區。未填使用說明時只提供「先讀原作 README」的通用引導，不捏造安裝指令。分享短文以使用者輸入組成一則，沒有強迫使用者準備 100 則內容。

Agent／聊天 AI／CLI 上傳保留在進階工具中；其既有 100 則短文驗證、一次性憑證與金鑰權限不變。技能書架的主要投稿按鈕直接開啟簡單表單。

### 公開失敗與修改

公開失敗時保留同一份私人草稿，可以直接重試，或重載後從「繼續未公開的草稿」恢復。尚未公開的手動草稿可以修改；API 檢查本人、版本和狀態。Agent 草稿仍用既有工具管理，已公開投稿不提供這個修改入口。

### 已公開作品與組織 Repo 的介紹管理

技能書架的社群投稿可按「管理作品介紹」進入作品管理。原投稿會員保留編輯權；其他會員先連結本人 GitHub，再按「核對 GitHub 管理權」。API 使用該會員的加密授權憑證，即時確認 GitHub user ID、原 Repo ID、公開且未封存，以及 Repo 的 `permissions.admin` 或 `permissions.maintain`；不要求 Repo owner login 等於會員 login，因此個人與組織 Repo 都能使用。只有 `push`、一般組織成員、自填維護者關係或公會職稱不足以授權。

核對、更新版本、儲存介紹及 idempotent replay 都會重新授權；核對結果不是永久授權。若 GitHub App／組織尚未授權該 Repo，先由組織管理者確認 App 的 Repo 存取範圍；缺少權限資料或 GitHub 查詢失敗時拒絕編輯，不使用平台 metrics token 代替會員憑證。[GitHub Repo API 契約](https://docs.github.com/en/rest/repos/repos#get-a-repository)。

公開介紹的名稱、描述、使用說明與展示網址會同步反映於書架、公開介紹頁與技能內容。原投稿 payload／hash、分享短文、圖片、公開同意、來源關係和固定 SHA 保留；沒有改換投稿歸屬、授予原 Repo 寫入權，或開放私人草稿、Agent grants、行銷紀錄。更新 GitHub 版本仍不重寫既有投稿或行銷的固定來源。

- `POST /api/v1/opensource/projects/:id/edit-access`：需會員 session、Origin／CSRF、Idempotency-Key；僅核對當次編輯權。
- `POST /api/v1/opensource/projects/:id:revise`、`:refresh`：每次獨立核對編輯權，保留 If-Match／交易／稽核；權限只適用同社群可見作品。
- `migrations/126_project_public_metadata.sql`：新增公開介紹已修訂標記；尚未修訂的既有投稿繼續呈現原投稿內容。
- Preview 契約更新為 `freedom.preview/v1` revision `0.4.0`，新增 `checkProjectEditing` 並同步 SDK／bundle；外倉由其維護者更新自己的來源 pins。

本次本機驗證使用隔離 PostgreSQL schema 與明示的合成 GitHub OAuth／組織 Repo 回應；瀏覽器實跑管理者核對、儲存、書架與公開介紹頁同步，390px 書架無水平溢出。未使用真實組織憑證，未部署正式站。

修正後實跑：`npm run typecheck`、`npm run build`、`git diff --check` 通過；organization-project-editing、opensource-marketing、skill-submissions、github-social、preview-protocol 五份 runtime suite **57/57**；migration-plan／release-compatibility **98/98**（macOS 使用 `TMPDIR=/private/tmp`，避免系統 temporary path 的 symlink 被 migration 安全檢查拒絕）。全倉測試與真實 GitHub 組織授權尚未驗證。

## API 與資料

- `POST /api/v1/showcases`：`artifact_ref` 改為選填，未提供時在同一交易內產生；新增選填 `public_url`。保留舊 request 與既有引用規則。
- `GET /api/v1/showcases?limit=20&offset=0`（#402）：社群已發布作品分頁，`limit` 1–50（預設 20）、`offset` 為非負安全整數，回 `{items,next_offset}`，依 `created_at DESC, showcase_id` 穩定排序；超過 10,000 筆仍可依回傳的 `next_offset` 續頁，未知參數回 422。「作品與需求」頁顯示「載入更多作品」，`#showcase/<id>` 深連結會逐頁載入直到找到該作品。
- `POST /api/v1/me/skill-submissions/manual`：只保存本人私人草稿；不建立 upload key 或 bearer grant。
- `POST /api/v1/me/skill-submissions/:id/manual`：只修改本人、尚未公開、沒有 Agent grant 的手動草稿；要求 If-Match。
- `POST /api/v1/me/skill-submissions/:id/publish`：沿用現有公開機制、來源查驗、稽核與交易回滾。
- 私人投稿 DTO 新增 `can_edit`，不回傳 grant hash。
- 新 migration：`migrations/073_showcase_public_url.sql`。原為 071；合併時 main 已用到 072，因此改為 073。不依賴其他新 migration。

手動內容解析與 Agent 協議獨立。仍要求 session、Origin／CSRF、會員資格、rate limit、idempotency 和本人公開同意；客戶端不能寫入 official、owner 或會員身分。公開 API 保留原作者、來源關係（自行聲明）、固定 SHA、授權與正式收錄尚未審核的狀態。

## 檔案入口

- [SimpleSkillSubmission.tsx](../../apps/portal-web/src/modules/SimpleSkillSubmission.tsx)：表單、預覽、公開、草稿恢復及成功入口。
- [WorkSharingEntry.tsx](../../apps/portal-web/src/modules/WorkSharingEntry.tsx)、[WorkSharing.css](../../apps/portal-web/src/modules/WorkSharing.css)：兩種分享方式與沿用主題的簡約樣式。
- [App.tsx](../../apps/portal-web/src/App.tsx)：一般作品分享與合作需求。
- [投稿 service](../../modules/skill-submissions/service.ts)、[投稿 routes](../../apps/platform-api/src/routes/skill-submissions.ts)。
- [作品 service](../../modules/opportunity-project-work/business.ts)、[migration](../../migrations/073_showcase_public_url.sql)。
- [新流程 E2E](../../tests/e2e/simple-work-sharing.spec.ts)、[既有流程測試](../../tests/runtime/flows.test.ts)、[投稿 runtime 測試](../../tests/runtime/skill-submissions.test.ts)。

## 後續共創社群電商方向

以下為下一階段產品規劃，不是這一版已完成或已部署的功能。

| 階段 | 真實使用旅程 | 驗收與觀察 |
| --- | --- | --- |
| 1（本 PR） | 展示作品／投稿工具 → 分享 → 找夥伴／提出需求 | 完整流程、同意範圍、失敗恢復、手機和三主題；正式站採用成效待觀察 |
| 2 | 把合作需求整理成清楚的專案，列出所需角色、交付、期限和報酬 | 找到第一位夥伴的時間、需求回覆率、雙方同意率、實際交付率 |
| 3 | 用 AI 協助整理需求、比較公開的能力與作品，再由人選擇夥伴 | 推薦理由能追溯公開資料、可修改與拒絕；不自動聯絡或授予權限 |
| 4 | 商品／服務 → 合作約定 → 交付 → 外部 Seller 收款 → 可追溯成果分享 | 真實成交／收款證據、退款與爭議流程、回購和再次合作 |

先用「創作者 × 小品牌」的實際合作驗證。介面應讓來訪者很快看見真作品、真資源、可參與的事；合作與報酬條款由參與者確認。貢獻、推廣點擊、工作驗收與收入是不同紀錄，不能直接互換。

這一版沒有新增推薦模型、訂單結帳、平台代收、分潤計算、XP 政策或正式站成效埋點。下一輪依實際使用瓶頸推進，不把 PR 通過當成商業驗證。

## 驗證與畫面

本機使用 Node 24、每次新建的 PostgreSQL 測試 schema；GitHub 回應使用明示的合成 fixture。測試會員與圖片不是真實公開會員。

測試涵蓋：不用內部代號的作品分享、另一位會員提出合作、預覽零 API 寫入、公開同意、正式作品頁和書架、失敗保留草稿、修改同一份草稿、idempotent replay、來源與權限限制，以及 1280／390／320px 與三主題。

實跑結果：

- `npm run typecheck`、`npm run build` 通過。
- `tsx --test --test-concurrency=1 tests/runtime/flows.test.ts tests/runtime/skill-submissions.test.ts`：最終 **36/36**。
- 7 份相關瀏覽器 suite 共 54 案例，最後廣泛回歸 **53 通過／1 失敗**：恢復草稿時混入分享短文欄位，已改成明確欄位投影。
- 修正上述問題及作品列表即時更新後，重跑新流程與兩項合作流程 **7/7**；之後桌機主按鈕改為小尺寸，再 build 並跑手機／桌機／三主題 **3/3**。
- `npm run worker:dry-run`：local／staging-next／next 三環境通過，沒有發布。

完整全倉 E2E、runtime、跨倉與靜態契約交給 GitHub CI，不把局部測試當成全站驗收。

![桌面作品分享](../design/simple-work-sharing/showcase-desktop.png)

![320px 投稿工具](../design/simple-work-sharing/tool-light-320.png)

![320px 預覽投稿](../design/simple-work-sharing/review-320.png)

發布與完整 CI 結果以此 PR 的最新 head 為準；本機沒有部署到 staging 或 Live。Hao 與 Codex 協作完成程式、介面與測試，既有品牌圖片和作者授權保留。
