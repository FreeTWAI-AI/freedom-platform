# 公會区塊開發入口

會長的文字、順序、顯示選項走現有啟動台後台；新增呈現元件才改程式。
供貨商品與作品仍由原領域 API 保存。這裡只提供呈現介面，沒有新應用目錄、
登入、資料表或權限。新增業務操作、契約、ACL 或資料結構須由領域維護者整合。

## 先看到一個實際畫面

在 repo 根目錄使用 Node 24 以上與既有 lockfile 安裝依賴，再執行：

```sh
npm ci
npm run guild:preview
```

開啟 `http://127.0.0.1:4487`。此入口沒有 API proxy，只有明示的合成資料；
不需要 PostgreSQL、備份 operator、GitHub、R2 或正式秘密。切換訪客、正式會員、
唯讀成員、空資料、403、404、503、載入中與三種外觀。導覽與建立按鈕只記錄
預覽動作，不會發送命令。主機 watcher 額度不足時可用
`GUILD_PREVIEW_POLL=1 npm run guild:preview`；不要提高整台主機限制。

兩個實際樣板：

| 自己維護的目錄 | 原領域介面 | 模組責任 |
| --- | --- | --- |
| [guild-supply](../../modules/guild-supply/README.md) | `/me/supply-catalogs?pagination=cursor` | 顯示目前可讀的供貨商品庫，返回原供貨頁；建立交給既有應用流程 |
| [guild-open-source](../../modules/guild-open-source/README.md) | `/me/content` | 顯示作品與技能投稿的不同狀態，返回各自管理入口 |

## 新增自己的區塊

1. 在 `modules/<自己的模組>/` 放元件、測試與既有格式的 `freedom.module.json`。
   從上述樣板開始；元件接受 [GuildBlockProps](block.ts)，匯出 `default` 與 `title`。
2. 在該 descriptor 的 `surfaces` 加一個 `guild-block.<名稱>.v1` page，
   `entry` 指到自己擁有且列為 `public_exports` 的元件，`operations` 宣告既有 API
   操作，`auth_profile` 是 `member-session`。`dependencies` 包含呈現 SDK 與實際領域。
   這些是影響範圍與審查資料，不能授予權限。
3. `node scripts/generate-guild-blocks.mjs` 從同一批 descriptor 產生兩份投影：
   瀏覽器的靜態 lazy import 與伺服器的核准 ID 清單。不要手改產物或另建 manifest，
   不需要在 `App.tsx`、`GuildLaunchpad.tsx` 新增公會判斷。
4. 使用 `useGuildRead` 處理目前 session、abort、晚到回應、載入、空資料、無權限、
   關閉與暫時錯誤。公會成員等級只是呈現提示；伺服器仍逐次檢查真正資料權限。
   訪客不讀取私人 endpoint。未知區塊顯示不可用，元件錯誤保留其他區塊與重試入口。
5. 跑自己的測試與共同契約，再提交可審查 PR。元件程式會隨主站 build 執行，
   必須經平台 review；錯誤邊界不是安全沙箱，不接受任意 JavaScript 或遠端載入器。

## 適用的本機驗證

```sh
npm run typecheck
npm run guild:check
npm run guild:test -- modules/guild-supply
# 或自己的另一個樣板
npm run guild:test -- modules/guild-open-source
```

`guild:check` 檢查登錄產物、嚴格 v1／v2 契約、未知版本與訪客呈現。
`guild:test` 建置專用預覽後跑模組內的 Playwright 測試，不啟動資料庫。
三種外觀、390／768／1440px、正常／空／拒絕／錯誤與實際導覽都需要核對。
本機預覽不能替代真實 API、撤權、CAS、發布與回復的整合測試。

改共同殼層或組裝契約時，平台維護者還要執行
`tests/runtime/guild-launchpad.test.ts` 與 `tests/e2e/guild-block-composition.spec.ts`、
原啟動台／用途配置旅程；使用獨立磁碟 PostgreSQL，跑完移除自己建立的容器與 volume。
領域變更另跑領域與反向相依測試。不要為此連接正式 DB。

提交前沿 [現有 context／影響工具](../../governance/README.md)檢查 baseline、
candidate、擁有者、依賴及 blockers。**目前正式安裝 CI 仍使用廣範圍驗證**；
上述命令是可用的本機開發路徑，不代表已安裝縮減 CI。可信 selector 的縮減需與完整
結果對照、獨立 review 與安裝；未知路徑、核心或不完整依賴不可自動少測。

## 會長如何使用已審查的區塊

在啟動台「調整版面」選「啟用可組裝版面」，再選「加入公會工具」。
調整標題、顺序與顯示，保存草稿、預覽，再發布。現有 editor／delegate／publisher
權限與版本衝突處理保持有效；一般成員無法保存。草稿不進公開頁。
v1 仍嚴格讀取七區塊，轉換只建立新的 v2 草稿，不改寫已存歷史與 digest；
可從歷史回復已發布的 v1。未知版本不能新保存或發布，舊配置中未知區塊安全顯示不可用。

舊版的供貨、人才與製作主要動作集中在
[相容元件](../../modules/guild-workspace/LegacyLaunchpadPrimary.tsx)，保留既有使用者流程。
新工具使用區塊介面；不要繼續擴充相容元件的公會清單。平台預設版面未被自動改寫。

本輪 Agent 實作與隔離測試不代表真人驗收完成。仍需兩位非核心公會開發者，
各自在自己的目錄交付一次有用的修改，記錄使用入口、適用測試、維護者協助及卡點。
正式部署、相稱 CI 安裝與真人成果分別記錄，不互相替代。


## 公會驗證的對照階段

目前這份 CI 來源新增 `guild-presentation` 固定工作：型別、登錄一致性、入口建置、五個公會 runtime 檔、三個殼層整合 browser 檔，以及兩個公會目錄自己的 preview 測試。完整驗證仍同時執行；合併此來源不代表組織 required workflow 已換 pin，也不代表縮減已啟用。

只改兩個已審查範例的 `CatalogBlock.tsx`／`WorksBlock.tsx`，才是候選縮減範圍。選測器核對基線與候選的完整 descriptor 圖、原始 ownership、公開介面、權限及實際反向依賴，保留共用殼層的整合測試。新增公會、改 manifest／SDK／契約／測試／API、增加消費者或未知路徑，都保留完整驗證。這不是任意新套件的自動核准。

本機不需要資料庫的開發入口仍是 `npm run guild:preview` 與 `npm run guild:test`。平台維護者可用隔離 PostgreSQL 跑 `node scripts/ci/run-guild-runtime.mjs`；`TEST_DATABASE_URL` 必須指向可丟棄的測試庫。CI 的 browser 執行器接受固定 `--guild-presentation` 或 `--guild-preview` 工作，不接受任意檔案清單，逐案例核對列舉與執行結果；選中却未執行、只 skip、零案例、測試程序失敗都不算通過。

安裝縮減之前，必須保存同一版本的完整與公會工作結果、可信 workflow pin 與合併門檻讀回。現階段的對照不能冒稱公會長已走完快速 PR；兩位非核心作者的真實交付驗收仍待進行。
