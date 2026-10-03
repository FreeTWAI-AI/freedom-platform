# 隔離 broker 認證橋與單步執行

本 profile 延續 [18 的憑證保管](18-credential-broker-core.md)、
[16 的 ModelStep／私人 Result](16-private-model-step.md) 與
[17 的會員 HTTP](17-private-ai-product.md)。這一批固定主 API／broker 的
程序邊界；正式服務、直接秘密輸入及原始產品驗收仍須另外完成。

## 真正的程序邊界

主 API 只持本人 cookie／CSRF 邊界、命令簽章私鑰及固定 broker 回應公鑰。
它使用普通 app SQL role，不能讀寫 vault ciphertext／wrapped DEK。
`createModelBrokerClient` 是 WeakMap 註冊的 server port，安裝時精確綁定
pool、origin、environment 與 client。呼叫者 JSON、另一個 pool 或相同內容的
物件不能代替這個 port。product assembly 明選 local host 或 broker port；
兩者不得同時設定，不提供自動 fallback。

Broker 內保留原本的 host、Step service、runner、Result finalizer 及
Asset lifecycle。opaque verified binding／capability／observation 只存在於
同一個 broker host instance，不序列化或從歷史 SQL JSON 重鑄。Cipher pool
與 execution pool 使用不同專用 roles；execution role 不具 vault 權限。
這是主 API 與 broker 的程序隔離，不宣稱 broker 內不同 pools 能防惡意程式。

## 用途分離的命令

中央 [contract](../../../../contracts/execution/v2/model-broker-bridge.ts)
只容許 activation／execution 的 bounded refs 與 CAS。RPC request 僅為
`authorizationRef`、`nonce`、compact signed assertion。沒有 Actor、cookie、
session hash、secret、ciphertext、provider URL、prompt、tool 或 opaque proof。

Assertion 固定 Ed25519／EdDSA、strict protected header、pinned kid 與 public
key。profile、issuer、audience、environment、client、operation、purpose、
authorizationRef、nonce、canonical command SHA-256、recovery generation 及
issuedAt／expiresAt 全部必須符合 SQL 中原始 statement。Activation 與 execution
用途分別為 `model-broker.activate`、`model-broker.execute`。Request 最長
60 秒，並受原始本人 session、credential、approval、Grant、connection、family
及 Step deadline 的較早期限限制；沒有到期寬限。時間使用毫秒精度。

Response 使用不同的簽章方向、issuer／audience 與
`model-broker.response` purpose，最長 10 秒。Factory 以真實 crypto 驗證
request／response 不是同一對金鑰，不能只換 kid。compact segments 必須是
canonical base64url；JSON 拒絕 duplicate keys、未知欄位與過量 bytes／depth／nodes。
Wire 回應只含經驗證的 safe Step metadata 或固定 problem code，
`operational_authority:false`。主 API 重驗方向、nonce、ref、digest、generation
及期限後，從當前本人 SQL 重讀 metadata；回應不能製造 Step、Result 或執行權。

## 原始本人 session 與一次性 admission

暫定 [096 migration](../../../../migrations/096_model_broker_authorizations.sql)
新增不可變的命令授權列。主 API 完成真正會員認證後，在既有 scoped command
交易中保存 original session hash、本人 user／person／personal scope、exact target、
command digest、CAS、credential pin、nonce hash、recovery 與期限。新的 session
不能取代原始 session；原始 session 撤銷／到期、scope 關閉、family／connection／
runtime／model／credential 終止或 generation 改變時，授權即不可用。

Broker 先驗真實簽章，再鎖 SQL authorization。`accepted_at` 只可從 null 設定
一次；immutable statement、nonce、digest 與原始本人 backing 必須全部一致。
第一次 claim 檢查命令的初始 CAS；domain service 繼續管理各階段 CAS、lease、
Work version 與 control epoch。不能在 begin／record／Result 自己推進版本後，
仍拿 initial version 擋住合法的下一階段。同一個 HTTP key 重試回到原始 authorizationRef／nonce；server 產生的新 nonce
不改變語意 command digest，也不重新 admission。已接受的重送只允許目前本人 metadata，
不得重送 provider。Claim commit／ACK 遺失後仍視為已消耗，不重新派送。

Actor 只由這筆已驗證 SQL 的原始 session 導出，不能由 wire 反序列化；
invocation 為 factory-bound WeakMap handle，偽造物件／另一 factory handle 拒絕。
外部 signed recovery state 與獨立 floor 每次保持 current；沒有 generation=1
fallback，也不把不同來源的讀取宣稱為原子 snapshot。

## 最後效果寫入的重驗

`ModelStepInvocationGuard(q)` 是額外的 server-only authority check，capture
後傳入 activation、begin、context、record、runner 與 Result finalizer。它使用
真正正在提交的 PoolClient，不另開巢狀交易或改用全域 current Actor。原始本人、
domain、policy、CAS 及 opaque observation checks 全部保留。

Guard 在初始讀取、activation／begin 的最後 receipt decision、provider POST
前、context 交付前、record 的最後 SQL decision，以及 Asset prepare／claim／write 各階段最後 receipt、真正
Result INSERT／Work CAS／最後 receipt SQL 之後重驗 current authority。
模型儲存 adapter 在 representation／hash 等待之後，真正 ObjectStore PUT／HEAD／
GET 呼叫前再查原始 Step／policy／invocation；模型路徑不容許 delete。
SQL 等待跨過 session／authorization deadline 時整筆交易回滾，不能靠外層
「簽章仍有效」或原始 callback 開始時的 clock 放行。

Broker invocation 的 SQL deadline 另封存在私有 WeakMap，以 wall／monotonic
clock 共同檢查，begin permit 不晚於命令期限。provider 前與 storage 前在 SQL
交易返回後再做同步 deadline fence，避免 COMMIT 回應等待跨期後新增外部呼叫。
這不宣稱分散式來源與 SQL COMMIT 能形成原子時間判斷。

主 API exchange 使用 45 秒總 budget 與 monotonic/cancelled fence；timeout
後完成的 recovery／signing 不可再開始 exchange。已開始的 RPC／provider effect
可能繼續完成，主 API 不自動重送；會員從既有 owner read/control 取得實際結果。
失去回應不宣稱 provider 沒有執行。owner read／Stop／歷史控制仍沿原來權限，
不依賴 KEK／provider／recovery 健康來讀取或撤銷自己的歷史紀錄。

## Registry 與重啟

Broker registry 精確綁定 environment、client、原始 session identity、immutable
model/version、credential/generation。最多 128 bundles 與 128 retained Step／ACK
refs，依 session、credential 與 Step 期限清理；await 前預留容量以免併發超量。
Activation 和 execute 使用同一 bundle 中的原始 host/service proofs Map。
另一 replica、重啟或 proof registry miss 必須 unavailable／unknown；不能從
SQL verified_binding 重新 mint proof、靜默重新驗證或另發一個 POST。

## SQL roles 與尚未安裝的服務

[20 app grants](../../../../deploy/cloudflare/sql/20-runtime-grants.psql) 清除新
authorization 的舊 table／column ACL，僅容許 SELECT／INSERT。ordinary app
仍無 cipher 權限。authorization 不是會員公開 metadata；session hash 不輸出。
[40 cipher grants](../../../../deploy/cloudflare/sql/40-credential-broker-grants.psql)
與 [45 execution grants](../../../../deploy/cloudflare/sql/45-model-broker-execution-grants.psql)
逐表／column 保留原始 invoker／trigger 語意；不得使用 superuser、bypass RLS、
role membership／SET ROLE、schema CREATE 或廣泛 domain DML 代替最小權限。
Role guard 同時拒絕 PUBLIC／inherited／舊 column ACL 的額外權限。

本機 process RPC listener 固定 numeric loopback origin 與單一 internal route；
request host／method／headers／stream budget 經驗證。這個 listener 不是正式公開
入口，不將 localhost 認成 production authentication。Node-only provider host
不能直接宣稱 Worker／Hyperdrive 可用；正式 private service identity、TLS、
request capture off、KEK custody／rotation、獨立 recovery floor、provider budget、
R2 prefix／retention、restore fencing 與可信發布證據尚須實測及安装。

## 驗證及下一個產品接點

本機實測使用自己建立／移除的 PostgreSQL 18 schemas、普通 app／cipher／executor
roles、真正 ES256 device pairing／refresh、真正 Ed25519 assertion／response／
external recovery，以及真實 AES-GCM 合成 key。Main／broker 為不同 child
process，main 沒有 provider secret／KEK／cipher pool；唯一 provider socket 發出者
是 broker。filesystem ObjectStore 保存實際 bytes，沿本人 Result ACL 讀取。

反例涵蓋簽章／statement injection、原始 session／scope／floor 撤銷、併發重送、
lost ACK／response tamper、wrong replica／restart、最後 Result INSERT 真實 SQL
等待跨過期限，以及 timeout 後不可新增 exchange。實際結果與 source SHA
記在 [交付紀錄](implementation-status.md)，本文件不預先宣稱測試通過。

合成 credential 由 test-only broker IPC seed 真 vault；這不代表會員 secret
ingest 已完成。下一批接直接 broker 的 one-use secret ingest、本人 cookie／CSRF
setup、capture off、明選 provider/model／credential 的設定與驗證。其後續做
原計畫的 native host、機器 execution auth、heartbeat／reconciliation、多步、
媒體、跨端、restore、legacy removal 與可信 CI／發布，不以這個工程閉環提前部署。
