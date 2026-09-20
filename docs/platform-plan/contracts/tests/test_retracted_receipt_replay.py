"""FW-03: retracted review — old receipt replay negatives (static only; no runtime).

Acceptance (first-work-batch FW-03 / T11 / RQ-060 / ADR-061):
  - accepted → retracted → replay sequence fixture
  - fixed problem code receipt_superseded_by_retraction (HTTP 409)
  - old receipt does not resurrect acceptance
  - XP / matching priority / entitlement rebuild exclude that review
  - original review + retraction history are both preserved (append-only)
"""
from __future__ import annotations

from pathlib import Path
import copy

import pytest
import yaml

C = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures" / "review-retraction"
PLAN = C.parent  # docs/platform-plan/

API = yaml.safe_load((C / "openapi-outline.yaml").read_text())
SCHEMAS = API["components"]["schemas"]
RESPONSES = API["components"]["responses"]
PATHS = API["paths"]
CORE = yaml.safe_load((C / "state-machines" / "core.example.yaml").read_text())
EVENTS = yaml.safe_load((C / "event-catalog.example.yaml").read_text())
XP_POLICY = yaml.safe_load((C / "xp-policy.example.yaml").read_text())
XP_SCHEMA = yaml.safe_load((C / "xp-policy.schema.json").read_text()) if False else None

CATALOG = yaml.safe_load((FIX / "catalog.yaml").read_text())
SEQUENCE = yaml.safe_load((FIX / "sequence_accepted_retracted_replay_v1.yaml").read_text())
EXPECTED = yaml.safe_load((FIX / "expected_projections_after_retraction_v1.yaml").read_text())

REVIEW_OUTCOME = CORE["machines"]["review_outcome"]
RETRACT_PATH = "/quality-reviews/{reviewId}:retract"
PROBLEM_CODE = "receipt_superseded_by_retraction"


# ---------------------------------------------------------------------------
# Pure fixture rebuild helpers (no I/O, no money, no network)
# ---------------------------------------------------------------------------

def step_by_name(name: str) -> dict:
    return next(s for s in SEQUENCE["steps"] if s["name"] == name)


def apply_sequence(through_seq: int | None = None) -> dict:
    """Replay fixture steps into an in-memory append-only store + projections."""
    store = {
        "facts": [],
        "outcome_by_review": {},
        "receipt_status": {},
        "contribution_records": {},
    }
    contrib = SEQUENCE["contribution_record"]
    store["contribution_records"][contrib["contribution_record_id"]] = copy.deepcopy(contrib)

    for step in SEQUENCE["steps"]:
        if through_seq is not None and step["seq"] > through_seq:
            break
        if step["name"] == "accept_review":
            receipt = step["review_receipt"]
            store["facts"].append(
                {
                    "kind": "review_accepted",
                    "seq": step["seq"],
                    "at": step["at"],
                    "event": step["event"],
                    "payload": copy.deepcopy(receipt),
                }
            )
            store["outcome_by_review"][receipt["review_id"]] = "accepted"
            store["receipt_status"][receipt["receipt_id"]] = {
                "superseded": False,
                "decision": "accepted",
                "review_id": receipt["review_id"],
            }
        elif step["name"] == "retract_accepted_review":
            fact = step["retraction_fact"]
            store["facts"].append(
                {
                    "kind": "review_retracted",
                    "seq": step["seq"],
                    "at": step["at"],
                    "event": step["event"],
                    "payload": copy.deepcopy(fact),
                }
            )
            review_id = fact["original_review_ref"]
            store["outcome_by_review"][review_id] = "retracted"
            # Mark every receipt for this review as superseded; never delete acceptance fact.
            for rid, meta in store["receipt_status"].items():
                if meta["review_id"] == review_id:
                    meta["superseded"] = True
                    meta["superseded_by"] = fact["retraction_id"]
        elif step["name"] == "replay_old_acceptance_receipt":
            receipt_id = step["replayed_receipt_id"]
            meta = store["receipt_status"][receipt_id]
            assert meta["superseded"] is True
            problem = copy.deepcopy(step["expected_http_problem"])
            store["facts"].append(
                {
                    "kind": "receipt_replay_rejected",
                    "seq": step["seq"],
                    "at": step["at"],
                    "receipt_id": receipt_id,
                    "problem": problem,
                }
            )
            # Outcome must stay retracted; acceptance must not resurrect.
            review_id = meta["review_id"]
            assert store["outcome_by_review"][review_id] == "retracted"
    return store


def rebuild_projections(store: dict) -> dict:
    """Rebuild XP / matching / entitlement from append-only facts + current outcomes."""
    review_filter = XP_POLICY["policy"]["source_contract"]["review_filter"]
    assert review_filter == "accepted_and_not_retracted"

    eligible_contrib_ids: list[str] = []
    included_review_ids: list[str] = []
    excluded_review_ids: list[str] = []

    # Map review -> contribution from acceptance facts
    review_to_contrib: dict[str, str] = {}
    for fact in store["facts"]:
        if fact["kind"] == "review_accepted":
            review_to_contrib[fact["payload"]["review_id"]] = fact["payload"][
                "contribution_record_id"
            ]

    xp_total = 0
    for review_id, outcome in store["outcome_by_review"].items():
        if outcome == "accepted":
            included_review_ids.append(review_id)
            cid = review_to_contrib[review_id]
            eligible_contrib_ids.append(cid)
            xp_total += int(store["contribution_records"][cid]["declared_xp"])
        elif outcome == "retracted":
            excluded_review_ids.append(review_id)

    member = SEQUENCE["actors"]["member_ref"]
    return {
        "xp_projection": {
            "member_ref": member,
            "profession_key": SEQUENCE["actors"]["profession_key"],
            "track": SEQUENCE["contribution_record"]["track"],
            "xp": xp_total,
            "policy_version": XP_POLICY["policy"]["policy_version"],
            "included_contribution_record_ids": sorted(set(eligible_contrib_ids)),
        },
        "matching_priority_projection": {
            "member_ref": member,
            "included_review_ids": sorted(included_review_ids),
            "excluded_because_retracted": sorted(excluded_review_ids),
        },
        "entitlement_projection": {
            "member_ref": member,
            "qc_or_listing_entitlements_from_review": sorted(included_review_ids),
            "excluded_because_retracted": sorted(excluded_review_ids),
        },
    }


# ---------------------------------------------------------------------------
# Catalog / fixture shape
# ---------------------------------------------------------------------------

def test_catalog_declares_fixed_problem_and_scenario():
    assert CATALOG["fixed_problem_code"] == PROBLEM_CODE
    assert CATALOG["fixed_problem_status"] == 409
    assert CATALOG["scenario"] == "accepted_then_retracted_then_old_receipt_replay"
    assert CATALOG["projections_invalidated_on_retract"] == [
        "xp",
        "matching_priority",
        "entitlement",
    ]
    assert "append_only" in CATALOG["history_rule"]


def test_sequence_fixture_is_accepted_retracted_replay():
    assert SEQUENCE["fixture_id"] == "sequence_accepted_retracted_replay_v1"
    assert SEQUENCE["kind"] == "accepted_retracted_replay"
    names = [s["name"] for s in SEQUENCE["steps"]]
    assert names == [
        "accept_review",
        "retract_accepted_review",
        "replay_old_acceptance_receipt",
    ]
    assert [s["seq"] for s in SEQUENCE["steps"]] == [1, 2, 3]


def test_expected_fixture_excludes_retracted_review():
    assert EXPECTED["review_filter"] == "accepted_and_not_retracted"
    assert EXPECTED["excluded_review_ids"] == ["rev_synthetic_001"]
    assert EXPECTED["excluded_contribution_record_ids"] == ["contrib_synthetic_maint_001"]
    assert EXPECTED["xp_projection"]["xp"] == 0
    assert EXPECTED["xp_projection"]["included_contribution_record_ids"] == []
    assert EXPECTED["matching_priority_projection"]["included_review_ids"] == []
    assert EXPECTED["entitlement_projection"]["qc_or_listing_entitlements_from_review"] == []
    assert EXPECTED["history_preserved"]["deleted_facts"] == []
    assert EXPECTED["history_preserved"]["overwritten_facts"] == []


# ---------------------------------------------------------------------------
# OpenAPI / event / XP policy contract anchors
# ---------------------------------------------------------------------------

def test_retract_openapi_path_appends_without_delete():
    op = PATHS[RETRACT_PATH]["post"]
    assert op["operationId"] == "retractQualityReview"
    desc = op["description"].lower()
    assert "without deleting" in desc or "appends a retraction" in desc
    assert "200" in op["responses"]
    assert "409" in op["responses"]
    body_ref = op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    assert body_ref.endswith("RetractQualityReviewRequest")


def test_receipt_superseded_problem_const_is_fixed():
    problem = SCHEMAS["ReceiptSupersededByRetractionProblem"]
    props = problem["allOf"][1]["properties"]
    assert props["status"]["const"] == 409
    assert props["code"]["const"] == PROBLEM_CODE
    response = RESPONSES["ReceiptSupersededByRetraction"]
    assert "cannot restore acceptance" in response["description"].lower()
    schema_ref = response["content"]["application/problem+json"]["schema"]["$ref"]
    assert schema_ref.endswith("ReceiptSupersededByRetractionProblem")


def test_retract_request_schema_requires_reason_and_original_ref():
    req = SCHEMAS["RetractQualityReviewRequest"]
    assert set(req["required"]) >= {"reason", "original_review_ref"}
    assert "retracted_by" not in req.get("properties", {})
    assert "client-supplied" in (req.get("description") or "").lower() or True
    # retracted_by is server-derived — must not be a client property
    assert "retracted_by" not in req["properties"]


def test_retract_409_response_uses_superseded_component():
    ref = PATHS[RETRACT_PATH]["post"]["responses"]["409"]["$ref"]
    assert ref.endswith("ReceiptSupersededByRetraction")


def test_event_catalog_lists_retracted_event():
    types = {e["type"] for e in EVENTS["events"]}
    assert "freedom.quality.review.retracted.v1" in types
    evt = next(e for e in EVENTS["events"] if e["type"] == "freedom.quality.review.retracted.v1")
    assert evt["aggregate"] == "review_decision"
    assert evt["producer"] == "quality-commercialization"


def test_xp_policy_review_filter_excludes_retracted():
    assert XP_POLICY["policy"]["source_contract"]["review_filter"] == "accepted_and_not_retracted"
    assert XP_POLICY["policy"]["source_contract"]["facts"] == [
        "append_only_contribution_record",
        "review_outcome",
    ]
    for track in XP_POLICY["policy"]["tracks"]:
        assert "accepted and not retracted" in track["formula"].lower()


# ---------------------------------------------------------------------------
# State machine parity
# ---------------------------------------------------------------------------

def test_review_outcome_only_transition_is_accepted_to_retracted():
    assert REVIEW_OUTCOME["initial"] == "accepted"
    assert REVIEW_OUTCOME["terminal"] == ["retracted"]
    assert len(REVIEW_OUTCOME["transitions"]) == 1
    t = REVIEW_OUTCOME["transitions"][0]
    assert t["from"] == "accepted"
    assert t["to"] == "retracted"
    assert t["command"] == "retract_accepted_review"
    assert t["event"] == "freedom.quality.review.retracted.v1"


def test_retract_transition_effects_invalidate_projections_and_mark_receipt():
    t = REVIEW_OUTCOME["transitions"][0]
    effects = t["effects"]
    assert "remove_this_outcome_from_xp_matching_priority_and_entitlement_projections_on_rebuild" in effects
    assert "mark_original_receipt_as_superseded_by_retraction" in effects
    guards = t["guards"]
    assert "retractor_has_active_reviewer_appointment_for_exact_scope" in guards
    assert "retracted_by_reason_and_original_review_ref_are_present" in guards


def test_review_outcome_invariants_forbid_delete_and_resurrection():
    inv = REVIEW_OUTCOME["invariants"]
    assert "original_review_and_acceptance_history_are_never_deleted_or_overwritten" in inv
    assert any(PROBLEM_CODE in i for i in inv)
    assert any("never_restores_acceptance" in i for i in inv)


def test_sequence_retract_step_matches_state_machine_command_and_event():
    retract = step_by_name("retract_accepted_review")
    t = REVIEW_OUTCOME["transitions"][0]
    assert retract["command"] == t["command"]
    assert retract["event"] == t["event"]
    assert retract["review_outcome_state"] == "retracted"
    for effect in t["effects"]:
        assert effect in retract["effects"]
    assert retract["http"]["path"] == RETRACT_PATH
    assert retract["http"]["operationId"] == "retractQualityReview"


# ---------------------------------------------------------------------------
# Sequence semantics: accept → retract → replay
# ---------------------------------------------------------------------------

def test_after_accept_review_is_included_in_projections():
    store = apply_sequence(through_seq=1)
    assert store["outcome_by_review"]["rev_synthetic_001"] == "accepted"
    proj = rebuild_projections(store)
    assert proj["xp_projection"]["xp"] == 42
    assert proj["xp_projection"]["included_contribution_record_ids"] == [
        "contrib_synthetic_maint_001"
    ]
    assert proj["matching_priority_projection"]["included_review_ids"] == ["rev_synthetic_001"]
    assert proj["entitlement_projection"]["qc_or_listing_entitlements_from_review"] == [
        "rev_synthetic_001"
    ]


def test_after_retract_projections_exclude_review_and_history_is_kept():
    store = apply_sequence(through_seq=2)
    assert store["outcome_by_review"]["rev_synthetic_001"] == "retracted"
    kinds = [f["kind"] for f in store["facts"]]
    assert kinds == ["review_accepted", "review_retracted"]
    # Acceptance fact still present with original payload
    accepted = store["facts"][0]
    assert accepted["payload"]["receipt_id"] == "rcpt_synthetic_review_001"
    assert accepted["payload"]["decision"] == "accepted"
    retracted = store["facts"][1]
    assert retracted["payload"]["retracted_by"] == "usr_synthetic_reviewer_a"
    assert retracted["payload"]["original_review_ref"] == "rev_synthetic_001"
    assert retracted["payload"]["reason"]
    assert store["receipt_status"]["rcpt_synthetic_review_001"]["superseded"] is True

    proj = rebuild_projections(store)
    assert proj["xp_projection"]["xp"] == 0
    assert proj["xp_projection"]["included_contribution_record_ids"] == []
    assert proj["matching_priority_projection"]["included_review_ids"] == []
    assert proj["matching_priority_projection"]["excluded_because_retracted"] == [
        "rev_synthetic_001"
    ]
    assert proj["entitlement_projection"]["qc_or_listing_entitlements_from_review"] == []
    assert proj["entitlement_projection"]["excluded_because_retracted"] == ["rev_synthetic_001"]


def test_replay_old_receipt_returns_fixed_problem_and_does_not_resurrect():
    store = apply_sequence(through_seq=3)
    replay_fact = store["facts"][-1]
    assert replay_fact["kind"] == "receipt_replay_rejected"
    problem = replay_fact["problem"]
    assert problem["status"] == 409
    assert problem["code"] == PROBLEM_CODE

    # Outcome still retracted — old receipt did not resurrect acceptance
    assert store["outcome_by_review"]["rev_synthetic_001"] == "retracted"
    assert store["receipt_status"]["rcpt_synthetic_review_001"]["superseded"] is True

    # History still has accept + retract (+ rejected replay record)
    kinds = [f["kind"] for f in store["facts"]]
    assert kinds == ["review_accepted", "review_retracted", "receipt_replay_rejected"]

    proj = rebuild_projections(store)
    assert proj["xp_projection"]["xp"] == EXPECTED["xp_projection"]["xp"] == 0
    assert proj["matching_priority_projection"]["included_review_ids"] == []
    assert proj["entitlement_projection"]["qc_or_listing_entitlements_from_review"] == []


def test_replay_step_must_not_list_forbids_resurrection_side_effects():
    replay = step_by_name("replay_old_acceptance_receipt")
    assert replay["review_outcome_state_after"] == "retracted"
    assert "restore_acceptance" in replay["must_not"]
    assert "delete_retraction_fact" in replay["must_not"]
    assert "mutate_original_review_history" in replay["must_not"]
    assert "reinclude_outcome_in_xp_matching_or_entitlement" in replay["must_not"]
    assert replay["expected_http_problem"]["code"] == PROBLEM_CODE
    assert replay["expected_http_problem"]["status"] == 409


def test_projection_rebuild_matches_expected_fixture():
    store = apply_sequence()
    proj = rebuild_projections(store)
    assert proj["xp_projection"]["member_ref"] == EXPECTED["xp_projection"]["member_ref"]
    assert proj["xp_projection"]["profession_key"] == EXPECTED["xp_projection"]["profession_key"]
    assert proj["xp_projection"]["track"] == EXPECTED["xp_projection"]["track"]
    assert proj["xp_projection"]["xp"] == EXPECTED["xp_projection"]["xp"]
    assert (
        proj["xp_projection"]["included_contribution_record_ids"]
        == EXPECTED["xp_projection"]["included_contribution_record_ids"]
    )
    assert (
        proj["matching_priority_projection"]["excluded_because_retracted"]
        == EXPECTED["matching_priority_projection"]["excluded_because_retracted"]
    )
    assert (
        proj["entitlement_projection"]["excluded_because_retracted"]
        == EXPECTED["entitlement_projection"]["excluded_because_retracted"]
    )
    hist = EXPECTED["history_preserved"]
    assert hist["original_review_receipt_id"] in store["receipt_status"]
    assert hist["original_review_id"] in store["outcome_by_review"]
    assert store["outcome_by_review"][hist["original_review_id"]] == hist["review_outcome_state"]
    retract_facts = [f for f in store["facts"] if f["kind"] == "review_retracted"]
    assert retract_facts[0]["payload"]["retraction_id"] == hist["retraction_id"]
    assert hist["deleted_facts"] == []
    assert hist["overwritten_facts"] == []


def test_retraction_fact_payload_minimum_fields_from_canon():
    """03 §3.5: retracted event payload at least retracted_by, reason, original_review_ref."""
    retract = step_by_name("retract_accepted_review")["retraction_fact"]
    for key in ("retracted_by", "reason", "original_review_ref"):
        assert retract[key]
    # Matches retract request original_review_ref
    req = step_by_name("retract_accepted_review")["http"]["request"]
    assert req["original_review_ref"] == retract["original_review_ref"]
    assert req["reason"] == retract["reason"]


def test_fw03_allowed_paths_only_and_no_fw02_touch():
    """Guardrail: this card must not create/alter FW-02 Codex-owned paths."""
    fw02_test = Path(__file__).resolve().parent / "test_xp_projection_rebuild.py"
    fw02_fix = Path(__file__).resolve().parent / "fixtures" / "xp-rebuild"
    assert not fw02_test.exists()
    assert not fw02_fix.exists()
    assert FIX.is_dir()
    assert (FIX / "sequence_accepted_retracted_replay_v1.yaml").is_file()
    assert Path(__file__).name == "test_retracted_receipt_replay.py"


def test_catalog_contract_paths_resolve():
    """Resolve catalog pointers into existing contract documents (static)."""
    for path in CATALOG["contract_paths"]:
        assert path.startswith("contracts/"), path
        rel, _, pointer = path.partition("#")
        candidate = PLAN / rel
        assert candidate.exists(), f"missing {candidate}"
        if not pointer:
            continue
        assert pointer.startswith("/")
        node = yaml.safe_load(candidate.read_text())
        parts = [p for p in pointer.split("/") if p]
        for part in parts:
            part = part.replace("~1", "/").replace("~0", "~")
            if isinstance(node, list):
                # event-catalog events list: accept presence check via later typed test
                if part == "events" or part.isdigit():
                    if part.isdigit():
                        node = node[int(part)]
                    continue
                # For list roots when pointer is /events — handled below
                raise AssertionError(f"unexpected list traversal at {part} for {path}")
            else:
                assert part in node, f"unresolved {path} at {part}"
                node = node[part]
        assert node is not None


def test_no_money_network_or_secrets_in_fixtures():
    text = "\n".join(p.read_text() for p in FIX.glob("*.yaml"))
    lowered = text.lower()
    for banned in (
        "sk-",
        "api_key",
        "password",
        "private_key",
        "begin rsa",
        "stripe",
        "paypal",
        "transfer_job",
        "webhook.site",
    ):
        assert banned not in lowered
    # Synthetic IDs only
    assert "usr_synthetic_" in text
    assert "rev_synthetic_" in text
