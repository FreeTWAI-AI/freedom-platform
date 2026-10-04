import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { FULL_RUNTIME_BASELINE } from '../../packages/contribution-tools/runtime-suites.mjs';
import { runLocalSuite, partitionRuntimeFiles, isDisposableDatabaseUrl } from '../../packages/contribution-tools/suite-runner.mjs';
import { validateFormat } from '../../packages/contribution-tools/formats.mjs';
import { createRuntimeDatabases } from '../../packages/contribution-tools/runtime-databases.mjs';
import { fixtureRoot, put } from '../../packages/contribution-tools/test/fixtures.mjs';

// Explicit local integration input only, never a discovered/default server.
const database = process.env.TEST_DATABASE_URL;
assert(isDisposableDatabaseUrl(database), 'explicit disposable test database required');
const pg = createRequire(import.meta.url)('pg');
const simple = "import {test} from 'node:test';test('fixture',()=>{});";
const names = [...FULL_RUNTIME_BASELINE].sort();
function validateReport(check) {
  validateFormat('verifierReport', { format: 'freedom.verifier-report/v1', assurance_level: 'local',
    repository: 'synthetic/fixture', base_commit: 'a'.repeat(40), head_commit: 'b'.repeat(40),
    workspace_sha256: 'c'.repeat(64), status: check.status, scope: [], checks: [check], blockers: [] });
}


async function fullFixture(t) {
  const root = await fixtureRoot(t);
  await Promise.all(names.map(path => put(root, path, simple)));
  return root;
}
async function connect(url) {
  const client = new pg.Client({ connectionString: url }); await client.connect(); return client;
}

test('fresh owned databases isolate identical public tables and cleanup preserves base', {}, async () => {
  const owner = await connect(database);
  const before = (await owner.query('SELECT current_database() AS name')).rows[0].name;
  const created = await createRuntimeDatabases(database, 2);
  try {
    assert.notEqual(created.urls[0], created.urls[1]);
    const clients = await Promise.all(created.urls.map(connect));
    try {
      await Promise.all(clients.map((client, index) => client.query(`CREATE TABLE public.same_table(value integer); INSERT INTO public.same_table VALUES (${index})`)));
      for (let index = 0; index < clients.length; index++) assert.equal((await clients[index].query('SELECT value FROM public.same_table')).rows[0].value, index);
    } finally { await Promise.all(clients.map(client => client.end())); }
  } finally { assert.equal(await created.cleanup(), true); }
  const found = await owner.query('SELECT datname FROM pg_database WHERE datname = ANY($1)', [created.urls.map(url => new URL(url).pathname.slice(1))]);
  assert.equal(found.rowCount, 0);
  assert.equal((await owner.query('SELECT current_database() AS name')).rows[0].name, before);
  await owner.end();
});

test('committed CREATE with a lost acknowledgement is still cleaned by its registered nonce', {}, async () => {
  const original = pg.Client.prototype.query;
  let created;
  pg.Client.prototype.query = function(...args) {
    const query = args[0];
    if (typeof query === 'string' && query.startsWith('CREATE DATABASE "fp_suite_')) {
      created = query.match(/^CREATE DATABASE "([a-z0-9_]+)"/)[1];
      return original.apply(this, args).then(() => { throw Error('synthetic lost acknowledgement after actual commit'); });
    }
    return original.apply(this, args);
  };
  try { await assert.rejects(createRuntimeDatabases(database, 2), /runtime_database_provision_failed/); }
  finally { pg.Client.prototype.query = original; }
  assert(created);
  const owner = await connect(database);
  try {
    assert.equal((await owner.query('SELECT datname FROM pg_database WHERE datname=$1', [created])).rowCount, 0);
    assert.equal((await owner.query('SELECT current_database() AS name')).rows[0].name, new URL(database).pathname.slice(1));
  } finally { await owner.end(); }
});

test('successful shards merge the entire selected file/case union without duplicates', {}, async t => {
  const root = await fullFixture(t);
  await put(root, 'tests/runtime/new-shard-coverage.test.ts', simple);
  const result = await runLocalSuite(root, 'runtime.full', { testDatabaseUrl: database });
  validateReport(result);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.shards.length, 2); assert.equal(result.database_cleanup_verified, true);
  const expected = [...names, 'tests/runtime/new-shard-coverage.test.ts'].sort();
  assert.deepEqual(result.test_files.map(file => file.path), expected);
  assert.deepEqual(result.shards.flatMap(shard => shard.selected_files).sort(), expected);
  assert.equal(result.test_count, expected.length);
  assert.equal(new Set(result.test_files.flatMap(file => file.cases.map(entry => entry.case_sha256))).size, expected.length);
});

test('full shards cover every file once; one failing shard cannot hide the completed other shard', {}, async t => {
  const root = await fullFixture(t);
  // Distinct shards execute the same public table name on independent DBs.
  const pgPath = createRequire(import.meta.url).resolve('pg');
  for (const [index, path] of names.slice(0, 2).entries()) await put(root, path, `import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';const {Client}=createRequire(import.meta.url)(${JSON.stringify(pgPath)});test('real database',async()=>{const c=new Client({connectionString:process.env.TEST_DATABASE_URL});await c.connect();try{await c.query('CREATE TABLE public.shard_collision(value integer)');${index === 0 ? "assert.fail('bounded synthetic assertion');" : "await c.query('INSERT INTO public.shard_collision VALUES(2)');"}}finally{await c.end();}});`);
  const result = await runLocalSuite(root, 'runtime.full', { testDatabaseUrl: database });
  validateReport(result);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'test_process_failed');
  assert.equal(result.shards.length, 2); assert.equal(result.database_cleanup_verified, true);
  assert.equal(result.shards.filter(shard => shard.reason === 'tests_executed').length, 1);
  assert.deepEqual(result.shards.flatMap(shard => shard.selected_files).sort(), names);
  assert.deepEqual(result.test_files.map(file => file.path), names);
  assert.equal(result.test_count, names.length);
  assert.equal(result.test_files.reduce((sum, file) => sum + file.counts.failed, 0), 1);
  assert.match(result.evidence_sha256, /^[a-f0-9]{64}$/);
  assert(result.shards.every(shard => /^[a-f0-9]{64}$/.test(shard.evidence_sha256)));
});

test('global cancellation kills both active shards and cleans only invocation-owned databases', {}, async t => {
  const root = await fullFixture(t);
  for (const path of names.slice(0, 2)) await put(root, path, "import {test} from 'node:test';test('pending',()=>new Promise(()=>setInterval(()=>{},1000))); ");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const result = await runLocalSuite(root, 'runtime.full', { testDatabaseUrl: database, signal: controller.signal });
    validateReport(result);
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'test_cancelled');
    assert.equal(result.database_cleanup_verified, true);
    assert.equal(result.shards.length, 2);
    assert(result.shards.every(shard => shard.reason === 'test_cancelled' && shard.termination_signal === 'SIGKILL'));
    assert.deepEqual(result.shards.flatMap(shard => shard.selected_files).sort(), names);
  } finally { clearTimeout(timer); }
});
