# Bounded local test progress diagnostics

The fixed suite runner installs a clean `FREEDOM_TEST_PROGRESS_FILES` containing
its selected relative source paths and opens child FD 3. The existing Node
reporter emits file-start and file-completion NDJSON there, separately from the
unchanged final JSON on stdout. Sources must be bounded regular files under the
selected checkout; records contain the validated relative path, exact-byte SHA-256, monotonic elapsed milliseconds and fixed completion counts. Failed-case records also retain the existing opaque case digest and a finite Node failure classification (`testCodeFailure`, `hookFailed`, `testTimeoutFailure`, `cancelledByParent`, `testAborted`, `subtestsFailed`, or `unknown`). Test names, assertions, exception messages, stacks, stdout/stderr, URLs and environment contents are omitted.

The parent independently checks each record against the exact selection and
source digests before reconstructing a closed diagnostic on **stderr**, prefixed
`freedom.test-progress `. Unknown paths, changed digests, extra/duplicate keys,
duplicate transitions, malformed/truncated records and invalid counts are
rejected without echoing raw input. Limits are 512 sources, 1024 file records plus at most 64 failed-case records,
2048 bytes per line and 1 MiB per child diagnostic stream. Oversized streams
continue to drain without accepting further records. A final bounded progress
summary marks missing completions, rejected records or truncated failure diagnostics as incomplete.

An optional `source_line` is the Node test-event location, accepted only when its integer line is within the parent-read selected source. It is not extracted from a stack and does not identify the throwing assertion or hook. Transformed TypeScript may report a generated location: the Ubuntu 24.04 native probe events reported line 30, which is not the literal TypeScript test declaration. The bounded integer check establishes only that the value is in range, not a source-map correspondence. A `hookFailed` classification identifies a setup/teardown failure without locating that hook. If a location cannot be validated, it is omitted. These diagnostics do not establish the cause of earlier remote failures whose details were not retained.

Redirect stderr to a separate ignored report to retain completed files and the
last started file when a timeout kills the child before final JSON exists.
These records remain candidate-controlled diagnostics, not authenticated host
observations or a test pass. They are never added to verifier JSON, selection
projections or pass/coverage decisions. A timeout, cancelled child, empty final
report or failed final report still fails through the original admission path.
No additional timeout budget, database authority or provider access is granted.

The mandatory producer also writes a separate FD4 failure diagnostic for only
`tests/runtime/model-broker-bridge-adversarial.test.ts` and
`tests/runtime/media-verify.test.ts`. Its host decoder reconstructs closed
`freedom.test-failure-diagnostic/v1` records under the separate STDERR prefix
`freedom.test-failure-diagnostic`. Source digest, opaque case hash and optional
declaration line bind it to the selected source. These are untrusted diagnostics,
never evidence of authority or pass, and no test is executed a second time.

Only fixed error-name/code classifications are admitted. Known source messages
distinguish an unobserved SQL wait and an asset read that never reached the
trusted port; the known `expires>Date.now()` assertion has a finite classification.
Other assertions remain `assertion_failed`; Boolean or safe-integer comparisons
within±20000 can distinguish failed cancellation/count assertions. `fetch_failed`
and optional `UND_ERR_SOCKET` identify a transport symptom, not its cause. No
arbitrary message, test name, stack, request body, environment, string comparison
or object actual/expected value is serialized. The source line remains the Node
event declaration location, with the source-map limitation described above.

FD4 is independently capped at64 records,2048 bytes per record and256KiB total.
Unknown paths, source/hash mismatches, malformed/private fields, out-of-bounds
locations and duplicate cases are discarded. A missing, invalid, truncated or
hung sideband cannot change primary JSON, selected files, pass admission or the
original deadline. FD3's schema and final JSON remain unchanged.
