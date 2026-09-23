# 0.4.0-co-creation-beta

新會員先回答做事偏好與實務情境，再填技能與裝備。可保留完整、自填的能力清單，名片僅顯示本人精選的最多三項；手機以大類、子分類收合，電腦展開。註冊只填 Email、密碼、暱稱；聯絡方式於會員資料複選分享對象。

公會依主力、其他已加入、未加入排序。每會設藏經閣，技能書先開工坊介紹，接著可閱讀來源、專案網站或 Fork。加入資安、音樂創作與 MV、廣告攝影與影片三個公會，目錄合計十五個基礎公會。

「一起開發」連接真實 GitHub Issues 與已合併 PR，並提供可複製給 Agent 的工作說明。工坊 video-autopilot-kit Fork 已建立五張任務卡；上游影音程式未在本輪執行，Actions 保持停用，已知 Pillow 告警列為待修復任務。平台不把外部 GitHub 作者帳號自動認定為會員，也不虛構貢獻、報酬或成交。

`/admin` 使用 Cloudflare Access 真人信箱驗證與私有管理員名單。管理員可管理會員狀態、審核含技能書配置的公會申請、任命現有會員為會長，以及查看名單與操作紀錄。負責人指定但未綁定的會長顯示「待連結會員帳號」；本人必須同時通過 Access 驗證、登入同信箱會員並完成定位，才能確認任命。一般註冊不因信箱文字相符就取得管理權。

Migration 008–014 保留既有會員、已完成定位與主力公會。新增資料包含聯絡對象陣列、三公會、共創入口、管理操作紀錄、自訂／精選技能、核准公會的技能書關聯及待連結會長指定。停用會員會撤銷會員 session 與客戶端憑證，重新啟用不復活舊憑證。

提交前驗證：TypeScript、build、129 項 runtime、16 項瀏覽器、5 項跨 Repo 測試通過；契約 628 passed、4 skipped。管理操作的瀏覽器互動測試使用明確的 UI fixture，權限與任命由隔離 PostgreSQL 和簽章 JWT 測試覆蓋；不把 UI fixture 當成正式 Access 登入證據。正式站部署與真人登入狀態另存運行紀錄。

- [定位 API](../development/onboarding-api.md)
- [管理 API](../development/platform-admin-api.md)
- [共創 API 與貢獻來源](../development/co-creation.md)
- [公開站運行手冊](../development/public-operations.md)
