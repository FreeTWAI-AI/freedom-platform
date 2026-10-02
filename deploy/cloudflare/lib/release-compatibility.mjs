import { createHash } from 'node:crypto';

const REQUEST = 'freedom.release-compatibility-request/v1';
const HOST = 'freedom.release-compatibility-host/v2';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
const ENVIRONMENTS = ['next', 'staging-next'];
const CAPABILITIES = ['platform.legacy.v1', 'work.explicit-wire.v1', 'avatar.asset-bridge.v1', 'work.personal-owner-acl.v1', 'work.private-human-result.v1', 'work.server-policy.v1'];
const SHAPES = Object.freeze({
  'avatar.asset.v1': { migration: 80, capabilities: ['avatar.asset-bridge.v1'] },
  'work.private.v1': { migration: 81, capabilities: ['work.personal-owner-acl.v1'] },
  'work.private-human-result.v1': { migration: 84, capabilities: ['work.personal-owner-acl.v1', 'work.private-human-result.v1'] },
});
const FOUNDATION_NAMES = [
  '076_principal_resource_scopes.sql', '077_work_scope_privacy.sql', '078_scoped_member_commands.sql',
  '079_asset_upload_lifecycle.sql', '080_avatar_asset_bridge.sql', '081_private_work_commands.sql',
  '082_asset_maintenance.sql', '083_avatar_upload_policy.sql', '084_private_work_result_profiles.sql',
  '085_private_work_policy.sql',
];

function reject(code) { throw new Error(code); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) reject('invalid_data');
}
function text(value, pattern, length) {
  if (typeof value !== 'string' || (length !== undefined && value.length !== length) || pattern.exec(value)?.[0] !== value) reject('invalid_data');
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) reject('invalid_data');
}
function strings(value, allowed, max = 32) {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length || value.some((x) => typeof x !== 'string' || !allowed.includes(x))) reject('invalid_data');
}
// Do not invoke getters, toJSON, prototypes or candidate-provided functions.
function snapshot(value, limit = 512 * 1024) {
  let budget = limit;
  const seen = new Set();
  function copy(v, depth) {
    if (depth > 12 || --budget < 0) reject('invalid_data');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) reject('invalid_data'); return v; }
    if (typeof v === 'string') { budget -= Buffer.byteLength(v); if (budget < 0) reject('invalid_data'); return v; }
    if (!v || typeof v !== 'object' || seen.has(v)) reject('invalid_data');
    const array = Array.isArray(v);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) reject('invalid_data');
    seen.add(v);
    const out = array ? [] : Object.create(null);
    if (array && (v.length > 4096 || Object.keys(v).length !== v.length)) reject('invalid_data');
    for (const key of Reflect.ownKeys(v)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') reject('invalid_data');
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) reject('invalid_data');
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) reject('invalid_data');
      budget -= key.length;
      out[key] = copy(descriptor.value, depth + 1);
    }
    if (array && out.length !== v.length) reject('invalid_data');
    seen.delete(v);
    return out;
  }
  return copy(value, 0);
}
function identity(value) {
  exact(value, ['source_sha', 'artifact_sha256']);
  text(value.source_sha, HEX40, 40); text(value.artifact_sha256, HEX64, 64);
  return `${value.source_sha}:${value.artifact_sha256}`;
}
function target(value) {
  exact(value, ['environment', 'database_identity', 'recovery_generation']);
  if (!ENVIRONMENTS.includes(value.environment)) reject('invalid_data');
  text(value.database_identity, ID); text(value.recovery_generation, /^[1-9][0-9]{0,39}$/);
  return JSON.stringify([value.environment, value.database_identity, value.recovery_generation]);
}
export function compatibilityLedgerDigest(ledger) {
  return createHash('sha256').update(ledger.map((e) => `${e.name}:${e.sha256}`).join('\n')).digest('hex');
}
function ledger(value, digest) {
  if (!Array.isArray(value) || value.length < 74 || value.length > 256) reject('schema_ledger_invalid');
  text(digest, HEX64, 64);
  let previous = 0;
  for (const row of value) {
    exact(row, ['name', 'sha256']); text(row.name, /^[0-9]{3}_[a-z0-9_]+\.sql$/); text(row.sha256, HEX64, 64);
    const number = Number(row.name.slice(0, 3));
    if (number !== previous + (previous === 21 ? 2 : 1)) reject('schema_ledger_invalid');
    if (number >= 76 && FOUNDATION_NAMES[number - 76] !== row.name) reject('schema_unknown');
    previous = number;
  }
  if (previous < 75 || compatibilityLedgerDigest(value) !== digest) reject('schema_ledger_invalid');
  return previous;
}
function ledgerPrefix(prefix, complete) {
  return prefix.length <= complete.length && prefix.every((row, index) => row.name === complete[index].name && row.sha256 === complete[index].sha256);
}
function failReport(code, required = [], shapes = []) {
  return { schema: 'freedom.release-compatibility-report/v1', status: 'unavailable', deployment_authority: false, restore_proof: false, execution_authority: false, required_capabilities: [...required].sort(), required_shapes: [...shapes].sort(), checked_releases: 0, issues: [{ code }] };
}

/**
 * Local compatibility diagnostic, NOT a trust verifier or deployment permit.
 * `host` is a separately authenticated, fixed-host input. Never construct it
 * from candidate JSON or load a candidate-selected adapter. The caller owns
 * current release approval, complete observations and non-rollback watermarks.
 */
export function evaluateReleaseCompatibility(input, { scan, host } = {}) {
  let request, planned, plannedLast;
  const required = new Set(['platform.legacy.v1']);
  try {
    request = snapshot(input, 16384);
    exact(request, ['schema', 'environment', 'candidate', 'enable_shapes']);
    if (request.schema !== REQUEST || !ENVIRONMENTS.includes(request.environment)) reject('request_invalid');
    identity(request.candidate); strings(request.enable_shapes, Object.keys(SHAPES));
    planned = snapshot(scan);
    if (planned.ok !== true) reject('schema_scan_failed');
    plannedLast = ledger(planned.ledger, planned.ledger_digest);
    if (plannedLast >= 77) required.add('work.explicit-wire.v1');
    for (const shape of request.enable_shapes) {
      for (const capability of SHAPES[shape].capabilities) required.add(capability);
      if (plannedLast >= 85 && shape.startsWith('work.private')) required.add('work.server-policy.v1');
    }
  } catch (error) { return failReport(['schema_unknown', 'schema_ledger_invalid', 'schema_scan_failed'].includes(error.message) ? error.message : 'request_invalid', required); }
  if (!host) return failReport('trusted_host_required', required, request.enable_shapes);

  let trusted, observed, observedLast, floor, floorLast;
  try {
    trusted = snapshot(host);
    if (trusted?.schema !== HOST) reject('host_version_unsupported');
    if (!trusted.rollback_floor) reject('historical_floor_required');
    exact(trusted, ['schema', 'target', 'now_ms', 'max_age_ms', 'rollback_floor_shapes', 'rollback_floor', 'observation', 'release_records']);
    if (trusted.target.environment !== request.environment) reject('target_mismatch');
    const targetIdentity = target(trusted.target);
    integer(trusted.now_ms); integer(trusted.max_age_ms, 1, 300000);
    strings(trusted.rollback_floor_shapes, Object.keys(SHAPES));
    // This independently retained floor is a HOST assertion, not a collector,
    // durable checkpoint or proof that host state cannot itself be rolled back.
    floor = trusted.rollback_floor;
    exact(floor, ['evidence_id', 'target', 'schema_ledger', 'schema_ledger_digest', 'capabilities']);
    text(floor.evidence_id, ID); target(floor.target);
    if (floor.target.environment !== trusted.target.environment || floor.target.database_identity !== trusted.target.database_identity) reject('historical_target_mismatch');
    if (BigInt(floor.target.recovery_generation) > BigInt(trusted.target.recovery_generation)) reject('historical_recovery_regression');
    floorLast = ledger(floor.schema_ledger, floor.schema_ledger_digest);
    strings(floor.capabilities, CAPABILITIES);
    observed = trusted.observation;
    exact(observed, ['evidence_id', 'observed_at_ms', 'target', 'schema_ledger', 'schema_ledger_digest', 'enabled_shapes', 'written_shapes', 'active_releases', 'complete']);
    text(observed.evidence_id, ID); integer(observed.observed_at_ms);
    if (target(observed.target) !== targetIdentity) reject('target_mismatch');
    if (observed.observed_at_ms > trusted.now_ms || trusted.now_ms - observed.observed_at_ms > trusted.max_age_ms) reject('observation_stale');
    if (observed.complete !== true || !Array.isArray(observed.active_releases) || observed.active_releases.length < 1 || observed.active_releases.length > 32) reject('observation_incomplete');
    const identities = observed.active_releases.map(identity);
    if (new Set(identities).size !== identities.length) reject('observation_incomplete');
    strings(observed.enabled_shapes, Object.keys(SHAPES)); strings(observed.written_shapes, Object.keys(SHAPES));
    observedLast = ledger(observed.schema_ledger, observed.schema_ledger_digest);
    if (!ledgerPrefix(observed.schema_ledger, planned.ledger)) reject('schema_ledger_mismatch');
    if (!Array.isArray(trusted.release_records) || trusted.release_records.length < 1 || trusted.release_records.length > 64) reject('release_evidence_invalid');
    const records = new Set();
    for (const record of trusted.release_records) {
      exact(record, ['source_sha', 'artifact_sha256', 'evidence_id', 'status', 'environments', 'schema_ledger_digests', 'capabilities', 'approved_at_ms', 'expires_at_ms']);
      const id = identity({ source_sha: record.source_sha, artifact_sha256: record.artifact_sha256 });
      if (records.has(id)) reject('release_evidence_invalid');
      records.add(id); text(record.evidence_id, ID);
      if (!['approved', 'withdrawn'].includes(record.status)) reject('release_evidence_invalid');
      strings(record.environments, ENVIRONMENTS); strings(record.capabilities, CAPABILITIES);
      if (!Array.isArray(record.schema_ledger_digests) || record.schema_ledger_digests.length < 1 || record.schema_ledger_digests.length > 32 || new Set(record.schema_ledger_digests).size !== record.schema_ledger_digests.length) reject('release_evidence_invalid');
      for (const digest of record.schema_ledger_digests) text(digest, HEX64, 64);
      integer(record.approved_at_ms); integer(record.expires_at_ms);
      if (record.expires_at_ms <= record.approved_at_ms) reject('release_evidence_invalid');
    }
  } catch (error) {
    const codes = ['host_version_unsupported', 'historical_floor_required', 'historical_target_mismatch', 'historical_recovery_regression',
      'target_mismatch', 'observation_stale', 'observation_incomplete', 'schema_unknown', 'schema_ledger_invalid', 'schema_ledger_mismatch', 'release_evidence_invalid'];
    return failReport(codes.includes(error.message) ? error.message : 'host_evidence_invalid', required, request.enable_shapes);
  }

  const shapes = new Set([...trusted.rollback_floor_shapes, ...observed.enabled_shapes, ...observed.written_shapes, ...request.enable_shapes]);
  const issues = [];
  const issue = (code, extra = {}) => issues.push({ code, ...extra });
  if (!ledgerPrefix(floor.schema_ledger, observed.schema_ledger) || !ledgerPrefix(floor.schema_ledger, planned.ledger)) issue('historical_schema_floor_mismatch');
  for (const capability of floor.capabilities) required.add(capability);
  if (floorLast >= 77) required.add('work.explicit-wire.v1');
  for (const shape of shapes) {
    const profile = SHAPES[shape];
    if (plannedLast < profile.migration) issue('shape_schema_missing', { shape });
    if ([...observed.enabled_shapes, ...observed.written_shapes].includes(shape) && observedLast < profile.migration) issue('observed_shape_schema_missing', { shape });
    for (const capability of profile.capabilities) required.add(capability);
    if (Math.max(plannedLast, floorLast) >= 85 && shape.startsWith('work.private')) required.add('work.server-policy.v1');
  }
  const releases = new Map([...observed.active_releases, request.candidate].map((release) => [identity(release), release]));
  for (const [id, release] of releases) {
    const record = trusted.release_records.find((r) => `${r.source_sha}:${r.artifact_sha256}` === id);
    const ref = { source_sha: release.source_sha, artifact_sha256: release.artifact_sha256 };
    if (!record) { issue('release_approval_missing', ref); continue; }
    if (record.status !== 'approved') issue('release_withdrawn', ref);
    if (record.approved_at_ms > trusted.now_ms || record.expires_at_ms <= trusted.now_ms) issue('release_approval_stale', ref);
    if (!record.environments.includes(request.environment)) issue('release_environment_mismatch', ref);
    for (const digest of new Set([observed.schema_ledger_digest, planned.ledger_digest])) {
      if (!record.schema_ledger_digests.includes(digest)) issue('release_schema_unsupported', ref);
    }
    for (const capability of required) if (!record.capabilities.includes(capability)) issue('release_capability_missing', { ...ref, capability });
  }
  return {
    schema: 'freedom.release-compatibility-report/v1', status: issues.length ? 'incompatible' : 'compatible',
    deployment_authority: false, restore_proof: false, execution_authority: false,
    required_capabilities: [...required].sort(), required_shapes: [...shapes].sort(),
    checked_releases: releases.size, issues,
  };
}
