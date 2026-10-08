import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error Existing host-only clean environment helper is an ESM JavaScript module.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const UNCOVERED_CHECKS = [
  ['check:execution-contracts', 'packages/execution-state/generate.ts'],
  ['check:member-model-http', 'modules/agent-execution/generate-member-model-http.ts'],
  ['check:model-credential', 'modules/agent-execution/generate-model-credential.ts'],
] as const;

test('uncovered generator drift checks match the committed artifacts', () => {
  for (const [scriptName, generatorPath] of UNCOVERED_CHECKS) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', generatorPath, '--check'], {
      cwd: root, env: verificationEnvironment(),
      encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024,
    });
    assert.equal(
      result.status,
      0,
      `${scriptName} (${generatorPath}) failed with status ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
});

test('every tsx generator drift check runs in verify.yml or a runtime test', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const scripts: Record<string, string> = pkg.scripts ?? {};

  for (const [name, path] of UNCOVERED_CHECKS) {
    assert.equal(scripts[name], `tsx ${path} --check`);
  }

  const inScope: Array<{ name: string; generatorPath: string }> = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith('check:')) continue;
    const match = /^tsx (\S+\.ts) --check$/.exec(command);
    if (!match) continue;
    inScope.push({ name, generatorPath: match[1] });
  }

  const verifyYml = readFileSync(join(root, '.github/workflows/verify.yml'), 'utf8');
  const verifyRunScripts = new Set<string>();
  for (const line of verifyYml.split(/\r?\n/)) {
    const match = /^\s*- run: npm run (\S+)\s*$/.exec(line);
    if (match) {
      verifyRunScripts.add(match[1]);
    }
  }

  const runtimeDir = join(root, 'tests/runtime');
  const otherTestFiles = readdirSync(runtimeDir)
    .filter(name => name.endsWith('.test.ts') && name !== 'generator-drift.test.ts');
  const otherTestContents = otherTestFiles.map(name => readFileSync(join(runtimeDir, name), 'utf8'));

  const uncoveredListGeneratorPaths = new Set<string>(UNCOVERED_CHECKS.map(([, path]) => path));

  const uncovered: string[] = [];
  for (const { name, generatorPath } of inScope) {
    const coveredByVerify = verifyRunScripts.has(name);
    const coveredByRuntimeTest = otherTestContents.some(content => content.includes(generatorPath));
    const coveredByDriftList = uncoveredListGeneratorPaths.has(generatorPath);
    if (!coveredByVerify && !coveredByRuntimeTest && !coveredByDriftList) {
      uncovered.push(name);
    }
  }

  assert.deepEqual(
    uncovered,
    [],
    `Generator drift checks not run by verify.yml or any runtime test: ${uncovered.join(', ')}`,
  );
});
