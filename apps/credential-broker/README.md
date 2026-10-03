# Model credential broker

This directory implements the isolated custody boundary planned in AP P-17/P-24.
The internal core now includes a purpose-bound authenticated execution bridge
and a fixed local process RPC listener. Production service trust is not installed.
Provider keys and KEKs stay in the broker; the main app uses only an opaque
reference client. Public Node/Worker defaults do not install these factories.

Use the [central contract](../../contracts/execution/v2/model-credential.ts) and
[spec 18](../../docs/platform-plan/execution/unified-foundation/18-credential-broker-core.md).
ModelConnection remains immutable `unverified`/`revoked` metadata. An encrypted
credential is not proof of provider authentication or model availability.

The store prepares an opaque, short-lived, server-derived binding. The vault
seals only that exact binding using an explicitly supplied nonextractable KEK;
commit rechecks current member authority, SQL backing, versions and deadlines.
Rotation uses a distinct replacement ModelConnection and terminates the old
credential/model. Resolver creation captures the current actor and explicitly
pins credential ID/generation; it never silently reads a newer credential.

Ciphertext and wrapped DEKs require a separate broker database role. Ordinary
runtime permissions, including column/default/inherited/SET ROLE paths, must
deny the ciphertext table. Journals, outbox, receipts and member metadata hold
only non-secret references and versions.

Recovery comes from purpose-separated signed external state and a separately
persisted monotonic floor, pinned to the configured authority/environment.
Process memory adds a fence but cannot establish restore safety by itself.
Crypto/port operations are bounded and late plaintext buffers are cleared.
The pinned resolver transfers ownership of fresh plaintext bytes to its trusted
host. The host clears the original on acceptance, rejection and late timeout,
and clears its own bounded copy after use.
The resolver has a shared 2.5-second SQL/open/revalidation budget, below the
host's 3-second port limit, so a stuck SQL delivery clears already owned key
bytes before the outer host deadline. Resolver observations do not acquire
nested member/model locks; SQL delivery and external recovery waits each retain
freshness checks. Separate SQL and external floor reads are not an atomic pair.

Missing KEK/recovery/backing or malformed data fails closed with fixed errors.
Do not add ambient environment keys, R2 secret storage, default models or a
generic proxy. Do not serialize WeakMap handles or member Actor DTOs as cross
process authorization.

See [spec 19](../../docs/platform-plan/execution/unified-foundation/19-authenticated-broker-bridge.md)
for original-session SQL authorization, pinned separate signing directions,
bounded in-process proofs registry, per-transaction invocation guards and
separate cipher/executor roles. The existing complete host/service/runner/
Result finalizer remains broker-local; JSON or historical DB metadata never
recreates opaque evidence. Main verifies replies and reads current owner SQL.

Production private service binding, secret ingest with capture disabled, provider verification/settings and actual
member/provider acceptance remain separate work. Tests use synthetic keys and
disposable PostgreSQL only; no production credentials or deployments are implied.
