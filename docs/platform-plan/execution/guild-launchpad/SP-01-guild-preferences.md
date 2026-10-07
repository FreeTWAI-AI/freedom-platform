# SP-01 公會分類與每類主力偏好

## 1. 文件 ID、版本、狀態、來源 commit、對應 D／R／T ID 與範圍

- ID：SP-01；版本：0.1.0；日期：2026-10-05；狀態：**待實作、待審查的規格提案**。本文不是已部署聲明，所有 NEW API／資料結構均為目標契約。
- 計畫來源：《自由工坊｜公會啟動台與可攜式業務空間》v1.0，第 2、5、19–24 章及附錄 A/B。
- 原始碼基線：`FreeTWAI-AI/freedom-platform@567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`。部署版本與正式資料未於本規格工作驗證。
- 決策：D-01、D-02、D-03、D-19、D-20、D-22。主要需求：R-001、R-002、R-010；共同覆蓋 R-003、R-016、R-030、R-057、R-058、R-060、R-064。
- 驗收：T-001、T-002、T-003、T-010、T-016、T-030、T-054、T-055、T-060。
- 範圍：三類 catalog、每類至多一個主力、舊會員無損轉換、onboarding／會員名冊／首頁相容；不改公會加入條件、職務權力或 tenant 所有權。
- 共用基準：[contracts.md](contracts.md)、[資料責任](data-responsibility.md)、[程式地圖](repository-map.md)、[決策與待定參數](decision-log.md)、[追蹤表](traceability.json)。與本文有命名歧異時須修正文檔並重新驗證 consumer，不可在實作時自行猜測。

## 2. 使用者流程、前後狀態、非目標與依賴；說明什麼不需要等

### 2.1 前後行為

目前 `guild_member_preferences` 為 `(community_id,user_id)` 一列，保存一個 `primary_guild_key` 與最多兩個 `secondary_guild_keys`；`effectiveSecondary()` 還有歷史 NULL 的推導行為。現行離會要求先換走原主要公會，加入／重加入預設 `intern`，技能書 grant 保留。這些是來源事實，不是本規格的新規則。

目標為內政、外交、專業與產業三個獨立偏好槽；加入任何數量公會仍沿現行資格與限制。會員可只選一類，其他槽為空。主力只改排序、推薦與投入方向，不授予應用、tenant、技能編輯、GitHub 或管理權。

1. 會員打開公會頁，讀取有效 catalog 及本人 memberships；顯示三類主力與所有其他已加入公會。
2. 選「設為本類主力」前，server 確認公會有效、類別已核准且會員關係 active。`intern` 也可表達主力偏好；啟動應用另依 SP-02 檢查 `full`。
3. 以目前偏好 aggregate version 提交單槽更新；成功只更動該類。重複點擊／未知回應使用同一 key 查重，不生成加入、升級或 tenant 事件。
4. 清空某類合法；UI 不要求補滿。離會的新版 command 可原子清除此公會的主力，不選替代者；會員知道私人業務保持原歸屬。
5. 公會改類別時，不把主力自動塞到新類造成衝突；原槽記錄 invalidation，提示本人重新選。停用亦同；不動既有 memberships、tiers、書或資料。

### 2.2 分類提案：18 個實際 key

分類依 migrations 的使命與 catalog 綁定，而非名字或工具。下列均為**待內容審查的建議映射**，不是 Ted 已逐項批准分類；「需確認」必須在正式切換前結案，但公版 launchpad 不等其結案。

| 實際 guild_key | 基線名稱 | 建議主類別 | 使命依據／待確認事項 |
|---|---|---|---|
| `guild_talent_direction` | 人才與方向公會 | 內政 `internal` | 會員探索、學習與陪跑；如果未來主要提供對外職涯服務，另走改類流程 |
| `guild_member_operations` | 會員與社群營運公會 | 內政 | 會員加入、交流、支援 |
| `guild_platform_engineering` | 平台工程公會 | 內政 | 平台整合、資料及可靠性 |
| `guild_ai_vibe` | AI 開發公會 | 內政 | 建議以社群開源建設為使命；**需確認**：若主使命是對外專業開發，應屬專業與產業 |
| `guild_opportunity_partnership` | 商機與夥伴公會 | 外交 `external` | 外部需求、合作資源與夥伴連結 |
| `guild_marketing` | 成長與行銷公會 | 外交 | 推廣、內容、活動成效；**需確認**以對外成長為主，而非內部社群營運 |
| `guild_commerce_sales` | 電商與銷售公會 | 外交 | 通路、銷售與買家；**需確認**專業店務與外交通路的主使命取捨 |
| `guild_product_quality_supply` | 商品品質與供應公會 | 專業與產業 `professional_industry` | 產品、供货條件、品質實踐 |
| `guild_media_automation` | 媒體自動化公會 | 專業與產業 | 影片、字幕及媒體流程 |
| `guild_commerce_settlement` | 交易整合與對帳公會 | 專業與產業 | 商家自有收款整合、核對；不代表平台代收或正式會計 |
| `guild_ai_field` | AI 導入與驗證公會 | 專業與產業 | 場域測試、導入、部署；**需確認**是否主要服務工坊內部產品 |
| `guild_ai_project` | AI 專案公會 | 專業與產業 | 需求、範圍與交付；**需確認**是否主使命為對外商機媒合 |
| `guild_security` | 資安公會 | 專業與產業 | 有權管理系統的安全檢查與修復 |
| `guild_music_mv` | 音樂創作與MV公會 | 專業與產業 | 音樂／MV 的製作交付 |
| `guild_commercial_production` | 廣告攝影與影片公會 | 專業與產業 | 拍攝、分鏡與交付；不因服務行銷就歸外交 |
| `guild_event_space` | 活動與空間公會 | 專業與產業 | 場地、動線及實體活動專業；**需確認**內部社群活動是否才是主要使命 |
| `guild_projection_mapping` | 光影光雕公會 | 專業與產業 | 場勘、投影、視覺與播放設計 |
| `guild_human_design` | 人類圖研究所 | 專業與產業 | 共讀、來源查核與探索；不作診斷或能力認證 |

`guild_*` key、既有名稱、alias、profession_title 均不因分類而改名／合併。基線沒有本計畫新增的 ERP guild key；不得虛構已存在 ERP 公會。動態核准的 `guild_custom_<32 hex>` 由 catalog 查詢列舉，不能只用上表 18 個作分母。新公會審核要求 mission/category 欄位；在舊公會分類未決期間 `category_review='pending'`、`category=null`，仍提供 SP-03 公版，但不能寫入主力分類槽。

### 2.3 依賴與並行

依 SP-00 基線與共同 command／session；SP-02 消費 memberships 而不依賴選滿主力。SP-03 可用合成 catalog 測試全覆蓋，同時實作 shell。SP-04 應用、ERP 深化、私人 AI、正式資料迁移均不是分類與 UI 規格前置。正式 switch 前須完成分類審查、雙讀對帳及舊寫入擋板。

非目標：改測驗分數、重設已有 onboarding、重訂 full 判準、將會長設成 tenant owner、重做 skill books、默認用次要公會填滿另兩類。

## 3. 現有程式對照與 KEEP／MODIFY／NEW／GENERATED，精確到實際檔案

以下是未來實作改動地圖；本 PR 只新增本文。

| 動作 | 精確路徑 | 責任 |
|---|---|---|
| KEEP | `migrations/002_positioning_guilds.sql`、`migrations/006_guild_onboarding.sql`、`migrations/009_specialist_guilds.sql`、`migrations/020_creative_guilds.sql`、`migrations/027_secondary_guild_preferences.sql`、`migrations/069_guild_member_tiers.sql` | 歷史 migration 不重寫 |
| KEEP | `modules/positioning/member-tier.ts`、`modules/platform-admin/guild-appointment-membership.ts` | full／intern、專家及會長任命語意 |
| KEEP | `packages/db/command-core.ts`、`packages/db/member-command.ts`、`packages/db/member-session.ts` | session、receipt、交易核心；不建第二套 |
| MODIFY | `modules/community/catalog.ts` | guild/book 關係保持，新增分類 metadata 的單一內容來源引用 |
| MODIFY | `modules/positioning/onboarding.ts`、`modules/positioning/service.ts` | 分類、主力、加入／離會鎖定及新舊 adapter |
| MODIFY | `modules/identity-membership/members.ts` | 名冊及名片的舊 primary filter／projection 相容 |
| MODIFY | `modules/platform-admin/service.ts` | 自訂公會核准時設定類別／未決狀態；保留既有審核權 |
| MODIFY | `apps/platform-api/src/routes/positioning.ts` | 新分類／偏好 endpoints；舊寫入升級提示 |
| MODIFY | `apps/portal-web/src/modules/PositioningPanels.tsx`、`apps/portal-web/src/modules/Onboarding.tsx`、`apps/portal-web/src/modules/GuildCard.tsx`、`apps/portal-web/src/modules/GuildFilters.tsx`、`apps/portal-web/src/modules/MemberHome.tsx`、`apps/portal-web/src/modules/Membership.tsx` | 三類偏好、可留空、不中斷舊 onboarding 與名冊 |
| NEW（建議） | `modules/positioning/guild-categories.ts`、`contracts/guild-launchpad/v1/guild-preferences.ts` | 分類規則、嚴格 Zod DTO；路徑本輪不存在 |
| NEW（建議） | `migrations/<next>_guild_categories_preferences.sql` | expand；這是未分配檔名的 logical migration，實作依最新 main／相依 PR 分配，不預占任何 SQL 號碼 |
| GENERATED（未建立） | `contracts/guild-launchpad/v1/guild-preferences.schema.json`、`packages/sdk/guild-launchpad.d.mts` | 由未來 generator 從 typed canonical source 產生，不手改 |
| MODIFY | `tests/runtime/guild-preferences.test.ts`、`tests/runtime/onboarding.test.ts`、`tests/runtime/guild-member-tiers.test.ts` | 回歸及新分類反例 |
| NEW（建議） | `tests/runtime/guild-category-preferences.test.ts`、`tests/e2e/guild-launchpad-preferences.test.ts` | 本節 T 案例 |

canonical `README.md`、`DESIGN.md`、`docs/development/guild-library-layout.md` 目前仍說一主兩次。實作 switch 的 PR 必須同步改其產品描述與 consumer；spec PR 不提前把现況改成已完成。

## 4. 資料模型、唯一性／關聯／tenant scope、owner／authority、版本與敏感欄位

所有新增表名均為提案。分類與偏好属于平台原生資料，中央 API/PostgreSQL 為寫入權威；不進任一業務 tenant，不隨 CRM 外移刪除。

- `guild_catalog_categories(guild_key PK/FK positioning_guild_catalog, category enum|null, category_review pending|approved, catalog_revision bigint>0, capability_tags text[], active boolean, reviewed_by_principal_id nullable, reviewed_at nullable)`。approved 必有 category；pending 必為 null。舊 catalog 無 active 欄位，新增 lifecycle 必須明示，不能聲稱已可停用。
- `guild_preference_sets(community_id,user_id,aggregate_version bigint>0, migration_state legacy|backfilled|switched, migrated_from_version nullable, updated_at)`，PK `(community_id,user_id)`。新版一組三槽只一個 CAS 版本，避免多槽修改部分成功。
- `guild_category_preferences(community_id,user_id,category,guild_key,selected_at)`，PK `(community_id,user_id,category)`，UNIQUE `(community_id,user_id,guild_key)`；FK `(community_id,user_id,guild_key)` 到既有 membership unique key。active membership 與同類別跨表一致性由受控 command 加鎖驗證，並設 constraint trigger 防未經 service 的 DML 破壞；不寫錯誤的跨表 CHECK。
- `guild_preference_migration_audit(run_id,community_id,user_id,legacy_primary,legacy_secondary,legacy_version,new_snapshot,invalidation_reason,recorded_at)` 保留不可變映射、digest／counts。原 secondary 為 NULL 也必須保存，另記當時 effective list，不混為明確空陣列。
- `guild_preference_invalidations(id,community_id,user_id,guild_key,old_category,reason,old_version,new_version)`；reason 為 `guild_recategorized|guild_inactive|membership_left|legacy_ambiguous`。不含私人測驗答案。

偏好屬本人私有設定；可公開顯示的職業／主力標示仍經現有名片隱私規則。分類與公開公會描述可公開。API 不可因遷移把 email、guild answers、positioning answers 或 private notes 混入名冊。

鎖順序：沿 session/user → receipt → `lockMemberGuilds(community,user)` → preference-set → guild catalog/membership 的一致順序；分類批次與 member command 須使用同一分類修訂 fence，避免 catalog change 和 set-primary 間 write skew。分類變更只批次處理受影響 preferences，每批可重啟；未處理讀取以當前 catalog 為準把已失效 preference 標為 invalid，不暴露錯誤的有效主力。

## 5. API／command／query／event 的完整輸入輸出、錯誤、身份、冪等及並行語意

### 5.1 共通 wire

API 前綴 `/api/v1`。UUID 使用現行 `OpaqueId`；`Version` 為正整數 decimal string，範圍 1..9223372036854775807；`GuildKey` 遵現行 `guild_[a-z0-9_]+`／custom key 正規式且 ≤100 字元。時間為 UTC RFC3339。輸入 strict、拒未知欄位／重複 query；`category` 僅 `internal|external|professional_industry`。

Mutation 需目前 member session、Origin/CSRF、`Idempotency-Key`（現行 `[A-Za-z0-9_-]{8,128}`）；set 已存在 aggregate 需 `If-Match: "<Version>"`，新會員在現有 register/onboarding 的同一受控交易建立三槽為空的 preference-set version 1；舊會員由 backfill 建立。GET 不寫入，若必要 mapping 尚缺回503 `preference_mapping_unavailable`，不得由 client 用0假造版本或靠讀取偷偷完成遷移。個人 query `Cache-Control: private, no-store`。error 使用現有 Problem transport 的 `{type:string,title:string,status:number,code:string,detail:string}`；以共同 contracts 確認 transport shape，不在 log 回顯敏感輸入。

```ts
type Category = 'internal'|'external'|'professional_industry';
type PreferenceView = {
  aggregate_version: Version;
  primaries: {category:Category; guild_key:GuildKey|null}[]; // exactly three distinct categories
  invalidated: {guild_key:GuildKey; category:Category; reason:string}[];
  migration_state:'legacy'|'backfilled'|'switched';
  legacy: {primary_guild_key:GuildKey|null;secondary_guild_keys:GuildKey[]}|null;
};
type GuildClassification = {
  guild_key:GuildKey; category:Category|null; category_review:'pending'|'approved';
  capability_tags:string[]; active:boolean; catalog_revision:Version;
};
```

### 5.2 端點與權限

| 端點／command | 完整輸入 | 成功輸出 | 身份／必要 domain 檢查 |
|---|---|---|---|
| GET `/guild-categories` | query `{}` | `{categories:[{key:Category,label:string}],items:GuildClassification[],catalog_revision:Version}` | 僅公開分類投影，無 membership；退役 key 可保留 metadata，不展示私有 |
| GET `/me/guild-preferences/v2` | query `{}` | `PreferenceView`、ETag | 本人 current session；不得給 user_id 查他人偏好 |
| POST `/me/guild-preferences/v2/set`，`guild.preference.set` | `{category:Category,guild_key:GuildKey\|null,catalog_revision:Version}`＋If-Match | `PreferenceView`、ETag | 本人；非 null 必 active membership、approved/active catalog、同 category；null 可清空 |
| POST `/guilds/:key/leave-v2`，`guild.membership.leave` | `{clear_primary:boolean}`＋membership If-Match；若該 guild 是主力另傳 header `X-Preference-Version: <Version>`（正十進位未加引號；缺少428、無效400） | `{membership:{membership_id:UUID,state:'left',member_tier:'intern'\|'full',aggregate_version:Version},preferences:PreferenceView}` | 本人；如為主力且 clear_primary=false 回衝突；true 原子清槽，保留書與 tenant；既有會長離會限制照舊 |
| POST `/admin/guilds/:key/classification`，`guild.classification.update` | `{category:Category,capability_tags:string[],reason:string}`＋catalog If-Match | `{classification:GuildClassification,invalidation_operation_id:UUID}` | 既有平台 admin context；不是任何 tenant owner；tags 0..20、每項 1..64；reason 3..1000；不接受 caller reviewed_by |

分類 query 分頁若動態 catalog 超過共用上限，改用共同 cursor envelope；不能不標示截斷後聲稱全公會已覆蓋。正式 classifier API 決策可放 admin 契約，但欄位／狀態以上為最低要求。

特定失敗：400 `invalid_category|invalid_body|idempotency_required|invalid_version`；401 `session_expired`；403 `guild_classification_denied`／現有 admin denial；404 `guild_not_found`；409 `active_guild_required|guild_category_unresolved|guild_inactive|catalog_revision_changed|primary_clear_required|idempotency_conflict|client_upgrade_required`；412 `version_conflict`；428 `version_required`；429 `rate_limited`。未知／他社群 membership 不回其他成員狀態。

同 key 同 payload 回已提交 snapshot，仍先重驗當前 session／本人授權；同 key 不同 `category/guild/expected/catalog_revision` 回409。不同 key 同舊 version 併發僅一筆成功，另一筆412；同時更新不同類仍需重讀 aggregate，不能 last-write-wins 丟另一槽。命令、版本、audit 與 outbox 同交易；沒有網路 I/O 放入交易。

### 5.3 事件及兼容

新增私有 scoped fact `freedom.guild.preference.changed.v1`，payload `{community_id,user_id,aggregate_version,changed_category,guild_key|null,reason:'member_selected'|'member_cleared'|'membership_left'|'guild_recategorized'|'guild_inactive'}`。guild directory 只接收分類事件 `freedom.guild.classification.changed.v1` 的公開允許欄位。這些是平台原生控制面事實，保留既有 scoped journal/outbox profile，不套用SP-05要求tenant_id/source_instance_id的module資料envelope，也不捏造tenant/instance。payload schema版本、event_id去重、revision單調性由同一canonical authoring產生；若未來真有module subscriber，只能在確認真實target binding與用途後由顯式versioned adapter轉譯。不得把偏好事件廣播到公會聊天。

舊 GET `/me/guild-preferences` 暫回凍結的 legacy primary/secondary 與 `compatibility:'legacy_projection'`（新增欄位先驗證 consumer），或保持原 wire 並以 header 指示升級；不能把三類壓回單欄。switch 後舊 POST `/guilds/:key/primary` 與 `/me/guild-preferences/secondary` 回409 `client_upgrade_required`，帶新版 route 文案；不得200但忽略新槽。switch 前舊寫入正常，必使該會員 backfill checkpoint 失效再重算。

## 6. 狀態機與成功、失敗、結果未知、重啟、撤權、版本不符及部分完成分支

- membership `active/left`、tier `intern/full`、officer、primary 為四個維度；任一偏好操作不得升 tier。
- preference-set：`legacy → backfilled → switched`。backfilled 遇舊寫入退回待重算；switched 後只收新版寫入。contract retire 不刪 audit。
- category：`pending → approved`；approved 改 category 產生新修訂與 invalidation 任務。fail midway 保留 checkpoint；讀取採最新分類防錯主力，不刪私有業務。
- set command 同交易成功即全成；錯誤 rollback 所有偏好與 event。提交 ACK 丟失時 UI 保留 key／精確 payload，重試取得原 receipt；不得以新的 key 覆寫為「修復」。刷新後可重新 GET 版本，不把 UI 舊值當成功證據。
- session/會員帳號撤銷後，即使 receipt 存在也拒回私有 snapshot；重新登入後本人可讀當前狀態。離會和 set 同時發生，最終不得留 active preference 指向 left membership。
- catalog／client version 不相容時明確拒絕寫入；已取得的書、本人 tenant 操作不因偏好服務故障被阻擋。

## 7. UI、可見性、空狀態、載入／失敗、手機、無障礙與人工接手

三類各一個「本類主力」區塊與「尚未選擇」狀態；加入與主力按鈕分開。其他已加入公會保持可見，secondary 歷史在相容說明中可查，不自動變成主力。每卡保留 full/intern、會長、專家、技能書功能。公開頁不顯示本人 preferences。

onboarding 可先選一個喜歡的已加入公會，保留現行 quick-start／可稍後定位流程，不要求填滿三類或重答測驗。離會確認文案明示清空哪一類偏好及 tenant 資料不移轉；不可把離會確認說成刪資料。

更新時保留選擇草稿；412 提供讀新版本／比較差異，再由本人重送。分類未決顯示「分類整理中，仍可使用公會工作區」。401 回登入後回原頁；unknown 顯示「正在確認是否已儲存」。手機使用既有 tokens、44px 可點區、單一主操作；三組 radio/fieldset 有清楚 legend，可鍵盤清空與變更；live region 公布結果，focus 回原按鈕。長名稱換行，不縮正文。沿 `DESIGN.md`、現有三主題／導覽安全規則，不另建設計系統。

## 8. 資料匯出／匯入／升級／清理／回復及 legacy 相容；不適用需寫理由

1. **Expand**：新增 catalog category、preference-set、audit；舊 SQL／API 行為不變；dry-run 只出 counts、差異與歧義，私有識別不進公開 PR。
2. **Backfill**：按 `(community,user)` 鎖定，記 legacy version。只有舊 primary 在 active/approved catalog 與 active membership 下映到其單一類；其餘兩槽 null。secondary 所有值與 membership/tier/skill/privacy 原封保存。同 key 重跑不重複 audit。
3. **驗證**：before/after memberships 數、state/tier digest、skill grants、member_accounts 隱私 digest 全同；偏好映射逐列可追；分類未知、left primary、不合法 legacy secondary 列出而不猜。
4. **Switch**：版本化開關按 community 分批；封鎖該範圍舊寫入後完成最後差分並切新讀。切換中短暫拒寫可接受，不能雙寫不同語義造成三槽被一槽覆蓋。
5. **Contract**：相容窗口長度在 decision-log 批准，建議30日只作規劃數值；先驗舊 client telemetry 再移除舊寫路徑，舊欄位先保留唯讀，不在本 PR 執行 destructive SQL。

回復應回復 reader/feature flag，不把新版三槽覆寫成一槽。若已產生新版 preference，新版表仍是權威；舊 UI 只能唯讀且顯示升級，不可重新開放有損寫入。備份還原須重放 invalidation/撤權以及 migration checkpoint，禁止已 left guild 復活為主力。

會員個資匯出可含自己的 preferences、legacy mapping、選擇時間與公開 guild key；不附其他會員的選擇或內部審核者聯絡資料。業務 module portable bundle 只可帶作 UI context 的 guild refs（無授權效果），不攜整份社群 catalog 當權威；跨平台匯入偏好需本人重新確認，不能由外來檔案建立 active membership。

## 9. 威脅模型、最小權限、秘密、外部入口、cost／capacity 與安全反例

- IDOR：篡改 user_id、community_id、guild_key 無法改他人偏好；query 不接受 user_id。分類/admin 權限不從 guild master／tenant role 推導。
- write skew：分類變更、離會、兩個 browser 同類競寫採同一鎖／revision；DB 約束拒不同類錯配，不能只驗 UI。
- 隱私：個人偏好不出 public cache、名冊的私人欄位及錯誤詳情；舊公開 profile 依原 privacy policy。
- 任意 tags/XSS：catalog 文字當純文字，tag 不成為 permission string；不能輸入程式碼、SQL、script URL。
- 成本：不新建 tenant、不呼叫模型、不配置 DB。建議 mutation 每人30次/分鐘、catalog page200、backfill100人/批（最大500）、DB lock timeout5秒；**數值為待批准預設**，可配置且以503/429明示政策缺失或限流，不能默認無限。
- 本 spec 不需要新 API secret；不得把 session、email、private onboarding answers 寫 audit/outbox。對帳報告可用本機合成 UUID，正式詳情放受限稽核儲存。

## 10. 可重現 fixtures、測試環境、T-ID 驗收、發布條件、證據與未完成項目

fixtures：隔離 PostgreSQL schema；A/B 兩社群、會員 Alice(owner elsewhere)、Bob、guild master M；18個基線 key＋1個合成 `guild_custom_...`；每類兩公會、pending分類一個；legacy primary、NULL／空／兩筆 secondary、intern/full、已離會、privacy private/public 組合。以 `tests/e2e/fixtures.ts` 建帳，禁止正式會員資料。

| T-ID | 步驟／故障注入 | 必須觀察的結果及證據 |
|---|---|---|
| T-001 | 對18 keys＋dynamic分類、非法enum、跨類 FK／直接DML、改類中斷逐項測 | 一guild一主類；pending不寫槽；tags不擴權；SQL約束與API錯誤摘要 |
| T-002 | 同一If-Match併發把同類設不同guild；清空另兩類後操作合法業務 | 恰一成功一412；每類≤1；未選滿不封鎖；DB rows＋receipts counts |
| T-003 | full 非主力 member 從 SP-04 啟動；主力 intern 嘗試相同啟動 | 前者依其他資格成功、後者403；ACL前後digest不變 |
| T-010 | legacy fixture每種轉換／重跑／rollback | memberships、tiers、skills、privacy完整；只原primary映一槽；secondary不升格 |
| T-016 | 主力切換、離會與set競爭、分類停用 | 不刪tenant或Work；失效槽清楚且無自動替代 |
| T-030 | 舊client switch前後GET/POST | 舊讀可理解；舊有損寫409，無200假成功；新三槽不丟 |
| T-054 | backfill提交前後crash、舊寫入插入中途、restore | checkpoint續跑、版本重算、audit能還原；無重複映射 |
| T-055 | 360px/1280px、鍵盤、兩tab版本衝突、網路ACK丟失、Back/Forward | 草稿保留、焦點正確、同key重試、私人快取不洩漏 |
| T-060 | 檢查本文件D/R/T與traceability、catalog分母 | 所有映射有owner；不是只查18個卡片截圖 |

未來實作驗證入口：`npm run typecheck`、`npm run build`、`npm test`、`npm run test:contracts`、相關E2E；UI先build再E2E。需附 exact source/head SHA、DB migration revision、catalog分類簽核、測試命令/exit code/時間、fixture seed、負向測試、dry-run差異及rollback演練。這些**本 specs-only PR 均未執行**；本輪只驗文檔結構、路徑與diff。

發布 gate：分類疑義結案、正式 catalog 列舉對帳、無損dry-run、舊API寫入擋板、新UI回歸、受控備份／恢复前置、feature flag 初始關閉。未完成：分類實際核准、正式dynamic catalog、compat窗口／rate limit定值、程式／migration／測試實作、部署驗證；不阻擋並行SP-03公版設計。
