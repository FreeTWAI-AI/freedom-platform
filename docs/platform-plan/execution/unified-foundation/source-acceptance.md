# R2 與 Autopilot 原始要求對照

原需求原文與最低證據層級保留在本頁；**目前逐項状态以 [需求證據索引](requirement-evidence.json) 為準**。
下表 `not_run` 是建立規格映射時的歷史欄位，不再維護為第二份 current 狀態。
狀態定義、owner 及 FC-00–07 完成門檻見 [收尾入口](closeout.md)；部分證據不能直接升為 accepted。


本文件逐字保留 [R2 §18](../../../plans/platform-restructure-r2.md) 的 38 項案例及 [AP §5.7](../../../plans/autopilot-vnext.md) 的 70 項案例；與 [統一計畫驗收](acceptance.md) 的 60 項合計 **168 項來源要求**。另列原 R2 G01–12、AP INV-01–12 共 24 條原則，不重算為額外 24 項產品測試。

來源 ID 以 R2:/AP: 命名空間區分；列內文字是原需求，不表示已實現。Owner 是 spec 責任，不是假造的 test filename。實作 PR 必須將每列接到真正 test IDs 及 evidence；所有狀態目前為 `not_run`。證據格式與禁止把 mock 當實機的規則沿 [共同驗收](acceptance.md)。

Owner 連結：[GOV](01-contracts-and-governance.md)、[CORE](02-principal-command.md)、[ASSET-WORK](03-assets-private-work.md)、[EXEC-OPS](04-execution-adapters-release.md)、[MEDIA](05-media-migration.md)、[BROWSER](06-browser-runtime.md)。

## 原文解讀與必要修訂

- AP:INV-03 中 run 綁 runtime/Grant，依 v1.1 落在 RunAttempt；舊 attempt evidence 保留，不原地改綁定。
- AP:WORK-06/15 的 epoch 與換 runtime 必須同時驗 attempt、control scope 及 recovery generation；不是只換前端顯示。
- AP:WORK-10 的「查詢同 dispatch」遇到已標記可能發出但無結果，進 unknown/reconcile，不允許再 click。
- AP:AUTH-05、INV-01 只限制新 AI 執行；不阻擋人類功能、Stop/Revoke 及限定晚到 evidence。
- AP:OPS-07 加不隨 DB rollback 的 recovery generation/撤銷來源；不能只還原同 DB 的 denylist。
- R2:G01/S02/M05 的拒絕只在該類別 r2_only 生效；bridge 過渡及 crypto bytea 例外保留。
- R2:D10 中 MEDIA 為初版 native binding；logical store mapping 與 DB/環境必須匹配，不以改名省略檢查。
- AP 原規格的 schema 範例檢查 PASS 不是這 70 項產品證據；本輪未取得或重跑其 ZIP validator。
- 相容路徑、TaskLease expires_at、schema authoring 等其他修訂見 [基準差異](00-baseline-and-decisions.md)。

## R2：Storage、權限、搬遷與交付

| ID | 原情境 | 原預期 | Owner spec | 最低證據層級 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| R2:S01 | 七類新媒體上傳 | 實際 R2 object 存在；DB 僅 metadata/pointer；既有 DTO 正確 | ASSET-WORK、MEDIA | DB＋七類 staging | not_run |
| R2:S02 | 新 DB media bytes 寫入 | R2-only 下被拒絕；crypto bytea 不受誤傷 | MEDIA | 真實 app role＋舊 writer | not_run |
| R2:S03 | 同 key retry | 不重複 pointer、quota、journal 或成功 receipt | CORE、MEDIA | DB 競態 | not_run |
| R2:S04 | 同 key 不同內容 | 409；不污染先前版本 | CORE、MEDIA | DB＋HTTP | not_run |
| R2:S05 | R2/Images delay | 不長持 domain/user DB lock；另一合法交易可完成 | CORE、MEDIA | 雙 DB connection＋delayed latch | not_run |
| R2:S06 | 部分 variants／R2 success DB fail | 無 ready dangling pointer；可續跑或回收 | ASSET-WORK、MEDIA | 故障注入＋staging | not_run |
| R2:S07 | DB success response lost | 重送回原結果，不重新掛回已取代版本 | CORE、MEDIA | DB＋ACK 遺失注入 | not_run |
| R2:S08 | 上傳中撤權／刪目標／換圖 | finalize 拒絕舊操作，保留新狀態 | CORE、MEDIA | DB 交錯交易 | not_run |
| R2:S09 | object 遺失／破壞 | 明確 unavailable/evidence，不回舊私密圖 | MEDIA | object 故障注入 | not_run |
| R2:S10 | GC 與 finalize 同時 | live object 不被刪；fencing／狀態轉換有效 | ASSET-WORK、MEDIA | GC/finalize/late PUT 競態 | not_run |
| R2:S11 | invalid input／假 MIME／超 cap／動畫 | 保持原拒絕規則，不因 R2 接線放寬 | MEDIA | 七類格式/大小 vectors | not_run |
| R2:S12 | video Range／HEAD／If-Range | 正確 bytes/headers/206/416 邊界；可實際 seek | MEDIA | HTTP＋staging player | not_run |
| R2:A01 | 跨社群／他人資產 id | 无權者不得連接／讀取；DB 最終提交拒絕 | CORE、MEDIA | DB＋HTTP | not_run |
| R2:A02 | revoke share／rotate／取消 avatar opt-in | 下一次授權判斷拒絕舊入口 | MEDIA | HTTP＋share revoke | not_run |
| R2:A03 | session 撤銷、退出公會、停用 user | 原資格限制完整保留 | CORE、MEDIA | DB 撤權競態 | not_run |
| R2:A04 | 暫停／隱藏／刪除服務或活動 | 舊 URL 不繞過 domain state | MEDIA | domain＋HTTP | not_run |
| R2:A05 | cache hit／304／HEAD／Range | 全部先驗權，不靠 body 是否需要傳輸決定 | MEDIA | HTTP＋cache | not_run |
| R2:A06 | R2 public domain／r2.dev | 正式媒體 bucket 不能匿名直讀 | MEDIA | 有權 cloud 配置＋匿名探測 | not_run |
| R2:A07 | JSON／log／receipt／trace | 無原始 bytes、share token、credential、私人 URL | MEDIA、BROWSER | 序列化＋實際 safe logs | not_run |
| R2:A08 | SSRF preview + R2 存檔 | redirect／host／size 邊界不變；不能讀內網或轉存未授權秘密 | MEDIA | SSRF redirect/size fixtures | not_run |
| R2:M01 | 有舊資料的 bridge | 原網址仍能讀；不存在資料不被誤判有圖 | MEDIA | legacy DB＋HTTP | not_run |
| R2:M02 | 全量 backfill | 每筆／每variant 可分類；size+實際 digest 相同 | MEDIA | 全量 metadata＋object hash | not_run |
| R2:M03 | 中途停止／重跑 | 可續跑，不重复資產，不將未完成標成功 | MEDIA | 中斷/重跑故障注入 | not_run |
| R2:M04 | 來源同時更改／刪除 | 舊副本不覆蓋新 pointer、不使刪除復活 | MEDIA | source 更新/刪除競態 | not_run |
| R2:M05 | R2-only 舊 writer | 不能新增 DB blob，出明確錯誤 | MEDIA | 實際舊 writer/DB role | not_run |
| R2:M06 | rollback | 回退到 R2-aware release 後，新舊資產皆可按權限讀 | MEDIA、EXEC-OPS | 隔離 rollback drill | not_run |
| R2:M07 | restore | 隔離 DB+R2 還原集合完整，應拒絕者仍拒絕 | MEDIA、EXEC-OPS | DB＋R2 restore drill | not_run |
| R2:M08 | cleanup | legacy read route／bytes／相關存在判斷已退場，必要 evidence 保留 | MEDIA | 全量清理/支持版本證據 | not_run |
| R2:D01 | Import graph 反例 | browser→db、Worker→ops SDK、新增不准循環會 fail | GOV | 實際 import/bundle graph | not_run |
| R2:D02 | pure docs PR | 不啟 DB/browser；verify 正常回報 | GOV | 可信 CI docs fixture | not_run |
| R2:D03 | runtime MD 假裝 docs | 仍選到 generation/runtime tests | GOV | 可信 selector＋runtime MD fixture | not_run |
| R2:D04 | selected job cancelled/skipped | 不被 verify 當成功 | GOV | 可信 CI job 結果反例 | not_run |
| R2:D05 | 修改 selector/workflow | 可信基線與獨立審查仍生效 | GOV | 可信 harness＋GitHub | not_run |
| R2:D06 | 舊／自審／失格 approval | merge 被拒絕，不靠 AI 自行判讀放行 | GOV | 真實 GitHub policy gate | not_run |
| R2:D07 | head／base 前進 | 重驗或 queue 驗證，不合併未測組合 | GOV | 真實 GitHub candidate | not_run |
| R2:D08 | 沒有人按按鈕 | 無新增 GitHub merge／Approve／push／comment 副作用 | GOV | 未授權零寫入反例 | not_run |
| R2:D09 | App/API extraction | 既有業務、三主題、手機／焦點／autosave／聊天行為保留 | EXEC-OPS | browser/theme/mobile 回歸 | not_run |
| R2:D10 | deployment config drift | 不能將 staging DB 綁 prod bucket；missing MEDIA 不當成功部署 | MEDIA | deploy preflight＋cloud identity | not_run |

## Autopilot：身分、工作、Extension、neo 與維運

| ID | 原測試與預期 | Owner spec | 最低證據層級 | 狀態 |
| --- | --- | --- | --- | --- |
| AP:AUTH-01 | 無登入讀private work →401/404，不回metadata | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-02 | fw_read token打execution mutation →拒絕，原readonly仍正常 | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-03 | shop machine key打execution/LLM endpoint →拒絕 | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-04 | site key填另一會員user_id →拒絕，不建立fake session | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-05 | 無本人CLI/BYOK開始user AI run →model_auth_required | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-06 | 沒有模型時仍可配對、撤key與瀏覽普通會員功能 | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-07 | 本人CLI登入成功但不支持工具限制 →assisted profile，不能宣稱managed | CORE、EXEC-OPS、BROWSER | 受測官方 CLI＋實機 | not_run |
| AP:AUTH-08 | CLI檔案存在但status無效 →不是ready | CORE、EXEC-OPS、BROWSER | 受測官方 CLI＋實機 | not_run |
| AP:AUTH-09 | 已選subscription但環境API key會override →阻擋或請本人明選，不暗中計費 | CORE、EXEC-OPS、BROWSER | 受測官方 CLI＋實機 | not_run |
| AP:AUTH-10 | CLI quota耗尽 →waiting_engine，未呼叫platform provider key | CORE、EXEC-OPS、BROWSER | 受測官方 CLI＋實機 | not_run |
| AP:AUTH-11 | A的BYOK connection綁到B的run →拒絕 | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-12 | refresh重播 →撤family，既有in-flight進明確狀態 | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-13 | DPoP錯誤key、audience、method、URI、過期／重放 →拒絕 | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-14 | 專用secret mint重試 →不把明文secret寫command_receipts/log | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-15 | production憑證用在staging或反向 →拒絕 | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:AUTH-16 | userAccessKey擴權請求A4 →拒絕；human confirm必走獨立驗證 | CORE、EXEC-OPS、BROWSER | auth DB＋HTTP/proof 反例 | not_run |
| AP:WORK-01 | 個人可以建立並執行自己的私人工作，不走舊self-claim | ASSET-WORK、EXEC-OPS | DB＋HTTP＋讀取面矩陣 | not_run |
| AP:WORK-02 | 社群協作仍禁止自我驗收與虛假貢獻 | ASSET-WORK、EXEC-OPS | DB＋HTTP＋讀取面矩陣 | not_run |
| AP:WORK-03 | private工作不出現在別人的list/search/events/export/notifications | ASSET-WORK、EXEC-OPS | DB＋HTTP＋讀取面矩陣 | not_run |
| AP:WORK-04 | Agent完成只提交結果，不自動accepted／XP／official | ASSET-WORK、EXEC-OPS | DB＋HTTP＋讀取面矩陣 | not_run |
| AP:WORK-05 | 一個scope兩Agent同時claim →只有一個currentlease | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-06 | 舊lease/epoch的commands、receipts →阻止新effect，late evidence只reconcile | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-07 | grant撤銷與authorize競態 →依鎖順序，無越權新permit | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-08 | take over時queue有命令 →舊epoch全部失效；inflight列明 | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-09 | 人手動改了頁面後resume →新observation，舊node ref不能用 | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-10 | begin成功但回應丢失 →查询同dispatch，不另建intent重送 | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-11 | browser click後斷線 →result_unknown，不再次click | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-12 | 同intent不同args digest →409 | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-13 | event重複/亂序/gap →去重與補讀，不跳state | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-14 | 取消後晚到model結果 →保存／忽略明示，不派新effect | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-15 | 換runtime →舊epoch被fence，新環境自行登入，不複製cookie | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:WORK-16 | result_unknown未解決 →不能宣告run completed | EXEC-OPS、BROWSER | DB 競態＋runtime fault injection | not_run |
| AP:EXT-01 | 無Native Host的純extension仍可BYOK模式；CLI明示missing | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-02 | 訊息sender/frame/document不符 →拒絕，不能啟動nativecommand | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-03 | permission只給A站，redirect到B站 →停止並請權限 | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-04 | Grant撤但Chromehostperm仍在 →不得新操作 | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-05 | 殺掉MV3worker/reload →恢復cursor/journal，不重click | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-06 | browser重開token已失效 →重新授權，不沿用舊permit | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-07 | tabID重用/SPA換頁/DOMnode detached →target_changed | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-08 | file upload未選檔 →user gesture required，不讀任意路徑 | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-09 | JSON夾JS/eval/remotehandler →schema拒絕 | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-10 | 模型/頁面要求讀其他tab cookies →拒絕 | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-11 | recording遇password/token/A4/login頁 →capture前遮罩或暫停 | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-12 | key寫入storage.sync或bundle →CI fail | BROWSER | 可信 CI＋實際 extension bundle | not_run |
| AP:EXT-13 | localStop不等網路 →立即拒絕新effect，UI顯示pending reconcile | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:EXT-14 | browser關閉 →localexecution停止，不承諾24/7 | BROWSER | 打包 Chrome＋fixture 站點/生命週期 | not_run |
| AP:NEO-01 | managed MCP無Freedomcontext →拒絕，不退到upstream無限制路徑 | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-02 | 跨Agent／人類tab，即使upstream ownership提示存在 →scope拒絕 | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-03 | raw `run`／`evaluate`直接call →拒絕，不只藏catalog | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-04 | helper/scriptnestedexecution →guard一致，無旁門 | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-05 | 使用未授權localREST/CORS請求控制 →拒絕 | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-06 | 手動改Standalone設定控制同managedprofile →拒絕／獨立instance | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-07 | MCP session label自稱Ted但token不是 →拒絕 | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-08 | app更新後guard仍覆蓋所有execute paths；property test檢查 | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-09 | upstreamrecordingcontent不自動上傳平台 | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:NEO-10 | generatedDTO被手改與schema不一致 →CI fail | BROWSER | 生成漂移＋TS/Rust vectors | not_run |
| AP:NEO-11 | Windows packaged launch與macOS dev實測分開，Linux不捏造支持 | BROWSER | 各 OS packaged/dev 分別實測 | not_run |
| AP:NEO-12 | cancel後遲到effect audit不能改成業務accepted | BROWSER | Rust guard＋所有可達入口/實機 | not_run |
| AP:OPS-01 | providerURLredirect／私網／metadataSSRF →拒絕 | EXEC-OPS、BROWSER | broker SSRF vectors | not_run |
| AP:OPS-02 | 公開worker拿不到vault解密key；普通DBrole不能讀secret | EXEC-OPS、BROWSER | 實際 binding/DB role 隔離 | not_run |
| AP:OPS-03 | budget並行reserve →不超出平台可保證的cap；未知charge不歸零 | EXEC-OPS | DB 並發＋provider 用量/timeout | not_run |
| AP:OPS-04 | 使用者撤BYOK →停止新推論，系統key不fallback | EXEC-OPS | 撤銷競態＋真實模型 adapter | not_run |
| AP:OPS-05 | Queue重送／outbox重派 →唯一effect/idempotentjob | EXEC-OPS | queue/outbox 故障注入 | not_run |
| AP:OPS-06 | main API rollback →既有會員/readonly仍可用，execution新動作停用 | EXEC-OPS | 隔離 rollback drill | not_run |
| AP:OPS-07 | DB restore後key已撤狀態不因舊backup復活；rotate/denylist核對 | EXEC-OPS | DB restore＋外部 recovery generation | not_run |
| AP:OPS-08 | 分享ViewerGrant撤銷 →原viewer不能取新recording/artifact | ASSET-WORK、BROWSER | HTTP＋viewer revoke | not_run |
| AP:OPS-09 | privatework新增以前所有舊querysurface已加ACL | ASSET-WORK | 全讀面 ACL＋feature gate | not_run |
| AP:OPS-10 | 技能書未簽／未驗證 →來源可讀，不會偷偷runtime install | GOV、BROWSER | trust/catalog/runtime 反例 | not_run |
| AP:OPS-11 | adversarial page篡改effect label／收件人 →policy拒絕或人工處理 | BROWSER | 對抗 fixture 網站＋actuator | not_run |
| AP:OPS-12 | provider unavailable／model renamed →blocker，禁止猜測成功或替換 | EXEC-OPS、BROWSER | 模型 adapter unavailable 反例 | not_run |

## R2 guardrails

| ID | 原規則 | 原機械化方向 | Owner spec | 狀態 |
| --- | --- | --- | --- | --- |
| R2:G01 | Production 不新增媒體 bytes 到 DB／永久 local disk | 指定 media columns 寫入拒絕＋runtime SQL regression；保留 crypto bytea 例外 | MEDIA | not_run |
| R2:G02 | 已發布 SQL／contract bundle 不可任意改寫 | baseline hash／ledger／contract compatibility tests | GOV、EXEC-OPS | not_run |
| R2:G03 | Browser／Worker／ops import 邊界正確 | 既有 TS parser／bundle graph；不只 grep 字串 | GOV | not_run |
| R2:G04 | 撤權後新操作與 replay 不得成功 | 真正 DB transaction／session／guild race tests | CORE | not_run |
| R2:G05 | ready pointer 必須對應先寫好的已驗證 object | failure injection：R2 success/DB fail、partial variants、unknown ACK | ASSET-WORK、MEDIA | not_run |
| R2:G06 | public URL 不繞過 domain／share revoke | GET/HEAD/Range/304、cache hit、舊 token 回歸 | MEDIA | not_run |
| R2:G07 | 外部 I/O 不在業務 DB lock 內 | provider delayed latch + 第二 DB connection 的確定性測試 | CORE、MEDIA | not_run |
| R2:G08 | 不新增第二套 truth、未登錄 provider/runtime | dependency／binding diff + 架構宣告核對 | GOV | not_run |
| R2:G09 | 必要 checks 確實執行，不能 skipped/cancelled 被當通過 | trusted selector、job result aggregator negative tests | GOV | not_run |
| R2:G10 | 真實 scope reviewer、人授權、current head/base 才能 merge | GitHub protection／輕量 review-policy／sandbox negative cases | GOV | not_run |
| R2:G11 | 既有使用者功能與 DTO 不消失 | 原 runtime、Worker、browser journey regression | ASSET-WORK、EXEC-OPS | not_run |
| R2:G12 | 無秘密／media body 出現在 log、receipt、PR artifact | serialization tests、secret scan、人工抽查安全 evidence | MEDIA、BROWSER | not_run |

## Autopilot invariants

| ID | 原規則 | Owner spec | 狀態 |
| --- | --- | --- | --- |
| AP:INV-01 | 未登入本人有效 CLI、也沒有可用本人 API 連線，不能啟動使用者 AI run；配對／人工／公開閱讀仍可用 | CORE、EXEC-OPS | not_run |
| AP:INV-02 | 平台登入、模型登入、網站服務身分與 browser 控制權各自驗證，互不冒充 | CORE、BROWSER | not_run |
| AP:INV-03 | 長效 user key／site key 不直接授予執行；每個 run 綁定可撤銷 Grant 與特定 runtime | CORE、EXEC-OPS | not_run |
| AP:INV-04 | 只有平台改寫中央工作、會員、權限與成果事實；本機資料為執行證據或暫存 | ASSET-WORK、EXEC-OPS | not_run |
| AP:INV-05 | 相同控制範圍只有一個控制者；舊 epoch／lease 的命令一律不得執行 | EXEC-OPS、BROWSER | not_run |
| AP:INV-06 | 所有副作用先有 ActionIntent；timeout 不當成可安全重送，先 reconciliation | EXEC-OPS、BROWSER | not_run |
| AP:INV-07 | 外部頁面／Skill／MCP 輸出都不能新增權限或取得秘密 | GOV、BROWSER | not_run |
| AP:INV-08 | API key、OAuth、cookie、refresh token 不放 model prompt／log／event／repo／前端 bundle | EXEC-OPS、BROWSER | not_run |
| AP:INV-09 | 純 extension 不宣稱具備 OS sandbox、跨 profile 隔離或 browser 關閉後繼續執行 | BROWSER | not_run |
| AP:INV-10 | AgentRun completed 不等於付款、正式發布、人類驗收、XP 或貢獻成立 | ASSET-WORK、EXEC-OPS | not_run |
| AP:INV-11 | 同一平台只有一份 WorkItem 真相；GitHub code collaboration 仍以 GitHub issue／PR 為準 | ASSET-WORK | not_run |
| AP:INV-12 | 額度不足只能等待、換本人明選的連線或取消；不得自動改用網站 key／更貴模型 | EXEC-OPS、BROWSER | not_run |

## 工作包接線

這是原工作包到本組 spec/PR 範圍的對照，不是建立 issue、指派他人或啟動外部操作。

| 原工作包 | 本組落點 | 先後/完成條件 |
| --- | --- | --- |
| R2 RS-00 | U0、MEDIA-A、GOV baseline | 原文已讀；實際資料量/入口/限制仍要盤點 |
| R2 RS-01 | MEDIA-A operations 接線 | 有權環境配置與 cloud smoke；本機 fixture 不替代 |
| R2 RS-02 | EXEC-OPS OPS-A | numeric 保留；v2 runner/helper 全相容才切命名 |
| R2 RS-03 | CORE、ASSET-A | 共用 Asset/Scope/ports；可先以現有 numeric schema 實作 |
| R2 RS-04 | ASSET-B | 頭像、名片、清單完整 A 流程 |
| R2 RS-05A | MEDIA-B | 技能投稿 profile |
| R2 RS-05B | MEDIA-C | 活動 banner/video/highlights、variants/seek |
| R2 RS-05C | MEDIA-B | 社群縮圖/服務封面、SSRF/撤銷 |
| R2 RS-06 | MEDIA-D | backfill/verify/GC/DB+R2 restore |
| R2 RS-07 | GOV-B/C、EXEC-OPS inventory 遷移 | trusted affected tests 先落地，現行 inventory 規則後改 |
| R2 RS-08 | GOV-D、EXEC-OPS migration 相容 | current candidate、有效 review、人明確授權、實際 protection |
| R2 RS-09A | EXEC-OPS UX | 避開活躍 PR；shell 行為/主題/手機/焦點回歸 |
| R2 RS-09B | CORE、EXEC-OPS route profiles | member/media/public-read/narrow-agent/shop/webhook 加 execution/service；保留原驗權 |
| R2 RS-10 | MEDIA-E、U6 | staging/prod 七類全量證據；需部署授權 |
| R2 RS-11 | MEDIA-F、U7 | supported floor、backup/delete 對帳、退舊欄位 |
| AP M0 | GOV-A、CORE、EXEC-A | 正式中央 source/schema/fixtures；不是沿用 draft ZIP 作發布契約 |
| AP M1 | CORE、ASSET-A、WORK-A | nullable/backfillable；私人讀面先完整封住 |
| AP M2 | EXEC-A、BROWSER auth/UI | pairing/bootstrap/model settings；未完成能力明示 unavailable |
| AP M3 | WORK-B、EXEC-B/C | 一條真實明選模型草稿；preview 不全域標 execution=true |
| AP M4 | CLIENT-A/B、U5 | pause/takeover/resume/revoke、同 Work 新 attempt、舊 permit 拒絕 |
| AP M5 | 後續逐 domain operation PR | 精確 effect/A4 完成後才開；不把全部 POST 暴露 |
| AP M6 | GOV consumer 相容、U7 | schema/enum 收斂、deprecated window、舊 key 不擴權 |
| AP T0 | GOV、CORE、EXEC-A | shared contract/auth/fixtures |
| AP T1 | ASSET-WORK、EXEC-A/C | platform Work/ACL/run/broker/control UI |
| AP T2 | BROWSER CLIENT-A1/A2 | 標準 MV3、journal、permissions |
| AP T3 | BROWSER CLIENT-B1/B2 | Rust guard/cockpit、recording、packaging |
| AP T4 | BROWSER EXEC-B、Agent Kit | 官方 CLI adapter/Native Host/登入及工具能力證據 |
| AP T5 | WORK-B、後續 domain adapters | 先草稿，再按 operation 的 scope/effect 證據逐項開放 |

同一測試可支持多個來源 ID，但必須列出各列的 coverage；任一 row 只完成部分表面或其中一個 OS，不可把整列升為 passed。原需求相同不代表可以刪除可追溯 ID。
