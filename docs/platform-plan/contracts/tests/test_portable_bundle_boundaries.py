"""FW-09: portable bundle tamper / compatibility boundaries (static only).

Acceptance (first-work-batch FW-09 / RQ-047 / ADR-049 / T16 / BLD-01..04):
  - minimal valid bundle manifest passes portable-activation schema
  - negatives: tampered digest, unknown major, revoked signer, host-shadow
  - each negative has a fixed failure class and zero execution assertion
  - signatures use non-production test key fixture only; no production trust root
  - pytest only; no network, money, secrets, or production keys
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator, FormatChecker

CONTRACTS = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures" / "portable-bundle"

SCHEMA = json.loads((CONTRACTS / "portable-activation.schema.json").read_text())
CATALOG = yaml.safe_load((FIX / "catalog.yaml").read_text())
CASES = yaml.safe_load((FIX / "cases.yaml").read_text())["cases"]
KEYS = json.loads((FIX / "keys" / "nonprod-test-keys.json").read_text())

VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())

FAILURE_CLASSES = tuple(CATALOG["failure_classes"])
SCHEMA_MAJOR_RE = re.compile(
    r"^freedom\.(?:bundle-manifest|signed-channel|revocation-snapshot"
    r"|skill-registry-snapshot|publisher-policy|publisher-keyset-transition"
    r"|publisher-bootstrap-index|activation-lock|activation-pointer"
    r"|activation-session-lease|portable-activation-fixture-set)/v(\d+)$"
)


def case_by_id(case_id: str) -> dict:
    return next(c for c in CASES if c["case_id"] == case_id)


def load_artifact(rel: str) -> dict:
    return json.loads((FIX / rel).read_text())


def schema_errors(doc: dict) -> list:
    return list(VALIDATOR.iter_errors(doc))


def parse_schema_major(schema_version: str) -> int | None:
    m = SCHEMA_MAJOR_RE.match(schema_version or "")
    return int(m.group(1)) if m else None


def parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def revoked_kids_at(revocation: dict, statement_issued_at: str) -> set[str]:
    """Kids invalid when statement.issued_at >= revoked_key.invalid_from."""
    issued = parse_dt(statement_issued_at)
    out: set[str] = set()
    for tomb in revocation.get("statement", {}).get("revoked_keys") or []:
        if issued >= parse_dt(tomb["invalid_from"]):
            out.add(tomb["kid"])
    return out


def evaluate_boundary(case: dict) -> dict:
    """Pure local boundary evaluator. Never executes payloads or fetches network."""
    artifact = load_artifact(case["artifact"])
    kind = case["artifact_kind"]
    execution = {
        "execution_allowed": False,
        "executable_effects": 0,
        "effects": [],
    }

    if kind == "bundle_manifest":
        errors = schema_errors(artifact)
        major = parse_schema_major(artifact.get("schema_version", ""))
        supported = case.get("supported_schema_majors") or [1]
        if major is None or major not in supported:
            return {
                "schema_valid": False,
                "failure_class": "unknown_major",
                **execution,
            }
        if case["kind"] == "negative" and case.get("expected_payload_digest"):
            declared = artifact.get("payload_digest")
            expected = case["expected_payload_digest"]
            if declared != expected:
                return {
                    "schema_valid": len(errors) == 0,
                    "failure_class": "tampered_digest",
                    **execution,
                }
        if errors:
            return {
                "schema_valid": False,
                "failure_class": "unknown_major" if major not in supported else "schema_invalid",
                **execution,
            }
        # planning_fixture never production-activates
        return {
            "schema_valid": True,
            "failure_class": None,
            **execution,
        }

    if kind == "signed_channel_with_revocation":
        channel = artifact["signed_channel"]
        revocation = artifact["revocation_snapshot"]
        ch_errors = schema_errors(channel)
        rev_errors = schema_errors(revocation)
        schema_ok = not ch_errors and not rev_errors

        # Keys fixture must remain non-production / non-trust-root.
        assert KEYS["production_use"] is False
        assert KEYS["production_trust_root"] is False
        assert KEYS["production_signed"] is False
        assert artifact.get("production_trust_root") is False

        issued_at = channel["statement"]["issued_at"]
        revoked = revoked_kids_at(revocation, issued_at)
        signer_kids = {s["kid"] for s in channel["proof"]["signatures"]}
        if signer_kids & revoked:
            return {
                "schema_valid": schema_ok,
                "failure_class": "revoked_signer",
                "revoked_kids": sorted(signer_kids & revoked),
                **execution,
            }
        return {
            "schema_valid": schema_ok,
            "failure_class": None,
            **execution,
        }

    if kind == "host_shadow_fixture":
        sealed_names = {
            s["name"].lower() for s in artifact["sealed_session"]["skills"]
        }
        shadows = []
        for cand in artifact.get("host_discovery_candidates") or []:
            name = (cand.get("name") or "").lower()
            if name in sealed_names and (
                cand.get("shadows_sealed_root")
                or cand.get("path", "").startswith(".")
                or cand.get("mutable")
            ):
                shadows.append(cand)
        if shadows or not artifact.get("isolation", {}).get("host_discovery_masked", True):
            return {
                "schema_valid": None,
                "failure_class": "host_shadow",
                "shadow_count": len(shadows),
                **execution,
            }
        return {
            "schema_valid": None,
            "failure_class": None,
            **execution,
        }

    raise ValueError(f"unknown artifact_kind {kind!r}")


# ---------------------------------------------------------------------------
# Catalog / key hygiene
# ---------------------------------------------------------------------------


def test_catalog_lists_exact_failure_classes():
    assert list(CATALOG["failure_classes"]) == [
        "tampered_digest",
        "unknown_major",
        "revoked_signer",
        "host_shadow",
    ]
    assert CATALOG["production_trust_root"] is False
    assert CATALOG["production_use"] is False
    assert CATALOG["network"] is False
    assert CATALOG["money"] is False
    assert CATALOG["secrets"] is False


def test_nonprod_keys_fixture_is_marked_and_contains_no_private_material():
    assert KEYS["note"].startswith("NON_PRODUCTION")
    assert KEYS["production_use"] is False
    assert KEYS["production_trust_root"] is False
    assert KEYS["production_signed"] is False
    assert KEYS["artifact_profile"] == "planning_fixture"
    kids = [k["kid"] for k in KEYS["keys"]]
    assert kids == sorted(kids), "keys must be sorted by kid for fixture hygiene"
    for key in KEYS["keys"]:
        assert key["production_use"] is False
        assert key["private_material"] is None
        assert key["algorithm"] == "EdDSA"
        assert key["public_jwk"]["kty"] == "OKP"
        assert key["public_jwk"]["crv"] == "Ed25519"
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", key["public_jwk"]["x"])


def test_cases_cover_valid_and_all_negative_failure_classes():
    kinds = {c["kind"] for c in CASES}
    assert "valid" in kinds
    negatives = [c for c in CASES if c["kind"] == "negative"]
    assert {c["expect"]["failure_class"] for c in negatives} == set(FAILURE_CLASSES)
    for c in negatives:
        assert c["expect"]["execution_allowed"] is False
        assert c["expect"]["executable_effects"] == 0


# ---------------------------------------------------------------------------
# Valid fixture
# ---------------------------------------------------------------------------


def test_valid_minimal_bundle_manifest_schema_pass():
    case = case_by_id("valid_minimal_bundle_manifest")
    result = evaluate_boundary(case)
    assert result["schema_valid"] is True
    assert result["failure_class"] is None
    # planning_fixture never grants execution in this fixture suite
    assert result["execution_allowed"] is False
    assert result["executable_effects"] == 0
    doc = load_artifact(case["artifact"])
    assert doc["artifact_profile"] == "planning_fixture"
    assert doc["schema_version"] == "freedom.bundle-manifest/v1"


# ---------------------------------------------------------------------------
# Negatives — fixed failure class + zero execution
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case_id,failure_class",
    [
        ("negative_tampered_digest", "tampered_digest"),
        ("negative_unknown_major", "unknown_major"),
        ("negative_revoked_signer", "revoked_signer"),
        ("negative_host_shadow", "host_shadow"),
    ],
)
def test_negative_fixed_failure_class_and_zero_execution(case_id: str, failure_class: str):
    case = case_by_id(case_id)
    assert case["expect"]["failure_class"] == failure_class
    result = evaluate_boundary(case)
    assert result["failure_class"] == failure_class
    assert result["execution_allowed"] is False
    assert result["executable_effects"] == 0
    assert result["effects"] == []


def test_tampered_digest_declared_digest_differs_from_expected():
    case = case_by_id("negative_tampered_digest")
    doc = load_artifact(case["artifact"])
    assert doc["payload_digest"] != case["expected_payload_digest"]
    assert not schema_errors(doc)
    result = evaluate_boundary(case)
    assert result["failure_class"] == "tampered_digest"
    assert result["executable_effects"] == 0


def test_unknown_major_rejects_schema_and_blocks_execution():
    case = case_by_id("negative_unknown_major")
    doc = load_artifact(case["artifact"])
    assert parse_schema_major(doc["schema_version"]) == 99
    assert schema_errors(doc)
    result = evaluate_boundary(case)
    assert result["schema_valid"] is False
    assert result["failure_class"] == "unknown_major"
    assert result["execution_allowed"] is False


def test_revoked_signer_uses_only_nonprod_keys_and_blocks_execution():
    case = case_by_id("negative_revoked_signer")
    artifact = load_artifact(case["artifact"])
    channel = artifact["signed_channel"]
    revocation = artifact["revocation_snapshot"]
    assert not schema_errors(channel)
    assert not schema_errors(revocation)

    fixture_kids = {k["kid"] for k in KEYS["keys"]}
    for sig in channel["proof"]["signatures"]:
        assert sig["kid"] in fixture_kids
        assert "nonprod" in sig["kid"] or "test" in sig["kid"]

    revoked = {t["kid"] for t in revocation["statement"]["revoked_keys"]}
    assert "publisher-key/fw09-test-nonprod-revoked" in revoked
    result = evaluate_boundary(case)
    assert result["failure_class"] == "revoked_signer"
    assert "publisher-key/fw09-test-nonprod-revoked" in result["revoked_kids"]
    assert result["executable_effects"] == 0


def test_host_shadow_detects_unmasked_host_candidate():
    case = case_by_id("negative_host_shadow")
    artifact = load_artifact(case["artifact"])
    assert artifact["isolation"]["host_discovery_masked"] is False
    assert any(c["shadows_sealed_root"] for c in artifact["host_discovery_candidates"])
    result = evaluate_boundary(case)
    assert result["failure_class"] == "host_shadow"
    assert result["shadow_count"] >= 1
    assert result["execution_allowed"] is False
    assert result["executable_effects"] == 0


def test_every_case_matches_expect_block():
    for case in CASES:
        result = evaluate_boundary(case)
        expect = case["expect"]
        assert result["failure_class"] == expect["failure_class"], case["case_id"]
        assert result["execution_allowed"] is expect["execution_allowed"], case["case_id"]
        assert result["executable_effects"] == expect["executable_effects"], case["case_id"]
        if expect.get("schema_valid") is not None:
            assert result["schema_valid"] is expect["schema_valid"], case["case_id"]


def test_no_production_trust_root_artifact_present():
    """FW-09 must not introduce a production trust root."""
    for path in FIX.rglob("*"):
        if not path.is_file():
            continue
        text = path.read_text()
        if path.suffix in {".json", ".yaml", ".yml"}:
            assert '"production_trust_root": true' not in text
            assert "production_trust_root: true" not in text
            assert '"policy_profile": "production"' not in text
            assert '"channel_profile": "production"' not in text
        # private key material markers
        assert "BEGIN PRIVATE KEY" not in text
        assert "BEGIN OPENSSH PRIVATE KEY" not in text
        assert '"d":' not in text  # JWK private component


def test_evaluator_does_not_mutate_fixtures():
    case = case_by_id("negative_tampered_digest")
    before = load_artifact(case["artifact"])
    evaluate_boundary(case)
    after = load_artifact(case["artifact"])
    assert before == after
