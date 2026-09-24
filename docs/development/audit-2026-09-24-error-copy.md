# 2026-09-24 錯誤訊息文案稽核

## 問題

後端 Problem 的 `title` 有時直接等於機器代碼，前端 `messageFromProblem` 把它和 `detail` 拼起來，會員看到：

```
skill_maintainer_required：此操作限目前 AI 公會的技能書維護者。
```

## 修改

`apps/portal-web/src/api.ts` 的 `messageFromProblem`：

- `title` 等於 `problem.code`，或是明顯的 snake_case 機器代碼時，不顯示在訊息裡；有 `detail` 就只顯示 `detail`，沒有則沿用現有的狀態碼 fallback。
- `title` 與 `detail` 相同時只顯示一次。
- 可讀的人類標題照舊顯示成 `標題：說明`。
- 沒改：`ApiError` 的 `code`／`title`／`type`／`detail`、5xx 遮蔽、401 處理、網路／逾時與 CSRF 流程。

## 回歸測試

`tests/runtime/portal-client-recovery.test.ts` 新增一個 fetch mock 案例，檢查：

- 403 `skill_maintainer_required`：訊息只有中文 detail，`cause.code`／`title`／`type` 保留，UI 仍可依 code 恢復。
- 代碼式 title 與不同的 code：同樣隱藏。
- 代碼式 title 且沒有 detail：403 與 422 都走狀態碼 fallback。
- title 與 detail 相同：只顯示一次。
- 可讀的 title 加 detail：保留 `版本已變更：請重新讀取後再送出。`
- 500：仍遮蔽成 `服務暫時無法回應（500）…`，不暴露 code／detail。

## 實跑結果（2026-09-24）

| 命令 | 結果 |
| --- | --- |
| `npx tsx --test --test-concurrency=1 tests/runtime/portal-client-recovery.test.ts` | 14 項通過，0 項失敗 |
| `npm run typecheck` | 通過，exit 0 |

`not_run`：`npm run build`、瀏覽器／e2e。本輪依指示不跑，由 root 統一執行。
