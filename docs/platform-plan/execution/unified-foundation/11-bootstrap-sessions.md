# Bootstrap refresh 與重複 nonce admission

接續 [10](10-device-authorization.md)，依 [AP §4.3](../../../plans/autopilot-vnext.md#43-機器配對與登入流程) 完成內部 refresh family 輪替／重用撤銷及裝置取得新 status nonce 的服務。這是同一原 scope 的工程增量，不是另一套登入、通用 VerifiedContext 或提前部署；沒有 HTTP/UI、正式 issuer custody、Grant/Attempt、private Work 或模型權限。087–090 歷史 migration 不改，新增暫用 091。

## 封閉介面與中央契約

新增中央 `contracts/execution/v1/bootstrap-session.ts`，同源生成結構 schemas。`BootstrapSessionHost` 是既有 BootstrapProofHost 加 `issuerKid,refreshUri,nonceUri`；兩條新 URI 為 exact canonical HTTPS ASCII，拒 query/fragment/userinfo/percent encoding，與彼此及既有 GET bootstrapUri 不同。Host 固定 environment/client/keyset，不能由 request 覆寫。

`await createBootstrapSessions(pool,{host,signingKey})` 自行建立真正 proof verifier 與既有 constrained issuer，不接受 callback verifier/signer、caller clock、fake member Actor 或 raw private JWK。新方法均不需要會員 session，也不要求原配對 session 仍登入：

| 方法 | 輸入 | 結果 |
| --- | --- | --- |
| `refresh({familyId,refreshHandle,proof})` | exact family locator、32-byte canonical base64url secret、真正 device proof | `{accessToken,tokenType:'DPoP',expiresAt,connectionId,runtimeDeviceId,refresh,operational_authority:false}`；refresh DTO 為 `{familyId,generation,handle,expiresAt}`，generation 是正十進位字串 |
| `nonce({connectionId,accessToken,proof})` | 仍有效的 bootstrap token 與獨立用途 device proof | 既有 089 BootstrapNonce DTO；不接受舊 nonce、不消耗 status nonce、不發 execution 權 |

10 的 device exchange 改為必定在同一交易建立初始 family/generation，回 `refreshSupported:true` 及上述 refresh DTO；其 host／factory 參數不增加選項。既有中央 issued DTO 和對應測試一起前向更新，不同時保留另一套可選發行模式。舊本機歷史紀錄不自動補發 refresh，沒有資料回填或 secret recovery。Device pairing 的第一個 status nonce 保留。

## Proof 與用途隔離

Refresh typ=`freedom-bootstrap-refresh+jwt`，header=`{alg:'ES256',typ,jwk}`，strict public P-256 JWK。Claims 僅包含 `purpose:'bootstrap_refresh',client_id,environment,connection_id,family_id,generation,refresh_handle_hash,jti,iat,htm:'POST',htu`。Wire hash 是 raw canonical handle 的 SHA-256 base64url，不叫 DPoP ath；expected generation/hash/connection/key 從保存的 handle row 解析。Refresh 不依賴 access token 尚未過期，否則不能恢復過期的短效 token。純 verifier 輸入為 `{proof,publicJwk,familyId,generation,connectionId,refreshHandleHash,nowMs}`。

Nonce acquisition typ=`freedom-bootstrap-nonce+jwt`，header 同樣 strict ES256 public JWK。Claims 僅為 `purpose:'bootstrap_nonce',client_id,environment,connection_id,jti,iat,htm:'POST',htu,ath`，ath 是 exact access token SHA-256 base64url。這條用途限定的 acquisition 不要求先有 status nonce；以目前 token/key binding、短效 proof 及 durable JTI 防重播，解決原 nonce 過期或消耗後的取得循環。純 verifier 輸入為 `{accessToken,proof,expectedBinding,nowMs}`，成功包含 tokenId/proofId 與 exact crypto interval。

兩種 verifier 都 snapshot input、拒 unknown/getter/toJSON/duplicate JSON/非 canonical compact bytes、實際驗曲線與 JOSE 簽章，proof iat 使用既有 [-60,+5] 秒窗口及精確 [from,until) 毫秒界線。Refresh 成功回 `{proofId,validFromMs,validUntilMs,assurance:'cryptographic_only',operational_authority:false}`；nonce proof 再帶 tokenId。公鑰與綁定／時鐘仍是受信服務輸入，不是純 crypto 自行認證。

Nonce verifier 必須重用同一組 bootstrap access-token 檢查（purpose、issuer/audience/client/environment、subject/owner/scope/runtime/connection/version/jkt、issuer key及token時限），不複製一套較寬鬆的 JWT verifier。可抽出 private crypto helper；09 固定 GET+nonce 的公開驗證介面不變，也不開放任意 method/URI/operation。這兩種新 proof 是封閉用途 profile，不宣稱完整 OAuth HTTP 相容；既有 resource DPoP 不變。

## 保存與一次性輪替

091 保存 `bootstrap_refresh_families`、`bootstrap_refresh_generations`、`bootstrap_session_proofs`。Family 與唯一 immutable 088 connection 一對一，保存 issued/expires、current generation、active/revoked、revoked_at/reason；owner/runtime/client/environment 經 immutable connection backing 解析，不允許重新綁定。Family expiry 固定且不晚於 connection expiry 或 family issued+30日；輪替不能延長。

Generation 保存 `(family_id,generation)`、parent generation、purpose-separated handle SHA-256 hash、wire hash、issued_at/consumed_at；初始為 1，新增只准前代+1、前代已消耗。同一 active family 只能有一個未消耗 head，pointer 與 generation chain 用 deferred 完整性約束保證，不能 commit 消耗 head 卻沒有替代者，不能 fork/skip/rewrite/delete。所有必要時間須 nonnull、finite、millisecond；不能靠 nullable CHECK 的 UNKNOWN 放行。SQL 只驗結構／背後資料，不驗簽，也不防被控制的 trusted app DB credential／schema owner。

Initial family/generation 由 device exchange 的同一 q 建立，不巢狀 transaction，不產生 generic member receipt。Refresh 先在鎖內比對 exact hash與真正 proof，再消耗 head／新增下一代／更新 pointer／寫 proof ledger／簽新 bootstrap token，最後重驗 DB clock與完整 binding。回應只在 commit 後交出。簽章、任一 SQL sink 或最後時計失敗全部 rollback，舊 handle 仍可重試；raw handle/token/proof 永不進 durable tables、facts、logs 或 generic receipts。

Proof ledger 保存實際 runtime/connection、operation=`refresh|nonce`、proof JTI、accepted_at，`UNIQUE(runtime_device_id,proof_jti)` 防同 runtime 跨新用途重用 ID；新 proof 的 typ/purpose 與舊 status/配對 proof 不互通。Fixed engineering bounds：每 family 最多 4,096 lifetime generations，每 connection 最多 8,192 session-proof rows；nonce 同時維持 089 的 8 pending／4,096 lifetime 上限。Quota 在既有 owner/key/connection 鎖下計算，並發不能繞過。這是有界工程 profile，不是正式 retention/GC/payment 政策。

## 重用撤銷與遺失回應

真正持有保存的 spent handle 且通過其對應 key/purpose/binding/新鮮 proof，視為 reuse：同交易把 family terminal revoked，並把真實 088 connection terminal revoked／version+1。必須提交後才回固定 invalid response，不能在 transaction callback throw 把撤銷回滾；任一撤銷 sink 失敗則整筆回滾且不交付 token。已發 token 由 09 目前 connection/version 檢查拒絕。

Spent-handle reuse 判定在一般 JTI duplicate／quota 檢查之前；完全相同或 high-S/low-S 等價的有效 proof 重送仍要撤銷，不能因先命中 ledger 就漏掉 reuse。錯誤 handle、key、簽章、用途、環境或過期 proof 一律無寫入，不能撤銷別人的 family。並發有效使用同一代可能先回一次新 token，接著被第二次重用撤銷，最終沒有可用連線；測試不能錯誤要求保留一個 active winner。

091 的 connection-revocation trigger 同步撤銷其 active family；family revoked 必須在交易最終對應 revoked connection，拒單獨恢復／撤銷半套狀態。原 member revoke 的 CAS／facts 仍不變；family 的衍生撤銷和 connection 同交易。Runtime/owner 停用或 connection expiry 仍即時阻止 admission，不能靠尚未 physical revoke 的 family row 繞過。

Lost committed refresh response 無法從 receipt 復原；舊 handle 再送會觸發上述 reuse，而不是 reissue grace。需要 fresh-key re-pair，仍計 retained quotas。這是明列的安全恢復 profile，不宣稱 exactly-once 網路交付或已完成同 owner key恢復。Access token仍最多10分鐘且受family/connection/key expiry上限；只保留原 bootstrap.status.read scope。

## 鎖順序與最後決策

未授權 locator 只找 immutable connection身份。實際順序沿09：user SHARE → person SHARE → personal scope SHARE → owner/environment advisory → key advisory →087 challenge → runtime → connection → family → generation/proof ledger →089 nonce。Member路徑在 user後多session、scope後多scoped-command advisory；connection revoke持conn後才更新family，沒有family到conn的鎖升級。可抽出狹窄的 server-internal connection locking helper供09/11共用，不新增可從外部提交的授權context。

驗目前 active user/onboarding/person/personal scope/enrolled runtime/active未過期connection/family，鎖後重新比對locator/binding。每個真正crypto/sign await以及最後可能阻塞SQL後取新DBclock，檢查proof/token/family/connection及新nonce期間。Nonce發行與ledger同交易，expires=min(now+60秒,connection expiry)，失敗不燒JTI或quota；returned nonce不必受當前access token expiry限制，使用時09仍獨立驗當時token與nonce。最終時計是commit前決策，不保證網路到達時仍有效。

## 必要驗證與未啟用範圍

真實ES256、ephemeral nonextractable issuer、隔離fp_* PostgreSQL與non-superuser migrator/runtime LOGIN。需驗完整device→初始refresh→rotation→machine nonce→09status；舊access過期仍可refresh；spent多代重用及等價／並發proof使已發token失效；wrong secret/key/purpose/environment無變更；currentauth與memberrevoke競態；family/connection expiry不延長；真實lock／sign／最後storage跨期；所有建立／rotation／nonce／reuse撤銷sink故障原子性；遺失回應；跨用途／跨connection replay；quota races；NULL／時間精度／TEMP shadow／SQL fork及half-state；全表秘密掃描。結構schema通過不是正式issuer批准或執行權。

原計畫已指定refresh≤30日及rotation/reuse，不需另問routine初值。正式issuer來源／custody、TLS／CSRF／來源限流、client registration、extension/native storage與HTTP/UI仍另接；沒有生產秘密／設定／發布。[RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2) 提供refresh保護與重用偵測背景，[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) 提供既有DPoP用途背景；本spec固定的額外proof與恢復限制不冒充完整標準相容。
