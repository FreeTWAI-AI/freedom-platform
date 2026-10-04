# 中央 main 的實際治理門檻（2026-10-04）

這份紀錄接續 [P2](post-migration-plan-2026-10-04.md)。本輪在 GitHub Enterprise organization 安裝原生 required workflow，並實際測試正常及竄改 PR。`freedom-platform:main` 現在受保護；其他 repositories、完整可信 harness、實際 library usage 與所有入口覆蓋仍未驗收，不能把本輪當作整個 P2 完成。

實際回讀的非秘密[配置 artifact](../../verification/main-ruleset-2026-10-04.json)隨本紀錄提交。

## 已安裝配置

- Organization：`FreeTWAI-AI`；repository ID：`1378081342`；僅 `refs/heads/main`。
- Ruleset：`24469536`，`Freedom platform pinned verification`，active，無 bypass actor。
- Required workflow：本倉 `.github/workflows/verify.yml`，固定 `d269a8d7605630cab1da605d7cac4d0c254e3258`；候選 PR 修改 workflow 不改變 required workflow 的來源。
- Required status checks：`verify` 綁定 GitHub Actions App `15368`；`CodeQL` 綁定 GitHub Advanced Security App `57789`。strict base freshness 開啟。
- 必須走 PR；至少一位 reviewer、last-push approval、舊 approval 在新 push 後失效、review thread 必須解決；禁止 force push 與 branch deletion。
- GitHub 回讀另帶 `require_extra_approval_for_unattributed_changes=true` 及空 `required_reviewers`；保留服務端預設，不視為可忽略 drift。實際 `branches/main` 回報 `protected=true`，effective rules 同時含 workflow 與 App-bound checks。

本輪沒有合併任何產品 PR，也沒有改 main commit。安裝前後均為 `d269a8d7605630cab1da605d7cac4d0c254e3258`。PR #111／#112／#113 仍走正常 review 與 merge，不使用 bypass。已開 PR 若缺新規則要求的 workflow run，須觸發符合規則的新候選驗證，舊綠燈不能冒充新 required workflow。

## 真實正反例

測試使用一次性 `ops/governance-acceptance-base-20261004`，從同一 main SHA 建立；永不把故意破壞的 fixture 指向 main。先對此 branch 安裝相同 pinned workflow／verify App-source 規則，再依下列實測結果套用正式 main 配置。

| 案例 | 實際結果 |
| --- | --- |
| [#114 正例](https://github.com/FreeTWAI-AI/freedom-platform/pull/114) | 只加合成文件及正確 inventory，app／contract／workflow 不變；[run 37236090337](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37236090337) 全部 10 jobs success。API 實際接受 merge 到一次性 branch，merge SHA `7dc328dd066229b6bca25db72bd7c6a6e0843526`；main 不變。 |
| [#115 竄改契約與 workflow](https://github.com/FreeTWAI-AI/freedom-platform/pull/115) | 改生成 metadata 的 `external_job_execution`，同步偽造 bundle／inventory hash，並把候選 workflow 換成單一 echo-success。GitHub 仍執行固定來源的 [run 37236094413](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37236094413)；canonical contract rebuild／diff 在 `static-worker` 真正失敗。 |
| #115 同名成功 status 偽造 | 只在此測試 head 以目前使用者發布 `verify`／`CodeQL` success status。第一次實際 merge API 回 405，指明 check 不是預期 GitHub App 發出；沒有 merge。 |
| #115 失敗 workflow 拒絕 | 決定性失敗已取得後，取消其剩餘耗時 jobs；再試 merge 回 405，指出 `verify`／required workflow 失敗。此 run 最終為 cancelled，不宣稱整套負例測試全部跑完。 |

一次性 branch 起初也要求 `CodeQL`，但該新 branch 未取得 default-setup 的 CodeQL check。為讓 workflow 正例能實際完成，只在一次性 branch 移除此項；main 的正式配置仍要求 `CodeQL@57789`，既有正常產品 PR 已實際取得該 App 的成功結果。這次正例不能用來宣稱在 probe 上驗過 CodeQL gate。Probe 的 review count 是 0；正式 main 為 1，本輪不宣稱已完成真人 reviewer 資格的完整負例。

測試後 #115 關閉且未 merge，#114 只 merge 到一次性 branch，三個自建 probe branches 已刪除。原始 API receipts、run/job 身分、失敗 logs 與安裝前後配置保存在操作者私有 journal `freedom-governance-enforcement-20261004`；公開 PR 保留可核對的合成測試歷史，不公開憑證或會員資料。

## 仍須完成

固定 YAML 阻止候選 PR 任意替換該 required workflow，但目前 workflow 仍會執行候選 checkout 的 build/test/scripts。因此它不等同 [治理規格](01-contracts-and-governance.md)要求的獨立可信 suite registry、不可竄改反例 harness 與完整 report publisher。`publisher_trust`／`library_usage` 不因本次安裝就改標 PASS。

後續沿既有 P2 完成：可信 harness 與證據來源、漏登入口／候選刪測試等反例、consumer 的實際 library resolution／operation 使用、精確授權版本的跨倉同步，以及必要的 merge-group／撤銷／未知 ACK 驗收。原生 required workflow 是目前 Enterprise 能力下的既有規格路徑；若將來改方案，必須先建立等效的可信 App-bound publisher，不直接移除門檻。

Workflow SHA 更新須審查新固定來源及重新驗證，不隨 main 自動移動。配置回讀和 probe 結果只證明本文件明列的 repository／branch／版本範圍。


## 九個 consumer 的當前唯讀盤點

在中央 main 安裝後另向 GitHub 讀回 integration lock 所列九個 repo 的 default branch、contract lock 與含父層 rulesets。沒有修改這些 repo 或建立跨倉 upgrade PR。

| Repo | 實際 main head | protected | rulesets 數 |
| --- | --- | --- | --- |
| `FreeTWAI-AI/.github` | `9c8f3b62e2ed3f7f585abcc4d63112c4516c9515` | false | 0 |
| `FreeTWAI-AI/FreeTWAI-AI.github.io` | `90f790763f4f0507d123f325d194d2cf7b9bf73f` | false | 0 |
| `FreeTWAI-AI/freedom-agent-kit` | `201fdab8017e2850bafc7b2f1e8dec7e4c0d6233` | false | 0 |
| `FreeTWAI-AI/freedom-growth-automation` | `d1fd7f223efcbed85c95cda18734a33e6528b82a` | false | 0 |
| `FreeTWAI-AI/freedom-project-page` | `05508e805a764ec6b681792aaaf8c4803cb7a592` | false | 0 |
| `FreeTWAI-AI/freedom-project-template` | `9bc7cee3f98d21da3156e5a67bfa63dc63a4615e` | false | 0 |
| `FreeTWAI-AI/freedom-skill-registry` | `b5aed63bdd40d6c72df2afe039677d2173a2e3f9` | false | 0 |
| `FreeTWAI-AI/freedom-storefront` | `9823df79f8eee86008c269437880ed2e49bdc394` | false | 0 |
| `FreeTWAI-AI/freedom-supplier-client` | `53fd5b0ac4a1b67ccd71a8cc4ba092ea15bb3534` | false | 0 |

九個 `contracts.lock.json` 都仍指向 `b221d2ba1bcf014dc785e95212455ba6f157ec6d` 的 `freedom.preview/v1`。但它們的 bundle SHA-256 **與 d269 main 的 preview bundle 完全相同**：`835e9a898d3c10eaabd16c92cfeb25eae050f658814da3aec055f019a7245d3d`。因此不能僅因舊 source pin 就宣稱現有 preview wire contract 已 drift，也不能把單純改 pin 當成新 execution／governance 接入。

這九倉尚未受本輪 main ruleset 範圍強制，`libraryUsage=not_checked`。既有 export 入口能分發 preview contract 與 portable tooling，仍不能證明所有 consumer 真正 import／呼叫了新共用 library。下一批必須先產出各 repo 的 profile／入口／實際 imports 差異、目標 ReleaseSet／tooling 版本與相容測試，再沿精確版本批次流程接入。不得把中央 monorepo 的 full verify workflow 原樣強制到不同結構的 consumer，造成所有正常 PR 永久失敗。
