# 第一筆真人案：紀錄包與流程

目的：把「社群促成、可追溯、且已核實收到款項」的第一案做成可重跑證據，而不是本機示範或行銷故事。

對照：[首批營運驗證](./operating-validation.md)。平台**不過手金錢**；銀行／provider 證據留在 Seller 端，這裡只存 ref、digest、金額／幣別／日期與核實方法。

## 誰做什麼

| 角色 | 負責 |
| --- | --- |
| Ted | 拍板此案是否算「首筆核實實收」；保管敏感證據存放位置；必要時 A4 |
| Jason | 定位、陪跑、商機／合作協調；協助雙方把條款寫成 exact version |
| Hao | 行銷／社群接觸來源紀錄（不誇大流量） |
| Mini | PM／商品 QC／電商觀點（可選 review，非正式 A4） |
| 需求者／maker（當事人） | 本人確認需求、同意條款、交付／驗收、實益回報；Seller 提供收款證據 |
| Freedom Platform bot／Codex | 維護模板、檢查欄位完整性、不代填「受益／實收／核實」 |

AI **不得**代答「是否受益」「是否願意再參與」，也不得把 `unknown` 寫成 0。

## 一案一檔

1. 複製 [`cases/CASE-TEMPLATE.md`](./cases/CASE-TEMPLATE.md) → `cases/CASE-YYYYMMDD-<短名>.md`
2. 填表頭 `case_ref`（整案唯一、之後不變）
3. 依階段勾選；每一欄「未知」就寫 `unknown`，不要留空裝完成
4. 敏感附件（匯款單、個資）**不要**直接 commit 進公開 repo；只寫 `evidence_ref`（例如加密雲端路徑、hash、或私有 vault id）
5. 狀態機：`intake` → `opportunity` → `agreed` → `delivered` → `payment_reported` → `payment_verified` → `closed`（可停在任一步並標失敗／部分成功）

## 最小通過線（什麼叫「第一筆核實實收」）

必須**同時**成立：

1. 有穩定 `case_ref`
2. 需求者與 maker 皆為真實自然人（非 `*.local.test`）
3. 雙方同意的合作條款有 **exact version**（檔案或訊息 digest）
4. 交付被雙方接受（或明確記錄部分接受／失敗原因）
5. 收款狀態不是只有 `self_reported`：至少一方提供 Seller 自有 provider／bank 的受限證據，且核實者、方法、金額、幣別、日期齊備
6. 平台沒有代收、沒有保管資金、沒有把 Contribution 推成 payable

未達第 5 點：整案計為 **未知／尚未驗證**，即使合作與交付都成功。

## 建議節奏（一週內可開案）

| 日 | 動作 | 產出 |
| --- | --- | --- |
| D0 | Ted／Jason 選定目標案源（一個就好） | `case_ref`、當事人聯絡方式（私有） |
| D1 | 需求者本人確認問題與範圍 | 模板「有效需求」填滿 |
| D1–D2 | 明示條款（價款、交付、時程）；雙方同意 exact version | `terms_version` + digest |
| D2–D5 | 交付／補件／驗收 | artifact ref、驗收紀錄 |
| 交付後 | Seller 收款 → 回報 → **外部證據核實** | 金額／幣別／日期／evidence_ref／核實方法 |
| 結案前 | 雙方自願實益回報（可拒填＝unknown） | 不催活躍；意願與行為分列 |

## 與本機工作台的關係

`http://127.0.0.1:4310` 的示範帳可練習流程，**不得**把示範案勾成首筆真人核實實收。真人案可用工作台當協作紀錄，但證據欄位以本包 markdown 為準（尤其支付核實）。

## 完成後

把填好的 `CASE-*.md`（無敏感附件）PR／commit 進 `docs/development/cases/`，並在 [operating-validation.md](./operating-validation.md) 頂部「真人證據計數」改為指向該案（由 Ted 確認後再改）。
