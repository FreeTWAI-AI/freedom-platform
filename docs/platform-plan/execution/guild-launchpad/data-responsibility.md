# 資料責任、寫入權威與最小中央留存

版本 0.1，target design。`tenant_id` 是存取/可攜責任，不宣稱對客戶或共同作者資料有無限制法律所有權。現行程式還沒有 tenant aggregate；下表區分現存資料與新 target，沒有以文件改變正式資料歸屬。

> 2026-10-07 註：上段是 2026-10-05 的描述，保留不改。之後 P-B1（#164，merge `93e1470b`）以 migration 121 新增 `tenants` 等業務空間資料表，P-C2（#181，merge `57b610ab`）以 migration 123 新增 tenant Work 與人工 Result 的資料表與欄位；部署、啟用與驗收的目前狀態見 [README「目前狀態」](README.md#目前狀態)。

## 1. 模組邊界與資料目錄

每個實作 PR 必須把實際新增/讀寫的 SQL table、R2 purpose、索引、queue body、通知、cache、模型 trace 對到以下 dataset ID。未知資料集不能進可攜發布，不能由 glob 全表匯出補洞。`W` 是唯一 domain writer，`R` 是經 ACL 的 reader，`X` 是具專門 export 能力的人或 bounded job。tenant 角色不是全欄位/全模組通行證。

| Dataset ID | 目前承接點 / target | W 與 ownership | R / X | 可攜及跨模組規則 | 外移後中央保留 / 清理 |
| --- | --- | --- | --- | --- | --- |
| DC-01 平台會員與認證 | `users`,`sessions`；identity-membership | 平台 identity；本人欄位沿既有政策 | 原 member ACL；模組 export 不可讀認證表 | 套件只允許必要 principal reference；本地登入另建，不複製 session/password hash/OAuth | 平台會員原生關係按原政策保留；模組外移不是停用帳號 |
| DC-02 公會關係/技能/偏好 | positioning/onboarding、guild membership/tier/preferences、book grants | 平台 organizations；本人 primary preference、具名 officer scope | 公私欄位沿現有 ACL；X 僅本人可攜摘要 | 不因 tenant 移交重寫 membership，intern/full 與 office 不互換 | 原生資料；移出單模組不刪公會身份/技能；公開名冊不能帶私人欄位 |
| DC-03 公會內容/配置 | guild-workspace announcements/editorial；新 launchpad config | 該公會授權職務/委派，平台保存可審版本 | 公開/成員/管理三種；本人工作另取 DC-06 | 可攜公版模板及合法公開內容；不能夾帶名冊/會員私人工作 | 只留平台內容、版本來源及必要管理稽核 |
| DC-04 Tenant/instance/authority | 新 tenant membership/workspace/registry/binding mapping | 平台控制面對有效平台 binding 負責；tenant owner 管經營權 | 該 tenant capability；export 只取本模組有效 refs | stable tenant/instance IDs、schema/contract versions、依賴配置；平台授權資料僅供描述，匯入不能復活 grant | 保留 ID、當前 binding/epoch、契約及撤銷/切點證據；不藉 registry 保留業務 payload |
| DC-05 CRM | **新增 CRM domain**；引用 existing opportunity/engagement | CRM instance 是客戶/聯絡/跟進主檔唯一 writer；tenant 私有 | 指定 CRM read/edit；整批 export 另授權 | 可帶 contacts/notes/custom fields/附件/必要歷史；只分享用途允許 customer ref/必要 label | 外移清除原主檔、搜尋、摘要；預設僅 opaque ref。label 必須有具名用途/期限，不預設永久 |
| DC-06 工作/筆記/成果 | `work_items`、`private_work_results`、`private_work_result_index` 與 Asset；新增 tenant_execution seam | 既有 Work/Result domain，tenant scope extension；personal_execution 不變 | Work ACL+tenant/module；guild leader 無私有特權；X 專 scope | Work title/objective/progress、歷史 Result、配置/附件；社群 Claim/QC/Contribution 僅引用 | 外移後 Work registry 最小 ref/status；不能留私有全文於 community outbox/公開作品 |
| DC-07 商品/供貨條件 | `catalog_products`,`supplier_offer_versions` legacy preview；`commerce_items`現行 lane | SP-10 指定 agent-commerce 正式演進承接；legacy remains preview | Supplier 私有成本與公開商品分離 | Product stable refs、版本化合法供货條款；禁止另建 ERP 正式 product truth | 共享目錄僅已批准欄位/版本；撤銷不銷毀已成立合法義務 |
| DC-08 店面/listing | `retail_stores`,`retail_listing_revisions` preview；`commerce_shops`,`commerce_selections` | 單一 Seller/Store domain；tenant 經營者不同於 user alias | Seller tenant ACL；public listing 另有發佈規則 | app/config/theme/合法素材、listing/source refs；public slug 不是 ID | 平台原生公開目錄/ref 可按同意保留；未公開成本/草稿移除 |
| DC-09 訂單/交易快照 | `commerce_orders`,`commerce_order_lines`,`commerce_transfers` | agent-commerce order owner；交易 participants 各有具名 rights | Seller/Supplier 按用途欄位；不得任一方查另一方整份 CRM | 訂單必要收件快照保留當次版本；不是 CRM live master；跨方引用不直接 SQL cascade | order-owned 合約/履約事實依具名 policy 保留；CRM 外移不抹除，亦不容日後拿快照重建全 CRM |
| DC-10 庫存/預留 | 現在 `commerce_items.stock/reserved`；target inventory balances/reservations seam | 遷移前既有程式；switch 後該 inventory instance 唯一 writer | scope-limited reserve/release/status；display projection 不決定接單 | balance/ledger/reservation/cutoff/operations 同包；hosted order 只呼叫 port | minimal availability projection+source version/TTL；移出後中央不得再修改舊 stock 欄位 |
| DC-11 分銷/應付/付款觀察 | `commerce_distribution_acceptances`,`commerce_supplier_payables`,`commerce_obligation_reversals`,`commerce_payment_events`,`commerce_settlement_records` | exact agreement participants / ledger；Seller provider/bank 是實收權威 | 當事方 scope；不能從 PR/頭銜生成付款義務 | 帶本方合法快照/不可變 refs；不要把單方回報改成 bank-verified | 平台必要商務事实保留具名用途；保持 record_only，無代收/自動扣款/新增 checkout |
| DC-12 活動/行銷 | community/events、opensource-marketing、promotion | 既有 domain public/owner ACL；不是 CRM 子表 | event audience、organizer/author及已授權參與者 | tenant 私有 campaign draft 可攜；平台公共活動和 referral事實另論 | 公開/共同活動資料按原政策；聯絡/email和私密草稿不可順便複製 |
| DC-13 附件/變體 | `assets`,`asset_objects`,`asset_upload_intents`及各 target sidecar；R2 bytes | Asset engine維護 lifecycle；內容 ACL 由 owner domain 決定 | download/HEAD/Range/variant/export 全部驗 domain+tenant+purpose | logical asset ID、immutable representation、sha256、byte size、mime、source revision、實際 bytes | 完整 object pins/retention；移除不再必要的檔案/變體但不刪合法共享別方引用；不能僅刪 DB pointer |
| DC-14 Operations/receipts/events | existing command/scoped journals；target module inbox/outbox/operation projection | domain本地交易；認證 adapter驗当下 authority | 同 target當下讀權；transport不等於 authority | 已承認歷史 operation/receipt最小摘要與未送事件接續；原 key不成登入凭證 | body 清理與dedup marker分開；最小重播防護到 namespace退役。保存期限在policy未定，不能預設永久私有payload |
| DC-15 搜尋/cache/分析/通知/模型 | 各 consumer/read surface；新 profiles均需登記 | source module授權建立有用途副本 | parent ACL不可因投影弱化；每次讀/搜尋scope過濾 | 預設可重建不打包；必要config和來源cursor可帶；內容進模型需另許可 | 清理索引、embedding、summary、cache、通知excerpt、trace；統計只留不含業務payload聚合 |
| DC-16 備份/匯出/恢復材料 | media-migration/snapshot-evidence及新 scoped manifest | bounded operator/export job；不得用全庫privilege替代tenant scope | 專用export/migration scope，owner近期驗證；下載本身也驗權 | 同snapshot rows/object pins；包無平台secret/原始role grants | 期限/目的/合法保留分列。過期副本待清理不標已刪；恢復前先套tombstone/revocation/epoch floor |

## 2. 欄位允許清單範例

CRM→order 的 live projection 初版允許 `{customer_ref, source_version, observed_at, expires_at}`。只有具名 order UI 用途確實需名稱且 tenant 核准時才增加 `display_label`。不得含 email/phone/address/freeform_notes；當次履約所需收件快照在 DC-09 由 order owner 另行收集、驗同意、pin 版本，不能經 generic projection偷帶。

Inventory→storefront 的 display projection 可含 `{product_ref, availability_state, source_version, authority_epoch, observed_at, expires_at}`；精確數量只有政策明許。`inventory.reserve` 成功必須來自當前 authoritative instance，不能從 projection推斷。Supplier 的採購成本不進 Seller 的 public listing。

中央應提供私有的 retention inventory：dataset_id、storage_surface、field_allowlist、purpose、policy_ref、expires_at或阻止刪除的具體原因、cleanup state。採 `unknown` 時不可聲稱外移後已無殘留。每次新增資料欄位須審是否影響X、privacy、保留與對方權利。

## 3. 跨模組引用及刪除/恢復

- 同模組 SQL 使用帶 tenant/instance 的組合 FK 和唯一性；跨模組用 typed ResourceRef/application port，禁止 direct private DB join成為必要運作條件
- `tombstone` 是已授權刪除決策的最小事實，包含 opaque ID、decision version/time、scope、retention basis；不存被刪內容。它不授權刪除其他 tenant合法共同事實
- 移交的控制面 epoch/recovery floor與撤權來源不能只放在會被同backup回退的資料庫；unavailable就隔離/停寫，不能猜舊token仍可用
- 附件去重預設限 tenant；cross-tenant content address命中不得漏出另一方是否有檔，也不得讓一方清理破壞另一方引用
- 匯入先 quarantine；身份/密碼/機器grant/audit trust不從資料包接受。schema、counts、digest、ref及業務不變量全部驗過後才發布資料
- 上述policy未決定不阻擋合成fixture/spec；阻擋該能力正式保留/刪除承諾。詳 [SP-06](SP-06-isolation-recovery.md)、[SP-07](SP-07-portable-bundle.md)、[SP-08](SP-08-module-migration.md)

## 4. 完整性驗收

T-021 必須以實際schema/catalog/Asset purposes與所有讀寫面對帳；本表目前是初始責任設計，不宣稱窮盡現行資料庫全部表。未涉及本專案的192表歷史數字不當成此scope分母。T-025/046檢查當前全量副本清單，T-047從包含舊副本的隔離backup恢復後仍拒舊權威/已撤token。所有資料用合成 A/B tenant，禁止取得正式客戶資料補測。
