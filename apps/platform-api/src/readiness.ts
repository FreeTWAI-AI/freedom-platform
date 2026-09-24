import type { Pool } from 'pg';
import type { FreedomEnv } from './env.js';

type Queryable = Pick<Pool, 'query'>;
export type DatabaseExpectation = { registrationCommunityId?: string; databaseName?: string };

/** Messages never name the database, URL, role or community actually found. */
export class ReadinessError extends Error {
  override name = 'ReadinessError';
}
const UUID = /^[0-9a-f-]{36}$/i;
const SHARED_DATABASES = ['freedom_local', 'freedom_staging'];

/** Existing public guard: a dedicated, initialized, non-superuser database without demo accounts. */
export async function assertPublicDatabase(pool: Queryable, expected: DatabaseExpectation): Promise<void> {
  const community = expected.registrationCommunityId;
  if (!community || !UUID.test(community)) throw new ReadinessError('Public registration requires an explicit community ID.');
  const database = (await pool.query('SELECT current_database() AS name,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (!database || database.rolsuper || database.name !== expected.databaseName || SHARED_DATABASES.includes(database.name)) throw new ReadinessError('Public runtime requires a dedicated non-superuser database.');
  if ((await pool.query('SELECT 1 FROM communities WHERE community_id=$1', [community])).rowCount !== 1) throw new ReadinessError('Public community is not initialized.');
  if ((await pool.query("SELECT 1 FROM users WHERE email LIKE '%@local.test' LIMIT 1")).rowCount) throw new ReadinessError('Public database must not contain local demo accounts.');
}

/** Staging keeps demo accounts but must still use its own named, non-superuser database. */
export async function assertStagingDatabase(pool: Queryable, expected: DatabaseExpectation): Promise<void> {
  const community = expected.registrationCommunityId;
  if (community !== undefined && !UUID.test(community)) throw new ReadinessError('Staging registration community must be a UUID when set.');
  const database = (await pool.query('SELECT current_database() AS name,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
  if (!database || database.rolsuper || !expected.databaseName || database.name !== expected.databaseName || database.name === 'freedom_local') throw new ReadinessError('Staging runtime requires its own non-superuser database.');
  if (community && (await pool.query('SELECT 1 FROM communities WHERE community_id=$1', [community])).rowCount !== 1) throw new ReadinessError('Staging community is not initialized.');
}

export async function assertDatabaseReady(pool: Queryable, env: FreedomEnv, expected: DatabaseExpectation): Promise<void> {
  if (env === 'public') return assertPublicDatabase(pool, expected);
  if (env === 'staging') return assertStagingDatabase(pool, expected);
}
