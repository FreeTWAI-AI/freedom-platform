"""Local read-token custody is explicit and cannot weaken platform secret boundaries."""
import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[4]
SCHEMA = json.loads((ROOT / 'docs/platform-plan/contracts/project-manifest.schema.json').read_text())
VALIDATOR = Draft202012Validator(SCHEMA)
POLICY = {
    'kind': 'scoped_read_token', 'max_lifetime_seconds': 604800,
    'local_file_mode': '0600', 'repo_storage': False, 'browser_storage': False,
}


def client_manifest():
    # Start from the real central manifest so the entire document, not a partial
    # schema fragment, is checked. The repo identity remains a semantic-check
    # responsibility; this fixture describes the changed external client role.
    manifest = json.loads((ROOT / 'freedom.project.yaml').read_text())
    manifest['project_type'] = 'storefront_template'
    manifest['data_boundary'] = {
        'classification': 'internal', 'platform_record_types': [],
        'customer_data_mode': 'external_client_owned',
        'credential_reference_metadata_in_postgres': False,
        'dynamic_credential_storage': ['client_owned'],
        'credential_root_key_storage': 'none', 'stores_payment_instrument_data': False,
        'stores_plaintext_credentials': True, 'external_systems_of_record': ['github', 'client_storage'],
        'client_credential_policy': copy.deepcopy(POLICY),
    }
    return manifest


def valid(manifest):
    errors = list(VALIDATOR.iter_errors(manifest))
    assert not errors, '\n'.join(error.message for error in errors)


def invalid(manifest):
    assert list(VALIDATOR.iter_errors(manifest)), 'Unsafe credential boundary unexpectedly accepted'


def test_real_central_manifest_remains_valid_without_plaintext_exception():
    valid(json.loads((ROOT / 'freedom.project.yaml').read_text()))


@pytest.mark.parametrize('project_type', ['storefront_template', 'application', 'agent_kit', 'integration'])
def test_declared_external_client_local_read_cache_is_valid(project_type):
    manifest = client_manifest()
    manifest['project_type'] = project_type
    valid(manifest)


@pytest.mark.parametrize('field,value', [
    ('customer_data_mode', 'platform_owned_with_explicit_basis'),
    ('customer_data_mode', 'none'),
    ('dynamic_credential_storage', ['client_owned', 'provider_managed']),
    ('dynamic_credential_storage', ['postgres_envelope_vault']),
    ('dynamic_credential_storage', ['none']),
    ('credential_root_key_storage', 'client_owned'),
    ('credential_root_key_storage', 'cloudflare_worker_secret'),
    ('credential_reference_metadata_in_postgres', True),
    ('platform_record_types', ['Member']),
    ('external_systems_of_record', ['github']),
])
def test_plaintext_exception_requires_every_external_client_boundary(field, value):
    manifest = client_manifest()
    manifest['data_boundary'][field] = value
    invalid(manifest)


@pytest.mark.parametrize('field,value', [
    ('kind', 'provider_api_key'), ('max_lifetime_seconds', 604801),
    ('max_lifetime_seconds', 0), ('max_lifetime_seconds', 1.5),
    ('local_file_mode', '0644'), ('repo_storage', True), ('browser_storage', True),
    ('embedded_token', 'must-never-appear-in-metadata'),
])
def test_long_lived_general_purpose_or_exposed_credentials_are_rejected(field, value):
    manifest = client_manifest()
    manifest['data_boundary']['client_credential_policy'][field] = value
    invalid(manifest)


@pytest.mark.parametrize('project_type', ['platform', 'service', 'automation_worker', 'registry'])
def test_platform_and_server_roles_cannot_claim_the_client_plaintext_exception(project_type):
    manifest = client_manifest()
    manifest['project_type'] = project_type
    invalid(manifest)


def test_plaintext_true_without_explicit_policy_is_rejected():
    manifest = client_manifest()
    del manifest['data_boundary']['client_credential_policy']
    invalid(manifest)


def test_plaintext_false_cannot_simultaneously_declare_a_plaintext_cache():
    manifest = client_manifest()
    manifest['data_boundary']['stores_plaintext_credentials'] = False
    invalid(manifest)


def test_existing_central_boundary_cannot_enable_plaintext_by_a_boolean_change():
    manifest = json.loads((ROOT / 'freedom.project.yaml').read_text())
    manifest['data_boundary']['stores_plaintext_credentials'] = True
    invalid(manifest)


def test_read_token_lifetime_can_be_shorter_than_seven_days():
    manifest = client_manifest()
    manifest['data_boundary']['client_credential_policy']['max_lifetime_seconds'] = 3600
    valid(manifest)
