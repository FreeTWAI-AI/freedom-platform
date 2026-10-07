"""Fail-closed JUnit evidence for the pinned contracts suite (stdlib only)."""
import argparse
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import PurePosixPath


def normalize_file(value):
    if not isinstance(value, str) or not value or "\0" in value:
        raise ValueError()
    value = value.replace("\\", "/")
    if value.startswith("/") or re.match(r"^[A-Za-z]:", value) or ".." in value.split("/"):
        raise ValueError()
    path = str(PurePosixPath(value))
    if path == ".":
        raise ValueError()
    return path


def evaluate(junit_path, expected_files_json):
    def fail(reason):
        return {"ok": False, "reason": reason}

    try:
        with open(expected_files_json, encoding="utf-8") as stream:
            expected = json.load(stream)
        if not isinstance(expected, list) or not all(isinstance(item, str) for item in expected):
            return fail("invalid_expected_files")
        expected_files = {normalize_file(item) for item in expected}
        if not expected_files or len(expected_files) != len(expected):
            return fail("invalid_expected_files")
    except Exception:
        return fail("invalid_expected_files")

    try:
        with open(junit_path, "rb") as stream:
            xml = stream.read(16 * 1024 * 1024 + 1)
        if len(xml) > 16 * 1024 * 1024:
            return fail("junit_xml_too_large")
        root = ET.fromstring(xml)
    except OSError:
        return fail("missing_junit_xml")
    except Exception:
        return fail("invalid_junit_xml")

    if root.tag not in ("testsuites", "testsuite"):
        return fail("invalid_junit_xml")
    testcases = list(root.iter("testcase"))
    if any(child.tag in ("failure", "error", "skipped") for tc in testcases for child in tc):
        return fail("testcase_not_passed")
    suites = list(root.iter("testsuite"))
    if not suites:
        return fail("invalid_suite_totals")
    for suite in suites:
        count = len(list(suite.iter("testcase")))
        if suite.get("tests") != str(count):
            return fail("invalid_suite_totals")
        if any(suite.get(key, "0") != "0" for key in ("errors", "failures", "skipped")):
            return fail("invalid_suite_totals")
    if root.tag == "testsuites" and root.get("tests") is not None and root.get("tests") != str(len(testcases)):
        return fail("invalid_suite_totals")

    files, identities = {}, set()
    for tc in testcases:
        try:
            path = normalize_file(tc.get("file"))
        except ValueError:
            return fail("invalid_file_attribute")
        if path not in expected_files:
            return fail("unexpected_file")
        classname, name = tc.get("classname", ""), tc.get("name", "")
        if "\0" in classname or "\0" in name:
            return fail("invalid_case_identity")
        identity = f"{path}\0{classname}\0{name}"
        if identity in identities:
            return fail("duplicate_case_identity")
        identities.add(identity)
        entry = files.setdefault(path, {"path": path, "tests": 0, "passed": 0, "cases": []})
        entry["tests"] += 1
        entry["passed"] += 1
        entry["cases"].append({"case_sha256": hashlib.sha256(identity.encode("utf-8")).hexdigest(), "status": "passed"})
    if any(path not in files for path in expected_files):
        return fail("missing_or_empty_file")
    return {"ok": True, "reason": "tests_executed", "files": sorted(files.values(), key=lambda entry: entry["path"]), "total": len(testcases)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--junit", required=True)
    parser.add_argument("--expected", required=True)
    args = parser.parse_args()
    result = evaluate(args.junit, args.expected)
    print(json.dumps(result))
    sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
