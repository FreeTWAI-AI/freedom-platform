# 裝置配對與一次性 bootstrap 交換

接續 [09](09-bootstrap-status.md)，實作 [AP §4.3](../../../plans/autopilot-vnext.md#43-機器配對與登入流程) 的新裝置配對協調器、真正簽章輪詢及受限 issuer。保留 087–089 的不可改綁／撤銷規則，不讓會員核准代替裝置持有私鑰的證明。本批是原 scope 的內部工程增量，不是提早部署的過渡版本；沒有 HTTP/UI、正式 key custody、refresh family、Grant／Attempt 或 execution 權。

## 固定 profile 與中央契約

中央 `contracts/execution/v1/device-pairing.ts` 定义嚴格 inputs、DTOs、host、proof claims 及容量常數。Runtime kind 封閉為 `agent-kit`、`extension`、`neo`；這只是請求 metadata，不是 runtime build／capability attestation。Host 固定既有 `BootstrapProofHost`、issuer key ID、begin/poll/verification 的 canonical HTTPS URI 與可信 client display name；URI 不接受 query、fragment、userinfo、非 canonical encoding 或相同 begin/poll 端點。裝置不能傳任意 scope、owner、環境或 operation；scope 唯一為 `bootstrap.status.read`。

`createDeviceAuthorizations(pool,{host,signingKey})` 是 async factory：自行建立真正 pairing verifier 及 bootstrap issuer，`signingKey` 是 host 提供、不可從 JSON 取得的 private P-256 WebCrypto signing handle。沒有 verify=true、caller clock、issuer callback、既有 member session 或 raw private JWK 注入介面。測試只用 ephemeral keys；正式信任來源仍待 operations 設定。

## Pairing proof 與 issuer

Begin/poll 使用独立 `freedom-device-pairing+jwt` typ、ES256/P-256 與嚴格 public-JWK header，不混用 09 的 GET+ath DPoP。Begin claims 包含 `purpose:'device_pairing_begin'`、`client_id`、`environment`、`runtime_kind`、固定 `scope`、`jti`、`iat`、`htm:'POST'`、exact begin `htu`。Poll 的 purpose 為 `device_pairing_poll`，另外綁 `authorization_id`、server public `nonce`、`device_code_hash`（exact canonical secret 的 SHA-256 base64url）與 exact poll URI。裝置把 raw device code 交給服務，簽章只綁其 hash；不得把這個自訂欄位叫做標準 DPoP ath。

Verifier 重用既有 strict JSON／canonical compact encoding、真正 JOSE 曲線與簽章驗證。Proof JTI 為 16–128 個 base64url 字元、iat 為 safe nonnegative 整數秒；允許 DB nowSeconds−60 至 nowSeconds+5，回 exact millisecond interval，仍為 `cryptographic_only`／`operational_authority:false`。Begin header key 與 request public key 必須相同；poll 必須匹配儲存的 key/client/environment/runtime kind/request/nonce/code hash。Caller input 在 await 前 snapshot，拒 getter／toJSON／額外欄位；不從 token 下載 key。

`createBootstrapTokenIssuer({host,kid,signingKey})` 綁既有 purpose-bound 公鑰 descriptor；初始化做真正 sign/verify 確認 private handle 匹配，而非接受型別就相信。`issue({binding,nowMs,notAfterMs})` 只簽既有 BootstrapAccessClaims，內部產生 JTI，iat=floor(DB now/1000)，exp=min(iat+600、floor(connection expiry/1000)、floor(issuer key expiry/1000))；不產生空 interval、不超出 key interval。每次簽後以固定公鑰驗回 exact claims／header，沒有 remote I/O 或任意 signing callback。純 issuer 不是 DB 授權；服務持有所有目前狀態鎖，await 後及最後 query 後另驗 DB clock，commit 成功後才把 raw token 交出。

## 介面與秘密

| 方法 | 必要輸入 | 結果與限制 |
| --- | --- | --- |
| `begin({publicJwk,runtimeKind,proof})` | 真正 begin proof；沒有 member Actor | 一次回 `authorizationId,deviceCode,userCode,nonce,requestDigest,verificationUri,issuedAt,expiresAt,expiresIn:300,interval:5,operational_authority:false` |
| `inspect(actor,{userCode})` | 目前本人 member/session/onboarding/person/personal scope | 回 exact request review DTO：authorization ID、digest、client ID/display name、environment、runtime kind、key thumbprint、固定 scope、expiry/state；不含 device code 或他人 owner metadata |
| `decide(actor,{key,userCode,authorizationId,requestDigest,decision})` | exact inspected identity；decision=`approve`或`deny` | scoped command／facts／receipt 只回 nonsecret decision DTO；目前身分及不可變 binding 必須仍有效 |
| `poll({authorizationId,deviceCode,proof,enrollmentProof?})` | code possession 與 genuine fresh poll proof | committed `authorization_pending`／`slow_down`／`proof_required`／`access_denied`／`expired_token`，或一次性的 `issued` |

Device code 是 32 隨機 bytes 的 canonical base64url secret；user code 是 10 個無歧義 Crockford base32 字元（顯示為 XXXXX-XXXXX，50 bits）。服務只接受該 canonical 大寫格式；不做隱含字元替換。DB 只保存兩者帶用途分隔的 SHA-256 hash；poll claim 的 `device_code_hash` 另按前述 wire 規則計算。User code 不是登入 secret，hash 不增加其熵。Begin 回應與 issued token 不走一般 command receipt，不寫 journal/outbox/raw logs。Begin proof 的 `(environment,key_thumbprint,begin_jti)` 唯一，重播不重新交付秘密；兩個等價 ECDSA signatures 也不能繞過。

`proof_required` 只交出已核准的真正 087 RuntimeRegistrationChallenge。`issued` 回 `accessToken,tokenType:'DPoP',expiresAt,connectionId,runtimeDeviceId,nonce`（089 DTO）、`refreshSupported:false,operational_authority:false`。第一次 status nonce 與 connection 同交易建立，裝置不必拿會員 cookie 才能使用 09。重複取得新 status nonce 的 machine transport 及 refresh family 留給後續工程，不能稱作完整長期登入。

秘密回應遺失時，不可從 generic receipts 復原，也不悄悄再 mint。Begin 遺失可用新 proof JTI 重開，仍算容量；成功 exchange 已 commit 則原 code 永久 consumed。Fresh-only 初版重配對須新裝置 key，因為既有 environment/key 及 runtime/client tombstones 不允許復活或改綁，既有 lifetime quota 仍計入。這是明示失敗恢復行為，不宣稱 exactly-once 網路交付；refresh／同 owner re-pair 恢復尚未完成。

## 狀態與交易

暫用 migration 090 新增 device authorizations、poll proof JTI ledger 與 member review rate buckets；087–089 不改寫。Pending request 保存 immutable key/request/nonce/hash/expiry，沒有 owner/runtime 權威。Original issued_at＋300 秒是獨立截止，會員核准不能延長。

`pending → approved|denied` 只由目前有效的 member 決定，owner/person/personal scope 一次綁定，不可改派給第二個人。Approve 原子建立真實 087 challenge 並連回 authorization；087 自己保持精確 300 秒 TTL，但 poll／exchange 同時驗 original authorization deadline。Approve 不建立 enrolled runtime、connection 或 token。Deny 不產生 087 challenge。無論 expired/denied/consumed 都不刪除或復活。

Poll 先用未授權 locator 得到 immutable state/owner；pending-only 路徑不能先鎖 authorization 再升級到 owner 鎖。若等鎖後看到 approval 與 locator 不同，就結束該唯讀交易並重啟有界的 approved 路徑，不在同交易倒序取鎖。Approved 路徑沿 user SHARE → person SHARE → personal scope SHARE → existing owner/environment advisory → existing key advisory → 087 challenge → existing runtime/connection（若有）→ authorization／proof ledger → 089 nonce。Member 在 user 後多 session，scope 後多 scoped-command advisory，其餘一致。當前 authority、state、binding 皆須鎖後重驗。

Approved poll 沒有 enrollment proof 時，回 exact challenge。交換時必須以既有 `verifyRuntimeRegistrationProof` 真正驗該 challenge；不能 fake Actor、巢狀呼叫自己開交易的 member factory 或以批准 row 代替 proof。成功同交易 consume challenge → INSERT enrolled runtime → INSERT 30 日 immutable connection → INSERT 第一個 089 nonce → authorization consumed → sign bootstrap。之後再驗 DB clock、member-independent目前身分及 token validity，commit 後才回 issued。Raw enrollment/poll proof、device code 與 token 不落表；失敗任一 sink／驗簽／簽發／最後時計，全數 rollback。沒有 fake member business receipt，交換的 durable facts 是這些 backing records。

## Polling 與容量

初始 interval 5 秒，第一個 poll 可立即開始，後續按 last valid poll＋interval；有效但過早的 poll 將 interval 永久加 5 秒並從現在重設下次時間。這類結果必須 return committed protocol variant，不能 throw 讓 throttle/JTI 更新 rollback。每個 valid poll JTI 都只用一次；重複 JTI 回固定 invalid response，不再增加 slowdown。錯簽章、錯 code/key/request、非法 input 不能燒 code 或影響合法装置的 throttle。

固定工程界線：每 environment 最多 1,000 未到期 pending/approved 與 10,000 lifetime authorization；每 key 最多 4 pending/approved、32 lifetime；每 authorization 最多 64 accepted poll proof JTIs。Begin 真正 proof 驗過後，在 environment admission advisory lock 下算 quota，因此換 key 不能繞過 global bound。這是內部容量防護，不是對 Internet 的完整來源限流；掛 HTTP 前還需 trusted transport 的來源／全域流量限制、TLS、CSRF與人類確認UI，不能把呼叫端自填 IP/key 當完整防濫用。

Member inspect／decide 對每 owner/environment 使用 60 秒、最多 10 次 user-code 查找的 durable bucket，包含猜錯與查不到的代碼；無效 code 的結果必須在 bucket 提交後才拋出對外錯誤。同一桶 row/advisory 的鎖序需固定在 scope／member-command之後、domain locks 之前；不得與 domain 路徑反轉。這些是封閉工程限額，不是正式配額／retention／GC 政策；沒有清理或 production 啟用。

## 驗證與剩餘範圍

真實 ES256、ephemeral nonextractable issuer key、隔離 fp_* PostgreSQL 與 non-superuser migrator/app LOGIN。必要反例：begin proof key squatting／replay；code-only/wrong-key polling；核准 request替換／two-owner race；durable slowdown與重播；expired approval不延長；genuine enrollment signature；並發與 high-S equivalent exchange；所有 durable sinks故障 rollback；最後 lock／sign await 跨 deadline；wrong issuer key／purpose／claims；raw secrets 不出現在所有表與 facts；既有 runtime/connection revoke、TEMP shadow、不可改綁與低權限DDL。新 schema 只驗shape，不是有效proof或正式issuer批准。

這是對 [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) 的封閉語意實作，額外的 proof_required 與 fresh-only 恢復不宣稱完整 OAuth HTTP 相容。獨立 pairing proof 不冒充 [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) 的 resource DPoP；既有 bootstrap resource profile不變。完整 refresh rotation/reuse、production trust、HTTP/UI及跨端、Grant/Attempt/model binding仍沿原plan交付，不計作本批通過。
