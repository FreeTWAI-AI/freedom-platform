"""Static contract assertions only; these do not execute a product state machine."""
from pathlib import Path
import yaml

C = Path(__file__).resolve().parents[1]
S = yaml.safe_load((C / 'state-machines/core.example.yaml').read_text())
W = S['machines']['work_item']
CLAIM = S['machines']['work_claim']

def transition(command, machine=W):
    return next(t for t in machine['transitions'] if t['command'] == command)

def test_waiting_is_not_lifecycle_state():
    states = {W['initial'], *W['terminal']}
    for t in W['transitions']:
        states.update(t['from'] if isinstance(t['from'], list) else [t['from']])
        states.add(t['to'])
    assert states == {'draft', 'open', 'active', 'claiming_closed', 'accepted', 'cancelled', 'expired'}

def test_publish_without_reviewer_is_open():
    t = transition('publish_review_required_without_current_reviewer_capacity')
    assert t['to'] == 'open'
    assert t['event'] == 'freedom.work.item.opened.v1'
    assert 'participation_terms_declared_or_pre_revision_legacy_explicitly_unclassified' in t['guards']

def test_ordinary_open_has_no_reviewer_gate():
    assert all('reviewer' not in g and 'capacity' not in g for g in transition('open')['guards'])

def test_claims_pin_terms_without_reviewer_gate():
    for command in ['add_first_nonexclusive_claim', 'add_additional_nonexclusive_claim', 'add_exclusive_claim_atomically']:
        t = transition(command)
        assert all('reviewer' not in g for g in t['guards'])
        assert any('terms_revision_and_digest' in g for g in t['guards'])
        assert any('pin_terms_snapshot' in e for e in t['effects'])

def test_capacity_change_does_not_reopen_work():
    assert not any(t['command'] == 'reviewer_capacity_becomes_available' for t in W['transitions'])
    p = S['projections']['review_capacity_navigation']
    assert 'waiting_reviewer_capacity' in str(p)
    assert p['enforcement'] == 'navigation'
    assert 'work_item_lifecycle' in str(p)
    assert 'claimability' in str(p)

def test_reviewer_qualification_is_not_promised_time():
    assert 'reviewer_appointment_is_qualification_not_a_reservation_of_human_time' in W['invariants']
    assert 'new_guaranteed_human_support_requires_accepted_atomic_capacity_reservation' in W['invariants']

def test_voluntary_expiry_preserves_protected_obligations():
    for machine in [W, CLAIM]:
        assert 'no_protected_obligations' in transition('expire', machine)['guards']
    assert 'no_submitted_unresolved_claims' in transition('expire')['guards']

def test_claim_exit_never_erases_contractual_duties():
    for command in ['claimant_releases', 'cancel_with_reason']:
        t = transition(command, CLAIM)
        assert any('protected_obligation' in g for g in t['guards'])
        assert any('retain_outstanding' in e for e in t['effects'])

def test_no_automatic_core_backfill():
    assert 'no_support_card_creates_an_obligation_for_core_or_volunteers_to_backfill' in W['invariants']

def test_fw06_can_modify_the_two_source_contracts():
    s = (C.parent / 'execution/first-work-batch.md').read_text()
    section = s.split('FW-06', 1)[1].split('FW-07', 1)[0]
    assert 'contracts/state-machines/core.example.yaml' in section
    assert 'contracts/agent-work-contract.example.yaml' in section

def test_state_machine_aggregate_count_not_increased():
    assert len(S['machines']) == 56

def test_capacity_never_changes_person_fields():
    p = S['projections']['review_capacity_navigation']
    for field in ['membership', 'rank', 'entitlement', 'discoverability']:
        assert field in p['never_changes']
    assert 'work_item_lifecycle' in p['never_changes']
    assert 'claimability' in p['never_changes']

def test_support_card_is_idempotent_upsert_per_scope_episode():
    t = transition('publish_review_required_without_current_reviewer_capacity')
    assert any('upsert_one_scope_episode' in e for e in t['effects'])
    p = S['projections']['review_capacity_navigation']
    assert any('upsert_or_resolve_one_scope_episode_card' in e for e in p['on_capacity_changed'])
    assert 'no_support_card_creates_an_obligation_for_core_or_volunteers_to_backfill' in W['invariants']

def test_capacity_updates_route_card_official_only():
    p = S['projections']['review_capacity_navigation']
    assert 'recompute_navigation_and_route_only' in p['on_capacity_changed']
    assert 'do_not_set_official_true_without_exact_review_evidence' in p['on_capacity_changed']
    assert 'do_not_reopen_work_item_or_emit_work_item_opened' in p['on_capacity_changed']
    assert 'capacity_change_alone_never_changes_lifecycle_claimability_or_sets_official_true' in W['invariants']

def test_agent_work_contract_capacity_parity():
    import yaml as _yaml
    aw = _yaml.safe_load((C / 'agent-work-contract.example.yaml').read_text())
    wi = aw['work_item']
    assert wi['states'] == ['draft', 'open', 'active', 'claiming_closed', 'accepted', 'cancelled', 'expired']
    assert 'waiting_reviewer_capacity' not in wi['states']
    assert wi['capacity_rule'] == 'waiting_reviewer_capacity_is_orthogonal_navigation_never_lifecycle_or_claim_gate'
    assert 'appointment_is_qualification' in wi['human_support_rule']
