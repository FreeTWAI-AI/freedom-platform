# 本次文件驗證與未執行範圍

日期2026-10-05，base source `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`。這份文件記錄spec PR的靜態驗證，**不是60項新產品案例或168項foundation需求的執行報告**。所有T-001–060維持not_run且evidence空。

## 已執行

| 檢查 | 結果及界線 |
| --- | --- |
| 原主稿/JSON對帳 | 完整1,251行主稿與原requirements/source JSON核對；22D、64R、60T、13SP、67 R↔T邊、chapter/D mappings與27 S/W來源一致。source hashes見sources.md |
| `python3 docs/platform-plan/execution/guild-launchpad/validate-spec-pack.py` | 檢查原語意digest、固定ID集、雙向edges、所有實際existing_files、原ledger ID、13份各十章、local file links、not_run/empty evidence。22D/64R/60T/13SP/67邊、182個本地連結，零失敗；最終tree更動後已重跑，不作runtime證據 |
| `npm run test:contracts`（隔離Python環境） | 671 passed、4 skipped。四項為既有 `test_five_clock_invariants.py` 的 `clock has fewer than 3 schema paths` 條件跳過；未改測試或跳過條件 |
| Source/ERP file review | 中央identity/scopes/commands/commerce/Work/Asset/governance與ERP實際source核對；KEEP/MODIFY paths存在。ERP MIT/NOTICE固定版本，無code copy |
| 跨spec review | 審查發現inventory API、Work upload DTO、module/control-plane event、capability grammar、operation route與backup pause釋放的矛盾；在本PR內統一canonical責任並重查。這是文件/來源審查，非執行安全驗收 |

第一次執行contracts時環境缺pytest，已依repo的 `docs/platform-plan/contracts/tests/requirements-static.txt` 在隔離環境安裝其固定版本，再用相同npm命令成功執行。撰寫途中validator曾因尚未完成的文件/link拒絕；不是隱藏通過或放寬規則。

另以六項負向控制核對validator：缺R、重複D、偽造產品PASS、不存在current path、反向edge錯誤及臆造ledger ID，全數拒絕。這只證明文件工具的此範圍，不是trusted runtime gate。

## 交付前最後檢查

- `git diff --check`（含staged新文件）
- `python3 docs/platform-plan/execution/guild-launchpad/validate-spec-pack.py`
- `python3 scripts/update-inventory.py`，接著 `npm run verify:inventory`：3764個檔案hash、1349個全repo相對檔案/目錄連結，零失敗；不核section anchors/外部URL/runtime
- 變更檔案只在docs/platform-plan，含read-only planning validator及生成inventory；runtime/schema SQL/SDK/flags/workflows皆未修改
- 掃公開內容沒有raw chat、私人取檔連結、secret、customer資料或原始備份
- GitHub發布後讀回exact commit/tree/head；所有blob內容/本地Git tree與遠端一致才宣稱已發布

最終PR/head及hosted CI是GitHub實際紀錄；本文件不預填尚未發生的checks。草案PR不代表已核准、可merge或已部署；本任務不merge/enable auto-merge/部署/改rules。

## 未執行

- T-001–T-060所有未來產品驗收、真tenant/service scope、hosted/external module API、單模組migration、所有私有default workflows
- 本輪typecheck/build/runtime test/E2E、真PostgreSQL/R2/Cloudflare/provider/私人AI/正式member資料操作。純spec無runtime變更，沒有以文件檢查冒充這些流程
- 新quota/retention/pricing/SLA政策批准、授權release/跨repo SDK採用、原ledger其餘未完成條件
- 原對話session完整逐則重讀、原ZIP的AGENT-START-HERE及SHA256SUMS核對；主稿§24和另附原JSON已完整承接

後续實作應在每個T-ID附其自己的source/environment/命令/結果/證據，不能引用此處671個靜態contract測試當新功能通過。
