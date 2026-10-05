# Native text process boundary

This candidate adds structural v3 binding/context/receipt DTOs and a reusable native process boundary. Parsing a DTO does not authenticate a device, claim an Attempt or authorize execution. `createNativeTextStartAuthority` accepts trusted in-process host functions; the server still must derive current identity/Grant/Attempt/Work/control/policy/recovery from SQL and durably claim once. Neither JSON nor a callback supplied by a request may create that authority.

The production Grok1.0.46 profile is deliberately unavailable before claim or private context. Its real metadata probe does not establish effective tools or ordinary owner credential custody. Synthetic subprocess cases prove the boundary mechanics only, and return synthetic-local evidence. No private provider credentials, Freedom secrets, ambient config or network enter these tests.

The boundary preserves the 90-second lease and 5-second start window, caps native wall time at 60 seconds, context/output at 16 KiB, stdout at 64 KiB and stderr at 8 KiB. A verified native ELF is copied to an unlinked snapshot; each inspection/invocation obtains an independent file offset from that same snapshot. Known invalid lease clocks are checked both before inspection and before the one-use claim. Unknown claim or process results are never retried. Current authority is checked around context, spawn and output; callbacks need real server implementations.

Native receipts are local observations with unknown provider call count/usage/cost. One local process does not prove one upstream request. They are neither existing BYOK observation capabilities nor accepted private Results. Server-side machine proof, durable dispatch, distinct native observation acceptance and Asset finalization are still required.

Evidence: [candidate process and control observations](../../../docs/platform-plan/execution/unified-foundation/native-text-boundary-evidence-2026-10-05.json).
