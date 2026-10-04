# Original-checkout documentation completeness audit

Audited 2026-10-03 against integration baseline `946d67bd200624ba61d23032ee7571e9fd47c602`. Source checkout HEAD: `4c019ff1207b448e8dbf5baab64435a5e919b349`. This is documentation provenance, not a new product spec or test/deployment claim.

The original HEAD has 131 documentation paths (all `docs/` files plus root Markdown); every path already exists in the integration baseline. The original index has zero such paths because its staged removals are intentional. Its filesystem has 123 documentation paths: 36 byte-identical, 38 different, 49 absent from integration. Its tracked deletions and untracked replacements were left untouched. No canonical HEAD document is missing from integration.

Eleven absent JSON synthetic fixture inputs are imported byte-for-byte at their original paths. Attribution remains the original source checkout and its FW-01 historical review context. They are reference fixtures, not new runtime evidence; the current canonical tests/specs remain authoritative. No source spec was overwritten. The older README and 37 differing specification/contract/test files require requirement-level comparison before any content adoption; wholesale replacement would discard subsequent integration changes.

The 33 HANDOFF/SESSION files mix publicly safe requirements with historical operational assertions, private evidence locations, deployment procedures and member/provider administration context. Their raw copies are excluded from public Git; their requirement content is independently mapped below. Their public product topics already have canonical documentation under `docs/development/`, `docs/releases/`, and the platform plan; historical deployment assertions cannot be promoted to current proof. Four historical FW-01 result/review/log/digest files are now preserved with an archival warning; the Python cache is excluded. Historical records are excluded from current verification claims. Private identifiers or credentials are not reproduced in this audit. No credential material is imported. Patch/bundle artifacts and nested `.gitdata`, `.bat-worktrees` and `worktrees` are working artifacts, not canonical documentation, and are excluded.

The following source map covers the union of original HEAD documentation and original filesystem documentation. “Different” is a diff recommendation to retain integration content and compare the old source only when a current requirement is demonstrably missing. Source paths are relative to the preserved original checkout; no private source content is quoted.

| Source path | Baseline comparison | Disposition |
| --- | --- | --- |
| `CHANGES-2026-09-19.md` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `HANDOFF-CLAUDE-CLOUD-ACCEPTANCE-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-AUTHOR-OWNED-COLLABORATION-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-COCREATION-ADMIN-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-COCREATION-PROMPTS-GUILDS-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-COLLABORATION-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-COMPACT-WORKSHOP-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-COMPLETE-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-DESIGN-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-EIGHT-AUTHOR-SKILLS-PROFILE-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-FOUR-AUTHOR-SKILLS-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-FULL-AUDIT-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-GITHUB-SOCIAL-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-GITHUB-STAR-PERMISSIONS-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-GUILD-APPOINTMENTS-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-GUILD-COLLABORATION-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-GUILD-DEVELOPMENT-ACCESS-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-GUILD-DEVELOPMENT-DEPLOYED-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-GUILD-LEADERSHIP-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-GUILD-LIBRARY-014469a-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-MEMBER-BETA-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-MEMBER-SETTINGS-MESSAGES-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-MEMBER-TOOLKIT-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-MODULES-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-ONBOARDING-RECOVERY-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-PRIMARY-GUILD-HELP-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-REPOSITORIES-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-SEAT-2026-09-19.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-SKILL-GITHUB-ACTIONS-2026-09-24.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-SKILL-SHARING-79b9b6a-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-SKILL-SHARING-bfb26e7-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-STAGING-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `HANDOFF-CODEX-WORKSPACE-IA-92ad64c-2026-09-23.md` | missing | raw handoff excluded; content mapped below |
| `README.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `SESSION-CONTINUITY-2026-09-20.md` | missing | raw handoff excluded; content mapped below |
| `docs/platform-plan/00-current-requirements-baseline.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/01-product-community-model.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/02-architecture-repositories.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/03-domain-events-state-machines.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/04-module-specifications.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/05-integration-contracts.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/06-delivery-plan.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/07-decisions-risks-traceability.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/08-bootstrap-hosting-project-lifecycle.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/09-handoff-record.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/10-member-agent-narrative.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/11-operator-agent-narrative.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/12-low-ops-mutual-benefit.md` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/README.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/README.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/agent-work-contract.example.yaml` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/commerce-distribution.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/discord-channel-map.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/domain-skill-overlay.example.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/domain-skill-overlay.schema.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/entitlement-catalog.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/entity-playbook.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/entity-playbook.schema.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/event-catalog.example.yaml` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/event-envelope.schema.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/line-template-map.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/member-onboarding.example.yaml` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/member-onboarding.schema.json` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/openapi-outline.yaml` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/operating-policy.example.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/organization-professions.example.yaml` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/portable-activation.example.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/portable-activation.schema.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/project-manifest.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/project-manifest.external-personal-fork.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/project-manifest.schema.json` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/project-status-attestation.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/project-status-attestation.schema.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/skill-package.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/skill-package.schema.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/state-machines/core.example.yaml` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/submission-intake.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/tests/__pycache__/test_xp_projection_rebuild.cpython-314-pytest-9.0.2.pyc` | missing | excluded generated cache / historical test evidence; not current verification |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/RESULT.md` | missing in audit baseline | imported historical source evidence; archival warning in RESULT, not current verification |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/catalog.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/clock-cases.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/delivery/delivery_boundary_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/delivery/delivery_neg_claim_by.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/delivery/delivery_neg_fencing_token.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/delivery/delivery_neg_grant_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/delivery/delivery_neg_review_by.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/delivery/delivery_neg_task_lease_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/delivery/delivery_neg_valid_until.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/delivery/delivery_positive_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/evidence_appointment/evidence_appointment_boundary_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/evidence_appointment/evidence_appointment_neg_claim_by.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/evidence_appointment/evidence_appointment_neg_due_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/evidence_appointment/evidence_appointment_neg_expires_at_as_lease.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/evidence_appointment/evidence_appointment_neg_fencing_token.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/evidence_appointment/evidence_appointment_neg_grant_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/evidence_appointment/evidence_appointment_neg_task_lease_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/evidence_appointment/evidence_appointment_positive_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/appointment_create_request.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/appointment_reviewer.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/delivery_sow_milestone.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/grant_create_request.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/grant_day_one.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/grant_summary.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/lease_agent_run.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/lease_heartbeat.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/examples/lease_job.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/grant/grant_boundary_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/grant/grant_neg_claim_by.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/grant/grant_neg_due_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/grant/grant_neg_fencing_token.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/grant/grant_neg_review_by.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/grant/grant_neg_task_lease_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/grant/grant_neg_valid_until.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/grant/grant_positive_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/input-digests.json` | missing in audit baseline | imported historical source evidence; archival warning in RESULT, not current verification |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/invite_claim/invite_claim_boundary_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/invite_claim/invite_claim_neg_due_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/invite_claim/invite_claim_neg_fencing_token.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/invite_claim/invite_claim_neg_grant_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/invite_claim/invite_claim_neg_lease_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/invite_claim/invite_claim_neg_review_by.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/invite_claim/invite_claim_neg_valid_until.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/invite_claim/invite_claim_positive_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/lease_fence/lease_fence_boundary_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/lease_fence/lease_fence_neg_claim_by.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/lease_fence/lease_fence_neg_due_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/lease_fence/lease_fence_neg_grant_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/lease_fence/lease_fence_neg_lease_expires_at.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/lease_fence/lease_fence_neg_review_by.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/lease_fence/lease_fence_neg_valid_until.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/lease_fence/lease_fence_positive_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/pytest-output.txt` | missing in audit baseline | imported historical source evidence; archival warning in RESULT, not current verification |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/review-output.txt` | missing in audit baseline | imported historical source evidence; archival warning in RESULT, not current verification |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/schema-mutations.json` | missing | imported synthetic fixture, original bytes |
| `docs/platform-plan/contracts/tests/fixtures/review-retraction/catalog.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/review-retraction/expected_projections_after_retraction_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/review-retraction/sequence_accepted_retracted_replay_v1.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/fixtures/xp-rebuild/expected-projection.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/tests/fixtures/xp-rebuild/ordered-source-records.json` | same | already present byte-identical |
| `docs/platform-plan/contracts/tests/requirements-static.txt` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/test_five_clock_invariants.py` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/contracts/tests/test_low_ops_contracts.py` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/test_retracted_receipt_replay.py` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/test_work_reviewer_capacity.py` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/tests/test_xp_projection_rebuild.py` | same | already present byte-identical |
| `docs/platform-plan/contracts/work-participation.example.yaml` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/work-participation.schema.json` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/contracts/xp-policy.example.yaml` | same | already present byte-identical |
| `docs/platform-plan/contracts/xp-policy.schema.json` | same | already present byte-identical |
| `docs/platform-plan/execution/acceptance-matrix.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/first-work-batch.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/human-foundation-plan.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/milestones.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/spec-index.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/specs/AGT-01.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/AGT-02.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/AGT-04.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/AGT-05.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/BLD-01.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/BLD-02.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/BLD-03.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/BLD-04.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/BLD-05.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/FND-01.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/specs/FND-02.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/specs/FND-03.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/specs/FND-04.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/specs/FND-06.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/specs/INT-03A.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/INT-03B.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/ORG-01.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/specs/ORG-02.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/execution/specs/SKL-01.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/SKL-03.md` | same | already present byte-identical |
| `docs/platform-plan/execution/specs/WRK-01.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/verification/2026-09-17-tree-verification.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `docs/platform-plan/verification/2026-09-19-file-inventory.json` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/verification/2026-09-19-revision-check.md` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/verification/2026-09-19-static-tests.txt` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `docs/platform-plan/verification/verify_revision.py` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |

Validation for this documentation change: 39 relative Markdown links checked with zero missing targets; JSON fixture parse validation and `git diff --check` passed. No runtime, CI, live/provider or product acceptance test was run by this audit. Inventory is intentionally left to the integration owner after all agents are combined.

## Requirement-level follow-up

Follow-up reads distinguish **safe requirements**, **dated historical observations**, and **private operational records**. A filename alone is not a privacy finding. All 33 handoffs were read for stable requirements; changed hunks in all 38 differing source documents were compared to integration content, including contract fields and state-machine guards. The following mappings are content dispositions, not declarations that mapped features are complete. The sources remain preserved in the original checkout; their historical model/author attribution is unchanged. Session identifiers, administrator identity details, member/provider state, private evidence and provisioning records are omitted from public summaries. No credentials or member records are copied.

No stable product requirement was found solely in an excluded handoff and absent from current canonical documentation. The actual documentation omission was safe **historical FW-01 evidence**, now restored at its original paths. The original source's mandatory Star request remains an explicitly unresolved request, not an accepted voluntary substitute or implemented gate. The Jason/Talent & Direction training and Hao/community roles are retained in `06 §3.1`, planning README and `execution/human-foundation-plan.md` HF-P28; shortened architecture rows do not remove those assignments.

The raw-copy exclusions below are separate from keeping safe content. `O` means private operator/provider/member configuration or administration context; `E` means private evidence paths, session transcripts or member screenshots; `H` means historical SHA/test/deploy/resource observations requiring dated attribution rather than current proof. These categories explain why a public wholesale dump would be misleading or disclose unnecessary operational material. Sources lacking private data are still retained locally as historical handoffs because their safe requirements already have a canonical home; they are not labeled inherently secret.

| Historical source | Safe requirement content / current canonical home | Raw-copy disposition |
| --- | --- | --- |
| `HANDOFF-CLAUDE-CLOUD-ACCEPTANCE-2026-09-24.md` | Selected-phase registration/messages verification, exact-SHA evidence, synthetic-only cleanup, no real channel history; [cloud candidate verifier](../../../scripts/verify-cloud-candidate.md), [migration status](../../development/cloudflare-migration-status-2026-09-24.md), [communications](../../development/member-communications.md) | O/E/H; September candidate topology and pass counts are historical |
| `HANDOFF-CODEX-AUTHOR-OWNED-COLLABORATION-2026-09-23.md` | Original Repo/Fork/PR targets, authorship/license/version credit, no ownership transfer; [original-author collaboration](../../development/author-owned-collaboration.md) | H; safe policy already canonical, old worktree/verification observations remain local |
| `HANDOFF-CODEX-COCREATION-ADMIN-2026-09-23.md` | Explicit registration/profile audiences, skill libraries, verified nominated identity, atomic appointment, no signup-derived admin; [member release](../../development/member-onboarding-release.md), [admin API](../../development/platform-admin-api.md) | O/E/H; nominee/provisioning details excluded |
| `HANDOFF-CODEX-COCREATION-PROMPTS-GUILDS-2026-09-23.md` | Single project prompt, original vs integration task, bounded guild classification, task filters and late-response/clipboard fallback; [co-creation](../../development/co-creation.md) | H; safe requirements already canonical |
| `HANDOFF-CODEX-COLLABORATION-2026-09-23.md` | Public no-member-data guides, fixed sources, optional benefit observations, consented reuse and future squad/work gaps; [agent guide](../../development/agent-development-guide.md), [benefit observations](../../development/benefit-observations.md), [plan drift](../../development/plan-drift-2026-09-23.md) | E/H; local authorship/review/deploy records excluded |
| `HANDOFF-CODEX-COMPACT-WORKSHOP-2026-09-23.md` | Master-first/expert rows, authenticated portraits, compact covers, real-state Star/Fork control, stale OAuth and focus guards; [guild layout](../../development/guild-library-layout.md), [GitHub social](../../development/github-social.md), [design](../../../DESIGN.md) | O/E/H; explicitly private handoff and member-link state |
| `HANDOFF-CODEX-COMPLETE-2026-09-24.md` | Central data authority, privacy/revocation/replay, six real-data todos, protocol pins, environment isolation and safe restore; [member settings](../../development/member-settings-messages.md), [migration](../../development/cloudflare-migration.md), [repository integration](../../development/repository-integration.md) | O/E/H; obsolete pre-cutover topology and provider/member snapshots |
| `HANDOFF-CODEX-DESIGN-2026-09-23.md` | Original logo is highest anchor, shared brand, no fake XP/data, confirmed positioning not overwritten by drafts; [design](../../../DESIGN.md), [member release](../../development/member-onboarding-release.md) | O/E/H; private nominations and deployment validation |
| `HANDOFF-CODEX-EIGHT-AUTHOR-SKILLS-PROFILE-2026-09-24.md` | Original source attribution/limitations, explicit nullable identity label, display-name change without login-email change, old-client preserve behavior; [community authors](../../development/community-author-skills.md), [member API](../../development/member-api.md) | E/H; old counts/versions are dated snapshots |
| `HANDOFF-CODEX-FOUR-AUTHOR-SKILLS-2026-09-24.md` | Four original authors, source SHA/license uncertainty, no automatic Fork/grant/primary change, no upstream-execution claim; [member skill registration](../../development/member-skill-registration.md) | O/E/H; source license observations retained there; no new license inferred |
| `HANDOFF-CODEX-FULL-AUDIT-2026-09-24.md` | Maintainer AND guild editor qualification, GitHub stable-ID uniqueness and reconnect revoke, custom guild checks, truthful incomplete long-term plan; [audit](../../development/audit-2026-09-24.md), [editor access](../../development/skill-editor-guild-access.md), [identity uniqueness](../../development/github-identity-uniqueness.md), [reconnect race](../../development/github-grant-reconnect-race.md) | E/H; independent source security findings mapped, historical deployment proofs not promoted |
| `HANDOFF-CODEX-GITHUB-SOCIAL-2026-09-23.md` | Unknown/stale metric state, no OAuth-implied Star, explicit member action, separate env encryption; [GitHub social](../../development/github-social.md) | O/E/H; member link/provider configuration snapshots omitted |
| `HANDOFF-CODEX-GITHUB-STAR-PERMISSIONS-2026-09-23.md` | App metadata + starring least privilege, repo installation separate from OAuth, no CLI impersonation/no 403 author-blame; [GitHub social](../../development/github-social.md#star-權限錯誤) | O/E/H; individual real-member permission/action history omitted |
| `HANDOFF-CODEX-GUILD-APPOINTMENTS-2026-09-23.md` | Search enabled community members, confirmation atomically joins/grants/appoints, preserves primary, expertise not admin, no resurrection on replay/rejoin; [admin API](../../development/platform-admin-api.md) | O/E/H; nominee/deployment/cleanup administration omitted |
| `HANDOFF-CODEX-GUILD-COLLABORATION-2026-09-23.md` | Launch-day vs registered provenance, roster search/filter/sort, social-link audiences, designated books/real Stars, scoped announcement/editor/council rights; [guild collaboration](../../development/guild-collaboration.md), [member social links](../../development/member-social-links.md), [member API](../../development/member-api.md) | O/E/H; production policy and verification-account records |
| `HANDOFF-CODEX-GUILD-DEVELOPMENT-ACCESS-2026-09-23.md` | OR-source grant/revoke, no token revival, submission credentials separate, GitHub native rights and external revoke outbox; explicit mandatory Star request remains unresolved; [development access](../../development/guild-development-access.md) | H; safe requirements and policy discussion already retained |
| `HANDOFF-CODEX-GUILD-DEVELOPMENT-DEPLOYED-2026-09-24.md` | Exact-target private proposals only, seven-day grant/60-minute key, last-source revoke, current provider permission recheck, no code-write/merge/deploy authority; [development access](../../development/guild-development-access.md#本輪實作範圍) | O/E/H; signed-in real-person provider verification not inferred |
| `HANDOFF-CODEX-GUILD-LEADERSHIP-2026-09-23.md` | At most three expert slots, inactive active appointment retains slot, race-safe fourth rejection before side effects, master not automatic slot; [admin API](../../development/platform-admin-api.md), [guild layout](../../development/guild-library-layout.md) | O/E/H; old production capacity snapshots excluded |
| `HANDOFF-CODEX-GUILD-LIBRARY-014469a-2026-09-23.md` | One primary/two persisted secondaries, new joins do not displace, grants survive leave, free previews and responsive growing rows; [guild layout](../../development/guild-library-layout.md) | E/H; verifier/application SHA distinction remains historical |
| `HANDOFF-CODEX-MEMBER-BETA-2026-09-23.md` | Privacy by current relationship, explicit join/primary, no invented leaders, revocable client read token with declared local cache boundary; [member API](../../development/member-api.md), [read connections](../../development/client-read-connections.md) | O/E/H; mandatory positioning superseded by October quick join, old host/DNS observations excluded |
| `HANDOFF-CODEX-MEMBER-SETTINGS-MESSAGES-2026-09-24.md` | Current membership on read/write/replay, conversation privacy, Unicode bound, real unread/error states, same-transaction notifications, owner-accepted invitations; [communications](../../development/member-communications.md), [settings](../../development/member-settings-messages.md) | E/H; no implication full plan/Star gate complete |
| `HANDOFF-CODEX-MEMBER-TOOLKIT-2026-09-23.md` | Private bounded normalized avatars, single positioning flow, small direct UI, audited admin revocation/self-last-admin guard, remote readback sync; [toolkit](../../development/member-toolkit.md), [admin API](../../development/platform-admin-api.md) | O/E/H; real administrator provisioning details omitted |
| `HANDOFF-CODEX-MODULES-2026-09-23.md` | Immutable offer/listing/source snapshots, private marketing drafts, source/license OSS import, previews not checkout/revenue; [module design](../../development/module-expansion-design.md), [plan drift](../../development/plan-drift-2026-09-23.md) | O/E/H; historical Castle service and member/data snapshots |
| `HANDOFF-CODEX-ONBOARDING-RECOVERY-2026-09-23.md` | Bound fetch/body deadline, exact same-command retry, freeze unknown mutation, separate checkpoints, no localStorage/answer logging, never infer 522 root cause; [onboarding API](../../development/onboarding-api.md) | O/E/H; member incident time and service observations remain historical |
| `HANDOFF-CODEX-PRIMARY-GUILD-HELP-2026-09-24.md` | Explicit primary choice only from selected guilds, nearby missing-choice prompt/focus, no automatic choice, preserved drafts; [onboarding release](../../development/member-onboarding-release.md), [onboarding API](../../development/onboarding-api.md) | H; safe requirement already canonical, old completed release does not prove present acceptance |
| `HANDOFF-CODEX-REPOSITORIES-2026-09-23.md` | One central truth, fixed contract/consumer pins, exact manifests, session/CSRF/CAS/idempotency, no auto retry and no external deployment assumptions; [repository integration](../../development/repository-integration.md) | O/E/H; historical repo/Pages configuration operations excluded |
| `HANDOFF-CODEX-SEAT-2026-09-19.md` | Stable planning IDs, no AI signing/payment authority, Seller-only collection, default roles and honest evidence boundaries; [baseline](../00-current-requirements-baseline.md), [delivery](../06-delivery-plan.md), [human foundation](../execution/human-foundation-plan.md) | E/H; explicitly outside canonical corpus; old session paths/hard locks superseded by current task authorization |
| `HANDOFF-CODEX-SKILL-GITHUB-ACTIONS-2026-09-24.md` | Progressive/no-JS original Star/Fork/Watch/author Follow links, exact same-origin OAuth return, private state never SSR/localStorage; [GitHub social](../../development/github-social.md#公開介紹頁的操作入口) | O/E/H; no new provider consent or Star proof |
| `HANDOFF-CODEX-SKILL-SHARING-79b9b6a-2026-09-23.md` | Per-book dice/100 blurbs, bounded illustrations, one-use 60-minute draft upload, revoked scoped keys, owner preview/publication and no official badge; [skill upload](../../development/agent-skill-upload.md), [sharing release](../../releases/2026-09-23-agent-skill-sharing.md) | O/E/H; historical Linux/Windows/edit-withdraw limitations retained as scope, not current blanket claims |
| `HANDOFF-CODEX-SKILL-SHARING-bfb26e7-2026-09-23.md` | Same upload/sharing requirement set plus synchronous secret DOM clearing and late-response epoch invalidation; [skill upload](../../development/agent-skill-upload.md) | E/H; intermediate deployment progress superseded by 79b9b6a handoff |
| `HANDOFF-CODEX-STAGING-2026-09-23.md` | Immutable release, preserve Access, env/DB separation, backup/restore into isolated target and no false managed-cloud claim; [staging operations](../../development/staging-operations.md), [migration](../../development/cloudflare-migration.md) | O/E/H; explicitly private config/evidence, September topology superseded |
| `HANDOFF-CODEX-WORKSPACE-IA-92ad64c-2026-09-23.md` | Dedicated skill shelf vs OSS intake, grouped management, mobile navigation/skip focus, old hashes and privacy/source preserved; [IA review](../../development/workspace-ia-review.md) | E/H; old review/deployment evidence not new verification |
| `SESSION-CONTINUITY-2026-09-20.md` | Preserve original source, pinned test evidence distinct from product claims, Jason/Hao coordination, real operating cases without ten-free-help requirement; [local runtime](../../development/local-runtime.md), [operating validation](../../development/operating-validation.md), [first real case](../../development/first-real-case-pack.md) | E/H; private session transcript routing and obsolete KEEP PUSHING instructions are not present authorization |

## Differing-source content reconciliation

Every row below compares original-only/replaced hunks, not just existence. Unchanged source text remains in the same integration path. Later policy changes take precedence over September planning defaults. `12-low-ops-mutual-benefit.md` is already byte-identical in both sources and provides the additional reviewer-capacity, voluntary help, protected obligations and participation-terms policy; reverting old narrative/state-machine hunks would undo it.

| Differing source path | Meaningful original content / current disposition |
| --- | --- |
| `README.md` | Historical handoff/worktree pointers and pre-cutover facts replaced by current source navigation. Planning-not-product boundary and narrative entry retained; no old grok-only instruction imported as current policy. |
| `docs/platform-plan/02-architecture-repositories.md` | Original deterministic ai-online parity superseded by original questionnaire direction. Jason/T&D and Hao/community assignments still explicit in 06 §3.1 and planning README. Existing table row saying ai-online golden fixtures conflicts with newer no-parity prose: documentation inconsistency identified, no lost requirement and no restoration of obsolete parity. |
| `docs/platform-plan/01-product-community-model.md` | Source task/reward funnel, automatic first-submission Vibe membership and always-free human review revised by low-ops help/participation and explicit-member-join policy. Free knowledge vs paid human time, contribution without ownership/payable, Seller collection and exact authorization remain. No implicit promise of reviewer capacity reintroduced. |
| `docs/platform-plan/05-integration-contracts.md` | Stable member command, device flow, explicit execution grant and organization/private-data separation remain. Original skip-positioning bootstrap journey narrowed to post-joining welcome; October quick joining preserves optional assessment without making welcome a signup bypass. |
| `docs/platform-plan/08-bootstrap-hosting-project-lifecycle.md` | Only status line differs; substantive original resource, owner, hosting and recovery requirements unchanged. |
| `docs/platform-plan/07-decisions-risks-traceability.md` | ADR/RQ stable identities retained. First-party email session facts and explicit voluntary membership supersede LINE-first/no-session and submission-auto-join assumptions. Human QC capacity requires accepted reservation; visibility is not a revenue promise. No safety/authorization requirement removed. |
| `docs/platform-plan/11-operator-agent-narrative.md` | Original blanket all-resources-absent/no-tests statements narrowed by dated local runtime facts. Original roles retained in delivery and README; fake planning signature/production evidence boundary unchanged. |
| `docs/platform-plan/06-delivery-plan.md` | Original fixed seeded tracks/cohort counts and mandatory short feedback are superseded by low-ops real demand, voluntary feedback and capacity planning. Four loops, technical dependency sequence, Seller payment lane and exact release authority remain; no old numeric cohort default reinstated. |
| `docs/platform-plan/09-handoff-record.md` | Original inventory/tree counts and all-resources-unbuilt facts are historical, replaced by integration evidence/navigation. It is not a product requirement source; snapshot preserved original, no stale counters imported as current. |
| `docs/platform-plan/README.md` | Original source/read-order/principles remain; Now/Next/Gained task funnel revised to voluntary help/benefit model. Original Jason/Hao/Ted/Mini roles remain explicit; older private checkout pointers replaced by repository links. |
| `docs/platform-plan/04-module-specifications.md` | Source automatic Vibe enrollment on software submission explicitly superseded by independent member-selected guild joining. Candidate/QC/official separation, free access and work evidence remain; low-ops participation terms added rather than dropping work safety. |
| `docs/platform-plan/10-member-agent-narrative.md` | Old full-day task/store/marketing/field-review story replaced by low-ops help story. Its signed Skill fail-closed loading, exact Seller/Supplier authorization, standing-grant limits, original GitHub consent, no automatic ownership/revenue remain in 03/04/05/08/12 and canonical commerce/development docs; narrative is not permission or deployed-runtime proof. |
| `docs/platform-plan/00-current-requirements-baseline.md` | Source baseline date and auto-submission membership rule superseded by low-ops revision and explicit join. Stable foundational principles, Seller collection, independent review and evidence boundaries remain. |
| `docs/platform-plan/03-domain-events-state-machines.md` | Original automatic Vibe submission membership superseded. Reviewer-capacity projection remains stable waiting_reviewer_capacity ID but does not block open/claims or promise human time. Clock/expiry/fence and work-owned-by-person boundaries retained. |
| `docs/platform-plan/execution/first-work-batch.md` | Original new/not_run FW-01–12 static test paths now exist; current text distinguishes static fixture evidence from original product acceptance. No source requirement or stable FW ID removed. |
| `docs/platform-plan/execution/acceptance-matrix.md` | Original T01–T26 and voluntary product-learning signal preserved. Unbuilt/all-not_run blanket changed to distinguish static FW evidence from product acceptance; human research remains consented and non-gating. |
| `docs/platform-plan/execution/human-foundation-plan.md` | Only stale status/resource existence claim revised; human account/billing/signature lanes and HF-P28 training=Jason/delegate unchanged. |
| `docs/platform-plan/execution/milestones.md` | M00–M09/package owners retained. Original optional positioning narrowed September then restored via October quick joining; voluntary assessment cannot bypass explicit primary-guild joining. Runtime evidence still distinct from milestone acceptance. |
| `docs/platform-plan/execution/spec-index.md` | Stable packages/RQ mappings and roles retained. Original no-tests claim revised for existing static FW evidence, plus incremental UF spec links; historical package completion is not promoted. |
| `docs/platform-plan/contracts/project-manifest.schema.json` | Source central plaintext prohibition retained. Explicit external-client-owned seven-day read-token cache exception narrowly declared (0600 is not encryption); server custody exception forbidden. GitHub .github repository spelling support is a semantic expansion, not unsafe generic hostname acceptance. |
| `docs/platform-plan/contracts/organization-professions.example.yaml` | Original submission-creates-Vibe invariant superseded by source/version/evidence-only submission and separate explicit self-join. Maintainer appointment cannot imply AI guild membership. |
| `docs/platform-plan/contracts/README.md` | Original strict URL/repo/official provenance and credential-root semantics retained. Narrow external client cache exception and post-joining welcome purpose documented; raw provider secrets remain forbidden. |
| `docs/platform-plan/contracts/agent-work-contract.example.yaml` | Original review wait lifecycle corrected to orthogonal navigation with same stable ID. Added pinned terms, accepted human capacity, benefit confirmation and protected-obligation expiry boundaries; ordinary claims are not reviewer-gated. |
| `docs/platform-plan/contracts/member-onboarding.example.yaml` | Only journey identifier clarifies existing/post-positioning welcome; fixtures remain non-activating and skip is not a new-member bypass. |
| `docs/platform-plan/contracts/openapi-outline.yaml` | Original enrollment shortcut/day-one welcome revised to post-joining explicit flow; participation terms/benefits added. Source duplicate top-level release-status fencing_token proposal is superseded by complete nested ReleaseStatusLeaseProof (expiry and fence on one lease object), checked by current static tests. Claim_window_open remains on all new-claim transitions; do not resurrect historical duplicate response fields. |
| `docs/platform-plan/contracts/member-onboarding.schema.json` | Only schema title changes to clarify post-positioning/existing-member welcome; underlying fields remain. |
| `docs/platform-plan/contracts/event-catalog.example.yaml` | No original-only/replaced content; integration only adds source-traceable low-ops event definitions. |
| `docs/platform-plan/verification/2026-09-17-tree-verification.md` | Historical file counts/digests and FW01 snapshot additions differ. Requirements do not originate in this generated report; restored FW01 companion evidence retains historical source hashes without rewriting current inventory. |
| `docs/platform-plan/contracts/state-machines/core.example.yaml` | State formatting plus review-capacity lifecycle correction. Human-owned Claims, independent lease, accepted evidence not money/ownership, exclusive capacity and claim-window guards retained. New protected obligations/terms are stronger constraints; no old reviewer-queue gate reintroduced. |
| `docs/platform-plan/contracts/tests/test_five_clock_invariants.py` | Original JSON-backed schema validation/recursive refs/prose setter+expiry+renewal tests replaced by catalog/YAML static tests. Reference JSON imported; original setter/expiry/renewal/foreign-clock rules remain canonical in 03 §11 and fixture inputs. Historical stronger response-level fence requirement is superseded by nested complete lease proof. Test coverage differences are not product PASS; source old test is preserved original, not overwritten into latest suite. |
| `docs/platform-plan/execution/specs/FND-02.md` | Original local schema work and provider/restore technical dependencies remain; dated beta PostgreSQL/outbox facts do not complete inbox/lease/PITR requirements. |
| `docs/platform-plan/execution/specs/ORG-02.md` | Original self-confirmed WorkIntent/private-org separation/equipped-not-qualified retained; October quick join permits optional assessment and old-member compatibility. September onboarding gate is dated, not restored as mandatory assessment. |
| `docs/platform-plan/execution/specs/FND-06.md` | Original exact entitlement/appointment scope requirements unchanged. Test-path existence clarified; static FW04 does not establish entitlement runtime acceptance. |
| `docs/platform-plan/execution/specs/FND-01.md` | Original signed formal bundle requirement unchanged. Existing beta preview bundle distinguished from formal contract authority and static XP fixtures distinguished from original acceptance. |
| `docs/platform-plan/execution/specs/ORG-01.md` | Original interim stewardship requirement refined: existing owner preserves safety/accepted commitments, reduces optional new promises, never invents unconsenting volunteer/interim capacity. Governance continuity intent retained. |
| `docs/platform-plan/execution/specs/FND-03.md` | Provider-neutral identity, no fuzzy merge and cross-user/community denial retained. Dated email/GitHub stable-ID subset recorded while recovery/LINE/Discord merge remain unmet; no static/provider claim promoted. |
| `docs/platform-plan/execution/specs/FND-04.md` | Only unbuilt test-path observation dated; principal/permission/expiry safety requirements unchanged. |
| `docs/platform-plan/execution/specs/WRK-01.md` | Work/claim review/lease requirements unchanged; FW01/static evidence explicitly separated from original runtime acceptance and nonexistent runtime cases. |

## Historical evidence provenance and license boundary

`RESULT.md`, `review-output.txt`, `pytest-output.txt` and `input-digests.json` are safe engineering source records, not disposable cache. The original RESULT is dated 2026-09-20 and attributes its static/synthetic evidence and limitations; the review retains its original named reviewer/model claims and initial failures. They are restored at the original fixture paths. RESULT now has an archival warning; the other three retain original bytes. Their old source hashes intentionally differ from current integration source, and the archive is not used to claim present CI/runtime/deployment or product acceptance. Python `__pycache__` remains excluded as generated executable cache.

No new license or authorship is asserted by this import. This checkout has no tracked LICENSE/NOTICE file; importing these user-authorized project records does not grant a new public reuse license. Original authors/reviewer attribution remains as written, and upstream source-license observations remain in their canonical skill-registration docs (including NOASSERTION/uncertainty). No private upstream source or third-party code is imported.

Follow-up validation: all 33 mapped source filenames exist, none are omitted; 61 relative link targets resolve, JSON syntax parses and `git diff --check` passes. Checks cover links and whitespace; runtime/product/provider tests are not relevant evidence for this documentation import. The integration owner regenerates inventory after combining these changes.
