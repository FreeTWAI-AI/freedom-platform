import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Pool} from 'pg';
import {createPool} from '../packages/db/index.js';
import {
  backfillGuildPreferences,
  backfillInTransaction,
  communitySwitched,
} from '../modules/positioning/guild-categories.js';

// Restartable category-primary backfill. Defaults to a dry run. Pass --execute to write.
// Pass --status for a read-only snapshot of legacy, backfilled, switched and blocked communities.
// A preference set left in `legacy` by an ambiguous recompute stays a candidate until a clean plan moves it to `backfilled`.
// Requires an explicit database URL and refuses production and the shared local database.

export type GuildPreferenceStatus = {
  totals: {
    communities: number;
    legacy: number;
    backfilled: number;
    switched: number;
    blocked: number;
    preference_sets: {legacy: number; backfilled: number; switched: number};
  };
  communities: Array<{
    community_id: string;
    state: 'switched' | 'blocked' | 'legacy' | 'backfilled';
    switched_at: string | null;
    remaining: number;
    remaining_blocked: number;
    blocking_reasons: Record<string, number>;
    blocking_reasons_complete: boolean;
    preference_sets: {legacy: number; backfilled: number; switched: number};
  }>;
};

export async function guildPreferenceStatus(pool: Pool, options: {communityId?: string} = {}): Promise<GuildPreferenceStatus> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const communityId = options.communityId;
    const rows = (communityId
      ? await client.query('SELECT community_id FROM communities WHERE community_id = $1 ORDER BY community_id', [communityId])
      : await client.query('SELECT community_id FROM communities ORDER BY community_id')
    ).rows as {community_id: string}[];
    if (communityId && rows.length === 0) throw new Error('No community matches --community-id.');

    const communities: GuildPreferenceStatus['communities'] = [];
    for (const row of rows) {
      const cId = row.community_id;
      const report = await backfillInTransaction(client, {communityId: cId, dryRun: true, limit: 500});
      const switched = await communitySwitched(client, cId);
      const switchedRow = (await client.query(
        `SELECT switched_at FROM guild_preference_switch WHERE community_id = $1 AND state = 'switched'`,
        [cId],
      )).rows[0] as {switched_at: Date | string | null} | undefined;
      const switched_at = switchedRow?.switched_at ? new Date(switchedRow.switched_at).toISOString() : null;

      const preference_sets = {legacy: 0, backfilled: 0, switched: 0};
      const prefRows = (await client.query(
        `SELECT migration_state::text AS migration_state, count(*)::int AS count FROM guild_preference_sets WHERE community_id = $1 GROUP BY migration_state`,
        [cId],
      )).rows as {migration_state: string; count: number}[];
      for (const pr of prefRows) {
        if (pr.migration_state in preference_sets) {
          preference_sets[pr.migration_state as keyof typeof preference_sets] = Number(pr.count);
        }
      }

      let state: 'switched' | 'blocked' | 'legacy' | 'backfilled';
      if (switched) {
        state = 'switched';
      } else if (report.remaining_blocked > 0) {
        state = 'blocked';
      } else if (report.remaining > 0) {
        state = 'legacy';
      } else {
        state = 'backfilled';
      }

      const blocking_reasons: Record<string, number> = {};
      for (const m of report.blocked_members) {
        blocking_reasons[m.reason] = (blocking_reasons[m.reason] ?? 0) + 1;
      }
      const blocking_reasons_complete = report.blocked_members.length === report.remaining_blocked;

      communities.push({
        community_id: cId,
        state,
        switched_at,
        remaining: report.remaining,
        remaining_blocked: report.remaining_blocked,
        blocking_reasons,
        blocking_reasons_complete,
        preference_sets,
      });
    }

    const totals = {
      communities: communities.length,
      legacy: 0,
      backfilled: 0,
      switched: 0,
      blocked: 0,
      preference_sets: {legacy: 0, backfilled: 0, switched: 0},
    };
    for (const c of communities) {
      totals[c.state]++;
      totals.preference_sets.legacy += c.preference_sets.legacy;
      totals.preference_sets.backfilled += c.preference_sets.backfilled;
      totals.preference_sets.switched += c.preference_sets.switched;
    }

    return {totals, communities};
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === 'production') throw new Error('Guild preference backfill cannot target production.');
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const status = args.includes('--status');
  if (status && (args.includes('--execute') || args.includes('--limit'))) {
    throw new Error('--status is read-only and cannot be combined with --execute or --limit.');
  }
  const databaseUrl = option('--database-url');
  if (!databaseUrl) throw new Error('Pass --database-url. This script does not read DATABASE_URL.');
  if (databaseUrl.includes('54339') || /\/freedom_local(\?|$)/.test(databaseUrl)) throw new Error('Refusing the shared local database.');
  const execute = args.includes('--execute');
  const limit = option('--limit');
  const communityArg = option('--community-id');
  const pool = createPool(databaseUrl);
  try {
    if (status) {
      console.log(JSON.stringify(await guildPreferenceStatus(pool, {communityId: option('--community-id')})));
    } else {
      const communities = (await pool.query('SELECT community_id FROM communities ORDER BY community_id')).rows as {community_id: string}[];
      const communityId = communityArg ?? (communities.length === 1 ? communities[0].community_id : undefined);
      if (!communityId) throw new Error('Pass --community-id when the database has more than one community.');
      const result = await backfillGuildPreferences(pool, {
        communityId,
        dryRun: !execute,
        limit: limit === undefined ? undefined : Number(limit),
      });
      console.log(JSON.stringify(result));
    }
  } finally {
    await pool.end();
  }
}
