# Skill illustration grant bridge

The original strict base64 JSON upload remains the only image-bearing skill
writer. Browser-issued and agent-key-issued upload grants use the same original
endpoint and acknowledgement; manual browser create/revise has no image field
and remains unchanged. Input and normalized output stay bounded to 512 KiB;
the original normalizer produces a static 1200x630 WebP.

`FREEDOM_SKILL_IMAGE_ENABLED=true` explicitly installs the Worker adapter with
existing MEDIA and IMAGES. Missing native bindings or malformed flags refuse
requests before effects. Default flags remain absent and DB storage mode legacy.
A nonlegacy skill policy requires canonical DB consent, revision and quota;
missing installation fails closed. No deployment profile is activated.

The finite adapter uses the real current upload-grant kernel, not a fabricated
member session. Each phase locks the original active owner, originating key and
matching current grant; expiry/revocation is checked at the actual decision clock
again after storage and database waits. Active principal and personal-scope
mapping is resolved under lock. A typed submission pointer, common intent lease
and fence, quota reservation, immutable verified object and common asset metadata
bind the exact normalized image to the existing payload digest and grant.
Publication and original grant consumption/acknowledgement occur in one SQL
transaction. Successful replays preserve the original acknowledgement and add no
object. Interrupted uploads retain bounded reservations; expired leases can be
reclaimed by the same current grant and digest. No generic machine scope or
member-session receipt is minted.

Owner-private illustration and the original published-project/version shelf
rules remain at their existing URLs. Asset reads verify bytes and recheck those
ACLs after I/O; asset sources never fall back to old SQL bytes. SQL constraints
reject cross-owner targets and legacy rewrites of asset sources. Old legacy
images require the existing migration/restore process before R2-only policy.

The native test uses actual restricted-role PostgreSQL, Hyperdrive and native R2
through the ordinary main Worker bundle. IMAGES is Miniflare's local emulator;
matching aspect input avoids its unproven padded-contain behavior. A separate
restricted SQL/fake-store interruption asserts expiry after object I/O cannot
consume the grant or publish an asset. No provider/cloud calls occur. Remote
bindings, deployed policy, backfill, restore, physical deletion and staging
acceptance remain unverified.
