# Main Worker media configuration preflight

Run the local declaration check with Node's option terminator:

```sh
node -- deploy/cloudflare/media-preflight.mjs
node -- deploy/cloudflare/media-preflight.mjs --config /path/to/private-main-worker-overlay.jsonc
node --test deploy/cloudflare/test/media-wrangler.test.mjs
```

`--` prevents Node from interpreting a later `--env-file` as an interpreter option. The checker accepts only the optional local `--config` path; it has no credential, provider, SQL, enable or execution interface. It reads the existing canonical [environment manifest](environments.json) and [Wrangler parser/topology checker](lib/wrangler.mjs). It neither modifies the overlay nor prints its binding IDs, credentials or arbitrary variable values.

Exit `0` means declarations are internally consistent; `1` means invalid or rejected configuration; `2` means required media declarations are unavailable. Every result keeps `deployment_ready: false` and runtime/provider acceptance `not_run`. The committed main configuration is deliberately unavailable: media bindings are absent, the six flags are off, and Hyperdrive IDs are placeholders. This is not a claim that the remote resources are absent.

| Existing source | Main Worker installation | Required bindings | Required release capabilities |
| --- | --- | --- | --- |
| Member avatar | Native `MEDIA` presence; no avatar flag exists | `MEDIA`, `IMAGES` | `avatar.asset-bridge.v1` |
| Member service cover | `FREEDOM_SERVICE_COVER_ENABLED="true"` | `MEDIA`, `IMAGES` | `media.service-cover.asset.v1`, `media.server-policy.v1` |
| Community event banner | `FREEDOM_EVENT_BANNER_ENABLED="true"` | `MEDIA`, `IMAGES` | `media.event-banner.asset.v1`, `media.server-policy.v1` |
| Community event video | `FREEDOM_EVENT_VIDEO_ENABLED="true"` | `MEDIA` | `media.event-video.asset.v1`, `media.server-policy.v1` |
| Skill submission image | `FREEDOM_SKILL_IMAGE_ENABLED="true"` | `MEDIA`, `IMAGES` | `media.skill-image.asset.v1`, `media.server-policy.v1` |
| Community social thumbnail, including automatic preview creation | `FREEDOM_SOCIAL_THUMBNAIL_ENABLED="true"` | `MEDIA`, `IMAGES` | `media.social-thumbnail.asset.v1`, `media.social-preview-create.v1`, `media.server-policy.v1` |
| Community event highlight image and thumb | `FREEDOM_EVENT_HIGHLIGHT_ENABLED="true"` | `MEDIA`, `IMAGES` | `media.event-highlight.asset.v1`, `media.server-policy.v1` |

Missing flags default off. Only exact strings `"true"` and `"false"` are accepted. Flags and native bindings are checked on each environment block rather than inherited from local/default configuration. The table describes installed dependencies; existing Asset profiles still define formats, limits, variants and ACL. Avatar still uses its existing policy. The other six purposes require current canonical PostgreSQL media policy; a flag or bucket grants no persistence or migration permission.

| Profile | Origin and route | Private `MEDIA` bucket | Expected database / runtime role |
| --- | --- | --- | --- |
| `staging-next` | `https://staging.freetwai.com`, `staging.freetwai.com/*` | `freedom-staging-next-private` | `freedom_staging_next` / `freedom_staging_next_app` |
| `next` | `https://freetwai.com`, `freetwai.com/*` | `freedom-next-private` | `freedom_next` / `freedom_next_app` |

The checker derives these names from the manifest, rejects crossed declarations and shared real Hyperdrive IDs, and reports the required existing Hyperdrive names and cache-off expectation. A real-looking ID cannot establish which database or role it connects to. `FREEDOM_DATABASE_NAME` must match when declared; omitted deploy-time injection remains unavailable. There is no Worker-consumed `FREEDOM_DATABASE_ROLE` variable, so inventing one is rejected rather than treated as role proof.

Still **NOT_RUN**: provider binding identity and bucket privacy; actual Hyperdrive cache-disabled readback; current database and exact runtime-role identity; current consent/policy/quota; authenticated release capabilities and schema floor; deployed Worker media acceptance. Static declarations, prior historical observations and local fixtures do not satisfy these checks. Production activation remains an operator action under the existing release process; this tool cannot enable flags, migrate/backfill/purge data or deploy. Independent broker/operator Worker configurations are outside this main Worker check.
