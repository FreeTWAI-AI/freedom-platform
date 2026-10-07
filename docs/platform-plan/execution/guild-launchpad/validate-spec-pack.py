"""Read-only planning-document checks; never executes or accepts product T cases."""
from pathlib import Path
import hashlib
import json
import re
import sys
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
EXPECTED_BASELINE = "11183364845c0d46b29fa52f5cc25f5c3ebce43cc3ff33662ef37d880b583c69"


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
    for failure in failures:
        print("FAIL:", failure)
    print(f"22 decisions; 64 requirements; 60 planned acceptances; 13 specs; {sum(len(r['acceptance_ids']) for r in d['requirements'])} R/T edges; {links} local links; {len(failures)} failures")
    print("Documentation only: no product acceptance, runtime, authorization, deployment or external-link verification is implied.")
    return bool(failures)


if __name__ == "__main__":
    sys.exit(validate())
