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
