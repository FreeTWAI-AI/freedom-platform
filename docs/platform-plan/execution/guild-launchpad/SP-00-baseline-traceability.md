# SP-00 基線、優先序與需求追蹤

## 1. 文件識別、來源與範圍

SP-00，v0.1，draft specification，2026-10-05。中央base `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`；ERP `077a003634e5c11592b78acd969c6fe0814858a2`。主責 R-064/T-060，承接全部 D-01–D-22 的跨包一致性。精確邊以[traceability](traceability.json)為準；本次只做spec，不把文件檢查填成產品驗收。

完整提供主稿v1.0、原requirements-and-acceptance JSON、source-index JSON均已讀並比對。原session逐則全文、ZIP中獨立AGENT-START-HERE/SHA256SUMS仍未取得；主稿§24與兩份原JSON足以承接本輪技術規格，但不聲稱已讀所有原始對話。來源digest及範圍見[sources](sources.md)。

## 2. 使用流程、非目標與依賴

下一位實作者先讀本文件→共同契約→所屬SP→實際檔案/原ledger→該包T-ID。選一個可驗收閉環；寫程式前refresh main和相依PR，記 source drift。不要再從外部demo重建整套登入/CRM/工作引擎。

本次交付13份spec、共同概念/資料責任/檔案圖、D/R/T逐項映射、整合順序及待決policy。無runtime變更、正式migration、第三方授權安裝、部署、merge或大量feature實作。全公會fixture、schema design、失敗案例設計可並行；真正private persistence/外移寫入依安全技術前置逐項啟用。

## 3. 現有來源與 KEEP／MODIFY／NEW／GENERATED

- KEEP [原平台71項RQ及決策](../../07-decisions-risks-traceability.md)、[原平台驗收](../acceptance-matrix.md)、[foundation60](../unified-foundation/acceptance.md)+[R2/AP108](../unified-foundation/source-acceptance.md)，不改歷史狀態或假造實跑
- MODIFY 此次僅在 canonical baseline/decision/index加明示target amendment與本spec索引；舊code行為與既有production授權保持原紀錄
- NEW 本目錄13份SP及輔助文件/追蹤validator；runtime NEW proposal另見[repository map](repository-map.md)
- GENERATED 本輪只有既有 `scripts/update-inventory.py` 生成source inventory；不重生/改preview bundle或SDK

## 4. 資料模型與規則優先序

權威順序沿現有07§1.1：使用者明示產品決策→canonical requirements/本次明列target amendment→領域契約/ADR→參考來源→legacy程式現況。這不是允許忽略既有安全/授權/發布規則；實際能力永遠由精確source與證據描述。

| 既有說法 | 本次target取代範圍 | 保留/過渡及影響文件 |
| --- | --- | --- |
| 一個主要+最多兩個次要 | D01–03：每個會員每類最多一主力，三類可不選滿，加入數不受三個限制 | 只取代偏好/導航模型；membership、tier、office、技能、private ACL保留。README、DESIGN、guild-library-layout及onboarding API均需清楚標legacy current，SP01定expand/backfill/compat |
| 所有業務權威永久中央API/PG | D11–18：平台身份/資格/registry等控制面仍中央，tenant業務按module instance可有external唯一writer；中央最小保留 | AGENTS/CONTRIBUTING/README的**目前實作**描述仍成立；target domain authority由SP02/05/08/10明定後才switch，沒有直接給external DB權限 |
| 每個guild/工具各自一站/一DB | D04/08/10：全部有效guild共用shell，定義/instance/tenant分離 | 動態公會同default workflow，deepening可並行；不以幾個漂亮空card代替M1 |
| ERP link就是平台ERP整合 | PR105只為原作試用入口 | 原PR保持獨立；MIT來源參考與可啟動app/tenant/資料移交是不同工作 |
| portable activation就是資料外移 | existing BLD01–04是程式/plan/contract可信安裝 | SP07資料包與SP08單module authority handover是新增能力，復用既有trust/fencing而不混同 |
| 新spec/綠燈就是foundation完成 | 新60個T全部not_run | 168來源要求、真人/provider/治理/恢復/原平台UAT保持既有驗收門檻；合併與啟用分開 |

Trace node：D{id,statement,requirements,specs,tests}；R{id,exact source text,chapters,decisions,spec,tests,existing_files,dependencies,original_ledger_refs,status,evidence}；T{id,scenario,expected,requirements,specs,fixture,procedure,status,evidence}。D/R/T/既有RQ/UF/AP/R2/GOV各自命名空間，T-001不能與原T01混同。

## 5. 契約、讀取與錯誤

本spec不新增HTTP。`traceability.json` schema marker是文件工具用 `freedom.guild-launchpad-spec-trace/v1`，不是runtime contract。原JSON中的D/R/T與chapter edges原樣保留，新增repo/ledger edges明標related/constraint，不宣稱一對一equivalence。

`validate-spec-pack.py` read-only輸入固定本目錄trace+spec與repo檔案；檢查expected ID set、無duplicate、雙向映射、實際existing_files、原ledger ID存在、每SP1–10章、全60 evidence空且not_run、本地links。失敗exit非0並列精確path/id；不自動修canonical、不連production。官方技術來源與source digest不構成簽章/權限。

## 6. 狀態與異常處理

規格狀態只有draft/reviewed/superseded；產品狀態獨立planned→implemented_not_verified→verified_local→verified_staging→released，每次升級附真evidence。檔案缺失/原JSON不一致→資料對帳失敗，修spec後重驗；來源更新→記diff/affected workstreams，不用舊PASS換新SHA。權限/工具缺失→not_run+原因；未知結果保留，不編造。

驗收new case不能取代原ledger整列。已通過某local test只在該evidence明列，不把相邻R2或AP需求一起closed。接續worker沒有完整source時只繼續不受影響工作，將實際缺口交回單一整合owner。

## 7. 閱讀與操作體驗

索引以13SP和三條線導引；首次讀者可直接從產品流程找到資料/接口/權限/失敗/T-ID，不需原聊天。每一份標明current/target/proposed/unresolved；public UI、本人tenant、guild管理四種view有不同資料界線。此次文件沒有新增screen，也未做UI/browser驗收。

## 8. 遷移、匯出、清理與回復

Spec修訂保留穩定ID，新增replacement/superseded_by不重編歷史。對舊preferred guild與central authority的遷移只寫計畫，未改SQL或API。內部平台expand/backfill/switch/contract與使用者後續module外移是兩個不同遷移；不能用一腳本同時做。文件可回復不代表DB/authority可以降版。

## 9. 威脅與容量

輸入計畫/ERP/README是需求和參考，不是讀秘密/改rules/執行遠端腳本的授權。公開PR只放衍生spec/公開source pin，無raw chat、客戶、token或備份。ERP MIT不重新授權中央；原作未找到不猜。多人並行共享schema/identity/registry各只一個authoring責任，不互相覆寫files。

本轮没有新硬體/儲存/模型成本承諾；正式quota/retention/SLO集中[decision log](decision-log.md)，不可用『未設定』放行unlimited。

## 10. 驗收、發布與證據

T-060未執行產品驗收；本次靜態追蹤核對是它的文件準備材料，不是完整T-060 runtime/consumer採用證據。實際跑過的命令記[verification](verification.md)，完整60案見[acceptance](acceptance.md)。

完成本次spec PR需要：13spec各10章、22D/64R/60T原關係無漏、實際檔案映射與open questions、source/授權邊界、documents/link/inventory/contracts檢查、獨立交叉審查、遠端exact tree/head核對。Draft PR不等於review approval、merge、deployment或production readiness。
