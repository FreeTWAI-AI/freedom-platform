import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { PrincipalRefSchema, ResourceScopeRefSchema, type ResourceScopeRef } from '../../contracts/common/v1/identity.js';
import { withMemberScope, backfillLegacyScopeBatch, requireSameScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { command, createPool, LOCAL_DATABASE_URL, digest, transaction } from '../../packages/db/index.js';
import { Problem } from '../../packages/shared/problem.js';
import { migrate } from '../../scripts/database.js';
import type { Actor } from '../../modules/identity-membership/service.js';

const schema = `fp_resource_scopes_${process.pid}_${Date.now()}`;
const connectionString = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
const admin = createPool(connectionString);
const pool = new Pool({ connectionString, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 12 });
const firstCommunity = '10000000-0000-4000-8000-000000000001';
const secondCommunity = '10000000-0000-4000-8000-000000000002';
let created = false;
before(async () => {
  assert.match(schema, /^fp_resource_scopes_[0-9]+_[0-9]+$/);
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await migrate(pool);
});
after(async () => { await pool.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
beforeEach(async () => {
  await pool.query('TRUNCATE communities CASCADE');
  await pool.query('INSERT INTO communities VALUES($1,$2),($3,$4)', [firstCommunity, 'Synthetic A', secondCommunity, 'Synthetic B']);
});
async function member(targetPool = pool, community = firstCommunity, active = true): Promise<Actor> {
  const id = randomUUID(), session = randomUUID();
  const row = (await targetPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active)
    VALUES($1,$2,$3,'Synthetic','not-a-login-hash',$4,$5) RETURNING *`, [id, community, id + '@example.invalid', randomUUID(), active])).rows[0];
  await targetPool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',now()+interval '1 hour')", [session, id]);
  return { ...row, session_hash: session, csrf_token: 'synthetic' };
}
const inspect = (actor: Actor, scope: 'personal' | 'community' | ResourceScopeRef = 'personal', targetPool = pool) =>
  withMemberScope(targetPool, { actor, scope }, async () => {}, async (_q, context) => context);
const problem = (status: number, code: string) => (error: unknown) => error instanceof Problem && error.status === status && error.code === code;
const sqlCode = (code: string) => (error: unknown) => (error as { code: string })?.code === code;
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function blockedBy(pid: number) {
  for (let i = 0; i < 150; i++) {
    if ((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes', [pid])).rows[0].yes) return;
    await delay(10);
  }
  assert.fail('Expected actual PostgreSQL lock contention.');
}
async function finishBackfill(targetPool = pool) {
  for (let i = 0; i < 20; i++) {
    const result = await backfillLegacyScopeBatch(targetPool, 500);
    if (result.remaining.communities + result.remaining.users === 0) return;
  }
  assert.fail('Synthetic backfill did not finish.');
}
async function mappingSnapshot(targetPool = pool) {
  return { principals: (await targetPool.query('SELECT * FROM principals ORDER BY principal_id')).rows,
    scopes: (await targetPool.query('SELECT * FROM resource_scopes ORDER BY scope_id')).rows };
}

test('common reference validators and generated JSON Schema agree, without granting service/site support', async () => {
  const id = 'abcdefab-1234-4567-89ab-abcdefabcdef';
  for (const [name, validator, field, kinds] of [
    ['principal-ref', PrincipalRefSchema, 'principal_id', ['person', 'service']],
    ['resource-scope-ref', ResourceScopeRefSchema, 'scope_id', ['community', 'personal', 'site']],
  ] as const) {
    const schema = JSON.parse(await readFile(new URL(`../../contracts/common/v1/${name}.schema.json`, import.meta.url), 'utf8'));
    assert.deepEqual(schema, { ...z.toJSONSchema(validator), $id: `https://freetwai.com/contracts/common/v1/${name}` });
    const valid = kinds.map(kind => ({ [field]: id, kind }));
    const invalid = [{ [field]: id, kind: 'invented' }, { [field]: id, kind: kinds[0], verified: true },
      ...[id.toUpperCase(), id + '\n', 'not-an-id', null, 123].map(value => ({ [field]: value, kind: kinds[0] })), {}, null];
    const cases = [...valid.map(value => ({ value, valid: true })), ...invalid.map(value => ({ value, valid: false }))];
    for (const item of cases) assert.equal(validator.safeParse(item.value).success, item.valid);
    const python = "import json,sys; from jsonschema import Draft202012Validator; p=json.load(sys.stdin); Draft202012Validator.check_schema(p['schema']); v=Draft202012Validator(p['schema']); assert all(v.is_valid(c['value']) == c['valid'] for c in p['cases']); print('conformant')";
    assert.equal(execFileSync('python3', ['-c', python], { input: JSON.stringify({ schema, cases }), encoding: 'utf8' }).trim(), 'conformant');
  }
});

test('opaque person IDs and personal scopes are stable, distinct from user IDs, and not based on email', async () => {
  const owner = await member(), first = await inspect(owner);
  assert.notEqual(first.subject_principal.principal_id, owner.user_id);
  await pool.query('UPDATE users SET email=$2 WHERE user_id=$1', [owner.user_id, 'renamed@example.invalid']);
  assert.deepEqual(await inspect(owner), first);
  const another = await member();
  const next = await inspect(another);
  assert.notEqual(first.subject_principal.principal_id, next.subject_principal.principal_id);
  assert.notEqual(first.scope.scope_id, next.scope.scope_id);
  assert(!JSON.stringify(first).includes('@')); assert.equal(first.authn_kind, 'member_session');
});

test('same-community members share a community scope with no invented owner; personal scopes stay private', async () => {
  const a = await member(), b = await member(), outside = await member(pool, secondCommunity);
  const ca = await inspect(a, 'community'), cb = await inspect(b, 'community'), co = await inspect(outside, 'community');
  assert.deepEqual(ca.scope, cb.scope); assert.notDeepEqual(ca.scope, co.scope);
  const row = (await pool.query('SELECT * FROM resource_scopes WHERE scope_id=$1', [ca.scope.scope_id])).rows[0];
  assert.equal(row.owner_principal_id, null); assert.equal(row.owner_principal_kind, null); assert.equal(row.community_ref, firstCommunity);
  const privateA = await inspect(a);
  await assert.rejects(inspect(b, privateA.scope), problem(404, 'resource_not_found'));
  await assert.rejects(inspect(a, co.scope), problem(404, 'resource_not_found'));
  await assert.rejects(inspect(a, { ...privateA.scope, kind: 'community' }), problem(404, 'resource_not_found'));
});

test('typed target check rejects another scope, another kind and surplus claims', async () => {
  const a = await member(), context = await inspect(a);
  requireSameScope(context.scope, context.scope);
  for (const value of [{ ...context.scope, scope_id: randomUUID() }, { ...context.scope, kind: 'community' }, { ...context.scope, authorized: true }, null]) {
    assert.throws(() => requireSameScope(context.scope, value), problem(404, 'resource_not_found'));
  }
});

test('a site-shaped reference or fabricated session never activates a machine identity', async () => {
  const a = await member();
  await assert.rejects(inspect(a, { scope_id: randomUUID(), kind: 'site' }), problem(403, 'scope_kind_unavailable'));
  await assert.rejects(inspect({ ...a, session_hash: 'not-a-member-session' }), problem(401, 'session_expired'));
  assert.equal((await pool.query('SELECT count(*) FROM principals')).rows[0].count, '0');
});

for (const failure of ['inactive', 'expired', 'revoked', 'other-user-session', 'wrong-community'] as const) {
  test(`scope resolution rechecks ${failure} before providing a context`, async () => {
    const owner = await member(); await inspect(owner);
    if (failure === 'inactive') await pool.query('UPDATE users SET active=false WHERE user_id=$1', [owner.user_id]);
    if (failure === 'expired') await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [owner.session_hash]);
    if (failure === 'revoked') await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [owner.session_hash]);
    if (failure === 'other-user-session') owner.session_hash = (await member()).session_hash;
    if (failure === 'wrong-community') owner.community_id = secondCommunity;
    await assert.rejects(inspect(owner), problem(401, 'session_expired'));
  });
}

for (const table of ['principals', 'resource_scopes'] as const) {
  test(`disabled ${table} reject cached references and backfill never re-enables them`, async () => {
    const owner = await member(), context = await inspect(owner);
    await pool.query(`UPDATE ${table} SET status='disabled'`);
    await finishBackfill();
    const before = await mappingSnapshot(); await finishBackfill(); assert.deepEqual(await mappingSnapshot(), before);
    await assert.rejects(inspect(owner, context.scope), problem(403, table === 'principals' ? 'principal_disabled' : 'scope_disabled'));
    assert.equal((await pool.query(`SELECT status FROM ${table} WHERE ${table === 'principals' ? 'principal_id' : 'scope_id'}=$1`,
      [table === 'principals' ? context.subject_principal.principal_id : context.scope.scope_id])).rows[0].status, 'disabled');
  });
}

test('disabling a community scope does not confer or remove personal-domain authority', async () => {
  const owner = await member(), community = await inspect(owner, 'community'), personal = await inspect(owner);
  await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [community.scope.scope_id]);
  await assert.rejects(inspect(owner, community.scope), problem(403, 'scope_disabled'));
  assert.deepEqual(await inspect(owner, personal.scope), personal);
  await assert.rejects(withMemberScope(pool, { actor: owner, scope: personal.scope }, async () => {
    throw new Problem(403, 'synthetic_acl_denied', 'Synthetic denial.');
  }, async () => { assert.fail('A valid scope is not domain authority.'); }), problem(403, 'synthetic_acl_denied'));
});

test('domain authorization is mandatory and failed authorization rolls back lazy provisioning', async () => {
  const owner = await member(); let ran = false;
  await assert.rejects(withMemberScope(pool, { actor: owner, scope: 'personal' }, async () => {
    throw new Problem(403, 'synthetic_acl_denied', 'Synthetic denial.');
  }, async () => { ran = true; }), problem(403, 'synthetic_acl_denied'));
  assert.equal(ran, false); assert.deepEqual(await mappingSnapshot(), { principals: [], scopes: [] });
});

test('parallel first use converges on exactly one mapping and frozen context on the same transaction', async () => {
  const owner = await member(); let client: PoolClient | undefined;
  const results = await Promise.all(Array.from({ length: 8 }, () => inspect(owner)));
  for (const result of results) assert.deepEqual(result, results[0]);
  const mapped = await mappingSnapshot(); assert.equal(mapped.principals.length, 1); assert.equal(mapped.scopes.length, 1);
  await withMemberScope(pool, { actor: owner, scope: 'personal' }, async (q, context) => {
    client = q; assert(Object.isFrozen(context)); assert(Object.isFrozen(context.scope)); assert(Object.isFrozen(context.subject_principal));
  }, async q => { assert.equal(q, client); });
});

test('bounded backfill covers inactive and new users without changing legacy facts', async () => {
  const a = await member(), inactive = await member(pool, firstCommunity, false);
  const old = (await pool.query('SELECT user_id,community_id,active,email FROM users ORDER BY user_id')).rows;
  let batch = await backfillLegacyScopeBatch(pool, 1); assert.equal(batch.processed, 1); assert.equal(batch.created.principals, 0);
  await finishBackfill(); const before = await mappingSnapshot();
  assert.equal(before.principals.length, 2); assert.equal(before.scopes.length, 4);
  batch = await backfillLegacyScopeBatch(pool, 1);
  assert.equal(batch.processed, 0); assert.deepEqual(batch.created, { principals: 0, community_scopes: 0, personal_scopes: 0 });
  assert.deepEqual(await mappingSnapshot(), before);
  assert.deepEqual((await pool.query('SELECT user_id,community_id,active,email FROM users ORDER BY user_id')).rows, old);
  await assert.rejects(inspect(inactive), problem(401, 'session_expired'));
  const newcomer = await member(); await inspect(newcomer); await finishBackfill();
  assert.equal((await mappingSnapshot()).principals.length, 3); assert.equal((await inspect(a)).subject_principal.principal_id, before.principals.find(row => row.user_ref === a.user_id).principal_id);
});

test('invalid batch limits fail before acquiring a database client', async () => {
  const fake = { connect() { throw new Error('must not connect'); } } as unknown as Pool;
  for (const limit of [0, -1, 501, 1.5, NaN]) await assert.rejects(backfillLegacyScopeBatch(fake, limit), problem(400, 'invalid_batch_limit'));
});

test('concurrent bounded backfills produce no duplicate identities and can resume', async () => {
  for (let i = 0; i < 4; i++) await member();
  await Promise.all([backfillLegacyScopeBatch(pool, 2), backfillLegacyScopeBatch(pool, 2)]);
  await Promise.all([backfillLegacyScopeBatch(pool, 2), backfillLegacyScopeBatch(pool, 2)]);
  await finishBackfill(); const snapshot = await mappingSnapshot();
  assert.equal(snapshot.principals.length, 4); assert.equal(snapshot.scopes.length, 6);
  await finishBackfill(); assert.deepEqual(await mappingSnapshot(), snapshot);
});

test('backfill skips an in-flight member and never deadlocks with lazy community provisioning', async () => {
  const owner = await member(), entered = barrier(), finish = barrier();
  const running = withMemberScope(pool, { actor: owner, scope: 'community' }, async () => {}, async (_q, context) => {
    entered.release(); await finish.promise; return context;
  });
  await entered.promise;
  try { const batch = await backfillLegacyScopeBatch(pool); assert(batch.remaining.users > 0); }
  finally { finish.release(); }
  await running; await finishBackfill(); assert.equal((await mappingSnapshot()).principals.length, 1);
});

test('a failed backfill batch rolls back principal insertion and resumes without changing committed IDs', async () => {
  await member(); await backfillLegacyScopeBatch(pool);
  const before = await mappingSnapshot();
  await pool.query("CREATE FUNCTION fp_refuse_personal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='personal' THEN RAISE EXCEPTION 'synthetic scope failure'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER fp_refuse_personal BEFORE INSERT ON resource_scopes FOR EACH ROW EXECUTE FUNCTION fp_refuse_personal()');
  try { await assert.rejects(backfillLegacyScopeBatch(pool), /synthetic scope failure/); assert.deepEqual(await mappingSnapshot(), before); }
  finally { await pool.query('DROP TRIGGER fp_refuse_personal ON resource_scopes'); await pool.query('DROP FUNCTION fp_refuse_personal()'); }
  await finishBackfill(); assert.equal((await mappingSnapshot()).principals.length, 1);
});

test('database rejects unbacked identities, ambiguous scope ownership and dangling backing refs', async () => {
  const owner = await member(), context = await inspect(owner), user = owner.user_id, principal = context.subject_principal.principal_id;
  const cases: [string, unknown[], string][] = [
    ["INSERT INTO principals(kind,user_ref) VALUES('service',$1)", [user], '23514'],
    // 118 pairs each kind with its real backing via CHECK; person still cannot
    // omit user_ref even though the column is nullable for shop services.
    ["INSERT INTO principals(user_ref) VALUES(NULL)", [], '23514'],
    ["INSERT INTO principals(user_ref) VALUES($1)", [randomUUID()], '23503'],
    ["INSERT INTO principals(user_ref) VALUES($1)", [user], '23505'],
    ["INSERT INTO resource_scopes(kind,community_ref) VALUES('site',$1)", [firstCommunity], '23514'],
    ["INSERT INTO resource_scopes(kind) VALUES('personal')", [], '23514'],
    ["INSERT INTO resource_scopes(kind) VALUES('community')", [], '23514'],
    ["INSERT INTO resource_scopes(kind,community_ref,owner_principal_id) VALUES('community',$1,$2)", [firstCommunity, principal], '23514'],
    ["INSERT INTO resource_scopes(kind,community_ref,owner_principal_id) VALUES('personal',$1,$2)", [firstCommunity, principal], '23514'],
    ["INSERT INTO resource_scopes(kind,owner_principal_id) VALUES('personal',$1)", [randomUUID()], '23503'],
    ["INSERT INTO resource_scopes(kind,owner_principal_id) VALUES('personal',$1)", [principal], '23505'],
    ["INSERT INTO resource_scopes(kind,community_ref) VALUES('community',$1)", [randomUUID()], '23503'],
    ["UPDATE principals SET status='invented'", [], '23514'],
    ["UPDATE resource_scopes SET status='invented'", [], '23514'],
  ];
  for (const [sql, values, code] of cases) await assert.rejects(pool.query(sql, values), sqlCode(code));
  await inspect(owner, 'community');
  await assert.rejects(pool.query("INSERT INTO resource_scopes(kind,community_ref) VALUES('community',$1)", [firstCommunity]), sqlCode('23505'));
});

test('principal and scope IDs cannot be rebound or reassigned, even by direct SQL', async () => {
  const owner = await member(), peer = await member(); await inspect(owner); await inspect(owner, 'community');
  const peerContext = await inspect(peer);
  const before = await mappingSnapshot();
  for (const [sql, values] of [
    ['UPDATE principals SET user_ref=$1', [peer.user_id]],
    ['UPDATE principals SET principal_id=$1', [randomUUID()]],
    ["UPDATE principals SET kind='service'", []],
    ['UPDATE resource_scopes SET scope_id=$1', [randomUUID()]],
    ["UPDATE resource_scopes SET community_ref=$1 WHERE kind='community'", [secondCommunity]],
    ["UPDATE resource_scopes SET owner_principal_id=$1 WHERE kind='personal' AND owner_principal_id<>$1", [peerContext.subject_principal.principal_id]],
    ["UPDATE resource_scopes SET kind='community' WHERE kind='personal'", []],
  ] as [string, unknown[]][]) await assert.rejects(pool.query(sql, values), sqlCode('23514'));
  assert.deepEqual(await mappingSnapshot(), before);
});

test('deleting a mapping cannot reset disabled state or allow ID reassignment', async () => {
  const owner = await member(), context = await inspect(owner);
  await pool.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [context.scope.scope_id]);
  const before = await mappingSnapshot();
  await assert.rejects(pool.query('DELETE FROM resource_scopes WHERE scope_id=$1', [context.scope.scope_id]), sqlCode('23514'));
  await assert.rejects(pool.query('DELETE FROM principals WHERE principal_id=$1', [context.subject_principal.principal_id]), sqlCode('23514'));
  await finishBackfill();
  const after = await mappingSnapshot();
  assert.deepEqual(after.principals, before.principals);
  assert.deepEqual(after.scopes.find(row => row.scope_id === context.scope.scope_id), before.scopes[0]);
  await assert.rejects(inspect(owner, context.scope), problem(403, 'scope_disabled'));
});

test('principal revocation waits for an already authorized scope transaction, then blocks the next one', async () => {
  const owner = await member(), entered = barrier(), finish = barrier(); let pid = 0;
  const running = withMemberScope(pool, { actor: owner, scope: 'personal' }, async () => {}, async (q, context) => {
    pid = (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; entered.release(); await finish.promise; return context;
  });
  await entered.promise;
  // First-use inserts are not visible until commit; identify by backing user in a
  // later statement after provisioning, then test the normal existing-row race.
  finish.release(); const context = await running;
  const entered2 = barrier(), finish2 = barrier();
  const pending = withMemberScope(pool, { actor: owner, scope: context.scope }, async () => {}, async q => {
    pid = (await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; entered2.release(); await finish2.promise;
  });
  await entered2.promise;
  const revoked = pool.query("UPDATE principals SET status='disabled' WHERE principal_id=$1", [context.subject_principal.principal_id]);
  try { await blockedBy(pid); } finally { finish2.release(); }
  await pending; await revoked; await assert.rejects(inspect(owner, context.scope), problem(403, 'principal_disabled'));
});

test('a scope revocation that holds the row lock wins before new authorization', async () => {
  const owner = await member(), context = await inspect(owner), revoker = await pool.connect();
  try {
    await revoker.query('BEGIN'); const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await revoker.query("UPDATE resource_scopes SET status='disabled' WHERE scope_id=$1", [context.scope.scope_id]);
    const rejected = assert.rejects(inspect(owner, context.scope), problem(403, 'scope_disabled'));
    try { await blockedBy(pid); await revoker.query('COMMIT'); }
    finally { await revoker.query('ROLLBACK'); }
    await rejected;
  } finally { revoker.release(); }
});

test('upgrade from 075 preserves every legacy table and receipt; migration/backfill are repeatable', async () => {
  const upgradeSchema = schema + '_upgrade', upgrade = new Pool({ connectionString, options: `-c search_path=${upgradeSchema}`, max: 4 });
  await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
  try {
    const directory = new URL('../../migrations/', import.meta.url);
    await transaction(upgrade, async q => {
      await q.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql') && name < '076_').sort()) {
        const sql = await readFile(new URL(name, directory), 'utf8'); await q.query(sql);
        await q.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, digest(sql)]);
      }
    });
    await upgrade.query('INSERT INTO communities VALUES($1,$2)', [firstCommunity, 'Synthetic upgrade']);
    const owner = await member(upgrade);
    const receiptInput = { actor: owner, operation: 'POST /legacy-synthetic', key: 'old-receipt-001', body: { original: true } };
    await command(upgrade, receiptInput, async () => {}, async () => ({ original: true }));
    // Populate the old Work graph, not just empty tables, before 077 adds its
    // discriminator/FKs. These are synthetic legacy facts, never real data.
    const contributor = await member(upgrade), workId = randomUUID(), claimId = randomUUID(), submissionId = randomUUID(), decisionId = randomUUID();
    const historicalTerms = { synthetic: 'historical terms remain byte-equivalent' }, termsHash = digest(historicalTerms);
    await upgrade.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,participation_terms_sha256,claim_window_expires_at,due_at)
      VALUES($1,$2,$3,'Legacy title','Legacy objective','Legacy criteria','Legacy gain','accepted',$4,$5,now(),now())`, [workId, firstCommunity, owner.user_id, historicalTerms, termsHash]);
    await upgrade.query("INSERT INTO work_review_routes(work_item_id,reviewer_ref,valid_until) VALUES($1,$2,now()+interval '1 day')", [workId, owner.user_id]);
    await upgrade.query(`INSERT INTO work_claims(claim_id,work_item_id,claimant_ref,acting_profession_membership_ref,state,terms_revision,terms_sha256,terms_snapshot)
      VALUES($1,$2,$3,$4,'accepted',1,$5,$6)`, [claimId, workId, contributor.user_id, contributor.profession_membership_ref, termsHash, historicalTerms]);
    await upgrade.query("INSERT INTO submissions(submission_id,claim_id,revision,summary,artifact_ref,sha256) VALUES($1,$2,1,'Legacy summary','artifact:legacy',$3)", [submissionId, claimId, termsHash]);
    await upgrade.query("INSERT INTO work_decisions(decision_id,claim_id,submission_id,reviewer_ref,decision,feedback,submission_sha256) VALUES($1,$2,$3,$4,'accept','Legacy feedback',$5)", [decisionId, claimId, submissionId, owner.user_id, termsHash]);
    await upgrade.query("INSERT INTO contributions(contribution_id,claim_id,user_id,community_id,work_item_id,decision_id,title,summary,artifact_ref) VALUES($1,$2,$3,$4,$5,$6,'Legacy title','Legacy summary','artifact:legacy')", [randomUUID(), claimId, contributor.user_id, firstCommunity, workId, decisionId]);
    await upgrade.query("INSERT INTO work_benefit_observations(observation_id,community_id,work_item_ref,reporter_principal_ref,role,observation_revision,report) VALUES($1,$2,$3,$4,'beneficiary',1,$5)", [randomUUID(), firstCommunity, workId, owner.user_id, { synthetic: 'Legacy self report' }]);
    const tables = (await upgrade.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename<>'schema_migrations' ORDER BY tablename", [upgradeSchema])).rows.map(row => row.tablename as string);
    // Freeze the old column projection before additive migrations. New metadata
    // is not an altered legacy fact; every original column is still compared.
    const legacyColumns = new Map<string, string[]>();
    for (const table of tables) legacyColumns.set(table, (await upgrade.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', [upgradeSchema, table])).rows.map(row => row.column_name));
    const snapshot = async () => {
      const hashes: Record<string, string> = {};
      for (const table of tables) {
        assert.match(table, /^[a-z_][a-z0-9_]*$/);
        const columns = legacyColumns.get(table)!; for (const column of columns) assert.match(column, /^[a-z_][a-z0-9_]*$/);
        hashes[table] = digest((await upgrade.query(`SELECT to_jsonb(t)::text AS row FROM (SELECT ${columns.map(column => '"' + column + '"').join(',')} FROM ${table}) t ORDER BY to_jsonb(t)::text`)).rows);
      }
      return hashes;
    };
    const old = await snapshot(), oldLedger = (await upgrade.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    await migrate(upgrade); await finishBackfill(upgrade);
    assert.deepEqual(await snapshot(), old);
    assert.deepEqual((await upgrade.query("SELECT * FROM schema_migrations WHERE name<'076_' ORDER BY name")).rows, oldLedger);
    assert.deepEqual(await command(upgrade, receiptInput, async () => {}, async () => { assert.fail('Must replay old receipt.'); }), { original: true });
    const mapped = await mappingSnapshot(upgrade); await migrate(upgrade); await finishBackfill(upgrade);
    assert.deepEqual(await mappingSnapshot(upgrade), mapped);
  } finally { await upgrade.end(); await admin.query(`DROP SCHEMA ${upgradeSchema} CASCADE`); }
});

test('non-superuser migrator and DML-only runtime roles can use the mappings without elevated functions', async () => {
  const role = `fp_scope_owner_${process.pid}`, appRole = `fp_scope_app_${process.pid}`, roleSchema = schema + '_roles';
  let migrator: Pool | undefined, app: Pool | undefined;
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER`); await admin.query(`CREATE ROLE ${appRole} NOLOGIN NOSUPERUSER`);
  try {
    await admin.query(`CREATE SCHEMA ${roleSchema} AUTHORIZATION ${role}`);
    migrator = new Pool({ connectionString, options: `-c search_path=${roleSchema} -c role=${role}`, max: 2 });
    assert.equal((await migrator.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper, false);
    await migrate(migrator); await migrator.query('INSERT INTO communities VALUES($1,$2)', [firstCommunity, 'Synthetic roles']);
    const owner = await member(migrator);
    await migrator.query(`GRANT USAGE ON SCHEMA ${roleSchema} TO ${appRole}`);
    await migrator.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${roleSchema} TO ${appRole}`);
    app = new Pool({ connectionString, options: `-c search_path=${roleSchema} -c role=${appRole}`, max: 2 });
    assert.equal((await inspect(owner, 'personal', app)).scope.kind, 'personal');
    await assert.rejects(app.query('DELETE FROM resource_scopes'), sqlCode('23514'));
    await assert.rejects(app.query('DELETE FROM principals'), sqlCode('23514'));
    await assert.rejects(app.query('ALTER TABLE principals ADD COLUMN forbidden text'), sqlCode('42501'));
    await finishBackfill(migrator);
    // Mapping operations run as the DML-only caller. Separate media operator
    // ports may be installed in the same schema, but never confer authority on it.
    const elevated = (await migrator.query(`SELECT proname,pg_get_userbyid(proowner) AS owner,
      has_function_privilege($2,oid,'EXECUTE') AS runtime_execute
      FROM pg_proc WHERE pronamespace=$1::regnamespace AND prosecdef`, [roleSchema,appRole])).rows;
    for (const port of elevated) {
      assert.match(port.proname,/^(?:lock_media_backfill_|publish_media_backfill_|operator_avatar_intent_admitted$)/);
      assert.equal(port.owner,role);
      assert.equal(port.runtime_execute,false);
    }
  } finally {
    await app?.end(); await migrator?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${roleSchema} CASCADE`);
    await admin.query(`DROP ROLE ${appRole}`); await admin.query(`DROP ROLE ${role}`);
  }
});
