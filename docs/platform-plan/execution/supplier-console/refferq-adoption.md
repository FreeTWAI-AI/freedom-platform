# Refferq 採用界線

來源固定為 `Refferq/Refferq@25df6596a15cf1e9d26021752137d66c22dd8e34`（MIT，Copyright (c) 2025 Refferq）。本輪是靜態閱讀，沒有安裝、執行或測試 Refferq；結論不是安全評等。Supplier Console R1 **不複製 Refferq 原始碼、圖示、字型或品牌素材**，只採用資訊架構與操作模式，並以平台既有元件與 `DESIGN.md` token 重新實作。

## 採用什麼

| Refferq 來源 | 學到的模式 | Freedom 做法 | 頁面 |
| --- | --- | --- | --- |
| `src/app/admin/layout.tsx:52-75`、`src/app/affiliate/layout.tsx:52-63` | 依角色分組的固定側欄；首頁精確比對、子頁前綴比對 | 沿用公會啟動台已上線的「桌面固定側列＋手機同一份選單」（`GuildLaunchpad.css`），群組為營運／合作／管理；目前頁以 `aria-current="page"` 與粗體底線標示 | SC-01～11 |
| `src/app/admin/page.tsx:230-255` | 指標卡＋快速動作 | 四個營運指標都來自同一次伺服器讀取，附資料時間與可回查清單；無資料時說明原因，不顯示 0 | SC-03 |
| `src/app/admin/partners/page.tsx`、`[id]/page.tsx` | 清單分狀態、詳細頁分區 | 合作店家以穩定店 ID 分組；詳細頁只呈現「這間店與我」的合作 | SC-06 |
| `src/app/admin/customers/page.tsx:99-116` | 逐筆核准／拒絕 | 同意綁定精確 `listing_sha256` 與版本；R1 不做批次同意 | SC-07 |
| `src/app/affiliate/resources/page.tsx:180-230` | 素材卡片格線、格式標籤 | 只在素材 API 與授權完成後使用；下載走當前授權讀取 | SC-09／12 |
| `src/app/admin/reports/page.tsx` | 期間篩選＋匯出 | 只有可回查的營運數量；匯出另依 SC-SPEC-04 限制欄位、列數與 CSV 公式前綴 | SC-10 |
| `src/app/admin/settings/page.tsx:100-150` | 分卡設定表單 | 事業資訊、預留設定、團隊入口分區；能保存的欄位才可編輯 | SC-11 |

## 不採用什麼

| 現象（固定來源） | 為何不能移植 |
| --- | --- |
| 通知鈴寫死 `3`（`src/app/admin/layout.tsx:268-274`）；首頁趨勢寫死 `+12%`、`+5`（`src/app/admin/page.tsx:146,172`） | 假數字。營運中心不放未接資料的計數或趨勢。 |
| 未收集的欄位填 `0`（`src/app/admin/page.tsx:105,123`、`partners/page.tsx:140-143`） | 讀不到不是零；改為「無法取得／未更新」。 |
| 儀表板全庫 `count()` 與 `findMany()` 後在記憶體加總（`src/app/api/admin/dashboard/route.ts:29-78`） | 沒有 tenant 範圍與上限。Freedom 的計數在授權後、於同一次讀取中計算。 |
| 詳細頁下載整份清單再 `.find()`（`partners/[id]/page.tsx:140-143`、`customers/[id]/page.tsx:99-102`） | 讀取超出需要的私人資料。詳細頁使用自己的授權讀取。 |
| 建立 PENDING payout 時把佣金直接標為 PAID（`src/app/api/admin/payouts/route.ts:197-240`），刪除 payout 不回復佣金（`:414-416`） | R1 沒有付款、請款或佣金；預留不是營收，供貨價差不是佣金。 |
| 通知存在瀏覽器 `localStorage`（`src/lib/notifications.ts:22,30`） | 不是可跨裝置、可稽核的事實來源。 |
| Next.js、Prisma、本地 `User`／JWT、ADMIN 全域角色 | 平台已有身分、tenant、capability 與 command；不建第二套權威。 |
| shadcn sidebar（774 行）、`vaul`、`framer-motion`、Google Fonts、品牌 Logo、追蹤 script | 新增依賴與外部字型，違反 `DESIGN.md`；品牌不可替換。 |

## 授權處理

R1 不複製來源檔案或實質段落，因此不需在產品檔案加入 Refferq 版權標頭。若日後確需移植實質程式碼，該檔頭部須保留 MIT 版權與許可聲明，並在本文件記錄檔案、來源 commit 與用途；第三方套件另依其授權逐一核對。這不改變 Freedom Platform 本身的授權範圍。
