# Domain Skill Overlay — stage 1A contract fixtures

Materialized documentation of the existing stage-1A fixture tree. This file
does not claim cryptographic verification, a live runtime, production
activation, or stage 1B enable→execute→revoke paths.

## Boundary
- Stage **1A**: freeze schema/example consumption, JCS roots-set projection,
  2-of-N proof, QC natural-person independence, authority/revocation/mode gates,
  and golden + negative fixtures.
- Stage **1B** (out of scope here): three-CLI skeleton, sealed load, mid-run
  revoke drills, live enable→execute→revoke→capability_unavailable.

Existing catalog markers for this tree: `stage=1A`,
`stage_boundary=contract_fixtures_only_not_1B_runtime`,
`status=synthetic_planning_fixtures_not_runtime`, `no_runtime_claim=true`,
`network=false`, `money=false`, `secrets=false`.

## Exact existing fixture inventory

| Path | Role |
| --- | --- |
| `catalog.yaml` | Stage-1A catalog, failure classes, non-prod / no-runtime markers |
| `cases.yaml` | `as_of`, baseline control digest, server-derived refs, case expect blocks |
| `golden-meta.json` | Frozen golden `runtime_roots_set_digest` and matching control digest |
| `keys/nonprod-test-keys.json` | Non-prod public JWKs only; `private_material` is null |
| `valid/golden-overlay.json` | Gate-pass planning golden (`fixture_status=fake_planning_fixture_never_activate`) |
| `negative/missing-root.json` | `missing_root` |
| `negative/extra-root.json` | `extra_root` |
| `negative/reordered-root.json` | `reordered_root` |
| `negative/self-review.json` | `self_review` |
| `negative/expired.json` | `expired` |
| `negative/revoked.json` | `revoked` |
| `negative/host-shadow.json` | `host_shadow` (host discovery fixture, not a signed overlay body) |
| `negative/unsupported-isolation.json` | `unsupported_isolation` (adapter isolation fixture) |

Frozen values copied from the existing fixtures (planning numbers, not a
runtime or signature-verification result):

- `as_of`: `2026-09-20T12:00:00Z`
- `baseline_control_activation_digest` / golden control digest:
  `sha256:1111111111111111111111111111111111111111111111111111111111111111`
- `golden_runtime_roots_set_digest`:
  `sha256:801c0005d5604ea6a606c78a710e77e87eb1763985bfc398ebdbc47ba842feeb`
- `server_derived_skill_version_refs`:
  `skill-version:inventory-insight-1.0.0`,
  `skill-version:store-curation-1.0.0`

## Exact roots-set digest (frozen projection)

```
runtime_roots_set_digest = SHA-256(JCS({
  control_activation_digest,
  domain_roots: [ /* sorted by skill_version_ref UTF-8 bytes */ {
    skill_version_ref, package_id, version, skill_name,
    package_manifest_sha256, skill_package_digest, package_archive_sha256,
    dependency_closure_digest,
    qc_admission: {
      quality_review_ref, decision_signature_ref,
      reviewed_skill_package_digest, reviewed_package_archive_sha256
    }
  }, ...]
}))
```

`control_activation_digest` remains the existing eight-input control activation
digest and is never redefined by the overlay. Local tests compare the golden
digest bytes against this projection; that comparison is not cryptographic
verification of overlay signatures.

## Negatives (all → capability_unavailable, zero domain execution)
- missing_root / extra_root / reordered_root (vs server-derived WorkItem refs)
- self_review (reviewer_user_ref == submitter_user_ref)
- expired (overlay / bootstrap index / revocation window)
- revoked (proof kid in non-prod revocation fixture)
- host_shadow (unmasked host discovery candidate)
- unsupported_isolation (adapter lacks per-run sealed profile)

Every case in `cases.yaml`, including `valid_golden_overlay`, asserts
`domain_execution_allowed=false` and `domain_executable_effects=0`.

## Keys
- `keys/nonprod-test-keys.json` only (FW-09 conventions)
- `production_use=false`, `production_trust_root=false`, no private material
- kids present: `publisher-key:fw11-test-nonprod-a`,
  `publisher-key:fw11-test-nonprod-b`,
  `publisher-key:fw11-test-nonprod-c`,
  `publisher-key:fw11-test-nonprod-revoked`
- threshold `2`; algorithm `EdDSA` / `Ed25519` public JWKs; no private JWK
  material in the fixture

## Planning fixture rule
- `fixture_status=fake_planning_fixture_never_activate`
- Even gate-pass golden asserts `domain_execution_allowed=false` in stage 1A
- Canonical `domain-skill-overlay.example.json` remains a planning shape and
  is not activated by this README
