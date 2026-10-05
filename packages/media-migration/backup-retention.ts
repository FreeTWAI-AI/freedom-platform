import { createHash } from 'node:crypto';
import { archiveRead, decodeRecoverySet, decodeReceipt, parseInstant, RECOVERY_MANIFEST_MAX_BYTES, RECOVERY_RECEIPT_MAX_BYTES,
  RECOVERY_SET_PREFIX, RecoveryArchiveError, type ArchiveStore } from './backup-archive.js';

/* Bounded retention PLAN for sealed recovery sets. It never deletes, releases
 * pins or contacts a database: it returns a deterministic, digest-bound plan an
 * operator reviews and executes separately. Invariants:
 *  - if any lineage lacks a freshly verified set, nothing is pruned (fail closed);
 *  - the latest freshly verified set and its source pins are always kept;
 *  - sets newer than it (pending verification), young sets, future-dated,
 *    incomplete, corrupt or ambiguous sets are kept or flagged, never pruned;
 *  - backup objects are pruned only when referenced exclusively by pruned sets
 *    and every set's references are known. */

export class RetentionError extends Error {
  constructor(readonly code: 'invalid_policy' | 'retention_scan_overflow' | 'archive_unavailable') {
    super(code); this.name = 'RetentionError';
  }
}
export interface RetentionPolicy {
  /** Freshly verified sets to keep, newest first. Minimum 1. */
  readonly keepVerified: number;
  /** No set younger than this is pruned, regardless of verification. */
  readonly minRetentionSeconds: number;
  /** A readback receipt older than this does not count as verified. */
  readonly maxReadbackAgeSeconds: number;
  /** Bound on distinct sets scanned; more fails the whole plan. */
  readonly maxSets: number;
}
export interface RecoveryLineage { readonly environment: string; readonly database: string; readonly schema: string }
export type RecoverySetState =
  | { readonly setId: string; readonly status: 'sealed'; readonly lineage: RecoveryLineage; readonly createdAt: string;
      readonly manifestSha256: string; readonly captureId: string; readonly objectKeys: readonly string[];
      readonly archiveKeys: readonly string[]; readonly lastVerifiedAt?: string; readonly anomalies: readonly string[] }
  | { readonly setId: string; readonly status: 'incomplete' | 'corrupt'; readonly archiveKeys: readonly string[]; readonly anomalies: readonly string[] };

export interface RetentionPlan {
  readonly format: 'freedom.recovery-retention-plan/v1';
  /** planned only when EVERY lineage (environment/database/schema) has its own fresh anchor. */
  readonly status: 'planned' | 'no_verified_recovery_set';
  readonly execution: 'not_run';
  readonly now: string;
  readonly policy: RetentionPolicy;
  /** One recovery anchor per lineage; a newer set of another lineage never supersedes it. */
  readonly lineages: readonly { lineage: string; latestVerified: string | null }[];
  /** Unrecognized keys under the archive prefix; any withholds object pruning. */
  readonly strayKeys: number;
  readonly keep: readonly { setId: string; reasons: readonly string[] }[];
  readonly prune: readonly { setId: string; lineage: string; manifestSha256: string; captureId: string; archiveKeys: readonly string[] }[];
  readonly inspect: readonly { setId: string; reasons: readonly string[] }[];
  readonly objectPrune: { readonly status: 'planned' | 'withheld'; readonly reason?: string;
    readonly precondition: 'backup_object_store_dedicated_to_this_archive'; readonly keys: readonly string[] };
  /** Source pins referenced ONLY by pruned sets. Withheld if any kept set's capture is unknown. */
  readonly captureRelease: { readonly status: 'planned' | 'withheld'; readonly reason?: string;
    readonly items: readonly { captureId: string; setIds: readonly string[] }[] };
  readonly planSha256: string;
}

const DAY = 86_400;
function checkPolicy(policy: RetentionPolicy): RetentionPolicy {
  const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
  if (!policy || !int(policy.keepVerified, 1, 366) || !int(policy.minRetentionSeconds, 0, 3650 * DAY)
    || !int(policy.maxReadbackAgeSeconds, 60, 366 * DAY) || !int(policy.maxSets, 1, 10_000)) throw new RetentionError('invalid_policy');
  return Object.freeze({ keepVerified: policy.keepVerified, minRetentionSeconds: policy.minRetentionSeconds,
    maxReadbackAgeSeconds: policy.maxReadbackAgeSeconds, maxSets: policy.maxSets });
}
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const LINEAGE_PART = /^[a-z_][a-z0-9_]{0,62}$/;
function lineageKey(l: RecoveryLineage): string {
  if (!l || ![l.environment, l.database, l.schema].every(v => typeof v === 'string' && LINEAGE_PART.test(v))) throw new RetentionError('invalid_policy');
  return `${l.environment}/${l.database}/${l.schema}`;
}

/** Pure planner over already-loaded set states. Each lineage is planned
 * independently; kept/pruned object and capture sets are computed globally. */
export function computeRetentionPlan(states: readonly RecoverySetState[], policyInput: RetentionPolicy, now: string,
  scan: { readonly strayKeys: number } = { strayKeys: 0 }): RetentionPlan {
  const policy = checkPolicy(policyInput);
  let nowMs: number;
  try { nowMs = parseInstant(now); } catch { throw new RetentionError('invalid_policy'); }
  if (!Array.isArray(states) || states.length > policy.maxSets) throw new RetentionError('retention_scan_overflow');
  const strayKeys = scan?.strayKeys;
  if (!Number.isSafeInteger(strayKeys) || strayKeys < 0) throw new RetentionError('invalid_policy');
  const ids = new Set<string>();
  for (const s of states) { if (ids.has(s.setId)) throw new RetentionError('invalid_policy'); ids.add(s.setId); }
  const keep = new Map<string, Set<string>>(), inspect = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, id: string, reason: string) => { if (!map.has(id)) map.set(id, new Set()); map.get(id)!.add(reason); };

  const sealed = states.filter((s): s is Extract<RecoverySetState, { status: 'sealed' }> => s.status === 'sealed');
  for (const s of states) {
    if (s.status !== 'sealed') { add(keep, s.setId, s.status); add(inspect, s.setId, s.status); }
    for (const a of s.anomalies) { add(keep, s.setId, 'anomaly'); add(inspect, s.setId, a); }
  }
  const createdMs = new Map(sealed.map(s => [s.setId, parseInstant(s.createdAt)]));
  const lineageOf = new Map(sealed.map(s => [s.setId, lineageKey(s.lineage)]));
  for (const s of sealed) {
    const c = createdMs.get(s.setId)!;
    if (c > nowMs) { add(keep, s.setId, 'future_created_at'); add(inspect, s.setId, 'future_created_at'); }
    if (nowMs - c < policy.minRetentionSeconds * 1000) add(keep, s.setId, 'within_min_retention');
  }
  const lineages: { lineage: string; latestVerified: string | null }[] = [];
  for (const lineage of [...new Set(lineageOf.values())].sort(byText)) {
    const members = sealed.filter(s => lineageOf.get(s.setId) === lineage);
    const fresh = members.filter(s => {
      // A set with any anomaly (e.g. a member missing after its readback) is never the recovery anchor.
      if (s.lastVerifiedAt === undefined || s.anomalies.length > 0) return false;
      const v = parseInstant(s.lastVerifiedAt);
      return v >= createdMs.get(s.setId)! && v <= nowMs && nowMs - v <= policy.maxReadbackAgeSeconds * 1000;
    }).sort((a, b) => (createdMs.get(b.setId)! - createdMs.get(a.setId)!) || byText(b.setId, a.setId));
    const latest = fresh[0];
    lineages.push({ lineage, latestVerified: latest?.setId ?? null });
    if (!latest) { for (const s of members) add(keep, s.setId, 'no_verified_recovery_set_in_lineage'); continue; }
    fresh.slice(0, policy.keepVerified).forEach((s, i) => add(keep, s.setId, i === 0 ? 'latest_verified' : 'verified_window'));
    const latestMs = createdMs.get(latest.setId)!;
    for (const s of members) if (s.setId !== latest.setId && createdMs.get(s.setId)! >= latestMs) add(keep, s.setId, 'newer_than_latest_verified');
  }
  const anchored = lineages.length > 0 && lineages.every(l => l.latestVerified !== null);
  if (!anchored) for (const s of states) add(keep, s.setId, 'no_verified_recovery_set');
  const prune = sealed.filter(s => !keep.has(s.setId)).sort((a, b) => byText(a.setId, b.setId));
  const kept = states.filter(s => keep.has(s.setId));
  const unknownKept = kept.some(s => s.status !== 'sealed');

  let objectPrune: RetentionPlan['objectPrune'];
  if (!anchored) {
    objectPrune = { status: 'withheld', reason: 'no_verified_recovery_set',
      precondition: 'backup_object_store_dedicated_to_this_archive', keys: [] };
  } else if (unknownKept || strayKeys > 0) {
    objectPrune = { status: 'withheld', reason: strayKeys > 0 ? 'unrecognized_archive_keys' : 'unknown_references_in_kept_set',
      precondition: 'backup_object_store_dedicated_to_this_archive', keys: [] };
  } else {
    const needed = new Set(kept.flatMap(s => (s.status === 'sealed' ? s.objectKeys : [])));
    const keys = [...new Set(prune.flatMap(s => s.objectKeys))].filter(k => !needed.has(k)).sort(byText);
    objectPrune = { status: 'planned', precondition: 'backup_object_store_dedicated_to_this_archive', keys };
  }
  // The same capture may back several sets (sealRecoverySet accepts one backup
  // under multiple setIds). A pin is releasable only if NO kept set uses it.
  let captureRelease: RetentionPlan['captureRelease'];
  if (!anchored) captureRelease = { status: 'withheld', reason: 'no_verified_recovery_set', items: [] };
  else if (unknownKept) captureRelease = { status: 'withheld', reason: 'unknown_capture_in_kept_set', items: [] };
  else {
    const keptCaptures = new Set(kept.flatMap(s => (s.status === 'sealed' ? [s.captureId] : [])));
    const grouped = new Map<string, string[]>();
    for (const s of prune) if (!keptCaptures.has(s.captureId)) { if (!grouped.has(s.captureId)) grouped.set(s.captureId, []); grouped.get(s.captureId)!.push(s.setId); }
    captureRelease = { status: 'planned', items: [...grouped.entries()].sort((a, b) => byText(a[0], b[0]))
      .map(([captureId, setIds]) => ({ captureId, setIds: setIds.sort(byText) })) };
  }
  const freeze = (m: Map<string, Set<string>>) => [...m.entries()].sort((a, b) => byText(a[0], b[0]))
    .map(([setId, r]) => ({ setId, reasons: [...r].sort(byText) }));
  const body = {
    format: 'freedom.recovery-retention-plan/v1' as const,
    status: anchored ? 'planned' as const : 'no_verified_recovery_set' as const,
    execution: 'not_run' as const, now, policy, lineages, strayKeys,
    keep: freeze(keep), prune: prune.map(s => ({ setId: s.setId, lineage: lineageOf.get(s.setId)!, manifestSha256: s.manifestSha256,
      captureId: s.captureId, archiveKeys: [...s.archiveKeys].sort(byText) })),
    inspect: freeze(inspect), objectPrune, captureRelease,
  };
  const planSha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return deepFreeze({ ...body, planSha256 });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
}

const SET_KEY = /^recovery-sets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(database\.dump|snapshot-evidence\.json|recovery-set\.json|readback\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$/;
const MAX_RECEIPTS_PER_SET = 64;

/** Loads every set's manifest and readback receipts (not dumps/objects) and
 * plans. Freshness relies on receipts written by readbackRecoverySet. */
export async function planRecoverySetRetention(archive: ArchiveStore, policyInput: RetentionPolicy, now: string): Promise<RetentionPlan> {
  const policy = checkPolicy(policyInput);
  let keys: readonly string[];
  try { keys = await archive.list(RECOVERY_SET_PREFIX, policy.maxSets * (3 + MAX_RECEIPTS_PER_SET)); }
  catch { throw new RetentionError('retention_scan_overflow'); }
  const grouped = new Map<string, string[]>();
  const strays: string[] = [];
  const SET_DIR = /^recovery-sets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;
  for (const key of keys) {
    const m = SET_KEY.exec(key);
    if (!m) {
      strays.push(key);
      // A set directory holding only unexpected keys must still be reported.
      const dir = SET_DIR.exec(key);
      if (dir && !grouped.has(dir[1])) grouped.set(dir[1], []);
      continue;
    }
    if (!grouped.has(m[1])) grouped.set(m[1], []);
    grouped.get(m[1])!.push(key);
  }
  if (grouped.size > policy.maxSets) throw new RetentionError('retention_scan_overflow');
  const states: RecoverySetState[] = [];
  for (const [setId, setKeys] of [...grouped.entries()].sort((a, b) => byText(a[0], b[0]))) {
    const anomalies: string[] = [];
    if (strays.some(k => k.startsWith(`${RECOVERY_SET_PREFIX}${setId}/`))) anomalies.push('unexpected_key');
    const manifestKey = `${RECOVERY_SET_PREFIX}${setId}/recovery-set.json`;
    if (!setKeys.includes(manifestKey)) { states.push({ setId, status: 'incomplete', archiveKeys: setKeys, anomalies }); continue; }
    let decoded;
    try {
      const bytes = await archiveRead.getBytes(archive, manifestKey, RECOVERY_MANIFEST_MAX_BYTES);
      if (bytes === null) { states.push({ setId, status: 'incomplete', archiveKeys: setKeys, anomalies }); continue; }
      decoded = decodeRecoverySet(bytes);
      if (decoded.body.setId !== setId) throw new RecoveryArchiveError('archive_corrupt');
    } catch (e) {
      if (e instanceof RecoveryArchiveError && e.code === 'archive_unavailable') throw new RetentionError('archive_unavailable');
      states.push({ setId, status: 'corrupt', archiveKeys: setKeys, anomalies }); continue;
    }
    const b = decoded.body;
    if (!setKeys.includes(b.dump.key) || (b.evidence.status === 'captured' && !setKeys.includes(b.evidence.key))) anomalies.push('missing_member');
    const receipts = setKeys.filter(k => k.includes('/readback/'));
    if (receipts.length > MAX_RECEIPTS_PER_SET) anomalies.push('receipt_overflow');
    let lastVerifiedAt: string | undefined;
    for (const key of receipts.slice(0, MAX_RECEIPTS_PER_SET)) {
      try {
        const bytes = await archiveRead.getBytes(archive, key, RECOVERY_RECEIPT_MAX_BYTES);
        if (bytes === null) continue;
        const r = decodeReceipt(bytes);
        if (r.setId !== setId || r.manifestSha256 !== decoded.manifestSha256 || r.dumpSha256 !== b.dump.sha256
          || r.objectCount !== b.objectCount || r.objectBytes !== b.objectBytes) { anomalies.push('receipt_mismatch'); continue; }
        if (lastVerifiedAt === undefined || r.verifiedAt > lastVerifiedAt) lastVerifiedAt = r.verifiedAt;
      } catch (e) {
        if (e instanceof RecoveryArchiveError && e.code === 'archive_unavailable') throw new RetentionError('archive_unavailable');
        anomalies.push('receipt_corrupt');
      }
    }
    states.push({ setId, status: 'sealed', lineage: { environment: b.environment, database: b.database, schema: b.schema }, createdAt: b.createdAt, manifestSha256: decoded.manifestSha256, captureId: b.consistency.captureId,
      objectKeys: b.objects.objects.map(o => o.key), archiveKeys: setKeys, anomalies: [...new Set(anomalies)],
      ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }) });
  }
  return computeRetentionPlan(states, policy, now, { strayKeys: strays.length });
}
