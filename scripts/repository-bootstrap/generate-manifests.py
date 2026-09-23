#!/usr/bin/env python3
"""Observe real GitHub identities and generate schema-valid bootstrap metadata.

Only local files are written. This tool does not enable Pages, grant a license,
create teams, enforce rulesets, tag releases, or deploy an environment.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys

from jsonschema import Draft202012Validator, FormatChecker


ORG = "FreeTWAI-AI"
MAINTAINER = "teddashh"
STAGING_URL = "https://staging.freetwai.com/"
REPOS = {
    "freedom-platform": {
        "slug": "freedom-platform", "name": "Freedom Platform", "type": "platform",
        "vertical": "platform", "runtime": "external",
        "summary": "Shared member, positioning, Guild, supplier, retail, open-project and campaign control plane.",
        "capabilities": ["Persist member and module state in the central PostgreSQL database", "Provide authenticated versioned module commands", "Run the access-controlled Castle staging application"],
        "limitations": ["Castle staging is not a managed-cloud or production deployment", "Demo identities and internal commerce confirmations do not establish real sales or payment evidence"],
        "records": ["User", "ProfessionMembership", "PositioningProfile", "Product", "SupplierOfferVersion", "Store", "RetailListingRevision", "DistributionAcceptance", "OpenProject", "CampaignDraft", "ManualShareRecord", "WorkItem", "Engagement"],
    },
    "freedom-agent-kit": {
        "slug": "freedom-agent-kit", "name": "Freedom Agent Kit", "type": "agent_kit",
        "vertical": "agent", "runtime": "external",
        "summary": "Local CLI and helper templates consuming the pinned Platform member and work APIs.",
        "capabilities": ["Use the versioned Platform client from local agent tooling", "Keep canonical member and work state in Platform"],
        "limitations": ["No autonomous authority, background job executor or provider credential custody"],
    },
    "freedom-storefront": {
        "slug": "freedom-storefront", "name": "Freedom Storefront", "type": "storefront_template",
        "vertical": "commerce", "runtime": "library_only",
        "summary": "Supplier and retailer templates using canonical products, immutable offers and stores.",
        "capabilities": ["Prepare supplier and retailer API commands", "Render reference store templates using Platform snapshots"],
        "limitations": ["No production storefront, checkout, payment collection or verified commercial agreement"],
    },
    "freedom-growth-automation": {
        "slug": "freedom-growth-automation", "name": "Freedom Growth Automation", "type": "library",
        "vertical": "marketing", "runtime": "library_only",
        "summary": "Source-preserving campaign draft helpers and local channel previews.",
        "capabilities": ["Create and revise private campaign drafts through Platform", "Preserve source snapshots in plain-text and LINE-shaped local previews", "Record a member's manual share report"],
        "limitations": ["Publication and media execution are unavailable; no provider messages or render jobs are sent"],
    },
    "freedom-skill-registry": {
        "slug": "freedom-skill-registry", "name": "Freedom Skill Registry", "type": "registry",
        "vertical": "opensource", "runtime": "external",
        "summary": "Public import declarations and open-project registration client templates.",
        "capabilities": ["Validate public registry declarations", "Connect open-project registrations to Platform and observed GitHub source versions"],
        "limitations": ["Declarations are not a second database or proof of accepted skill review", "Skill installation and execution are not implemented"],
    },
    ".github": {
        "slug": "freedom-community", "name": "Freedom Community Automation", "type": "documentation",
        "vertical": "community", "runtime": "none",
        "summary": "Shared contributor documents, issue and pull-request templates, and reusable verification workflow.",
        "capabilities": ["Provide reusable read-only template verification", "Provide common contribution and reporting instructions"],
        "limitations": ["A callable workflow is not proof that an organization ruleset requires it"],
    },
    "freedom-project-template": {
        "slug": "freedom-project-template", "name": "Freedom Project Template", "type": "application",
        "vertical": "opensource", "runtime": "external",
        "summary": "Node project starter with a local preview and a pinned Platform contract bundle.",
        "capabilities": ["Build and test a minimal local Node application", "Start a separately identified project using the Platform protocol"],
        "limitations": ["A generated project must replace repository identity and retain applicable source lineage", "No cloud deployment or inherited official status"],
    },
    "freedom-project-page": {
        "slug": "freedom-project-page", "name": "Freedom Project Page", "type": "library",
        "vertical": "opensource", "runtime": "library_only",
        "summary": "Generate a bounded public project introduction from validated metadata.",
        "capabilities": ["Produce an escaped static HTML artifact from public manifest fields", "Display provenance without claiming verified official status"],
        "limitations": ["Does not enable or publish GitHub Pages", "Private and internal manifests are excluded from the public renderer"],
    },
    "FreeTWAI-AI.github.io": {
        "slug": "freetwai-project-directory", "name": "FreeTWAI Project Directory", "type": "documentation",
        "vertical": "community", "runtime": "static_github_pages",
        "summary": "Static project-directory source and local build artifacts for the Freedom repositories.",
        "capabilities": ["Organize public project metadata and repository links"],
        "limitations": ["No site publication or production domain is configured by this bootstrap"],
    },
}


def github_api(endpoint: str) -> dict:
    result = subprocess.run(
        ["gh", "api", "-H", "Accept: application/vnd.github+json", endpoint],
        text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"GitHub read failed for {endpoint}; check gh authentication and repository access.")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError(f"Unexpected GitHub response for {endpoint}")
    return value


def account(observed: dict) -> dict:
    if observed.get("type") not in ("User", "Organization") or not isinstance(observed.get("id"), int) or observed["id"] < 1:
        raise ValueError("GitHub account must contain a stable positive database ID and supported account type.")
    return {"type": observed["type"], "account_id": str(observed["id"]), "login": observed["login"], "html_url": observed["html_url"]}


def manifest(name: str, observed: dict, maintainer: dict, schema: dict) -> dict:
    meta = REPOS[name]
    if observed.get("full_name") != f"{ORG}/{name}" or observed.get("owner", {}).get("login") != ORG:
        raise ValueError(f"Repository identity changed for {name}; review ownership before regenerating.")
    if observed.get("fork"):
        raise ValueError(f"{name} is a GitHub fork; bootstrap must not invent its upstream provenance.")
    if observed.get("default_branch") not in (None, "", "main"):
        raise ValueError(f"{name} does not use the required main branch.")
    visibility = observed.get("visibility")
    if visibility not in ("public", "private"):
        raise ValueError(f"Unsupported repository visibility for {name}.")
    core = name == "freedom-platform"
    community = name == ".github"
    public_page = not core and not community and visibility == "public"
    repo_url = observed["html_url"]
    page_url = f"https://{ORG.lower()}.github.io/" + ("" if name.lower() == f"{ORG.lower()}.github.io" else name + "/")
    limitations = meta["limitations"] + [
        "Quality and release fields declare intended policy; they do not attest an enforced ruleset or a signed release",
        "NOASSERTION means licensing remains undecided; this metadata grants no additional reuse rights",
    ]
    if public_page:
        limitations.append("github_pages is the intended project-page surface only; Pages and production remain unpublished")
    return {
        "schema_version": "freedom.project/v1", "kind": "Project",
        "project_id": f"project:{meta['slug']}", "slug": meta["slug"], "name": meta["name"],
        "summary": meta["summary"], "project_type": meta["type"], "lifecycle": "incubating",
        "description": {
            "problem": meta["summary"],
            "audiences": ["Freedom members", "maintainers and contributors"],
            "capabilities": meta["capabilities"], "limitations": limitations,
        },
        "ownership": {
            "ownership_mode": "external_owner", "accountable_team": None,
            "external_owner": account(observed["owner"]), "accountable_party_ref": "user:teddashh",
            "module_stewardship_ref": None, "vertical": meta["vertical"],
            "maintainer_teams": [], "maintainer_accounts": [account(maintainer)],
            "security_contact": maintainer["html_url"],
        },
        "repository": {
            "full_name": observed["full_name"], "html_url": repo_url,
            "repository_id": str(observed["id"]), "default_branch": observed.get("default_branch") or "main",
            "visibility": visibility, "is_fork": False, "upstream": None,
            "creation_method": "original", "source_lineage": [],
        },
        "page": {
            "publication": "platform_only" if core else "github_pages" if public_page else "withheld",
            "requested_trust_label": "incubating", "source": "generated",
            "canonical_platform_url": STAGING_URL,
            "github_pages_url": page_url if public_page else None,
            "exception_reason": None if public_page else "Internal staging entry only; no separate public project page is deployed." if core else "Community automation metadata is not published as a project page.",
            "required_sections": schema["properties"]["page"]["properties"]["required_sections"]["const"],
        },
        "fork_policy": {
            "mode": "allowed" if visibility == "public" else "disabled",
            "allowed_purposes": ["contribution"] if visibility == "public" else [],
            "allow_private_forks": False, "new_independent_project_method": "template",
            "official_status_inherited": False, "fork_badge": "Community fork — not an official Freedom release",
        },
        "release": {
            "policy": "freedom.semver-immutable/v1" if not community else "freedom.no-release/v1",
            "tag_format": "vMAJOR.MINOR.PATCH[-PRERELEASE]" if not community else None,
            "source_branch": "main", "immutable": not community,
            "page_from": "published_release" if not community else "none",
        },
        "toolchain": {
            "profile": "freedom.custom-reviewed/v1", "runtime_version_file": ".tool-versions",
            "package_manager": "npm", "lockfile": "package-lock.json", "commands_source": "trusted_build_profile",
        },
        "licensing": {"spdx_expression": "NOASSERTION", "license_file": None, "source_distribution": "source_available", "commercial_terms_url": None},
        "deployment": {
            "runtime": meta["runtime"],
            "environments": {
                "preview": {
                    "provider": "none", "trigger": "none", "url": None, "requires_human_approval": False,
                    "external_fork_policy": "artifact_only", "external_fork_preview_exception": "trusted_manual_two_stage_static_only",
                },
                "staging": {"provider": "external" if core else "none", "trigger": "manual" if core else "none", "url": STAGING_URL if core else None, "requires_human_approval": False},
                "production": {"provider": "none", "trigger": "none", "url": None, "requires_human_approval": False},
            },
            "database_migration_strategy": "expand_backfill_switch_contract" if core else "none",
        },
        "data_boundary": {
            "classification": "internal" if core else "public", "platform_record_types": meta.get("records", []),
            "customer_data_mode": "platform_owned_with_explicit_basis" if core else "none",
            "credential_reference_metadata_in_postgres": False, "dynamic_credential_storage": ["none"],
            "credential_root_key_storage": "none", "stores_payment_instrument_data": False,
            "stores_plaintext_credentials": False, "external_systems_of_record": ["github"],
        },
        "quality": {
            "required_checks": ["manifest/schema", "manifest/github-consistency", "test", "page/build", "security", "release-policy"],
            "minimum_human_reviews": 1, "production_human_approval": True,
            "sensitive_paths": ["freedom.project.yaml", ".github/**", "SECURITY.md", "LICENSE", "site/assets/brand/**"],
        },
        "links": {
            "documentation": repo_url + "/blob/main/README.md", "demo": STAGING_URL if core else None,
            "support": repo_url + "/issues", "issues": repo_url + "/issues",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repos-root", type=Path, required=True)
    parser.add_argument("--platform-root", type=Path, required=True)
    args = parser.parse_args()
    repos_root, platform_root = args.repos_root.resolve(), args.platform_root.resolve()
    schema_path = platform_root / "docs/platform-plan/contracts/project-manifest.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    targets = {name: platform_root if name == "freedom-platform" else repos_root / name for name in REPOS}
    for name, target in targets.items():
        if not target.is_dir():
            raise ValueError(f"Missing checkout for {name}: {target}")
    maintainer = github_api(f"users/{MAINTAINER}")
    if maintainer.get("login") != MAINTAINER or maintainer.get("type") != "User":
        raise ValueError("Maintainer identity no longer matches the configured GitHub user.")
    with ThreadPoolExecutor(max_workers=4) as executor:
        observed = dict(zip(REPOS, executor.map(github_api, (f"repos/{ORG}/{name}" for name in REPOS))))
    manifests = {name: manifest(name, observed[name], maintainer, schema) for name in REPOS}
    for name, value in manifests.items():
        errors = sorted(validator.iter_errors(value), key=lambda error: str(list(error.path)))
        if errors:
            details = "; ".join(f"{list(error.path)}: {error.message}" for error in errors)
            raise ValueError(f"{name} does not satisfy canonical project manifest schema: {details}")
    # Validate every identity and schema before writing any destination.
    for name, value in manifests.items():
        target = targets[name]
        (target / "freedom.project.yaml").write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (target / ".tool-versions").write_text("nodejs 24.21.0\n", encoding="utf-8")
        print(f"{name}: observed repository_id={value['repository']['repository_id']}; manifest/schema PASS")
    print("Wrote 9 local manifests and runtime files. No GitHub settings, publication or licensing changed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, OSError, json.JSONDecodeError) as error:
        print(f"Manifest generation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
