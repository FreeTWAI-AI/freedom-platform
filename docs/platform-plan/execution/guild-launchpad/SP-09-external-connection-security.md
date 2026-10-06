# SP-09｜外部模組連線、安全與自主性

## 1. 文件身分、來源、追蹤與範圍

- **ID／版本：** SP-09 / 0.1.0；2026-10-05
- **狀態：** proposed、待實作、待驗收；endpoint/credential API 名稱皆為目標設計，未宣稱目前可用
- **來源：**《公會啟動台與可攜式業務空間》v1.0 第 11、13、15–16、23–24 章與附錄；中央 source `567ae8d3849cfaa319b79c42d9c6c0a48d76f4a9`
- **決策：** D-14–17、D-19–21；**主要需求：** R-036、R-048–051；**協作：** R-015、R-022、R-029、R-032–035、R-039、R-043–044、R-047、R-052–054、R-059、R-062
- **驗收：** T-036、T-048–050；共同 T-007、T-015、T-022、T-027、T-029–035、T-039–047、T-051、T-056、T-058
- **共同定義：** [contracts.md](contracts.md)、[repository-map.md](repository-map.md)、[資料責任](data-responsibility.md)、[traceability.json](traceability.json)、[decision-log.md](decision-log.md)

外部 endpoint 的 possession、程式版本聲明與 service credential 是不同事實：控制 hostname 不證明擁有 tenant，憑證有效不等於當前有 domain 寫權，簽章不證明庫存／收入／付款真實。本規格只定連線與平台可承認的行為；SP-08 唯一負責移交 writer。

## 2. 使用者流程、前後狀態、非目標與依賴

1. 目前具 `module.binding.manage`／`module.connection.manage` 權限且通過 SP-02 高風險新驗證的 owner 登錄受支持的 external endpoint、module instance、contract/release 與明列的 capabilities
2. 平台先驗 tenant/instance ACL 和 network policy，再向受控 endpoint 作有界 possession challenge；同時驗其 declared contract，以真實 contract fixture 核實該 capability 的相容性
3. 已驗 target 登錄真實 service backing、principal、用途／audience／environment／scope／expiry／key binding；由既有 credential/command 核心的**新增受驗 adapter**配發有限權限。不得取人類 session 冒充 service
4. 註冊完成僅 `verified`／`registered`，仍無 live business writer 權；由 SP-08 成功移交且目前 epoch/floor 一致後才接受新業務 command
5. 管理者可查健康、範圍、最後驗證與 expiry，輪替／縮權／撤銷／斷線；受影響模組降級有真實狀態，其他模組保持正常

**前後狀態：** 新註冊不改原 registry writer；新 key 不擴既有 capabilities；revoke/disconnect 不刪租戶合法本地資料。external 本地 auth 可讓純本地工作獨立繼續，平台相關高風險動作需 fresh platform authority，不以舊全權 cache 放行。

**非目標：** 通用任意 URL proxy、遠端執行會員 repo install scripts、把 `fw_read_` 升級寫 token、把公會頭銜映成 tenant owner、平台 key 代會員模型、承諾任意 fork 業務真實或官方支援、斷線後自動恢復舊 keys。

高風險 binding/connection 管理預設 owner-only；admin／普通 editor 不自動取得。新增或擴大 capabilities 要依 SP-02 範圍／目的／期限與目前權限重新批准，不能從 guild 職務推得。

**依賴：** SP-02 tenant ACL/common-v2、SP-04 binding registry、SP-05 ports/receipts/inbox/outbox、SP-08 epoch/fence、既有 UF CORE/credential/recovery。Endpoint parser、網路負例、UI、contract fixtures 可先實作；真正 service backing、credential verifier、recovery/current-state locks 未完成前，service route fail closed，不用 stub VerifiedContext 開通。

## 3. 現有程式對照與精確檔案

| 標記 | 檔案 | 對接／限制 |
| --- | --- | --- |
| KEEP | `modules/client-connections/service.ts`、`apps/platform-api/src/routes/client-connections.ts`、`packages/client-connections/read-client.mjs`、`cli.mjs` | 現有 storefront/supplier `fw_read_` 僅 GET；`/client-api/v1` 回 405 拒写；保留 scope、receipt、對應 owner ACL |
| KEEP | `apps/portal-web/src/modules/ClientConnections.tsx` | 現有讀取連線 UI 保留真實用途，不直接改標籤當外部 module write |
| KEEP／MODIFY | `packages/db/command-core.ts`、`packages/scoped-commands/index.ts`、`packages/resource-scopes/index.ts` | 復用 neutral core/目前驗權優先；後兩者現在只 member＋personal/community；新增 service adapter 不能造 Actor |
| KEEP／MODIFY | `contracts/common/v1/identity.ts`、`contracts/common/v1/principal-ref.schema.json`、`resource-scope-ref.schema.json` | 保留 v1 bytes/consumers；經 SP-02 新 common/v2 增真實 tenant branch；現 service/site wire reservations 不等 runtime 支持 |
| KEEP | `modules/agent-control/runtime-registration.ts`、`runtime-proof.ts`、`strict-jose-json.ts` | 復用受限 public JWK／strict JOSE 原理；現 profile 是 runtime enrollment，不是 module credential/client authentication |
| KEEP | `modules/agent-control/bootstrap-issuer.ts`、`bootstrap-proof.ts`、`bootstrap-session-proof.ts` | 用途分離與 verifier 設計參考；不得接受 bootstrap token 作 module 命令、擴其 aud/scope 或重用其專用 proof typ |
| KEEP／MODIFY | `apps/credential-broker/src/recovery.ts`、`bridge.ts`、`store.ts` | 沿外部 monotonic recovery 與 reference-only 秘密邊界擴充；目前 model broker 不是 module credential store／已可用服務驗權 |
| KEEP | `apps/platform-api/src/module-context.ts` | 現 member session／If-Match parser；machine route 不能呼叫它捏造 member auth |
| NEW | `contracts/connections/v1/module-service.ts`、`contracts/connections/generate.ts` | BindingRegistration／CredentialMetadata／CapabilityNegotiation／network profile 作者來源 |
| GENERATED | `contracts/connections/v1/module-service.schema.json` | 從作者來源產出 schema/client/vectors，接原治理／release 流程 |
| NEW | `modules/module-connections/service.ts`、`endpoint-policy.ts`、`verification.ts`、`credentials.ts`、`service-command.ts`、`repository.ts` | 封閉 registry/current-state auth／標準 credential profile／network guard；不可新建萬能 credential framework |
| NEW | `apps/platform-api/src/routes/module-connections.ts`、`module-service.ts` | member 控制面與 service data plane 不同 route safety profile／中介層 |
| NEW | `apps/portal-web/src/modules/ModuleConnections.tsx` | tenant scoped external 管理，與 read-only client 區分 |
| NEW | `migrations/<next>_module_connections.sql` | 真實 service backing/principal FK／credential lifecycle／revocation/dedupe，編號實作時定 |
| NEW | `tests/runtime/module-connections.test.ts`、`module-service-authority.test.ts`、`module-endpoint-policy.test.ts`、`tests/e2e/module-connections.spec.ts` | 真實 network／crypto／DB-role／revocation race 與 UI |
| KEEP | `tests/runtime/client-connections.test.ts`、`resource-scopes.test.ts`、`scoped-member-command.test.ts` | 原 credential 和 member replay 不能被擴權；舊 baseline 必須回歸 |

## 4. 資料模型、credential 用途與權威

### 4.1 Registration 與 DeploymentBinding

所有新 API DTO 沿共用 UUID、positive-decimal Version/Epoch、Digest、ContractRef、PolicyRef，採 snake_case；PolicyRef 固定 `{policy_key,version}`，僅引用 server 登記的不可變政策修訂，不接受 caller 自帶 policy 內容。URI tenant/instance 僅選 target，server 查 SP-02 membership／domain ACL。

**ExternalRegistration required：** `registration_id, tenant_id, instance_id, binding_id, endpoint_ref, environment, declared_release_ref, declared_contract_ref, requested_capabilities, accepted_capabilities, state, version, created_at, verification_expires_at, network_policy_ref, compatibility_report_ref, service_principal_ref`。後四個狀態證據在完成前可 nullable；requested 不自動進 accepted。

**EndpointRecord：** `endpoint_id, canonical_origin, base_path, network_policy_ref, allowed_routes, tls_policy_ref, verified_at, verification_expires_at, state, version`。URI 不含 userinfo/query/fragment，不存嵌入 token 的 URL。host/path 變動建立新 endpoint revision，重跑 possession、SSRF、contract check；不以修改 string 沿用既有批准。

**DeploymentBinding** 使用共同字段 `binding_id,tenant_id,instance_id,mode,endpoint_ref,environment,service_principal_ref,contract_ref,state,version`。某 instance/epoch 至多一 active binding 由 SP-04/08 registry 約束；registration verified 不得直接設 active。endpoint 可共用 origin，但不同 tenant/instance 的 ACL／credentials 仍完全分開，不能靠 origin 當 tenant ID。

**ModuleServiceBacking：** `service_id,registration_id,tenant_id,instance_id,environment,status,authorization_revision,created_at`；immutable tuple，FK 到真實 registration 和同 tenant instance。`principals.kind=service` 必須有非空唯一 service backing FK 並禁止 user_ref；沒有 backing 的 service principal 不能建立。服務的 tenant scope 由 SP-02 common/v2 真實 resource_scope 映射，不拿目前 `site` 保留 wire shape 或 dummy person 頂替。

### 4.2 各類 credential 不互換

| 身分類型／材料 | 准許用途 | 永遠不由它推得 |
| --- | --- | --- |
| 會員 session | 本人 tenant 控制面／領域 ACL | 不自動給任意外部服務使用，也不交給外部 HTML |
| 現有 `fw_read_` | 已定 storefront/supplier GET read scopes | 外部 write、export、migration、全站會員、AI／Grant |
| 外部 module credential | 精確 service principal/tenant/instance/audience/environment/capability | 公會管理、人類 impersonation、模型 key、所有 tenant 權限 |
| Endpoint possession challenge | 特定 origin/path 控制證明，短效一次性 | tenant 經營權、writer、程式安全、營收／付款真實 |
| Runtime enrollment／bootstrap | 其原 profile 的登錄／狀態／配對 | Module service／domain write／ExecutionGrant |
| Model connection／provider key | 本人明確選的模型使用 | 平台所有功能、一般人工作業前置、module migration |
| ExecutionGrant | 指定 actor/executor/target/action/effect/expiry | 無界工具、改 tenant 權限、移交 writer或永久 offline 全權 |

**CredentialMetadata required：** `credential_id, service_principal_ref, registration_id, tenant_id, instance_id, binding_id, purpose, audience, environment, capabilities, resource_constraints, credential_generation, authorization_revision, authority_epoch, recovery_generation, issued_at, not_before, expires_at, sender_binding, state, version, replaced_by, revoked_at`。`purpose` 固定受支持 `module_service_access` 或另獨立的 `module_historical_event_replay`；不得二者混用。audience 是單一受控 resource server ID，不能 `*`／按任意 URL 前綴；雙向呼叫分配不同 audience／capability／credential。resource_constraints 以 stable refs／類型限制，不含 SQL。

不可變 identity／purpose／audience/environment；擴 scope、換 instance/key/binding/epoch 必須新 credential、目前明確批准及新 generation。縮 scope 可以同 lifecycle 增 authorization_revision，舊憑證隨即不符；不能僅改前端顯示。credential state `prepared|active|rotating|replaced|revoked|expired`，後三者終態，不 DELETE 後重建同 ID。

secret、private JWK、raw token、refresh token、session、proof 不進 metadata、receipt、journal、outbox、bundle或logs。credentials lookup 使用受限 credential store，不進一般租戶 dataset。若 profile 保存 bearer/token hashes或受保管秘密，沿既有隔離／secret-ingest方式處理，不把model broker profile 原地放寬，也不另發全權key。

### 4.3 Credential profile 與驗權順序

**建議標準 profile，OPEN-10 待安全/相容驗收後定案：** 使用用途分離的短效 OAuth access credential、單一 resource audience、已登錄 service client authentication、sender-constrained proof；sender binding 可採 [RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html)，credential 限權／撤銷要求對照 [OAuth 安全 BCP](https://www.rfc-editor.org/rfc/rfc9700.html)。DPoP 只證明持有對應 key，不能代替 client authentication／tenant 授權；不自行設計簽章演算法或把現有 runtime enrollment proof 當 DPoP。

初版支援集合應只含一個經互通驗證的精確 profile。Implementation 必須在 canonical contract 固定 issuer/audience/profile、token header algorithm allowlist/key ID、claims schema、sender-binding標準及負例，並用現有 `jose`/credential核心整合。若 profile 未定或 verifier 尚未驗收，`service_auth_unavailable`，不能 fallback bearer/member/session。完整 access credential 必須綁本節全部不可變權限 tuple；其 metadata 部分可由 opaque credential lookup 取得，不要求把全部私有資料塞JWT。

**供實作與負例起步的精確候選 profile（非已批准正式設定）：** `module-oauth-dpop-v1`，client authentication 採已批准 service 公鑰的 [RFC 7523 JWT client assertion](https://www.rfc-editor.org/rfc/rfc7523.html)，限定 ES256／P-256、`iss=sub=client_id`、`aud` 精確 token endpoint、`exp`／`iat` 及單次 `jti`；signature 有效仍要查 active client backing。DPoP 使用標準 `typ=dpop+jwt`、`htm,htu,iat,jti`，resource request 再驗 `ath`、server nonce及目前 registered thumbprint；以 `cnf.jkt`／等價 opaque metadata 綁 access credential。不接受 Bearer 降級、重複 proof header、私鑰、動態 key URL。client-assertion jti 與 DPoP replay records 分 namespace，持久保存至接受窗口＋clock skew後；business operation 去重另依 SP-05，不受短 proof TTL 清除。DPoP 不替代 body 完整性：仍依 TLS 與 command payload digest/CAS 保護業務語意。新 verifier 只能共用既有 JOSE/parser/core 的受支持 primitive，不能把現有 bootstrap claims/keys/purpose 直接重解釋。profile 變更須 versioned vectors；沒有對等實作、真實撤銷與跨 restart replay 測試則不掛 service-token route。

每次受保護請求依序：

1. route safety 選擇 service profile；拒 cookie 作 service auth、拒 body 指定 Actor／owner／VerifiedContext；限制 method/content type/bytes。解析 credential／sender proof，不把 header 原文寫 log
2. 驗受信任 issuer/key/profile、audience、purpose、environment、token times、sender key與 HTTP method/URI／proof replay；不能按 token 的 `jku/x5u` 到任意地址抓 key
3. 用 service backing 目前資料取 principal、tenant scope、registration、credential state/generation/revision、binding/epoch與recovery floor；目前 active＋grant/capability 交集成立才建立 server-owned context
4. 在同交易鎖住真實 backing／目前 domain authority與 target。順序和 SP-02/05 統一，與 revoke/rotation/fence 使用一致順序；SQL/receipt/crypto等待後依目前 DB clock 重驗 expiry/revision，不採請求開始時的時間
5. **先 current authority，後 receipt lookup**。同 transport key 異 payload/version/contract/target/binding 身分 409；跨位置/輪替的 business operation_id 由 SP-05 durable effect ledger 去重。JSON receipt或匯入檔不能建立服務權限
6. callback 做本地 domain mutation＋journal/outbox/receipt；外部 I/O 在交易外，dispatch前再驗實際 epoch/grant/floor。response 丟失同operation查；未知外部效果不得假定未發生

對 `module_historical_event_replay` 使用不同的封閉 authorize 分支：仍驗目前 principal/credential/purpose/environment/recovery/replay grant，但 binding/epoch 只允許 SP-08 已 pin 的歷史 tuple及精確 event ID/digest 集合；不能要求它等於目前 writer而丟掉合法遲到事實，也不能讓此分支執行任何新 command。

**撤權線性化：** revoke與寫入都鎖同 credential／authority rows。先取得且已通過最後必要驗權的交易可完成在先事實，revoke commit後新交易／replay 必須拒絕；不能承諾撤銷能取消已提交出貨。對等待跨expiry／scope變更的情況需 barrier tests，不能只測valid signature。

## 5. API、handshake、query、event 與錯誤

Base 為 `/api/v1/tenants/{tenant_id}/instances/{instance_id}`，下列 **proposed**。會員控制 commands 帶原 `Idempotency-Key` 8–128 profile與 `If-Match: "<Version>"`；先身份/tenant/instance ACL，再處理 JSON。異步回共同 `operation{operation_id,state,version,resource_ref?,retry_after_seconds?,problem?}`，state只用共同六值；私有結果no-store。Connection/credential lifecycle operation 使用 tenant-level query；真正 module domain effect 才用 SP-05 instance-level operation route，兩者以 dependency_refs 連結，不建立第二份 operation truth。

| 方法／相對路徑 | 完整 strict input／query | 權限、結果及安全條件 |
| --- | --- | --- |
| `POST /external-registrations` | `{endpoint_url,declared_release_ref,declared_contract_ref,requested_capabilities,network_profile_ref}` | `module.binding.manage`；If-Match instance；202 Operation/ref registration；environment由host定，不讓request override |
| `GET /external-registrations/{registration_id}` | 無body/query | binding管理／目前讀權；`{registration,binding,capability_status,blocking_reasons}`；不含token或private rows |
| `POST /external-registrations/{registration_id}/verify` | `{endpoint_version,declared_contract_ref}` | If-Match registration；202 Operation；只對已受理且SSRF初檢過的 endpoint 發challenge |
| `GET /external-registrations/{registration_id}/challenge` | 無body/query | 同控制人權限；`{challenge_id,verification_path,nonce,expected_response,expires_at}`；公開nonce非bearer，一次性，另驗tenant批准 |
| `POST /external-registrations/{registration_id}/approve` | `{verification_report_ref,accepted_capabilities,resource_constraints,credential_profile_ref,expires_at}` | 目前tenant connection管理／高風險新驗證；If-Match registration；不能超過自己或module能力；202 Operation，僅建立有範圍service backing |
| `POST /external-registrations/{registration_id}/keys` | `{public_jwk,credential_profile_ref}` | 目前管理者；If-Match registration；202 Operation/ref pending credential；只接公鑰，拒任何private JWK字段；必須另完成標準proof與批准 |
| `GET /credentials/{credential_id}` | 無body/query | 目前 `module.connection.manage` 或該service自身的metadata.read；只回 CredentialMetadata／issuance狀態，不回token/key/proof；no-store |
| `POST /credentials/{credential_id}/prove` | `{client_assertion_type,client_assertion}`，使用已批准候選 profile 的標準 client assertion | 只對尚未到期的 prepared credential、固定 prove audience 與已登錄 public key 驗 proof；原子消耗 assertion jti，200 `{key_possession_report_ref,expires_at}`；不發 token、不啟動 writer，沒有通用 service auth 可借用 |
| `POST /credentials/{credential_id}/activate` | `{key_possession_report_ref,approval_ref}` | If-Match credential；參照由受信verifier建立，不能caller聲稱成功；202 Operation；仍不移交writer |
| `POST /credentials/{credential_id}/rotate` | `{replacement_credential_id,overlap_policy_ref}` | 同instance的已批准新key/credential；If-Match current；202 Operation；immutable tuple及範圍檢查，overlap由policy限定 |
| `POST /credentials/{credential_id}/revoke` | `{reason_code}` | If-Match credential；202 Operation；立即增加revision／撤銷；不依endpoint/model健康；相關pending工作依狀態核對 |
| `POST /external-registrations/{registration_id}/disconnect` | `{reason_code,acknowledged_effects_digest}` | If-Match registration；202 Operation；停止平台互通，不能刪外部本地資料；目前writer如何續用依下文 |
| `POST /external-registrations/{registration_id}/reconnect` | `{endpoint_version,declared_contract_ref,requested_capabilities}` | If-Match registration；202 Operation/new verification；舊token/nonce不恢復 |
| `GET /api/v1/tenants/{tenant_id}/operations/{operation_id}` | 無body/query | 目前 `module.operation.read` 與精確 target ACL；token/secret永不經operation receipt取回 |

**Service credential exchange：** 在同base的 `/service-token` 使用profile限定的標準token request；推薦 `application/x-www-form-urlencoded` 固定字段 `{grant_type:"client_credentials",client_id,scope,resource,client_assertion_type:"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",client_assertion}`，拒絕重複／未知字段，`client_id`映射server註冊service、scope只能批准集合子集、resource只能批准audience。既有受限client-auth／sender-proof驗證器完成後才可掛載；不接受cookie／人類password／body `Actor`。成功200標準 `{access_token,token_type:"DPoP",expires_in,scope}`，raw token只在這個no-store、無log的專用途徑一次交付，不寫通用command receipt。不發無界refresh token；新交換每次驗current state/recovery，失去回應由以自身 client-assertion jti 對應的 credential issuance metadata 核對；issuer 不重放 raw token，同一 assertion 重送拒絕且不新發。需要新 exchange 時用新 assertion/jti，先依既有 credential 操作使不確定 issuance 失效，禁止無界並存，不從receipt返回秘密。該途徑不接受現有runtime/bootstrap token。標準profile最終冻结前維持關閉；完整canonical wire vectors是發布必要交付，不以本描述冒充已生成schema。

**Endpoint possession handshake：** server产生nonce/challenge ID/expiry，固定路徑 `/.well-known/freedom-module-verification/{challenge_id}`，以無 credential 的 GET 取 bounded strict JSON `{challenge_id,nonce,registration_id,endpoint_id}`。只在自己 registration 的當前 tuple精確相等、尚未消耗／未到期時，以本地transaction原子消耗並寫verification report。response中多帶tenant/principal/capabilities不授權，schema直接拒unknown。此請求與contract probe都是未授權私有資料的探測，不先送CRM、platform Cookie或任何全權token；最終批准仍需tenant控制人。

**Capability negotiation：** target回`{contract_ref,application_release_ref,supported_capabilities,behavior_profiles}`，為待核實聲明；平台只存與self-pinned release/合同測試相容的交集。每capability回`{capability,state:"compatible|unsupported|incompatible|verification_required",reason_code,required_contract_ref}`；一項不相容只停該项，讀取／匯出／停止／撤銷按其獨立profile保留。不得自動轉未知schema或允許external fork繼承official標籤。

Connection/credential registry 是平台控制面；下列 facts 沿 contracts.md §8 的既有 scoped/platform journal 及 versioned payload，不使用 SP-05 module-native EventEnvelope：`module.connection.verified`、`module.connection.disconnected`、`module.credential.rotated`、`module.credential.revoked`、`module.capability.incompatible`，只含refs、revision、expiry、fixed code。不得捏造 source_instance_id；只有受控 translator 可對已知實際 module target、policy 與 source revision 作通知，亦不把它宣稱為模組原生事實。接收event不能靠它直接啟用credentials；必須回可信registry/current-state查。

| HTTP／code | 意義／恢復 |
| --- | --- |
| 400 `invalid_endpoint`／`invalid_proof`／`invalid_input` | 格式或標準proof不合；不回完整提交URL／token／crypto例外 |
| 401 `authentication_required`／`credential_invalid` | 無效、過期、撤銷或錯issuer/audience/purpose/environment；opaque訊息不洩另一tenant |
| 403 `capability_denied`／`endpoint_policy_denied` | 已知本人資源但scope或網路policy不允许；不可換route迴避 |
| 404 `not_found` | 不可見instance/registration與不存在同形 |
| 409 `idempotency_conflict`／`authority_changed`／`registration_changed` | 同key異body或epoch/endpoint/version變動；重讀且保留原operation |
| 412 `version_conflict`／428 `version_required` | 不覆蓋新scope/key／revocation |
| 422 `contract_incompatible`／`credential_profile_unsupported` | 明列受影響capability/version；不封其他module |
| 429 `quota_exceeded` | 有界Retry-After，network probes不得無限重試 |
| 503 `dependency_unavailable`／`service_auth_unavailable`／`recovery_authority_unavailable` | local已授權功能可保持；需platform authority的新副作用拒絕或真正pending，不fake success |

## 6. 狀態機、撤銷、重啟與結果未知

Registration：`requested -> verifying -> verified -> awaiting_approval -> registered`；`verifying`可`verification_failed`，各非終態可`cancelled|needs_reconciliation`；`registered -> suspended|disconnected`；reconnect回`verifying`且必有新challenge。`active`的writer狀態屬DeploymentBinding/SP-08，不與registration混用。

- possession或compatibility超時無私有副作用，可在原operation退避重試；challenge已過期就新challenge revision，不能延長舊nonce。未知已消耗ACK先查原challenge，不產兩個service backing
- approve/key activation 同交易驗tenant authority、registration version、目前verification deadline與key possession；receipt寫失敗全回滾。expiry在等鎖後已到則拒，不只在request開始驗
- Credential `prepared -> active -> rotating -> replaced`，另可從非終態`revoked|expired`。新credential先受控驗證，rotation使舊credential只能在明確短overlap／原scope內使用；不能用「取latest key」讓旧Grant繼承新key。overlap結束後舊key所有新command／replay拒絕
- revoke先durable置state/revision，再處理outbound pending／cache失效；對平台新驗權立即生效。已提交業務是歷史，不刪除以假装未發生。外部service離線無法立即知道平台撤銷時，不承諾遠端抹除；平台接收端已拒舊key
- 連線已verified但未migrate：disconnect關停此target服務，不影響既有source writer。已是external writer：disconnect停止跨平台API/events/projections及平台的外部寫呼叫，保留binding历史/authority tombstone；**不把writer自動切回舊hosted copy**。純本地授權仍由外部owner治理
- endpoint/DNS/release/key改變，採新revision及必要reverification；不得因health恢复就解除安全suspended。membership/tenant狀態變更重檢批准條件，guild切主力本身不撤tenant所有權
- worker restart從durable verification／credential issuance record續跑，proof replay store／revocations跨重啟存活。process memory的seen-token集合不是唯一防線；同ID異payload拒絕
- current-state/recovery來源不可用時，Stop/Revoke/member查閱控制metadata的安全路徑應保持可用；新的跨平台effect fail closed。先前已dispatch未知不能自動重送，照SP-05/08核對

純本地可繼續不表示平台承認離線期間所有事實：來源一旦有 SP-08 durable local fence 仍禁止該 instance 業務新寫；無法證明遠端 source 已 fenced 時平台不得完成移交。完全自主／斷線本地使用依租戶自己 local ACL，保留新資料；回接時有 epoch／cutoff 衝突的事實需 reconciliation，不能自動宣稱是平台認可的舊 epoch 事件。

**Cache邊界：** schema/capability可有版本cache；write admission、credential revocation、authority epoch/recovery不因cache valid就跳過必要fresh驗證。若正式profile允许短期bounded lease，其最大TTL／過期即拒與撤銷暴露窗須明示、測試且寫入decision log；本初版建議跨平台write每次向当前authority檢查，不設offline write grant。

## 7. UI、可見性、可及性與人工接手

管理頁只顯示本人可管理tenant/instance；會長、operator普通edit、`fw_read_`持有者不能看到私有連線詳情／匯出。功能卡分開「端點已驗證」「契約已相容」「服務憑證可用」「寫入權威已移交」，不合成一個容易誤導的綠燈。

登錄表顯示canonical HTTPS origin、精確scope、環境、到期、資料會到哪裡、local與platform邊界。確認host/path後顯示變更diff；拷貝verification challenge不包含secret。key只接public內容，偵测private fields立即拒收且不記log。憑證交換/保存由受控服務流程；普通Portal不提供可讀model/platform keys的表格。

不相容逐capability顯示原因和支持版本；外部offline顯示最後成功觀察及真正pending operation，不以cached數字當目前庫存。重連、rotate、revoke、disconnect有明確影響：斷平台連線不刪本地業務；target已寫後不能恢复舊hosted版本。

手機有短scope清單與可展開細節；鍵盤可以檢查endpoint、確認、撤銷。敏感範圍確認dialog用完整可讀名稱、focus trap／close後回位，錯誤摘要focus，aria-live只報重要狀態變化。換tenant清理cache與未完成view requests，舊late response不能覆蓋新tenant畫面。

人工支援只拿registration/operation IDs、固定錯誤、policy/release/contract pins、最後可驗證狀態；無token／proof／CRM。人工無法按「忽略TLS/SSRF／force active」解除安全控制；需受授權更新policy/來源並重新驗收。模型不可用不妨礙手動管理、停止或撤銷。

## 8. 可攜、升級、斷線與恢复

- SP-07 bundle帶stable instance/resource refs、contract pin、依賴與reconnect指引；不帶credentials/refresh/session/Grant bearer。匯入歷史connection/receipt視為資料，不能建立live approved backing
- SP-08移交提高authority_epoch、憑證綁新binding/epoch，舊一般write credential撤銷；合法cutoff舊event用獨立purpose、明列event集合的replay授權。原service不能拿正常write token把舊資料當新effect
- 外部fork在支援contract/behavior profile內可用，但不繼承official、付款真實或未知依賴授權。建議只承諾經fixtures支持的當前＋前一個相容tuple；正式退場期限依OPEN-06公告，安全撤銷可立即限制受影響effect
- 版本退場／membership變化不自動刪local資料或撤合法程式授權；平台只停止相應補助/新註冊/API互通等既定範圍。既有可讀/可匯出能力遵明確安全policy，不默認全面鎖死
- 完全disconnect保存最小registry／revocation／epoch tombstone及必要稽核，停止API、event交換、shared catalog刊載/更新與projection收集；按SP-06清中央私有副本。外部自己local auth、檔案、資料庫不接受遠端purge
- 重連新配對、新currently-authorized approval、新credential、新scope/contract驗證；若外部離線期間資料前進，先SP-05 reconciliation（IDs、sequence、未完成operations、共享policy），不能復活舊token或回放超窗操作
- restore舊DB前先fence所有dispatch；從獨立recovery authority取得目前generation、revocations、binding/epoch floor／deletion tombstones，之後逐credential/grant/operation核對。`apps/credential-broker/src/recovery.ts`現有generation機制是可復用的有限基線，不代表module-specific floor已存在
- `fw_read_`舊路徑維持原purpose/route/receipt與GET-only；不重新解釋舊scope成module capability。舊client缺新必要字段／標準profile時清楚upgrade-required；不能返回success並丟tenant/epoch語意

## 9. 威脅模型、網路／瀏覽器邊界、秘密及容量

### 9.1 受限 egress，非會員 URL proxy

以下是本案的應用profile要求；測試來源可參照 [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)。只在註冊時驗URL不夠，真正connect以及redirect都必須守相同策略。

1. 只允許 HTTPS；初版建議443、無userinfo/query/fragment、無raw IP literal／不明port、host正規化IDNA後按exact allowlist。拒alternate numeric IPv4、percent-encoded host、backslash、控制字符、混淆parse、`file:|gopher:|data:|ftp:`及Unix socket。輸入長度先有界
2. 以受信resolver解析全部A/AAAA及CNAME結果；任一非允許目的即拒，不能只挑一個public結果。拒loopback、private、link-local、multicast、reserved、IPv4-mapped IPv6、cloud metadata與平台內部service地址；禁用搜索suffix推導內網主機
3. 每個連線及retry重新解析／驗addresses，將實際dial鎖到驗證過IP並核對peer IP；TLS SNI/Host仍為原canonical hostname、驗chain/hostname/expiry，拒自簽／降TLS驗證。若runtime無法保證DNS-to-connect或由可信egress gateway強制，該runtime不可執行外部fetch
4. 初版建議redirect=0；收到3xx報需變更endpoint再驗，不自動把token傳別host。未來若開redirect，逐hop重驗scheme/origin/path/DNS/IP/TLS/bytes/total deadline，跨origin不帶authorization/cookie；數量上限以policy固定
5. 路徑只用已驗base_path＋contract registry內的固定route/template；resource IDs型別驗證且安全編碼。body不得傳「代抓url」欄位；health／possession probe永不帶平台session/secret或未批准業務資料
6. 限制response headers、body的**實際**bytes、decompressed bytes/ratio、connect/first-byte/overall時間及併發；Content-Length僅提示。拒無界chunk stream、壓縮炸彈、過深JSON、duplicate keys、意外content-type；timeout後關連線與取消reader
7. egress network policy作第二層阻擋內網／metadata，不單靠字串比對；互通私網如果確有需求，只能另有明確部署/host批准與專用非公開profile，不能由會員要求任意allowprivate

### 9.2 瀏覽器與不可信內容

任意會員HTML/JavaScript不能在擁有平台登入權的origin執行。hosted公開店面採受限content/template與固定assets；深度客製使用獨立origin，平台session cookie使用host-only／安全旗標，不設可被任意子域腳本共享的Domain。外部後台不拿平台cookie；跨origin redirect/return_url採註冊exact allowlist、一次state/nonce與目的檢查，不容open redirect。

若嵌iframe則獨立origin＋最小sandbox／permissions，不能給能逃逸的same-origin/script組合；postMessage驗exact origin/source/message schema與correlation，不接受`*`。CORS允許必要origin/method/headers、不允許任意origin帶credentials；XSS/CSP/output escaping依現有shell安全流程驗收。API machine route不是取消整站CSRF/Origin的理由。

README、skill、外部data、模型輸出和endpoint error都是不可信内容，不能指示讀secret、更改policy、接受新scope或替其他tenant執行。signed payload也只有其授權purpose，不升格成系統指令。

### 9.3 成本、容量及秘密處理

建議profile（OPEN-05/10/16待定）：每tenant最多5個pending verification、每instance一個probe、每tenant同時2個egress requests；connect 3秒、overall 10秒、headers 32KiB、handshake/health JSON 64KiB、一般JSON response 1MiB、DNS answers最多16、redirect 0。大型bundle沿SP-07獨立chunk/streamingprofile，不放寬普通API。超限立即中止stream，有限backoff不拖垮其他tenant。

credential建議access TTL 5分鐘、key-possession／endpoint challenge 5分鐘、rotation overlap最多5分鐘；這些是測試起點，不能假稱正式SLA。有效期限取credential、grant、registration、recovery observation最早值；任何未配置的security profile拒發新憑證。retry建議共用≤12次/24h，offline replay≤7天、完整receipt/inbox至少30天，最小去重tombstone按SP-05保存；過窗須reconciliation不能以新ID盲重做。

tenant-facing rate limit按principal/tenant/instance分配，另有global safety ceiling防多tenant淹沒；限流結果不能洩其他tenant資料。容量未定不等無限；標準challenge／失敗可能發生遠端請求但不傳私有業務data，仍受evidence與cost budget。秘密只進受限server/credentialhost記憶體，authorization/proof headers、URLs中token、payload敏感字段從proxy/WAF/traces/metrics中排除；正式啟用前要驗真的logging設定而非只測應用logger。

## 10. Fixtures、驗收、發布gate與未完成項目

全部新增能力／下列測試 **not_run、待實作與待驗收**。本文閱讀了實際source及上列官方安全文件，不代替外部部署、真人授權或正式測試。

**Fixture：** tenant A owner/admin/operator、tenant B owner、A非owner會長；合法source/target獨立程序、獨立DB/DML-onlyroles；可控DNS/resolver/egress/TLS測試server；合成key且實際crypto驗證；外部recovery store不隨DB snapshot回退。提供兩個compatible contract tuples、一個不相容capability、revoked/expired/wrong-purpose/wrong-audience/wrong-environment keys、同ID異payloadevents、合法cutofflateevent。

| T-ID | 前置／步驟／fault injection | 預期及必交evidence |
| --- | --- | --- |
| T-036 | target只支持部分capability；schema/version/behavior不相容；fork自稱official | 不相容capability明確拒絕；其他模組/read/export/revoke可用；兼容矩陣和fixturediff，沒有假official |
| T-048 | B／會長／普通operator註冊A；外部控制hostname卻無tenant權；合法owner完整challenge | unauthorized無新binding/credential；possession僅驗endpoint；有權registration仍不改writer |
| T-048網路 | private/loopback/metadata/IPv6/alternateIPv4、public→privateDNSrebinding、mixedanswers、TLSwronghost、redirecttointernal、slow/huge/gzipbomb | 在真實transport確認沒有禁區connect／cookie/token泄漏；限制memory/time/bytes；runtime無peer-pin能力拒profile |
| T-049 | 正常servicecommand後撤權、rotation、membership降權；replay原successreceipt；等鎖跨expiry／revocation；wrongaud/env/instance/purpose | current auth先於receipt；舊key無擴權；合法先提交效果保留；新交易拒絕；記多connection barrier順序 |
| T-049標準profile | token正確但錯senderkey、重用proof、method/URI變更、過期nonce、未知jku／算法；client-auth缺失 | 真實verifier拒絕、無副作用；不能用DPoP代clientauth；原bootstrap／fw_read_全拒modulewrite |
| T-050 | 切斷platform/authority、外部仍在線；本地寫一筆後嘗試跨平台reserve；disconnect再reconnect | 本地依localACL可繼續；跨平台真實pending/denied，不伪成功；不刪local資料；重連新approval/key並先核對offlinefacts |
| T-043／T-044／T-047 | authority切換／ACK丟失／restore舊DB及credentialbackup | 舊epoch/floor拒新effects；合法歷史依exactcutoff/replay權；來源不復活，unknown有持久對帳記錄 |
| T-039／T-040 | bundle/receipt/日志插rawtoken／privateJWK／惡意redirect；import歷史credential | denylist/allowlist及實際logscan無秘密；import不建livegrant；沒有腳本執行或任意fetch |
| T-007／T-015／T-022 | 公會長、operator、B猜registration/operationID；使用servicecredential呼guild/admin/export | 後端拒絕且no-store/非披露404；私有payload/舊receipt不泄漏 |
| T-029–035 | 同fixture走hosted/external，故障/duplicate/outoforder/unknown | 業務語意一致；currentserviceauth不取代domainACL；stableoperation去重與reconciliation成立 |
| T-051／T-056 | 未有模型connection的人做一般表單；servicekey要求model／官方標籤 | 人工可用；無本人模型／精確Grant時AI拒絕；key不跨用途、fork不自封官方 |
| T-058 | A慢endpoint／rateflood／大量timeout，B正常；proxy/WAF收集開啟 | A被有界隔離；B延遲在測試profile；真實sink無authorization／privatepayload；報peakRSS/bytes/time/socket清理 |
| T-055協作 | 手機/鍵盤完整register/revoke/disconnect；tenantA→B後Aresponse晚到 | focus/progress正確；不顯示A資料；沒綠燈混淆possession與writer |

**正式gate：** common/v2真實tenant/servicebacking FK與最低DBrole；canonicalcredentialprofile及標準wirevectors；真人approval與machinecurrent-statevalidator；既有core被實際呼叫；networkpeer/DNS/TLS/redirect負例；credentialrevocation/rotation/receipt競態；恢復floor與T-050斷線自主性；跨程序可重現合同一致；正式policy／TTL／retention／capability退場已記decisionlog。任一未達標只保留安全read/spec/測試能力，machinewrites保持關閉。

後續實作須跑既有`npm test`、`npm run test:contracts`、`npm run test:repos`與新負例；有UI依repo指示先build後E2E。每項報source/head、installedpolicy、network/runtime、fixture、真實commands/results和not_run原因。連回UF CORE、runtime enrollment、credentialbroker／EXEC-OPSledger；未知細項標unmapped，不宣稱它們因本規格完成。本文不新增正式key、不註冊外部endpoint、不動平台權限或部署。
