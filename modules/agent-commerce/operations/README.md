# Commerce host operations

M1 host settings default off and accept only the exact strings `true` and `false`.
Checkout requires guild launchpad until the commerce console flag exists.
Quarantine stops new public commerce commands and the commerce sweep; retained
order reads remain available. Checkout being off does not stop hold expiry.

Runtime, Node and E2E entrypoints share `readCommerceSettings`. Production wiring
supplies no store admission, shipping, policy or commerce email ports. The fixture
email sender retains messages only in memory and performs no external I/O.

Release capability `commerce.hosted-checkout.v1` acknowledges schema 168 writer
compatibility; it grants no payment, email, invoice or deployment authority.
See EC-SPEC-10 for release, recovery and authorization boundaries.

Commerce setup commands append `commerce_control_events` in their own domain
transaction. Events contain only identifiers and a bounded allowlist of service,
environment, state, credential-version and module-release metadata. They never
include credential fields, fingerprints, account routing refs or request bodies.
Rows are immutable except for a single `journaled_at` fill by the later journal
writer. An unjournaled index supports that future writer without granting it
payment execution authority. This non-PII control log deliberately has no RLS so
independent admin and machine operations can record facts before tenant binding;
all helpers still require an authorized caller and a caller-owned transaction.
