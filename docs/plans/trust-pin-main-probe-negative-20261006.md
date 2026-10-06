# Trust pin main-target probe (negative, 2026-10-06)

Temporary main-target probe for the central workflow pin upgrade (`c3e5a537` → `d1c9e18f`). It adds this synthetic note on purpose without updating the generated file inventory.

`source-integrity` must fail `verify:inventory`, the pinned `verify` must fail, and the merge API must refuse it. It is closed without merging.
