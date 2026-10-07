import { createHash } from 'node:crypto';
import { readMigrationSources } from '../../../packages/db/migration-files.mjs';
import { migrationDigest, legacyMigrationProfile, resolveMigrationPlan } from '../../../packages/db/migration-plan.mjs';
export { migrationDigest } from '../../../packages/db/migration-plan.mjs';

// PlanetScale's default role (like other managed PostgreSQL admins) is NOSUPERUSER; these statements fail or need provider support.
const PRIVILEGED = [
  [/\bCREATE\s+EXTENSION\b/i, 'CREATE EXTENSION (verify against the provider extension list first)'],
  [/\bALTER\s+SYSTEM\b/i, 'ALTER SYSTEM (use provider cluster parameters instead)'],
  [/\b(CREATE|ALTER)\s+ROLE\b|\bCREATE\s+USER\b/i, 'role management inside a migration (roles are provisioned per environment, not migrated)'],
  [/\bSUPERUSER\b|\bBYPASSRLS\b|\bREPLICATION\b/i, 'superuser-class attribute'],
  [/\bCOPY\b[^;]*\b(FROM|TO)\s+PROGRAM\b/i, 'COPY ... PROGRAM'],
  [/\bLANGUAGE\s+(c|plpython3?u|plperlu)\b/i, 'untrusted procedural language'],
  [/\bpg_(read|write)_server_files\b|\bpg_execute_server_program\b|\blo_import\b/i, 'server file access'],
  [/\bCREATE\s+(EVENT\s+TRIGGER|TABLESPACE|DATABASE)\b/i, 'cluster-level object'],
  [/\bOWNER\s+TO\b/i, 'explicit OWNER TO (ownership must stay with the environment migrator role)'],
  [/\bSECURITY\s+DEFINER\b/i, 'SECURITY DEFINER function (review search_path and owner)'],
];

// Integration-reviewed source exception only, never installation/deployment
// authority. Any byte change requires a fresh review. All other privileged
// categories and every unlisted SECURITY DEFINER migration remain rejected.
const REVIEWED_DEFINER = Object.freeze({
  '105_operator_service_cover_backfill.sql': Object.freeze({
    sha256: 'e27f74e859485c264cadfd48d5841f0a35e32df3e47e53d115c260a49370814e',
    review: 'docs/development/operator-backfill-sql-review.md',
  }),
  '107_operator_event_video_backfill.sql': Object.freeze({
    sha256: '7afd5fa17f62d1827337ef3ee833fa42ec8d750aa622868b5c22a091f9bbdd11',
    review: 'docs/development/operator-backfill-sql-review.md',
  }),
  '109_banner_social_operator_backfill.sql': Object.freeze({
    sha256: '6df762d6de5dac13c93b42e070fde5de0c2af2612258c1a89ff8d678b33610a7',
    review: 'docs/development/operator-backfill-sql-review.md',
  }),
  '110_skill_highlight_operator_backfill.sql': Object.freeze({
    sha256: '30a7cfeb7488bede72c9da68e19689d555aee1e0ee4d7b9ab4cf151aee9cc46f',
    review: 'docs/development/operator-backfill-sql-review.md',
  }),
  '111_operator_avatar_backfill.sql': Object.freeze({
    sha256: '695a8c84ac8f7e9c7d7f4ab4049c87b0b32a0e0061a3edebd00801e2ae071c1a',
    review: 'docs/development/operator-backfill-sql-review.md',
  }),
});

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Third argument is a host-selected DAG profile. Manifests, env and candidate JSON cannot select it. */
export function checkMigrations(dir, expected, hostProfile) {
  const sources = readMigrationSources(dir), files = sources.map(e => e.name);
  const problems = [];
  let plan;
  const dag = hostProfile !== undefined;
  try { plan = resolveMigrationPlan(sources, dag ? hostProfile : legacyMigrationProfile(expected)); }
  catch (error) { problems.push(error.message); }
  const privileged = [], reviewedPrivileged = [];
  const entries = sources.map(({ name, sql }) => {
    const body = stripComments(sql);
    const sha256 = migrationDigest(sql);
    for (const [re, why] of PRIVILEGED) if (re.test(body)) {
      const reviewed = REVIEWED_DEFINER[name];
      if (why === 'SECURITY DEFINER function (review search_path and owner)' && reviewed?.sha256 === sha256) {
        reviewedPrivileged.push({ file: name, statement: why, sha256, review: reviewed.review });
      } else privileged.push({ file: name, statement: why });
    }
    return { name, sha256 };
  });
  const functionsAndTriggers = sources.filter(({ sql }) => /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)\b/i.test(stripComments(sql))).map(e => e.name);
  const result = {
    ok: problems.length === 0 && privileged.length === 0,
    count: files.length,
    first: files[0],
    last: files.at(-1),
    known_gaps: plan?.known_gaps ?? [],
    problems,
    privileged,
    reviewed_privileged: reviewedPrivileged,
    plpgsql_trigger_files: functionsAndTriggers,
    ledger: entries,
    ledger_digest: createHash('sha256').update(entries.map((e) => `${e.name}:${e.sha256}`).join('\n')).digest('hex'),
  };
  // Absent on the legacy path so existing scan objects stay byte-identical.
  if (dag) result.dependencies = plan ? plan.dependencies.map(({ name, depends_on }) => ({ name, depends_on: [...depends_on] })) : [];
  return result;
}
