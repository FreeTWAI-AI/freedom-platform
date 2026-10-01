# Registration → positioning → guilds

All paths below are under `/api/v1`; authenticated writes use CSRF, `Idempotency-Key`, and `If-Match` of the current assessment `aggregate_version` (omit only the first draft save). Server scoring alone is authoritative. Public member cards never expose answers, occupation, raw scores or founding interest. 公會小問題的答案同樣只留在本人的定位資料，不進名片、分享名片、推薦、其他會員看得到的目錄、管理 API、日記或 outbox。

## Interrupted saves

The portal bounds a request, including its response body, to 20 seconds. A network error, incomplete success response, or HTTP 5xx leaves the write outcome unknown: the database may already have committed. Keep the exact command body, `Idempotency-Key`, and `If-Match` in page memory; freeze its inputs and offer **重試保存**. Replay only that command after an explicit click. In particular, a failed `evaluate` response must not repeat the preceding `answers` command, and a failed `complete` response must not submit different guild choices. Do not automatically retry mutations or invent a successful completion.

A confirmed 412/428 permits **重讀保存版本**: fetch the latest onboarding view, retain the member's current input, and require another explicit save. This read does not overwrite the remote draft. Answers are not placed in localStorage; reloading or leaving the page can lose input that has not been confirmed saved.

POST responses from the application include a generated `X-Freedom-Request-ID`. The error panel's folded **問題資訊** shows the HTTP status and validated request ID / Cloudflare Ray when present. An edge-generated error may have no application request ID. Operational logging records only stage, status, duration and these correlation IDs, never the assessment payload.

## Endpoints

- `GET /assessment-definition`: `{assessment_version,assessment_sha256,questions:[{id,kind:"preference"|"ability",prompt,options:[{id,label}]}],capability_categories,equipment_categories}`. Render server options. Capability/equipment options have stable `id`, `label`; each category has `id`,`label`,`options` plus `subcategories:[{id,label,options}]`. Flattened `options` remain compatible and are exactly the unique union of the subcategories. Answers have no client scoring inputs.
- `GET /me/onboarding`: `{required,completed,entry_mode:"assessment"|"quick",assessment_completed,assessment_update_required,current_assessment_version,current_assessment_sha256,state:"new"|"draft"|"evaluated"|"completed",draft:null|{aggregate_version,assessment_version,assessment_sha256,answers,occupation,founding_interest,capabilities,equipment},result:null|{recommendations:[{guild_key,name,reason,title}],assessment_version,assessment_sha256},primary_guild_key:null|string,skill_books:[]}`. `entry_mode` is `quick` after quick start and `assessment` after the positioning completion path (also the column default, including existing members). `assessment_completed` is true only when the saved assessment `state` is `completed`. Quick start sets `completed` (records `onboarding_completed_at`) without setting `assessment_completed` or inventing answers. `required` stays true until that timestamp exists. While it is required, other member APIs return 403 `onboarding_required` with「請先選擇主要公會，完成加入後即可使用會員功能。」
- `POST /me/onboarding/answers`: `{assessment_version,assessment_sha256,answers:{[question_id]:option_id},occupation:string,founding_interest:boolean,capabilities:string[],equipment:string[]}`. Partial answers permit saving progress; full category selections are validated. Replacing an evaluated draft clears its recommendation result. Returns the same onboarding view. On completed users, a new save starts a change-of-direction draft without re-locking the account.
- `POST /me/onboarding/evaluate`: `{}`. Requires every question answered; capability and equipment selections may be empty for a beginner. Writes deterministic recommendations and returns the onboarding view. Server requires current version.
- `POST /me/onboarding/complete`: `{guild_keys:string[],primary_guild_key:string,confirmed:true}`. Requires evaluated draft/current version, 1–15 distinct valid chosen guilds, selected primary present among chosen guilds. Recommendations are suggestions: other valid guilds can be chosen. Atomically joins selected guilds, sets exactly one primary, grants repository pointers, marks completion and unlocks new accounts. Does not silently leave existing guilds. Returns updated onboarding view. Sets `onboarding_entry_mode` to `assessment`.
- `POST /me/onboarding/quick-start`: `{guild_keys,primary_guild_key,confirmed:true,guild_answers:{[question_id]:option_id}}`. Allowed while onboarding is required (same session, CSRF and idempotency rules as other onboarding writes). Joins the listed guilds, sets the primary, grants that guild's skill books and records `onboarding_completed_at` with `entry_mode` `quick`. It keeps any unfinished assessment draft and does not invent assessment answers, scores or a completed assessment. `guild_answers` 必須答完主要公會目前題組的每一題，而且每一題都要用該題提供的選項。少答、多答、空值或選項不存在回 422 `guild_answers_invalid`，說明是「請回答這個公會的每一題，並使用題目提供的選項。」，這次不會加入任何公會。答案與加入寫在同一交易。日記與 outbox 只記 `primary_guild_key` 與 `question_set_version`，不放答案本身，也不放題組 sha256。回傳仍是 onboarding view，不含這些答案。Replay of the same command does not join twice. `409 onboarding_already_completed` when joining is already recorded. `422` when the primary guild is not among `guild_keys` (`primary_guild_not_selected`) or a guild key is not in the catalog (`unknown_guild`). 未知公會與「已經完成加入」都先於答案檢查。`POST /me/onboarding/complete` 不要求 `guild_answers`。多選的其他 `guild_keys` 這次可以先不加答案，之後在「我的定位」補。
- `GET /me/guild-answers`：只列本人目前仍加入的公會。`{items:[{guild_key,name,question_set_version,outdated,answers:[{question_id,prompt,option_id,label}]|null,aggregate_version|null,updated_at|null}]}`。還沒回答時，answers、aggregate_version、updated_at 是 null，outdated 是 false，question_set_version 是目前題組版本。已回答時回傳儲存的版本；`outdated` 是儲存的 sha256 和目前題組不同。題目與選項文案依目前題組對上，對不上就留原 id。
- `POST /me/guild-answers/:guild_key`：`{answers:{[question_id]:option_id}}`。必須是該公會的有效會員，否則 409 `active_guild_required`（「請先加入這個公會，再回答小問題。」）。沿用 Idempotency-Key。第一次寫入不要帶 If-Match；帶了回 412 `version_conflict`。更新要帶目前的 aggregate_version，沒帶回 428 `version_required`，不符回 412。成功回傳該筆 item，並送 `ETag`。這次寫入不進日記或 outbox。答案只給本人。
- `GET /guilds`: legacy response shape retained. `GET /guilds/directory`: `{items:[...legacyGuildFields,entry_questions:{version,sha256,questions:[{id,prompt,options:[{id,label}]}]},guild_master:null|{user_id,display_name,avatar_url},guild_experts:[{user_id,display_name,avatar_url}],is_primary:boolean,skill_books:[]]}`. `entry_questions` 是這個公會的題庫，不是會員的答案。內建公會各 4 題；`guild_custom_*` 用同一份 3 題通用題，雜湊仍依公會鍵分開。Unassigned master renders `待任命` with a `公會長` badge. `avatar_url` is a versioned, authenticated local image URL or null; it is not an external image source.

公會物件另含 `alias`（0–100 字，空字串表示沒有別名）與 `profession_title`（0–40 字）。有別名時，介面把公會名稱與別名並排；沒有別名就不顯示分隔或別名。內建公會的職業稱號仍來自定位題目，`profession_title` 保持空字串。管理員核准的自訂公會若有非空 `profession_title`，以該公會為主要公會的成員使用這個稱號；留空時仍顯示「專業探索者」。會員摘要裡的 `primary_guild`、`secondary_guilds`、`joined_guilds` 各帶 `alias`。
- Existing `POST /guilds/:key/join` / `leave`: `{}`; membership ETag applies. Joining grants books atomically. A primary guild cannot be left until a different active membership is made primary. 會員自己加入，以及離開後再加入，成員等級都是 `intern`（實習成員）。已經是有效成員時再按加入，不會把等級改掉。`membership` 物件對本人帶 `member_tier`：`intern` 或 `full`。快速加入（`quick-start`）與完成定位的加入同樣從實習成員開始。
- `POST /guilds/:key/members/:userId/tier`：`{member_tier:"intern"|"full"}`。只有該公會現任會長可呼叫，沿用 session、CSRF、Idempotency-Key 與會員 `aggregate_version` 的 If-Match。對象必須是這個公會的現任成員。會長不能改自己的等級（409 `guild_member_tier_self`）。把會長或在任專家改回實習回 409 `guild_member_tier_locked`。等級真的改變時通知該會員；再寫同一個等級不增加版本、不寫日記、也不通知。非會長回 403 `guild_leader_required`。
- `POST /guilds/:key/experts`：`{user_id,active,reason?}`。現任會長任命或解除專家，最多三位，與管理員任命一起計算（409 `guild_expert_limit_reached`）。會長不能任命自己（409 `guild_expert_self`）。第一次任命省略 If-Match；已有列時要比對專家 `aggregate_version`。任命會把對方的成員等級設為 `full`，並記下 `appointed_by_user_id`。管理員路徑仍用 `appointed_by`，兩者恰有一個有值。
- `POST /guilds/:key/primary`: `{}`; `If-Match` of preference version. Response `{primary_guild_key,aggregate_version}`. `GET /me/guild-preferences` exposes this version. First selection omits version. Active membership required.
- `GET /me/skill-books`: `{items:[{book_id,title,repository_url,fork_url,description,guild_keys,granted_at}]}`. Grants are access pointers to public repository resources, not software installation, GitHub account linking or a completed fork.
- `GET /guild-applications` and `POST /guild-applications`: `{name,profession,reason}` on create. Creates a pending request only. No automatic guild creation or officer privileges. Both return a member-safe projection, as an object from POST and as `{items}` from GET. Fields: `application_id, name, profession, reason, state, aggregate_version, created_at, reviewed_at, review_reason, approved_guild_key, approved_guild_name`. `state` is `pending`, `approved` or `declined`. `approved_guild_name` is the current catalog name; an admin may rename the guild when approving, so it can differ from the name the member submitted. Never returned: `reviewed_by`, `user_id`, `community_id`. Admin review and the approve/reject notifications are unchanged; see [platform admin API](platform-admin-api.md).

After a successful submit the 職業公會 page closes the form and shows「謝謝你的申請！「名稱」已送出，正在審核中。審核結果會通知你，也可以在下方「我的公會申請」查看進度。」「我的公會申請」 lists that member's requests on the same page. Display states are 待審核, 已通過 and 未通過. Each row shows 送出／審核時間 and「審查說明」. 已通過 offers「查看公會」. 未通過 offers「修改後重新申請」, which prefills a new application; the declined record stays as history.

Guild portraits follow the existing member-avatar visibility rules: the owner and viewer must be active, same-community members who have completed required onboarding, and the viewer must have a valid session. Missing/removed images and ineligible viewers receive null. Newcomers can still see guild roles during positioning, using nickname icons without fetching protected photos. The image endpoint rechecks authorization and version when bytes are requested. Pending nominees have no member photo. The directory does not include image bytes, private contacts or additional authority.

Assessment version `freedom-orientation-v2-specialist-guilds` uses six work-preference choices and nine everyday practical scenarios. It includes 15 guilds: the original twelve plus 資安公會, 音樂創作與MV公會, and 廣告攝影與影片公會. Scores recommend guild activities, not clinical personality types, credentials, licenses or job qualifications. Future quiz revisions require a new immutable assessment version/hash. Joining a guild always remains the user's explicit choice. No personal quiz payloads are written to the event outbox.


## Version transition and specialist guilds

The retained v1 identity is `freedom-orientation-v1` / SHA-256 `fa485d9b23a0b7626c85284788297ef4b0425d45f2b7950842646b2a39e844cf`. Existing saved answers and results are never automatically evaluated against the new questions. `GET /me/onboarding` marks a different saved version/hash with `assessment_update_required: true`, returns the saved draft unchanged, and supplies the current definition identity separately. Evaluation and completion return `409 assessment_revision_changed` until the member explicitly saves a current-version draft. Previously answered valid option IDs can be carried forward, but the new security, music/MV and commercial-production practical questions must also be answered. An old response sent with the old definition identity is rejected.

Already completed members stay unlocked, keep their primary/secondary guilds and published capabilities, and may retake the assessment voluntarily. Migration 009 only inserts three guilds and three career directions. It does not appoint leaders, alter memberships, or switch anyone's primary guild.

- `guild_security`: 資安公會; first book `security-scanner`, Ted's existing public scanner repository. A repo author is not automatically the guild leader.
- `guild_music_mv`: 音樂創作與MV公會; first book `music-mv`, an original manual and templates for music/MV planning and delivery. It does not generate or compose music automatically.
- `guild_commercial_production`: 廣告攝影與影片公會; first book `commercial-production`, an original manual and templates for a commercial shoot and delivery. It is not an automatic video-production service.

All three show `guild_master: null` until an officer is explicitly appointed; the UI displays `待任命` with a `公會長` badge. Skills and equipment are self-declared separately and do not grant rank, authority or qualification.


## Preference-first flow and self-declared skill inventory

The client now starts with work preferences, then practical scenarios. Occupation, skills and equipment follow those questions; the API continues to allow partial saves at any point. The scoring version and question weights do not change for this presentation update. Capability/equipment choices, featured skills and optional written notes do not add points or establish a qualification.

`POST /me/onboarding/answers` additionally accepts these **optional** fields; `GET /me/onboarding` returns them in `draft`:

```json
{
  "custom_capabilities": ["台語訪談"],
  "custom_equipment": ["我的錄音服務"],
  "featured_capabilities": ["sales", "custom:台語訪談"],
  "question_notes": {"preferred_result": "我想補充的實際情境"}
}
```

- `custom_capabilities` and `custom_equipment`: at most 10 distinct items each, trimmed single-line text of 1–60 characters. Case/Unicode-normalized duplicates are rejected. They describe the member's own experience or subscriptions, not verified credentials.
- `featured_capabilities`: at most three distinct entries, in the member's chosen display order. Each entry must be an ID in the submitted `capabilities`, or `custom:` followed by the exact trimmed label in `custom_capabilities`. It cannot name an unselected skill or a tool from the equipment list. An explicit empty array means no featured skills.
- `question_notes`: optional notes for current question IDs only, at most 500 characters each. Notes are private to the member's draft and are not scored, projected into member cards, or emitted in events. An explicit `{}` clears notes.
- Omitting new fields preserves already saved custom entries, notes and eligible featured choices for older clients. Removing a selected capability also removes its featured reference if the older client omitted the featured field. A new explicit featured selection containing an unselected reference is rejected.
- A beginner may submit empty capability, equipment, custom and featured arrays and still complete the assessment and choose a guild. The system does not invent strengths for that member.

Migration 012 adds fields without rewriting saved answers, existing completed state, primary guilds or previously published inventories. The member card projection retains full `capabilities` and `equipment` arrays and adds full `custom_capabilities`, `custom_equipment`, plus compact `featured_capabilities` (maximum three). Frontends use the featured list on compact cards and expose the full arrays in details. A legacy snapshot without a featured field falls back to its first three selected capabilities; explicit `[]` is preserved. During a retake, the last confirmed published profile remains visible until the member completes the new draft.

The catalog currently has 20 capability categories / 170 unique options and 8 equipment categories / 45 unique options. Categories have meaningful subcategories suitable for an expandable desktop tree or mobile accordion. Nontechnical options include sales and customer support, crafts and food, onsite operations, education/languages and business administration, alongside music, media, software and security. Existing option IDs remain valid. Structured option labels and custom text are self-declarations, not certification checks.

`GET /guilds/directory` sorts the current member’s primary guild first, their other active guild memberships next, then all remaining guilds. Each group uses stable `guild_key` ordering; a left membership is treated as not joined.


## Skill books for administrator-approved guilds

A new guild approval requires 1–20 distinct `guild.skill_book_ids` from the canonical skill-book catalog. Migration 013 stores the reviewed associations in `guild_skill_book_bindings`, scoped by community and guild. Approval creates the guild and bindings in the same transaction; it does not silently join the applicant or grant a book before membership. The rich guild directory merges static starter books with these reviewed bindings, and joining grants those book IDs atomically.

核准正文可以附帶 `alias` 與 `profession_title`，寫入新的目錄列。審查也可以改為併入既有公會：申請標成已核准並指向該公會，不建立新目錄列、不新增技能書綁定。併入時若帶了非空別名，該別名成為目標公會的別名。自訂公會的職業稱號只存在目錄的 `profession_title`；內建稱號不從這個欄位讀取。

A book ID always resolves through `communityCatalog.skill_books`; applications cannot supply arbitrary download URLs, tokens or executable content. Existing grants also resolve against that full catalog, so books received from a custom guild remain visible. Unknown or removed catalog IDs are skipped. Static defaults and additional bindings are deduplicated; another community's bindings are not included.
