# 直接 broker 憑證輸入

版本 `0.1-draft`，2026-10-03。延續 [18](18-credential-broker-core.md) 的 vault／store
及 [19](19-authenticated-broker-bridge.md) 的原本人 session／recovery fence。
對應 AP P-04/P-17/P-20/P-24/P-31、AUTH-11/14/15、OPS-01/02/04/07、
EXT-11/12 與 UF INT-18/25、GOV-29/30。本 spec 是實作契約，尚非安裝或產品 PASS。

## 主站只簽 metadata

會員先明確選擇 immutable BYOK ModelConnection；只能 `platform_vault` custody，
provider 固定 openai／anthropic、model／environment／client／runtime 已由原服務
驗證。`POST /api/v1/me/credential-ingests` 經本人 cookie、constant-time CSRF、
onboarding、exact origin／Host、限流及 bounded JSON，body 只接受 create／rotate
參照與明確 `consent:true`。Idempotency-Key 和 primary If-Match 只在 header；
rotation replacement model 的 secondary CAS 是 body metadata。不能提供 key bytes、
ciphertext、Actor、owner/session、provider URL、readiness 或「已驗證」聲明。

主站使用用途獨立的 pinned Ed25519 ingest 私鑰簽短效 bootstrap。claims 固定
`credential-broker.ingest-bootstrap`、issuer/audience、exact setup origin、environment／
client、authorizationRef、nonce、semantic digest、operation、recovery generation、
issuedAt／expiresAt，最長 60 秒並受原 session／backing／external floor 限制。
嚴格 compact／duplicate JSON／bytes／depth／nodes；不得從 JWK/JWT header 自選 key。
execution activate／execute assertion 不能在此接受。broker 回應方向使用不同實際
金鑰與 purpose `credential-broker.ingest-response`，不是只改 kid。

同本人原 session 的同 key 重試只回原 assertion/ref/nonce；更改 semantics 拒絕。
簽章後再次檢查原當前 SQL 授權與期限，不讓 await 的晚到結果交付。主站 production
組裝沒有 vault／KEK／cipher pool／provider endpoint；秘密不經主站代理或 JSON。

## 真正瀏覽器 handoff

主站與 broker 使用**不同 cookie hostname**及 HTTPS；不同 port 不隔離 cookie。
瀏覽器以 top-level POST 到 pinned broker `/credential-setup`，使用
`application/x-www-form-urlencoded`，恰好一個 `assertion` field，無 query/fragment。
compact JWS 已包含 ref／nonce。拒絕重複 field、非 canonical encoding、過大 body、
錯誤 Origin；只接受 main Origin 的 navigation/document handoff profile，Fetch-Site
可為 same-site 或 cross-site（不同 hostname），不可為 same-origin／none。
不依賴第三方 credentialed fetch、CORS、redirect 或 broker cookie 已存在。
不同 host 的真實 Secure／SameSite 行為必須由瀏覽器驗證；Node 手填 cookie 不是證據。

broker 驗 pinned signature、當前 SQL 及 protected-surface readiness 後，一次 claim
bootstrap，設獨立 random `__Host-fp_broker_setup` cookie：Secure、HttpOnly、
SameSite=Strict、Path=/、無 Domain；另產生新的 CSRF token，只留 broker document。
cookie／CSRF hashes 留 SQL，原 main raw cookie／session hash 不傳 broker browser。
bootstrap replay 不重發 cookie；舊 broker cookie 只能被新已驗證流程覆蓋，不能
作為 bootstrap authority。metadata、assertion 或 secret 不放 URL/history/referrer。

保護頁需明示 exact provider/model、平台加密保管、remote processing、create／
replacement rotation 及舊 Grant／Step 影響。金鑰欄 password/autocomplete off；
無 telemetry、capture hook、browser storage、raw error 或外部 resources。
頁面 CSP 只允許同源 script/style/connect/form；frame/base/default 都拒絕，
no-store/no-referrer/nosniff。DOM 標記不是 capture 關閉證據。

## 在提交時準備真正 intent

bootstrap 以 SQL 保留 cookie／CSRF hashes 與原 session 授權，最長到原 60 秒期限。
每個 isolate 的 128 個 setup reservation 只限制本地 admission，不再是跨請求 authority。
每次請求用 cookie hash 查找唯一 SQL claim，重新檢查原 session／recovery，產生本地
opaque Invocation；不反序列化 Actor 或 WeakMap capability。不在 bootstrap 開始 write budget。
本人輸入 key 並明確同意後，broker 同源 `POST /credential-setup/prepare` 只接受
`{consent:true}`，需要 cookie／`X-FP-Broker-CSRF`、exact Origin/Host 及 current authority。
原 `store.prepareCreate/prepareRotate` 驗證後，migration 114 的 append-only
`credential_ingest_preparations` 記錄一次性 deadline；30 秒從 prepare 的 genuine intent
SQL 時鐘開始。submit 在同一 deadline 內重新建立 genuine store intent，再用原 SQL
submission claim 消耗一次權限，之後才讀 secret。navigation、await、replica、restart
均不能延長 deadline，重複 prepare／已消耗 submission 不可重播。

secret 直接 `POST /credential-setup/secret`：同源 cookie/CSRF，
`application/octet-stream`，exact declared/actual length，1–4096 bytes，最多 128 chunks，
讀取最長 5 秒並受原 authorization/intent deadline 限制。只接受 ASCII
`[A-Za-z0-9._-]`，不 trim／normalize；拒絕 JSON、multipart、Content-Encoding、
query、machine credentials、未知 headers/redirect。before application stream pull，
完成 current SQL／recovery／readiness／consent／CAS 檢查，並一次 commit submission
claim。header/current/claim 拒絕時不 drain secret；native adapter 延後 body reader，
不能提前 `Readable.toWeb` 或 `incoming.resume()`。這不宣稱 OS/edge 未收到 bytes。

owned buffer 只交原 `vault.seal(binding, bytes)` 和 `store.commit(actor,intent,sealed)`；
不另造 encryption、rotation、intent 或 sealed provenance。每個 await 使用 wall clock、
monotonic/cancelled fences；晚到 read/chunk/crypto/SQL delivery 必須清除 owned bytes。
finally 清除原/copy buffers、DOM key 值，不宣稱可證明 JS strings／clipboard／
任意第三方 extensions 的記憶體抹除。無自動重送或重新取得 write permit。

## SQL 及最後 sink

暫用 migration 097 新建 purpose-specific immutable authorization（需掃描確認編號）；
076–096 不改。欄位固定原 owner/principal/personal scope/session、typed command/key/
digest、model/runtime/connection/family 及 expiry、rotation old pin／replacement refs、
nonce/assertion/recovery。monotonic transitions：issue → bootstrap claim（cookie/CSRF
hash、setup expiry）→ submission claim（genuine planned credential/binding/write expiry）
→ 同 store transaction 的 commit metadata。bootstrap/submission 各一次；失敗仍
消耗已 committed claim，不 reset、extend、delete 或 reconstruct opaque handle。

store optional server-only guard 捕獲 immutable function，同 `PoolClient` 在 prepare／
commit 原 validator 後、cipher/index/journal/receipt 最後 sink 及 scopedMemberCommand
第五 revalidation callback 檢查。最後 SQL clock 必須在 external recovery 等待後
重新讀；body/crypto 不持長 SQL 交易。create/rotation 原 CAS、selection/consent、
session/scope/backing/provenance guard 均保留。rotation final guard 只能接受這個
genuine intent 的 exact replacement credential/binding、old credential rotated/version+1
及 old model revoked/version+1；不能要求已合法改變的舊 active CAS，也不能接受
任意歷史 rotated 列。Result／模型執行既有 authority 不因 ingest 成功而放寬。
097 另以 deferred whole-state constraint 在真正 SQL COMMIT 檢查 exclusive
authorization/setup/write clock、原 session／owner／scope／backing 與 exact replacement，
擋住最後 session-clock driver 結果等待跨過較短 command 期限的交易。外部 recovery
仍是最新有界觀測，沒有宣稱與 SQL COMMIT 或網路交付原子一致。

app SQL role 可 issue/read，不能 update claim 或讀 ciphertext；cipher broker role
只有必要 transition columns 及原 store privileges；executor 不得碰 ingest authority
或 ciphertext。實際檢查 table/column/PUBLIC、grant-option、membership/SET ROLE，
不引入 SECURITY DEFINER 或 superuser bypass。SQL JSON CHECK 明確拒絕 null 三值漏洞。

ACK 遺失或逾時保留 unknown；restart／replica 可延續未消耗且仍有效的 SQL setup，
不重播已接受 submission。遺失 cookie／CSRF、期限過期或原授權撤銷仍需新明確授權。
`GET /api/v1/me/credential-ingests/:ref` 只回當前本人 safe outcome／credential metadata，
不依賴 KEK/recovery/provider 健康，不重發 cookie/intent/body permission。success 只
代表加密 custody committed；ModelConnection 仍 unverified，metadata
`operational_authority:false`，不推定 provider 登入、額度或 inference 許可。

## 必要 ports 與驗證範圍

protected-surface readiness 是固定 origin 的 server-only trusted installed adapter，
每次 render/prepare/body 前以有界最新觀測證明必要 proxy/WAF/APM/logger/analytics／
protected browser/native capture 已關閉或停止。沒有 port、逾時、過期、來源不符
即 unavailable，且在 key DOM/application pull 前拒絕。測試 spy/本機 callback 只
提供合成 readiness；CSP、空 logger 或布林 DTO 不等於正式來源證據。

本機測試需真正 login/cookie/CSRF、AES-GCM/Ed25519、獨立 SQL roles/recovery/floor、
兩程序，秘密只由 test parent 直接傳 broker，不再 seed IPC 或 main entry 的 key
常數。保留 ingest → original host → 一次 provider POST → Asset/Result/owner read
閉環；counterexamples 實測 purpose/origin/session/CAS、並發輸入、跨 process setup／restart、
late read/seal/最後 SQL 等待、rotation rollback、floor advance、zero application pull
與 actual buffers 清零。main/log/receipt/audit/storage 不得含合成 sentinel 或編碼。

正式 Worker/service binding/Hyperdrive/R2、KEK/不同方向 keys provisioning、外部 durable
floor、capture-disabled 操作證據、真人 provider/native/跨端、備份 restore、migration
及可信 CI/publisher 仍另驗。原始 168 項 complete product acceptance 不能因本機
組件通過改 PASS。完成原 scope 後受控 forward migration，沒有提早發布承諾；
staging/live/真實秘密及等待中的 PR 均不在本批操作範圍。
