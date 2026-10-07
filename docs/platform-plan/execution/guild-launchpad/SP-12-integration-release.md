# SP-12 整合、相依、測試與發布

## 1. 文件識別、來源與範圍

SP-12 v0.1，draft specification；source `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`。主責 R-056/057/060/062，T-053/054/057/058；完整D/R/T邊見[traceability](traceability.json)，也承接其他包跨界案例。原foundation168與平台RQ/T/UAT/A4保持獨立，不因這份spec關閉。

## 2. 使用流程、依賴與可並行部分

| 建議後續 PR 閉環 | 輸入/先行介面 | 真正完成條件 | 可平行工作 |
| --- | --- | --- | --- |
| P-A catalog/preference | SP01，讀目前guild/tier/primary | 三類唯一性、legacy資料不丟、old client兼容、全部動態catalog | shell具名fixture、A/B角色測試設計 |
| P-B tenant authority | SP02，現有identity/command/v1兼容 | 真實tenant backing/FK/resolver，current auth+revocation+receipt wait tests；不偽造Actor | application/config和data catalog |
| P-C all-guild default | P-A/P-B接口，SP03與Work/Result scope | 每個有效公會Work+note+attachment+Result保存再登入可取回、private ACL、手機鍵盤 | 專屬domain不必先完成 |
| P-D registry/provision | P-B/SP04/SP05 | reuse dependencies、quota原子reserve、unknown ACK唯一instance | export manifest/tool、版本fixtures |
| P-E ports/data isolation | P-B/SP05/SP06 | hosted/external相同fixtures、禁cross-domain SQL、真DB role/R2隔離/outbox/inbox | external獨立fixture、owner permission UI |
| P-F domain slice | P-C/D/E、SP10 | commerce唯一owner、inventory reserve/release/status與非商務全流程；無payment啟用 | 各guild自訂配置、已核授權原作模板 |
| P-G portable bundle | P-E/SP07、app release/license manifest | 乾淨環境app+data+attachments+interop完整還原/再寫，A/B不串 | migration fault harness |
| P-H external migration | P-E/F/G、SP08/09 | 真正單庫存移到獨立DB+endpoint，one writer/cutoff/late event/unknown/reverse recovery | 不依賴模組繼續可用 |
| P-I optional AI/operations | P-B/D/E與已驗私人AI/Grant/adapter，SP11 | 本人模型/tenant scope/current grant/usage對帳/取消，人工無key正常 | 正式policy與容量量測 |
| P-J bounded release | exact integration candidate、該能力全部證據 | 支援版本/restore/可信CI/review/需有的正式批准；只開已驗能力 | 未啟用能力與後續guild深度開發 |

以上不是新增十個委員會或強制串行審查排程；介面可先定、fixtures可先做。共同identity、event、storage和registry owner各一位責任workstream。**M1全公會基本可用**不依賴ERP完整/付款/AI；M3可攜不得用整包搬遷替代單module。

## 3. 既有檔案與生成責任

KEEP `.github/workflows/verify.yml`、`scripts/ci/select-affected-jobs.mjs`、`packages/contribution-tools/context.mjs`、`scripts/update-inventory.py`、`docs/platform-plan/verification/verify_revision.py`。未來NEW/修改domain需更新自身 `freedom.module.json` 的paths/deps/surfaces及既有生成/測試選擇流程；本次不新增descriptor或放寬gate。

[repo map](repository-map.md)標各runtime seam；契約authoring/GENERATED規則見[contracts](contracts.md)。既有 `npm run test:contracts` 包含舊package spec corpus驗證，新SP位於sibling目錄以免偷改M00–M02 corpus要求。

目前docs/platform-plan不在docs-only narrow allowlist；正常PR可能跑full CI，照實等待其結果。不得為此spec PR修改selector/workflow讓它跳過必要檢查。`packages/sdk`包含手寫來源，不能整目錄誤當generated output覆寫。

## 4. 整合資料與證據模型

ReleaseCandidate manifest需要exact source/head/base-tree、contract/profile指紋、app/data/config/binding版本、migration IDs/digests、支持的reader/writer floor、consumer locks、feature scope/environment、policy revisions、build artifacts、required tests、rollback/restore引用。TestEvidence至少：T/R/原ledger refs、真實test file/id、fixture digest、command、時間、environment/runtime、result、failure/skip reason、artifact digest、observed limitations。

code implemented、schema recognized、local verified、staging verified、released是不同欄位。evidence append-only修正/supersession，不把earlier source結果覆寫成新head。可信CI需驗實際caller/library/schema共用，不僅檔案hash或相同check名稱。

## 5. 測試與發布介面

不在本PR建立發布API。未來capability activation使用現行發布/feature policy流程，其輸入必須綁exact ReleaseCandidate、環境與policy，驗state floors後才開；通用JSON `enable:true` 不足以授權。缺前置回明確`capability_unavailable`/`release_evidence_missing`，不修改unrelated flags。

| 層級 | 測試入口/產物 | 不能取代 |
| --- | --- | --- |
| spec static | 本目錄validator、relative links、`git diff --check`、inventory | runtime、部署、真使用者驗收 |
| contracts | 既有test:contracts+新canonical fixtures/schema/generated drift；TS/Rust需要原ledger能力另驗 | hosted/external实际副作用 |
| domain/PG | synthetic A/B真受限runtime role、交錯連線/locks、rollback、pool | R2/cloud或UI |
| storage | ObjectStore/R2完整bytes/digest/HEAD/Range/revoke、same-cutoff restore | 只metadata/fake-store正例 |
| adapter | 同golden+negative vectors跑hosted port/真正external endpoint及獨立DB | 同進程兩函式的假混合部署 |
| E2E | 先build後既有Playwright隔離schema，desktop320/390/1280、keyboard/reduced-motion、tenant switch | 靜态HTML/screenshot |
| migration | 真一module fence/export/restore/epoch/late-event/unknown/reverse transfer；B不受影響 | 整ERP搬遷/空資料庫 |
| trusted delivery | fixed host/verifier/App workflow、候選篡改/SDK bypass/selected skip等負例；exact integration head | 候選PR自己echo PASS |
| production | 既有正式發布授权+能力別staging/恢復/支援policy | merge main、draft PR或mock |

原factory/route未安裝要保持unavailable，而不是擴大测试stub。跨repoconsumer未支持新contract保留舊profile read與具體升級要求；新operation不靜默fallback。

## 6. 失敗、重啟、版本與撤權

新增或改main/base後重算affected closure，必要重新整合測試。selected job failure/skipped/cancelled/missing都不能當passed；run未知查exact remote run，不重打外部有副作用job。source變了必須新證據，歷史PASS保留來源。

migration操作中止可恢復同operation；失去unknown-effect/epoch/revocation可核對性則只停受影響module。target已寫入後不可切回stale source。UI回退不能移除private ACL/R2 reader/reconciliation，舊reader碰新持久shape需拒絕啟動而非數據破壞。

## 7. UI與人工接手

每能力顯示可操作狀態、blocked原因及scope，不用『全部完成』掩蓋private AI/external migration尚未驗。所有有效guild default可用；tenant切換清理舊cache/late response，主力改變不更換tenant。

非技術使用者看到建立/繼續/儲存/匯出/結果確認中/需要處理等具體字詞；診斷附operation ID而不是secret或整份CRM。失敗可重試同operation、恢復/下載已可用成果、聯繫具權責支援，不能把不明狀態強制改成功。

## 8. 平台內部遷移、export及恢復

內部upgrade遵expand→backfill→switch→contract：新增schema及old read compatibility；用明確owner資料回填，歧義列隔離帳不放global tenant；A/B all-surface ACL驗過才切write；舊client退場/reader floors確認後才contract。原stable IDs、membership/tier/grants/privacy全保留。

SQL新logical IDs於實作時核對最新main與#145/#149等runner政策分配；本spec不預占編號或改歷史SQLdigest。必跑真empty DB replay以及不同merge順序；runtime/app/operator restore ACL/grants/backup pins一同核對。全庫備份不等module可攜；反之模組bundle不等完整平台災難恢復。

## 9. 威脅與可測的非功能profile

第一組**合成、可調整**非功能profile `F-GUILD-TWO-TENANTS-v1`：A/B兩tenant，各10,000業務record、100個附件（合計100MiB）、10個module instances；20並行正常UI/API、4個bounded長工作。這是測試負載設計，非正式quota/免費額度/SLA。

目標初值：list/control-plane metadata p95≤1s（本機/區域內測試配置須報明）；external route deadline用OPEN-05 10s合成profile，完成不了就有界pending/timeout；其他tenant p95在故障壓力下不高於同負載healthy基準2倍。單stream採≤1MiB chunks，publisher/extractor峰值額外memory建議≤32MiB，測不同chunk斷點；實際runtime的CPU/memory官方上限和整體memory一同量測。數字不達標要明說/調能力profile，不降低隔離、冪等或fake成功。

必報dataset/seed、並行度、p50/p95/error/timeout、CPU/memory、object bytes、retries、排隊深度及每tenant拒絕；樣本/數值是建議技術起點，正式SLO在OPEN-16收斂。長工作不阻塞普通UI或Stop，event backlog/poison message不得跨tenant拖垮全站。public evidence只含合成資料/aggregate，secret掃描必跑。

## 10. 驗收、發布條件與本次證據

- T-053：候選自行改validator、fake check、未用SDK/私fetch、unknown surface、過期supported tuple；既有可信source/runtime gate拒絕。根據實際支持consumer逐個記，不用一倉pass推全倉
- T-054：含舊會員、多品牌、無主/歧義商品、隱私技能及附件的synthetic snapshot逐階段upgrade，counts+full digest+ID/ACL和old API驗證；歧義個別blocked，不洩全站
- T-057：實作/測試/部署不同SHA故意混搭，release拒絕；保留未知結果與其他OFF能力，不以main合併自動啟用
- T-058：以上profile施加external timeout、poison、斷線、corrupted chunk、quota contention；stream恢復不重複effect、不串tenant且有latency/memory證據

全部T-001–060仍`not_run`，未做runtime、staging、真人或部署。正式能力釋出需其SP/D/R/T、現有foundation及原平台相關要求都有實際可核對證據和既有授權，其他能力可持續開發。此次只提交draft spec PR；[verification](verification.md)列已實跑文件檢查與hosted CI狀態，不自動merge。
