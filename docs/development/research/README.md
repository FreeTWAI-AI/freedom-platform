# 上游取用決定

本輪檢視 Ted 指定的 repositories，以其實際資料模型、程式碼、授權檔與維護狀態作判斷。沒有執行上游 installer，也沒有把外部帳號、資料庫或收付款程式整套引入。此輪新增程式為原創實作。

| 候選 | 採用重點 | 在 Freedom 的位置 |
| --- | --- | --- |
| [RefRef](https://github.com/amicalhq/refref) | partner portal、referral／attribution 流程；AGPL-3.0 | 行銷設計參考，不是供貨／庫存底座 |
| [Refferq](https://github.com/Refferq/Refferq) | affiliate journey／dashboard；MIT | 行銷設計參考；來源的 payout／狀態處理不能當付款權威 |
| [tw-ecommerce-majordomo](https://github.com/asgard-ai-platform/tw-ecommerce-majordomo) | 台灣電商營運 skill／MCP 接點；MIT | 後續 agent／provider adapter 選型參考 |
| [taiwan-ecommerce-toolkit](https://github.com/Moksa1123/taiwan-ecommerce-toolkit) | 台灣金流、物流、發票的知識／範例；MIT | 後續官方 sandbox 實接前的研究來源 |
| [golershop](https://github.com/shsuishang/golershop) | SKU、商店、訂單／履約頁面與流程 | 參考電商 UX；不引入其 MySQL/Redis／wallet 資料權威 |
| [LINE Node SDK](https://github.com/line/line-bot-sdk-nodejs) | 官方 Messaging API／webhook SDK；Apache-2.0 | 後續 LINE adapter 候選，與零售後端分開 |
| Ted 的既有定位專案 | 定位內容與 assessment 遷移來源 | 保留既有評量版本；本輪先建立可編輯本人定位、更多方向與 Guild 接點 |
| [Penpot](https://github.com/penpot/penpot) | 設計、原型、團隊協作；MPL-2.0 | 後續外部設計稿接點；OSS registry 以 GitHub repo／commit／license 為核心 |

各項 inspected commit、程式碼證據及限制：

- [供貨／零售與 LINE](commerce-upstreams.md)
- [定位](positioning-upstream.md)
- [開源與行銷](oss-marketing-upstreams.md)
- [整合設計與中央 DB](../module-expansion-design.md)

這些判斷決定了本輪的實作方式：同一會員與 PostgreSQL，分開的模組 command；外部工具透過清楚的接點逐步引入。這不等於已驗證所有上游部署或完成任何 provider 接線。
