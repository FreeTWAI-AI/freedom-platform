import { test } from 'node:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
const { Client } = pg;
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
  const created = await createRuntimeDatabases(database, 4);
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
    const query = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (typeof query === 'string' && query.startsWith('CREATE DATABASE "fp_suite_')) {
      created = query.match(/^CREATE DATABASE "([a-z0-9_]+)"/)[1];
      return original.apply(this, args).then(() => { throw Error('synthetic lost acknowledgement after actual commit'); });
    }
    return original.apply(this, args);
  };
  try { await assert.rejects(createRuntimeDatabases(database, 4), /runtime_database_provision_failed/); }
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
  assert.equal(result.shards.length, 4); assert.equal(result.database_cleanup_verified, true);
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
  for (const [index, path] of partitionRuntimeFiles(names, 4).map(shard => shard[0]).entries()) await put(root, path, `import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';const {Client}=createRequire(import.meta.url)(${JSON.stringify(pgPath)});test('real database',async()=>{const c=new Client({connectionString:process.env.TEST_DATABASE_URL});await c.connect();try{await c.query('CREATE TABLE public.shard_collision(value integer)');${index === 0 ? "assert.fail('bounded synthetic assertion');" : "await c.query('INSERT INTO public.shard_collision VALUES(2)');"}}finally{await c.end();}});`);
  const result = await runLocalSuite(root, 'runtime.full', { testDatabaseUrl: database });
  validateReport(result);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'test_process_failed');
  assert.equal(result.shards.length, 4); assert.equal(result.database_cleanup_verified, true);
  assert.equal(result.shards.filter(shard => shard.reason === 'tests_executed').length, 3);
  assert.deepEqual(result.shards.flatMap(shard => shard.selected_files).sort(), names);
  assert.deepEqual(result.test_files.map(file => file.path), names);
  assert.equal(result.test_count, names.length);
  assert.equal(result.test_files.reduce((sum, file) => sum + file.counts.failed, 0), 1);
  assert.match(result.evidence_sha256, /^[a-f0-9]{64}$/);
  assert(result.shards.every(shard => /^[a-f0-9]{64}$/.test(shard.evidence_sha256)));
});

test('global cancellation kills all four active shards and cleans only invocation-owned databases', {}, async t => {
  const root = await fullFixture(t);
  const ready = partitionRuntimeFiles(names, 4).map(shard => ({path:shard[0],marker:join(root,shard[0]+'.ready')}));
  for (const {path} of ready) await put(root, path, "import {test} from 'node:test';import {writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';test('pending',()=>new Promise(()=>{writeFileSync(fileURLToPath(import.meta.url)+'.ready','ready');setInterval(()=>{},1000);}));");
  const controller = new AbortController();
  let settled=false;
  const running=runLocalSuite(root, 'runtime.full', { testDatabaseUrl: database, signal: controller.signal }).finally(()=>{settled=true;});
  try {
    // Provisioning can exceed one second. Abort only after each real shard has
    // entered its pending test, so this case actually exercises four SIGKILLs.
    const deadline=Date.now()+30_000;
    while(!ready.every(({marker})=>existsSync(marker))&&!settled&&Date.now()<deadline) await delay(25);
    assert(ready.every(({marker})=>existsSync(marker)), 'all four shards must enter their pending test before cancellation');
    controller.abort();
    const result = await running;
    validateReport(result);
    assert.equal(result.status, 'failed'); assert.equal(result.reason, 'test_cancelled');
    assert.equal(result.database_cleanup_verified, true);
    assert.equal(result.shards.length, 4);
    assert(result.shards.every(shard => shard.reason === 'test_cancelled' && shard.termination_signal === 'SIGKILL'));
    assert.deepEqual(result.shards.flatMap(shard => shard.selected_files).sort(), names);
  } finally { controller.abort(); await running; }

});

test('lost DROP acknowledgement reconciles exact owned names on a fresh verified connection', {}, async () => {
  const created = await createRuntimeDatabases(database, 4);
  const owned = created.urls.map(url => new URL(url).pathname.slice(1));
  const original = pg.Client.prototype.query;
  let dropped = 0;
  pg.Client.prototype.query = function(...args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (text?.startsWith('DROP DATABASE "fp_suite_') && owned.some(name => text.includes(`"${name}"`))) {
      return original.apply(this,args).then(() => { dropped++; throw Error('synthetic lost DROP acknowledgement after actual commit'); });
    }
    return original.apply(this,args);
  };
  let cleanup;
  try { cleanup = await created.cleanup(); } finally { pg.Client.prototype.query = original; }
  const owner = await connect(database);
  try {
    assert.equal(dropped,4);
    assert.equal((await owner.query('SELECT datname FROM pg_database WHERE datname=ANY($1)',[owned])).rowCount,0);
    assert.equal((await owner.query('SELECT current_database() name')).rows[0].name,new URL(database).pathname.slice(1));
    assert.equal(cleanup,true,'actual committed DROP lost acknowledgement must be reconciled, not reported as unverified');
  } finally { await owner.end(); }
});

test('cleanup refuses changed ownership and preserves that database and the supplied base', {}, async () => {
  const created=await createRuntimeDatabases(database,4),names=created.urls.map(url=>new URL(url).pathname.slice(1));
  const admin=await connect(database),foreign=`fp_cleanup_foreign_${process.pid}`;
  try {
    await admin.query(`CREATE ROLE "${foreign}" NOLOGIN`);
    await admin.query(`ALTER DATABASE "${names[0]}" OWNER TO "${foreign}"`);
    assert.equal(await created.cleanup(),false);
    assert.equal((await admin.query('SELECT pg_get_userbyid(datdba) owner FROM pg_database WHERE datname=$1',[names[0]])).rows[0].owner,foreign);
    assert.equal((await admin.query('SELECT current_database() name')).rows[0].name,new URL(database).pathname.slice(1));
  } finally {
    for(const name of names)await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${foreign}"`);await admin.end();
  }
});

// Real server-side delay exercises the distinct DDL timeout, not a JS sleep.
test('bounded CREATE budget tolerates DDL work beyond the metadata timeout', async () => {
  const original = pg.Client.prototype.query;
  let delayed = false, created;
  pg.Client.prototype.query = function(...args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (!delayed && text?.startsWith('CREATE DATABASE "fp_suite_')) {
      delayed = true;
      return original.call(this,{text:'SELECT pg_sleep(2.2)',query_timeout:4000})
        .then(()=>original.apply(this,args));
    }
    return original.apply(this,args);
  };
  try { created = await createRuntimeDatabases(database,4); }
  finally { pg.Client.prototype.query = original; }
  assert.equal(delayed,true);
  assert.equal(created.urls.length,4);
  assert.equal(await created.cleanup(),true);
});

test('one owned disk database can finish DROP beyond six seconds within the existing cleanup reserve', {timeout: 30000}, async () => {
  const created = await createRuntimeDatabases(database, 1), name = new URL(created.urls[0]).pathname.slice(1);
  const observer = await connect(database), original = Client.prototype.query;
  let delayed = false;
  Client.prototype.query = function(...args) {
    const q = args[0];
    if (!delayed && q?.text === `DROP DATABASE "${name}"`) {
      delayed = true;
      // Actual server work consumes the configured DROP timeout. The previous
      // six-second cap cancelled this before DROP despite a 20-second reserve.
      return original.call(this, {...q, text: 'SELECT pg_sleep(6.5)', values: []})
        .then(() => original.apply(this, args));
    }
    return original.apply(this, args);
  };
  const started = performance.now();
  try {
    assert.equal(await created.cleanup(), true);
    assert(delayed);
    assert(performance.now() - started >= 6500);
    assert(performance.now() - started < 20000, 'unchanged absolute cleanup deadline');
    assert.equal((await observer.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0);
    assert.equal((await observer.query('SELECT current_database() db')).rows[0].db, new URL(database).pathname.slice(1));
  } finally {
    Client.prototype.query = original;
    try { assert.equal(await created.cleanup(), true); } finally { await observer.end(); }
  }
});

test('cleanup reconciles a backend exiting after the termination scan instead of reporting leaked database', async () => {
  const created = await createRuntimeDatabases(database, 1);
  const name = new URL(created.urls[0]).pathname.slice(1);
  const victim = await connect(created.urls[0]), observer = await connect(database), holder = await connect(database);
  const lock = String(process.pid);
  const holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await holder.query('SELECT pg_advisory_lock($1::bigint)', [lock]);
  const original = Client.prototype.query;
  let intercepted = false, falseTermination = false;
  Client.prototype.query = function(...args) {
    const q = args[0];
    if (q?.text?.startsWith('SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE datname=') && q.values[0] === name) {
      intercepted = true;
      // Preserve the actual selected PID, then block before termination. The
      // victim closes naturally while that old pg_stat_activity row is held.
      const pending = original.call(this, {...q, text: `WITH targets AS MATERIALIZED
        (SELECT pid, pg_advisory_xact_lock($2::bigint) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid())
        SELECT pg_terminate_backend(pid,1000) AS stopped FROM targets`, values: [name, lock]});
      return (async () => {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          if ((await observer.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [holderPid])).rowCount) { blocked = true; break; }
          await delay(5);
        }
        assert(blocked, 'actual cleanup SELECT reached its gate');
        await victim.end();
        await holder.query('SELECT pg_advisory_unlock($1::bigint)', [lock]);
        const result = await pending;
        falseTermination = result.rows.some(row => row.stopped === false);
        return result;
      })();
    }
    return original.apply(this, args);
  };
  try {
    const result = await created.cleanup();
    assert(intercepted); assert(falseTermination, 'PostgreSQL actually reports the departed PID as not terminated');
    assert.equal(result, true, 'fresh absence must permit owned-database DROP and final positive readback');
    assert.equal((await observer.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0);
  } finally {
    Client.prototype.query = original;
    await holder.query('SELECT pg_advisory_unlock_all()'); await victim.end();
    try { assert.equal(await created.cleanup(), true); }
    finally { await Promise.all([holder.end(), observer.end()]); }
  }
});

test('cleanup still refuses a false termination while an owned database backend remains live', async () => {
  const created = await createRuntimeDatabases(database, 1), name = new URL(created.urls[0]).pathname.slice(1);
  const victim = await connect(created.urls[0]), observer = await connect(database), original = Client.prototype.query;
  Client.prototype.query = function(...args) {
    const q = args[0];
    if (q?.text?.startsWith('SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE datname=') && q.values[0] === name) {
      return Promise.resolve({rows: [{stopped: false}]}); // Inject refusal, leave real backend running.
    }
    return original.apply(this, args);
  };
  try {
    assert.equal(await created.cleanup(), false);
    assert.equal((await observer.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 1);
    assert.equal((await victim.query('SELECT 1 AS alive')).rows[0].alive, 1);
  } finally {
    Client.prototype.query = original; await victim.end();
    try { assert.equal(await created.cleanup(), true); } finally { await observer.end(); }
  }
});
