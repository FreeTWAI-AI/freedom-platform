import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixtureRoot, put } from './fixtures.mjs';
import { verificationEnvironment } from '../process-env.mjs';

const env = { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (root, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
  cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const commit = root => {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic checkout fixture']);
  return git(root, ['rev-parse', 'HEAD']);
};
async function setup(t) {
  const directory = await fixtureRoot(t), canonical = join(directory, 'canonical'), candidate = join(directory, 'candidate');
  await mkdir(canonical);
  git(canonical, ['-c', 'init.templateDir=', 'init', '--quiet']);
  await put(canonical, 'README.md', 'Synthetic source object.\n');
  const source = commit(canonical);
  await put(canonical, 'scripts/checkout-repositories.mjs', await readFile(new URL('../../../scripts/checkout-repositories.mjs', import.meta.url)));
  await put(canonical, 'repositories.lock.json', JSON.stringify({ consumer_library_source: { repository: 'FreeTWAI-AI/freedom-platform', commit: source }, repositories: [] }));
  const head = commit(canonical);
  git(directory, ['clone', '--quiet', '--depth=1', '--no-local', pathToFileURL(canonical).href, candidate]);
  // Keep the real entrypoint and exact HTTPS URL; only this isolated fixture's
  // Git transport maps that URL to its synthetic local canonical repository.
  git(candidate, ['config', 'url.' + pathToFileURL(canonical).href + '.insteadOf', 'https://github.com/FreeTWAI-AI/freedom-platform.git']);
  const run = () => spawnSync(process.execPath, ['scripts/checkout-repositories.mjs'], {
    cwd: candidate, env: { ...env, FREEDOM_REPOSITORIES_ROOT: join(directory, 'consumers') }, encoding: 'utf8', timeout: 15000,
  });
  return { directory, canonical, candidate, source, head, run };
}

test('existing checkout entrypoint fetches a missing exact source into a shallow checkout without changing HEAD or files', async t => {
  const { candidate, source, head, run, canonical } = await setup(t);
  assert.throws(() => git(candidate, ['cat-file', '-e', source + '^{commit}']));
  const result = run(); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(candidate, ['rev-parse', source + '^{commit}']), source);
  assert.equal(git(candidate, ['rev-parse', 'HEAD']), head);
  assert.equal(git(candidate, ['status', '--porcelain']), '');
  // A cached exact source needs no network and must not replace local edits.
  git(candidate, ['config', '--unset', 'url.' + pathToFileURL(canonical).href + '.insteadOf']);
  git(candidate, ['config', 'url.file:///nonexistent-canary-source.insteadOf', 'https://github.com/FreeTWAI-AI/freedom-platform.git']);
  await writeFile(join(candidate, 'README.md'), 'Keep local work.\n');
  const again = run(); assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(await readFile(join(candidate, 'README.md'), 'utf8'), 'Keep local work.\n');
  assert.equal(git(candidate, ['rev-parse', 'HEAD']), head);
});

test('missing, mutable, or unavailable lock source fails instead of using candidate HEAD', async t => {
  const { candidate, source, run } = await setup(t);
  for (const pin of [undefined, { repository: 'FreeTWAI-AI/freedom-platform', commit: 'main' },
    { repository: 'other/source', commit: source }, { repository: 'FreeTWAI-AI/freedom-platform', commit: 'f'.repeat(40) }]) {
    await writeFile(join(candidate, 'repositories.lock.json'), JSON.stringify({ consumer_library_source: pin, repositories: [] }));
    const result = run(); assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /consumer-library-source/);
  }
});
