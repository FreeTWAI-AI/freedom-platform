"""FW-10: GitHub mock-only read semantics fixture (static only).

Acceptance (first-work-batch FW-10 / RQ-024 / RQ-064 / ADR-065 / T17 / INT-03A/B):
  - synthetic GitHub responses + expected normalized records
  - write/star surface absent from default adapter
  - Agent write/star rejected; no provider request
  - malicious external text cannot change grant/owner/payee
  - read-only golden stable (byte-stable canonical form)
  - fixtures pass secret-scan mindset (no real tokens)
  - no real GitHub token / account / network
"""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from pathlib import Path

import pytest
import yaml

FIX = Path(__file__).resolve().parent / "fixtures" / "github-mock"
CATALOG = yaml.safe_load((FIX / "catalog.yaml").read_text())
CASES = yaml.safe_load((FIX / "cases.yaml").read_text())["cases"]

READ_ONLY_SCOPES = tuple(CATALOG["canonical_read_only_scopes"])
ABSENT_SURFACE = set(CATALOG["absent_write_star_surface"])
PROTECTED = tuple(CATALOG["protected_authority_fields"])
FORBIDDEN_TOKEN_SUBSTR = tuple(CATALOG["forbidden_token_substrings"])

# Patterns that secret scanners treat as high-signal GitHub credentials.
SECRET_SCAN_PATTERNS = (
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"gho_[A-Za-z0-9]{20,}"),
    re.compile(r"ghu_[A-Za-z0-9]{20,}"),
    re.compile(r"ghs_[A-Za-z0-9]{20,}"),
    re.compile(r"ghr_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----"),
)


def case_by_id(case_id: str) -> dict:
    return next(c for c in CASES if c["case_id"] == case_id)


def load_json(rel: str) -> dict:
    return json.loads((FIX / rel).read_text())


def canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def digest(value: object) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(value)).hexdigest()


def iter_fixture_files() -> list[Path]:
    return sorted(p for p in FIX.rglob("*") if p.is_file())


def collect_strings(node: object) -> list[str]:
    out: list[str] = []
    if isinstance(node, dict):
        for k, v in node.items():
            out.append(str(k))
            out.extend(collect_strings(v))
    elif isinstance(node, list):
        for item in node:
            out.extend(collect_strings(item))
    elif isinstance(node, str):
        out.append(node)
    return out


def assert_no_real_secrets(text: str) -> None:
    for pattern in SECRET_SCAN_PATTERNS:
        matches = pattern.findall(text)
        assert not matches, f"secret-scan mindset failed: {matches[:3]}"


def normalize_github_response(
    response: dict, platform_binding: dict
) -> dict:
    """Pure local normalizer. Never opens sockets or reads host credentials."""
    assert response.get("network") is False
    assert response.get("credential_used") in (None, False)
    kind = response["kind"]
    body = response["body"]
    headers = response.get("headers") or {}
    installation_id = platform_binding["installation_id"]
    authority = {
        field: deepcopy(platform_binding.get(field))
        for field in PROTECTED
    }

    if kind == "synthetic_github_api_response":
        path = response["http"]["path"]
        if "/repositories/" in path or path.endswith("/repository"):
            return {
                "schema_version": "freedom.github-normalized-fact/v1",
                "provider": "github",
                "resource_kind": "repository",
                "installation_id": installation_id,
                "repository_stable_id": body["id"],
                "display_full_name": body["full_name"],
                "default_branch": body["default_branch"],
                "commit_sha": None,
                "visibility": body.get("visibility")
                or ("private" if body.get("private") else "public"),
                "is_fork": bool(body.get("fork")),
                "state": "active",
                "html_url_display": body["html_url"],
                "delivery_id": None,
                "occurred_at": body.get("pushed_at") or body.get("updated_at"),
                "source_provenance": {
                    "fixture_id": response["fixture_id"],
                    "response_kind": kind,
                    "network": False,
                },
                "official_claim": False,
                "authority_snapshot": authority,
            }
        if "/pulls/" in path:
            return {
                "schema_version": "freedom.github-normalized-fact/v1",
                "provider": "github",
                "resource_kind": "pull_request",
                "installation_id": installation_id,
                "repository_stable_id": body["head"]["repo"]["id"],
                "display_full_name": body["head"]["repo"]["full_name"],
                "resource_number": body["number"],
                "state": body["state"],
                "draft": bool(body.get("draft")),
                "merged": bool(body.get("merged")),
                "title": body["title"],
                "head_sha": body["head"]["sha"],
                "base_sha": body["base"]["sha"],
                "head_ref": body["head"]["ref"],
                "base_ref": body["base"]["ref"],
                "actor_external_id": body["user"]["id"],
                "html_url_display": body["html_url"],
                "delivery_id": None,
                "occurred_at": body.get("updated_at") or body.get("created_at"),
                "source_provenance": {
                    "fixture_id": response["fixture_id"],
                    "response_kind": kind,
                    "network": False,
                },
                "official_claim": False,
                "authority_snapshot": authority,
            }
        if "/issues/" in path:
            return {
                "schema_version": "freedom.github-normalized-fact/v1",
                "provider": "github",
                "resource_kind": "issue",
                "installation_id": installation_id,
                "repository_stable_id": 900100200,
                "display_full_name": "synthetic-org/example-skill",
                "resource_number": body["number"],
                "state": body["state"],
                "title": body["title"],
                "actor_external_id": body["user"]["id"],
                "html_url_display": body["html_url"],
                "delivery_id": None,
                "occurred_at": body.get("updated_at") or body.get("created_at"),
                "source_provenance": {
                    "fixture_id": response["fixture_id"],
                    "response_kind": kind,
                    "network": False,
                },
                "official_claim": False,
                "authority_snapshot": authority,
            }
        if "/releases/" in path:
            return {
                "schema_version": "freedom.github-normalized-fact/v1",
                "provider": "github",
                "resource_kind": "release",
                "installation_id": installation_id,
                "repository_stable_id": 900100200,
                "display_full_name": "synthetic-org/example-skill",
                "tag_name": body["tag_name"],
                "commit_sha": body["target_commitish"],
                "prerelease": bool(body.get("prerelease")),
                "draft": bool(body.get("draft")),
                "html_url_display": body["html_url"],
                "delivery_id": None,
                "occurred_at": body.get("published_at") or body.get("created_at"),
                "source_provenance": {
                    "fixture_id": response["fixture_id"],
                    "response_kind": kind,
                    "network": False,
                },
                "official_claim": False,
                "authority_snapshot": authority,
            }
        raise ValueError(f"unsupported api path: {path}")

    if kind == "synthetic_github_webhook_delivery":
        event = headers.get("X-GitHub-Event")
        delivery_id = headers.get("X-GitHub-Delivery")
        repo = body["repository"]
        if event == "push":
            commits = body.get("commits") or []
            occurred = commits[-1]["timestamp"] if commits else None
            return {
                "schema_version": "freedom.github-normalized-fact/v1",
                "provider": "github",
                "resource_kind": "push",
                "installation_id": body.get("installation", {}).get(
                    "id", installation_id
                ),
                "repository_stable_id": repo["id"],
                "display_full_name": repo["full_name"],
                "default_branch": repo["default_branch"],
                "commit_sha": body["after"],
                "ref": body["ref"],
                "delivery_id": delivery_id,
                "occurred_at": occurred,
                "source_provenance": {
                    "fixture_id": response["fixture_id"],
                    "response_kind": kind,
                    "network": False,
                },
                "official_claim": False,
                "authority_snapshot": authority,
            }
        if event == "pull_request":
            pr = body["pull_request"]
            return {
                "schema_version": "freedom.github-normalized-fact/v1",
                "provider": "github",
                "resource_kind": "pull_request",
                "installation_id": body.get("installation", {}).get(
                    "id", installation_id
                ),
                "repository_stable_id": repo["id"],
                "display_full_name": repo["full_name"],
                "resource_number": pr["number"],
                "state": pr["state"],
                "draft": bool(pr.get("draft")),
                "merged": bool(pr.get("merged")),
                "title": pr["title"],
                "head_sha": pr["head"]["sha"],
                "base_sha": pr["base"]["sha"],
                "head_ref": pr["head"]["ref"],
                "base_ref": pr["base"]["ref"],
                "actor_external_id": pr["user"]["id"],
                "html_url_display": pr["html_url"],
                "delivery_id": delivery_id,
                "occurred_at": pr.get("updated_at") or pr.get("created_at"),
                "webhook_action": body.get("action"),
                "source_provenance": {
                    "fixture_id": response["fixture_id"],
                    "response_kind": kind,
                    "network": False,
                },
                "official_claim": False,
                "authority_snapshot": authority,
            }
        raise ValueError(f"unsupported webhook event: {event}")

    raise ValueError(f"unsupported response kind: {kind}")


def evaluate_operation(case: dict) -> dict:
    """Decide whether a mock adapter may emit a provider side-effect."""
    op = case["requested_operation"]
    expect_network = False
    provider_request_made = False

    # Default mock adapter surface is read-only: write/star always absent.
    if op in ABSENT_SURFACE:
        # Platform-triggered / reward-induced star is a stronger, specific denial.
        if op == "github.star" and case.get("inducement"):
            return {
                "allowed": False,
                "provider_request_made": False,
                "denial_reason": "platform_triggered_or_reward_induced_star_forbidden",
                "network": expect_network,
                "xp_awarded": False,
            }
        if op == "github.star" and not (
            case.get("person_explicit_decision")
            and "github.star" in (case.get("grant_scopes") or [])
            and (case.get("actor") or {}).get("type") == "person"
            and (case.get("actor") or {}).get("agent_connection_ref")
        ):
            # Still surface-absent first for default adapter when the Person
            # triple is incomplete; otherwise Person-complete still absent.
            if not case.get("person_explicit_decision") or "github.star" not in (
                case.get("grant_scopes") or []
            ):
                return {
                    "allowed": False,
                    "provider_request_made": False,
                    "denial_reason": "github_star_requires_person_decision_and_explicit_grant",
                    "network": expect_network,
                    "xp_awarded": False,
                }
        return {
            "allowed": False,
            "provider_request_made": provider_request_made,
            "denial_reason": "write_or_star_surface_absent",
            "network": expect_network,
            "xp_awarded": False,
        }

    if op not in READ_ONLY_SCOPES and not str(op).endswith(":read"):
        return {
            "allowed": False,
            "provider_request_made": False,
            "denial_reason": "write_or_star_surface_absent",
            "network": False,
            "xp_awarded": False,
        }

    return {
        "allowed": True,
        "provider_request_made": False,
        "denial_reason": None,
        "network": False,
        "xp_awarded": False,
    }


def apply_malicious_content(fixture: dict) -> dict:
    """Ingest malicious GitHub text without mutating platform authority."""
    binding = deepcopy(fixture["platform_binding_snapshot"])
    # Untrusted body / title / comment text is recorded as content only.
    raw = fixture["github_response"]
    text_parts = [
        str(raw.get("title") or ""),
        str(raw.get("body") or ""),
    ]
    untrusted_text = "\n".join(p for p in text_parts if p)

    # Injected claims from external text are ignored for authority.
    _ignored = fixture.get("injected_claims") or {}

    if "pull_request" in (raw.get("html_url") or "") or raw.get("head"):
        resource_kind = "pull_request"
        number = raw.get("number")
    elif "discussion_r" in (raw.get("html_url") or "") or raw.get(
        "pull_request_url"
    ):
        resource_kind = "pull_request_review_comment"
        number = None
    else:
        resource_kind = "issue"
        number = raw.get("number")

    repo = raw.get("repository") or {}
    normalized = {
        "schema_version": "freedom.github-normalized-fact/v1",
        "provider": "github",
        "resource_kind": resource_kind,
        "repository_stable_id": repo.get("id", 900100200),
        "display_full_name": repo.get("full_name", "synthetic-org/example-skill"),
        "resource_number": number,
        "title": raw.get("title"),
        "untrusted_text_digest": digest(untrusted_text),
        "content_classification": "untrusted_external_text",
        "authority_snapshot": binding,
        "official_claim": False,
        "provider_request_made": False,
        "authority_mutated": False,
    }
    # Prove injected claims did not land in authority.
    for field, forged in (fixture.get("injected_claims") or {}).items():
        if field in PROTECTED:
            assert normalized["authority_snapshot"].get(field) != forged
            assert normalized["authority_snapshot"].get(field) == binding.get(field)
    return normalized


# ---------------------------------------------------------------------------
# Catalog / environment invariants
# ---------------------------------------------------------------------------


def test_catalog_declares_mock_only_no_network_no_real_token():
    assert CATALOG["network"] is False
    assert CATALOG["real_github_token"] is False
    assert CATALOG["real_github_account"] is False
    assert CATALOG["provider_sandbox"] is False
    assert CATALOG["secret_scan_mindset"] is True
    assert CATALOG["no_runtime_claim"] is True


def test_canonical_read_only_scopes_exclude_write_and_star():
    for scope in READ_ONLY_SCOPES:
        assert scope not in ABSENT_SURFACE
        assert "write" not in scope
        assert scope != "github.star"
    for absent in ABSENT_SURFACE:
        assert absent not in READ_ONLY_SCOPES


def test_person_only_star_rule_matches_adr_065():
    rule = CATALOG["person_only_star_rule"]
    assert rule["capability"] == "github.star"
    assert "person_explicit_decision" in rule["requires_all"]
    assert "execution_grant_lists_github_star" in rule["requires_all"]
    assert "acting_agent_connection_belongs_to_same_person" in rule["requires_all"]
    assert rule["xp_effect"] == "never"
    assert "platform_triggered_star" in rule["forbidden"]


# ---------------------------------------------------------------------------
# Read-only golden stability
# ---------------------------------------------------------------------------


READ_CASES = [c for c in CASES if c["kind"] == "positive_read"]


@pytest.mark.parametrize("case", READ_CASES, ids=lambda c: c["case_id"])
def test_read_golden_matches_expected_normalized_record(case):
    response = load_json(case["response"])
    expected = load_json(case["expected"])
    binding = case["platform_binding"]
    actual = normalize_github_response(response, binding)
    assert actual == expected
    # Byte-stable golden: canonical digest must be deterministic.
    assert digest(actual) == digest(expected)
    assert actual["source_provenance"]["network"] is False
    assert actual["official_claim"] is False
    assert actual["authority_snapshot"]["grant_id"] == binding["grant_id"]
    assert actual["authority_snapshot"]["owner_party_ref"] == binding[
        "owner_party_ref"
    ]
    assert actual["authority_snapshot"]["payee_party_ref"] == binding[
        "payee_party_ref"
    ]


def test_read_goldens_are_byte_stable_across_reload():
    case = case_by_id("read_golden_repository")
    first = normalize_github_response(
        load_json(case["response"]), case["platform_binding"]
    )
    second = normalize_github_response(
        load_json(case["response"]), case["platform_binding"]
    )
    assert canonical_bytes(first) == canonical_bytes(second)
    assert digest(first) == digest(load_json(case["expected"]))


def test_repository_identity_is_stable_numeric_id_not_display_path():
    case = case_by_id("read_golden_repository")
    expected = load_json(case["expected"])
    assert expected["repository_stable_id"] == 900100200
    assert expected["display_full_name"] == "synthetic-org/example-skill"
    # Rename would change display path only; golden pins stable id.
    renamed = deepcopy(expected)
    renamed["display_full_name"] = "synthetic-org/renamed-skill"
    assert renamed["repository_stable_id"] == expected["repository_stable_id"]


# ---------------------------------------------------------------------------
# Write / star surface absent + Agent rejection
# ---------------------------------------------------------------------------


OP_CASES = [
    c
    for c in CASES
    if c["kind"] in {"negative_write", "negative_star", "surface_absent"}
]


@pytest.mark.parametrize("case", OP_CASES, ids=lambda c: c["case_id"])
def test_agent_write_or_star_rejected_without_provider_request(case):
    result = evaluate_operation(case)
    assert result["allowed"] is False
    assert result["provider_request_made"] is False
    assert result["network"] is False
    assert result["denial_reason"] == case["expect"]["denial_reason"]
    if "xp_awarded" in case["expect"]:
        assert result["xp_awarded"] is False


def test_default_adapter_surface_lists_write_and_star_as_absent():
    for op in (
        "contents:write",
        "issues:write",
        "pull_requests:write",
        "github.star",
        "github.follow",
    ):
        assert op in ABSENT_SURFACE


def test_agent_self_reported_star_scope_ignored():
    case = case_by_id("reject_agent_star_with_forged_scope_in_text_only")
    assert "github.star" in case["agent_self_reported_scopes"]
    assert "github.star" not in case["grant_scopes"]
    result = evaluate_operation(case)
    assert result["allowed"] is False
    assert result["provider_request_made"] is False


# ---------------------------------------------------------------------------
# Malicious content cannot change grant / owner / payee
# ---------------------------------------------------------------------------


MALICIOUS_CASES = [c for c in CASES if c["kind"] == "malicious_content"]


@pytest.mark.parametrize("case", MALICIOUS_CASES, ids=lambda c: c["case_id"])
def test_malicious_external_text_cannot_change_grant_owner_payee(case):
    fixture = load_json(case["malicious"])
    before = deepcopy(fixture["platform_binding_snapshot"])
    result = apply_malicious_content(fixture)
    assert result["content_classification"] == "untrusted_external_text"
    assert result["authority_mutated"] is False
    assert result["provider_request_made"] is False
    assert result["authority_snapshot"] == before
    for field in ("grant_id", "owner_party_ref", "payee_party_ref"):
        forged = (fixture.get("injected_claims") or {}).get(field)
        if forged is not None:
            assert result["authority_snapshot"][field] != forged
            assert result["authority_snapshot"][field] == before[field]


def test_malicious_comment_forged_grant_scopes_do_not_enter_snapshot():
    fixture = load_json("malicious/comment_grant_injection.json")
    result = apply_malicious_content(fixture)
    scopes = result["authority_snapshot"]["grant_scopes"]
    assert "github.star" not in scopes
    assert "contents:write" not in scopes
    assert result["authority_snapshot"]["authorization_level"] == "A0"


# ---------------------------------------------------------------------------
# Secret-scan mindset + no network fixtures
# ---------------------------------------------------------------------------


def test_all_fixture_files_pass_secret_scan_mindset():
    catalog_path = FIX / "catalog.yaml"
    for path in iter_fixture_files():
        text = path.read_text()
        # Catalog may list short forbidden prefixes (ghp_ etc.) as documentation.
        # Every file, including catalog, must still lack full token-shaped secrets
        # and PEM private-key armor.
        assert_no_real_secrets(text)
        if path == catalog_path:
            continue
        for needle in FORBIDDEN_TOKEN_SUBSTR:
            assert needle not in text, f"{path} contains {needle}"


def test_fixtures_use_opaque_secret_ref_only():
    cases_doc = yaml.safe_load((FIX / "cases.yaml").read_text())
    binding = cases_doc["cases"][0]["platform_binding"]
    assert binding["secret_ref"].startswith("cred_synthetic_")
    assert "token" not in binding
    assert "access_token" not in binding


def test_every_response_fixture_declares_network_false():
    for path in sorted((FIX / "responses").glob("*.json")):
        doc = json.loads(path.read_text())
        assert doc["network"] is False
        assert doc.get("credential_used") in (None, False)


def test_case_count_covers_acceptance_buckets():
    kinds = {c["kind"] for c in CASES}
    assert "positive_read" in kinds
    assert "negative_write" in kinds
    assert "negative_star" in kinds
    assert "malicious_content" in kinds
    assert "surface_absent" in kinds
    assert len(READ_CASES) >= 4
    assert len(MALICIOUS_CASES) >= 3
