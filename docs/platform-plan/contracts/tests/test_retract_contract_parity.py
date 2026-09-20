"""FW-12: retract success response canonical OpenAPI + state/event parity (static only).

Acceptance (first-work-batch FW-12 / RQ-060 / ADR-061 / T11 / 05 §3.2/3.3):
  - typed 200 success body RetractQualityReviewSuccess is in canonical OpenAPI
    (retraction_ref, original_review_ref, aggregate_version, state)
  - HTTP 200 does not imply the original review was deleted
  - aggregate_version / ETag usable for optimistic concurrency; 412 VersionConflict
  - schema $refs resolve
  - historical proposal diff is applied/superseded (not a live gap)
  - FW-03 fixtures remain present; this module does not claim named reviewers passed
"""
from __future__ import annotations

from copy import deepcopy
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
    assert not name, f"FW-12 canonical refs must be local, got {ref}"
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


def retract_op() -> dict:
    return PATHS[RETRACT_PATH]["post"]


def canonical_success_schema() -> dict:
    return SCHEMAS[PROPOSED_SCHEMA_NAME]


def inline_success_schema() -> dict:
    """Inline local component $refs so Draft 2020-12 can validate bodies."""
    schema = canonical_success_schema()
    return {
        "type": schema["type"],
        "additionalProperties": schema["additionalProperties"],
        "required": list(schema["required"]),
        "properties": {
            "retraction_ref": SCHEMAS["OpaqueId"],
            "original_review_ref": SCHEMAS["OpaqueId"],
            "aggregate_version": SCHEMAS["AggregateVersion"],
            "state": schema["properties"]["state"],
        },
    }


def success_validator() -> Draft202012Validator:
    inline = inline_success_schema()
    Draft202012Validator.check_schema(inline)
    return Draft202012Validator(inline, format_checker=FormatChecker())


# ---------------------------------------------------------------------------
# Current-contract parity (OpenAPI path × state machine × event catalog)
# ---------------------------------------------------------------------------

def test_current_retract_path_exists_with_request_and_errors():
    assert RETRACT_PATH in PATHS
    op = retract_op()
    assert op["operationId"] == "retractQualityReview"
    assert "200" in op["responses"]
    assert "409" in op["responses"]
    body_ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    assert body_ref.endswith("RetractQualityReviewRequest")
    _local_ref_target(body_ref, API)


def test_canonical_200_typed_success_retains_history_and_does_not_imply_delete():
    """Acceptance: 200 response does not imply original review deleted."""
    op = retract_op()
    resp_200 = op["responses"]["200"]
    desc = resp_200["description"].lower()
    assert "retained" in desc or "history" in desc
    assert "does not imply" in desc and "deleted" in desc
    op_desc = op["description"].lower()
    assert "without deleting" in op_desc or "appends a retraction" in op_desc
    content_ref = resp_200["content"]["application/json"]["schema"]["$ref"]
    assert content_ref.endswith(PROPOSED_SCHEMA_NAME)
    _local_ref_target(content_ref, API)
    schema = canonical_success_schema()
    schema_desc = schema["description"].lower()
    assert "does not delete" in schema_desc or "retaining original_review_ref" in schema_desc
    assert "append" in schema_desc or "retaining" in schema_desc


def test_canonical_success_schema_required_fields_and_refs():
    schema = canonical_success_schema()
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(REQUIRED_SUCCESS_FIELDS)
    for field in REQUIRED_SUCCESS_FIELDS:
        assert field in schema["properties"]
    assert schema["properties"]["state"]["const"] == "retracted"
    for ref in _walk_refs(schema):
        _local_ref_target(ref, API)
    assert schema["properties"]["retraction_ref"]["$ref"].endswith("OpaqueId")
    assert schema["properties"]["original_review_ref"]["$ref"].endswith("OpaqueId")
    assert schema["properties"]["aggregate_version"]["$ref"].endswith("AggregateVersion")


def test_current_retract_requires_if_match_etag_and_412_for_concurrency():
    op = retract_op()
    param_refs = [
        p.get("$ref", "") for p in op.get("parameters", []) if isinstance(p, dict)
    ]
    assert any(r.endswith("/IfMatch") for r in param_refs)
    if_match = API["components"]["parameters"]["IfMatch"]
    assert if_match["name"] == "If-Match"
    assert if_match["required"] is True
    agg = SCHEMAS["AggregateVersion"]
    assert "If-Match" in agg["description"] or "ETag" in agg["description"]

    etag = op["responses"]["200"]["headers"]["ETag"]
    assert etag["schema"]["type"] == "string"
    etag_desc = etag["description"].lower()
    assert "if-match" in etag_desc or "optimistic" in etag_desc
    assert "aggregate_version" in etag_desc

    ref_412 = op["responses"]["412"]["$ref"]
    assert ref_412.endswith("VersionConflict")
    conflict = _local_ref_target(ref_412, API)
    assert "optimistic" in conflict["description"].lower()
    problem_ref = conflict["content"]["application/problem+json"]["schema"]["$ref"]
    _local_ref_target(problem_ref, API)

    agg_prop = canonical_success_schema()["properties"]["aggregate_version"]
    assert "If-Match" in agg_prop["description"] or "ETag" in agg_prop["description"]


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
# Canonical success body vs historical planning example (not a live gap)
# ---------------------------------------------------------------------------

def test_historical_example_validates_against_canonical_success_schema():
    """FW-03 sequence example body must satisfy the canonical typed 200 schema."""
    validator = success_validator()
    example = PROPOSED["example_success_body"]
    validator.validate(example)

    fact = step_by_name("retract_accepted_review")["retraction_fact"]
    assert example["retraction_ref"] == fact["retraction_id"]
    assert example["original_review_ref"] == fact["original_review_ref"]
    assert example["aggregate_version"] == fact["aggregate_version"]
    assert example["state"] == "retracted"

    quoted = PROPOSED["example_etag"]
    assert quoted == f'"{example["aggregate_version"]}"'


def test_historical_planning_shape_matches_canonical_required_fields():
    """Planning fixture still names the same fields now frozen in OpenAPI."""
    schema = PROPOSED["proposed_schema"]
    canonical = canonical_success_schema()
    assert set(schema["required"]) == set(REQUIRED_SUCCESS_FIELDS)
    assert set(canonical["required"]) == set(schema["required"])
    assert schema["properties"]["state"]["const"] == canonical["properties"]["state"]["const"]
    assert schema["additionalProperties"] is False
    assert canonical["additionalProperties"] is False
    for ref in _walk_refs(schema):
        _local_ref_target(ref, API)


@pytest.mark.parametrize(
    "mutator,fragment",
    [
        (lambda b: b.pop("retraction_ref"), "retraction_ref"),
        (lambda b: b.pop("original_review_ref"), "original_review_ref"),
        (lambda b: b.pop("aggregate_version"), "aggregate_version"),
        (lambda b: b.pop("state"), "state"),
    ],
)
def test_success_body_rejects_missing_required_field(mutator, fragment):
    body = deepcopy(PROPOSED["example_success_body"])
    mutator(body)
    errors = list(success_validator().iter_errors(body))
    assert errors
    assert any(fragment in e.message or fragment in list(e.path) for e in errors)


def test_success_body_rejects_additional_properties():
    body = deepcopy(PROPOSED["example_success_body"])
    body["deleted"] = True
    errors = list(success_validator().iter_errors(body))
    assert errors
    assert any("additional" in e.message.lower() for e in errors)


def test_success_body_rejects_non_retracted_state():
    body = deepcopy(PROPOSED["example_success_body"])
    body["state"] = "accepted"
    errors = list(success_validator().iter_errors(body))
    assert errors
    assert any("retracted" in e.message or "const" in e.message.lower() for e in errors)


def test_success_body_rejects_non_integer_aggregate_version():
    body = deepcopy(PROPOSED["example_success_body"])
    body["aggregate_version"] = "2"
    errors = list(success_validator().iter_errors(body))
    assert errors


def test_canonical_200_does_not_describe_a_delete_tombstone():
    schema = canonical_success_schema()
    retr_desc = schema["properties"]["retraction_ref"]["description"].lower()
    orig_desc = schema["properties"]["original_review_ref"]["description"].lower()
    assert "not a delete tombstone" in retr_desc or "appended retraction" in retr_desc
    assert "retained" in orig_desc or "append-only" in orig_desc
    assert "original_review_ref" in schema["required"]


def test_historical_proposal_diff_is_applied_superseded_without_false_review_claims():
    assert PROPOSAL_DIFF.is_file()
    text = PROPOSAL_DIFF.read_text()
    header = text.split("---", 1)[0]
    header_lower = header.lower()
    assert "applied_superseded" in header_lower or (
        "applied" in header_lower and "superseded" in header_lower
    )
    assert "RetractQualityReviewSuccess" in text
    for field in REQUIRED_SUCCESS_FIELDS:
        assert field in text, f"missing proposal field: {field}"
    assert "does not imply the original review was deleted" in text.lower()
    assert "etag" in text.lower()
    assert "VersionConflict" in text
    assert "optimistic concurrency" in text.lower()
    # Honest record: do not treat named reviewer pass as a recorded fact.
    assert "reviewers passed" not in header_lower
    assert "grok review passed" not in header_lower
    assert "claude verify passed" not in header_lower
    assert "claude verification passed" not in header_lower
    assert "proposal_not_merged" not in header_lower
    assert "do not edit openapi-outline.yaml in fw-12" not in header_lower


def test_catalog_historical_pointer_and_fw03_anchors_remain():
    prop = CATALOG["fw12_proposal"]
    assert prop["proposed_schema"] == PROPOSED_SCHEMA_NAME
    assert prop["success_response_fixture"] == "proposed_retract_success_response_v1.yaml"
    diff_rel = prop["diff"]
    assert (REPO / diff_rel).is_file() or (PLAN.parent.parent / diff_rel).is_file()
    assert PROPOSAL_DIFF.is_file()
    assert "proposed_retract_success_response_v1.yaml" in CATALOG["fixture_files"]
    # FW-03 asserted fields untouched. Catalog status text is a historical
    # pointer and is not rewritten here; canonical OpenAPI now has the schema.
    assert CATALOG["fixed_problem_code"] == "receipt_superseded_by_retraction"
    assert CATALOG["fixed_problem_status"] == 409
    assert CATALOG["scenario"] == "accepted_then_retracted_then_old_receipt_replay"
    assert PROPOSED_SCHEMA_NAME in SCHEMAS
    assert CATALOG["history_rule"] == "append_only_never_delete_original_review_or_acceptance"


def test_historical_parity_block_matches_current_state_and_event():
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
    assert any("If-Match" in c for c in parity["concurrency"])
    assert any("aggregate_version" in c for c in parity["concurrency"])
    assert "original_review_not_deleted_on_200" in parity["history"]


def test_fw03_fixture_files_still_present():
    assert (FIX / "catalog.yaml").is_file()
    assert (FIX / "sequence_accepted_retracted_replay_v1.yaml").is_file()
    assert (FIX / "expected_projections_after_retraction_v1.yaml").is_file()
    assert (FIX / "proposed_retract_success_response_v1.yaml").is_file()
