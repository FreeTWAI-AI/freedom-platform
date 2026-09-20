"""FW-02 deterministic XP projection rebuild golden contract.

The repository has no XP runtime yet.  This small, fixture-driven reference
rebuild locks the policy semantics and golden bytes without claiming to test a
server implementation.
"""

from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator, FormatChecker


CONTRACTS = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures" / "xp-rebuild"
POLICY_DOCUMENT = yaml.safe_load((CONTRACTS / "xp-policy.example.yaml").read_text())
POLICY_SCHEMA = json.loads((CONTRACTS / "xp-policy.schema.json").read_text())
SOURCE = json.loads((FIXTURES / "ordered-source-records.json").read_text())
EXPECTED = json.loads((FIXTURES / "expected-projection.json").read_text())

TRACKS = ("training", "maintenance", "real_delivery")
FORBIDDEN_AUTHORIZATION_INPUTS = (
    "entitlement_snapshot",
    "rank_decision",
    "reviewer_appointment",
    "a4_signature",
)


def canonical_bytes(value):
    """Return the byte representation whose digest is the golden contract."""
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def rebuild(policy, source):
    """Reference projection over ordered append-only facts.

    Contribution records are authoritative facts.  Review outcomes are folded
    in event order, and a contribution is counted once only when its current
    outcome is accepted.  Contribution kind-to-track mapping comes solely from
    the selected policy version.
    """
    events = source["events"]
    sequences = [event["event_seq"] for event in events]
    if sequences != sorted(sequences) or len(sequences) != len(set(sequences)):
        raise ValueError("source events must have unique ascending event_seq values")

    rules = policy["tracks"]
    if tuple(rule["track"] for rule in rules) != TRACKS:
        raise ValueError("policy tracks must use the canonical deterministic order")

    kind_to_track = {}
    for rule in rules:
        for kind in rule["eligible_contribution_kinds"]:
            if kind in kind_to_track:
                raise ValueError(f"contribution kind appears in two tracks: {kind}")
            kind_to_track[kind] = rule["track"]

    contributions = {}
    current_outcomes = {}
    for event in events:
        record_id = event["canonical_contribution_record_id"]
        if event["fact_type"] == "contribution_record":
            if record_id in contributions:
                raise ValueError(f"duplicate contribution record: {record_id}")
            if not isinstance(event["declared_xp"], int) or event["declared_xp"] < 0:
                raise ValueError("declared_xp must be a non-negative integer")
            contributions[record_id] = event
        elif event["fact_type"] == "review_outcome":
            if record_id not in contributions:
                raise ValueError(f"review precedes contribution record: {record_id}")
            if event["outcome"] not in {"accepted", "retracted"}:
                raise ValueError(f"unsupported review outcome: {event['outcome']}")
            if current_outcomes.get(record_id) == "retracted":
                raise ValueError(f"retracted outcome is terminal: {record_id}")
            current_outcomes[record_id] = event["outcome"]
        else:
            raise ValueError(f"unsupported fact type: {event['fact_type']}")

    profession = policy["profession_key"]
    members = sorted(
        {
            event["member_ref"]
            for event in contributions.values()
            if event["profession_key"] == profession
        }
    )
    totals = {
        (member, track): 0
        for member in members
        for track in TRACKS
    }
    for record_id, contribution in contributions.items():
        if contribution["profession_key"] != profession:
            continue
        if current_outcomes.get(record_id) != "accepted":
            continue
        track = kind_to_track.get(contribution["contribution_kind"])
        if track is not None:
            totals[(contribution["member_ref"], track)] += contribution["declared_xp"]

    rebuilt_from_event_seq = max(sequences, default=0)
    return [
        {
            "member_ref": member,
            "profession_key": profession,
            "track": track,
            "xp": totals[(member, track)],
            "policy_version": policy["policy_version"],
            "rebuilt_from_event_seq": rebuilt_from_event_seq,
            "rebuilt_at": source["rebuilt_at"],
        }
        for member in members
        for track in TRACKS
    ]


def test_policy_example_validates_and_declares_exact_three_tracks():
    Draft202012Validator(
        POLICY_SCHEMA, format_checker=FormatChecker()
    ).validate(POLICY_DOCUMENT)
    policy = POLICY_DOCUMENT["policy"]
    assert tuple(rule["track"] for rule in policy["tracks"]) == TRACKS
    assert policy["source_contract"] == {
        "facts": ["append_only_contribution_record", "review_outcome"],
        "review_filter": "accepted_and_not_retracted",
    }


def test_rebuild_matches_three_track_golden_and_projection_schema():
    projection = rebuild(POLICY_DOCUMENT["policy"], SOURCE)
    assert canonical_bytes(projection) == canonical_bytes(EXPECTED)
    assert {row["track"]: row["xp"] for row in projection} == {
        "training": 25,
        "maintenance": 27,
        "real_delivery": 75,
    }

    row_schema = {
        "$schema": POLICY_SCHEMA["$schema"],
        "$defs": POLICY_SCHEMA["$defs"],
        "$ref": "#/$defs/MemberProfessionXpProjection",
    }
    validator = Draft202012Validator(row_schema, format_checker=FormatChecker())
    for row in projection:
        validator.validate(row)


def test_retracted_outcome_is_excluded_without_deleting_history():
    record_id = "contrib_retracted_training"
    assert [
        event["outcome"]
        for event in SOURCE["events"]
        if event["fact_type"] == "review_outcome"
        and event["canonical_contribution_record_id"] == record_id
    ] == ["accepted", "retracted"]

    without_retraction = deepcopy(SOURCE)
    without_retraction["events"] = [
        event
        for event in without_retraction["events"]
        if not (
            event["fact_type"] == "review_outcome"
            and event["canonical_contribution_record_id"] == record_id
            and event["outcome"] == "retracted"
        )
    ]
    with_retraction = rebuild(POLICY_DOCUMENT["policy"], SOURCE)
    before_retraction = rebuild(POLICY_DOCUMENT["policy"], without_retraction)
    xp = lambda rows, track: next(row["xp"] for row in rows if row["track"] == track)
    assert xp(with_retraction, "training") == 25
    assert xp(before_retraction, "training") == 124


def test_same_policy_and_ordered_source_rebuild_to_identical_bytes_and_digest():
    first = canonical_bytes(rebuild(POLICY_DOCUMENT["policy"], SOURCE))
    second = canonical_bytes(rebuild(POLICY_DOCUMENT["policy"], SOURCE))
    golden = canonical_bytes(EXPECTED)
    assert first == second == golden
    assert hashlib.sha256(first).hexdigest() == hashlib.sha256(second).hexdigest()


def test_xp_is_forbidden_as_entitlement_rank_appointment_or_a4_input():
    rebuild_contract = POLICY_DOCUMENT["policy"]["rebuild_contract"]
    assert rebuild_contract["authorization_input_forbidden"] == list(
        FORBIDDEN_AUTHORIZATION_INPUTS
    )
    schema_const = POLICY_SCHEMA["$defs"]["XpPolicyVersion"]["properties"][
        "rebuild_contract"
    ]["properties"]["authorization_input_forbidden"]["const"]
    assert schema_const == list(FORBIDDEN_AUTHORIZATION_INPUTS)

    projection_properties = set(
        POLICY_SCHEMA["$defs"]["MemberProfessionXpProjection"]["properties"]
    )
    assert projection_properties.isdisjoint(FORBIDDEN_AUTHORIZATION_INPUTS)


@pytest.mark.parametrize("bad_order", [(101, 100), (100, 100)])
def test_source_order_must_be_unique_and_ascending(bad_order):
    source = deepcopy(SOURCE)
    source["events"][0]["event_seq"], source["events"][1]["event_seq"] = bad_order
    with pytest.raises(ValueError, match="unique ascending"):
        rebuild(POLICY_DOCUMENT["policy"], source)
