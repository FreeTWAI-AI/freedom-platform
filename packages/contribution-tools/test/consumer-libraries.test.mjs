import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { exportConsumerLibraries, LIBRARY_TOOL_FILES } from '../export.mjs';
import { CONSUMER_LIBRARIES, verifyConsumerLibraries, LIBRARY_LOCK, LIBRARY_PREFIX } from '../consumer-libraries.mjs';
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
  const report = await exportConsumerLibraries(destinations, { sourceRoot });
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
  await exportConsumerLibraries(destinations, { sourceRoot });
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
  const { sourceRoot, destinations } = await setup(t);
  await put(destinations[1].root, 'dirty', 'untracked');
  await assert.rejects(exportConsumerLibraries(destinations, { sourceRoot }), { code: 'consumer_worktree_dirty' });
  assert(!((await readdir(destinations[0].root)).includes(LIBRARY_LOCK)));
  commit(destinations[1].root);
  await assert.rejects(exportConsumerLibraries(destinations, { sourceRoot }), { code: 'consumer_base_mismatch' });
  const next = await setup(t), outside = await fixtureRoot(t);
  await symlink(outside, join(next.destinations[1].root, 'vendor/freedom-libraries'));
  // Ignoring the path cannot turn a symbolic link into an allowed destination.
  await put(next.destinations[1].root, '.git/info/exclude', 'vendor/freedom-libraries\n');
  await assert.rejects(exportConsumerLibraries(next.destinations, { sourceRoot: next.sourceRoot }), { code: 'unsafe_export_destination' });
  assert(!((await readdir(next.destinations[0].root)).includes(LIBRARY_LOCK)));
  assert.deepEqual(await readdir(outside), []);
});

test('uncommitted source libraries cannot be labelled as committed exports', async t => {
  const { sourceRoot, destinations } = await setup(t);
  await put(sourceRoot, CONSUMER_LIBRARIES[destinations[0].repository][0], 'uncommitted');
  await assert.rejects(exportConsumerLibraries(destinations, { sourceRoot }), { code: 'commit_before_export' });
  assert(!((await readdir(destinations[0].root)).includes(LIBRARY_LOCK)));
});
