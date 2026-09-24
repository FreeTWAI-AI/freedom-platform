# 2026-09-24 技能組：計畫全文補讀與契約修正

這份報告補完首輪技能組報告（[audit-2026-09-24-skills.md](./audit-2026-09-24-skills.md)）承認沒讀完的部分：05 §11–15、OpenAPI 全文、核心狀態機全文，以及 contracts 目錄其他檔案。依讀到的內容修正投稿入會、rank 及 onboarding 範圍的契約問題。

- 分支 `audit/skills-20260924`，base `8338a42`。協調者 review 後提交；沒有 push、部署，也沒有對外發訊息。
- 執行模型：`claude-opus-5-5`（Claude Opus 5.5）。第一輪與 root 審閱後的第二輪修正都是同一模型。
- 兩次實際 CLI 成功輸出的 `modelUsage.canonicalModel` 都是 `claude-opus-5-5`，sessions 為 `121aa79a-026d-4619-8e9c-038a052b3562` 和 `6ca5c4e9-90af-43b7-9448-e5da30dc1a80`；第二輪完整結果在 `/tmp/freedom-audit-skills-contract-followup.json`。
- 第一輪只改了 `docs/platform-plan/contracts/` 內兩個檔案，新增一個 contracts 測試和這份報告。第二輪經 root 限定授權，又改了 onboarding 契約、contracts README，以及 `02` §4.5 表格的 `ai-online` 那一列（見 §2.4–2.5）。UI、`tests/e2e`、首輪報告、`05`、00／01／03 等核心文件、verification 與 inventory 都沒有動。
- 下面「已讀」指用 Read 工具分段把內容讀進模型，不是只用程式統計或看 diff。多數分段約 400 行，最大一段是 516 行（`core.example.yaml` 1601–2116）；各檔的實際區間照下表列出。和舊版的比較是另外用 `diff` 做的，兩者分開列。

## 1. 已讀清單（本輪）

本组在整體 44 份原始 plan/spec 的閱讀分工中負責以下 16 份，均已完整讀過；首輪讀 02、spec-index 及 13 份 spec，補讀輪讀完 05。其餘原始計畫由 root 與其他組讀取，不能用本組這 16 份冒稱全體 44 份完成。contracts 全文另外列在 §1.1。

| 原始 plan/spec | 完整閱讀行數（修改前） |
| --- | --- |
| `02-architecture-repositories.md` | 641 |
| `05-integration-contracts.md` | 1142 |
| `execution/spec-index.md` | 138 |
| `BLD-01`、`BLD-02`、`BLD-03` | 各 84 |
| `BLD-04`、`BLD-05` | 各 85 |
| `AGT-01`、`AGT-02` | 各 84 |
| `AGT-04`、`AGT-05` | 各 85 |
| `INT-03A`、`INT-03B` | 84、85 |
| `SKL-01`、`SKL-03` | 各 85 |

### 1.1 逐行全讀

| 檔案 | 行數 | 讀取區間 |
| --- | --- | --- |
| `05-integration-contracts.md` | 1142 | 1–400、401–800、801–1142（§1–19 全部，包括 §11–15） |
| `00-current-requirements-baseline.md` | 194 | 1–194 |
| `contracts/README.md` | 98 | 1–98 |
| `contracts/openapi-outline.yaml` | 9175（修改前） | 1–400、401–800、…、8401–8800、8801–9175，共 23 段，未跳段 |
| `contracts/state-machines/core.example.yaml` | 2116 | 1–400、401–800、801–1200、1201–1600、1601–2116 |
| `organization-professions.example.yaml` | 347 | 1–347 |
| `agent-work-contract.example.yaml` | 288 | 1–288 |
| `submission-intake.example.yaml` | 201 | 1–201 |
| `commerce-distribution.example.yaml` | 191 | 1–191 |
| `discord-channel-map.example.yaml` | 80 | 1–80 |
| `line-template-map.example.yaml` | 200 | 1–200 |
| `entitlement-catalog.example.yaml` | 96 | 1–96 |
| `entity-playbook.example.yaml`／`.schema.json` | 164／163 | 全部 |
| `event-catalog.example.yaml` | 195 | 1–195 |
| `event-envelope.schema.json` | 173 | 1–173 |
| `member-onboarding.example.yaml`／`.schema.json` | 68／174 | 全部 |
| `operating-policy.example.yaml` | 101 | 1–101 |
| `xp-policy.example.yaml`／`.schema.json` | 36／132 | 全部 |
| `skill-package.example.yaml`／`.schema.json` | 75／473 | 全部 |
| `work-participation.example.yaml` | 132 | 1–132 |
| `work-participation.schema.json` | 808 | 1–420、421–808 |
| `domain-skill-overlay.example.json`／`.schema.json` | 77／245 | 全部 |
| `portable-activation.example.json` | 1014 | 1–400、401–800、801–1014 |
| `portable-activation.schema.json` | 1153 | 1–400、401–800、801–1153 |
| `project-manifest.example.yaml` | 181 | 1–181 |
| `project-manifest.external-personal-fork.example.yaml` | 180 | 1–180 |
| `project-manifest.schema.json` | 2437 | 1–400、401–800、801–1200、1201–1620、1621–2040、2041–2437 |
| `project-status-attestation.example.yaml` | 132 | 1–132 |
| `project-status-attestation.schema.json` | 1151 | 1–400、401–800、801–1151 |

合計：contracts 目錄全部頂層 schema／example（`*.json`、`*.yaml`）、README、OpenAPI 與核心狀態機都已逐行讀完。

### 1.2 只讀相關段落（不算全讀）

- `03-domain-events-state-machines.md`：用 Grep 找出所有 rank／profession_membership 的出現位置，再讀 318–327（投稿段）、1094–1119（§7.3.1 membership）、1140–1161（§7.4 SkillVersion）。其餘由其他組負責。
- `execution/specs/AGT-02.md`、`INT-03B.md`：只用 Grep 看 Star／grant／revoke 相關行（AGT-02:18–64、INT-03B:18–85 的相符行）。BLD-01–05、其餘 AGT／INT／SKL 規格、`02`、`execution/spec-index.md` 本輪沒有重讀，沿用首輪的閱讀結果。
- `docs/development/guild-development-access.md`：用 Grep 看 grant、revoke、書籍、Star 相關行（5–177 的相符行）。
- `contracts/tests/`：只讀 `test_reviewer_appointment_entitlement.py` 1–60 行，用來對齊測試寫法；其他測試檔和 `fixtures/` 只看目錄。
- 首輪報告 `audit-2026-09-24-skills.md`：全文讀過（1–173），沒有修改。

### 1.3 與舊版比較（diff，不算閱讀）

和 `/home/ted-h/projects/Freedom-Platform/docs/platform-plan` 比較（舊版目錄不是 git repo，只能用檔案比較）：

- `05`：只差狀態列的日期（09-17 → 09-19），以及新增的 §18.1 低維運互惠。
- contracts：不同的檔案有 README、agent-work、event-catalog、openapi（舊 8791 行 → 新 9175 行）、project-manifest.schema、core 狀態機。新版另外有 operating-policy、work-participation 與多個測試和 fixture。`organization-professions.example.yaml` 兩版相同。
- 這次修的兩個問題在舊版也存在：舊 openapi 第 2093–2094 行有自動入會的說法，第 4152 行有 `const: runner`。所以不是新版改壞的，一律以 repo 最新版和 00:7 的最新決定為準。

## 2. 已修正的契約問題

### 2.1 投稿不代表加入公會

依據是 `00-current-requirements-baseline.md:7`（2026-09-23）：「Guild 由本人選擇加入，登錄作品不自動替本人加入其他 Guild。」

| 位置 | 修改前 | 修改後 |
| --- | --- | --- |
| `openapi-outline.yaml` `/review-submissions` `createReviewSubmission` 的 description（原 2091–2096） | 首次 software／Skill／code 投稿會建立 AI Vibe Runner ProfessionMembership | 投稿只記錄來源、確切版本／digest 與證據，歸屬到提交的本人；不會建立、變更或推論任何 Guild／ProfessionMembership（包括 AI Vibe）。投稿不代做自助入會，自助入會是另一個指令，由本人自己選公會並確認；metadata maintainer 任命不代為加入 AI 公會；經另外授權、有稽核的管理員任命是獨立指令，不受影響（第二輪收窄）。投稿也不給 rank、不讓商品變成可售 |
| 同一個 operation | 沒有 invariant | 新增 `x-invariants`，共四條：只記錄證據；不建立或推論 membership；投稿不代做自助入會，自助入會另走本人選擇並確認的指令；metadata maintainer 任命不代為加入 AI 公會 |
| `organization-professions.example.yaml` `participation_rules`（原 327） | `first_…_submission_creates_ai_vibe_runner_membership_and_starting_evidence_only` | 換成三條：`a_submission_records_source_version_and_evidence_only_and_never_creates_or_infers_guild_or_profession_membership`、`a_submission_never_performs_a_self_service_guild_join_and_a_self_service_join_stays_a_separate_member_selected_and_confirmed_command`，以及 `a_metadata_maintainer_appointment_never_joins_the_appointee_to_an_ai_guild` |

第二輪收窄了範圍。第一輪寫的是泛用的 `joining_a_guild_requires_the_member_to_select_…`，OpenAPI 的 invariant 也寫成 `guild_membership_requires_a_separate_member_selected_…`。這兩條會被讀成連「管理員明確任命並入會」（`admin_join_guild`）都禁止，但那條路徑原本就有使用者授權。所以兩處都改成只限制兩件事：

- 投稿不能代替本人自助入會，也不能推論出入會。
- metadata maintainer 任命不會代為加入 AI 公會。

OpenAPI 描述另外寫明：經另外授權、有稽核的管理員任命是獨立指令，不受這條規則影響。本輪沒有阻擋、也沒有修改 `admin_join_guild`。

其他 contracts 的核對結果：

- `core.example.yaml` 的 `review_submission` 狀態機本來就沒有 membership 效果。
- `event-catalog`、`submission-intake`、`agent-work-contract`、`entitlement-catalog` 都沒有「投稿即入會」的 invariant，不用改。

### 2.2 `ProfessionMembershipSummary` 的 rank

- 問題：`rank` 寫成 `const: runner`，`state` 卻允許 `strategist`、`master` 等狀態，兩者互相矛盾。
- 對照依據：
  - `core.example.yaml:86-140`：ProfessionMembership 的狀態依序是 runner → strategist_review → strategist → master_review → master，任何狀態都可以進 left。
  - `03:1116`：要求更多證據時保留原本的 rank。
  - `organization-professions` 的 `rank_ladder` 是 runner／strategist／master 三級。
- 修改後的 schema：
  - `rank` 改成 `enum: [runner, strategist, master]`。
  - 用 `allOf` 加上最小的狀態對照：`runner` 和 `strategist_review` 對應 `rank=runner`；`strategist` 和 `master_review` 對應 `strategist`；`master` 對應 `master`；`left` 保留最後記錄的 rank，不另外限制。
- 建立時的限制和讀取時的 rank 分開寫在 `x-invariants`：
  - 新建立或本人確認的 membership 一律是 `state=runner`、`rank=runner`。
  - 重複呼叫建立指令時，如果回傳的是既有 membership，照原本的 rank 回傳。這點很重要，因為 `createMyProfessionMembership` 的 201 回應本來就寫「或回傳既有 active membership」，所以連建立回應也不能硬寫成只有 runner。
  - 審查中的狀態保留原本的 rank。
  - `left` 保留歷史 rank。
- 這是為未來 canonical 契約做的一致性修正，本輪沒有新增升級 rank 的功能。
  - 執行中的 preview 契約（`contracts/preview/v1/definition.mjs:28`、`packages/sdk/client.d.mts:12`）和 migration `002` 都只有 runner。這符合目前執行版只有 runner 的事實，所以沒有改。
  - 將來執行版支援升級 rank 時，要另外把 preview 升一個版本。

### 2.3 新增測試

新增 `contracts/tests/test_membership_submission_contract.py`，第二輪後共 31 個案例，全部是合成資料，不連網：

- state 的 enum 要和核心狀態機一致，rank 的詞彙要和 rank_ladder 一致。
- 狀態和 rank 相符的組合有 8 個正例，互相矛盾的組合有 8 個反例。
- 建立時的限制有寫在 invariant 裡。
- 投稿的描述和 invariant 裡沒有入會效果，`review_submission` 狀態機的轉換也不涉及 membership。
- `participation_rules` 已換成新規則，並且不能再出現 `joining_a_guild_requires…` 這種泛用寫法；投稿描述必須明寫管理員任命是另外的指令（第二輪）。
- onboarding 跨契約語義（第二輪，見 §2.4）：
  - OpenAPI 三個 operation 的描述和 `ConfirmMyOnboardingBundleRequest` 必須寫明入口前提，並且不能再出現舊的「optional positioning」或「without requiring a positioning assessment」。
  - schema 的 title 和 x-invariants 必須點明這是後續旅程、不是捷徑。
  - schema 和 OpenAPI 的 step `enforcement` 都必須固定是 `navigation`，step kind 兩邊要一致。
  - example 必須通過 schema；如果定位步驟是 skipped，id 和頂部註解就必須表明它是既有 `onboarding_required=false` 帳號。
  - 契約引用的 `onboarding_required`、`onboarding_completed_at` 欄位確實存在於 `migrations/005`、`024`（只做靜態讀檔）。

能抓舊版的驗證（暫存目錄，跑完即刪）：

- 第一輪：把兩個修改過的契約檔換回 HEAD，21 項中有 10 項失敗；換回修正版後全部通過。
- 第二輪：把四個契約檔（openapi、organization-professions、member-onboarding schema／example）換回 HEAD，31 項中有 18 項失敗，新增的 onboarding 與收窄範圍的測試全部都在失敗之列。
- 第二輪另外只把第一輪那條泛用的 `joining_a_guild_requires…` 規則放回去，結果剛好 1 項失敗（`test_participation_rules_separate_submission_from_guild_join`）。

### 2.4 onboarding 契約：後續公會／Agent 歡迎旅程，不是新會員入口捷徑（第二輪）

root 讀過 member-onboarding 的 schema／example 和 `05` §10.1 後確認：這份契約是 Agent 安裝與公會 welcome 的後續旅程。裡面的 navigation 和 skippable 不代表撤掉新會員入口的定位 gate。執行版的入口 gate 在 `apps/platform-api/src/app.ts:150`（`onboarding_required` 且沒有 `onboarding_completed_at` 就回 403）。本輪只改契約的文字，不改 runtime。

| 位置 | 修改 |
| --- | --- |
| `member-onboarding.schema.json` title | 從「day-one onboarding」改成「post-positioning Guild and Agent welcome journey（已完成平台定位，或既有 `onboarding_required=false` 帳號）」 |
| 同上 `x-invariants` | 新增三條：旅程在新會員入口之後才開始，不是註冊或定位捷徑；navigation／skippable 只在旅程內有效，不豁免入口的定位 gate；定位步驟反映入口的事實，新會員是 satisfied，只有既有 `onboarding_required=false` 帳號才會是 skipped，而且不追溯封鎖這些老會員 |
| `member-onboarding.example.yaml` | 頂部加上註解；`journey_id` 從 `journey_demo_member_ai_vibe` 改成 `journey_demo_existing_member_post_positioning_guild_agent_welcome`，表明 skipped 的定位屬於舊會員 |
| `openapi-outline.yaml` `/me/onboarding-bundles` | 描述改成「後續公會與 Agent 歡迎指令」，只給已完成平台定位或 `onboarding_required=false` 的帳號使用，不是註冊或定位捷徑；新增 3 條 `x-invariants`，其中一條明寫 welcome、equip、installation 維持 navigation，不會變成 action_gate |
| 同上 `/me/work-intents` | 刪掉「without requiring a positioning assessment」，改成：入口之外不再另要求定位；只給上述帳號使用 |
| 同上 `/me/onboarding-journeys/current` | 刪掉「optional positioning」，改成入口定位事實（新會員 satisfied；只有舊帳號 skipped） |
| 同上 `ConfirmMyOnboardingBundleRequest.description` | 說明定位不列為本指令的欄位或前提，是因為入口已經強制做過（有 `onboarding_completed_at`），或帳號是既有 `onboarding_required=false`；本請求不豁免、不取代、也不滿足新會員的定位 gate |
| `contracts/README.md` 第 17–18 行 | 兩個 onboarding 檔案的說明同步改寫 |

沒有做的事：

- 沒有把 welcome 或技能安裝改成 action_gate。
- 沒有追溯封鎖老會員。
- 沒有動 `05` §10.1，由 root 自己修。

### 2.5 `02` §4.5 `ai-online` 那一列（第二輪）

上方 2026-09-23 的覆寫註記說：`ai-online` 只參考探索形式、題目重設為原創，新會員必須做定位。但表格仍寫「deterministic 定位評量參考」「golden fixtures；shadow parity 後成 optional assessment」。本輪只把這一列的兩欄改成和覆寫一致：只參考探索形式、不做 golden／shadow parity、不做 optional assessment、新會員必做原創定位、新舊 version/hash 分開保存。表格其他列都沒改。

## 3. 分工時快照：交給 root 的核心文件 prose（本組沒有改）

下表是第一輪分工時，本分支（base `8338a42`）看到的內容快照。當時這些段落仍然把「首次投稿就建立 AI Vibe Runner」寫成規則，和 00:7 衝突，建議統一改成：「投稿只形成來源／證據；自助入會必須本人另選並確認，不從投稿推論。」

之後 root 已經在另一處另外修正了所有 prose 裡的 auto-join 說法。本分支沒有合入那些修改，所以下表只代表分工時的狀態，不代表最終 repo 仍然沒修。合併後要再核對一次，確認這些行已經換成新規則。

| 位置 | 現況 |
| --- | --- |
| `00-current-requirements-baseline.md:108`（§4） | 「結構有效且提交者本人確認的首次 software／Skill／code candidate，直接建立 AI Vibe Runner」。和同一份文件第 7 行互相矛盾 |
| `01-product-community-model.md:192`、`:359` | 同上 |
| `03-domain-events-state-machines.md:325` | 「並可啟用 `ai_vibe` Runner ProfessionMembership」 |
| `04-module-specifications.md:258`、`:746` | 「可啟用 AI Vibe Runner」 |
| `06-delivery-plan.md:455` | 同上 |
| `07-decisions-risks-traceability.md:106` ADR-015 | adopted 欄位仍含自動建立 membership。建議用新 ADR 或 revision 取代這一段，不要直接改寫歷史 |

相鄰的兩條路徑：

- `docs/development/platform-admin-api.md:36,46` 的管理員明確任命並入會（`admin_join_guild`）原本就有使用者授權，而且記入管理稽核，不冒稱是會員自己加入。本輪沒有阻擋它，也不把它列為待決問題。本輪限制的只有兩件事：投稿不能推論出入會；metadata maintainer 任命不代為加入 AI 公會（見 §2.1）。
- `entitlement-catalog.example.yaml:29` 寫「claim command 可自助選擇或建立 Runner」。這仍然是本人在 claim 時明確選擇，不算推論；實作時必須是明示的選項，不能預設勾選。

## 4. 首輪報告 C2、C3、C6 的更正解讀

### C2：投稿的草稿流程和 SkillVersion／QC 不是同一個 aggregate

目前有四個互相獨立的 aggregate，不能因為名稱不同就改產品的 enum：

| Aggregate | 狀態 | 來源 |
| --- | --- | --- |
| 執行版技能投稿 `skill_submissions` | awaiting_upload → ready_for_review → published → revoked | `migrations/028_skill_submissions.sql:24` |
| 規劃中的 SkillVersion | registered → candidate → official → deprecated → withdrawn | `03:1149` |
| 規劃中的 ReviewSubmission／QualityReview | submitted → in_review → changes_requested／accepted | `core:1480-1512` |
| 規劃中的 intake `SubmissionDraft` | draft → confirmed／rejected／expired | `core:1041`；OpenAPI 明寫它和 work_submission、DraftArtifact 分開 |

建議的對照：

- 執行版的 `published` 相當於公開、可發現的 candidate，也就是 03 的 `registered`／`candidate`，以及 05 §9.2 的 metadata-only candidate。它永遠不等於 `official`。首輪確認介紹頁有標示「社群投稿，不是官方公會技能」，這和契約一致。
- `official` 只能由另一位自然人的 QualityReview 簽章，加上 fork 檢查與 attestation 取得。現在的執行版沒有這條路徑，屬於未來範圍。
- 執行版的 `revoked` 是作者撤回投稿，不等於審查後版本的 `deprecated`／`withdrawn`。
- 首輪說「沒有狀態機」不準確。SkillVersion 在 03 §7.4 已經有狀態機，真正缺的是 core 機器可讀檔裡沒有 `skill_version` 這台機器，也沒有執行版和規劃之間的對照表。建議 root 在計畫文件補一張對照表，不必急著動產品 enum。

### C3：已領的技能書和開發授權是兩回事

- 依據是 `guild-development-access.md:15,88-92`：
  - 最後一個適用資格來源消失時（離開最後一個 AI 公會；OR 來源），才撤銷開發 grant 和由它衍生的 key。
  - 草稿、已發布作品、PR、署名，以及「已領取書籍」都保留。
- 所以不是「技能書的 grant／revoke 沒寫進規劃」。實際上是兩件事：
  - 領書紀錄是持有或閱讀的紀錄，離會後仍然保留。
  - 開發能力是 capability grant，依公會資格重新計算，離開最後一個適用公會就撤銷。
- core 狀態機 `profession_membership → left` 沒有撤權效果，這是對的，因為開發 grant 是執行版 development-access 自己的 capability，不是規劃中 Agent 用的 `ExecutionGrant`。
- 如果要補契約，建議 root 評估兩件事：
  - 在 entitlement／capability 契約加一條「開發能力由資格來源推導、離開最後來源時撤銷」。
  - 明寫「領書紀錄不是權益，不隨離會撤回」。
- 首輪「需要 ADR 決定技能書 grant／revoke」的說法應該撤回。

### C6：在瀏覽器由本人按 Star，不是 Agent 用的 ExecutionGrant

- `AGT-02:34`、`INT-03B:34,65` 和 `00:142` 規範的是由 Agent 代為執行的 `github.star`：必須本人決定、有明示且可撤銷的 grant，並由本人的 AgentConnection 執行；平台觸發、批量操作或用獎勵誘導都禁止。
- 瀏覽器裡由本人明確點 Star，是本人自己的操作（principal session），不是 Agent 代做：
  - `guild-development-access.md:117-121`：GitHub user authorization 只允許「在你按下 Star 時」執行；每次點擊就代表這一次的操作意圖；連線本身不會按星，也不會批量按星。
- 兩種授權的前提不同，不應混為一談，也不需要 ADR 來證明兩者等價。
- 「強制按星才能領書／推廣」是使用者明確要求但尚未落地；建議改成自願的替代方案尚未獲使用者同意，不得寫成已採納。GitHub AUP 的適用風險另由 root 依官方來源記錄，本報告不冒稱 GitHub 已對本案裁定。Follow 與 Watch 是不同 GitHub 操作，現有 UI 都保留，站內 Follow 寫入尚未實作。

## 5. 全文讀過後的其他發現（第 1 項已在第二輪修正，其餘未修改，交協調者判斷）

1. **定位是否必做：已在第二輪修正範圍上的歧義，不再是待決的政策問題。**
   - 第一輪看到的是文字歧義：契約把定位寫成可選或可略過（work-intents、ConfirmMyOnboardingBundleRequest、onboarding-journeys/current、example 的 skipped 定位），看起來和 `00:5` 的「新會員必須定位」衝突。
   - root 確認後的解讀是：這些契約描述的是入口之後的後續公會／Agent 歡迎旅程，本來就不是新會員入口；入口 gate 仍然必做。
   - 第二輪已經把契約文字改成明確寫出這個範圍（見 §2.4），並加上能抓到舊版的測試。
   - `05` §10.1 由 root 自己修，本組沒有動。
2. **rank 事件的 aggregate 名稱不一致。** `event-catalog:11` 的 `freedom.organization.rank.recorded.v1` 標記 aggregate 為 `profession_rank_record`，但 core 狀態機是在 `profession_membership` 的轉換上發出這個事件。03:1116 提到了不可變的 RankRecord。建議 root 決定由哪個 aggregate 發出這個事件。
3. **兩份 navigation 狀態的 enum 不一致。** `member-onboarding.schema.json` 的 `navigation_status.state` 少了 OpenAPI `NavigationStatus` 裡的 `missing`／`unknown`／`not_applicable`。目前 OpenAPI 是超集合，fixture 仍然有效；正式化時應該統一來源。
4. **投稿的 201 回應沒有 schema。** `/review-submissions` 的 201 回應沒有 response schema，屬於規劃中的缺口。

## 6. 實際執行結果

| 命令 | 結果 |
| --- | --- |
| `python3 -m pytest … test_membership_submission_contract.py` | 第一輪 21 passed；第二輪 31 passed |
| 同一份測試，對 HEAD 版本的契約檔（暫存副本） | 第一輪（兩個檔）10 failed、11 passed；第二輪（四個檔）18 failed、13 passed |
| 第二輪：只把泛用的 `joining_a_guild_requires…` 規則放回去（暫存副本） | 1 failed、30 passed |
| `npm run test:contracts`（= `pytest docs/platform-plan/contracts/tests docs/platform-plan/execution/tools/tests`） | 第一輪 649 passed、4 skipped；第二輪 659 passed、4 skipped，都是 exit 0。4 個 skip 是既有的 `test_five_clock_invariants.py:118`「clock has fewer than 3 schema paths」，和本輪修改無關 |
| README 指定的 OpenAPI 驗證（`openapi-spec-validator` 0.9.0，帶 base_uri） | 兩輪都 PASS，paths=163、schemas=290 |
| `member-onboarding.example.yaml` 對 schema（Draft 2020-12） | 第二輪 0 個錯誤（也包含在上面的測試裡） |
| `git diff --check` | 兩輪都通過 |

沒有執行（not_run）：

- `npm run typecheck`、`build`、`test`、`test:e2e`、`test:repos`。兩輪都沒有改程式或 UI；第二輪的新測試只靜態讀取 migration 檔的欄位名稱，不連資料庫。
- `tests/runtime/flows.test.ts` 會讀 OpenAPI，但只驗 `ClaimWorkItemRequest`／`WorkClaim`，這兩個本輪沒有改；它需要隔離的資料庫，所以沒有跑。
- 本輪沒有呼叫任何 provider、GitHub 或資料庫，所有驗證都是靜態的契約測試。

## 7. 變更檔案

- `docs/platform-plan/contracts/openapi-outline.yaml`：`createReviewSubmission` 的描述與 x-invariants（第二輪收窄範圍）；`ProfessionMembershipSummary` 的 rank enum、allOf 對照、x-invariants 與描述；第二輪加上 `/me/onboarding-bundles`（描述＋x-invariants）、`/me/work-intents`、`/me/onboarding-journeys/current` 與 `ConfirmMyOnboardingBundleRequest` 的描述。
- `docs/platform-plan/contracts/organization-professions.example.yaml`：`participation_rules` 一條換成三條（第二輪收窄範圍）。
- `docs/platform-plan/contracts/member-onboarding.schema.json`：title 與 x-invariants（第二輪）。
- `docs/platform-plan/contracts/member-onboarding.example.yaml`：頂部註解與 `journey_id`（第二輪）。
- `docs/platform-plan/contracts/README.md`：onboarding 兩列的說明（第二輪）。
- `docs/platform-plan/02-architecture-repositories.md`：只改 §4.5 表格 `ai-online` 那一列（第二輪）。
- 新增 `docs/platform-plan/contracts/tests/test_membership_submission_contract.py`（第二輪擴充）。
- 新增這份報告。
