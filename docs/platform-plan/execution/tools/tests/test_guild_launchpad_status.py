"""CI checks only the README status line; the full validator stays a manual command."""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import pytest

EXECUTION = Path(__file__).resolve().parents[2]
PACK = EXECUTION / "guild-launchpad"
SPEC = importlib.util.spec_from_file_location("guild_launchpad_validate_spec_pack", PACK / "validate-spec-pack.py")
vsp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vsp)

README = (PACK / "README.md").read_text(encoding="utf-8")
STATE = json.loads((EXECUTION / "unified-foundation" / "current-state.json").read_text(encoding="utf-8"))
TRACE = json.loads((PACK / "traceability.json").read_text(encoding="utf-8"))


def test_status_keys_map_to_current_state_paths():
    expected_sources = {
        "as_of": "features.guild_launchpad.at",
        "release.production": "deployment.production.observed_release_sha",
        "release.staging": "deployment.staging.last_operator_release_sha",
        "flag.production": "features.guild_launchpad.last_operator_value.production",
        "flag.staging": "features.guild_launchpad.last_operator_value.staging",
        "max_migration": "schema.repository_max_migration",
        "capacity_policy_rows": "features.guild_launchpad.policy_rows.capacity",
        "authority_policy_rows": "features.guild_launchpad.policy_rows.authority"
    }
    assert vsp.STATUS_SOURCES == expected_sources
    assert vsp.STATUS_KEYS == (*expected_sources, "accepted")


def test_repository_status_line_matches_current_state():
    assert vsp.status_failures(README, STATE, TRACE) == []


@pytest.mark.parametrize("key", vsp.STATUS_KEYS)
def test_readme_value_drift_fails(key):
    match = vsp.STATUS_LINE.search(README)
    assert match
    tokens = match.group(1).split()
    new_tokens = []
    for token in tokens:
        k, v = token.split("=", 1)
        if k == key:
            if k == "as_of":
                drift = "1999-01-01"
            elif k.startswith("release."):
                drift = "0" * 40
            elif k.startswith("flag."):
                drift = f"{v}-drift"
            elif k == "accepted":
                drift = "true" if v == "false" else "false"
            else:
                drift = str(int(v) + 1)
            new_tokens.append(f"{k}={drift}")
        else:
            new_tokens.append(token)
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(new_tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert failures
    assert any(key in f for f in failures)


@pytest.mark.parametrize("key", vsp.STATUS_SOURCES)
def test_current_state_drift_fails(key):
    path = vsp.STATUS_SOURCES[key]
    state_copy = copy.deepcopy(STATE)
    parts = path.split(".")
    current = state_copy
    for part in parts[:-1]:
        current = current[part]

    val = current[parts[-1]]
    if key == "as_of":
        drift = "1999-01-01T00:00:00+00:00"
    elif key.startswith("release."):
        drift = "0" * 40
    elif key.startswith("flag."):
        drift = f"{val}-drift"
    else:
        drift = val + 1

    current[parts[-1]] = drift

    failures = vsp.status_failures(README, state_copy, TRACE)
    assert failures
    assert any(path in f for f in failures)


def test_missing_status_line_fails():
    drift_readme = vsp.STATUS_LINE.sub("", README)
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert failures == ["README must contain exactly one glp-status line, found 0"]


def test_duplicate_status_line_fails():
    match = vsp.STATUS_LINE.search(README)
    drift_readme = README[:match.end()] + "\n" + match.group(0) + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert failures == ["README must contain exactly one glp-status line, found 2"]


def test_missing_key_fails():
    match = vsp.STATUS_LINE.search(README)
    tokens = [t for t in match.group(1).split() if not t.startswith("accepted=")]
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert any("missing key accepted" in f for f in failures)


def test_unknown_key_fails():
    match = vsp.STATUS_LINE.search(README)
    tokens = match.group(1).split() + ["source=687dee87"]
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert any("unknown key source" in f for f in failures)


def test_duplicate_key_fails():
    match = vsp.STATUS_LINE.search(README)
    tok = next(t for t in match.group(1).split() if t.startswith("flag.staging="))
    tokens = match.group(1).split() + [tok]
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert any("repeats key flag.staging" in f for f in failures)


def test_malformed_token_fails():
    match = vsp.STATUS_LINE.search(README)
    tokens = match.group(1).split() + ["oops"]
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert any("'oops'" in f for f in failures)


def test_status_line_outside_section_fails():
    match = vsp.STATUS_LINE.search(README)
    drift_readme = README[:match.start()] + README[match.end():] + "\n" + match.group(0)
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert any("inside the 目前狀態 section" in f for f in failures)


def test_missing_section_heading_fails():
    drift_readme = README.replace("## 目前狀態", "## 狀態")
    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert any('exactly one "## 目前狀態" heading, found 0' in f for f in failures)


def test_release_prefix_missing_from_section_fails():
    match = vsp.STATUS_LINE.search(README)
    status_line = match.group(0)

    sha = STATE["deployment"]["production"]["observed_release_sha"][:8]
    drift_readme = README.replace(sha, "deadbeef")
    drift_readme = drift_readme.replace(status_line.replace(sha, "deadbeef"), status_line)

    failures = vsp.status_failures(drift_readme, STATE, TRACE)
    assert any("outside the glp-status line" in f for f in failures)


def test_missing_current_state_path_fails():
    state_copy = copy.deepcopy(STATE)
    del state_copy["features"]["guild_launchpad"]["policy_rows"]
    failures = vsp.status_failures(README, state_copy, TRACE)
    assert any("features.guild_launchpad.policy_rows.capacity" in f for f in failures)


def test_non_scalar_current_state_value_fails():
    state_copy = copy.deepcopy(STATE)
    state_copy["features"]["guild_launchpad"]["last_operator_value"]["production"] = True
    failures = vsp.status_failures(README, state_copy, TRACE)
    assert any("features.guild_launchpad.last_operator_value.production" in f for f in failures)


def test_recorded_acceptance_evidence_keeps_status_check_green():
    trace_copy = copy.deepcopy(TRACE)
    for i, case in enumerate(trace_copy["acceptance"]):
        if i < len(trace_copy["acceptance"]) - 1:
            case["status"] = "passed"
            case["evidence"] = ["evidence"]
    assert vsp.status_failures(README, STATE, trace_copy) == []


def test_accepted_must_flip_when_no_case_is_not_run():
    trace_copy = copy.deepcopy(TRACE)
    for case in trace_copy["acceptance"]:
        case["status"] = "passed"
    failures = vsp.status_failures(README, STATE, trace_copy)
    assert any("accepted" in f for f in failures)
