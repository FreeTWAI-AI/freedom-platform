# Private media operator Worker candidate

`apps/media-operator/src/worker.ts` installs the existing 105/107/109/110/111 operator host in the target Cloudflare runtime. Its named `MediaOperator.execute(plan)` entrypoint is callable through a **private Service Binding RPC**. Both the default HTTP handler and the named entrypoint's HTTP handler return 404. There is no HTTP execute route, bearer fallback, public caller, member-session fabrication or approval API. This increment does not install a caller in the main platform Worker.

`wrangler.media-operator.example.jsonc` is an inactive candidate: `workers_dev:false`, `preview_urls:false`, `routes:[]`, and `FREEDOM_MEDIA_OPERATOR_ENABLED:false`. Its zero Hyperdrive IDs and bucket names are placeholders. Neither a successful dry-run nor the local test establishes a deployed service, a real binding identity, cache configuration, approved plan or cloud readiness. No staging/public configuration or resources have been changed.

## Explicit installation

Install a dedicated `OPERATOR_HYPERDRIVE` using the canonical `freedom_media_migrator` SQL role, the target database, and **query caching disabled**. The canonical `40-media-backfill-operator-grants.psql` installs its finite capabilities; it cannot write approval, owner activation, persistence consent, source bytes or vault credentials. Bind `MEDIA` to the environment's existing private asset bucket, not a second storage authority. The host creates the original `createR2ObjectStore` port, including its four-method native binding check; deletion remains disabled. It does not create a role, read an ambient database URL, install a key or accept a caller-provided object store.

An authorized installer must set all of:

- `FREEDOM_MEDIA_OPERATOR_ENABLED` to the exact string `true` (absent, `false` and other values refuse RPC execution).
- `FREEDOM_MEDIA_OPERATOR_ENVIRONMENT` to `staging` or `public`, separately pinned from the profile.
- `FREEDOM_MEDIA_OPERATOR_RELEASE_SHA` to the approved 40-character source release SHA.
- `FREEDOM_MEDIA_OPERATOR_STORE_BINDING_ID` to the reviewed installed private bucket binding identity.
- `FREEDOM_MEDIA_OPERATOR_PROFILE` to the closed JSON shape below, matching those separate pins.

```json
{
  "target": {
    "environment": "staging",
    "database": "freedom_staging_next",
    "schema": "public",
    "role": "freedom_media_migrator",
    "releaseSha": "<approved 40-character source SHA>"
  },
  "logicalStore": "MEDIA",
  "storeBindingId": "<reviewed installed binding identity>",
  "purposes": ["member.service-cover", "community.event-video",
               "community.event-banner", "community.social-thumbnail",
               "skill.submission-image", "community.event-highlight", "member.avatar"]
}
```

For public, the database is `freedom_next`. A purpose subset is allowed; duplicates, extra profile fields, other purposes, wrong environment or release pins or mismatched store pins refuse execution. Local testing requires an explicit `fp_*` database/schema and `fp_media_migrator_*` role. No config value proves which remote bucket a provider binding actually references: the installer must verify that mapping and cache-off setting independently before activation.

The caller privately binds the named entrypoint, for example `{ "binding":"MEDIA_OPERATOR", "service":"freedom-media-operator-staging-next", "entrypoint":"MediaOperator" }`, then invokes `env.MEDIA_OPERATOR.execute(plan)`. The caller cannot supply bindings, credentials or approval. Send a canonical `planOperatorBackfill` result, including `planSha256`; the host recomputes that digest and requires exact installed target, store and purpose correspondence. A digest is not approval: the existing database-owned `media_backfill_operator_policy` approval, expiry, current owner/scope and canonical persistence/quota checks still run in each original transaction phase.

Each RPC creates and closes its own PostgreSQL Pool. Before the existing host starts it checks actual `current_user`, `session_user`, database, dedicated role powers/membership, absence of schema DDL and absence of approval/owner/consent/vault privileges. The original finite host retains immutable byte verification, durable cursors, fences, typed pointer publication and 108 object-write effect evidence. An unknown R2 PUT outcome is refused, never reported as successful; the approved same-plan resume reconciles the same immutable object and intent. It preserves the original uncertain effect row; a ready pointer does not erase that evidence or authorize GC. Execution errors expose only `operator_media_unavailable`. The Worker does not cut over policy, purge legacy bytes, grant member rights, approve a plan, install a public endpoint, or install another media purpose outside its explicit seven-profile set.

## Local acceptance and remaining deployment work

Run `npm run typecheck`, and candidate bundling:

```sh
node node_modules/wrangler/bin/wrangler.js deploy --dry-run \
  --config wrangler.media-operator.example.jsonc --env staging-next \
  --outdir .wrangler/dry-run/media-operator
TEST_DATABASE_URL='<explicit owned fp_* PostgreSQL URL>' \
  npx tsx --test --test-concurrency=1 tests/worker/media-operator-worker.test.ts tests/worker/media-operator-images-worker.test.ts tests/worker/media-operator-private-worker.test.ts
```

The test accepts explicitly isolated loopback TCP or Unix-socket PostgreSQL (for Unix it creates its own temporary loopback proxy for native Hyperdrive), uses canonical migrations and operator grants, and removes only its own schema/roles, pools and proxy. It bundles the actual candidate, uses native Miniflare service binding to the named WorkerEntrypoint, actual restricted SQL and actual native R2. It proves cover/video exact bytes and original retained legacy bytes, typed pointer/version publication, replay completion, disabled/missing binding/profile and environment/release/store/foreign-role/plan/approval/consent refusals, HTTP 404, no sessions or external HTTP calls, no surviving cross-request client, and committed native PUT with lost acknowledgement followed by fenced same-intent resume. The fault wrapper injects only the lost ACK/readback failure after a real native R2 PUT. Synthetic MP4 signature bytes test storage integrity, not playback.

Remote service installation, actual Hyperdrive credentials/cache-off and bucket mapping, the authorized private caller, reviewed release/plan approval, operator activation and a remote acceptance run remain **not_run**. Follow the canonical operator/backfill and restore lockdown runbooks before application installation; this candidate is not deployment approval.


The separately installed banner/social profiles use the same native named RPC and the original 109 host, not new approval or storage adapters. `media-operator-images-worker.test.ts` creates actual non-super migration ownership, applies the canonical 109 operator grants and proves exact 512 KiB historical WebP bytes, community scope/typed targets, original banner orientation and social URL/platform/title/note/source provenance, public-read ACL cancellation/hiding, disabled owner refusal, and real after-PUT source/provenance or owner changes preventing publication. It also proves committed native PUT with lost acknowledgement, preserved unknown effect history, same common intent/Asset under a newer fence, restricted source/provenance/state writes (42501), no sessions, no external HTTP and no cross-request SQL client. The test-only after-PUT service-binding callback changes only its owned synthetic source SQL; the production RPC, approval and publication kernels are unchanged.

The installation now permits exactly seven explicit operator purposes: avatar, cover, banner, video, skill illustration, highlight pair and social thumbnail. Each installed profile is still an explicit subset. Existing two- and four-profile configurations remain subsets; they do not gain skill, highlight or avatar authority when host migrations arrive. A cover-only installation rejects even an approved plan for another purpose; private-work artifacts remain outside this set.

The added `media-operator-private-worker.test.ts` bundles the actual seven-profile Worker and invokes the same native named service RPC for 110/111. It verifies actual 128 KiB avatar, 512 KiB skill illustration and atomic 1 MiB highlight image + 200 KiB thumbnail bytes. Skill owner/viewer reads use genuine original login/authenticate sessions, with no fabricated Actor or upload grant; the original published shelf/project and private owner predicates still control read visibility. Original skill/highlight URL projections and avatar versioned URL format are retained. Avatar public-share revocation and current viewer-session revocation deny bytes. The avatar historical representation explicitly carries `profileId:member.avatar` and `member.avatar.legacy-bytes.v1`; the ordinary writer and its NULL-profile representation remain unchanged.

A real second highlight R2 PUT with a lost acknowledgement leaves BOTH typed pointers unpublished, both common Assets pending, no object metadata committed and both original legacy variants readable. Approved same-plan resume publishes the same two intents/Assets in one SQL commit and increments the event once. Actual after-PUT skill payload/highlight orientation/avatar byte changes are stale and cannot publish. Unknown effect history remains present after successful resume. Each source retains its original bytes through backfill; tests separately exercise an authorized owner removal for the covered-avatar GC refusal. Even after unlink, retention and fulfilled effect history, the existing avatar maintenance port refuses a covered operator avatar and creates no deletion tombstone; no GC installation is implied.

The live Worker role guard now also rejects direct table/column writes to `avatar_storage_policy`, before the approved host can start. A test adds that exact privilege to the otherwise restricted role, observes safe refusal with zero Assets, then revokes only its own test grant. Inactive avatar owners remain blocked without fabricated identities. The seven-profile test checks no external HTTP, no operator-created sessions and no surviving cross-request SQL client. Remote installation, cloud binding identity/cache-off verification and an authorized private caller remain **not_run**; the candidate retains its default-off flag and empty public routes.
