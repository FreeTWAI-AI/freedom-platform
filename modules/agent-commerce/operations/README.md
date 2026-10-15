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
