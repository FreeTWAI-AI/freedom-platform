"""FW-12: retract success response proposal + OpenAPI/state/event parity (static only).

Acceptance (first-work-batch FW-12 / RQ-060 / ADR-061 / T11 / 05 §3.2/3.3):
  - typed success response proposal (retraction_ref, original_review_ref,
    aggregate_version, state)
  - OpenAPI / state / event parity against *current* contracts
  - HTTP 200 does not imply the original review was deleted
  - aggregate_version usable for optimistic concurrency
  - schema $refs resolve; proposal diff separately marked (not merged)
  - FW-03 fixtures / test_retracted_receipt_replay.py remain green
"""
from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote

import pytest
import yaml
from jsonschema import Draft202012Validator, FormatChecker

C = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures" / "review-retraction"
PLAN = C.parent  # docs/platform-plan/
REPO = PLAN.parent.parent  # repo root

API = yaml.safe_load((C / "openapi-outline.yaml").read_text())
SCHEMAS = API["components"]["schemas"]
RESPONSES = API["components"]["responses"]
PATHS = API["paths"]
CORE = yaml.safe_load((C / "state-machines" / "core.example.yaml").read_text())
EVENTS = yaml.safe_load((C / "event-catalog.example.yaml").read_text())

CATALOG = yaml.safe_load((FIX / "catalog.yaml").read_text())
SEQUENCE = yaml.safe_load((FIX / "sequence_accepted_retracted_replay_v1.yaml").read_text())
PROPOSED = yaml.safe_load((FIX / "proposed_retract_success_response_v1.yaml").read_text())

REVIEW_OUTCOME = CORE["machines"]["review_outcome"]
RETRACT_PATH = "/quality-reviews/{reviewId}:retract"
PROPOSAL_DIFF = PLAN / "execution" / "proposals" / "retract-success-response.diff"
PROPOSED_SCHEMA_NAME = "RetractQualityReviewSuccess"
REQUIRED_SUCCESS_FIELDS = (
    "retraction_ref",
    "original_review_ref",
    "aggregate_version",
    "state",
)


def _local_ref_target(ref: str, root: dict):
    """Resolve an OpenAPI local $ref against a document root."""
    name, _, fragment = ref.partition("#")
    assert not name, f"FW-12 proposal must use local refs only, got {ref}"
    assert fragment.startswith("/"), ref
    obj = root
    for token in unquote(fragment).split("/")[1:]:
        token = token.replace("~1", "/").replace("~0", "~")
        assert token in obj, f"unresolved {ref} at {token}"
        obj = obj[token]
    return obj


def _walk_refs(value):
    if isinstance(value, dict):
        if "$ref" in value:
            yield value["$ref"]
        for child in value.values():
            yield from _walk_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_refs(child)


def step_by_name(name: str) -> dict:
    return next(s for s in SEQUENCE["steps"] if s["name"] == name)


# ---------------------------------------------------------------------------
# Current-contract parity (OpenAPI path × state machine × event catalog)
# ---------------------------------------------------------------------------

def test_current_retract_path_exists_with_request_and_errors():
    assert RETRACT_PATH in PATHS
    op = PATHS[RETRACT_PATH]["post"]
    assert op["operationId"] == "retractQualityReview"
    assert "200" in op["responses"]
    assert "409" in op["responses"]
    body_ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    assert body_ref.endswith("RetractQualityReviewRequest")
    _local_ref_target(body_ref, API)


def test_current_200_description_retains_history_and_does_not_imply_delete():
    """Acceptance: 200 response does not imply original review deleted."""
    op = PATHS[RETRACT_PATH]["post"]
    desc = op["responses"]["200"]["description"].lower()
    assert "retained" in desc or "history" in desc
    assert "deleted" not in desc or "without deleting" in op["description"].lower()
    # Operation description is the strong guarantee in current contracts.
    op_desc = op["description"].lower()
    assert "without deleting" in op_desc or "appends a retraction" in op_desc
    # Current 200 is description-only (typed body is the FW-12 proposal gap).
    assert "content" not in op["responses"]["200"]


def test_current_retract_requires_if_match_for_concurrency():
    op = PATHS[RETRACT_PATH]["post"]
    param_refs = [
        p.get("$ref", "") for p in op.get("parameters", []) if isinstance(p, dict)
    ]
    assert any(r.endswith("/IfMatch") for r in param_refs)
    if_match = API["components"]["parameters"]["IfMatch"]
    assert if_match["name"] == "If-Match"
    assert if_match["required"] is True
    # AggregateVersion documents ETag / If-Match wire form.
    agg = SCHEMAS["AggregateVersion"]
    assert "If-Match" in agg["description"] or "ETag" in agg["description"]


def test_state_machine_accepted_to_retracted_emits_catalog_event():
    assert REVIEW_OUTCOME["initial"] == "accepted"
    assert "retracted" in REVIEW_OUTCOME["terminal"]
    t = REVIEW_OUTCOME["transitions"][0]
    assert t["from"] == "accepted"
    assert t["to"] == "retracted"
    assert t["command"] == "retract_accepted_review"
    assert t["event"] == "freedom.quality.review.retracted.v1"
    types = {e["type"] for e in EVENTS["events"]}
    assert t["event"] in types
    evt = next(e for e in EVENTS["events"] if e["type"] == t["event"])
    assert evt["aggregate"] == "review_decision"
    assert evt["producer"] == "quality-commercialization"


def test_state_invariants_forbid_delete_and_resurrection():
    inv = REVIEW_OUTCOME["invariants"]
    assert "original_review_and_acceptance_history_are_never_deleted_or_overwritten" in inv
    assert any("never_restores_acceptance" in i for i in inv)
    assert any("receipt_superseded_by_retraction" in i for i in inv)


def test_sequence_fixture_parity_with_openapi_state_event():
    retract = step_by_name("retract_accepted_review")
    t = REVIEW_OUTCOME["transitions"][0]
    assert retract["command"] == t["command"]
    assert retract["event"] == t["event"]
    assert retract["review_outcome_state"] == t["to"]
    assert retract["http"]["path"] == RETRACT_PATH
    assert retract["http"]["operationId"] == PATHS[RETRACT_PATH]["post"]["operationId"]
    assert retract["http"]["expected_status"] == 200
    fact = retract["retraction_fact"]
    assert fact["original_review_ref"] == retract["http"]["request"]["original_review_ref"]
    assert fact["aggregate_version"] >= 1


def test_retract_request_schema_refs_resolve():
    req = SCHEMAS["RetractQualityReviewRequest"]
    for ref in _walk_refs(req):
        _local_ref_target(ref, API)
    assert set(req["required"]) >= {"reason", "original_review_ref"}
    assert "retracted_by" not in req["properties"]


def test_receipt_superseded_response_ref_resolves():
    ref = PATHS[RETRACT_PATH]["post"]["responses"]["409"]["$ref"]
    target = _local_ref_target(ref, API)
    schema_ref = target["content"]["application/problem+json"]["schema"]["$ref"]
    problem = _local_ref_target(schema_ref, API)
    props = problem["allOf"][1]["properties"]
    assert props["status"]["const"] == 409
    assert props["code"]["const"] == "receipt_superseded_by_retraction"


# ---------------------------------------------------------------------------
# Proposal artifact (separately marked; not applied to canonical OpenAPI)
# ---------------------------------------------------------------------------

def test_proposal_diff_exists_and_is_separately_marked():
    assert PROPOSAL_DIFF.is_file()
    text = PROPOSAL_DIFF.read_text()
    for marker in (
        "FW-12 PROPOSAL",
        "NOT APPLIED TO CANONICAL CONTRACTS",
        "proposal_not_merged",
        "RetractQualityReviewSuccess",
        "retraction_ref",
        "original_review_ref",
        "aggregate_version",
        "state",
    ):
        assert marker in text, f"missing proposal marker/field: {marker}"
    # Must not claim it was applied.
    assert "proposal_not_merged" in text
    assert "do not edit openapi-outline.yaml in FW-12" in text


def test_canonical_openapi_does_not_yet_define_success_schema():
    """Proposal差異單獨標示 — typed success schema is proposal-only until verified."""
    assert PROPOSED_SCHEMA_NAME not in SCHEMAS
    op = PATHS[RETRACT_PATH]["post"]
    resp_200 = op["responses"]["200"]
    assert "content" not in resp_200
    # 412 VersionConflict is also proposal-only for this path today.
    assert "412" not in op["responses"]


def test_proposed_fixture_declares_typed_success_fields():
    assert PROPOSED["status"] == "proposal_not_applied_to_canonical"
    assert PROPOSED["proposed_schema_name"] == PROPOSED_SCHEMA_NAME
    schema = PROPOSED["proposed_schema"]
    assert set(schema["required"]) == set(REQUIRED_SUCCESS_FIELDS)
    for field in REQUIRED_SUCCESS_FIELDS:
        assert field in schema["properties"]
    assert schema["properties"]["state"]["const"] == "retracted"
    assert schema["additionalProperties"] is False


def test_proposed_schema_refs_resolve_against_current_openapi():
    schema = PROPOSED["proposed_schema"]
    for ref in _walk_refs(schema):
        _local_ref_target(ref, API)
    # Also resolve VersionConflict response referenced by the proposal.
    _local_ref_target("#/components/responses/VersionConflict", API)
    _local_ref_target("#/components/schemas/OpaqueId", API)
    _local_ref_target("#/components/schemas/AggregateVersion", API)


def test_proposed_example_validates_against_proposed_schema():
    """Example body from FW-03 sequence aligns with proposed typed success."""
    schema = PROPOSED["proposed_schema"]
    # Build a Draft202012 validator with local component resolution via id map.
    components = {
        "OpaqueId": SCHEMAS["OpaqueId"],
        "AggregateVersion": SCHEMAS["AggregateVersion"],
    }

    def resolver(uri: str):
        # jsonschema store keys we register below.
        return None

    store = {
        "#/components/schemas/OpaqueId": SCHEMAS["OpaqueId"],
        "#/components/schemas/AggregateVersion": SCHEMAS["AggregateVersion"],
    }
    # Inline $refs for validation without a full OpenAPI resolver.
    inline = {
        "type": "object",
        "additionalProperties": False,
        "required": list(schema["required"]),
        "properties": {
            "retraction_ref": SCHEMAS["OpaqueId"],
            "original_review_ref": SCHEMAS["OpaqueId"],
            "aggregate_version": SCHEMAS["AggregateVersion"],
            "state": {"const": "retracted"},
        },
    }
    Draft202012Validator.check_schema(inline)
    validator = Draft202012Validator(inline, format_checker=FormatChecker())
    example = PROPOSED["example_success_body"]
    validator.validate(example)

    # Align with FW-03 sequence retraction fact.
    fact = step_by_name("retract_accepted_review")["retraction_fact"]
    assert example["retraction_ref"] == fact["retraction_id"]
    assert example["original_review_ref"] == fact["original_review_ref"]
    assert example["aggregate_version"] == fact["aggregate_version"]
    assert example["state"] == "retracted"


def test_proposed_200_does_not_imply_original_review_deleted():
    phrases = [p.lower() for p in PROPOSED["proposed_200"]["description_must_include"]]
    assert any("retained" in p or "history" in p for p in phrases)
    assert any("does not imply" in p and "deleted" in p for p in phrases)
    desc = PROPOSED["proposed_schema"]["description"].lower()
    assert "does not delete" in desc or "retaining original_review_ref" in desc
    # Diff text must carry the same guarantee.
    diff = PROPOSAL_DIFF.read_text().lower()
    assert "does not imply the original review was deleted" in diff
    assert "does not delete" in diff or "retaining original_review_ref" in diff


def test_proposed_aggregate_version_usable_for_optimistic_concurrency():
    """Acceptance: version usable for optimistic concurrency."""
    schema = PROPOSED["proposed_schema"]
    agg_prop = schema["properties"]["aggregate_version"]
    assert agg_prop["$ref"].endswith("AggregateVersion")
    agg = SCHEMAS["AggregateVersion"]
    assert agg["type"] == "integer"
    assert "If-Match" in agg["description"] or "ETag" in agg["description"]

    etag = PROPOSED["proposed_200"]["headers"]["ETag"]
    assert "If-Match" in etag["purpose"] or "optimistic" in etag["purpose"]
    assert PROPOSED["example_etag"] == f'"{PROPOSED["example_success_body"]["aggregate_version"]}"'

    # Proposal adds 412 VersionConflict alongside required If-Match.
    assert PROPOSED["proposed_additional_responses"]["412"]["$ref"].endswith(
        "VersionConflict"
    )
    diff = PROPOSAL_DIFF.read_text()
    assert "ETag" in diff
    assert "VersionConflict" in diff
    assert "optimistic concurrency" in diff.lower()

    parity = PROPOSED["parity"]["concurrency"]
    assert any("If-Match" in c for c in parity)
    assert any("aggregate_version" in c for c in parity)


def test_proposed_parity_block_matches_current_state_and_event():
    parity = PROPOSED["parity"]
    t = REVIEW_OUTCOME["transitions"][0]
    assert parity["state_machine"] == "review_outcome"
    assert parity["transition_command"] == t["command"]
    assert parity["transition_to"] == t["to"]
    assert parity["event"] == t["event"]
    types = {e["type"] for e in EVENTS["events"]}
    assert parity["event"] in types
    for field in parity["event_payload_minimum"]:
        assert field in ("retracted_by", "reason", "original_review_ref")


def test_catalog_fw12_proposal_pointer_is_marked_not_applied():
    prop = CATALOG["fw12_proposal"]
    assert prop["status"] == "proposal_not_applied_to_canonical"
    assert prop["proposed_schema"] == PROPOSED_SCHEMA_NAME
    assert prop["success_response_fixture"] == "proposed_retract_success_response_v1.yaml"
    diff_rel = prop["diff"]
    assert (REPO / diff_rel).is_file() or (PLAN.parent.parent / diff_rel).is_file()
    # Prefer resolve from PLAN root: docs/platform-plan/../.. is repo
    assert PROPOSAL_DIFF.is_file()
    assert "proposed_retract_success_response_v1.yaml" in CATALOG["fixture_files"]
    # FW-03 asserted fields untouched.
    assert CATALOG["fixed_problem_code"] == "receipt_superseded_by_retraction"
    assert CATALOG["fixed_problem_status"] == 409
    assert CATALOG["scenario"] == "accepted_then_retracted_then_old_receipt_replay"


def test_fw03_fixture_files_still_present():
    assert (FIX / "catalog.yaml").is_file()
    assert (FIX / "sequence_accepted_retracted_replay_v1.yaml").is_file()
    assert (FIX / "expected_projections_after_retraction_v1.yaml").is_file()
    assert (FIX / "proposed_retract_success_response_v1.yaml").is_file()
