import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureRoot, put } from './fixtures.mjs';
import { verificationEnvironment } from '../process-env.mjs';
import { decodeBehaviorResponseFrame, materializeBehaviorCandidate, validateBehaviorDependencyCache } from '../behavior-supervisor.mjs';

const bytes = value => Buffer.from(JSON.stringify(value));
const frame = { id: 1, status: 200, headers: [['content-type', 'application/json']], body: Buffer.from('{}').toString('base64') };
test('dependency identity rejects a different node_modules cache before fixture creation', async t => {
  const root = await fixtureRoot(t), cache = join(root, 'node_modules');
  await mkdir(cache);
  await assert.rejects(validateBehaviorDependencyCache(cache), /supervisor_dependencies_invalid/);
});
test('isolated transport accepts only bounded response fields, never candidate results/identity', () => {
  assert.equal(decodeBehaviorResponseFrame(bytes(frame), 1).body.toString(), '{}');
  for (const value of [{ ...frame, id: 2 }, { ...frame, check: { status: 'passed' } },
    { ...frame, observation: {} }, { ...frame, binding: {} }, { ...frame, status: 101 },
    { ...frame, headers: Array(129).fill(['x', 'v']) }, { ...frame, headers: [['x', 'a'.repeat(17000)]] },
    { ...frame, body: 'e30' }, { ...frame, body: 'e31=' }, { ...frame, body: Buffer.alloc(262145).toString('base64') }]) {
    assert.throws(() => decodeBehaviorResponseFrame(bytes(value), 1));
  }
  assert.throws(() => decodeBehaviorResponseFrame(Buffer.from(JSON.stringify(frame).replace(/^\{/, '{"id":1,')), 1));
});
function git(root, args) {
  return execFileSync('git', args, { cwd: root, env: { ...verificationEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' },
  stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
test('candidate export reads committed blobs and rejects symlinks, not mutable worktree values', async t => {
  const root = await fixtureRoot(t), repo = join(root, 'repo'), out = join(root, 'out');
  await mkdir(repo); await mkdir(out); git(repo, ['init', '-q']);
  await put(repo, 'value.txt', 'committed'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Synthetic source']);
  const commit = git(repo, ['rev-parse', 'HEAD']); await put(repo, 'value.txt', 'uncommitted');
  const result = await materializeBehaviorCandidate(repo, commit, out);
  assert.equal(await readFile(join(out, 'value.txt'), 'utf8'), 'committed'); assert.equal(result.commit, commit);
  await symlink('/etc/passwd', join(repo, 'escape')); git(repo, ['add', 'escape']); git(repo, ['commit', '-qm', 'Synthetic symlink']);
  await assert.rejects(materializeBehaviorCandidate(repo, git(repo, ['rev-parse', 'HEAD']), join(root, 'unsafe')), /supervisor_nonregular_candidate/);
});
