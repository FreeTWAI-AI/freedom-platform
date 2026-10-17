import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../../apps/portal-web/src/api';
import type { PartnerMaterials } from '../../contracts/guild-launchpad/v1/supplier-console';
import {
  partnerMaterialsFailureKeepsStale,
  partnerMaterialsFailureState,
} from '../../modules/agent-commerce/supplier-console/ui/partner/partner-materials';
import { acceptedMaterialPreview } from '../../modules/agent-commerce/supplier-console/ui/view';

const data = {
  profile: 'freedom.partner-materials/v1',
  tenant_id: '11111111-1111-4111-8111-111111111111',
  instance_id: '22222222-2222-4222-8222-222222222222',
  as_of: '2026-10-15T15:30:00.000Z',
  items: [],
  truncated: false,
} as PartnerMaterials;

const scope = { tenantId: 'tenant-a', instanceId: 'instance-a' };
const detail = {
  tenant_id: 'tenant-a',
  instance_id: 'instance-a',
  material: { material_id: 'material-a', current: { version_id: 'version-a' } },
};

test('M2-18 known read denial drops the private projection; transient failure keeps it explicit', () => {
  for (const error of [
    new ApiError({ message: '目前沒有這個操作的權限。', status: 403, detail: '目前沒有這個操作的權限。' }),
    new ApiError({ message: '找不到這間商店。', status: 404, detail: '找不到這間商店。' }),
    new ApiError({ message: '登入已過期，請重新登入。', status: 401 }),
    new ApiError({ message: '網站登入已過期。', status: 403, accessExpired: true }),
    new ApiError({ message: '請求未完成（400），請稍後重試。', status: 400 }),
    new ApiError({ message: '請求未完成（422），請稍後重試。', status: 422 }),
  ]) {
    assert.equal(partnerMaterialsFailureKeepsStale(error), false, `${error.status} ${error.accessExpired}`);
    const settled = partnerMaterialsFailureState(data, error);
    assert.equal(settled.data, null);
    assert.equal(settled.state.kind, 'failed');
    assert.equal(settled.state.staleData, undefined);
    assert.equal(settled.state.error, error.detail ?? error.message);
  }

  const unavailable = new ApiError({ message: '服務暫時無法回應（503）。請稍後重試。', status: 503 });
  assert.equal(unavailable.network, false);
  assert.equal(partnerMaterialsFailureKeepsStale(unavailable), true);
  const stale = partnerMaterialsFailureState(data, unavailable);
  assert.equal(stale.data, data);
  assert.equal(stale.state.staleData, data);
  assert.match(stale.state.error ?? '', /503/);

  for (const error of [
    new ApiError({ message: '服務暫時無法回應（500）。請稍後重試。', status: 500 }),
    new ApiError({ message: '無法連線到伺服器，尚未確認結果。請確認網路後重試。', network: true }),
    new ApiError({ message: '連線等候過久，尚未確認結果。請稍後重試。', status: 503, network: true, timedOut: true }),
    new ApiError({ message: '請稍後再試。', status: 429, detail: '請稍後再試。' }),
    new ApiError({ message: '請稍後再試。', status: 408 }),
    new TypeError('Failed to fetch'),
  ]) {
    assert.equal(partnerMaterialsFailureKeepsStale(error), true);
    assert.equal(partnerMaterialsFailureState(data, error).state.staleData, data);
  }

  const denied = partnerMaterialsFailureState(data, new ApiError({ message: '找不到這間商店。', status: 404 }));
  const later = partnerMaterialsFailureState(denied.data, unavailable);
  assert.equal(later.data, null);
  assert.equal(later.state.staleData, undefined);
});

test('M2-19 supplier preview retry accepts only a ready read for the same scope, material and version', () => {
  const ready = { state: 'ready' as const, data: detail };
  assert.equal(acceptedMaterialPreview(ready, scope, 'material-a', 'version-a'), detail);
  assert.equal(acceptedMaterialPreview({ state: 'loading', data: detail }, scope, 'material-a', 'version-a'), null);
  assert.equal(acceptedMaterialPreview({ state: 'failed', data: detail }, scope, 'material-a', 'version-a'), null);
  assert.equal(acceptedMaterialPreview({ state: 'ready', data: null }, scope, 'material-a', 'version-a'), null);
  assert.equal(acceptedMaterialPreview(ready, { tenantId: 'tenant-b', instanceId: 'instance-a' }, 'material-a', 'version-a'), null);
  assert.equal(acceptedMaterialPreview(ready, { tenantId: 'tenant-a', instanceId: 'instance-b' }, 'material-a', 'version-a'), null);
  assert.equal(acceptedMaterialPreview(ready, scope, 'material-b', 'version-a'), null);
  assert.equal(acceptedMaterialPreview(ready, scope, 'material-a', 'version-b'), null);
  assert.equal(acceptedMaterialPreview({ state: 'ready', data: { ...detail, material: { ...detail.material, current: null } } }, scope, 'material-a', 'version-a'), null);
});
