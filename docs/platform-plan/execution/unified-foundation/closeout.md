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

## 第一批小工作包

每包固定來源、隔離 worktree、可改範圍及必要反例。共用 manifest／索引／入口由整合
owner 協調。依賴未齊時保留缺口，不把它改成 N/A 或自動移到下一個 sprint。

FC-00 本批先統一中央入口與索引。Agent Kit README 的「先完成定位」仍需對齊中央
「定位可稍後補做」；各倉入口接線與真實完整 prepare 通過前，FC-00 不算完成。

| 工作包／原要求 | 已確認的缺口 | 下一個可驗收結果 |
| --- | --- | --- |
| C1：GOV-16、R2:D04 | `verify.needs` 及 aggregate 的第二份 job 清單都漏掉 `deploy-preflight` | 將 preflight 納入；full 必須 success，docs 可正常 skip，missing／failure／cancelled 拒絕。獨立審查後再升級 installed workflow pin |
| A1：R2:A03、FC-01（session 到期回歸） | 七個 legacy media command 的 receipt ports 未在等待 DB receipt 後重查 session 時效；generic scoped command 已有檢查 | 用隔離 PostgreSQL 的 receipt SELECT／INSERT barrier 跨過到期時間重現；保留既有 digest／namespace，修補後證明授權有效的 replay 正常 |
| B1：R2:S02/M05、FC-02 | migration 106 的 social thumbnail fence 僅檢查 legacy source；migration 102 允許 asset＋bytes，hidden／deleted 不要求 active pointer | 先以 restricted runtime role 驗證 r2_only 下 INSERT／UPDATE 反例；若重現，以新增 migration 封口並保留合法 R2 寫入及 bridge backfill |
| C2：GOV-07/09/10/12 | root context 被模組宣告的 DESIGN.md 拒絕；修正後全 scope 又超過 512,000 bytes | 精確允許 DESIGN.md，保留任意根檔拒絕；後續有界分段載入含 baseline/candidate/delta 的完整必要規則，不能靜默截斷或縮 scope 避開未知修改 |
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

上表 A1／B1 是來源審查所得，尚未用 DB 反例重現，不能宣稱已確認可利用或已修好。
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
