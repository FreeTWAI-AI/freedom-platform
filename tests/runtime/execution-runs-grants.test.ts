import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import type { Actor } from '../../modules/identity-membership/service.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Execution grants require explicit disposable fp_* TEST_DATABASE_URL.');
const schema = `fp_run_acl_${process.pid}_${Date.now()}`, migrator = `${schema}_migrator`, runtime = `${schema}_app`;
const admin = new Pool({ connectionString });
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
// Actual dedicated PostgreSQL sessions, not a superuser session issuing SET ROLE.
const owner = new Pool({ connectionString: roleUrl(migrator), options: `-c search_path=${schema} -c statement_timeout=10000` });
const app = new Pool({ connectionString: roleUrl(runtime), options: `-c search_path=${schema} -c statement_timeout=10000`, max: 8 });
const api = createExecutionRuns(app); let created = false, checkQuery: string;

before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created = true; await migrate(owner);
  // Reuse the existing policy-grants test technique: execute actual template
  // SQL/generator with only synthetic schema/role substitutions. This is not a
  // psql interpreter or proof of the private deployment helper.
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql', import.meta.url), 'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'), template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public', `SCHEMA ${schema}`).replaceAll(':"runtime"', `"${runtime}"`);
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
  const q = await owner.connect();
  try {
    await q.query(prefix);
    const statements = await q.query(grants); assert.equal(statements.rowCount, 2);
    for (const row of statements.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  const check = await readFile(new URL('../../deploy/cloudflare/sql/30-verify-readonly.psql', import.meta.url), 'utf8');
  checkQuery = check.split("-- BEGIN PRIVATE POLICY READBACK\n")[1].split("\n-- END PRIVATE POLICY READBACK")[0]
    .replaceAll(":'runtime'", `'${runtime}'`).replace("n.nspname='public'", `n.nspname='${schema}'`);
});
after(async () => {
  await app.end(); await owner.end();
  try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); }
});
const sqlCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
const status = (value: number) => (error: unknown) => (error as { status?: number }).status === value;
async function fixture(allowed = true) {
  const user = randomUUID(), community = randomUUID(), session = randomUUID(), workId = randomUUID();
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic execution grants')", [community]);
  const row = (await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic member','not-a-login',$4) RETURNING *`, [user, community, user+'@example.invalid', randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',clock_timestamp()+interval '1 hour')", [session, user]);
  const actor: Actor = { ...row, session_hash: session, csrf_token: 'synthetic' };
  const context = await withMemberScope(app, { actor, scope: 'personal' }, async () => {}, async (_q,c) => c);
  await owner.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
    VALUES($1,'personal_execution',$2,$3,$4,'Synthetic closed Run','No model or dispatch','draft',NULL)`,
  [workId, context.scope.scope_id, context.subject_principal.principal_id, user]);
  if (allowed) await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,$2,'work.private-draft',1,true,1048576)`, [context.scope.scope_id, context.subject_principal.principal_id]);
  return { actor, context, workId };
}
async function transaction(run: (q: PoolClient) => Promise<void>) {
  const q = await app.connect();
  try { await q.query('BEGIN'); await run(q); } finally { await q.query('ROLLBACK'); q.release(); }
}
async function insertRun(q: Pool | PoolClient, f: Awaited<ReturnType<typeof fixture>>, extra = '') {
  return q.query(`INSERT INTO ${schema}.execution_runs(run_id,work_item_id,scope_id,owner_principal_id,owner_user_id,input_work_version,persistence_policy_revision${extra ? ',state' : ''})
    VALUES($1,$2,$3,$4,$5,1,'private-work.v1'${extra ? ',$6' : ''}) RETURNING run_id`,
  [randomUUID(), f.workId, f.context.scope.scope_id, f.context.subject_principal.principal_id, f.actor.user_id, ...(extra ? [extra] : [])]);
}

test('RUN-ACL actual migrator/app sessions are non-superuser and real grant checker permits policy locking only', async () => {
  for (const [pool, name] of [[owner,migrator],[app,runtime]] as const) {
    const row = (await pool.query(`SELECT current_user,session_user,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.deepEqual(row, { current_user:name, session_user:name, rolsuper:false, rolcreaterole:false, rolcreatedb:false, rolreplication:false, rolbypassrls:false });
  }
  assert.deepEqual((await owner.query(checkQuery)).rows, [{ private_policy_read:true, private_policy_lock:true, private_policy_unsafe:false }, { private_policy_read:true, private_policy_lock:true, private_policy_unsafe:false }]);
  const privileges = (await app.query(`SELECT has_table_privilege(current_user,'execution_runs','SELECT') AS read,
    has_table_privilege(current_user,'execution_runs','INSERT') AS insert,
    has_table_privilege(current_user,'execution_runs','UPDATE') AS update,
    has_table_privilege(current_user,'execution_runs','DELETE') AS delete,
    has_table_privilege(current_user,'execution_runs','TRUNCATE') AS truncate,
    has_schema_privilege(current_user,$1,'CREATE') AS ddl`, [schema])).rows[0];
  assert.deepEqual(privileges, { read:true, insert:true, update:true, delete:true, truncate:false, ddl:false });
});
test('RUN-ACL default policy denies create; actual operator policy enables atomic member create/read/pause/stop', async () => {
  const f = await fixture(false), input = {key:randomUUID(), workId:f.workId, expectedWorkVersion:'1'};
  await assert.rejects(api.create(f.actor,input), status(503));
  assert.equal((await app.query('SELECT count(*)::int n FROM execution_runs WHERE work_item_id=$1',[f.workId])).rows[0].n,0);
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,$2,'work.private-draft',1,true,1048576)`, [f.context.scope.scope_id,f.context.subject_principal.principal_id]);
  const created = await api.create(f.actor,input); assert.equal(created.state,'created'); assert.equal(created.operational_authority,false);
  assert.deepEqual(await api.create(f.actor,input),created); assert.deepEqual(await api.read(f.actor,{runId:created.runId}),created);
  const paused = await api.pause(f.actor,{key:randomUUID(),runId:created.runId,expectedVersion:'1'});
  assert.equal(paused.state,'paused'); assert.equal(paused.aggregateVersion,'2'); assert.equal(paused.taskLeaseEpoch,'2'); assert.equal(paused.controlEpoch,'2');
  const stopInput={key:randomUUID(),runId:created.runId,expectedVersion:'2'};
  const stopped = await api.stop(f.actor,stopInput); assert.equal(stopped.state,'cancelled'); assert.equal(stopped.aggregateVersion,'3');
  assert.deepEqual(await api.stop(f.actor,stopInput),stopped);
  assert.equal((await app.query("SELECT count(*)::int n FROM scoped_transition_journal WHERE aggregate_type='execution_run' AND aggregate_id=$1",[created.runId])).rows[0].n,3);
});
test('RUN-ACL app cannot grant itself policy, write migration ledger, truncate Run history or disable its trigger', async () => {
  const f=await fixture();
  for (const sql of [
    'UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=revision+1',
    'UPDATE private_work_persistence_policy SET scope_kind=DEFAULT,retained_byte_limit=524288',
    'DELETE FROM private_work_persistence_policy', 'INSERT INTO private_work_persistence_policy DEFAULT VALUES',
    'UPDATE schema_migrations SET name=name', 'TRUNCATE execution_runs',
    'ALTER TABLE execution_runs DISABLE TRIGGER preserve_execution_run',
  ]) await assert.rejects(app.query(sql),sqlCode('42501'));
  const before=(await owner.query('SELECT * FROM private_work_persistence_policy WHERE scope_id=$1',[f.context.scope.scope_id])).rows[0];
  await app.query('UPDATE private_work_persistence_policy SET scope_kind=DEFAULT WHERE scope_id=$1',[f.context.scope.scope_id]);
  assert.deepEqual((await owner.query('SELECT * FROM private_work_persistence_policy WHERE scope_id=$1',[f.context.scope.scope_id])).rows[0],before);
});
test('RUN-ACL direct inserts cannot invent policy provenance or activate a Run', async () => {
  const f=await fixture(false); await assert.rejects(insertRun(app,f),sqlCode('23514'));
  await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit)
    VALUES($1,$2,'work.private-draft',1,false,1048576)`,[f.context.scope.scope_id,f.context.subject_principal.principal_id]);
  await assert.rejects(insertRun(app,f),sqlCode('23514'));
  await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=true,revision=2 WHERE scope_id=$1',[f.context.scope.scope_id]);
  await assert.rejects(insertRun(app,f),sqlCode('23514'),'old claimed private-work.v1 is not current policy');
  const enabled=await fixture();
  for (const state of ['running','preflighting','completed','paused','cancelled']) await assert.rejects(insertRun(app,enabled,state),sqlCode('23514'));
});
test('RUN-ACL direct DML cannot rebind immutable identity, skip fences, resurrect cancelled state or delete history', async () => {
  const f=await fixture(), run=await api.create(f.actor,{key:randomUUID(),workId:f.workId,expectedWorkVersion:'1'});
  for (const assignment of ["run_id=gen_random_uuid()",'work_item_id=gen_random_uuid()','scope_id=gen_random_uuid()',
    'owner_principal_id=gen_random_uuid()','owner_user_id=gen_random_uuid()','input_work_version=2',
    "persistence_policy_revision='private-work.v2'","created_at=created_at+interval '1 second'",
    "state='running'","state='paused'","state='paused',aggregate_version=2,task_lease_epoch=1,control_epoch=2",
    "state='paused',aggregate_version=2,task_lease_epoch=2,control_epoch=1",
    "state='paused',aggregate_version=3,task_lease_epoch=3,control_epoch=3",
  ]) await assert.rejects(app.query(`UPDATE execution_runs SET ${assignment} WHERE run_id=$1`,[run.runId]),sqlCode('23514'));
  await assert.rejects(app.query('DELETE FROM execution_runs WHERE run_id=$1',[run.runId]),sqlCode('23514'));
  await api.stop(f.actor,{key:randomUUID(),runId:run.runId,expectedVersion:'1'});
  await assert.rejects(app.query("UPDATE execution_runs SET state='paused',aggregate_version=3,task_lease_epoch=3,control_epoch=3 WHERE run_id=$1",[run.runId]),sqlCode('23514'));
});
test('RUN-ACL member ACL remains current while policy withdrawal and archived Work still permit human read/pause/stop', async () => {
  const f=await fixture(), outsider=await fixture(), run=await api.create(f.actor,{key:randomUUID(),workId:f.workId,expectedWorkVersion:'1'});
  await assert.rejects(api.read(outsider.actor,{runId:run.runId}),status(404));
  for (const action of ['pause','stop'] as const) await assert.rejects(api[action](outsider.actor,{key:randomUUID(),runId:run.runId,expectedVersion:'1'}),status(404));
  await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=2 WHERE scope_id=$1',[f.context.scope.scope_id]);
  await owner.query("UPDATE work_items SET state='archived',aggregate_version=2 WHERE work_item_id=$1",[f.workId]);
  assert.equal((await api.read(f.actor,{runId:run.runId})).state,'created');
  await api.pause(f.actor,{key:randomUUID(),runId:run.runId,expectedVersion:'1'});
  await api.stop(f.actor,{key:randomUUID(),runId:run.runId,expectedVersion:'2'});
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  await assert.rejects(api.read(f.actor,{runId:run.runId}),status(401));
});
test('RUN-ACL invoker trigger cannot trust TEMP-shadowed allowing policy over real operator denial', async () => {
  const f=await fixture();
  await owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false,revision=2 WHERE scope_id=$1',[f.context.scope.scope_id]);
  await transaction(async q=>{
    assert.equal((await q.query('SELECT has_database_privilege(current_user,current_database(),\'TEMP\') AS allowed')).rows[0].allowed,true);
    await q.query(`CREATE TEMP TABLE private_work_persistence_policy (LIKE ${schema}.private_work_persistence_policy INCLUDING ALL) ON COMMIT DROP`);
    await q.query(`INSERT INTO pg_temp.private_work_persistence_policy(scope_id,owner_principal_id,purpose,revision,persistence_allowed,retained_byte_limit)
      VALUES($1,$2,'work.private-draft',1,true,1048576)`,[f.context.scope.scope_id,f.context.subject_principal.principal_id]);
    await assert.rejects(insertRun(q,f),sqlCode('23514'));
  });
});
test('RUN-ACL invoker trigger cannot trust TEMP-shadowed draft/version over real archived Work', async () => {
  const f=await fixture();
  await owner.query("UPDATE work_items SET state='archived',aggregate_version=2 WHERE work_item_id=$1",[f.workId]);
  await assert.rejects(insertRun(app,f),sqlCode('23514'));
  await transaction(async q=>{
    await q.query(`CREATE TEMP TABLE work_items (LIKE ${schema}.work_items INCLUDING ALL) ON COMMIT DROP`);
    await q.query(`INSERT INTO pg_temp.work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
      VALUES($1,'personal_execution',$2,$3,$4,'Synthetic shadow','Never an authority','draft',NULL)`,
    [f.workId,f.context.scope.scope_id,f.context.subject_principal.principal_id,f.actor.user_id]);
    await assert.rejects(insertRun(q,f),sqlCode('23514'));
  });
});
test('RUN-ACL direct Run initialization cannot skip or null independent counters', async () => {
  const f=await fixture();
  for (const column of ['aggregate_version','task_lease_epoch','control_epoch']) {
    for (const value of [null,2]) await assert.rejects(app.query(`INSERT INTO execution_runs
      (run_id,work_item_id,scope_id,owner_principal_id,owner_user_id,input_work_version,persistence_policy_revision,${column})
      VALUES($1,$2,$3,$4,$5,1,'private-work.v1',$6)`,
    [randomUUID(),f.workId,f.context.scope.scope_id,f.context.subject_principal.principal_id,f.actor.user_id,value]),sqlCode(value===null?'23502':'23514'));
  }
});
