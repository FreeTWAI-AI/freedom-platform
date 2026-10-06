import {createPool} from '../packages/db/index.js';
import {backfillGuildPreferences} from '../modules/positioning/guild-categories.js';

// Restartable category-primary backfill. Defaults to a dry run. Pass --execute to write.
// Requires an explicit database URL and refuses production and the shared local database.
if (process.env.NODE_ENV === 'production') throw new Error('Guild preference backfill cannot target production.');
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const databaseUrl = option('--database-url');
if (!databaseUrl) throw new Error('Pass --database-url. This script does not read DATABASE_URL.');
if (databaseUrl.includes('54339') || /\/freedom_local(\?|$)/.test(databaseUrl)) throw new Error('Refusing the shared local database.');
const execute = args.includes('--execute');
const limit = option('--limit');
const communityArg = option('--community-id');
const pool = createPool(databaseUrl);
try {
  const communities = (await pool.query('SELECT community_id FROM communities ORDER BY community_id')).rows as {community_id: string}[];
  const communityId = communityArg ?? (communities.length === 1 ? communities[0].community_id : undefined);
  if (!communityId) throw new Error('Pass --community-id when the database has more than one community.');
  const result = await backfillGuildPreferences(pool, {
    communityId,
    dryRun: !execute,
    limit: limit === undefined ? undefined : Number(limit),
  });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
