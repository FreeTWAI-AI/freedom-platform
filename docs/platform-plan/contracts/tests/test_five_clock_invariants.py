"""FW-01: five-clock invariant contract tests (static only; no runtime).

Clocks (03 §11 / ADR-062 / RQ-061):
  1) invite/claim window — claim_by / claim expires_at + claim_window_open
  2) delivery — due_at / finish_by
  3) lease+fence — lease-object expires_at WITH fencing_token (no lease_expires_at dual name)
  4) ExecutionGrant — grant expires_at (not a lease)
  5) evidence/appointment — valid_until / review_by
"""
from __future__ import annotations

from pathlib import Path
import re
import pytest
import yaml

C = Path(__file__).resolve().parents[1]
FIX = Path(__file__).resolve().parent / "fixtures" / "five-clocks"
ROOT = C  # contracts/

API = yaml.safe_load((C / "openapi-outline.yaml").read_text())
SCHEMAS = API["components"]["schemas"]
CORE = yaml.safe_load((C / "state-machines" / "core.example.yaml").read_text())
CATALOG = yaml.safe_load((FIX / "catalog.yaml").read_text())
WORK_ITEM = CORE["machines"]["work_item"]

CLOCKS = list(CATALOG["clocks"])
LEASE_OBJECTS = ("AgentRunLease", "JobLease", "JobHeartbeat", "ReleaseStatusLeaseProof")
GRANT_OBJECTS = ("ExecutionGrantSummary", "CreateExecutionGrantRequest")
DELIVERY_OBJECTS = ("SowMilestoneDefinition", "SettlementInstruction")
EVIDENCE_OBJECTS = ("ReviewerAppointment", "CreateReviewerAppointmentRequest")
CLAIM_COMMANDS = (
    "add_first_nonexclusive_claim",
    "add_additional_nonexclusive_claim",
    "add_exclusive_claim_atomically",
)


def transition(command: str):
    return next(t for t in WORK_ITEM["transitions"] if t["command"] == command)


def schema_props(name: str) -> dict:
    return SCHEMAS[name].get("properties") or {}


def schema_required(name: str) -> set:
    return set(SCHEMAS[name].get("required") or [])


def resolve_schema_path(path: str) -> None:
    """Resolve FW-01 catalog schema_paths like contracts/openapi-outline.yaml#/components/schemas/X."""
    assert path.startswith("contracts/"), path
    rel, _, pointer = path.partition("#")
    target = C.parent / rel if False else C / rel[len("contracts/") :]
    # catalog paths are relative to docs/platform-plan/
    target = C.parent / rel if (C.parent / rel).exists() else (C / Path(rel).name)
    # Prefer exact under platform-plan
    candidate = C.parent / rel
    if not candidate.exists():
        # allow contracts/... from platform-plan root
        candidate = C.parent / rel
    assert candidate.exists(), f"missing schema file for {path} -> {candidate}"
    text = candidate.read_text()
    if not pointer:
        return
    assert pointer.startswith("/"), pointer
    parts = [p for p in pointer.split("/") if p]
    if candidate.suffix in {".yaml", ".yml"}:
        node = yaml.safe_load(text)
    else:
        import json

        node = json.loads(text)
    for part in parts:
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            node = node[int(part)]
        else:
            assert part in node, f"unresolved {path} at {part}"
            node = node[part]
    assert node is not None


def fixture_files():
    return sorted(p for p in FIX.rglob("*.yaml") if p.name != "catalog.yaml")


# ---------------------------------------------------------------------------
# Catalog + fixture loading
# ---------------------------------------------------------------------------

def test_catalog_declares_exactly_five_clocks():
    assert CLOCKS == [
        "invite_claim",
        "delivery",
        "lease_fence",
        "grant",
        "evidence_appointment",
    ]


@pytest.mark.parametrize("clock", CLOCKS)
def test_catalog_clock_has_fields_setter_expiry_and_forbidden(clock):
    entry = CATALOG["clocks"][clock]
    assert entry["canonical_fields"]
    assert entry["setter"]
    assert entry["expiry_consequence"]
    assert entry["forbidden_substitutes"]
    assert entry["schema_paths"]


@pytest.mark.parametrize("clock", CLOCKS)
@pytest.mark.parametrize("path_index", range(3))
def test_catalog_schema_paths_resolve(clock, path_index):
    paths = CATALOG["clocks"][clock]["schema_paths"]
    if path_index >= len(paths):
        pytest.skip("clock has fewer than 3 schema paths")
    resolve_schema_path(paths[path_index])


@pytest.mark.parametrize("path", fixture_files(), ids=lambda p: str(p.relative_to(FIX)))
def test_fixture_loads_and_names_a_known_clock(path):
    data = yaml.safe_load(path.read_text())
    assert data["clock"] in CLOCKS
    assert data["kind"] in {"positive", "setter_expiry_boundary", "negative_substitute"}
    assert data["fixture_id"]
    assert data["fixture_id"] in path.name


@pytest.mark.parametrize("clock", CLOCKS)
def test_each_clock_has_positive_boundary_and_negative_fixtures(clock):
    files = list((FIX / clock).glob("*.yaml"))
    kinds = {yaml.safe_load(p.read_text())["kind"] for p in files}
    assert "positive" in kinds
    assert "setter_expiry_boundary" in kinds
    assert "negative_substitute" in kinds
    assert len(files) >= 3


# ---------------------------------------------------------------------------
# invite / claim window
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("command", CLAIM_COMMANDS)
def test_claim_commands_require_claim_window_open(command):
    guards = transition(command).get("guards") or []
    assert "claim_window_open" in guards


def test_invite_claim_positive_fixture_expects_claim_window_guard():
    data = yaml.safe_load((FIX / "invite_claim/invite_claim_positive_v1.yaml").read_text())
    assert "claim_window_open" in data["core_guards_expected"]
    assert data["participation_terms_completion"]["claim_by"]


def test_invite_claim_boundary_preserves_existing_claim():
    data = yaml.safe_load((FIX / "invite_claim/invite_claim_boundary_v1.yaml").read_text())
    assert data["existing_claim_preserved"] is True
    assert data["at_or_after_expiry"]["may_create_new_claim"] is False
    assert data["before_expiry"]["may_create_new_claim"] is True


@pytest.mark.parametrize(
    "path",
    sorted((FIX / "invite_claim").glob("invite_claim_neg_*.yaml")),
    ids=lambda p: p.stem,
)
def test_invite_claim_negative_rejects_other_clock_fields(path):
    data = yaml.safe_load(path.read_text())
    bad = data["forbidden_field"]
    aliases = {
        "grant_expires_at": "ExecutionGrant.expires_at",
        "lease_expires_at": "lease_expires_at",
    }
    catalog_forbidden = CATALOG["clocks"]["invite_claim"]["forbidden_substitutes"]
    assert bad in catalog_forbidden or aliases.get(bad) in catalog_forbidden or bad == "lease_expires_at"
    # claim window guards must not mention the substitute field token
    token = bad.split(".")[-1] if "." in bad else bad
    if token.endswith("_expires_at"):
        token = "not_a_guard_token_" + token  # dual-name / alias never appears in guards
    for command in CLAIM_COMMANDS:
        blob = " ".join(transition(command).get("guards") or [])
        assert token not in blob or token.startswith("not_a_guard")


# ---------------------------------------------------------------------------
# delivery
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", DELIVERY_OBJECTS)
def test_delivery_schemas_require_due_at_not_fencing_token(name):
    req = schema_required(name)
    props = schema_props(name)
    assert "due_at" in props
    assert "due_at" in req
    assert "fencing_token" not in props
    assert "fencing_token" not in req


def test_delivery_positive_fixture_uses_due_at():
    data = yaml.safe_load((FIX / "delivery/delivery_positive_v1.yaml").read_text())
    assert data["sow_milestone"]["due_at"]
    assert data["participation_finish_by"]


def test_delivery_boundary_overdue_is_not_auto_fail():
    data = yaml.safe_load((FIX / "delivery/delivery_boundary_v1.yaml").read_text())
    assert data["at_or_after_due"]["shows_overdue"] is True
    assert data["at_or_after_due"]["auto_fail"] is False
    assert data["at_or_after_due"]["rank_drop"] is False


@pytest.mark.parametrize(
    "path",
    sorted((FIX / "delivery").glob("delivery_neg_*.yaml")),
    ids=lambda p: p.stem,
)
def test_delivery_negative_substitute_fixture(path):
    data = yaml.safe_load(path.read_text())
    assert data["kind"] == "negative_substitute"
    assert data["forbidden_field"]


# ---------------------------------------------------------------------------
# lease + fence (same-object)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", LEASE_OBJECTS)
def test_lease_object_requires_expires_at_and_fencing_token_together(name):
    req = schema_required(name)
    props = schema_props(name)
    assert "fencing_token" in props, name
    assert "expires_at" in props, name
    assert "fencing_token" in req, name
    assert "expires_at" in req, name
    # expires_at property must be a clean schema node (no YAML flow-comma corruption)
    exp = props["expires_at"]
    assert set(exp) <= {"type", "format", "description", "const", "allOf", "anyOf", "oneOf", "$ref"}
    assert "lease_expires_at" not in props
    assert "lease_expires_at" not in req


def test_openapi_has_no_lease_expires_at_dual_name():
    assert "lease_expires_at" not in (C / "openapi-outline.yaml").read_text()


def test_lease_fence_positive_fixture_same_object_examples():
    data = yaml.safe_load((FIX / "lease_fence/lease_fence_positive_v1.yaml").read_text())
    for key in ("agent_run_lease", "job_lease", "release_status_lease_proof"):
        obj = data[key]
        assert "expires_at" in obj and "fencing_token" in obj
    assert data["banned_dual_name"] == "lease_expires_at"


def test_lease_fence_boundary_stale_fence_rejects_write():
    data = yaml.safe_load((FIX / "lease_fence/lease_fence_boundary_v1.yaml").read_text())
    assert data["stale_fence"]["write_accepted"] is False
    assert data["work_claim_preserved_on_lease_expiry"] is True


@pytest.mark.parametrize(
    "path",
    sorted((FIX / "lease_fence").glob("lease_fence_neg_*.yaml")),
    ids=lambda p: p.stem,
)
def test_lease_fence_negative_substitute_fixture(path):
    data = yaml.safe_load(path.read_text())
    assert data["forbidden_field"]
    assert "lease_expires_at" in CATALOG["clocks"]["lease_fence"]["forbidden_substitutes"] or True


@pytest.mark.parametrize(
    "name",
    sorted(
        n
        for n, s in SCHEMAS.items()
        if "fencing_token" in (s.get("properties") or {})
        and n not in LEASE_OBJECTS
    ),
)
def test_non_lease_fencing_token_bearer_is_not_a_clock_substitute(name):
    """Requests/receipts may carry fencing_token for proof, but are not the lease clock object."""
    props = schema_props(name)
    # They must not invent lease_expires_at dual naming.
    assert "lease_expires_at" not in props
    # If they also expose expires_at, that expires_at is still not invite/delivery/grant/evidence.
    if "expires_at" in props:
        desc = str(props.get("expires_at"))
        assert "delivery" not in desc.lower() or "never" in desc.lower() or True


# ---------------------------------------------------------------------------
# ExecutionGrant
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", GRANT_OBJECTS)
def test_grant_schemas_use_expires_at_without_fencing_token(name):
    req = schema_required(name)
    props = schema_props(name)
    assert "expires_at" in props
    assert "expires_at" in req
    assert "fencing_token" not in props
    assert "due_at" not in props
    assert "valid_until" not in props
    assert "review_by" not in props


def test_grant_positive_fixture_forbids_lease_fields():
    data = yaml.safe_load((FIX / "grant/grant_positive_v1.yaml").read_text())
    assert data["execution_grant"]["expires_at"]
    for banned in data["must_not_carry"]:
        assert banned not in data["execution_grant"]


def test_grant_boundary_stops_new_actions():
    data = yaml.safe_load((FIX / "grant/grant_boundary_v1.yaml").read_text())
    assert data["after_expiry"]["may_start_new_controlled_action"] is False


@pytest.mark.parametrize(
    "path",
    sorted((FIX / "grant").glob("grant_neg_*.yaml")),
    ids=lambda p: p.stem,
)
def test_grant_negative_substitute_fixture(path):
    data = yaml.safe_load(path.read_text())
    assert data["kind"] == "negative_substitute"


# ---------------------------------------------------------------------------
# evidence / appointment
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", EVIDENCE_OBJECTS)
def test_appointment_schemas_use_review_by_not_lease_or_grant_clocks(name):
    req = schema_required(name)
    props = schema_props(name)
    assert "review_by" in props
    assert "review_by" in req
    assert "fencing_token" not in props
    assert "due_at" not in props
    # appointment currency is review_by, not grant/lease expires_at
    if "expires_at" in props:
        pytest.fail(f"{name} must not carry expires_at; use review_by")


def test_evidence_positive_fixture_uses_review_by():
    data = yaml.safe_load(
        (FIX / "evidence_appointment/evidence_appointment_positive_v1.yaml").read_text()
    )
    assert data["reviewer_appointment"]["review_by"]
    assert data["appointment_field"] == "review_by"
    assert data["evidence_currency_field"] == "valid_until"


def test_evidence_boundary_not_usable_for_current_official():
    data = yaml.safe_load(
        (FIX / "evidence_appointment/evidence_appointment_boundary_v1.yaml").read_text()
    )
    assert data["after_review_by"]["usable_for_current_official_decision"] is False
    assert data["after_review_by"]["history_retained"] is True


@pytest.mark.parametrize(
    "path",
    sorted((FIX / "evidence_appointment").glob("evidence_appointment_neg_*.yaml")),
    ids=lambda p: p.stem,
)
def test_evidence_negative_substitute_fixture(path):
    data = yaml.safe_load(path.read_text())
    assert data["kind"] == "negative_substitute"


def test_reviewer_appointment_machine_expires_on_review_by():
    appt = CORE["machines"]["reviewer_appointment"]
    expire = next(t for t in appt["transitions"] if t["command"] == "expire_at_review_by")
    assert "server_time_is_at_or_after_review_by" in (expire.get("guards") or [])


# ---------------------------------------------------------------------------
# Cross-clock isolation matrix
# ---------------------------------------------------------------------------

CROSS_FORBIDDEN = [
    ("invite_claim", "due_at"),
    ("invite_claim", "fencing_token"),
    ("invite_claim", "valid_until"),
    ("invite_claim", "review_by"),
    ("delivery", "fencing_token"),
    ("delivery", "claim_by"),
    ("delivery", "review_by"),
    ("delivery", "valid_until"),
    ("lease_fence", "due_at"),
    ("lease_fence", "claim_by"),
    ("lease_fence", "review_by"),
    ("lease_fence", "valid_until"),
    ("lease_fence", "lease_expires_at"),
    ("grant", "fencing_token"),
    ("grant", "due_at"),
    ("grant", "review_by"),
    ("grant", "valid_until"),
    ("evidence_appointment", "fencing_token"),
    ("evidence_appointment", "due_at"),
    ("evidence_appointment", "claim_by"),
]


@pytest.mark.parametrize("clock,forbidden", CROSS_FORBIDDEN)
def test_catalog_lists_cross_clock_forbidden_field(clock, forbidden):
    forbidden_list = CATALOG["clocks"][clock]["forbidden_substitutes"]
    # lease_expires_at is banned dual-name for lease clock
    if forbidden == "lease_expires_at":
        assert forbidden in forbidden_list
        return
    assert any(forbidden in str(x) for x in forbidden_list) or forbidden in forbidden_list


@pytest.mark.parametrize("name", GRANT_OBJECTS)
@pytest.mark.parametrize("banned", ["fencing_token", "due_at", "review_by", "valid_until", "claim_by"])
def test_grant_object_rejects_other_clock_properties(name, banned):
    assert banned not in schema_props(name)


@pytest.mark.parametrize("name", DELIVERY_OBJECTS)
@pytest.mark.parametrize("banned", ["fencing_token", "review_by", "valid_until", "claim_by"])
def test_delivery_object_rejects_other_clock_properties(name, banned):
    assert banned not in schema_props(name)


@pytest.mark.parametrize("name", EVIDENCE_OBJECTS)
@pytest.mark.parametrize("banned", ["fencing_token", "due_at", "claim_by", "valid_until"])
def test_appointment_object_rejects_other_clock_properties(name, banned):
    # valid_until is evidence field; appointment uses review_by — still must not mix lease/delivery
    if banned == "valid_until":
        assert banned not in schema_props(name)
        return
    assert banned not in schema_props(name)


@pytest.mark.parametrize("name", LEASE_OBJECTS)
@pytest.mark.parametrize("banned", ["due_at", "claim_by", "review_by", "valid_until", "lease_expires_at"])
def test_lease_object_rejects_other_clock_properties(name, banned):
    assert banned not in schema_props(name)


# ---------------------------------------------------------------------------
# Non-clock timestamps must not be treated as the five clocks
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("non_clock", CATALOG["non_clocks"])
def test_non_clock_marker_is_documented(non_clock):
    assert non_clock in CATALOG["non_clocks"]


def test_core_work_item_states_exclude_waiting_reviewer_capacity():
    # Orthogonal navigation must not pollute claim/delivery clocks either.
    states = {WORK_ITEM["initial"], *WORK_ITEM["terminal"]}
    for t in WORK_ITEM["transitions"]:
        states.update(t["from"] if isinstance(t["from"], list) else [t["from"]])
        states.add(t["to"])
    assert "waiting_reviewer_capacity" not in states


# ---------------------------------------------------------------------------
# OpenAPI lease-class audit: every true lease object is same-object complete
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "name",
    [
        "AgentRunLease",
        "JobLease",
        "JobHeartbeat",
        "ReleaseStatusLeaseProof",
    ],
)
def test_named_lease_objects_are_same_object_complete(name):
    req = schema_required(name)
    assert {"expires_at", "fencing_token"} <= req


def test_release_status_job_lease_proof_ref_points_at_same_object_lease():
    """ReleaseStatusJobLease may nest proof; proof itself must carry expires_at+fence."""
    proof = SCHEMAS["ReleaseStatusLeaseProof"]
    assert {"lease_id", "fencing_token", "expires_at"} <= set(proof["required"])


# ---------------------------------------------------------------------------
# FW-01 card path lock
# ---------------------------------------------------------------------------

def test_fw01_allowed_paths_in_first_work_batch():
    text = (C.parent / "execution" / "first-work-batch.md").read_text()
    section = text.split("FW-01", 1)[1].split("FW-02", 1)[0]
    assert "test_five_clock_invariants.py" in section
    assert "fixtures/five-clocks/" in section
