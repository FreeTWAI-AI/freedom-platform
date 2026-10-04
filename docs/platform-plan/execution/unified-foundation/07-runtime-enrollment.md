# Runtime 金鑰登錄規格

本增量將會員核准與實際金鑰持有證明保存為可撤銷的 runtime 登錄。它是 [執行端規格](04-execution-adapters-release.md) 與 [配對規格](06-browser-runtime.md) 的前置工作，不是完整 device flow、DPoP、機器登入或執行授權。來源為 AP §1.5／4.3；本輪工程 profile 不替 Ted 選模型、provider、billing 或 credential custody。

## 固定工程 profile

中央型別與 validator 位於 `contracts/execution/v1/runtime-registration.ts`，伺服器實作位於 `modules/agent-control/`。本版只接受下列封閉組合；不接受 client 選擇演算法、驗證器、環境或有效期。

| 項目 | 本版規則 |
| --- | --- |
| profile 與用途 | `freedom.runtime-enrollment/v1`、`runtime_enrollment` |
| 公鑰 | EC P-256，只有 `kty`、`crv`、`x`、`y`；座標為 canonical 32-byte base64url，實際 import 驗曲線點 |
| JWS | ES256；protected header 固定 bytes `{"alg":"ES256","typ":"freedom-runtime-enrollment+jws"}` |
| 環境 | host constructor 明確提供 `local`／`staging-next`／`next`，沒有預設或 request override |
| 挑戰 | server 產生 challenge/runtime UUID 及 32 random bytes nonce；有效期固定 300 秒，canonical UTC ISO 毫秒 |
| 大小 | proof 最多 4,096 bytes，server payload 最多 2,048 bytes；有界 snapshot 拒 accessor、prototype 與非 JSON 值 |
| 容量 | 每 owner/environment 最多 10 個未過期未消耗 challenge、累計 1,000 個 challenge、32 個登錄（包含已撤銷） |

使用既有 `jose` 的 compact JWS 驗簽，不自行實作橢圓曲線運算；公鑰識別使用 SHA-256 JWK thumbprint。JWS 格式及 thumbprint 分別依 [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515) 與 [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638.html)，ES256 簽章編碼依 [RFC 7518](https://www.rfc-editor.org/rfc/rfc7518#section-3.4)。上述固定 header、期限與容量是本平台的工程限制，不是 RFC 的一般要求或已批准的正式服務政策。

被簽 payload 包含 profile/purpose、challenge、owner member/person principal/personal scope、runtime、environment、key thumbprint、nonce、issued/expires time 與 `operational_authority:false`。Client 簽伺服器提供的原始 UTF-8 payload，不重新排序或序列化；這不是新通用 JCS profile。Verifier 精確比較 protected header 與 payload 的編碼，拒絕重複 JSON keys、未知 header、`jku/x5u/crit`、detached/unencoded payload、padding 與 base64url aliases。原始 JWS 不存入 receipt、journal、outbox 或診斷。

Nonce 是公開挑戰，不是 device_code、token 或 bearer credential；單獨取得 nonce 不能登入或登錄。為使 begin 可安全重播，可將它保存在 challenge 與本人 scoped receipt。私鑰只在 client，本平台不生成、接收、保存或記錄私鑰；測試只使用合成金鑰。

## 會員內部服務

Factory 接收 DB pool 與不可變 host environment。Actor 必須來自現有可信會員認證鏈；service 仍以目前 user/session/person/personal scope/onboarding 重新驗權。沒有 HTTP mount、bootstrap/access/refresh token、provider 或外部 I/O。

| 操作 | 輸入與效果 |
| --- | --- |
| begin | `{key, publicJwk}`；runtime ID、owner、scope、nonce、期限全部由 server 決定；保存 challenge 及 scoped receipt |
| confirm | `{key, challengeId, proof}`；驗目前 owner、精確挑戰與真正簽章，原子消耗 challenge、建立登錄、寫 facts/receipt |
| read | `{runtimeDeviceId}`；只回本人 metadata 與 enrolled/revoked 狀態，不回 challenge、proof 或憑證 |
| revoke | `{key, runtimeDeviceId, expectedVersion}`；CAS 撤銷，保持已撤銷 tombstone，不需要 provider／模型健康 |

Begin 的待確認挑戰不能獨占公鑰：公鑰公開，否則任何人都能先提交他人的公鑰造成搶註。只有成功驗簽確認才取得 environment/key 的唯一登錄。既有登錄（含已撤銷）不可改綁 owner、runtime、scope 或 key；rotation 使用新 key 與新 runtime ID。衝突不洩漏其他 owner 或狀態。

## 原子性與時間

先取得現有 member/session/person/scope 與 command receipt 鎖，再按 owner/environment、key、challenge、registration 的固定順序取得 domain 鎖。容量檢查與新增使用同一 owner/environment advisory lock；不得把共用 scope SHARE 鎖升級。對不同 owner 相同 key 的確認仍須序列化，並有 SQL 唯一約束兜底。

Crypto helper 只驗簽章與绑定，不替 caller 保證目前 owner、freshness 或消耗狀態。Service 在等待鎖與 async crypto 之後使用 DB 當下時鐘重驗 session；新 confirm 還須 challenge 未消耗且尚未到期，恰好到期即拒絕，無隱含時鐘寬限。

每次 receipt 重播先驗目前權限與對應資源。Begin 的過期／已消耗挑戰不再回傳。已成功 confirm 的完全相同請求可在挑戰到期後取得歷史 receipt，但登錄必須仍屬本人且未撤銷；新 key 對已消耗挑戰不能產生第二次效果。撤銷後不得藉 confirm 或 begin receipt 復活。Revoke 的相同 receipt 可重播，仍須目前 owner 權限。

Challenge consume、registration、scoped journal/outbox/receipt 同交易；任何一個寫入失敗全部回滾。SQL 保存完整 owner/scope FK、不可變身分、一次消耗、版本與禁止刪除等結構約束；trigger 查詢明確限定實體 schema，不能用 TEMP 表代換。SQL 不驗 ES256，也不防持有可信 app DB 寫入憑證者捏造業務事實；加密驗證由受測 server service 執行，不能把資料列本身當成可對外使用的權限憑證。

## 驗收與未交付

必要反例包括錯 owner/scope/environment/purpose/key、非曲線點、私鑰或未知 JWK 欄位、簽章篡改及編碼歧義、同 key/不同 key 並發、鎖等待跨 expiry/撤權、重播復活、key 搶註、immutable FK、低權角色/TEMP shadow 與全部事實寫入故障回滾。測試必須實際驗簽與使用隔離 PostgreSQL，不以 mock true 作成功證據。

登錄只證明受控流程中的會員核准及持有金鑰；不證明裝置硬體、runtime build/capability、官方 CLI 登入、provider 身分、模型 ready 或 execution Grant。沒有 server signing key、machine token、RunAttempt、模型連線、dispatch、HTTP/UI 或正式設定變更。範圍與實跑證據最後記入 [交付紀錄](implementation-status.md)，不據此完成整項 AP AUTH 或私人 AI 草稿驗收。
