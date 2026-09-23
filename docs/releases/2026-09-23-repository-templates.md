# 九倉模板與 preview 協定接線

本輪將產品模板放進各自 repo，保留 Platform 為會員、定位、公會、商品、選品、作品、行銷的中央 API 與資料來源。完整對照見 [repo 分工](../development/repository-integration.md)，實測各倉 commit 見 [repositories.lock.json](../../repositories.lock.json)。

## 已完成

- 中央輸出 32 個已實作操作的 OpenAPI 3.1.1、schema、Node/browser client、型別與 metadata；SDK 啟動比對 protocol hash。
- 八個 consumer repo 固定中央來源 `9f54647ecc0cdda0a672cfaedcd97935cc165fab`；每倉驗證檔案 hash、remote source 與真實 GitHub manifest 身分。
- `.github` 的共用唯讀驗證 workflow 固定 commit；各 consumer 的 GitHub Verify template 已通過。
- `freedom-project-template` 與 `freedom-storefront` 已設成 GitHub template repository。
- 五項跨 repo 測試從獨立 checkout 載入各自 SDK，走真正 HTTP 與 PostgreSQL，涵蓋協定協商、零售選品／供貨确认、行銷 snapshot、GitHub 作品到行銷／介紹頁、Agent Kit 的會員／工作摘要。
- Core CI 按 lock 下載固定 consumer commits，再跑上述整合測試。

## 驗證

本機：runtime 52 passed；跨倉 5 passed；consumer 原生行為測試合計 38 passed；契約／工具 597 passed、4 skipped；typecheck、generated bundle、各倉 manifest、build 與 inventory 驗證通過。外部 GitHub response 在跨倉測試中使用明示 fixture；真實 GitHub import 的 staging 證據另見 modules preview 紀錄。完整遠端結果以本 commit 的 Actions 為準。

## 仍有邊界

這是會員 session 的內部 preview 接線。正式外部 Store／Agent／worker 授權、事件 transport、結帳、支付、provider 發布、media 執行、signed release status 尚未因本輪完成。service-offer 模板明示 API 未接入。

中央規則強制 workflow 尚未配置；各倉 CI 通過不等於 required workflow 已強制，也不代表 official release。原始碼授權仍 NOASSERTION，本輪沒有代擬法律授權。

目錄 repo 首次 push 意外觸發 GitHub 預設 branch Pages build；部署步驟已取消，Pages source 改為 custom workflow，repo 沒有 deploy workflow；檢查公開 URL 回 404。此設定停用 branch 自動發布，並非刪除 Pages 資源。
