"""Local structural checks; no HTTP, providers, product code, money or real users."""
from pathlib import Path
from copy import deepcopy
from datetime import datetime
from urllib.parse import unquote
import json
import re
import pytest
import yaml
from jsonschema import Draft202012Validator, FormatChecker, validators

C = Path(__file__).resolve().parents[1]
P = C.parent
SCHEMA = json.loads((C / 'work-participation.schema.json').read_text())
EX = yaml.safe_load((C / 'work-participation.example.yaml').read_text())
API = yaml.safe_load((C / 'openapi-outline.yaml').read_text())
POLICY = yaml.safe_load((C / 'operating-policy.example.yaml').read_text())

class UniqueKeyLoader(yaml.SafeLoader):
    """Reject duplicate YAML keys rather than silently accepting the last one."""

def unique_mapping(loader, node, deep=False):
    loader.flatten_mapping(node)
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError(f'duplicate YAML key {key!r} at line {key_node.start_mark.line + 1}')
        result[key] = loader.construct_object(value_node, deep=deep)
    return result
UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)

def no_duplicate_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'duplicate JSON key {key!r}')
        result[key] = value
    return result

def validator(definition):
    schema = deepcopy(SCHEMA)
    schema['$ref'] = f'#/$defs/{definition}'
    return Draft202012Validator(schema, format_checker=FormatChecker())

def check_term_fixture(terms):
    """Validate fixture-level x-invariants; not a server authorization implementation."""
    validator('ParticipationTerms').validate(terms)
    if terms['effort']['maximum_minutes'] < terms['effort']['estimated_minutes']:
        raise ValueError('maximum effort less than estimate')
    dates = {k: datetime.fromisoformat(v.replace('Z', '+00:00')) if v else None
             for k, v in terms['completion'].items() if k in ['claim_by', 'finish_by', 'feedback_due']}
    if dates['finish_by'] and dates['claim_by'] > dates['finish_by']:
        raise ValueError('claim deadline after finish')
    if dates['finish_by'] and dates['feedback_due'] and dates['feedback_due'] < dates['finish_by']:
        raise ValueError('feedback before finish')

@pytest.mark.parametrize('path', sorted(C.rglob('*.yaml')), ids=lambda p: str(p.relative_to(C)))
def test_yaml_has_unique_keys(path):
    yaml.load(path.read_text(), Loader=UniqueKeyLoader)

@pytest.mark.parametrize('path', sorted(C.rglob('*.json')), ids=lambda p: str(p.relative_to(C)))
def test_json_has_unique_keys(path):
    json.loads(path.read_text(), object_pairs_hook=no_duplicate_json)

@pytest.mark.parametrize('path', sorted(C.glob('*.schema.json')), ids=lambda p: p.name)
def test_json_schema_meta_valid(path):
    s = json.loads(path.read_text())
    validators.validator_for(s).check_schema(s)

@pytest.mark.parametrize('mode', ['voluntary', 'mutual', 'funded'])
def test_participation_examples(mode):
    check_term_fixture(EX['terms_examples'][mode])

def test_reserved_human_feedback_requires_explicit_reference():
    x = deepcopy(EX['terms_examples']['mutual'])
    x['contributor_gain'].update(kind='reciprocal_feedback', assurance='reserved_human_time')
    x['human_support'].update(promised=True, reservation_ref='synthetic_reservation_not_runtime_evidence')
    check_term_fixture(x)
    x['human_support']['reservation_ref'] = None
    assert list(validator('ParticipationTerms').iter_errors(x))

@pytest.mark.parametrize('mutation', [
    'unfunded_payment', 'funded_no_budget', 'missing_beneficiary',
    'promise_without_reservation', 'reserved_gain_without_promise',
    'funded_silent_expiry', 'negative_effort', 'missing_mode',
    'invented_property', 'gained_cash_without_funding'])
def test_invalid_terms_are_rejected(mutation):
    x = deepcopy(EX['terms_examples']['mutual'])
    if mutation == 'unfunded_payment': x['contributor_gain']['kind'] = 'payment'
    elif mutation == 'funded_no_budget': x = deepcopy(EX['terms_examples']['funded']); x['funding'] = None
    elif mutation == 'missing_beneficiary': x['beneficiary']['party_ref'] = None
    elif mutation == 'promise_without_reservation': x['human_support']['promised'] = True
    elif mutation == 'reserved_gain_without_promise': x['contributor_gain']['assurance'] = 'reserved_human_time'
    elif mutation == 'funded_silent_expiry': x = deepcopy(EX['terms_examples']['funded']); x['completion']['unanswered_outcome'] = 'expire_unclaimed'
    elif mutation == 'negative_effort': x['effort']['estimated_minutes'] = -1
    elif mutation == 'missing_mode': del x['participation_mode']
    elif mutation == 'invented_property': x['guaranteed_future_jobs'] = True
    elif mutation == 'gained_cash_without_funding': x['contributor_gain']['assurance'] = 'conditional_payment'
    assert list(validator('ParticipationTerms').iter_errors(x)), mutation

@pytest.mark.parametrize('mutation', ['too_small_maximum', 'finish_before_claim', 'feedback_before_finish'])
def test_numeric_and_date_fixture_invariants(mutation):
    x = deepcopy(EX['terms_examples']['mutual'])
    if mutation == 'too_small_maximum': x['effort']['maximum_minutes'] = 1
    elif mutation == 'finish_before_claim': x['completion']['finish_by'] = '2026-09-20T00:00:00Z'
    else: x['completion']['feedback_due'] = '2026-10-02T00:00:00Z'
    with pytest.raises(ValueError): check_term_fixture(x)

def test_self_report_example_valid():
    validator('BenefitObservationRequest').validate(EX['benefit_observation_example'])

@pytest.mark.parametrize('mutation', ['spoof_reporter', 'empty_gain', 'negative_minutes'])
def test_invalid_self_report_rejected(mutation):
    x = deepcopy(EX['benefit_observation_example'])
    if mutation == 'spoof_reporter': x['reporter_principal_ref'] = 'someone_else'
    elif mutation == 'empty_gain': x['actual_gain'] = ''
    else: x['effort_minutes']['coordination_friction'] = -1
    assert list(validator('BenefitObservationRequest').iter_errors(x))

def walk_refs(value):
    if isinstance(value, dict):
        if '$ref' in value: yield value['$ref']
        for child in value.values(): yield from walk_refs(child)
    elif isinstance(value, list):
        for child in value: yield from walk_refs(child)

def test_openapi_local_refs_resolve():
    for ref in walk_refs(API):
        if ref.startswith(('https://', 'http://')): continue
        name, _, fragment = ref.partition('#')
        if name:
            target = (C / name).resolve()
            assert target.is_file(), ref
            obj = json.loads(target.read_text()) if target.suffix == '.json' else yaml.safe_load(target.read_text())
        else: obj = API
        if fragment:
            assert fragment.startswith('/'), ref
            for token in unquote(fragment).split('/')[1:]:
                token = token.replace('~1', '/').replace('~0', '~')
                assert token in obj, ref
                obj = obj[token]

def test_no_duplicate_openapi_operation_ids():
    ids = [v['operationId'] for item in API['paths'].values() for v in item.values()
           if isinstance(v, dict) and 'operationId' in v]
    assert len(ids) == len(set(ids))

def test_benefit_write_requires_session_not_agent_token():
    op = API['paths']['/work-items/{workItemId}/benefit-observations']['post']
    assert op['security'] == [{'userSession': [], 'csrfHeader': []}]
    assert 'supersedes' in op['description'] and 'atomically' in op['description']
    for name in ['acceptance', 'payable', 'QC']: assert name in op['description']

def test_public_feed_does_not_require_private_terms():
    f = API['components']['schemas']['WorkFeedItem']
    assert 'participation_terms' not in f['properties']
    summary = f['properties']['participation_summary']
    assert not {'party_ref', 'budget_ref', 'reservation_ref'} & summary['properties'].keys()
    assert summary['additionalProperties'] is False

def test_claim_request_and_receipt_pin_terms():
    for n in ['ClaimWorkItemRequest', 'WorkClaim']:
        f = API['components']['schemas'][n]
        assert 'terms_status' in f['required']
        assert 'participation_terms_sha256' in f['properties']
        assert any('participation_terms_revision' in t.get('then', {}).get('required', []) for t in f['allOf'])

def test_event_producer_matches_existing_owner():
    event_data = yaml.safe_load((C / 'event-catalog.example.yaml').read_text())
    events = event_data['events']
    indexed = {e['type']: e for e in events}
    assert len(indexed) == len(events)
    assert indexed['freedom.work.participation_terms.revised.v1']['producer'] == indexed['freedom.work.item.opened.v1']['producer']
    assert indexed['freedom.result.benefit_observed.v1']['producer'] == indexed['freedom.result.recorded.v1']['producer']

def test_policy_not_activated_and_no_fabricated_resources():
    assert POLICY['runtime_activation'] is False
    assert POLICY['status'] == 'planning_not_activated'
    assert POLICY['active_resources']['can_claim_sustainability'] is False
    assert POLICY['active_resources']['cash_received'] is None

def test_protected_obligation_categories_remain():
    assert set(POLICY['protected_obligations']) == {'signed_delivery', 'payment', 'refund', 'safety_incident', 'formal_rights_dispute'}

def test_policy_keeps_money_disabled():
    assert POLICY['money']['money_movement_enabled'] is False
    assert POLICY['money']['default_execution_mode'] == 'record_only'

def test_revised_trials_are_still_unrun():
    s = (P / 'execution/acceptance-matrix.md').read_text()
    for ident in [f'T{i:02}' for i in range(27, 35)] + [f'UAT-M{i}' for i in range(1, 6)]:
        rows = [line for line in s.splitlines() if f'| {ident} |' in line]
        assert len(rows) == 1, ident
        assert '未跑' in rows[0], ident
