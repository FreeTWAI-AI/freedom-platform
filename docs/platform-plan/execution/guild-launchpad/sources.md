# 來源與覆蓋界線

中央 source 與 ERP source 均於 2026-10-05 以遠端 main/clone 核對；所有本 PR 原始碼現況判斷固定到下列 commit，非 live 部署證明。

| 來源 | 固定值 / 本次讀取 |
| --- | --- |
| 中央 | `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9` |
| ERP | `077a003634e5c11592b78acd969c6fe0814858a2`；實際 LICENSE、NOTICE、templates、engine、domain、worker、backup、storage、launch-kit 已讀 |
| 提供主稿 | Freedom-Guild-Launchpad-Architecture-Plan-v1.0.md，v1.0，2026-10-05，1,251 行 |
| 主稿全文 SHA-256 | `a8d1d2c4d693cd5343cd301710f912047220c61fe67aef33115798b82c3925cb`；原始與重新附上的主稿逐行一致 |
| 原 requirements-and-acceptance JSON | 使用者以 .txt 附上，完整有效 JSON；SHA-256 `513512ec8944a5281ffedaf1eba793736da75e469f1cf95d6d16bfe1016feb0b` |
| 原 source-index JSON | 使用者以 .txt 附上，完整有效 JSON；SHA-256 `d53adc0811b9f561d642fdd74e0a13e74a5d8c35c28247909e7fe1b19b0d621a` |
| 核對 | 22 D、64 R、60 T、13 SP；原 67 條 R↔T 邊雙向一致，章節及 D 映射保留；27 S/W URL 一致 |
| 無法取得 | 原對話 session 的完整逐則紀錄；原 ZIP 的 AGENT-START-HERE 與 SHA256SUMS。主稿 §24 提供完整接手格式。未聲稱讀完整對話或驗包內 checksum |

## 來源索引（沿用原 ID）

S/W scope_note 是原規劃作者記載的查阅范围；下表 URL 固定commit者可重現，不把它當本次產品測試。W03/W06/W07/W09 已另開官方文件核對核心RLS/至少一次/limits/SSRF原理；不固定未量測數字SLA。其餘官方來源作規劃參考，不表示引入其他雲端服務。

| ID | 來源 | 適用 |
| --- | --- | --- |
| S01 | [中央平台 main 版本](https://github.com/FreeTWAI-AI/freedom-platform/commit/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9) | 本輪以 GitHub connector 重新確認 main；不是部署版本證明。 |
| S02 | [ERP 原作 main 版本](https://github.com/mars-tw/freedom-erp-crm/commit/077a003634e5c11592b78acd969c6fe0814858a2) | 本輪以 GitHub connector 重新確認 main。 |
| S03 | [PR #105：外部 ERP 試用入口](https://github.com/FreeTWAI-AI/freedom-platform/pull/105) | 已讀 metadata、原討論及 diff；本輪重新確認 open／未 merge／mergeable=false，狀態可能後續改變。 |
| S04 | [產品、社群與組織運轉模型](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/docs/platform-plan/01-product-community-model.md) | 已讀相關開頭章節：平台承諾、概念分離、Guild／Squad；不是全文及產品驗收。 |
| S05 | [公會分組與解鎖書架](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/docs/development/guild-library-layout.md) | 已讀全文，確認原一主兩次與技能書保留政策。 |
| S06 | [公會成員等級實作](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/modules/positioning/member-tier.ts) | 已讀原始碼，確認 intern／full 與會長操作邊界；本輪未執行測試。 |
| S07 | [共同 DB 入口](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/packages/db/index.ts) | 本輪已讀；確認 member command 匯出、transaction、journal／outbox 與版本檢查。 |
| S08 | [商務模型及分銷接點](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/modules/catalog-commerce/service.ts) | 已讀相關原始碼，及 agent-commerce/distribution.ts 搜尋片段；不宣稱完整 checkout 現場驗收。 |
| S09 | [實際移植後執行計畫](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/docs/platform-plan/execution/unified-foundation/post-migration-plan-2026-10-04.md) | 本輪重讀更新段落；內容是來源記載的狀態，不是本次親自執行的部署或恢復證據。 |
| S10 | [Autopilot 三端整合設計](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/docs/plans/autopilot-vnext.md) | 已讀前 135 行等相關片段，確認身份、模型與契約方向；不是全規格或已發布能力。 |
| S11 | [ERP 原作 README](https://github.com/mars-tw/freedom-erp-crm/blob/077a003634e5c11592b78acd969c6fe0814858a2/README.md) | 已讀全文，確認模擬用途、範本及授權聲明。 |
| S12 | [ERP 模組範本及 Worker](https://github.com/mars-tw/freedom-erp-crm/blob/077a003634e5c11592b78acd969c6fe0814858a2/src/templates.ts) | 已讀 templates.ts、worker.ts、workspace-storage.ts；確認模組組合、cookie／DO、SIM及保留邊界。 |
| S13 | [Mini 等原作登錄](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/docs/development/member-skill-registration.md) | 已讀全文，確認原作與當時登錄／未執行範圍。 |
| S14 | [平台設計規範](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/DESIGN.md) | 已讀品牌、tokens、互動、手機與產品規範等相關段落。 |
| S15 | [中央 project manifest](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/freedom.project.yaml) | 已讀全文；授權標示 NOASSERTION／source_available，部分部署描述可能為舊基線。 |
| S16 | [Agent 工作說明](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/AGENTS.md) | 已讀全文；供後續實際開工重新核對，文件內命令不表示本次已執行。 |
| S17 | [現行需求基準與歷史覆寫](https://github.com/FreeTWAI-AI/freedom-platform/blob/567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9/docs/platform-plan/00-current-requirements-baseline.md) | 已讀相關開頭章節；整體地基、低維運、原計畫與後續覆寫的背景。 |
| W01 | [Microsoft：多租戶控制面](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/control-planes) | 官方架構原理；不要求引入 Azure。 |
| W02 | [Microsoft：多租戶資料與儲存](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data) | 官方架構原理，特別是隔離、客製、單租戶恢復與遷移。 |
| W03 | [PostgreSQL 18：Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html) | 官方 RLS 行為與 bypass／owner 限制；不代替本案權限測試。 |
| W04 | [AWS：Transactional Outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) | 官方設計模式；不要求新增 AWS 服務。 |
| W05 | [AWS：Saga Orchestration](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-orchestration.html) | 官方設計模式；不要求建立另一個工作引擎。 |
| W06 | [Cloudflare Queues：Delivery Guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) | 本輪查閱至少一次傳遞及去重要求。 |
| W07 | [Cloudflare Workers：Limits](https://developers.cloudflare.com/workers/platform/limits/) | 本輪查閱 CPU、memory 等限制；正式 spec／部署時需重新核對。 |
| W08 | [RFC 9700：OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html) | 原始安全規範，支持限制 token 用途與受眾等實務。 |
| W09 | [OWASP：SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) | 官方安全指引；外部 endpoint 的規格與反例來源。 |
| W10 | [GitHub：Rulesets 可用規則](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) | 官方治理機制；規則實際安裝狀態需另查 repo。 |

## ERP 授權與上游界線

宣告授權為 MIT，Copyright (c) 2026 mars-tw；[完整 LICENSE](https://github.com/mars-tw/freedom-erp-crm/blob/077a003634e5c11592b78acd969c6fe0814858a2/LICENSE) 與 [NOTICE](https://github.com/mars-tw/freedom-erp-crm/blob/077a003634e5c11592b78acd969c6fe0814858a2/NOTICE) 已讀。本 PR 只寫規格，未複製實作。日後衍生/分發實作或實質片段需保留完整許可/免責、署名、source commit、變更範圍及實際依賴 notices；這不重新授權中央 NOASSERTION 或其他素材。

[PR #105](https://github.com/FreeTWAI-AI/freedom-platform/pull/105) 查閱時 open，head `c1606a068c3c0b79e5a653f80f2169a214b92b74`，三檔變更只有外部 demo/source link、E2E與inventory；沒有站內ERP backend。此 PR 不改它或任何 Issue。

## 資料與引用使用

沒有公開原對話或內部取檔metadata。使用者D-ID意圖保留為產品方向；public repo是程式/契約/授權證據。資料、程式、規劃、測試、部署五種來源不能相互代替。整包ZIP未取到不影響依已讀完整主稿及原JSON寫spec，但獨立checksum核對仍明列未做。
