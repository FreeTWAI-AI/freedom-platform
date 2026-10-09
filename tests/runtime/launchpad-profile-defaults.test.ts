import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BLOCK_KINDS, recommendedApplications} from '../../contracts/guild-launchpad/v1/config.js';
import {defaultConfigFor, platformDefaultView} from '../../modules/guild-workspace/launchpad-config.js';
import {LAUNCHPAD_PROFILES} from '../../modules/guild-workspace/launchpad-profiles.js';

const manual = {application_key: 'manual-workspace', release_ref: 'manual-workspace@1.0.0'};
const hosted = {application_key: 'hosted-store', release_ref: 'hosted-store@1.0.0'};
const synthetic = {application_key: 'synthetic-storefront', release_ref: 'synthetic-storefront@1.0.0'};
const guild = (guild_key: string) => ({guild_key, name: '測試公會', purpose: '測試用途'});
const talent = 'guild_talent_direction';
const workOrder = ['mission', 'my_work', 'skill_books', 'announcements', 'applications', 'community_tasks', 'support'];

test('talent defaults use only the current offered manual release; revision 4 does not advance pointer CAS', () => {
  const selected = {...manual, release_ref: 'manual-workspace@2.0.0'};
  const offered = Object.freeze([synthetic, selected, manual]);
  const body = defaultConfigFor(guild(talent), offered);
  assert.deepEqual(body.blocks.map(block => block.kind), workOrder);
  assert.deepEqual(body.application_refs, [{...selected, order: 0}]);
  assert.deepEqual(defaultConfigFor(guild(talent), [synthetic, hosted]).application_refs, []);
  assert.deepEqual(defaultConfigFor(guild(talent)).application_refs, []);
  const view = platformDefaultView(guild(talent), undefined, offered);
  assert.equal(view.revision, '4'); assert.equal(view.pointer_version, '1');
  assert.equal(platformDefaultView(guild(talent), '17', offered).pointer_version, '17');
  assert.equal(view.body.starter.title_label, '我的方向卡');
});

test('commerce, production and unprofiled guild content retain their existing default contracts', () => {
  assert.deepEqual(Object.keys(LAUNCHPAD_PROFILES).sort(), ['guild_commerce_sales', 'guild_commercial_production', talent].sort());
  assert.ok(Object.isFrozen(LAUNCHPAD_PROFILES));
  for (const profile of Object.values(LAUNCHPAD_PROFILES)) {
    assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile!.block_order) && Object.isFrozen(profile!.preferred_applications));
  }
  for (const key of ['guild_music_mv', 'guild_custom_0123456789abcdef0123456789abcdef']) {
    const body = defaultConfigFor(guild(key), [manual, hosted, synthetic]);
    assert.deepEqual(body, {
      schema_version: 'guild-launchpad.config/v1', guild_key: key, mission_override: null,
      blocks: BLOCK_KINDS.map((kind, order) => ({id: kind, kind, order, enabled: true, title: null})),
      application_refs: [], starter: {title_label: key === 'guild_music_mv' ? '歌曲／MV構想與素材來源' : '我的第一個工作', objective_hint: '寫下這次工作的目標。', note_hint: '記下過程、來源與下一步。'},
      support: {kind: 'platform_help', public_url: null}, extensions: {},
    });
  }
  const production = defaultConfigFor(guild('guild_commercial_production'), [hosted, manual]);
  assert.deepEqual(production.blocks.map(block => block.kind), workOrder);
  assert.deepEqual(production.application_refs, [{...manual, order: 0}]);
  assert.equal(production.starter.title_label, '拍攝brief／分鏡／交付');
  const commerce = defaultConfigFor(guild('guild_commerce_sales'), [manual, hosted]);
  assert.deepEqual(commerce.blocks.map(block => block.kind), ['mission', 'applications', 'my_work', 'announcements', 'skill_books', 'community_tasks', 'support']);
  assert.deepEqual(commerce.application_refs, [hosted, manual].map((ref, order) => ({...ref, order})));
  assert.equal(commerce.starter.title_label, '選品／營運待辦');
});

test('rendered leader refs control recommendations without inserting talent defaults or matching another release', () => {
  const apps = [manual, synthetic, {...synthetic, release_ref: 'synthetic-storefront@2.0.0'}];
  const refs = [{...manual, order: 8}, {...synthetic, order: 3}, {...synthetic, order: 6}, {application_key: 'absent', release_ref: 'absent@1', order: 0}];
  const snapshot = JSON.stringify(refs);
  assert.deepEqual(recommendedApplications(refs, apps), [synthetic, manual]);
  assert.equal(recommendedApplications(refs, apps)[0], apps[1]);
  assert.equal(JSON.stringify(refs), snapshot);
  assert.deepEqual(recommendedApplications([], apps), []);
  assert.deepEqual(recommendedApplications([{...manual, release_ref: 'manual-workspace@future', order: 0}], apps), []);
  assert.deepEqual(recommendedApplications([{...synthetic, order: 0}], apps), [synthetic]);
});
