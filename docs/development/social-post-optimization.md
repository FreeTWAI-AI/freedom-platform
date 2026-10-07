# Social Post：本人模型額度與發文草稿

需求來源：Hao 在 2026-10-07 要求首頁動態牆／發文入口旁提供小型、可選的文案優化按鈕，消耗使用者自己的 Token。這項功能不改發布權限，也不把優化結果自動發布。

## 會員操作

1. 在首頁或社群分享按「建立貼文」，寫下自己的內容。
2. 「Social Post 優化」預設關閉。開啟後可選更清楚簡潔、更有吸引力或整理合作需求。
3. 有本人已設定、未撤銷、未到期且符合現有模型政策的連線時，選模型及最多輸出 Token，按「同意送出草稿，優化一次」。頁面可展開查看完整送出內容；帳號額度／本人 API Key 分開標示。
4. 沒有可直接執行的連線時，可在新分頁開啟既有「私人工作與 AI」設定；原發文草稿保留。也可把任務複製到自己的 Codex、Claude Code、Grok 或其他 LLM，執行後貼回結果。這一路徑明示需要本人在外部工具執行，不宣稱平台已代為呼叫模型。
5. 結果先預覽；「採用這版文案」才替換草稿，仍需原本的「發布貼文」。可復原原稿；採用後又修改的內容不由舊復原操作覆蓋。原稿已更新時，舊結果不能直接採用。

## 使用既有平台能力

直接執行沿用以下本人範圍的既有 transport：

| 步驟 | 現有入口 |
| --- | --- |
| 發現本人模型、連線與政策上限 | `GET /me/model-step-overview` |
| 保存這次通用指令與草稿 | `POST /me/private-work` |
| 建立綁定該工作版本的執行 | `POST /me/execution-runs` |
| 明確綁定本人連線與模型 | `POST /me/execution-runs/:id/grants` |
| 綁定草稿、版本與輸出上限 | `POST /me/model-step-approvals` |
| 啟用一次推論 | `POST /me/model-steps` |
| 使用原命令執行一次 | `POST /me/model-steps/:id:execute` |
| 確認狀態與私人成果 | `GET /me/model-steps/:id`、`GET /me/private-work/:id/results/current` |

沒有新增金鑰輸入表單、供應商代理、付款或憑證資料表。本人 API Key 仍使用既有獨立保管流程；CLI 登入與模型實際可用性仍由既有 host／adapter 驗證。選擇紀錄本身不表示模型可執行。

現有 source 有 Codex／Claude 訂閱 adapter 及 OpenAI／Anthropic／OpenRouter BYOK adapter。OpenRouter 的具名模型必須由既有政策明確允許；Grok／其他 LLM 不能僅因出現在手動交接選單就宣稱正式自動執行可用。這個 PR 不啟用 staging／正式站的 host、broker、供應商憑證或政策，也不代替真實帳號驗收。

## 恢復與資料範圍

- 每步寫入保留原 body、idempotency key 與精確 CAS。未知回應停止流程；不自動重送、不改模型或使用其他人的額度。
- Execute 回應遺失時，「確認原請求結果」先新讀取 Step；已完成時只讀成果，進行中／結果未知時不再送出推論。啟用前的未知命令僅由本人操作重放原命令。
- 待確認的工作在同一登入世代的記憶體中共享；關閉發文或在首頁／社群分享切換不建立第二次推論。必要時可取回當次原稿，再預覽。登入世代改變時不能延續上一身分的寫入；新身分取得新的空工作。
- 草稿、結果、原命令與 Token 不寫入 localStorage／sessionStorage。完整重載／關閉瀏覽器後，仍可由本人到「私人工作與 AI」查閱伺服器保存的工作與結果；不宣稱本機記憶體能跨程序恢復。
- 直接推論會把通用文案指令與這次原稿保存成本人私人的工作，交給所選模型；不附上聊天室、名片、其他會員資料或整個作品庫。原稿作為 JSON 資料，不替它授予工具操作權。
- 公開程式只有通用優化指令與外部 Skill 呼叫提示，不包含 Hao 的私人語氣、公式、案例、洞察紀錄或任何 Token。
- 預覽顯示來源及可取得的實際 Token 用量。合成測試、本人貼回與供應商 HTTPS 分開標示；費用由供應商核算，不能由 Token 上限推定實際費用。
- 手動複製／匯出時便記住那一刻的原稿及登入世代，關閉再開啟發文仍保留。複製 A 後改稿 B，再貼回 A 的結果會提示原稿已變並停用採用；重新匯出 B、貼回 B 的結果才可採用。沒有匯出而直接貼回仍可使用；採用完成或登入世代變更後，下一次貼回從新的原稿開始。貼回欄位使用固定文字標籤，反覆修改結果不會改變欄位名稱。

## 驗證與限制

直接模型的第一輪合成瀏覽器測試為 1 pass／1 fail。失敗 Step 已進入 dispatched，但建立 host capability 時被拒絕；保留 trace 和 SQL 狀態。PostgreSQL／host 的時鐘差可重現此問題：修正前的 500ms 控制反例在同一 capability 檢查失敗。修正只把五秒 permit 同時限制在 SQL 與 host 時鐘內，沒有延長期限、放寬 policy 或重送推論。既有模型 service 與前端流程共 58 項 runtime 測試通過；修正後正常與遺失 ACK 兩項真實 SQL／loopback transport 測試通過，合成 provider 各只執行一次。

`tests/runtime/social-post-task.test.ts` 覆蓋本人模型篩選、用量上限、連續點擊、原請求恢復、舊身分隔離、成果綁定及導航記憶體。`tests/e2e/social-post-optimizer.spec.ts` 覆蓋預設關閉、本人工具任務、預覽／採用／復原、舊結果拒絕、三主題手機版面及不自動發布。`tests/e2e/private-work-ai.spec.ts` 的既有隔離 fixture 階段驗證真實 SQL／transport 的單次優化與遺失 ACK；不消耗真人 Token。

實際命令與結果記在[本輪效能紀錄](social-platform-performance-2026-10-07.md)。真實供應商費用、訂閱資格、正式站安裝與真人文案品質仍需由維護者及本人帳號驗收。

## 多平台分享

同一發文器另提供可選的「Social Post 分享」：點平台 Logo 亮燈、準備原始素材，再到各平台自行確認發布。風險提醒、恢復、實際平台能力與驗證範圍見[選平台與逐站分享](social-cross-platform-sharing.md)。
