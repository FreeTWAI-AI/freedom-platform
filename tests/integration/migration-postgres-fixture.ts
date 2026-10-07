// Owned PostgreSQL fixture for the migration integration tests. No TEST_DATABASE_URL
// or private config. Importing it registers the container hooks; it declares no tests.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, chmod, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';

const image = 'sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd';
const imageReference = 'postgres:18-alpine@' + image;
let imageId = '';
const label = randomUUID(), password = randomBytes(32).toString('base64url');
export let container = '', directory = '', socket = '', admin: Pool | undefined;
let lifecycle: { dispatch(kind: string, operation: string, invoke: () => string): string; cleanupState(empty: boolean): { cleanup_verified: boolean; status: string } } | undefined;
const containerName = 'fp-c5-migrations-' + label;
const docker = (args: string[], env: Record<string,string> = {}) => execFileSync('/usr/bin/docker', args, {
  env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 30000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
before(async () => {
  // Docker's classic and containerd image stores can report different local
  // image IDs. Bind the immutable repository digest to that store's actual ID.
  const installed = JSON.parse(docker(['image', 'inspect', '--format', '{{json .}}', imageReference]));
  assert.match(installed.Id, /^sha256:[a-f0-9]{64}$/);
  assert(installed.RepoDigests.some((digest: string) => digest === 'postgres@' + image || digest === 'docker.io/library/postgres@' + image));
  imageId = installed.Id;
  directory = await mkdtemp(join(tmpdir(), 'fp-c5-postgres-')); socket = join(directory, 'socket');
  await mkdir(socket); await chmod(socket, 0o777);
  const { createSupervisorContainerLifecycle } = await import(new URL('../../packages/contribution-tools/behavior-supervisor.mjs', import.meta.url).href);
  lifecycle = createSupervisorContainerLifecycle();
  // Durable intent exists before Docker can commit a create with a lost ACK.
  await writeFile(join(directory, 'intent.json'), JSON.stringify({ label, name: containerName, state: 'create_pending', socket }), { mode: 0o600, flag: 'wx' });
  container = lifecycle!.dispatch('database', 'create', () => docker(['create', '--name', containerName, '--pull=never', '--network', 'none', '--read-only', '--user', 'postgres',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--memory-swap', '512m',
    '--pids-limit', '128', '--cpus', '1', '--log-driver', 'none', '--ulimit', 'core=0:0', '--ulimit', 'nofile=256:256',
    '--label', 'freedom.migration-test=' + label, '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,size=1m', '--mount', `type=bind,src=${socket},dst=/run/postgresql`,
    '-e', 'PGDATA=/tmp/data', '-e', 'POSTGRES_DB=fp_c5_migrations', '-e', 'POSTGRES_PASSWORD',
    '-e', 'POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=reject', imageReference,
    'postgres', '-c', 'listen_addresses=', '-c', 'unix_socket_directories=/run/postgresql', '-c', 'max_locks_per_transaction=256'], { POSTGRES_PASSWORD: password }));
  assert.match(container, /^[a-f0-9]{64}$/);
  await writeFile(join(directory, 'intent.json'), JSON.stringify({ label, name: containerName, state: 'acknowledged', container, socket }), { mode: 0o600 });
  docker(['start', container]);
  const observed = JSON.parse(docker(['inspect', '--format', '{{json .}}', container]));
  assert.equal(observed.Image, imageId); assert.equal(observed.Config.Image, imageReference);
  assert.equal(observed.Config.Labels['freedom.migration-test'], label);
  assert.equal(observed.HostConfig.NetworkMode, 'none'); assert.equal(observed.HostConfig.ReadonlyRootfs, true);
  assert.equal(observed.HostConfig.Memory, 536870912); assert.equal(observed.HostConfig.PidsLimit, 128);
  admin = new Pool({ host: socket, user: 'postgres', database: 'fp_c5_migrations', password, max: 2, connectionTimeoutMillis: 1000, statement_timeout: 30000 });
  let ready = false;
  for (let n = 0; n < 100; n++) { try { await admin.query('SELECT 1'); ready = true; break; } catch { await delay(100); } }
  assert.equal(ready, true, 'owned PostgreSQL is ready');
  const target = (await admin.query('SELECT current_database() db,version() version')).rows[0];
  assert.equal(target.db, 'fp_c5_migrations'); assert.match(target.version, /^PostgreSQL 18\./);
  console.log(JSON.stringify({ evidence: 'owned-local-postgres', image, database: target.db, version: target.version.split(' on ')[0], network: 'none' }));
});
after(async () => {
  let poolClosed = true; try { await admin?.end(); } catch { poolClosed = false; }
  let empty = false;
  // Bounded reconciliation finds only this invocation's label. Even a later
  // empty scan cannot acknowledge a timed-out create; retain its socket/intent.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ids = docker(['ps', '-aq', '--no-trunc', '--filter', 'label=freedom.migration-test=' + label]).split('\n').filter(Boolean);
      for (const id of ids) {
        if (!/^[a-f0-9]{64}$/.test(id)) continue;
        const owned = JSON.parse(docker(['inspect', '--format', '{{json .}}', id]));
        if (owned.Config.Labels?.['freedom.migration-test'] === label && owned.Name === '/' + containerName && owned.Image === imageId && owned.Config.Image === imageReference) docker(['rm', '-f', id]);
      }
      empty = docker(['ps', '-aq', '--no-trunc', '--filter', 'label=freedom.migration-test=' + label]) === '';
      if (empty && lifecycle?.cleanupState(true).cleanup_verified) break;
    } catch { empty = false; }
    await delay(100);
  }
  const cleanup = lifecycle?.cleanupState(empty) ?? { cleanup_verified: empty, status: 'not_dispatched' };
  if (directory && cleanup.cleanup_verified) await rm(directory, { recursive: true, force: true });
  else if (directory) {
    await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ label, name: containerName, ...cleanup }), { mode: 0o600 });
    console.log(JSON.stringify({ evidence: 'cleanup_unverified', intent_directory: directory, label, status: cleanup.status }));
  }
  assert.equal(poolClosed, true, 'test pool closed'); assert.equal(cleanup.cleanup_verified, true, 'owned create/cleanup resolved; retain intent/socket otherwise');
  console.log('owned PostgreSQL container and socket directory removed');
});
export async function isolated(run: (pool: Pool, connectionString: string, target: { database: string; role: string; schema: string }) => Promise<void>) {
  const schema = 'fp_c5_' + randomBytes(8).toString('hex'); await admin!.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ host: socket, user: 'postgres', database: 'fp_c5_migrations', password, options: `-c search_path=${schema} -c statement_timeout=30000`, max: 2 });
  const url = new URL('postgresql://postgres:'+password+'@localhost/fp_c5_migrations'); url.searchParams.set('host',socket); url.searchParams.set('options',`-c search_path=${schema}`);
  try { await run(pool,url.href,{database:'fp_c5_migrations',role:'postgres',schema}); } finally { await pool.end(); await admin!.query(`DROP SCHEMA ${schema} CASCADE`); }
}
