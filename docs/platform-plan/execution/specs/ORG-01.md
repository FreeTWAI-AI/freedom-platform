# SPEC-ORG-01 — Guild、Profession、Rank、Office 與 Stewardship

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-ORG-01`／draft-ready |
| 所屬 milestone／原 package | M01／`ORG-01` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Foundation owner／Organizations & Guilds；owner＝Hao（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`03 §3.1.1`](../../03-domain-events-state-machines.md)、`01 §3–5`、`06 §4.1`、RQ-005/RQ-006/RQ-007/RQ-008/RQ-009/RQ-059；ADR-007/ADR-008/ADR-009/ADR-010/ADR-011/ADR-060；OD-10；現行 baseline。

## 使用者結果與明確不包含

一人可多 Guild/Profession；rank、office、stewardship、reviewer authority 可分辨且可交接。不包含 Master admission approval、rank→reviewer 自動授權或具名 holder 的杜撰。

## Actor／principal／acting role／資源範圍

Member、Guild OfficeAssignment holder、delegate、Board/Ops；每個 command 以一個 acting ProfessionMembership/office scope 執行。Agent 不是 office/reviewer。

## 既有 canonical entity／command／event／state／projection

Division/Guild/ProfessionDefinition/ProfessionMembership/RankRecord/OfficeAssignment/ModuleStewardship/Squad；office assignment/handoff 與 profession events沿用 `03`。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：self-join existing Guild→Runner；office proposed/accepted/handover；stewardship delegate。異常：same-person independence、scope expiry、handover gap。無successor時由既有責任owner保留必要安全／已承諾事項並處理交接；對非必要新服務先縮減承諾。不得自動捏造interim holder、擴大未接受的志工範圍，或只開新WorkItem就宣稱人力已解決。

## 授權／A4／independence／來源與版本綁定

Rank 不授權；office scope/term/delegation 才授權治理 action。v1 reviewer appointment appointer 只接受 OD-10 Council 具名自然人 holder。

## 版本與獨立驗收

Profession/rubric/office revision pin version；handover audit 不改歷史。獨立 reviewer 驗 multi-Guild、rank/office/reviewer separation。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

同 user×profession×Guild active membership 唯一；同 module 恰一 active stewardship。Office term、appointment review date與 task lease 不共用。

## UI／CLI／MCP

Portal 分頁顯示 profession rank、office、delegation、review appointment；CLI/MCP 每次 write 傳 acting role並由 server 解析 authority。

## 隱私／憑證／資料保留與 provider 邊界

只保存必要 identity refs/evidence refs；Discord role/GitHub team 不成 canonical rank/office。

## 2026-09-19 容量與共同參與

委派只轉責任，不降低總人力；core／non-core維持與協調均記入有限預算。Office／ReviewerAppointment只授權，不推定可用時間。普通互助由既有Squad／cohort自願組成、提出共同目標及續組，不新增任務審批或報告會；capacity gap只聚合導航，不自動核心補位。

## 2026-09-24 會員 beta 對應

已實作：自助入會只有 `rank='runner'`（`migrations/002`）；會長提名需本人確認（`014`）、每公會最多三位專家（`026`），專家與會長不因標章取得平台 Access 權限。入會即取得公會範圍的開發提案資格；離開最後一個適用公會時由 `migrations/030` trigger 同交易撤銷 grant 與衍生 key，已領書目、作者署名與既有成果保留。尚未實作：Strategist／Master rank、OfficeAssignment term／handover、ModuleStewardship、ReviewerAppointment。

站內技能書編修（既有書 metadata／內容，不是 `skill.submit`）的現行要求：該書具名維護任命（`skill_book_maintainers`，`migrations/023`）仍有效，且在 `guild_ai_vibe` 或 `guild_ai_field` 至少一個有效會籍。會籍不授予全公會編修權，`development:propose` 不轉成編修 token；離開最後一個符合公會即拒絕，另一符合公會仍在則保留；任命仍有效時重新入會恢復會籍條件，已撤銷的 API token 不恢復。公開書目、原作閱讀與一般 `skill.submit` 不變。本版實作與 runtime 證據記錄於本版合併稽核；本 spec 不登錄通過結果。

## 成本／可觀測性／timeout／retry／reconciliation

觀測 stewardship gap、expired delegation、handover conflict；external role drift 只提示 reconcile，不直接覆寫 canonical。

## 遷移／相容性／rollback

Legacy title/rank 分欄匯入並保留 source；無證據標 unknown。錯誤 assignment 用 supersede/end fact，不刪歷史。

## Given–When–Then

- Given AI Vibe Master rank 無 office；When governance write；Then拒絕。
- Given同一人換 Agent/role；When滿足三人或independent review；Then仍只計一個自然人。
- Givenoffice handover；When commit；Then successor/stewardship revisions原子成立。
- Given 會員只在一個適用公會；When 離會；Then 該公會衍生的貢獻 grant／key 同交易失效，其他公會資格、已領書目與作者署名保留。
- Given 有效維護任命且只在一個 AI 開發／AI 導入與驗證公會；When 離開該公會；Then 編修立即拒絕，公開閱讀與一般 `skill.submit` 不受影響。
- Given 有效維護任命且同時在兩個符合公會；When 離開其中一個；Then 仍可編修。
- Given 離會後任命仍有效；When 重新加入符合公會；Then 會籍條件恢復，先前已撤銷的 API token 仍為撤銷。
- Given 會員只有公會會籍或 `development:propose`，沒有具名任命；When 編修技能書；Then 拒絕。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_rank_office_separation.py -q
python -m pytest docs/platform-plan/contracts/tests/test_office_handover_atomicity.py -q
python -m pytest docs/platform-plan/contracts/tests/test_od10_appointer_scope.py -q
```

尚無 tests，**未跑**。

## 缺 evidence 時的標籤／技術依賴

缺獨立自然人或 supply owner 時，相應標籤（`official`／`supply-ready`）為 false；不停止 candidate、review-required 公開可領與 live 以外的工作。具名 refs、term／scope 與 acceptance evidence 到位時更新相應標籤。

## 完成證據

未完成；需 migrations、authorization tests、handover demo、holder inventory、限制。
