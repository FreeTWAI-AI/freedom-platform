"""FW-05: settlement execution mode and platform condition parity (static only).

Acceptance (first-work-batch FW-05 / RQ-062 / ADR-063 / OD-28 / T21):
  - schema / example / state-machine parity for modes and defaults
  - default record_only; money_movement_enabled false at launch
  - money_movement_enabled=false OR invalid mandate => zero executable TransferJob
  - authorized_mandate requires platform flag + active exact mandate (+ dual A4)
  - stable_provider_operation_key survives retry / reconcile
  - provider is a pure fake object (accept / confirm / unknown); no network, money, sandbox
  - pytest only; no secrets
"""

from __future__ import annotations

import hashlib
import importlib.util
import sys
from copy import deepcopy
from pathlib import Path

import pytest
import yaml

CONTRACTS = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures" / "settlement-modes"

API = yaml.safe_load((CONTRACTS / "openapi-outline.yaml").read_text())
SCHEMAS = API["components"]["schemas"]
COMMERCE = yaml.safe_load((CONTRACTS / "commerce-distribution.example.yaml").read_text())
CORE = yaml.safe_load((CONTRACTS / "state-machines" / "core.example.yaml").read_text())
POLICY = yaml.safe_load((CONTRACTS / "operating-policy.example.yaml").read_text())

CATALOG = yaml.safe_load((FIX / "catalog.yaml").read_text())
CASES = yaml.safe_load((FIX / "cases.yaml").read_text())["cases"]

SI_MACHINE = CORE["machines"]["settlement_instruction"]
MODES = tuple(SCHEMAS["SettlementMandate"]["properties"]["settlement_execution_mode"]["enum"])
RECORD_ONLY, AUTHORIZED = MODES
AMOUNT_FIELD = next(iter(SCHEMAS["PositiveMoney"]["properties"]))
SUPPLIER_ACTION = SCHEMAS["SettlementMandateBound"]["properties"]["payout_action_types"]["items"]["enum"][0]
FORBIDDEN_DISPLAY = set(CATALOG["forbidden_record_only_display_statuses"])
EVAL_ONLY = {"payer_member_a4_on_exact_digest", "ted_payment_a4_on_exact_digest"}


def _load_fake():
    path = FIX / "fake_provider.py"
    spec = importlib.util.spec_from_file_location("fw05_fake_provider", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


FAKE = _load_fake()
FakeSettlementProvider = FAKE.FakeSettlementProvider
ALLOWED_RESPONSES = FAKE.ALLOWED_RESPONSES


def case_by_id(case_id: str) -> dict:
    return next(c for c in CASES if c["case_id"] == case_id)


def strip_eval_only(mandate: dict) -> dict:
    return {k: deepcopy(v) for k, v in mandate.items() if k not in EVAL_ONLY}


def find_exact_bound(mandate: dict | None, instruction: dict) -> dict | None:
    if not mandate or mandate.get("state") != "active":
        return None
    amount = instruction["amount"]
    for bound in mandate.get("bounds") or []:
        if bound.get("beneficiary_party_ref") != instruction.get("beneficiary_party_ref"):
            continue
        if bound.get("currency") != amount.get("currency"):
            continue
        if bound.get("payout_destination_ref") != instruction.get("payout_destination_ref"):
            continue
        if SUPPLIER_ACTION not in (bound.get("payout_action_types") or []):
            continue
        if int(amount[AMOUNT_FIELD]) > int(bound["per_transfer_cap"]):
            continue
        return bound
    return None


def has_dual_a4(mandate: dict | None) -> bool:
    if not mandate:
        return False
    return bool(mandate.get("payer_member_a4_on_exact_digest")) and bool(
        mandate.get("ted_payment_a4_on_exact_digest")
    )


def stable_provider_operation_key(instruction: dict, mandate: dict, bound: dict) -> str:
    material = "|".join(
        [
            instruction["instruction_id"],
            mandate["mandate_id"],
            bound["bound_id"],
            instruction["amount"]["currency"],
            instruction["amount"][AMOUNT_FIELD],
            instruction["idempotency_key"],
        ]
    )
    return "xfer_op_" + hashlib.sha256(material.encode()).hexdigest()


def evaluate_enqueue(case: dict) -> dict:
    enabled = bool(case["platform"]["money_movement_enabled"])
    seller_mode = case["seller_settlement_execution_mode"]
    mandate = case.get("mandate")
    instruction = case["instruction"]

    if (not enabled) or seller_mode != AUTHORIZED:
        return {
            "effective_mode": RECORD_ONLY,
            "display_status": "recorded",
            "executable_transfer_jobs": [],
            "denial_reason": (
                "platform_money_movement_disabled"
                if (not enabled and seller_mode == AUTHORIZED)
                else "platform_money_movement_disabled_or_record_only_mode"
            ),
        }

    if not mandate or mandate.get("state") != "active":
        return {
            "effective_mode": RECORD_ONLY,
            "display_status": "recorded",
            "executable_transfer_jobs": [],
            "denial_reason": "mandate_not_active",
        }

    if mandate.get("settlement_execution_mode") != AUTHORIZED:
        return {
            "effective_mode": RECORD_ONLY,
            "display_status": "recorded",
            "executable_transfer_jobs": [],
            "denial_reason": "platform_money_movement_disabled_or_record_only_mode",
        }

    if not has_dual_a4(mandate):
        return {
            "effective_mode": RECORD_ONLY,
            "display_status": "recorded",
            "executable_transfer_jobs": [],
            "denial_reason": "missing_dual_a4_on_exact_mandate_digest",
        }

    bound = find_exact_bound(mandate, instruction)
    if bound is None:
        return {
            "effective_mode": RECORD_ONLY,
            "display_status": "recorded",
            "executable_transfer_jobs": [],
            "denial_reason": "no_exact_active_mandate_bound",
        }

    key = stable_provider_operation_key(instruction, mandate, bound)
    job = {field: None for field in COMMERCE["transfer_job"]["required"]}
    job.update(
        {
            "transfer_job_id": f"tj_{instruction['instruction_id']}",
            "instruction_ref": instruction["instruction_id"],
            "action_intent_ref": instruction["action_intent_ref"],
            "stable_provider_operation_key": key,
            "lease_id": f"lease_{instruction['instruction_id']}",
            "fencing_token": 1,
            "state": "queued",
        }
    )
    return {
        "effective_mode": AUTHORIZED,
        "display_status": None,
        "executable_transfer_jobs": [job],
        "denial_reason": None,
        "matched_bound_id": bound["bound_id"],
    }


def project_record_only(outcome: dict) -> dict | None:
    if outcome["effective_mode"] != RECORD_ONLY:
        return None
    status = outcome["display_status"]
    assert status == "recorded"
    assert status not in FORBIDDEN_DISPLAY
    return {"display_status": status, "paid_by_platform": False, "settled_by_platform": False}


def commerce_branch() -> dict:
    for step in COMMERCE["money_flow"]["launch_sequence"]:
        if isinstance(step, dict) and "branch_by_settlement_execution_mode" in step:
            return step["branch_by_settlement_execution_mode"]
    raise AssertionError("missing branch_by_settlement_execution_mode")


# --- catalog / fixtures ---

def test_catalog_declares_fw05_scope():
    assert CATALOG["scenario"] == "settlement_execution_mode_and_platform_condition_parity"
    assert CATALOG["modes"] == list(MODES)
    assert CATALOG["platform_default"]["money_movement_enabled"] is False
    assert CATALOG["seller_default"]["settlement_execution_mode"] == RECORD_ONLY
    assert CATALOG["record_only_display_status"] == "recorded"
    assert CATALOG["fake_provider"]["network"] is False
    assert CATALOG["fake_provider"]["real_money"] is False
    assert CATALOG["fake_provider"]["provider_sandbox"] is False
    assert set(CATALOG["fake_provider"]["responses"]) == set(ALLOWED_RESPONSES)
    assert CATALOG["no_secrets"] is True
    assert CATALOG["no_runtime_claim"] is True


def test_cases_cover_required_acceptance_matrix():
    ids = {c["case_id"] for c in CASES}
    required = {
        "default_record_only_platform_disabled",
        "record_only_with_active_mandate_but_flag_false",
        "authorized_flag_true_but_mandate_revoked",
        "authorized_flag_true_but_mandate_expired",
        "authorized_flag_true_but_mandate_superseded",
        "authorized_flag_true_but_no_exact_bound",
        "authorized_missing_ted_payment_a4",
        "authorized_missing_payer_member_a4",
        "seller_still_record_only_despite_flag_and_mandate_row",
        "authorized_happy_path_creates_one_transfer_job",
        "stable_operation_key_retry_after_unknown",
    }
    assert required <= ids
    assert any(c["kind"] == "positive" for c in CASES)
    assert any(c["kind"] == "negative" for c in CASES)
    assert any(c["kind"] == "retry" for c in CASES)
    assert any(c["kind"] == "default" for c in CASES)


def test_fixtures_contain_no_secrets_or_live_endpoints():
    text = (FIX / "cases.yaml").read_text() + (FIX / "catalog.yaml").read_text()
    for token in ("sk_live", "sk_test", "BEGIN PRIVATE KEY", "password=", "api_key=", "Bearer "):
        assert token not in text
    assert "https://" not in text and "http://" not in text


# --- schema / example / state parity ---

def test_openapi_mode_and_flag_defaults():
    mode = SCHEMAS["SettlementMandate"]["properties"]["settlement_execution_mode"]
    assert mode["enum"] == list(MODES)
    assert mode["default"] == RECORD_ONLY
    assert mode.get("readOnly") is True
    flag = SCHEMAS["PartyCommerceReadiness"]["properties"]["money_movement_enabled"]
    assert flag["type"] == "boolean"
    assert flag["default"] is False
    assert flag.get("readOnly") is True
    assert "money_movement_enabled" in SCHEMAS["PartyCommerceReadiness"]["required"]
    assert "settlement_execution_mode" in SCHEMAS["SettlementMandate"]["required"]


def test_operating_policy_defaults_match_openapi():
    money = POLICY["money"]
    assert money["money_movement_enabled"] is False
    assert money["default_execution_mode"] == RECORD_ONLY


def test_commerce_example_branch_parity():
    branch = commerce_branch()
    assert set(branch) == set(MODES)
    assert branch[RECORD_ONLY]["settlement_execution_mode"] == RECORD_ONLY
    assert "recorded" in branch[RECORD_ONLY]["steps"][0]
    auth = branch[AUTHORIZED]
    assert auth["settlement_execution_mode"] == AUTHORIZED
    assert set(auth["requires"]) == {
        "money_movement_enabled_is_true",
        "active_exact_settlement_mandate",
    }


def test_state_machine_enqueue_guard_and_effect_parity():
    enq = next(t for t in SI_MACHINE["transitions"] if t["command"] == "enqueue_transfer")
    assert enq["from"] == "ready"
    assert enq["to"] == "executing"
    assert enq["effects"] == ["create_transfer_job"]
    assert any("money_movement_enabled" in g and AUTHORIZED in g for g in enq["guards"])
    assert any("mandate" in g and "active" in g for g in enq["guards"])
    reconcile = next(
        t for t in SI_MACHINE["transitions"] if t["command"] == "reconcile_safe_to_retry"
    )
    assert any("stable_provider_operation_key" in g for g in reconcile["guards"])
    assert reconcile["to"] == "ready"


def test_manual_settlement_projection_parity():
    proj = CORE["projections"]["manual_settlement_detail"]
    assert proj["display_status"] == "recorded"
    assert "paid" in proj["invariant"] and "never" in proj["invariant"]


def test_transfer_job_contract_requires_stable_operation_key():
    tj = COMMERCE["transfer_job"]
    assert "stable_provider_operation_key" in tj["required"]
    assert any("retry" in r and "operation_key" in r for r in tj["rules"])


def test_active_mandate_fixture_has_openapi_required_fields():
    mandate = strip_eval_only(
        case_by_id("authorized_happy_path_creates_one_transfer_job")["mandate"]
    )
    for field in SCHEMAS["SettlementMandate"]["required"]:
        assert field in mandate
    assert mandate["settlement_execution_mode"] in MODES
    assert mandate["state"] in SCHEMAS["SettlementMandate"]["properties"]["state"]["enum"]
    for bound in mandate["bounds"]:
        for field in SCHEMAS["SettlementMandateBound"]["required"]:
            assert field in bound
        assert SUPPLIER_ACTION in bound["payout_action_types"]


def test_party_commerce_readiness_default_shape():
    readiness = {
        "party_ref": "party_synthetic_seller_001",
        "seller_collection": "ready",
        "payer_disbursement": "ready",
        "beneficiary_payout_destination": "ready",
        "money_movement_enabled": False,
        "active_mandates_as_payer": 0,
        "sellable_listing_count": 0,
        "needs_attention": [],
    }
    for field in SCHEMAS["PartyCommerceReadiness"]["required"]:
        assert field in readiness
    assert readiness["money_movement_enabled"] is False


# --- case evaluation ---

@pytest.mark.parametrize("case", CASES, ids=lambda c: c["case_id"])
def test_case_outcomes(case: dict):
    outcome = evaluate_enqueue(case)
    expect = case["expect"]
    assert outcome["effective_mode"] == expect["effective_mode"]
    assert len(outcome["executable_transfer_jobs"]) == expect["executable_transfer_jobs"]
    assert outcome["denial_reason"] == expect.get("denial_reason")
    if expect.get("display_status") is not None:
        assert outcome["display_status"] == expect["display_status"]
        detail = project_record_only(outcome)
        assert detail is not None
        assert detail["display_status"] == "recorded"
        assert detail["paid_by_platform"] is False
        assert detail["settled_by_platform"] is False
    elif expect["effective_mode"] == AUTHORIZED:
        assert outcome["display_status"] is None
        assert project_record_only(outcome) is None


def test_default_is_record_only_with_zero_jobs():
    outcome = evaluate_enqueue(case_by_id("default_record_only_platform_disabled"))
    assert outcome["effective_mode"] == RECORD_ONLY
    assert outcome["executable_transfer_jobs"] == []
    assert outcome["display_status"] == "recorded"


def test_flag_false_or_invalid_mandate_yields_zero_executable_jobs():
    zero_ids = [
        "record_only_with_active_mandate_but_flag_false",
        "authorized_flag_true_but_mandate_revoked",
        "authorized_flag_true_but_mandate_expired",
        "authorized_flag_true_but_mandate_superseded",
        "authorized_flag_true_but_no_exact_bound",
        "authorized_missing_ted_payment_a4",
        "authorized_missing_payer_member_a4",
        "seller_still_record_only_despite_flag_and_mandate_row",
    ]
    for case_id in zero_ids:
        outcome = evaluate_enqueue(case_by_id(case_id))
        assert outcome["executable_transfer_jobs"] == [], case_id
        assert outcome["effective_mode"] == RECORD_ONLY, case_id


def test_authorized_branch_requires_flag_and_active_exact_mandate():
    happy = evaluate_enqueue(case_by_id("authorized_happy_path_creates_one_transfer_job"))
    assert happy["effective_mode"] == AUTHORIZED
    assert len(happy["executable_transfer_jobs"]) == 1
    job = happy["executable_transfer_jobs"][0]
    for field in COMMERCE["transfer_job"]["required"]:
        assert field in job and job[field] is not None

    flipped = deepcopy(case_by_id("authorized_happy_path_creates_one_transfer_job"))
    flipped["platform"]["money_movement_enabled"] = False
    assert evaluate_enqueue(flipped)["executable_transfer_jobs"] == []

    flipped = deepcopy(case_by_id("authorized_happy_path_creates_one_transfer_job"))
    flipped["mandate"]["state"] = "revoked"
    assert evaluate_enqueue(flipped)["executable_transfer_jobs"] == []


# --- stable key + fake provider ---

def test_operation_key_stable_across_retry_and_fake_provider_flow():
    case = case_by_id("stable_operation_key_retry_after_unknown")
    outcome = evaluate_enqueue(case)
    key = outcome["executable_transfer_jobs"][0]["stable_provider_operation_key"]
    assert evaluate_enqueue(case)["executable_transfer_jobs"][0]["stable_provider_operation_key"] == key

    provider = FakeSettlementProvider(scripted=list(case["fake_provider_script"]))
    payload = {
        AMOUNT_FIELD: case["instruction"]["amount"][AMOUNT_FIELD],
        "currency": case["instruction"]["amount"]["currency"],
        "instruction_ref": case["instruction"]["instruction_id"],
    }
    assert provider.submit_transfer(operation_key=key, payload=payload) == "unknown"
    assert provider.query_transfer(operation_key=key) == "accept"
    assert provider.submit_transfer(operation_key=key, payload=payload) == "confirm"
    assert [c["operation_key"] for c in provider.calls] == [key, key, key]
    assert [c["response"] for c in provider.calls] == case["expect"]["fake_provider_responses_seen"]
    assert case["expect"]["operation_key_stable_across_retry"] is True


def test_fake_provider_rejects_bad_responses_and_empty_keys():
    provider = FakeSettlementProvider(scripted=["accept"])
    with pytest.raises(ValueError):
        provider.submit_transfer(operation_key="", payload={})
    provider.scripted = ["wire_transfer"]  # type: ignore[list-item]
    provider._cursor = 0
    with pytest.raises(ValueError):
        provider.submit_transfer(operation_key="xfer_op_x", payload={})


def test_fake_provider_module_lives_in_fixtures_and_has_no_network_imports():
    source = (FIX / "fake_provider.py").read_text()
    for banned in ("requests", "httpx", "urllib", "socket", "aiohttp", "stripe", "paypal"):
        assert banned not in source
    assert "accept" in source and "confirm" in source and "unknown" in source


def test_enqueue_guard_string_matches_evaluation_inputs():
    enq = next(t for t in SI_MACHINE["transitions"] if t["command"] == "enqueue_transfer")
    joined = " ".join(enq["guards"])
    assert "money_movement_enabled" in joined
    assert AUTHORIZED in joined
    assert "active" in joined and "mandate" in joined
