# Bounded affected job selection

The selector and aggregate are loaded from the installed workflow source, not
from candidate configuration. This candidate adds an `affected` mode for the
exact frontend files in `FRONTEND_LEAF_PROFILES` in `select-affected-jobs.mjs`:
member-card editor/QR/download/styles and newcomer-guide host/gallery/styles.
It does not install a new workflow pin or claim a hosted timing improvement.

A modified existing leaf must have exactly its expected module owner in both
Git revisions. Both complete descriptor graphs must be valid and unchanged;
module dependencies and suite obligations must match the fixed host profile.
The baseline/candidate impact union, including reverse dependencies, must contain
only the changed leaf modules and their known suites. New files, missing or
ambiguous owners, descriptor drift, extra consumers, unknown paths, contracts,
security paths, runtime Markdown, shared infrastructure, rename/delete/mode
changes, pushes and merge groups use full selection. Public sharing helpers,
guide gates, contract/content/release pins and root application files have no
leaf exemption. An ordinary unowned prose document or the generated inventory
may accompany a leaf; they cannot introduce another module obligation.

| Mode | Required selectable jobs |
| --- | --- |
| `full` | All six existing jobs |
| `docs` | None; always-on integrity still runs |
| `affected` | Full six-part runtime plus aggregate, full browser, static/worker |

Affected mode omits only `governance-consumers` and `deploy-preflight`. It does
not trim runtime test files or browser cases, add a second runner, or replace
independent security harnesses with candidate test reports. `source-integrity`
still verifies generated contracts, runtime text, governance and full inventory.
The two omitted jobs are selected again if any changed file falls outside the
fixed profile, including database/migration/operator changes.

The aggregate requires every output and every job result. Only the exact fixed
job shape is accepted for affected mode. Selected skip/failure/cancellation,
unselected failure/cancellation, missing results and malformed outputs fail.
An intentionally unselected job may report skipped or success.

Local tests use real Git commits and the actual CLI as well as graph/aggregate
negative cases. They do not prove installed GitHub enforcement or cost savings.
UF:INT-17 also requires the corresponding TS/Rust conformance evidence; full
fallback alone does not supply a missing conformance adapter. Release/archive
inventory replacement is a separate packet. Until its complete archive and
restore integrity checks exist, daily `verify:inventory` remains unchanged.

## Root README documentation policy proposal

An ordinary `M` content change to the exact root `README.md` may use the existing
`docs` mode, alone or with otherwise qualifying prose and the exact generated
inventory. Both revisions must have valid bounded module graphs (unique IDs, existing
dependencies, no cycles), and neither may explicitly own `README.md`; ownership in either revision retains full CI. Other
documents retain the baseline/candidate impact union. README plus a frontend
leaf stays full: this exception does not expand the affected profile.

This intentionally changes the previous conservative root-instruction policy.
It admits all root README prose modifications, not only navigation paragraphs;
it does not infer whether prose is harmless or replace content review. Root
README remains a mandatory instruction and retains its full context impact in
`ROOT_INSTRUCTIONS` and `selectImpact`. AGENTS/CONTRIBUTING, runtime Markdown,
code, tests, workflows, policy, contracts, descriptors, SQL, unknown paths and
non-content changes still retain full selection. Pushes and merge groups do too.

The selector continues to read exact GitHub event base/head Git trees through
the installed trusted source. No candidate script or file list can opt into this
policy. Source-integrity, the required aggregate and their failure semantics
are unchanged. This source proposal does not update the installed workflow pin,
change GitHub settings or bypass any current PR's checks. Hosted savings require
a separately reviewed and authorized installed-source upgrade.
