"""FW-08: M00–M02 spec-template linter tests (static only).

Acceptance (first-work-batch FW-08 / spec-index Global cross-spec constraints):
  - index/file parity for 21 M00–M02 linked specs
  - required sections, source link, owner, milestone
  - 「未跑」 test-command wording; claiming test passed fails
  - missing section / orphan spec / missing file fail
  - current corpus passes
"""

from __future__ import annotations

import sys
import textwrap
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from check_specs import (  # noqa: E402
    DEFAULT_SPEC_INDEX,
    DEFAULT_SPECS_DIR,
    REQUIRED_SECTIONS,
    IndexEntry,
    SpecDoc,
    parse_m00_m02_index,
    parse_spec_doc,
    validate_execution_specs,
    validate_spec_template,
    validate_specs,
)

EXECUTION = TOOLS.parent
SPEC_INDEX = EXECUTION / "spec-index.md"
SPECS_DIR = EXECUTION / "specs"


def _codes(issues) -> set[str]:
    return {i.code for i in issues}


def _minimal_spec(
    *,
    package_id: str = "FND-01",
    milestone: str = "M00",
    owner: str = "Ted（建議預設，五人共同閱讀確認）",
    omit_section: str | None = None,
    source_body: str | None = None,
    test_body: str | None = None,
    extra_sections: str = "",
) -> str:
    """Build a minimal valid-ish spec markdown for negative fixtures."""
    if source_body is None:
        source_body = (
            "[`06 §4.1`](../../06-delivery-plan.md)；RQ-041。\n"
        )
    if test_body is None:
        test_body = (
            "以下為 future command。\n\n"
            "```bash\npytest -q nowhere.py\n```\n\n"
            "以上命令**未跑**，沒有結果可報。\n"
        )

    sections: list[tuple[str, str]] = []
    for title in REQUIRED_SECTIONS:
        if title == omit_section:
            continue
        if title == "來源與需求 ID":
            body = source_body
        elif title == "實際測試命令（將來會這樣跑；未跑）":
            body = test_body
        elif title == "Given–When–Then":
            body = "- Given x；When y；Then z。\n"
        else:
            body = f"{title} placeholder content。\n"
        sections.append((title, body))

    parts = [
        f"# SPEC-{package_id} — fixture\n",
        "\n",
        "| 欄位 | 值 |\n",
        "| --- | --- |\n",
        f"| Spec ID／狀態 | `SPEC-{package_id}`／draft-ready |\n",
        f"| 所屬 milestone／原 package | {milestone}／`{package_id}` |\n",
        f"| Accountable role／implementation agent／AI reviewer／AI verifier | "
        f"Platform；owner＝{owner}／韋銘＋Codex／Grok／Claude |\n",
        "\n",
    ]
    for title, body in sections:
        parts.append(f"## {title}\n\n{body}\n")
    if extra_sections:
        parts.append(extra_sections)
    return "".join(parts)


@pytest.fixture(scope="module")
def index_entries():
    text = SPEC_INDEX.read_text(encoding="utf-8")
    return parse_m00_m02_index(text)


def test_defaults_point_at_execution_tree():
    assert SPEC_INDEX.resolve() == DEFAULT_SPEC_INDEX.resolve()
    assert SPECS_DIR.resolve() == DEFAULT_SPECS_DIR.resolve()


def test_required_sections_count_and_test_title():
    assert len(REQUIRED_SECTIONS) == 16
    assert "實際測試命令（將來會這樣跑；未跑）" in REQUIRED_SECTIONS
    assert "Given–When–Then" in REQUIRED_SECTIONS
    assert "來源與需求 ID" in REQUIRED_SECTIONS


def test_index_lists_exactly_21_m00_m02_linked_specs(index_entries):
    assert len(index_entries) == 21
    ids = {e.package_id for e in index_entries}
    assert len(ids) == 21
    assert "FND-01" in ids
    assert "INT-03A" in ids
    assert "INT-03B" in ids
    assert "AGT-03" not in ids  # M03+ has no file link
    milestones = {e.milestone for e in index_entries}
    assert milestones == {"M00", "M01", "M02"}


def test_canonical_corpus_passes():
    issues = validate_execution_specs(SPEC_INDEX, SPECS_DIR)
    assert issues == [], [str(i) for i in issues]


def test_disk_matches_index_filenames(index_entries):
    disk = sorted(p.name for p in SPECS_DIR.glob("*.md"))
    expected = sorted(e.filename for e in index_entries)
    assert disk == expected


def test_each_corpus_spec_has_owner_milestone_source(index_entries):
    by_id = {e.package_id: e for e in index_entries}
    for path in sorted(SPECS_DIR.glob("*.md")):
        doc = parse_spec_doc(path)
        entry = by_id[doc.package_id]
        issues = validate_spec_template(doc, index_entry=entry)
        assert issues == [], [str(i) for i in issues]
        assert doc.owner
        assert doc.milestone == entry.milestone
        assert doc.meta_package_id == doc.package_id


def test_missing_section_fails(tmp_path):
    text = _minimal_spec(omit_section="完成證據")
    path = tmp_path / "FND-01.md"
    path.write_text(text, encoding="utf-8")
    doc = parse_spec_doc(path)
    entry = IndexEntry(
        package_id="FND-01",
        filename="FND-01.md",
        owner_cell="Ted（Foundation）",
        source_cell="06",
        milestone="M00",
    )
    issues = validate_spec_template(doc, index_entry=entry)
    assert "missing_section" in _codes(issues)
    assert any("完成證據" in i.message for i in issues)


def test_missing_source_link_fails(tmp_path):
    text = _minimal_spec(source_body="RQ-041；ADR-062；無連結。\n")
    path = tmp_path / "FND-01.md"
    path.write_text(text, encoding="utf-8")
    doc = parse_spec_doc(path)
    issues = validate_spec_template(doc)
    assert "source_link" in _codes(issues)


def test_missing_owner_fails(tmp_path):
    text = _minimal_spec().replace("owner＝Ted（建議預設，五人共同閱讀確認）", "no-owner-here")
    path = tmp_path / "FND-01.md"
    path.write_text(text, encoding="utf-8")
    doc = parse_spec_doc(path)
    issues = validate_spec_template(doc)
    assert "owner" in _codes(issues)


def test_bad_milestone_fails(tmp_path):
    text = _minimal_spec(milestone="M03")
    path = tmp_path / "FND-01.md"
    path.write_text(text, encoding="utf-8")
    doc = parse_spec_doc(path)
    issues = validate_spec_template(doc)
    assert "milestone" in _codes(issues)


def test_claiming_test_passed_fails(tmp_path):
    text = _minimal_spec(
        test_body=(
            "```bash\npytest -q x.py\n```\n\n"
            "結果：全部通過，pytest passed。\n"
        )
    )
    path = tmp_path / "FND-01.md"
    path.write_text(text, encoding="utf-8")
    doc = parse_spec_doc(path)
    issues = validate_spec_template(doc)
    assert "test_passed_claim" in _codes(issues)


def test_missing_weipao_in_test_body_fails(tmp_path):
    text = _minimal_spec(
        test_body="```bash\npytest -q x.py\n```\n\n將來會跑。\n"
    )
    path = tmp_path / "FND-01.md"
    path.write_text(text, encoding="utf-8")
    doc = parse_spec_doc(path)
    issues = validate_spec_template(doc)
    assert "test_wording" in _codes(issues)


def test_orphan_spec_fails(tmp_path):
    specs = tmp_path / "specs"
    specs.mkdir()
    # Copy a valid corpus file as the only indexed one, plus an orphan.
    canonical = SPECS_DIR / "FND-01.md"
    (specs / "FND-01.md").write_text(
        canonical.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (specs / "ZZZ-99.md").write_text(
        _minimal_spec(package_id="ZZZ-99", milestone="M01"),
        encoding="utf-8",
    )
    index = textwrap.dedent(
        """\
        | spec／package | owner | 來源 | milestone | 狀態／跨模組契約 |
        | --- | --- | --- | --- | --- |
        | [FND-01](./specs/FND-01.md) | Ted（Foundation） | `06` | M00 | draft-ready |
        """
    )
    issues = validate_specs(index_text=index, specs_dir=specs)
    assert "orphan_spec" in _codes(issues)
    assert any("ZZZ-99" in i.message for i in issues)


def test_missing_file_fails(tmp_path):
    specs = tmp_path / "specs"
    specs.mkdir()
    (specs / "FND-01.md").write_text(
        (SPECS_DIR / "FND-01.md").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    index = textwrap.dedent(
        """\
        | spec／package | owner | 來源 | milestone | 狀態／跨模組契約 |
        | --- | --- | --- | --- | --- |
        | [FND-01](./specs/FND-01.md) | Ted（Foundation） | `06` | M00 | draft-ready |
        | [FND-02](./specs/FND-02.md) | Ted（Foundation） | `06` | M01 | draft-ready |
        """
    )
    issues = validate_specs(index_text=index, specs_dir=specs)
    assert "missing_file" in _codes(issues)
    assert any("FND-02" in i.message for i in issues)


def test_cli_main_ok_on_corpus():
    from check_specs import main

    assert main(["--index", str(SPEC_INDEX), "--specs-dir", str(SPECS_DIR)]) == 0
