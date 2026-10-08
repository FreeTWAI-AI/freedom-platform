import {test, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BLOCK_KINDS, recommendedApplications, type Config} from '../../contracts/guild-launchpad/v1/config.js';
import {LaunchpadApplicationSchema} from '../../contracts/guild-launchpad/v1/module-registry.js';
import {defaultConfigFor, platformDefaultView} from '../../modules/guild-workspace/launchpad-config.js';
import {LAUNCHPAD_PROFILES} from '../../modules/guild-workspace/launchpad-profiles.js';
import {availableReleases, availableReleaseRefs} from '../../modules/module-registry/catalog.js';
import {isolatedTransaction} from '../../packages/resource-scopes/tenant-transaction.js';
import {DEMO_COMMUNITY, DEMO_USERS} from '../../packages/testing/seed.js';
import {createRegistryHarness, type RegistryHarness, type Session} from './module-registry-harness.js';

const commerce = 'guild_commerce_sales';
const production = 'guild_commercial_production';
const other = 'guild_music_mv';
const manual = {application_key: 'manual-workspace', release_ref: 'manual-workspace@1.0.0'};
const synthetic = {application_key: 'synthetic-storefront', release_ref: 'synthetic-storefront@1.0.0'};
const orders: Record<string, readonly string[]> = {
  [commerce]: ['mission', 'applications', 'my_work', 'announcements', 'skill_books', 'community_tasks', 'support'],
  [production]: ['mission', 'my_work', 'skill_books', 'announcements', 'applications', 'community_tasks', 'support'],
};
let h: RegistryHarness;
before(async () => {h = await createRegistryHarness('fp_gcfg', {synthetic: true});});
after(async () => {await h.stop();});
beforeEach(async () => {await h.reset();});

async function catalog(key: string) {
  return (await h.pool.query('SELECT guild_key, name, purpose FROM positioning_guild_catalog WHERE guild_key=$1', [key])).rows[0];
}
async function member() {
  const session = await h.signIn(DEMO_USERS[1].email);
  for (const key of [commerce, production, other]) await h.fullMember(session.user.user_id, key);
  return session;
}
async function leader() {
  const session = await h.signIn(DEMO_USERS[0].email);
  await h.fullMember(session.user.user_id, commerce);
  await h.pool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)
    ON CONFLICT (community_id,guild_key) DO UPDATE SET user_id=$3`, [DEMO_COMMUNITY, commerce, session.user.user_id]);
  return session;
}
async function offer() {
  const id = randomUUID();
  await h.pool.query(`INSERT INTO guild_application_offerings(
      offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,$4,$5,'offered',20,'{"policy_key":"synthetic-storefront.launch","version":"1"}',1)`,
  [id, DEMO_COMMUNITY, commerce, synthetic.application_key, synthetic.release_ref]);
  return id;
}
async function publish(session: Session, config: Config, pointer: string) {
  const draft = await h.post(`/guilds/${commerce}/launchpad-config/drafts`, session, {body: config}, `"${pointer}"`);
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const published = await h.post(`/guilds/${commerce}/launchpad-config/${draft.data.config_id}/publish`, session,
    {expected_body_sha256: draft.data.body_sha256}, `"${draft.data.pointer_version}"`);
  assert.equal(published.status, 200, JSON.stringify(published.data));
  return published.data;
}
const keys = (items: readonly {application_key: string}[]) => items.map(item => item.application_key);

test('purpose profiles are frozen, pure and preserve every unprofiled default', async () => {
  assert.deepEqual(Object.keys(LAUNCHPAD_PROFILES).sort(), [production, commerce].sort());
  assert.ok(Object.isFrozen(LAUNCHPAD_PROFILES));
  for (const key of [commerce, production, other]) {
    const guild = await catalog(key);
    const body = defaultConfigFor(guild, [synthetic, manual, {...manual, release_ref: 'manual-workspace@2.0.0'}]);
    assert.deepEqual(body.blocks.map(block => block.kind), orders[key] ?? BLOCK_KINDS);
    assert.deepEqual(body.blocks.map(block => block.order), [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(body.blocks.every(block => block.enabled && block.title === null));
    assert.deepEqual(body.application_refs, key === other ? [] : [{...manual, order: 0}]);
    assert.deepEqual(defaultConfigFor(guild).application_refs, []);
    assert.deepEqual(defaultConfigFor(guild, [synthetic]).application_refs, []);
    const profile = LAUNCHPAD_PROFILES[key];
    if (profile) {
      assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.block_order) && Object.isFrozen(profile.preferred_applications));
    }
  }
  const view = platformDefaultView(await catalog(commerce), undefined, [manual]);
  assert.equal(view.revision, '2');
  assert.equal(view.pointer_version, '1');
});

test('recommendations match exact release pairs, sort refs and drop duplicate and missing matches', () => {
  const apps = [manual, synthetic, {...synthetic, release_ref: 'synthetic-storefront@2.0.0'}];
  const refs = [{...manual, order: 8}, {...synthetic, order: 3}, {...synthetic, order: 6}, {application_key: 'absent', release_ref: 'absent@1', order: 0}];
  assert.deepEqual(recommendedApplications(refs, apps), [synthetic, manual]);
  assert.equal(recommendedApplications(refs, apps)[0], apps[1]);
  assert.deepEqual(refs.map(ref => ref.order), [8, 3, 6, 0]);
  assert.deepEqual(recommendedApplications([], apps), []);
});

test('member, public and leader defaults use revision 2 with pointer 1 and scoped recommendations', async () => {
  const session = await member();
  for (const key of [commerce, production, other]) {
    const view = await h.call('GET', `/guilds/${key}/launchpad`, session);
    const pub = await h.call('GET', `/public/guilds/${key}/launchpad`);
    assert.equal(view.status, 200, JSON.stringify(view.data));
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    for (const config of [view.data.config, pub.data.config]) {
      assert.equal(config.revision, '2');
      assert.deepEqual(config.body.blocks.map((block: {kind: string}) => block.kind), orders[key] ?? BLOCK_KINDS);
      assert.deepEqual(config.body.application_refs, key === other ? [] : [{...manual, order: 0}]);
    }
    assert.equal(view.data.config.pointer_version, '1');
    const applications = LaunchpadApplicationSchema.array().parse(view.data.applications);
    assert.equal(applications.find(app => app.application_key === manual.application_key)?.display_name, '人工工作空間');
    assert.equal(view.response.headers.get('cache-control'), 'private, no-store');
  }
  const owner = await leader();
  const initial = await h.call('GET', `/guilds/${commerce}/launchpad-config`, owner);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data.body.application_refs, [{...manual, order: 0}]);
  assert.equal(initial.data.revision, '2');
  assert.equal(initial.data.pointer_version, '1');
  const closed = await h.call('GET', `/guilds/${commerce}/launchpad`, session, undefined, {}, h.closed);
  assert.equal(closed.status, 404);
});

test('published recommendation order selects the primary application without affecting another guild', async () => {
  await offer();
  const owner = await leader();
  const session = await member();
  await h.createTenant(session, '推薦測試空間');
  const originalProduction = (await h.call('GET', `/guilds/${production}/launchpad`, session)).data;
  const initial = (await h.call('GET', `/guilds/${commerce}/launchpad-config`, owner)).data;
  let pointer = initial.pointer_version;
  for (const refs of [[synthetic, manual], [manual, synthetic], []]) {
    const body = {...initial.body, application_refs: refs.map((ref, order) => ({...ref, order}))};
    const published = await publish(owner, body, pointer);
    pointer = published.pointer_version;
    const view = await h.call('GET', `/guilds/${commerce}/launchpad`, session);
    assert.equal(view.status, 200);
    const recommended = recommendedApplications(view.data.config.body.application_refs, LaunchpadApplicationSchema.array().parse(view.data.applications));
    assert.deepEqual(keys(recommended), keys(refs));
    assert.equal(recommended[0]?.application_key, refs[0]?.application_key);
    if (refs.length) assert.ok(recommended[0].eligibility.can_launch);
    assert.deepEqual((await h.call('GET', `/guilds/${production}/launchpad`, session)).data, originalProduction);
  }
});

test('first draft accepts If-Match 1 and stale pointer remains a 412 conflict', async () => {
  const owner = await leader();
  const initial = (await h.call('GET', `/guilds/${commerce}/launchpad-config`, owner)).data;
  const body = {body: initial.body};
  const first = await h.post(`/guilds/${commerce}/launchpad-config/drafts`, owner, body, '"1"');
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.revision, '1');
  assert.equal(first.data.pointer_version, '2');
  const stale = await h.post(`/guilds/${commerce}/launchpad-config/drafts`, owner, body, '"1"');
  assert.equal(stale.status, 412);
  assert.equal(stale.data.code, 'version_conflict');
});

test('withdrawn releases disappear from public refs and member recommendations while views stay readable', async () => {
  const offering = await offer();
  const owner = await leader();
  const session = await member();
  const initial = (await h.call('GET', `/guilds/${commerce}/launchpad-config`, owner)).data;
  await publish(owner, {...initial.body, application_refs: [synthetic, manual].map((ref, order) => ({...ref, order}))}, initial.pointer_version);
  assert.deepEqual((await h.call('GET', `/public/guilds/${commerce}/launchpad`)).data.config.body.application_refs.map((ref: {application_key: string}) => ref.application_key), keys([synthetic, manual]));
  await h.pool.query("UPDATE guild_application_offerings SET status='withdrawn',version=version+1 WHERE offering_id=$1", [offering]);
  const view = await h.call('GET', `/guilds/${commerce}/launchpad`, session);
  const pub = await h.call('GET', `/public/guilds/${commerce}/launchpad`);
  assert.equal(view.status, 200);
  assert.equal(pub.status, 200);
  assert.deepEqual(keys(pub.data.config.body.application_refs), ['manual-workspace']);
  assert.deepEqual(keys(recommendedApplications(view.data.config.body.application_refs, view.data.applications)), ['manual-workspace']);
});

test('available releases use catalog winner precedence and retain the release-ref filtering set', async () => {
  const offered = await offer();
  await h.pool.query(`INSERT INTO guild_application_offerings(
      offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,NULL,NULL,$2,$3,'offered',0,'{"policy_key":"synthetic-storefront.launch","version":"1"}',1)`,
  ['00000000-0000-4000-8000-000000000001', synthetic.application_key, synthetic.release_ref]);
  await isolatedTransaction(h.pool, async q => {
    const releases = await availableReleases(q, commerce, DEMO_COMMUNITY);
    assert.deepEqual(releases, [manual, synthetic]);
    assert.deepEqual(await availableReleaseRefs(q, commerce, DEMO_COMMUNITY), new Set(releases.map(ref => ref.release_ref)));
    assert.deepEqual(await availableReleases(q, commerce, null), [synthetic, manual]);
  });
  await h.pool.query("UPDATE guild_application_offerings SET status='withdrawn',version=version+1 WHERE offering_id=$1", [offered]);
  await isolatedTransaction(h.pool, async q => {
    assert.deepEqual(await availableReleases(q, commerce, DEMO_COMMUNITY), [synthetic, manual]);
  });
});
