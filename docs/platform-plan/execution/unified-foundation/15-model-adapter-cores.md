# 三條模型 adapter 核心與隔離診斷

Ted 已指示 Codex 訂閱、Claude Code 訂閱及 BYOK 三路平行開發；不再以
「先選一條路」阻擋本機實作。這個指示授權三路的程式、研究及合成驗證，
尚未指定產品會員的 provider／exact model／custody／billing，也沒有要求登入、
取用正式憑證、發出產品模型請求或部署。沿用 [13](13-member-execution-prerequisites.md)
及 [14](14-member-execution-http.md) 的 current-authority 邊界，不另建執行許可。

## 本批介面及證據

[adapter 模組](../../../../modules/agent-execution/adapters/index.ts) 依會員完整的
ModelSelection 明確選擇路徑，沒有預設模型、provider、custody 或 fallback。
輸入嚴格限於 selection、prompt、maxOutputTokens；prompt 最多 16 KiB UTF-8，
token cap 為 1–4096。未知欄位、錯誤組合、非 provider_remote 或非法字元拒絕。
只有 `openai`／`anthropic` 的精確 providerRef 有 codec；不猜測 alias。

三路 factory 的 `prepare` 僅產生私人 candidate：CLI argv 加 stdin，或固定
provider endpoint／headers／JSON bytes。它們不是 HTTP DTO、資料庫 fact、
execution permit 或待發送 queue。prompt 不放 CLI argv；BYOK candidate 不含
credential。沒有 process／fetch／secret resolver 可以由這些 candidate 啟動。
所有 `invoke` 固定拒絕 `execution_authority_unavailable`，沒有 ready boolean、
policy boolean 或 caller 注入 permit 可轉成執行權。

`decode` 僅解析私人、未驗證的 provider observation，成功仍帶
`evidence:unverified_provider_output`、`operational_authority:false`。
requested modelRef 與 reportedModelRef 分開；Codex 未回報模型時後者為 null，
不把請求標籤當已執行模型證據。Claude 與 BYOK 必須有唯一且完全相等的
reported model，不能自動接受 alias／另一個 snapshot。使用量是未驗證的報告，
不是價格、subscription entitlement 或付費事實；無法精確推出的 total 為 null。

JSON／JSONL 先複製並計量實際 bytes，再 fatal UTF-8 decode；單個 response
32 KiB、Codex event stream 64 KiB／64 events，深度 24、每段最多 4096 nodes，
最終文字 16 KiB。拒絕 decoded duplicate keys、prototype keys、BOM、lone
surrogates、不安全整數、非有限數字及非零值 underflow；小數不能透過 Number
捨入成整數使用量。有限的費用小數可解析，但不推導帳單。錯誤只輸出固定
allowlist code／通用 message，不回傳 prompt、account、credential、stderr 或
provider 原始錯誤。逾時、取消、非成功結果及不完整 terminal 保留 unknown／
unavailable，不重試或切換 provider。

## 三路範圍

| 路徑 | 本批交付 | 保留的執行缺口 |
| --- | --- | --- |
| Codex 訂閱 | 固定 0.160.0 與 native binary digest；版本／help／auth-status 診斷、stdin candidate、受限 JSONL lifecycle／用量 codec | 無法證明完整 effective tool catalog 為空、未認證 exact model／billing／upstream budget；support 仍 unsupported |
| Claude Code 訂閱 | 固定 2.1.288 與 native binary digest；去識別診斷、明確完整 model ID、settings／tools／MCP candidate、單一成功 result codec | managed policy／hooks／model routing 的有效結果尚無獨立證據；support 仍 unsupported |
| BYOK | OpenAI Responses 與 Anthropic Messages 兩種固定 endpoint 的 text-only request／response codec；明確 local_keychain 或 platform_vault 組合 | 沒有 key resolver、真正認證／egress／出口政策／permit／model availability；support 僅 candidate_only |

Codex 的 read-only 仍容許受 sandbox 約束的工具；disable feature 旗標本身不是
有效工具集合的證明。[官方安全文件](https://learn.chatgpt.com/docs/agent-approvals-security)
及 [non-interactive JSONL](https://learn.chatgpt.com/docs/non-interactive-mode)。

Claude tools、MCP、settings、managed hooks 與認證各有控制面；strict MCP 遇到
mandatory managed MCP 會失敗，不能描述成覆蓋管理政策。bare 模式也不能
直接用成訂閱 runner。[CLI reference](https://code.claude.com/docs/en/cli-reference)、
[headless](https://code.claude.com/docs/en/headless)、
[managed MCP](https://code.claude.com/docs/en/managed-mcp)、
[hooks](https://code.claude.com/docs/en/hooks)。

BYOK request 僅明確 text input／output、沒有 tools／stream／conversation resume；
OpenAI 關閉 storage、background、parallel tools，Anthropic 固定 API version。
只收成功 JSON、單一 assistant text、沒有 tool／mixed content，並核對 reported
model、終止狀態、token cap 及 cache／usage 數值一致性。endpoint 由中央固定，
不能從會員 JSON 提供。[OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create.md)、
[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)。

## 真實程序隔離與驗收層級

CLI probe 只有固定 version／help／auth_status 三種 metadata operation。它驗
native artifact digest，使用獨立 snapshot，再以 bwrap 啟動無網路、fresh home、
empty workspace 的程序，只提供固定 readonly loader／libraries／executable。
不掛載會員 home、auth/config、repository、socket、host `/proc` 或 vault，不
傳入 parent environment。程序執行有 3 秒 deadline、stdout/stderr 合計 32 KiB
及 256 chunks 上限；超限／逾時後清掉該次 process group。native artifact 最多
512 MiB，複製時每次 I/O 之間檢查 5 秒期限；此期限不能中斷已卡住的檔案
系統 I/O，不是整個 probe 的硬上限。artifact path 是可信 host 的固定設定，
不能從會員 request 指定。隔離無法成立時回 unavailable，不改用裸執行。
診斷結果只適用該 fresh
home，不能宣稱 Ted 真實帳戶已登入或未登入。

測試分成合成 observation codecs、本機 mock HTTP framing、真正隔離的 native
fixture 反例及 installed CLI metadata。mock listener 的 synthetic credential 只
驗本機 protocol fixture，不證明真實 provider authentication。CLI version/help
成功也不是完整模型請求或 tools 隔離驗收。本批不掛正式 HTTP、不改 migration
076–092、不發 execution token、不建立 operational lease、不寫 AI Result。
實跑總數、commit、未跑項及清理證據集中於 [交付紀錄](implementation-status.md)。

下一步仍是實作目前本人／精確 Work version 的 inference export policy、genuine
operational permit、dispatch 前後 current-authority／fences，以及受約束的 secret
resolver／provider transport；再驗真正模型認證、有效工具政策及私人 Result 的
完整垂直流程。已派三路不表示三個 production adapter 都完成；原始產品驗收、
trusted CI 及 staging/live 保持原完成條件。
