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
export async function createRuntimeDatabases(baseUrl, count, provisionTimeoutMs = 20_000) {
  if (![1, 2, 4].includes(count)) throw Error('invalid_runtime_shards');
  if (!Number.isSafeInteger(provisionTimeoutMs) || provisionTimeoutMs < 1 || provisionTimeoutMs > 20_000) throw Error('invalid_provision_timeout');
  const provisionDeadline = performance.now() + provisionTimeoutMs;
  if (!isDisposableDatabaseUrl(baseUrl)) throw Error('test_database_rejected');
  const { Client } = createRequire(import.meta.url)('pg');
  const prefix = `fp_suite_${process.pid}_${randomBytes(8).toString('hex')}`;
  const connection = (application_name, limits = {}) => {
    const client = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 2000,
      query_timeout: 2000, statement_timeout: 2000, application_name, ...limits });
    client.on('error', () => { /* query/cleanup failures never print connection details */ });
    return client;
  };
  const ownerApplication = prefix + '_owner', client = connection(ownerApplication, { connectionTimeoutMillis: Math.min(2000, provisionTimeoutMs) });
  const names = [], urls = [];
  let owner, ownerPid;
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  async function close(connection, maximum = 1000) {
    let timer;
    const ended = await Promise.race([connection.end().then(() => true, () => false),
      new Promise(done => { timer = setTimeout(() => done(false), Math.max(0, maximum)); })]);
    clearTimeout(timer);
    if (!ended) connection.connection?.stream?.destroy();
    return ended;
  }
  async function cleanup() {
    // One absolute 20s budget, inside the suite's unchanged 24s cleanup reserve.
    // In particular, DROP may wait for a checkpoint; it must not inherit the
    // short metadata-query timeout or gain an unbounded per-database budget.
    const deadline = performance.now() + 20_000;
    const remaining = () => Math.floor(deadline - performance.now());
    async function boundedQuery(c, text, values = [], maximum = 2000) {
      const milliseconds = Math.min(maximum, remaining() - 100);
      if (milliseconds <= 0) throw Error('cleanup_deadline');
      await c.query({ text: "SELECT set_config('statement_timeout',$1,false)",
        values: [String(milliseconds)], query_timeout: Math.min(1000, remaining()) });
      const timeout = Math.min(milliseconds + 50, remaining());
      if (timeout <= 0) throw Error('cleanup_deadline');
      return c.query({ text, values, query_timeout: timeout });
    }
    async function identity(c) {
      const row = (await boundedQuery(c, 'SELECT current_database() AS database, current_user AS owner, session_user AS session, pg_backend_pid() AS pid')).rows[0];
      if (row?.database !== new URL(baseUrl).pathname.slice(1) || row.owner !== owner || row.session !== owner) throw Error('cleanup_identity');
      return row.pid;
    }
    async function stop(c, pid, application) {
      const rows = (await boundedQuery(c, 'SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE pid=$1 AND usename=$2 AND application_name=$3', [pid, owner, application])).rows;
      if (rows.some(row => row.stopped !== true)) throw Error('owner_backend_unsettled');
    }
    // CREATE may commit with an unknown ACK. Its exact nonce-bound owner must
    // stop before we consider any pre-registered name on a fresh connection.
    await close(client, Math.min(1000, remaining()));
    if (!names.length) return true;
    const cleanupApplication = prefix + '_cleanup';
    const cleaner = connection(cleanupApplication, { connectionTimeoutMillis: Math.max(1, Math.min(2000, remaining())) });
    let okay = true, cleanerPid;
    try {
      await cleaner.connect();
      cleanerPid = await identity(cleaner);
      await stop(cleaner, ownerPid, ownerApplication);
      for (const [index, name] of names.entries()) {
        const found = await boundedQuery(cleaner, 'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1', [name]);
        if (!found.rows.length) continue;
        if (found.rows[0].owner !== owner) { okay = false; continue; }
        const stopped = await boundedQuery(cleaner, 'SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
        if (stopped.rows.some(row => row.stopped !== true)) throw Error('database_backend_unsettled');
        const dropBudget = Math.min(6000, Math.floor((remaining() - 4000) / (names.length - index)));
        try { await boundedQuery(cleaner, `DROP DATABASE ${quote(name)}`, [], dropBudget); }
        catch { /* Unknown DROP acknowledgement requires fresh reconciliation. */ }
      }
    } catch { okay = false; }
    await close(cleaner, Math.min(1000, remaining()));
    // Never equate an ACK (or its absence) to proof of deletion. Settle the
    // exact cleanup backend, then positively verify every owned name absent.
    // An identity/ownership failure above cannot be converted into success.
    if (!okay || !cleanerPid || remaining() <= 1000) return false;
    const verifier = connection(prefix + '_verify', { connectionTimeoutMillis: Math.min(2000, remaining()) });
    try {
      await verifier.connect();
      await identity(verifier);
      await stop(verifier, cleanerPid, cleanupApplication);
      const found = await boundedQuery(verifier, 'SELECT datname FROM pg_database WHERE datname=ANY($1)', [names]);
      return found.rowCount === 0 && remaining() > 0;
    } catch { return false; }
    finally { await close(verifier, Math.min(1000, remaining())); }
  }

  async function provisionQuery(text, values = [], maximum = 2000) {
    const budget = Math.min(maximum, Math.floor(provisionDeadline - performance.now()));
    if (budget <= 0) throw Error('provision_deadline');
    return client.query({ text, values, query_timeout: budget });
  }
  try {
    await client.connect();
    const identity = await provisionQuery('SELECT current_database() AS database, current_user AS owner, session_user AS session, pg_backend_pid() AS pid');
    owner = identity.rows[0].owner; ownerPid = identity.rows[0].pid;
    const supplied = new URL(baseUrl);
    if (identity.rows[0].database !== supplied.pathname.slice(1) || owner !== supplied.username
      || owner !== identity.rows[0].session) throw Error('runtime_database_identity');
    for (let index = 0; index < count; index++) {
      const name = `${prefix}_${index}`;
      const existing = await provisionQuery('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
      if (existing.rowCount) throw Error('runtime_database_collision');
      names.push(name); // register BEFORE CREATE, including unknown acknowledgements
      const createTimeout = Math.min(6000, Math.floor(provisionDeadline - performance.now()) - 100);
      if (createTimeout <= 0) throw Error('provision_deadline');
      await provisionQuery("SELECT set_config('statement_timeout',$1,false)", [String(createTimeout)]);
      await provisionQuery(`CREATE DATABASE ${quote(name)} OWNER ${quote(owner)} TEMPLATE template0`, [], createTimeout + 50);
      await provisionQuery("SET statement_timeout=2000");
      const url = new URL(baseUrl); url.pathname = '/' + name; urls.push(url.href);
    }
    if (performance.now() >= provisionDeadline) throw Error('provision_deadline');
    return { urls, cleanup };
  } catch {
    const error = Error('runtime_database_provision_failed');
    error.cleanupVerified = await cleanup();
    throw error;
  }
}
