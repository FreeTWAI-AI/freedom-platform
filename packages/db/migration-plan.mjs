import { createHash } from 'node:crypto';

export const LEGACY_MIGRATIONS = 'freedom.migrations/legacy-v1';
export const DAG_MIGRATIONS = 'freedom.migrations/dag-v2';
export const MIGRATION_LIMITS = Object.freeze({ files: 4096, fileBytes: 4194304, totalBytes: 67108864, metadataBytes: 16384, dependencies: 64 });
const LEGACY_NAME = /^[0-9]{3}_[a-z0-9_]+\.sql$(?![\s\S])/;
const DAG_NAME = /^v2_(\d{8}T\d{9}Z)_([0-9a-f]{16})_([a-z][a-z0-9_]{0,63})\.sql$/;
const HEX = /^[0-9a-f]{64}$/;
const HEADER = '-- freedom-migration: ';
// Compatibility fence for an old runner executing every *.sql. This is NOT
// authorization: the migrator already owns DDL and can set custom settings.
export const MIGRATION_V2_GUARD = "DO $freedom_migration_v2$ BEGIN\n  IF current_setting('freedom.migration_protocol', true) IS DISTINCT FROM 'freedom.migrations/dag-v2' THEN\n    RAISE EXCEPTION 'migration_runner_v2_required';\n  END IF;\nEND $freedom_migration_v2$;\n";

export class MigrationPlanError extends Error {
  constructor(code, detail = code) { super(detail); this.name = 'MigrationPlanError'; this.code = code; }
}
function fail(code, detail) { throw new MigrationPlanError(code, detail); }
function exact(value, keys, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).sort().join('|') !== [...keys].sort().join('|')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value'))) fail(code);
}
function boundedArray(value, limit, code) {
  if (!Array.isArray(value) || value.length > limit || Object.keys(value).length !== value.length) fail(code);
}
export function migrationDigest(sql) {
  // Historical packages/db digest(string), not a raw SQL byte hash.
  return createHash('sha256').update(JSON.stringify(sql)).digest('hex');
}
export function migrationLedgerDigest(ledger) {
  return createHash('sha256').update(ledger.map(e => `${e.name}:${e.sha256}`).join('\n')).digest('hex');
}
export function legacyMigrationProfile(expected) {
  // Existing manifests may also contain ledger_table. No manifest option can
  // opt the repository runner/scanner into DAG mode in this preparatory packet.
  if (!expected || (expected.format !== undefined && expected.format !== LEGACY_MIGRATIONS)) fail('migration_profile_unsupported');
  const profile = { format: LEGACY_MIGRATIONS, first: expected.first, last: expected.last, known_gaps: [...(expected.known_gaps ?? [])] };
  validateLegacy(profile); return profile;
}
function validateLegacy(profile) {
  exact(profile, ['format', 'first', 'last', 'known_gaps'], 'migration_profile_invalid');
  if (profile.format !== LEGACY_MIGRATIONS || !Number.isInteger(profile.first) || !Number.isInteger(profile.last)
    || profile.first < 1 || profile.last > 999 || profile.last < profile.first) fail('migration_profile_invalid');
  boundedArray(profile.known_gaps, 999, 'migration_profile_invalid');
  if (new Set(profile.known_gaps).size !== profile.known_gaps.length || profile.known_gaps.some(n => !Number.isInteger(n) || n < profile.first || n > profile.last)) fail('migration_profile_invalid');
}
function dagIdentity(name) {
  const match = DAG_NAME.exec(name); if (!match || match[0] !== name) return null;
  const s = match[1], iso = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}.${s.slice(15,18)}Z`;
  const date = new Date(iso); if (!Number.isFinite(date.valueOf()) || date.toISOString() !== iso) return null;
  return `${match[1]}_${match[2]}`;
}
function metadata(sql) {
  const end = sql.indexOf('\n');
  if (!sql.startsWith(HEADER) || end < 0 || Buffer.byteLength(sql.slice(0, end)) > MIGRATION_LIMITS.metadataBytes) fail('migration_metadata_invalid');
  let value; try { value = JSON.parse(sql.slice(HEADER.length, end)); } catch { fail('migration_metadata_invalid'); }
  exact(value, ['format', 'depends_on'], 'migration_metadata_invalid');
  // Exact canonical JSON also rejects duplicate JSON keys and alternate forms.
  if (value.format !== DAG_MIGRATIONS || sql.slice(HEADER.length, end) !== JSON.stringify(value)) fail('migration_metadata_invalid');
  boundedArray(value.depends_on, MIGRATION_LIMITS.dependencies, 'migration_dependencies_invalid');
  if (!value.depends_on.length || value.depends_on.some(n => typeof n !== 'string')
    || new Set(value.depends_on).size !== value.depends_on.length) fail('migration_dependencies_invalid');
  if (!sql.slice(end + 1).startsWith(MIGRATION_V2_GUARD)) fail('migration_runner_guard_missing');
  return [...value.depends_on];
}
function rows(value, code) {
  boundedArray(value, MIGRATION_LIMITS.files, code); const found = new Map();
  for (const row of value) {
    exact(row, ['name', 'sha256'], code);
    if (typeof row.name !== 'string' || row.name.length > 128 || !(LEGACY_NAME.test(row.name) || dagIdentity(row.name)) || typeof row.sha256 !== 'string' || row.sha256.length !== 64 || !HEX.test(row.sha256) || found.has(row.name)) fail(code);
    found.set(row.name, row.sha256);
  }
  return found;
}

/** Pure bounded planner. DAG profile/frontier comes from the host, never SQL.
 * It proves declared dependencies, not that arbitrary SQL operations commute. */
export function resolveMigrationPlan(sources, profile, applied = []) {
  boundedArray(sources, MIGRATION_LIMITS.files, 'migration_catalog_limit');
  const dag = profile?.format === DAG_MIGRATIONS;
  if (dag) exact(profile, ['format', 'legacy', 'legacy_ledger'], 'migration_profile_invalid');
  else if (profile?.format !== LEGACY_MIGRATIONS) fail('migration_profile_unsupported');
  const legacy = dag ? profile.legacy : profile; validateLegacy(legacy);
  const entries = [], names = new Set(), identities = new Set(); let bytes = 0;
  for (const source of sources) {
    exact(source, ['name', 'sql'], 'migration_source_invalid');
    const { name, sql } = source;
    if (typeof name !== 'string' || name.length > 128 || typeof sql !== 'string' || !sql.isWellFormed() || sql.includes('\0')) fail('migration_source_invalid');
    const size = Buffer.byteLength(sql);
    if (size > MIGRATION_LIMITS.fileBytes || (bytes += size) > MIGRATION_LIMITS.totalBytes) fail('migration_catalog_limit');
    if (names.has(name)) fail('migration_duplicate_name'); names.add(name);
    const isLegacy = LEGACY_NAME.test(name), identity = isLegacy ? null : dagIdentity(name);
    if (!isLegacy && !identity) fail('migration_name_invalid', 'migration file without valid NNN_ or v2 identity');
    if (!isLegacy && !dag) fail('migration_v2_not_activated');
    if (identity && identities.has(identity)) fail('migration_duplicate_identity'); if (identity) identities.add(identity);
    entries.push({ name, sql, sha256: migrationDigest(sql), legacy: isLegacy, depends_on: isLegacy ? [] : metadata(sql) });
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const old = entries.filter(e => e.legacy), numbers = old.map(e => Number(e.name.slice(0, 3)));
  if (new Set(numbers).size !== numbers.length) fail('migration_duplicate_number', 'duplicate migration number');
  const gaps = [];
  for (let n = legacy.first; n <= legacy.last; n++) if (!numbers.includes(n) && !legacy.known_gaps.includes(n)) gaps.push(n);
  if (gaps.length) fail('migration_legacy_gap', `unexpected gaps: ${gaps.join(',')}`);
  if (!old.length || numbers.some(n => n < legacy.first || n > legacy.last || legacy.known_gaps.includes(n)) || numbers.at(-1) !== legacy.last) fail('migration_legacy_frontier_mismatch');
  for (let i = 1; i < old.length; i++) old[i].depends_on = [old[i - 1].name];
  if (dag) {
    const frontier = rows(profile.legacy_ledger, 'migration_frontier_invalid');
    if (frontier.size !== old.length || old.some(e => frontier.get(e.name) !== e.sha256)) fail('migration_frontier_mismatch');
  }
  const byName = new Map(entries.map(e => [e.name, e])), indegree = new Map(), dependents = new Map();
  for (const e of entries) {
    indegree.set(e.name, e.depends_on.length);
    for (const dependency of e.depends_on) {
      if (dependency === e.name) fail('migration_self_dependency');
      if (!byName.has(dependency)) fail('migration_dependency_missing');
      const list = dependents.get(dependency) ?? []; list.push(e.name); dependents.set(dependency, list);
    }
  }
  const ready = entries.filter(e => !indegree.get(e.name)).map(e => e.name).sort(), order = [], reachesFrontier = new Set([old.at(-1).name]);
  while (ready.length) {
    const name = ready.shift(), e = byName.get(name); order.push(name);
    if (e.depends_on.some(n => reachesFrontier.has(n))) reachesFrontier.add(name);
    for (const dependent of dependents.get(name) ?? []) {
      const next = indegree.get(dependent) - 1; indegree.set(dependent, next);
      if (!next) { ready.push(dependent); ready.sort(); }
    }
  }
  if (order.length !== entries.length) fail('migration_dependency_cycle');
  if (entries.some(e => !e.legacy && !reachesFrontier.has(e.name))) fail('migration_frontier_dependency_missing');
  const prior = rows(applied, 'migration_applied_ledger_invalid');
  for (const [name, hash] of prior) {
    const e = byName.get(name); if (!e) fail('migration_applied_unknown');
    if (e.sha256 !== hash) fail('migration_applied_digest_mismatch', `Applied migration changed: ${name}`);
    if (e.depends_on.some(n => !prior.has(n))) fail('migration_applied_dependency_missing');
  }
  const ledger = entries.map(({ name, sha256 }) => Object.freeze({ name, sha256 }));
  const dependencies = entries.map(({ name, depends_on }) => Object.freeze({ name, depends_on: Object.freeze([...depends_on]) }));
  const identity = { format: 'freedom.migration-plan/v1', profile: profile.format, ledger, dependencies, execution_order: order };
  return Object.freeze({ ...identity, ledger: Object.freeze(ledger), dependencies: Object.freeze(dependencies),
    execution_order: Object.freeze(order), pending: Object.freeze(order.filter(n => !prior.has(n))),
    ledger_digest: migrationLedgerDigest(ledger), plan_digest: migrationDigest(identity),
    known_gaps: Object.freeze([...legacy.known_gaps]), sql: Object.freeze(Object.fromEntries(entries.map(e => [e.name, e.sql]))) });
}
