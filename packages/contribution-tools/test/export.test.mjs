import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { exportPreviewBundle, PORTABLE_TOOL_FILES } from '../export.mjs';
import { fixtureRoot, put } from './fixtures.mjs';

async function producer(t) {
  const root = await fixtureRoot(t), source = fileURLToPath(new URL('../../../', import.meta.url));
  const bundle = JSON.parse(await readFile(join(source, 'contracts/preview/v1/bundle.json')));
  const files = ['bundle.json', ...Object.keys(bundle.files)].map(path => `contracts/preview/v1/${path}`);
  files.push(...PORTABLE_TOOL_FILES, ...['verify-contracts.mjs', 'verify-project-manifest.py', 'freedom.mjs']
    .map(name => 'scripts/repository-bootstrap/' + name));
  for (const path of files) await put(root, path, await readFile(join(source, path)));
  const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['-c', 'init.templateDir=', 'init', '--quiet']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic producer']);
  return root;
}

test('exports one shared verifier with unchanged preview bytes to explicit local consumers', async t => {
  const sourceRoot = await producer(t), first = await fixtureRoot(t), second = await fixtureRoot(t);
  const result = await exportPreviewBundle([first, second], { sourceRoot });
  assert.equal(result.consumer_count, 2);
  for (const destination of [first, second]) {
    const run = spawnSync(process.execPath, ['scripts/verify-contracts.mjs'], { cwd: destination, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).profile, 'legacy_preview');
    const cli = spawnSync(process.execPath, ['scripts/freedom.mjs', 'unknown'], { cwd: destination, encoding: 'utf8' });
    assert.equal(cli.status, 1); assert.equal(JSON.parse(cli.stdout).code, 'unknown_command');
    assert((await readFile(join(destination, 'vendor/freedom-platform/bundle.json')))
      .equals(await readFile(join(sourceRoot, 'contracts/preview/v1/bundle.json'))));
    for (const path of PORTABLE_TOOL_FILES) {
      assert((await readFile(join(destination, 'vendor/freedom-tooling', path))).equals(await readFile(join(sourceRoot, path))));
    }
  }
});

test('three independent synthetic consumers use the exact central context library', async t => {
  const sourceRoot = await producer(t);
  for (const name of ['freedom-agent-kit', 'freedom-node', 'freedom-extension']) {
    const root = await fixtureRoot(t);
    await exportPreviewBundle([root], { sourceRoot });
    for (const path of ['AGENTS.md', 'README.md', 'CONTRIBUTING.md']) await put(root, path, '# Synthetic consumer\n');
    await put(root, '.gitignore', '.freedom/\n');
    await put(root, 'package.json', JSON.stringify({ name }));
    await put(root, 'modules/client/freedom.module.json', JSON.stringify({
      format: 'freedom.module/v1', module_id: 'client', owner_role: 'consumer', owned_paths: ['modules/client/**'],
      public_exports: [], dependencies: [], contract_families: ['preview'], client_profiles: ['member'],
      instructions: ['vendor/freedom-tooling/governance/README.md'], invariants: ['preview-no-execution'], tests: ['consumer.fixture'], surfaces: [],
    }));
    const git = args => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['-c', 'init.templateDir=', 'init', '--quiet']); git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic consumer']);
    const run = spawnSync(process.execPath, ['scripts/freedom.mjs', 'context', '--base-ref', 'HEAD', '--scope', 'client'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.repository, 'FreeTWAI-AI/' + name);
    assert(result.documents.some(document => document.path === 'vendor/freedom-tooling/governance/README.md'));
    assert(result.version_inputs.some(input => input.path === 'contracts.lock.json' && JSON.parse(input.content).source_commit));
    assert.equal(result.publisher_trust, 'unverified');
  }
});

test('uncommitted tooling and unsafe destinations fail before writing any consumer', async t => {
  const sourceRoot = await producer(t), first = await fixtureRoot(t), second = await fixtureRoot(t), outside = await fixtureRoot(t);
  await symlink(outside, join(second, 'vendor'));
  await assert.rejects(exportPreviewBundle([first, second], { sourceRoot }), { code: 'unsafe_export_destination' });
  assert.deepEqual(await readdir(first), []);
  assert.deepEqual(await readdir(outside), []);
  await put(sourceRoot, 'packages/contribution-tools/pin-cli.mjs', 'changed after commit');
  await assert.rejects(exportPreviewBundle([first], { sourceRoot }), { code: 'commit_before_export' });
  assert.deepEqual(await readdir(first), []);
  await assert.rejects(exportPreviewBundle([sourceRoot], { sourceRoot }), { code: 'overlapping_export_destination' });
  await assert.rejects(exportPreviewBundle([first, first], { sourceRoot }), { code: 'duplicate_export_destination' });
});
