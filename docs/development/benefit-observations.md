# 自願實益回報

2026-09-23 本輪實作，部署須以該次 release 的實測紀錄為準。這是原計畫 §12／FW-13 的第一個可運行子集，不代表完整低維運指標、跨模組容量或真人驗證已完成。

工作開始後，需求者與實際承接者各自可回報「有得到／部分得到／沒有得到／還不確定」。可略過；沒有回報保持 `not_reported`，不計為失敗、零工時或不願再參與。回報不改工作驗收、Contribution、rank、權益、付款及收款紀錄。無 reviewer 的工作仍能回報實際經驗，不必等接受成果才有資格。

前端在工作與已接受成果卡提供收合的選填區，展開才讀取資料；內容包含具體收穫、可略過的解題投入分鐘及再參與意願。自由文字與證據引用預設僅本人可讀，另一位當事人只看整體回報數量／outcome 分布。平台一般會員、第三人、其他社群及 client read token 無讀取權。

## API

以下為既有會員 cookie、同源 JSON、CSRF 及 onboarding 權限之內的 API；不是外部 Agent 的確認能力，尚未納入 preview 32-operation SDK。

| 方法 | 路徑 | 行為 |
|---|---|---|
| GET | `/api/v1/work-items/:id/benefit-observations` | 只讓本人需求者或承接者取得目前 WorkItem `aggregate_version`、server-derived `role`／`work_claim_ref`、`can_report`、本人最新 `own_observation` 與去除文字的摘要。 |
| POST | 同上 | 依既有 `BenefitObservationRequest` 保存一筆，回 `201 BenefitObservationReceipt`；需 `Idempotency-Key`、目前 WorkItem 的 `If-Match`。 |

Request／receipt 形狀採 [work-participation schema](../platform-plan/contracts/work-participation.schema.json) 的 `$defs/BenefitObservationRequest`／`BenefitObservationReceipt`；測試以原 schema 驗證實際 request 和 response。Runtime 額外只接受 UUID 與不含 URL／secret 的 opaque evidence ref。需求者固定 `work_claim_ref:null`；承接者固定自己的 Claim ID。不能自行指定 reporter，也不能以其他人的 role 或 Claim 建立第二份回報。

```json
{
  "work_claim_ref": null,
  "role": "beneficiary",
  "outcome": "partly_gained",
  "actual_gain": "能自行整理資料，但匯出格式還需要調整。",
  "evidence_refs": [],
  "would_participate_again": null,
  "effort_minutes": null,
  "supersedes_observation_ref": null
}
```

工時可整體為 null，或分為 `platform_maintenance`、`coordination_friction`、`collaborative_value`、`paid_delivery`，各為非負安全整數或 null。零表示本人確實回報零；null 表示未知。一般畫面只問可略過的解題／創作／測試分鐘，其餘已存在資料在修正時保留。

第一筆 `supersedes_observation_ref:null`；修改須指向本人同 Work／role／Claim 最新一筆 ID。伺服器同一交易檢查 WorkItem 版本及 lineage，append 新 revision，不更新舊回報。競態修改一筆成功、另一筆 `409 benefit_observation_changed`；過期 WorkItem 版本回 412、缺 If-Match 回 428。同一 key／相同 request 的成功重送回原 receipt，後續 WorkItem 版本變動不會把已提交回報重做一次。

只有開始執行或後續階段的真實 Claim 才可回報；開放中或只有剛認領回 `409 participation_not_started`。目前只支援既有本人發布＋單一會員承接的 Work 流程；組織代表、多人 Squad Claim 與跨 Work 合作週期不在本次 scope。

## 摘要與證據

只計各 lineage 最新回報，保留 `gained`、`partly_gained`、`not_gained`、`unconfirmed`、`not_reported`。`both_participants_reported_gained` 只表示兩個不同會員帳號的兩個角色各自回報 gained；固定 `evidence_level:self_reported`、`independent_people_verified:false`、`income_verified:false`。它不是兩位獨立自然人已驗證互惠的比例，更不是實收或正式 QC。

原北極星還需要獨立自然人／真實受益者、持續價值與重用、同一合作週期去重、時間窗、核心補位及工時覆蓋等 evidence。此功能補上第一手觀察來源，不把 accepted_count 或兩個帳號的自報直接改名為北極星。

Journal／outbox 只記 observation 與 Work refs／revision，不放私人敘述、evidence refs、意願或工時。尚未新增催填、通知、公開排名或營運承諾。
