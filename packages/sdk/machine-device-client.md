# Machine device bootstrap client

`machine-device-client.mjs` is a dependency-free, in-memory client for the existing device authorization and bootstrap HTTP contract. It authenticates one agent-kit device and reads `bootstrap.status.read`; it does not create an ExecutionGrant, invoke a model or authorize Work/Result changes.

Create the client with a trusted exact HTTPS `origin`, canonical `environment` (`local`, `staging-next`, `next`) and registered `clientId`. Call `begin()` and present its public user code/verification URI for a separate real member approval. `pair()` waits at the server polling interval; `refresh()` rotates once; `readStatus()` obtains a fresh nonce and reads status. `close()` aborts active work and clears in-memory state. Public results omit tokens, refresh handles and private keys.

The P-256 private key is nonextractable. There is no state import/export or disk custody. Process restart requires a new key and pairing; this is not durable reconnect. No machine request includes member cookies/CSRF. The bootstrap client cannot be used as a member Actor or as an execution credential.

Enrollment and refresh reserve their one-use state before dispatch. A lost, malformed, redirected, aborted or otherwise uncertain response quarantines the client; it never automatically repeats that exchange. Polling waits recheck the wall-clock deadline after timer wakeup. Reads can obtain a new nonce without replaying inference or changing business state.

The optional trusted Fetch port must implement standard decoded-body behavior, `redirect:error`, `credentials:omit` and AbortSignal. JSON responses are limited to 32 KiB decoded bytes, 128 chunks and a bounded deadline, with closed DTO/duplicate-key/encoding checks. Native Fetch gzip/br/deflate responses retain their wire headers: encoded Content-Length is not compared with decoded length. Identity bodies retain exact length validation.

Agent Kit consumes this file through the explicit `agent-kit-device-v1` library profile and canonical exporter. Updating a candidate lock does not install a new trusted gate. Source publication/profile approval, supported client rollout, execution grant integration, persistent custody and target-cloud acceptance remain separate requirements.

Evidence: [D1 client and integration observations](../../docs/platform-plan/execution/unified-foundation/machine-device-evidence-2026-10-05.json).
