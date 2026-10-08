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
FIX_COMMAND = "run: python3 docs/platform-plan/execution/guild-launchpad/validate-spec-pack.py --write-status"
# Tests derive from the declared value, so adding a migration never breaks them.
DECLARED_MAX_MIGRATION = int(dict(token.split("=", 1) for token in vsp.STATUS_LINE.search(README).group(1).split())["repo_max_migration"])


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
    assert any(key in f and f.endswith(FIX_COMMAND) for f in failures)


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
    assert any(path in f and f.endswith(FIX_COMMAND) for f in failures)


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
        "recorded_at": "2026-10-07T14:00:00Z",
        "result": "passed",
        "ref": "123456"
    }


def passed_progress(ids=None):
    progress = copy.deepcopy(PROGRESS)
    for milestone in progress["milestones"].values():
        milestone["candidate_sha"] = "a" * 40
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


@pytest.mark.parametrize("recorded_at", [
    "2026-10-07T14:44:12.302980+00:00", "2026-10-07T14:44:12Z",
    "2026-10-07T14:44Z", "2026-10-07T14:44+08:00", "2026-10-07T14:44:12-04:00"
])
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
    declared = DECLARED_MAX_MIGRATION
    ahead = declared + 1
    for number in range(1, ahead + 1):
        (tmp_path / f"{number:03}_{'a' if number == 1 else 'b'}.sql").write_text("-- fixture\n")
    for name in ("notes.md", "12_bad.txt", "999_UPPER.txt", "1000_bad.txt"):
        (tmp_path / name).write_text("ignored\n")
    (tmp_path / "998_directory.sql").mkdir()
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "999_nested.sql").write_text("ignored\n")
    assert vsp.repository_max_migration(tmp_path) == ahead
    failures = vsp.status_failures(README, STATE, TRACE, PROGRESS, tmp_path)
    assert any(f"repo_max_migration={declared}" in f and f"migrations/ (code) is {ahead}" in f for f in failures)
    assert any(f"repo_max_migration={declared}" in f and f.endswith(FIX_COMMAND) for f in failures)


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
    stale = README.replace(f"repo_max_migration={DECLARED_MAX_MIGRATION}", "repo_max_migration=1")
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


@pytest.mark.parametrize("milestone", ["M1", "full"])
@pytest.mark.parametrize("candidate", ["", "a" * 39, "a" * 41, "A" * 40, "g" * 40, 123, False, [], {}])
def test_invalid_candidate_sha_fails(milestone, candidate):
    progress = passed_progress()
    progress["milestones"][milestone]["candidate_sha"] = candidate
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(f"{milestone}.candidate_sha" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("milestone", ["M1", "full"])
def test_candidate_sha_is_required(milestone):
    progress = passed_progress()
    del progress["milestones"][milestone]["candidate_sha"]
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(f"{milestone}.candidate_sha is required" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("candidate", [None, "b" * 40])
@pytest.mark.parametrize("milestone", ["M1", "full"])
def test_null_or_unproven_candidate_is_not_accepted_without_failing(milestone, candidate):
    progress = passed_progress()
    progress["milestones"][milestone]["candidate_sha"] = candidate
    expected = {"M1": True, "full": True}
    expected[milestone] = False
    assert vsp.progress_failures(progress, TRACE) == ([], expected)


def test_each_case_needs_nonlocal_passing_evidence_for_the_candidate():
    progress = passed_progress()
    progress["cases"][0]["evidence"] = [
        {**passing_evidence(), "source_sha": "b" * 40},
        {**passing_evidence(), "environment": "local"}
    ]
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": False, "full": False})
    progress["cases"][0]["evidence"].append(passing_evidence())
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


def test_milestones_can_accept_different_candidates():
    progress = passed_progress()
    progress["milestones"]["full"]["candidate_sha"] = "b" * 40
    for case in progress["cases"]:
        case["evidence"].append({**passing_evidence(), "source_sha": "b" * 40})
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


@pytest.mark.parametrize("result", ["failed", "partial", "blocked"])
@pytest.mark.parametrize("environment", ["ci", "staging", "production"])
@pytest.mark.parametrize("reverse", [False, True])
def test_later_nonpass_contradicts_pass_regardless_of_array_order(result, environment, reverse):
    progress = passed_progress()
    entries = [
        {**passing_evidence(), "environment": environment},
        {**passing_evidence(), "environment": environment, "result": result,
         "recorded_at": "2026-10-07T10:01:00-04:00"}
    ]
    progress["cases"][0]["evidence"] = entries[::-1] if reverse else entries
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert len(failures) == 1
    assert failures[0].endswith(f"passed is contradicted by a later {result} result for aaaaaaaaaaaa in {environment}")
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("change", [
    {"source_sha": "b" * 40}, {"environment": "staging"}, {"result": "passed"},
    {"recorded_at": "2026-10-07T16:00:00+02:00"},
    {"recorded_at": "2026-10-07T16:00:00+03:00"}
])
def test_other_sha_environment_or_non_later_result_does_not_supersede(change):
    progress = passed_progress()
    progress["cases"][0]["evidence"].append({
        **passing_evidence(), "result": "failed", "recorded_at": "2026-10-07T14:01:00Z", **change
    })
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


def test_nonpass_in_another_case_does_not_supersede():
    progress = passed_progress()
    progress["cases"][-1].update(status="failed", evidence=[{
        **passing_evidence(), "result": "failed", "recorded_at": "2026-10-07T14:01:00Z"
    }])
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": False})


@pytest.mark.parametrize("surviving_pass,expected", [
    ({"source_sha": "b" * 40}, {"M1": False, "full": False}),
    ({"environment": "staging"}, {"M1": True, "full": True}),
    ({"recorded_at": "2026-10-07T14:02:00Z"}, {"M1": True, "full": True})
])
def test_only_unsuperseded_passes_count_for_candidate(surviving_pass, expected):
    progress = passed_progress()
    progress["cases"][0]["evidence"].extend([
        {**passing_evidence(), "result": "failed", "recorded_at": "2026-10-07T14:01:00Z"},
        {**passing_evidence(), **surviving_pass}
    ])
    assert vsp.progress_failures(progress, TRACE) == ([], expected)


@pytest.mark.parametrize("level", ["top", "M1", "full", "case", "evidence"])
def test_unknown_progress_keys_fail_and_name_the_key(level):
    progress = passed_progress()
    target = {"top": progress, "M1": progress["milestones"]["M1"], "full": progress["milestones"]["full"],
              "case": progress["cases"][0], "evidence": progress["cases"][0]["evidence"][0]}[level]
    target["unexpected_field"] = "fixture"
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any("unknown key unexpected_field" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("optional", [
    {}, {"started_at": "2026-10-07T13:00Z"}, {"finished_at": "2026-10-07T14:00Z"},
    {"started_at": "2026-10-07T16:00+03:00", "finished_at": "2026-10-07T14:00Z"},
    {"started_at": "2026-10-07T16:00+02:00", "finished_at": "2026-10-07T14:00Z"},
    {"artifact_sha256": "0123456789abcdef" * 4, "limits": "Synthetic fixture only", "failures": []},
    {"failures": ["Earlier attempt failed", "Historical limitation"]}
])
def test_supported_optional_evidence_fields_are_valid(optional):
    progress = passed_progress()
    progress["cases"][0]["evidence"][0].update(optional)
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


@pytest.mark.parametrize("key,value", [
    ("artifact_sha256", "A" * 64), ("artifact_sha256", "a" * 63), ("artifact_sha256", "a" * 65),
    ("artifact_sha256", "g" * 64), ("artifact_sha256", None),
    ("limits", ""), ("limits", " \n"), ("limits", []), ("limits", None),
    ("failures", "failed"), ("failures", [""]), ("failures", [" "]), ("failures", [1]),
    ("failures", None), ("failures", ["valid", None])
])
def test_invalid_optional_evidence_fields_fail(key, value):
    progress = passed_progress()
    progress["cases"][0]["evidence"][0][key] = value
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(key in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("key", ["recorded_at", "started_at", "finished_at"])
@pytest.mark.parametrize("value", [
    "2026-10-07", "2026-10-07T14:00", "2026-10-07T14:00:00", "2026-02-30T14:00Z",
    "2026-10-07T14:00+0000", "2026-10-07T14:00+00:60", "2026-10-07T14:00+24:00", None
])
def test_timestamps_require_explicit_valid_timezone(key, value):
    progress = passed_progress()
    progress["cases"][0]["evidence"][0][key] = value
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(f"{key} must be an ISO-8601 timestamp with an explicit Z or ±HH:MM timezone" in f for f in failures)
    assert accepted == {"M1": False, "full": False}


def test_started_at_cannot_follow_finished_at_in_absolute_time():
    progress = passed_progress()
    progress["cases"][0]["evidence"][0].update(
        started_at="2026-10-07T10:00-05:00", finished_at="2026-10-07T14:00Z"
    )
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any("started_at must be <= finished_at" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("ref", [
    "1", "123456", "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123456",
    "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123456/attempts/2",
    "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123456/job/987654"
])
def test_ci_action_run_references_are_valid(ref):
    progress = passed_progress()
    progress["cases"][0]["evidence"][0]["ref"] = ref
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


@pytest.mark.parametrize("ref", [
    "synthetic-receipt.json", "0", "01", "-1", "123\n", 123,
    "https://github.com/FreeTWAI-AI/other/actions/runs/123",
    "http://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123",
    "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/0",
    "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123/attempts/0",
    "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123/job/01",
    "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123/attempts/1/job/2",
    "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123/",
    "https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/123?check=1"
])
def test_invalid_ci_references_fail(ref):
    progress = passed_progress()
    progress["cases"][0]["evidence"][0]["ref"] = ref
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any("ref for ci" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("environment", ["local", "staging", "production"])
def test_other_environments_keep_nonempty_reference_rule(environment):
    progress = passed_progress()
    entry = {**passing_evidence(), "environment": environment, "ref": "synthetic-receipt.json"}
    progress["cases"][0]["evidence"].append(entry)
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})
    entry["ref"] = " "
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any("ref must be a non-empty string" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("with_valid_file", [False, True])
def test_every_invalid_sql_filename_is_reported(tmp_path, with_valid_file):
    if with_valid_file:
        (tmp_path / "125_valid.sql").write_text("-- fixture\n")
    invalid = ["12_bad.sql", "999_UPPER.sql", "1000_bad.sql", "no_number.sql", "126_bad-name.sql", ".sql"]
    for name in invalid:
        (tmp_path / name).write_text("-- invalid fixture\n")
    (tmp_path / "notes.md").write_text("ignored\n")
    with pytest.raises(ValueError) as error:
        vsp.repository_max_migration(tmp_path)
    assert str(error.value) == "invalid migration filenames: " + ", ".join(sorted(invalid))
    failures = vsp.status_failures(README, STATE, TRACE, PROGRESS, tmp_path)
    assert any(str(error.value) in failure for failure in failures)


# full is the original requirement set; its scope is rejected in test_full_scope_is_forbidden.
@pytest.mark.parametrize("milestone,scope", [
    ("M1", {}), ("M1", {"T-015": "Restricted operator variant"})
])
def test_valid_milestone_scope(milestone, scope):
    progress = passed_progress()
    progress["milestones"][milestone]["scope"] = scope
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})
    del progress["milestones"][milestone]["scope"]
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


@pytest.mark.parametrize("milestone,scope,bad_key", [
    ("M1", {"T-009": "Outside M1"}, "T-009"), ("full", {"T-061": "Unknown"}, "T-061"),
    ("M1", {"T-015": " "}, "T-015"), ("full", {"T-060": ""}, "T-060"),
    ("M1", {"T-023": None}, "T-023"), ("full", {"T-001": []}, "T-001"),
    ("M1", [], "scope"), ("full", None, "scope"), ("M1", "T-015", "scope")
])
def test_invalid_milestone_scope_fails(milestone, scope, bad_key):
    progress = passed_progress()
    progress["milestones"][milestone]["scope"] = scope
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(f"{milestone}.scope" in failure and bad_key in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


def test_repository_candidates_remain_unselected_and_m1_variants_match_owner_decision():
    assert all(milestone["candidate_sha"] is None for milestone in PROGRESS["milestones"].values())
    assert PROGRESS["milestones"]["M1"]["scope"] == {
        "T-015": "M1 變體：只驗受限營運者沒有任何路徑能批次取走 tenant 資料；匯出／還原部分移到提供匯出功能的里程碑。",
        "T-023": "M1 變體：只驗權限半部，B 或匿名者猜 A 的物件／變體網址時 GET、HEAD、Range 一律拒絕；位元組還原由 two-tenant RLS 備份還原演練（#238）涵蓋，匯出／還原移到提供匯出功能的里程碑。"
    }
    assert PROGRESS["milestones"]["M1"]["basis"].endswith(
        "T-015 與 T-023 依 2026-10-07 owner 決定以 M1 變體驗收（見 scope）。"
    )
    assert vsp.progress_failures(PROGRESS, TRACE) == ([], {"M1": False, "full": False})


def m1_variant_progress():
    progress = passed_progress()
    for case in progress["cases"]:
        if case["id"] in ("T-015", "T-023"):
            case.update(status="partial", evidence=[{
                **passing_evidence(), "result": "partial",
                "limits": "Only owner-approved M1 variant exercised; export/restore deferred"
            }], variants={"M1": {"status": "passed", "evidence": [passing_evidence()]}})
    return progress


def test_m1_variants_pass_without_passing_the_original_full_cases():
    progress = m1_variant_progress()
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": False})
    assert all(case["status"] == "partial" for case in progress["cases"]
               if case["id"] in ("T-015", "T-023"))


def test_full_pass_covers_m1_without_variant_records():
    progress = passed_progress()
    assert all("variants" not in case for case in progress["cases"])
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": True, "full": True})


def test_variant_pass_at_another_sha_does_not_accept_m1_or_fall_back_to_case():
    progress = passed_progress()
    progress["cases"][14]["variants"] = {"M1": {
        "status": "passed", "evidence": [{**passing_evidence(), "source_sha": "b" * 40}]
    }}
    assert vsp.progress_failures(progress, TRACE) == ([], {"M1": False, "full": True})


@pytest.mark.parametrize("mutation,error", [
    ("local", "passed requires valid passing evidence from ci, staging or production"),
    ("later_failed", "passed is contradicted by a later failed result"),
    ("not_run", "not_run requires empty evidence"),
    ("unknown_key", "unknown key unexpected_field"),
    ("unknown_status", "unknown status accepted"),
    ("missing_status", "unknown status None"),
    ("missing_evidence", "evidence must be a list"),
    ("bad_evidence", "source_sha must be 40 lowercase hex characters"),
    ("not_object", "must be an object")
])
def test_invalid_variant_records_fail_with_case_and_variant_label(mutation, error):
    progress = m1_variant_progress()
    variants = progress["cases"][14]["variants"]
    record = variants["M1"]
    if mutation == "local":
        record["evidence"][0]["environment"] = "local"
    elif mutation == "later_failed":
        record["evidence"].append({
            **passing_evidence(), "result": "failed", "recorded_at": "2026-10-07T14:01:00Z"
        })
    elif mutation == "not_run":
        record["status"] = "not_run"
    elif mutation == "unknown_key":
        record["unexpected_field"] = "fixture"
    elif mutation == "unknown_status":
        record["status"] = "accepted"
    elif mutation == "missing_status":
        del record["status"]
    elif mutation == "missing_evidence":
        del record["evidence"]
    elif mutation == "bad_evidence":
        record["evidence"][0]["source_sha"] = "invalid"
    elif mutation == "not_object":
        variants["M1"] = []
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any("cases[14] (T-015) variants.M1:" in failure and error in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("index,key", [(0, "M1"), (14, "full"), (14, "unknown")])
def test_variant_key_requires_milestone_scope_for_the_case(index, key):
    progress = passed_progress()
    case = progress["cases"][index]
    case["variants"] = {key: {"status": "passed", "evidence": [passing_evidence()]}}
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(f"cases[{index}] ({case['id']}) variants.{key}: requires a scope entry" in failure
               for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("variants", [None, [], "M1"])
def test_variants_must_be_an_object(variants):
    progress = passed_progress()
    progress["cases"][14]["variants"] = variants
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any("cases[14] (T-015): variants must be an object" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("scope", [{}, {"T-015": "Full case scope"}, {"T-060": "Full case scope"}])
def test_full_scope_is_forbidden(scope):
    progress = passed_progress()
    progress["milestones"]["full"]["scope"] = scope
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any("full.scope is not allowed" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


@pytest.mark.parametrize("status", ["not_run", "partial", "failed", "blocked"])
def test_nonpassing_variant_contradicts_full_case_pass(status):
    progress = passed_progress()
    progress["cases"][14]["variants"] = {"M1": {"status": status, "evidence": []}}
    failures, accepted = vsp.progress_failures(progress, TRACE)
    assert any(f"variants.M1 status {status} contradicts case status passed" in failure for failure in failures)
    assert accepted == {"M1": False, "full": False}


def test_status_source_counts_variant_status_only_for_m1():
    progress = copy.deepcopy(PROGRESS)
    for case in progress["cases"]:
        if case["id"] in ("T-015", "T-023"):
            case["variants"] = {"M1": {"status": "passed", "evidence": [passing_evidence()]}}
    values, sources, failures = vsp.status_values(STATE, TRACE, progress, vsp.MIGRATIONS)
    assert failures == []
    assert sources["accepted_m1"] == "acceptance-progress.json (2 of 28 M1 cases passed)"
    assert sources["accepted_full"] == "acceptance-progress.json (0 of 60 full cases passed)"
    assert values["accepted_m1"] == values["accepted_full"] == "false"
