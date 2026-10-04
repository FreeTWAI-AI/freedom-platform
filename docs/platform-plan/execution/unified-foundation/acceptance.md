# 共同基礎需求與驗收對照

這份索引保留統一計畫的 INT-01–28 與 GOV-01–32，共 60 項；另有 [R2/AP 原始驗收](source-acceptance.md) 38+70 項，合計 168 項來源要求。本輪只完成規格映射，全部產品驗收狀態為 `not_run`；實作仍需補每項的測試程式、競態反例及實際證據，168 不是完整 test case 數。

來源：[統一計畫 §19 與 §31](../../../plans/unified-foundation.md)。下表情境及預期保留原文；owner spec 簡稱對應 [GOV](01-contracts-and-governance.md)、[CORE](02-principal-command.md)、[ASSET-WORK](03-assets-private-work.md)、[EXEC-OPS](04-execution-adapters-release.md)。INT 以 `UF:INT-xx` 識別命名空間，原 ID 不變。

## Evidence 格式

每次實跑記錄 requirement ID、test ID/實際檔案、source SHA、base/candidate tree、contract/ReleaseSet、policy/adapter/runtime 版本、環境、命令、結果、時間、evidence artifact digest 及限制。CI 額外記 run/job/workflow/verifier 身分；cloud/packaged tests 記實際環境與能力。

個別 case 有正向及反向測試。必要測試 skipped/cancelled、只有 schema/mock、或只驗部分 surface，均不能把整列改為 passed。測試對私人資料只用合成 fixture，report 不帶 secret、個人真實內容或 private overlay。

## 跨計畫驗收

| ID | 情境 | 預期 | Owner spec | 最低證據層級 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| UF:INT-01 | 真人與Agent保存相同用途資產 | 共用store/purpose validation；各自auth；無fake session | ASSET-WORK | DB＋staging | not_run |
| UF:INT-02 | 無modelkey的會員換頭像／撤key | 正常工作，不依賴AIready | CORE、ASSET-WORK | DB＋E2E | not_run |
| UF:INT-03 | 同社群另一會員讀私人Work及R2結果 | list/detail/events/export/image全部拒絕或不列出 | ASSET-WORK | DB＋HTTP＋E2E | not_run |
| UF:INT-04 | site key指定他人principal/asset | 無delegation即拒；不能以server-to-server繞過 | CORE、EXEC-OPS | DB＋HTTP | not_run |
| UF:INT-05 | Agent上傳途中Grant或attempt失效 | finalize拒絕新業務commit；bytes可回收 | CORE、ASSET-WORK | DB 交錯交易 | not_run |
| UF:INT-06 | provider到期但晚到receipt須回報 | 限定evidence可對帳，不能再effect或讀任意private資料 | EXEC-OPS | runtime | not_run |
| UF:INT-07 | runtime A → B handoff | 舊epoch全部拒絕；新attempt保留可追溯billing/Grant | EXEC-OPS | packaged clients | not_run |
| UF:INT-08 | A的local-only artifact交接到cloud | 不自動upload，給missing/custody blocker | ASSET-WORK、EXEC-OPS | runtime | not_run |
| UF:INT-09 | 有本機CLI但model processing不符policy | 不能因CLIlocation=local就放行 | EXEC-OPS | 真實 adapter | not_run |
| UF:INT-10 | 私人結果要求公開 | 獨立domain publication確認／去敏，不直接翻asset public | ASSET-WORK | DB＋HTTP | not_run |
| UF:INT-11 | R2完成，最後DB交易失敗 | 無偽成功；sameintent恢復／回收 | ASSET-WORK | fault injection＋staging | not_run |
| UF:INT-12 | queue投遞兩次／ACK遺失 | 無重複modelstep/Result/domaincommit；unknown依provider處理 | EXEC-OPS | queue＋provider fault injection | not_run |
| UF:INT-13 | browser click已發出但receipt遺失 | 不另建intent重按；結果unknown可核對 | EXEC-OPS | 真實 browser fault injection | not_run |
| UF:INT-14 | Queue塞滿媒體工作時Stop | 本機fence/直接controlpath仍可用，不排隊等模型 | EXEC-OPS | runtime＋queue backlog | not_run |
| UF:INT-15 | 舊previewtoken呼叫Asset execution finalize | 不擴scope；原preview讀取不變 | CORE、GOV | HTTP | not_run |
| UF:INT-16 | 舊client不認新requiredpolicy | 不能execute；提供相容read/升級/停止途徑 | GOV、EXEC-OPS | mixed client runtime | not_run |
| UF:INT-17 | 修改Command或ArtifactRef的PR | CI選中media+execution+對應TS/Rustconformance | GOV | 可信 CI | not_run |
| UF:INT-18 | restore舊DB/queue且舊token仍持有 | recovery generation拒舊授權，不重播外部effects | EXEC-OPS | 隔離 restore drill | not_run |
| UF:INT-19 | 只關Agent新執行／回退UI | R2/privateACL/reconciliation仍存在 | ASSET-WORK、EXEC-OPS | rollback drill | not_run |
| UF:INT-20 | 更換模型付費來源 | 新明選binding/attempt，歷史實耗與來源不被覆寫 | EXEC-OPS | DB＋provider | not_run |
| UF:INT-21 | scope重疊但不同字串target | resolve到同控制資源；不得兩個controller競寫 | EXEC-OPS | browser 並發 | not_run |
| UF:INT-22 | 本機journal存在，平台工作已被撤銷 | journal不能讓run復活，僅補有限evidence | EXEC-OPS | runtime reconnect | not_run |
| UF:INT-23 | 兩條SQL逆序merge與空庫replay | 相依驗證/結果一致；未套用不被latest篩掉 | EXEC-OPS | 雙 migration runner | not_run |
| UF:INT-24 | 沒有人要求merge／僅有AIGrant | 不新增GitHubmerge/approve/deploy副作用 | GOV、EXEC-OPS | GitHub gate＋runtime | not_run |
| UF:INT-25 | broker收到被篡改的內部step/context | owner/attempt/data/budget重新檢查而拒絕 | EXEC-OPS | broker DB＋HTTP | not_run |
| UF:INT-26 | 下載URL cache/HEAD/Range遇share撤銷 | 下一次授權先拒絕，沒有R2public旁門 | ASSET-WORK | HTTP＋cache | not_run |
| UF:INT-27 | remote網站傳「新增工具／執行JS」 | 不成為extension/neo的已批准operation | EXEC-OPS | packaged clients | not_run |
| UF:INT-28 | A成功但B垂直流程仍無法接同核心 | 不宣告共同基礎完成；列出不相容責任與修正 | ASSET-WORK、EXEC-OPS | A/B 完整流程 | not_run |

## 開發治理驗收

| ID | 情境 | 預期 | Owner spec | 最低證據層級 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| GOV-01 | consumer修改vendor某DTO | 本機／可信CI拒絕；指向中央source修復 | GOV | 本機＋可信 CI | not_run |
| GOV-02 | 同時修改bundle、lock hash、驗證root自簽 | 不被可信publisher基線接受 | GOV | 可信發布＋CI | not_run |
| GOV-03 | 同一build出現兩個互斥SDK版本 | resolution check拒絕，不能只看package.json | GOV | build resolution | not_run |
| GOV-04 | 新頁面用私寫platform fetch繞client | import/operation邊界測試抓出，明確白名單不誤傷adapter | GOV | AST/build＋反例 | not_run |
| GOV-05 | 新API／queue／MCP入口未登記 | surface coverage拒絕 | GOV | registration coverage | not_run |
| GOV-06 | pageID只登記但實際route沒掛auth | behavior negative test拒絕 | GOV | HTTP behavior | not_run |
| GOV-07 | 從repo root啟Agent修改deep module | bundle包括該module規則；不只依AGENTS自動發現 | GOV | context tool | not_run |
| GOV-08 | Claude local/parent檔遮住AGENTS | launcher diagnostics顯示差異，wrapper按受測版本補載 | GOV | 受測 launcher | not_run |
| GOV-09 | Agent交接子Agent或換worktree | 子工作取得對應repo/head/bundle，不繼承錯repo context | GOV | context tool | not_run |
| GOV-10 | 長session跨模組／context重建 | 重新解析/提供delta，缺scope明示；CI最終scope獨立重算 | GOV | context tool＋CI | not_run |
| GOV-11 | 作者偽造context已讀receipt | 不能作verify依據；CI自己產evidence | GOV | 可信 CI | not_run |
| GOV-12 | 刪AGENTS或縮module glob來免檢 | baseline/candidate差異與unknown fallback拒絕逃逸 | GOV | baseline/candidate CI | not_run |
| GOV-13 | PR把workflow改成echo pass | 不滿足可信workflow/publisher identity與suite要求 | GOV | 真實 GitHub protection | not_run |
| GOV-14 | PR篡改selector或fixture為空集 | 可信基線／必跑反例仍執行，不能假綠 | GOV | 可信 CI/harness | not_run |
| GOV-15 | fork嘗試存取R2/prod/signing key | 測試環境無此權限／secret，不執行有權程式 | GOV | 隔離 fork CI | not_run |
| GOV-16 | selected job skipped/cancelled/failure | verify不是success | GOV | 可信 CI | not_run |
| GOV-17 | head相同但base前進 | 新integration candidate證據或原生queue重驗 | GOV | 真實 GitHub candidate | not_run |
| GOV-18 | consumer還在受支援前一版本 | 相容操作正常，未支持的新operation拒絕 | GOV、EXEC-OPS | mixed client runtime | not_run |
| GOV-19 | 已撤銷release仍符合semver | 新effect拒絕，不只按版本字串放行 | GOV、EXEC-OPS | runtime＋撤銷來源 | not_run |
| GOV-20 | contract shape不變但effect改成publish | 語意變更審查與安全測試，不能偷偷minor放行 | GOV | 語意 review＋behavior | not_run |
| GOV-21 | TS/Rust canonicalization/enum解碼不同 | 相同golden/negative vectors抓出 | GOV、EXEC-OPS | TS/Rust vectors | not_run |
| GOV-22 | 每份repo pin互相依賴造成循環 | release manifests不依賴未來consumer，工具拒自引用／缺artifact | GOV | ReleaseSet resolver | not_run |
| GOV-23 | resource-only repo偷偷新增execution code | classifier提升required profile/測試，不能自稱文件型逃避 | GOV | classifier＋CI | not_run |
| GOV-24 | sync未授權或同repo已有upgrade PR | 不寫GitHub；有授權時更新同batch不重複開PR | GOV | sync dry-run＋受權 GitHub | not_run |
| GOV-25 | site token當member／permit當login | purpose/typ/audience拒絕 | EXEC-OPS、GOV | HTTP/runtime | not_run |
| GOV-26 | staging keyset/token打prod | 環境與issuer拒絕 | EXEC-OPS、GOV | HTTP/runtime | not_run |
| GOV-27 | token帶未知kid／惡意jku | 僅可信來源有界refresh，否則拒；不任意連外 | EXEC-OPS、GOV | trust verifier | not_run |
| GOV-28 | public SDK含private/HMAC signing secret | secret/build boundary拒絕且查來源；不宣稱靠隱藏可安全 | EXEC-OPS、GOV | secret/build boundary | not_run |
| GOV-29 | 修改某頁model ref使用他人額度 | broker驗owner/Grant/data policy拒絕 | EXEC-OPS、GOV | broker DB＋HTTP | not_run |
| GOV-30 | rotation與offline client／restore | 按TTL/recovery generation拒舊權限；Stop仍可用 | EXEC-OPS、GOV | runtime＋restore drill | not_run |
| GOV-31 | 不相容policy工作中被升級 | fence/新attempt；歷史binding不被原地覆寫 | EXEC-OPS、GOV | runtime＋DB | not_run |
| GOV-32 | 未安裝指定launcher的人類或自製Agent送PR | 仍可貢獻；相同產出驗證，不能由未受管理繞過merge | GOV | 真實 GitHub protection | not_run |

## 里程碑完成條件

| 里程碑 | 必要結果 | 尚不足以完成的證據 |
| --- | --- | --- |
| 本機治理工具 | v1 相容、source/paths/版本反例、scope/context/coverage、固定三倉 fixture | 只有文件、hash 自洽或 agent 自稱讀過 |
| GitHub 治理 | 可信 harness 加實際 required workflow/App check，篡改 workflow/selector/報告的 PR 被擋 | 普通 CI 綠燈或 YAML 註解 |
| A 會員頭像 | 原 member auth、共用 Asset/R2、名片/聊天/目錄、撤銷與版本競態 | 假 store 通過、只有上傳成功 |
| B 私人 AI 草稿 | 一條真實明選模型路徑、Grant/attempt、相同 Asset、owner-only、人改稿不被覆寫、不自動公開 | mock provider 或另一套 agent_files 儲存 |
| 跨端 handoff | Chrome/neo 新 attempt、舊 permit 拒絕、unknown 對帳、local-only 不偷上雲 | 兩端只是顯示同名工作 |
| 發布及恢復 | 支援版本矩陣、migration/helper 相容、DB/R2 restore、撤銷不復活 | 只有新 UI 能啟動或只還原 DB |

## 原需求保留

UF-01–12 的實作 owner 分別落在 CORE、ASSET-WORK、EXEC-OPS 及 GOV 的章節；CG-01–08 由 GOV 為主，runtime trust/rotation 由 EXEC-OPS 負責。U0–U7/UX 與 CG-A–G 的交付映射見 [總入口](README.md)。

原 R2 S/A/M/D 及 AP AUTH/WORK/EXT/NEO/OPS 清單已完整保留在 [來源驗收](source-acceptance.md)，附 owner spec、最低證據層級與整合修訂；實際 test IDs 由實作 PR 登記。原 [平台 acceptance matrix](../acceptance-matrix.md) 的 T/UAT/A4 要求保留，不因新增索引降低其要求或改寫驗收狀態。

本輪文件檢查只驗三份原文快照相同、168 個驗收 ID 及 24 條原則映射無漏列/重複、相對連結、diff whitespace 與 source inventory；結果另在交付報告記錄，不填入上列產品測試。
