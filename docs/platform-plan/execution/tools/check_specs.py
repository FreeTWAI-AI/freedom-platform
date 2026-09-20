"""FW-08: M00–M02 spec-template linter (static markdown checks only).

Reads ``execution/spec-index.md`` and ``execution/specs/*.md`` and checks:
  - index ↔ file parity (M00–M02 linked rows only)
  - required template sections
  - source markdown link in 「來源與需求 ID」
  - owner and milestone metadata
  - 「未跑」 test-command wording (reject claiming tests passed)
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

EXECUTION_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SPEC_INDEX = EXECUTION_DIR / "spec-index.md"
DEFAULT_SPECS_DIR = EXECUTION_DIR / "specs"

PACKAGE_ID_RE = re.compile(r"^[A-Z]{2,5}-\d{2}[A-Z]?$")
MILESTONE_RE = re.compile(r"^M0[0-2]$")
INDEX_LINK_RE = re.compile(
    r"\[([A-Z]{2,5}-\d{2}[A-Z]?)\]\(\./specs/([^)]+\.md)\)"
)
OWNER_RE = re.compile(r"owner＝([^／\|\n]+)")
MILESTONE_ROW_RE = re.compile(
    r"所屬\s*milestone／原\s*package\s*\|\s*(M\d{2})／`([^`]+)`"
)
HEADING_RE = re.compile(r"^## (.+)$", re.M)
SECTION_BODY_RE = re.compile(
    r"^## (.+?)\n(.*?)(?=^## |\Z)", re.M | re.S
)
MD_LINK_RE = re.compile(r"\[[^\]]+\]\([^)]+\)")

# Exact required H2 titles from the M00–M02 corpus template.
# Given–When–Then uses U+2013 EN DASH.
REQUIRED_SECTIONS: tuple[str, ...] = (
    "來源與需求 ID",
    "使用者結果與明確不包含",
    "Actor／principal／acting role／資源範圍",
    "既有 canonical entity／command／event／state／projection",
    "正常／異常／卡點／取消／補件／爭議／恢復",
    "授權／A4／independence／來源與版本綁定",
    "版本與獨立驗收",
    "冪等／業務唯一鍵／並發／fencing／lease／時間",
    "UI／CLI／MCP",
    "隱私／憑證／資料保留與 provider 邊界",
    "成本／可觀測性／timeout／retry／reconciliation",
    "遷移／相容性／rollback",
    "Given–When–Then",
    "實際測試命令（將來會這樣跑；未跑）",
    "缺 evidence 時的標籤／技術依賴",
    "完成證據",
)

TEST_SECTION_TITLE = "實際測試命令（將來會這樣跑；未跑）"
SOURCE_SECTION_TITLE = "來源與需求 ID"

# Phrases that claim the future test command already ran successfully.
_CLAIMED_PASS_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bpassed\b", re.I),
    re.compile(r"\bPASS(?:ED)?\b"),
    re.compile(r"測試通過"),
    re.compile(r"已通過"),
    re.compile(r"全部通過"),
    re.compile(r"結果[：:]\s*通過"),
    re.compile(r"pytest[^\n]*通過"),
    re.compile(r"已跑(?!）)"),  # 「已跑」 but not inside 「未跑」
    re.compile(r"exit(?:\s+code)?\s*[:=]?\s*0\b", re.I),
    re.compile(r"綠燈"),
)

_KNOWN_OWNERS = frozenset({"Ted", "Hao", "Mini", "Jason", "韋銘"})


@dataclass
class IndexEntry:
    package_id: str
    filename: str
    owner_cell: str
    source_cell: str
    milestone: str


@dataclass
class SpecDoc:
    path: Path
    package_id: str
    text: str
    headings: list[str] = field(default_factory=list)
    sections: dict[str, str] = field(default_factory=dict)
    owner: str | None = None
    milestone: str | None = None
    meta_package_id: str | None = None


@dataclass
class ValidationIssue:
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


def is_package_id(value: str) -> bool:
    return bool(PACKAGE_ID_RE.fullmatch(value))


def parse_m00_m02_index(text: str) -> list[IndexEntry]:
    """Parse M00–M02 rows that link to ``./specs/*.md``."""
    entries: list[IndexEntry] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        parts = [p.strip() for p in stripped.strip("|").split("|")]
        if len(parts) < 4:
            continue
        spec_cell, owner_cell, source_cell, milestone = (
            parts[0],
            parts[1],
            parts[2],
            parts[3],
        )
        if milestone not in ("M00", "M01", "M02"):
            continue
        match = INDEX_LINK_RE.search(spec_cell)
        if not match:
            continue
        package_id, filename = match.group(1), match.group(2)
        entries.append(
            IndexEntry(
                package_id=package_id,
                filename=filename,
                owner_cell=owner_cell,
                source_cell=source_cell,
                milestone=milestone,
            )
        )
    return entries


def parse_spec_doc(path: Path) -> SpecDoc:
    text = path.read_text(encoding="utf-8")
    package_id = path.stem
    headings = HEADING_RE.findall(text)
    sections = {title: body for title, body in SECTION_BODY_RE.findall(text)}
    owner = None
    om = OWNER_RE.search(text)
    if om:
        owner = om.group(1).strip()
    milestone = None
    meta_pkg = None
    mm = MILESTONE_ROW_RE.search(text)
    if mm:
        milestone, meta_pkg = mm.group(1), mm.group(2)
    return SpecDoc(
        path=path,
        package_id=package_id,
        text=text,
        headings=headings,
        sections=sections,
        owner=owner,
        milestone=milestone,
        meta_package_id=meta_pkg,
    )


def _claims_test_passed(test_body: str) -> list[str]:
    """Return matched claim fragments that assert tests already passed."""
    hits: list[str] = []
    # Normalize away the mandated 「未跑」 markers so 「已跑」 inside 「未跑」
    # is not treated as a claim; strip bold markers around 未跑.
    scrubbed = test_body.replace("**未跑**", "未跑").replace("未跑", "")
    for pat in _CLAIMED_PASS_RES:
        for m in pat.finditer(scrubbed):
            hits.append(m.group(0))
    return hits


def validate_spec_template(
    doc: SpecDoc,
    *,
    index_entry: IndexEntry | None = None,
) -> list[ValidationIssue]:
    """Validate one spec file against the M00–M02 template rules."""
    issues: list[ValidationIssue] = []
    pid = doc.package_id

    if not is_package_id(pid):
        issues.append(
            ValidationIssue("package_id", f"{doc.path.name}: malformed package ID")
        )

    present = set(doc.headings)
    for title in REQUIRED_SECTIONS:
        if title not in present:
            issues.append(
                ValidationIssue(
                    "missing_section",
                    f"{pid}: missing required section ## {title}",
                )
            )

    source_body = doc.sections.get(SOURCE_SECTION_TITLE, "")
    if SOURCE_SECTION_TITLE in present and not MD_LINK_RE.search(source_body):
        issues.append(
            ValidationIssue(
                "source_link",
                f"{pid}: 「來源與需求 ID」 has no markdown source link",
            )
        )

    if not doc.owner:
        issues.append(ValidationIssue("owner", f"{pid}: missing owner＝ metadata"))
    else:
        first = doc.owner.split("（", 1)[0].strip()
        if first not in _KNOWN_OWNERS:
            issues.append(
                ValidationIssue(
                    "owner",
                    f"{pid}: owner＝{doc.owner!r} is not a known five-person owner",
                )
            )

    if not doc.milestone:
        issues.append(
            ValidationIssue(
                "milestone",
                f"{pid}: missing 所屬 milestone／原 package metadata",
            )
        )
    else:
        if not MILESTONE_RE.fullmatch(doc.milestone):
            issues.append(
                ValidationIssue(
                    "milestone",
                    f"{pid}: milestone {doc.milestone!r} is not M00–M02",
                )
            )
        if doc.meta_package_id and doc.meta_package_id != pid:
            issues.append(
                ValidationIssue(
                    "milestone",
                    f"{pid}: metadata package {doc.meta_package_id!r} "
                    f"does not match filename",
                )
            )

    if index_entry is not None:
        if doc.milestone and doc.milestone != index_entry.milestone:
            issues.append(
                ValidationIssue(
                    "milestone",
                    f"{pid}: spec milestone {doc.milestone} != "
                    f"index milestone {index_entry.milestone}",
                )
            )
        # Index owner cell must name the same person as owner＝.
        if doc.owner:
            owner_first = doc.owner.split("（", 1)[0].strip()
            if owner_first not in index_entry.owner_cell:
                issues.append(
                    ValidationIssue(
                        "owner",
                        f"{pid}: owner＝{owner_first} not found in index owner cell",
                    )
                )

    if TEST_SECTION_TITLE in present:
        test_body = doc.sections.get(TEST_SECTION_TITLE, "")
        # Heading already embeds 未跑; body must also mark commands as 未跑.
        if "未跑" not in test_body and "未跑" not in TEST_SECTION_TITLE:
            issues.append(
                ValidationIssue(
                    "test_wording",
                    f"{pid}: test-command section missing 「未跑」 wording",
                )
            )
        elif "未跑" not in test_body:
            # Heading has 未跑 (required title), but body should also say 未跑
            # per global cross-spec constraint / corpus convention.
            issues.append(
                ValidationIssue(
                    "test_wording",
                    f"{pid}: test-command body missing 「未跑」 wording",
                )
            )
        claims = _claims_test_passed(test_body)
        if claims:
            issues.append(
                ValidationIssue(
                    "test_passed_claim",
                    f"{pid}: test-command section claims tests passed "
                    f"({', '.join(sorted(set(claims)))})",
                )
            )

    return issues


def validate_specs(
    *,
    index_text: str,
    specs_dir: Path,
) -> list[ValidationIssue]:
    """Full FW-08 validation: parity + per-spec template checks."""
    issues: list[ValidationIssue] = []
    entries = parse_m00_m02_index(index_text)
    by_id = {e.package_id: e for e in entries}

    if len(entries) != len(by_id):
        seen: set[str] = set()
        for e in entries:
            if e.package_id in seen:
                issues.append(
                    ValidationIssue(
                        "index_parity",
                        f"duplicate M00–M02 index entry for {e.package_id}",
                    )
                )
            seen.add(e.package_id)

    if not specs_dir.is_dir():
        issues.append(
            ValidationIssue("missing_file", f"specs directory missing: {specs_dir}")
        )
        return issues

    disk_files = sorted(p for p in specs_dir.glob("*.md") if p.is_file())
    disk_by_name = {p.name: p for p in disk_files}
    disk_ids = {p.stem for p in disk_files}
    index_ids = set(by_id)
    index_filenames = {e.filename for e in entries}

    missing = sorted(index_ids - disk_ids)
    for pid in missing:
        entry = by_id[pid]
        issues.append(
            ValidationIssue(
                "missing_file",
                f"index lists {pid} → specs/{entry.filename} but file is missing",
            )
        )

    orphans = sorted(disk_ids - index_ids)
    for pid in orphans:
        issues.append(
            ValidationIssue(
                "orphan_spec",
                f"specs/{pid}.md exists but is not a linked M00–M02 index entry",
            )
        )

    for entry in entries:
        if entry.filename != f"{entry.package_id}.md":
            issues.append(
                ValidationIssue(
                    "index_parity",
                    f"{entry.package_id}: index link filename "
                    f"{entry.filename!r} != {entry.package_id}.md",
                )
            )
        path = disk_by_name.get(entry.filename)
        if path is None:
            continue
        doc = parse_spec_doc(path)
        issues.extend(validate_spec_template(doc, index_entry=entry))

    # Orphan files still get template checks so failures are visible.
    for pid in orphans:
        path = disk_by_name.get(f"{pid}.md")
        if path is not None:
            doc = parse_spec_doc(path)
            issues.extend(validate_spec_template(doc, index_entry=None))

    # Filename present in index but wrong name mapping already covered;
    # also catch index filename pointing at a different stem.
    for entry in entries:
        if entry.filename in disk_by_name and entry.filename not in index_filenames:
            pass  # unreachable
        if (
            entry.filename in disk_by_name
            and Path(entry.filename).stem != entry.package_id
        ):
            issues.append(
                ValidationIssue(
                    "index_parity",
                    f"{entry.package_id}: link target stem mismatch",
                )
            )

    return issues


def validate_execution_specs(
    index_path: Path | str = DEFAULT_SPEC_INDEX,
    specs_dir: Path | str = DEFAULT_SPECS_DIR,
) -> list[ValidationIssue]:
    """Load index + specs directory and run full validation."""
    index_path = Path(index_path)
    specs_dir = Path(specs_dir)
    text = index_path.read_text(encoding="utf-8")
    return validate_specs(index_text=text, specs_dir=specs_dir)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="FW-08: lint M00–M02 execution specs against template"
    )
    parser.add_argument(
        "--index",
        default=str(DEFAULT_SPEC_INDEX),
        help="path to spec-index.md",
    )
    parser.add_argument(
        "--specs-dir",
        default=str(DEFAULT_SPECS_DIR),
        help="path to execution/specs/",
    )
    args = parser.parse_args(argv)
    issues = validate_execution_specs(args.index, args.specs_dir)
    if not issues:
        entries = parse_m00_m02_index(Path(args.index).read_text(encoding="utf-8"))
        print(
            f"OK: {len(entries)} M00–M02 specs, "
            "index/file parity, required sections, "
            "source link/owner/milestone, 未跑 test wording"
        )
        return 0
    print(f"FAIL: {len(issues)} issue(s)", file=sys.stderr)
    for issue in issues:
        print(f"  - {issue}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
