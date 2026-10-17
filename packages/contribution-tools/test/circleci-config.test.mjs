import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const config = readFileSync(new URL('../../../.circleci/config.yml', import.meta.url), 'utf8');
const command = config.split('          command: |\n')[1].split('      - run: npm ci')[0].split('\n').map(l => l.startsWith('            ') ? l.slice(12) : l).join('\n');
function run(cmd, args, cwd, env) {
  return spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 10000 });
}
test('OAuth null config SHA permits exact checkout and hashes committed config; mismatched candidate fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'circle-oauth-'));
  try {
    const repo = join(root, 'origin'), work = join(root, 'work'); mkdirSync(repo); mkdirSync(work);
    const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    for (const args of [['init'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(run('git', args, repo, env).status, 0);
    mkdirSync(join(repo, '.circleci')); writeFileSync(join(repo, '.circleci/config.yml'), config);
    assert.equal(run('git', ['add', '.'], repo, env).status, 0); assert.equal(run('git', ['commit', '-m', 'fixture'], repo, env).status, 0);
    const sha = run('git', ['rev-parse', 'HEAD'], repo, env).stdout.trim();
    const jobEnv = { ...env, CANDIDATE_SHA: sha, CIRCLE_SHA1: sha, RUNNER_SHA: '3c1ff74476d4072f5a1b8b179a1bb0faecefc461', CONFIG_SHA: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/FreeTWAI/freedom-platform.git' };
    assert.ok(!config.includes('pipeline.config.sha'));
    const result = run('bash', ['-eo', 'pipefail', '-c', command], work, jobEnv);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(join(work, '.freedom/circleci-config-source.json')));
    assert.deepEqual(evidence, { checkout_commit: sha, circle_sha1: sha, config_file_sha256: createHash('sha256').update(config).digest('hex'), config_provenance: 'oauth-same-repository-checkout-assumption' });
    const guards = command.split('git init .')[0];
    for (const change of [{ CIRCLE_SHA1: 'a'.repeat(40) }, { CANDIDATE_SHA: '' }, { RUNNER_SHA: 'bad' }]) assert.notEqual(run('bash', ['-eo', 'pipefail', '-c', guards], work, { ...jobEnv, ...change }).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
