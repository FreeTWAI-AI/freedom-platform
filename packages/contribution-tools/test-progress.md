# Bounded local test progress diagnostics

The fixed suite runner installs a clean `FREEDOM_TEST_PROGRESS_FILES` containing
its selected relative source paths and opens child FD 3. The existing Node
reporter emits file-start and file-completion NDJSON there, separately from the
unchanged final JSON on stdout. Sources must be bounded regular files under the
selected checkout; records contain only the validated relative path, exact-byte
SHA-256, monotonic elapsed milliseconds and fixed completion counts. Test names,
assertions, errors, stdout/stderr, URLs and environment contents are omitted.

The parent independently checks each record against the exact selection and
source digests before reconstructing a closed diagnostic on **stderr**, prefixed
`freedom.test-progress `. Unknown paths, changed digests, extra/duplicate keys,
duplicate transitions, malformed/truncated records and invalid counts are
rejected without echoing raw input. Limits are 512 sources, 1024 records,
2048 bytes per line and 1 MiB per child diagnostic stream. Oversized streams
continue to drain without accepting further records. A final bounded progress
summary marks missing completions or rejected records as incomplete.

Redirect stderr to a separate ignored report to retain completed files and the
last started file when a timeout kills the child before final JSON exists.
These records remain candidate-controlled diagnostics, not authenticated host
observations or a test pass. They are never added to verifier JSON, selection
projections or pass/coverage decisions. A timeout, cancelled child, empty final
report or failed final report still fails through the original admission path.
No additional timeout budget, database authority or provider access is granted.
