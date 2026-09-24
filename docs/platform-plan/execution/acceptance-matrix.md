# Acceptance matrix

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

T01–T26保持穩定，新增T27–T34與UAT-M1–M5。下表產品／營運／真人測試仍為「未跑」。契約 fixture 靜態檢查見 `../verification/2026-09-19-revision-check.md`；本機 scoped runtime milestone 見 [`docs/releases/2026-09-20-local-core.md`](../../releases/2026-09-20-local-core.md)（login→claim→submit→accept→gains 原型）。兩者都不代替下表，也不宣稱完整 package、milestone、部署、真人使用或收款證據。Fixture、命令與 evidence path 是預定位置，不表示對應產品測試已跑。Owner 以「職能（建議預設：人名）」對回 `spec-index.md` 與 `06 §4`；所有分工皆為建議預設，五人共同閱讀確認。平台建置檢查固定為 Grok adversarial review＋Claude verification＋自動 checks。

| ID | 分類 | assertion | fixture／執行方法 | owner | A4 語意 | 預定 evidence | 狀態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | contract／integration | 同 request／receipt 重送不重複 claim、contribution、publish 或 payable；每次按 current authority 判定 | duplicate request／receipt replay＋ledger count | Platform（建議預設：Ted） | 無 | `execution/evidence/T01/` | 未跑 |
| T02 | unit／contract | 同 idempotency key 配不同 body 回 conflict，無 partial write | body-hash pairs＋rollback assertion | Platform（建議預設：Ted） | 無 | `execution/evidence/T02/` | 未跑 |
| T03 | integration | 多 Agent claim 不超容量；stale fencing token 不覆蓋新 holder | concurrent barrier＋stale write | Work / Opportunities（建議預設：Jason） | 無 | `execution/evidence/T03/` | 未跑 |
| T04 | security | token subject／principal／acting role 不符時只拒絕該動作且不洩漏資料 | authorization matrix＋redaction checks | Identity / Security（建議預設：Ted） | 無 | `execution/evidence/T04/` | 未跑 |
| T05 | security／contract | A0–A2 不能 publish、QC sign 或改 payment terms；拒絕無副作用 | A0–A4 command matrix＋negative API checks | Identity / Security（建議預設：Ted） | Ted 三類 A4 與成員 exact A4 分別測試 | `execution/evidence/T05/` | 未跑 |
| T06 | security／integration | revoke／expiry／stale snapshot 後拒絕 consequential write；只保留允許的歷史／安全回報 | revoke race＋projection convergence | Identity / Security（建議預設：Ted） | 無 | `execution/evidence/T06/` | 未跑 |
| T07 | contract | WorkItem／source／Skill／evidence version 不符時不套用 result、不產生 accepted contribution | mismatched digests＋validator／command tests | Work / Opportunities（建議預設：Jason） | 無 | `execution/evidence/T07/` | 未跑 |
| T08 | security／integration | 換 Agent／acting role 仍不得自我驗收；`commercial-ready` 需要三個不同自然人 | principal graph＋positive／negative policy checks | Identity / Security（建議預設：Ted） | 成員／角色 assignment 接受語意保留 | `execution/evidence/T08/` | 未跑 |
| T09 | unit／contract | Agent success claim 缺 minimum evidence 時不算 pass，回 missing list | omission table＋response snapshots | Work / Opportunities（建議預設：Jason） | 無 | `execution/evidence/T09/` | 未跑 |
| T10 | integration／AI scenario check | changes-requested、補件、拒絕不錯發 contribution；revision 有 lineage 與 next step | workflow integration＋AI journey transcript | Quality / Commercialization（建議預設：Mini） | Product exact review decision 由具權當事人簽署 | `execution/evidence/T10/` | 未跑 |
| T11 | contract／operational drill | accepted outcome retracted 後 old receipt 固定拒絕；XP／matching／entitlement rebuild 不復活 | API negative＋projection rebuild／digest compare | Quality / Commercialization（建議預設：Mini） | 成員 retraction authority 依 exact artifact | `execution/evidence/T11/` | 未跑 |
| T12 | AI scenario check／integration | inactive、skip、install failure、普通逾期不自動降 rank、封會員或降低 discoverability | member scenarios＋policy assertions | Talent / Agent（建議預設：Jason） | 無 | `execution/evidence/T12/` | 未跑 |
| T13 | contract／AI scenario check | training／maintenance 不被分類或推薦理由冒充 customer delivery | classification contract＋copy comprehension checks | Work / Opportunities（建議預設：Jason） | 無 | `execution/evidence/T13/` | 未跑 |
| T14 | security | 高 XP／Master 無 active exact-scope ReviewerAppointment 不能產品 QC；Agent 不取代自然人 appointment | entitlement negative matrix | Identity / Security（建議預設：Ted） | 產品 QC exact A4 保留 | `execution/evidence/T14/` | 未跑 |
| T15 | integration | 三 CLI 取得同 approved version 時 activation／domain roots 一致且不混版 | clean-environment activation comparison | Skills / Integrations（建議預設：Ted） | 無 | `execution/evidence/T15/` | 未跑 |
| T16 | security／contract | unsigned、revoked、expired、host-shadow 或不支援 isolation 的 domain bytes 不執行 | signature／trust／sandbox matrix | Build / Release（建議預設：Ted） | Ted 對外正式 release A4 只在 release case | `execution/evidence/T16/` | 未跑 |
| T17 | security | 外部 message／Skill 的提權或換 payee 指令只當 untrusted content | attack corpus＋tool／contract negatives | Identity / Security（建議預設：Ted） | payment artifact 仍需適用 exact A4 | `execution/evidence/T17/` | 未跑 |
| T18 | provider sandbox／security | HTTP MCP audience／scope 不符固定拒絕且不 passthrough token | local MCP mock；O1 sandbox connection 存在時再跑 sandbox | Skills / Integrations（建議預設：Ted） | 無 | `execution/evidence/T18/` | 未跑 |
| T19 | operational drill／integration | queue redelivery、late arrival、worker crash 不重複 domain state；outbox／inbox／lease 可恢復 | deterministic queue fault injection | Platform（建議預設：Ted） | 無 | `execution/evidence/T19/` | 未跑 |
| T20 | contract | 無 Offer／service／Squad agreement 的成果可成 contribution，但不建 payable 或 transferable interest | agreement／no-agreement domain checks | Work / Opportunities（建議預設：Jason） | Squad agreement 的成員 exact A4 保留 | `execution/evidence/T20/` | 未跑 |
| T21 | provider sandbox／operational drill | transfer timeout 後以 stable operation key query／reconcile，不建第二筆付款 | fake provider accepted-but-timeout；Seller sandbox connection 存在時重跑 | Payments（建議預設：Ted） | `SettlementMandate` 同一 digest 需 Payer 當事人（reseller 情境下通常即 Seller）的成員 A4＋Ted 付款類一鍵 A4 | `execution/evidence/T21/` | 未跑 |
| T22 | integration／contract | price／supply revision、refund 或撤 future supply 不改 old order snapshot；reversal 追加歷史 | listing revisions、old order、refund／revoke cases | Catalog / Commerce（建議預設：Mini） | Seller listing revision、Supplier `DistributionAcceptance` exact A4 保留 | `execution/evidence/T22/` | 未跑 |
| T23 | contract／provider sandbox | fork／PR／舊版 QC 不繼承 `official`；artifact version 與 approval exact match | local git graph＋provenance checks；sandbox 可後跑 | Quality / Commercialization（建議預設：Mini） | `ProjectRelease` 成員 approval 與 Ted 對外正式 release A4 各自保留 | `execution/evidence/T23/` | 未跑 |
| T24 | operational drill／AI scenario check | provider outage、notification failure、projection lag 時既有工作仍可查；只影響相關 external action | outage switches＋recovery drill＋AI journey transcript | Platform（建議預設：Ted） | 無 | `execution/evidence/T24/` | 未跑 |
| T25 | security | raw customer data／secret 進 log、prompt、event 時攔截／redact／限權，不建中央 raw-content lake | synthetic canaries＋access checks | Identity / Security（建議預設：Ted） | 無 | `execution/evidence/T25/` | 未跑 |
| T26 | operational drill／security | restore、projection rebuild、key revoke 後 authority、valid evidence、money state 一致；revoked rights 不復活 | isolated restore＋all projections rebuild | Platform（建議預設：Ted） | 適用的付款與 release exact A4 receipts 必須保持可驗 | `execution/evidence/T26/` | 未跑 |

## 低維運互惠：產品測試增量（產品驗收未跑；部分 runtime 子集見表後）

| ID | assertion | 方法與owner | 狀態 |
| --- | --- | --- | --- |
| T27 | 新公開條款有三模式、雙方實益、投入／結束與權利；Claim pin revision/hash，改版不變舊承諾 | Work schema＋API revision／stale claim tests；WRK-01 | 未跑 |
| T28 | 實益只能本人／有權組織代表回報，Agent不可代認；不重複計數、不產生payable／Contribution | auth matrix、idempotency、projection、ledger negatives；WRK-01 | 未跑 |
| T29 | 新人／無Agent／不付費／未貢獻可求助及參與；同條件輪替，不按XP封閉派單 | Portal journey、matching reason snapshots；People／Work | 未跑 |
| T30 | Appointment不代表空閒；Work／Coaching跨模組並發reservation不超本人已接受容量 | database concurrent barriers、expiry／lease tests；Work／Coaching | 未跑 |
| T31 | 核心及非核心維持／協調計入；unknown不當0；分母0為not_available，含未完成成本 | synthetic totals／coverage／attribution tests；Platform／Results | 未跑 |
| T32 | 普通未認領志願工作到期結束；無回報為unknown；scope／episode去重且有界提醒 | frozen clock／queue replay／notification counts；Work／Notifications | 未跑 |
| T33 | 已簽履約、付款、退款、安全與正式權益爭議不可普通auto-expire；責任及升級保留 | protected-obligation expiry negatives；Work／Payments／Security | 未跑 |
| T34 | reviewer缺席時open仍可claim；available只改導航不改lifecycle／official證據 | state／command／API tests；WRK-01／QLT-01 | 未跑 |

2026-09-24 現況證據（base `8338a42` 公開會員 beta；只證明所列 scope，上表狀態不變）：

- T27 局部：建立 WorkItem 時產生 `voluntary_contribution` 條款並符合 schema；Claim pin revision／sha256 與 snapshot，條款不符 409、舊 Claim bytes 不被改寫（`tests/runtime/flows.test.ts`）。缺三模式、條款 revision API 與改版流程。
- T28 局部：需求者／承接者本人回報、append-only 修正、他人只見聚合、不改 Contribution／付款（`tests/runtime/benefits.test.ts`、[實益 API](../../development/benefit-observations.md)）。只接受會員 cookie＋CSRF，不含組織代表或跨合作週期去重。
- T31 局部：回報工時四類可分別為 null，零與未知分開（同上）；尚無總量、覆蓋率或核心／非核心投影。
- T32 局部：claim window 過期拒絕新 Claim 且不抹除已成立 Claim（`tests/runtime/flows.test.ts`）；尚無未認領自動到期、提醒或 scope／episode 去重。
- T34 局部：無回饋者時 `review_capacity=waiting_reviewer_capacity` 仍可 claim、lifecycle 不變（`tests/runtime/flows.test.ts`）；回饋者是發布者自選，不是 ReviewerAppointment，也沒有 official 標籤路徑。
- T29、T30、T33：尚無對應 runtime。

## 真人營運觀察（不是AI模擬驗收）

| ID | 最小實验／觀察 | 決策用途 | 狀態 |
| --- | --- | --- | --- |
| UAT-M1 | 約10次真人合作分列每位參與者實益、partial／no gain／unknown；不壓成任務完成率。10次是互助採樣，不是外展門檻 | 題目與互惠條件是否需修改；不阻擋平行外展／商機路徑 | 未跑 |
| UAT-M2 | 觀察自願再參與、共同目標由成員提出及合法成果重用；意願與行為分開 | 共同參與與非金錢價值，不催活躍 | 未跑 |
| UAT-M3 | 普通互助七天無核心找人催促，維持必要安全／既有履約；量測所有人的行政工時 | 核心依賴、工時及記錄覆蓋 | 未跑 |
| UAT-M4 | 兩位幫助者不再接受新工作，系統縮減新供給而不轉派核心；舊責任保留 | 容量枯竭與降載是否誠實 | 未跑 |
| UAT-M5 | 無付費需求期間觀察工具、學習、公益是否仍為本人認可的價值；公共成本有來源 | 不依赖虛構未來案源；資金及擴張決策 | 未跑 |

樣本／時間為可改工作預設，非科學通過線。觀察前固定擴張判準；未設定、資料不足或工時未知標evidence_insufficient，不擴大對外承諾，現有有容量範圍與開發可繼續。不可用降低保護措施製造無人工介入率。

## AI checks 與 Ted 三類 A4 observation

| ID | observation | 方法 | 判定邊界 | 狀態 |
| --- | --- | --- | --- | --- |
| UAT-Q1 | 真人持續意願與互惠是否成立 | AI persona僅檢查流程；以UAT-M1–M5的真人自願回報、行為及工時證據觀察 | 不作會員／開工／工程release門檻，但直接影響是否擴大對外服務承諾；未知不當通過 | 未跑 |
| A4-TED-1 | 付款 | AI 產生 exact artifact、digest、consequence 與差異；Ted 一鍵簽署 | 只作用於該付款 artifact | 未跑 |
| A4-TED-2 | 法律文件 | AI 產生 exact document、digest、consequence 與差異；Ted 一鍵簽署 | 只作用於該法律文件 | 未跑 |
| A4-TED-3 | 對外正式發布 | AI 產生 exact release／public `official` artifact、digest、evidence 與 rollback；Ted 一鍵簽署 | 只作用於該次 production release 或 public `official` 標示 | 未跑 |

成員 A4 不被 Ted 三類 A4 或 AI checks 取代：Seller `SellerListingRevision`、Supplier `DistributionAcceptance`、Squad `EngagementAllocationPlan`、Payer `SettlementMandate`、`ProjectRelease` approval 等仍由該當事人對 exact digest 簽署。

## 共通執行規則

- 每次執行記錄 contract version、fixture digest、environment、clock、principal、seed 與 command；failure 也保留。
- Provider sandbox 先有相應 O1／O2 owner connection；O3 只跑 contract tests＋deterministic mocks，不能冒充真帳號或 live。
- AI checks 取代平台建置的人類排隊；Grok report、Claude verification 與自動輸出都進 evidence。
- Ted 只處理付款、法律文件、對外正式發布三類 exact A4；成員 A4 依產品契約保留。
- `execution/evidence/` 尚未建立；沒有 artifact 時本表產品／營運／真人 row 維持「未跑」。契約 fixture 與本機 scoped runtime 另存，不填入本表通過數。
