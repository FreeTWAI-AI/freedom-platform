# 契約發布與開發治理規格

Spec ID：`UF-SPEC-GOV`；狀態：`local-partial`。來源：統一計畫 §11、14、23–31，CG-01–08。本規格供分工實作治理工具，讓每個 checkout 取得可追溯的契約、適用上下文及獨立驗證結果。GOV-A/B 本機工具與 GOV-C 的 host-owned 資料驗證邊界已有實作；正式 runner、可信 check publisher 及 GitHub 強制仍未接線，證據見 [交付紀錄](implementation-status.md)。

## 範圍與原有實作

沿用 [contract build](../../../../scripts/build-contract-bundle.mjs)、[export](../../../../scripts/export-contract-bundle.mjs)、[bootstrap verifier](../../../../scripts/repository-bootstrap/verify-contracts.mjs)、[SDK](../../../../packages/sdk) 及 [repo snapshots](../../../../repositories.lock.json)。新增 shared contribution-tools 及薄入口；實作前查重，不將 copied verifier 再擴成各倉各自維護的程式。

本機工具不連正式 DB、不登入、不讀私有部署 overlay。consumer upgrade 是另外明示範圍的批次，不是 prepare 的副作用。

## ReleaseSet 及 lock

`governance/schemas/` 已有本機 schema；批准後的 release authoring metadata、正式發行與信任來源仍待接線。以下是目標欄位契約，實作的固定 wire 名稱與限制以 [治理實作](../../../../governance/README.md) 及其 schema 為準。

| 物件 | 必填內容 | 不变量 |
| --- | --- | --- |
| ReleaseSet | `format`、`release_set_id`、`source_repository`、完整 `source_commit`、`contracts[]`、`libraries[]`、`policy`、`generator`、`fixtures`、`profiles[]`、`trust_profile_version` | 所有 artifact 以 path、byte count、SHA-256 固定；不能用 latest 或可變 tag |
| contracts entry | family、wire version、operation/policy 相依、artifact refs | preview 保留原 family 與 digest；新 execution 不以 preview credentials 呼叫 |
| libraries entry | library/subpath ID、version、integrity、runtime profile | 同一 build 的核心 SDK/validator 解析到同一套相容 artifact |
| detached proof | subject manifest digest、publisher 身分與可驗 provenance/signature | manifest 不含自己的 digest/proof；不能由 candidate 自帶 root 決定信任 |
| support metadata | release set digest、支援期間、撤銷/最低安全版本、revision、到期時間 | 由獨立可信更新來源發布；不改已發布 manifest bytes |
| contracts.lock v2 | exact ReleaseSet ref/digest、artifact pins、producer SHA、格式版本 | 固定 checkout 的內容；不當部署紀錄 |

首批本機實作固定 ReleaseSet 為 `sha256-exact-bytes/v1`，簽署 domain-separated 的原始 UTF-8 manifest bytes，使用 Node 24 原生 Ed25519；deterministic authoring 對 key 排序，但不宣稱是 JCS。此選擇與向量見 [治理實作](../../../../governance/README.md)。未來 execution 的 JCS/JOSE profile 另定；不改既有 preview hash 或 SQL `digest(sql)`。目前只有 fixture keys，尚未配置正式 publisher。

Reader 必須同時支援 v1 與 v2。v1 走原有 preview 驗證，報告 `legacy_preview`；不能聲稱已有可信 ReleaseSet 發布，更不能換得 execution 權限。原 v1 檔案與 bundle 無變動時，build 不得造成無關的重新生成差異。

v2 驗證順序：解析有界資料 → 驗 repo/profile 與固定來源 → 驗已批准 publisher/proof → 驗 manifest digest → 驗 exact file set、bytes、hash → 驗 resolved libraries → 驗 policy freshness/撤銷 → 產出報告。任一步不可用需列原因，不得改走浮動來源補成功。

首版的批准 publisher、proof profile 及可信根尚待實作 PR 決定與 operations 接線。可先以非正式 key/provenance fixtures 測上述算法；fixture-only 結果不能發布 `trusted=true` 的正式 ReleaseSet。

Artifact path 只允許 repo-relative POSIX 路徑，拒絕空 segment、`.`、`..`、absolute/drive/UNC 路徑、symlink 與 case-fold collision；Windows/macOS/Linux 執行相同反例。設定檔只接受資料，不載入 JS、URL hook 或任意 shell command。下載前後均有大小上限；錯誤輸出只含安全 ID/path，不反射 token 或外部內容。

## Module descriptor

每個 module 一份 `freedom.module.json`，其 schema 包含 `module_id`、owner role ref、owned paths、public exports、dependencies、surfaces、contract families、approved client profiles、instruction/invariant/test refs。

每個 surface 包含 stable ID、kind、entry、operation refs 與 auth profile。kind 至少覆蓋 page、HTTP route、scheduled handler、queue handler、MCP tool、native bridge command。只引用 domain policy；不在 descriptor 重寫角色權限。

每個 ref 必須能解析到真實 source/test/operation。第一批 coverage 包含現有會員頭像入口、現有 Work 列表及其頁面；私人草稿入口建立時一併登記。沒有的頁面不能只在 descriptor 中宣稱已接通。

基線由已批准版本產生，candidate 可提出新增或修改。影響範圍取 baseline 與 candidate 的聯集，再加 renamed/deleted paths、反向依賴及實際註冊入口。縮 glob、降 repo profile、移入 utils/legacy、刪測試或刪 descriptor 不會減少該 PR 的必測集合。

Hono、navigation、queue/MCP/native registration 優先導出實際 registry。無法靜態識別的動態入口需要 registration test；未知入口保守選全套對應測試並回 `surface_unmapped`，不能以 grep 零結果當成無入口。

## 開工 CLI

以下命令已有本機實作；對未治理的 baseline 或尚缺的檢查 adapter 會回 unavailable，而不是宣稱可信 CI 通過：

```sh
node scripts/freedom.mjs prepare --base-ref origin/main --scope assets,member-card
node scripts/freedom.mjs context --paths apps/portal-web/src/modules/Membership.tsx
node scripts/freedom.mjs verify --base-ref origin/main --report .freedom/reports/current.json
```

`scripts/freedom.mjs` 只轉入固定版本的 shared tooling。程式 API 以同一 library 提供給其他 runtime 的 wrapper，不能強迫每個 Rust/Python repo 建一套 Node workspace。

`prepare` 在開始時把 base-ref 解析為 SHA，讀取 head、index/worktree 差異及 planned scope，解析已驗證 cache 中的版本，產生 task-specific context。缺 source 時預設回報缺項；若實作提供下載選項，只接受明列來源及 exact ref，驗證完才載入，不能執行未驗工具。

`context` 輸出全組底線、repo profile、本次 module/operation 的完整必要條款與來源。短摘要可以導覽，不能取代 mandatory clauses。以 document ID/digest cache 提供 delta；超出容量時明列未提供部分並要求下一段讀取，不能默默截斷。

`verify` 對實際差異重新計算 scope、檢查 source/import/surface/behavior coverage，再執行由可信 suite registry 選定的本機檢查。descriptor 不能指定任意命令。無法執行的必要檢查標 `not_run`，總結不得 pass。

建議 CLI exit contract：`0=所要求層級通過`、`1=明確違規/測試失敗`、`2=缺來源或環境導致 verification_unavailable`。本機通過的 `assurance_level=local`，無權產生 `trusted_ci`。console 與 JSON 使用同一 result，不提供獨立 always-success 分支。

## Context 及驗證報告

| Context 必填 | 用途 |
| --- | --- |
| task ID、repo stable ID/full name、base/head SHA、workspace state digest | 避免換 worktree 後使用前一個 repo 的輸入 |
| active policy ID/digest、candidate ReleaseSet/contract refs、repo profile | 區分當前安全底線與正在修改的設計 |
| planned/changed paths、module/page/operation IDs、反向依賴 | 表達範圍與跨域影響 |
| documents 的來源、digest、必要完整內容、shared APIs | 確認實際提供內容而非模型理解聲明 |
| library resolution、guardrails、selected tests 與選擇理由、blockers | 能追查測試為何被選中或缺失 |

輸出位於 `.freedom/context/<task>/` 與 `.freedom/reports/`，排除於 Git 及 source inventory；需要稽核時上傳受控 artifact，不進共用 context.json。不得包含私人 prompt、api key、使用者資料或私有 overlay。

新任務、跨 module/repo/worktree、base/lock/policy/descriptor 改變、session 重建及 delegation 時重算相關內容。CLI 只能證明明確呼叫的事件；未實作 launcher hook 時，不宣稱會攔住每一次模型編輯。工具 wrapper 的自動載入以實際版本驗收，root/parent/local override 衝突要明示。

VerifierReport 額外包含 repo/PR、head/base/candidate tree、run ID、verifier SHA、ReleaseSet/policy digest、實際 test IDs 與每項結果、evidence digests、assurance level。report 不作權限憑證；私人 repo 的 report 不可公開到不相干倉。

## 共用 library 與實際使用

會員 client 保持既有同源、CSRF、Idempotency-Key、If-Match 及 redirect/retry 行為；execution/service exports 待其 auth 實作可用才啟用。UI build 不得解析到 DB、vault、ops 或 server-only service client。

檢查實際 module resolution、imports 與 operation 呼叫，不只 package.json。新 frontend platform fetch、consumer 自定中央 wire schema 或 crypto verifier 要能被反例抓出。合法 provider HTTP、後端 SQL、測試 adapter 以有 scope、原因、expiry、替代測試的中央例外管理，candidate 自填例外不立即生效。

## 可信 CI 與 GitHub 強制

沿現有 `verify` 彙總結果，審查資格另用必要的 `review-policy`。正式結果的可信 verifier 位於受保護、已批准的固定 revision；對候選 repo 只做資料解析，不能 import 候選 policy script。

可信控制部分決定 base/head/candidate、測試選擇與基線反例；執行 candidate build/test 的部分放隔離、短生命週期、沒有正式秘密的 runner。候選程式不能寫 verifier binaries、suite registry 或最終可信結果。必跑的安全反例由 trusted harness 提供，不能完全依賴 candidate 測試檔及其 exit 0。

CI evidence 必須取自實際 run/job/workflow 身分、固定 harness 與 runner 產出的結果。PR artifact 的 `passed:true` 或假 JUnit 只是不可信資料。檢查零 tests、skipped/cancelled/failure、遺漏 suite、tree/SHA 不符及改過 fixture 均失敗。

GitHub 接法由實際 org 能力決定：能使用 required workflow 時，固定中央來源和預期 workflow；否則在既有 Maintainer 範圍增設窄權 check publisher，required check 固定 App 身分。publisher 不執行 PR 程式，也不能只轉抄候選 artifact。

啟用前需有一份具體配置 artifact：org/repo/branch 範圍、workflow revision 或 App ID、required result、review 規則、bypass 身分及操作理由記錄、候選 base freshness 策略。這份 spec 不設定上述 GitHub 狀態。

新 push、base 前進、candidate 改變或安全 policy 撤銷都使舊整合證據失效。若採 merge queue，支援 `merge_group`；否則合併前重新驗最新 base/candidate。review/label/資格變動只重算輕量資格檢查，仍需至少一位有效非作者 reviewer 及人明確要求合併。

## 有限跨倉同步批次

sync 首先產生 dry-run 計畫，列 batch ID、目標 ReleaseSet digest、明確 repo 集合、各 repo base/head、相容差異、預計改檔及測試。人授權的範圍綁這組版本與 repositories；prepare/context、唯讀 drift 檢查及一般 coding 工作都不能自行產生外部 upgrade PR。

實際執行前再次讀取 repo head 與既有 upgrade PR。每倉同一 batch 只維持一張 PR；同一授權範圍內可更新它，遇到其他 batch、作者另有改動、head 不符或 repo 權限不足時記錄 conflict，不覆寫。branch/PR body 保存 batch/release 身分及 source evidence，失聯後先 read-back 再重試，避免重複建立。

同步只更新實際使用的 contract/library，保留 LICENSE、repo profile 與上游原生設定。consumer 測試及正常 review/merge 不被 sync 繞過；中央 repositories.lock 只在需要改整合測試樣本時另行更新，不能與 consumer pin 形成循環。

測試用 fake GitHub adapter 驗未授權零寫入、同 batch 去重、不同 batch 衝突、head 前進及中斷恢復；真實 GitHub 寫入另需明示批次授權。GOV-24 在只有 dry-run 時保持未完整驗收。

## PR 切分與驗收

| PR 範圍 | 交付與測試 | 不能宣稱的完成 |
| --- | --- | --- |
| GOV-A | 新 schema、v1/v2 reader、deterministic fixture、source/path 反例 | 正式 signer 或全組治理上線 |
| GOV-B | shared context/verify、module registry、baseline/candidate 聯集、三倉 local fixtures | 任意 Agent 的自動 hook 均有效 |
| GOV-C | 隔離 runner、trusted harness、證據完整性與 fake-workflow 反例 | GitHub 側尚未設定時的 merge 強制 |
| GOV-D | 實際權限及方案盤點、配置 artifact、授權後設定及試驗 PR | 未執行的 protection 測試 |

GOV-A/B 最少測 v1 不變、vendor+hash 同改、path traversal/symlink/case collision、self-signed root、missing/withdrawn source、deep module、換 worktree、rename/delete、空 test set、未註冊入口與雙 SDK。GOV-C/D 加 workflow echo-pass、偽 artifact、同名 App check、fork secret 隔離及 base 前進，對應 [GOV 驗收](acceptance.md)。

本機 suite registry 已有 governance、明確隔離 DB 的 runtime，以及 Kit/Storefront 固定 Node suite adapters；不執行 consumer package hooks。整合 `7a1c1b2` 的治理測試為 196/196、無跳過。候選 Git tree、baseline ownership fallback、vendor exact bytes 及完整 observation binding 均在本機驗證；host observation 的真實來源仍未認證，所有 report 保持 local、merge/execution 未授權。既有 `npm run contracts:build`、`npm run test:contracts`、`npm run test:repos` 與 `npm run verify:inventory` 仍保留；integration tests 僅可用隔離 `fp_*` schema。

新增 [有限 source audit](../../../../packages/contribution-tools/surface-audit.md) 只以 host 注入的 parser 解析 baseline/candidate bytes，不 import 或執行候選程式。它抽取六條 avatar/private-read route 及 mount 的語法事實；既有 receiver delegates、其他 routes 與 runtime behavior 仍未覆蓋。`coverage_kind=fixed-syntax-only`，`structural_status` 及整體狀態只有 unavailable/failed，沒有局部綠燈或 helper 名稱豁免。29 項作者測試加 30 項獨立反例通過；負向案例必須產生相對 baseline 新增的具體問題，不能靠固定 unavailable 假通過。這個 host-only 模組尚未接入 CLI/可信 publisher，不解除 `registration_behavior_audit_required`。

另有 [固定 member 行為 harness](../../../../packages/contribution-tools/behavior-harness.md)，由 host 固定六條既有 route 的 27 個 request/assertion，不接受 candidate 的 test registry、執行路徑或 passed 報告。Host 注入 request port 與合成 fixture，前後核對候選／workflow／harness／fixture 身分；response 受 byte／time 上限約束，證據不保存 cookie、CSRF 或私人正文。成功只提供 scoped observation，整體仍 local/unavailable、無 merge/execution 權限；transport 本身的認證、runner 隔離、完整入口覆蓋與可信 publisher 尚缺。負向 avatar mutation 保留獨立的缺漏前置條件，避免 auth 回歸時破壞 fixture。這不是把本機測試改名成可信 CI。

回退可以停用新 CLI/consumer v2 升級；已發布且被撤銷的 release 不得因工具回退重新標為可信。缺 v2 能力的舊 client 回到原 preview 能力範圍，不能忽略不認識的新必需 policy。
