# 實際移植後的執行計畫（2026-10-04）

**2026-10-05 06:33 UTC 私人模型增量：** 真實 OpenRouter 已透過本機原生 main／broker Worker 完成一條合成會員流程：獨立 origin 金鑰 ingest、本人配對與精確 Grant、broker 重啟後一次推論、私人 Result 保存與外人拒絕、本人修改另存 human revision、Stop／Revoke／recovery withdrawal。成功來源 `59131aa6`；原始模型成果保留，已完成請求重播不增加 provider POST。四筆真實推論合計 US$0.000206，使用者 US$10 額度另有保守 session ledger。前兩次驗收未完成的原因與修正均保留在[聚合證據](../../verification/private-ai-openrouter-2026-10-05.json)。這次 SQL／R2／recovery／會員均為隔離本機驗收；正式 Cloudflare／R2／瀏覽器 ingress 尚未驗收，Private AI 仍 OFF。新 authority Worker 已有持久化防回退與原生 HTTP 驗證；06:46 UTC 三個 staging 服務已建立，使用不同 Durable Object namespaces，flags／public routes／workers.dev／previews 均關閉，尚未安裝 signer、啟用或驗收。main bindings 與資料庫未變更，詳細界線見聚合證據。 07:20 UTC，獨立 staging recovery state／floor 已啟用（僅 state 安裝 signer）並完成六項真實雲端 service-binding 驗收，generation 維持3，原 namespaces 保留；包含不一致、停用與持久化回退拒絕。設定更新曾有短暫503，失敗紀錄保留，後續以新連線與精確狀態驗證。capture-readiness 仍 OFF，broker／main 尚未接入，不能算完整雲端私人 AI 驗收。Codex CLI 有真實回覆，Claude CLI 因 OAuth 過期未通過；兩者的正式平台執行 adapter 均未驗收。不能把這次結果標成整體 P3 完成。

**2026-10-05 05:22 UTC 治理增量：** 九倉 source 與三倉 runtime 的既有正式規則已升級至固定 `92a58db`。新增入口登錄檢查、storefront／supplier 實際 CLI 及 Docker create 未知結果修正；21 個臨時 branch probes（九次正常 merge、十二次拒絕）及三個 storefront main probes完成，後兩個負例 actual merge 均 405。所有 probes 已清理、consumer mains 不變，中央 review 規則保留。完整 library invocation／其餘六倉 runtime／durable publisher／merge queue 仍未驗，見[實裝紀錄](governance-installation-2026-10-04.md#10-月-5-日九倉入口登錄與三倉實際-cli-強制92a58db)。下方 source55／c3e consumer pins 為較早的執行更新。

**2026-10-05 04:53 UTC 後續：** #117 與 #121 已依序正常合併／部署，兩環境目前為 `89f64ace`。新版日備份已各完成一次真正定時觸發，異地完整回讀、相同 snapshot 的 DB／R2 隔離恢復及清理通過，見[定時執行證據](r2-recovery-retirement-2026-10-04.md#新版部署後的真正定時執行2026-10-05)。下文 02:10 UTC 的「下一次尚未觀察」為當時狀態。GC 與 Private AI 維持 OFF；完整 P2／P3 仍未驗收。

**本日後續執行更新：** #110 的 d269 已部署；七類媒體使用 R2、DB＋R2 隔離恢復及每日異地備份已通過，兩個舊庫已核對後退役。維持媒體 R2 ON、Private AI OFF、GC OFF。中央 main 規則 `24469536` 保留，九個 consumer main 已另安裝 `24473806`：來源 workflow 固定 `55f70c01e574cf66c8fa06b79fc9d8b3ffff0c4a`，library 固定 `91b943ac61e132fbbce72ea066cb2301aa065600`。九倉一次性 branch 正例實際 merge，兩個偽造綠燈負例被 native workflow 拒絕；三個 library 採用 PR 已正常合併。安裝後 kit main-target 正例 native job 成功，竄改／偽造綠燈負例的 actual merge 回 405，suite `4357871927` 確認新規則拒絕，main 未變。

中央 rule **24469536** 已只更新 required verify workflow 的固定 SHA 至 c3e；既有 checks／review／無 bypass 政策不變，c3e CI 通過，更新規則後的新 native main-target run 仍待驗。10 月 5 日三個 consumer main runtime rule **24476100** 先以 c42 安裝，再升級至固定 **c3e5a537a75303c4688e01b7f0d8477c3587a26f**，增加 kit 真實 maker-demo CLI 的 login／workspace／CSRF logout 強制。三個新版 temporary 正例實際 merge；CLI-only 負例 source／workspace 通過，但 native CLI 拒絕、偽造綠燈後 merge 仍 405。升級後 kit main-target #12 正例通過、#13 負例 merge 405（suite `4358652158`），probes 全清理、main 不變。library invocation／完整 CLI coverage 仍未證明。新版媒體變體與清理後 daily 回讀已完成，見現行交接。

三個 merged consumers 的 **2/2 HTTP／隔離 PostgreSQL 呼叫測試、5/5 既有跨倉測試通過**並接入既有 CI；來源 gate 仍為 `library_usage=not_checked`。完整入口／library coverage、merge queue、durable App publisher／replay／unknown ACK 與完整 P3 仍未驗收。本批實際使用 3 個 Astra、2 個 Opus 5.5、8 個 Grok 4.7；兩個 Opus 遭 provider 429 後由根 agent／Astra 接續，不把呼叫數當作 13 份已驗收成果。

精確版本、證據及限制見[治理實裝](governance-installation-2026-10-04.md)與[現行交接](handoff-2026-10-04.md)；線上媒體／恢復基線見[搬移／退役](r2-recovery-retirement-2026-10-04.md)、[五類媒體啟用](media-profiles-activation-2026-10-04.md)。下文 9cc、25 頭像、空用途及全 OFF 是制定計畫時的基線，不能當現行部署指令。10 月 5 日兩環境另通過新版 archive 的同 snapshot 全表 evidence、異地完整回讀及實際 PG18／原生 R2 還原；02:10 UTC 日常 services 已切到固定 c3e coordinator，兩環境實際 service 與獨立讀回均通過，原 timers 已恢復。下一次真正定時觸發尚未觀察，主機依賴／retention 等仍保留為未完成。P0 排程／retention 改善、P1 其餘變體／purge 前置、完整 P2／P3 繼續按未完成事項推進。

本計畫從[已完成的實際移植](actual-migration-2026-10-04.md)接續：09:03:44 UTC staging／公開入口切到新 PostgreSQL branch，runtime 為 `9cc283c6`。原正式 387 users、staging 8 users、兩環境共 280 張來源表已完整核對後還原並套 migrations；每環境 66/66 HTTPS 核對及新庫日備份已成功。媒體仍保存為 legacy bytea，新 R2 分環境接線但 object backfill／非 legacy policy 未開啟，Private AI／broker／machine 仍 OFF。

Ted 已授權本輪合併 foundation integration 並保留未驗收功能 OFF。合併前置的 CodeQL alert 39 判定與目前 head 的 CI 由根 agent／CI 工作包本輪處理；本計畫不宣稱它們已 PASS 或 PR 已合併，實際結果以[發布狀態](release-readiness.md)及 merge 紀錄為準。原始 168 項產品要求仍保留在[共同基礎驗收](acceptance.md)與[來源驗收](source-acceptance.md)，不要求全部完成才合併這次已授權的基底範圍，也不把合併當完整產品驗收。

## 優先順序與交付單位

| 順序 | 工作與負責範圍 | 開始條件 | 可核對的完成標準 |
| --- | --- | --- | --- |
| 本輪前置 | 根 agent／CI 工作包處理 CodeQL39、精確 head CI 與授權合併 | 目前 integration source／PR | 記錄實際判定、check 結果及 merge SHA；不能沿用部署 9cc 的 CI 冒充新 head |
| P0 | 操作者維持入口、備份、renewal 與恢復能力 | 現有正式／staging 可用 | 日備份持續產出有效 archive；完成可用的新庫恢復紀錄及獨立保存安排 |
| P1 | 媒體工作包逐環境搬入 R2，先頭像與海報 | P0 恢復材料可用，該用途當前批准及 reader 相容證據完整 | 現存物件全量 bytes／digest／CAS 核對、實際 HTTP 驗收、可恢復 pins；其他空用途記 empty |
| P2 | 治理工作包安裝可信 publisher 與 GitHub App-bound enforcement | 本輪 security／CI 判定有明確紀錄 | 真實負向 PR／merge-queue 被 gate 拒絕，可信正例可通過，重播／未知 ACK 不誤報授權 |
| P3 | 私人執行工作包按功能完成真人驗收 | 各功能的身份、秘密、恢復與外部出口前置通過 | 每一功能有獨立 release／驗收紀錄才逐項開啟，原始未完成需求繼續列入計畫 |

P0 優先維持線上服務；P1 與 P2 可沿現有分工推進，不以 P3 或另一輪完整獨立預演當開工前置。每個工作包直接做需要的操作，備份、反例及核對跟著該次操作完成。此文件不建立新服務、排程或自動啟用功能，也不猜日期或工程百分比。

## P0：穩定營運、備份與可用恢復

1. 讀[交接](handoff-2026-10-04.md)，回讀正式／staging 的 runtime、Hyperdrive、R2、Access、EMAIL、OFF flags 及原有 cron。部署使用已更新的 private release helpers／templates／plans，拒用封存的舊 Hyperdrive overlays。切換後的新寫入是權威資料。
2. 核對現有 `freedom-next-backup`／`freedom-staging-next-backup` timers 的下一次真實執行，而非重建排程。新庫專用 backup role 只讀取自己資料庫的 public tables／sequences；後續 migrations 須維持 migrator 所建立新物件的 backup default privileges。服務使用 PG18 disposable client、`verify-full` 與系統根憑證，不依賴停止的本機 Compose DB。
3. 每次保存非空 custom archive、TOC、完整 SHA-256、source database／branch、ledger／release 及產生時間。 現行日備份已有 archive／TOC／SHA-256；接著補與每份備份同一 exported snapshot 的逐表摘要／counts／sequences，供恢復比對。舊備份缺摘要時如實記 unavailable，不能拿恢復時的 live 數字比對較早備份。檢查 retention 能保留最後有效 archive；錯誤須回報及修復，不能讓 timer 存在冒充備份成功。沿用已接新庫的 credential-renewal，核對失敗重試與下一次執行，不把舊 credential receipt 改成新目標。
4. 把有效備份與私有恢復材料保存到操作者核對過、獨立於原主機及資料庫供應商的位置，限制讀取權。現有本機 dump 只證明 off-provider，尚不是異地備援；保存方式及實際 readback 要有紀錄，不能只寫「已備份」。
5. 用要投入恢復的真實備份還原到核對過的新空 logical DB，先驗 archive digest，再單交易 restore、逐表全欄位摘要／counts／sequences 比對，最後套 pending migrations、restore ACL lockdown、runtime／backup grants 與角色登入核對。使用 [snapshot evidence](../../../../packages/db/snapshot-evidence.ts)、[restore ACL](../../../../scripts/media-restore-acl.ts) 及 [SQL grants](../../../../deploy/cloudflare/README.md)；私有 actual-migration receipts 提供本輪命令與失敗修正。

P0 完成標準是：兩環境有效日備份、可讀的獨立副本、一次從真實備份建立可核對新庫的恢復紀錄，以及明確說明可恢復到哪個時點／可能遺失哪些後續寫入。R2 啟用前恢復 legacy bytes；啟用後必須把相同時點 DB pointer／object pins／object backup 一起納入恢復。恢復能力不足時保持尚未驗收功能 OFF，不重置現有會員資料。

## P1：七類 R2，先搬確實存在的內容

目前正式站有 25 個 legacy 頭像（258,694 bytes）與一張活動海報（81,110 bytes）；其餘五類無 bytes，staging 七類無 bytes。這是本輪 inventory 的時點數字，下一次操作先重跑盤點，不能用 metadata 表列數當檔案數。

現成入口：只讀 [media-inventory](../../../../scripts/media-inventory.ts)、[media-backfill](../../../../scripts/media-backfill.ts)、[media-verify](../../../../scripts/media-verify.ts)、[operator-backfill](../../../../packages/media-migration/operator-backfill.ts)、[備份／恢復 transfer](../../../../packages/media-migration/backup-transfer.ts) 及[私人 operator Worker](../../../development/media-operator-worker.md)。詳細批准、pointer、legacy retention 與讀寫矩陣沿用[七類媒體規格](05-media-migration.md)，不另造通用 DB delta 引擎。

1. 明確指定環境、logical DB、SQL role、branch-qualified username、release／reader fleet 及該環境桶。保存只含 aggregate 的新 inventory；owner/source references 與批准材料留在 private journal。
2. 先在 staging 用可清理且有合法 owner／批准的用途正例核對已安裝 caller、operator role 與讀取矩陣。staging 本來沒有 bytes，不能把 synthetic 正例記成歷史正式媒體已搬完。來源批准撤銷、owner／bytes revision 變動、CAS 失敗、重試與部分成功須有可核對結果。
3. 正式先逐筆處理存在的 25 頭像，再處理一張海報；實際筆數以新盤點為準。操作前保存 source digest／revision／批准，寫 immutable representation 後完整讀回 hash，發布 pointer 前重新驗權並作 CAS。任何 stale approval／bytes 或 ownership 變化須拒絕發布並重新盤點，不能覆蓋新寫入。
4. 頭像必須核對 `avatar.legacy-bytes.v1` 在所有 active／retained readers 的相容 floor；只因新 schema 或 operator 存在不能發布舊 reader 無法讀的 representation。海報保留現有尺寸、方向與 owner／organizer 權限。
5. 保存同時點 DB／pointer／object pins，使用獨立 ObjectStore 備份並核對完整 bytes。先證明所選 representation 可恢復，再按環境、按用途切換 policy；GET／HEAD、digest／ETag、讀取權與撤銷都要以實際 HTTPS 核對。影片類在有合法正例後另驗 Range／播放器 seek，不能借頭像 PASS 代替。
6. 技能圖片、影片、活動精華、社群縮圖、服務封面目前記 empty；逐用途的 writer／reader／authority／restore 正例仍列未驗收。在合法資料出現或獲准建立用途正例時再執行，不能為湊七類完成率擅自造真人資料。

P1 每用途完成標準：fresh remaining legacy inventory 與實際成功／拒絕／待處理項目相符，所有已發布 objects 有 verified digest／pins／backup，member HTTP 權限與恢復核對通過，policy 切換及 reader fleet 明確記錄。舊 bytea 在 retained-byte／reader／restore floor 全部滿足前保留；object GC／legacy 刪除須另完成規格條件，backfill 成功不自動授權清除。

## P2：安全判定與真正安裝的發布門檻

CodeQL39 精確分析在[告警文件](../../../development/codeql-alert-39.md)。本輪根 agent／CI 工作包負責其實際處理；本計畫只要求接續使用結果，不把 Analyze success、同 main 程式或 hosted Verify 當已解除告警。不能以排除 query、假 PASS 或未記錄的 dismissal 掩蓋風險。

重用 [durable publisher](../../../../packages/contribution-tools/github-durable-publisher.mjs)、[GitHub App publisher](../../../../packages/contribution-tools/github-app-publisher.mjs) 與 [supervisor publisher](../../../../packages/contribution-tools/github-supervisor-publisher.mjs)，依[治理規格](01-contracts-and-governance.md)與[發布門檻](release-readiness.md)接正式安裝：

1. 核對 App 的 installation／最小 permissions、host-owned pinned verifier、approved baseline／library、受保護 journal 父路徑及 single trusted writer。從真正事件送達開始，關聯 exact repository／head／check／run attempt，不接受 PR 自帶 passing report。
2. 安裝可信事件來源、remote reconciliation 與 App-bound required rule；覆蓋已要求的入口／consumer 及 merge queue。未知成功 ACK 要讀遠端事實後由可信順序判定，不能自動 replay POST 或以 run ID 大小推定先後。
3. 用真正測試 PR／merge-queue 核對未受信任作者、偽造 check、重播、較舊 attempt／不同 run、修改 verifier／entry coverage 及 crash restart。失敗必須留 failure barrier；正例只能由正確 App 對 exact head 產生可核對結果。

P2 完成標準：正式 repository 規則及 App 身份回讀吻合，負向 PR／queue 被拒絕、可信正例通過，durable replay／unknown ACK 處理有實際紀錄；此前 `gate_enforced`／`merge_authorized` 不改成 true。這是後續治理產品交付，與 Ted 本輪直接授權合併的操作事實分開記錄。

## P3：逐項驗收後開啟私人執行

| 順序 | 保持 OFF 的功能 | 現成入口 | 必須取得的實際證據 |
| --- | --- | --- | --- |
| 1 | 本人模型／憑證設定與隔離 broker | [設定規格](21-member-model-settings.md)、[秘密 ingest](20-direct-credential-ingest.md)、[broker bridge](19-authenticated-broker-bridge.md) | 本人 cookie／CSRF／origin，直接秘密 ingest 用途分離，metadata 不洩露，撤銷／輪替／外部 recovery、runtime role 不可讀 vault；正式 service binding／hostname 契約有效 |
| 2 | 私人 AI 單步執行 | [私人產品](17-private-ai-product.md)、[單步模型](16-private-model-step.md)、[三路 adapters](15-model-adapter-cores.md) | Codex 訂閱、Claude 訂閱、BYOK 各自真人認證及明確模型／計費選擇；逐次出口批准、active Attempt／lease、一次派送、私人 Result、取消及 ambiguous ACK 不重送 |
| 3 | machine／device／跨端 execution | [device authorization](10-device-authorization.md)、[sessions](11-bootstrap-sessions.md)、[HTTP](12-bootstrap-http.md)、[browser runtime](06-browser-runtime.md) | 真裝置 proof、本人批准、nonce／refresh 重播拒絕、撤銷、限制 Grant、extension/native/neo 包裝與入口權限；bootstrap 身份不能推定執行授權 |
| 4 | 完整 Autopilot 與其餘原始產品範圍 | [執行發布](04-execution-adapters-release.md)、[原始驗收](source-acceptance.md) | 按 requirement ID 補多步 Action、heartbeat／reconciliation、跨端交接、恢復與所有未完成條件，逐項附 exact release 的證據 |

每次只開啟已驗收的用途及環境，先 staging 再正式，保留其他 OFF flags。若秘密／模型／裝置前置缺失，回報具體 unavailable；不能讓 mock／local PASS 轉成真人 provider PASS。新增功能的 backup／restore／ACL、成本與資料保存同意跟著該項操作核對。

## 回退與接手規則

- 舊來源 DB 已封鎖 app 寫入並落後於新庫，不能直接恢復舊 ACL／Hyperdrive 或把流量指回舊來源。修復優先向前；需要恢復時停止所有 HTTP／cron／renewal／其他 writer、排空交易，從相符新快照恢復到新空庫並核對後切換，保留切換後資料。
- 媒體 policy 回退須與當前 pointer、representation、reader 相容及保留 bytes 一起驗證；`legacy` 開關不等於可無條件讀回被清除的舊內容。私人功能遇到授權／秘密風險先停該功能入口，保留 journal，不能重送未知已執行的模型操作。
- 每次交付記錄 exact source／release、實際環境、數量、有效備份、失敗及剩餘驗收，更新同一份 handoff／status。私有 credential、cookies、owner IDs、原始 dump 及完整 provider metadata 不進 Git。
- 本文件只新增後續工作計畫；不建立服務、改排程、改雲端設定或宣告 merge。實際合併及本輪 security／CI 結果由根 agent 記錄。
