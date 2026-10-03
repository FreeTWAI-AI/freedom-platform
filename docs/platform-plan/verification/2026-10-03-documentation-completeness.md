# Original-checkout documentation completeness audit

Audited 2026-10-03 against integration baseline `946d67bd200624ba61d23032ee7571e9fd47c602`. Source checkout HEAD: `4c019ff1207b448e8dbf5baab64435a5e919b349`. This is documentation provenance, not a new product spec or test/deployment claim.

The original HEAD has 131 documentation paths (all `docs/` files plus root Markdown); every path already exists in the integration baseline. The original index has zero such paths because its staged removals are intentional. Its filesystem has 123 documentation paths: 36 byte-identical, 38 different, 49 absent from integration. Its tracked deletions and untracked replacements were left untouched. No canonical HEAD document is missing from integration.

Eleven absent JSON synthetic fixture inputs are imported byte-for-byte at their original paths. Attribution remains the original source checkout and its FW-01 historical review context. They are reference fixtures, not new runtime evidence; the current canonical tests/specs remain authoritative. No source spec was overwritten. The older README and 37 differing specification/contract/test files require requirement-level comparison before any content adoption; wholesale replacement would discard subsequent integration changes.

The 33 HANDOFF/SESSION files contain historical operational assertions, private evidence locations, deployment procedures and member/provider administration context. They are excluded from public Git. Their public product topics already have canonical documentation under `docs/development/`, `docs/releases/`, and the platform plan; historical deployment assertions cannot be promoted to current proof. The five remaining missing files are historical result/log/digest records or generated Python cache, excluded from current verification. Private identifiers or credentials are not reproduced in this audit. No credential material is imported. Patch/bundle artifacts and nested `.gitdata`, `.bat-worktrees` and `worktrees` are working artifacts, not canonical documentation, and are excluded.

The following source map covers the union of original HEAD documentation and original filesystem documentation. “Different” is a diff recommendation to retain integration content and compare the old source only when a current requirement is demonstrably missing. Source paths are relative to the preserved original checkout; no private source content is quoted.

| Source path | Baseline comparison | Disposition |
| --- | --- | --- |
| `CHANGES-2026-09-19.md` | original HEAD only; absent filesystem/index | already present in integration; staged deletion preserved |
| `HANDOFF-CLAUDE-CLOUD-ACCEPTANCE-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-AUTHOR-OWNED-COLLABORATION-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-COCREATION-ADMIN-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-COCREATION-PROMPTS-GUILDS-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-COLLABORATION-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-COMPACT-WORKSHOP-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-COMPLETE-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-DESIGN-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-EIGHT-AUTHOR-SKILLS-PROFILE-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-FOUR-AUTHOR-SKILLS-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-FULL-AUDIT-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-GITHUB-SOCIAL-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-GITHUB-STAR-PERMISSIONS-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-GUILD-APPOINTMENTS-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-GUILD-COLLABORATION-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-GUILD-DEVELOPMENT-ACCESS-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-GUILD-DEVELOPMENT-DEPLOYED-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-GUILD-LEADERSHIP-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-GUILD-LIBRARY-014469a-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-MEMBER-BETA-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-MEMBER-SETTINGS-MESSAGES-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-MEMBER-TOOLKIT-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-MODULES-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-ONBOARDING-RECOVERY-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-PRIMARY-GUILD-HELP-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-REPOSITORIES-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-SEAT-2026-09-19.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-SKILL-GITHUB-ACTIONS-2026-09-24.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-SKILL-SHARING-79b9b6a-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-SKILL-SHARING-bfb26e7-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-STAGING-2026-09-23.md` | missing | excluded private historical handoff |
| `HANDOFF-CODEX-WORKSPACE-IA-92ad64c-2026-09-23.md` | missing | excluded private historical handoff |
| `README.md` | different | retain integration revision; reconcile source only against current requirements, do not overwrite |
| `SESSION-CONTINUITY-2026-09-20.md` | missing | excluded private historical handoff |
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
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/RESULT.md` | missing | excluded generated cache / historical test evidence; not current verification |
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
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/input-digests.json` | missing | excluded generated cache / historical test evidence; not current verification |
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
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/pytest-output.txt` | missing | excluded generated cache / historical test evidence; not current verification |
| `docs/platform-plan/contracts/tests/fixtures/five-clocks/review-output.txt` | missing | excluded generated cache / historical test evidence; not current verification |
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
