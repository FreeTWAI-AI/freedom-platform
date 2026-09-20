"""FW-07: execution package DAG validator (static markdown checks only).

Reads ``execution/milestones.md`` Package 主 bundle 清單 + Package 依賴表
and checks against the frozen 56-package inventory (06 §4 / milestones).

Suffix-aware IDs (e.g. INT-03A / INT-03B) are first-class package IDs.
Conditional runtime deps (third column) are NOT hard DAG edges.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_ID_RE = re.compile(r"^[A-Z]{2,5}-\d{2}[A-Z]?$")
PACKAGE_ID_FIND_RE = re.compile(r"\b([A-Z]{2,5}-\d{2}[A-Z]?)\b")

# Frozen inventory from 06 §4 / milestones Package 主 bundle 清單 (exact 56).
# Package IDs are not renumbered; INT-03A and INT-03B are distinct.
CANONICAL_PACKAGE_IDS: frozenset[str] = frozenset(
    {
        "FND-01",
        "FND-02",
        "FND-03",
        "FND-04",
        "FND-05",
        "FND-06",
        "ORG-01",
        "ORG-02",
        "ORG-03",
        "WRK-01",
        "WRK-02",
        "AGT-01",
        "AGT-02",
        "AGT-03",
        "AGT-04",
        "AGT-05",
        "ONB-01",
        "BLD-01",
        "BLD-02",
        "BLD-03",
        "BLD-04",
        "BLD-05",
        "PRJ-01",
        "PRJ-02",
        "POS-01",
        "POS-02",
        "COA-01",
        "COA-02",
        "INTK-01",
        "INT-01",
        "INT-02",
        "INT-03A",
        "INT-03B",
        "ACT-01",
        "SKL-01",
        "SKL-02",
        "SKL-03",
        "QLT-01",
        "QLT-02",
        "SRV-01",
        "SRV-02",
        "OPP-01",
        "CAT-01",
        "CAT-02",
        "CAT-03",
        "STF-01",
        "ORD-01",
        "PAY-01",
        "PAY-02",
        "PAY-03",
        "PAY-04",
        "MKT-01",
        "MKT-02",
        "MED-01",
        "MED-02",
        "STA-01",
    }
)

assert len(CANONICAL_PACKAGE_IDS) == 56

DEFAULT_MILESTONES = Path(__file__).resolve().parents[1] / "milestones.md"

_NONE_DEPS = frozenset({"無", "—", "-", "", "n/a", "N/A", "none", "None"})


@dataclass
class PackageDag:
    """Parsed hard DAG + unique primary milestone assignment."""

    primary_by_package: dict[str, str] = field(default_factory=dict)
    depends_on: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class ValidationIssue:
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


def is_package_id(value: str) -> bool:
    """True iff value is a suffix-aware package ID (INT-03A/B included)."""
    return bool(PACKAGE_ID_RE.fullmatch(value))


def parse_depends_cell(cell: str) -> list[str]:
    """Parse the depends_on cell; ``無`` / em-dash mean no hard edges."""
    raw = cell.strip()
    if raw in _NONE_DEPS:
        return []
    found = PACKAGE_ID_FIND_RE.findall(raw)
    seen: set[str] = set()
    out: list[str] = []
    for pid in found:
        if pid not in seen:
            seen.add(pid)
            out.append(pid)
    return out


def parse_primary_milestones_detailed(
    text: str,
) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Return (primary_by_package, duplicates_map)."""
    match = re.search(
        r"## Package 主 bundle 清單\s*\n(.*?)(?=\n## |\Z)",
        text,
        re.S,
    )
    if not match:
        raise ValueError("milestones.md missing '## Package 主 bundle 清單' section")
    body = match.group(1)
    assignments: dict[str, list[str]] = {}
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        parts = [p.strip() for p in stripped.strip("|").split("|")]
        if len(parts) < 3:
            continue
        bundle, pkgs_cell = parts[0], parts[2]
        if not re.fullmatch(r"M\d{2}", bundle):
            continue
        for pid in PACKAGE_ID_FIND_RE.findall(pkgs_cell):
            assignments.setdefault(pid, []).append(bundle)
    flat = {pid: bundles[0] for pid, bundles in assignments.items()}
    dups = {pid: list(b) for pid, b in assignments.items() if len(b) > 1}
    return flat, dups


def parse_primary_milestones(text: str) -> dict[str, str]:
    """Map each package to its unique primary bundle (M00–M09)."""
    flat, _dups = parse_primary_milestones_detailed(text)
    return flat


def parse_dependency_table(text: str) -> dict[str, list[str]]:
    """Parse hard depends_on edges from Package 依賴表 (column 2 only)."""
    match = re.search(
        r"## Package 依賴表\s*\n(.*?)(?=\n自查標準|\n## |\Z)",
        text,
        re.S,
    )
    if not match:
        raise ValueError("milestones.md missing '## Package 依賴表' section")
    body = match.group(1)
    deps: dict[str, list[str]] = {}
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        parts = [p.strip() for p in stripped.strip("|").split("|")]
        if len(parts) < 2:
            continue
        pkg = parts[0]
        if not is_package_id(pkg):
            continue
        deps[pkg] = parse_depends_cell(parts[1])
    return deps


def load_package_dag(milestones_text: str) -> tuple[PackageDag, dict[str, list[str]]]:
    """Parse milestones markdown into a PackageDag plus primary duplicates."""
    primary, dups = parse_primary_milestones_detailed(milestones_text)
    depends = parse_dependency_table(milestones_text)
    return PackageDag(primary_by_package=primary, depends_on=depends), dups


def find_cycles(depends_on: dict[str, list[str]]) -> list[list[str]]:
    """Return simple cycles as lists of package IDs (each unique cycle once)."""
    cycles: list[list[str]] = []
    seen_cycle_keys: set[tuple[str, ...]] = set()
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {n: WHITE for n in depends_on}
    for dep_list in depends_on.values():
        for d in dep_list:
            color.setdefault(d, WHITE)
    path: list[str] = []
    index_of: dict[str, int] = {}

    def dfs(node: str) -> None:
        color[node] = GRAY
        index_of[node] = len(path)
        path.append(node)
        for nxt in depends_on.get(node, []):
            if color.get(nxt, WHITE) == WHITE:
                dfs(nxt)
            elif color.get(nxt) == GRAY:
                start = index_of[nxt]
                cycle = path[start:] + [nxt]
                body = cycle[:-1]
                rot = min(range(len(body)), key=lambda i: body[i:])
                key = tuple(body[rot:] + body[:rot])
                if key not in seen_cycle_keys:
                    seen_cycle_keys.add(key)
                    cycles.append(cycle)
        path.pop()
        index_of.pop(node, None)
        color[node] = BLACK

    for node in list(color):
        if color[node] == WHITE:
            dfs(node)
    return cycles


def validate_package_dag(
    *,
    primary_by_package: dict[str, str],
    depends_on: dict[str, list[str]],
    primary_duplicates: dict[str, list[str]] | None = None,
    canonical_ids: frozenset[str] = CANONICAL_PACKAGE_IDS,
) -> list[ValidationIssue]:
    """Validate inventory exact-set, unique primary, dangling, self-edge, cycle."""
    issues: list[ValidationIssue] = []
    primary_duplicates = primary_duplicates or {}

    dep_ids = set(depends_on)
    primary_ids = set(primary_by_package)

    if len(canonical_ids) != 56:
        issues.append(
            ValidationIssue(
                "exact_set",
                f"canonical inventory size is {len(canonical_ids)}, expected 56",
            )
        )

    if dep_ids != set(canonical_ids):
        missing = sorted(set(canonical_ids) - dep_ids)
        extra = sorted(dep_ids - set(canonical_ids))
        if missing:
            issues.append(
                ValidationIssue(
                    "exact_set",
                    f"dependency table missing canonical IDs: {missing}",
                )
            )
        if extra:
            issues.append(
                ValidationIssue(
                    "exact_set",
                    f"dependency table has non-canonical IDs: {extra}",
                )
            )

    if primary_ids != set(canonical_ids):
        missing = sorted(set(canonical_ids) - primary_ids)
        extra = sorted(primary_ids - set(canonical_ids))
        if missing:
            issues.append(
                ValidationIssue(
                    "exact_set",
                    f"primary milestone list missing canonical IDs: {missing}",
                )
            )
        if extra:
            issues.append(
                ValidationIssue(
                    "exact_set",
                    f"primary milestone list has non-canonical IDs: {extra}",
                )
            )

    for pid, bundles in sorted(primary_duplicates.items()):
        issues.append(
            ValidationIssue(
                "unique_primary",
                f"{pid} has multiple primary milestones: {bundles}",
            )
        )

    for pid in sorted(dep_ids | primary_ids | set(canonical_ids)):
        if not is_package_id(pid):
            issues.append(
                ValidationIssue("package_id", f"malformed package ID: {pid!r}")
            )

    for pkg, deps in sorted(depends_on.items()):
        for dep in deps:
            if not is_package_id(dep):
                issues.append(
                    ValidationIssue(
                        "package_id",
                        f"{pkg} depends on malformed ID: {dep!r}",
                    )
                )
                continue
            if dep == pkg:
                issues.append(
                    ValidationIssue("self_edge", f"{pkg} depends on itself")
                )
                continue
            if dep not in dep_ids:
                issues.append(
                    ValidationIssue(
                        "dangling",
                        f"{pkg} depends on unknown package {dep}",
                    )
                )

    for cycle in find_cycles(depends_on):
        issues.append(ValidationIssue("cycle", " → ".join(cycle)))

    return issues


def validate_milestones_file(path: Path | str) -> list[ValidationIssue]:
    """Load milestones.md and run full DAG validation."""
    text = Path(path).read_text(encoding="utf-8")
    dag, dups = load_package_dag(text)
    return validate_package_dag(
        primary_by_package=dag.primary_by_package,
        depends_on=dag.depends_on,
        primary_duplicates=dups,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="FW-07: validate execution package dependency DAG"
    )
    parser.add_argument(
        "milestones",
        nargs="?",
        default=str(DEFAULT_MILESTONES),
        help="path to milestones.md (default: sibling execution/milestones.md)",
    )
    args = parser.parse_args(argv)
    issues = validate_milestones_file(args.milestones)
    if not issues:
        print(
            f"OK: {len(CANONICAL_PACKAGE_IDS)} packages, "
            "unique primary milestones, no dangling/self-edge/cycle"
        )
        return 0
    print(f"FAIL: {len(issues)} issue(s)", file=sys.stderr)
    for issue in issues:
        print(f"  - {issue}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
