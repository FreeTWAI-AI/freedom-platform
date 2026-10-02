# Bootstrap 即時驗權與防重播

接續 [08 的連線紀錄與加密元件](08-agent-connections-bootstrap.md)，本批完成唯一 `bootstrap.status.read` 的 DB-backed admission。對應 AP §4.3／AUTH-13、U1／U3，不掛 HTTP、不發 token、不建立 Grant／Attempt 或模型路徑；正式 issuer、完整 device flow 和 refresh 仍沿原計畫交付。本批只在合成環境測試，沒有提早發布的過渡版本。

## 封閉介面

`createBootstrapStatus(pool, host: BootstrapProofHost)` 深度快照既有 host profile，固定 issuer、audience、environment、client、GET URI 及 purpose-bound 公鑰。服務自己建立真正 verifier；不能注入 `verify=true`、caller clock／binding 或預先聲稱已驗證的結果。Host 仍負責受信 keyset 的來源及更新；更換／撤銷 issuer key 必須重新建立 host instance，本批不假裝已有正式信任發布。

| 方法 | 輸入與結果 | 授權邊界 |
| --- | --- | --- |
| `challenge(actor,{key,connectionId})` | 回 `nonceId,nonce,connectionId,issuedAt,expiresAt,operational_authority:false`；時間為 ISO 毫秒格式 | 本人 member session、onboarding、person/personal scope、enrolled runtime 及 active/unexpired connection；沿用 scoped command／journal／outbox／receipt |
| `read({connectionId,nonceId,accessToken,proof})` | 回 `connectionId,runtimeDeviceId,clientId,environment,connectionVersion,expiresAt,state:'active',operation:'bootstrap.status.read',operational_authority:false` | 真正 issuer/device 簽章、目前 DB 身分與一次性 nonce；沒有 Actor／session cookie 或任意 operation 參數 |

Challenge 是暫時的內部會員服務接點，供未來 pairing/nonce transport 組合，不要求裝置取得會員 cookie。Nonce 是公開挑戰，不是登入 secret；只有 nonce 不授任何權。相同 challenge receipt 只在目前會員及連線仍有效、nonce 未消耗／未到期時重播；不同 idempotency key 不能繞過容量。

Machine read 不冒用 member session，也不要求原配對 session 仍登入；獨立 machine connection 的撤銷由 connection/runtime、active user、person 及 personal scope 控制。停用 owner 或未完成 required onboarding 一律拒絕。沒有 lazy mapping、client supplied owner/scope、舊 `fw_read` token 升權或 private Work／model 健康依賴。

## Nonce 資料與原子消耗

暫用 migration 089 `bootstrap_nonces` 保存 server UUID、32-byte canonical base64url nonce、connection/runtime/owner/person/scope/environment/client/version 綁定、建立與到期時間、可空的 consumed_at／proof_jti／token_jti。外鍵及固定 physical schema 的 trigger 核對真正 087/088 backing rows；identity、nonce、time 不可改綁，pending 只能消耗一次，不可 DELETE／復活。SQL 保結構與目前 backing row，不驗簽，也不能抵抗可信 app DB 憑證或 schema owner 被控制。

Nonce TTL 為 60 秒且不得晚於 connection expiry；每 connection 最多 8 pending、4,096 lifetime，expired/consumed 都算 lifetime。這是有界工程 profile，不是正式保留／清理／付費政策；沒有自動 GC 或正式刪除。回傳不能延長效期；challenge 的最後 domain 決策時點和 receipt 後 member clock 都要有效。

成功 read 在同一交易把 nonce 由 pending 改成 consumed，保存已驗的 bounded proof/token jti，不保存 raw token/proof/private key。`UNIQUE(runtime_device_id,proof_jti)` 跨同 runtime 的不同 client/connection 防重用 proof ID；NULL pending 不占用。相同 proof、ECDSA 等價簽章、改 proof ID 後重用 nonce 都不能再次成功。錯簽章、錯綁定、過期或 SQL failure 不消耗 nonce，已提交的第一次成功則永久保留。

這比 RFC 的可重用 server nonce profile 更嚴格，是本版明列的單次 admission 規則，不宣称完整 OAuth HTTP 相容。[RFC 9449 §11.1](https://www.rfc-editor.org/rfc/rfc9449.html#section-11.1) 的 jti/replay 要求仍由共享 DB 狀態實作，不能只在 process 記憶體去重。這是 auth admission ledger，不寫一份假 member business receipt，也不發送舊 community event。

## 鎖與時鐘

Machine 先用 connection ID 作未授權、未加鎖的 identity lookup，之後依序鎖並重新核對：user SHARE → person SHARE → personal scope SHARE → 087 owner/environment advisory → 087 key advisory → enrollment challenge → runtime → connection → nonce。會員 challenge 在 user 後多 session、scope 後多 member command advisory，其餘相同。不升級 scope SHARE，不以第一次 lookup 或 claims 取代鎖後的目前資料。

真正驗簽在有界交易內執行，沒有外部 I/O。Crypto result 新增 `validFromMs`／`validUntilMs`：以 BigInt 計算 token、issuer key 與 DPoP 時間窗口交集，語意為 `[from,until)`，僅供可信 caller 在 await 後重驗時鐘，仍是 `cryptographic_only`。交集包括 DPoP 秒級窗口的 floor 邊界，不複寫另一套時限演算法。

Service 在等鎖後、驗簽後、nonce 更新後取新 DB `clock_timestamp()`；檢查 connection／nonce 到期和 crypto interval，再返回固定 metadata。成功 nonce UPDATE 的 AFTER guard 同時拒絕 constraint/index 等待後過期。所有授權狀態保持相應 row lock 到 commit；撤銷先取得鎖就拒絕，已授權交易先取得鎖則在撤銷提交前完成。最終時計是 commit 前的決策時點，不保證 commit 或網路回應送達時仍有效，也不授下一個 request 權限。

Machine read 的非法 shape、查無資料、撤銷、錯 owner/client/environment/purpose、簽章／nonce／重播均回相同 401 `bootstrap_invalid`，不透露存在性；未預期 SQL／timeout 為固定 503，不回 SQL、stack 或提交內容。Caller input 必須在第一個 await 前 snapshot，拒 getter／toJSON／額外欄位，不得靠它們執行程式。

## 驗證要求

使用真實 ES256、既有真實 enrollment/connection、隔離 PostgreSQL 與 non-superuser LOGIN。驗證並發同 nonce 只成功一次、同 proof ID 換 nonce 仍拒絕、不同 connection/client 不串用、錯誤請求不燒 nonce；會員／機器撤銷鎖順序、真實鎖等待及 crypto await 跨 nonce/token/proof/key 到期、三個 challenge fact sinks 與 nonce UPDATE 故障全回滾；TEMP shadow、immutable/FK、低權限 migration/app 與 public-only資料保存也要有反例。這些不是正式配對 UI、跨端 transport、issuer custody、正式信任或完整產品驗收。
