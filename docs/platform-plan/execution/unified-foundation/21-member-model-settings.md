# 本人模型與憑證設定

版本 `0.1-draft`，2026-10-03。沿用 [17](17-private-ai-product.md)、
[18](18-credential-broker-core.md)、[19](19-authenticated-broker-bridge.md)、
[20](20-direct-credential-ingest.md)，實作 AP M2/M3 的本人設定入口。
本批為本機工程增量，不表示 provider／runtime／正式部署或168項產品驗收完成。

## 本人 metadata 與選擇

`GET /api/v1/me/model-settings` 回傳中央 closed overview：最多50筆 connections、
models、credentials、selectionOptions，setup 僅為 unavailable 或 installed 的
exact broker origin；`operational_authority:false`。每類依原始建立時間與 opaque
ID 固定排序，各最多50筆，不用目前工作、私人內容政策或 provider/recovery健康
阻擋本人歷史。選項由 server installed catalog 固定捕獲，只提供目前
platform_vault/openai或anthropic BYOK metadata，不能將這些標籤當可用性驗證。
`GET /api/v1/me/model-credentials/:id` 只回原 ModelCredentialMetadata。

沿用 current member/session、active person principal／personal scope、onboarding、
exact user/principal/scope/environment/client 與最後SQL session-clock檢查。
沿原 withMemberScope 取得當前權限，保留其新會員 canonical lazy identity mapping
與 user/session/principal/scope FOR SHARE；不另造 resolver 或重建 Actor。
SQL-only read service 不含 vault、cipher pool、recovery、resolver、provider 或新Actor
重建；查詢明列安全欄位，不把 binding／envelope 傳至主站。主站原SELECT-only
credential grants不變，credential domain read不使用 FOR UPDATE 或寫入 journal；
既有 canonical identity mapping 不改憑證或模型狀態。HTTP沿用閉合
method/path、origin/Host、cookie、machine credentials拒絕、限流、no-store及安全
錯誤；未知method/query/body/conditional headers在原body reader前拒絕。

ModelConnection create/read/revoke 沿用既有本人HTTP及原CAS/idempotency。
新模型不接受 owner/session/family/providerURL，也不成為已驗證模型。
建立新credential或replacement rotation沿原ingest issue：主CAS/header key、
rotation replacement model secondary CAS、本人明確consent。任何未知結果都
保留原command/key/CAS並讓本人明確重讀或確認；不得背景自動重送。

## 主站不接金鑰

現有「私人工作與 AI」中新增模型／憑證設定區，在工作選擇之前、獨立刷新。
主站沒有 key/password/upload/clipboard 欄位，不儲存assertion/ref/key於URL、
localStorage/sessionStorage、console／client telemetry或第三方資源。明示provider／
model、平台加密保管、remote processing與rotation的原模型／Grant／Step影響。
同意需為本次明確動作；沒有安裝port或沒有catalog時顯示無法設定及原因。

取得主站handoff後，核對closedschema、時效，以及settings installed setupOrigin
完全相同的canonical HTTPS不同hostname。使用top-level同頁POST，
`application/x-www-form-urlencoded`恰一個assertion欄位至 `/credential-setup`，
無query/fragment，不能以fetch代理secret、未知目的地或redirect重送。
本人從broker明確返回主站後，重讀owner settings/outcome；safe ACK不代表驗證。
reload/unmount不復原body permission；存放的pending command只在當前component
記憶體，不把消耗過的setup當作可再用，也不自動開始新handoff。

狀態區分模型尚未驗證／已撤銷、金鑰已保管／已輪替／已撤銷／到期、未知結果。
主站ModelConnection revoke不改credential terminal state，須明說「模型已撤銷，
金鑰仍保管」。本批不提供credential revoke／delete假按鈕；原broker終止交易
需要095的ciphertext existence deferred check，不能為UI放寬main vault權限。
未實作official_cli/local_keychain設定與真人provider驗證，不自動fallback。

## 同一 installed port 控制 CSP

CredentialIngestClient私有registry捕獲已驗證setupOrigin；PrivateAiProductTransport
從同一已綁定client取得server-only browser policy。Node createApp只接受genuine
opaque product，驗pool/main-origin/environment，runtime取得相同pinnedorigin。
不得另收request/JSON/query/config自由目的地，或用worker rawDTO假安裝。

實際portal HTML保留platform CSP；其form-action只加 exact已安裝setupOrigin，
保留self與既有GitHub admin例外，其餘directive不放寬。沒有port維持self。
Node dist靜態資產／index fallback及Worker ASSETS保留規則要驗證；Vite開發HTML
或blankfixture沒有正式CSP，不能當作這個接點的證據。此policy不證明capture
readiness、credential保存、provider登入或inference批准；每次broker既有檢查仍保留。

## 分路驗證與部署界線

作者測actualSQL app-role、crossowner/environment/client denial、expired/session
withdrawal、safe history duringprovider/recoveryoutage、unknownbody/headers及不讀body。
獨立測試從actualcreateApp＋built portal HTML、實際HTTPS不同cookiehosts完成
catalog選model→create→handoff→broker輸key→owner read→replacement rotation；
驗CSP精確origin、missing/forged/mismatchedports、cookie/CSRF、body零讀取、staleCAS、
unknownACK／manual重讀、DOM及storage/console不留assertion或sentinel。

先build再before/after截圖390／768／1440及overflow/console檢查，沿原DESIGN／tokens。
使用專屬network-none PostgreSQL／合成cert、keys、provider及capture port，
逐項記錄真實限制；不宣稱JS immutable strings可擦除。本批不動正式key／provider
帳號、GitHub規則／凍結／待審PR、真實資料或staging/live。正式安裝、真人模型、
native／跨端、媒體搬遷／restore與可信CI仍沿原scope完成後受控前向migration。
