# 機器連線與 bootstrap 驗證基礎

本增量接續 [runtime 登錄](07-runtime-enrollment.md)，對應 AP §1.5／4.3、U1／U3。第一段交付真正的會員機器連線紀錄及獨立的 token／DPoP 加密驗證組件；不把兩個組件相加就宣稱機器授權已接通。原有 `fw_read` 配對不變，不建立 provider／billing／credential custody 選擇或正式金鑰。

後續 [09 的封閉 bootstrap status](09-bootstrap-status.md) 已另接目前 DB 身分與 nonce 原子消耗，僅允許 `bootstrap.status.read`。本文件繼續描述連線紀錄與純加密元件的邊界；完整配對、token 發行與 execution 授權仍未由這些元件完成。

## 會員連線服務

`createAgentConnections(pool, { environment, clientId })` 由 host 固定環境及 client ID，輸入不能覆寫。client ID 只接受 1–64 個 ASCII 字元，首字元英數，其餘英數、點、底線或連字號；它是設定身分，不是 client build 認證。服務提供 `create(actor, {key,runtimeDeviceId})`、`read(actor, {connectionId})`、`revoke(actor, {key,connectionId,expectedVersion})`。所有會員寫入沿用 scoped member command／journal／outbox／receipt。

暫用 migration 088 的 `agent_connections` 保存 server UUID、真實 owner user/person/personal scope、runtime ref、environment、client ID、建立／到期／撤銷時間與 aggregate version。它不保存 token、refresh、nonce 或私鑰。FK 與固定 schema 的 INSERT trigger 驗 runtime 所有身分欄位相同且目前 enrolled；既有 087 不改。identity、建立及到期時間不可變，active→revoked 為唯一狀態變化，禁止 DELETE／重新綁定。

connection 有效期固定 DB 當下時間起 30 日、每 owner/environment 累計最多 32 筆（含 revoked），`(runtime_device_id,client_id)` 唯一且包含撤銷 tombstone。這是本機工程 profile，不是已批准的正式 session／refresh 政策；延長、換 client 或重新配對的產品流程尚未開放。metadata 明列到期時間、state、version、runtime/client/environment，`operational_authority:false`。

Create 及其 receipt replay 都驗目前 member/session/onboarding/person/scope、runtime enrolled，existing connection 未過期／未撤銷。已完成登錄的 runtime 不因原 enrollment challenge 過期而失效。Read/revoke 仍驗目前本人資格，但允許清理 runtime 已撤銷或 connection 已過期的紀錄；不要求模型、私人 Work policy 或 provider 健康。相同 revoke receipt 可以重播；缺版本 428、過舊 412、同 key 不同內容 409。

鎖順序沿 087：user/session/person/personal scope → member command advisory → enrollment owner/environment advisory → enrollment key advisory → enrollment challenge → runtime registration → connection。Read 不拿 command advisory。不要升級已取得的 scope SHARE 鎖。跨 await 先 snapshot；domain 等鎖後重驗 session clock，create 還驗 connection 到期；共用 scoped command 在 receipt 讀取／寫入後再次驗 session clock，逾期則整筆回滾。這是 commit 前的授權決策時點，不保證 commit 或回應送達時仍未過期。讀到曾 enrolled 不等於目前可用。

create/revoke 與三個 scoped sinks 原子提交；不向舊 community outbox 發送私人 producer。SQL 僅強制結構／目前 backing row，不能抵抗可信 app DB 憑證被控制；runtime token 授權不得僅憑 active row。

## 固定 bootstrap 加密 profile

使用現有 `jose` 及中央 P-256 公鑰 parser/import，不自製簽章驗證。下表為封閉工程 profile；不是宣稱 OAuth device flow、DPoP HTTP transport 或整項 AP AUTH 已完成。用途隔離參照 [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)，proof 的 method／URI／nonce／token hash／key binding 參照 [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html#section-4.3)。

| 項目 | 本版約束 |
| --- | --- |
| factory | `createBootstrapProofVerifier({environment,clientId,issuer,audience,bootstrapUri,keys})`；host 固定且深度 snapshot，沒有 request override／預設環境／ambient trust |
| host URI | issuer、audience、bootstrapUri 為 canonical HTTPS URI，無 userinfo/query/fragment；bootstrapUri 路徑固定 `/execution-api/v1/bootstrap`；不從 token 自帶 URI 下載內容 |
| trusted keys | 1–4 個不同 kid，各為 `{kid,purpose:'bootstrap_access',environment,publicJwk,notBeforeMs,notAfterMs,revoked}`；公鑰僅 EC/P-256 的 kty/crv/x/y；未知 kid／撤銷／過期直接拒絕，不刷新網路 |
| access header | 只有 `alg:'ES256'`、`typ:'freedom-bootstrap+jwt'`、`kid` |
| access claims | 只有 `iss,aud,sub,owner_user_id,scope_id,runtime_device_id,connection_id,connection_version,client_id,environment,purpose,scope,cnf,iat,exp,jti`；sub 是 person principal UUID，其他 refs 是 UUID，version 為中央正整數字串 |
| token 用途 | `purpose:'bootstrap_access'`、`scope:'bootstrap.status.read'`、`cnf:{jkt}`；issuer/audience/client/environment 精確等於 host；不接受 array audience 或其他 scope |
| token 時間 | iat/exp 為非負安全整數秒；`iat <= floor(nowMs/1000) < exp`、`0 < exp-iat <= 600`；token 整段效期及目前時間都在 trusted key 有效期內，沒有 expiry grace |
| DPoP header | 只有 `alg:'ES256'`、`typ:'dpop+jwt'`、`jwk`，公鑰同一嚴格格式，實際 import 驗曲線 |
| DPoP claims | 只有 `jti,htm,htu,iat,ath,nonce`；htm 固定 GET，htu 精確等於 host bootstrapUri，拒 query/fragment／非 canonical alias |
| proof 時間 | 非負安全整數秒，`nowSeconds = floor(nowMs/1000)`；`nowSeconds-60 <= iat <= nowSeconds+5`，此窗口只是工程 profile |
| proof binding | ath 是原始 ASCII access token 的 SHA-256 base64url；DPoP key thumbprint 等於 cnf.jkt 及預期 binding；nonce 精確等於 host 給定的 canonical 32-byte base64url 公開 nonce |
| 大小及 JSON | access/proof 各最多 8 KiB，header 最多 1 KiB、payload 最多 4 KiB；嚴格 UTF-8、canonical base64url／64-byte signature；拒重複解碼 key、未知欄位、非法數字、超深物件、私鑰、jku/x5u/crit、detached/unencoded payload |

kid 為 1–64 個英數／底線／連字號，jti 為 16–128 個同字元。不要求一般 JSON key 排序，但拒重複 key／prototype 特殊欄位。數字只接受整數字面值，拒小數、指數、負零及不安全整數。key 效期的目前時間採 `[notBeforeMs,notAfterMs)`，token 的 exp 可恰等於 key 的 notAfterMs；秒轉毫秒使用 BigInt 避免溢位。Factory 無效設定拋固定訊息的 `BootstrapProofError`，verify 的輸入或驗簽失敗回 null；不回傳 token／proof／key 原文、stack 或 provider 診斷。Issuer 公鑰與 device 公鑰用途分開，不能將登錄用 key 自行宣稱為受信 issuer。

## Crypto 結果不是機器身分

Factory 的 `verify({accessToken,proof,expectedNonce,nowMs,expectedBinding})` 使用 host 提供的綁定快照。expectedBinding 精確包含 `ownerUserId,principalId,scopeId,runtimeDeviceId,connectionId,connectionVersion,keyThumbprint`。成功只回受限 claims、proof jti、nonce、時間窗口交集 `validFromMs`／`validUntilMs`（前含後不含）及 `assurance:'cryptographic_only'`、`operational_authority:false`；失敗回 null。時間交集供 [09 的可信 DB adapter](09-bootstrap-status.md) 在 await 後重驗時鐘，本純 verifier 不自行查當下 DB clock。不得輸出可被當成 execution Invocation／VerifiedContext 的品牌或 handle。

Caller 填 now／binding／keys 不會因此成為可信來源。這個純組件不查 DB、不做 nonce 發行或原子 consume，也不防跨呼叫 replay；同一合法 proof 重驗可以成功，測試須明示這項限制。合法 ECDSA high-S／low-S 簽章皆可驗過，replay 防護須使用 server nonce／proof jti，不以簽章 bytes 去重。[封閉 status 服務](../../../../modules/agent-control/bootstrap-status.md) 已在同一交易內解析目前 user/person/scope/runtime/connection、檢查到期／撤銷及 DB clock，並原子消耗 nonce／proof jti；結果只允許這一次 `bootstrap.status.read`，沒有可重用的 VerifiedContext。後續 execution 仍須真正 Grant／Attempt 與 operation-specific 授權，不能沿用 status 結果取得私人正文、Work、Run、model 或 effect 權。

## 測試及未完成部分

Member service 用全新隔離 PostgreSQL、真實 enrollment 簽章及 non-superuser 角色測 FK、TEMP shadow、目前資格、runtime revoke、到期、同 key 重播、並發 CAS、真正鎖等待、三個 fact sink 故障全回滾。Proof suite 用獨立合成 issuer/device key 實際簽 token／DPoP，測錯用途／issuer／audience／client／環境／key／binding／URI／nonce／ath、時間邊界、duplicate keys／私鑰／編碼、host/input mutation 與 signature malleability；不以 mock true 驗證成功。

本文件原始增量僅包含連線紀錄及純加密元件；nonce ledger 與唯一 status operation 的 DB 驗權已另由 [09](09-bootstrap-status.md) 實作。Token issuer、device_code/user_code/poll、refresh family、正式信任來源、HTTP/UI 及真正 Grant/Attempt 仍待交付。完整配對與 execution authorization 繼續沿 AP 原計畫推進，不以局部元件測試宣稱完成所有 AUTH 要求。
