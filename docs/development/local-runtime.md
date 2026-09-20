# 本機可運行版本

這份文件描述 `0.1.0-local-core` 的實際程式。完整 56 packages／9 repos／12 runtimes 的設計仍保留；本次實作涵蓋會員工作與合作紀錄的一條本機流程，沒有宣告所有 packages 或階段 1B 完成。

## 啟動

需要 Node.js 24、npm、Docker Compose。安裝 Python 3.10+ 與靜態測試依賴才需跑完整驗證。

```sh
npm ci
npm run demo
```

開啟 <http://127.0.0.1:4310>。指令依序啟動只綁 loopback 的 PostgreSQL、套用 migration、以冪等方式建立虛構示範帳號、build Portal，再啟動 API。資料放在此專案的 Docker named volume；重啟與 seed 不會重設已做的工作。API 與 DB 都只供本機使用。

| 帳號 | 示範用途 |
| --- | --- |
| `maker@local.test` | 認領、提交、分享作品與提供合作 |
| `reviewer@local.test` | 第一張工作卡的需求者與驗收者 |
| `client@local.test` | 提出商機、確認合作與交付、核對收款回報 |

三個帳號密碼均為 `freedom-local-demo`。它們不是實際人的身分；示範帳號不能成為獨立自然人、正式 QC、A4 或已收款證據。這一版明確拒絕 `NODE_ENV=production` 啟動，沒有對外部署設定。

## 兩條可操作流程

1. Maker 登入，認領第一張工作卡，開始工作並提交成果摘要與 `artifact:example-v1` 這類引用。需求者登入開始驗收，可要求調整／重新提交，或接受該 exact submission digest。Maker 的「已獲得的成果」顯示持久保存的紀錄；重新登入、重啟 API 後仍保留。
2. Maker 在「作品與商機」同意分享作品；Client 提出需求；Maker 提案並列明範圍、完成條件、價款；Client 確認 exact terms digest；Maker 交付，Client 驗收；Maker 記錄外部收款回報，Client 可確認。平台明示 `self_reported`／`counterparty_confirmed`，兩者都不是銀行／provider 核實或平台代收。

新工作只支援本人發布、exclusive user claim、自願貢獻。勾選「我願意驗收」是發布者接受此工作範圍的 work review route，沒有賦予產品 QC `ReviewerAppointment`。不勾選仍可發布、認領、提交；不自動指派核心人員，也不保證回饋時數。成果接受不自動產生款項、XP、rank、正式 QC 或新的權益。

成果與收款引用只接受 `kind:opaque-ref`，不抓取外部 URL。展示可見性限同一社群；商機及合作僅雙方可讀。這一版記錄必要的摘要／引用，不提供原始檔上傳或憑證存放。

## 程式與資料邊界

- `apps/platform-api`：Hono HTTP transport；Node loopback adapter 供本機重跑，尚未部署 Worker。
- `apps/portal-web`：React/Vite 繁中會員工作台。
- `modules/identity-membership`：salted scrypt password、伺服器 session、撤銷與登入次數限制。沒有 LINE／Discord／GitHub OAuth。
- `modules/opportunity-project-work`：工作生命週期、immutable submission revision、驗收與 Contribution；以及當前本機合作觀測流程。
- `packages/db`、`migrations`：唯一 PostgreSQL 真相、同 transaction 的 transition journal／outbox／command receipt。沒有第二份記憶體資料庫，也未部署 Queue dispatcher。
- `packages/testing`：明示虛構的本機 seed；反覆 seed 不覆寫進行中工作。

每個 mutation 驗證 session、Origin、CSRF、嚴格 request body 與 idempotency key；已有 aggregate 使用 `If-Match`。exclusive claim 的 WorkItem row lock 保證並發只有一位成功。Command receipt、實體、decision、Contribution、journal/outbox 在同一交易提交；失敗整筆回滾。重播仍核對當下 session 與 resource authority。work review route 鎖定 exact work scope；claimant 不能驗收自己的提交。

`claim_by` 對應認領窗口，`finish_by` 對應交付期限；認領後窗口到期不抹除 Claim。`feedback_due` 只控制本機 review route 的有效期間，不會建立 TaskLease 或 ExecutionGrant。此版沒有 Agent 執行、queue lease/fence、正式簽章或可執行 Skill overlay。

## API 範圍

所有路徑在 `/api/v1`。認領 endpoint 的 request 與 response 以現有 [OpenAPI](../platform-plan/contracts/openapi-outline.yaml) 的 `ClaimWorkItemRequest`／`WorkClaim` 驗證；`aggregate_version` 在 JSON 為安全整數，ETag 為其加引號表示。列表是本機 UI 的讀取投影，不是假稱完整 production contract。

| Endpoint | 功能 |
| --- | --- |
| `POST /auth/login`、`POST /auth/logout`、`GET /session` | 示範帳密登入、session 與撤銷 |
| `GET/POST /work-items`、`POST /work-items/{id}:claim` | 列表、有限自願工作、原子認領 |
| `POST /work-claims/{id}:start/:submit/:begin-review/:decide` | 各別 action suffix 路徑；開始、提交、開始驗收、作成決定 |
| `GET /dashboard` | 從 canonical 工作／貢獻事實讀取 Now／Next／Gained |
| `GET/POST /showcases`、`GET/POST /opportunities` | 本人同意展示、雙方商機 |
| `POST /opportunities/{id}/engagements`、`GET /engagements` | 有明示條款的本機合作提案 |
| `POST /engagements/{id}:agree/:deliver/:accept/:confirm-receipt` | 各別 action suffix 路徑；本人身分與版本核對 |
| `POST /engagements/{id}/receipts` | 一次全額收款觀測，必須同幣別、同約定金額；相同證據不可重複 |

除了認領 endpoint 的相容子集，其餘為此本機 milestone 的應用 API。它們尚未實作 production `ServiceEngagement`／SOW／exact A4 的全套法律、撤銷與簽章流程，正式 adapter 必須在啟用前補齊。`health` 明示 `money_movement_enabled=false` 與 `official=false`。

## 重跑與故障處理

```sh
python3 -m pip install -r docs/platform-plan/contracts/tests/requirements-static.txt
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:e2e
npm run test:contracts
npm run verify:inventory
```

API 整合測試與瀏覽器測試各自建立暫存 PostgreSQL schema，結束後只移除該次 schema，不重設示範資料。CI 用獨立 PostgreSQL service。可用 `TEST_DATABASE_URL` 指向專用測試 DB；勿指向 production。

- `npm run db:down` 停止此專案 DB 並保留 volume；`npm run demo` 可恢復。
- 若認領回 `412`／條款改版回 `409`，重新整理並確認最新版本；不以新識別碼盲目重送。
- 網路回應未知時，UI 保留原 idempotency key；手動重試使用原內容，成功後重新讀取狀態。
- 停止 API 後可再 `npm start`；資料不依賴 API process memory。
- `/tmp` 配額不足造成 Chromium crash 時，可用有空間的 `TMPDIR` 重跑瀏覽器測試；不能把 crash 當驗收通過。
- 修改來源後先完成測試與 release 紀錄，再執行 `python3 scripts/update-inventory.py`；`verify_revision.py` 只讀驗證，不自行改 manifest。

Vite 熱更新可分別啟動 `APP_ORIGIN=http://127.0.0.1:5173 npm start` 與 `npm run dev`。一般示範建議單一 `npm run demo` 入口。

實作參考：[Hono Node adapter](https://hono.dev/docs/getting-started/nodejs)、[node-postgres transaction](https://node-postgres.com/features/transactions)、[Vite build](https://vite.dev/guide/build)。
