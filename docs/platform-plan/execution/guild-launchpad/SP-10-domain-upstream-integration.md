# SP-10｜領域與原作接入

## 1. 文件身分、來源與範圍

- **ID／版本／狀態：** SP-10／0.1.0／draft specification；全部新增 schema、API、狀態及驗收均為待實作，這份文件不啟用正式功能
- **規劃基準：**《自由工坊｜公會啟動台與可攜式業務空間》v1.0，2026-10-05，第 16–20、24 章及附錄 A–D；取得的是完整 1,251 行附件文字，未取得原始 ZIP／requirements JSON
- **中央來源：** `FreeTWAI-AI/freedom-platform@567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`；**ERP 原作：** `mars-tw/freedom-erp-crm@077a003634e5c11592b78acd969c6fe0814858a2`；這些是靜態來源 pin，不是部署版本
- **D：** D-04、D-08–D-11、D-13–D-18、D-20–D-22
- **R：** R-004、R-005、R-008、R-009、R-026–R-030、R-034、R-035、R-041、R-053、R-057、R-059、R-061；跨包完整歸屬以 [traceability.json](traceability.json) 為準
- **T：** T-005、T-008、T-009、T-020、T-026、T-028–T-035、T-041、T-051、T-054–T-056
- **責任：** 唯一 commerce owner 映射、第一條 `inventory.reserve/release/status` 聯動、所有公會可用的非商務人工 Work／note／Asset Result、ERP 原作採用邊界；共同 DTO／授權／資料責任由 [contracts.md](contracts.md)、[data-responsibility.md](data-responsibility.md)、[repository-map.md](repository-map.md)、[decision-log.md](decision-log.md) 統一

`KEEP` 是保留已查閱來源；`MODIFY` 是未來修改；`NEW` 是建議新增；`GENERATED` 只能由 canonical generator 產生。現有 `packages/resource-scopes/index.ts` 只接受 `personal|community`，私人 Work 仍綁 `personal_execution`。本文 tenant／service 範圍是 SP-02 的 additive extension，不能把 caller 傳入 tenant ID 當成已具備隔離。

## 2. 使用者流程、相依與非目標

### 2.1 四個閉環

1. **任何有效公會的人工起步：**正式成員選有權 tenant → 啟用／重用通用工作模組 → 新建 Work → 保存人寫筆記 Result 或上傳受支持附件 → 登出再登入 → 找回同一 Work／Result／bytes。全程不需要模型連線、AI grant 或 key；切主力不影響資料。公會本身只提供入口，不能讀取私人內容
2. **既有商務接軌：**列出原有商店與來源 → tenant 映射已確定者繼續使用 → 訂單仍由 agent-commerce 建立、分銷仍引用其真實 acceptance → 選擇已存在相容 inventory instance，避免另一公會入口再次複製商品／庫存
3. **第一條庫存 port：**hosted 商店保存受控 order-intent → authoritative inventory 原子預留 → 成功時將 reservation ref 接回既有 commerce order／lines → 取消／超時按同一 ref 釋放 → 查詢 status 核對。reserve 不等於支付、出貨或成交
4. **真實單模組外移：**依 SP-08 只將該 inventory instance 搬到獨立 endpoint／DB → hosted 商店、CRM 和 Work 留在中央 → 同一 SDK 呼叫 reserve／release／status → tenant B 完全不切換。此驗收不能以整 ERP 搬家或同 DB 換 process 代替

### 2.2 相依與可並行範圍

| 必要能力 | owner | 哪一部分可先做 |
|---|---|---|
| tenant membership／scope、service principal、跨方資料授權 | SP-02 | schema、負例與非正式 fixture；正式 tenant 寫入等共享授權 seam 完成 |
| 全公會 shell、應用／instance 選擇 | SP-03／04 | 全 catalog 公版入口及 source badge 不等 ERP 功能移植 |
| operation、port、receipt、outbox、projection | SP-05 | 同一契約的 hosted／external conformance fixture |
| Asset policy、R2、隔離／恢復 | SP-06 | 文字與附件 UI fixture；不在 policy 未定時承諾正式保存 |
| export／fencing／binding／endpoint 安全 | SP-07／08／09 | hosted adapter 與可獨立起動的合成外部 inventory |
| 模型與 usage | SP-11 | AI 入口可顯示不可用理由；人工流程不等 AI |

非目標：複製 ERP 的全部程式、正式會計／薪資／法遵、代收款、建立第三套訂單 DB、將 SIM 假資料匯成正式交易、任意執行上游 install script、替 Mini 猜一套未定位的 dashboard。第一條外部 inventory 契約只做 reserve／release／status；**沒有 consume／fulfill 能力時，綁到該 profile 的商店不能接受付款或出貨**。後續 consume 必須有獨立契約與故障驗收，不能在 payment callback 偷改庫存。既有未轉移店鋪的已授權商務行為按相容路徑保留，不由此文件全域停用。

## 3. 精確程式對照及原作採用

### 3.1 中央檔案改動圖

| 分類 | 精確路徑 | 待實作責任／保留理由 |
|---|---|---|
| KEEP | `modules/catalog-commerce/service.ts`、`apps/platform-api/src/routes/commerce.ts` | internal preview 明示 `checkout_enabled:false`、`money_movement_enabled:false`；舊資料和 UI 不升格成正式商務 |
| MODIFY | `modules/agent-commerce/imports.ts`、`modules/agent-commerce/schema.ts` | 保留 shop/item/selection importer；加明確 tenant ownership mapping、instance 與 inventory mapping，不以 AI 生成 manifest 取得 owner 權限 |
| MODIFY | `modules/agent-commerce/orders.ts` | 抽出目前直接寫 `commerce_items.stock/reserved` 的操作，改呼叫 inventory port；保留 order/external_id 去重、payment provenance、shipment responsibility |
| MODIFY | `modules/agent-commerce/distribution.ts` | 保留 accepted price digest、supplier/seller roles、payable／reversal；加 cross-party references 的 tenant-aware ACL |
| MODIFY | `apps/platform-api/src/routes/agent-commerce.ts` | additive tenant facade；舊 shop key 不擴成任意 inventory／tenant 寫權 |
| KEEP／MODIFY | `modules/opportunity-project-work/work.ts`、`private-work.ts`、`private-commands.ts` | 保留 community／personal branches；透過明示新 discriminator 加 tenant Work，不能放寬原 personal filter |
| MODIFY | `modules/autopilot-work/results.ts`、`modules/autopilot-work/policy.ts`、`modules/assets/engine.ts` | 共用 human Result publication、Asset intent／fence／lease／digest；新增明確 tenant profile |
| KEEP | `packages/db/index.ts`、`packages/scoped-commands/index.ts`、`packages/asset-storage/README.md` | 交易、receipt、journal/outbox、儲存契約沿用；tenant adapter extension 由共同包 owner 管理 |
| MODIFY | `apps/portal-web/src/modules/CommercePanels.tsx`、`LegacyCommercePanels.tsx`、`GuildWorkspace.tsx` | 顯示正式／preview／SIM、庫存位置、工作成果及 continuation；不複製獨立後台 |
| NEW | `modules/inventory/schema.ts`、`modules/inventory/service.ts`、`modules/inventory/port.ts` | canonical 庫存／預留 domain；相同 port 給 hosted 和 external adapter |
| NEW | `modules/agent-commerce/inventory-adapter.ts`、`modules/agent-commerce/order-reservations.ts` | store orchestration 持久化 operation，無跨 DB transaction 假象 |
| NEW | `modules/crm/schema.ts`、`modules/crm/service.ts` | 最小客戶資料 owner；不建立 CRM sales-order truth |
| NEW | `modules/opportunity-project-work/tenant-work.ts`、`apps/platform-api/src/routes/tenant-work.ts` | tenant Work application adapter、shared command 和 member/service 入口 |
| NEW | `apps/platform-api/src/routes/tenant-inventory.ts`、`apps/platform-api/src/routes/tenant-crm.ts` | 本文 proposed routes，預設關閉到能力驗收通過 |
| NEW | `contracts/modules/v1/inventory.ts`、`contracts/modules/v1/crm.ts`、`contracts/modules/v1/tenant-work.ts` | SP-05 整合 owner 管理的 authoring inputs；不另造一個 protocol repo |
| GENERATED | `contracts/modules/v1/inventory-reserve.schema.json`、`contracts/modules/v1/inventory-release.schema.json`、`contracts/modules/v1/inventory-status.schema.json`、`contracts/modules/v1/crm-customer.schema.json`、`contracts/modules/v1/tenant-work.schema.json` | 相對於前述 contracts 目錄的具名輸出；實作 generator 後才生成 |
| NEW | migration logical IDs `tenant-commerce-inventory`、`tenant-work-results` | NEW additive migrations；尚無實際檔名，整合 owner 先重新讀 main、stacked PR 與 migration runner policy 才配發 `migrations/` 路徑，本文不預占號碼或執行 SQL |
| NEW | `tests/runtime/guild-domain-inventory.test.ts`、`tests/runtime/tenant-work-results.test.ts`、`tests/e2e/guild-launchpad-domain.spec.ts` | 第 10 節 planned evidence；既有 `tests/runtime/agent-commerce.test.ts`、`commerce.test.ts` 同時回歸 |
| MODIFY／GENERATED | `scripts/build-contract-bundle.mjs`／`packages/sdk/client.mjs`、`packages/sdk/client.d.mts` | generator 綁共同來源；確認既有 build 輸入後增量接入，不手改 SDK 產物 |

路徑組合是未來 PR 的精確責任地圖，不是本 PR 修改清單；本 PR 只新增規格文件。共同 schema／migration 檔由唯一整合 owner 協調，不能多個 agent 各自覆蓋。

### 3.2 ERP adopt／adapt／reject 清單

所有下列 upstream 路徑都固定於 [ERP commit 077a003](https://github.com/mars-tw/freedom-erp-crm/tree/077a003634e5c11592b78acd969c6fe0814858a2)。原作 `LICENSE` 及 `NOTICE` 為 **MIT，Copyright (c) 2026 mars-tw**。若日後复制／改作實質程式，發布包必須包含對應授權、署名、來源 SHA、修改檔清單與相依授權；本輪只作研究及規格，未複製原作程式。中央 `freedom.project.yaml` 的 `NOASSERTION/source_available` 不因上游 MIT 而被重新授權。

| 決定 | 原作精確路徑 | 可取內容 | 接入前必須改的部分 |
|---|---|---|---|
| ADOPT 概念／ADAPT 配置 | `src/templates.ts`、`templates/catalog.json` | 八種產業 profile、模組依賴；例如 sales→inventory+wallets、services→crm+wallets | application/module registry 正規化；wallet 只可 SIM，不因依賴宣告啟用平台金流 |
| ADAPT | `src/engine.ts` | customer/contact/deal/case/task/milestone 流程；quote digest、issued/superseded/confirmed 與 expiry | customer 到 CRM；task/milestone 到既有 Work；quote 先提案／版本快照，不建立第三套正式 order |
| ADAPT | `src/domain.ts` | 價格快照、reservation、FIFO 與交付修訂 digest 的 domain 教學 | stock ownership 及併發 port 重寫；SIM payment／journal 不能作銀行實收、應付已付或真實庫存證據 |
| ADAPT | `src/workbench-model.ts` | readiness、搜尋、返回工作 | 每次查詢同 tenant scope、資料允許清單、來源與 freshness；不得帶入其他 visitor 資料 |
| ADAPT 思路，REJECT 直接匯入 | `src/workspace-backup.ts`、`src/workspace-storage.ts` | digest／backup validation、staging/resume 思想 | 全 workspace JSON 非模組包；15 分鐘暫存不是正式 retention；加入附件 bytes、cutoff、fencing、schema lineage |
| REJECT 正式身份 | `src/worker.ts`、`src/workspace-storage.ts` | demo 可保留 cookie/visitor DO 的原用途 | cookie hash／per-visitor DO 不具 tenant membership／role；72 小時閒置清理不得套到會員正式資料 |
| REJECT 未 pin 發布 | `web/launch-kit.ts`、`bin/launch-config.mjs` | 可作人工研究入口 | 發布前固定 application release／commit／artifact digest、license／NOTICE、支援 runtime；不任意執行未 pin 套件 |
| KEEP 外連獨立貢獻 | [平台 PR #105](https://github.com/FreeTWAI-AI/freedom-platform/pull/105) | 外部 ERP 試用入口 | 不修改其分支／檔案／狀態，不將本計畫塞入原 PR；連結存在不代表 tenant 或 hosted 已可用 |

原作涉及 SIM 的設定／模板可由明確欄位 allowlist 重新建立；假 customer、sales、wallet、payment、stock／活動歷史不得批次晉升成正式資料。採用源碼與核實業務事實是兩件事。

### 3.3 Mini 與其他已登錄工具

`docs/development/member-skill-registration.md` 已定位 Mini 為 [Local Workspace MCP](https://github.com/arumwu/local-workspace-mcp/tree/71dfd5d6c4884c218b0c2365eb68fb8dde5d7cc1)，該文件記載 MIT，且沒有安裝／執行所有原作。這不是另一套未提供的 Mini dashboard 的來源證明。若所指另有原作，登錄 `source_unresolved`、缺 repo／作者／commit／license／runtime 列表；先完成本包共同流程，不猜實作、不標 hosted-ready。Editkin 的 GPL 與未知授權作品必須分開做發布義務判定，不從 ERP MIT 推論可商用托管。source review 是能力 gate，不得默認將「未知」改為通過。

## 4. 資料模型、唯一性與 owner／authority

### 4.1 現有實體 → 唯一領域 owner

| 實體 | 現有表／來源 API | 本規格定案的 owner／過渡 |
|---|---|---|
| preview Store | `retail_stores`／catalog-commerce `createStore/listStores` | 保留 internal-preview 歷史；只可明確轉換可用設定，不自動和正式店鋪合併 |
| operational Store | `commerce_shops`／agent-commerce `importShop/ownShops`；`/commerce/shops` | agent-commerce 唯一 store owner；保留 `shop_id`、kind、mode；NEW tenant/resource mapping，不另建 ERP store |
| preview Product／Offer | `catalog_products`、`supplier_offer_versions`／`createProduct/createOfferVersion` | 既有 owner 保留 preview；快照需 explicit confirmation 才能轉成新的 commercial item，保留 source lineage，不把原 preview ID 假稱 operational ID |
| operational Product／Offer | `commerce_items`，其 `price_minor/shipping_minor/shipping_terms/return_terms`；importer | agent-commerce owner 商品及現行供貨內容；Offer 首版是具 digest 的 item/selection 商務快照，**沒有新正式 offers DB** |
| preview Listing／Acceptance | `retail_listing_revisions`、`distribution_acceptances`／`requestSupply/decideSupply` | 永遠 internal-preview；不當作允許真實 order 的 acceptance |
| operational Listing／Acceptance | `commerce_selections`、`commerce_distribution_acceptances`／`decideAcceptance` | agent-commerce；`current_acceptance_id`＋`listing_sha256` 對應被接受的售價與供貨快照，保留 signer/provenance |
| Order／lines／supplier transfer | `commerce_orders`、`commerce_order_lines`、`commerce_transfers`／`createOrder/orderView` | agent-commerce 唯一 order owner；原 `(public_shop_id,external_id)` 與 request digest 去重保留，不在 ERP sales/CRM 重建另一訂單 |
| Payment／Payable／settlement | `commerce_payment_events`、`commerce_supplier_payables`、`commerce_obligation_reversals`、`commerce_settlement_records` | 保持原 agent-commerce responsibility；merchant report、obligation、record-only settlement 與銀行實收分開 |
| Inventory／Reservation | 現有 `commerce_items.stock/reserved`，`orders.ts` 本地 SQL reserve/release | NEW inventory owner；切換前仍由原程式唯一寫，切換後 `inventory_balances/inventory_reservations` 唯一寫；原欄位只可相容只讀 projection，不能雙寫 |
| Customer／Contact／private notes | 目前無 CRM customer table；order 有 `delivery_ref`／必要交易快照 | NEW CRM owner `crm_customers/crm_contacts`；opaque customer ref 與用途限定 projection 供 commerce 使用；不是用 owner/member 表充 CRM |
| Work／note／Result | `work_items`、`private_work_results`／`private_model_work_results`、共用 Asset 引擎 | Work 維持 opportunity-project-work；note 是 human Result 的內容，附件為 Asset；tenant profile 是新 discriminator，不能覆寫原個人 owner |

上表「operational」指程式有實際訂單／接受紀錄責任，不宣稱此次已驗正式交易或任何銀行／支付 provider。查閱的 `orderView` 明示 `payment_evidence:merchant_backend_report`、`platform_bank_verified:false`、`platform_collects_money:false`、`settlement_mode:record_only`。

### 4.2 新資料與約束

所有 NEW 表由 SP-06 隔離。`OpaqueId` 為 UUID；所有 `version/authority_epoch` 為 1..9223372036854775807 正十進位字串；SQL 使用 bigint，JSON 不經 Number。`ModuleInstance` 共用 shape：`{instance_id,tenant_id,module_key,application_release_ref,data_schema_version,contract_ref,status,binding_id,authority_epoch,version}`。

| 新增／擴充資料 | 主要欄位與硬約束 | owner／敏感度 |
|---|---|---|
| `commerce_resource_tenants` | `(resource_kind,resource_id)` 唯一；`tenant_id,instance_id,source_owner_id,mapping_state,version`；未解歧義不准 export/切 authority；非共享 resource 僅一 tenant | commerce；來源 owner ID 限管理用途，禁止依目前登入者猜值 |
| `inventory_item_links` | `(tenant_id,inventory_instance_id,item_id)` 唯一，FK 至 inventory SKU 與受授權商務 source；SKU 字串 1–80、同 instance 唯一 | inventory；綁定存貨實體，不複製完整商品文件 |
| `inventory_balances` | `(tenant_id,instance_id,sku_id)` PK；`on_hand,reserved` 非負整數且 `reserved<=on_hand`；`version` CAS；第一版整件單位，不接受浮點量 | inventory authoritative binding；餘量私有，公開只能明選 availability |
| `inventory_reservations` | UUID、tenant/instance、`operation_id,order_ref,request_sha256,state,expires_at,authority_epoch,version`；unique `(instance_id,operation_id)`；子列 `(reservation_id,sku_id)` 唯一、quantity 1–1,000,000 | inventory；狀態 active/released/expired；order_ref 僅不可逆假名引用，不帶 CRM／付款資料 |
| `commerce_order_reservations` | `order_reservation_id:OpaqueId` 主鍵，`(order_id,inventory_instance_id)` 唯一；`operation_id,reservation_id?,state,expires_at?,version`，只由 order orchestration 更新 | commerce 的 saga journal／引用，**不是另一份 order** |
| `crm_customers/crm_contacts` | UUID，tenant/instance composite FK、`version`；display label 1–120，聯絡欄位分開；email/phone 非 global unique，避免跨租戶辨識 | CRM 私有敏感內容；owner/export 依 tenant permission；guild officer 無權 |
| tenant Work additive branch | 原 `work_items` 加 `work_mode=tenant_execution`、tenant/instance/workspace refs；`state=draft\|archived`，`progress=todo\|in_progress\|done`；已有個人／社群 branch 不變 | Work 的 tenant owner；progress 不等於 Claim、Review、Contribution 或 Benefit |
| tenant Result/Asset relation | 在共用 Result／Asset family 加 tenant profile、same-tenant composite FK；human provenance server 寫入；immutable revision＋sha256＋byte_size | Work 擁有結果引用，Asset engine 擁有 bytes lifecycle；不開個別公會 blob store |

同一 order 可跨供應方，但第一個外移 fixture 限 store/inventory 同 tenant；跨方 reserve 要由供應方精確授予限定訂單／instance 的 service scope，seller tenant owner 不能自動獲 supplier 私有權。既有跨方交易快照仍按雙方用途獨立保留，刪 CRM 不 cascade 刪合法訂單；不得利用此例外保留整份 CRM。

## 5. Proposed API、command、query、event

### 5.1 共同 wire 與認證

以下路由均 **proposed**，base 為 `/api/v1/tenants/{tenant_id}`。本文欄位採 snake_case；既有 camelCase 內部方法由 typed adapter 逐欄映射，不能透過 object spread 忽略新增權限。嚴格拒絕 unknown fields、duplicate query keys；時間為 UTC RFC3339 毫秒。變更採 `Idempotency-Key`（8–128 ASCII `[A-Za-z0-9_-]`）；CAS 採 `If-Match: "{version}"`，缺少為 428、落後為 412。member session 必須 current／CSRF／tenant role；service 必須 SP-09 已驗 principal＋audience＋instance＋scope＋epoch，不能用 `fw_read_`、舊 `fw_shop_` 或人類 session 假冒。

Command 成功／受理回 `operation={operation_id,state,version,resource_ref?,retry_after_seconds?,problem?}`；`state` 只用 `requested|running|succeeded|failed|needs_reconciliation|cancelled`。同步完成 HTTP 200/201、非同步 202。resource_ref 採共同契約，GET resource 取完整 DTO；operation 與業務 resource version 不互換。receipt replay 先重驗**現在**授權，原 key+scope+target+digest 同一效果；異內容同 key 409 `idempotency_conflict`。operation status／command outcome 的共同 route 由 SP-05 提供。

### 5.2 Inventory port（hosted／external 完全同語意）

| HTTP／capability | 完整輸入 | 成功 resource／輸出 | 限制／錯誤 |
|---|---|---|---|
| `POST /inventory/instances/{instance_id}/reservations`；`inventory.reserve` | `{operation_id:OpaqueId,order_ref:ResourceRef,authority_epoch:Epoch,expires_at,lines:[{sku_id,quantity,expected_version}]}`；1–50 個 distinct sku，quantity 1..1,000,000，expiry 在服務端現在後 60–900 秒 | Operation→Reservation；同一交易鎖定排序 SKU，所有行都成功才增 reserved／插入 reservation／receipt/outbox | `inventory:reserve`；409 insufficient_stock/order_binding_invalid，412 balance_version_conflict，409 authority_changed，422 expiry_invalid；不知道遠端結果用 202 needs_reconciliation，不回 out_of_stock |
| `GET /inventory/instances/{instance_id}/reservations/{reservation_id}`；`inventory.status` | path IDs，無 body/query | `{reservation_id,tenant_id,instance_id,operation_id,order_ref,state,lines:[{sku_id,quantity}],expires_at,authority_epoch,version,observed_at}` | `inventory:status`＋同 order grant；404 隱藏其他 tenant；status 必須 authority 讀取，不能讀 projection 冒充最新 |
| `GET /inventory/instances/{instance_id}/reservations/by-operation/{operation_id}`；`inventory.status` | path IDs；必須同命令 target／scope | 上述 Reservation；已拒絕的 command 回原 terminal problem 的 outcome；確知不存在回 404 `command_not_recorded` | 此 404 只有 authoritative endpoint 可產生；timeout／不可達不是「不存在」，不可據此新 reserve |
| `POST /inventory/instances/{instance_id}/reservations/{reservation_id}/release`；`inventory.release` | `{operation_id:OpaqueId,authority_epoch:Epoch,reason:cancelled\|expired\|downstream_failed}`＋If-Match | Operation→同 Reservation；active→released（expiry worker 可 expired），每行只扣一次 reserved | `inventory:release`；終態 fresh-version release 是成功 no-op；stale version 412；庫存調整不能以傳負數達成 |
| `GET /inventory/instances/{instance_id}/availability` | `sku_ids` 為單一 query value，以逗號分隔 1–50 distinct UUID；禁止空項／重複值，cursor 不可混用 | `{instance_id,authority_epoch,observed_at,items:[{sku_id,available,version}],projection:false}` | `inventory:read`；availability 不保證稍後 reserve；409 capability_unavailable/503 binding_unavailable |

`operation_id` 是 SP-05 定義的穩定 domain effect identity，header key 是 transport retry identity；第一次受理分配並保存，跨 transport／binding 重試原樣攜帶；同 command ID 異 payload 409，即使換 header key 也不能再次扣量。永續 command→outcome tombstone 至少跨 migration／event replay 窗口；具體期限由 SP-06 retention policy 決定，未核定不得把重試安全性建立在短 TTL cache 上。

### 5.3 Hosted order adapter

`POST /commerce/shops/{shop_id}/order-intents` input `{external_id,items:[{selection_id,quantity,delivery_ref}],inventory_instance_id}`，1–50 行；沿既有 `orderInput` 的 quantity 1..99／delivery_ref 格式。認證是該 shop 的 tenant member 或明確 service grant，非公共買家任意 caller。回 Operation，成功指向**同一** `commerce_orders.order_id`；`GET /commerce/shops/{shop_id}/orders/{order_id}` 回 existing owner-filtered order DTO 加 `{inventory_state,reservation_refs}`，不增加對方總利潤或 CRM 私資料。

流程：先在中央 transaction 確定 selection／live-test mode／acceptance digest／角色、鎖受理 identity，在既有 `commerce_orders` 保存不可結帳的 draft/inventory-pending 記錄與 stable order_id，再寫持久化 saga 與 outbox；order_ref 必須指這筆真實記錄，不能引用尚不存在的 order 或另建 ERP 訂單；commit 後呼叫 reserve；每次再次核對 acceptance、order expiry、capability 與當前 epoch；reserve 成功才提交 order 的 reserved 狀態。crash 可從 operation_id 重取結果。後段失敗啟動 release operation；不刪除已成功遠端 reservation 冒充 rollback。現有 `(public_shop_id,external_id)` 及新受理記錄共享唯一索引責任，不允許 legacy route 競態再建一次 order。proof profile 回 `checkout_ready:false` 及 `inventory_consume_unavailable`，不能將 reserve 當完成付款授權。

`POST /commerce/shops/{shop_id}/orders/{order_id}/cancel` input `{reason:member_cancelled}`＋If-Match；已無外部／付款不可逆效果才開始 cancel/release；回 Operation。pay/refund/shipment 的既有參數與 provenance 不由本包擴權；未支援外部 consume 時返回 409 `inventory_capability_incomplete`。

### 5.3.1 Hosted 自有商品 direct-sale 預留增量（HO-0）

2026-10-08 的 bounded 下一階段採 direct sale：一般會員買家可在 seller tenant 之外，使用既有 `commerce_orders`／`commerce_items` 的唯一訂單與庫存權威，不建立第三套 core。具體 [HO-0 契約與 locking／expiry 設計](../../../../modules/agent-commerce/hosted/direct-order-contract.md) 及 [canonical DTO](../../../../contracts/guild-launchpad/v1/hosted-order.ts) 區分五分鐘報價（不占庫存）、三十分鐘 `reserved` 訂單、取消／到期。付款、退款、履約與 money movement 永遠關閉於此 profile；沒有 contact／PII dataset，不偽造 supplier acceptance／transfer／payable。

HO-0 只提供可 review 的 shape、規則、generated structural schema 與契約測試，沒有 route、DB migration、module application release 或功能啟用。既有 imported reseller 流程與本節上方 proposed external-inventory adapter 各自保留；direct slice 仍以現有 stock/reserved 單一 writer 接軌，未宣稱 inventory port 已實作。Applied 134 不改，136／137 尚未真正整合前不建立假 138 ledger row。HO-1..3 等本契約 root review 後才實作。

### 5.4 最小 CRM 與人工 Work／Result

| Proposed route | 完整輸入／回傳 | 認證／限制 |
|---|---|---|
| `POST /crm/instances/{instance_id}/customers` | `{display_label,contact?:{email?,phone?},note?}`；label 1–120，email ≤254，phone ≤40，note ≤16 KiB；Operation→`{customer_id,tenant_id,instance_id,display_label,contact,note,version}` | `crm:write`，無 payer／bank／identity credential 欄位，body 不接受 owner |
| `GET /crm/instances/{instance_id}/customers/{customer_id}` | 無 body/query；上述 DTO | `crm:read`；archived 回 404；search/list 另行明定後才開放；不得因 commerce customer_ref 取得全文 |
| `PATCH /crm/instances/{instance_id}/customers/{customer_id}` | 完整 replace `{display_label,contact:null\|{email?,phone?},note:null\|string}`＋If-Match；Operation | `crm:write`；顯式 null 才清欄位，省略不假刪除 |
| `POST /crm/instances/{instance_id}/customers/{customer_id}/archive` | `{}`＋If-Match；Operation→`{customer_id,state:archived,version}` | `crm:write`；停止一般查詢／投影，保留型封存不是 erasure；實際刪除走 SP-06 retention policy，不 cascade 刪訂單 |
| `POST /workspaces/{workspace_id}/works` | `{title,objective,progress:todo\|in_progress\|done}`；title 1–120 chars/480 bytes，objective 1..16 KiB；Operation→Work DTO | `work:create`；same-tenant workspace／instance 由 server 解；不讀 AI settings |
| `GET /workspaces/{workspace_id}/works` | `q?` ≤120 chars，`limit` 1–50 default20，`cursor?` 為 signed bounded opaque cursor | `{items:[{work_id,tenant_id,workspace_id,instance_id,title,objective,progress,state,version,current_result_id?,updated_at}],next_cursor:string\|null,source_version:Version}`；scope-filtered count 不另洩漏 |
| `GET /works/{work_id}` | 無 body/query；上列 Work DTO | `work:read`；list 僅 draft，archived detail 回 404；archive receipt／authorized export 可保留 metadata，不借社群列表看到私人 Work |
| `PATCH /works/{work_id}` | `{title,objective,progress}`＋If-Match；Operation→Work | `work:write`；保留原文，禁 NUL／孤立 surrogate／非法控制字；兩個 edit 只有一個 CAS 成功 |
| `POST /works/{work_id}/archive` | `{}`＋If-Match；Operation→Work | `work:archive`；retained terminal state；policy/provider 故障仍可依現有 archive principle 操作，但不繞過身份撤銷 |
| `POST /works/{work_id}/results/uploads` | `{content_type,byte_size,sha256,display_name,expected_work_version}`；text/plain 或 text/markdown；1..262144 bytes；filename ≤120 chars 不作物件路徑 | `work:result.write`；Operation→`{upload_id,asset_id,expires_at,version}`；content profile 與 quota 服務端決定 |
| `GET /works/{work_id}/results/uploads/{upload_id}` | 無 body/query；回 `{upload_id,work_id,asset_id,phase,expires_at,version,byte_size,sha256}`，phase 沿共用 Asset 引擎 | `work:result.write`；current policy／ACL；恢復時返回可合法接續的 phase，不授予新 fence |
| `PUT /works/{work_id}/results/uploads/{upload_id}/content` | exact bytes stream，Content-Length／SHA-256 與已準備 manifest 相符；If-Match；不收 URL | 回 `{upload_id,verified:true,version}`，沿 Asset engine claim/write；no-store、same tenant、當前 policy/lease/fence，超量 413、digest mismatch 422 |
| `POST /works/{work_id}/results/uploads/{upload_id}/finalize` | `{expected_work_version}`＋If-Match | Operation→`{result_id,work_id,asset_id,revision,work_version,provenance:human,content_type,byte_size,sha256}`；atomic Result CAS＋receipt |
| `GET /works/{work_id}/results`、`GET /works/{work_id}/results/{result_id}` | list `limit`1–50 default20、cursor?；detail 無 query | list `{items:[Result metadata],next_cursor:string\|null,source_version:Version}`；detail metadata 加 authorized content route，永不回 raw object key／public signed URL |
| `GET /works/{work_id}/results/{result_id}/content` | 無 query/body；完整授權後取得 bytes | before／after I/O current ACL、版本、policy 檢查；no-store，禁未授權 HEAD/Range/304；歷史內容採同一規則 |

第一個可用 attachment 就是實際上傳的 `.txt/.md` Asset bytes，不是外連卡片；image/PDF/video 等額外 profile 須由 SP-06 補 MIME／掃描／quota／renderer／import 驗收後才啟用，不宣称已涵蓋所有格式。upload 中断後 GET 同 upload metadata 查 phase，續傳沿現有 Asset fence 協定；不得以新 upload 略過未結 reservation quota。

共同錯誤沿 contracts.md：400 invalid_input，401 authentication_required/session_expired，403 capability_denied/policy_unconfigured，404 not_found，409 invalid_state/authority_changed/idempotency_conflict，412 version_conflict，413 payload_too_large，422 validation_failed/contract_incompatible，428 version_required，429 quota_exceeded（含 retry_after_seconds），503 dependency_unavailable。表內 domain 特定 code 只細分同一 HTTP 語意。錯誤只含安全 ID／code，不回 CRM／prompt／SQL／keys。租戶切換不可把前一 tenant error body 顯示到新 tenant。

### 5.5 Domain events：完整 strict payload 定義

本節是下列五個 **module-domain fact** 的唯一 payload authoring 規格；全部使用 SP-05 §5.3 的 `EventEnvelope`，內容欄位叫 `payload`，不是舊 scaffold 的 `data`。`event_type` 必須是下表精確名稱，`event_schema_version` 固定字串 `"1"`；新欄位或語意變更必須另發布 payload schema revision 及相容測試，不能把任意欄位塞進 v1。

五種 payload 共同且**完整**的 object shape 為 `{resource_id:OpaqueId,version:Version,state:EventState,related_resource_refs:ResourceRef[]}`。四個欄位全部必填，`additionalProperties:false`；不接受 null、未知欄位或任意巢狀資料。`OpaqueId`、`Version`、`ResourceRef` 精確沿 [contracts.md](contracts.md)：每個 ref 都是 strict `{tenant_id:OpaqueId,instance_id:OpaqueId,resource_type:StableKey,resource_id:OpaqueId}`。`EventState` 不是開放字串，由下表逐 event 限定；array 為下表明定的**有序 tuple**，不能增列、重排或用缺欄位 ref 代替。

這是刻意最小化的通知型 schema：**不含 quantity、available stock、expires_at、reason、provenance、customer/contact、note、Asset bytes、storage key 或 URI**。consumer 需要數量／期限／結果內容時，以現行權限呼叫 inventory.status／Work Result query 取得，不把事件當完整 Reservation DTO、預留許可或資料分享授權。

| 精確 `event_type`；schema revision | producer／envelope aggregate | 完整 payload 限制 | 發布時點 |
|---|---|---|---|
| `inventory.reserved.v1`；`"1"` | 當前 inventory instance；`aggregate_type="inventory.reservation"`，`aggregate_id=reservation_id` | `resource_id=reservation_id`；`version=reservation.version`；`state="active"`；`related_resource_refs=[order_ref]`，恰 1 項，`order_ref.resource_type="commerce.order"` | reserve 成功提交 active reservation；transaction 同時保存 receipt/outbox，不能在 reserve 請求剛受理時發 |
| `inventory.released.v1`；`"1"` | 同 inventory aggregate | `resource_id=reservation_id`；`version=reservation.version`；`state="released"`；`related_resource_refs=[order_ref]`，恰 1 項，type 同上 | active→released 真正提交；fresh-version 終態 release no-op／receipt replay 不再發新事件 |
| `inventory.expired.v1`；`"1"` | 同 inventory aggregate | `resource_id=reservation_id`；`version=reservation.version`；`state="expired"`；`related_resource_refs=[order_ref]`，恰 1 項，type 同上 | authoritative expiry worker 確認到期並原子釋放成功；不能由 consumer 看到本地時鐘超過預估期限就自行發 |
| `commerce.order_inventory_changed.v1`；`"1"` | 當前 commerce instance；`aggregate_type="commerce.order_reservation"`，`aggregate_id=order_reservation_id` | `resource_id=order_reservation_id`；`version=commerce_order_reservations.version`；`state` 恰為 `requested\|reserving\|reserved\|releasing\|released\|failed_known\|needs_reconciliation`；`related_resource_refs` 詳見下段的條件 tuple | 該筆既有 order 的 inventory saga 實際狀態變更提交；此 aggregate 是 §4.2 的引用／協調記錄，不是第二份訂單 |
| `work.result_attached.v1`；`"1"` | 擁有 tenant Work 的當前 Work instance；`aggregate_type="work.work"`，`aggregate_id=work_id` | `resource_id=work_id`；`version=Work CAS 提交後的版本`；`state="draft"`；`related_resource_refs=[result_ref,asset_ref]`，恰 2 項，依序 type 為 `work.result`、`work.asset` | Result/Asset 經共用 engine 驗證並與 Work CAS、receipt/outbox 原子提交後；prepare、寫 bytes、未 attach 或 replay 均不發 |

`commerce.order_inventory_changed.v1` 的條件 tuple 是完整規則：

- `requested|reserving`：必須 `[order_ref]`，恰 1 項
- `reserved|releasing|released`：必須 `[order_ref,reservation_ref]`，恰 2 項
- `failed_known|needs_reconciliation`：若尚未核實 reservation ID，只能 `[order_ref]`；若已有原 authoritative response/receipt 證據確定 ID，必須 `[order_ref,reservation_ref]`。不能為湊欄位捏造 ID，後續可信核對補上 ref 須提升 saga version 並發布新的事件
- `order_ref.resource_type="commerce.order"`，resource_id 是同一原 `commerce_orders.order_id`，instance_id 是該 commerce instance；`reservation_ref.resource_type="inventory.reservation"`，resource_id 是已核實 reservation ID，instance_id 是該 saga 指定的 inventory instance

每個事件必須滿足 `payload.resource_id=envelope.aggregate_id`、`payload.version=envelope.aggregate_version`，envelope tenant/source instance/authority epoch 由當前已驗 producer backing records 決定，不能由 model/caller 自填。inventory 的 order_ref 逐欄等於該 reservation 保存的 §5.2 order_ref；Work 的 result_ref/asset_ref 都由同一 tenant Work instance 擁有，Result→Work／Asset 的 composite 關聯必須與已提交記錄一致。`work.asset` 表示 Work 模組負責的附件資源，bytes lifecycle 仍由共用 Asset engine 管理，不另設公會 storage authority。上述 aggregate/resource type 值須註冊到 canonical type allowlist，不能只因符合 StableKey regex 就接受。

第一個 proof 的所有 refs 必須與 envelope 同 tenant，允許 order 與 inventory 是不同 instance。未來 cross-tenant ref 只有在 SP-05 的精確 agreement/participants/purpose 與 subscription field policy 已成立時才可發送；不允許為逃避 schema 條件刪掉某個 tuple 項目，缺分享權時拒絕該 subscription。事件傳輸仍需共同 `CapabilityKey` 的 `events.deliver`／`events.replay`，人工 redrive 需 `events.reconcile`；事件本身不增加 `inventory:status`、`work:read` 或其他 domain capability。Result content 另行驗 current Work/Asset ACL。

以上五種事件都在**已存在且具有 domain authority 的 module instance** 內產生。Guild preference/classification、tenant creation/membership、registry/provision、Connection/Grant/usage operating-policy 等控制面事實不在這個 event catalog，沿共同控制面 journal／各自明訂的 versioned payload，不捏造 `source_instance_id` 包成 module event。若 SP-11 的通知被轉成 module-domain notification，仍須另有受控 translator、真實 instance authority 與明確 schema，不能套用這五種名稱。

所有 domain mutation＋receipt＋outbox 同交易；event ID 去重、每 aggregate 的 event_sequence 連續且跨 epoch 延續，aggregate_version 可跳號。consumer 依 SP-05 處理 gap／倒序，snapshot 版本不倒退；cutoff 前合法遲到事實只按 SP-08 exact manifest、replay grant、期限與當前可見性接納。通知不保證 resource 現在仍可讀，authorized query 回 404 時不得以舊 event 復活已刪除／撤權資料。

**新增 planned contract vectors（T-029／T-032／T-033）：**五種事件各一合法 fixture；逐一注入缺欄位、未知 quantity/expiry/reason、錯 schema version、錯 state、錯 tuple 長度／順序／resource_type、payload/envelope ID 或 version 不一致、跨 tenant 未授權 ref，均在 consumer effect 前拒絕。同 event 重送不多扣 stock／不多 attach Result；終態 release no-op 不增事件；Control-plane 事件冒用此 envelope/catalog 必須拒絕。這些 vectors 尚未實作／執行。

## 6. 狀態、失敗、重啟及撤權

| 資源 | 成功路徑 | 失敗／未知與接續 |
|---|---|---|
| reservation | active → released 或 expired，终态不再扣量 | reserve transaction 失敗無半筆；ACK 遺失以同 operation_id 查 authority，不能換 key 再扣；同 key 重播仍 current auth |
| order reservation saga | requested → reserving → reserved → releasing → released；failed_known 與 needs_reconciliation 分支 | 任一遠端結果未知保留 operation，不開 payment；重啟從持久化 command_ref 接續；釋放成功但中央 ACK 遺失再查，不把 reserved 減兩次 |
| Work | draft、progress 可變 → archived | update CAS 失敗保留人稿讓使用者比較；archive 不等於 erase，不可用 rollback 復活 |
| Result upload | existing engine intent → claimed/writing → verified → finalized | bytes 尚未 attach 不可讀；late PUT 不得靠舊 fence attach；成功 finalize ACK 遺失重播回同 Result ID，不追加歷史 |
| source integration | source_unresolved → reviewed → fixture_verified → release_eligible | license/runtime/contract 不符只關該能力；不影響全公會 shell、人工 Work 或其他 instance |

inventory migration fence 後舊 binding 不接新命令；已受理命令的 terminal outcome 必須可追蹤並隨操作資料搬遷。若已撤 service grant，舊 token／receipt 不能繼續執行；權威可用其受控 expiry worker 釋放到期 reservation，不能仰賴已被撤的人再次登入。離會／換主力不改 tenant owner；被移除 tenant membership 的操作者不能再 read／finalize／重播。撤權前已被合法對方取得的交易快照按既定資料責任保存。

未知版本 contract 返回 422 `contract_incompatible`＋supported contract refs；只阻擋相應 port。hosted order 不降級直連遠端 DB，也不改用舊 stock projection。binding 外移到新 endpoint 要新驗證 grant/audience，operation 的業務 identity 不變。

## 7. UI、可見性與人工接手

- 所有 active guild 以 catalog 列舉；沒有專用 profile 也有「新增工作／繼續筆記／上傳成果」。公會卡不是任務的 owner，公共頁不顯示他人 Work 數量、CRM 片段或私人搜索結果
- 入口標清「內部預覽」「SIM 練習」「可用人工工作」「來源待確認」「能力尚未啟用」；開源 repo／作者不自動冠官方、正式 ERP 或合規產品
- 商店顯示 inventory instance、hosted/external location、資料時間、reservation 狀態和 expiry；未知時顯示「正在核對預留結果」，只能查進度／取消請求，不能以再按一次建立新 order
- 空狀態提供直接可保存的 title/objective；note editor 自動保存只能經既有授權明定，第一版 explicit 保存避免意外外送。衝突時保留使用者本地草稿並顯示差異，不靜默覆蓋
- Result 先顯示 upload progress／未保存／驗證失敗，只有 finalize 成功顯示「已保存」。draft Result 不表示正式發布／公會驗收。人工可繼續工作，不被 AI banner 或模型錯誤覆蓋
- `DESIGN.md` tokens；360px 手機不橫溢、keyboard 全流程、label/error 關聯、focus-visible、status aria-live、dialog Esc／焦點返回。A→B tenant 切換取消舊請求、清私有 cache；晚到 A response 不進 B 畫面

## 8. 遷移、匯出、清理、回復及 legacy

1. **Expand：**建立 tenant mapping／inventory owner schema／domain port，不改舊 ID；原商品／商店查詢仍有 mode。以每筆明確 owner 證據映射，多品牌／共同店舖／孤兒隔離到 unresolved 清單，不使用 default tenant
2. **Backfill：**dry-run 按 `commerce_items.stock/reserved` 與未結 `commerce_order_lines`／orders 對帳；每個 active reservation 可重建來源、數量與期限。負數、count mismatch、重複外部 ID 停該 instance；不用清零偽造一致。來源 preview、SIM 不進正式訂單
3. **Switch：**per-instance fence 短暫停止新庫存 effect → 鎖切點 → 寫入 inventory owner → port adapter切換。原 stock/reserved 列不再可寫；取消／expiry／payment 舊路徑都必須走同 port，資料庫 runtime role 負例證明不能直接 UPDATE
4. **Contract：**相容窗內 legacy reads 是帶 lineage／freshness 的 projection；缺 tenant 語意的 legacy writes 明確 409 upgrade_required。刪舊欄前對帳所有 consumers／pending orders，不假成功丟欄位
5. **Export：**inventory-only 包含 balances、SKU links、active/terminal reservation 必要歷史、command dedupe/outcome、outbox cursor、config、schema/release refs；Work 包含 Work metadata、Result 修訂、Asset bytes/digest 與 extension fields。CRM private contacts 只在 CRM export，不能順 order export 全打包
6. **Import：**保留 migration ID；clone 新 identity＋明確 mapping。schema/digest/refs/capacity/same-tenant 驗證在 staging，全數通過後才能切換。operation 狀態與 receipt 可保留作去重資料；來源 token/session/grant/authority/audit assertion 不匯成新信任
7. **Cleanup：**依 SP-06 dataset allowlist 清 cache/index/thumbnail/projection/temporary uploads；中央保留合法 commerce snapshot 和必要 inventory refs，不留外移庫存全量私有 DB。備份保留期、tombstone 與 erasure policy 未核定前不能宣稱刪除完成
8. **Recovery：**備份還原先套 revocation／tombstone／epoch floors；外部已新寫入不能直接重開舊中央 stock。透過反向移交或向前修復處理；用 operation ledger 找出半完成釋放／未結 order

## 9. 威脅、成本、容量與安全反例

| 威脅／成本 | 強制控制與負例 |
|---|---|
| preview／SIM 洗成真實成交 | discriminator、source lineage、禁止直接 import 客戶／訂單／支付；merchant report 不能變銀行實收 |
| 跨 tenant reserve／customer 關聯 | composite refs＋current tenant/service ACL；測同 UUID 字串、錯 instance、錯 grant、跨方 scope 未授予 |
| oversell／release twice | authoritative sorted-row locks、全行 transaction、CAS／command dedupe；100 concurrent reserve 測不得負 stock |
| CRM／private note 假借監控外洩 | minimal events／allowlist projections／no shared search index plaintext；私有資料不自動餵公會 AI |
| 任意 upstream plugin／安裝腳本 | review/pin release；hosted 不執行每 tenant repo；來源與 license gate 独立 |
| SSRF／簽章被當業務真實 | SP-09 endpoint checks；signature 只能驗來源與完整性，不能證明庫存實數／付款真實 |
| 失控 retry／N+1 | batch ≤50 SKUs、受限 concurrent jobs、exponential retry＋jitter；有 unknown 先 status，不重做 effect |
| storage／模型成本混算 | human Asset quota 與 AI usage 分開；未支持 MIME 拒絕；沒有 AI 仍能使用 quota 內人工 Work |

**建議非正式測試 profile，非正式收費／SLO 承諾：**每 tenant 1 個 inventory、10,000 SKU、100 同時 reserve caller；單命令 ≤50 行，body ≤64 KiB；external call timeout 5 秒、端到端受理 10 秒後回 202；最多 4 並行外部連線／tenant，429 隔離；文字 Result 256 KiB、fixture retained budget 10 MiB。正式儲存額度、過期時間、retention、SLO／價格由已公開 policy revision 決定，未定不開正式 profile。外部不可達需只阻該 instance，不阻 B tenant 或人工筆記。

## 10. 可重現验收、發布與尚未完成

所有案例 **planned/not_run**。本文件提交只做來源／路徑／文件檢查，不表示 domain runtime、E2E、部署已測通。

### 10.1 Fixture 與環境

使用兩個獨立 PostgreSQL 實例 `central`／`external_inventory`（測試須顯式 disposable URL；不用管理員／superuser runtime），獨立 inventory HTTP process 與受限 service identity。租戶 A/B，各 owner、operator、viewer、一位 guild officer、被撤身份；同一 member 在 A owner/B viewer。有效 guild catalog 動態枚舉，至少一個純非商務 guild。A 的商品 SKU-A=10 件、SKU-B=3，兩個被接受 selection、一個 declined、test/live 各一例；Work／CRM／附件僅合成資料。保留一組 baseline legacy preview 和 existing agent-commerce order/acceptance/payment records，避免測試只驗空 DB。

### 10.2 Planned cases／可觀察證據

| T-ID | 步驟／故障注入 | 必要證據 |
|---|---|---|
| T-005／T-051 | 無 model／key 的會員逐公會建立 Work、保存 note 與實際 `.md` bytes，重登讀回／更新 | API IDs 不變、byte digest 相同、人工 flow 零 model dispatch、R2 policy gate 受測 |
| T-008／T-020 | 兩公會入口同 tenant 啟用相同能力；選重用或明選新 independent instance | 重用無複製表；新 instance 新 ID、舊資料不混合 |
| T-009／T-056 | 將 upstream SIM customer/order/wallet fixture 送正式 importer，未知 Mini source、缺 NOTICE 的 package | 全部精確拒絕／能力標示；真實 origin/commit/attribution 齊備；PR #105 diff 不被本包改動 |
| T-026 | 按 SP-06 刪除政策清理 CRM／外移 CRM 後查 commerce order | 私人 note/customer dataset 不在中央；合法必要 order snapshot 保留且無 CRM backdoor |
| T-028／T-029／T-041 | 同 fixtures 先 hosted reserve/release/status；只搬 A inventory；撤中央 role 對 inventory table 可見／UPDATE 權限；重跑 hosted store | 獨立 endpoint request log、DB instance identity、舊來源寫入拒絕、新 epoch 唯一、A store 成功／B 無中斷 |
| T-031／T-032 | reserve commit 前後 crash、drop ACK、同 command 100 併發、restart、多 key 同 operation_id | 只一 reservation；reserved sum 正確；receipt/outbox 不丟不重；不同 payload 409 |
| T-033／T-035 | 延遲／倒序 projection、expiry／release race | stale UI 不允許 oversell；authority status 正確、release 扣一次、gap 可補讀 |
| T-034 | reserve 成功後中央 finalize 注入失敗；release ACK 再丟失 | needs_reconciliation 可見、restart 接續、無遺失 reservation，未接受 payment |
| T-054 | baseline→expand→backfill→switch，另放 owner 歧義／存量不符／活躍訂單 | dry-run diff、逐階段 count/digest/ACL；歧義不落全域 tenant；legacy test/live／acceptance unchanged |
| T-055 | 360px、鍵盤、offline／戻る／重送、A→B 晚回、被撤 user Result GET中斷 | screenshots＋route/request evidence；無 A內容進 B；無 authority 的 HEAD／304／history／replay 皆拒絕 |

後續實作 PR 才執行 `npm run typecheck`、`npm run build`、受影響 runtime suites、`npm run test:e2e`、`npm run test:contracts`、`npm run test:repos` 與新增 fixture harness；每次 evidence 記 source/head SHA、migration set、command、UTC、DB runtime role、fixture digest、pass/fail/not_run、log path。不得現在把尚不存在的 suite 寫成已成功。

**發布條件：**共同 tenant/service scope、port conformance、獨立 DB 單模組外移、human Result policy、來源授權、legacy regression 全部通過，且 SP-12 可信 gate 實際消費共同 library；先逐能力／instance 開啟，不一次貼入 ERP demo。**仍未完成：**正式 capacity/retention 決策、inventory consume 契約、未定位 Mini 原作、實作 migration 編號確認、實際 runtime／UI／restore／部署驗收。
