# Foundation Complete 收尾

本輪固定研究來源為 `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`（包含 #129）。
目前仍未完成共同基礎 sprint。保留 React／Hono／Workers／PostgreSQL／R2，
暫停非必要功能擴張，按原需求收尾。

[現況快照](current-state.json)是已合併版本、已部署版本、schema 觀察、功能狀態、
治理 pins 及 client 支援範圍的唯一彙總入口；每筆都有自己的觀察時間及證據界線。
[需求證據索引](requirement-evidence.json)承接 [INT／GOV](acceptance.md) 與
[R2／AP](source-acceptance.md) 的原文、最低證據層級及所有 168 個 ID。
歷史 handoff／release-readiness 保留當時證據，不再維護另一份 current 狀態。

## 判定方式

- `not_run`：尚無足以支持實作或執行的映射。
- `implemented`：找到相關實作，仍缺原要求的必要驗收；不表示整條需求已實作完整。
- `partial`：已有部分實際執行證據，必要情境或最低環境尚未齊備。
- `blocked`：列出使整合驗收無法進行的具體相依條件及責任人，不能代替一般未完成工作。
- `accepted`：原要求所有必要正反例及最低證據均具備，附 source／candidate／環境。

測試原始碼存在不等於本輪測試通過；本機、隔離 CI、真實 GitHub、browser、
cloud、正式營運證據不得互換。Feature OFF 是發布設定，不是驗收結果。
168 是來源要求數，額外 R2 G／AP INV 原則與每列的多個必要 case 仍然保留。
後续 PR 更新同一索引的對應列，不以新增檔案、測試或 commit 數當作完成率。

## 八個完成門檻

| 門檻 | 收尾結果 | 整合責任 |
| --- | --- | --- |
| FC-00 | 現況、Agent 入口及 168 項需求可對帳，歷史不冒充 current | 整合 owner；A–D 各自維護證據 |
| FC-01 | 真人／執行端／網站服務各自驗身分，共用交易與稽核；所有私人讀面、replay／finalize 撤權通過 | A，D 協作 |
| FC-02 | 七類共用儲存、writer／reader floor、legacy bytes、GC／retention 有驗收結果 | B |
| FC-03 | 當前版本可還原，另一位有權操作者在新環境可接手 | B |
| FC-04 | 每倉適用 profile、實際 library 解析及呼叫、全部入口與正確 context | C，A／D 協作 |
| FC-05 | 偽造／過期／違規被拒，合法修改與升級可通過；一個有效 review 加明確合併授權 | C |
| FC-06 | 本人 CLI／BYOK、Grant／Attempt、私人 Result、Stop／Revoke、重連及 Extension／neo 交接 | D |
| FC-07 | 同一候選版本完成會員、私人 AI、contributor、第二操作者恢復四條流程 | 整合 owner |

## 第一批小工作包（保留研究起點）

每包固定來源、隔離 worktree、可改範圍及必要反例。共用 manifest／索引／入口由整合
owner 協調。依賴未齊時保留缺口，不把它改成 N/A 或自動移到下一個 sprint。

FC-00 本批先統一中央入口與索引。
[有界 context 證據](context-chunks-evidence-2026-10-05.json)在 exact candidate `664c05b` 接受 GOV-07 的 context-tool 層級：乾淨 worktree 的 root／deep module 都取得完整規則。GOV-09 client/subagent 接線與 GOV-10/12 hosted CI 仍有獨立未驗項。
Agent Kit README 的「先完成定位」仍需對齊中央
「定位可稍後補做」；各倉入口接線與真實完整 prepare 通過前，FC-00 不算完成。

| 工作包／原要求 | 已確認的缺口 | 下一個可驗收結果 |
| --- | --- | --- |
| C1：GOV-16、R2:D04 | `verify.needs` 及 aggregate 的第二份 job 清單都漏掉 `deploy-preflight` | 將 preflight 納入；full 必須 success，docs 可正常 skip，missing／failure／cancelled 拒絕。獨立審查後再升級 installed workflow pin |
| A1：R2:A03、FC-01（session 到期回歸） | 已以實際 receipt lock wait 重現並修補七個 media adapter 及 ordinary member command 的 session deadline 缺口（見下方證據） | 用隔離 PostgreSQL 的 receipt SELECT／INSERT barrier 跨過到期時間重現；保留既有 digest／namespace，修補後證明授權有效的 replay 正常 |
| B1：R2:S02/M05、FC-02 | 已以 DML-only role 重現 asset＋bytes INSERT，新增 migration116 修補；舊 SQL 與 bridge bytes 保留 | 先以 restricted runtime role 驗證 r2_only 下 INSERT／UPDATE 反例；若重現，以新增 migration 封口並保留合法 R2 寫入及 bridge backfill |
| C2：GOV-07/09/10/12 | DESIGN.md 與全 scope 大小阻礙已修補；完整分片仍保持每件 artifact 上限及全部規則 | 精確允許 DESIGN.md，保留任意根檔拒絕；後續有界分段載入含 baseline/candidate/delta 的完整必要規則，不能靜默截斷或縮 scope 避開未知修改 |
| D1：AP:AUTH-13/14/15、UF:INT-07/09/25 | 中央 device/bootstrap／member broker 已存在；Kit client 及 official CLI adapter 尚未完成 | Kit 接既有 API；一條受控真實 CLI／BYOK 工作走 Grant→Attempt→Result→修改→Stop／Revoke／換端，不拿 CLI pong 代替平台驗收 |
| C3：GOV-03/04/05/06/23 | 四倉有界 runtime 尚不證明共用 library 被呼叫，其餘五倉缺適用 profile | 真實 build resolution＋call path；unused import／自寫同形 client 必須失敗；cron／queue／MCP／bridge 按適用入口納管 |
| C4：GOV-04/06/20 | directory profile 固定完整 markup/styles bytes | 保留授權、escaping、URL／資料／輸出邊界反例；合法 style／wrapper／可及性修改可通過。獨立審查信任材料及 reference 升級 |
| B2：R2:S10/M06/M07/M08 | daily backup 明確要求 GC OFF；retention 只有 planner；歷史 unsettled PUT 尚未結案 | 先核對當前 schema 的 restore／reader floor；將持續 pins 與有界 retention executor 接回既有 coordinator，再驗 GC 相容，不直接開 flag |
| B3：R2:M07、AP:OPS-07、UF:INT-18 | 現有排程與恢复依賴原操作者主機 | 第二個有權操作者從新環境、受控秘密來源完成隔離 restore，驗舊授權不復活、unknown 不重播；列出 RPO／資料遺失範圍 |
| A2：UF:INT-04、GOV-25/26/29 | service/site schema 不代表 service adapter 已完成 | 具名 service entry 驗權，保留身分用途與環境分離；禁止改寫已驗證交易核心 |
| A3：R2:D09、GOV-05 | App／API 與 surface descriptors 有責任漂移 | 把工作 UI／路徑掛載拆回既有模組，驗證原業務、三主題、mobile、焦點、autosave 與聊天行為 |
| C5：UF:INT-23 | migration scanner/helper 仍 NNN | migration v2 同時升級兩個 runner，驗逆序 merge 與空庫 replay；保留所有已套用名稱／digest |
| C6：UF:INT-17、R2:D02/D03 | 一般修改仍 full CI | 影響映射保守 fallback，驗 Command／ArtifactRef 與 runtime MD 選中對應 jobs，不改最低證據 |
| C7：FC-05／原交付計畫 | 日常全倉 inventory 尚無 release 替代 | release/archive 的 artifact 與歷史 migration 完整性檢查接妥前，保留既有檢查 |

上表保留最初工作包。A1 receipt 到期與 B1 social bytes writer 已用隔離 PostgreSQL 重現並修補；精確版本、正反例及尚缺的雲端驗收見需求證據索引。C2 的完整 context 分段已在乾淨 worktree 驗收，GOV-07 依其原訂 context-tool 證據層級接受。其他套件、CLI 與治理來源修補仍是待審候選。

A1 的 [隔離 PostgreSQL 證據](receipt-session-evidence-2026-10-05.json)記錄修補前 21 個到期反例、修補後七個 media adapter 與 ordinary member 的拒絕／有效 replay；它只關閉 receipt 等待跨 session 到期的子項，未接受整列 R2:A03。

B1 的 [隔離 PostgreSQL／native local R2 證據](social-writer-evidence-2026-10-05.json)記錄三個 INSERT 反例與合法 R2、bridge、crypto bytea 正例。這只關閉 social thumbnail writer 缺口；R2:S02/M05 的全 purpose／目標環境驗收仍未完成。
現有 member broker 已經掛載並重查 owner／Grant／資料權限，不重新發明一套機器交易核心。
單純綁死 generic journal 的 target 會破壞「collection 建立新 Work」的合法不同 target，
不採用這個未證實的修補建議。

## 治理主路徑決策

沿用已安裝的 GitHub 原生固定 workflow 作為 PR check 發布及合併主路徑。
Detached check publisher 保留為尚未安裝的選配能力；沒有離線／外部執行需求時，
不增加第二個必要 publisher 或人工批准。此決策取代舊 P2 文件「必須安裝
detached publisher」的工作順序，不撤回 GOV-02／19 或 artifact 的來源、簽章、
版本、撤銷與 ReleaseSet 驗收。

已固定 selector／aggregate 不代表 candidate 提供的所有測試都是獨立 harness。
升級既有 workflow 時，先以可信來源的必要行為反例與合法修改正例建立邊界，
再做 fork 隔離、supersession／新 base、偽造 check 及空測試集的真實 GitHub 驗收。
不得把不可信 fork 程式與正式秘密放在同一有權工作中。
一份有效 review 及明確合併授權即可，不新增同義簽核。

## 本輪研究與實測界線

四線共 12 個 Grok CLI 工作包，指定 `grok-4.7`，provider 回報實際 alias
`grok-4.7-build`；另有兩份 `agy` `claude-opus-5-5-high` 審查。
部分 Grok 初次在 plan／turn limit 停止，已從原 session 接續取得結論；不把
退出碼 0 當成研究完成。兩份 Opus 使用給定的公開來源節錄，沒有工具執行。
所有建議另由整合者及各線核對來源；模型呼叫本身不是產品證據。

目前的本機修補結果記在 [patch evidence](closeout-patch-evidence.json)。這些結果
不等於已合併、installed pin 已切換或已部署，也未執行正式 DB／R2 私有操作。
正式站 fresh health、Access 回應、既有 operator 及 GitHub 證據分別見現況快照。

後續每次回報列出：關閉的原要求、新增／解除的實際阻礙，以及證據的
source／candidate／環境。FC-07 未通過前不宣告 Foundation Complete。

## 候選整合觀察（2026-10-05）

正式 source／部署／pins 仍以本頁開頭的具日期快照為準。平台 #130–152 各自取得有效 review 後，已由 #154（`558e4843`）以 merge commit 保留每個已審 head 一併合併；Agent Kit #17/#18 另行處理。每份 review 保留自己的來源與最低證據；合併不代表已部署、已升級 installed workflow pin 或已執行正式 migration。共用 library producer `057201218b6d4ae3e96b4ab838677f2b484b55fa` 保持固定。

原 168 項中，GOV-07 已依 context-tool tier 接受；R2:M07 已依當前候選 schema116 的完整 DB＋R2 restore tier 接受；UF:INT-04 已依固定候選 `533523f3f608f549e43fe1d2c9b59c27e796c0ec` 的 DB＋HTTP tier 接受（有效 site key 指定他人 principal／private Asset 即拒，own-site 與真 owner 正例成功），不代表雲端 rollout 或完整 service credential 生命週期。第二操作者接手仍是 FC-03，完整外部執行恢復仍是 AP:OPS-07，沒有借這一列的成功結案。其他原要求的狀態／反例／owner 以 [需求證據索引](requirement-evidence.json) 為準。

[跨包整合證據](composition-evidence-2026-10-05.json) 記錄 `697a995dc8f9ff15c77af62e3146d0721e67b550` 的核心、治理、備份與真實 CLI/build 回歸；只增加 App 拆分的 `de4bbee05baa893314f44839f82b75aad7f43cd9` 另通過真實會員 browser journeys。App 業務已拆回既有模組；API 掛載／完整 surface coverage 仍在收尾。這些是本機精確版本觀察，不是 FC-07 四條完整目標流程的驗收。

Agent Kit candidate `ff273fce3b65f7ebda3e6f0918d58e8ede2520ca` 已有共用 command／SDK 的實際 CLI 呼叫證據。舊 installed host 仍要求舊 profile；必須完成配套 review 與 host 升級才能採用，不能由 consumer lock 自行切換信任。其他入口仍不宣告 invocation coverage。

#130 的 `9f2630527de88ab4893b8ec2fd434259e063b15f` 與 #131 的 `44435955dbe7ae2f854fbb47daf3ec1f50fc5fba` 已直接查到完整 verify、CodeQL 與 deploy-preflight success；此觀察不代表已安裝 preflight 修正的新 workflow pin或已部署。原生 Grok startup／prompt ingress、真正 machine BYOK 的 Grant／Attempt／Result、GOV-25/26/29 的 service 用途、migration DAG profile／release floor、GC／retention 與第二操作者仍各有明確待辦。

## 2026-10-05 收尾 review 索引

下列 review 各自保留 exact head 與證據界線，不改寫現況快照的已部署版本／治理 pins。原168列由整合 owner 在 landing 對帳：各 PR 的列變更依自身 fork point 計算後套用，UF:INT-23 採 #149 的超集證據。

| 工作包 | review 與可驗證結果 | 仍未完成 |
| --- | --- | --- |
| C1 | [#130](https://github.com/FreeTWAI-AI/freedom-platform/pull/130)：aggregate 包含 deploy-preflight，full/missing/fail/cancel/docs-skip 分開判定 | installed workflow 升級與真實正反例；舊 hosted partial retry 超過原900秒窗口，不能記 pass |
| A1 | [#132](https://github.com/FreeTWAI-AI/freedom-platform/pull/132)：receipt SELECT/INSERT 等待跨過 session 到期會拒絕，合法 replay 保留 | 其餘私人讀面與正式環境驗收 |
| B1 | [#133](https://github.com/FreeTWAI-AI/freedom-platform/pull/133)：新 migration116 阻止 asset 標籤繞回 DB bytes，正常 R2 與 bridge 保留 | 正式 migration/floor、legacy bytes 退出 |
| C2 | [#134](https://github.com/FreeTWAI-AI/freedom-platform/pull/134)：完整分段 context 與独立 verifier 相依閉合；GOV-07 在 exact664 candidate 滿足原context-tool層級 | supported launcher/client、subagent 實際採用及 hosted 邊界 |
| D1 | [#135](https://github.com/FreeTWAI-AI/freedom-platform/pull/135)：sessionless device SDK、一次性 response-loss 與撤銷反例 | Grant/Attempt、私人Result、本人CLI與持久重連；僅AUTH13/14部分證據 |
| C3 | [#136](https://github.com/FreeTWAI-AI/freedom-platform/pull/136)：host 選定的 library profile 與 canonical 合法升級 | 實際 library invocation、其餘repo/entry、installed tuple 升級 |
| B2 前置 | [#137](https://github.com/FreeTWAI-AI/freedom-platform/pull/137)：未知 archive object 同時阻擋 prune 及舊 capture pin release | retention executor、GC日常啟用、第二操作者接手 |
| C4 | [#138](https://github.com/FreeTWAI-AI/freedom-platform/pull/138)：真實 build 容許合法CSS/ARIA修改並拒絕資料/安全反例 | 獨立review後 hosted canary 與固定workflow升級；非browser視覺驗收 |
| B3 前置 | [#139](https://github.com/FreeTWAI-AI/freedom-platform/pull/139)：daily snapshot pins 保護退役原物件；R2:M07 在 exact `ae239d38` 的完整 DB＋R2 restore tier 接受 | 第二操作者新環境接手（FC-03）、AP:OPS-07 外部恢復、雲端 readback |
| D2a | [#140](https://github.com/FreeTWAI-AI/freedom-platform/pull/140)：有界 native text 程序邊界、preclaim lease fencing；真實 Grok 在 claim／context 前即判定不可用 | 實際模型推論、authenticated receipt 與 Result finalize |
| A2 前置 | [#141](https://github.com/FreeTWAI-AI/freedom-platform/pull/141)：shop key 在交易等待中到期即拒絕並 rollback，含 replay | 共用 site/service principal 見 #151 |
| C3 producer | [#142](https://github.com/FreeTWAI-AI/freedom-platform/pull/142)：固定 producer `057201218b` 匯出 canonical device command 與 launcher | Agent Kit 配套 review 與 installed host 升級 |
| C3 | [#143](https://github.com/FreeTWAI-AI/freedom-platform/pull/143)：固定 host 下實際執行 Agent Kit canonical device CLI；candidate lock 不能選 authority | 其他入口 invocation coverage |
| App 拆分 | [#144](https://github.com/FreeTWAI-AI/freedom-platform/pull/144)：portal 業務 panel 移回既有模組 | 完整 App/API 責任切分與 surface audit |
| C5a | [#145](https://github.com/FreeTWAI-AI/freedom-platform/pull/145)：單一有界 migration planner；缺漏、修改或未知的 applied ledger 拒絕 | host 核准的 DAG profile、release floor |
| C3 | [#146](https://github.com/FreeTWAI-AI/freedom-platform/pull/146)：只允許已審的前一版與目前 consumer tuple；未知／混合 tuple 拒絕 | installed native workflow pin 升級 |
| D2a | [#147](https://github.com/FreeTWAI-AI/freedom-platform/pull/147)：機器 text command 以真實簽章 device 與 locked SQL authority admission | 掛載的 machine HTTP endpoint（D2b）、broker 與 Result |
| D2a | [#148](https://github.com/FreeTWAI-AI/freedom-platform/pull/148)：model／Asset authority ports 共用，member constructor 權限不變 | 具體 machine adapter、broker dispatch、Result 整合 |
| C5b | [#149](https://github.com/FreeTWAI-AI/freedom-platform/pull/149)：兩個 migration 入口共用 pinned runner，A→B／B→A／空 catalog 結果一致 | DAG profile 與 release-floor set 語意（C5c）、雲端執行 |
| C6 | [#150](https://github.com/FreeTWAI-AI/freedom-platform/pull/150)：bounded frontend 葉節點修改保留必要 jobs，只略過無關 consumer／deploy jobs | installed workflow 升級；不宣告 hosted 成本節省 |
| A2 | [#151](https://github.com/FreeTWAI-AI/freedom-platform/pull/151)：site service authority；UF:INT-04 在 exact `533523f3` 的 DB＋HTTP tier 接受 | GOV-25/26/29、雲端 rollout、service credential 生命週期 |
| API 組合 | [#152](https://github.com/FreeTWAI-AI/freedom-platform/pull/152)：私人 AI transport 安裝路徑集中到單一 classifier | 完整 App/API 責任與 surface 義務 |

同一整合程式候選 `3bc3eb6843d0e7112fc231212a1e7169094cad08` 的本機 HTTP/DB、治理工具、schema116 七類媒體 restore 都有實跑結果；FC-07 所需四條完整流程仍未齊全，不能用這些回歸結果代替。

## 2026-10-06 收尾 review 索引

#154 land #130–#152 之後，#155–#159 與 #161 各自取得有效 review，依序以 merge commit 合併（括號內為 merge commit）。需求證據索引只在對應列附加各 PR exact head 的執行證據，沒有任何列改變狀態，accepted 仍是 3 列。合併不代表已部署、已升級 installed workflow pin，或已在任何環境套用 migration 116–119。

| 工作包 | review 與可驗證結果 | 仍未完成 |
| --- | --- | --- |
| 整合 | [#154](https://github.com/FreeTWAI-AI/freedom-platform/pull/154)（`558e4843`）：#130–#152 的已審 head 以 merge commit 一次 land，需求索引依各 review 的 fork point 重算 | installed workflow pin 升級、部署、migration 116–118 套用 |
| C7 | [#155](https://github.com/FreeTWAI-AI/freedom-platform/pull/155)（`cc06e7ed`）：exact Git source tree 的 archive／verify／restore 工具；`570d1aba` 完整還原後 `git write-tree` 與 source tree 相同 | daily 全倉 inventory 不變；release workflow、ReleaseSet 與 inventory 移位未接；不關閉任何原要求列 |
| C5c | [#156](https://github.com/FreeTWAI-AI/freedom-platform/pull/156)（`81610f93`）：release-compatibility host v3，exact `(name, sha256)` 集合、host-only DAG profile 與相依閉合；v2 host 不變 | 安裝到 preflight／operator、真實 `v2_` migration |
| B3 | [#157](https://github.com/FreeTWAI-AI/freedom-platform/pull/157)（`70ed4724`）：producer 程序與 container 結束後，新程序只靠 handover 檔與 operator 提供的 identity 還原 sealed media recovery set | 第二位授權操作者在新環境接手（FC-03）、外部 recovery generation；不關閉任何原要求列 |
| D2b | [#158](https://github.com/FreeTWAI-AI/freedom-platform/pull/158)（`e8484245`）：已登記 device 以 DPoP＋SQL admission 執行 machine model Step；一次性 broker 授權只存 digest，broker 重讀 SQL 後跑既有 BYOK Step；migration 119 | 真 BYOK、Worker／key profile 安裝、reader floor、CLI custody、重連、Extension／neo |
| B4 | [#159](https://github.com/FreeTWAI-AI/freedom-platform/pull/159)（`b8fa58a8`）：還原較舊的 DB snapshot 後，SQL 中已被 rotate 的 credential 回到 active，但 fresh broker 讀到外部 authority floor 4，claim／issue／bridge／rotate 都被拒絕，provider 不會被呼叫（owned 雙 PG18、本機 Miniflare authority） | 與部署的獨立 authority 及遠端 generation readback 結合、第二位操作者、雲端 R2 |
| 頭像 | [#161](https://github.com/FreeTWAI-AI/freedom-platform/pull/161)（`626e56c3`）：沒有 model key 與 BYOK 已撤銷的會員在 Private AI 關閉時，把頭像存到 `r2_only` 共用 R2（ui-e2e 第三個 pass，本機 Miniflare R2） | 雲端 R2 上的同版本正例、綁定整合 candidate |

### 10 月 6 日：installed workflow pin 與 staging rollout

中央 `24469536` 的 required workflow 已固定到 `d1c9e18f`（#167 合併後的 main），C1（#130）與 C6（#150）的
selector／aggregate 現在由 installed pin 執行；C6 沒有另做 hosted 正反例。一次性 probes 實際驗到：換 pin 後舊綠燈被拒、
close／reopen 重驗、base 前進後 strict freshness 拒絕、選中的 deploy-preflight 失敗被拒、竄改加偽造綠燈被拒、
fork 竄改被拒，以及 hostile fork 沒有 secrets 或寫入權。以 main 為目標的正例 green，負例 merge 405。
GOV-15 依此改為 `partial`；GOV-16／R2:D04／GOV-17／R2:D07 附加證據但不改狀態，accepted 仍是 3 列。
候選 npm script 可讓選中的 suite 跑 0 tests 而 verify 仍成功（probe E），這個缺口未修。

同一 d1c9 只部署到 staging：37／37 selected checks，migration 114–119 由 staging migrator 套用。
production 仍是 10 月 6 日 hotfix `e07d61d2`；production rollout 與 `FREEDOM_SHOP_KEY_POLICY` 的值待 owner 決定。
細節見[現況快照](current-state.json)與[治理安裝紀錄](governance-installation-2026-10-04.md)。
