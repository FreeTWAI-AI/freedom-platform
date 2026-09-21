# CASE-OPEN-next — 下一筆待填真人案

> 開案時把檔名改成 `CASE-YYYYMMDD-<短名>.md`，並把表頭 `case_ref` 寫死。敏感附件只寫 ref。

## 表頭

| 欄位 | 值 |
| --- | --- |
| case_ref | `CASE-OPEN-next`（開案日當天改成正式 id，之後不改） |
| 狀態 | `intake` / `opportunity` / `agreed` / `delivered` / `payment_reported` / `payment_verified` / `closed` / `abandoned` |
| 開案日 | |
| 結案日 | `unknown` 或日期 |
| 協調人 | Jason / 其他 |
| 社群接觸來源 | Hao 協助紀錄／Discord／私訊／其他（寫來源，不寫「有流量」） |
| 是否宣稱首筆核實實收 | `no`（達最小通過線且 Ted 勾選後才改 `yes`） |

## 當事人（真實自然人）

| 角色 | 顯示名 | 聯絡 ref（私有） | 確認本人 |
| --- | --- | --- | --- |
| 需求者 | | | `yes` / `unknown` |
| maker／提供者 | | | `yes` / `unknown` |
| Seller（收款方） | | 同 maker 或另填 | |

示範帳（`*@local.test`）填這裡＝本案**不能**算真人核實。

---

## 1. 作品曝光與來源

| 欄位 | 值 |
| --- | --- |
| 作者是否同意展示／分享 | `yes` / `no` / `unknown` |
| 作品 ref | URL、repo、檔案 digest… |
| 接觸來源 | |
| 投入時間（人時，可估） | 數字或 `unknown` |
| 備註 | 不把「頁面存在」當成已有流量 |

## 2. 有效需求

| 欄位 | 值 |
| --- | --- |
| 需求者本人確認的問題 | |
| 範圍／不做什麼 | |
| 下一步 | |
| 確認方式 | 訊息連結／通話紀錄 ref… |
| 是否把詢問／按讚算成交 | **否**（固定） |

## 3. 合作成立

| 欄位 | 值 |
| --- | --- |
| 交付條件 | |
| 價款／收益安排 | |
| 幣別 | |
| terms 檔案或訊息位置 | |
| terms_version | 例如 `v1` |
| terms_digest | sha256:… 或同等 |
| 雙方同意日 | |
| 同意證據 ref | |
| 是否把未來分潤當保證薪酬 | **否**（固定） |

## 4. 交付與接受

| 欄位 | 值 |
| --- | --- |
| artifact ref（exact） | |
| 交付日 | |
| 需求者決定 | `accepted` / `changes_requested` / `rejected` / `partial` / `unknown` |
| 補件紀錄 | |
| 未完成／失敗原因 | 可空；有就必填 |
| 雙方紀錄 ref | |

## 5. 實際收到款項（關鍵）

| 欄位 | 值 |
| --- | --- |
| 回報狀態 | `self_reported` / `counterparty_confirmed` / `provider_or_bank_verified` / `unknown` |
| 金額 | |
| 幣別 | |
| 收款日 | |
| Seller provider／bank | 名稱即可（勿貼完整帳號） |
| evidence_ref（受限） | 私有路徑／vault id／遮罩檔 hash |
| 核實者 | 真人姓名／角色 |
| 核實方法 | 例如「對過銀行 App 入帳截圖與合約金額」 |
| 是否平台代收 | **否**（固定） |
| 是否可標「銀行已核實」 | 僅當回報狀態＝`provider_or_bank_verified` 且上列齊備 |

未達 `provider_or_bank_verified`：本案對「首筆核實實收」計數仍為 **unknown**。

## 6. 參與者是否受益（本人填，AI 不代答）

| 當事人 | 實益自述 | 實收／分配 | 實際投入工時 | 拒填 |
| --- | --- | --- | --- | --- |
| 需求者 | | | | `yes`→整列 unknown |
| maker | | | | `yes`→整列 unknown |

## 7. 是否願意再參與／重用

| 欄位 | 值 |
| --- | --- |
| 後續自願行為（已發生） | 或 `unknown` |
| 口頭意願（未行動） | 與上列分寫；不催活躍 |
| 合法成果重用 | `yes` / `no` / `unknown` + ref |

---

## 檢查清單（結案前）

- [ ] `case_ref` 穩定且檔名一致
- [ ] 非示範帳
- [ ] terms exact version + digest
- [ ] 交付／驗收有紀錄（含失敗也算）
- [ ] 支付欄：狀態／金額／幣別／日期／evidence_ref／核實者／方法
- [ ] 無平台代收敘述
- [ ] 實益欄未由 AI 代填
- [ ] 敏感附件未進公開 git
- [ ] Ted 是否同意標「首筆核實實收」：`yes` / `no`

## 變更日誌

| 日 | 誰 | 改了什麼 |
| --- | --- | --- |
| | | 建立檔案 |
