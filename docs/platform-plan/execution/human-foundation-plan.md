# Foundation Day 1 執行清單

> 狀態：現行 canonical baseline（2026-09-19 低維運互惠修訂）；planning 文件，不代表已部署。

本文件記錄 Ted 的 O1／Seller lane 與 Hao 的品牌 lane（建議預設，五人共同閱讀確認）；Ted 的 O1 不等待任何人，並一併記錄 AI 自動化動作與建立事實證據。產品模組地圖以 `02 §4.7` 為準，框架決定以 `07 §3` 為準，AI 協定以 `06 §3.3` 為準；所有外部帳號、採購、資源、連線與測試目前均未建立或未跑。

### 2026-09-19 運作範圍修訂

56 packages及M00–M09技術membership保留；FW-13–FW-15是既有package的工作卡增量。全形狀建置／帳號／sandbox不等於四線同步營運。首批只一種真需求互助，真人容量、雙方實益、總維持工時與資金證據決定新增對外服務承諾，詳見 `../12-low-ops-mutual-benefit.md`；不封鎖一般貢獻。所有原runtime／真人測試仍未跑。


## 1. 決策拍板欄

OD-01…OD-28 已是 working defaults，決定全文、依據與標籤／技術依賴見 `07 §5`。ADR-066…ADR-079 已是框架決定，全文與後果見 `07 §3`。Ted 可直接在最後一欄記 replacement 與日期；沒有 replacement 時依現行決定執行。

| HF-ID | 現行決定 | Canonical 內容 | Ted 可改欄 |
| --- | --- | --- | --- |
| HF-D01 | OD-01 control planes／domain／PostgreSQL | `07 §5` OD-01 | replacement＿＿／日期＿＿ |
| HF-D02 | OD-02 LINE | `07 §5` OD-02 | replacement＿＿／日期＿＿ |
| HF-D03 | OD-03 Discord | `07 §5` OD-03 | replacement＿＿／日期＿＿ |
| HF-D04 | OD-04 GitHub | `07 §5` OD-04 | replacement＿＿／日期＿＿ |
| HF-D05 | OD-05 市場與責任 | `07 §5` OD-05 | 市場＿＿／SellerParty＿＿／日期＿＿ |
| HF-D06 | OD-06 Seller-owned provider／幣別 | `07 §5` OD-06 | 幣別＿＿／SellerParty＿＿／connection＿＿／日期＿＿ |
| HF-D07 | OD-07 settlement | `07 §5` OD-07 | replacement＿＿／日期＿＿ |
| HF-D08 | OD-08 價格／供貨條款 | `07 §5` OD-08 | replacement＿＿／日期＿＿ |
| HF-D09 | OD-09 attribution | `07 §5` OD-09 | replacement＿＿／日期＿＿ |
| HF-D10 | OD-10 首批 holders | `07 §5` OD-10 | replacement＿＿／日期＿＿ |
| HF-D11 | OD-11 rank／office | `07 §5` OD-11 | replacement＿＿／日期＿＿ |
| HF-D12 | OD-12 AI／media／publication | `07 §5` OD-12 | replacement＿＿／日期＿＿ |
| HF-D13 | OD-13 legacy | `07 §5` OD-13 | replacement＿＿／日期＿＿ |
| HF-D14 | OD-14 rights | `07 §5` OD-14 | replacement＿＿／日期＿＿ |
| HF-D15 | OD-15 license | `07 §5` OD-15 | replacement＿＿／日期＿＿ |
| HF-D16 | OD-16 RPO／RTO | `07 §5` OD-16 | replacement＿＿／日期＿＿ |
| HF-D17 | OD-17 vault／root key | `07 §5` OD-17 | replacement＿＿／日期＿＿ |
| HF-D18 | OD-18 A4／e-sign | `07 §5` OD-18 | replacement＿＿／日期＿＿ |
| HF-D19 | OD-19 五人核心團隊 capacity | `07 §5` OD-19 | replacement＿＿／日期＿＿ |
| HF-D20 | OD-20 publisher | `07 §5` OD-20 | replacement＿＿／日期＿＿ |
| HF-D21 | OD-21 badge | `07 §5` OD-21 | replacement＿＿／日期＿＿ |
| HF-D22 | OD-22 printer | `07 §5` OD-22 | replacement＿＿／日期＿＿ |
| HF-D23 | OD-23 custody model | `07 §5` OD-23 | replacement＿＿／日期＿＿ |
| HF-D24 | OD-24 DB topology | `07 §5` OD-24 | replacement＿＿／日期＿＿ |
| HF-D25 | OD-25 matching | `07 §5` OD-25 | replacement＿＿／日期＿＿ |
| HF-D26 | OD-26 commission | `07 §5` OD-26 | replacement＿＿／日期＿＿ |
| HF-D27 | OD-27 settlement batch | `07 §5` OD-27 | replacement＿＿／日期＿＿ |
| HF-D28 | OD-28 money mode | `07 §5` OD-28 | replacement＿＿／日期＿＿ |
| HF-D29 | ADR-066：一個 GHEC organization 與九個 repo | `07 §3` ADR-066 | replacement＿＿／日期＿＿ |
| HF-D30 | ADR-067：主 domain 與固定 URL 角色 | `07 §3` ADR-067 | replacement＿＿／日期＿＿ |
| HF-D31 | ADR-068：modular monolith 與 canonical PostgreSQL | `07 §3` ADR-068 | replacement＿＿／日期＿＿ |
| HF-D32 | ADR-069：PostgreSQL async truth 與四 Queues | `07 §3` ADR-069 | replacement＿＿／日期＿＿ |
| HF-D33 | ADR-070：canonical IDs 與 event envelope | `07 §3` ADR-070 | replacement＿＿／日期＿＿ |
| HF-D34 | ADR-071：principal 與 acting role | `07 §3` ADR-071 | replacement＿＿／日期＿＿ |
| HF-D35 | ADR-072：bounded grants 與 exact A4 | `07 §3` ADR-072 | replacement＿＿／日期＿＿ |
| HF-D36 | ADR-073：broker／signer／publisher key 分離 | `07 §3` ADR-073 | replacement＿＿／日期＿＿ |
| HF-D37 | ADR-074：preview／staging／production 分層 | `07 §3` ADR-074 | replacement＿＿／日期＿＿ |
| HF-D38 | ADR-075：Agent runtime 契約與三 CLI adapters | `07 §3` ADR-075 | replacement＿＿／日期＿＿ |
| HF-D39 | ADR-076：六類 build profiles | `07 §3` ADR-076 | replacement＿＿／日期＿＿ |
| HF-D40 | ADR-077：四循環、八模組、五 cores、56 packages、12 runtimes | `07 §3` ADR-077 | replacement＿＿／日期＿＿ |
| HF-D41 | ADR-078：單一接點 seam | `07 §3` ADR-078 | replacement＿＿／日期＿＿ |
| HF-D42 | ADR-079：SellerParty 是收款主體 | `07 §3` ADR-079 | replacement＿＿／日期＿＿ |

## 2. 人事與標籤

Ted 依舊持有 infra／platform／設計／建置 owner 與三類 A4；其餘 holder 均是建議預設，五人共同閱讀時確認。Codex 實作，Grok adversarial review，Claude verification。共同閱讀不影響 Ted 執行 Day 1；缺人員 evidence 只令相應標籤為 false。Guild self-service 直達 `runner`；Master 通知不是 admission approval。

| HF-ID／職能 | 建議預設 holder（五人共同閱讀時確認） | AI 執行／檢查 | 共同閱讀確認 |
| --- | --- | --- | --- |
| HF-P01 Platform | Ted | Codex／Grok／Claude | □ |
| HF-P02 Identity / Security | Ted | Codex／Grok／Claude | □ |
| HF-P03 Work / Opportunities | Jason | Codex／Grok／Claude | □ |
| HF-P04 Quality / Commercialization | Mini | Codex／Grok／Claude | □ |
| HF-P05 People / Identity | Hao | Codex／Grok／Claude | □ |
| HF-P06 Agent Runtime | Ted | Codex／Grok／Claude | □ |
| HF-P07 Skills / Integrations | Ted | Codex／Grok／Claude | □ |
| HF-P08 Build / Release | Ted | Codex／Grok／Claude | □ |
| HF-P09 Catalog / Commerce | Mini | Codex／Grok／Claude | □ |
| HF-P10 Payments | Ted | Codex／Grok／Claude | □ |
| HF-P11 Organizations / Guilds | Hao | Codex／Grok／Claude | □ |
| HF-P12 Product / Operations | Mini | Codex／Grok／Claude | □ |
| HF-P13 Finance / Legal | Ted | AI 整理 issue；專業者同步提供意見 | □ |
| HF-P14 定位＋陪跑 Master | Hao | Codex／Grok／Claude | □ |
| HF-P15 貨品／Supplier／QC Master | Mini | Codex／Grok／Claude | □ |
| HF-P16 電商／Storefront Master | Mini | Codex／Grok／Claude | □ |
| HF-P17 自動行銷 Master | Hao | Codex／Grok／Claude | □ |
| HF-P18 自動剪輯 Master | Hao | Codex／Grok／Claude | □ |
| HF-P19 Skills／OSS Master | Ted | Codex／Grok／Claude | □ |
| HF-P20 會員／組織／status Master | Hao | Codex／Grok／Claude | □ |
| HF-P21 Opportunity Master | Jason | Codex／Grok／Claude | □ |
| HF-P22 Platform／Agent／Contracts Master | Ted | Codex／Grok／Claude | □ |
| HF-P23 Settlement／ledger Master | Ted | Codex／Grok／Claude | □ |
| HF-P24 GitHub break-glass co-owner | Mini | 邀請 evidence 檢查 | 候選＿＿／接受 ref＿＿ |
| HF-P25 Cloudflare break-glass Super Administrator | Jason | 邀請 evidence 檢查 | 候選＿＿／接受 ref＿＿ |
| HF-P26 Signer A／B／offline C custodians | Ted／Mini／Jason | custody evidence 檢查 | A＿＿／B＿＿／C＿＿ |
| HF-P27 Vibe／Field／Project | 韋銘／Jason／Mini | provenance 檢查 | V＿＿／F＿＿／P＿＿ |
| HF-P28 training／maintenance／real demand supply | training＝Hao；maintenance＝各模組 steward；real demand＝Jason＋Mini（建議預設，五人共同閱讀確認） | supply evidence 檢查 | owners＿＿ |
| HF-P29 official QC | 韋銘（非作者時） | Grok／Claude | 人類 pool＿＿ |
| HF-P30 support／incident／reconciliation on-call | Ted／Jason | AI alerts／runbook checks | delegates＿＿ |

| 標籤 | 為 true 的人員 evidence | false 時的效果 |
| --- | --- | --- |
| `official` | 獨立自然人 QC reviewer | 只不顯示 public `official`；candidate、工作與 sandbox 照常 |
| `production-signed` | Signer A／B custodians 是不同自然人 | production signing claim 維持 false；technical planes 與 staging 照常 |
| `commercial-ready` | Vibe／Field／Project 是三個不同自然人 | 商業成熟標籤維持 false；工作與內部 demo 照常 |
| `recovery` | break-glass 邀請已被獨立自然人接受 | recovery 標籤維持 false；資產與設定照常 |

## 3. O1／O2／O3 採購與角色帳號

完整 exact scope、建議預設、canonical 價格、Day 1 安全設定與 evidence 欄位以 `08 §13.1`、`08 §13.2` 為準。AI 不付款、不作決策、不簽 A4，也不代替真人建立需真人身分的帳號；AI 在該帳號 owner（O1＝Ted；O2 品牌＝Hao）完成登入後執行設定。第一個 Seller lane 由 Ted 以 Seller 身分自持。

### 3.1 O1：平台基礎設施

| HF-ID | Day 1 購買／建立範圍 | Owner／A4 類別 | 現況 |
| --- | --- | --- | --- |
| HF-B01 | GHEC、Freedom organization、seats、GitHub App | Ted／付款 | 未建立 |
| HF-B02 | 主 domain、年期、auto-renew、registrant | Ted／付款 | 未建立 |
| HF-B03 | Cloudflare Workers Paid、Registrar、R2、Queues、Workflows、Pages、Access | Ted／付款 | 未建立 |
| HF-B04 | PostgreSQL production＋staging、Hyperdrive、HA／PITR／backup | Ted／付款 | 未建立 |
| HF-B05 | external KMS／HSM、A／B online planes、C offline plane | Ted／付款 | 未建立 |
| HF-B06 | password manager／secret 保存 | Ted／付款 | 未建立 |
| HF-B08 | LINE OA＋Login production／test | Ted／帳號建立；有費用時付款；Hao／營運 admin（建議預設，五人共同閱讀時確認） | 未建立 |
| HF-B09 | Discord server＋bot | Ted／帳號建立；有費用時付款；Hao／營運 admin（建議預設，五人共同閱讀時確認） | 未建立 |
| HF-B10 | 平台自用 AI provider accounts＋budgets | Ted／付款 | 未建立 |
| HF-B11 | 平台自用 media／render provider | Ted／付款 | 未建立 |
| HF-B12 | transactional email | Ted／付款 | 未建立 |
| HF-B13 | monitoring／alerting | Ted／付款 | 未建立 |
| HF-B14 | e-sign＋A4 evidence archive | Ted／付款 | 未建立 |
| HF-B15 | 法務 engagement | Ted／法律文件 | 未建立 |
| HF-B16 | 會計／稅務 engagement | Ted／法律文件 | 未建立 |
| HF-B17 | R2 public／private／quarantine 與 evidence prefix | HF-B03 內 | 未建立 |
| HF-B18 | billing＋renewal register | Ted／付款 | 未建立 |
| HF-B19 | WebAuthn keys＋offline recovery bundle | Ted／付款 | 未建立 |
| HF-B21 | vendor billing identity，只支付 O1 帳單 | Ted／付款 | 未建立 |

### 3.2 O2：第一個營運實例

Ted 的 O1 Day 1 不等待任何人。Freedom 品牌帳號是 Hao 的獨立 lane，可在 Day 1 或之後任何時間建立，不阻擋 O1、第一個 Seller lane或其他工作；Hao 當日不便時，Ted 可用品牌名義先開並同日把 owner／admin 交給 Hao，帳號始終在品牌名下，不是 Platform 資產。第一家 Store 的 Seller lane 同理由 Ted 以 Seller 身分自持。

| HF-ID | Day 1 帳號／connection | Owner | 平台邊界 | 現況 |
| --- | --- | --- | --- | --- |
| HF-B07 | 第一個 Seller 的綠界 ECPay sandbox＋Seller-owned Store origin | Ted 以第一個 `SellerParty` 身分（建議預設，五人共同閱讀時確認） | 平台只存 `seller_collection` ref、digest、fact；reference Store 是 `reference` mode | 未建立 |
| HF-B20 | Freedom 品牌 X／Meta／YouTube `ChannelConnection` | Hao 以品牌 owner 身分；Hao 當日不便時由 Ted 以品牌名義先開並同日移交 owner／admin | 帳號始終在品牌角色名下；平台只存 connection ref 與 capability fact | 未建立 |

### 3.3 O3：成員／Seller／Squad 自有

其他 Seller provider、成員 repo、BYOK key、Squad／client raw storage、coach／Squad 收款、payer-owned `payer_disbursement` 與 beneficiary-owned destination 都不由 Platform 採購。Day 1 只建立 contract tests 與 deterministic mocks，全部未跑；owner 接入後平台仍只保存 purpose-tagged ref、digest 與必要 fact。GitHub 是 code 權威，Seller provider／bank 是 money 權威，Discord／LINE 是 chat 權威，client／Squad storage 是 raw data 權威。

## 4. 硬體

| HF-ID | 建議預設 | Day 1 安全設定 | 現況 |
| --- | --- | --- | --- |
| HF-H01 | WebAuthn security keys 4 把 | firmware inventory、PIN、服務 enrollment；數量屬建議預設 | 未購買／未設定 |
| HF-H02 | 2 份異地 offline recovery media | 加密、封存、location class、access log；數量屬建議預設 | 未購買／未設定 |
| HF-H03 | Signer A／B 各獨立執行裝置＋offline C | full-disk encryption、WebAuthn、admin／recovery 分離 | 未購買／未設定 |
| HF-H04 | Ted primary workstation baseline | OS patch、disk encryption、EDR、separate browser profiles | 未核對／未設定 |

全部品牌、型號與數量均為建議預設，採購時查價；不得宣稱已購買或已設定。

## 5. Infrastructure Ready

這是唯一 Infrastructure Ready 清單；勾選只代表建立事實與 evidence 可解析，不代表功能上線、production readiness、任何標籤為 true 或測試通過。

| HF-ID | 建立事實 | Evidence | 檢查者 | 完成 |
| --- | --- | --- | --- | --- |
| HF-I01 | OD-01…OD-28 與 ADR-066…ADR-079 已記為現行決定 | decision digest；`07 §3`、`07 §5` | Ted | □ |
| HF-I02 | GHEC、Freedom organization、seats、GitHub App、9 repos 存在 | invoice＋stable-ID inventory | Claude | □ |
| HF-I03 | 主 domain、auto-renew、Workers Paid／Registrar／Pages／Access 存在 | receipt＋account／zone／resource IDs | Claude | □ |
| HF-I04 | preview／staging／production resources、tokens、bindings、alerts 分層 | redacted environment matrix | Claude | □ |
| HF-I05 | production＋staging PostgreSQL、Hyperdrive、PITR／backup 與 bootstrap path 存在 | cluster／binding／setting IDs | Claude | □ |
| HF-I06 | KMS／HSM、A／B key purposes／identities、offline C plane 存在 | redacted policy／key IDs | Claude＋Ted custody | □ |
| HF-I07 | 4 Queues、3 R2 buckets、Workflows、12 runtime resources／identities 存在 | IaC state／resource IDs | Claude | □ |
| HF-I08 | LINE、Discord、email 與 GitHub webhook endpoints 存在 | provider／channel IDs | Claude | □ |
| HF-I09 | O1 AI、render、monitoring、e-sign accounts 與 budgets／caps 存在 | account／project IDs＋alerts | Claude | □ |
| HF-I10 | password manager、WebAuthn／offline recovery 與 security／billing register 存在 | redacted inventory／receipts | Ted＋Claude | □ |
| HF-I11 | 法務與會計 engagement 已送出，matter／case IDs 存在 | engagement／submission receipts | Ted | □ |
| HF-I12 | AI 有 9 repo write、scoped deploy、staging migration、sandbox access path | grant／secret-ref matrix，不含值 | Claude | □ |
| HF-I13 | evidence index 能解析 stable ID／receipt／owner／renewal／revoke path | `execution/evidence/EP-FOUNDATION-<date>/INDEX.md` | Claude；test 未跑 | □ |
| HF-I14 | 第一家 Store sandbox binding 存在且 origin 在 Seller 自有 hosting | Store／origin／binding refs | Claude | □ |
| HF-I15 | 第一個 `seller_collection` ref 存在且 provider 帳號在 Seller 名下 | ownership evidence＋connection ref | Claude＋Ted 核對角色 | □ |
| HF-I16 | Freedom 品牌 ChannelConnections 存在且帳號在品牌 owner 名下 | channel／connection refs | Claude 核對＋Hao 核對角色（Hao 當日不便時 Ted 代核並記移交） | □ |
| HF-I17 | skill registry 與 reference Store Pages 存在，Store 無 checkout | URLs＋mode／binding evidence | Claude | □ |

完成語句：`Infrastructure Ready：__/17；evidence index digest=＿＿；記錄時間=＿＿`。正式建立前保持空白。

## 6. Day 1 順序

只有 API、account、resource、schema 等技術依賴決定先後；無依賴 lane 同時進行。2FA／WebAuthn、recovery、rotation、restore、incident exercises 同日啟動並持續，結果只控制 `SLO`、`production-signed`、`recovery` 與 public traffic；全部測試目前未跑。

| 順序 | 技術依賴／並行 lane | 核心團隊動作 | AI 動作 | 輸出 |
| --- | --- | --- | --- | --- |
| 1 | 無 | 記錄 42 項 working defaults；建立 vendor billing identity；下單硬體；開 password manager；盤點 legacy | 建 decision／billing／evidence／legacy templates | decision index、orders、billing identity、inventory |
| 2-P | 無，與 2-S／2-M 並行 | 以 Platform 身分建立全部 O1 帳號並完成付款／法律文件 A4、安全設定與 break-glass 邀請 | 產生 teams／roles／token／budget／cap manifests | O1 account／plan／project IDs、receipts |
| 2-S | SellerParty／sandbox／origin 無依賴；Store fork 依賴 repo | Ted 以第一個 Seller 身分建立 SellerParty、綠界 sandbox 與 Seller origin（建議預設，五人共同閱讀時確認） | 建 adapter、Store binding、connection 與未跑 tests | Seller-owned account／origin／refs |
| 2-M | 無；品牌 lane 可在 Day 1 或之後執行，不阻擋 O1、Seller lane或其他工作 | Hao 以品牌 owner 身分建立 X／Meta／YouTube；Hao 當日不便時由 Ted 以品牌名義先開並同日移交 owner／admin | 建 ChannelConnections 與 fixtures | brand account／channel／refs |
| 3 | Cloudflare account 存在 | 對 exact domain／年期付款並開 auto-renew | 設 DNSSEC、zones、URL roles、mail records | domain／zone IDs |
| 4 | GitHub organization、Cloudflare account、domain 存在 | 完成需要 dashboard 登入的 repo／DB／LINE／Discord／email 動作 | scaffold 9 repos；建 production＋staging PostgreSQL、IaC、callbacks | repo／DB／channel IDs |
| 5 | PostgreSQL 與 Cloudflare resources 存在 | 完成剩餘 dashboard clicks／invites | 建 Queues、R2、Workflows、12 runtime resources、bindings、monitoring | resource graph＋access matrix |
| 6 | 各自的 O1／O2 account 與 callback 存在；O3 不依賴真帳號 | 各 owner 核對 Platform／Seller／品牌 ownership 與 receipts | 已存在的 O1／O2 真 sandbox 接線；尚未建立的品牌 lane 留在同 lane，不阻擋其他工作；O3 mocks；三 CLI configs | owner-classified connection／mock inventory |
| 7 | stable IDs 可讀 | 記錄人類列 evidence | 核對 HF-I01…HF-I17 並建立 evidence index | Infrastructure Ready 記錄 |

Production 與 staging resources 同日建立；production 維持零 public traffic，直到 Ted 對 exact production release 執行對外正式發布類 A4。建立失敗要留下 evidence 與修復工作，不縮小 Day 1 scope。其後階段依 `06 §6` 與 `08 §13.4` 推進。

## 7. 一頁總表

| HF-ID | 工作 | Owner | Evidence | 完成 |
| --- | --- | --- | --- | --- |
| HF-C01 | 記錄 HF-D01…HF-D42 與 Ted replacement | Ted | decision digest | □ |
| HF-C02A | 建立 O1 全部平台資產 | Ted 以 Platform 身分 | receipts／account／app IDs | □ |
| HF-C02B | 建立 O2 第一個 Seller 與品牌 connections | Ted（Seller）／Hao（品牌）（建議預設，五人共同閱讀時確認） | ownership／binding／connection refs | □ |
| HF-C03 | 購買硬體並做同日安全設定 | Ted | asset／enrollment inventory | □ |
| HF-C04 | 建 9 repos、production＋staging、Queues、R2、Workflows、12 runtimes | Ted＋AI | stable IDs／IaC state | □ |
| HF-C05 | O1／O2 真 sandbox 接線；O3 contract tests＋deterministic mocks | Ted＋Hao＋AI（分工為建議預設，五人共同閱讀時確認） | connection／channel／mock inventory；tests 未跑 | □ |
| HF-C06 | 建 roles、secret refs、billing／renewal／alerts、可撤 AI access | AI；Ted 保管 root | redacted access matrix | □ |
| HF-C07 | 完成 HF-I01…HF-I17 記錄 | Claude 核對＋Ted | evidence index digest | □ |
| HF-C08 | Day 1 之後（`08 §13.4`／`06 §6`）：階段 1A 凍結全契約並執行 FW-01…FW-12 | Codex／Grok／Claude | contract digest＋AI reports；tests 未跑 | □ |
| HF-C09 | Day 1 之後（`08 §13.4`／`06 §6`）：9 repos＋56 packages＋21 現有 specs／35 待建立 specs＋12 runtimes 全形狀 skeleton | Codex | commits／resource refs | □ |
| HF-C10 | Day 1 之後（`08 §13.4`／`06 §6`）：三 CLI 與 O1／O2 adapters 真 sandbox 接線；O3 mocks | Codex | adapter／mock logs；tests 未跑 | □ |
| HF-C11 | Day 1 之後（`08 §13.4`／`06 §6`）：階段 2 依 package DAG 補垂直細節與 recovery／acceptance | Ted＋AI | M00–M09 evidence；tests 未跑 | □ |
| HF-C12 | 付款、法律文件、對外正式發布由 Ted 對 exact artifact 一鍵 A4 | Ted | exact signature／receipt | □ |
| HF-C13 | 確認五人建議預設分工；缺 evidence 只維持相應 labels=false | Ted／Hao／Mini／Jason／韋銘（建議預設，五人共同閱讀時確認） | assignment／label ledger | □ |

成員 A4 維持產品語意：Seller `SellerListingRevision`、Supplier `DistributionAcceptance`、Squad `EngagementAllocationPlan`、Payer 當事人（reseller 情境下通常即 Seller）的 `SettlementMandate`、`ProjectRelease` approval 等都由該當事人對 exact digest 簽署。平台建置的 AI review 與 Ted 三類 A4 不取代這些簽名。
