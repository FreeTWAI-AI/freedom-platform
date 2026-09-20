"""FW-04: ReviewerAppointment is the sole source of qc.review:<scope> (static only).

Acceptance (first-work-batch FW-04 / RQ-059 / ADR-060 / OD-10 / T08 / T14):
  - exact-scope active appointment positive cases
  - negatives: high XP, rank/Master, familiarity, Agent, expired/revoked, self-review
  - only active exact-scope appointment projects qc.review:<scope>
  - natural-person independence + expiry/revoke boundary clear
  - synthetic IDs only; pytest only; no money/network/secrets
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml

C = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures" / "reviewer-appointments"

API = yaml.safe_load((C / "openapi-outline.yaml").read_text())
SCHEMAS = API["components"]["schemas"]
PATHS = API["paths"]
CORE = yaml.safe_load((C / "state-machines" / "core.example.yaml").read_text())
EVENTS = yaml.safe_load((C / "event-catalog.example.yaml").read_text())
ENTITLEMENTS = yaml.safe_load((C / "entitlement-catalog.example.yaml").read_text())

CATALOG = yaml.safe_load((FIX / "catalog.yaml").read_text())
ACTORS = yaml.safe_load((FIX / "actors.yaml").read_text())
CASES = yaml.safe_load((FIX / "cases.yaml").read_text())
EXPECTED_RULES = yaml.safe_load((FIX / "expected_projection_rules.yaml").read_text())

RA_MACHINE = CORE["machines"]["reviewer_appointment"]
QC_KEY_PREFIX = "qc.review:"
DEFAULT_AS_OF = ACTORS["as_of"]


# ---------------------------------------------------------------------------
# Pure projection helpers (no I/O, no money, no network)
# ---------------------------------------------------------------------------

def parse_dt(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def is_natural_person_ref(ref: str) -> bool:
    return isinstance(ref, str) and ref.startswith("person_")


def is_agent_ref(ref: str) -> bool:
    return isinstance(ref, str) and ref.startswith("agent_")


def entitlement_key_for_scope(scope: str) -> str:
    return f"{QC_KEY_PREFIX}{scope}"


def appointment_is_current(appt: dict, as_of: str) -> bool:
    """Active + as_of strictly before review_by; revoked/expired never current."""
    if appt.get("state") != "active":
        return False
    if appt.get("revoked_at"):
        return False
    return parse_dt(as_of) < parse_dt(appt["review_by"])


def project_qc_review_keys(
    appointments: list[dict],
    *,
    member_ref: str,
    as_of: str,
) -> list[str]:
    """Project qc.review:<scope> keys solely from active exact-scope appointments.

    Non-appointment signals (XP, rank, Master, familiarity, Agent) are ignored by design.
    Agent subjects never project. Scope matching is exact (one key per appointment.scope).
    """
    if is_agent_ref(member_ref) or not is_natural_person_ref(member_ref):
        return []

    keys: list[str] = []
    for appt in appointments:
        if appt.get("subject_member_ref") != member_ref:
            continue
        if appt.get("subject_kind") == "agent" or is_agent_ref(appt.get("subject_member_ref", "")):
            continue
        if not is_natural_person_ref(appt.get("appointer_ref", "")):
            continue
        if not appointment_is_current(appt, as_of):
            continue
        scope = appt["scope"]
        key = entitlement_key_for_scope(scope)
        if key not in keys:
            keys.append(key)
    return sorted(keys)


def evaluate_case(case: dict) -> dict:
    """Evaluate one fixture case into entitlement + independence + denial outcome."""
    as_of = case.get("as_of_override") or CASES["as_of"]
    actor = case["actor_ref"]
    requested = case["requested_scope"]
    author = case["submission_author_ref"]
    appointments = case.get("appointments") or []
    signals = case.get("non_appointment_signals") or {}

    # Agents never hold independently — even if a malformed appointment row exists.
    if signals.get("actor_kind") == "agent" or is_agent_ref(actor):
        return {
            "projects_qc_review": False,
            "entitlement_keys": [],
            "all_keys_for_member": [],
            "independent_of_author": False,
            "self_review_allowed": False,
            "denial_reason": "agent_cannot_hold_reviewer_appointment",
            "appointment_rejected": True,
            "history_ids": [a["appointment_id"] for a in appointments],
        }

    all_keys = project_qc_review_keys(appointments, member_ref=actor, as_of=as_of)
    requested_key = entitlement_key_for_scope(requested)
    has_requested = requested_key in all_keys
    independent = actor != author

    denial = None
    if not has_requested:
        # Classify denial without letting non-appointment signals create authority.
        matching = [a for a in appointments if a.get("scope") == requested and a.get("subject_member_ref") == actor]
        if any(a.get("state") == "revoked" for a in matching):
            denial = "appointment_revoked"
        elif any(
            a.get("state") == "expired" or (a.get("state") == "active" and not appointment_is_current(a, as_of))
            for a in matching
        ):
            denial = "appointment_expired_at_review_by"
        elif any(a.get("state") == "active" and a.get("scope") != requested for a in appointments):
            denial = "no_active_appointment_for_requested_exact_scope"
        else:
            denial = "missing_active_exact_scope_reviewer_appointment"
        # Non-appointment signals must never flip denial to allow.
        assert not any(
            k in signals
            for k in (
                "xp_by_profession_track",
                "profession_rank",
                "guild_master_office",
                "product_familiarity_score",
            )
        ) or denial is not None
    elif not independent:
        denial = "self_review_not_independent_natural_person"

    return {
        "projects_qc_review": has_requested,
        "entitlement_keys": [requested_key] if has_requested else [],
        "all_keys_for_member": all_keys,
        "independent_of_author": independent,
        "self_review_allowed": bool(has_requested and independent),
        "denial_reason": denial,
        "appointment_rejected": False,
        "history_ids": [a["appointment_id"] for a in appointments],
        # Explicitly record that non-appointment signals were ignored.
        "ignored_non_appointment_signals": sorted(signals.keys()),
    }


def case_by_id(case_id: str) -> dict:
    return next(c for c in CASES["cases"] if c["case_id"] == case_id)


def cases_of_kind(kind: str) -> list[dict]:
    return [c for c in CASES["cases"] if c["kind"] == kind]


# ---------------------------------------------------------------------------
# Catalog / fixture shape
# ---------------------------------------------------------------------------

def test_catalog_declares_sole_source_scenario():
    assert CATALOG["scenario"] == "qc_review_sole_source_is_active_exact_scope_appointment"
    assert CATALOG["entitlement_key_template"] == "qc.review:<scope>"
    assert CATALOG["projection_rule"] == "only_active_exact_scope_appointment_projects_qc_review"
    assert CATALOG["expiry_field"] == "review_by"
    assert CATALOG["named_od10_appointers_are_synthetic_ids_only"] is True
    for banned in (
        "xp",
        "profession_rank",
        "master_rank",
        "guild_master_office",
        "product_familiarity",
        "agent_identity",
        "expired_appointment",
        "revoked_appointment",
    ):
        assert banned in CATALOG["non_sources_never_project_qc_review"]


def test_actors_are_synthetic_only():
    assert ACTORS["status"] == "synthetic_planning_fixtures_not_runtime"
    for key, value in ACTORS["actors"].items():
        assert "synthetic" in value, f"{key} must be synthetic: {value}"
        assert not any(tok in value.lower() for tok in ("ted", "hao", "mini", "jason", "weiming", "韋銘"))


def test_cases_cover_required_acceptance_matrix():
    ids = {c["case_id"] for c in CASES["cases"]}
    required = {
        "positive_active_exact_scope",
        "positive_second_scope_isolated",
        "negative_high_xp_no_appointment",
        "negative_rank_master_no_appointment",
        "negative_familiarity_no_appointment",
        "negative_agent_cannot_hold_appointment",
        "negative_expired_appointment",
        "negative_revoked_appointment",
        "negative_mismatched_scope",
        "negative_self_review",
        "boundary_expire_at_exact_review_by",
        "boundary_active_just_before_review_by",
    }
    assert required <= ids
    assert cases_of_kind("positive"), "need positive cases"
    assert cases_of_kind("negative"), "need negative cases"
    assert cases_of_kind("boundary"), "need expiry boundary cases"


def test_expected_rules_match_contract_invariants():
    assert EXPECTED_RULES["rules"]["sole_source"] == "ReviewerAppointment"
    assert EXPECTED_RULES["rules"]["required_appointment_state"] == "active"
    assert EXPECTED_RULES["rules"]["scope_match"] == "exact"
    assert EXPECTED_RULES["rules"]["currency_field"] == "review_by"
    assert EXPECTED_RULES["rules"]["agent_never_holds_independently"] is True
    assert EXPECTED_RULES["rules"]["xp_rank_master_familiarity_never_create_appointment"] is True
    assert EXPECTED_RULES["rules"]["self_review"]["independent_review"] is False
    assert EXPECTED_RULES["rules"]["revoke"]["deletes_history"] is False
    assert EXPECTED_RULES["rules"]["expire"]["guard"] == "server_time_is_at_or_after_review_by"


# ---------------------------------------------------------------------------
# Entitlement catalog + OpenAPI + state machine + events anchors
# ---------------------------------------------------------------------------

def test_entitlement_catalog_qc_review_is_appointment_only():
    defs = {d["key"]: d for d in ENTITLEMENTS["definitions"]}
    qc = defs["qc.review:<scope>"]
    assert qc["acquisition"]["mode"] == "reviewer_appointment_only"
    assert "active_reviewer_appointment_for_exact_scope" in qc["acquisition"]["conditions"]
    assert "reviewer_is_a_different_human_from_the_submission_author" in qc["obligations"]
    assert qc["revocation"]["mode"] == "appointment_expiry_or_manual_scoped"
    inv = ENTITLEMENTS["invariants"]
    assert "qc_review_scope_is_projected_only_from_an_active_exact_scope_reviewer_appointment" in inv
    assert "xp_rank_master_office_and_product_familiarity_never_create_a_reviewer_appointment" in inv
    assert "agent_never_holds_an_entitlement_independently_of_its_principal" in inv


def test_reviewer_appointment_openapi_schemas_and_paths():
    ra = SCHEMAS["ReviewerAppointment"]
    assert set(ra["required"]) >= {
        "appointment_id",
        "appointer_ref",
        "subject_member_ref",
        "scope",
        "granted_at",
        "review_by",
        "reason",
        "state",
        "aggregate_version",
    }
    assert ra["properties"]["state"]["enum"] == ["active", "revoked", "expired"]
    assert "review_by" in ra["properties"]
    assert "expires_at" not in ra["properties"]
    assert "valid_until" not in ra["properties"]
    desc = ra.get("description", "").lower()
    assert "active exact-scope" in desc or "qc.review" in desc
    assert "od-10" in desc

    create = SCHEMAS["CreateReviewerAppointmentRequest"]
    assert set(create["required"]) == {"subject_member_ref", "scope", "review_by", "reason"}
    revoke = SCHEMAS["RevokeReviewerAppointmentRequest"]
    assert set(revoke["required"]) == {"reason"}

    create_path = PATHS["/guilds/{guild_id}/reviewer-appointments"]["post"]
    assert create_path["operationId"] == "createReviewerAppointment"
    create_desc = create_path["description"]
    assert "only source of qc.review" in create_desc
    assert "XP" in create_desc and "rank" in create_desc and "familiarity" in create_desc

    revoke_path = PATHS["/reviewer-appointments/{id}/revoke"]["post"]
    assert revoke_path["operationId"] == "revokeReviewerAppointment"
    assert "without deleting" in revoke_path["description"].lower()

    list_path = PATHS["/me/reviewer-appointments"]["get"]
    assert list_path["operationId"] == "listMyReviewerAppointments"
    assert "only currently active" in list_path["responses"]["200"]["description"]


def test_claim_review_requires_different_human_principal():
    claim = PATHS["/review-submissions/{submissionId}:claim"]["post"]
    assert claim["operationId"] == "claimReviewSubmission"
    desc = claim["description"].lower()
    assert "different human" in desc
    assert "agent" in desc


def test_reviewer_appointment_state_machine_invariants():
    assert RA_MACHINE["initial"] == "active"
    assert set(RA_MACHINE["terminal"]) == {"revoked", "expired"}
    assert RA_MACHINE["emitted_on_create"] == "freedom.quality.reviewer_appointment.granted.v1"
    commands = {t["command"]: t for t in RA_MACHINE["transitions"]}
    revoke = commands["authorized_appointer_revokes_with_reason"]
    assert revoke["to"] == "revoked"
    assert "appointer_is_named_natural_person_holder_of_od_10_guild_officeholders_council" in revoke["guards"]
    expire = commands["expire_at_review_by"]
    assert expire["to"] == "expired"
    assert "server_time_is_at_or_after_review_by" in expire["guards"]
    inv = RA_MACHINE["invariants"]
    assert "only_an_active_exact_scope_appointment_projects_qc_review_entitlement" in inv
    assert "xp_rank_master_office_and_product_familiarity_never_create_an_appointment" in inv
    assert "appointer_ref_is_a_named_natural_person_holder_in_the_OD_10_guild_officeholders_council_not_an_agent_or_council_aggregate" in inv
    assert "renewal_creates_a_new_traceable_appointment_and_never_rewrites_the_prior_record" in inv


def test_reviewer_appointment_events_are_catalogued():
    types = {e["type"] for e in EVENTS["events"]}
    assert "freedom.quality.reviewer_appointment.granted.v1" in types
    assert "freedom.quality.reviewer_appointment.revoked.v1" in types
    assert "freedom.quality.reviewer_appointment.expired.v1" in types
    for e in EVENTS["events"]:
        if e["type"].startswith("freedom.quality.reviewer_appointment."):
            assert e["aggregate"] == "reviewer_appointment"
            assert e["producer"] == "quality-commercialization"


def test_quality_submission_independence_invariant():
    inv = CORE["machines"]["review_submission"]["invariants"]
    assert "same_person_using_another_role_or_agent_is_not_independent_review" in inv


# ---------------------------------------------------------------------------
# Projection evaluation — positives
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("case_id", [c["case_id"] for c in cases_of_kind("positive")])
def test_positive_exact_scope_active_projects_qc_review(case_id: str):
    case = case_by_id(case_id)
    result = evaluate_case(case)
    expect = case["expect"]
    assert result["projects_qc_review"] is True
    assert result["entitlement_keys"] == expect["entitlement_keys"]
    assert result["independent_of_author"] is True
    assert result["self_review_allowed"] is True
    assert result["denial_reason"] is None
    if "all_active_keys_for_member" in expect:
        assert result["all_keys_for_member"] == sorted(expect["all_active_keys_for_member"])


def test_positive_does_not_leak_unrelated_scope():
    case = case_by_id("positive_active_exact_scope")
    result = evaluate_case(case)
    assert result["entitlement_keys"] == ["qc.review:protocol.product.field-review.v1"]
    assert "qc.review:protocol.product.other-skill.v1" not in result["all_keys_for_member"]


# ---------------------------------------------------------------------------
# Projection evaluation — negatives (XP / rank / familiarity / agent / expiry / revoke / scope / self)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "case_id",
    [
        "negative_high_xp_no_appointment",
        "negative_rank_master_no_appointment",
        "negative_familiarity_no_appointment",
    ],
)
def test_negative_non_appointment_signals_never_project(case_id: str):
    case = case_by_id(case_id)
    result = evaluate_case(case)
    expect = case["expect"]
    assert result["projects_qc_review"] is False
    assert result["entitlement_keys"] == []
    assert result["denial_reason"] == expect["denial_reason"]
    # Signals present in fixture must be ignored by projector.
    assert result["ignored_non_appointment_signals"]
    assert case["non_appointment_signals"]


def test_negative_agent_cannot_hold_appointment_or_entitlement():
    case = case_by_id("negative_agent_cannot_hold_appointment")
    result = evaluate_case(case)
    assert result["projects_qc_review"] is False
    assert result["entitlement_keys"] == []
    assert result["denial_reason"] == "agent_cannot_hold_reviewer_appointment"
    assert result["appointment_rejected"] is True
    # Even the malformed appointment row must not project.
    assert project_qc_review_keys(
        case["appointments"],
        member_ref=case["actor_ref"],
        as_of=CASES["as_of"],
    ) == []


def test_negative_expired_appointment_clears_projection():
    case = case_by_id("negative_expired_appointment")
    result = evaluate_case(case)
    assert result["projects_qc_review"] is False
    assert result["denial_reason"] == "appointment_expired_at_review_by"
    assert result["history_ids"] == ["ra_synthetic_expired_001"]


def test_negative_revoked_appointment_clears_future_keeps_history():
    case = case_by_id("negative_revoked_appointment")
    result = evaluate_case(case)
    assert result["projects_qc_review"] is False
    assert result["denial_reason"] == "appointment_revoked"
    assert result["history_ids"] == ["ra_synthetic_revoked_001"]
    # History row still present in fixture (append-only / no delete).
    appt = case["appointments"][0]
    assert appt["state"] == "revoked"
    assert appt["revoked_at"] == "2026-09-15T12:00:00Z"
    assert appt["review_by"] == "2026-12-31T00:00:00Z"


def test_negative_mismatched_scope_does_not_project_requested():
    case = case_by_id("negative_mismatched_scope")
    result = evaluate_case(case)
    assert result["projects_qc_review"] is False
    assert result["entitlement_keys"] == []
    assert result["denial_reason"] == "no_active_appointment_for_requested_exact_scope"
    assert result["all_keys_for_member"] == case["expect"]["other_scope_keys"]


def test_negative_self_review_blocks_independence_even_with_appointment():
    case = case_by_id("negative_self_review")
    result = evaluate_case(case)
    # Entitlement key may exist for the member, but self-review is not independent.
    assert result["projects_qc_review"] is True
    assert result["entitlement_keys"] == ["qc.review:protocol.product.field-review.v1"]
    assert result["independent_of_author"] is False
    assert result["self_review_allowed"] is False
    assert result["denial_reason"] == "self_review_not_independent_natural_person"


# ---------------------------------------------------------------------------
# Expiry / revoke boundary
# ---------------------------------------------------------------------------

def test_boundary_at_exact_review_by_is_expired():
    case = case_by_id("boundary_expire_at_exact_review_by")
    result = evaluate_case(case)
    assert parse_dt(case["as_of_override"]) == parse_dt(case["appointments"][0]["review_by"])
    assert result["projects_qc_review"] is False
    assert result["denial_reason"] == "appointment_expired_at_review_by"


def test_boundary_just_before_review_by_still_active():
    case = case_by_id("boundary_active_just_before_review_by")
    result = evaluate_case(case)
    assert parse_dt(case["as_of_override"]) < parse_dt(case["appointments"][0]["review_by"])
    assert result["projects_qc_review"] is True
    assert result["entitlement_keys"] == ["qc.review:protocol.product.field-review.v1"]
    assert result["denial_reason"] is None


def test_currency_predicate_is_strictly_before_review_by():
    assert EXPECTED_RULES["rules"]["currency_predicate"] == "as_of_strictly_before_review_by"
    review_by = "2026-12-31T00:00:00Z"
    appt = {
        "appointment_id": "ra_synthetic_currency_check",
        "appointer_ref": ACTORS["actors"]["od10_appointer_ref"],
        "subject_member_ref": ACTORS["actors"]["subject_reviewer_ref"],
        "scope": ACTORS["scope_exact"],
        "granted_at": "2026-09-01T00:00:00Z",
        "review_by": review_by,
        "reason": "currency check",
        "state": "active",
        "aggregate_version": 1,
    }
    member = ACTORS["actors"]["subject_reviewer_ref"]
    assert project_qc_review_keys([appt], member_ref=member, as_of="2026-12-30T23:59:59Z") == [
        entitlement_key_for_scope(ACTORS["scope_exact"])
    ]
    assert project_qc_review_keys([appt], member_ref=member, as_of=review_by) == []
    assert project_qc_review_keys([appt], member_ref=member, as_of="2027-01-01T00:00:00Z") == []


# ---------------------------------------------------------------------------
# Cross-cutting: non-sources cannot be smuggled into projection API
# ---------------------------------------------------------------------------

def test_projector_ignores_xp_rank_familiarity_kwargs_surface():
    """Projection function accepts only appointments — no XP/rank/familiarity parameters."""
    import inspect

    sig = inspect.signature(project_qc_review_keys)
    params = set(sig.parameters)
    assert params == {"appointments", "member_ref", "as_of"}
    for banned in ("xp", "rank", "master", "familiarity", "office", "agent"):
        assert banned not in params


def test_all_fixture_ids_are_synthetic():
    blob = (FIX / "cases.yaml").read_text() + (FIX / "actors.yaml").read_text()
    assert "synthetic" in blob
    # No credential / money / network markers in fixtures (word "secrets" in prose is ok).
    import re
    assert re.search(r"api[_-]?key\s*=", blob, re.I) is None
    assert re.search(r"password\s*=", blob, re.I) is None
    assert "private_key" not in blob.lower()
    assert "-----BEGIN" not in blob
    assert "paypal" not in blob.lower() and "stripe" not in blob.lower()
    assert "https://" not in blob and "http://" not in blob


def test_fw04_allowed_paths_only_in_this_card():
    batch = (C.parent / "execution" / "first-work-batch.md").read_text()
    section = batch.split("## FW-04", 1)[1].split("## FW-05", 1)[0]
    assert "test_reviewer_appointment_entitlement.py" in section
    assert "fixtures/reviewer-appointments/" in section
