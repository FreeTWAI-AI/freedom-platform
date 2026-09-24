---
name: freedom-skill-upload
description: 把一個真實的公開 GitHub 技能 repo 整理成自由工坊的私人技能草稿並上傳，等待會員本人在網站確認與公開。
---

# 上傳技能草稿到自由工坊

你的權限只有一件事：替會員建立並上傳一份 **私人技能草稿**。你不能公開草稿、不能讀取其他草稿、不能管理金鑰，也不能代表會員同意分享、修改 GitHub、讀取私人儲存庫、變更會員資料或處理交易。

## 開始前

1. 先選會員提供的方式。**一次性私人指令**：直接以 HTTP POST 把 JSON 送到指令內指定的 `submit_url`，使用其 Bearer 憑證；不需要安裝工具、建立長期金鑰或讀取瀏覽器。**已安裝的長期客戶端**：會員先用 `freedom-skill-upload init --origin https://freetwai.com --key-stdin` 設定好投稿金鑰；之後以 `freedom-skill-upload config` 確認 `keyConfigured: true`。
2. 持久金鑰由會員事先設定，不要讀出或要求貼出設定檔。若會員提供私人一次性指令，可使用其中只授權指定草稿的 `fpg_` 憑證；透過 stdin 或環境變數交給工具，不能放在命令列參數、輸出、repo 或分享文字。若憑證已出現在公開對話、截圖或日誌，提醒會員撤銷並重新建立。
3. 只使用會員真實擁有、維護、貢獻或推薦的 **公開** GitHub repo。

## 整理內容

請打開 repo 並核對，不要憑印象填寫：

- `repository_url`：repo 根網址，例如 `https://github.com/owner/repo`。
- 來源與授權：核對儲存庫身分、README 與 LICENSE。沒有授權時如實說明，不要推定可重用；只撰寫自己的介紹，不複製未獲授權的原文或素材。網站公開時會自行讀取 GitHub，保存當時的 repository ID、commit SHA 與授權依據；不要自行填入或冒充這些驗證欄位。
- `title`、`description`、`use_notes`：依照 README 與實際程式內容撰寫；不要誇大功能、不要承諾收入、不要寫成官方或平台認證。
- `relationship`：照會員自己的說法選 `author`、`maintainer`、`contributor` 或 `curator`；網站會標示為「自述」。
- `share_introductions`：**剛好 100 則**，每則 8–200 字、單行、彼此不重複（大小寫或空白不同不算不同），適合貼到社群的分享介紹。不要放個人資料、聯絡方式、追蹤碼或不實宣稱。
- `demo_url`：只有真的存在的公開 HTTPS 示範頁才填，否則用 `null`。
- 示意圖可選：靜態 PNG、JPEG 或 WebP，512 KiB 以內。用 `--cover` 指定檔案，不要放遠端網址。

不要加入 `consent_to_share`、`official` 或任何會員 ID；這些欄位會被拒絕。

## 上傳

```sh
freedom-skill-upload submit --file skill.json [--cover cover.png]
```

一次性指令可用 `freedom-skill-upload submit --origin <指令內的網站 origin> --submission <草稿 ID> --grant-stdin --file skill.json`，從安全的 stdin 來源傳入憑證。僅接受該 origin 的固定上傳路徑，不跟隨轉址，不傳 cookies；既有 read-only token 不能上傳。

成功時輸出 `submission_id`、`status: ready_for_review` 與 `review_url`。請把這三項告訴會員，並說明：

> 草稿已上傳，目前只有你看得到。請到 review_url 檢查內容，確認後由你本人勾選同意並公開。

在會員於網站公開之前，不要宣稱作品「已發表」「已上架」或「已被自由工坊採用」。

## 失敗時

- `upload_key_invalid`：金鑰失效，請會員到網站建立新金鑰後重新 `init`。
- `validation_failed`：依錯誤訊息修正內容（常見是介紹數量不是 100 或有重複）。上傳授權若未被使用，可以再送一次同一份草稿；否則重新執行 `submit` 會建立新草稿。
- `upload_grant_consumed`：這份草稿已收到內容；修改後請重新 `submit` 建立新草稿，或請會員在網站撤回舊草稿。
- 其他錯誤：告訴會員錯誤代碼與草稿 ID，請他到網站查看；不要反覆重試。

完整協定見 `protocol.md`。
