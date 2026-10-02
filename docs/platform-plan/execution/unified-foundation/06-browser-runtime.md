# Autopilot API、Chrome 與 neo 執行端規格

Spec ID：`UF-SPEC-BROWSER`；狀態：`draft-ready-for-contract-and-runtime-audit`。來源：[AP 原文](../../../plans/autopilot-vnext.md) §01–05、Unified Foundation §03–12、27–30。依賴 [CORE](02-principal-command.md)、[ASSET-WORK](03-assets-private-work.md)、[EXEC-OPS](04-execution-adapters-release.md)；AP 的來源研究是固定歷史版本，不代表本輪已建置或完整稽核 neo。

## 交付範圍與中央責任

第一條真實垂直流程是「本人商品介紹草稿」：讀本人既有商品與允許的公開作品 → 本人明選模型 → 精確 Grant/RunAttempt → 版本化私人 Result/Asset → 本人預覽/改稿。需要外站資料時才使用 browser；不附帶付款、上架、GitHub 合併或 XP。普通頭像、人工工作、配對及撤銷不受 model-ready gate 限制。

| 模式 | 控制/模型路徑 | 完成證據與限制 |
| --- | --- | --- |
| extension_byok | 標準 MV3；明選 platform_vault broker | 無 Native Host 仍可用；不取得 provider key、不宣稱 OS/profile 隔離 |
| extension_cli | 標準 MV3 + Native Host + 本人官方 CLI | 安装 host、本人登入、工具限制與實際用量證據；無 host 明示 missing |
| neo_cli | neo managed profile + 本人官方 CLI | 所有 Rust/MCP/native paths guard；同 profile 不可用 standalone 繞過 |
| neo_byok | neo + 明選 broker 或 local_keychain | custody 選定後不可自動切換；本機 key 也不可交給頁面/模型 |
| cloud_byok | 保留中的 runtime profile | 首版不開放，不因有 enum 就宣稱雲端執行已完成 |

`assisted_local`、`managed_local`、`isolated_remote` 是受測能力等級，不是 client 自報字串即可取得的權限。CLI 無法限制任意 shell/工具時降為 assisted；不能因僅有 UI 按鈕就宣稱 managed。

中央延伸現有 work_items 與 shared principals，不建立第二份 execution_principals 真相。runtime_devices、connections、model/site metadata、Grant、Run/RunAttempt、lease/control、intent/receipt/event/checkpoint、budget/vault 的 logical schema 依 AP §1.5 補上 attempt 關聯、scope 複合約束及 recovery generation。表名仍由 schema PR 定版，不逐表拆 Worker。

`community_collaboration` 保留原 Claim/Review 規則；`personal_execution` 私人、無 self-claim；`service_operation` 需實際 delegation。org/squad visibility 未有 ACL 實作前不開。requires_ai 由 operation/policy 推導，不信任 caller 關閉 gate。

## API mount 與 operation registry

AP §1.7 的兩張完整 method/path 表是本組候選 route 清單，以下修訂為必要差異。各 route 必須在中央登記 method/path、operation ID、auth kind、body cap、schema/version、idempotency、effect class、必要反例；不能只加文件 route 或維持不同授權的隱藏 alias。

| Surface | 範圍 | 必須行為 |
| --- | --- | --- |
| `/api/v1` human | 裝置/模型/網站連線管理、私人 Work、Grant、人類 start/pause/takeover/resume/cancel、簽署 | 原 member cookie/Origin/CSRF；owner 由 server 推導；A4 另驗真人及 step-up |
| `/execution-api/v1/auth/*` | device-authorizations、token exchange/refresh | 專用 rate limit；配對只給 bootstrap，不因登入成功取得 effect 權 |
| execution bootstrap/capabilities/observe-auth | 最小狀態、runtime 能力、本機登入證據 | proof-bound；local_observed 明示其證據等級，不當 provider attestation |
| execution runs/preflight/advance/heartbeat | 建 Run 及首 attempt、續租、排下一 model step | 原子 current attempt/lease；`:advance` 202 + operation ref，不接受任意 HTTP proxy payload |
| execution commands/events/checkpoints | 有序領取、安全狀態/恢復證據 | scoped stream、bounded cursor、message/sequence/digest 去重與 gap 補讀 |
| execution actions/authorize/begin/receipts | 提案、短效 permit、消耗 dispatch、對帳 | server 重判 effect/target；current Grant/attempt/epochs；receipt 不直接改業務 accepted |
| execution complete/fail/signature-requests | 結束、明確 blocker、請人簽署 | unknown 不假填完成；machine 可以請求簽署但不能 approve |
| internal ModelStep | 既有 step/attempt/binding/context/catalog refs | private broker 重新驗 owner/Grant/data/budget，不收任意 URL/key/body |

為讓 unknown dispatch 可確實查詢，本組補兩個候選唯讀入口：GET `/execution-api/v1/runs/{id}` 及 GET `/execution-api/v1/actions/{id}`。前者只回該 caller 可見的 run/attempt 安全狀態，後者只回其原 dispatch/reconciliation 狀態；兩者不回任意私人正文，也不因回傳 dispatch ID 而再授執行權。正式 registry/vectors 必須包含這兩個入口與失權反例。

路徑仍可使用 run ID，但所有 effect-bearing requests/token/permit/lease/journal/checkpoint/queue refs 明帶 attempt ID，驗它屬該 run 且為當前可執行 attempt；不得無條件套用目前 attempt 而誤認舊訊息。receipt/晚到結果只可指向原 attempt/dispatch 的 reconciliation，不能用目前模型健康狀態阻止有限收證。

晚到 evidence 使用獨立窄用途驗證器：只准原 runtime proof 對原 dispatch 查最小對帳狀態及交有限 evidence，不授新 read/effect/upload-finalize。EXEC-A 須固定此 capability 的 mint/TTL/revoke/body cap；不能靠接受過期 execution JWT 達成。因 compromised device 被撤銷時，停止自動收證並交有權人對帳，不讓「late」成永久驗權例外。

Machine route 不收 member cookie；fw_read、shop、skill-upload、site key 均不能被當會員 session 或 execution token。Service 引用會員資料必須有 scope 限定 delegation。舊 member/preview/shop 入口保持原能力，execution-v1 不偷偷升級其 scopes。

Agent Kit MCP facade 採 AP §4.11 列出的 11 個 freedom.* 工具並逐個登記 operation/測試；execute_authorized_action 只收 canonical intent ref，不收 shell/JS 字串。observe_page 同樣驗 scope/data policy。facade 不是唯一 guard，繞過 facade 直呼 platform/neo 仍必須拒絕越權。

AP 範例 envelope 上限 64 KiB、event 8 KiB 是候選專用限制，不能放寬現行全站 body cap。契約 PR 固定每 route 及未壓縮資料上限、深度、batch count；binary/large artifacts 走 Asset，不塞 event。

## 配對、憑證與模型 custody

裝置配對以 RFC 8628 型流程設計：device proof、短效 code、exact client/origin/environment/scopes、真人確認、poll backoff/rate limit；既有唯讀配對獨立保留。token proof 驗 method、URI、audience、iat/nonce/replay、access-token hash 與綁定公鑰；sender label 不是身分。

以下是 AP 的待驗測起始值，不是現況或已批准安全政策：device code 300 秒/poll 5 秒、access 10 分鐘、execution token 最長 5 分鐘且不超 Grant、refresh family 最長 30 日、TaskLease 90 秒/heartbeat 20 秒、action permit 5 秒且 max-use=1。實作 PR 統一成 versioned profile 並測離線/延遲/時鐘誤差；未定 skew/expiry 行為不得開 managed mode。

首版純 extension 將 refresh 視為 session-only，browser 重開重新確認；30 日是上限，不是准許把 refresh 寫 storage.local/sync。Native Host 使用 OS keychain。rotation 偵測 reuse 後撤 family，禁止新 effects，已 dispatch 的收證仍有明確狹義路徑。

UserAccessKey 只作 bootstrap，AP 建議 32 random bytes、90 日上限，實作定版；只保存 hash/安全 prefix。SiteCredential 明分 service/audience/environment，不授 A4。secret mint/rotation 不能把明文放普通 command receipt；採一次顯示、遺失即重配，或經安全審查的短 TTL 加密重播，不在本組擅自宣稱已解決。

Model custody 僅 platform_vault/local_keychain/official_cli 明選。provider secret 走專用 ingest，logging/tracing/WAF/body capture 皆確認不保存後才可啟用；broker 才有獨立 KEK/窄 DB role。Provider URL/redirect/private-address/metadata SSRF 拒絕，無一般代理出口。

官方 CLI adapter 介面為 detect、inspectAuth、beginOfficialLogin、validateToolsProfile、startAuthorizedRun、streamSafeEvents、cancel、getUsageEvidence。只用官方登入，不抽 OAuth/cookie；設定檔存在不能當 ready。使用者選 subscription 而環境 API key 會覆蓋時阻擋或請重新明選；quota/model/provider unavailable 明示等待，不自動換貴模型或平台 key。供應商當期能力與規則在實作/發版前另外查核。

預算 atomic reserve，未知 charge 不釋放為零；CLI 無可靠 cost evidence 就顯示 unknown，不承諾無法強制的 dollar hard-cap。binding/付費來源改變要新 attempt，已耗費紀錄保留原來源。

## 狀態機、控制與 durable journal

EXEC-A 將 AP §1.8 的 enum/轉移一次納入中央 schema。來源 Run 圖重複的三行 runtime_offline 合為一個 blocked reason；不是三個新狀態。Run 是邏輯聚合，RunAttempt 是一次固定 binding；Run 的顯示狀態由受控轉移計算，不能與 attempt 各自任意改寫。

每個狀態轉移的 actor、source/target state、current version/epoch、db locks、允許 evidence、timeout、outbox 與結果都要有表和 vectors。`cancelling`/`reconciling` 不能假裝 cancelled/completed；manual_unknown 保留「未知」，不能自動變成功。resume 重新 preflight/觀察，不重用旧 node ref。

一個 canonical control scope 同時只允許一個 mutating dispatch；read/model 可依政策並行。TaskLease 沿現有 `expires_at`，不採 AP 草稿的破壞性 lease_expires_at 改名。TaskLease epoch、control epoch、policy/Grant revision、recovery generation 分欄且都參與拒絕舊授權。

Native/MV3 journal 必須持久化以下順序：received → begin_requested → 平台原子 consume/確認 begin → durable dispatching → actuator → durable result/evidence → upload receipt。任何 begin/dispatch 回應未知都先查同 dispatch；「標記可能已發出但無結果」即使實際未 click 也不可盲重試。尚未 begin 不得執行，已 dispatch 不得以新 intent 掩蓋重做。

Journal 保存 message/intent/dispatch/run/attempt、operation/args digest、target incarnation、epochs、cursor、有限 safe evidence，不保存 provider key/cookie/任意頁面正文。容量、expiry、eviction 待 profile 定版；未完成/unknown 紀錄不得為騰空間靜默丟棄，滿額時停接新 effects 並回 blocker。

Local Stop 立即 fence 新操作，不等網路；server/remote offline 顯示 pending reconcile。Human takeover 經 requested → draining → human_active 的承認流程，列出 in-flight；人工改頁後必須重新觀察。handoff 開新 attempt、新登入，不複製 profile/cookie，local-only artifact 缺失回 custody blocker。

## 標準 Chrome extension

獨立標準 MV3/TypeScript/React/Vite client，不複製 neo 的 browserOS permission。AP 的 Chrome 120 是歷史 API 最低值，不是本次支援/安全版本承諾；實際發版使用受支援 browser 並留版本證據。

Manifest 初版必要 sidePanel/storage/scripting/activeTab/alarms，nativeMessaging/downloads 按需；平台 host 精確限定，網站 host permissions 經人 gesture 逐 origin 請求。禁止預設 all_urls、cookies/history/bookmarks/debugger/unlimitedStorage；staging/prod 分 extension IDs、origin、token trust。平台 Grant 與 Chrome permission 都要通過，保有 host permission 不代表撤 Grant 後仍可操作。

每則 content/background/native message 驗 schema/size、sender.id、tab/frame/documentId、origin、session binding、control epoch；頁面 postMessage 不授權、不直接啟 Native Host。token 只在受控 background/session，不交 content script。externally_connectable 不接受任意網站。

Native Host 只允許精確 installed extension origins，stage/prod 分離；固定 get_engine_status/start_authorized_run/cancel 等 typed commands，禁止 generic exec/read_file。安裝包/更新與 manifest 驗證是獨立實機證據。

首版 DOM vocabulary 固定 observe_page、navigate、fill_field、select_option、activate_element、scroll_view、request_file_selection、capture_visible_page、report_observation；沒有 evaluate/raw CDP/任意 JS 或 OS path。file selection/capture 依 user gesture/capability；page 要求下載執行程式不擴充工具。

Node ref 綁 doc incarnation/SPA generation、tab/frame/origin/account 及觀察；act 前重驗 attached/visible/editable/target digest。tab ID 重用、跨 origin redirect、DOM 替換、人接手即失效。未知站點 fill/click 可能 autosave/publish，不以「輸入文字」一律降為無副作用；分類不可靠只能 assisted/manual。

Access token 存 storage.session，非匯出 device key 的 IndexedDB 方案須實測且不宣稱硬體證明。local storage 只放安全 journal/metadata；storage.sync、bundle、log 不含 credentials。MV3 worker 被殺、reload、離線重連均從 journal/cursor 恢復；browser 關閉就停止，不承諾 24/7。

## neo managed guard 與本機邊界

以 AP 固定 upstream `53c3799ce014e9fee05569802314a05d0bad3e40` 作研究起點，實作先固定實際採用 SHA/patch inventory、LICENSE/NOTICE 及 build 方式；不因研究文件存在就宣稱授權/發版義務已完成。

目標是 `packages/browseros-agent/apps/claw-server-rust` 的 Rust/Axum backend 與 claw-app/WXT，不是舊 Bun apps/server。逐一盤點 AP §3.9 所列 dispatch、HTTP/helper/runtime、session/profile、recording/live、UI/generated API 路徑；確認直接與巢狀可達點後登記 surface/guard/test。新 source SHA 必須重跑覆蓋，不能只比檔名。

Freedom context 只能由 verified constructor 建立，含 principal/scope/run/attempt/runtime/Grant/epochs/policy；managed mode 缺 context 直接拒絕。執行順序固定 native/MCP auth → bound attempt → schema/connection/scheme → domain/control/target guard → begin → execute → observation → receipt。read permit 也有限 scope/data policy，不能讀所有 tabs。

首版 raw run/evaluate/script_hook/helper_runtime 的任意執行直接與 nested calls 皆拒絕；不能只是从 catalog 隱藏。standalone 與 managed 分 instance/profile，不讓手改 setting 控制同 profile。既有 upstream ownership/session label 只作提示，不能替代 guard。

本機 `/freedom/v1/*` 限 loopback、native token/nonce、Host/Origin allowlist；維持 MCP browser-origin 拒絕，不暴露 public CDP/0.0.0.0。由 native outbound poll 平台，不要求普通網頁 fetch localhost。所有 local REST、MCP、recording/live、native command 都在同 coverage registry。

原 neo codegen 與中央 Freedom TS/Rust 生成物分開；不手改 generated DTO。AP 的 bun/check/test:rust/lint:rust/fmt:rust 命令是歷史入口，實作讀實際 package 定義後執行，不在此宣稱已跑。

## Capture、recording、Skill 與人類確認

Capture 是 task opt-in，保護 A4/key setup/CLI login/password/payment verification/內部瀏覽器頁；不自動操作 OTP/CAPTCHA。redaction 在持久化/上傳前，測試頁面對抗內容/隱藏欄位，不以只遮 password type 宣稱安全。

neo rrweb 是 DOM recording，不是影片。首版中央預設僅安全 metadata；原始內容是否保存在 runtime/platform 依 data policy，ArtifactRef 不允許暗中上雲。ViewerGrant 與控制權分離；撤 viewer 後新讀取拒絕，retention/tombstone 參與 restore。checkpoint 不含 cookies/auth cache。

Skills 固定來源/commit/license/digest/capabilities/policy，驗批准 publisher 後才可進受控 catalog；來源文字可讀不代表可 runtime install。extension/neo 只執行隨受控 build 發布的 adapter code，不下載任意 JS/WASM/SKILL handler。外部頁面/模型/MCP output 無法自填 effect label 或擴權。

A4 必須可信 human surface、當前 member/CSRF/Origin/step-up、精確 artifact digest 與用途；模型一句「OK」及 site/userAccessKey 都無法簽署。沒有真實 WebAuthn 實作就不宣稱 WebAuthn 保護；完成 execution 不等於 accepted/paid/published。

## 契約向量、错误與實機驗收

新跨語言 digest 使用中央固定的 JCS/SHA-256 profile、拒 duplicate keys/不合法數字、明定 Unicode/金額字串語意；簽章 encoding 另由 JOSE profile 規定，不自行混搭。舊 command/SQL/preview digest 不重算。AP 引用的六份 draft schema、28 個樣本及 validator 未隨本次 Markdown/HTML 提供；不引用其 PASS 當本輪證據。可直接依中央契約新增正式 vectors，不需等待舊 ZIP 才開工。

HTTP/error schema 保留 AP §4.13 的 purpose：401 connection/model auth、403 Grant/tool/custody、409 stale epoch/target/idempotency/effect-unclassified、412 version、422 schema、429 quota、503 offline、202 pending/unknown operation。逐 operation 固定合法 code/shape 與 retry/reconcile 指示；不得把 result_unknown 當可安全重試的 503。對無權讀私人存在性採一致不洩漏的 401/404 行為。

測試至少三層：中央 schema/DB/HTTP vectors；runtime fake-platform/crash 注入；真實打包 browser/Native Host/CLI/provider。Windows/macOS Chrome extension、neo packaged launch 與 macOS dev 分開列版本/命令/結果；Linux 無實跑就 not_verified，不從 compile 推定支援。商店核准、正式 signing/release 各需另有證據與授權。

| PR | 交付 | 必要證據 |
| --- | --- | --- |
| EXEC-A（補充） | AP API registry/auth/RunAttempt/state vectors、原 planning additive 對齊 | AUTH/WORK 反例、TaskLease 相容、TS/Rust vectors |
| EXEC-B（補充） | Kit 官方 adapter/Native Host，接本人商品草稿 | 真實明選模型、無 fallback、secret redaction、human edit 412 |
| CLIENT-A1 | MV3 shell/permissions/pairing/typed messaging | 無 host BYOK、錯 sender/redirect/撤權、no remote code |
| CLIENT-A2 | typed DOM/journal/Stop/takeover | worker kill、begin ACK lost、unknown click、tab reuse/restart 實機 |
| CLIENT-B1 | neo verified context/所有 effect paths guard | direct/nested/standalone/local REST 反例及 guard coverage |
| CLIENT-B2 | recording/cockpit/跨端 handoff/packaging | opt-in/redaction/viewer revoke、同 Work 新 attempt、各 OS 真實證據 |

所有 AP:AUTH/WORK/EXT/NEO/OPS 原始案例見 [驗收對照](source-acceptance.md)，目前全部 `not_run`。這份 spec 只授予可審查的設計方向；不表示已開新 repo、登入 provider、建置 Chromium、變更金鑰或發布。
