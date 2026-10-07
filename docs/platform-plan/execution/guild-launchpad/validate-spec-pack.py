"""Planning-document checks and the README status line generated from code (migrations), operator observations (current-state.json) and the progress index; never executes product T cases."""
from datetime import date, datetime
from pathlib import Path
import hashlib
import json
import re
import sys
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
EXPECTED_BASELINE = "11183364845c0d46b29fa52f5cc25f5c3ebce43cc3ff33662ef37d880b583c69"

CURRENT_STATE = ROOT / "docs/platform-plan/execution/unified-foundation/current-state.json"
PROGRESS = HERE / "acceptance-progress.json"
MIGRATIONS = ROOT / "migrations"
PROGRESS_STATUSES = ("not_run", "passed", "failed", "partial", "blocked")
EVIDENCE_ENVIRONMENTS = ("local", "ci", "staging", "production")
ACCEPTANCE_ENVIRONMENTS = ("ci", "staging", "production")
STATUS_LINE = re.compile(r"^<!-- glp-status: (.*) -->$", re.M)
STATUS_SOURCES = {
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
STATUS_KEYS = (
    "as_of", "release.production", "release.staging", "flag.production", "flag.staging",
    "repo_max_migration", "applied_migration.production", "applied_migration.staging",
    "capacity_policy_rows", "authority_policy_rows", "accepted_m1", "accepted_full"
)


def repository_max_migration(migrations_dir):
    numbers = [int(match.group(1)) for path in Path(migrations_dir).iterdir()
               if path.is_file() and (match := re.fullmatch(r"(\d{3})_[a-z0-9_]+\.sql", path.name))]
    if not numbers:
        raise ValueError("migrations/ (code) has no matching migration files")
    return max(numbers)


def valid_recorded_at(value):
    if not isinstance(value, str):
        return False
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            date.fromisoformat(value)
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:\d{2})?", value):
            datetime.fromisoformat(value)
        else:
            return False
    except ValueError:
        return False
    return True


def progress_failures(progress, trace):
    failures = []
    canonical = set()
    baseline = trace.get("acceptance") if isinstance(trace, dict) else None
    if not isinstance(baseline, list) or not baseline:
        failures.append("traceability.json acceptance must be a non-empty list")
    else:
        for case in baseline:
            case_id = case.get("id") if isinstance(case, dict) else None
            if not isinstance(case_id, str) or not case_id or case_id in canonical:
                failures.append("traceability.json acceptance has invalid or duplicate IDs")
            else:
                canonical.add(case_id)

    progress = progress if isinstance(progress, dict) else {}
    cases = progress.get("cases")
    if not isinstance(cases, list):
        failures.append("acceptance-progress.json cases must be a list")
        cases = []
    by_id = {}
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            failures.append(f"acceptance-progress.json cases[{index}] must be an object")
            continue
        case_id = case.get("id")
        label = f"acceptance-progress.json cases[{index}] ({case_id})"
        if not isinstance(case_id, str) or case_id not in canonical:
            failures.append(f"{label}: unknown ID")
        elif case_id in by_id:
            failures.append(f"{label}: duplicate ID")
        else:
            by_id[case_id] = case
        status = case.get("status")
        if status not in PROGRESS_STATUSES:
            failures.append(f"{label}: unknown status {status}")
        evidence = case.get("evidence")
        if not isinstance(evidence, list):
            failures.append(f"{label}: evidence must be a list")
            evidence = []
        if status == "not_run" and evidence:
            failures.append(f"{label}: not_run requires empty evidence")
        passing = False
        for entry_index, entry in enumerate(evidence):
            errors = []
            if not isinstance(entry, dict):
                errors.append("must be an object")
            else:
                for key in ("test", "command", "ref"):
                    if not isinstance(entry.get(key), str) or not entry[key].strip():
                        errors.append(f"{key} must be a non-empty string")
                sha = entry.get("source_sha")
                if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
                    errors.append("source_sha must be 40 lowercase hex characters")
                if entry.get("environment") not in EVIDENCE_ENVIRONMENTS:
                    errors.append("environment is invalid")
                if not valid_recorded_at(entry.get("recorded_at")):
                    errors.append("recorded_at must be YYYY-MM-DD or an ISO-8601 timestamp")
                if entry.get("result") not in PROGRESS_STATUSES[1:]:
                    errors.append("result is invalid")
            if errors:
                failures.append(f"{label}: evidence[{entry_index}] " + "; ".join(errors))
            elif entry["result"] == "passed" and entry["environment"] in ACCEPTANCE_ENVIRONMENTS:
                passing = True
        if status == "passed" and not passing:
            failures.append(f"{label}: passed requires valid passing evidence from ci, staging or production")
    for case_id in sorted(canonical - by_id.keys()):
        failures.append(f"acceptance-progress.json missing ID {case_id}")

    milestones = progress.get("milestones")
    if not isinstance(milestones, dict) or set(milestones) != {"M1", "full"}:
        failures.append("acceptance-progress.json milestones must contain exactly M1 and full")
    milestones = milestones if isinstance(milestones, dict) else {}
    m1 = milestones.get("M1")
    m1_cases = m1.get("cases") if isinstance(m1, dict) else None
    m1_ids = set()
    if not isinstance(m1_cases, list) or not m1_cases:
        failures.append("acceptance-progress.json M1.cases must be a non-empty list")
    else:
        for case_id in m1_cases:
            if not isinstance(case_id, str) or case_id not in canonical:
                failures.append(f"acceptance-progress.json M1.cases unknown ID {case_id}")
            elif case_id in m1_ids:
                failures.append(f"acceptance-progress.json M1.cases duplicate ID {case_id}")
            else:
                m1_ids.add(case_id)
    full = milestones.get("full")
    if not isinstance(full, dict) or full.get("cases") != "all":
        failures.append('acceptance-progress.json full.cases must be "all"')
    accepted = {key: not failures and all(by_id[case_id].get("status") == "passed" for case_id in ids)
                for key, ids in (("M1", m1_ids), ("full", canonical))}
    return failures, accepted


def status_values(state, trace, progress, migrations_dir):
    failures, accepted = progress_failures(progress, trace)
    values, sources = {}, {}
    for key, path in STATUS_SOURCES.items():
        current = state
        for part in path.split("."):
            current = current.get(part) if isinstance(current, dict) else None
        if isinstance(current, bool) or not isinstance(current, (str, int)):
            failures.append(f"current-state.json {path} is missing or not a string/integer")
        else:
            values[key] = str(current)[:10] if key == "as_of" else str(current)
        sources[key] = f"current-state.json {path}" + ("[:10]" if key == "as_of" else "")
    try:
        values["repo_max_migration"] = str(repository_max_migration(migrations_dir))
    except (OSError, ValueError) as error:
        failures.append(f"migrations/ (code): {error}")
    sources["repo_max_migration"] = "migrations/ (code)"
    cases = progress.get("cases", []) if isinstance(progress, dict) else []
    cases = cases if isinstance(cases, list) else []
    passed_ids = {case.get("id") for case in cases if isinstance(case, dict)
                  and isinstance(case.get("id"), str) and case.get("status") == "passed"}
    milestones = progress.get("milestones", {}) if isinstance(progress, dict) else {}
    milestones = milestones if isinstance(milestones, dict) else {}
    m1 = milestones.get("M1", {})
    m1_cases = m1.get("cases", []) if isinstance(m1, dict) else []
    m1_cases = m1_cases if isinstance(m1_cases, list) else []
    baseline = trace.get("acceptance", []) if isinstance(trace, dict) else []
    full_cases = [case["id"] for case in baseline if isinstance(case, dict) and isinstance(case.get("id"), str)] if isinstance(baseline, list) else []
    for key, milestone, ids in (("accepted_m1", "M1", m1_cases), ("accepted_full", "full", full_cases)):
        values[key] = str(accepted[milestone]).lower()
        count = sum(isinstance(case_id, str) and case_id in passed_ids for case_id in ids)
        sources[key] = f"acceptance-progress.json ({count} of {len(ids)} {milestone} cases passed)"
    return values, sources, failures


def render_status_line(state, trace, progress, migrations_dir=MIGRATIONS):
    values, sources, failures = status_values(state, trace, progress, migrations_dir)
    if failures:
        raise ValueError("; ".join(failures))
    return "<!-- glp-status: " + " ".join(f"{key}={values[key]}" for key in STATUS_KEYS) + " -->"


def status_failures(readme, state, trace, progress, migrations_dir=MIGRATIONS):
    expected_values, sources, failures = status_values(state, trace, progress, migrations_dir)
    lines = STATUS_LINE.findall(readme)
    if len(lines) != 1:
        return failures + [f"README must contain exactly one glp-status line, found {len(lines)}"]
    tokens = lines[0].split()
    parsed_tokens = {}
    for token in tokens:
        if "=" not in token:
            failures.append(f"README glp-status token '{token}' is not key=value")
            continue
        key, value = token.split("=", 1)
        if not key or not value:
            failures.append(f"README glp-status token '{token}' is not key=value")
            continue
        if key in parsed_tokens:
            failures.append(f"README glp-status repeats key {key}")
        elif key not in STATUS_KEYS:
            failures.append(f"README glp-status has unknown key {key}")
        else:
            parsed_tokens[key] = value

    for key in STATUS_KEYS:
        if key not in parsed_tokens:
            failures.append(f"README glp-status is missing key {key}")

    for key, parsed_val in parsed_tokens.items():
        if key in expected_values:
            expected = expected_values[key]
            if parsed_val != expected:
                source_str = sources[key]
                failures.append(f"README glp-status {key}={parsed_val} but {source_str} is {expected}; update the README 目前狀態 section and its glp-status line together with its sources")

    headings = re.findall(r"^## 目前狀態$", readme, re.M)
    if len(headings) != 1:
        failures.append(f"README must contain exactly one \"## 目前狀態\" heading, found {len(headings)}")
    else:
        match = re.search(r"^## 目前狀態$(.*?)(?=^## |\Z)", readme, re.M | re.S)
        if match:
            section_text = match.group(1)
            if not STATUS_LINE.search(section_text):
                failures.append("README glp-status line must be inside the 目前狀態 section")
            else:
                text_without_status = STATUS_LINE.sub("", section_text)
                for key in ("release.production", "release.staging"):
                    if key in expected_values:
                        prefix = expected_values[key][:8]
                        if prefix not in text_without_status:
                            failures.append(f"README 目前狀態 section must name {prefix} (current-state.json {STATUS_SOURCES[key]}) outside the glp-status line")

    return failures


def validate():
    failures = []
    d = json.loads((HERE / "traceability.json").read_text())
    by = {}
    for key, prefix, count, digits in [
        ("decisions", "D", 22, 2), ("requirements", "R", 64, 3),
        ("acceptance", "T", 60, 3), ("specs", "SP", 13, 2)
    ]:
        ids = [x["id"] for x in d[key]]
        expected = {f"{prefix}-{i:0{digits}}" for i in range(0 if prefix == "SP" else 1, count if prefix == "SP" else count + 1)}
        if set(ids) != expected or len(ids) != count:
            failures.append(f"{key}: wrong, duplicate or missing IDs")
        by[key] = {x["id"]: x for x in d[key]}
    payload = {
        "decisions": [{k: x[k] for k in ["id", "statement", "forbidden_interpretation", "requirement_ids"]} for x in d["decisions"]],
        "requirements": [{k: x[k] for k in ["id", "statement", "source_chapters", "decision_ids", "spec", "acceptance_ids"]} for x in d["requirements"]],
        "acceptance": [{k: x[k] for k in ["id", "scenario", "expected", "requirement_ids"]} for x in d["acceptance"]]
    }
    actual = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if actual != EXPECTED_BASELINE or d.get("source_baseline_digest") != EXPECTED_BASELINE:
        failures.append("source D/R/T/chapters differ from reconciled original planning baseline")
    source_ids = {x["id"] for x in d["sources"]}
    if len(source_ids) != 27:
        failures.append("source index must contain all 27 supplied public S/W sources")
    for r in d["requirements"]:
        if not set(r["source_refs"]).issubset(source_ids):
            failures.append(f"{r['id']}: undefined source reference")
        if r["status"] != "planned" or r.get("evidence") != []:
            failures.append(f"{r['id']}: spec PR must not claim product evidence")
        if r["spec"] not in by["specs"] or r["spec_path"] != by["specs"][r["spec"]]["path"]:
            failures.append(f"{r['id']}: invalid owner spec")
        if not r["decision_ids"] or not r["acceptance_ids"]:
            failures.append(f"{r['id']}: missing decisions or tests")
        for dec in r["decision_ids"]:
            if dec not in by["decisions"] or r["id"] not in by["decisions"][dec]["requirement_ids"]:
                failures.append(f"{r['id']}: asymmetric decision {dec}")
        for case in r["acceptance_ids"]:
            if case not in by["acceptance"] or r["id"] not in by["acceptance"][case]["requirement_ids"]:
                failures.append(f"{r['id']}: asymmetric test {case}")
        for path in r["existing_files"]:
            if not (ROOT / path).is_file():
                failures.append(f"{r['id']}: nonexistent current file {path}")
        for ref in r["existing_ledger_refs"] + r["foundation_refs"]:
            p = ROOT / ref["path"]
            if not p.is_file() or ref["id"] not in p.read_text():
                failures.append(f"{r['id']}: invented ledger reference {ref}")
    for dec in d["decisions"]:
        rs = [r for r in d["requirements"] if dec["id"] in r["decision_ids"]]
        if not rs or dec["requirement_ids"] != [r["id"] for r in rs]:
            failures.append(f"{dec['id']}: incomplete requirement edges")
        if dec["spec_ids"] != sorted({r["spec"] for r in rs}) or dec["acceptance_ids"] != sorted({t for r in rs for t in r["acceptance_ids"]}):
            failures.append(f"{dec['id']}: incomplete spec/test edges")
    for t in d["acceptance"]:
        if t["status"] != "not_run" or t.get("evidence") != [] or t.get("exact_source") is not None or t.get("environment") is not None:
            failures.append(f"{t['id']}: future acceptance must remain not_run with no evidence")
        if not t["requirement_ids"]:
            failures.append(f"{t['id']}: orphan")
        for rid in t["requirement_ids"]:
            if rid not in by["requirements"] or t["id"] not in by["requirements"][rid]["acceptance_ids"]:
                failures.append(f"{t['id']}: asymmetric requirement {rid}")
        file, anchor = t["procedure"].split("#")
        if f'id="{anchor}"' not in (HERE / file).read_text():
            failures.append(f"{t['id']}: procedure anchor absent")
    for spec in d["specs"]:
        p = HERE / spec["path"]
        if not p.is_file():
            failures.append(f"{spec['id']}: missing spec file")
            continue
        text = p.read_text()
        headings = re.findall(r"^## (\d+)\.", text, re.M)
        if headings != [str(i) for i in range(1, 11)]:
            failures.append(f"{spec['id']}: expected ten ordered sections, got {headings}")
        if d["source_commit"] not in text:
            failures.append(f"{spec['id']}: missing exact source pin")
        for dep in spec["dependencies"]:
            if dep not in by["specs"] or dep == spec["id"]:
                failures.append(f"{spec['id']}: invalid dependency {dep}")
    links = 0
    for p in HERE.glob("*.md"):
        text = p.read_text()
        for raw in re.findall(r"(?<!!)\[[^\]\n]*\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)", text):
            target = raw.split("#", 1)[0]
            if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("/"):
                continue
            links += 1
            if not (p.parent / unquote(target)).exists():
                failures.append(f"{p.name}: missing local link {raw}")
    readme_text = (HERE / "README.md").read_text(encoding="utf-8")
    progress_data = {}
    if PROGRESS.is_file():
        try:
            progress_data = json.loads(PROGRESS.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            failures.append("invalid acceptance-progress.json")
    else:
        failures.append("missing acceptance-progress.json")
    if CURRENT_STATE.is_file():
        state_data = json.loads(CURRENT_STATE.read_text(encoding="utf-8"))
        failures.extend(status_failures(readme_text, state_data, d, progress_data))
    else:
        failures.append("missing docs/platform-plan/execution/unified-foundation/current-state.json")
    for failure in failures:
        print("FAIL:", failure)
    print(f"22 decisions; 64 requirements; 60 planned acceptances; 13 specs; {sum(len(r['acceptance_ids']) for r in d['requirements'])} R/T edges; {links} local links; {len(failures)} failures")
    print("Documentation only: no product acceptance, runtime, authorization, deployment or external-link verification is implied.")
    print("README glp-status compared with migrations/ (code), unified-foundation/current-state.json (operator observations, the deployment record) and acceptance-progress.json.")
    return bool(failures)


if __name__ == "__main__":
    if sys.argv[1:] == ["--write-status"]:
        readme_path = HERE / "README.md"
        readme = readme_path.read_text(encoding="utf-8")
        if len(STATUS_LINE.findall(readme)) != 1:
            print("FAIL: README must contain exactly one glp-status line")
            sys.exit(1)
        try:
            line = render_status_line(
                json.loads(CURRENT_STATE.read_text(encoding="utf-8")),
                json.loads((HERE / "traceability.json").read_text(encoding="utf-8")),
                json.loads(PROGRESS.read_text(encoding="utf-8"))
            )
        except (OSError, ValueError) as error:
            print("FAIL:", error)
            sys.exit(1)
        updated = STATUS_LINE.sub(lambda match: line, readme)
        if updated != readme:
            readme_path.write_text(updated, encoding="utf-8")
        print(line)
        sys.exit(0)
    if sys.argv[1:]:
        print("Usage: validate-spec-pack.py [--write-status]")
        sys.exit(1)
    sys.exit(validate())
