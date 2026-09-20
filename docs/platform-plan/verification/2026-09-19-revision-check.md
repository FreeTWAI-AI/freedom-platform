# 2026-09-19 修訂檢查紀錄

日期採Asia/Taipei。範圍：本次ZIP的規劃來源、機器契約與新增靜態測試，不含線上產品。

## 來源與版本

來源 `Freedom-Platform.zip` SHA-256：`b2a09f579dc6953cdd2722aba2c4f00e1b94879a8f1706e3b32b005d51c510bb`。來源70份有效文件，本版82份；修改26、新增12、不變44、有效原檔刪除0。所有原始有效路徑保留，原始ZIP未改動。

Python：3.13.5；PyYAML：6.0.3；jsonschema：4.26.0；pytest：9.0.2。這是本次實際執行版本，非最新版本或產品依賴建議。

## 實際執行

```sh
PYTHONDONTWRITEBYTECODE=1 python -m pytest docs/platform-plan/contracts/tests -q -p no:cacheprovider
```

退出碼：0。結果：**83 passed**。完整stdout見 [2026-09-19-static-tests.txt](./2026-09-19-static-tests.txt)。

| 範圍 | 檢查到的事實 | 沒有證明的事 |
| --- | --- | --- |
| 全部contracts JSON／YAML | 可解析，無重複鍵；schema自身符合所宣告draft | 所有自訂format／x-invariant及所有舊example已完整語意驗證 |
| 新互助schema與範例 | 三種模式與實益正例、缺預算／容量／收益／偽造reporter等反例；數字及期限關係fixture | refs真的存在、本人已同意、銀行款項已收到 |
| WorkItem／WorkClaim | 缺reviewer可open與claim；導航正交；退出／到期保護責任；Claim pin條款 | 已有可執行狀態機、API實際授權與資料庫並發原子性 |
| OpenAPI／events | 本地refs存在、operationId／event唯一、新event沿用owner、新寫入要求session＋CSRF、公開摘要不含私密refs | HTTP實際運作、CSRF／auth部署有效、遠端dataschema URI已發布 |
| Operating policy | 未啟用、資源未假造、付款仍關閉、保護義務保留 | 有低人力成本實績、有供給、有資金或有真人互惠 |
| 驗收矩陣 | T27～T34、UAT-M1～M5仍明示未跑 | 真人或runtime驗收已完成 |

`verify_revision.py`另以本版manifest驗每檔SHA-256／bytes與Markdown相對檔案或目錄連結。檢查不涵蓋章節anchor與外部URL。精確檔案清單／hash見 [inventory](./2026-09-19-file-inventory.json)，該manifest只排除自己，避免雜湊自我循環。

## 重跑方式

從`Freedom-Platform/`根目錄，建立Python虛擬環境，安裝`contracts/tests/requirements-static.txt`，再跑上述pytest及：

```sh
python docs/platform-plan/verification/verify_revision.py
```

完整步驟見 [09現況紀錄](../09-handoff-record.md)。修改來源後hash不匹配屬預期，須產生新版本紀錄。`requirements-static.txt`只供這兩個本地測試模組，不是product requirements。

## 明確未做

未執行原09文件列出的私有絕對路徑scripts（ZIP未含它們）；未執行產品unit／integration／E2E、現網／provider、資料庫容量競爭、正式簽章驗證、JCS跨語言向量、部署、付款、外部帳號查證或真人測試。沒有把Grok／Claude分工建議寫成本次已審查證據。沒有完成或保證83個產品功能。

本版是可接續實作的規劃修訂；靜態通過不能證明營運模式有效。真人及資源證據不足時不擴大服務承諾，一般參與與開發仍可繼續。
