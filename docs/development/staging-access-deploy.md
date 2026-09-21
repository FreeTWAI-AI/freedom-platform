# Staging（內部 Access）佈署清單與落地路徑

日期：2026-09-21。目標：讓 Ted／Mini／Jason／Hao／韋銘**看得到、點得到** `v0.1.0-local-core` 工作台，網址在 Cloudflare Access 後面（外人進不來）。**不是** production public release，也**不是**宣稱 56-package／Workers 全架構已上線。

## 0. 先講清楚：現在程式實際是什麼

| 項目 | 現況（`443e281`／local-core） | 計畫文件裡的大架構 |
| --- | --- | --- |
| API | Node＋Hono（`@hono/node-server`） | Cloudflare Workers |
| UI | Vite build 靜態檔，由同一 Node process 送出 | Workers／Pages |
| DB | Docker Postgres（本機 compose） | PlanetScale Postgres＋Hyperdrive |
| 綁定 | `server.ts`：**禁止** `NODE_ENV=production`；`APP_ORIGIN` **必須**是 `127.0.0.1`／`localhost` | staging／production 分環境 |

因此「把大架構一次推上雲」≠「明天就能點 Portal」。要先選一條 **Staging A（現有 Node 棧上雲＋Access）** 讓人有感覺；**Staging B（Workers＋Hyperdrive 改寫）** 並行當架構軌道。

---

## 1. Staging A — 現有工作台上雲（建議先做，為了「有感覺」）

### 1.1 架構（最小）

```
瀏覽器 → https://staging.freetwai.com（或 *.freetwai.com）
       → Cloudflare Access（只允許指定 Google／email）
       → 來源：Castle Tunnel 或小型 Node host
       → Node API＋Portal（放寬後的 staging origin）
       → Managed Postgres（staging 專用；非本機 Docker）
```

平台仍不過手金錢；示範收款 ≠ 銀行核實。

### 1.2 程式必須先改（否則永遠只能 localhost）

在 `apps/platform-api/src/server.ts` 增加明確的 **staging 模式**（建議環境變數）：

- `FREEDOM_ENV=staging`（或 `APP_ENV=staging`）時：
  - 允許非 loopback `APP_ORIGIN`（必須 https）
  - 仍禁止當 production（不開 production auth／不宣稱正式發布）
  - Origin／CSRF 檢查對齊 `APP_ORIGIN`
- `FREEDOM_ENV=local`：維持現況硬鎖

此刀建議交 **Codex `01a0bd1a`** 做；驗收：staging 設定下可 boot，local 行為不變。

### 1.3 雲端資源清單

| # | 項目 | 誰做 | A4？ | 備註 |
| --- | --- | --- | --- | --- |
| A1 | DNS：`staging.freetwai.com`（或決定的 hostname）CNAME／Tunnel | Bot＋CF 帳 | 否（網域已買） | 目前 freetwai.com DNS 幾乎空 |
| A2 | Cloudflare Access Application：只允許核心 email | Bot 起草／Ted 確認名單 | 否 | 建議：Ted、Mini、Jason、Hao、韋銘 |
| A3 | Cloudflare Tunnel（連 Castle:4310）**或** 獨立 Node host | Bot／Castle | 否／視 host | Tunnel 最快；獨立 host 較乾淨 |
| A4 | Staging Postgres | Ted 付款 | **是（付錢）** | 建議 PlanetScale single-node staging ≈ catalog 最低價；或同等 managed PG |
| A5 | Hyperdrive（若 DB 在外網） | Bot | 可能要 Workers Paid | Staging A 若 Node 直連 PG，可暫不用 Hyperdrive |
| A6 | Secrets：`DATABASE_URL`、`APP_ORIGIN`、session 相關 | Bot 設、不進 git | 否 | staging ≠ production credentials |
| A7 | Seed：示範帳可留，但頁面大標「Staging／非正式」 | Bot | 否 | 勿與真人核實實收混淆 |
| A8 | GitHub Environment `staging`＋deploy workflow（可後做） | Bot | 否 | 先手動／Tunnel 也行 |

### 1.4 落地順序（勾選）

- [ ] Ted 確認 hostname（建議 `staging.freetwai.com`）
- [ ] Ted 確認 Access 允許名單（email）
- [ ] Ted **A4**：staging Postgres 採購（provider／SKU／月費）
- [ ] Codex：放行 `FREEDOM_ENV=staging`＋測試
- [ ] 建 Tunnel 或 host；DNS 指到 Tunnel／來源
- [ ] Access 擋在前面；用非允許帳號驗證會被拒
- [ ] migrate＋seed；核心五人各自登入走一遍「認領→提交→驗收」
- [ ] 寫短 release note：`docs/releases/YYYY-MM-DD-staging-access.md`

### 1.5 明確不宣稱

- 不是 production、不是 public Official
- 不是 Workers 全架構完成
- 不是 Infrastructure Ready／T01–T34 全綠
- 不是真人成交或銀行核實

---

## 2. Staging B — 大架構（Workers／Hyperdrive／Queues）並行軌道

依 `08-bootstrap-hosting-project-lifecycle.md` Day 1／staging 目標：

| # | 項目 | A4？ | 狀態 |
| --- | --- | --- | --- |
| B1 | Cloudflare Workers Paid | 付錢→A4 | 未開（帳已有） |
| B2 | PlanetScale prod＋staging（prod HA 另議） | 付錢→A4 | 未建 |
| B3 | Hyperdrive binding、分環境 secrets | 否 | 未建 |
| B4 | 把 Hono app 從 node-server 遷到 Workers | 否 | **未開始**（大刀） |
| B5 | Queues／Workflows／R2 最小骨架 | 否／視用量 | 未建 |
| B6 | GitHub `staging` Environment 自動 deploy | 否 | 未建 |
| B7 | KMS／signer／broker | 多數否；prod signed 另控 | 不擋內部 demo |

**建議**：B 與 A 並行，但**不要**等 B 做完才給人點。A 給體感；B 給架構正確性。

---

## 3. 你（Ted）現在只要回這幾件事

1. Hostname：是否用 `staging.freetwai.com`？
2. Access 允許 email 名單（可先只給你自己）
3. Staging DB：是否同意開 **PlanetScale Postgres staging（或你指定的 provider）** 並付當期最低價？（A4）
4. 來源偏好：**(a)** Castle Tunnel 掛現有 demo，或 **(b)** 另開小 host 跑 Node？

回完 1–4，Bot 就能繼續落地（程式刀進 Codex；CF／DNS 在已登入的 VM 做）。

---

## 4. 與「第一筆真人案」關係

真人案模板仍在 `docs/development/first-real-case-pack.md`，**先擱**。等 staging 可點之後，再用同一套 Portal 跑內部演習；正式核實實收仍要真人證據。
