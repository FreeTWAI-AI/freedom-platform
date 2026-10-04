# 私人工作與單次模型推論的產品入口

沿 [16](16-private-model-step.md) 將既有 Work、Run、ModelConnection、Grant、出口批准、
ModelStep 及私人 Result 接到本人會員 HTTP 和「私人工作與 AI」畫面。沒有新增 migration；
076–094 原始 bytes 保留。產品程式具備 Node host 的明確安裝入口，正式模型／金鑰／
recovery 與產品本人端驗收仍未完成，staging/live 未啟用。

## 安裝與 HTTP 邊界

[createPrivateAiProductTransport](../../../../apps/platform-api/src/private-ai-product.ts)
只接受 host 提供的 pool、origin、environment、client、ModelStepHost 及 ObjectStore。
保存政策固定使用既有 DB policy resolver；request 不能改 host、URL、憑證或政策。
回傳 private WeakMap handle，`createApp(...,{privateAiProduct})` 驗相同 pool、origin
及環境後才安裝。JSON、錯資料庫／origin／環境的 handle 不能代替。

Node 組合 private Work、v1 前置同意及 v2 ModelStep 契約，逐 family 派送到子 router。
不把 child wildcard middleware 掛到整個平台。Worker 不 import Node provider 模組，
沒有安裝 ports 的新模型路徑回 503 unavailable；既有非私人功能不由此取得執行權。

產品共同 envelope 驗精確 URL origin／Host、同來源 Origin／Sec-Fetch-Site，拒絕
Bearer／DPoP／machine headers 混用及 Content-Encoding。子 router 仍驗 cookie、
CSRF、onboarding、本人 principal/personal scope、用途、當前權限與 DB clock。
model/prerequisite routes 保留獨立 committed abuse charges，不信任 forwarded headers。

產品路徑在平台 generic text reader 之前取得原始 stream。所有寫入使用共用 JSON
reader：32 KiB、128 chunks、5 秒、精確 declared length、abort 及 escaped duplicate
key 檢查；取消 stream 不延長期限。private Work 仍只接受原有 strict string/empty
body。新版有界 chunk/deadline 是明確契約變更，不能以超多碎片規避資源限制。

## 本人 metadata 與一次性操作

[中央 wire schemas](../../../../contracts/execution/v2/member-model-http.ts) 及四份生成
JSON Schema 保留 primary `If-Match` 和 header-only `Idempotency-Key`；secondary
versions 只在 strict typed body。版本全程用 signed-64 decimal string，不轉 Number。

| 路徑（`/api/v1/me`） | 操作 | primary CAS |
| --- | --- | --- |
| `/model-step-overview` | GET 本人 bounded metadata | 不接受寫入 headers |
| `/model-step-approvals` | POST 明確出口批准 | Run |
| `/model-step-approvals/:id` | GET 本人批准歷史 | 無 |
| `/model-step-approvals/:id:revoke` | POST 撤銷 | Approval |
| `/model-steps` | POST 啟用一個單步 Attempt | Approval；body 帶 Run version |
| `/model-steps/:id` | GET 本人狀態 | 無 |
| `/model-steps/:id:execute` | POST 一次執行及私人 Result finalize | Step |
| `/model-steps/:id:pause`、`:stop` | POST 本人控制 | Step |

overview 每 collection 至多 50 筆，只有本人／scope／environment／client metadata。
allowedSelections 由 operator 的當前出口政策導出；configuration 只表示 ports 已
安裝，不表示模型已登入、可執行或 `operational_authority`。派送仍由 16 的真實 host
驗證與所有當前 backing 決定。舊 Run HTTP 遇 active profile 回 409
`execution_run_profile_required`，不在 closed DTO 暗藏 running/fence。

保存政策不存在或撤回時，`persistenceAvailable:false`、`works:[]`、
`allowedSelections:[]`，不回 Work title/objective 或 Result text。本人已建立的
Step／Approval／Grant metadata 與 Stop／revoke 仍可讀／操作；SQL policy source
故障回 unavailable，不偽裝成成功的空政策。私人正文讀取及新效果維持 fail closed。

execute 等待既有 runner 的 committed dispatch、host、record、Asset/Result finalize；
HTTP 只回 Step metadata，文字走既有 owner-authorized Result API。一次 capability
與 provider POST 規則不變。未知／ACK 遺失不重送；原 key replay 可能因 Work/fence
已改變而拒絕，會員可獨立讀取狀態與成果，不因錯誤就新增 Attempt 或第二次推論。

## 會員畫面

[PrivateWorkAI](../../../../apps/portal-web/src/modules/PrivateWorkAI.tsx) 使用既有導覽、
色彩／表單／按鈕及三項頁面工具。會員能建立／編輯私人 Work、讀 current/history
及人／模型來源，從本人已配對連線和政策模型選項中明確選擇，不貼內部 ID 或憑證。
每次出口顯示精確 provider/model、已保存 title/objective 與當前 token 上限，分開
本人 model Grant 同意和單次出口批准；沒有 provider/model default 或自動執行。

同一時間只接受一筆 UI mutation。request 的 key/body/CAS 暫存於 component memory；
網路結果不明時凍結新效果，可手動讀取或以原請求確認，沒有自動 retry。work edit／
selection／version 變更要求重新確認同意。私人內容不進 localStorage/sessionStorage；
政策撤回會清掉畫面正文，但重載後仍能從 metadata 停止或撤銷。

畫面如實區分 `synthetic_local_fixture`、provider HTTPS 來源、usage 與未知費用。
選擇紀錄不等於模型已驗證。產品沒有任意 prompt、檔案、URL、tool、分享或 publish。

## 本機驗證與剩餘範圍

runtime 使用 disposable PostgreSQL、non-superuser runtime、真實 ES256 配對、
loopback protocol 與 byte-validating ObjectStore 驗 HTTP、ACL、once-only、撤銷與競態。
瀏覽器 fixture 明確 flag、fresh `fp_e2e_*` schema、普通 runtime role；透過真實
ES256 registration challenge/confirm 與 server 初始 refresh family 建 backing，
不是本輪重新跑全套 device-pairing exchange。provider/key/recovery 都是合成來源。
fixture 只存在 testing 模組，不匯入正式 server/Worker，也不借用真實會員資料。

shutdown 只刪成功建立的自有 schema／role；同名既有角色必須保留。選用證據檔
寫入失敗不能阻止必要清理。獨立審查以相同合成 countercase 驗修正前後。
實際測試數、固定 source commit 與完整回歸見 [交付紀錄](implementation-status.md)。

本批不完成正式 vault/recovery 信任、本人真實 BYOK/訂閱驗收、native CLI、machine
execution auth、heartbeat/reconciliation、多步、browser/Kit/broker、媒體搬遷／
restore、完整私人讀面矩陣或可信 CI/publisher。原始 168 項產品驗收仍 not_run。
