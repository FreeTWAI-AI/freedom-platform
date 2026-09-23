# 平台管理介面 API

管理介面位於 `/admin`；後端為 `/admin/api/*`。它使用 Cloudflare Access 簽章驗證後的真人身分，再查詢 `platform_admins` 有效名單；初始人選私下建立，後續由既有管理員在後台任命。平台一般註冊、會員 cookie、自填 email、GitHub slug 或自行加上的 email header 都不授予管理權。真實管理員信箱及 Access 設定不放進 repo。

所有讀取重新驗證 Access JWT 和管理名單；所有修改還需要同源 JSON、`X-Admin-CSRF`（取自 bootstrap）與 `Idempotency-Key`（8–128 個英數、底線或連字號）。修改既有資料需要 `If-Match: "<aggregate_version>"`。缺版本回 428、版本過期 412、重用操作識別碼但內容不同 409。API 採 `Cache-Control: no-store`，失敗不回傳 JWT、SQL、密碼或 provider 原始錯誤。

| 方法與路徑（前綴 `/admin/api`） | 用途與回傳 |
| --- | --- |
| `GET /bootstrap` | `{admin, csrf_token, summary, available_skill_books, pending_guild_appointments}`；admin 包含 `admin_id, community_id, email, display_name, role`。summary 包含會員數、有效會員數、待審公會數、公會數、有效管理員數。 |
| `POST /link-member` | `{}`；需要 Access 管理員驗證，加上同社群、同 email 的有效會員 cookie，且會員已完成定位。本人確認後才綁定信箱與預先指定的公會長任命。 |
| `GET /members?limit=25&offset=0&q=` | `{items,next_offset}`；limit 1–100、offset 0–100000、q 最多100字。管理專用欄位包含 email、active、onboarding_required、onboarding_completed_at、email_verified_at、aggregate_version、目前公會。 |
| `POST /members/:id/status` | `{active:boolean,reason:string}`；理由3–1000字。停用會撤銷既有會員 session 與客戶端讀取憑證；恢復不會復活舊憑證。 |
| `GET /guild-applications?state=pending&limit=25&offset=0` | state 為 pending、approved、declined、all。回傳申請、申請者姓名與 email，以及審查者、理由、時間、核准的 guild key。 |
| `POST /guild-applications/:id/review` | `{decision:'approve'|'reject',reason,guild?}`。核准必須提供完整 guild，拒絕不得帶 guild。每件僅能處理一次；重試相同操作回原結果。 |
| `GET /guilds` | `{items}`；包含公會目錄、有效會員數、`guild_master:{user_id,display_name}|null`、`officer_version:number|null`。 |
| `GET /guilds/:key/master-candidates?q=&scope=eligible&limit=20&offset=0` | 在整份本站會員資料篩選後分頁，回傳 `{items,total,next_offset}`。`q` 搜尋暱稱／Email 的字面片段；`scope=eligible` 只列有效公會成員，`scope=all` 同時列出不符合條件者及原因。人選包含 `user_id,display_name,email,active,eligible,eligibility_reason,is_current`；原因為 `inactive`／`not_joined` 或 null。管理專用結果不可放進公開會員名冊。 |
| `POST /guilds/:key/master` | `{user_id,reason}`；目標必須是同社群、有效且已加入該公會的會員。首次任命不傳 If-Match，後續任命使用 officer_version。 |
| `GET /admins` | `{items}`；管理名單、有效狀態、aggregate_version、access_state 及是否有相同 email 的會員。相同 email 不代表已驗證帳號歸屬。 |
| `POST /members/:id/admin` | `{reason,confirmed:true}`，使用會員 aggregate_version；任命同社群的啟用中會員。已有管理紀錄回409，改用狀態操作。 |
| `POST /admins/:id/status` | `{active,reason,confirmed:true}`，使用管理員 aggregate_version；不可停用自己，重新啟用須有啟用中的同信箱會員。 |
| `GET /audit` | `{items}`；最近100筆本站管理操作，包含操作人顯示名、理由、對象、前後狀態與時間。 |

核准的 `guild` 格式：

```json
{
  "name": "新公會名稱",
  "purpose": "公會的目標與協作範圍",
  "first_step": "加入後可以開始的第一步",
  "module_key": "guilds",
  "skill_book_ids": ["從 available_skill_books 選擇既有 id"]
}
```

名稱2–100字，purpose 與 first_step 各5–1000字。module_key 只能是 positioning、supplier、retail、marketing、workbench、guilds、engagement、opensource。skill_book_ids 需1–20個不重複且存在於平台目錄的技能書 ID，不接受任意 repo URL。新公會與技能書綁定同交易寫入；核准不會自動替申請人入會、領書或任命公會長。會員實際加入時才獲得綁定技能書。

目前基礎公會目錄為全域資料；資料庫只有一個社群時可核准建立新公會。若有多個社群，核准回 `409 guild_catalog_scope_required`，待目錄隔離完成後再開放；會員、申請、管理名單、操作紀錄及任命一律依管理員的 community_id 限定。

公會長明確離會時，任命會在同一交易解除。每次任命取得單調遞增版本；即使離會後重新任命，舊版本也不能覆蓋新任命。停用會員不會移除 Access 管理權：管理員身分與一般會員帳號分別管理。因此即使有人用管理員信箱搶註冊尚未驗證的會員，仍可停用該會員，不會鎖死真正管理員。

後台「公會管理」先找公會，再按「設定公會長」。人選搜尋直接限定該公會，可按暱稱或 Email 找人、載入更多、點選人選及確認任命。搜尋所有會員時，未入會及停用者仍可見，旁邊顯示不能任命的原因；不再把搜尋結果偷偷過濾成空選單。更改查詢會清除舊人選，較慢的舊回應不能覆蓋新結果。任命仍由伺服器重新檢查資格及版本，不會因出現在搜尋結果就直接取得職務，也不會替未入會的人自動加入。

`/admins` 的 `identity_binding` 為 `no_member_account`、`unverified_email_match` 或 `verified_email_match`。API 同時提供 `member_account_present`、`member_account_active`、`member_email_verified`；未驗證相同地址不得標示為已確認的管理員會員身分。本模組不提供公開授權管理員、email 密碼重設或自動 email 身分綁定功能。

公會長提名由平台負責人私下建立，bootstrap 只回傳目前管理員自己的提名。`/link-member` 會在同一交易驗證會員 session、確認信箱、加入被指定的公會、領取技能書並完成任命；既有主力公會保持不變。若任一公會已有其他公會長，整批回 `409 appointment_changed` 並回復所有修改。未註冊、未完成定位或登入不同信箱時不建立替身帳號、不自動綁定。

修改會把已驗證的 Access subject 與管理員 ID、理由、前後狀態寫入獨立 audit；JWT 本身不落盤。所有權限與版本會在交易中重查，相同 idempotency 重試不重複記錄。

驗證：`npx tsx --test --test-concurrency=1 tests/runtime/admin-access.test.ts tests/runtime/platform-admin.test.ts` 使用隔離 PostgreSQL schema 與測試用 RSA/JWKS 簽章；不使用正式 DB 或 Cloudflare 服務。`createApp` 的明確 verifier 注入僅供程式測試，正式 server 使用預設驗證器，沒有環境變數繞過登入的模式。

## 管理員任命與登入同步

`GET /members` 附帶 `platform_admin`（null 或 admin_id、active、aggregate_version、access_state），方便直接任命。所有任命由既有 Access 管理員明確確認並留下 audit；會員信箱只是被任命的地址，仍須本人通過 Access OTP 才能使用管理權限。

`access_state` 為 pending、ready、pending_removal、revoked。獨立操作服務每15秒執行 `scripts/sync-admin-access.ts`，將啟用中管理員的精確信箱名單同步到 Access；讀回比對成功才寫入 access_synced_version/at。Web API 不持有 Cloudflare token。停用先在資料庫立即生效，舊 Access JWT 也無法再管理；邊緣名單移除可能稍後完成。服務失敗時維持待同步，不假報可登入。詳見 [部署設定](member-toolkit.md)。
