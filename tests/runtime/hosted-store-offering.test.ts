import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {seedLocal} from '../../packages/testing/seed.js';
import {ApplicationPageSchema} from '../../contracts/guild-launchpad/v1/module-registry.js';
import {createRegistryHarness, type RegistryHarness} from './module-registry-harness.js';

const commerce = 'guild_commerce_sales';
const production = 'guild_commercial_production';
let h: RegistryHarness;
before(async () => {
  h = await createRegistryHarness('fp_store_offer');
  assert.equal((await platformOffer()).length, 1, 'Migration installs the offering before any seed reset');
});
after(async () => {await h.stop();});
beforeEach(async () => {await h.reset();});
async function platformOffer() {
  return (await h.pool.query(`SELECT community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version::text AS version
    FROM guild_application_offerings WHERE community_id IS NULL AND guild_key IS NULL AND application_key='hosted-store'`)).rows;
}
test('migration and seed keep exactly one platform hosted-store offering with the definition policy', async () => {
  const policy = (await h.pool.query("SELECT launch_policy_ref FROM application_definitions WHERE release_ref='hosted-store@1.0.0'")).rows[0].launch_policy_ref;
  assert.deepEqual(await platformOffer(), [{community_id: null, guild_key: null, application_key: 'hosted-store', release_ref: 'hosted-store@1.0.0', status: 'offered', display_order: 10, launch_policy_ref: policy, version: '1'}]);
  assert.deepEqual(policy, {policy_key: 'hosted-store.launch', version: '1'});
});
test('seedLocal restores the hosted offering after community truncation and stays idempotent', async () => {
  await h.pool.query('TRUNCATE communities CASCADE');
  assert.deepEqual(await platformOffer(), []);
  await seedLocal(h.pool); const first = await platformOffer();
  assert.equal(first.length, 1);
  await seedLocal(h.pool); assert.deepEqual(await platformOffer(), first);
});
test('commerce recommends hosted-store then manual-workspace while production keeps manual-workspace', async () => {
  const session = (await h.person('商店會員')).session;
  for (const [guild, expected] of [[commerce, ['hosted-store', 'manual-workspace']], [production, ['manual-workspace']]] as const) {
    await h.fullMember(session.user.user_id, guild);
    const result = await h.call('GET', `/guilds/${guild}/launchpad`, session);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.config.body.application_refs.map((ref: {application_key: string}) => ref.application_key), expected);
    assert.equal(result.data.config.revision, '4'); assert.equal(result.data.config.pointer_version, '1');
  }
});
test('full commerce members can start with no space and can launch after creating one; interns are refused', async () => {
  const session = (await h.person('商店資格會員')).session;
  await h.fullMember(session.user.user_id, commerce);
  async function eligibility() {
    const result = await h.call('GET', `/applications?guild_key=${commerce}`, session);
    assert.equal(result.status, 200);
    const item = ApplicationPageSchema.parse(result.data).items.find(app => app.application_key === 'hosted-store');
    assert.ok(item?.eligibility); return item.eligibility;
  }
  assert.deepEqual(await eligibility(), {can_launch: false, reason_codes: ['tenant_manage_required'], required_guild_tier: 'full', tenant_action: 'create', policy_revision: '1'});
  await h.createTenant(session, '選物工作室');
  assert.deepEqual(await eligibility(), {can_launch: true, reason_codes: [], required_guild_tier: 'full', tenant_action: 'select', policy_revision: '1'});
  await h.fullMember(session.user.user_id, commerce, 'intern');
  assert.deepEqual(await eligibility(), {can_launch: false, reason_codes: ['guild_full_member_required'], required_guild_tier: 'full', tenant_action: 'denied', policy_revision: '1'});
});
test('withdrawn hosted offering makes the commerce default fall back to manual-workspace', async () => {
  const session = (await h.person('商店撤回會員')).session;
  await h.fullMember(session.user.user_id, commerce);
  await h.pool.query("UPDATE guild_application_offerings SET status='withdrawn',version=version+1 WHERE community_id IS NULL AND guild_key IS NULL AND release_ref='hosted-store@1.0.0'");
  const result = await h.call('GET', `/guilds/${commerce}/launchpad`, session);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.config.body.application_refs, [{application_key: 'manual-workspace', release_ref: 'manual-workspace@1.0.0', order: 0}]);
});
