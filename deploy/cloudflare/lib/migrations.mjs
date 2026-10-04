import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Same digest as packages/db digest(sql): sha256 over JSON.stringify of the SQL string. */
export function migrationDigest(sql) {
  return createHash('sha256').update(JSON.stringify(sql)).digest('hex');
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function checkMigrations(dir, expected) {
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  const numbers = files.map((f) => Number(/^(\d{3})_/.exec(f)?.[1] ?? NaN));
  const problems = [];
  if (numbers.some(Number.isNaN)) problems.push('migration file without NNN_ prefix');
  if (new Set(numbers).size !== numbers.length) problems.push('duplicate migration number');
  const gaps = [];
  for (let n = expected.first; n <= expected.last; n++) if (!numbers.includes(n)) gaps.push(n);
  const unexpectedGaps = gaps.filter((g) => !expected.known_gaps.includes(g));
  if (unexpectedGaps.length) problems.push(`unexpected gaps: ${unexpectedGaps.join(',')}`);
  if (Math.max(...numbers) !== expected.last) problems.push(`last migration is ${Math.max(...numbers)}, manifest expects ${expected.last}`);
  const privileged = [], reviewedPrivileged = [];
  const entries = files.map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
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
  const functionsAndTriggers = files.filter((name) => /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)\b/i.test(stripComments(readFileSync(join(dir, name), 'utf8'))));
  return {
    ok: problems.length === 0 && privileged.length === 0,
    count: files.length,
    first: files[0],
    last: files.at(-1),
    known_gaps: gaps.filter((g) => expected.known_gaps.includes(g)),
    problems,
    privileged,
    reviewed_privileged: reviewedPrivileged,
    plpgsql_trigger_files: functionsAndTriggers,
    ledger: entries,
    ledger_digest: createHash('sha256').update(entries.map((e) => `${e.name}:${e.sha256}`).join('\n')).digest('hex'),
  };
}
