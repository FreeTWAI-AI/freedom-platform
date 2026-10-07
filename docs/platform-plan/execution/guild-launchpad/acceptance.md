# 60 項待執行驗收與合成案例設計

**全部 `not_run`；產品案例未在本次 spec PR 執行。** 原T-ID、情境及必要預期逐字來自原JSON/主稿；此文件新增可重現步驟/觀察點，不能解讀為通過紀錄。各SP§10還有domain細節。

## 共用 fixture：F-GUILD-TWO-TENANTS-v1

- 兩個獨立tenant A/B；同一會員在A為owner、B為viewer；A另一restricted operator；一位同guild leader不屬A；一位intern及一位full非主力會員；匿名訪客
- 當下完整active guild catalog加一動態新guild；現有legacy primary/secondary、skills/privacy與intern/full樣本；不以18 seed代全部有效catalog
- A hosted store、inventory、CRM、non-commerce Work/notes/Result/attachments；B相同顯示名但不同ID。stable synthetic UUID、已知byte/digest、namespace extensions、待送outbox及未知operation
- 基本PG/HTTP測試用isolated schema和真正受限runtime role，不能用superuser證明ACL。真正外移案例須獨立endpoint、獨立DB和受控object storage；不是兩同進程stub
- 截止時鐘、source/head/base、fixture digest、config/contract/adapter/schema/policy/recovery版本固定；所有fault點先建立可觀察barrier，記SQL/HTTP/objects/side effects前後；不讀正式會員/客戶資料
- 每案evidence欄位：R/T與原ledger ref、test filename/ID、exact source、environment、command、開始/結束、結果、failure/skip、artifact digest、限制。沒有evidence不得改status；不得用本文件檢查代替產品執行

## 案例清單

<a id="t-001"></a>

### T-001 公會分類一致性

- 規格：SP-01；需求：R-001；層級：catalog/unit+PG
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：列舉18個seed及一動態guild；送invalid category、兩類主類別與標籤擴權。
- 原必要預期：同一 guild 主類別只有一個；標籤不擴權，未合法分類的值不可寫入。
- 核對／證據：taxonomy唯一、stable key未變、無membership/ACL變更；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-002"></a>

### T-002 主力唯一性與空類別

- 規格：SP-01；需求：R-002；層級：PG並發+UI
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：A同類兩個choice並發；只選一類重登入再開合法工作。
- 原必要預期：同類並行設兩個主力不成立；只選一類仍可做既有合法工作。
- 核對／證據：唯一constraint/CAS結果、另外兩空類別不gate；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-003"></a>

### T-003 非主力正式成員

- 規格：SP-02；需求：R-003；層級：HTTP+PG
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：full會員將提供app的guild改為非主力並launch；只改primary後讀原tenant。
- 原必要預期：本人在某非主力公會為 full，可啟動適用應用；改主力不改 tenant ACL。
- 核對／證據：資格可用、tenant ACL/資料digest不變；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-004"></a>

### T-004 全公會及新增公會覆蓋

- 規格：SP-03；需求：R-004；層級：catalog+E2E
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：依當下active catalog逐個開launchpad，再核准synthetic新guild無客製config。
- 原必要預期：以有效 catalog 列舉逐一開啟；新公會無客製也取得可用預設。
- 核對／證據：覆蓋分母匹配，每guild有合法default workflow，不以18作分母；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-005"></a>

### T-005 公版有用工作

- 規格：SP-03；需求：R-005；層級：E2E+PG+R2
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：無model會員建Work、存note、附檔、存Result，登出登入後繼續編輯。
- 原必要預期：以一般會員保存任務／筆記／附件，再登入可繼續；非僅空卡或外連。
- 核對／證據：真DB/R2保存與IDs/version/digest相符，不是localStorage/mock/外連；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-006"></a>

### T-006 公共與私有分離

- 規格：SP-03；需求：R-006；層級：HTTP+E2E
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：以B、同guild其他member、訪客讀A Work/list/search/events/error。
- 原必要預期：公會成员與陌生人看不到他人 tenant 私有任務、搜尋結果及錯誤細節。
- 核對／證據：無private metadata/body/索引摘要洩露、公共公告仍可讀；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-007"></a>

### T-007 會長不是私有管理員

- 規格：SP-02；需求：R-007；層級：HTTP權限矩陣
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：非A成員guild leader改公告，再讀A CRM/匯出/instance。
- 原必要預期：會長能改公告，讀取非本人 CRM／匯出／instance 管理則拒絕。
- 核對／證據：公告成功，private功能404/拒絕且零副作用；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-008"></a>

### T-008 同能力跨公會重用

- 規格：SP-04；需求：R-008；層級：registry+PG
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：兩guild指同application/module定義，A依序从兩入口啟動。
- 原必要預期：兩公會指向同 definition；同 tenant 取得第二入口不自動複製資料。
- 核對／證據：definition/instance依賴共用、無重複資料；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-009"></a>

### T-009 Demo／正式與来源界線

- 規格：SP-10；需求：R-009, R-061；層級：source+runtime
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：載SIM profile和空正式tenant，觸發demo expiry；打開未验hosted原作入口。
- 原必要預期：SIM、假客戶、試用到期不作用於正式空間；未驗 hosted 工具顯示真實狀態。
- 核對／證據：SIM資料及72h政策不作用正式；能力未驗標真狀態；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-010"></a>

### T-010 舊會員偏好轉換

- 規格：SP-01；需求：R-010；層級：upgrade PG
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：旧primary+兩secondary含同類衝突，intern/full/skills/privacy各一；run dry-run/backfill/replay。
- 原必要預期：保留 memberships、tier、skills、privacy；同類次要不被隨機升為主力。
- 核對／證據：原關係逐欄digest保留；只合法primary映射、不把secondary升主力/full；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-011"></a>

### T-011 URL 與資源身份

- 規格：SP-02；需求：R-011；層級：HTTP+PG
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：改public slug與轉經營者，old ID查資源；B猜A private URL。
- 原必要預期：改 slug／管理者不改 ID；猜測另一 tenant URL 仍不可讀私人後台。
- 核對／證據：ID未變、別方拒絕；redirect不帶private cookie；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-012"></a>

### T-012 配置版本與不可信內容

- 規格：SP-03；需求：R-012；層級：schema+E2E
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：預覽/發布/回復config；輸入script、遠端code、越權private widget。
- 原必要預期：可預覽及回復布局但不回復資料；script／越權配置被拒絕。
- 核對／證據：layout可回復，業務row不rollback，unsafe拒絕；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-013"></a>

### T-013 多租戶多角色

- 規格：SP-02；需求：R-013；層級：PG+HTTP+E2E
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：同user A owner/B viewer交錯request、tab/cache與role撤銷。
- 原必要預期：同 user 在 A 為 owner、B 為 viewer；不同角色效果正確且不串 context。
- 核對／證據：每target現在角色生效，不共用錯context；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-014"></a>

### T-014 Owner 移交與孤兒防護

- 規格：SP-02；需求：R-014；層級：PG並發
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：非owner提移交、正確owner提名、受讓接受、兩last-owner離開競爭。
- 原必要預期：未授權移交拒絕；正確受讓確認後權限明確；最後 owner 不可靜默消失。
- 核對／證據：未授權0變更，接受前不轉權，最後owner不孤兒/自動轉leader；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-015"></a>

### T-015 受限操作人的匯出

- 規格：SP-02；需求：R-015；層級：HTTP+R2
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：operator做被允許編輯，枚舉export/create/status/download/manifest/Range。
- 原必要預期：operator 可做指定業務操作，未有 export scope 時不可整批帶走資料。
- 核對／證據：普通業務成功，無export scope全部拒絕；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-016"></a>

### T-016 離會／停權／續用

- 規格：SP-11；需求：R-016；層級：policy+PG
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：依序換primary/離會/降級/plan到期/security suspend，各有有效existing資料。
- 原必要預期：切主力無資料影響；離會按既定方案，不 destroy；安全停權限制風險能力。
- 核對／證據：按versioned政策限制新能力，保留資料及合法export/recovery，不destroy；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-017"></a>

### T-017 重複建立

- 規格：SP-04；需求：R-017；層級：PG並發
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：同idempotency key多點/refresh/restart；同key異body。
- 原必要預期：同 key 併發提交／重送／刷新只建立一份，異內容同 key 拒絕。
- 核對／證據：只有一instance及quota reservation；409不覆蓋；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-018"></a>

### T-018 容量與限流

- 規格：SP-04；需求：R-018；層級：PG競態+HTTP
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：A最後一額度被兩launch/兩export競爭，B同時正常操作。
- 原必要預期：超 quota 可理解地拒絕，不產生半成品；其他 tenant 不被額度混算。
- 核對／證據：不超cap、不混算；reject不留可用半成品；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-019"></a>

### T-019 配置 unknown ACK

- 規格：SP-04；需求：R-019；層級：fault/restart
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：provider完成provision後丟ACK並重啟coordinator，查同operation。
- 原必要預期：模擬配置完成但回應丟失，重啟後同 operation 查到原實例。
- 核對／證據：原instance被認領/恢復，無第二無主資源；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-020"></a>

### T-020 相依模組選擇

- 規格：SP-04；需求：R-020；層級：PG+E2E
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：A已有compatible inventory，另guild啟店；先共用再明選新獨立instance。
- 原必要預期：已有庫存可明確共用；另建獨立庫存須明示，原資料不被拷貝覆蓋。
- 核對／證據：共用原ref，新建不同ID；不靜默複製或改原綁定；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-021"></a>

### T-021 資料責任完整性

- 規格：SP-06；需求：R-021；層級：schema/surface inventory
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：新增未登記的敏感table/Asset purpose/cache field至candidate fixture。
- 原必要預期：實際表／附件／索引與資料目錄對帳，新增未登錄敏感資料使測試失敗。
- 核對／證據：資料責任對帳fail；每export/retention surface有owner/purpose；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-022"></a>

### T-022 跨 tenant 全路徑反例

- 規格：SP-06；需求：R-022；層級：PG+API/jobs/cache
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：A/B資料同顯示名，枚舉API/list/search/job/event/bulk/FK與cachekey。
- 原必要預期：API、查詢、job、搜尋、cache、FK／引用與批次端點均不可越界。
- 核對／證據：所有未授權讀0筆/一致404，write0效果，無存在側信道；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-023"></a>

### T-023 R2 權限與可攜

- 規格：SP-06；需求：R-023；層級：HTTP+R2
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：猜A object/variant/export URL以B/匿名做GET/HEAD/Range；A匯出还原。
- 原必要預期：直接猜 object／變體／export URL 不得越權；匯出還原 bytes 與 digest 相同。
- 核對／證據：权限全路徑拒絕；合法bytes/digest相同；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-024"></a>

### T-024 真實 DB role 與 pool

- 規格：SP-06；需求：R-024；層級：真runtime PG role
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：同pool交錯A/B，注入exception/rollback/cancel後reuse；以非owner非BYPASSRLS角色。
- 原必要預期：用應用角色交錯 A/B，含 exception／rollback／reuse，無跨租戶可見或可寫。
- 核對／證據：session-local context不殘留，不能越tenant/FK；無TRUNCATE旁門；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-025"></a>

### T-025 外移後中央殘留

- 規格：SP-06；需求：R-025；層級：migration+inventory
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：CRM外移成功後掃中央table/index/outbox/trace/cache和retention manifest。
- 原必要預期：對照留存 allowlist，中央不再存已外移 CRM 全資料；投影僅有允許欄位。
- 核對／證據：只有allowlist refs/必要order快照；无full CRM/private notes殘留；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-026"></a>

### T-026 跨方交易與 CRM 快照

- 規格：SP-05；需求：R-026；層級：PG/domain
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：CRM關聯合法order snapshot，撤共享/刪CRM，另一方讀交易。
- 原必要預期：刪 CRM 不任意刪仍合法存在的訂單快照；快照不能作為完整 CRM backdoor。
- 核對／證據：合法order事實保留；snapshot不能當CRM搜尋/更新backdoor；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-027"></a>

### T-027 穩定 ID 與 clone

- 規格：SP-04, SP-07；需求：R-027, R-052；層級：export/import+PG
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：同包分別migration和clone；檢引用和兩份writer claims。
- 原必要預期：遷移保留引用；clone 新建身份並映射，不發生雙方同時聲稱相同權威。
- 核對／證據：migration ID不變；clone全新namespace及ref mapping，不能同權威；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-028"></a>

### T-028 跨模組邊界

- 規格：SP-05；需求：R-028；層級：兩部署integration
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：切斷store對inventory本地DB讀寫權，改external port跑reserve/release/status。
- 原必要預期：移除庫存本地 DB 可見性後商店仍透過 port 工作，沒有隱藏直接寫入。
- 核對／證據：流程仍通，無私有SQL/hidden join依賴；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-029"></a>

### T-029 Adapter 契約一致性

- 規格：SP-05；需求：R-029；層級：contract conformance
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：同golden/negative/concurrency fixtures在hosted及external adapter各執行。
- 原必要預期：同一套輸入／錯誤／並行 fixtures 在 hosted／external 路徑取得相容語意。
- 核對／證據：I/O/errors/receipt/versions語意相容，不是只schema相同；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-030"></a>

### T-030 舊 client 相容

- 規格：SP-05；需求：R-030；層級：mixed clients
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：受支持舊client read、新required scope缺失write、未知major及unsupported新operation。
- 原必要預期：合法舊讀取可用；缺新必要語意的寫入明確拒絕，不假成功丟資料。
- 核對／證據：合法read保留；write明確upgrade拒絕，不成功後丟新欄位；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-031"></a>

### T-031 Outbox 原子與重啟

- 規格：SP-05；需求：R-031；層級：PG+outbox faults
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：business mutation前、receipt後、commit後、publish前後注入crash/restart。
- 原必要預期：業務提交前後注入 crash，既不丟已提交事件，也不發布未提交事實。
- 核對／證據：未commit不發布，已commit event不遺失/不duplicate effect；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-032"></a>

### T-032 Command／event 去重

- 規格：SP-05；需求：R-032；層級：兩部署競態
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：same command/event ID重複、並行、restart；異payload冒用同ID。
- 原必要預期：重送、並發及 restart 後只一份業務效果；同 ID 不同內容拒絕。
- 核對／證據：唯一effect，異digest拒絕；receipt replay先現在驗權；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-033"></a>

### T-033 亂序、缺漏、遲到

- 規格：SP-05；需求：R-033；層級：events/cutoff
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：送seq3前seq2、重播seq1、製造gap、cutover後送合法pre-cutoff及偽post-cutoff舊epoch。
- 原必要預期：舊事件不覆蓋新版本，缺漏可補讀；合法 cutoff 以前事件不被誤丟。
- 核對／證據：不回退projection，gap補讀，合法late接纳，illegal舊writer拒絕；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-034"></a>

### T-034 補償與不可逆操作

- 規格：SP-05；需求：R-034；層級：domain saga
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：reserve成功後下一步失敗；drop release ACK；對已寄送/出貨事實要求rollback。
- 原必要預期：後續失敗可釋放預留；已發生外部行為保留，不用刪列冒充回滾。
- 核對／證據：同reservation冪等釋放/補償中；不可逆事实不刪或假回滾；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-035"></a>

### T-035 過期投影

- 規格：SP-05；需求：R-035；層級：external/query
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：投影顯示有stock，但authoritative instance已耗盡/改epoch。
- 原必要預期：投影可標示陳舊；預留／訂單確認不依舊庫存快取作最終決定。
- 核對／證據：UI標stale；reserve/接單以權威結果拒絕，不用cache賣超；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-036"></a>

### T-036 外部版本不相容

- 規格：SP-09；需求：R-036；層級：mixed external versions
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：某capability升不相容major，其餘module仍為supported tuple。
- 原必要預期：拒絕受影響 capability 並提示版本，其他模組與資料匯出仍可運作。
- 核對／證據：僅該能力拒絕，read/export/local other工作仍可用；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-037"></a>

### T-037 完整套件還原

- 規格：SP-07；需求：R-037；層級：乾淨獨立runtime
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：只給公開app release+scoped data+objects+interop包，在空環境驗hash/build/restore/start/read/write。
- 原必要預期：乾淨受支持環境以應用＋資料＋互通包啟動並讀寫原資料，不需隱藏內部資源。
- 核對／證據：無hidden monorepo account/secret依賴，原資料可接續；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-038"></a>

### T-038 非核心欄位與附件

- 規格：SP-07；需求：R-038；層級：round-trip
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：加入namespace extension、配置、歷史結果、非ASCII、各合法附件；往返export/import。
- 原必要預期：客製欄位、配置、歷史及媒體往返後保留；未知欄位不靜默丟棄。
- 核對／證據：欄位/版本/ref/digest均保留；unknown extension明拒或原樣保留；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-039"></a>

### T-039 敏感匯出與下載

- 規格：SP-07；需求：R-039；層級：security export
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：owner和B/匿名分別查job/manifest/download；掃包所有dataset/metadata。
- 原必要預期：他人無法取回包；包中不含全平台 users／cookie／API secrets／CLI session。
- 核對／證據：包無別tenant/users auth/cookies/API keys/CLI session，下載到期撤銷有效；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-040"></a>

### T-040 惡意或損壞匯入

- 規格：SP-07；需求：R-040；層級：hostile archive
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：逐一缺引用、重複ID、跨tenant row、digest破壞、zip traversal/bomb/symlink、超cap/未知schema。
- 原必要預期：digest 不符、跨 tenant ID、缺引用、容量超標、路徑穿越等不污染正式資料。
- 核對／證據：quarantine拒絕，active DB/R2零污染，無任意script/SSRF；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-041"></a>

### T-041 單庫存模組外移

- 規格：SP-04, SP-08；需求：R-041, R-052；層級：獨立DB+endpoint E2E
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：A只外移inventory，store保留hosted；B同步操作；斷本地inventory DB權限。
- 原必要預期：A 只搬 inventory 到獨立部署及 DB，商店仍在平台；B 正常，不以整 ERP 代替。
- 核對／證據：同stable refs預留/取消可用，一個writer，B不受影響；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-042"></a>

### T-042 資料與媒體一致切點

- 規格：SP-08；需求：R-042；層級：snapshot/object faults
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：source fence前後並發更新附件，故意更換object/刪pin；輸出同cutoffmanifest。
- 原必要預期：停寫後快照引用到確定的 object 版本，並行更新不能產生缺附件或錯引用。
- 核對／證據：資料只指確定immutable object版本，不缺bytes或混snapshot；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-043"></a>

### T-043 Fencing 與原子移交

- 規格：SP-08；需求：R-043；層級：所有狀態cutpoint
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：每migration transition前後crash，source仍連線；registry CAS競爭及restore舊epoch。
- 原必要預期：故障插在每個切點；舊來源不能接新寫，registry 不出現雙權威或倒退 epoch。
- 核對／證據：無雙writer/epoch回退，source確實fenced，未知不啟target；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-044"></a>

### T-044 遷移 unknown／進行中工作

- 規格：SP-08；需求：R-044；層級：migration operation faults
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：transfer commit後丟ACK，帶pending accepted command和unsent event重新啟動。
- 原必要預期：遺失 ACK、待送事件、已接受命令可追蹤並接續，不重扣或遺失操作。
- 核對／證據：查同operation/manifest接續，不重扣、不遺失accepted fact；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-045"></a>

### T-045 切換後安全回復

- 規格：SP-08；需求：R-045；層級：reverse transfer
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：target_active後新增record/reservation，嘗試直接切回舊source；再做有界反向移交。
- 原必要預期：目標新增資料後直接切回舊庫被拒絕；反向移交／向前修復保留新事實。
- 核對／證據：直接rollback拒絕，反向/forwardfix保留新fact及receipt；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-046"></a>

### T-046 副本及備份清理

- 規格：SP-06；需求：R-046；層級：copy cleanup
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：外移後清list中search/thumbnail/summary/cache/notification，保留未到期backup。
- 原必要預期：搜尋、縮圖、摘要、cache 等按政策清理；仍在備份的資料清楚標示期限。
- 核對／證據：清理每copy有結果；backup期限/未刪狀態明確，無假全刪；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-047"></a>

### T-047 舊備份還原防復活

- 規格：SP-06；需求：R-047；層級：隔離restore
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：restore含舊binding/token/deleted record的backup，再套durable floors/tombstone/revocation。
- 原必要預期：還原後套用 tombstone／撤權／epoch floor，再對外服務，不復活舊寫入來源。
- 核對／證據：對外服務前拒舊writer/已撤key，已刪資料不重新可見；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-048"></a>

### T-048 外部註冊與 SSRF

- 規格：SP-09；需求：R-048；層級：endpoint security
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：無tenant權pair；測http/private/metadata/IPv6/redirect/DNS-rebind和錯endpoint possession。
- 原必要預期：不具 tenant 權者不能綁定；私網、metadata、惡意 redirect／DNS 變更按政策拒絕。
- 核對／證據：全部按profile拒絕且無敏感egress；hostname控制不等tenant權；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-049"></a>

### T-049 Key／scope 撤銷

- 規格：SP-09；需求：R-049；層級：credential/race
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：錯audience/env/instance、撤key或scope於lock wait、rotation後replay歷史receipt。
- 原必要預期：舊 token、錯 audience、跨 instance、replay receipt 不擴權；rotation 後舊鍵依政策失效。
- 核對／證據：現在權限生效，無新effect/資料洩漏，舊receipt不復活token；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-050"></a>

### T-050 離線／完全自架

- 規格：SP-09；需求：R-050, R-051；層級：network partition
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：external module斷中央仍做純local工作；跨platform operation後disconnect/reconnect。
- 原必要預期：純本地業務可繼續，跨平台動作待處理／拒絕；終止連線不刪本地資料。
- 核對／證據：local資料不沒收；跨平台真pending/拒絕，新pair不復活舊token；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-051"></a>

### T-051 人工與 AI 邊界

- 規格：SP-11；需求：R-053, R-054；層級：E2E+grant negatives
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：無model做人工default；AI無本人model/grant、foreign billing、平台key環境存在。
- 原必要預期：人工無模型也可工作；AI 未有本人模型／grant 拒絕，不偷用平台 key。
- 核對／證據：人工可用；AI阻擋且無hidden fallback，當次scope不擴大；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-052"></a>

### T-052 AI／運算用量

- 規格：SP-11；需求：R-055；層級：usage/unknown faults
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：並發reserve budget、provider accepted timeout、cancel、late usage、同step retry。
- 原必要預期：重試、取消、provider timeout 的預留／實耗／未知可對帳，不重複計費或隱藏消耗。
- 核對／證據：estimate/reserved/actual/unknown可對帳，未知不歸0/重複charge；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-053"></a>

### T-053 可信治理與 library 使用

- 規格：SP-11, SP-12；需求：R-054, R-056；層級：trusted runtime/CI
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：candidate竄改validator/report、SDK bypass、new unregistered surface、selected job skip。
- 原必要預期：candidate 偽造綠燈／替換 validator 或繞 SDK 的反例被可信 runtime 檢查拒絕。
- 核對／證據：可信來源的真call-chain/gate拒絕，不只看hash/check名稱；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-054"></a>

### T-054 內部 legacy 轉換

- 規格：SP-12；需求：R-057；層級：legacy migration matrix
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：same源snapshot跑expand/backfill/switch/contract與空庫/相反merge順序；含歧義owner。
- 原必要預期：expand／回填／switch／退場各階段可核對；舊私有資料不掉進全域 tenant。
- 核對／證據：舊資料/ACL/IDs可核對；歧義blocked個別資源，無global tenant fallback；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-055"></a>

### T-055 真實 UI 與切租戶

- 規格：SP-03；需求：R-058；層級：Chromium E2E
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：320/390/1280+鍵盤：空/錯誤/返回/重試；A request延遲後切B再回。
- 原必要預期：手機、鍵盤、錯誤、返回可用；A→B 舊 request 晚回不覆蓋 B 畫面。
- 核對／證據：焦點/scroll正常，無A flash/late overwrite，無模型仍能工作；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-056"></a>

### T-056 授權與來源

- 規格：SP-10；需求：R-059, R-061；層級：source/license/build
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：核upstream exactcommit/LICENSE/NOTICE，未知素材/未验工具、fork冒official反例。
- 原必要預期：原作版本／NOTICE／發布範圍可追蹤；未知授權與未驗工具不標成官方可商用 hosted。
- 核對／證據：阻不明再分發/官方標籤；來源可閱讀不等runtime-ready；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-057"></a>

### T-057 狀態與發布誠實

- 規格：SP-12；需求：R-060；層級：release negative matrix
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：把code/contract/app/schema/deployed混不同head，未跑case或只合main嘗試enable。
- 原必要預期：合併、測試及部署各有版本；未驗功能保持關閉／明示，不以頁面存在宣稱完成。
- 核對／證據：阻能力啟用，狀態分列，有scope及環境而非全部完成；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-058"></a>

### T-058 容量及外部故障隔離

- 規格：SP-12；需求：R-062；層級：bounded load/fault
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：以SP12 profile和runtime limits跑stream、chunk中斷、20併發、external長故障。
- 原必要預期：在 spec 定義資料量、並行度及 runtime 限制下測 streaming／timeout／重試，不拖垮其他 tenant。
- 核對／證據：報p50/p95/error/memory，受限重試與tenant隔離，不拖垮其他tenant；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-059"></a>

### T-059 利益與證據

- 規格：SP-11；需求：R-063；層級：domain/ledger negatives
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：SIM成交、PR數、guild頭銜/AI完成、單方benefit報告各觸發一次。
- 原必要預期：公會頭銜／PR 數／模擬交易不生成付款義務或實收；合作與成本可查來源。
- 核對／證據：不生成payable/實收/永久抽成；合法合作按exact agreement另立；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收

<a id="t-060"></a>

### T-060 追蹤完整性

- 規格：SP-00；需求：R-064；層級：static+integration trace
- 前置：共用合成fixture；另依操作建立對應state/權限，沒有該實作時記not_run
- 操作／故障注入：逐D/R/T對原JSON，核檔案/原ledger IDs/consumer test實際調用及evidence來源。
- 原必要預期：每個 D／R 有負責 spec 與至少一項 T；原 ledger 未映射處明列，不臆造已完成。
- 核對／證據：缺漏/假mapping/已跑錯SHA皆拒；unmapped明列，不把靜態pass當完整產品acceptance；記上述exact-source evidence
- 狀態：not_run；evidence：空；原因：尚未實作及執行此項產品驗收
