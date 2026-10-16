# EC-SPEC-10 發布與操作：開關、寫入下限、發布順序、回退、還原與試用

狀態：proposed（2026-10-15），基準 `efaf314d`；同日再讀 `origin/main` `5bee7376`，migration 仍到 167，本文引用的行號不變。對應需求 EC-R03、R15、R27、R47、R48、R50、R52、R55、R56、R59、R60；驗收 EC-AT61、63、64、67～72（全部 `not_run`）。

本文件定案其他文件交給本文件的項目：主機設定與公開布林（§2.2、§2.3）、平台與 provider 環境（§2.4）、店家准入（§2.5）、能力清單（§2.6）、寫入下限（§3）、發布順序與部署設定（§4）、staging 的 Access 排除（§4.4）、provider 准入（§4.5）、排程（§5）、寄信（§6）、回退（§7）、還原與隔離（§8）、試用與結案（§9）。

本文件不授權部署、改正式資料、開旗標、設定 Access、寄信、連線綠界，也不授權聯絡會員或商家。每一步由 Ted 決定，Agent 只準備候選、工具與證據。標「提議」的設定、表、路由與函式尚未存在。

## 1. 現況（已核對）

| 範圍 | 事實 | 位置 |
| --- | --- | --- |
| 發布相容檢查 | 能力白名單 `CAPABILITIES`、shape 表 `SHAPES`。schema 到 165、164、162 時，不論旗標都要求每個在跑與候選的 binary 具備對應能力。環境只有 `next`（正式）與 `staging-next`（staging）。沒有 `writerFloor` 欄位；歷史下限 `rollback_floor` 由主機在可還原的資料庫之外保存，還原較舊的 schema 也抹不掉 | `deploy/cloudflare/lib/release-compatibility.mjs:14-16`、`:533-535`；`deploy/cloudflare/release-compatibility.md:63-64`、`:411-453` |
| 功能旗標 | 主機環境變數，只有精確的 `'true'` 才開。`readWorkerConfig` 拒絕拼錯的值與缺少依賴的組合，任何設定錯誤都讓全部路徑回 503。旗標與 secret 放在操作者的私人設定，不在 repo | `apps/platform-api/src/worker.ts:124-165`、`wrangler.jsonc:24-34` |
| 公開布林 | `GET /api/v1/site` 回傳各功能的布林（例如 `guild_launchpad_enabled`），前端依此顯示入口 | `apps/platform-api/src/platform-app.ts:322` |
| 安裝檢查 | 部署前檢查旗標與 binding 的組合，例如商店照片要 launchpad 與 IMAGES | `deploy/cloudflare/lib/media-wrangler.mjs:72-75` |
| 管理 API | `/admin/api` 由平台管理員的 Access 身分驗證；稽核寫 `platform_admin_audit`，冪等用 `platform_admin_receipts` | `platform-app.ts:310`、`migrations/011_platform_admin.sql:9-21` |
| 排程 | 每個環境一個 cron `*/10 * * * *`；`scheduled()` 依序跑具名工作，每項有自己的 try，沒有 queue | `wrangler.jsonc:71`、`:83`、`:102`；`worker.ts:431-465` |
| 寄信 | `EMAIL` binding 只在 staging 與正式環境，寄件人固定 `no-reply@mail.freetwai.com`；活動信在交易之外直接寄出 | `wrangler.jsonc:88`、`:107`；`worker.ts:250-253`、`:437-443` |
| Access | staging 整個網域與 `/admin` 各有一個 Access application，只限具名人員；正式環境只保護 `/admin`。目前沒有任何 bypass | `docs/development/cloudflare-migration.md:251`、`docs/development/staging-access-deploy.md:30` |
| 部署 | staging 與正式環境都是 `938516ee`、schema 166；main 上的 167 還沒部署 | `docs/platform-plan/execution/unified-foundation/closeout.md:14-20`、`:71`（main） |
| 還原 | production 部署後備份的還原還沒成功過（四次嘗試，最後一次在 restore 階段失敗）。T-047：備份後撤銷的成員或邀請，還原後會回到有效；tenant 表沒有 recovery generation，只靠隔離與操作步驟 | `closeout.md:27-54`（main）；`docs/development/daily-recovery-backup-installation.md:96-101` |
| 預留的寫入下限 | 162 之後，只把 Worker 退回 162 之前的版本不算回退；還原後保持隔離，直到目前的權限與撤銷對帳完成 | `modules/agent-commerce/hosted/inventory-reservations.md:49-55` |
| 到期預留的排程函式 | `sweepDueCheckoutHolds`：每次最多 200 張訂單，每張在自己的交易處理；已寫好，還沒接到 cron | `modules/agent-commerce/checkout/settlement.ts`（分支 `fc/wp03-core`） |
| Supplier Console 的開關 | `FREEDOM_SUPPLIER_CONSOLE_ENABLED` 預設關，需要 launchpad；`site.supplier_console_enabled` 取兩者的 AND。Seller Console 的殼由它提供 | SC-SPEC-06 §1（分支 `feat/supplier-console-r1`） |

## 2. 能力與開關

### 2.1 三層條件

一項商務功能要對某位買家可用，下列三層都要成立：

1. **binary 具備能力**。§3 的寫入下限保證：schema 裡有的東西，每個在跑的 binary 都懂。
2. **主機設定打開**（§2.2）。由 Ted 經 release wrapper 設定。
3. **該店的條件成立**：
   - 實例是 1.1.0（EC-SPEC-09 §2.3）；
   - 已准入（§2.5）；
   - 服務是 `active`（EC-SPEC-04 §1.4、EC-SPEC-05 §2.2、EC-SPEC-06 §3）；
   - 店家打開了 `checkout_enabled`（EC-SPEC-02 §2.3）。

任何一層關閉，都只停止**新的**動作。已成立的責任照常進行，包括付款通知與查詢、退款、出貨追蹤、到期釋放與遮罩（計畫 §18.2、EC-R56）。

開關不是授權。每次讀寫仍由伺服器檢查 tenant、實例、能力與目前狀態（EC-SPEC-09 §2）。

### 2.2 主機設定（提議）

| 設定 | 預設 | 就緒檢查的依賴 | 打開時 | 關閉或缺少時 |
| --- | --- | --- | --- | --- |
| `FREEDOM_COMMERCE_CONSOLE_ENABLED` | 關 | launchpad；`FREEDOM_SUPPLIER_CONSOLE_ENABLED`（殼） | E02～E11 的新頁面與新的讀寫路由（EC-SPEC-01 §7.5）。M2 只有賣家的訂單、付款例外、退款紀錄與立即查詢路由，還沒有 E 頁 | 新路由回 404；E 頁的 slug 回到既有頁面；資料不動 |
| `FREEDOM_COMMERCE_CHECKOUT_ENABLED` | 關 | console | 新的 checkout、`hosted_checkout` 訂單與付款交接（B04、B05） | 購物車與結帳按鈕隱藏，B03 顯示「目前暫停接單」。已成立訂單的付款通知、查詢、到期釋放、出貨、售後與退款照常 |
| `FREEDOM_COMMERCE_PROVIDER_PROFILES` | 空 | 每個 ID 都必須是這個 binary 實作的 profile；列有 `ecpay.*` 時必須有 `COMMERCE_CREDENTIAL_KEYS` 與 `COMMERCE_JOURNAL`；只列線下 profile 時不需要（EC-SPEC-11 §8） | 只有列出的 profile 能啟用新服務、出現在結帳選項、發起新的對外操作（付款交接、建單、開票、API 退款） | 不在清單的 profile 照常接收通知與查詢；尚未執行的操作留在佇列，重新列入後繼續，不丟棄 |
| `FREEDOM_COMMERCE_EMAIL_ENABLED` | 關 | Worker 的 `EMAIL` binding 與 `COMMERCE_JOURNAL`；Node server 打開時就緒失敗 | §6 的交易信件；只有打開期間發生的事實會建立信件列 | 不寄信，也不建立新的信件列，關閉期間的事實事後不補寄；打開時已建立、還沒寄出的列留在佇列，重新打開後在到期前寄出（§6.3） |
| `FREEDOM_COMMERCE_QUARANTINE` | 關 | — | 隔離模式（§8.3） | 正常 |
| secret `COMMERCE_CREDENTIAL_KEYS` | 無 | 有值但格式錯誤時就緒失敗 | 解封商家金鑰（EC-SPEC-04 §1.3） | provider 入口回 503（綠界會重送）；帳戶寫入回 503；其他頁面正常 |
| R2 binding `COMMERCE_JOURNAL` | 無 | — | 外部效果日誌（§8.2） | 不發起任何新的對外操作 |

規則：

- 布林只接受 `true`／`false`。profile 清單以逗號分隔，不允許空白、重複與未知 ID。不合規則或缺少依賴時丟 `ReadinessError`，比照既有旗標（`worker.ts:124-165`）。
- Node server（`apps/platform-api/src/server.ts`）、E2E server 與 fixture 都用同一份解析函式。
- 安裝檢查（比照 `media-wrangler.mjs`）加相同的組合規則，部署前就擋下。
- 正式與 staging 的值由 Ted 經 release wrapper 設定。每次變更都記在 receipt：環境、時間、前後值。
- 新設定對設定生效後的請求才有作用；處理中的請求以開始時讀到的設定完成。每個命令是單一交易，所以不會停在一半。
- M1 只有 `CHECKOUT` 與 `QUARANTINE`，`CHECKOUT` 依賴 launchpad。M2 的 wp04-seller 加入 `CONSOLE`，`CHECKOUT` 改依賴 `CONSOLE`：賣家要能處理訂單，才能開放結帳（§7 的回退也一起關）。`CONSOLE` 起初只依賴 launchpad；Supplier Console 的殼進 main 後（2026-10-16），`CONSOLE` 也依賴 `FREEDOM_SUPPLIER_CONSOLE_ENABLED`。就緒與安裝檢查的錯誤碼：`commerce_launchpad_required`（`CONSOLE` 沒有 launchpad）、`commerce_supplier_console_required`（`CONSOLE` 沒有 Supplier Console 的開關）、`commerce_console_required`（`CHECKOUT` 沒有 `CONSOLE`）。

### 2.3 `site` 欄位與頁面

- `/api/v1/site` 新增兩個欄位：
  - `commerce_console_enabled`：console、supplier console 與 launchpad 三者的 AND；
  - `commerce_checkout_enabled`：checkout 與 console 都開，而且不在隔離模式。
  - M1 只加 `commerce_checkout_enabled`（checkout 開而且不在隔離模式）；`commerce_console_enabled` 在殼進 main 後加入（2026-10-16）。
- 不公開 profile 清單、金鑰狀態或隔離原因。
- B01～B03 是否出現購物車，由伺服器依該店的三層條件決定（§2.1），不只看 `site`。這幾頁的 HTML 由伺服器產生（EC-SPEC-02 §6）。
- `/api/v1/health` 不加 commerce 欄位。設定錯誤本來就讓全站回 503，所以部署驗收的 health 階段就會發現。

### 2.4 平台環境與 provider 環境

| 平台環境 | 允許的 provider 環境 | 說明 |
| --- | --- | --- |
| local、CI、E2E | 只有 `sandbox` | 欄位值是 `sandbox`，但只用 fixture adapter 與本機假 provider：adapter 的主機白名單在這些環境只有本機，連不到任何綠界主機 |
| staging（`staging-next`） | 只有 `sandbox` | 綠界 stage 主機、公開測試特店與測試卡；需要 §4.4 的 Access 排除 |
| 正式（`next`） | 只有 `live` | 沒有測試模式；商家要試做，就用真實小額交易再退款（§4.5） |
| 自架（C3） | 安裝時選一種，之後不改 | 一個安裝只用一種 provider 環境（EC-SPEC-08） |

- 建立帳戶時，若環境不在上表允許的範圍，回 422 `provider_environment_not_allowed`。這是依 `FREEDOM_ENV` 的程式規則，不是可調的設定：`local` → `sandbox`、`staging` → `sandbox`、`public` → `live`，每個平台環境只對應一個值。店家准入（§2.5）的環境也用同一個對應，請求內容不指定。
- 理由：
  - 正式站允許 sandbox 帳戶時，買家會在正式網址看到不扣款的「訂單」，報表與對帳都要多一層排除；
  - staging 允許 live 帳戶時，測試站會產生真實扣款。

### 2.5 店家准入（提議 `commerce_store_admissions`）

C2 是受控營業（計畫 §5）。staging 與正式環境的店都要經 Ted 准入，才能打開結帳。

- 表的欄位：`tenant_id`、`instance_id`、`environment`、`admitted_at`、`admitted_by`、`reason`、`revoked_at`、`revoked_by`、`revoke_reason`。
  - 一店一環境，同時最多一列有效。
  - 列不可改；撤銷只能前進。
  - 不含個資，所以豁免 RLS；catalog 登錄豁免理由。
- 命令：`POST /admin/api/commerce/store-admissions` 與 `…/:admission_id/revoke`。
  - 只有平台管理員能執行（既有 `/admin` 的 Access 身分與 `platform_admins`），而且必須獨立於這間店：管理員的 Email 若是該事業任一在職成員（不分角色），回 403 `admission_not_independent`。不另加管理員能力表；只限 Ted 本人是另一個決定（decisions.md）。
  - 准入的環境依 §2.4 從 `FREEDOM_ENV` 推出；事業或實例不是 `active` 時不能准入，撤銷不受限制。
  - 要 `Idempotency-Key`；稽核寫 `platform_admin_audit`。
  - Agent 與商家都不能為自己的店准入。
- 准入只是 EC-SPEC-02 §2.3 的第 5 項，其他條件照樣要成立。撤銷立即停止該店新的 checkout；已成立的訂單照常完成。
- M2 的准入檢查（`CheckoutAdmissionPort`）＝該店在目前 provider 環境有未撤銷的准入，而且實例登錄的能力包含 1.1.0 的 12 個鍵；EC-SPEC-02 §2.3 的其他條件由之後的工作加入。
- seed 不建立商店，所以也不建准入；runtime 測試與 E2E 經同一個准入函式建立。
- 擴大使用（計畫 §18.2 的第三步）要改成「符合條件即可開」，是另一個決定（§12）。在那之前不加自動准入。

### 2.6 能力清單（提議 `modules/agent-commerce/operations/commerce-capabilities.json`）

計畫 §18.1 要求每個 provider profile 與功能標出驗證程度。清單是版本化的資料檔，格式 `freedom.commerce-capabilities/v1`。每一項的欄位：

| 欄位 | 內容 |
| --- | --- |
| `id` | 例如 `ecpay.aio.credit.v1`、`ecpay.logistics.home.tcat`、`ecpay.logistics.cvs.unimartc2c`、`ecpay.invoice.b2c.v1`、`commerce.checkout.guest` |
| `kind` | `payment`、`logistics`、`invoice`、`feature` |
| `stage` | C1～C4（計畫 §5） |
| `status` | `planned` → `implemented` → `sandbox_verified` → `production_verified`，只能前進 |
| `evidence` | 每個 `implemented` 之後的狀態都要有 receipt 的 ID（PR、測試報告或 rollout receipt），沒有證據不能前進 |
| `limits` | 已知限制，例如「API 退款在正式環境的受控試退前只能人工紀錄」（EC-SPEC-04 §7.3） |

規則：

- 這是紀錄，不是開關。runtime 不讀它；正式環境能不能用某個 profile，由 §2.2 的清單、§2.5 的准入與商家服務決定。
- CI 檢查：
  - 每個 `implemented` 的 profile 在程式裡都有 adapter，每個 adapter 都在清單裡；
  - 只能前進；
  - 每個 `sandbox_verified`、`production_verified` 都有證據 ID。
- 狀態更新以 PR 送出，附上證據。`production_verified` 指這個 profile 第一次在正式環境的受控試用通過，不代表每位商家都能用；每位商家仍要自己的服務 `active`。
- 從清單產生的內容：書的「各模式能做的事」附錄（EC-SPEC-07 §5）、可攜發行清單的 `modes`（EC-SPEC-08 §3.3）、`storefront` 閱讀指南的狀態文字（EC-SPEC-07 §3）。這些都不手寫。

## 3. 寫入下限（release-compatibility）

| 里程碑 | 能力 | 在哪個 migration 成為強制 | 舊 binary 會做錯的事 |
| --- | --- | --- | --- |
| M1 訂單與庫存核心 | `commerce.hosted-checkout.v1` | M1（目前分支上是 168） | 不懂 `hosted_checkout`：v1 的意圖查找可能撞到新訂單；v1 缺貨時不先釋放到期的 checkout 預留（EC-SPEC-03 §8） |
| M2 收款 | `commerce.hosted-payment.v1` | M2（`169`；與 checkout 旗標無關） | 沒有付款通知的路由與查詢，會漏接付款（EC-SPEC-04 §9） |
| M3 履約 | `commerce.hosted-fulfilment.v1` | M3 | 沒有物流通知的路由，會漏接貨態（EC-SPEC-05 §13） |
| M4 發票與售後 | `commerce.hosted-invoice.v1` | M4 | 沒有折讓通知的路由；不懂售後與發票的狀態（EC-SPEC-06 §9） |

每一項都照 162 的做法登錄：

1. `CAPABILITIES` 加上能力。
2. `SHAPES` 加一個同名 shape，`migration` 是該 migration。
3. 加一行強制條件：`Math.max(plannedLast, floorLast) >= M` 時要求這個能力（比照 `:533-535`）。
4. 能力之間的依賴寫成 `required` 的推導：M2 要求 M1 的能力，M3、M4 各要求前一個。
5. `release-compatibility.md` 加一節，說明這個下限與「承認能力不代表任何操作權」。
6. 更新約 15 個 `deploy/cloudflare/test/release-*.test.mjs` 裡核准能力的陣列，並為每個下限加三種測試：
   - 計畫的 schema 到 M 而 binary 缺能力時拒絕；
   - 還原到 M 之前、但歷史下限保留 M 時仍然拒絕；
   - 能力齊全時通過。

規則：

- 能力只代表「這個 binary 讀寫這些資料的方式正確」，不授予付款、寄件、開票或部署的權限。
- 下限在 migration 套用的那一刻就成立，與旗標無關。所以每個里程碑的 binary 要先部署到所有環境，才能套用該 migration（§4.2）。
- 新增 migration 的其他登錄點見 WP-00 §4：`environments.json` 的 `migrations.last`、`FOUNDATION_NAMES`、`migration-plan.test.mjs`、release-compatibility 測試以 `prefix(scan, 167)` 改指的兩個測試，以及 runtime grants 重跑。

## 4. 發布

### 4.1 migration 順序

- 167（`community_ar`）在 main 上還沒部署。commerce 的第一次發布，若 167 仍未部署，依序套用 167 與 M1；或由 root 先單獨發布 167。這是 root 的發布排程，本計畫不決定。
- 編號在整合當下依 main 決定（EC-SPEC-03 §7）。Supplier Console 的 S3（素材）也需要 migration，誰先合併誰取下一號；後到的一方在整合時改號並更新全部登錄點。
- 每個 migration 只含一個里程碑；不把不同里程碑的表合進同一個檔案。
- 已套用的 migration 不改 bytes。要修正就新增 migration。

### 4.2 每個里程碑的步驟

固定一個已合併的 main SHA 當候選，之後不追新的 main。步驟沿用 release wrapper（私人，不在 repo）與 SC-SPEC-06 §3：

1. 確認沒有尚未部署的必要安全修補；有的話先處理。
2. 同一個 SHA 的完整 CI 通過；取消或略過不算（EC-SPEC-09 §6）。
3. 兩個環境都先部署**含新能力的 binary**，旗標維持原狀，讓 release-compatibility 記錄新能力。
4. 每個環境：備份 → migrator 套用 migration → 重跑 runtime grants → 唯讀檢查（grants、RLS、新表的 owner）。只用 migrator 角色（`deploy/cloudflare/migration-operator.md`）。
5. staging 先開新功能，跑 §4.6 的驗收。正式環境用同一個候選，部署後保持關閉，由 Ted 決定開啟時間。
6. 每一步留 receipt：SHA、環境、時間、設定前後值、結果。任何一步失敗就停在那裡，不跳過。

各里程碑的特別事項：

| 里程碑 | 特別事項 |
| --- | --- |
| M1 | 正式環境的 checkout 旗標保持關閉：沒有收款就沒有可營業的結帳。M1 沒有店家准入表（§2.5 在 M2），所以 staging 也不能成立 `hosted_checkout` 訂單；staging 只驗證 v1 相容與排程（§4.6） |
| M2 | 同一個 migration 登錄 `storefront@1.1.0`、`hosted-store@1.1.0` 與升級列（EC-SPEC-09 §2.3）。第一次需要 `COMMERCE_CREDENTIAL_KEYS`、`COMMERCE_JOURNAL`、staging 的 Access 排除與 cron 工作（§5） |
| M3 | 物流通知與選店返回加入 Access 排除；物流 profile 依 §4.5 逐一准入 |
| M4 | 折讓通知加入 Access 排除；發票 profile 依 §4.5 准入 |

### 4.3 部署設定（Ted 操作）

| 項目 | 何時 | 內容 |
| --- | --- | --- |
| `COMMERCE_CREDENTIAL_KEYS` | M2 | 每個環境各自一組 keyring，以 Worker secret 設定；不進 repo、不進 receipt。格式見 EC-SPEC-04 §1.3：`<key_id>:<base64>` 以逗號分隔，第一把封存新資料。換金鑰：把新的一把放在最前面、部署、執行重新封存、確認沒有舊 `key_id` 的列，再移除舊的一把 |
| 退役的 keyring 金鑰 | 每次換金鑰 | 換掉的金鑰另外離線保存，期限至少等於最長的備份保存期限。否則還原出來、以舊金鑰封存的列無法解封（§8.4） |
| R2 bucket `COMMERCE_JOURNAL` | M2 | 每個環境一個，不放進媒體備份集合；設定 bucket lock，保存期內不能刪除或覆寫；保存期限見 §8.2 |
| Access 排除 | M2 起，staging | §4.4 |
| 主機設定 | 依階段 | §2.2 |
| cron | 不需要改 | 沿用 `*/10 * * * *`，在 `scheduled()` 加工作（§5） |

### 4.4 staging 的 Access 排除

綠界伺服器沒有 Access 身分；買家瀏覽器從綠界頁面送出的跨站 POST 也不一定帶得到 Access 的 cookie。所以 staging 要讓 EC-SPEC-09 §2.6 的五條路徑繞過 Access：

| Access application（Bypass，Everyone） | 涵蓋的路徑 | 起始里程碑 |
| --- | --- | --- |
| `staging.freetwai.com/api/v1/provider-callbacks/ecpay/*` | 付款、物流、折讓通知 | M2（物流 M3、折讓 M4 沿用同一個） |
| `staging.freetwai.com/pay/ecpay/return/*` | 付款的瀏覽器返回 | M2 |
| `staging.freetwai.com/ship/ecpay/map-return/*` | 電子地圖返回 | M3 |

- 只排除這三個前綴。不排除整個 `/api/`，也不排除付款返回頁（303 之後的 GET）。測試者在 staging 已經登入 Access：若 Access cookie 是 `SameSite=Lax`，跨站導回的 GET 會帶上它；若是 `Strict`，會先經過 Access 登入再回到頁面。兩種情況頁面都只觸發查詢，結果相同。
- Bypass 不能限制 HTTP 方法；這三個前綴下的其他方法由 Worker 回 404。
- 設定後的驗證（記在 receipt）：
  - 未登入 Access 的 client 對三個前綴送出無效的請求，收到 Worker 的回應（`0|invalid` 或 404），不是 302；
  - 同一個 client 讀 `/`、`/api/v1/site`、`/admin`，仍然是 302。
- 正式環境只保護 `/admin`，所以不需要設定。但要確認 `/admin` 的 application 沒有涵蓋這三個前綴。
- sandbox 驗證不再需要時，由 Ted 移除這三個 application。
- 本機沒有公開網址，只能靠查詢驗證（EC-SPEC-04 §5）。

### 4.5 provider 准入（EC-AT68）

一個 profile 從程式到正式使用，依序經過下列關卡；缺任何一關就不開（計畫 §18.1）：

| 關卡 | 條件 | 誰 | 能力清單 |
| --- | --- | --- | --- |
| 1. 實作 | adapter 與官方向量測試在 CI 通過；Node 與 workerd 結果一致（EC-SPEC-04 §11） | CLI＋整合負責人 | `implemented` |
| 2. sandbox | staging 的 profile 清單加入它；以綠界公開測試特店完成完整流程，包含通知（需要 Access 排除）、查詢與 §8 的對帳報表 | Ted 授權連線綠界 stage | `sandbox_verified` |
| 3. 正式設定 | 正式環境的 profile 清單加入它；還沒有任何店能用 | Ted | 不變 |
| 4. 商家 | 店已准入（§2.5）；商家確認合約涵蓋這項服務；物流的 B2C 另需測標（EC-SPEC-05 §2.2） | 商家＋Ted | 不變 |
| 5. 受控試用 | 該商家的 live 服務以真實小額交易啟用：付款與全額、部分退款各一（EC-SPEC-04 §11）；物流建單與查詢（EC-SPEC-05 §2.2）；發票以唯讀查詢確認，第一張發票隨真實訂單開立（EC-SPEC-06 §3） | Ted＋商家；真實扣款與退款 | 第一次通過時 `production_verified` |

- 只有工具範例或尚未開通的帳戶，不出現在任何選單，也不顯示「即將推出」（EC-AT68）。
- 已准入的 profile 可以單獨使用。例如物流 profile 還沒過關，不影響已啟用付款的店以已啟用的配送方式營業。
- 綠界 stage 與正式環境的連線，每一次都需要 Ted 當時的授權。

### 4.6 每個里程碑的 staging 驗收

用合成帳號與合成資料（EC-SPEC-09 §7），每一項記錄結果與證據：

| 里程碑 | 驗收 |
| --- | --- |
| M1 | v1 的直接與 shared 預留照常；舊頁面不變；到期預留的排程有執行（日誌只有工作名稱）；新的公開結帳路由回 409 `checkout_not_enabled`。`hosted_checkout` 的預留、到期釋放、10 件 6＋5 與付款後配置由本機與 CI 的測試證明（fixture 准入與 fixture 付款），不在 staging 成立訂單 |
| M2 | J02～J04：stage 測試卡付款、通知、查詢、失敗與結果不明；升級到 1.1.0；Access 排除的驗證；隔離模式開關一次 |
| M3 | J05～J07：宅配與店到店的建單、列印、貨態通知、選店返回；SL 頁面（與 Supplier Console 一起） |
| M4 | J08、J09：售後、退款、發票開立與作廢、折讓通知；對帳單 |

## 5. 排程

### 5.1 工作

在 `scheduled()` 加一個 commerce 區塊。它有自己的 try，不被其他工作的錯誤中斷；因為有時效，排在 GitHub 同步之前。

| 工作 | 從哪個里程碑 | 內容 | 受什麼控制 |
| --- | --- | --- | --- |
| 延後的付款事件 | M2 | `applyDeferredPaymentEvents`：隔離期間存下、尚未套用的通知事件，依收到的順序套用；排在到期預留釋放之前 | 只受隔離模式控制 |
| 到期預留釋放 | M1 | `sweepDueCheckoutHolds`，每次最多 200 張；有尚未套用的已驗證 `paid` 事件的訂單略過（EC-SPEC-03 §5.2） | 只受隔離模式控制；checkout 旗標關閉時也要跑，否則已成立訂單的預留不會釋放 |
| 到期工作 | M2 | `commerce_due_work` 的到期列（EC-SPEC-09 §2.4）：付款查詢、退款執行與查詢、建單、物流查詢、開票與查詢、寄信、遮罩、存取憑證到期、日誌補寫（§8.2） | 每一列依自己的種類檢查：對外的新操作要 profile 在清單內；寄信要寄信旗標；查詢只要 binary 支援 |

規則：

- 每次執行有三個上限：最多 200 列、最多 50 次對外呼叫、總時間 5 分鐘。數字在 staging 觀察後校準；超過上限的列留到下一次。
- 取列用一個跨 tenant 的查詢（`FOR UPDATE SKIP LOCKED`）。每一列在自己的交易裡綁 tenant 後處理（EC-SPEC-09 §2.4）。
- 有外部效果的呼叫前先取得租約並寫入日誌（§8.2），再連線；結果不明時下一次先查詢，不直接重送（EC-SPEC-04 §6）。查詢是唯讀，只要租約、不寫日誌（EC-SPEC-04 §6.3）。
- 隔離模式時整個 commerce 區塊不執行（§8.3）。
- 錯誤只記錯誤名稱與工作種類，不記內容（EC-SPEC-09 §3）。
- 自架（C3）用 `apps/commerce-standalone/scheduler.ts` 以計時器呼叫同一個函式，上限與規則相同（EC-SPEC-08 §2）。

### 5.2 為什麼 10 分鐘夠用

- 預留到期：下單與缺貨時，程式會先就地釋放到期的預留（`direct-effects.ts`、`checkout/orders.ts`），排程只是補做。
- 付款：綠界的通知通常在幾秒內到；查詢是補救，晚 10 分鐘可以接受。買家在付款返回頁看到的是當下查詢的結果，不等排程（EC-SPEC-04 §4）。
- 需要更細的節奏時，另外提出 queue 或更密的 cron，不在本案範圍。

## 6. 寄信

### 6.1 C2 寄出的信

只有給買家的交易信件；賣家與供應商在站內待辦看到（EC-SPEC-01 §7.5），C2 不寄給他們：

| 信件 | 觸發 | 內容 | 規格 |
| --- | --- | --- | --- |
| 訂單成立 | 付款確認（套用結果是 converted 或 allocated） | 顯示用編號、店名、品項摘要、金額、一次性訂單連結 | EC-SPEC-02 §4.2 |
| 付款後無法出貨 | 付款確認但 unallocatable | 說明店家會退款、聯絡店家的方式 | EC-SPEC-03 §5 |
| 找回訂單 | B10 相符時 | 一次性訂單連結 | EC-SPEC-02 §4.2 |
| 出貨通知 | 包裹交寄 | 物流、追蹤碼、訂單連結 | EC-SPEC-05 §6 |
| 售後有新回覆 | 店家回覆或售後狀態改變 | 「有新回覆」與訂單連結，不含回覆內文 | EC-SPEC-06 §2.1 |

- 寄件人沿用 `no-reply@mail.freetwai.com`，Reply-To 是店家公開的聯絡 Email（EC-SPEC-02 §2.1）。店家還沒有公開的聯絡 Email 時（M2 還沒有賣方揭露）不設 Reply-To，信裡改附商店頁。
- 信件不含行銷內容，所以沒有退訂連結。行銷信需要另外的同意，不在 C2。
- 綠界自己寄的信（例如折讓同意）依商家在綠界後台的設定，不是平台的信（EC-SPEC-06 §3.8）。

### 6.2 寄送授權

`FREEDOM_COMMERCE_EMAIL_ENABLED` 只有在 Ted 授權後才打開。授權的內容：

1. 已審過全部信件範本的文字與連結；
2. 寄件網域與寄件人（沿用既有設定）；
3. 收件人只會是實際下單或申請找回訂單的人；
4. 開始的環境與日期。

授權前：

- 不寄任何 commerce 信件。
- 結帳完成頁明確告知「這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家」。
- B10 改顯示同樣的說明，不收 Email。

### 6.3 可靠寄送與個資

- 觸發寄信的事實與信件列在同一個交易寫入（提議 `commerce_outbound_emails`）。每個（範本、來源事實）只有一列，所以重送的通知不會產生第二封。信件列只在 `FREEDOM_COMMERCE_EMAIL_ENABLED` 打開時建立，所以第一次打開不會寄出之前訂單的信。
- 信件列不存 Email 與個資（EC-SPEC-09 §3），只存來源的參照（訂單、付款套用、找回訂單的申請）與範本代號，所以豁免 RLS（EC-SPEC-09 §2.4 規則 2），由跨 tenant 的到期工作讀取。寄出當下，在該 tenant 的綁定裡讀出收件人；聯絡資料已遮罩時，這一列改成 `suppressed`，不寄。
- 寄送由到期工作執行：取得租約、寫日誌（`email_send`，寫入成功才寄，§8.2）、建立這封信的訂單連結（只存 token 的雜湊）、在交易之外寄出、標成 `sent`。回應遺失時可能重寄一次，這是已知限制；連結 token 只能兌換一次，所以重寄不會擴大權限。
- 寄送服務拒絕的信（格式、收件人、寄件人未驗證）標成 `failed`，不重試；限流與暫時錯誤在 1、5、15、60 分鐘後重試，不超過到期時間。
- 信件列 7 天未寄出就標成 `expired`（訂單連結本身也是 7 天）。結束的信件列（`sent`、`suppressed`、`expired`、`failed`）在最後更新 45 天後刪除（EC-SPEC-09 §3）。

### 6.4 測試用寄件

- 提議 `EmailPort`：正式實作包裝 `EMAIL` binding，`FixtureEmailSender` 只把信件存在記憶體或測試表。
- runtime 測試與 E2E 一律用 fixture；E2E 透過 harness 讀出信件與連結，走完 B10 與訂單連結的兌換。
- staging 預設不開寄信。需要驗證真實寄送時，經 Ted 授權，只寄到 Ted 指定的信箱。

## 7. 回退（EC-AT64）

不以整庫還原作為回退。回退的方式是停止新增、切換到相容的版本，或向前修補，保留已經發生的金錢與履約事實（計畫 §18.3）。

| 情況 | 做法 | 結果 |
| --- | --- | --- |
| 新結帳有問題 | 關 `FREEDOM_COMMERCE_CHECKOUT_ENABLED`，或撤銷個別店的准入 | 不再成立新訂單；已成立的照常完成 |
| 某個 provider profile 有問題 | 把它移出 `FREEDOM_COMMERCE_PROVIDER_PROFILES` | 不建立新的對外操作；通知與查詢照常；佇列中的操作等重新列入 |
| 某間店的帳戶有問題 | 商家或 Ted 把服務設成 `suspended` | 同上，只影響這間店（EC-SPEC-04 §1.4） |
| Seller Console 的畫面有問題 | 關 `FREEDOM_COMMERCE_CONSOLE_ENABLED` | 回到既有頁面；但結帳也必須一起關（checkout 依賴 console），因為賣家要能處理訂單 |
| binary 有錯 | 向前修補；或部署上一個**具備全部已要求能力**的候選 | release-compatibility 拒絕缺能力的 binary（§3） |
| migration 有錯 | 新增修正的 migration；不做 down migration | 已寫入的資料保留 |
| 資料錯誤 | 用領域命令更正，留稽核 | 不直接改表 |

- 舊的客戶端只讀它認得的 v1 DTO；新交易的狀態不塞回舊的 enum（EC-SPEC-03 §1）。
- 回到 M1 之前的 binary 一律不允許：M1 起的強制下限會拒絕它（§3）。即使正式環境從未開過結帳也一樣，因為下限只看 schema。
- 關閉 console 而 checkout 仍開，不是允許的組合：就緒檢查會拒絕（§2.2）。

## 8. 備份、還原與隔離（EC-AT61、AT63、T-047）

### 8.1 原則

- 還原只用在資料遺失或災難，不是回退工具（§7）。
- 綠界已經完成的扣款、建單、開票與退款，不會因為還原本地資料庫而消失。
- 還原後不盲目重做任何對外操作；狀態不明的操作先查詢（計畫 §18.3）。
- 開放正式收款之前，要先有一次成功的 production 還原（目前沒有，§1）。這是 C2 正式營業的前提，不阻擋 staging 與 sandbox。

### 8.2 外部效果日誌（提議）

還原後要知道「備份之後外面發生了什麼」，但那段時間的資料列已隨還原消失。所以在資料庫之外保留一份只增不改的日誌：

- 儲存在 R2 bucket `COMMERCE_JOURNAL`（§4.3）：
  - 每個環境一個，不在媒體備份的集合裡；
  - bucket lock 使保存期內不能刪除或覆寫；
  - 一筆紀錄一個物件，鍵是 `<environment>/<yyyy>/<mm>/<dd>/<kind>/<id>`，以條件寫入確保不覆寫。
- 寫入的事件：
  - **對外效果**：付款交接、建立物流單、改門市、開票、作廢、折讓、API 退款、寄信；
  - **權限與設定的變更**：帳戶與服務狀態、`credential_version`、店家准入、寫入者世代（EC-SPEC-08 §5.2）。
- 內容只有識別碼，不含個資與金鑰：
  - 環境、`account_ref`、tenant、instance；
  - 種類與操作 ID；
  - provider 的交易識別（`MerchantTradeNo`、`AllPayLogisticsID`、`RelateNumber`、發票號碼）；
  - 金額與時間。
- 順序：
  - 對外效果：操作列先提交到資料庫，寫入日誌，**之後**才連線。所以一筆日誌代表「可能發生過」，沒有日誌就一定沒有連線。
  - 設定變更：先提交，再寫日誌。
  - 寫日誌失敗時，對外操作不執行（下次重試）；設定變更已經生效，由到期工作補寫。需要寫日誌的列有 `journaled_at`；對外呼叫要求它不是 NULL。
  - 設定變更先寫進資料庫的 `commerce_control_events`（只增不改、豁免 RLS、不含個資與金鑰；種類是封閉清單，`detail` 只允許固定的鍵），與變更同一個交易；日誌寫入成功後才設 `journaled_at`，只能設一次。
- 保存期限：至少等於最長的備份保存期限再加 30 天。依 OPEN-07 備份 30 天，所以是 60 天。

### 8.3 隔離模式

`FREEDOM_COMMERCE_QUARANTINE=true` 時：

| 項目 | 行為 |
| --- | --- |
| 新 checkout、付款交接、任何對外的新操作 | 停止；回 503 `commerce_quarantined` |
| 會員與 guest 的 commerce 寫入 | 停止；包含改庫存、手動出貨、退款紀錄 |
| 排程的 commerce 區塊 | 不執行 |
| 寄信 | 停止 |
| provider 通知 | 照常驗證簽章並存進收件匣（EC-SPEC-04 §5），回綠界成功；套用延到解除隔離後依序處理：排程先套用延後的事件，再釋放到期預留；有尚未套用的已驗證付款的訂單不釋放（EC-SPEC-03 §5.2、EC-SPEC-04 §5.4） |
| 讀取 | 照常；頁面頂端顯示「商店系統維護中，訂單資料核對中」 |

隔離模式只能由 Ted 在部署設定中開關。還原流程的第一步就是打開它，而且必須在還原的資料庫接到任何請求之前。

### 8.4 還原後的對帳

一個對帳工具（提議 `scripts/commerce/restore-reconcile.mts`）由操作者在隔離模式下執行。連線綠界查詢需要 Ted 當時的授權。

1. 讀備份的時間點 T（備份 manifest），列出日誌中 T 減 10 分鐘之後的全部紀錄。
2. 對每一筆對外效果：
   - 還原的資料庫沒有這筆操作，或操作不是終態 → 向 provider 查詢，記下實際結果；
   - 不重做原操作。
3. 還原的資料庫裡每一筆不是終態的操作（日誌沒有也一樣）都先查詢。查到已完成就記錄結果；查到確定沒發生，才在解除隔離後依原規則繼續。
4. 產生每間店的差異報表，每一列有一個處理方式：

| 差異 | 處理 |
| --- | --- |
| 付款成功，訂單在資料庫裡 | 以 provider 的事實補記付款，依 EC-SPEC-03 §5 配置；庫存不足時是 `paid_unallocatable` 並排退款 |
| 付款成功，訂單隨還原消失 | 沒有收件資料可以出貨：開例外並退款；買家的確認信與憑證指向不存在的訂單，所以頁面要說明「訂單已退款」（以日誌保留的操作 ID 對應） |
| 物流單已建立或已交寄 | 以查詢結果補記 shipment 與出貨異動；對不上訂單時開例外，由商家盤點庫存 |
| 發票已開立或作廢 | 以查詢結果補記；**不重新開立**，否則會重複開票 |
| API 退款已執行 | 以查詢結果補記；不重新退款 |
| 信件已寄出 | 標成 `sent`，不重寄 |
| 權限或設定變更 | 收緊的變更（停用、撤銷准入、退役、寫入者移出）自動重新套用；放寬的變更（啟用、准入、新金鑰）要操作者確認。T 之後新增的商家金鑰無法從日誌取回，服務改成需要重新輸入 |

5. 補記一律經過領域命令，來源標成 `restore_reconciliation` 並附日誌 ID，不直接寫表。
6. 對完後重跑遮罩工作：備份可能含有之後已經遮罩的個資（EC-SPEC-09 §3）。

### 8.5 解除隔離的條件

全部成立，Ted 才關閉隔離模式，並把結果記在 receipt：

1. 部署的 binary 具備還原的 schema 與歷史下限要求的全部能力（§3）。
2. keyring 含有還原資料中所有封存列用到的金鑰（§4.3）。
3. 差異報表每一列都已處理，或由 Ted 註明理由接受。
4. 平台層的 T-047 撤權對帳完成。T-047 解決之前，這一項是人工核對，列在發布檢查（EC-SPEC-08 §5.3）。
5. 遮罩工作已重跑。

### 8.6 演練（`restore_lab`）

- AT63：在隔離環境，用合成商家與 fixture provider 建立「備份 → 付款成功、交寄、開票、退款、撤銷准入 → 還原較早的備份」，跑 §8.4 的工具。驗證不重扣、不重寄、不重開票、撤銷不復活，差異報表完整。
- AT61（C3）：還原到移交之前的備份，舊的中央寫入者在隔離模式下不能寫；核對外部寫入者的世代後，該店保持外部寫入（EC-SPEC-08 §5.3）。
- 演練的隔離環境沒有 `COMMERCE_CREDENTIAL_KEYS`，所以不可能連到真實 provider。

## 9. 試用與結案

試用由 Ted 邀請與安排。Agent 不聯絡會員或商家，只準備任務卡與記錄表（同 SC-SPEC-06 §5）。

### 9.1 C2 受控試用（EC-AT69）

- 對象：自願的賣家、供應商與買家，各至少 2 位，至少一位用手機；人選與實測範圍由 Ted 核准。
- 任務：J01～J09 中適用的流程；付款、退款、寄件都是真實的小額交易。
- 記錄：
  - 完成與否、耗時、求助次數、卡住的位置；
  - 是否需要 DB／API 代操作。需要就是 blocker。
  - 觀察者可以問「你在找什麼」，不能代按。
- 同一個候選版本的付款、貨態、售後證據放在一起，不拼接不同版本的結果。
- 記錄不含個資。小樣本只描述發生了什麼，不推成成功率。

### 9.2 公會作者與書本入口（EC-AT70，C3）

非核心作者加一個應用或書本摘要入口（EC-SPEC-07）。驗收：沒有中央特判、沒有額外資料權限，用 preview 與適用的測試就能完成。

### 9.3 可攜營業（EC-AT71，C3）

非核心部署者依書在乾淨環境安裝、營業、升級與備份（EC-SPEC-08）。驗收：不需要原開發者補秘密或 SQL；限定的 provider 流程能從備份恢復。

### 9.4 結案與舊碼退出（EC-AT72）

- C1、C2、C3 各自獨立接受，不把各分支的通過相加。物流與可攜營業不默默取消。
- 舊頁面的退場條件同 SC-SPEC-06 §6：新版在兩個環境驗過、試用沒有只能回舊頁才能做的主要操作、舊測試都有新版的對應案例。
- 舊的會員 `/api/v1/commerce/*` 與 `/shop-api/v1/*` 只操作 `origin='imported'`（EC-SPEC-03 §1），退場另案處理，不在本案自動移除。
- 能力清單（§2.6）更新到結案時的實際狀態；未驗證的項目保持原狀並寫明原因。

## 10. 程式位置

| 項目 | 位置（提議） |
| --- | --- |
| 主機設定的解析與就緒檢查 | `modules/agent-commerce/operations/runtime-settings.ts`；`apps/platform-api/src/worker.ts`、`server.ts`、`runtime.ts`、`app.ts`；E2E server 與 fixture |
| 安裝檢查 | `deploy/cloudflare/lib/commerce-wrangler.mjs`（比照 `media-wrangler.mjs`） |
| `site` 欄位 | `apps/platform-api/src/platform-app.ts` |
| 店家准入 | M2 的 migration；`modules/agent-commerce/operations/admissions.ts`；`/admin/api` 的路由 |
| 能力清單與 CI 檢查 | `modules/agent-commerce/operations/commerce-capabilities.json`；`tests/runtime/commerce-capabilities.test.ts` |
| 寫入下限 | `deploy/cloudflare/lib/release-compatibility.mjs`、`release-compatibility.md`、`deploy/cloudflare/test/release-*.test.mjs` |
| 排程 | `modules/agent-commerce/checkout/due-work.ts`；`worker.ts` 的 `scheduled()` |
| 寄信 | `modules/agent-commerce/operations/notifications/`（`EmailPort`、範本、信件列） |
| 外部效果日誌 | `modules/agent-commerce/operations/journal/`（`EffectJournalPort`、R2 實作、自架的檔案或 S3 實作） |
| 隔離模式 | `modules/agent-commerce/operations/runtime-settings.ts`；commerce 路由的共同檢查 |
| 還原對帳工具 | `scripts/commerce/restore-reconcile.mts` |

`operations/` 底下的檔案屬於新的 descriptor `commerce-operations`：`agent-commerce` 的 descriptor 已經有 64 條路徑，不能再加。descriptor 的歸屬與工作順序在 [work-plan.md](work-plan.md)。

## 11. 測試（全部 not_run）

| 測試 | 驗收 |
| --- | --- |
| 每個設定：預設關；只接受精確值；拼錯、未知 profile、缺依賴時就緒失敗；Node 與 Worker 一致；`site` 欄位的 AND | §2.2、§2.3 |
| checkout 關閉後：新 checkout 被拒；已成立訂單的付款通知、查詢、到期釋放、出貨與退款照常 | EC-AT64、R56 |
| profile 移出清單：不出現在選項、不建立新操作；通知與查詢照常；佇列中的操作在重新列入後繼續 | EC-AT68 |
| 平台與 provider 環境不符時拒絕建立帳戶 | §2.4 |
| 准入：只有平台管理員；撤銷後新 checkout 停止、已成立訂單完成；稽核與冪等 | §2.5 |
| 能力清單的 CI 檢查：adapter 與清單一致、只能前進、證據必填 | §2.6 |
| 每個下限：缺能力拒絕、還原到下限之前仍拒絕、齊全通過 | §3 |
| 排程：上限、跨 tenant 取列後各自綁 tenant、隔離模式不執行、checkout 關閉時仍釋放到期預留 | §5 |
| 寄信：寄送關閉時不寄且頁面說明；同一事實只有一封；遮罩後 `suppressed`；信件列不含 Email；fixture 走完 B10 | §6 |
| 日誌：寫入失敗時不連線；設定變更補寫；內容不含個資與金鑰（canary，EC-SPEC-09 §5.3） | §8.2 |
| 隔離模式：寫入與排程停止、通知照常存入、解除後依序套用 | §8.3 |
| 還原演練 | EC-AT61、AT63（§8.6） |

## 12. 仍待決

| 項目 | 建議 | 只影響 |
| --- | --- | --- |
| 正式環境只接受 live 帳戶 | 是；商家以真實小額交易試做 | 商家在正式環境自行試做的方式 |
| C2 由 Ted 逐店准入 | 是 | 開店的速度 |
| 擴大使用（不需逐店准入） | C2 試用結案後另行決定，屆時加一個主機設定 | 計畫 §18.2 的第三步 |
| 外部效果日誌放在 R2 並設 bucket lock | 是；保存 60 天 | 還原時能找回的範圍 |
| C2 只寄買家的交易信件 | 是；賣家與供應商用站內待辦 | 賣家收到新訂單的方式 |
| 排程上限（200 列、50 次呼叫、5 分鐘） | 以 staging 觀察校準 | 尖峰時的處理延遲 |
| 第一次正式收款前要有成功的 production 還原 | 是 | C2 正式收款的開始時間 |
| Access 排除 | Ted 依 §4.4 設定 | staging 的 sandbox 驗證 |
