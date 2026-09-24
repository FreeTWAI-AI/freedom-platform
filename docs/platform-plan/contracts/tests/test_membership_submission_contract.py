"""Static contract checks for Guild membership vs submission and membership rank read models.

  - a review submission records source/version/evidence only and never creates or infers
    Guild/ProfessionMembership (00-current-requirements-baseline 2026-09-23: joining a Guild
    is the member's own choice; registering work does not join another Guild)
  - ProfessionMembershipSummary.rank covers runner/strategist/master and follows the
    profession_membership state machine; creation still enters runner
  - the member-onboarding journey and its OpenAPI commands are the follow-up Guild/Agent welcome
    journey after the platform new-member positioning entry (or for existing
    onboarding_required=false accounts); navigation/skippable never waives that entry gate
  - synthetic values only; pytest only; no network/secrets
"""
from __future__ import annotations

from pathlib import Path

import json

import pytest
import yaml
from jsonschema import Draft202012Validator

C = Path(__file__).resolve().parents[1]
API = yaml.safe_load((C / "openapi-outline.yaml").read_text())
CORE = yaml.safe_load((C / "state-machines" / "core.example.yaml").read_text())
ORG = yaml.safe_load((C / "organization-professions.example.yaml").read_text())
ONBOARDING_SCHEMA = json.loads((C / "member-onboarding.schema.json").read_text())
ONBOARDING_EXAMPLE_TEXT = (C / "member-onboarding.example.yaml").read_text()
ONBOARDING_EXAMPLE = yaml.safe_load(ONBOARDING_EXAMPLE_TEXT)
REPO = C.parents[2]

MEMBERSHIP = Draft202012Validator(
    {"$ref": "#/components/schemas/ProfessionMembershipSummary", "components": API["components"]}
)


def summary(state: str, rank: str) -> dict:
    return {
        "membership_id": "mem_synthetic_01",
        "profession_key": "ai_vibe",
        "guild_id": "guild_synthetic_01",
        "rank": rank,
        "state": state,
        "aggregate_version": 3,
        "starter_track_ref": {"id": "starter.ai-vibe", "version": "1", "hash": "sha256:" + "a" * 64},
    }


def machine_states(name: str) -> set[str]:
    machine = CORE["machines"][name]
    states = {machine["initial"], *machine["terminal"]}
    for transition in machine["transitions"]:
        sources = transition["from"] if isinstance(transition["from"], list) else [transition["from"]]
        states.update(sources)
        states.add(transition["to"])
    return states


def test_summary_state_enum_matches_core_machine():
    schema = API["components"]["schemas"]["ProfessionMembershipSummary"]
    assert set(schema["properties"]["state"]["enum"]) == machine_states("profession_membership")
    assert CORE["machines"]["profession_membership"]["initial"] == "runner"


def test_summary_rank_vocabulary_matches_rank_ladder():
    schema = API["components"]["schemas"]["ProfessionMembershipSummary"]
    ladder = [entry["key"] for entry in ORG["rank_ladder"]]
    assert schema["properties"]["rank"]["enum"] == ladder == ["runner", "strategist", "master"]


@pytest.mark.parametrize(
    ("state", "rank"),
    [
        ("runner", "runner"),
        ("strategist_review", "runner"),
        ("strategist", "strategist"),
        ("master_review", "strategist"),
        ("master", "master"),
        ("left", "runner"),
        ("left", "strategist"),
        ("left", "master"),
    ],
)
def test_summary_accepts_state_consistent_rank(state, rank):
    assert not list(MEMBERSHIP.iter_errors(summary(state, rank)))


@pytest.mark.parametrize(
    ("state", "rank"),
    [
        ("runner", "strategist"),
        ("runner", "master"),
        ("strategist_review", "strategist"),
        ("strategist", "runner"),
        ("strategist", "master"),
        ("master_review", "master"),
        ("master", "strategist"),
        ("left", "officer"),
    ],
)
def test_summary_rejects_rank_that_contradicts_state(state, rank):
    assert list(MEMBERSHIP.iter_errors(summary(state, rank)))


def test_creation_constraint_is_documented_separately_from_read_rank():
    schema = API["components"]["schemas"]["ProfessionMembershipSummary"]
    invariants = schema["x-invariants"]
    assert "a_newly_created_or_self_confirmed_membership_has_state_runner_and_rank_runner" in invariants
    assert any("existing_membership" in rule for rule in invariants)


def test_review_submission_never_creates_or_infers_membership():
    operation = API["paths"]["/review-submissions"]["post"]
    text = " ".join(operation["description"].split())
    assert "never creates, changes or infers a Guild or ProfessionMembership" in text
    assert "creates that human's AI Vibe Runner" not in text
    assert "submission_never_creates_changes_or_infers_guild_or_profession_membership" in operation["x-invariants"]

    machine = CORE["machines"]["review_submission"]
    for transition in machine["transitions"]:
        blob = str(transition.get("effects", [])) + str(transition.get("event", ""))
        assert "profession" not in blob and "membership" not in blob


def test_participation_rules_separate_submission_from_guild_join():
    rules = ORG["participation_rules"]
    assert not any("creates_ai_vibe" in rule for rule in rules)
    assert "a_submission_records_source_version_and_evidence_only_and_never_creates_or_infers_guild_or_profession_membership" in rules
    assert "a_submission_never_performs_a_self_service_guild_join_and_a_self_service_join_stays_a_separate_member_selected_and_confirmed_command" in rules
    assert "a_metadata_maintainer_appointment_never_joins_the_appointee_to_an_ai_guild" in rules
    # The rule is scoped to submissions and maintainer appointments; it must not read as a blanket
    # ban on a separately authorized administrator appointment.
    assert not any(rule.startswith("joining_a_guild_requires") for rule in rules)


def test_submission_rule_is_scoped_and_keeps_admin_appointment_separate():
    operation = API["paths"]["/review-submissions"]["post"]
    text = " ".join(operation["description"].split())
    assert "never performs a self-service Guild join" in text
    assert "separately authorized, audited administrator appointment is its own command" in text
    assert not any(rule.startswith("guild_membership_requires") for rule in operation["x-invariants"])
    assert "a_metadata_maintainer_appointment_never_joins_the_appointee_to_an_ai_guild" in operation["x-invariants"]


ENTRY_TERMS = ("onboarding_required=false", "positioning")
ONBOARDING_OPERATIONS = [
    ("/me/onboarding-bundles", "post"),
    ("/me/work-intents", "post"),
    ("/me/onboarding-journeys/current", "get"),
]


def flat(text: str) -> str:
    return " ".join(text.split())


def test_entry_gate_columns_named_by_contracts_exist_in_runtime_migrations():
    migration = (REPO / "migrations" / "005_member_accounts.sql").read_text()
    assert "onboarding_required boolean" in migration
    assert "onboarding_completed_at" in (REPO / "migrations" / "024_member_joined_at.sql").read_text()


@pytest.mark.parametrize(("path", "method"), ONBOARDING_OPERATIONS)
def test_onboarding_operations_are_scoped_to_post_positioning_or_existing_accounts(path, method):
    text = flat(API["paths"][path][method]["description"])
    for term in ENTRY_TERMS:
        assert term in text
    assert "optional positioning" not in text
    assert "without requiring a positioning assessment" not in text
    assert ("shortcut" in text) or ("never waive" in text)


def test_onboarding_bundle_is_not_a_signup_shortcut_and_keeps_navigation_steps():
    operation = API["paths"]["/me/onboarding-bundles"]["post"]
    invariants = operation["x-invariants"]
    assert "never_a_registration_signup_or_positioning_gate_shortcut" in invariants
    assert "welcome_skill_equip_and_installation_steps_stay_navigation_and_never_become_action_gates" in invariants
    assert "The canonical day-one command" not in flat(operation["description"])


def test_bundle_request_positioning_absence_is_explained_by_the_entry_gate():
    text = flat(API["components"]["schemas"]["ConfirmMyOnboardingBundleRequest"]["description"])
    assert text != "Positioning is intentionally absent as a prerequisite; self-declared profession confirmation is equally valid."
    assert "onboarding_required=false" in text and "onboarding_completed_at" in text
    assert "never waives, substitutes or satisfies the new-member positioning gate" in text


def test_member_onboarding_schema_names_the_follow_up_journey_and_entry_gate():
    assert "post-positioning" in ONBOARDING_SCHEMA["title"]
    assert "day-one onboarding" not in ONBOARDING_SCHEMA["title"]
    invariants = " ".join(ONBOARDING_SCHEMA["x-invariants"])
    assert "onboarding_required=false" in invariants
    assert "never a registration, signup or positioning shortcut" in invariants
    assert "never waive, replace or satisfy the new-member positioning gate" in invariants


def test_journey_steps_stay_navigation_in_both_contracts():
    step = ONBOARDING_SCHEMA["$defs"]["journey_step"]["properties"]
    api_step = API["components"]["schemas"]["OnboardingJourneyStep"]["properties"]
    assert step["enforcement"] == {"const": "navigation"}
    assert api_step["enforcement"]["const"] == "navigation"
    assert step["kind"]["enum"] == api_step["kind"]["enum"]
    for journey_step in ONBOARDING_EXAMPLE["journey"]["steps"]:
        assert journey_step["enforcement"] == "navigation"


def test_example_skipped_positioning_is_an_existing_account_not_a_new_member():
    Draft202012Validator(ONBOARDING_SCHEMA).validate(ONBOARDING_EXAMPLE)
    journey = ONBOARDING_EXAMPLE["journey"]
    positioning = [step for step in journey["steps"] if step["kind"] == "positioning"]
    assert len(positioning) == 1
    if positioning[0]["status"]["state"] == "skipped":
        assert "existing_member" in journey["journey_id"]
        assert "post_positioning" in journey["journey_id"]
        header = ONBOARDING_EXAMPLE_TEXT.split("schema_version:", 1)[0]
        assert "onboarding_required=false" in header
        assert "never waives the new-member positioning gate" in header
