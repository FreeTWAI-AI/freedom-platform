# 身分範圍與交易核心規格

Spec ID：`UF-SPEC-CORE`；狀態：`draft-ready`。來源：UF-01/02/06、U1、統一計畫 §02–03、08。目標是保留會員 command 的現有行為，讓同一交易機制能接收各自正確驗證的人類、execution 與 service 呼叫。

## 實作邊界

主要修改入口為 [packages/db/index.ts](../../../../packages/db/index.ts)、[identity-membership](../../../../modules/identity-membership)、`migrations/` 及新的 common contract family。core 只依賴 neutral types、DB/Problem 及小型 auth ports，不能反向 import 整個 execution 或會員業務模組。

首個 PR 先抽出原交易機制並保持舊 `command(pool,input,authorize,run)` wrapper；再以獨立 PR 加入映射 schema。service/execution adapter 在真實 credential/current-state validator 完成前不可註冊對外 route。

## 身分與 scope 契約

| 物件 | 必要欄位與约束 | 來源 |
| --- | --- | --- |
| Principal | opaque UUID、kind 為 person 或 service、status、backing ref | person 與既有 `users.user_id` 一對一；service 與真實 SiteApplication/service backing record 關聯 |
| ResourceScope | UUID、kind 為 community、personal 或 site、status、owner/domain ref | community 指定既有 community；personal 綁本人 principal；site 綁已驗證 application |
| Invocation | subject principal、initiated_by、executor、可選 on_behalf_of、authn_kind、operation、scope、grant/attempt refs | server auth module 建立，不能直接信任 caller JSON |

DB 必須強制 backing refs 的互斥與完整性：person 有 user ref 且無 service ref；service 相反。各 scope kind 的必填/禁止欄位由 CHECK/FK 限制。community scope 不虛構某個會員作整個社群 owner；其權威仍由 community/domain 關係導出，owner principal 僅在有真實對應時填寫。

映射以 stable IDs/FK 建立，禁止 email 自動合併。新增 principal ID 不要求等於 user ID。對 `(kind,user_ref)`、community scope、personal owner 及 site scope 施加相應唯一约束；backfill 重跑不產生第二份映射。既有 community_id、user_id 與舊外鍵不整批改名。

typed target 必須同時驗其 scope；只驗 UUID 存在不足。跨 scope reference 以 composite FK/受測 domain 查詢限制，具體表關係隨 Asset/Work schema PR 固定。scope 本身不增加公會長、好友、審查者或公開讀取資格。

本規格不要求先建空的網站服務產品。若 SiteApplication 尚無 canonical backing record，service 分支僅保留 wire 契約並拒絕啟用；新增 service rows 必須等實際 backing schema/FK 一起交付。

## Command 行為與相容性

| 呼叫入口 | 必須驗證 | receipt namespace |
| --- | --- | --- |
| 舊 command/memberCommand | active user、community、session 未撤銷且未過期、當前 domain authority | 原 user_id + 原 operation + idempotency key |
| executionCommand | credential 用途/environment、executor binding、active attempt/Grant、epochs、scope、domain authority | principal + authn kind + scope + stable operation + key；語意 binding 納入 digest |
| serviceCommand | site credential/service principal、audience/purpose、site scope、當前 domain authority | 同新 namespace，與 member/execution 互不碰撞 |

新命名空間使用獨立 typed receipt schema/table 或等價不碰撞約束；不可把機器 receipt 假裝寫入既有 member user_id。新 response 一律禁止 raw secret；需一次性交付的憑證採专用流程。

歷史 member digest 保持 `digest({body, expected: expected ?? null})`，advisory key、operation 字串、既有 response shape 與錯誤碼保持。新增穩定 operation ID 與既有 route-based operation 用 descriptor 映射，不改歷史 replay key。

新 request digest 納入所有影響效果的 target、scope、expected version、payload、Grant/attempt/binding identity。從 attempt A 改成 B 不能以同 key 悄悄重播或產生新效果；若內容不同回 409 `idempotency_conflict`。同一平台 operation 的業務唯一約束另外存在，不能只依 request key 保證唯一。

## 交易內順序

member 路徑保持目前順序：BEGIN → lock user → lock session → 同一 key advisory lock → 當前 authorize → 檢查 digest/receipt → 執行 domain mutation → receipt/journal/outbox → COMMIT。更新 user 時從一開始取得適當鎖強度，避免在鎖 session 後再升級 user lock。

execution/service 路徑使用相同 core orchestration，但 auth port 在同一 `PoolClient` 驗 active backing records、attempt/Grant 或 site credential，再由 domain authorize 檢查 target。VerifiedContext 的 branded type 只防程式誤用，不能代替交易內檢查。

新路徑的鎖表須隨相應 validator PR 列明取得順序，包含 revoke/finalize/attempt handoff 的反向操作，並以兩連線 barrier 測試驗證。不能用全域互斥取代此分析。

每次 replay 都先驗目前身份與 domain authority；若私有結果已不可讀，回拒絕而不返回舊 response。若某操作需要與寫權不同的 replay 讀權，必須明確分拆 ports 並加反例，不能省略所有 authorize。

core callback 不允許 R2、Images、provider、GitHub、browser 或其他網路 I/O。既有 avatar 是後续 Asset PR 要搬出的已知位置；抽 core 的 PR 不宣稱已解決所有歷史長交易。

## 失敗及恢復

- authorization 在交易中失效：不 mutation、不建立成功 receipt。
- 相同 key、相同 request 並行：一次 mutation、一份 receipt，後者經目前驗權後取得同一結果。
- 相同 key、不同 request：409，原 receipt 不變。
- expected version 缺失/過舊：沿用既有 428/412；不由 client 自動覆寫新版本。
- domain mutation 或 receipt/journal/outbox 寫入失敗：同一 transaction rollback，不留下半成功。
- 模型不可用：人類操作、Stop/Revoke 及修連線保持可用；只有需要模型的新 step 受限制。
- 晚到 evidence：走另定的狹義 evidence capability；不能借 core 的通用 execution 身分復活 effect。

## Migration 及回退

採 additive schema、可重跑的受控 mapping backfill。先新增受約束映射，再接雙讀相容 wrapper，最後才考慮舊資料退出。回填不更改既有 membership、角色或 receipt。

編號依合併時的最小可用 numeric ID，更新 deploy manifest 的 last，保留 `[22]`。本 spec 不預留 076，不改舊 SQL。migration v2 另外驗收後才切換命名。

只完成映射及 member wrapper 時可回退既有 member release；一旦已寫機器 receipt、private Work 或 R2-only 資產，必須使用綜合 rollback floor，禁止回到不能辨識這些授權或資料的版本。

## Given When Then 驗收

| 前提與操作 | 必須結果 |
| --- | --- |
| 已存在 member success receipt，撤 session 後 replay | 401，不能回原 response |
| 身分仍有效但資源讀權撤銷後 replay | domain 拒絕，不洩漏 private response |
| 兩個有效 session 同時送同 key/same body | 恰一筆業務變更及 receipt |
| 同 key 改 body、version 或新 binding | 409，不改已提交內容 |
| 管理員撤 user/session 與會員寫入交錯 | 無死鎖、提交結果符合定義的線性化點 |
| service credential 帶他人 user_id | 拒絕，不建立 fake session |
| 將 TS-shaped VerifiedContext 直接送到 API | 無有效 credential 即拒絕 |
| body 指向其他 scope 的合法 UUID | 拒絕，不因 ID 存在放行 |
| 歷史 fixture 經原 wrapper 再執行 | request hash、receipt key、錯誤碼及回傳形狀相容 |
| domain 成功但 journal/receipt/outbox insert 失敗 | 全部 rollback |

新增測試加入既有 runtime suite，使用合成會員及獨立 `fp_*` schema。保留 `flows.test.ts`、member/session 及 avatar 回歸，並加入真正多連線競態測試；mock authorize 為 true 不算機器身分驗收。實作 PR 必須附 schema、鎖順序、SQL constraint 與試跑輸出，本輪均 `not_run`。
