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

### 10 月 6 日：installed workflow pin 與 staging／production rollout

中央 `24469536` 的 required workflow 已固定到 `d1c9e18f`（#167 合併後的 main），C1（#130）與 C6（#150）的
selector／aggregate 現在由 installed pin 執行；C6 沒有另做 hosted 正反例。一次性 probes 實際驗到：換 pin 後舊綠燈被拒、
close／reopen 重驗、base 前進後 strict freshness 拒絕、選中的 deploy-preflight 失敗被拒、竄改加偽造綠燈被拒、
fork 竄改被拒；hostile fork 在執行 `test:governance` 的 jobs 只取得 Contents／Metadata 唯讀 token、Secret source None，
列出的部署／R2／provider／signing／OIDC 變數都不存在，push 被拒；預設 `persist-credentials` 下候選程式仍讀得到該唯讀 token。以 main 為目標的正例 green，負例 merge 405。
GOV-15 依此改為 `partial`；GOV-16／R2:D04／GOV-17／R2:D07 附加證據但不改狀態，accepted 仍是 3 列。
候選 npm script 可讓選中的 suite 跑 0 tests 而 verify 仍成功（probe E），這個缺口未修。

同一 d1c9 先部署到 staging：37 個 selected checks，migration 114–119 由 staging migrator 套用，
`FREEDOM_SHOP_KEY_POLICY` 為 `legacy-compatible`。owner 於 20:34Z 核准後，21:13Z 部署到 production，取代 hotfix `e07d61d2`：
migration 前的備份做過隔離還原與遠端 readback（第一次在 capture 階段因單一 R2 物件讀取逾時失敗，重跑一次通過），
migration 114–119 由 production migrator 套用，`FREEDOM_SHOP_KEY_POLICY` 用與 staging 相同的 `legacy-compatible`；
22 個唯讀公開 checks 通過，5 次 fresh health 都是 d1c9，兩個環境的 backup pin 都改成 d1c9。這些是 selected checks，不是 foundation acceptance。

同日第二輪：owner 於 21:35Z 核准後，main `8d2213d7`（d1c9 之後的 #180／#182／#162）於 21:52Z 部署到 staging：
37 個 selected checks 通過，部署後 cron 有寫入，after-rollout 備份做過隔離還原與遠端 readback。
22:12Z 再以同一份 dist 部署到 production：22 個唯讀公開 checks 通過，5 次 fresh health 都是 8d2213d7，
after-rollout 備份通過，部署後 cron 有寫入；兩個環境的 backup pin 都改成 8d2213d7。同樣是 selected checks，不是 foundation acceptance。
這一輪沒有 migration（兩個 ledger 唯讀確認到 119、無 pending），`FREEDOM_SHOP_KEY_POLICY` 維持 `legacy-compatible`。
#162 的具名 prepared statement 只在 Private AI 開啟（兩邊都關）或尚未部署的 credential broker 才會執行，
所以這一輪沒有在 Hyperdrive 上驗到它。回滾是重新部署 `d1c9e18f`，不需要還原資料。
改成 `purpose-bound-only` 前要先完成 agent-commerce 的 controlled legacy exit。
細節見[現況快照](current-state.json)與[治理安裝紀錄](governance-installation-2026-10-04.md)。

### 10 月 7 日：installed workflow pin 升級至 6ffdf94a

中央 `24469536` 的 required workflow 於 11:15:36 UTC 改固定到 `6ffdf94a`（#195 合併後的 main；workflow 變更來自 #189 與 #195）。
10 月 6 日 probe E 的缺口在 required suites 上已修正：node:test、pytest 與瀏覽器 suites 由固定 commit 的 runner 執行，
對照審查過的基準清單，每個檔案、每個 case 都要有結果，候選的 test scripts 與 Playwright／pytest 篩選設定不再決定 suite 內容。
一次性 probes 實際驗到：換 pin 後舊綠燈被拒、close／reopen 重驗；候選改掉 test scripts 並放入敵意 Playwright／pytest 設定時，
每個 pinned suite 的數量仍與良性對照相同（e2e 516／89、contracts pytest 671／16、governance 439／33、runtime 3,212 tests）；
刪除審查過的測試檔或加上 skip 時，各家族都失敗且 merge 405。以 main 為目標的正例 green，負例 merge 405。
GOV-16／R2:D04／GOV-17／R2:D07 附加證據但不改狀態；GOV-15 仍只有 d1c9 的 fork 證據（這次沒有 fork 可測），accepted 仍是 3 列。
build、typecheck、dry-run 與 `check:*` 腳本仍由候選定義，候選可以把它們改成空操作；候選程式也仍與 trusted runner 在同一台 runner 上執行。
這次只改 CI 規則，沒有部署；當時 production 與 staging 仍是 `8d2213d7`。
細節見[治理安裝紀錄](governance-installation-2026-10-04.md)與[本次證據](../../verification/main-ruleset-2026-10-07.json)。

### 10 月 7 日：第三輪 staging／production rollout（main 687dee87）

owner 於 12:38Z 回覆「1.2.3.4 都你決定就好 除非你覺得該我決定」，把這次發布交給整合 owner 決定；
整合 owner 決定先 staging、再 production dark：套用 migration 120–124，兩邊都不設定 `FREEDOM_GUILD_LAUNCHPAD_ENABLED`。
main `687dee87`（8d2213d7 之後合併的 21 個 PR，其中 #225 一起合併 #187／#203／#208／#210／#105）於 14:10Z 部署到 staging：
migration 前的備份做過隔離還原與遠端 readback，migration 120–124 由 staging migrator 套用，43 個 selected checks 通過，部署後 cron 有寫入。
14:25Z 再以同一份 dist 部署到 production：migration 前的備份同樣做過隔離還原與遠端 readback，120–124 由 production migrator 套用，
27 個唯讀公開 checks 通過，5 次 fresh health 都是 687dee87，部署後 cron 有寫入；
兩個環境的 after-rollout 備份都做過隔離還原與遠端 readback，backup pin 都改成 687dee87。同樣是 selected checks，不是 foundation acceptance。
兩個 ledger 在 migration 後都確認 123 個 migration 檔全部套用到 124，沒有 pending 或 mismatch；capacity 與 authority policy 列都是 0，
所以若開啟 flag，tenant 寫入會回 `policy_unconfigured`。`FREEDOM_SHOP_KEY_POLICY` 維持 `legacy-compatible`，Private AI 兩邊仍關閉。

相容性：migration 前對兩個 live 資料庫做 precheck，12 項 constraint 檢查都是 0 筆違反，也沒有缺少的 drop target；
在 scratch 資料庫比對 schema，47 個既有物件有變更，全部只是放寬：每項只加 tenant 分支或 8d2213d7 留 NULL 的欄位，
新 foreign key 是 MATCH SIMPLE，新 trigger 只作用於 tenant_execution 列。
回滾是把受影響的 Worker 重新部署成 `8d2213d7`，不需要還原 schema；若要還原資料，從 migration 前的備份開始（production `ce4913c6`、staging `723736c4`）。

- staging：rollout 第 1 次因 prep.sh 缺唯讀 plan 步驟在部署前停止；acceptance 第 1 次 `guild_categories_unmounted` 失敗（flag 關閉時路由不存在，匿名 GET 回 401 `login_required` 而非預期的 404，檢查已修正），第 2 次因新的 Access service token 尚未生效失敗（改為先輪詢 readiness），第 3 次 43／43 通過。
- production：第一次 migration 在 commit 120–124、runtime grants 與 30-verify-readonly 後停在 `operator_privileges_unchanged`（media operator 權限快照多出 8 筆 column 列，是 migration 123 在 assets、asset_upload_intents 新增的欄位經既有 table-level INSERT／SELECT grant 帶出；去掉即與 migration 前的 hash 相同，沒有 GRANT 變動），由 finish script 重跑唯讀驗證與 login probes 後寫出 receipt；public acceptance 第 1 次在部署後數秒 `presence_bundle_matches_build` 失敗，該檔隨後三次以 HTTP 200 回傳 build 的 sha256，第 2 次 27／27 通過。

#198（JSON body 讀取沒有上限）由本輪的 #203 修正。staging 從外部看不到 Worker 是否提前停止讀取：
Cloudflare 會保留未結束的 chunked request body，約 15 秒後 reset（fetch probe 15,192 ms 後 TypeError；raw TLS probe 送出 40,053 bytes，15,133 ms 後 ECONNRESET）。
提前停止由 verify run 37630943060 的 `tests/runtime/platform-json-body.test.ts` 證明（未讀完就 cancel source；宣告超量的 body 不會被讀取），
staging 的 `json_stream_limit_413` check 則證明有界路徑已上線。

限制：guild launchpad 的表已建立，但 flag 不設定時不會使用，也沒有寫入任何 capacity／authority policy 列；
#162 的具名 prepared statement 只在 Private AI 開啟（兩邊都關）或尚未部署的 credential broker 才會執行，這一輪仍沒有在 Hyperdrive 上驗到它；
selected checks 不是完整 foundation acceptance，production checks 是唯讀 HTTP。
細節見[現況快照](current-state.json)。

### 10 月 7 日：第四輪 staging／production rollout（main e8cd72e8，migration 125）

owner 於 22:22Z 核准：staging 立即部署 main `e8cd72e8`（第一個包含 migration 125 的版本），staging 通過後 production 部署同一個 SHA，
兩邊都不設定 `FREEDOM_GUILD_LAUNCHPAD_ENABLED`；部署後在 Discord 公告重新登入（文字由 owner 核准）。
`e8cd72e8` 是 `687dee87` 之後合併的 #228、#229、#206、#226、#235、#243、#241；#243 一起合併 #231／#240，#241 一起合併 #205／#207。

- staging：migration 前的備份做過隔離還原與遠端 readback，125 由 staging migrator 套用並重套 runtime grants、通過唯讀驗證。
  在部署新版本前，先對已 migrate 的 staging 跑舊版 `687dee87` 的 acceptance，43／43 通過，作為回滾證據。
  22:46Z 部署 `e8cd72e8`，47 個 selected checks 通過（含新的 cookie 檢查），部署後 cron 有寫入。
- production：migration 前的備份同樣做過隔離還原與遠端 readback，125 由 production migrator 套用；media operator 的權限快照前後相同。
  23:07Z 以同一份 dist 部署，29 個唯讀公開 checks 通過，5 次 fresh health 都是 `e8cd72e8`，部署後 cron 有寫入。
- 兩個環境的 after-rollout 備份都做過隔離還原與遠端 readback，backup pin 都改成 `e8cd72e8`。
  production 的 after-rollout 備份到第 4 次才通過：第 1、3 次執行中 pg 連線出錯（socket 逾時；exporter 被自己 120 秒的 idle-in-transaction 上限終止），程序直接結束、沒跑 cleanup，`asset_maintenance_policy` 停在 enabled，第 2 次因此在 preflight 失敗。每次都由 migrator 執行 adapter 自己的 cleanup 語句關回去，期間沒有任何 tombstone、deletion fence 或物件刪除。coordinator 的修正（延長 exporter 上限、加 error listener）另開 PR。
  備份裡 snapshot evidence 的列數，在 18 張 row security 表上都與 migrator 讀到的相同。

Row security：125 在 18 張表啟用（不 FORCE）row security，共 29 條 policy，另加 4 個 invoker STABLE 的 context 讀取函式。
migration 前兩邊都沒有 row security 表，18 張表都由 migrator 擁有，runtime 角色沒有 BYPASSRLS，備份角色有 BYPASSRLS（owner 選定，當天下午授予）。
兩邊都還沒有任何 tenant 列，所以 probe 只能證明「沒有綁定 context 的 runtime 看得到全部非 tenant 列」與「備份角色看得到全部列」，
沒有實際綁定過 tenant。

登入 Cookie：HTTPS 網站改為只讀 `__Host-freedom_session`（#241 的 #207）。舊名稱 `freedom_local_session` 回 401，
重複的 `__Host-` cookie 回 403 `credential_kind_rejected`；所以部署後每位會員都會被登出一次。23:07Z 已在 Discord #📜│公告 發出重新登入公告。

回滾是把受影響的 Worker 重新部署成 `687dee87`，不需要還原 schema：沒有綁定 context 的請求仍看得到所有非 tenant 列，
`687dee87` 從不綁定 context，flag 關閉時也不寫 tenant 列，而且它的 acceptance 已在 migrate 後的 staging 通過。
若要還原資料，從 migration 前的備份開始（production `5cc20f05`、staging `914c5e68`）。

限制：guild launchpad 仍未啟用，row security 只由 migration probe 與 CI 驗證，沒有真實 tenant 流量；
每日備份的 operator source `c3e5a537` 早於 `packages/db/snapshot-evidence.ts` 的 fail-closed `row_security = off`，完整性靠備份角色的 BYPASSRLS 與上面的列數比對；
selected checks 不是完整 foundation acceptance，production checks 是唯讀 HTTP。
細節見[現況快照](current-state.json)。

### 10 月 8 日：第五輪 staging／production rollout（main c84829e2，migration 126、127）

`c84829e2` 是 #227 的 merge，也就是 M1 候選版本 X。它包含 `e8cd72e8` 之後合併的 #238、#245、#264、#244、#248、#246、#242、#227；
#244 一起合併 #204、#222、#236、#237，帶進 migration 126（`oss_projects.public_metadata_revised`）與 127（`sessions.prune_retained_at` 加三個外鍵索引）。
staging 依 owner 的委派部署；production 由 owner 在看過 staging 證據與 #237 的刪除筆數後核准（2026-10-08T05:20Z，「Deploy X now」）。兩邊都不設定 `FREEDOM_GUILD_LAUNCHPAD_ENABLED`。

- staging：migration 前的備份做過隔離還原與遠端 readback，126、127 由 staging migrator 套用並重套 runtime grants、通過唯讀驗證。
  部署前先對已 migrate 的 staging 跑舊版 `e8cd72e8` 的 acceptance，47／47 通過，作為回滾證據。
  05:08Z 部署 `c84829e2`，47 個 selected checks 通過，部署後 cron 有寫入。
- production：migration 前的備份同樣做過隔離還原與遠端 readback，126、127 由 production migrator 套用；media operator 的權限快照前後相同。
  05:32Z 以同一份 dist 部署，29 個唯讀公開 checks 通過，5 次 fresh health 都是 `c84829e2`，部署後 cron 有寫入。
- 兩個環境的 after-rollout 備份都做過隔離還原與遠端 readback，backup pin 都改成 `c84829e2`。

#237 的定期清除：每次 cron 從 `auth_rate_limits`、`login_attempts`（視窗超過 1 天）、`password_reset_tokens`（過期超過 1 天）與 `sessions`
（過期或撤銷超過 1 天；保留每位會員最新的一個 session，以及仍被外鍵參照的 session）各刪最多 500 筆。驗證方式是在舊版仍執行時固定一個 cutoff 計算可清除的筆數，
X 的 cron 跑過後在同一個 cutoff 重算：staging sessions 137→0、rate limit 50→0、login attempts 16→0、reset tokens 2→0；因外鍵保留的 session 0 筆；持有 session 的會員 30→32；production sessions 429→0、rate limit 1711→710、login attempts 197→0、reset tokens 13→0；因外鍵保留的 session 0 筆；持有 session 的會員 410→410。這些刪除只能從 migration 前的備份還原。

回滾是把受影響的 Worker 重新部署成 `e8cd72e8`，不需要還原 schema：126、127 只新增欄位與索引，`e8cd72e8` 不讀寫它們，
而且它的 acceptance 已在 migrate 後的 staging 通過。回滾後清除就停止；已刪除的資料只能從 migration 前的備份（production `bdc249cd`、staging `2e0c96e2`）還原。

限制：guild launchpad 仍未啟用，tenant 路由沒有掛載，row security 只由 migration probe 與 CI 驗證；
每日備份的 operator source 仍是 `c3e5a537`，#264 已合併但要等 operator source 重新 pin 才生效；
selected checks 不是完整 foundation acceptance，production checks 是唯讀 HTTP。
細節見[現況快照](current-state.json)。

### 10 月 8 日：staging 啟動台試開（X，flag 只在 staging 開啟）

owner 在 2026-10-07 核准只在 staging 試開的計畫與暫時容量值。第五輪讓兩個環境都執行 X 之後，整合負責人依同一份核准把試開改到 X。
production 不受影響：flag 仍未設定，也沒有 capacity policy 列。

- 05:51Z：staging migrator 以 #227 的 `scripts/tenant-policy.ts`（status → plan → `apply --execute`，expect revision `none`）寫入預設範圍的暫時
  capacity policy：10／3／2／1000／104857600／2／0，plan_ref `interim-default-20261007`，revision 1。
- 主力偏好的 backfill 狀態唯讀記錄為 blocked：還有 28 位舊會員未對應，其中 27 位的舊主力公會沒有已核准的分類（`unknown_category`）。
  這不是 gate；三分類看板只在 `migration_state` 為 `switched` 時顯示，是否切換由 owner 另外決定。
- 06:03Z 開始的試開前備份做過隔離還原與遠端讀回。
- 06:11Z 以第五輪同一份 dist 重新部署 staging，唯一的變更是 `FREEDOM_GUILD_LAUNCHPAD_ENABLED=true`（Worker 版本 `7b7050c2`）。
  部署前後的 live readback 都確認 production 仍是 X、flag 未設定。47 個 selected checks 通過：網站回報 launchpad 啟用，
  匿名讀得到公開分類清單（catalog revision 18：3 個區塊、12 個已核准、6 個待審）；其餘檢查與第五輪相同。

回滾是把 staging 以同一份 dist 重新部署、不設 flag；policy 列與試開期間建立的 tenant 資料會保留。

試開本身不是 guild launchpad 的驗收；guild-work 驗收見下一節。

### 10 月 8 日：staging guild-work verifier（X）

- 06:30–06:31Z：owner 用自己的 Cloudflare Access 身分，在 staging 管理後台（公會管理 → 設定公會長）把示範帳號 `maker@local.test`
  設為 `guild_product_quality_supply` 與 `guild_commerce_sales` 的公會長。兩個公會原本都沒有公會長，所以沒有取代任何人；
  任命時 maker 成為兩個公會的正式成員。走的是產品流程，沒有直接改資料庫。公會長不是平台管理員，verifier 用到的 tenant 路由
  只檢查公會正式成員與 tenant 角色，不看公會幹部。
- 06:31Z–06:32Z：整合負責人以 60 分鐘的 Access 授權執行 X 的 `scripts/verify-guild-work.mjs --expect-sha c84829e21a2b43753b32bb18ebb8f4ac739175eb`（#242），
  結束後撤銷授權。served SHA 等於 X，4 項檢查全部通過：
  - preconditions：網站回報 launchpad 啟用，build identity 等於 X。
  - A creates：會員 A（maker）建立 tenant 與業務空間，開啟手動工作，存一個 Work、一份筆記 Result 與一個 64 KiB 附件 Result（真實 R2）。
  - A logs out and back in：登出再登入後讀回相同的 ID、版本與位元組 digest，並存下筆記的下一個版本。
  - B and anonymous are refused：另一位會員 B（`reviewer@local.test`）與只有 Access 的匿名者，對所有已發給 A 的內容路徑
    以 GET、HEAD、Range 存取都被拒絕。
- receipt `20261008T063130038Z-83185463`（SHA-256 `185e6746928b71be17388d1c7ae656998d5b831e4400acc3dc348b28f1959b78`）保存在 operator journal；內含 tenant ID，所以不公開。
- 依 `acceptance-progress.json` 記錄：T-005 通過；T-023 依 M1 範圍只驗權限半部，`variants.M1` 通過，完整案例記為 partial
  （X 沒有匯出路由，匯出還原沒有執行）。
- 06:33Z 開始的試開後備份做過隔離還原與遠端讀回。

M1 仍未接受：28 個 M1 案例中其餘 26 個尚未執行，M1 也還沒有指定 candidate_sha。production 的開啟見下一節。

### 10 月 8 日：production 開啟 guild launchpad（X）

owner 在 06:47Z 看過 staging 的 guild-work 結果後決定開啟 production（「271 合 , production 開」），容量值選「跟 staging 一樣」。
staging 不受影響：仍是 X、flag 開啟。

- 06:55Z：production migrator 以 #227 的 `scripts/tenant-policy.ts`（status → plan → `apply --execute`，expect revision `none`）
  寫入預設範圍的暫時 capacity policy：10／3／2／1000／104857600／2／0，plan_ref `interim-default-20261007`，revision 1，與 staging 相同。
- 主力偏好的 backfill 狀態唯讀記錄為 blocked：還有 305 位舊會員未對應，其中 156 位的舊主力公會沒有已核准的分類
  （`unknown_category`）。三分類看板在 production 同樣隱藏。
- 06:56Z 開始的開啟前備份做過隔離還原與遠端讀回。
- 07:05Z 以第五輪同一份 dist 重新部署 production，唯一的變更是 `FREEDOM_GUILD_LAUNCHPAD_ENABLED=true`（Worker 版本 `2871eefe`）。
  部署前後的 live readback 都確認 staging 仍是 X、flag 開啟。29 個公開的 selected checks 通過：網站回報 launchpad 啟用，
  匿名讀得到公開分類清單（catalog revision 24：3 個區塊、12 個已核准、12 個待審）；
  其餘檢查與第五輪相同。新的 DNS 解析下 4 次 health 讀回都是 X。production 沒有建立任何帳號。
- 07:05Z 開始的開啟後備份做過隔離還原與遠端讀回。

回滾是把 production 以同一份 dist 重新部署、不設 flag；policy 列與開啟期間建立的 tenant 資料會保留。

production 沒有示範帳號，所以 guild-work verifier 只在 staging 執行；production 的開啟不是 M1 驗收，M1 仍未接受。
`tenant_authority_policies` 兩邊都是 0 列，經營權移交與復原會回 403 `policy_unconfigured`，政策值（OPEN-02／03）由 owner 決定。

### 10 月 8 日：第六輪 staging／production rollout（main d2900cf4，migration 128～130）

`d2900cf4` 是 #278 的 merge。它在 X（`c84829e2`）之後帶進 P-D1（#239，migration 128：應用目錄、模組實例登錄、啟動操作與容量保留）、
P-D2a（#269，129：實例暫停與恢復）與 P-D2b（#278，130：實例封存），以及 #273、#271（#265、#266）、#275、#277。
兩個環境的 `FREEDOM_GUILD_LAUNCHPAD_ENABLED` 都維持 `true`，所以這些路由隨部署上線。staging 依 owner 的委派部署；
production 由 owner 決定直接上線（「太囉嗦了 你全部把它做一做就 go live 不用測這麼多 浪費時間  去live 測就好 死不了人」、「我選 直接部署直接上線」），不跑 staging 驗收，到 live 再測。

- 兩個環境各自先做 migration 前的備份（staging `469c43e9`、production `a972e586`），都做過隔離還原與遠端讀回。
- 128 對 X 不相容：它把 `module_instances.module_release_ref`／`contract_ref` 與 `deployment_bindings.contract_ref` 改成 NOT NULL，
  X 建立新的 manual-work 實例會失敗。所以每個環境都是 migration 後立刻部署 `d2900cf4`。
- staging：migrator 套用 128～130，重套 runtime grants（含 128 的 definition 表授權段落）並通過唯讀驗證，08:22Z 部署（Worker 版本 `eafb925e`）。
  128 的 backfill 寫入 1 個 installation、1 個模組連結（對應 1 個既有的 manual-work 綁定）。
- production：同樣由 migrator 套用並驗證，media operator 的權限快照前後相同；08:24Z 以同一份 dist 部署（Worker 版本 `2114352b`），
  29 個唯讀公開 checks 通過，4 次 fresh health 都是 `d2900cf4`。128 的 backfill 寫入 0 個 installation、0 個模組連結（對應 0 個既有的 manual-work 綁定）。
- row security：128 在 9 張新 tenant 表啟用（不強制），每張一條 policy，合計 27 張表、38 條 policy；三張 definition 表對 runtime 只有 SELECT。
  兩邊 migrate 後，runtime 與備份角色在同一個 snapshot 的登入 probe 都通過。
- 兩個環境部署後的備份（staging `9cc41da1`、production `98b497d5`）都做過隔離還原與遠端讀回，backup pin 都改成 `d2900cf4`。
  staging 部署後 cron 有寫入（最後同步 08:40Z，last_error 8→8）；production 部署後 cron 有寫入（最後同步 08:41Z，last_error 6→6）。

回滾：128 之後不能再部署 X。可以關閉 flag，或修正後再部署；schema 只能從 migration 前的備份還原。

限制：P-D1／P-D2a／P-D2b 的 T-ID 案例（T-008、T-016、T-017、T-018、T-021、T-022、T-024、T-051、T-055、T-057、T-058）沒有執行，staging 也沒有跑驗收；production checks 是唯讀 HTTP，兩邊都沒有建立帳號。
這次 rollout 不是 M1 驗收，M1 仍未接受。每日備份的 operator source 仍是 `c3e5a537`。細節見[現況快照](current-state.json)。

### 10 月 8 日：第七輪 staging／production rollout（main 3685d626，migration 131）

`3685d626` 是 #282 的 merge。它在第六輪（`d2900cf4`）之後帶進 P-B2b（#279，migration 131：成員的模組實例權限）與
P-D3a（#282，無 migration：公會應用卡與啟動流程），以及 #274、#280（都不改 runtime）。
兩個環境的 `FREEDOM_GUILD_LAUNCHPAD_ENABLED` 都維持 `true`，所以這些路由與畫面隨部署上線。staging 依 owner 的委派部署；
production 由 owner 於 12:31Z 決定照第六輪的方式直接發（「直接發 (Recommended)」），不跑 staging 驗收，到 live 再測。

- 兩個環境各自先做 migration 前的備份（staging `7c9b4233`、production `a34872cb`），都做過隔離還原與遠端讀回。
- 131 新增 `tenant_module_permissions`（一般的實例成員授權；匯出與限定用途的授權由 CHECK 擋下），並重建
  `preserve_module_instance_identity()`，讓實例的 `module_release_ref` 也不可變更。`d2900cf4` 不寫這張表也不改 `module_release_ref`，
  所以 131 對它相容；仍然是 migration 後立刻部署 `3685d626`。
- staging：migrator 套用 131，重套 runtime grants（131 沒有 GRANT，通用授權涵蓋新表）並通過唯讀驗證，12:57Z 部署（Worker 版本 `2222f11c`）。
- production：同樣由 migrator 套用並驗證，media operator 的權限快照前後相同；12:59Z 以同一份 dist 部署（Worker 版本 `e2e064cd`），
  29 個唯讀公開 checks 通過，4 次 fresh health 都是 `3685d626`。
- row security：131 在 `tenant_module_permissions` 啟用（不強制），一條 tenant policy（`tenant_module_permissions_tenant`），合計 28 張表、39 條 policy；
  新表目前 staging 0 列、production 0 列。兩邊 migrate 後，runtime 與備份角色在同一個 snapshot 的登入 probe 都通過。
- 兩個環境部署後的備份（staging `60e7f34d`、production `2547f645`）都做過隔離還原與遠端讀回，backup pin 都改成 `3685d626`。
  staging 部署後 cron 有寫入（最後同步 13:11Z，last_error 8→8）；production 部署後 cron 有寫入（最後同步 13:11Z，last_error 6→6）。

回滾：重新部署 `d2900cf4` 或關閉 flag，不需要退回 migration；128 之後仍然不能部署 X（`c84829e2`）。schema 只能從 migration 前的備份還原。

限制：P-B2b 的 T-ID 案例（T-013、T-015、T-022、T-047）與 P-D3a 的畫面流程沒有執行驗收，staging 也沒有跑驗收；production checks 是唯讀 HTTP，兩邊都沒有建立帳號。
這次 rollout 不是 M1 驗收，M1 仍未接受。每日備份的 operator source 仍是 `c3e5a537`。細節見[現況快照](current-state.json)。

### 10 月 8 日：第八輪 staging／production rollout（main e89cd0c8，migration 132、133）

`e89cd0c8` 是 #287 的 merge。它在第七輪（`3685d626`）之後帶進 #193 的社群整合（#284，migration 132：社群貼文的按讚、留言與純文字貼文；
migration 133：新貼圖）與 P-D3a 的目錄修正（#287，無 migration）。第七輪的收據 #286 不在本輪發布的 `e89cd0c8` 內；本 PR 承接該收據，計畫隨本 PR 一起合併。
兩個環境的 `FREEDOM_GUILD_LAUNCHPAD_ENABLED` 都維持 `true`；#284 的會員功能不受這個 flag 控制，隨部署上線。staging 依 owner 的委派部署；
production 由 owner 於 13:49Z 決定在 #287 合併後照第七輪的方式直接發（「#287 合併後直接發 (Recommended)」），不跑 staging 驗收，到 live 再測。

- 兩個環境各自先做 migration 前的備份（staging `9492971b`、production `87d02a52`），都做過隔離還原與遠端讀回。
- 132 讓 `community_social_posts` 多了 `kind`（預設 `link`；`note` 沒有網址），用 `social_post_content` 取代 066 的 note CHECK，並新增
  `community_social_likes` 與 `community_social_comments`。133 把兩個 sticker_id CHECK 從 4 個放寬到 52 個 id。兩者對 `3685d626` 都只是新增或放寬，
  既有資料都符合新的 CHECK；仍然是 migration 後立刻部署 `e89cd0c8`。
- staging：migrator 套用 132、133，重套 runtime grants（兩者都沒有 GRANT，通用授權涵蓋新表）並通過唯讀驗證，14:32Z 部署（Worker 版本 `f9284c0b`）。
- production：同樣由 migrator 套用並驗證。media operator 對 `community_social_posts` 有表層級授權，所以新欄位 `kind` 多出衍生的欄位權限列
  （SELECT），其餘權限快照前後相同；14:34Z 以同一份 dist 部署（Worker 版本 `4c40169a`），33 個唯讀公開 checks 通過，4 次 fresh health 都是 `e89cd0c8`。
- row security 不變：28 張表、39 條 policy。migrate 後新表在 staging 有 0 個讚、0 則留言，
  production 有 0 個讚、0 則留言；兩邊 runtime 與備份角色在同一個 snapshot 的登入 probe 都通過。
- 兩個環境部署後的備份（staging `770211b6`、production `691eed94`）都做過隔離還原與遠端讀回，backup pin 都改成 `e89cd0c8`。
  staging 部署後 cron 有寫入（最後同步 14:51Z，last_error 8→8）；production 部署後 cron 有寫入（最後同步 14:51Z，last_error 6→6）。另有 2 次備份失敗後清理 maintenance policy，經過記在私人收據。

回滾：重新部署 `3685d626`，不需要退回 migration；部署後新增的純文字貼文、按讚、留言與新貼圖，`3685d626` 只能部分顯示。128 之後仍然不能部署 X（`c84829e2`）。
schema 只能從 migration 前的備份還原。

限制：#284 與 #287 沒有執行驗收，staging 也沒有跑驗收；production checks 是唯讀 HTTP，兩邊都沒有建立帳號。
這次 rollout 不是 M1 驗收，M1 仍未接受。每日備份的 operator source 仍是 `c3e5a537`。細節見[現況快照](current-state.json)。

### 10 月 8 日：installed workflow pin 升級至 709600a0

中央 `24469536` 的 required workflow 於 17:09:27 UTC 改固定到 `709600a0`（#288 合併後的 main）。
#288 放寬容量：UI e2e 預設 pass 上限 30→40 分鐘、`ui-e2e` job 40→50 分鐘；單一測試 timeout、worker 數、retry 與 skip 規則都沒變。
完整 pin 也同步了已審查的 runtime baseline（`FULL_RUNTIME_BASELINE` +66、−0），判定規則不變。
依 Ted 同意的精簡 probe：刪除基準檔（E2）與加 skip（E3）都失敗且 merge 405；以 main 為目標的負例（MN）merge 405，
正例是第七／八輪收據 #291，在新 pin 下通過並依一般流程合併。S、E0／E1b、E2p／E3p 與 fork 探測沒有重做，沿用 10 月 7 日與 10 月 6 日的證據；
GOV-16／R2:D04 附加證據但不改狀態，accepted 仍是 3 列。這次只改 CI 規則，沒有部署；production 與 staging 仍是 `e89cd0c8`。
細節見[治理安裝紀錄](governance-installation-2026-10-04.md)與[本次證據](../../verification/main-ruleset-2026-10-08.json)。

### 10 月 8 日：第九輪 staging／production rollout（main cc72c3fd，無 migration）

`cc72c3fd` 是 #297 的 merge。它在第八輪（`e89cd0c8`）之後帶進公會首頁設定（D1）：沒有自訂首頁的公會改用平台預設 revision 2，
電商公會（`guild_commerce_sales`）與廣告攝影公會（`guild_commercial_production`）各有自己的區塊順序，並推薦平台已提供的應用；
會員看到推薦應用的名稱，正式成員看到主要動作，公會長可以編輯推薦。同一範圍內的 #288（CI 容量）、#296（inventory 順序）與 #291（第七／八輪收據）不改 runtime。
兩個環境的 `FREEDOM_GUILD_LAUNCHPAD_ENABLED` 都維持 `true`。staging 依 owner 的委派部署；production 由 owner 於 19:00Z 決定在 #297 合併後
照第八輪的方式直接發（「#297 合併後直接發 (Recommended)」），不跑 staging 驗收，到 live 再測。

- 沒有 migration：部署前兩邊的資料庫都唯讀確認仍在 133、沒有待套用或不一致的 migration，row security 仍是 28 張表、39 條 policy。
- staging 19:19Z 部署（Worker 版本 `3a5a5308`）；production 19:20Z 以同一份 dist 部署（Worker 版本 `d80f2817`），33 個唯讀公開 checks 通過，4 次 fresh health 都是 `cc72c3fd`。
- staging 與 production 兩個公會的公開首頁都是 revision 2、區塊順序符合各自的設定（推薦應用：manual-workspace）。
- 兩個環境部署後的備份（staging `fc6da97b`、production `f12747a0`）都做過隔離還原與遠端讀回，backup pin 都改成 `cc72c3fd`。
  staging 部署後 cron 有寫入（最後同步 19:41Z，last_error 8→8）；production 部署後 cron 有寫入（最後同步 19:41Z，last_error 6→6）。另有 1 次備份失敗後清理 maintenance policy，經過記在私人收據。

回滾：重新部署 `e89cd0c8`，沒有 migration，也沒有資料變更；部署後公會長存的草稿或發布仍是同一個 v1 格式，`e89cd0c8` 可以讀。128 之後仍然不能部署 X（`c84829e2`）。

限制：#297 沒有執行驗收，staging 也沒有跑驗收；production checks 是唯讀 HTTP 與兩個公會的公開首頁，兩邊都沒有建立帳號。
部署後另一個 session 用 staging 示範帳號做了會員實測：電商公會的正式成員看到主要動作「選品／營運待辦」，非成員看到加入提示，公會長存的推薦草稿重新進入後仍在、公開首頁不變；廣告攝影公會沒有正式成員的示範帳號，production 沒有登入實測。
這次 rollout 不是 M1 驗收，M1 仍未接受。每日備份的 operator source 仍是 `c3e5a537`。細節見[現況快照](current-state.json)。

## 2026-10-10 R15：社群修補與 schema148 正式發布

本次真正受保護合併的 #427 `2d5f158c` 已發布至 staging 與正式站，與 reviewed `fccc1739` 同 tree；
必要 Verify38052439063 的14 jobs及CodeQL通過，兩環境使用相同dist。正式站套用142–148；
staging在R15前已是148，本輪沒有重套migration。兩邊147筆ledger、RLS33表／45 policies，runtime無BYPASS。

staging實際商店24、社群26、小隊16、公開入口34項通過；正式站公開34／登入19項HTTP檢查通過。
社群驗收前三次工具失敗（body長度量測、編輯未完成登出、等待錯誤HTTP verb）保留，
最後修正量測與等待後同產品source通過。這不是正式一般會員完整瀏覽器旅程，也不宣告Foundation／M1完成。

發布前後四份備份均完成磁碟DB／物件還原與異地readback。staging-after保留6照片／4留言圖片，
production-after3照片／0留言圖片；synthetic資料完成指定清理，歷史物件保留供恢復。
daily operator及兩環境runtime pins皆2d5，排程／GC／retention不变；臨時staging Access已撤銷。
留言圖片兩邊為r2_only／64MiB。e977不能作143私人資料寫入後回退；19c6只在留言圖片啟用前適用，
現在修復必須保留media.comment-image.asset.v1 reader。沒有以本機11項回退證據冒稱live回退演練。

細節見 [R15發布收據](rollout-r15-2026-10-10.json) 與 [現況快照](current-state.json)。
較早 [e977發布紀錄](rollout-2026-10-10.json) 保留歷史，不代表目前release。#425／#426尚未包含在此發布。

## 2026-10-10 R16：舊 PR 集中整合與 schema160 發布

#434 `b9ed788c` 已透過受保護合併並發布至 staging 與正式站，與 reviewed `907b2516` 同 tree。
必要 Verify 38092198284 全部通過；精確案例數與選定環境驗收見 [R16 發布收據](rollout-r16-2026-10-10.json)。
兩環境套用149–160、159筆ledger；使用相同dist，資料庫／物件恢復與遠端readback通過。
訊息圖片啟用r2_only，purpose保存容量64MiB，單張上傳上限仍為2MiB；
保留既有留言圖片與商品照片政策，搜尋、封鎖及通知偏好已啟用。
TOTP使用分環境金鑰並完成合成帳號驗收；異地主機／第二操作者金鑰恢復仍未驗證。
Banner以大於512KiB的原圖驗收瀏覽器自動轉換；不以API傳输上限要求使用者手動壓圖。
這些是選定雲端流程的實測，不代表Foundation／M1完成。真實投遞、真人試用、正式政策、
真實指標baseline及Maintainer App等未完成事項保持獨立追蹤；不以source存在自動關單。
臨時staging Access已撤銷，兩環境backup pins同步，GC／retention保持OFF。

本批範圍已結束；後續主交付依 [#234](https://github.com/FreeTWAI-AI/freedom-platform/issues/234#issuecomment-6103127315)
集中在跨店訂單共用庫存：A的10件商品由B／C以各自獲同意的版本及售價接單，6＋5並行不得超賣，
quote／submit重驗當前供貨與權限，取消／到期只釋放一次，各方只讀必要訂單資訊。
接著交付一次庫存單模組外移及一條本人CLI／BYOK的Grant→Result→Stop／Revoke／重連流程。
T-047還原後tenant撤權存續尚未完成；隔離還原成功不代表可公開服務，重新開放前須與當前授權權威對帳。
真人反覆使用、供貨狀態理解與失敗恢復仍需經同意的實際回饋，不以合成驗收推定。
