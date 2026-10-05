# Explicit OpenRouter BYOK profile

The provider identifier is `openrouter`; the owner selects the exact namespaced
model, such as `openai/gpt-4.1-mini`. This is a distinct provider, not an endpoint
override for `openai`. Namespaced IDs are accepted only in the new OpenRouter BYOK
selection branches. Existing provider/model label metadata remains compatible.
The broker requires `platform_vault`, `platform`, `provider_remote`,
`platform_asset`, and `user_byok`; metadata alone does not grant execution.

The fixed protocol sends one non-streaming text request to
`https://openrouter.ai/api/v1/chat/completions`, with the approved
`max_completion_tokens`, `tools: []`, `tool_choice: none`, and
`provider.allow_fallbacks: false`, `data_collection: deny`, `require_parameters: true`.
There is no fallback model, retry, caller URL, tool capability, or key in the
prepared adapter payload. Node/Worker transports independently restrict HTTPS
origins, paths and methods, reject redirects and bound output to 32 KiB.

Readiness first authenticates `GET /api/v1/key`, then requests the exact
`GET /api/v1/model/{author}/{slug}` metadata. The public model catalog alone is
never credential proof. Expired, exhausted or management keys fail; key expiry
also bounds the existing short-lived proof. Catalog `id` and completion `model`
must equal the owner selection, even if `canonical_slug` names a snapshot.
Generation still consumes the existing single-use capability before dispatch.
Recovery, consent, export policy, output token/byte ceilings and custody checks
remain mandatory. No policy is seeded and no private-AI flag is enabled here.

The response codec accepts one completed assistant text choice and strict bounded
usage, including the documented finite nonnegative `usage.cost` shape. It rejects
model changes, tool calls, refusal, nonempty reasoning, truncation, unknown fields,
missing cost/usage and inconsistent token counts. Provider cost is metadata:
`is_byok` refers to OpenRouter's upstream-key arrangement and does not change the
member's `user_byok` billing choice. This change does not create a platform USD
ledger or enforce a daily dollar budget; provider-side key limits and operator
spend accounting remain separate. Existing safe errors remain sanitized; 429 and
other ambiguous non-authentication outcomes fail closed without retry.

Migration 115 adds only OpenRouter namespaced BYOK to the model-selection CHECK
and explicit provider/model admission in the existing vault and ingest triggers.
It leaves historical migrations, trigger identity, privileges and other predicates
intact. Generated closed JSON schemas include the new branch.

References: [chat completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion),
[current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key),
[exact model metadata](https://openrouter.ai/docs/api/api-reference/models/get-model).
Synthetic adapter/HTTP/Worker and low-privilege PostgreSQL tests cover the new
profile. A successful synthetic test or provider connectivity request is not
complete owner-flow acceptance or production readiness.

The October 5 [observed provider evidence](../platform-plan/verification/private-ai-openrouter-2026-10-05.json)
records a successful bounded native owner API flow with real OpenRouter HTTPS.
It also preserves an initial readiness failure: the deprecated
`rate_limit.requests` field used the observed `-1` sentinel. The closed decoder
admits exactly that sentinel or a nonnegative integer, without treating it as
budget or execution authority. SQL, R2, owners and recovery in that acceptance
remain local/synthetic; remote deployment and browser ingress are not proved.
