# SPEC-ORG-02 — WorkIntent、equipped Skills 與 availability

> 狀態：現行 canonical baseline（2026-09-17）；planning 文件，不代表已部署。

| 欄位 | 值 |
| --- | --- |
| Spec ID／狀態 | `SPEC-ORG-02`／draft-ready |
| 所屬 milestone／原 package | M01／`ORG-02` |
| Accountable role／implementation agent／AI reviewer／AI verifier | Talent/Agent owner；owner＝Jason（建議預設，五人共同閱讀確認）／韋銘＋Codex（implementation；建議預設，五人共同閱讀確認）／Grok／Claude |
| official reviewer（建議預設） | Mini 或 Jason（五人共同閱讀確認）；implementation＝韋銘時由非作者擔任，只控制 official evidence |

## 來源與需求 ID

[`03 §3.14`](../../03-domain-events-state-machines.md)、`04 §8`、`06 §4.1`、RQ-010/RQ-011/RQ-012；ADR-039/ADR-040；baseline。

## 使用者結果與明確不包含

本人能確認想投入的 profession/work/capacity 並裝備 Skill，Agent Feed 有可解釋 basis。2026-09-23 起新註冊會員須先完成一次封閉定位並選主要公會；定位結果仍不自動成為 confirmed WorkIntent、rank 或 entitlement。不包含以 WorkIntent 作為入會或一般參與門檻、equipped＝installed/qualified，或 organization 借用個人私密 WorkIntent。

2026-09-24 beta 對應：已實作必填定位、主要／次要公會與入會領書（`modules/positioning/`、`migrations/006`／`027`）；尚無 WorkIntent revision、EquippedSkillSet 或 Agent Feed basis。未完成定位的新會員只能使用 `apps/platform-api/src/app.ts` `onboardingAllowed` 白名單內的會員 API，其餘讀寫皆拒絕。舊會員 `onboarding_required=false`，不追溯。

## Actor／principal／acting role／資源範圍

Person principal 自己確認 WorkIntent；organization 由具名 operator 依 versioned organization policy；Agent 可 draft，不能 confirm。

## 既有 canonical entity／command／event／state／projection

WorkIntent、ProfessionMembership、EquippedSkillSet、availability、work_direction_basis；confirm/supersede/withdraw與 equipped replacement events引用 `03`。

## 正常／異常／卡點／取消／補件／爭議／恢復

正常：本人選 profession/capacity→confirm revision→Feed讀取。異常：unconfirmed draft、wrong membership、stale version、organization 缺 operator/policy。Withdraw 不改舊 Claim/Result。

## 授權／A4／independence／來源與版本綁定

本人 confirmation 是普通 authenticated command，不是 A4。Equipped selection 不授予 privileged entitlement；organization basis綁 policy revision/operator memberships。

## 版本與獨立驗收

每次修改新 revision；Feed item保存 basis ref/reason。獨立 reviewer 驗 personal/org separation、新會員必填定位 gate，以及舊會員未定位時的 WorkIntent path。

## 冪等／業務唯一鍵／並發／fencing／lease／時間

同 key/body回同 revision；stale expected version 412。Availability window 不作 TaskLease、grant或evidence validity。

## UI／CLI／MCP

Portal 讓本人從 stable catalog 選，不貼 opaque ID；CLI/MCP A0讀 active basis，draft mutation須 user confirmation。

## 隱私／憑證／資料保留與 provider 邊界

WorkContext 不含定位逐字稿、私人聊天或 secret；organization Agent 不讀個人 hidden intent。

## 成本／可觀測性／timeout／retry／reconciliation

觀測 confirmed/superseded、Feed reason coverage、stale conflict；無 provider cost。

## 遷移／相容性／rollback

Legacy preference 可成 draft/source evidence，不自動 active；rollback 是新 superseding revision。

## Given–When–Then

- Given 新會員未完成定位；When 呼叫白名單（session、帳號、定位、入會／離會／主要公會與定位所需唯讀目錄）以外的會員 API，不論讀寫；Then 403 `onboarding_required`，完成定位與主要公會後可繼續；未登入可讀的公開路徑不受影響。
- Given 舊會員（`onboarding_required=false`）未定位；When self-confirm intent；Then可取得一般 low-risk Feed。
- Given 已完成定位；When 未確認 WorkIntent；Then 定位結果不被當成 confirmed intent。
- Given equipped package；When installation不存在；Then不冒充 verified installation。
- Given org bundle 缺 named operator；When request；Then拒絕且不帶個人 intent。

## 實際測試命令（將來會這樣跑；未跑）

以下 `docs/platform-plan/contracts/tests/*.py` 均為（新建）路徑，目前尚不存在。

```bash
python -m pytest docs/platform-plan/contracts/tests/test_work_intent_revisions.py -q
python -m pytest docs/platform-plan/contracts/tests/test_work_direction_basis_privacy.py -q
python -m pytest docs/platform-plan/contracts/tests/test_equipped_not_installed.py -q
```

尚無 tests，**未跑**。

## 缺 evidence 時的標籤／技術依賴

首批 profession/starter catalog 與 supply owners 未核對；只阻塞有內容的 live Feed。

## 完成證據

未完成；需 schema/migration、tests、Portal demo、privacy review。
