"""FW-07: execution package DAG validator tests (static only).

Acceptance (first-work-batch FW-07 / 06 §5 / milestones Package 依賴表):
  - suffix-aware IDs (INT-03A / INT-03B) are distinct valid package IDs
  - canonical 56-ID exact set
  - unique primary milestone per package
  - dangling, self-edge, and cycle detection
  - canonical dependency table passes; intentional fixtures fail
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from check_package_dag import (  # noqa: E402
    CANONICAL_PACKAGE_IDS,
    DEFAULT_MILESTONES,
    find_cycles,
    is_package_id,
    load_package_dag,
    parse_depends_cell,
    validate_milestones_file,
    validate_package_dag,
)

EXECUTION = TOOLS.parent
MILESTONES = EXECUTION / "milestones.md"


@pytest.fixture(scope="module")
def canonical_dag():
    text = MILESTONES.read_text(encoding="utf-8")
    dag, dups = load_package_dag(text)
    return dag, dups


def _codes(issues) -> set[str]:
    return {i.code for i in issues}


def test_canonical_inventory_is_exactly_56():
    assert len(CANONICAL_PACKAGE_IDS) == 56
    assert "INT-03A" in CANONICAL_PACKAGE_IDS
    assert "INT-03B" in CANONICAL_PACKAGE_IDS
    assert "INT-03" not in CANONICAL_PACKAGE_IDS


def test_suffix_aware_package_ids():
    assert is_package_id("INT-03A")
    assert is_package_id("INT-03B")
    assert is_package_id("FND-01")
    assert is_package_id("INTK-01")
    assert is_package_id("INT-03")  # grammar-ok; not in canonical 56
    assert not is_package_id("int-03A")
    assert not is_package_id("FND-1")
    assert not is_package_id("FND-01A1")


def test_parse_depends_cell_none_and_list():
    assert parse_depends_cell("無") == []
    assert parse_depends_cell("—") == []
    assert parse_depends_cell("FND-01, FND-02") == ["FND-01", "FND-02"]
    assert parse_depends_cell("FND-03, FND-04, WRK-01, INT-03A") == [
        "FND-03",
        "FND-04",
        "WRK-01",
        "INT-03A",
    ]


def test_canonical_milestones_file_passes():
    assert MILESTONES.resolve() == DEFAULT_MILESTONES.resolve()
    issues = validate_milestones_file(MILESTONES)
    assert issues == [], [str(i) for i in issues]


def test_canonical_dag_exact_set_and_unique_primary(canonical_dag):
    dag, dups = canonical_dag
    assert dups == {}
    assert set(dag.depends_on) == CANONICAL_PACKAGE_IDS
    assert set(dag.primary_by_package) == CANONICAL_PACKAGE_IDS
    assert len(dag.primary_by_package) == 56
    # INT-03A / INT-03B have distinct primaries (M01 vs M02).
    assert dag.primary_by_package["INT-03A"] == "M01"
    assert dag.primary_by_package["INT-03B"] == "M02"
    # Conditional column must not inject hard edges (PRJ-01 → INT-03B).
    assert "INT-03B" not in dag.depends_on["PRJ-01"]
    assert dag.depends_on["PRJ-01"] == ["FND-01", "BLD-02", "INT-03A"]


def test_canonical_validate_helper_passes(canonical_dag):
    dag, dups = canonical_dag
    issues = validate_package_dag(
        primary_by_package=dag.primary_by_package,
        depends_on=dag.depends_on,
        primary_duplicates=dups,
    )
    assert issues == []


def test_dangling_fixture_fails(canonical_dag):
    dag, dups = canonical_dag
    depends = copy.deepcopy(dag.depends_on)
    depends["FND-02"] = depends["FND-02"] + ["NOPE-99"]
    issues = validate_package_dag(
        primary_by_package=dag.primary_by_package,
        depends_on=depends,
        primary_duplicates=dups,
    )
    assert "dangling" in _codes(issues)
    assert any("NOPE-99" in i.message for i in issues)


def test_cycle_fixture_fails(canonical_dag):
    dag, dups = canonical_dag
    depends = copy.deepcopy(dag.depends_on)
    # Introduce FND-01 → FND-02 → FND-01 (FND-02 already depends on FND-01).
    depends["FND-01"] = ["FND-02"]
    issues = validate_package_dag(
        primary_by_package=dag.primary_by_package,
        depends_on=depends,
        primary_duplicates=dups,
    )
    assert "cycle" in _codes(issues)
    cycles = find_cycles(depends)
    assert cycles, "expected at least one cycle"
    assert any(
        set(c[:-1]) == {"FND-01", "FND-02"} or set(c) >= {"FND-01", "FND-02"}
        for c in cycles
    )


def test_self_edge_fixture_fails(canonical_dag):
    dag, dups = canonical_dag
    depends = copy.deepcopy(dag.depends_on)
    depends["STA-01"] = ["STA-01"]
    issues = validate_package_dag(
        primary_by_package=dag.primary_by_package,
        depends_on=depends,
        primary_duplicates=dups,
    )
    assert "self_edge" in _codes(issues)
    assert any("STA-01" in i.message for i in issues if i.code == "self_edge")


def test_missing_canonical_id_fails(canonical_dag):
    dag, dups = canonical_dag
    depends = copy.deepcopy(dag.depends_on)
    primary = copy.deepcopy(dag.primary_by_package)
    del depends["MED-02"]
    del primary["MED-02"]
    issues = validate_package_dag(
        primary_by_package=primary,
        depends_on=depends,
        primary_duplicates=dups,
    )
    assert "exact_set" in _codes(issues)
    assert any("MED-02" in i.message for i in issues)


def test_duplicate_primary_milestone_fails(canonical_dag):
    dag, _dups = canonical_dag
    issues = validate_package_dag(
        primary_by_package=dag.primary_by_package,
        depends_on=dag.depends_on,
        primary_duplicates={"FND-01": ["M00", "M01"]},
    )
    assert "unique_primary" in _codes(issues)
    assert any("FND-01" in i.message for i in issues)


def test_int03_suffix_pair_are_separate_nodes(canonical_dag):
    dag, dups = canonical_dag
    assert "INT-03A" in dag.depends_on
    assert "INT-03B" in dag.depends_on
    assert "INT-03A" in dag.depends_on["INT-03B"]
    assert "INT-03B" not in dag.depends_on["INT-03A"]
    issues = validate_package_dag(
        primary_by_package=dag.primary_by_package,
        depends_on=dag.depends_on,
        primary_duplicates=dups,
    )
    assert issues == []
