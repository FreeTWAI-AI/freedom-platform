import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLocalSuites } from '../../packages/contribution-tools/verify.mjs';
import { FULL_RUNTIME_BASELINE } from '../../packages/contribution-tools/runtime-suites.mjs';
import { fixtureRoot, put } from '../../packages/contribution-tools/test/fixtures.mjs';

// Integration classification only: unchanged exact full/subset union assertions.
// The supplied URL is asserted by synthetic files; no database connection occurs.
const database = 'postgresql://postgres@localhost/fp_fixture?host=%2Ftmp%2Ffp-fixture';
const simple = "import {test} from 'node:test'; test('synthetic', () => {});\n";
const runtimeOptions = { testDatabaseUrl: database, runtimeShards: 1 };

test('full and subset union executes each file once and includes new runtime files', async t => {
  const root = await fixtureRoot(t);
  for (const path of FULL_RUNTIME_BASELINE) await put(root, path, simple);
  await put(root, 'tests/runtime/new-scope-080.test.ts', simple);
  await put(root, 'tests/runtime/command-core.test.ts', `import {test} from 'node:test'; import {writeFileSync} from 'node:fs';
test('once', () => writeFileSync('executed-once', 'once', {flag:'wx'}));`);
  const results = await runLocalSuites(root, ['runtime.full', 'runtime.command-core', 'runtime.command-core'], runtimeOptions);
  assert.equal(results.length, 2);
  for (const item of results) assert.equal(item.status, 'passed', JSON.stringify(item));
  const full = results.find(r => r.check_id === 'runtime.full'), subset = results.find(r => r.check_id === 'runtime.command-core');
  assert.equal(full.test_count, FULL_RUNTIME_BASELINE.length + 1); assert.equal(subset.test_count, 1);
  assert.equal(full.evidence_sha256, subset.evidence_sha256);
  assert(full.test_files.some(file => file.path.endsWith('/new-scope-080.test.ts')));
  assert.equal(await readFile(join(root, 'executed-once'), 'utf8'), 'once');
});

