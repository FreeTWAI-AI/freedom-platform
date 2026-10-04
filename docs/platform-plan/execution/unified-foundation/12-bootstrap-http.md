# Bootstrap HTTP 配對與登入邊界

接續 [10](10-device-authorization.md) 與 [11](11-bootstrap-sessions.md)，把既有真正簽章／當前 DB 服務接入 Hono HTTP。沿用 [AP §4.3](../../../plans/autopilot-vnext.md#43-機器配對與登入流程) 的用途分離與 TLS。除了明確建構的 transport factory，Node 的 genuine private AI product 可透過 `bootstrap:{host,signingKey}` 明確安裝；Worker 的完整 opt-in profile 亦可透過獨立 P-256 key 安裝相同 genuine port，見 [native binding 接線](../../../development/worker-private-ai-bindings.md)；預設 Node 與 Worker 仍未安裝，也未配置正式 issuer。用途保持 `bootstrap.status.read`，不建立 ModelConnection、Grant／Attempt、私人 Work 或 execution 權。

安裝時固定同一個 product pool、canonical HTTPS origin、environment 與 clientId，拒絕 getter、未知 port、錯誤 host binding 或不吻合的簽章金鑰。不存在 genuine product 時入口回 503 `private_ai_product_unavailable`；有 product 但沒有 bootstrap port 時回 503 `bootstrap_http_unavailable`，兩者都不讀原始 body。Machine 路徑先交給自己的用途與驗簽邊界；會員路徑自行檢查當前 session／CSRF，不從其他 transport 借用 Actor。

## 固定來源與用途

`await createBootstrapHttpTransport(pool,{host,signingKey,sourceNetwork?})` 接受既有 DeviceAuthorizationHost、不可匯出的 issuer handle，以及受信 host 可選的來源解析器。Host snapshot 的 bootstrap/begin/poll 必須是同一個 exact canonical HTTPS origin 加下表固定路徑；verificationUri 同源。Request URL／Host 若不吻合、出現 query/fragment/percent encoding／非 canonical spelling，拒絕；不採用 Forwarded、X-Forwarded-Host 或 X-Forwarded-Proto 修復來源。外層 host 仍負責真正 TLS 及可信 proxy 組態，合成 HTTPS Request 不證明已部署 TLS。

| 方法與路徑 | Wire 輸入與用途 |
| --- | --- |
| POST `/execution-api/v1/auth/device-authorizations` | JSON `{publicJwk,runtimeKind}`；`DPoP` header 放既有 begin-purpose proof |
| POST `/execution-api/v1/auth/token` | JSON `grantType:'device_code'` 加 authorizationId/deviceCode/enrollmentProof?，或 `grantType:'refresh_token'` 加 familyId/refreshHandle；`DPoP` header 放對應 poll／refresh proof |
| POST `/execution-api/v1/auth/nonce` | JSON `{connectionId}`；`Authorization: DPoP <token>` 及 nonce-purpose `DPoP` proof |
| GET `/execution-api/v1/bootstrap` | 相同 access/proof headers，`X-Freedom-Connection`／`X-Freedom-Nonce` 放公開 locator；真正 GET status-purpose proof |
| POST `/api/v1/me/device-authorizations/inspect` | 本人 cookie／CSRF；JSON `{userCode}` |
| POST `/api/v1/me/device-authorizations/decide` | 本人 cookie／CSRF；JSON exact review binding/decision，Idempotency-Key 由 header 送入既有服務 |
| GET `/api/v1/me/agent-connections` | 本人 cookie；最多 32 筆該 client/environment 的 metadata，不回 secret 或假造 live/last_seen |
| GET `/api/v1/me/agent-connections/{id}` | 本人 cookie；既有當前資格檢查的 metadata／ETag |
| POST `/api/v1/me/agent-connections/{id}:revoke` | 本人 cookie／CSRF，JSON `{}`、Idempotency-Key、精確 quoted If-Match；既有 service 的 CAS／scoped facts／family cascade |

HTTP 中 poll/refresh 同用 AP 的 token URI，但 typ/purpose/grantType 不同；不把既有 service verifier 改成任意 operation。兩條 token variant 的 JSON 都不接受 proof、actor、clock、issuer、scope、client 或 keyset override。Machine 路徑拒絕 Cookie／CSRF；begin/token 拒 Authorization，nonce/status 只接受 DPoP scheme。Member 路徑拒 Authorization／DPoP，以既有 memberBoundary 自行 authenticate，不接受預先塞入的 Actor。

所有路徑均不提供 CORS。Member unsafe 方法要求 exact Origin，GET 若提供 Origin 也必須同源；Sec-Fetch-Site 若提供只接受 same-origin。所有 unsafe member 方法仍驗 CSRF。Machine 若提供 Origin，只接受同源；缺 Origin 的原生 client 可以使用，`null`／foreign Origin、cross-site Fetch Metadata 拒絕。固定方法之外回 405；bootstrap HEAD 不消耗 nonce，也不把 GET proof 借給 HEAD。未知路徑固定 JSON 404。

## 有界 body 與 durable 限流

JSON 只接受 application/json、可選 charset=utf-8；不接壓縮、form、無效 UTF-8/BOM、重複 decoded JSON keys、未知字段或超出 32 KiB 的實際 bytes。重用既有 bounded duplicate-aware parser；body 讀取最多 128 chunks、5 秒，拒絕 Content-Length 與實際 bytes 不符。讀取失敗／cancel 不回原文。Proof/token header 為有界 canonical compact grammar，不接受逗號合併的多值。

在 body／crypto 前，以既有 auth_rate_limits 表保存獨立 HTTP 預算，與 service 內的 poll slowdown／review charge 分開。每 client/environment/operation 的 global＋network 兩個 bucket 在同一短交易使用 DB clock、固定鎖序、5 秒 statement/lock timeout；domain rollback 不退還已提交的 HTTP charge。Bucket 只存 purpose-separated SHA-256；不保存來源原文、body、token、code 或 proof。受信 sourceNetwork 缺失時所有來源共用 shared-server；request IP headers 本身不能新建 network 身分。

60 秒工程預算：begin 每 network 20/global 400；token 90/600；nonce 90/600；status 120/1200；member 每 network 60/global 600。這些是有界工程預設，不是正式容量／retention 政策。超限回固定 429／Retry-After:60；無法完成限流交易時 fail closed。Malformed 的已知合法來源請求亦計數；錯 host/origin/credential mode 不進 body 或 service。

## 回應與驗證

每個成功／錯誤／未知入口均 private/no-store、no-cache、nosniff、no-referrer、noindex、same-origin resource policy；不輸出 CORS、secret-bearing Location、錯誤 stack／SQL／輸入。Body 等 HTTP 錯誤與既有服務的少數 safe code 固定 allowlist。Sensitive response 只由既有 commit 後的 service 回傳；HTTP serialized secrets 不另放 durable receipt。

以獨立 fp_* PostgreSQL、non-superuser migrator/runtime 和 genuine ES256 驗完整 HTTP 配對→本人 review/approve→poll challenge/exchange→refresh→nonce→status→reuse/本人 revoke。反例涵蓋來源／環境／憑證用途、重複 keys、header confusion、限流並發與 rollback、過期／撤權、HEAD、串流卡死／取消、錯誤去敏、SQL grants 和相關 machine／receipt／fact 表的秘密掃描。實際 createApp 的安裝與未安裝路徑分別驗證；不把 factory 或本機安裝測試計為 AP M2 部署完成或原 168 項完整驗收。
