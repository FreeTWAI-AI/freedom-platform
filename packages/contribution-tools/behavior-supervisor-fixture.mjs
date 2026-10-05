// Host-side fixture only. No candidate imports or candidate migration scripts.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readMigrationSources } from '../db/migration-files.mjs';
import { legacyMigrationProfile, resolveMigrationPlan } from '../db/migration-plan.mjs';
import pg from 'pg';
import sharp from 'sharp';
import { MEMBER_BEHAVIOR as manifest } from './behavior-manifest.mjs';
export const FIXTURE_DATABASE = 'fp_behavior_supervisor';
export async function openSupervisorDatabase(socketDirectory, password) {
  const pool = new pg.Pool({ host: socketDirectory, database: FIXTURE_DATABASE, user: 'postgres', password, max: 2,
    connectionTimeoutMillis: 1000, statement_timeout: 10000 });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await pool.query('SELECT 1'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!ready) { await pool.end(); throw new Error('supervisor_database_unavailable'); }
  return pool;
}
export async function initializeSupervisorFixture(pool, appPassword) {
  const migrations = new URL('../../migrations/', import.meta.url);
  const migrationManifest = JSON.parse(await readFile(new URL('../../deploy/cloudflare/environments.json', import.meta.url), 'utf8'));
  const plan = resolveMigrationPlan(readMigrationSources(fileURLToPath(migrations)), legacyMigrationProfile(migrationManifest.database_defaults.migrations));
  await pool.query('BEGIN');
  try {
    for (const name of plan.execution_order) {
      await pool.query(plan.sql[name]);
    }
    await pool.query('COMMIT');
  } catch (error) { await pool.query('ROLLBACK'); throw error; }
  const ownerCommunity = randomUUID(), otherCommunity = randomUUID();
  await pool.query("INSERT INTO communities VALUES($1,'Synthetic owner'),($2,'Synthetic outsider')", [ownerCommunity, otherCommunity]);
  async function member(community, revoked = false) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(16).toString('base64url');
    await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
      VALUES($1,$2,$3,'Synthetic isolated fixture','not-a-login',$4)`, [id, community, id + '@example.invalid', randomUUID()]);
    await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,revoked_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes',CASE WHEN $4 THEN clock_timestamp() ELSE NULL END)`,
    [createHash('sha256').update(token).digest('hex'), id, csrf, revoked]);
    const principal = randomUUID(), scope = randomUUID();
    await pool.query('INSERT INTO principals(principal_id,user_ref) VALUES($1,$2)', [principal, id]);
    await pool.query("INSERT INTO resource_scopes(scope_id,kind,owner_principal_id) VALUES($1,'personal',$2)", [scope, principal]);
    return { id, cookie: 'freedom_local_session=' + token, csrf, principal, scope };
  }
  const owner = await member(ownerCommunity), outsider = await member(otherCommunity), revoked = await member(ownerCommunity, true);
  const work = randomUUID();
  await pool.query(`INSERT INTO work_items(work_item_id,work_mode,scope_id,owner_principal_id,owner_ref,title,objective,state,participation_terms_revision)
    VALUES($1,'personal_execution',$2,$3,$4,$5,$6,'draft',NULL)`, [work, owner.scope, owner.principal, owner.id, manifest.title, manifest.objective]);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#337799' } }).webp().toBuffer();
  await pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes) VALUES($1,$2,$3)', [owner.id, ownerCommunity, image]);
  const passwordLiteral = (await pool.query('SELECT quote_literal($1::text) value', [appPassword])).rows[0].value;
  await pool.query(`CREATE ROLE behavior_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${passwordLiteral};
    GRANT USAGE ON SCHEMA public TO behavior_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO behavior_app;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO behavior_app;
    REVOKE ALL ON private_work_persistence_policy FROM behavior_app;
    GRANT SELECT,UPDATE(scope_kind) ON private_work_persistence_policy TO behavior_app;`);
  const publicMember = ({ id, cookie, csrf }) => ({ id, cookie, csrf });
  return { instance_id: randomUUID(), owner: publicMember(owner), outsider: publicMember(outsider),
    revoked: { cookie: revoked.cookie, csrf: revoked.csrf }, work_id: work };
}
export async function supervisorFixtureFacts(pool, fixture) {
  await pool.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const fingerprints = [];
  for (const { tablename } of tables) {
    if (!/^[a-z0-9_]+$/.test(tablename)) throw new Error('supervisor_fixture_changed');
    // Only session activity touch is an expected effect of these fixed requests.
    // Hashes cover all other rows/fields, including ACLs, sessions and both outboxes.
    const value = tablename === 'sessions' ? "to_jsonb(t)-'last_seen_at'" : 'to_jsonb(t)';
    const budget = (await pool.query(`SELECT count(*)::text rows,coalesce(sum(pg_column_size(t)),0)::text bytes FROM public."${tablename}" t`)).rows[0];
    if (BigInt(budget.rows) > 10000n || BigInt(budget.bytes) > 33554432n) throw new Error('supervisor_fixture_changed');
    // Return fixed-size hashes only. Candidate-controlled text never enters host
    // result arrays; DB execution is bounded by its cgroup and statement timeout.
    const rowDigest = `encode(sha256(convert_to((${value})::text,'UTF8')),'hex')`;
    const digest = (await pool.query(`SELECT encode(sha256(convert_to(coalesce(string_agg(${rowDigest},'' ORDER BY ${rowDigest}),''),'UTF8')),'hex') digest
      FROM public."${tablename}" t`)).rows[0].digest;
    fingerprints.push([tablename, budget.rows, digest]);
  }
  await pool.query('COMMIT');
  return fingerprints;
  } catch (error) { await pool.query('ROLLBACK'); throw error; }
}
