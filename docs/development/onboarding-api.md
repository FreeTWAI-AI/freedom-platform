# Registration → positioning → guilds

All paths below are under `/api/v1`; authenticated writes use CSRF, `Idempotency-Key`, and `If-Match` of the current assessment `aggregate_version` (omit only the first draft save). Server scoring alone is authoritative. Public member cards never expose answers, occupation, raw scores or founding interest.

## Interrupted saves

The portal bounds a request, including its response body, to 20 seconds. A network error, incomplete success response, or HTTP 5xx leaves the write outcome unknown: the database may already have committed. Keep the exact command body, `Idempotency-Key`, and `If-Match` in page memory; freeze its inputs and offer **重試保存**. Replay only that command after an explicit click. In particular, a failed `evaluate` response must not repeat the preceding `answers` command, and a failed `complete` response must not submit different guild choices. Do not automatically retry mutations or invent a successful completion.

A confirmed 412/428 permits **重讀保存版本**: fetch the latest onboarding view, retain the member's current input, and require another explicit save. This read does not overwrite the remote draft. Answers are not placed in localStorage; reloading or leaving the page can lose input that has not been confirmed saved.

POST responses from the application include a generated `X-Freedom-Request-ID`. The error panel's folded **問題資訊** shows the HTTP status and validated request ID / Cloudflare Ray when present. An edge-generated error may have no application request ID. Operational logging records only stage, status, duration and these correlation IDs, never the assessment payload.

## Endpoints

- `GET /assessment-definition`: `{assessment_version,assessment_sha256,questions:[{id,kind:"preference"|"ability",prompt,options:[{id,label}]}],capability_categories,equipment_categories}`. Render server options. Capability/equipment options have stable `id`, `label`; each category has `id`,`label`,`options` plus `subcategories:[{id,label,options}]`. Flattened `options` remain compatible and are exactly the unique union of the subcategories. Answers have no client scoring inputs.
- `GET /me/onboarding`: `{required,completed,assessment_update_required,current_assessment_version,current_assessment_sha256,state:"new"|"draft"|"evaluated"|"completed",draft:null|{aggregate_version,assessment_version,assessment_sha256,answers,occupation,founding_interest,capabilities,equipment},result:null|{recommendations:[{guild_key,name,reason,title}],assessment_version,assessment_sha256},primary_guild_key:null|string,skill_books:[]}`.
- `POST /me/onboarding/answers`: `{assessment_version,assessment_sha256,answers:{[question_id]:option_id},occupation:string,founding_interest:boolean,capabilities:string[],equipment:string[]}`. Partial answers permit saving progress; full category selections are validated. Replacing an evaluated draft clears its recommendation result. Returns the same onboarding view. On completed users, a new save starts a change-of-direction draft without re-locking the account.
- `POST /me/onboarding/evaluate`: `{}`. Requires every question answered; capability and equipment selections may be empty for a beginner. Writes deterministic recommendations and returns the onboarding view. Server requires current version.
- `POST /me/onboarding/complete`: `{guild_keys:string[],primary_guild_key:string,confirmed:true}`. Requires evaluated draft/current version, 1–15 distinct valid chosen guilds, selected primary present among chosen guilds. Recommendations are suggestions: other valid guilds can be chosen. Atomically joins selected guilds, sets exactly one primary, grants repository pointers, marks completion and unlocks new accounts. Does not silently leave existing guilds. Returns updated onboarding view.
- `GET /guilds`: legacy response shape retained. `GET /guilds/directory`: `{items:[...legacyGuildFields,guild_master:null|{user_id,display_name,avatar_url},guild_experts:[{user_id,display_name,avatar_url}],is_primary:boolean,skill_books:[]]}`. Unassigned master renders `待任命` with a `公會長` badge. `avatar_url` is a versioned, authenticated local image URL or null; it is not an external image source.
- Existing `POST /guilds/:key/join` / `leave`: `{}`; membership ETag applies. Joining grants books atomically. A primary guild cannot be left until a different active membership is made primary.
- `POST /guilds/:key/primary`: `{}`; `If-Match` of preference version. Response `{primary_guild_key,aggregate_version}`. `GET /me/guild-preferences` exposes this version. First selection omits version. Active membership required.
- `GET /me/skill-books`: `{items:[{book_id,title,repository_url,fork_url,description,guild_keys,granted_at}]}`. Grants are access pointers to public repository resources, not software installation, GitHub account linking or a completed fork.
- `POST /guild-applications`: `{name,profession,reason}`. Creates a pending request only. `GET /guild-applications` lists own requests. No automatic guild creation/officer privileges.

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

A book ID always resolves through `communityCatalog.skill_books`; applications cannot supply arbitrary download URLs, tokens or executable content. Existing grants also resolve against that full catalog, so books received from a custom guild remain visible. Unknown or removed catalog IDs are skipped. Static defaults and additional bindings are deduplicated; another community's bindings are not included.
