import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

// Admission checks are not proof that a database is disposable. Its operator
// must provision an isolated test-only server; this library never discovers one.
export function isDisposableDatabaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\0]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || url.password
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(url.username)
      || !/^\/fp_[a-z0-9_]{1,59}$/.test(url.pathname)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) return false;
    const entries = [...url.searchParams];
    if (entries.length === 0) return true;
    if (entries.length !== 1 || entries[0][0] !== 'host') return false;
    const socket = entries[0][1];
    return /^\/[a-zA-Z0-9_./-]+$/.test(socket) && resolve(socket) === socket && socket !== '/';
  } catch { return false; }
}


// The caller must explicitly provide a disposable, local test server. Each
// invocation owns only these fresh databases; it never drops the supplied DB.
export async function createRuntimeDatabases(baseUrl, count) {
  if (count !== 2) throw Error('invalid_runtime_shards');
  if (!isDisposableDatabaseUrl(baseUrl)) throw Error('test_database_rejected');
  const { Client } = createRequire(import.meta.url)('pg');
  const prefix = `fp_suite_${process.pid}_${randomBytes(8).toString('hex')}`;
  const connection = application_name => {
    const client = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 2000,
      query_timeout: 2000, statement_timeout: 2000, application_name });
    client.on('error', () => { /* query/cleanup failures never print connection details */ });
    return client;
  };
  const ownerApplication = prefix + '_owner', client = connection(ownerApplication);
  const names = [], urls = [];
  let owner, ownerPid;
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  async function close(connection) {
    let timer;
    const ended = await Promise.race([connection.end().then(() => true, () => false),
      new Promise(done => { timer = setTimeout(() => done(false), 1000); })]);
    clearTimeout(timer);
    if (!ended) connection.connection?.stream?.destroy();
    return ended;
  }
  async function cleanup() {
    // CREATE may have committed without an acknowledged response. Close and
    // positively terminate this invocation's exact nonce-bound owner backend
    // before examining pre-registered candidate names on a fresh connection.
    await close(client);
    if (!names.length) return true;
    const cleaner = connection(prefix + '_cleanup');
    let okay = true;
    try {
      await cleaner.connect();
      const identity = await cleaner.query('SELECT current_database() AS database, current_user AS owner, session_user AS session');
      if (identity.rows[0].database !== new URL(baseUrl).pathname.slice(1)
        || identity.rows[0].owner !== owner || identity.rows[0].session !== owner) throw Error('cleanup_identity');
      const stopped = await cleaner.query('SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE pid=$1 AND usename=$2 AND application_name=$3', [ownerPid, owner, ownerApplication]);
      if (stopped.rows.some(row => row.stopped !== true)) throw Error('owner_backend_unsettled');
      for (const name of names) {
        try {
          const found = await cleaner.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [name]);
          if (!found.rows.length) continue;
          if (found.rows[0].owner !== owner) { okay = false; continue; }
          await cleaner.query('SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
          await cleaner.query(`DROP DATABASE ${quote(name)}`);
        } catch { okay = false; }
      }
    } catch { okay = false; }
    if (!await close(cleaner)) okay = false;
    return okay;
  }
  try {
    await client.connect();
    const identity = await client.query('SELECT current_database() AS database, current_user AS owner, session_user AS session, pg_backend_pid() AS pid');
    owner = identity.rows[0].owner; ownerPid = identity.rows[0].pid;
    const supplied = new URL(baseUrl);
    if (identity.rows[0].database !== supplied.pathname.slice(1) || owner !== supplied.username
      || owner !== identity.rows[0].session) throw Error('runtime_database_identity');
    for (let index = 0; index < count; index++) {
      const name = `${prefix}_${index}`;
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
      if (existing.rowCount) throw Error('runtime_database_collision');
      names.push(name); // register BEFORE CREATE, including unknown acknowledgements
      await client.query(`CREATE DATABASE ${quote(name)} OWNER ${quote(owner)} TEMPLATE template0`);
      const url = new URL(baseUrl); url.pathname = '/' + name; urls.push(url.href);
    }
    return { urls, cleanup };
  } catch {
    const error = Error('runtime_database_provision_failed');
    error.cleanupVerified = await cleanup();
    throw error;
  }
}
