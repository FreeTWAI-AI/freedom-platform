# 本人執行前置紀錄的封閉 HTTP 邊界

本批接線 [Run](04-execution-adapters-release.md) 與
[模型選擇、限定同意及 blocked Attempt](13-member-execution-prerequisites.md)。
沿用 U1/U3 與 AP M2/M3，不改原計畫的完成條件。
[中央 wire 契約](../../../../contracts/execution/v1/member-execution-http.ts)
只定義本人紀錄管理；[Hono factory](../../../../apps/platform-api/src/routes/member-execution-http.ts)
未掛入正式 app、Node server 或 Worker。所有成功 metadata 保留
`operational_authority:false`。沒有模型呼叫、lease、dispatch 或私人 AI Result。

## 信任設定與真人邊界

`createMemberExecutionHttpTransport(pool, {origin, environment, clientId,
sourceNetwork?, grantTtlSeconds?})` 使用可信 server configuration。
Configuration 必須是有界、嚴格的 own data properties；來源、environment/client
及 TTL 不由 HTTP JSON、query 或轉送標頭指定。不允許 caller 注入 Actor、
認證 callback、service、provider、key 或 policy。TTL 沿用 1–3600 秒上限。

已辨識入口先驗精確 URL authority／Host、method、來源、credential kind 與
標頭，再提交獨立限流 charge；真人 session、CSRF 及 onboarding 檢查通過後
才讀 JSON body。`memberBoundary` 依可信 origin 選擇真實的
`__Host-freedom_session`（HTTPS）或 `freedom_local_session`（local loopback HTTP），
拒絕同名重複 Cookie，再取 Actor 並覆蓋預注入資料。HTTPS 不接受舊名稱。
服務仍在同一 DB transaction 重驗 user/session、
person、personal scope、ownership 與目前 backing；HTTP 驗證不取代 domain
checks。Bearer、DPoP 及 bootstrap token 不能當真人憑證，與 cookie 混用亦拒絕。

Origin 是一個固定 canonical HTTPS origin；只有 local 的明確 loopback 可使用
HTTP。URL 不接受 query、fragment、percent
encoding、backslash、控制字元或非 canonical authority；Host 若存在須精確相等。
Forwarded／X-Forwarded-Host 不選擇信任來源。POST 必須有完全相同 Origin；
GET 的 Origin 若存在亦須相同。Sec-Fetch-Site 若存在只能 same-origin。
HEAD、OPTIONS 及其他不符 method 的請求明確 405，不利用 Hono HEAD fallback。
未知路徑只有通用 404，不暴露私人紀錄。

## 固定入口及版本來源

下表路徑全部以 `/api/v1/me` 為前綴；沒有 list、execute、resume 或模型測試入口。

| Method／path | JSON body | If-Match 的實體 | 結果 |
| --- | --- | --- | --- |
| POST `/execution-runs` | workId | Work | 201，created Run |
| GET `/execution-runs/:runId` | 無 | 無 | 200，本人 Run |
| POST `/execution-runs/:runId:pause` | `{}` | Run | 200，paused 與新的 fences |
| POST `/execution-runs/:runId:stop` | `{}` | Run | 200，cancelled 與新的 fences |
| POST `/model-connections` | connectionId、selection | AgentConnection | 201，unverified 模型選擇 |
| GET `/model-connections/:id` | 無 | 無 | 200，本人選擇紀錄 |
| POST `/model-connections/:id:revoke` | `{}` | ModelConnection | 200，revoked |
| POST `/execution-runs/:runId/grants` | expectedWorkVersion、connectionId、expectedConnectionVersion、modelConnectionId、expectedModelVersion、consent:true | Run | 201，限定同意紀錄 |
| GET `/execution-grants/:id` | 無 | 無 | 200，本人同意紀錄 |
| POST `/execution-grants/:id:revoke` | `{}` | Grant | 200，revoked |
| POST `/execution-runs/:runId/attempts` | grantId、expectedGrantVersion | Run | 201，preflight_blocked |
| GET `/execution-attempts/:id` | 無 | 無 | 200，不可變歷史 |

每項 POST 都從 `Idempotency-Key` 取得 8–128 位 ASCII key；不接受 body key。
`If-Match` 只接受 strong quoted、正整數 signed-64 decimal version；缺少為
428，weak／wildcard／multiple／溢位為 400，真正 stale CAS 沿服務回 412。
次要 expected versions 必須存在 body，中央 Zod 與 generated JSON Schema
使用相同 signed-64 grammar。Path ID、key 及主 version 由 transport 組合，
不能由 body 覆寫。沒有 Number 版本、TTL、Actor、owner、scope、policy、
credentials、provider URL、modelReady、inferenceRef 或 operational permit 欄位。
所有 body 與 nested selection 都嚴格拒絕未知欄位。

Run／ModelConnection／Grant 成功回覆 ETag 為 quoted aggregateVersion；
Attempt 沒有假的 aggregate version，回覆沒有 ETag。GET 不收 body、command
key 或 If-Match；條件快取／Range 標頭明確拒絕，不以 304／206 略過授權。
所有成功與錯誤回覆為 private/no-store，無公開 CORS，包含 nosniff、noindex、
no-referrer 及 same-origin resource policy。錯誤只回固定 allowlist code 與通用
detail；不輸出 SQL、session、模型輸出、Work 文本或 caller 原始錯誤。

## Body、限流與交易

共用 bounded JSON reader 保留 bootstrap 的安全邊界：32,768 實際 bytes、
128 chunks、5 秒 deadline、fatal UTF-8、bounded JSON 深度與每層 duplicate／
escaped duplicate／prototype key 拒絕。Content-Length 不能取代 actual bytes
計量且須與實際一致；不接受 Content-Encoding。Abort、timeout 及讀取失敗
會釋放 reader，取消 hostile source 不等待其永不完成的 cancellation promise。
未通過真人／用途／CSRF 的請求不先消耗私人 body stream。

獨立 `execution_member` bucket 沿用實際 PostgreSQL committed abuse charge，
每 environment/client/network 每分鐘 60 次，global 600 次；先 global 後 network。
Source network 來自可信 host callback，缺少時共用保守 bucket，不相信 caller
標頭。只存 domain-separated digest，沒有 raw network、cookie 或模型秘密。
Domain command 拒絕／回滾不回退 charge；限流回 429 與 Retry-After 60，
limiter unavailable 時不執行 command。

Transport 只呼叫既有 Run／prerequisite services。同 key replay 仍依既有
目前 owner/session/backing/policy 的規則重驗；Work 改版、Run 控制、family、
model／Grant 撤銷或到期不能利用 HTTP replay 得到新的許可。本人歷史 read
與 revoke 沿原契約保留；Attempt 的 nested Grant 是 immutable creation-time
snapshot，並非當前 active assertion。Receipt、facts、outbox 與 domain effect
在同一交易，rate charge 是另外的保守 anti-abuse effect。

## 本機查核及真正模型路徑

作者、獨立反例及中央 wire tests 必須使用 disposable PostgreSQL、non-superuser
migrator／runtime、真正 ES256 配對與 active refresh family。涵蓋本人完整
HTTP chain、錯誤真人／用途／owner／origin、CAS／replay／撤銷／expiry、真實
鎖等待、嚴格 streaming JSON、safe response、durable rate 與未掛載正式 app。
實際結果集中 [交付紀錄](implementation-status.md)，未跑項不能計為通過。

三條模型路徑已依 Ted 指示平行開發，見 [15](15-model-adapter-cores.md)；
各會員實際使用的 provider、exact model、processing location、artifact custody
與 billing 仍不補預設。開發 agent 用的模型
不代表產品會員已選擇同一模型。Kit 的既有 adapters 目前是文件，demo member
status 並非 execution grant；此批沒有從其模擬紀錄取得認證。

本機官方 CLI 的隔離 `--version`／`--help` 查核只證明安裝及旗標形狀，沒有
執行 login、讀取憑證或請求模型。查得 Codex 0.160.0、Claude Code 2.1.288；
這些版本不是已支援 adapter 的宣告。官方說明顯示 Codex read-only 仍可執行
受 sandbox 約束的 commands；不能推論完整 tool catalog 已關閉。
[Codex 安全文件](https://learn.chatgpt.com/docs/agent-approvals-security)

Claude 的 tools、MCP、startup customization 與 managed hooks 有不同控制面，
單用 plan、tools empty 或 safe mode 不足以驗證全部隔離；bare mode 的認證
需求也不能直接套成 subscription runner。完整 auth/custody、exact billing/model、
tools／hooks／MCP、config precedence、egress、logging、timeout／cancel 和 unknown
usage 都須獨立驗證，才可宣告可用 adapter。
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference)、
[headless](https://code.claude.com/docs/en/headless)、
[hooks](https://code.claude.com/docs/en/hooks)

目前同意紀錄與 private persistence policy 也不代表 Work 文字可送往任意 provider。
未來 dispatch 前須有目前本人、精確 Work version、provider/model/location/custody、
目的及有界資料的出口政策，再一次消耗 genuine operational permit；寫入私人
Result 前須重驗 scope／Grant／fences。模型 stdout、CLI login status 或 runtime
簽章不能各自變成平台 Result／provider attestation。取消或逾時後可能已有費用，
保留 unknown outcome／usage，不自動重試或 fallback。

HTTP factory 完成後，正式入口／UI、真正模型認證及 adapter、operational
Attempt／lease、私人 AI Result、可信 CI、正式 key/host 及 staging/live 仍待完成。
原始 168 項產品驗收維持逐項取得完整證據的規則。
