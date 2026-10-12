# 作品與開源分享區塊

[共同開發入口](../../packages/guild-presentation/README.md)包含預覽與 PR 流程。
`WorksBlock.tsx` 讀取既有 `/me/content` 的授權投影，只顯示作品與技能投稿。
原領域保有草稿、可見範圍、發布、撤下與審查責任；沒有統一發布資料表。
一般作品可從「我的內容」管理，技能投稿保留單獨入口與既有發布條件。

訪客不讀私人內容；區塊不公開會員的草稿。正式會員可前往既有投稿入口，
唯讀呈現不替人發布。未知狀態如實保留 API 值，不冒稱審查或收錄完成。

日常修改限自己的元件與 `WorksBlock.spec.ts`。在根目錄執行
`npm run guild:preview`，以及 `npm run guild:test -- modules/guild-open-source`。
範例資料明示為合成作品，不表示真實作者同意或會員採用。
