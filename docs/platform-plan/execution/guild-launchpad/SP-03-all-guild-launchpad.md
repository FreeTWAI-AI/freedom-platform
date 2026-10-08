# SP-03 全公會共用啟動台與真實私人工作

## 1. 文件 ID、版本、狀態、來源 commit、對應 D／R／T ID 與範圍

- ID：SP-03；版本：0.1.0；日期：2026-10-05；狀態：**可實作規格提案，未實作／未部署**。
- 2026-10-07 註：上一行是 2026-10-05 規格草案的狀態，保留不改。之後 P-C1（#160，merge `12a2a83c`，migration 122）、P-C2（#181，merge `57b610ab`，migration 123）與 P-C2-UI（#190，merge `31df6ddb`，無 migration）已實作本規格的一部分並合併到 main；部署、啟用與驗收的目前狀態只記在 [README「目前狀態」](README.md#目前狀態)。
- 來源：計畫v1.0第2、6、7、16、19–24章；原始碼 `FreeTWAI-AI/freedom-platform@567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`。以下route與資料表均標為target，不把目前`GuildWorkspace`名稱當成已支援launchpad。
- 決策：D-04、D-05、D-06、D-08、D-10、D-11、D-19、D-21、D-22。主要需求：R-004、R-005、R-006、R-012、R-058；共同R-007、R-008、R-010、R-018、R-023、R-053、R-060。
- 驗收：T-004、T-005、T-006、T-007、T-008、T-012、T-018、T-023、T-051、T-055、T-057。
- 責任：共用shell、四種視圖、版本配置、所有有效公會公版、可保存重開Work/note/attachment/Result。Work domain實作以[SP-10](SP-10-domain-upstream-integration.md)為單一責任；tenant ACL見[SP-02](SP-02-tenant-authorization.md)，instance見[SP-04](SP-04-applications-instances.md)。
- 共用：[contracts.md](contracts.md)、[data-responsibility.md](data-responsibility.md)、[repository-map.md](repository-map.md)、[decision-log.md](decision-log.md)、[traceability.json](traceability.json)。

## 2. 使用者流程、前後狀態、非目標與依賴；說明什麼不需要等

### 2.1 全覆蓋的最低交付

每一筆當時有效catalog公會（含管理員動態核准、含分類未決）都能開相同shell；沒有專屬配置就計算平台預設。不得硬編碼只18個、只commerce、只ERP、只列外部repo，亦不得把「開發中」當公版完成。

正式full成員可由任何已加入、非主力也包括在內的公會，選擇有權的tenant/workspace，啟用或續用同一個`work` module的manual workspace；建一個自己的Work、寫筆記、上傳實際`.txt/.md`附件、保存人工作Result，登出後再登入能讀回完全相同的內容和digest。沒有model key或任何AI grant仍可完成。intern沿既有閱讀／聊天資格，不自動升full；新啟動權依SP-02，不將未通過資格說成沒有公版。

公版從一開始就是真實持久資料路徑，不能先存localStorage或公會公告，等待未來才做隔離。公版生效須通過tenant Work與Asset profile前置；UI/fixtures可並行，正式私有寫入不能用假的「已保存」代替安全gate。

### 2.2 四種獨立視圖與可見性

| 視圖 | 內容 | 權限與禁止內容 |
|---|---|---|
| 公開／訪客 | mission、可公開公告／技能／成果、加入方法 | public projection allowlist；沒有private membership、Work數量、tenant名稱、draft配置、私人定位 |
| 公會成員 | 成員公告、技能、公共任務／活動、應用與資格提示 | current guild membership；intern/full逐能力判斷；不帶他人tenant資料 |
| 本人工作 | 顯示acting tenant/workspace、己方Work/Results、instances、容量／連線狀態 | 每個query另驗tenant角色、module scope、resource ACL；guild membership不是私人ACL |
| 會長／受委派管理 | 修改使命文案、核准元件、推薦排序、公開任務／公告與配置草稿 | 該guild職務或具名content capability；不給tenant清單、CRM、訂單、私有草稿 |

public/member/my/admin response分開，不用一個包含全部資料的JSON再讓前端隱藏。切公會保留目前tenant選擇但不默認改tenant；切tenant清前租戶資料再載入。沒有tenant者走SP-02簡化建立，不要求所有公會各建一個tenant。

### 2.3 用途配置：所有18 key加動態fallback

每列第一版都是同一套Work→note/attachment→Result持久流程，只提供不同的空白欄位說明，不生成假顧客、成交、任務進度或成果。

| guild_key | 預設starter名稱／客製提示 | 可後續深化，非其他公會的gate |
|---|---|---|
| `guild_talent_direction` | 私人方向筆記；目標、下一步 | 經本人同意的定位／陪跑 |
| `guild_member_operations` | 新人支援／活動準備 | 培育、交接與容量 |
| `guild_platform_engineering` | 問題重現／規格筆記 | 受治理Issue/PR/review |
| `guild_ai_vibe` | 開源作品需求／驗收 | 經授權開發工具 |
| `guild_ai_field` | 導入測試計畫 | 部署驗證、授權整合 |
| `guild_ai_project` | 範圍／里程碑／交付 | 專案模組 |
| `guild_opportunity_partnership` | 合作需求紀錄 | CRM／經同意媒合 |
| `guild_product_quality_supply` | 商品／供貨檢查清單 | 版本化供貨、inventory |
| `guild_commerce_sales` | 選品／營運待辦 | 現有agent-commerce domain |
| `guild_commerce_settlement` | 商家對帳步驟／證據索引 | 自有收款整合；非平台代收 |
| `guild_marketing` | 內容草稿／發布計畫 | 本人外部帳號及排程 |
| `guild_media_automation` | 腳本／素材與剪輯brief | 渲染、媒體工具 |
| `guild_security` | 授權範圍／檢查證據 | 受授權的安全整合 |
| `guild_music_mv` | 歌曲／MV構想與素材來源 | 聲音、影像製作 |
| `guild_commercial_production` | 拍攝brief／分鏡／交付 | 專用製作工具 |
| `guild_event_space` | 場地brief／動線／備援 | 活動場地配置 |
| `guild_projection_mapping` | 場勘／投影分區／cue表 | 播放和視覺工具 |
| `guild_human_design` | 共讀來源／限制／反思 | 探索工具；不作醫療或能力判斷 |
| 任何新有效guild | 「我的第一個工作」；title/objective/note/attachment | 無需新增前端分支，管理者之後可預覽發布配置 |

依賴SP-01/02的介面與SP-04/10最小manual-work profile；SP-06提供Asset/R2隔離。分類審查、ERP hosted、所有application/license審查、外部遷移、AI不是全部公會shell與基礎manual-work交付前置。可用功能分能力啟用，未驗深度應用只影響自己的卡片。

非目標：新Agent平台、每人複製公會站、任意JS/SQL/plugin、把社群Work看板改為私有資料庫、以公版建立正式買家checkout、宣稱所有附件格式已支援。

### 2.4 非商務製作企劃與版本工作台 v0

`guild_commercial_production` 在同一 tenant Work 入口深化為「建立製作專案 → 結構化 brief／交付規格／鏡位 → 素材版本 → 交付清單／回饋 → 重新登入續作」。[內容格式與實作邊界](../../../../modules/guild-workspace/production-dossier.md) 的 `freedom.production-dossier/v1` 是既有私有 Markdown Result 的 typed profile；沒有新增 HTTP 契約、module release、project core 或 commerce/order，Work domain／instance／ACL 仍由 SP-10／04／02 負責。

同 Work 的文字素材引用固定 Result ID、revision、digest；外部照片／影片只保存 HTTPS 位置與自填版本，原始媒體 bytes 不在此 v0。交付記錄凍結所選版本，回饋指向確切交付版本；自填負責人、使用權、交接和外部回饋不等於驗證身分、收到證明、客戶核准或公開發布。NP-M 原檔媒體與 NP-R 真正客戶核准維持獨立後續範圍，不阻擋普通私人文字 v0。

所有 Result 共用 revision 序列，reader 驗原 bytes/digest 後按分頁辨識最新製作內容，且綁同一 Work source version；未知較新 profile／損壞／版本變動時保留原文與草稿並停用覆寫。Work 建立與首份 Result、附件保存與引用登記是分開命令，後一步失敗續用既有 ID；不宣稱原子完成。412 保留草稿供與伺服器比較。UI 將 instance 可寫狀態與會員當前 capability 分開，唯讀 viewer 不出現寫入入口，具明確同 instance Result 寫權的 operator 可保存製作版本。這些本機候選行為與部署／live 驗收證據分開。

## 3. 現有程式對照與 KEEP／MODIFY／NEW／GENERATED，精確到實際檔案

| 動作 | 精確路徑 | 範圍／基線限制 |
|---|---|---|
| KEEP | `DESIGN.md`、`apps/portal-web/src/rpg-theme.css`、`apps/portal-web/src/styles.css`、`apps/portal-web/src/light-theme.css`、`apps/portal-web/src/versefolk-theme.css` | 原品牌與tokens；不另造設計系統 |
| MODIFY | `apps/portal-web/src/modules/GuildCard.tsx`、`apps/portal-web/src/modules/PositioningPanels.tsx`、`apps/portal-web/src/modules/GuildWorkspace.tsx`、`apps/portal-web/src/modules/GuildWorkspace.css` | 原guild卡、管理入口對接shell；目前GuildWorkspace處理職務/公告/技能編修，不是private tenant workspace |
| MODIFY | `apps/portal-web/src/App.tsx`、`apps/portal-web/src/Navigation.tsx`、`apps/portal-web/src/page-help.ts` | 保留既有hash入口，新增具名launchpad路由與說明 |
| MODIFY | `modules/guild-workspace/service.ts`、`apps/platform-api/src/routes/guild-workspace.ts` | 重用公告、member/leader資格；補public-safe projection與config handler |
| KEEP | `modules/opportunity-project-work/work.ts` | 現有community collaboration Claim/Review/Benefit，不向公版私有工作借用 |
| MODIFY | `modules/opportunity-project-work/private-work.ts`、`modules/opportunity-project-work/private-commands.ts`、`modules/autopilot-work/results.ts`、`modules/autopilot-work/policy.ts` | personal branch保持；具名tenant profile，Work與Result不另建競爭真相 |
| MODIFY | `modules/assets/engine.ts`、`packages/asset-storage/profiles.ts` | tenant-safe human Result/attachment purpose、原子target finalize與quota；SP-06擁有資產約束 |
| NEW（建議） | `modules/opportunity-project-work/tenant-work.ts`、`apps/platform-api/src/routes/tenant-work.ts`、`contracts/modules/v1/tenant-work.ts` | 與SP-10同一實作責任／canonical source，不重複檔 |
| NEW（建議） | `modules/guild-workspace/launchpad-config.ts`、`modules/guild-workspace/launchpad-view.ts`、`contracts/guild-launchpad/v1/config.ts` | strict config schema、版本解析、分視圖query |
| NEW（建議） | `apps/portal-web/src/modules/GuildLaunchpad.tsx`、`apps/portal-web/src/modules/GuildLaunchpad.css`、`apps/portal-web/src/modules/TenantWorkPanel.tsx` | 共用shell、manual工作UI |
| GENERATED（未建立） | `contracts/guild-launchpad/v1/config.schema.json`、`contracts/modules/v1/tenant-work.schema.json`、`packages/sdk/guild-launchpad.d.mts` | typed schema／SDK生成，不手寫 |
| NEW（logical migration） | `migrations/<next>_guild_launchpad_config.sql`、`migrations/<next>_tenant_work_profile.sql` | 名稱為待實作分配的邏輯描述，沒有預占SQL號碼；不改歷史077/081/084 |
| MODIFY | `tests/runtime/guild-workspace.test.ts`、`tests/runtime/private-work-commands.test.ts`、`tests/runtime/private-results.test.ts` | 既有邊界回歸 |
| NEW（建議） | `tests/runtime/guild-launchpad.test.ts`、`tests/runtime/tenant-work.test.ts`、`tests/e2e/guild-launchpad.test.ts` | 全catalog覆蓋＋真實保存重開／跨tenant |

`apps/platform-api/src/routes/private-work.ts`目前read-only；`private-work-transport.ts`提供closed human personal transport與policy/R2前置，不能把檔案存在當tenant與正式發布已驗。基線`ResourceScopeRef`/DB沒有tenant，需SP-02增量擴充。

## 4. 資料模型、唯一性／關聯／tenant scope、owner／authority、版本與敏感欄位

### 4.1 Config（新增提案）

`guild_launchpad_config_revisions(config_id UUID PK,community_id,guild_key,revision bigint>0,schema_version,body JSON,body_sha256,status draft|published|superseded,source platform_default|guild_editor,created_by_principal_id,created_at)`；UNIQUE `(community_id,guild_key,revision)`；published pointer另表 `(community_id,guild_key) PK,config_id FK,pointer_version)`。revision immutable，回復為建立新revision／指向已驗舊body，不倒退version。draft不得出public cache。

`guild_launchpad_delegations(community_id,guild_key,principal_id,capabilities,expires_at,version,status)` 只可委派`guild.content.edit|guild.config.preview|guild.config.publish`；grantor current guild leader、期限／撤銷DB驗證，不能給tenant capability。委派publish是否需leader保留可由policy再縮，不能比上層擴權。

配置繼承順序：平台安全預設→已發布guild內容→tenant個人化的顯示排序。安全/schema、必備manual-work入口、資料ACL及支援來源不能被低層覆寫。tenant overrides另存`tenant_launchpad_preferences(tenant_id,principal_id,guild_key,version,body)`且只有呈現欄位；不把私人偏好公開。

必備block：mission、announcements、skill_books、applications、community_tasks、my_work、support。公版合法default從有效guild catalog即時計算，無DBconfig row也可用；getter不順便寫入一份站台或建立tenant。預設ConfigView.config_id=null、revision=平台default的pinned正版本、pointer_version="1"、updated_at=null；首次draft/publish在guild advisory lock內驗default revision、以唯一鍵CAS建立pointer，並發只有一個贏，另一412。平台default升級改revision，使舊draft明確重驗，不以重置pointer version掩盖差異。

### 4.2 Work／Result（與SP-10共用）

- 現有`work_items`新增`work_mode='tenant_execution'`，`tenant_id,instance_id,workspace_id,scope_id`同tenant複合FK；`state='draft'|'archived'`，`progress='todo'|'in_progress'|'done'`是普通內容欄位，`version`wire映`aggregate_version`。原personal/community discriminators与約束不變。
- `guild_key`僅可選context/source metadata；不能作owner，也不控制讀取。author/created_by可追溯真人，資料owner為tenant，移交owner不更改WorkID。
- note為human Result的`.txt/.md` UTF-8內容；Result revision immutable，保存`result_id,work_id,asset_id,revision,work_version,provenance,content_type,byte_size,sha256,created_at`。附件同一Asset engine保存實際bytes；不同Result呈現為筆記或附件，不建立第三套blob store。
- Asset target、purpose、scope與Work複合FK；上傳intent/lease/fence/verified/finalize按既有engine。新的tenant profile不能直接放寬原private個人purpose去讀別人asset。
- `current_result_id`是UI最新版本pointer；歷史Results保留可讀，依私有ACL。保存note不生成社群投稿、公開作品、Claim、QC、Contribution、XP、Benefit或支付義務。

Work全文／附件／private搜索詞屬tenant private；公開或公會公告只能引用另經正式發布流程授權的public Result projection。本spec不提供一鍵公開，以免混淆保存與發布。資料責任DC-02/03/06/13/14/15；config rollback不rollback任何Work/Result bytes。

## 5. API／command／query／event 的完整輸入輸出、錯誤、身份、冪等及並行語意

### 5.1 共通wire與配置schema

UUID、Version、Digest、Page、Operation、Problem沿[contracts](contracts.md)。命令strict、session/CSRF、key8–128，修改If-Match；body不接受actor/owner/role/scope/grant。public與private路由分離，private no-store/noindex。

```ts
type Config = {
 schema_version:'guild-launchpad.config/v1'; guild_key:GuildKey;
 mission_override:string|null; // <=1200 UTF-8 bytes
 blocks:{id:StableKey;kind:'mission'|'announcements'|'skill_books'|'applications'|'community_tasks'|'my_work'|'support';
   order:number;enabled:boolean;title:string|null}[]; // exactly each mandatory kind once, <=7; no script/HTML
 application_refs:{application_key:StableKey;release_ref:string;order:number}[]; // 0..30 approved refs
 starter:{title_label:string;objective_hint:string;note_hint:string}; // each <=480 bytes
 support:{kind:'platform_help'|'guild_public_contact';public_url:string|null};
 extensions:{}; // v1 has no approved extension namespace, nonempty rejected
};
type ConfigView={config_id:UUID|null;revision:Version;pointer_version:Version;
 source:'platform_default'|'guild_editor';status:'draft'|'published'|'superseded';
 body:Config;body_sha256:string;updated_at:string|null};
type Eligibility={can_launch:boolean;reason_codes:string[];required_guild_tier:'full';
 tenant_action:'select'|'create'|'continue'|'denied';policy_revision:string};
```

order為0..1000整數且同list不重複；block title為null或1..120字/480 UTF-8 bytes；各starter欄位均≤480 bytes，嚴格禁止控制字元／孤立surrogate。`public_safe_config`固定為Config去除extensions（必空），application_refs只保留available且允公開的release，其餘欄位無私人值；不是任意spread ConfigView或tenant overrides。

`enabled=false`僅可對無內容的公告／公共任務／非必要application卡；平台規則仍顯示mission/skill/my_work/support，不能以config隱藏必要錯誤或私有入口。`public_url`僅HTTPS無credentials、拒javascript/data/file、長度≤2048；只作連結不由server自動fetch。component enum不能變成module importer。

### 5.2 Shell與管理API（proposed）

| endpoint | 完整輸入 | 成功輸出／授權 |
|---|---|---|
| GET `/api/v1/public/guilds/:guild_key/launchpad` | `{}` | `{guild:{guild_key,name,purpose,category\|null},config:{revision,body:public_safe_config},announcements:public_entries[],skill_books:public_book_refs[],public_results:public_refs[]}`；全部顯式public欄位，不從member全文裁切 |
| GET `/api/v1/guilds/:guild_key/launchpad` | `{}` | `{guild:{guild_key,name,purpose},config:ConfigView,membership:{state,member_tier},announcements:member_entries[],skill_books:book_refs[],applications:{application_key,release_ref,eligibility:Eligibility}[],community_tasks:public_or_member_task_refs[]}`；active guild member；只published config |
| GET `/api/v1/tenants/:tenant_id/workspaces/:workspace_id/launchpad-context` | `{guild_key:GuildKey}` | `{tenant_id,workspace_id,source_version:Version,instances:ModuleInstance[],work_page:Page<Work>,capacity_summary:{policy_revision,used,reserved,limit},connection_summary:{instance_id,status}[]}`；tenant membership+每instance ACL；不得查任意tenant |
| GET `/api/v1/guilds/:guild_key/launchpad-config` | `{revision?:Version}` | `ConfigView`；current leader/delegate；無draft時回合法預設 |
| POST `/api/v1/guilds/:guild_key/launchpad-config/drafts` | `{body:Config}`＋pointer If-Match | 201 `ConfigView`；editor；來源/actor由server填 |
| POST `/api/v1/guilds/:guild_key/launchpad-config/preview` | `{body:Config,preview_mode:'public'\|'member'\|'my_work'}` | `{effective_config:Config,validation:{code,path}[],preview_data_origin:'synthetic_fixture'}`；editor；my_work preview只用fixture，不讀會員tenant |
| POST `/api/v1/guilds/:guild_key/launchpad-config/:config_id/publish` | `{expected_body_sha256:string}`＋pointer If-Match | `ConfigView`；publisher；重新驗schema/capabilities/application release refs，CAS發布pointer |
| POST `/api/v1/guilds/:guild_key/launchpad-config/revert` | `{to_revision:Version,reason:string(3..1000)}`＋pointer If-Match | `ConfigView`（新修訂）; publisher；重驗舊body在當前schema/安全規則合法，不變業務資料 |
| POST `/api/v1/guilds/:guild_key/launchpad-delegations` | `{principal_id:UUID,capabilities:('guild.content.edit'\|'guild.config.preview'\|'guild.config.publish')[],expires_at:string}` | `{delegation_id:UUID,principal_id,capabilities,expires_at,status:'active',version}`；current leader，receiver必active guild member |
| POST `/api/v1/guilds/:guild_key/launchpad-delegations/:id/revoke` | `{reason:string(3..1000)}`＋If-Match | `{delegation_id,status:'revoked',version}`；current leader；撤銷後不能重播舊draft/publish |

public_entries/book_refs/public_refs/task_refs不由這裡發明新全文結構：明確引用現有公告／skill/Work公開DTO的safe projection，materialization前在canonical source列欄位allowlist。至少公會公告只含`announcement_id,title,body,published_at`，book refs只含`book_id,title,introduction_url,upstream_url`，task refs只含`work_item_id,title,state`且先依原audience驗權，public result refs只含`result_id,title,public_url`且確有公開授權。未有可公開來源時回空陣列，不能改公開scope。

### 5.3 私人Work／note／附件API：引用單一 canonical，禁止複製 DTO

本段由[SP-10 §5.4](SP-10-domain-upstream-integration.md#54-最小-crm-與人工-workresult)唯一定義全部route、strict輸入、capability、Operation／resource輸出；本文UI直接消費該契約，不另造`work:edit`或不同upload response。canonical authoring為提案`contracts/modules/v1/tenant-work.ts`，生成SDK後由UI import。base `/api/v1/tenants/:tenant_id`；Work更新capability固定`work:write`，不是自創別名。

必需完整流程依次呼叫SP-10定義的：POST/GET `/workspaces/:workspace_id/works`；GET/PATCH `/works/:work_id`；POST `/works/:work_id/archive`；POST `/works/:work_id/results/uploads`與GET `/works/:work_id/results/uploads/:upload_id`；PUT其`/content`；POST其`/finalize`；GET `/works/:work_id/results`、單筆metadata及受權`/content`。同tenant workspace/instance server解、same-tenant ACL、If-Match、Idempotency-Key、Page.source_version与共同Operation均以SP-10為準。

以下是與SP-10一致的具體合成測試例，不是第二份schema：

1. POST Work body `{title:"場勘筆記",objective:"記錄合成場地的投影分區",progress:"todo"}`，回Operation成功後GET Work，取得`work_id`與`version:"1"`；不能把operation.version當Work版本。
2. note editor或附件chooser都對實際UTF-8 bytes算SHA-256，POST upload body `{content_type:"text/plain",byte_size:3,sha256:"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",display_name:"note.txt",expected_work_version:"1"}`。bytes為ASCII `abc`，不含換行。成功Operation指向upload resource `{upload_id,asset_id,expires_at,version}`；不是`phase/max_bytes/work_version`替代DTO。
3. GET upload metadata取得`{upload_id,work_id,asset_id,phase,expires_at,version,byte_size,sha256}`。PUT exact 3 bytes到其content route，Content-Length/SHA-256與manifest吻合、If-Match用upload當前version，回`{upload_id,verified:true,version}`。這仍未完成Result保存。
4. POST finalize body `{expected_work_version:"1"}`＋Work If-Match，回Operation→`{result_id,work_id,asset_id,revision,work_version,provenance:"human",content_type,byte_size,sha256}`。GET Result content確認`abc`；登出新session後再次讀取digest一致。網路ACK丟失重播同key不追加revision。

`.txt/.md`是首版真實附件profile；note與附件皆走同一prepare/upload/finalize引擎，display_name≤120 chars且永遠不作object路徑。image/PDF/video須SP-06補MIME／掃描／renderer／quota／restore fixtures後另外啟用，不宣稱所有格式已支援。未有work instance回明確`work_instance_required`，不能fallback community Work。

共同錯誤與重試取SP-10及contracts：strict輸入、未授權target一致404、version_conflict412、version_required428、policy/contract/quota/unknown branches；private error不含其他人的title/tenant存在/SQL/原文。same key不同內容409；replay先current authority，撤權後舊receipt不洩漏。

Work/Result events由SP-10/SP-05單一負責，僅IDs/state/version/ref無筆記全文。配置發布是平台控制面事件`freedom.guild.launchpad.config.published.v1`，payload `{guild_key,config_id,revision}`，沿既有scoped journal/outbox profile，不捏造tenant/source_instance_id套module envelope；只觸發公開配置cache失效，與私有Work outbox隔離。

## 6. 狀態機與成功、失敗、結果未知、重啟、撤權、版本不符及部分完成分支

- config `draft→published→superseded`；preview無副作用；publish失敗舊published保持。revert新版本不能越過最新安全schema；含已撤application時提示該卡不可用，其他必備block保留。
- shell資料源之一失敗採局部error，公共內容可繼續；private Work讀取失敗不回傳舊tenant cache，不用公會內容假冒私人工作。
- Work draft進度可改；archive終態保留不刪；progress done不作社群正式驗收。tenant Work不能以修改work_mode變成public/personal。
- upload按原Asset intent→claim/writing→verified→finalized，expired/failed/quarantined分支沿SP-06。bytes寫成功DB finalize失敗需查原intent，不重複reserve；late PUT以fence阻止attach。
- Result save ACK丟失：保留Operation/key/upload_id，查server後才顯示已儲存；重啟取得同一Result。半成品bytes計入reserved/retained usage，依policy清理，不因UI取消立即當不存在。
- 撤guild職務立即停止config publish；撤tenant membership立即拒Work read/update/upload/finalize/replay，包括storage I/O途中。guild leave按SP-11影響啟動資格但不是Work ACL撤銷。
- schema不支援時保留上個可安全渲染published default，顯示明確版本問題；不能執行未知component或靜默丟掉私人擴充資料。client欄位不相容寫入拒422。

## 7. UI、可見性、空狀態、載入／失敗、手機、無障礙與人工接手

沿DESIGN原Logo、tokens、sidebar/手機同導覽；一頁一h1「{公會名稱}」，不大圖擠掉操作。共用區顯使命/公告/技能/任務；私有區明寫「{tenant}／{workspace}」，其上有可鍵盤操作selector。已存在相容instance顯「繼續工作」，不一直推「建立」。空狀態可直接輸入title/objective保存，沒有AI連線不擋。

顯示保存分三階：未儲存文字、上傳中／核對中、Result finalize已儲存（帶時間/revision）；自動保存若未另定權限不做，第一版明確保存。關閉dialog/Back須處理未存文字；不因切tenant自動把A草稿送B。若離線可留目前記憶體草稿并提示，不能把localStorage當雲端完成；裝置持久草稿需另明定privacy。

每guild可顯不同starter文字；不是假preset客戶/完成數。外部SIM卡標「外部試用／模擬」、未知來源卡標待驗，不能和正式可用manual Work混同。對無full資格者顯現行升級說明，閱讀/聊天與個人既有合法資料不受影響。

360px手機表單16px以上、控制44px、長guild名換行；有keyboard/tab序、focus-visible、label/error關聯、aria-live，modal Esc/關閉返回原焦點、reduced-motion。路由A→B使用request generation＋abort及tenant-scoped cache，遲到響應丟棄。權限403提供切回有權tenant或聯絡其owner；不要求聯絡公會長取得別人業務權。

## 8. 資料匯出／匯入／升級／清理／回復及 legacy 相容；不適用需寫理由

- 保留現有guild_key、會員tier、grant、公告ID與hash路由；launchpad是附加view，不把公告全文搬進所有tenant。
- Config匯出包含schema/version/source/完整公開配置與允許tenant個人化；不含delegation secret（本規格根本沒有）、私人preview、會員名冊。導入schema驗證／ref解析後作draft，不能直接publish或擴權。
- tenant Work包由SP-07帶Work metadata、progress、Result歷史、Asset原bytes/digest、必要config/context refs；不只CSV。只帶該tenant/instance，不帶guild完整成員／其他tenant。
- existing personal Work不能自動改tenant owner：其identity trigger本來禁止重分類；若本人將來要求搬成tenant工作，需明確copy/transfer專用設計與新的stable identity mapping，不能直接UPDATE work_mode。本輪不默默處理。
- 恢復config只恢復布局；Work恢復需一致Result metadata/object pins、policy及撤權floor。外移Work後中央只留必要ref/status，不留私人筆記、搜尋全文或通知excerpt。
- 暫存上傳/替代Result/歷史附件保留與GC依SP-06 policy；archive不是刪除、rollback config不是抹除Result；未確認清理範圍與備份期限不能說已全部刪除。
- 舊guild pages無新tenant參數仍可讀公共/member內容；舊private endpoints沿原personal profile，不能解釋成「目前選定tenant」。

## 9. 威脅模型、最小權限、秘密、外部入口、cost／capacity 與安全反例

config XSS/任意script/remote import/SQL與權限文字注入：enum+strict schema+pure text render，拒不可信程式；portal不iframe任意應用，外連noopener/noreferrer。public cache與private API完全不同；cache key不得只guild_key而省tenant/actor。配置preview的sample必合成且標記，不查私人CRM來「看看效果」。

資料外洩負例含完整URL、猜ID、搜尋、HEAD/Range/304、縮圖、舊Result、upload metadata、錯誤／logs、晚回request。server在I/O前後重驗ACL；沒有對象公開URL可直接分享。module讀寫與quota不依guild頁顯示順序或主力。

推荐有限測試profile：每page50工作、每tenant1000Work、Result文字256KiB、config32KiB、7blocks/30apps；DB statement5秒、private聚合query2秒目標；實際storage/member/instances限制由OPEN-04/13/16定。沒有policy不接受新的昂貴上傳；合法讀、未完成intent查詢、人工取消不全站停用。初版不呼叫LLM、不外送筆記作分類／推薦。

## 10. 可重現 fixtures、測試環境、T-ID 驗收、發布條件、證據與未完成項目

fixture：有效catalog從DB列舉，含18內建＋新核准guild＋pending classification；每guild無config／合法config／撤銷應用各情境。A/B tenant各不同私有字串「A-only-note」「B-only-note」，會長M不屬A，full F在非主力公會，intern I；無模型連線、無AI授權。ObjectStore合成fixture與真R2 staging驗證分列，不能用FakeObjectStore聲稱真bytes durability。

| T-ID | 操作／注入 | 必須結果及證據 |
|---|---|---|
| T-004 | runtime讀有效catalog逐一開頁；新增第19個custom無前端修改 | 全部解析合法default、必備controls存在；分母與coverage JSON一致，無手列18完成 |
| T-005 | 每類至少一guild完整建tenant/instance→Work→note→實際txt附件→finalize，登出/新session重開 | title/progress/note/bytes/digest/Result revision一致；不是localStorage或外鏈；其餘全部guild以同profile contract覆蓋 |
| T-006 | 陌生人、同guild他人、會長讀A detail/list/search/history/content | 統一404/403，public/member response不含A字串/tenant name/count；cache/error掃描 |
| T-007 | M編config成功後猜AWork/instance | 私有操作仍拒，不借leader preview讀A |
| T-008 | 同tenant從第二guild進manual-work | 續用同instance與資料，無重複Work/DB配置 |
| T-012 | preview、publish競態、revert；script/未知component/惡意url/越權scope | schema拒絕不執行；舊published保持；revert後Work數/digest不變 |
| T-018 | 超文字/Work/config配額、兩tab同時upload | 原子quota不超，舊資料可讀，失敗無「儲存完成」 |
| T-023 | 實際txt/md bytes上傳、錯digest、late PUT、跨tenant upload_id、HEAD/Range猜URL | 正確bytes可重開；錯誤不能attach；I/O中撤權即拒read/finalize |
| T-051 | 無模型設定與AI完全關閉保存全流程 | 人工成功，網路無LLM請求、grant/模型key沒有被要求 |
| T-055 | 360px/1280px三主題，鍵盤、長名、空/錯誤、Cancel/Back、A→B故意延遲A回應 | 無溢出、focus可用、B從不閃A內容；草稿不錯存 |
| T-057 | 只shell部署、storage policy關閉、特定深度應用失效 | 分別標已可看／保存未啟用／應用不可用；不宣稱全功能完成，不擋其他公版 |

未來實作實跑：typecheck/build/runtime/contracts/e2e；UI build必在瀏覽器前；postgres isolated schema及application DB role；真R2 bytes讀回需獨立授權測試環境。證據包含exact head/schema/policy/release refs、全catalog快照、瀏覽器desktop/mobile screenshot、Result bytes digest、重啟/unknown ACK、no-AI與cross-tenant負向trace。

本文件只完成規格，以上測試未在本輪實跑。發布門檻：SP-02 tenant scope、SP-04 manual-work app、SP-06 tenant Asset policy、SP-10 Work/Result聯通與T-005實測全部通過；至少一條真保存重開才可標「公版可用」。可先交所有guild shell/fixture但不得當最低功能完成。未完成：程式/migration/DTO生成、正式config authoring/委派policy、容量定值、真ObjectStore及UI證據；ERP等專属深化分開排程，不能令其他公會無入口。
