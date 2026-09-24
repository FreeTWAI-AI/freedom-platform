# 自由工坊技能草稿上傳協定（agent 端）

版本：`@freetwai/skill-upload` 0.1.0。這份協定只涵蓋「建立並上傳私人技能草稿」。查看草稿、撤回、公開、發出或撤銷金鑰都只能由會員本人在網站操作，agent 沒有這些端點。

## 憑證

| 憑證 | 格式 | 來源 | 用途 |
| --- | --- | --- | --- |
| 上傳金鑰 | `fpk_` + 43 個 base64url 字元 | 會員在網站「技能上傳」建立，只顯示一次，1–90 天到期，可隨時撤銷 | 只能建立新草稿 |
| 上傳授權 | `fpg_` + 43 個 base64url 字元 | 建立草稿時回傳一次，或會員在網站重新發出 | 只能上傳到那一份草稿，60 分鐘內有效，只能用一次 |

- 伺服器只保存 SHA-256 雜湊。遺失的金鑰或授權無法找回，只能重新建立。
- 金鑰被撤銷或到期時，由它建立、尚未完成的上傳授權也一併失效。
- 瀏覽器 cookie 不會被接受；請只用 `Authorization: Bearer …`。
- 不要把金鑰或授權放進命令列參數、repo、log、截圖或公開聊天。一次性私人指令只交給會員選擇的 Agent；長期金鑰留在私人設定中。

## 1. 建立草稿

```
POST /agent-api/v1/skill-submissions
Authorization: Bearer fpk_…
Content-Type: application/json
Idempotency-Key: <8–128 個 A-Z a-z 0-9 _ ->

{}
```

回應 201：

```json
{
  "submission": {"submission_id": "…", "status": "awaiting_upload", "grant_expires_at": "…", "created_at": "…"},
  "upload_grant": {"token": "fpg_…", "expires_at": "…", "submit_url": "https://freetwai.com/agent-api/v1/skill-submissions/…"},
  "review_url": "https://freetwai.com/#skills"
}
```

同一把金鑰以同一個 `Idempotency-Key` 重送時，回傳同一份草稿，但 `upload_grant` 為 `null`（授權只出現一次）。這時請會員到網站重新發出授權。內文上限 8 KiB。

## 2. 上傳內容

```
POST /agent-api/v1/skill-submissions/<submission_id>
Authorization: Bearer fpg_…
Content-Type: application/json
```

內文（上限 800 KiB）：

```json
{
  "repository_url": "https://github.com/擁有者/儲存庫",
  "title": "1–120 字",
  "description": "1–2000 字",
  "use_notes": "1–3000 字",
  "demo_url": null,
  "relationship": "author | maintainer | contributor | curator",
  "share_introductions": ["剛好 100 則，每則 8–200 字，單行、彼此不同"],
  "cover_image": {"mime_type": "image/png | image/jpeg | image/webp", "data_base64": "…"}
}
```

- `repository_url` 必須是公開 GitHub 儲存庫的根網址；`demo_url` 可省略或為公開 HTTPS 網址。
- `share_introductions` 會先做 Unicode NFC 與前後空白整理；大小寫或空白不同不算不同。不可含換行或控制字元。
- `cover_image` 可省略。只接受標準 base64（無換行、無 `data:` 前綴），解碼後 512 KiB 以內、靜態點陣圖、長寬各 4096 以內。SVG、GIF、APNG、動態 WebP 會被拒絕。伺服器會重新編碼為 WebP 並移除中繼資料；不會去抓取任何遠端圖片。
- 不接受 `consent_to_share`、`official`、會員 ID 或其他欄位。公開同意只能由會員本人在網站勾選。

回應 200：

```json
{"submission_id": "…", "status": "ready_for_review", "grant_consumed_at": "…", "review_url": "https://freetwai.com/#skills"}
```

以同一個授權重送完全相同的內容，會得到同樣的確認，不會重複建立。內容不同則回 409 `upload_grant_consumed`。授權過期、被撤銷、草稿被撤回、會員停用或尚未完成定位時，就算內容相同也會拒絕。

## 錯誤

錯誤回應為 `{"status", "code", "detail"}`。常見代碼：`upload_key_invalid`、`upload_grant_invalid`（401）、`onboarding_required`（403）、`upload_grant_consumed`、`draft_limit`（409）、`body_too_large`（413）、`json_required`（415）、`validation_failed`、`invalid_cover_image`（422）、`auth_rate_limited`（429）。

## 公開

agent 完成上傳後，草稿仍是私人的。會員在網站檢查內容、勾選同意分享並按下公開，平台才會讀取 GitHub 的公開資料，固定當下的 commit 與授權檔，並把關係標示為「自述」、非官方。公開之前，請不要對外宣稱作品已發表或已被平台認可。
