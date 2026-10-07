# 有限待決事項與建議預設

版本0.1。D-01–D-22是已決定產品意圖，不在此重新表決。下表是尚需明確 policy或技術選擇的參數；`recommended` 不是已獲准的正式營運承諾。整個工作不因其中一項未定停擺，只關閉真正依賴它的副作用。

| ID / owner spec | 待決 / 建議起點 | 原因、風險與正式前證據 | 不影響的工作 |
| --- | --- | --- | --- |
| OPEN-01 / SP-01 | 逐 guild主類別；採SP-01候選mapping，保留全部guild_key。行銷/供應/資安等按主要使命，不按工具名 | 需catalog內容owner確認疑義、taxonomy version及動態公會分類流程；不能自動搬primary或auto-upgrade full | 共用shell/default config/全部membership保留 |
| OPEN-02 / SP-02 | 已認證判準建議沿active user+current session/principal+現有onboarding；email驗證要求若新增需明確policy | 目前register不自動email_verified；不可發明KYC或讓舊會員全部重做onboarding | 身份/角色schema、拒絕矩陣、fixture |
| OPEN-03 / SP-02 | Tenant是安全/經營邊界，Workspace是其容器；初次自助建立一個workspace，多tenant/多人資料結構先支援 | tenant owner移交須受讓確認；最後owner停用先封高風險新操作並進受控recovery，絕不自動交會長 | 多角色模型/一般讀写/孤兒反例 |
| OPEN-04 / SP-04 | 多module instances資料模型允許；方案未設值不解讀無限。初始launch重用相容依賴或明示新建 | 正式max instances/storage/jobs與補助範圍需可維運成本資料；quota race需原子reserve | catalog/profile/可取消provision fixture |
| OPEN-05 / SP-05/09 | timeout/retry/receipt/offline窗口連動；合成profile建議request10s、≤12次/24h、offline≤7d、full receipt/inbox30d | 數值僅測試起點；replay horizon須小於完整去重可判定期。payload到期留下最小key/digest tombstone至namespace退役，或可證明等效策略；不能讓過期key再產effect | outbox/inbox、反例、未知ACK狀態 |
| OPEN-06 / SP-05/09 | 支援明列當前+前一個相容tuple作測試；正式退場窗口/通知節奏待policy | 簽章/semver不能取代behavior fixtures；高風險撤銷優先，保留local/read/export可用能力 | mixed-version fixture、SDK generation |
| OPEN-07 / SP-06/08 | 分資料類別的保留/備份/匯出下載期限待明定；清理先quarantine+可核對副本清單，不立即全域purge | 必須說清CRM原副本、order合法snapshot、dedup marker、recovery/tombstone與hist backup各期限；不能承諾即時所有副本消失 | scoped export/還原fixtures、allowlist掃描 |
| OPEN-08 / SP-07/10 | 首個可重現profile優先PG18及R2-compatible ObjectStore；確切OS/Node/lock/adapter版本於app release pin | 不保證任意DB互轉或所有object store等價；需乾淨環境從app+data+interop包啟動且無隱藏中央資源 | manifest/schema與streaming格式設計 |
| OPEN-09 / SP-08 | v1只停遷移module寫入，無零停機/通用CDC承諾；停寫上限依資料量與restore量測告知 | drain超時與未知effects先reconcile；不能用拍腦袋時間直接kill並宣稱成功 | shell、離線restore、cutoff/fencing反例 |
| OPEN-10 / SP-09 | 使用既有purpose-separated credential/Grant核心；具體sender-binding、有效TTL、rotation overlap依已驗adapter收斂 | 不自行創密碼協定、不把裝置bootstrap能力挪作module service；需audience/environment/replay/撤銷race實證 | endpoint/contract驗證、配對fixture |
| OPEN-11 / SP-11 | 換主力零影響；離會停止新補助/新啟動，既有續用依事先公布plan；無policy時不自動destroy | 過渡期/只讀/匯出/support由產品policy定，不以欠費扣走資料；安全停權與到期不同 | 事件分類與人類無AI流程 |
| OPEN-12 / SP-07/10 | ERP MIT遵原署名；中央NOASSERTION與其他原作逐件授權盤點；Mini特定未知原作仍待明確來源 | 未核授權不得發可商用/官方自架包；demo可讀不等hosted授權或支援 | 非抄碼spec/default workflow/已知source比較 |
| OPEN-13 / SP-11 | quota/pricing/支援投入用實測與採購當時價格；沒有正式數字不默認unlimited/free SLA | estimate/reserve/actual/unknown分開，AI與hosted/storage分帳；不得承諾收入/永久分潤 | 用量schema、成本fixture、取消/對帳 |
| OPEN-14 / SP-06/12 | RLS為第二層的具體policy/owner/FORCE選擇由source和true runtime-role測試決定 | 新tenant FK/query必要，RLS不能取代domain ACL；privileged exporter/backup權限單獨驗 | 純schema、兩tenant測試設計 |
| OPEN-15 / SP-08/12 | authority epoch與既有recovery generation的具體外部durable floor接點須在implementation選定 | 不能單DB自我證明防rollback；失去可信floor則停受影響寫入/恢復，不擴設第二信任根 | migration狀態/fixture與portability包 |
| OPEN-16 / SP-12 | 非功能驗收profile初值見SP-12；正式latency/容量/SLO待實測，不用『效能良好』結案 | 每次報source/資料量/並行/runtime/成本，超標縮能力/調adapter，不能取消隔離 | 開發/測試具名有限profile |

## 變更記錄與裁決格式

每個事項的收斂紀錄包含ID、原建議、決定與理由、決定者/責任scope、適用環境、policy/schema revision、影響D/R/T、測試及生效/退場方式。技術細化不能靜默反轉已決定的混合託管、最小中央留存或三類主力；產品變更需明列取代哪個D-ID。

任何審查者都可提出技術修正，沒有新增委員會或強制會議。正式grant/憑證、付款、法律文件、資料移交、規則/部署變更仍按既有授權，不由spec草案代替。
