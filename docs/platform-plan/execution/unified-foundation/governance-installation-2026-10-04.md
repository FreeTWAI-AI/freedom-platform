# 中央 main 與九個 consumer 的實際治理門檻（2026-10-04）

這份紀錄接續 [P2](post-migration-plan-2026-10-04.md)。中央 `main` 的 ruleset `24469536` 保留；另已安裝九個 consumer `main` 的原生來源檢查 ruleset `24473806`。九倉正例與兩個偽造綠燈負例已在一次性 branches 實際測試 merge；三個共用 library 採用 PR 已正常合併。這些結果不代表完整 P2、所有 runtime 入口或 durable App publisher 已驗收。

中央首次安裝的非秘密[配置 artifact](../../verification/main-ruleset-2026-10-04.json)隨本紀錄提交；九倉後續配置與驗證範圍見下節。安裝後另以 `freedom-agent-kit:main` 為目標，實際驗到正常 native job 成功及竄改／偽造綠燈的 merge 被新規則拒絕，main 未變。

## 中央首次安裝紀錄

- Organization：`FreeTWAI-AI`；repository ID：`1378081342`；僅 `refs/heads/main`。
- Ruleset：`24469536`，`Freedom platform pinned verification`，active，無 bypass actor。
- Required workflow：本倉 `.github/workflows/verify.yml`，固定 `d269a8d7605630cab1da605d7cac4d0c254e3258`；候選 PR 修改 workflow 不改變 required workflow 的來源。
- Required status checks：`verify` 綁定 GitHub Actions App `15368`；`CodeQL` 綁定 GitHub Advanced Security App `57789`。strict base freshness 開啟。
- 必須走 PR；至少一位 reviewer、last-push approval、舊 approval 在新 push 後失效、review thread 必須解決；禁止 force push 與 branch deletion。
- GitHub 回讀另帶 `require_extra_approval_for_unattributed_changes=true` 及空 `required_reviewers`；保留服務端預設，不視為可忽略 drift。實際 `branches/main` 回報 `protected=true`，effective rules 同時含 workflow 與 App-bound checks。

首次中央安裝操作沒有合併產品 PR，當時 main 前後均為 `d269a8d7605630cab1da605d7cac4d0c254e3258`。這是安裝時點紀錄，不代表後續 PR 的現行狀態。所有產品 PR 仍走正常 review 與 merge，不使用 bypass；缺新規則要求的 workflow run 時，舊綠燈不能冒充新 required workflow。

## 中央首次安裝的真實正反例

首次中央測試使用一次性 `ops/governance-acceptance-base-20261004`，從同一 main SHA 建立；該次破壞 fixture 沒有指向 main。先對此 branch 安裝相同 pinned workflow／verify App-source 規則，再依下列實測結果套用正式 main 配置。

| 案例 | 實際結果 |
| --- | --- |
| [#114 正例](https://github.com/FreeTWAI-AI/freedom-platform/pull/114) | 只加合成文件及正確 inventory，app／contract／workflow 不變；[run 37236090337](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37236090337) 全部 10 jobs success。API 實際接受 merge 到一次性 branch，merge SHA `7dc328dd066229b6bca25db72bd7c6a6e0843526`；main 不變。 |
| [#115 竄改契約與 workflow](https://github.com/FreeTWAI-AI/freedom-platform/pull/115) | 改生成 metadata 的 `external_job_execution`，同步偽造 bundle／inventory hash，並把候選 workflow 換成單一 echo-success。GitHub 仍執行固定來源的 [run 37236094413](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37236094413)；canonical contract rebuild／diff 在 `static-worker` 真正失敗。 |
| #115 同名成功 status 偽造 | 只在此測試 head 以目前使用者發布 `verify`／`CodeQL` success status。第一次實際 merge API 回 405，指明 check 不是預期 GitHub App 發出；沒有 merge。 |
| #115 失敗 workflow 拒絕 | 決定性失敗已取得後，取消其剩餘耗時 jobs；再試 merge 回 405，指出 `verify`／required workflow 失敗。此 run 最終為 cancelled，不宣稱整套負例測試全部跑完。 |

一次性 branch 起初也要求 `CodeQL`，但該新 branch 未取得 default-setup 的 CodeQL check。為讓 workflow 正例能實際完成，只在一次性 branch 移除此項；main 的正式配置仍要求 `CodeQL@57789`，既有正常產品 PR 已實際取得該 App 的成功結果。這次正例不能用來宣稱在 probe 上驗過 CodeQL gate。Probe 的 review count 是 0；正式 main 為 1，本輪不宣稱已完成真人 reviewer 資格的完整負例。

測試後 #115 關閉且未 merge，#114 只 merge 到一次性 branch，三個自建 probe branches 已刪除。原始 API receipts、run/job 身分、失敗 logs 與安裝前後配置保存在操作者私有 journal `freedom-governance-enforcement-20261004`；公開 PR 保留可核對的合成測試歷史，不公開憑證或會員資料。

## 仍須完成

固定 YAML 阻止候選 PR 任意替換該 required workflow，但中央 verify workflow 仍會執行候選 checkout 的 build/test/scripts。因此它不等同 [治理規格](01-contracts-and-governance.md)要求的獨立可信 suite registry、不可竄改反例 harness 與完整 report publisher。`publisher_trust`／`library_usage` 不因本次安裝就改標 PASS。

後續沿既有 P2 補完整可信 harness 與證據來源、漏登入口／候選刪測試等反例、其餘 library resolution／operation 覆蓋，以及實際 merge-group／撤銷／durable replay／未知 ACK 驗收。以下 consumer 來源 gate 與局部 HTTP 測試各自只證明明列範圍；它們不證明 durable App publisher 已部署。原生 required workflow 是現有規格路徑，不能因另一方案未完成就移除門檻。

Workflow SHA 更新須審查新固定來源及重新驗證，不隨 main 自動移動。配置回讀和 probe 結果只證明本文件明列的 repository／branch／版本範圍。


## 九個 consumer 的已安裝來源 gate

新增的 org ruleset **`24473806`** 為 active，只覆蓋下列九個 repository ID 的 `refs/heads/main`，無 bypass actor，`do_not_enforce_on_create=false`。required workflow 是中央倉的 [`.github/workflows/trusted-consumer-libraries.yml`](https://github.com/FreeTWAI-AI/freedom-platform/blob/55f70c01e574cf66c8fa06b79fc9d8b3ffff0c4a/.github/workflows/trusted-consumer-libraries.yml)，固定來源 **`55f70c01e574cf66c8fa06b79fc9d8b3ffff0c4a`**；三倉 library 的 canonical source 固定 **`91b943ac61e132fbbce72ea066cb2301aa065600`**。逐倉 effective main rules 回讀均含此 workflow；既有中央 ruleset `24469536` 未變，沒有取代或略過既有 review／checks。

| Repo | 本次安裝時核對的 main head | 一次性 branch 正例 PR |
| --- | --- | --- |
| `FreeTWAI-AI/.github` | `9c8f3b62e2ed3f7f585abcc4d63112c4516c9515` | [#1](https://github.com/FreeTWAI-AI/.github/pull/1) |
| `FreeTWAI-AI/FreeTWAI-AI.github.io` | `90f790763f4f0507d123f325d194d2cf7b9bf73f` | [#2](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/pull/2) |
| `FreeTWAI-AI/freedom-agent-kit` | `b2227bc36a571084f6c3d5c5ab340ed4485c6738` | [#2](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/2) |
| `FreeTWAI-AI/freedom-growth-automation` | `d1fd7f223efcbed85c95cda18734a33e6528b82a` | [#1](https://github.com/FreeTWAI-AI/freedom-growth-automation/pull/1) |
| `FreeTWAI-AI/freedom-project-page` | `05508e805a764ec6b681792aaaf8c4803cb7a592` | [#1](https://github.com/FreeTWAI-AI/freedom-project-page/pull/1) |
| `FreeTWAI-AI/freedom-project-template` | `9bc7cee3f98d21da3156e5a67bfa63dc63a4615e` | [#1](https://github.com/FreeTWAI-AI/freedom-project-template/pull/1) |
| `FreeTWAI-AI/freedom-skill-registry` | `b5aed63bdd40d6c72df2afe039677d2173a2e3f9` | [#1](https://github.com/FreeTWAI-AI/freedom-skill-registry/pull/1) |
| `FreeTWAI-AI/freedom-storefront` | `87eda4878fb761deb4f9a1c1d7e421c2701f3dcb` | [#2](https://github.com/FreeTWAI-AI/freedom-storefront/pull/2) |
| `FreeTWAI-AI/freedom-supplier-client` | `7e98c3733e48aa96517d53de6944e3e365108979` | [#2](https://github.com/FreeTWAI-AI/freedom-supplier-client/pull/2) |

三個實際採用 PR：[agent-kit #1](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/1)、[storefront #1](https://github.com/FreeTWAI-AI/freedom-storefront/pull/1)、[supplier-client #1](https://github.com/FreeTWAI-AI/freedom-supplier-client/pull/1) 已在 hosted checks 通過後，以 exact head guard 正常合併至上述 main SHA。它們分別 import 共用 member workspace、storefront scoped reader、supplier workspace／transport；原有 preview API 相容性保留。

### Hosted merge 證據與邊界

安裝 main 規則前，probe ruleset `24472894` 對一次性 `ops/consumer-source-probe-20261004/base` 使用同一 source55 workflow。上表九個正例的原生 workflow 都成功，merge API 均實際接受合併到各自的一次性 base，native rule-suite 記錄 `pass`。兩個負例先取得明確原生失敗，再在各自 head 發布同名 `consumer-library-source=success` classic status；actual merge 仍回 405、指出 required workflow 失敗，rule-suite 為 `fail`，base 未改變：

| 負例 | 實際被拒的修改 |
| --- | --- |
| [agent-kit #3](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/3) | 改共用 member workspace 並重算 candidate lock 的 bytes／hash；canonical source 檢查報 `library_source_bytes_mismatch`。 |
| [directory #3](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/pull/3) | 改受保護的 `scripts/build.mjs`；報 `consumer_verification_entry_changed`。 |

這證明一次性 branch 的 native workflow 確實控制 merge，並非看到 check 名稱就當作強制。完整 receipts 留在私有 journal `freedom-platform-push-20261004`：`consumer-guard-probes/root-hosted-acceptance.json`、對應 merge／forged-status receipts、三個 `*-adoption-merge.response.json`、`root-nine-main-source.json` 及 `nine-main-rule-install.readback.json`。

新規則安裝後，另對 kit 的實際 `main` 執行正反例：[#4](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/4) 只改文件，native job `111563483040` success；[#5](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/5) 竄改 library，native job `111563493485` failure，錯誤為 `library_source_bytes_mismatch`。即使 #5 head 有同名 classic success status，帶 exact head guard 的 actual merge 仍回 **405**；rule-suite **`4357871927`** 明確記錄 active workflow rule **`24473806` fail**，main 維持 `b2227bc36a571084f6c3d5c5ab340ed4485c6738`。正例只驗 native job，不把此結果寫成 main 的正例 merge 成功；兩個 PR 均已關閉、未合併，規則保留。對應 `consumer-main-probe/root-main-acceptance.json`、`negative-suite-4357871927.json` 與 `cleanup.json` 保存核對結果。

### Source gate 與實際呼叫分開計算

來源 gate 只讀 immutable Git blobs。三倉檢查 source91 library bytes；其餘六倉檢查 canonical preview、manifest、固定 build／verification automation，產品 source／data 只要求指定路徑存在並交原有 CI 驗證。它不執行 candidate 程式，`library_usage=not_checked`，不能當 runtime 或 ReleaseSet approval。

另以這三個已合併 HEAD、canonical source91、隔離 PostgreSQL 與真實 localhost HTTP 跑既有 `consumer-libraries.test.ts`：**2/2 通過**，實際呼叫三倉入口，含 scope 隔離及 revoke 拒絕；既有跨倉 suite **5/5 通過**。合計 7 個測試已接入 `npm run test:repos`／`governance-consumers` CI。這是合成資料的局部呼叫證據，沒有覆蓋全部九倉 runtime、所有 library／入口或正式 provider；不回填來源 gate 的 usage 欄位。

九倉的 preview pin 仍為 `b221d2ba1bcf014dc785e95212455ba6f157ec6d`，bundle SHA-256 `835e9a898d3c10eaabd16c92cfeb25eae050f658814da3aec055f019a7245d3d` 與 canonical source91 相同。沒有用 cosmetic repin 代替採用。完整 P2 仍需其餘 operation／entry coverage、真正 merge queue、durable App publisher 的事件／restart／replay／unknown-ACK 驗收；宣告 `merge_group` trigger 不等於這些項目已通過。


## 三個 consumer 的隔離 HTTP 行為增量

[既有 supervisor 的 consumer 模式](../../../../packages/contribution-tools/consumer-behavior.md) 已能從三個實際 merged commits 匯出唯讀 candidate，於 network-none 容器呼叫真實產品入口；host Unix-socket HTTP fixture 獨立記錄路徑、method、synthetic credential 與不可預猜的 response markers。根 agent 重新跑過 12 個實際 Docker 測試：三倉正例、三倉只保留正確 vendor 的 stub 負例、偽造 stdout、竄改回傳、吞掉 scope／revoke 拒絕、隔離限制、非 `/usr` 的 Node 安裝都通過。

這是本機可執行的 `host_observed_http` 證據。它仍不宣稱內部 JavaScript library invocation，也不是 server ACL 的替代證據；相關欄位維持 `not_checked`。初次本機驗證時尚未安裝 runtime 規則；後續三倉實装與實際 merge 證據如下。既有 source55／rule 24473806 保持不變。


### 10 月 5 日：三倉 main 的原生 runtime gate

已新增 active org ruleset **24476100**，僅對 agent-kit、storefront、supplier-client 的三個明列 repository ID／`refs/heads/main` 生效，無 bypass；[公開配置](../../verification/consumer-runtime-ruleset-2026-10-05.json)記錄原始 payload。固定 workflow 為中央 `.github/workflows/trusted-consumer-runtime.yml`，來源 **c42df49e3ee93beed95eeda463a3c7811772b3c5**，library 仍固定 source91。三倉 effective rules 回讀均同時包含來源 gate 與 runtime gate；中央 24469536、九倉 24473806 的規則內容沒有改動。

安裝前，temporary rule 24475590 以同一 c42 workflow 跑六個真實 hosted jobs：三個正例 source/runtime 通過，三個只改產品入口為空殼、保留 vendor／locks 的負例 source 通過而 runtime 明確失敗 `consumer_behavior_mismatch`。三個正例實際 merge 到自建 temporary base；三個負例即使另加同名 classic success status，exact-head merge API 仍回 **405**。三倉 main 全程未變。驗後九個 owned refs、三個 negative PR 及 temporary rule 都已清理。

| Consumer | temporary 正例／負例 | native runtime job 正例／負例 | 負例 rule-suite |
| --- | --- | --- | --- |
| agent-kit | [#6](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/6)／[#7](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/7) | 111574506794／111574512252 | 4358341381 |
| storefront | [#3](https://github.com/FreeTWAI-AI/freedom-storefront/pull/3)／[#4](https://github.com/FreeTWAI-AI/freedom-storefront/pull/4) | 111574517344／111574517678 | 4358342509 |
| supplier-client | [#3](https://github.com/FreeTWAI-AI/freedom-supplier-client/pull/3)／[#4](https://github.com/FreeTWAI-AI/freedom-supplier-client/pull/4) | 111574527257／111574531581 | 4358343569 |

正式 main 規則安裝後，另用 kit [#8 正例](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/8)與 [#9 空殼負例](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/9)驗證：source gate 均通過；runtime jobs **111576954462 success／111576968345 failure**。#9 同名 classic green 不能替代 required native workflow；actual merge 回 **405**，rule-suite **4358417877** 明確記錄 24476100 fail。兩個 PR 已關閉且未合併，兩個 owned refs 已刪除，kit main 仍為 b2227bc36a571084f6c3d5c5ab340ed4485c6738；正式規則保留。

每個實際 hosted verdict 都綁定 c42 workflow、candidate merge SHA／tree、固定 Debian manifest／config／rootfs 與 Node 24.21.0 二進位 SHA；四個受限 bind、network-none、唯讀 root 及 cleanup 經 root 與獨立 agent 核對。操作者接受 GitHub managed Ubuntu24 runner／kernel／Docker 為此局部 gate 的 host 信任邊界，未宣稱 host kernel 不可變或另有 durable App publisher。工具的保守 provenance 欄位不以安裝敘述覆寫。

這一版只強制三倉 `src/index` workspace／reader 入口的可觀測 HTTP 行為。`library_invocation`、`library_usage`、`server_authorization` 仍為 `not_checked`；兩個[可執行反例](../../../../packages/contribution-tools/consumer-runtime-boundaries.md)已證明：手寫等價 HTTP、或破壞未覆蓋的真實 CLI，仍可能通過此版 gate。完整 CLI／其他入口、其餘六倉 runtime、merge queue 與治理規格的其餘要求仍待完成。私有 journal 保存 `consumer-runtime-canary/root-hosted-verdicts.json`、`root-merge-acceptance.json`、`cleanup-completed.json` 及 `consumer-runtime-main/completed.json`，只公開上述 aggregate 與 public PR/job IDs。
