# 自由工坊共同基礎開發規格

這組 spec 將 [Unified Foundation 1.1 計畫](../../../plans/unified-foundation.md) 轉成可分批開發、審查及驗收的工作。結論是可以依此計畫開發；先交付固定契約與開工工具、相容的身分及交易核心，再完成「會員換頭像」與「本人私人 AI 草稿」兩條完整流程。

版本：`0.2-draft`；查核日期：2026-10-03。已讀完 Unified Foundation 1.1、R2 及 Autopilot 原文並完成規格對照。中央程式查核基準為 `3de70ccbd24362a7925508fb42d36aaa256a0806`；其後已有本機契約 verifier、開工工具、會員相容交易核心及受約束的 person/community/personal 映射。目前另有 scoped member receipt、共用 Asset 引擎、原生 R2 adapter、頭像讀寫相容 bridge、私人 Work 命令、人工 Result 及封閉 Run 內部服務。Run 已接本人建立／讀取／暫停／取消；未驗證 ModelConnection、限定同意 Grant 及 blocked history 之上，另有逐次出口批准、active Attempt／lease、一次性單步派送、私人模型 Asset／Result，以及真實 cookie／CSRF 的本人 HTTP／畫面。加密 broker／外部 recovery 的內部核心已有本機證據；主 API／broker 的用途分離認證橋與真正隔離程序閉環已有本機完整回歸；正式隔離服務、本人 secret ingest、真人 provider／runtime 尚待完成。本機 release 診斷保留歷史 schema/capability 下限。治理包含 host-owned 候選資料驗證、有限入口語法稽核，以及 Kit/Storefront 本機固定來源接入。範圍和測試證據見 [本機交付紀錄](implementation-status.md)；預設仍是 legacy／persistence 關閉，尚非正式新頭像啟用、私人 AI 草稿或完整治理驗收。

## 文件與開工順序

| 文件 | 對應計畫 | 開工狀態 |
| --- | --- | --- |
| [現況與過渡決策](00-baseline-and-decisions.md) | U0、CG-A、UF-09、UF-12 | 三份原文已齊；記錄來源優先序、衝突修訂及剩餘實機證據 |
| [契約發布與開發治理](01-contracts-and-governance.md) | CG-A/B/C/D/F，CG-E/G 的開發工具部分，UX | 可先實作本機 schema、相容 verifier、context 與反例；發布信任及 GitHub 強制需操作證據 |
| [身分範圍與交易核心](02-principal-command.md) | U1、UF-01/02/06 | 可先做 legacy 回歸與相容核心；機器入口待 execution/service 驗證器接妥才開放 |
| [資產與私人工作](03-assets-private-work.md) | U2、U4、UF-03/04/10 | 依 U1 介面實作；私人寫入須等讀取矩陣通過 |
| [執行端與發布收尾](04-execution-adapters-release.md) | U3/U5/U6/U7、UX、CG-G | 共用 attempt、broker、queue、migration 及恢復邊界 |
| [七類媒體搬遷](05-media-migration.md) | R2 RS-00–06/10/11、U6/U7 | 完整搬遷程序；正式資料盤點與 cloud/restore 實測另做 |
| [Autopilot API 與瀏覽器](06-browser-runtime.md) | AP M0–M6/T0–T5、U3/U5 | API/auth、MV3/native/neo guard、journal；實際 source audit 與 capability 另做 |
| [Runtime 金鑰登錄](07-runtime-enrollment.md) | U1/U3、AP AUTH 前置 | 封閉會員批准、真實金鑰持有證明及撤銷；不是完整 device flow 或機器執行授權 |
| [機器連線與 bootstrap 驗證](08-agent-connections-bootstrap.md) | U1/U3、AP §1.5／4.3 | 會員連線 backing record 與獨立 token／DPoP 加密組件；目前身分／nonce 原子驗證接線另列 |
| [Bootstrap 即時驗權與防重播](09-bootstrap-status.md) | U1/U3、AP AUTH-13 | DB 目前身分、單次 nonce／proof ID admission；只回最小 status，不授 Grant／Attempt 或模型權 |
| [裝置配對與一次性 bootstrap 交換](10-device-authorization.md) | U1/U3、AP §4.3／AUTH-13/14/15 | 短效代碼、本人核准、真正裝置 proof 及受限 issuer；目前交換依 11 同交易建立 refresh family |
| [Bootstrap refresh 與重複 nonce admission](11-bootstrap-sessions.md) | U1/U3、AP §4.3／AUTH-13/14/15 | 一次性輪替、重用撤銷 family/connection、獨立用途 machine nonce；沒有 HTTP／正式信任或 execution 權 |
| [Bootstrap HTTP 配對與登入邊界](12-bootstrap-http.md) | U1/U3、AP M2／§4.3 | 配對／refresh／nonce／status 的封閉 HTTP factory 與 Node product 明確安裝 port；預設 Node／Worker 仍未啟用 |
| [本人模型選擇、限定 Grant 與封閉 Attempt](13-member-execution-prerequisites.md) | U3、AP M1/M2/M3 | 真正 backing records、限定會員同意與 blocked history；模型認證／adapter 仍待做 |
| [本人執行前置紀錄的封閉 HTTP 邊界](14-member-execution-http.md) | U1/U3、AP M2/M3 | 真實會員 cookie／CSRF、exact origin／CAS、bounded JSON 與獨立限流；Run／模型選擇／Grant／blocked Attempt 的 factory，正式入口與模型執行未啟用 |
| [三條模型 adapter 核心](15-model-adapter-cores.md) | U3、AP M2/M3 | Codex／Claude 訂閱及 BYOK 平行 codecs、受限 candidate 與隔離 metadata；真實認證、有效 policy 及 operational dispatch 仍待做 |
| [私人單步模型與 Result](16-private-model-step.md) | U3/U4、AP M3 | 明確出口、active Attempt／lease、一次性派送與私人模型 Result；正式信任來源仍待完成 |
| [私人 AI 會員產品入口](17-private-ai-product.md) | U3/U4、AP M3 | 本人 HTTP／畫面、同意、成果歷史及控制已有本機證據；真正 provider/runtime 驗收未完成 |
| [隔離憑證 broker 核心](18-credential-broker-core.md) | U3、AP M2/M3、UF restore | 加密 custody、固定世代 resolver 與外部 recovery 核心；service binding／秘密 ingest／真人模型仍待接續 |
| [隔離 broker 認證橋](19-authenticated-broker-bridge.md) | U3/U4、AP M2/M3、UF authority | 原始 session command、broker 內原 Step／Result、最後 SQL guard；正式 trust／直接秘密 ingest 待續 |
| [直接 broker 憑證輸入](20-direct-credential-ingest.md) | U3/U5、AP M2/M3、AUTH/OPS/EXT | 主站 metadata handoff、隔離保護表單與原 vault/store 接線；正式 capture/binding/provider 尚待驗證 |
| [本人模型與憑證設定](21-member-model-settings.md) | U3/U5、AP M2/M3 | SQL 本人歷史、模型選擇、replacement 輪替與已安裝 broker 的瀏覽器交接；正式安裝／真人模型仍待驗證 |
| [共同基礎驗收](acceptance.md) | INT-01–28、GOV-01–32 | 60 項原要求，全部 `not_run` |
| [R2/AP 原始驗收](source-acceptance.md) | R2 S/A/M/D、AP AUTH/WORK/EXT/NEO/OPS | 108 項原要求，加 24 條 guardrails/invariants 對照，全部未驗收 |

原有 [execution spec index](../spec-index.md) 的 FND、BLD、WRK、AGT packages 繼續保留。本組為增量規格，不將 2026-09 的歷史 planning 列改成 implemented。`UF:INT-01` 表示統一計畫的 INT 驗收，避免與既有 `INT-01` LINE integration package 混淆；原始需求 ID 不重新編號。

來源優先序：Ted 的當次安全/操作限制 → 本輪明列的相容修訂 → Unified Foundation **1.1** 的整合決策 → R2/AP 詳細設計。1.0 unified Markdown/HTML 是舊版，不覆蓋 1.1；AP Markdown/HTML 是同份設計的不同格式。原文快照只作可追溯參考，修訂集中在本組 spec，不平行維護三套政策。

## 首批交付

第一批為三個可分別審查的 PR 範圍，實際 PR 尚未建立：

1. **契約及治理資料**：新增 ReleaseSet、module descriptor、context/report schema 與合成反例，保留 preview v1 的 bytes 及取用方式。先完成本機驗證；沒有可信發布證据時回報 unavailable。
2. **開工與檢查工具**：中央共用 `prepare/context/verify`、baseline 與 candidate 的影響聯集、legacy surface 清單，以及 platform、Agent Kit、storefront 三倉的固定版本測試。
3. **相容交易核心**：保留既有 `command()` 介面、digest、receipt、鎖順序及驗權時機，加入 neutral ports 與 principal/scope 映射，先驗真人會員流程。

可信 CI 的實作與 GitHub 設定跟第一批銜接；它是治理完成條件。上述 PR 不能因尚未完成強制機制就自称已有抗繞過保護。

接著交付 Asset 頭像與 private Work ACL，再把 RunAttempt 與明確模型路徑接進私人草稿。2026-10-03 Ted 已授權 Codex 訂閱、Claude 訂閱及 BYOK 三路平行開發；每位會員實際使用的模型及計費仍須明確選擇。完整共同基礎的完成條件同時包含 A 頭像、B 私人 AI 草稿及治理反例；第一批完成不能取代這三類證據。

發布條件見 [push、merge 與部署檢查表](release-readiness.md)；原 checkout 文件保全與補齊見 [完整性查核](../../verification/2026-10-03-documentation-completeness.md)。

## 開發與交付規則

2026-10-02 Ted 的最新方向是完成原計畫 scope 後做受控前向 migration，不為提早上線另做相容過渡 release，也不把回到舊應用版本作交付目標。資料安全與發布保護仍保留，詳見 [發布決策](00-baseline-and-decisions.md)；目前不變更 staging/live。

Ted 在規格完成後已明確授權由目前 agent 直接實作並持續推進，後續又授權多隻 GPT-6 Astra，之後明確指定 GPT-6.1 Sol 並允許 Grok 4.7 與 Opus 4.6 平行分工，不再要求所有產品程式交給 grok 4.7。派工仍須提供固定 source SHA、此組 spec、可改檔案、預期反例及隔離測試方式；獨立 worktree 避免互踩，共同檔案由整合者負責。此授權不自動包含推送、合併、部署、正式設定或公告。

工作限於 `~/tmp-scratch/fp_work/` 的獨立 worktree。主 checkout 及其 staged 刪除保留。所有 DB 測試只使用本輪建立、名稱以 `fp_` 開頭的 schema 或資料庫；禁止對 `freedom_local.public` 執行 migration、seed 或 truncate。

每個實作 PR 附來源需求、前後行為、實際 SHA、相依 PR、已跑及 `not_run` 項目。合計 168 項原始驗收保留來源命名空間；schema／mock 通過、本機 runtime 通過、真實 GitHub 強制、staging/provider、packaged client、production 的證據分開記錄。缺少 AP 舊附件 ZIP 不妨礙建立正式中央 schema/vectors，但不能引用原作者的樣本 PASS 當本輪證據。

目前仍需每次 push 前重產 inventory 並執行 `npm run verify:inventory`。本機文件產出不等於授權推送、合併、設定 ruleset、簽發 release、部署或發布 Discord 公告。
