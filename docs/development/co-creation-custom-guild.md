# 共創專案接受管理員核准的自訂公會

> 分階段證據；最終合併與完整回歸見 [整合總報告](./audit-2026-09-24.md)。

## 範圍

以 `b505229` 建立的獨立 worktree（分支 `audit/co-creation-custom-guild-20260924`）。只修改 `modules/co-creation/service.ts`、`tests/runtime/co-creation.test.ts` 與本文件。未部署、未推送，沒有連線到正式或 staging 服務，也沒有對 GitHub 或其他 provider 發出真實請求（GitHub 讀取全部使用測試 fixture）。

## 問題

管理員核准公會申請時，`modules/platform-admin/service.ts:92` 產生的標準 key 是 `'guild_custom_'+id.replaceAll('-','')`，也就是 `guild_custom_` 加上 32 個十六進位字元的申請 UUID。`id` 是核准請求傳入的值：`z.uuid()` 接受大寫，PostgreSQL 的 uuid 比對也不分大小寫，所以用大寫 UUID 核准是有效流程，產生的 key 會是大寫十六進位。`listCoCreationGuilds` 會回傳目錄中的所有 key，UI 也全部列出；但 `createInput` 的 `/^guild_[a-z_]+$/` 不接受數字，所以選了已核准的自訂公會後，`POST /co-creation/projects` 會回傳 422 `validation_failed`。

## 修正

`modules/co-creation/service.ts` 改用 `/^guild_(?:[a-z_]+|custom_[0-9a-fA-F]{32})$/`：

- 內建 key 的格式不變；只多接受核准流程實際產生的自訂 key 格式（`custom_` 加上正好 32 個大寫或小寫十六進位字元），不接受任意英數 key。
- 仍然要在 `positioning_guild_catalog` 以完全相同的字串查到才算有效；格式像自訂 key、但目錄中沒有的 key（包括已核准 key 換成另一種大小寫）會回傳 422 `invalid_guild`。
- 不可重複、最多 5 個、作品擁有者檢查、session／CSRF／idempotency 與 journal 都沒有改動。

## 回歸測試

`tests/runtime/co-creation.test.ts` 新增一個參數化案例（核准時傳入小寫、大寫申請 UUID 各跑一次），在隔離的 PostgreSQL schema 中呼叫實際的 `reviewGuildApplication`（使用真的 `platform_admins` 與 `guild_creation_applications` 資料列，沒有直接寫入目錄）產生已核准公會，接著驗證：

- 產生的 key 等於 `guild_custom_<傳入的申請 UUID 去掉連字號>`，大小寫與傳入值相同。
- `GET /co-creation/projects` 的 `guilds` 包含這個 key 與公會名稱，也實際包含測試使用的 5 個內建 key。
- 作品擁有者用 `['guild_ai_vibe', <custom>]` 建立專案時回傳 201；`co_creation_project_guilds` 讀回相同的 key；另一位會員看到的清單中，含此 key 的專案只有這一個（UI 的公會篩選就是比對這個欄位；API 本身沒有公會篩選參數）。
- 使用第二件作品測試拒絕情境：格式像自訂 key 但不存在（與該輪同樣的大小寫），回傳 422 `invalid_guild`；已核准 key 換成另一種大小寫，回傳 422 `invalid_guild`；重複 key 回傳 422；5 個內建 key 加上自訂 key 共 6 個有效目錄 key，回傳 422，錯誤只在 `guild_keys` 層級（不是單一元素的格式錯誤）；使用別人的作品回傳 404；拒絕後專案數仍為 1。

## 實跑結果

| 階段 | 命令 | 結果 | 原始輸出 |
| --- | --- | --- | --- |
| 第一輪修正前 | `npx tsx --test --test-concurrency=1 tests/runtime/co-creation.test.ts` | 13 tests，12 pass，1 fail：新案例回傳 422 `guild_keys.1: Invalid string: must match pattern /^guild_[a-z_]+$/` | `/tmp/freedom-custom-guild-before.log` |
| 第一輪修正後 | `npx tsx --test --test-concurrency=1 tests/runtime/platform-admin.test.ts` | 18 tests，18 pass，0 fail（之後沒有修改 platform-admin 程式，未重跑） | `/tmp/freedom-custom-guild-after.log` |
| 大寫修正前（只接受小寫的版本） | `npx tsx --test --test-concurrency=1 tests/runtime/co-creation.test.ts` | 14 tests，13 pass，1 fail：小寫案例通過；大寫案例回傳 422 `guild_keys.1: Invalid string: must match pattern /^guild_(?:[a-z_]+\|custom_[0-9a-f]{32})$/` | `/tmp/freedom-custom-guild-case-before.log` |
| 大寫修正後 | `npm run typecheck` | exit 0 | `/tmp/freedom-custom-guild-case-after.log` |
| 大寫修正後 | `npx tsx --test --test-concurrency=1 tests/runtime/co-creation.test.ts` | 14 tests，14 pass，0 fail | 同上 |

大寫修正前的紀錄是在加上「另一種大小寫被拒絕」斷言之前跑的；該案例在更早的格式檢查就失敗，沒有執行到那一步。

最終 review 讓合成申請 UUID 必定包含一個十六進位字母，避免隨機 UUID 全為數字時大小寫案例偶發相同；相同定向測試再次 14／14 通過，輸出 `/tmp/freedom-custom-guild-final.log`。兩輪實際 Claude CLI 的 JSON（`/tmp/freedom-custom-guild-{fix,case}-claude.json`）均回報 `canonicalModel: claude-opus-5-5`、`provider: firstParty`。

`not_run`：完整 `npm test`、`npm run build`、E2E、contracts。原因是沒有修改 UI 或跨模組契約，由整合端統一執行。

## 範圍外（未修改）

`modules/identity-membership/members.ts:131` 與 `modules/platform-admin/guild-experts.ts:10` 的會員相關 key 格式檢查仍只接受小寫字母、數字及底線，不屬於本次範圍，由對應模組處理。
