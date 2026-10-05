import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { exportConsumerLibraries, LIBRARY_TOOL_FILES } from '../export.mjs';
import { CONSUMER_LIBRARIES, AGENT_KIT_DEVICE_LIBRARY_PROFILE, LEGACY_LIBRARY_PROFILE,
  verifyConsumerLibraries, LIBRARY_LOCK, LIBRARY_PREFIX } from '../consumer-libraries.mjs';
import { sha256 } from '../io.mjs';
import { fixtureRoot, put } from './fixtures.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = root => {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic fixture']);
  return git(root, ['rev-parse', 'HEAD']);
};
async function setup(t) {
  const sourceRoot = await fixtureRoot(t), destinations = [];
  git(sourceRoot, ['-c', 'init.templateDir=', 'init', '--quiet']);
  for (const repository of Object.keys(CONSUMER_LIBRARIES)) {
    const root = await fixtureRoot(t);
    git(root, ['-c', 'init.templateDir=', 'init', '--quiet']);
    await put(root, 'contracts.lock.json', '{"fixture":"unchanged preview lock"}\n');
    await put(root, 'vendor/freedom-platform/bundle.json', '{"fixture":"unchanged preview bytes"}\n');
    destinations.push({ root, repository, commit: commit(root) });
  }
  await put(sourceRoot, 'repositories.lock.json', JSON.stringify({ repositories: destinations.map(({ repository, commit }) => ({ repository, commit })) }));
  const canonical = fileURLToPath(new URL('../../../', import.meta.url));
  for (const path of [...new Set(Object.values(CONSUMER_LIBRARIES).flat()), ...LIBRARY_TOOL_FILES, 'scripts/repository-bootstrap/verify-consumer-libraries.mjs']) {
    await put(sourceRoot, path, await readFile(join(canonical, path)));
  }
  const expectedSourceCommit = commit(sourceRoot);
  return { sourceRoot, destinations, expectedSourceCommit };
}

test('exports exact pinned consumers without changing preview and independently verifies source bytes', async t => {
  const { sourceRoot, destinations, expectedSourceCommit } = await setup(t);
  const report = await exportConsumerLibraries(destinations, { sourceRoot, expectedSourceCommit });
  assert.equal(report.library_usage, 'not_checked');
  for (const { root, repository } of destinations) {
    const verified = await verifyConsumerLibraries(root, { repository, expectedSourceCommit, sourceRoot });
    assert.equal(verified.verification, 'source_bytes_only');
    assert.equal(verified.publisher_trust, 'unverified');
    assert.equal(await readFile(join(root, 'contracts.lock.json'), 'utf8'), '{"fixture":"unchanged preview lock"}\n');
    assert.equal(await readFile(join(root, 'vendor/freedom-platform/bundle.json'), 'utf8'), '{"fixture":"unchanged preview bytes"}\n');
    const cli = spawnSync(process.execPath, ['scripts/verify-consumer-libraries.mjs', repository, expectedSourceCommit, '--source-root', sourceRoot], { cwd: root, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  }
  const module = await import(pathToFileURL(join(destinations[0].root, LIBRARY_PREFIX, CONSUMER_LIBRARIES[destinations[0].repository][0])));
  const calls = [], responses = { getSession: { user: { user_id: 'fixture' }, csrf_token: 'never-return' }, getDashboard: {}, listWorks: { items: [] }, getPositioning: {}, listGuilds: { items: [] } };
  const workspace = await module.loadMemberWorkspace({ call: async id => { calls.push(id); return responses[id]; } });
  assert.deepEqual(calls, Object.keys(responses));
  assert.equal(workspace.agent_execution_grant, false);
  assert(!JSON.stringify(workspace).includes('never-return'));
});

test('rewriting both candidate library and lock cannot forge a match to the selected source', async t => {
  const { sourceRoot, destinations, expectedSourceCommit } = await setup(t);
  await exportConsumerLibraries(destinations, { sourceRoot, expectedSourceCommit });
  const { root, repository } = destinations[0];
  const lock = JSON.parse(await readFile(join(root, LIBRARY_LOCK)));
  const fake = Buffer.from('export const forged = true;\n');
  await put(root, lock.files[0].path, fake);
  lock.files[0].bytes = fake.length; lock.files[0].sha256 = sha256(fake);
  await put(root, LIBRARY_LOCK, JSON.stringify(lock));
  await assert.rejects(verifyConsumerLibraries(root, { repository, expectedSourceCommit, sourceRoot }), { code: 'library_source_bytes_mismatch' });
  await assert.rejects(verifyConsumerLibraries(root, { repository, expectedSourceCommit: 'f'.repeat(40), sourceRoot }), { code: 'library_source_mismatch' });
  await assert.rejects(verifyConsumerLibraries(root, { repository, sourceRoot }), { code: 'expected_library_source_required' });
  await assert.rejects(verifyConsumerLibraries(root, { repository: destinations[1].repository, expectedSourceCommit, sourceRoot }), { code: 'library_source_mismatch' });
});

test('preflights every consumer and refuses dirty, wrong-base and symlink targets before writing', async t => {
  const { sourceRoot, destinations, expectedSourceCommit } = await setup(t);
  await put(destinations[1].root, 'dirty', 'untracked');
  await assert.rejects(exportConsumerLibraries(destinations, { sourceRoot, expectedSourceCommit }), { code: 'consumer_worktree_dirty' });
  assert(!((await readdir(destinations[0].root)).includes(LIBRARY_LOCK)));
  commit(destinations[1].root);
  await assert.rejects(exportConsumerLibraries(destinations, { sourceRoot, expectedSourceCommit }), { code: 'consumer_base_mismatch' });
  const next = await setup(t), outside = await fixtureRoot(t);
  await symlink(outside, join(next.destinations[1].root, 'vendor/freedom-libraries'));
  // Ignoring the path cannot turn a symbolic link into an allowed destination.
  await put(next.destinations[1].root, '.git/info/exclude', 'vendor/freedom-libraries\n');
  await assert.rejects(exportConsumerLibraries(next.destinations, { sourceRoot: next.sourceRoot, expectedSourceCommit: next.expectedSourceCommit }), { code: 'unsafe_export_destination' });
  assert(!((await readdir(next.destinations[0].root)).includes(LIBRARY_LOCK)));
  assert.deepEqual(await readdir(outside), []);
});

test('uncommitted source libraries cannot be labelled as committed exports', async t => {
  const { sourceRoot, destinations, expectedSourceCommit } = await setup(t);
  await put(sourceRoot, CONSUMER_LIBRARIES[destinations[0].repository][0], 'uncommitted');
  await assert.rejects(exportConsumerLibraries(destinations, { sourceRoot, expectedSourceCommit }), { code: 'commit_before_export' });
  assert(!((await readdir(destinations[0].root)).includes(LIBRARY_LOCK)));
});

async function adopted(t) {
  const state = await setup(t);
  await exportConsumerLibraries(state.destinations, state);
  for (const destination of state.destinations) {
    // Actual consumer code is deliberately outside the exporter's managed paths.
    await put(destination.root, 'src/index.mjs', 'export const consumerIntegration = "preserve me";\n');
    destination.upgradeFrom = { consumerCommit: commit(destination.root), sourceCommit: state.expectedSourceCommit };
  }
  const path = CONSUMER_LIBRARIES[state.destinations[0].repository][0];
  await put(state.sourceRoot, path, Buffer.concat([await readFile(join(state.sourceRoot, path)), Buffer.from('\n// Synthetic next library version.\n')]));
  return { ...state, previousSourceCommit: state.expectedSourceCommit, expectedSourceCommit: commit(state.sourceRoot) };
}

test('repeat upgrade verifies old source and exact consumer head, preserves real imports and preview bytes', async t => {
  const state = await adopted(t);
  await exportConsumerLibraries(state.destinations, state);
  for (const { root, repository, upgradeFrom } of state.destinations) {
    const lock = JSON.parse(await readFile(join(root, LIBRARY_LOCK)));
    assert.equal(lock.source_commit, state.expectedSourceCommit);
    assert.equal(lock.consumer_base_commit, upgradeFrom.consumerCommit);
    await verifyConsumerLibraries(root, { repository, expectedSourceCommit: state.expectedSourceCommit, sourceRoot: state.sourceRoot });
    assert.equal(await readFile(join(root, 'src/index.mjs'), 'utf8'), 'export const consumerIntegration = "preserve me";\n');
    assert.equal(git(root, ['diff', '--', 'contracts.lock.json', 'vendor/freedom-platform']), '');
    const changed = git(root, ['diff', '--name-only']).split('\n');
    assert(changed.every(path => path === LIBRARY_LOCK || path.startsWith(LIBRARY_PREFIX)));
  }
});

test('repeat upgrade refuses wrong selected source/head, dirty consumer and forged prior library before any write', async t => {
  const state = await adopted(t), [first, second] = state.destinations;
  const original = await readFile(join(first.root, LIBRARY_LOCK));
  await assert.rejects(exportConsumerLibraries(state.destinations, { sourceRoot: state.sourceRoot }), { code: 'expected_library_source_required' });
  await assert.rejects(exportConsumerLibraries(state.destinations, { ...state, expectedSourceCommit: state.previousSourceCommit }), { code: 'library_source_mismatch' });
  const wrongHead = state.destinations.map(item => ({ ...item, upgradeFrom: { ...item.upgradeFrom, consumerCommit: 'a'.repeat(40) } }));
  await assert.rejects(exportConsumerLibraries(wrongHead, state), { code: 'consumer_base_mismatch' });
  const wrongSource = state.destinations.map(item => ({ ...item, upgradeFrom: { ...item.upgradeFrom, sourceCommit: 'a'.repeat(40) } }));
  await assert.rejects(exportConsumerLibraries(wrongSource, state), { code: 'library_source_mismatch' });
  await put(second.root, 'src/index.mjs', 'uncommitted user changes');
  await assert.rejects(exportConsumerLibraries(state.destinations, state), { code: 'consumer_worktree_dirty' });
  assert((await readFile(join(first.root, LIBRARY_LOCK))).equals(original));
  // Even a clean, explicitly selected commit cannot make changed bytes canonical.
  const lock = JSON.parse(await readFile(join(second.root, LIBRARY_LOCK)));
  const fake = Buffer.from('export const forged = true;\n');
  await put(second.root, lock.files[0].path, fake);
  lock.files[0].bytes = fake.length; lock.files[0].sha256 = sha256(fake);
  await put(second.root, LIBRARY_LOCK, JSON.stringify(lock));
  second.upgradeFrom.consumerCommit = commit(second.root);
  await assert.rejects(exportConsumerLibraries(state.destinations, state), { code: 'library_source_bytes_mismatch' });
  assert((await readFile(join(first.root, LIBRARY_LOCK))).equals(original));
});

test('repeat upgrade refuses to overwrite modified tooling even when consumer changes are committed', async t => {
  const state = await adopted(t), [first, second] = state.destinations;
  const original = await readFile(join(first.root, LIBRARY_LOCK));
  await put(second.root, 'scripts/verify-consumer-libraries.mjs', '// consumer customization\n');
  second.upgradeFrom.consumerCommit = commit(second.root);
  await assert.rejects(exportConsumerLibraries(state.destinations, state), { code: 'library_previous_tooling_mismatch' });
  assert((await readFile(join(first.root, LIBRARY_LOCK))).equals(original));
});

const devicePath = 'packages/sdk/machine-device-client.mjs';
async function deviceUpgrade(t) {
  const state = await adopted(t);
  // Synthetic source bytes test distribution, not the separate SDK implementation.
  await put(state.sourceRoot, devicePath, 'export const deviceFixture = "version one";\n');
  state.expectedSourceCommit = commit(state.sourceRoot);
  state.destinations[0].expectedLibraryProfile = AGENT_KIT_DEVICE_LIBRARY_PROFILE;
  return state;
}

test('explicit Kit profile upgrade adds exact SDK artifact while other consumers keep v1', async t => {
  const state = await deviceUpgrade(t);
  const report = await exportConsumerLibraries(state.destinations, state);
  assert.deepEqual(report.consumers.map(item => item.library_profile), [AGENT_KIT_DEVICE_LIBRARY_PROFILE, LEGACY_LIBRARY_PROFILE, LEGACY_LIBRARY_PROFILE]);
  for (const { root, repository, expectedLibraryProfile } of state.destinations) {
    const lock = JSON.parse(await readFile(join(root, LIBRARY_LOCK)));
    assert.equal(lock.format, expectedLibraryProfile ? 'freedom.consumer-libraries/v2' : 'freedom.consumer-libraries/v1');
    assert.equal(lock.profile, expectedLibraryProfile);
    const verified = await verifyConsumerLibraries(root, { repository, expectedLibraryProfile,
      expectedSourceCommit: state.expectedSourceCommit, sourceRoot: state.sourceRoot });
    assert.equal(verified.library_usage, 'not_checked');
    assert.equal(git(root, ['diff', '--', 'contracts.lock.json', 'vendor/freedom-platform', 'src/index.mjs']), '');
  }
  const kit = state.destinations[0], args = ['scripts/verify-consumer-libraries.mjs', kit.repository, state.expectedSourceCommit, '--source-root', state.sourceRoot];
  const cli = (...extra) => spawnSync(process.execPath, [...args, ...extra], { cwd: kit.root, encoding: 'utf8' });
  assert.equal(cli('--profile', AGENT_KIT_DEVICE_LIBRARY_PROFILE).status, 0);
  assert.equal(JSON.parse(cli().stdout).code, 'library_profile_mismatch');
  for (const extra of [['--profile'], ['--profile', AGENT_KIT_DEVICE_LIBRARY_PROFILE, '--profile', LEGACY_LIBRARY_PROFILE], ['--anything', AGENT_KIT_DEVICE_LIBRARY_PROFILE]]) {
    assert.equal(cli(...extra).status, 1);
  }
  const urls = [];
  await verifyConsumerLibraries(kit.root, { repository: kit.repository, expectedLibraryProfile: AGENT_KIT_DEVICE_LIBRARY_PROFILE,
    expectedSourceCommit: state.expectedSourceCommit, remote: true, fetcher: async url => {
      urls.push(url);
      const prefix = `https://raw.githubusercontent.com/FreeTWAI-AI/freedom-platform/${state.expectedSourceCommit}/`;
      assert(url.startsWith(prefix));
      return new Response(await readFile(join(state.sourceRoot, url.slice(prefix.length))));
    } });
  assert.equal(urls.length, 2);
  assert(urls[1].endsWith('/' + devicePath));
});

test('new profile cannot be selected by lock, mispaired with source, or changed to arbitrary files', async t => {
  const state = await deviceUpgrade(t), kit = state.destinations[0];
  await exportConsumerLibraries(state.destinations, state);
  const options = { repository: kit.repository, expectedSourceCommit: state.expectedSourceCommit, sourceRoot: state.sourceRoot,
    expectedLibraryProfile: AGENT_KIT_DEVICE_LIBRARY_PROFILE };
  await assert.rejects(verifyConsumerLibraries(kit.root, { ...options, expectedSourceCommit: state.previousSourceCommit }), { code: 'library_source_mismatch' });
  await assert.rejects(verifyConsumerLibraries(kit.root, { ...options, expectedLibraryProfile: 'candidate-defined-profile' }), { code: 'unsupported_library_profile' });
  const lock = JSON.parse(await readFile(join(kit.root, LIBRARY_LOCK)));
  lock.profile = LEGACY_LIBRARY_PROFILE;
  await put(kit.root, LIBRARY_LOCK, JSON.stringify(lock));
  await assert.rejects(verifyConsumerLibraries(kit.root, options), { code: 'library_profile_mismatch' });
  lock.profile = AGENT_KIT_DEVICE_LIBRARY_PROFILE;
  lock.files[1].source_path = 'packages/sdk/arbitrary.mjs';
  await put(kit.root, LIBRARY_LOCK, JSON.stringify(lock));
  await assert.rejects(verifyConsumerLibraries(kit.root, options), { code: 'library_profile_mismatch' });
  lock.files[1].source_path = devicePath;
  const fake = Buffer.from('export const handwrittenDevice = true;\n');
  await put(kit.root, lock.files[1].path, fake);
  lock.files[1].bytes = fake.length; lock.files[1].sha256 = sha256(fake);
  await put(kit.root, LIBRARY_LOCK, JSON.stringify(lock));
  await assert.rejects(verifyConsumerLibraries(kit.root, options), { code: 'library_source_bytes_mismatch' });
});

test('wrong previous or inapplicable profile refuses entire export batch before writes', async t => {
  const state = await deviceUpgrade(t), [kit, storefront] = state.destinations;
  const before = await readFile(join(kit.root, LIBRARY_LOCK));
  kit.upgradeFrom.expectedLibraryProfile = AGENT_KIT_DEVICE_LIBRARY_PROFILE;
  await assert.rejects(exportConsumerLibraries(state.destinations, state), { code: 'library_profile_mismatch' });
  delete kit.upgradeFrom.expectedLibraryProfile;
  storefront.expectedLibraryProfile = AGENT_KIT_DEVICE_LIBRARY_PROFILE;
  await assert.rejects(exportConsumerLibraries(state.destinations, state), { code: 'unsupported_library_profile' });
  assert((await readFile(join(kit.root, LIBRARY_LOCK))).equals(before));
  assert(!git(kit.root, ['status', '--porcelain', '--untracked-files=all']));
});

test('new profile repeat upgrade requires its explicit old profile and refuses silent artifact removal', async t => {
  const state = await deviceUpgrade(t), kit = state.destinations[0];
  await exportConsumerLibraries([kit], state);
  kit.upgradeFrom = { consumerCommit: commit(kit.root), sourceCommit: state.expectedSourceCommit };
  await put(state.sourceRoot, devicePath, 'export const deviceFixture = "version two";\n');
  state.expectedSourceCommit = commit(state.sourceRoot);
  const before = await readFile(join(kit.root, LIBRARY_LOCK));
  await assert.rejects(exportConsumerLibraries([kit], state), { code: 'library_profile_mismatch' });
  kit.upgradeFrom.expectedLibraryProfile = AGENT_KIT_DEVICE_LIBRARY_PROFILE;
  await assert.rejects(exportConsumerLibraries([{ ...kit, expectedLibraryProfile: LEGACY_LIBRARY_PROFILE }], state), { code: 'library_profile_removal_unsupported' });
  assert((await readFile(join(kit.root, LIBRARY_LOCK))).equals(before));
  await exportConsumerLibraries([kit], state);
  const result = await verifyConsumerLibraries(kit.root, { repository: kit.repository, expectedLibraryProfile: AGENT_KIT_DEVICE_LIBRARY_PROFILE,
    expectedSourceCommit: state.expectedSourceCommit, sourceRoot: state.sourceRoot });
  assert.equal(result.files_verified, 2);
  assert.equal(await readFile(join(kit.root, LIBRARY_PREFIX + devicePath), 'utf8'), 'export const deviceFixture = "version two";\n');
});
