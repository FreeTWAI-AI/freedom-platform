# 隔離模型憑證與外部復原來源的核心

沿 [17](17-private-ai-product.md)、AP P-17/P-24 及 UF 的秘密與 restore 邊界，
在 `apps/credential-broker/` 建立內部加密保管、綁定生命週期及外部 recovery
adapter。這是可獨立驗證的 broker 核心；仍須完成隔離程序／service binding、
authenticated reference-only bridge、專用 secret ingest 與真人 provider 驗收。
不把主 API 的 credential resolver 接到 KEK，也不把 provider key 做成 Asset。

## 身分、綁定與既有模型相容

既有 v1 ModelConnection 仍只有 `unverified`／`revoked`，身分及精確 selection
不可變。新憑證 binding 是另外的紀錄，綁定本人 user/principal/personal scope、
environment/client、runtime/connection/family、modelConnection/version、精確
provider/model/processing/custody/billing、credential ID/generation、外部 recovery
generation 與期限。模型選擇及憑證保管均不是供應商已登入或模型已驗證的證據。

每個不可變 ModelConnection 只對應一個憑證生命週期。輪替必須先有另外建立的
replacement ModelConnection；同交易將原憑證標為 rotated、原模型選擇撤銷，
建立新 credential ID 及 generation。即使新舊 provider key 的 bytes 相同，
舊模型、Grant、Step binding 也不能因此取得新憑證。撤銷與輪替均使用精確
bigint decimal string CAS，終態不能重新啟用。

公開 metadata 只含參照、版本、狀態、selection、期限及
`operational_authority:false`；不含明文、ciphertext、wrapped DEK 或 key digest。
SQL ciphertext 表由隔離 broker role 使用。普通 runtime 的 table、column、
PUBLIC、繼承或 SET ROLE 路徑都不能取得 ciphertext；metadata 權限不授解密權。

## 封閉的 broker 生命週期

內部 factory 使用既有 member scope/session/command 交易語意，沒有新增公開
HTTP route、Portal key 欄位或任意 provider proxy。

| 操作 | 行為 |
| --- | --- |
| `prepareCreate(actor,input)` | 當前本人／backing／模型版本與明確 custody 同意，取得短效 opaque intent |
| `prepareRotate(actor,input)` | 原憑證 CAS、不同 replacement model/version 與同意，取得短效 opaque intent |
| `getCredentialWriteBinding(intent)` | 只取 server-derived 不可變 metadata，不能由 JSON 偽造 intent |
| `commit(actor,intent,sealed)` | 驗同一 minted sealed provenance 及精確 binding，重驗權限、DB clock、CAS 與 sink，原子提交 |
| `read`、`revoke` | 當前本人 metadata 讀取／終態撤銷，沒有解密輸出；歷史控制不依賴 recovery/provider 健康 |
| `createResolver(actor,{credentialId,expectedGeneration})` | 捕捉目前 actor 及固定世代，回傳只供 broker host 使用的 resolver |

準備 intent 最長 30 秒，憑證生命期由 host 設定且最長一小時，不能超過
connection/family/recovery。seal 在交易外；commit 不能依賴 seal 前的舊授權。
等待鎖、crypto、外部來源、receipt 與最後 SQL sink 後仍須重新確認當前期限。
相同 intent/sealed 重播不產生第二筆憑證；不同 sealed payload 不能藉同 key
替換秘密，已撤銷／輪替或目前 backing 無效的重播不能恢復權限。

resolver 只讀固定 credential ID/generation；沒有「取最新金鑰」或 fallback。
每次解密前後都驗目前 session/owner/scope、model/runtime/connection/family、
終態與版本、SQL clock 及外部 recovery。resolver 使用完整、非鎖定的唯讀 joined
observation，避免與已鎖定相同會員／模型的 ModelStep 交易互相等待；生命週期
command 保留其鎖定與 CAS。SQL 結果送達後仍須驗當下期限與 fresh recovery，
外部 floor 與 SQL 不宣稱同一原子快照，派送前仍重驗既有 operational fence。
明文只在 broker process 的受限記憶體
中供既有 host 使用，返回期限取所有當前界線的最小值。不能把 actor DTO、
opaque WeakMap handle 或此 resolver 序列化後當成跨程序授權。

## 加密保管

每筆秘密使用獨立隨機 256-bit DEK、AES-GCM、12-byte nonce 及 128-bit tag；
DEK 以明確注入的 nonextractable 256-bit KEK 包裝，採另一個 nonce 與用途 AAD。
KEK 不從 member request、主 Worker、R2、home 或環境預設取得。

完整 binding、key ID、cipher 用途及 recovery generation 參與 canonical AAD。
owner/scope/environment/provider/model/version 置換、bit tamper、錯誤 key ID、
無效 base64url、過大或不完整 envelope 都必須拒絕。接受 JSON shape 不代表
已取得 broker sealed provenance。明文沿既有 provider-key profile 有界；複製
buffer、DEK 與錯誤路徑中的秘密及時清除，固定錯誤不包含原始 crypto exception。
seal、open 及 recovery 各有整體 3 秒預算；晚到的解密結果亦清零。resolver
整段 SQL observation／open／後驗共用 2.5 秒期限，早於 host 的 3 秒 port
期限；SQL 結果送達卡住時，也先清除 resolver 已持有的明文。resolver
將新 buffer 的所有權交給可信 host，host 在接受、metadata 拒絕或逾時晚到時
清除原始 buffer，受限複本也在使用完或失敗時清除。

## 外部復原世代

沿 UF restore 規則，generation 不能來自同一個會回退的 DB/R2 snapshot。
adapter 需要明確 host-pinned authority/environment/verification keys、獨立的
signed state 與外部 monotonic floor。用途、schema、固定算法/key ID、簽章、
issued/expiry 及 positive signed-64 generation 均驗證；錯環境、未知 key、低於
floor、過期、來源缺失或竄改都 fail closed，不以 generation 1 補值。
簽署狀態最長有效五分鐘；到期與世代不能由 caller 延長或以本機預設替代。

程序記憶體可補充拒絕已見過的較低世代，但不能代替 restart/restore 後的外部
權威 floor。seal/open/resolver 的 await 前後都重讀有效來源；舊 snapshot 中的
合法 ciphertext 也不能跨新 recovery generation 自動恢復。

## 驗證與接續

作者以實際 WebCrypto／簽章與隔離 PostgreSQL、不同 app/broker roles 驗證；
獨立 lane 測身分 AAD、same-key rotation、opaque forgery、權限旁路、撤銷競態、
SQL 等待跨越期限與舊 snapshot／外部 floor。實際數字與固定 source SHA 在
[交付紀錄](implementation-status.md)；尚未實跑項目不得列為通過。

本批沿目前 numeric scanner，使用未合併暫用 `095_credential_vault.sql`；
076–094 bytes 保留，合併前仍重新解析 migration 號碼。沒有實際 provider/key、
WAF／logging capture 驗收、正式部署或跨程序證據橋，也不安裝到公開 Node／
Worker。隔離 host、secret ingest、模型設定畫面與本人認證是下一個產品接點。
