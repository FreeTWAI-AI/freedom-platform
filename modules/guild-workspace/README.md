# Guild workspace

The launchpad reads published guild configuration and computes a platform default when no usable revision exists. Leaders and delegates save immutable drafts, preview them, publish with pointer CAS, and revert by creating a new revision. Public configuration passes through `publicSafeConfig`; guild content authority grants no access to tenant Work.

`launchpad-profiles.ts` defines purpose profiles for `guild_commerce_sales`, `guild_commercial_production` and `guild_talent_direction`; every other guild keeps the existing block order and empty recommendations. Default `application_refs` come from offered releases in the viewer's scope. `PLATFORM_DEFAULT_REVISION` pins default content at `4`, while `DEFAULT_POINTER_VERSION` keeps the initial pointer CAS at `1`. The primary application is the first application returned by `recommendedApplications` for the rendered configuration.

The commerce purpose profile recommends 「線上商店」 first, followed by the existing manual workspace; the production profile keeps manual workspace first.

The portal parses `#guilds/<key>` in the UI-free `guild-launchpad-route.ts` helper. The public launchpad loads through `React.lazy` under App's existing `PageLoadBoundary`; the member launchpad remains inside the lazy guilds panel. `GuildLaunchpad`, `GuildLaunchpadMyWork` and `GuildLaunchpadApplications` are not part of the initial index chunk.

## 製作專案企劃與版本工作台

`guild_commercial_production` 的既有 My Work 區塊提供結構化 brief、交付規格、鏡位、素材版本引用、固定交付清單與對應回饋。專案沿用唯一 tenant `work_id`；[production-dossier.ts](production-dossier.ts) 定義 `freedom.production-dossier/v1` **Result 內容格式**，不是新增 API、module release 或 project 資料庫。[格式與限制](production-dossier.md) 對應 [SP-03 §2.4](../../docs/platform-plan/execution/guild-launchpad/SP-03-all-guild-launchpad.md#24-非商務製作企劃與版本工作台-v0)。

`GuildLaunchpadMyWork.tsx` 保有租戶選擇、Work／Result 命令與離開草稿保護；`ProductionProject.tsx` 只編輯具型別欄位，`work-result-save.ts` 是同一套 prepare／PUT／finalize checkpoint 流程。reader 先驗原始 bytes（含 BOM）的大小與 digest，再辨識內容；跨頁、續讀與採用前綁同一 Work `source_version`。遇未知格式、損壞或版本改變便鎖定並保留草稿，不退回較舊文件覆寫。

部署／instance 可寫狀態不代表會員有寫權。製作 UI 另依 `TenantView` owner/admin template 或同 instance 的明確 capability 分別呈現 create、metadata、archive、Result 寫入操作，API 每次仍驗當前權限。只有 `work:read` 的會員可讀原資料與下載；普通 operator 的 `work:result.write` 不變成 Work metadata／建立權限。

文字附件使用既有私有 Asset；原始照片／影片只登記外部 HTTPS 位置與自填版本，沒有保存媒體 bytes。交接、外部回饋、負責人與使用權說明都是填寫者的私人紀錄，不是外部身分驗證、收到證明、客戶核准或權利核實。沒有外寄、公開或新 commerce/order 權威。

純 source 回歸為 `tests/runtime/production-dossier.test.ts` 與 `work-result-client.test.ts`；真 API 保存／重登、partial recovery、412 草稿與 viewer／明確授權 writer 的本機 browser 路徑在 `tests/e2e/guild-launchpad-my-work.spec.ts` 的 NP-003／004。實跑與部署證據分列，不把本機 fixture 當 live 驗收。

## 我的方向卡

`guild_talent_direction` 的 My Work 提供本人填寫的[方向卡](positioning-action-card.md)，沿 `career-guide` 的小活動、完成條件與回顧步驟。`freedom.positioning-action-card/v1` 是同一 Work 的 immutable 文字 Result 內容格式，不是另一份會員定位、資料表或 API。可保存半填草稿並重新登入還原；不自動複製 assessment、小問答或私人補充筆記。資料沿目前業務空間與 Work 讀取權限，不因加入公會而公開，也不把共享空間說成只有本人可看。

方向卡的預設入口把「我的工作」及技能書提前，僅在當前 scope 實際提供
`manual-workspace` release 時推薦該 exact pair。主要動作「前往方向卡」只捲到並聚焦
下方原有工作區；會員選擇有權使用的空間，再建立新卡或開啟原卡。沒有空間／instance
仍走原有建立空間／啟用手動工作，訪客與實習成員不取得工作權限。下架 offering 不生成
替代推薦；已存在的 Work 存取仍由原 API 判定。

平台預設內容 revision 4 對所有平台預設視圖生效，pointer CAS 仍從 1 開始，
config schema v1 不變，沒有資料庫 migration。SP-03 §2.3 的 v0 原文保留；本次人才
default starter 使用已提供的方向卡說明。會長已發布的 starter、block order 及推薦
exact refs 仍是權威，不在讀取或呈現時改寫成平台預設；製作與其他公會的既有內容不變。
