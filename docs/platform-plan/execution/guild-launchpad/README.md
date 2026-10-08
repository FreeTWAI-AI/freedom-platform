# 公會啟動台與可攜式業務空間：SP-00–SP-12

版本 0.1，2026-10-05。建立時是完整技術規格草案：只有文件與靜態文件驗證，沒有功能實作、正式資料遷移、部署或產品驗收。**2026-10-07 更新：M1 已有部分實作合併，並部署到 staging 與 production，但功能未啟用，也沒有產品驗收；現況以[目前狀態](#目前狀態)為準。**

目標是全部有效公會都有能保存、返回工作的公版；成員在自己有權的 tenant 啟動應用；每個 module instance 可單獨攜出應用、資料、附件與互通配置，與仍由平台託管的模組繼續合作。一般人工工作不需要模型帳號。公會、主力、職務、tenant、實例與資料權威不能互相代替。

## 目前狀態

<!-- glp-status: as_of=2026-10-08 release.production=e8cd72e8112a7460f4c29bad4feb1a6a2aeffe1f release.staging=e8cd72e8112a7460f4c29bad4feb1a6a2aeffe1f flag.production=absent flag.staging=absent repo_max_migration=129 applied_migration.production=125 applied_migration.staging=125 capacity_policy_rows=0 authority_policy_rows=0 accepted_m1=false accepted_full=false -->

2026-10-07 的紀錄。權威來源是 [unified-foundation 現況快照](../unified-foundation/current-state.json)的 `deployment`、`features.guild_launchpad` 與 `schema`；文字紀錄見 [Foundation 收尾](../unified-foundation/closeout.md)的 10 月 7 日第四輪 rollout。上面的 `glp-status` 註解由 `validate-spec-pack.py` 對照來源檢查，CI 的 contracts pytest 也會執行這項檢查，不一致就失敗；更新現況快照的這些欄位時，要同時更新這一節。

狀態行由 `validate-spec-pack.py --write-status` 從 `migrations/`（repository 最大編號）、`current-state.json`（operator 觀察：部署、flag、已套用 migration、政策列）與 `acceptance-progress.json`（各里程碑驗收進度：M1 的 28 案全部有證據通過才接受 M1，60 案全部通過才接受完整計畫）產生。Repository 最新的 migration 是 129（#244 於 2026-10-08 合併，帶進 126、127；P-D1（#239）帶進 128；P-D2a 帶進 129），兩個環境都已套用到 125，126～129 尚未套用。local 執行可以記錄，但不算驗收證據：passed 至少要有一筆 ci、staging 或 production 的通過紀錄。

`accepted_m1`／`accepted_full` 只有在驗證無失敗、里程碑指定 `candidate_sha`，且每案都已通過並有該 SHA 在 ci、staging 或 production 的有效、未被較晚非通過結果推翻的通過證據時才為 true。T-015 與 T-023 依 `acceptance-progress.json` 的 `scope` 採 M1 變體驗收。M1 變體結果記在該案的 `variants.M1`，沿用相同的 `status`／`evidence` 格式，只計入 M1，不計入完整計畫。沒有 `variants.M1` 時，M1 使用該案本身的結果。新增 migration 的 PR 必須重跑 `python3 docs/platform-plan/execution/guild-launchpad/validate-spec-pack.py --write-status`。

- 部署：main `e8cd72e8` 自 2026-10-07 22:46Z 在 staging、23:07Z 在 production 執行；migration 125（#206，tenant 表的 row security）兩邊都已套用，120–124 在第三輪（`687dee87`）已套用。
- 啟用：`FREEDOM_GUILD_LAUNCHPAD_ENABLED` 在 staging 與 production 都沒有設定（停用），啟動台相關路由不會掛載。
- 政策列：兩邊的 `tenant_capacity_policies` 與 `tenant_authority_policies` 都是 0 列，所以即使開啟 flag，tenant 寫入也會回 `policy_unconfigured`。
- 驗收：沒有。只跑過發布時選定的檢查（網站回報 launchpad 停用；匿名呼叫 guild-categories 路由得到 401），沒有 guild-work 流程的產品驗收；[60 項驗收](acceptance.md)仍全部 not_run。

M0 規格包（SP-00–SP-12）由 #153（merge `c6f4a2cf`）合併。M1 各部分如下；PR 與 SP 的對應取自各 merge commit 的標題，migration 取自各 merge 對 `migrations/` 的差異。

| M1 部分 | 已合併 | 已部署 | 已啟用 | 已驗收 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| P-A 公會分類與主力偏好（SP-01） | #163，merge `eb4e348e`，migration 120 | 是，`e8cd72e8`；120 兩邊已套用 | 否 | 否 | 2、4、7 |
| P-B1 業務空間授權核心（SP-02） | #164，merge `93e1470b`，migration 121 | 是，`e8cd72e8`；121 兩邊已套用 | 否 | 否 | 4、6、7 |
| P-B2a 經營權移交與受控復原（SP-02） | #175，merge `137ace26`，migration 124 | 是，`e8cd72e8`；124 兩邊已套用 | 否 | 否 | 3、4、6、7 |
| P-C1 啟動台殼層與版本化設定（SP-03） | #160，merge `12a2a83c`，migration 122 | 是，`e8cd72e8`；122 兩邊已套用 | 否 | 否 | 4、7 |
| P-C2 業務空間手動工作與人工成果（SP-03／SP-04／SP-06） | #181，merge `57b610ab`，migration 123 | 是，`e8cd72e8`；123 兩邊已套用 | 否 | 否 | 1、4、5、6、7 |
| P-C2-UI「我的工作」畫面（SP-03） | #190，merge `31df6ddb`，無 migration | 是，`e8cd72e8` | 否 | 否 | 4、5、7 |
| P-K／P-K2 啟動台契約（SP-12） | #188，merge `6596263d`；#209，merge `5ccd76c3`；無 migration | 是，包含在 `e8cd72e8` | 不適用，沒有獨立開關 | 否 | 隨上列各部分 |
| P-E1 tenant 表的 row security（SP-06） | #206，merge `70fb6ae7`，migration 125 | 是，`e8cd72e8`；125 兩邊已套用 | 資料庫層已生效，不受 flag 控制 | 否 | 6、7 |

下一步相依（都是未完成事項，不是承諾）：

1. PR #227：有界的 capacity policy operator 工具；截至 2026-10-07 為 open，當天已有修正、重新審查中。
2. PR #226：#163 的唯讀 backfill／切換狀態；已合併（merge `3e33c736`），包含在 `e8cd72e8`。
3. 缺口：兩邊的 `tenant_authority_policies` 都是 0 列，所以經營權移交與復原會回 403 `policy_unconfigured`。這需要 owner 選定的政策值（[決策待辦](decision-log.md)的 OPEN-02／03），以及類似 #227 的 operator 工具。OPEN-04／13 的 staging 暫時容量值已於 2026-10-07 選定；OPEN-07 保留期也已於當天決定（見決策待辦），但備份到期清除尚未實作。
4. 只在 staging 的啟用試驗，搭配有界的暫時 capacity policy。
5. 在 staging 以真實 R2 做 guild-work 驗收；verifier 製作中。
6. PR #206（P-E1：tenant 表的 row security，SP-06，migration 125）已合併（merge `70fb6ae7`），2026-10-07 第四輪隨 `e8cd72e8` 部署到兩個環境。備份角色依 owner 選定的路徑取得 BYPASSRLS；兩邊部署後的備份，18 張 row security 表的列數都與 owner 相同。P-E2（#245，不含 P-D1 的部分）已於 2026-10-07 23:47Z 合併（`87f9fe51`）；#244（migration 126、127）已於 2026-10-08 02:40Z 合併（`32899577`），尚未部署。M1 候選版本在 #227 合併後切出，P-D1（#239）在候選版本切出之後才合併。production 啟用會使用附 gate 證據的候選版本。
7. production 啟用由 owner 決定。

本目錄其他文件是 2026-10-05 以 `567ae8d3` 為基線的規格紀錄，文中的「目前／現行」指當時。`traceability.json` 的 `planning_only` 與各需求的 `planned` 是當時的規劃追蹤，保留不改；60 項驗收至今仍是 `not_run`，進度記在 `acceptance-progress.json`，不記在 `traceability.json`。SP-01–SP-04 與 SP-06 的狀態行保留原文，另加 2026-10-07 註記指回本節。

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

M0 是本次規格/追蹤草案（#153 已合併）。M1 全公會可用公版已有部分實作合併並部署，但未啟用、未驗收（見[目前狀態](#目前狀態)）；M2 受控實例、M3 真正單模組可攜、M4 逐公會深化仍未完成、未驗收。UI fixture 不能代替 M1 的持久化與 ACL；整包 ERP 搬遷不能代替 M3。

## 已核對與未核對

- 中央 source：`567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`；ERP reference：`077a003634e5c11592b78acd969c6fe0814858a2`
- 已完整閱讀提供的 v1.0 主稿 1,251 行，22 決策、64 需求、60 待驗收、13 spec 包均保留穩定 ID
- 無法取得原對話 session 的逐則完整紀錄；原 ZIP 傳輸失敗，未讀到其 AGENT-START-HERE 或 SHA256SUMS。其後另取得使用者提供的兩份原始 JSON，已核對 requirements/acceptance 的全部文字、章節、D/R/T 關係及 27 個 S/W 來源與主稿一致。主稿第 24 章已含接手規則。此處 traceability.json 是保留原始關係並增補 repo 對照的衍生檔，**不是假造原 ZIP 檔案副本**
- 沒有複製私人對話、客戶資料、私人取檔連結、secret、原始 dump 或 ERP 程式碼。ERP 是有固定來源與 MIT 署名的架構參考
- 2026-10-05 撰寫時，最新部署/治理敘述引用既有 [foundation handoff](../unified-foundation/handoff-2026-10-04.md)，不是本輪 live 查驗；之後的部署狀態見[目前狀態](#目前狀態)。該 ledger 的 168 項要求及[原平台驗收](../acceptance-matrix.md)完整保留，不能被這 60 項取代

[文件驗證紀錄](verification.md)區分本次靜態檢查與未来產品案例；執行 `python3 docs/platform-plan/execution/guild-launchpad/validate-spec-pack.py` 只驗追蹤、文件結構，以及[目前狀態](#目前狀態)的 `glp-status` 行是否與現況快照一致，絕不將 T-ID 改為通過。這是手動指令；CI 只透過 contracts pytest 的 `docs/platform-plan/execution/tools/tests/test_guild_launchpad_status.py` 執行其中的 `glp-status` 檢查。
