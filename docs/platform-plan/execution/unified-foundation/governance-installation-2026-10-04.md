# 中央 main 與九個 consumer 的實際治理門檻（2026-10-04）

這份紀錄接續 [P2](post-migration-plan-2026-10-04.md)。**2026-10-06 17:06 UTC 現況：** 中央 `24469536` 的 required workflow 已固定 `d1c9e18fffabebbdceaba233a34f3605220e2dd7`，review 與 App-bound checks 不變；見文末「10 月 6 日」一節及[本次升級證據](../../verification/main-ruleset-2026-10-06.json)。下一段的 c3e 為 10 月 5 日當時紀錄。**2026-10-05 05:22 UTC 現況：** 九倉來源規則 `24473806` 與三倉 runtime 規則 `24476100` 都已固定至 `92a58db9948c4c56a9d81d1450b9a856fb94a944`，增加執行入口登錄檢查與 storefront／supplier 真實 CLI。中央 `24469536` 的 c3e workflow、review 與 App-bound checks 完整保留。21 個一次性 branch probes 和 3 個 main-target probes 已完成並清理；精確配置與 native jobs 見[本次實裝證據](../../verification/consumer-entry-cli-enforcement-2026-10-05.json)。下方 source55／c42／c3e consumer 紀錄為各次安裝歷史；不代表現行 consumer workflow pin。完整 P2、所有 runtime 入口與 durable App publisher 仍未驗收。

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


### 10 月 5 日：三倉 main 原生 runtime gate 首次安裝（c42 歷史紀錄）

首次新增 active org ruleset **24476100**，僅對 agent-kit、storefront、supplier-client 的三個明列 repository ID／`refs/heads/main` 生效，無 bypass；[公開配置](../../verification/consumer-runtime-ruleset-2026-10-05.json)記錄原始 payload。當時固定 workflow 為中央 `.github/workflows/trusted-consumer-runtime.yml`，來源 **c42df49e3ee93beed95eeda463a3c7811772b3c5**，library 仍固定 source91。三倉 effective rules 回讀均同時包含來源 gate 與 runtime gate；中央 24469536、九倉 24473806 的規則內容沒有改動。

安裝前，temporary rule 24475590 以同一 c42 workflow 跑六個真實 hosted jobs：三個正例 source/runtime 通過，三個只改產品入口為空殼、保留 vendor／locks 的負例 source 通過而 runtime 明確失敗 `consumer_behavior_mismatch`。三個正例實際 merge 到自建 temporary base；三個負例即使另加同名 classic success status，exact-head merge API 仍回 **405**。三倉 main 全程未變。驗後九個 owned refs、三個 negative PR 及 temporary rule 都已清理。

| Consumer | temporary 正例／負例 | native runtime job 正例／負例 | 負例 rule-suite |
| --- | --- | --- | --- |
| agent-kit | [#6](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/6)／[#7](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/7) | 111574506794／111574512252 | 4358341381 |
| storefront | [#3](https://github.com/FreeTWAI-AI/freedom-storefront/pull/3)／[#4](https://github.com/FreeTWAI-AI/freedom-storefront/pull/4) | 111574517344／111574517678 | 4358342509 |
| supplier-client | [#3](https://github.com/FreeTWAI-AI/freedom-supplier-client/pull/3)／[#4](https://github.com/FreeTWAI-AI/freedom-supplier-client/pull/4) | 111574527257／111574531581 | 4358343569 |

正式 main 規則安裝後，另用 kit [#8 正例](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/8)與 [#9 空殼負例](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/9)驗證：source gate 均通過；runtime jobs **111576954462 success／111576968345 failure**。#9 同名 classic green 不能替代 required native workflow；actual merge 回 **405**，rule-suite **4358417877** 明確記錄 24476100 fail。兩個 PR 已關閉且未合併，兩個 owned refs 已刪除，kit main 仍為 b2227bc36a571084f6c3d5c5ab340ed4485c6738；正式規則保留。

每個實際 hosted verdict 都綁定 c42 workflow、candidate merge SHA／tree、固定 Debian manifest／config／rootfs 與 Node 24.21.0 二進位 SHA；四個受限 bind、network-none、唯讀 root 及 cleanup 經 root 與獨立 agent 核對。操作者接受 GitHub managed Ubuntu24 runner／kernel／Docker 為此局部 gate 的 host 信任邊界，未宣稱 host kernel 不可變或另有 durable App publisher。工具的保守 provenance 欄位不以安裝敘述覆寫。

這一版只強制三倉 `src/index` workspace／reader 入口的可觀測 HTTP 行為。`library_invocation`、`library_usage`、`server_authorization` 仍為 `not_checked`；兩個[可執行反例](../../../../packages/contribution-tools/consumer-runtime-boundaries.md)已證明：手寫等價 HTTP、或破壞未覆蓋的真實 CLI，仍可能通過此版 gate。完整 CLI／其他入口、其餘六倉 runtime、merge queue 與治理規格的其餘要求仍待完成。私有 journal 保存 `consumer-runtime-canary/root-hosted-verdicts.json`、`root-merge-acceptance.json`、`cleanup-completed.json` 及 `consumer-runtime-main/completed.json`，只公開上述 aggregate 與 public PR/job IDs。


### 10 月 5 日 01:45 UTC：c3e 實際 CLI gate 升級已安裝

同一 main runtime ruleset **`24476100`** 已升級至固定來源
**`c3e5a537a75303c4688e01b7f0d8477c3587a26f`**，使用新的 immutable publication ref
`push-20261005/consumer-cli-runtime-source` 及原有
[`.github/workflows/trusted-consumer-runtime.yml`](https://github.com/FreeTWAI-AI/freedom-platform/blob/c3e5a537a75303c4688e01b7f0d8477c3587a26f/.github/workflows/trusted-consumer-runtime.yml)。
舊 c42 ref 沒有移動；上述 c42 配置 artifact 保留為首次安裝紀錄，不冒充現行來源。
三倉／main 範圍不擴大。九倉 source55／rule `24473806`、library source91 及中央
`24469536` 在本次 CLI probe／清理期間保持原配置；中央後續更新另記。
目前固定來源與完整 policy 的非秘密回讀另存為 [c3e runtime 配置](../../verification/consumer-cli-runtime-ruleset-2026-10-05.json)。

新版 host 對 kit 同時要求 source、workspace 及真實 `src/cli.mjs#maker` 的隔離
HTTP observation，綁定相同 candidate commit/tree 並確認各自 cleanup。CLI 走 synthetic
protocol → login → 五個 workspace reads → cookie／CSRF logout；其 session 值由 host
fixture 回傳。Storefront／supplier 仍只要求原 workspace profiles。任何必要 setup 不可用
也會拒絕，但只有 `failure={stage:cli,kind:behavior_mismatch}` 才計為本次 CLI 負例證據。

安裝前以 temporary rule **`24477081`** 及三倉自有 temporary bases 實跑：

| Hosted probe | Native job | 實際結果 |
| --- | --- | --- |
| [kit #10 文件正例](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/10) | `111581987356` | source／workspace／CLI 全通過；只 merge 到 temporary base，SHA `e0b3d9c7e056d5b9ee5aa0556831740d05bb1731`。 |
| [kit #11 CLI-only 負例](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/11) | `111581993149` | 正確 vendor／locks／workspace 保留；source、workspace 通過，CLI 明確 behavior mismatch。偽造同名 classic green 後 actual merge 仍回 **405**，rule-suite **`4358621717`**。 |
| [storefront #5 文件正例](https://github.com/FreeTWAI-AI/freedom-storefront/pull/5) | `111581996067` | source／workspace 通過，CLI `not_required`；temporary merge SHA `b9aef5625caae4a2f7dd80b5b405dcd74f4064fd`。 |
| [supplier #5 文件正例](https://github.com/FreeTWAI-AI/freedom-supplier-client/pull/5) | `111582002095` | source／workspace 通過，CLI `not_required`；temporary merge SHA `230173aa93a294a72dd0833977f4a23e6d0eb884`。 |

四個 verdict 均有 cleanup true。01:41:33 UTC 已刪 temporary rule `24477081` 與七個
owned refs，關閉 #11；三倉 main 及保留規則不變。

升級正式 runtime rule 後，再對 kit **實際 main** 驗證：
[#12 文件正例](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/12) 的 job
**`111582738936`** source／workspace／CLI 全通過，未 merge；
[#13 CLI-only 負例](https://github.com/FreeTWAI-AI/freedom-agent-kit/pull/13) 的 job
**`111582747620`** source／workspace 通過而 CLI 失敗。原有 `verify-template` 的綠燈不
代表此入口被驗證；即使另有同名 classic green，actual merge 仍回 **405**，rule-suite
**`4358652158`** 拒絕。01:45:10 UTC 已關閉兩個 probes、刪兩個 owned refs；kit main
維持 `b2227bc36a571084f6c3d5c5ab340ed4485c6738`，正式 rule `24476100` 保留 c3e。

證據來源為操作者 journal 中的 `consumer-cli-canary/root-hosted-acceptance.json`、
`merge-acceptance.json`、`cleanup-completed.json`，以及 `consumer-cli-main/completed.json`
和 `hosted-verdicts.json`；公開只記非秘密 aggregates、PR/job IDs 與來源 SHA。

此升級補上 kit 的 **maker demo CLI** 入口，不是完整 CLI／library coverage。手寫等價
workspace 仍能通過，`library_invocation`、`library_usage`、`server_authorization` 保持
`not_checked`；其他 kit roles／error paths、另兩倉 CLI、其餘六倉 runtime、未知入口與
merge queue、durable publisher／replay／unknown ACK 仍未完成。Host 邊界仍是操作者接受的
GitHub managed Ubuntu24／kernel／Docker，加固定 source／image／Node；不宣稱 immutable
kernel、新 durable App publisher 或完整 P2。


### 10 月 5 日 01:56 UTC：中央 required workflow 來源更新

中央 ruleset **`24469536`** 已將 `.github/workflows/verify.yml` 的固定 SHA 從
`d269a8d7605630cab1da605d7cac4d0c254e3258` 更新為
**`c3e5a537a75303c4688e01b7f0d8477c3587a26f`**。Fresh readback 比對確認唯一政策
變更是 `/rules/3/parameters/workflows/0/sha`；repository／main 範圍、active、空 bypass、
App-bound checks、strict freshness、review／last-push approval 與禁止刪除／force push
均保留。首次配置 artifact 仍是歷史紀錄，不代表現行 workflow SHA。
現行非秘密配置另存為 [10 月 5 日 main ruleset](../../verification/main-ruleset-2026-10-05.json)。

同一 c3e head 的 [Verify run 37251980098](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37251980098)
及 [CodeQL run 37251977438](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37251977438)
均已 completed／success。這兩筆是來源 head 的既有 CI 證據；更新中央規則後、包含本次
文件 push 的新 native main-target run **仍待完成**，不以舊 run 代替新 required workflow
驗收。Selector 必須依整個 PR diff 判斷範圍，不因最後一次 commit 只改文件便縮成 docs-only。

操作者保留 `main-workflow-c3e/before.json`、`after.json`、`verified.json` 與上述兩個 CI
readbacks；configuration verified、PUT ACK 已知，沒有新增 bypass 或跳過 reviewer。
這次更新不改 consumer source55／library91 或三倉 runtime rule `24476100`，也不補足前述
candidate-authored test scripts、library invocation 與完整 P2 的信任缺口。


## 10 月 5 日：九倉入口登錄與三倉實際 CLI 強制（92a58db）

這次只改既有 `24473806`／`24476100` 的 canonical workflow `sha`／`ref`，固定 ref 為 `refs/heads/next-20261005/consumer-enforcement-source`，SHA 為 `92a58db9948c4c56a9d81d1450b9a856fb94a944`。逐倉回讀九個 main 都有 source gate，只有已採用 library 的 kit／storefront／supplier 三倉另有 runtime gate；library 保留 source91。範圍、無 bypass、其餘規則與中央必要 review 均未改動。

Source host 比較完整 immutable Git 路徑與核准基線，保護 root／nested package 的可執行登錄、生命週期 scripts、已知 workflow／launcher 設定、隱含 Node/npm 入口及新增 executable mode。描述欄位與一般產品 source 可改；dependencies、engines 等非描述 package 欄位也須經可信基線更新，不能誤認為一般依賴升級自動放行。這不是所有動態 route／runtime 入口的完整發現。

Runtime 沿既有隔離 supervisor，新增 storefront／supplier 的 `scripts/run-client.mjs` → `client/cli.mjs` 真實程序鏈；正常資源讀取、錯誤 scope、撤銷及 server error 都由獨立 host HTTP trace 與不可預猜的回應核對，並保留 kit maker-demo CLI。外層 launcher 會把子 CLI failure 彙整成 exit 1，所以不能單由該 exit 推定每個失敗原因；結果仍須符合完整 trace／輸出條件。`library_invocation`、`library_usage`、server ACL 與其餘六倉 runtime 維持 `not_checked`。

本機真實 Docker 檢查發現另一個 bug：`docker create` timeout 後，daemon 可能晚於兩次空掃描才完成建立。Supervisor 現在先記錄 pending create；缺有效 ACK 時保留 `supervisor_create_outcome_unknown`／`create_pending`，即使掃描為空也不宣稱 cleanup verified。測試覆蓋該時序，沒有靠延長 timeout 或刪除不明來源容器消除證據。

安裝前的 21 個一次性 branch probes 都使用同一固定來源：九個文件正例 native source 通過（其中三倉 workspace／CLI 也通過）並實際 merge 到臨時 base；九個新增 `bin` 負例各報 `consumer_entry_registration_changed`，三個僅替換 CLI 的負例 source／workspace 通過、CLI 報 `consumer_behavior_mismatch`。12 次負例 actual merge 全為 405。所有執行過的 runtime cleanup 已核對，沒有偽造 check、rerun 或取消 native run。

正式 pins 升級後，再以 storefront 實際 main 為目標：

| Probe | Native 結果與 actual merge |
| --- | --- |
| [#9 正例](https://github.com/FreeTWAI-AI/freedom-storefront/pull/9) | [source 37267160241](https://github.com/FreeTWAI-AI/freedom-storefront/actions/runs/37267160241)／[runtime 37267160235](https://github.com/FreeTWAI-AI/freedom-storefront/actions/runs/37267160235) 成功，實際 CLI 七個情境通過；只驗 green，關閉且未 merge。 |
| [#10 新增入口](https://github.com/FreeTWAI-AI/freedom-storefront/pull/10) | [source 37267162055](https://github.com/FreeTWAI-AI/freedom-storefront/actions/runs/37267162055)／runtime 都因入口登錄變更拒絕，actual merge 405；suite `4360306561` 記錄兩個 active rules 失敗。 |
| [#11 替換 CLI](https://github.com/FreeTWAI-AI/freedom-storefront/pull/11) | [source 37267165139](https://github.com/FreeTWAI-AI/freedom-storefront/actions/runs/37267165139)／workspace 通過，[runtime 37267165130](https://github.com/FreeTWAI-AI/freedom-storefront/actions/runs/37267165130) 只在 CLI 行為失敗；actual merge 405，suite `4360309737` 為 source pass／runtime fail。 |

36 個 native jobs 的 source SHA、固定 checkout、workflow path、GitHub Actions App `15368`、check suite、PR head／tested merge tree 與失敗原因均核對。24 張 probes 全部結束，兩個臨時 rules `24483203`／`24483204` 及本輪 owned probe refs 已刪除；九個 consumer main 未變。正式新規則與 immutable source ref 保留。完整 API／logs 留在私有 `freedom-platform-next-20261005/consumer-probes` 與 `consumer-main-probes`；公開 JSON 僅保存配置、版本、run IDs、結果與邊界。

## 10 月 5 日：目錄站真實建置規則（#128）

中央 [#128](https://github.com/FreeTWAI-AI/freedom-platform/pull/128) 經
`detna-vibe-coding` 核准最終 head `25449d11`，正常合併為
`5b471fe730f11a85700d5ab3225d6c862cee7bc3`；合併 tree 與通過完整 CI 的
`4ee62c16` 相同。新規則 **24516222** 僅對目錄站 main 強制固定的
`.github/workflows/trusted-consumer-runtime.yml`，active、無 bypass，publication ref
為 `refs/heads/governance/directory-runtime-source-20261005`。九倉 source 規則24473806
仍固定a254，三倉 HTTP／CLI 規則24476100 仍固定92，中央 review 規則保留。

固定 host 對真正 `scripts/build.mjs` 跑十個隔離案例。輸出由 Docker daemon 在
暫停容器後提供完整 archive，host 只雜湊 regular files，核對固定參考產物與完整
輸入樹；candidate stdout 不提供 verdict。正常錯誤輸入須退出1且未產生半成品。
未知 exec／建立結果、讀回或清理失敗均拒絕。這是有限輸入與固定 renderer 契約，
不證明任意輸入、瀏覽器、visual redesign 或內部 library invocation。

安裝前兩個正例（目錄站 #12／#13）各完成十個案例，僅 merge 到自有臨時 base；
三個 source-valid 負例（#14 常數假輸出、#15 移除跳脫、#16 提早寫入）均在真正
build observation 失敗，actual merge 均405。正式規則安裝後，#17 正例通過並關閉，
#18 假輸出負例再次 merge405；rule-suite **4369999977** 為 source pass／runtime fail。
七張 probes 均結束，臨時 rule24516070 與十二個分支已移除。目錄站 main 保留
`e888d6a751269221e0b2b64ed4bc2d945ee8bd3e`，本輪沒有 Pages 或主站發布。

精確 rule 配置、PR／native run／job IDs 及清理結果見
[目錄站建置安裝證據](../../verification/directory-runtime-enforcement-2026-10-05.json)。
本節記錄實際已安裝範圍，不把前面「其餘六倉」的歷史文字當現行剩餘數量；
目前另五個 source-only profiles 的實際 runtime 仍待完成。

## 10 月 5 日：目錄站真正 merge queue 整合驗收

本次沿用正式已核准的 source a254 與 runtime5b，不改任何驗證程式或正式規則。
在目錄站自有 `canary/directory-queue-20261005/base` 上，臨時 org rule24519256
要求相同的兩條固定 workflows，repository rule24519258 啟用真正 merge queue：
`ALLGREEN`、build concurrency2、最多合併2筆、`MERGE`、timeout10分鐘、無 bypass。
GitHub 的 [queue 規則](https://docs.github.com/en/enterprise-cloud%40latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-merge-queue)
設在 repository；兩條 workflow 均接收真正的 `merge_group` 事件。

- [A／#19](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/pull/19) 只在 renderer 加入一個由特定資料觸發的合成錯誤；目前資料與十個 host cases 均通過。
- [B／#20](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/pull/20) 只更改資料文字，對原 renderer 是合法輸入，也完成十個 host cases。
- A、B 分別通過自己的兩條固定 native workflows 後，依 exact head 加入 queue。GitHub 產生 A 的 `eb187161` 與 A＋B 的 `d823cc8e`，檔案集合及兩個 PR 的 ancestry 均經回讀核對；後者不是任一原 PR 的 tested tree。

| Queue candidate | 固定 source | 真正 build | GitHub 結果 |
| --- | --- | --- | --- |
| A：`eb187161` | [37349786300](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/actions/runs/37349786300) 通過 | [37349786354](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/actions/runs/37349786354) 十個案例通過 | A 合入臨時 base |
| A＋B：`d823cc8e` | [37349789893](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/actions/runs/37349789893) 通過 | [37349789840](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/actions/runs/37349789840) 在 `candidate-data` 明確 behavior mismatch | B 被移出，未合併 |
| 後續 C：`5574d679` | [37350350817](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/actions/runs/37350350817) 通過 | [37350351136](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/actions/runs/37350351136) 十個案例通過 | [C／#21](https://github.com/FreeTWAI-AI/FreeTWAI-AI.github.io/pull/21) 從 queue 合入臨時 base |

GitHub 的 `RemovedFromMergeQueueEvent` 對 B 回報 `failed_checks`，`beforeCommit`
為完整 `d823cc8e14c1192a16d8801f5e89cea5413ed9df`，與失敗 native run／Git tree 相同。
後續 C 從 A 已合併的 base 開始，在自己的 PR 與新 queue head 各完成固定驗證，證明
拒絕 B 後 queue 可繼續工作。六個 PR jobs 與六個 queue jobs 均核對 App15368、
workflow source、candidate commit/tree、run attempt 及清理；未取消、rerun 或偽造綠燈。
完整非秘密紀錄見[queue 聚合證據](../../verification/directory-merge-queue-2026-10-05.json)。

所有 probe PR 已結束，四個自有分支、GitHub 管理的臨時 queue refs 與兩個臨時規則
均已清理。四個正式規則24469536／24473806／24476100／24516222 保留原配置，目錄站
main 維持e888；沒有 Pages 部署，也沒有替正式 main 啟用 queue。

這次只驗收同倉目錄站臨時 queue 的整合正反例與後續成功；其他 consumers 的
merge queue、fork／supersession、任意輸入、內部 library invocation 與獨立 App
publisher 的 durable replay／unknown ACK 仍未驗收。合成 A 能通過有限案例也說明
runtime profile 有明確輸入界線，不能把通過十個案例寫成任意行為均安全。

## 10 月 6 日：中央 required workflow 升級至 d1c9（選中的部署 preflight）

中央 ruleset **`24469536`** 於 2026-10-06 16:57:40 UTC 將 `.github/workflows/verify.yml`
的固定 SHA 從 `c3e5a537a75303c4688e01b7f0d8477c3587a26f` 更新為
**`d1c9e18fffabebbdceaba233a34f3605220e2dd7`**，即 [#167](https://github.com/FreeTWAI-AI/freedom-platform/pull/167)
合併後的 main commit。PUT 前回讀與 10 月 5 日紀錄完全相同；fresh readback 確認唯一政策變更是
`/rules/3/parameters/workflows/0/sha`。main 範圍、active、空 bypass、`verify@15368`／`CodeQL@57789`、
strict freshness、一位 reviewer、last-push approval、stale review 失效與禁止刪除／force push 均保留。
d1c9 帶入 [#130](https://github.com/FreeTWAI-AI/freedom-platform/pull/130)：選中的 `deploy-preflight`
列入 `verify.needs` 並由 aggregate 強制；另含前端 leaf profiles，以及 preflight 對隔離 PostgreSQL
執行兩個 migration 入口。完整非秘密配置、probe run／job、rule suite 與清理紀錄見
[10 月 6 日 main ruleset 與 probes](../../verification/main-ruleset-2026-10-06.json)。

切換 main 前，先在三個一次性 base（`ops/trust-pin-d1c9-base`／`-empty-base`／`-reopen-base`，
後綴 `-20261006`）安裝臨時 org rules `24592769`／`24593147`。兩條規則與 main 的差別只有：只要求
`verify@15368`、不要求 CodeQL，review count 為 0。兩者先固定 c3e，再只改 workflow SHA 為 d1c9。

| Probe | 實際結果 |
| --- | --- |
| [#168 S](https://github.com/FreeTWAI-AI/freedom-platform/pull/168) | c3e 下 run 成功後，臨時規則換成 d1c9；以舊綠燈 merge 回 405，rule suite `4389941231` 為 required workflow 未滿足。新 head 的 d1c9 run 成功後才 merge（`4389982354`）。 |
| [#174 R](https://github.com/FreeTWAI-AI/freedom-platform/pull/174) | 同樣先有 c3e 綠燈，換 pin 後 merge 405（`4390093276`）。不 push，只 close／reopen，同一 head 取得 d1c9 新 run 後 merge（`4390128413`）。 |
| [#173 N2](https://github.com/FreeTWAI-AI/freedom-platform/pull/173) | base 前進後，同一 head 雖有 d1c9 綠燈，strict freshness 仍回 405「Required status check "verify" is expected」，workflows rule 本身 pass（`4390372841`）。`update-branch` 產生新 integration candidate `da921194`，新 run 成功後才 merge（`4390428231`）。 |
| [#170 H](https://github.com/FreeTWAI-AI/freedom-platform/pull/170) | H2 竄改生成 metadata／bundle／inventory，並加入 job 名為 `verify` 的候選 workflow。操作者另發布 `verify`／`CodeQL` success status，候選 workflow 也以同一 App `15368` 發布成功的 `verify` check。固定 workflow 在 `source-integrity` 失敗，merge 405（`4390392254`）；指名舊 H1 head 的 merge 回 409。 |
| [#172 F](https://github.com/FreeTWAI-AI/freedom-platform/pull/172) | Fork 讓 selector 回 docs、把 `verify.yml` 換成 echo 並竄改契約；固定 workflow 仍完整執行並在 `source-integrity` 失敗，merge 405（`4390394090`）。 |
| [#177 F2](https://github.com/FreeTWAI-AI/freedom-platform/pull/177) | Hostile fork 在 `test:governance` 開頭執行探測。抽出的 jobs 均只有 Contents／Metadata read token、Secret source None；候選程序環境沒有 Cloudflare、R2、AWS、OpenRouter、signing、`GITHUB_TOKEN`／`GH_TOKEN` 或 OIDC 變數。Checkout 保留唯讀 job token，用它 push 新分支被拒（permission denied），目標 ref 不存在。關閉且未 merge。 |
| [#176 P](https://github.com/FreeTWAI-AI/freedom-platform/pull/176) | 只讓選中的 `deploy-preflight` 失敗，其餘 jobs 成功；aggregate 回 `selected_job_not_success`，merge 405（`4390704528`）。 |
| [#171 E](https://github.com/FreeTWAI-AI/freedom-platform/pull/171) | 候選把 `test:governance` 改成不匹配任何檔案的 glob：`source-integrity` 與 `governance-consumers` 跑 0 tests，verify 仍 success，並實際 merge 到一次性 base（`4390406135`）。**這是已觀察的缺口，d1c9 沒有修正。** |
| [#169 N1](https://github.com/FreeTWAI-AI/freedom-platform/pull/169) | 被合併衝突先擋下（405），遮蔽 strict freshness；不計入，N2 才是 freshness 案例。 |

切換後再以 main 為目標：

| Probe | 實際結果 |
| --- | --- |
| [#178 MP](https://github.com/FreeTWAI-AI/freedom-platform/pull/178) | 只新增一份合成文件並更新 inventory（`changed_files` 兩項）；[run 37499846392](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37499846392) 由 d1c9 執行並成功，`verify@15368` 與 `CodeQL@57789` 均 success；0 approval，GitHub 回報 blocked。只驗 green，關閉且未 merge。 |
| [#179 MN](https://github.com/FreeTWAI-AI/freedom-platform/pull/179) | 只新增一份合成文件，故意不更新 inventory（`changed_files` 一項）；[run 37499843838](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37499843838) 在 `source-integrity` 失敗，aggregate 回 `source_integrity_not_success`。實際 merge 405，rule suite `4390763223` 同時列出 verify 失敗、required workflow 失敗與缺少非 last pusher 的 approval；main 維持 d1c9。 |

所有 probe PR 已關閉：#178／#179 於 17:01:32 UTC 關閉且未 merge，並刪除 head refs（`main_probes[].closure`），其餘九個列於 `cleanup.pull_requests`。兩條臨時規則先刪除，回讀確認已不存在，再刪除 12 個 probe refs（含 fork 的兩個分支）；
main ruleset 在清理後回讀，與切換後完全相同。操作者私有 journal `freedom-trust-pin-d1c9-20261006`
保存 API receipts、logs 與規則前後配置；公開 JSON 只含配置、run／job、rule suite、HTTP 結果與邊界。
探測用 fork `teddashh/freedom-platform` 仍保留：操作者 token 沒有 `delete_repo` scope，需由擁有者手動刪除。

過程中有一次操作失誤：本機試跑 F2 探測腳本時，腳本以操作者 git 憑證實際 push 了
`ops/trust-pin-d1c9-fork-push-probe-20261006`，指向已審查的 d1c9 main commit。該 ref 立即經 API
刪除並回讀為 Not Found，沒有產生 workflow run 或 rule suite，也不計入證據。此後會嘗試 push 的探測只在
hosted fork job 執行。

本次升級仍不涵蓋：

- E 證明候選可控的 npm scripts 能讓選中的 suite 跑 0 tests，而 aggregate 仍成功。Pin 只固定
  selector／aggregate 的位元組，不固定它們包住的指令；候選 checkout 的 suites 仍不是獨立可信 harness。
- P 只驗到選中 job **失敗**；選中 job 被 skipped／cancelled 的 hosted 反例未在 d1c9 上單獨執行。
- F2 只檢查程序環境變數，以及用保留的 job token push；未探測 runner metadata、其他 workflows
  或每個 job。`persist-credentials` 維持預設時，唯讀 job token 仍可被候選程式讀到。
- 臨時規則為 0 approval、無 CodeQL；main 仍要求一位 reviewer、last-push approval 與 `CodeQL@57789`。
- 中央 main 沒有 merge queue，只靠 strict freshness 加 `update-branch`。durable App publisher 未安裝，
  完整 P2 未完成。consumer rules `24473806`／`24476100`／`24516222` 與目錄站 queue 本次均未改動。
