# Freedom Platform 現況紀錄

> 現行修訂：2026-09-19；規劃與本地靜態檢查，不代表功能已部署。

本次以原始 `Freedom-Platform.zip` 與當輪檢視修訂。沒有查詢外部帳號、repo、雲端或銀行，因此「未建立」一律解讀為本包沒有可驗證的建立證據，不推定外部世界目前狀態。

## 1. 現行 inventory

原 ZIP 有 70 份有效文件（其中 69 份位於 `docs/platform-plan/`），另含 macOS metadata。本版保留全部有效原始路徑，直接修改相關來源，新增契約、檢查與交付紀錄；不攜帶 `.DS_Store`、AppleDouble 或 `__MACOSX`。

本版精確檔案數、每檔 bytes／行數／完整 SHA-256，以及相對原 ZIP 的新增／修改／不變清單，見 [2026-09-19-file-inventory.json](./verification/2026-09-19-file-inventory.json)。Manifest 唯一不雜湊自己以避免自我引用；不是 signed ContractBundle 或 release attestation。原版 2026-09-17 verification 保留不改，不能當作本版檢查結果。

## 2. 已決定事項索引

| 現行決定範圍 | Canonical 位置 | 接手時的讀法 |
| --- | --- | --- |
| P1–P13 地基原則 | `00 §1.1–1.2` | 決定即執行；只有技術依賴排序；五人核心團隊各自 own track；Ted 的 Day 1 不等待共同閱讀；AI 執行可自動化建置與檢查；人數與證據控制標籤，不停止工作。 |
| 五人分工與第一次閱讀 | `06 §3.1`、`README §0` | Ted、Hao、Mini、Jason、韋銘的分工全部是建議預設，五人共同閱讀時確認；閱讀是一次性協作，不是 Day 1 或其他工作的閘門。 |
| 架構決定與框架決定 | `07 §3` | ADR ID 維持穩定；`adopted` 表示 target design 已決定，不表示 implementation、部署或上線。ADR-066…ADR-079 固定 canonical IDs、principal、URL、PostgreSQL、Queues、12 runtimes、broker／signer、2-of-N technical planes、Agent runtime、build profiles、56 packages、單一 seam 與 SellerParty 金流邊界。 |
| Launch decisions | `07 §5` | OD-01…OD-28 全部是已決定的 working defaults，Ted 可直接改寫 canonical 決定；OD-21…OD-28 依 evidence 觸發後續工作。非 canonical 的供應商、數量與日期是建議預設。 |
| 模組邊界與唯一接點 | `02 §4.7` | 每個模組遵守 L1 core context、L2 共用 seam、L3 product repo／template、L4 runtime／queue；外部實例只經 `Connection＋Credential Broker＋Ingress＋Job API` 接入。O1／O2／O3／O4 決定帳號與事實 owner。 |
| Foundation Day 1 | `08 §13` | O1 平台基礎設施與 O2 角色帳號同日建立，O3 只建 contract tests 與 deterministic mocks；依技術依賴執行單一 Infrastructure Ready 清單，之後依 1A、1B、1C、2 推進。所有建立事實都要有 stable ID、receipt 或 evidence index。 |

金流解讀以 `02 §4.7`、`07 §3` 與 `07 §5` 為準：收款方是使用自有 `seller_collection` connection 的 `SellerParty`；平台不持有 merchant／live payment account，不作 merchant of record、escrow、wallet 或代收。每個 Seller 預設 `record_only` 且 `money_movement_enabled=false`；`authorized_mandate` 僅在 `money_movement_enabled=true`、Payer 當事人已對 exact `SettlementMandate` digest 簽署成員 A4，且 Ted 已對同一 digest 完成付款類一鍵 A4 時可用；缺任一條件即維持 `record_only`，商店、listing 與對帳照常。

本版另採 `12` 的低維運互惠運作契約，以及 ADR-080–ADR-083、RQ-066–RQ-071。工程建置可持續；擴大對外真人服務承諾需實際容量及資源證據，不以不存在的供給填補。

## 3. 尚未取得的產品與營運證據

本次新增的事實只有：來源文件已改寫、本地靜態檢查已執行、交付檔已產生。下列項目没有新增可驗證完成證據：

| 項目 | 本包狀態 |
| --- | --- |
| 帳號、九個repos、十二個runtime、正式domain／provider／connection | 規劃描述；本次沒有建立或查證 |
| API／資料庫／Work與Coaching並發容量、授權及通知 | 尚待實作與runtime測試 |
| 真人名額、志願時數、公共維護預算、付費客戶與收款 | 未提供實際承諾；設定為null／空，不偽造數字 |
| Product／Skill／Plan／Contract signed release | 沒有正式新release；不能沿用舊hash或簽名 |
| T01–T34、UAT-M1–M5、UAT-Q1與各A4／provider驗收 | 未跑；沒有真人互惠或低維運實績 |
| 本地文件／schema／範例／state圖檢查 | 已跑；精確結果與範圍见本版verification |

## 4. 接手後可直接重跑的檢查

從 ZIP 解壓後的 `Freedom-Platform/` 根目錄執行；需要 Python 3.10+。依賴檔鎖定的是本次實際測试版本，不是最新版本宣告。

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r docs/platform-plan/contracts/tests/requirements-static.txt
PYTHONDONTWRITEBYTECODE=1 python -m pytest docs/platform-plan/contracts/tests -q -p no:cacheprovider
python docs/platform-plan/verification/verify_revision.py
```

第二支程式驗證交付manifest雜湊、檔案清單及Markdown相對檔案連結，不執行product code。若已修改原始檔，manifest mismatch是合理結果，請重新建立新版本evidence，不能把舊manifest當新內容的證明。虛擬環境、cache與Git metadata不納入manifest。

原09章指向的 `/home/ted-h/tmp-scratch/...` 私有腳本不在原ZIP中，本次沒有執行；不可假稱它們驗證通過。本版可重跑工具均隨ZIP附上。

## 5. 接手者禁止誤判清單

第一次看這份計畫的人請從 `README §0` 開始。

1. 不要把 `adopted`、已決定或 working default 解讀為 implemented、deployed、released 或 live。
2. 不要把 planning fixture 的 signature、digest、ID、URL、key、nonce 或 schema-valid 結果解讀為 cryptographic 或 production evidence。
3. 不要把 GHE 寫成 GHES；現行決定是 GHEC non-EMU。
4. 不要把 PlanetScale-hosted PostgreSQL 寫成 Cloudflare 原生 PostgreSQL。
5. 不要把 Queue 或 Workflow 當成 canonical job state；PostgreSQL 才是 aggregate、event、outbox、job、attempt、lease、inbox、reconciliation 與 projection 的唯一真相。
6. 不要把 `SubmissionDraft.confirm`、LINE／Discord message 或 Agent receipt 當成 A4、server attestation 或對 remote current bytes 的證明。
7. 不要宣稱 R2 native binding 具備 put-only IAM；public、private、quarantine 必須使用不同 bucket、binding 與 credential 邊界。
8. 不要宣稱 Freedom 能強制 external fork 的 ruleset、workflow 或 HTML 內容；external fork 固定是 unmanaged／community fork／not official。
9. 不要把 GitHub Pages 當作 Portal、API、checkout、SaaS runtime、credential boundary 或 private data host。
10. 不要讓 project repo 自選 trust root、channel 或 Skill source；共同控制 Skill、plan、contracts 與 revocation state 的來源以 `07 §3` ADR-049 為準。
11. 不要因帳號與資源目前未建立而縮小 Foundation Day 1 scope；Ted 處理付款、法律文件與真人身分動作，AI 依 `08 §13` 完成可自動化設定。
12. 不要把 `signed_isolated_overlay_v1` 解讀為任何 equipped Skill 都可執行；signed overlay、exact runtime QC、current revocation、roots-set equality 與 per-run isolation 缺一即 `capability_unavailable`。
13. 不要用本現況紀錄覆蓋 canonical 規格；決定變更要直接同步相應 canonical prose、contracts 與 trace，並保持既有 ID 穩定。
14. 不要新增 `pending_master`、admission approval 或 Master 簽名後才能繼續的路徑；加入既有 Guild 永遠 self-service 直達 `runner`，welcome／support card 可略過且沒有後果。
15. 不要把 private Discord、starter progress、member installation、stuck／skip 或 connector 缺失變成人身阻擋條件；它們使用 `enforcement=navigation` 並可轉成 WorkItem。
16. 不要用 package `capability_readiness`、equipped set 或 AgentRun 冒充某 member＋AgentConnection＋PackageVersion 已實裝；只認 `MemberSkillInstallation` receipt。
17. 不要復活模糊的 adoption event 或 aggregate；精確事實使用 `equipped_skills.replaced` 與 `member_installation.*`。
18. 不要把平台當成收款方、merchant of record、escrow、wallet 或代收方；SellerParty、payer 與 beneficiary 各自持有 purpose-tagged connection，平台只存 ref、digest 與 fact。
19. 不要把 `record_only` 解讀為商店、listing 或對帳停止；缺少同一 exact `SettlementMandate` digest 上的兩個必要 A4 時，只讓 money movement 維持關閉。
20. 不要把五人核心團隊的建議預設 holder 混成單人模式：Ted、Hao、Mini、Jason、韋銘依 `06 §3.1` 各自持有 track；同一自然人兼任不同 office 或產品角色仍只算一人，不同自然人的條件只控制 `official`、`production-signed` 與 `commercial-ready` 標籤。
21. 不要把任何文件檢查輸出解讀為產品測試已跑；產品與營運測試的現況一律是「未跑」。

## 6. 本版新增的接手注意

不可把 reviewer 的 `available` 當作已預留真人時間；不可把 `waiting_reviewer_capacity` 放回 WorkItem lifecycle；不可把 unknown 當0或把未收款當得利；不可讓志願到期抹去已簽履約／付款／退款／安全／正式權益責任。舊Claim pin原條款，擴張新服務前須重新確認容量與資源。
