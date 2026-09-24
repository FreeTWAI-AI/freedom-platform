# 技能書編輯的公會資格

站內技能書介紹與任務編輯（`GET/POST /api/v1/skill-books/:id/editor`）需要**同時**符合兩個條件，缺一就拒絕：

1. 管理員已任命這位會員維護這本書（`skill_book_maintainers.active`）。
2. 這位會員**目前**是「AI 開發公會 `guild_ai_vibe`」或「AI 導入與驗證公會 `guild_ai_field`」其中之一的 active 成員。

公會清單放在 `modules/development-access/guild-eligibility.ts` 的 `developmentGuilds.skill`，和開發提案授權用同一份常數；`modules/development-access/service.ts` 仍重新匯出 `developmentGuilds` 與 `Capability`，舊的 import 不用改。

## 不會做的事

- 任命維護者**不會**替會員加入公會，也不會讓整個公會的成員都能編輯。
- 加入 AI 公會本身不給任何書的編輯權。
- 編輯器不使用 GitHub App 的 metadata 或提案 token，也不改 GitHub 上的權限。
- 公開閱讀、公會公告、公會長議事區、`skill.submit` 投稿都不受這條規則影響。

## 離開與重新加入

- 兩個 AI 公會都有加入時，離開其中一個仍可編輯；離開最後一個後，編輯器 GET、POST 以及用舊 Idempotency-Key 重送的 POST 都回 `403 skill_editor_guild_required`。
- 重新加入任一 AI 公會後，**原本的具名任命**恢復作用。已經被 `guild_eligibility_lost` 撤銷的開發授權（`development_grants`）與開發憑證（`development_keys`）不會因此恢復，要照開發協作流程重新啟用。

## 鎖定順序

`activeDevelopmentGuilds()` 會先拿 `lockMemberGuilds()` 的 advisory lock（和加入／離開公會用的是同一把鎖），再讀 active membership。整體順序和 `command()` 一樣：users → sessions → idempotency advisory lock → guild-member advisory lock → 資料列。

- 離開公會的交易先 commit，之後等到鎖的儲存請求會看到 `left`，因此拒絕。
- 儲存請求先拿到公會鎖，就會完整跑完並 commit；之後才輪到離開公會，下一次編輯就會被拒絕。

`command()` 在 replay 時也會重跑 authorize callback，所以存下的 receipt 繞不過離開公會這件事。

### `GET /api/v1/guild-workspace` 的鎖定順序

`guildWorkspace()` 的順序是：`activeMember()`（users → sessions，`FOR SHARE`）→ `activeDevelopmentGuilds()`（guild-member advisory lock → AI 公會 membership `FOR SHARE`）→ `managedGuilds()`（`FOR SHARE OF m,o`，membership 與 officer 資料列）。

公會長清單一定要排在 advisory lock **之後**。離開公會的交易是先拿 advisory lock、再 `FOR UPDATE` 更新 membership；如果讀取端先用 `managedGuilds()` 對 membership 拿了 `FOR SHARE`，再去等 advisory lock，兩邊會互等而觸發 deadlock（稽核時發現的回歸）。調整後讀取端等鎖時不持有任何 membership／officer 資料列，離開公會 commit 後才讀，看到的是已 commit 的狀態。

### 測試證據

`tests/runtime/guild-workspace.test.ts` 用真實 PostgreSQL 與 `pg_stat_activity` 等待事件做 barrier，不靠 sleep：

- `race: a leave that commits first makes a save waiting on the guild lock fail`：離開先拿公會鎖，儲存等在 advisory lock，最後被拒絕、沒有寫入。
- `race: a save that already holds the guild lock completes before a concurrent leave, which then denies further edits`：儲存先拿公會鎖，完整 commit；離開完成後再編輯被拒絕。
- `race: workspace GET waits on the guild lock of an AI guild officer leaving, without holding membership rows, then reflects the leave`：會員同時是 `guild_ai_field` 公會長與技能書維護者。離開公會拿到 advisory lock 後被測試持有的 `FOR KEY SHARE` 擋在 membership `FOR UPDATE`；workspace GET 等在 advisory lock，`pg_blocking_pids` 只有離開公會的 backend，另一個連線可以 `FOR UPDATE NOWAIT` 鎖住 officer 資料列（證明讀取端沒拿資料列鎖）。放行後兩邊都成功，GET 回傳 `managed_guilds: []`、`can_discuss: false`、`managed_books: []`、`skill_editor_access.requires_development_guild: true`。舊順序下讀取端會先鎖 membership／officer，這個測試會失敗（`NOWAIT` 拿不到鎖，或 deadlock）。

## `GET /api/v1/guild-workspace` DTO（新增欄位，舊欄位不變）

```ts
{
  managed_guilds: {guild_key:string;name:string}[];
  managed_books: {book_id:string;title:string}[]; // 只有 skill_editor_access.eligible 時才列出
  can_discuss: boolean;
  skill_editor_access: {
    appointed_books: number;             // 目前有效的具名任命數，不管公會資格
    eligible: boolean;                   // 目前至少在一個必要 AI 公會
    requires_development_guild: boolean; // appointed_books>0 && !eligible：前端要顯示加入公會的路徑
    active_guilds: string[];             // 目前加入的必要 AI 公會 key
    required_guilds: {guild_key:string;name:string}[]; // 可以加入的 AI 公會（名稱來自 catalog）
  };
}
```

這個結構固定不變：沒有任命的會員也會拿到整個 `skill_editor_access` 物件，前端不用處理欄位缺少的情況。

### 前端行為（`apps/portal-web/src/modules/GuildWorkspace.tsx`）

已在程式實作，本輪尚未部署；E2E 由 coordinator 統一 build 後執行。

- `Workspace` 型別的 `skill_editor_access` 是選填欄位，舊的 mock／回應沒有這個欄位時照舊以 `managed_books` 判斷。
- `requires_development_guild === true`：公會管理頁顯示「已被任命維護 N 本技能書，加入「AI 導入與驗證公會」或「AI 開發公會」即可編輯。」（名稱取自 `required_guilds`），附「前往職業公會」連結（`#guilds`）與「重新核對管理權限」按鈕。不會顯示「目前沒有公會或技能書的管理職務」，也不會自動送出任何加入公會的請求。同一位會員的公會公告與公會長議事區照常可用，提示放在分頁上方。
- 編輯器 GET／POST 回 `403 skill_editor_guild_required`（以 `ApiError.code` 判斷，不比對訊息字串）：表單停用但**保留尚未保存的草稿**，顯示同一段提示；有草稿時改成「在新分頁前往職業公會 ↗」，避免切頁丟掉草稿。父層同時重新讀取 `/guild-workspace`。
- 重新核對只有在 `/guild-workspace` 成功回應且 `requires_development_guild` 為 false 時才解除鎖定；讀取失敗會在提示內顯示錯誤、保存鈕維持停用，不會沿用舊的可寫狀態。解除後草稿仍在，提示再按保存；原本沒載入成功的編輯器會重新讀取。鎖定期間視窗重新取得焦點、或同分頁觸發 `freedom-profile-updated`（加入／離開公會）時也會自動重新核對。
- `403 skill_maintainer_required` 等其他錯誤維持原本的錯誤訊息，不顯示加入公會的提示。
- 側欄「公會管理」入口是否在 `requires_development_guild` 時出現，由 `App.tsx` 的 `canManageGuild` 負責，不在這個模組內。

合成路由的瀏覽器測試在 `tests/e2e/skill-editor-guild-access.spec.ts`（桌機與 390px 手機）。
