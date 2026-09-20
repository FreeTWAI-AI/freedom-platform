"""FW-11: BLD-05 stage 1A signed domain overlay contract fixtures (static only).

Acceptance (first-work-batch FW-11 / RQ-049 / RQ-047 / ADR-052 / T02 / T06 / T16 / BLD-05 1A):
  - valid overlay golden with exact roots-set digest
  - negatives: missing/extra/reordered root, self-review, expired/revoked,
    host-shadow, unsupported isolation
  - 2-of-N natural-Person independence; authority/revocation/mode verifiable
  - all negatives: zero domain execution assertion
  - control activation digest unchanged
  - non-prod test keys only; no production trust root
  - stage 1A contract only — no stage 1B runtime
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator, FormatChecker

CONTRACTS = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures" / "domain-skill-overlay"

SCHEMA = json.loads((CONTRACTS / "domain-skill-overlay.schema.json").read_text())
CATALOG = yaml.safe_load((FIX / "catalog.yaml").read_text())
CASES_DOC = yaml.safe_load((FIX / "cases.yaml").read_text())
CASES = CASES_DOC["cases"]
KEYS = json.loads((FIX / "keys" / "nonprod-test-keys.json").read_text())
GOLDEN_META = json.loads((FIX / "golden-meta.json").read_text())

VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())

FAILURE_CLASSES = tuple(CATALOG["failure_classes"])
BASELINE_CONTROL_ACTIVATION = CASES_DOC["baseline_control_activation_digest"]
SERVER_REFS = list(CASES_DOC["server_derived_skill_version_refs"])
AS_OF = CASES_DOC["as_of"]

ZERO_EXECUTION = {
    "domain_execution_allowed": False,
    "domain_executable_effects": 0,
    "domain_effects": [],
}


def case_by_id(case_id: str) -> dict:
    return next(c for c in CASES if c["case_id"] == case_id)


def load_artifact(rel: str) -> dict:
    return json.loads((FIX / rel).read_text())


def schema_errors(doc: dict) -> list:
    return list(VALIDATOR.iter_errors(doc))


def parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def jcs_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_digest(value: object) -> str:
    return "sha256:" + hashlib.sha256(jcs_bytes(value)).hexdigest()


def root_digest_entry(root: dict) -> dict:
    """Stage-1A frozen projection for runtime_roots_set_digest."""
    qc = root["qc_admission"]
    return {
        "dependency_closure_digest": root["dependency_closure_digest"],
        "package_archive_sha256": root["package_archive_sha256"],
        "package_id": root["package_id"],
        "package_manifest_sha256": root["package_manifest_sha256"],
        "qc_admission": {
            "decision_signature_ref": qc["decision_signature_ref"],
            "quality_review_ref": qc["quality_review_ref"],
            "reviewed_package_archive_sha256": qc["reviewed_package_archive_sha256"],
            "reviewed_skill_package_digest": qc["reviewed_skill_package_digest"],
        },
        "skill_name": root["skill_name"],
        "skill_package_digest": root["skill_package_digest"],
        "skill_version_ref": root["skill_version_ref"],
        "version": root["version"],
    }


def compute_runtime_roots_set_digest(statement: dict) -> str:
    ordered = sorted(
        statement["domain_roots"],
        key=lambda r: r["skill_version_ref"].encode("utf-8"),
    )
    payload = {
        "control_activation_digest": statement["control_activation_digest"],
        "domain_roots": [root_digest_entry(r) for r in ordered],
    }
    return sha256_digest(payload)


def roots_sorted(statement: dict) -> bool:
    refs = [r["skill_version_ref"] for r in statement["domain_roots"]]
    return refs == sorted(refs, key=lambda s: s.encode("utf-8"))


def natural_person_independent(statement: dict) -> bool:
    for root in statement["domain_roots"]:
        qc = root["qc_admission"]
        if not qc.get("independent_natural_person"):
            return False
        if qc["reviewer_user_ref"] == qc["submitter_user_ref"]:
            return False
    return True


def proof_threshold_met(artifact: dict) -> bool:
    proof = artifact.get("proof") or []
    if len(proof) != 2:
        return False
    kids = [p["kid"] for p in proof]
    if len(set(kids)) != 2:
        return False
    if kids != sorted(kids):
        return False
    fixture_kids = {k["kid"] for k in KEYS["keys"]}
    return all(k in fixture_kids for k in kids)


def authority_current(statement: dict, as_of: str) -> bool:
    now = parse_dt(as_of)
    return parse_dt(statement["publisher_authority"]["bootstrap_index_expires_at"]) > now


def revocation_current(statement: dict, as_of: str) -> bool:
    now = parse_dt(as_of)
    return parse_dt(statement["revocation_binding"]["expires_at"]) > now


def overlay_validity_current(statement: dict, as_of: str) -> bool:
    now = parse_dt(as_of)
    return (
        parse_dt(statement["valid_from"]) <= now < parse_dt(statement["expires_at"])
    )


def revoked_kids_at(as_of: str) -> set[str]:
    now = parse_dt(as_of)
    out: set[str] = set()
    for key in KEYS["keys"]:
        rev = key.get("revocation_fixture")
        if not rev:
            continue
        if now >= parse_dt(rev["invalid_from"]):
            out.add(key["kid"])
    return out


def mode_verifiable(statement: dict) -> bool:
    return (
        statement.get("runtime_mode") == "signed_isolated_overlay_v1"
        and statement.get("isolation_profile") == "per-run-sealed-domain-overlay-v1"
    )


def evaluate_overlay(case: dict) -> dict:
    """Pure local stage-1A gate evaluator. Never executes domain Skill bytes."""
    artifact_doc = load_artifact(case["artifact"])
    kind = case["artifact_kind"]
    as_of = case.get("as_of") or AS_OF
    server_refs = list(case.get("server_derived_skill_version_refs") or SERVER_REFS)

    if kind == "host_shadow_fixture":
        sealed = {
            s["name"].lower()
            for s in artifact_doc.get("sealed_session", {}).get("domain_skills") or []
        }
        shadows = []
        for cand in artifact_doc.get("host_discovery_candidates") or []:
            name = (cand.get("name") or "").lower()
            if name in sealed and (
                cand.get("shadows_sealed_root")
                or cand.get("mutable")
                or str(cand.get("path", "")).startswith(".")
            ):
                shadows.append(cand)
        masked = artifact_doc.get("isolation", {}).get("host_discovery_masked", True)
        # Control activation must remain the baseline from the referenced golden.
        overlay = load_artifact(artifact_doc["overlay_fixture"])
        control = overlay["artifact"]["statement"]["control_activation_digest"]
        if shadows or not masked:
            return {
                "schema_valid": None,
                "gates_pass": False,
                "failure_class": "host_shadow",
                "shadow_count": len(shadows),
                "control_activation_digest": control,
                "control_activation_digest_unchanged": control == BASELINE_CONTROL_ACTIVATION,
                **ZERO_EXECUTION,
            }
        return {
            "schema_valid": None,
            "gates_pass": True,
            "failure_class": None,
            "control_activation_digest": control,
            "control_activation_digest_unchanged": control == BASELINE_CONTROL_ACTIVATION,
            **ZERO_EXECUTION,
        }

    if kind == "unsupported_isolation_fixture":
        overlay = load_artifact(artifact_doc["overlay_fixture"])
        control = overlay["artifact"]["statement"]["control_activation_digest"]
        unsupported = [
            a
            for a in artifact_doc.get("adapters") or []
            if not a.get("adapter_isolation_supported")
            or a.get("isolation_profile_requested")
            != "per-run-sealed-domain-overlay-v1"
        ]
        if unsupported:
            return {
                "schema_valid": None,
                "gates_pass": False,
                "failure_class": "unsupported_isolation",
                "unsupported_adapters": [a["adapter"] for a in unsupported],
                "control_activation_digest": control,
                "control_activation_digest_unchanged": control == BASELINE_CONTROL_ACTIVATION,
                **ZERO_EXECUTION,
            }
        return {
            "schema_valid": None,
            "gates_pass": True,
            "failure_class": None,
            "control_activation_digest": control,
            "control_activation_digest_unchanged": control == BASELINE_CONTROL_ACTIVATION,
            **ZERO_EXECUTION,
        }

    if kind != "signed_overlay":
        raise ValueError(f"unknown artifact_kind {kind!r}")

    # Keys hygiene — non-production only.
    assert KEYS["production_use"] is False
    assert KEYS["production_trust_root"] is False
    assert KEYS["production_signed"] is False

    errors = schema_errors(artifact_doc)
    schema_ok = len(errors) == 0
    artifact = artifact_doc["artifact"]
    statement = artifact["statement"]
    control = statement["control_activation_digest"]
    control_unchanged = control == BASELINE_CONTROL_ACTIVATION

    computed_digest = compute_runtime_roots_set_digest(statement)
    digest_match = computed_digest == statement["runtime_roots_set_digest"]
    sorted_ok = roots_sorted(statement)
    np_ok = natural_person_independent(statement)
    proof_ok = proof_threshold_met(artifact)
    auth_ok = authority_current(statement, as_of)
    rev_ok = revocation_current(statement, as_of)
    validity_ok = overlay_validity_current(statement, as_of)
    mode_ok = mode_verifiable(statement)

    overlay_refs = [r["skill_version_ref"] for r in statement["domain_roots"]]
    overlay_set = set(overlay_refs)
    server_set = set(server_refs)

    revoked = revoked_kids_at(as_of)
    signer_kids = {p["kid"] for p in artifact["proof"]}
    signer_revoked = sorted(signer_kids & revoked)

    base = {
        "schema_valid": schema_ok,
        "roots_set_digest_match": digest_match and sorted_ok,
        "natural_person_independent": np_ok,
        "proof_threshold_met": proof_ok,
        "authority_current": auth_ok,
        "revocation_current": rev_ok,
        "mode_verifiable": mode_ok,
        "control_activation_digest": control,
        "control_activation_digest_unchanged": control_unchanged,
        **ZERO_EXECUTION,
    }

    # Failure precedence mirrors BLD-05 fail-closed gates.
    if not schema_ok:
        return {**base, "gates_pass": False, "failure_class": "schema_invalid"}

    if not sorted_ok or (
        overlay_set == server_set and overlay_refs != sorted(overlay_refs, key=lambda s: s.encode("utf-8"))
    ):
        return {**base, "gates_pass": False, "failure_class": "reordered_root"}

    # Detect reordered when digest was computed for sorted order but array is reversed.
    if overlay_set == server_set and not sorted_ok:
        return {**base, "gates_pass": False, "failure_class": "reordered_root"}

    if not digest_match:
        # Reordered roots with stale digest also fail digest; prefer reordered if set equal.
        if overlay_set == server_set and list(overlay_refs) != sorted(
            overlay_refs, key=lambda s: s.encode("utf-8")
        ):
            return {**base, "gates_pass": False, "failure_class": "reordered_root"}
        return {**base, "gates_pass": False, "failure_class": "roots_set_digest_mismatch"}

    missing = sorted(server_set - overlay_set)
    extra = sorted(overlay_set - server_set)
    if missing and not extra:
        return {
            **base,
            "gates_pass": False,
            "failure_class": "missing_root",
            "missing_refs": missing,
        }
    if extra and not missing:
        return {
            **base,
            "gates_pass": False,
            "failure_class": "extra_root",
            "extra_refs": extra,
        }
    if missing or extra:
        # Both — treat as set mismatch; prefer missing if any required absent.
        return {
            **base,
            "gates_pass": False,
            "failure_class": "missing_root" if missing else "extra_root",
            "missing_refs": missing,
            "extra_refs": extra,
        }

    if not np_ok:
        return {**base, "gates_pass": False, "failure_class": "self_review"}

    if not validity_ok or not auth_ok or not rev_ok:
        return {**base, "gates_pass": False, "failure_class": "expired"}

    if signer_revoked:
        return {
            **base,
            "gates_pass": False,
            "failure_class": "revoked",
            "revoked_kids": signer_revoked,
        }

    if not proof_ok or not mode_ok:
        return {
            **base,
            "gates_pass": False,
            "failure_class": "unsupported_isolation" if not mode_ok else "proof_invalid",
        }

    return {**base, "gates_pass": True, "failure_class": None}


# ---------------------------------------------------------------------------
# Catalog / key hygiene
# ---------------------------------------------------------------------------


def test_catalog_lists_exact_failure_classes():
    assert list(CATALOG["failure_classes"]) == [
        "missing_root",
        "extra_root",
        "reordered_root",
        "self_review",
        "expired",
        "revoked",
        "host_shadow",
        "unsupported_isolation",
    ]
    assert CATALOG["production_trust_root"] is False
    assert CATALOG["production_use"] is False
    assert CATALOG["stage"] == "1A"
    assert CATALOG["network"] is False
    assert CATALOG["money"] is False
    assert CATALOG["secrets"] is False
    assert CATALOG["no_runtime_claim"] is True


def test_nonprod_keys_fixture_is_marked_and_contains_no_private_material():
    assert KEYS["note"].startswith("NON_PRODUCTION")
    assert KEYS["production_use"] is False
    assert KEYS["production_trust_root"] is False
    assert KEYS["production_signed"] is False
    assert KEYS["artifact_profile"] == "planning_fixture"
    assert KEYS["threshold"] == 2
    kids = [k["kid"] for k in KEYS["keys"]]
    assert kids == sorted(kids), "keys must be sorted by kid for fixture hygiene"
    for key in KEYS["keys"]:
        assert key["production_use"] is False
        assert key["private_material"] is None
        assert key["algorithm"] == "EdDSA"
        assert key["public_jwk"]["kty"] == "OKP"
        assert key["public_jwk"]["crv"] == "Ed25519"
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", key["public_jwk"]["x"])
        assert "fw11" in key["kid"] or "test" in key["kid"] or "nonprod" in key["kid"]


def test_cases_cover_valid_and_all_negative_failure_classes():
    kinds = {c["kind"] for c in CASES}
    assert "valid" in kinds
    negatives = [c for c in CASES if c["kind"] == "negative"]
    assert {c["expect"]["failure_class"] for c in negatives} == set(FAILURE_CLASSES)
    for c in CASES:
        assert c["expect"]["domain_execution_allowed"] is False
        assert c["expect"]["domain_executable_effects"] == 0


# ---------------------------------------------------------------------------
# Valid golden
# ---------------------------------------------------------------------------


def test_valid_golden_overlay_schema_and_exact_roots_set_digest():
    case = case_by_id("valid_golden_overlay")
    doc = load_artifact(case["artifact"])
    assert not schema_errors(doc)
    statement = doc["artifact"]["statement"]
    assert statement["control_activation_digest"] == BASELINE_CONTROL_ACTIVATION
    assert statement["runtime_roots_set_digest"] == compute_runtime_roots_set_digest(
        statement
    )
    assert statement["runtime_roots_set_digest"] == GOLDEN_META[
        "golden_runtime_roots_set_digest"
    ]
    assert roots_sorted(statement)
    result = evaluate_overlay(case)
    assert result["schema_valid"] is True
    assert result["gates_pass"] is True
    assert result["failure_class"] is None
    assert result["roots_set_digest_match"] is True
    assert result["natural_person_independent"] is True
    assert result["proof_threshold_met"] is True
    assert result["authority_current"] is True
    assert result["revocation_current"] is True
    assert result["mode_verifiable"] is True
    assert result["control_activation_digest_unchanged"] is True
    assert result["domain_execution_allowed"] is False
    assert result["domain_executable_effects"] == 0


def test_valid_golden_two_of_n_proof_and_qc_natural_person_independence():
    doc = load_artifact("valid/golden-overlay.json")
    artifact = doc["artifact"]
    kids = [p["kid"] for p in artifact["proof"]]
    assert len(kids) == 2
    assert len(set(kids)) == 2
    assert kids == sorted(kids)
    for root in artifact["statement"]["domain_roots"]:
        qc = root["qc_admission"]
        assert qc["independent_natural_person"] is True
        assert qc["reviewer_user_ref"] != qc["submitter_user_ref"]
        assert qc["decision"] == "accepted_for_isolated_runtime"


# ---------------------------------------------------------------------------
# Negatives — fixed failure class + zero domain execution
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case_id,failure_class",
    [
        ("negative_missing_root", "missing_root"),
        ("negative_extra_root", "extra_root"),
        ("negative_reordered_root", "reordered_root"),
        ("negative_self_review", "self_review"),
        ("negative_expired", "expired"),
        ("negative_revoked", "revoked"),
        ("negative_host_shadow", "host_shadow"),
        ("negative_unsupported_isolation", "unsupported_isolation"),
    ],
)
def test_negative_fixed_failure_class_and_zero_domain_execution(
    case_id: str, failure_class: str
):
    case = case_by_id(case_id)
    assert case["expect"]["failure_class"] == failure_class
    result = evaluate_overlay(case)
    assert result["failure_class"] == failure_class
    assert result["gates_pass"] is False
    assert result["domain_execution_allowed"] is False
    assert result["domain_executable_effects"] == 0
    assert result["domain_effects"] == []
    assert result["control_activation_digest_unchanged"] is True


def test_missing_root_server_set_not_covered():
    case = case_by_id("negative_missing_root")
    doc = load_artifact(case["artifact"])
    refs = {r["skill_version_ref"] for r in doc["artifact"]["statement"]["domain_roots"]}
    assert refs == {"skill-version:inventory-insight-1.0.0"}
    result = evaluate_overlay(case)
    assert result["failure_class"] == "missing_root"
    assert "skill-version:store-curation-1.0.0" in result["missing_refs"]
    assert result["domain_executable_effects"] == 0


def test_extra_root_not_in_server_derived_set():
    case = case_by_id("negative_extra_root")
    doc = load_artifact(case["artifact"])
    refs = {r["skill_version_ref"] for r in doc["artifact"]["statement"]["domain_roots"]}
    assert "skill-version:pricing-hints-1.0.0" in refs
    result = evaluate_overlay(case)
    assert result["failure_class"] == "extra_root"
    assert "skill-version:pricing-hints-1.0.0" in result["extra_refs"]
    assert result["domain_executable_effects"] == 0


def test_reordered_root_breaks_sort_and_digest_binding():
    case = case_by_id("negative_reordered_root")
    doc = load_artifact(case["artifact"])
    statement = doc["artifact"]["statement"]
    refs = [r["skill_version_ref"] for r in statement["domain_roots"]]
    assert refs != sorted(refs, key=lambda s: s.encode("utf-8"))
    # Declared digest still matches sorted projection, but array order is wrong.
    assert statement["runtime_roots_set_digest"] == compute_runtime_roots_set_digest(
        statement
    )
    result = evaluate_overlay(case)
    assert result["failure_class"] == "reordered_root"
    assert result["domain_execution_allowed"] is False


def test_self_review_rejects_same_natural_person():
    case = case_by_id("negative_self_review")
    doc = load_artifact(case["artifact"])
    qc = doc["artifact"]["statement"]["domain_roots"][0]["qc_admission"]
    assert qc["reviewer_user_ref"] == qc["submitter_user_ref"]
    assert not schema_errors(doc)
    result = evaluate_overlay(case)
    assert result["failure_class"] == "self_review"
    assert result["natural_person_independent"] is False
    assert result["domain_executable_effects"] == 0


def test_expired_authority_revocation_and_overlay_window():
    case = case_by_id("negative_expired")
    doc = load_artifact(case["artifact"])
    statement = doc["artifact"]["statement"]
    as_of = parse_dt(AS_OF)
    assert parse_dt(statement["expires_at"]) <= as_of
    assert parse_dt(statement["publisher_authority"]["bootstrap_index_expires_at"]) <= as_of
    assert parse_dt(statement["revocation_binding"]["expires_at"]) <= as_of
    result = evaluate_overlay(case)
    assert result["failure_class"] == "expired"
    assert result["authority_current"] is False
    assert result["revocation_current"] is False
    assert result["domain_execution_allowed"] is False


def test_revoked_signer_uses_only_nonprod_keys_and_blocks_execution():
    case = case_by_id("negative_revoked")
    doc = load_artifact(case["artifact"])
    assert not schema_errors(doc)
    kids = {p["kid"] for p in doc["artifact"]["proof"]}
    assert "publisher-key:fw11-test-nonprod-revoked" in kids
    fixture_kids = {k["kid"] for k in KEYS["keys"]}
    assert kids <= fixture_kids
    result = evaluate_overlay(case)
    assert result["failure_class"] == "revoked"
    assert "publisher-key:fw11-test-nonprod-revoked" in result["revoked_kids"]
    assert result["domain_executable_effects"] == 0


def test_host_shadow_detects_unmasked_host_candidate():
    case = case_by_id("negative_host_shadow")
    artifact = load_artifact(case["artifact"])
    assert artifact["isolation"]["host_discovery_masked"] is False
    assert any(c["shadows_sealed_root"] for c in artifact["host_discovery_candidates"])
    result = evaluate_overlay(case)
    assert result["failure_class"] == "host_shadow"
    assert result["shadow_count"] >= 1
    assert result["domain_execution_allowed"] is False
    assert result["control_activation_digest_unchanged"] is True


def test_unsupported_isolation_blocks_domain_execution():
    case = case_by_id("negative_unsupported_isolation")
    artifact = load_artifact(case["artifact"])
    assert any(not a["adapter_isolation_supported"] for a in artifact["adapters"])
    result = evaluate_overlay(case)
    assert result["failure_class"] == "unsupported_isolation"
    assert "codex" in result["unsupported_adapters"] or "grok" in result[
        "unsupported_adapters"
    ]
    assert result["domain_executable_effects"] == 0
    assert result["control_activation_digest_unchanged"] is True


def test_every_case_matches_expect_block():
    for case in CASES:
        result = evaluate_overlay(case)
        expect = case["expect"]
        assert result["failure_class"] == expect["failure_class"], case["case_id"]
        assert result["domain_execution_allowed"] is expect["domain_execution_allowed"], case[
            "case_id"
        ]
        assert result["domain_executable_effects"] == expect["domain_executable_effects"], case[
            "case_id"
        ]
        assert result["control_activation_digest_unchanged"] is expect.get(
            "control_activation_digest_unchanged", True
        ), case["case_id"]
        if expect.get("schema_valid") is not None:
            assert result["schema_valid"] is expect["schema_valid"], case["case_id"]
        if "gates_pass" in expect:
            assert result["gates_pass"] is expect["gates_pass"], case["case_id"]


def test_control_activation_digest_unchanged_across_all_fixtures():
    """Overlay must never redefine the existing eight-input control activation digest."""
    for case in CASES:
        result = evaluate_overlay(case)
        assert result["control_activation_digest"] == BASELINE_CONTROL_ACTIVATION, case[
            "case_id"
        ]
        assert result["control_activation_digest_unchanged"] is True, case["case_id"]


def test_no_production_trust_root_artifact_present():
    for path in FIX.rglob("*"):
        if not path.is_file():
            continue
        text = path.read_text()
        if path.suffix in {".json", ".yaml", ".yml"}:
            assert '"production_trust_root": true' not in text
            assert "production_trust_root: true" not in text
            assert '"policy_profile": "production"' not in text
            assert '"channel_profile": "production"' not in text
        assert "BEGIN PRIVATE KEY" not in text
        assert "BEGIN OPENSSH PRIVATE KEY" not in text
        assert '"d":' not in text  # JWK private component


def test_evaluator_does_not_mutate_fixtures():
    case = case_by_id("negative_missing_root")
    before = load_artifact(case["artifact"])
    evaluate_overlay(case)
    after = load_artifact(case["artifact"])
    assert before == after


def test_canonical_example_still_schema_valid_as_planning_fixture():
    """Existing contracts example remains a valid planning shape (digest is placeholder)."""
    example = json.loads((CONTRACTS / "domain-skill-overlay.example.json").read_text())
    assert example["fixture_status"] == "fake_planning_fixture_never_activate"
    assert not schema_errors(example)
