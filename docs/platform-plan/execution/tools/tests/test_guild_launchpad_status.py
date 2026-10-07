"""CI checks only the README status line; the full validator stays a manual command."""

from __future__ import annotations

import copy
import importlib.util
import json
import shutil
import subprocess
import sys
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
PROGRESS = json.loads((PACK / "acceptance-progress.json").read_text(encoding="utf-8"))


def test_status_keys_map_to_current_state_paths():
    expected_sources = {
        "as_of": "features.guild_launchpad.at",
        "release.production": "deployment.production.observed_release_sha",
        "release.staging": "deployment.staging.last_operator_release_sha",
        "flag.production": "features.guild_launchpad.last_operator_value.production",
        "flag.staging": "features.guild_launchpad.last_operator_value.staging",
        "applied_migration.production": "schema.production_observed.through_number",
        "applied_migration.staging": "schema.staging_observed.through_number",
        "capacity_policy_rows": "features.guild_launchpad.policy_rows.capacity",
        "authority_policy_rows": "features.guild_launchpad.policy_rows.authority"
    }
    assert vsp.STATUS_SOURCES == expected_sources
    assert vsp.STATUS_KEYS == (
        "as_of", "release.production", "release.staging", "flag.production", "flag.staging",
        "repo_max_migration", "applied_migration.production", "applied_migration.staging",
        "capacity_policy_rows", "authority_policy_rows", "accepted_m1", "accepted_full"
    )


def test_repository_status_line_matches_current_state():
    assert vsp.status_failures(README, STATE, TRACE, PROGRESS) == []
    assert vsp.render_status_line(STATE, TRACE, PROGRESS) == vsp.STATUS_LINE.search(README).group(0)


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
            elif k.startswith("accepted_"):
                drift = "true" if v == "false" else "false"
            else:
                drift = str(int(v) + 1)
            new_tokens.append(f"{k}={drift}")
        else:
            new_tokens.append(token)
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(new_tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
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

    failures = vsp.status_failures(README, state_copy, TRACE, PROGRESS)
    assert failures
    assert any(path in f for f in failures)


def test_missing_status_line_fails():
    drift_readme = vsp.STATUS_LINE.sub("", README)
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert failures == ["README must contain exactly one glp-status line, found 0"]


def test_duplicate_status_line_fails():
    match = vsp.STATUS_LINE.search(README)
    drift_readme = README[:match.end()] + "\n" + match.group(0) + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert failures == ["README must contain exactly one glp-status line, found 2"]


def test_missing_key_fails():
    match = vsp.STATUS_LINE.search(README)
    tokens = [t for t in match.group(1).split() if not t.startswith("accepted_full=")]
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert any("missing key accepted_full" in f for f in failures)


def test_unknown_key_fails():
    match = vsp.STATUS_LINE.search(README)
    tokens = match.group(1).split() + ["source=687dee87"]
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert any("unknown key source" in f for f in failures)


def test_duplicate_key_fails():
    match = vsp.STATUS_LINE.search(README)
    tok = next(t for t in match.group(1).split() if t.startswith("flag.staging="))
    tokens = match.group(1).split() + [tok]
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert any("repeats key flag.staging" in f for f in failures)


def test_malformed_token_fails():
    match = vsp.STATUS_LINE.search(README)
    tokens = match.group(1).split() + ["oops"]
    drift_readme = README[:match.start()] + "<!-- glp-status: " + " ".join(tokens) + " -->" + README[match.end():]
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert any("'oops'" in f for f in failures)


def test_status_line_outside_section_fails():
    match = vsp.STATUS_LINE.search(README)
    drift_readme = README[:match.start()] + README[match.end():] + "\n" + match.group(0)
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert any("inside the 目前狀態 section" in f for f in failures)


def test_missing_section_heading_fails():
    drift_readme = README.replace("## 目前狀態", "## 狀態")
    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert any('exactly one "## 目前狀態" heading, found 0' in f for f in failures)


def test_release_prefix_missing_from_section_fails():
    match = vsp.STATUS_LINE.search(README)
    status_line = match.group(0)

    sha = STATE["deployment"]["production"]["observed_release_sha"][:8]
    drift_readme = README.replace(sha, "deadbeef")
    drift_readme = drift_readme.replace(status_line.replace(sha, "deadbeef"), status_line)

    failures = vsp.status_failures(drift_readme, STATE, TRACE, PROGRESS)
    assert any("outside the glp-status line" in f for f in failures)


def test_missing_current_state_path_fails():
    state_copy = copy.deepcopy(STATE)
    del state_copy["features"]["guild_launchpad"]["policy_rows"]
    failures = vsp.status_failures(README, state_copy, TRACE, PROGRESS)
    assert any("features.guild_launchpad.policy_rows.capacity" in f for f in failures)


def test_non_scalar_current_state_value_fails():
    state_copy = copy.deepcopy(STATE)
    state_copy["features"]["guild_launchpad"]["last_operator_value"]["production"] = True
    failures = vsp.status_failures(README, state_copy, TRACE, PROGRESS)
    assert any("features.guild_launchpad.last_operator_value.production" in f for f in failures)


def passing_evidence():
    return {
        "test": "synthetic-test/T-case",
        "source_sha": "a" * 40,
        "environment": "ci",
        "command": "synthetic fixture command",
        "recorded_at": "2026-10-07",
        "result": "passed",
        "ref": "synthetic-receipt.json"
    }


def passed_progress(ids=None):
    progress = copy.deepcopy(PROGRESS)
    for case in progress["cases"]:
        if ids is None or case["id"] in ids:
            case.update(status="passed", evidence=[passing_evidence()])
    return progress


def readme_with_line(line):
    return vsp.STATUS_LINE.sub(lambda match: line, README)


def test_local_only_passing_evidence_cannot_prove_acceptance():
    progress = passed_progress()
    case_id = progress["milestones"]["M1"]["cases"][0]
    case = next(case for case in progress["cases"] if case["id"] == case_id)
    case["evidence"][0]["environment"] = "local"
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any("from ci, staging or production" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


def test_partial_case_can_record_local_passing_evidence():
    progress = passed_progress()
    case_id = progress["milestones"]["M1"]["cases"][0]
    case = next(case for case in progress["cases"] if case["id"] == case_id)
    case["status"] = "partial"
    case["evidence"][0]["environment"] = "local"
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": False, "full": False})


def test_local_and_staging_passing_evidence_proves_acceptance():
    progress = passed_progress()
    case_id = progress["milestones"]["M1"]["cases"][0]
    case = next(case for case in progress["cases"] if case["id"] == case_id)
    case["evidence"] = [{**passing_evidence(), "environment": environment}
                        for environment in ("local", "staging")]
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


@pytest.mark.parametrize("environment", ["ci", "staging", "production"])
def test_nonlocal_passing_evidence_proves_acceptance(environment):
    progress = passed_progress()
    case_id = progress["milestones"]["M1"]["cases"][0]
    case = next(case for case in progress["cases"] if case["id"] == case_id)
    case["evidence"][0]["environment"] = environment
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


def test_validate_summary_names_all_status_sources(capsys):
    assert vsp.validate() is False
    assert capsys.readouterr().out.splitlines()[-1] == (
        "README glp-status compared with migrations/ (code), unified-foundation/current-state.json "
        "(operator observations, the deployment record) and acceptance-progress.json."
    )


def test_recorded_acceptance_evidence_keeps_status_check_green():
    progress = passed_progress()
    progress["cases"][-1].update(status="not_run", evidence=[])
    readme = readme_with_line(vsp.render_status_line(STATE, TRACE, progress))
    assert vsp.status_failures(readme, STATE, TRACE, progress) == []
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": False})


def test_accepted_must_flip_when_no_case_is_not_run():
    # All cases passed with valid evidence; merely eliminating not_run is insufficient.
    progress = passed_progress()
    failures = vsp.status_failures(README, STATE, TRACE, progress)
    assert any("accepted_m1" in f for f in failures)
    assert any("accepted_full" in f for f in failures)
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})
    readme = readme_with_line(vsp.render_status_line(STATE, TRACE, progress))
    assert vsp.status_failures(readme, STATE, TRACE, progress) == []
    assert any("acceptance-progress.json (60 of 60 full cases passed)" in f for f in failures)


@pytest.mark.parametrize("mutation", [
    "missing_cases", "non_list_cases", "empty_cases", "missing_id", "duplicate_id",
    "unknown_id", "unknown_status", "passed_empty", "passed_failed", "bad_sha",
    "bad_environment", "not_run_evidence", "case_not_object", "evidence_not_list",
    "evidence_not_object"
])
def test_invalid_progress_fails_closed(mutation):
    progress = copy.deepcopy(PROGRESS)
    case = progress["cases"][0]
    if mutation == "missing_cases":
        del progress["cases"]
    elif mutation == "non_list_cases":
        progress["cases"] = {}
    elif mutation == "empty_cases":
        progress["cases"] = []
    elif mutation == "missing_id":
        progress["cases"].pop()
    elif mutation == "duplicate_id":
        progress["cases"].append(copy.deepcopy(case))
    elif mutation == "unknown_id":
        progress["cases"].append({"id": "T-061", "status": "not_run", "evidence": []})
    elif mutation == "unknown_status":
        case["status"] = "accepted"
    elif mutation == "passed_empty":
        case["status"] = "passed"
    elif mutation == "passed_failed":
        case.update(status="passed", evidence=[{**passing_evidence(), "result": "failed"}])
    elif mutation in ("bad_sha", "bad_environment"):
        entry = passing_evidence()
        entry["source_sha" if mutation == "bad_sha" else "environment"] = "invalid"
        case.update(status="passed", evidence=[entry])
    elif mutation == "not_run_evidence":
        case["evidence"] = [passing_evidence()]
    elif mutation == "case_not_object":
        progress["cases"][0] = None
    elif mutation == "evidence_not_list":
        case["evidence"] = {}
    elif mutation == "evidence_not_object":
        case.update(status="failed", evidence=["receipt"])
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert failures
    assert accepted == {"M1": False, "full": False}
    status_errors = vsp.status_failures(README, STATE, TRACE, progress)
    assert all(failure in status_errors for failure in failures)


@pytest.mark.parametrize("key", ["test", "source_sha", "environment", "command", "recorded_at", "result", "ref"])
def test_evidence_requires_every_field(key):
    progress = passed_progress()
    del progress["cases"][0]["evidence"][0][key]
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(key in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("key,value", [
    ("test", " "), ("command", None), ("ref", ""), ("source_sha", "A" * 40),
    ("source_sha", "a" * 39), ("recorded_at", "2026-02-30"),
    ("recorded_at", "2026-10-07T25:00:00Z"), ("recorded_at", "yesterday"),
    ("recorded_at", None), ("result", "not_run"), ("result", "unknown")
])
def test_invalid_evidence_fields_fail_closed(key, value):
    progress = passed_progress()
    progress["cases"][0]["evidence"][0][key] = value
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(key in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("recorded_at", ["2026-10-07", "2026-10-07T14:44:12.302980+00:00", "2026-10-07T14:44:12Z"])
def test_valid_evidence_dates(recorded_at):
    progress = passed_progress()
    progress["cases"][0]["evidence"][0]["recorded_at"] = recorded_at
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


def test_any_invalid_entry_prevents_acceptance_even_with_passing_evidence():
    progress = passed_progress()
    progress["cases"][0]["evidence"].append({"result": "failed"})
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert failures
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("status", ["failed", "partial", "blocked"])
def test_non_passing_statuses_are_valid_but_not_accepted(status):
    progress = copy.deepcopy(PROGRESS)
    for case in progress["cases"]:
        case["status"] = status
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": False, "full": False})
    assert vsp.status_failures(README, STATE, TRACE, progress) == []


def test_59_passed_and_one_failed_is_not_accepted():
    progress = passed_progress()
    progress["cases"][0].update(status="failed", evidence=[{**passing_evidence(), "result": "failed"}])
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": False, "full": False})


def test_m1_acceptance_is_independent_of_later_milestones():
    progress = passed_progress(PROGRESS["milestones"]["M1"]["cases"])
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": False})
    readme = README.replace("accepted_m1=false", "accepted_m1=true")
    assert vsp.status_failures(readme, STATE, TRACE, progress) == []
    failures = vsp.status_failures(README, STATE, TRACE, progress)
    assert any("accepted_m1=false" in f and "acceptance-progress.json (28 of 28 M1 cases passed)" in f for f in failures)


@pytest.mark.parametrize("mutation", ["empty", "duplicate", "unknown", "missing_full", "full_not_all", "extra", "missing_m1", "non_list_m1", "non_object"])
def test_invalid_milestones_fail_closed(mutation):
    progress = passed_progress()
    milestones = progress["milestones"]
    if mutation == "empty":
        milestones["M1"]["cases"] = []
    elif mutation == "duplicate":
        milestones["M1"]["cases"].append("T-001")
    elif mutation == "unknown":
        milestones["M1"]["cases"].append("T-061")
    elif mutation == "missing_full":
        del milestones["full"]
    elif mutation == "full_not_all":
        milestones["full"]["cases"] = ["T-001"]
    elif mutation == "extra":
        milestones["M2"] = {"cases": ["T-009"]}
    elif mutation == "missing_m1":
        del milestones["M1"]
    elif mutation == "non_list_m1":
        milestones["M1"]["cases"] = "all"
    elif mutation == "non_object":
        progress["milestones"] = []
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert failures
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("acceptance", [None, {}, [], [None], [{"id": None}]])
def test_malformed_baseline_cannot_infer_acceptance(acceptance):
    trace = copy.deepcopy(TRACE)
    trace["acceptance"] = acceptance
    failures, accepted = vsp.progress_failures(passed_progress(), trace)
    assert failures
    assert accepted == {"M1": False, "full": False}


def test_repository_migration_maximum_is_a_code_fact(tmp_path):
    for number in range(1, 127):
        (tmp_path / f"{number:03}_{'a' if number == 1 else 'b'}.sql").write_text("-- fixture\n")
    for name in ("notes.md", "12_bad.sql", "999_UPPER.sql", "1000_bad.sql"):
        (tmp_path / name).write_text("ignored\n")
    (tmp_path / "998_directory.sql").mkdir()
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "999_nested.sql").write_text("ignored\n")
    assert vsp.repository_max_migration(tmp_path) == 126
    failures = vsp.status_failures(README, STATE, TRACE, PROGRESS, tmp_path)
    assert any("repo_max_migration=125" in f and "migrations/ (code) is 126" in f for f in failures)


def test_empty_migrations_directory_raises(tmp_path):
    with pytest.raises(ValueError, match="no matching migration files"):
        vsp.repository_max_migration(tmp_path)


@pytest.mark.parametrize("key", ["max_migration", "accepted"])
def test_old_status_keys_are_unknown(key):
    line = vsp.STATUS_LINE.search(README).group(0)
    readme = readme_with_line(line.replace(" -->", f" {key}=125 -->"))
    assert any(f"unknown key {key}" in f for f in vsp.status_failures(readme, STATE, TRACE, PROGRESS))


@pytest.mark.parametrize("line_count", [0, 1, 2])
def test_write_status_round_trip(tmp_path, line_count):
    pack = tmp_path / "docs/platform-plan/execution/guild-launchpad"
    pack.mkdir(parents=True)
    for name in ("validate-spec-pack.py", "traceability.json", "acceptance-progress.json"):
        shutil.copyfile(PACK / name, pack / name)
    state_dir = pack.parent / "unified-foundation"
    state_dir.mkdir()
    (state_dir / "current-state.json").write_text(json.dumps(STATE), encoding="utf-8")
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "125_fixture.sql").write_text("-- fixture\n")
    readme_path = pack / "README.md"
    stale = README.replace("repo_max_migration=125", "repo_max_migration=1")
    line = vsp.STATUS_LINE.search(stale).group(0)
    if line_count == 0:
        stale = vsp.STATUS_LINE.sub("", stale)
    elif line_count == 2:
        stale += "\n" + line
    readme_path.write_text(stale, encoding="utf-8")
    result = subprocess.run([sys.executable, "-B", str(pack / "validate-spec-pack.py"), "--write-status"],
                            capture_output=True, text=True, cwd=tmp_path)
    if line_count != 1:
        assert result.returncode == 1
        assert "exactly one glp-status line" in result.stdout
        assert readme_path.read_text(encoding="utf-8") == stale
    else:
        assert result.returncode == 0, result.stdout + result.stderr
        expected = vsp.render_status_line(STATE, TRACE, PROGRESS, migrations)
        assert result.stdout.strip() == expected
        rewritten = readme_path.read_text(encoding="utf-8")
        assert vsp.STATUS_LINE.search(rewritten).group(0) == expected
        assert rewritten == vsp.STATUS_LINE.sub(lambda match: expected, stale)
        again = subprocess.run([sys.executable, "-B", str(pack / "validate-spec-pack.py"), "--write-status"],
                               capture_output=True, text=True, cwd=tmp_path)
        assert again.returncode == 0
        assert again.stdout.strip() == expected
        assert readme_path.read_text(encoding="utf-8") == rewritten
