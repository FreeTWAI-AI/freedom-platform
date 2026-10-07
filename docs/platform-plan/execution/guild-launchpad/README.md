# 公會啟動台與可攜式業務空間：SP-00–SP-12

版本 0.1，2026-10-05。**完整技術規格草案；只有文件與靜態文件驗證，沒有功能實作、正式資料遷移、部署或產品驗收。**

目標是全部有效公會都有能保存、返回工作的公版；成員在自己有權的 tenant 啟動應用；每個 module instance 可單獨攜出應用、資料、附件與互通配置，與仍由平台託管的模組繼續合作。一般人工工作不需要模型帳號。公會、主力、職務、tenant、實例與資料權威不能互相代替。

## 先讀

1. [SP-00 基線與追蹤](SP-00-baseline-traceability.md)：來源覆蓋、規則優先序、舊模型的明確取代範圍
2. [共同契約字典](contracts.md)、[資料責任](data-responsibility.md)、[實際檔案對照](repository-map.md)
3. [決策待辦](decision-log.md)：建議技術預設和仍需明訂的政策；不重新詢問已決定的產品方向
4. [64 項需求追蹤](traceability.json)、[60 項未執行驗收](acceptance.md)、[來源](sources.md)

| ID | 技術規格 | 主要介面相依 |
| --- | --- | --- |
| SP-00 | [基線與追蹤](SP-00-baseline-traceability.md) | 可立即開始 |
| SP-01 | [公會與偏好](SP-01-guild-preferences.md) | SP-00 |
| SP-02 | [Tenant 與授權](SP-02-tenant-authorization.md) | SP-00、既有 identity/command |
| SP-03 | [全公會啟動台](SP-03-all-guild-launchpad.md) | SP-01/02；具名 fixture 可並行 |
| SP-04 | [應用與實例](SP-04-applications-instances.md) | SP-02/05 |
| SP-05 | [模組互通](SP-05-module-interoperability.md) | SP-02、command/work |
| SP-06 | [資料隔離與恢復](SP-06-isolation-recovery.md) | SP-02/05、storage/recovery |
| SP-07 | [可攜套件](SP-07-portable-bundle.md) | SP-04/05/06 |
| SP-08 | [單模組遷移](SP-08-module-migration.md) | SP-05/06/07/09 |
| SP-09 | [外部連線安全](SP-09-external-connection-security.md) | SP-02/05、既有 key/grant |
| SP-10 | [領域與原作接入](SP-10-domain-upstream-integration.md) | SP-03/04/05；外移接 SP-08 |
| SP-11 | [AI、用量與維運](SP-11-ai-usage-operations.md) | SP-02/04/05/09、私人 AI 前置 |
| SP-12 | [整合與發佈](SP-12-integration-release.md) | 各包介面；測試設計立即並行 |

## 三條並行線與不可偷換的里程碑

- 共同基礎：tenant/member/permission → command/registry/ports → storage/portability/fencing
- 全公會：catalog/primary → shared shell/default Work+note+attachment+Result → 實際保存再開啟；不等電商完成
- 領域深化：唯一 commerce owner + inventory port、非商務 Work → 單庫存外移、混合聯動、故障恢復

M0 是本次規格/追蹤草案；M1 全公會可用公版、M2 受控實例、M3 真正單模組可攜、M4 逐公會深化均仍未實作/未驗收。UI fixture 不能代替 M1 的持久化與 ACL；整包 ERP 搬遷不能代替 M3。

## 已核對與未核對

- 中央 source：`567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`；ERP reference：`077a003634e5c11592b78acd969c6fe0814858a2`
- 已完整閱讀提供的 v1.0 主稿 1,251 行，22 決策、64 需求、60 待驗收、13 spec 包均保留穩定 ID
- 無法取得原對話 session 的逐則完整紀錄；原 ZIP 傳輸失敗，未讀到其 AGENT-START-HERE 或 SHA256SUMS。其後另取得使用者提供的兩份原始 JSON，已核對 requirements/acceptance 的全部文字、章節、D/R/T 關係及 27 個 S/W 來源與主稿一致。主稿第 24 章已含接手規則。此處 traceability.json 是保留原始關係並增補 repo 對照的衍生檔，**不是假造原 ZIP 檔案副本**
- 沒有複製私人對話、客戶資料、私人取檔連結、secret、原始 dump 或 ERP 程式碼。ERP 是有固定來源與 MIT 署名的架構參考
- 最新部署/治理敘述引用既有 [foundation handoff](../unified-foundation/handoff-2026-10-04.md)，不是本輪 live 查驗。該 ledger 的 168 項要求及[原平台驗收](../acceptance-matrix.md)完整保留，不能被這 60 項取代

[文件驗證紀錄](verification.md)區分本次靜態檢查與未来產品案例；執行 `python3 docs/platform-plan/execution/guild-launchpad/validate-spec-pack.py` 只驗追蹤與文件結構，絕不將 T-ID 改為通過。
