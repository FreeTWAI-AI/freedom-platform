import { createHash } from 'node:crypto';

const REQUEST = 'freedom.release-compatibility-request/v1';
const HOST = 'freedom.release-compatibility-host/v2';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
const ENVIRONMENTS = ['next', 'staging-next'];
const CAPABILITIES = ['commerce.shop-service-authority.v1', 'execution.model-credential-preparation.v1', 'execution.openrouter-selection.v1', 'platform.legacy.v1', 'work.explicit-wire.v1', 'avatar.asset-bridge.v1', 'avatar.legacy-bytes.v1', 'work.personal-owner-acl.v1', 'work.private-human-result.v1', 'work.server-policy.v1', 'execution.member-run-record.v1', 'execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.device-authorization.v1', 'execution.bootstrap-session.v1', 'execution.member-prerequisites.v1', 'execution.model-text-step.v1', 'work.private-model-result.v1', 'execution.model-credential-custody.v1', 'execution.model-broker-bridge.v1', 'execution.model-credential-ingest.v1', 'execution.member-model-settings.v1', 'execution.member-device-management.v1', 'media.server-policy.v1', 'media.service-cover.asset.v1', 'media.event-banner.asset.v1', 'media.event-video.asset.v1', 'media.social-thumbnail.asset.v1', 'media.skill-image.asset.v1', 'media.event-highlight.asset.v1', 'media.social-preview-create.v1', 'media.write-effects.v1', 'media.domain-gc.v1'];
const SHAPES = Object.freeze({
  // Durable service/site identity, bound keys and site command facts. This
  // reader floor never chooses legacy policy, rotates keys or grants access.
  'commerce.shop-service-authority.v1': { migration: 118, capabilities: ['commerce.shop-service-authority.v1'] },
  // Durable deadlines and namespaced selections remain required after disabling
  // creation. These are reader/writer compatibility, never provider authority.
  'execution.model-credential-preparation.v1': { migration: 114, capabilities: ['execution.model-credential-preparation.v1', 'execution.model-credential-ingest.v1', 'execution.model-credential-custody.v1'] },
  'execution.openrouter-selection.v1': { migration: 115, capabilities: ['execution.openrouter-selection.v1', 'execution.member-prerequisites.v1'] },
  // A creation bit cannot fence a mixed older writer. Every retained/active
  // consumer needs the instrumented write path before domain GC is enabled.
  'media.domain-gc.v1': { migration: 108, capabilities: ['media.domain-gc.v1', 'media.write-effects.v1', 'media.server-policy.v1'] },
  // Current canonical persistence policy and original domain ACL are mandatory.
  // Compatibility never grants persistence, cutover, cloud readiness or restore.
  'media.social-preview-create.v1': { migration: 106, capabilities: ['media.social-preview-create.v1', 'media.social-thumbnail.asset.v1', 'media.server-policy.v1'] },
  'media.social-thumbnail.asset.v1': { migration: 102, capabilities: ['media.social-thumbnail.asset.v1', 'media.server-policy.v1'] },
  'media.event-highlight.asset.v1': { migration: 104, capabilities: ['media.event-highlight.asset.v1', 'media.server-policy.v1'] },
  'media.skill-image.asset.v1': { migration: 103, capabilities: ['media.skill-image.asset.v1', 'media.server-policy.v1'] },
  'media.service-cover.asset.v1': { migration: 100, capabilities: ['media.service-cover.asset.v1', 'media.server-policy.v1'] },
  'media.event-banner.asset.v1': { migration: 100, capabilities: ['media.event-banner.asset.v1', 'media.server-policy.v1'] },
  'media.event-video.asset.v1': { migration: 101, capabilities: ['media.event-video.asset.v1', 'media.server-policy.v1'] },
  // Installed member inspect/decide/read/revoke plus bootstrap HTTP compatibility,
  // never machine execution authority or model/credential support.
  'execution.member-device-management.v1': { migration: 91, capabilities: ['execution.member-device-management.v1', 'execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.device-authorization.v1', 'execution.bootstrap-session.v1'] },
  // Owner metadata API compatibility only. Offline history needs no ingestion,
  // reference bridge, provider availability or operational text-step support.
  'execution.member-model-settings.v1': { migration: 95, capabilities: ['execution.member-model-settings.v1', 'execution.model-credential-custody.v1'] },
  // Safe setup/custody metadata only; no capture readiness, provider validation or release authority.
  'execution.model-credential-ingest.v1': { migration: 97, capabilities: ['execution.model-credential-ingest.v1', 'execution.model-credential-custody.v1'] },
  // Reference transport compatibility never substitutes for current SQL or
  // opaque host proof, and grants no credential/provider/deployment authority.
  'execution.model-broker-bridge.v1': { migration: 96, capabilities: ['execution.model-broker-bridge.v1', 'execution.model-credential-custody.v1', 'execution.model-text-step.v1', 'work.private-model-result.v1'] },
  // Encrypted custody compatibility only; no provider readiness or dispatch.
  'execution.model-credential-custody.v1': { migration: 95, capabilities: ['execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.bootstrap-session.v1', 'execution.member-prerequisites.v1', 'execution.model-credential-custody.v1'] },
  // Historical byte-preserving avatars carry a profile/transform absent from old readers.
  'avatar.legacy-bytes.v1': { migration: 111, capabilities: ['avatar.legacy-bytes.v1', 'avatar.asset-bridge.v1'] },
  'avatar.asset.v1': { migration: 80, capabilities: ['avatar.asset-bridge.v1'] },
  'work.private.v1': { migration: 81, capabilities: ['work.personal-owner-acl.v1'] },
  'work.private-human-result.v1': { migration: 84, capabilities: ['work.personal-owner-acl.v1', 'work.private-human-result.v1'] },
  // Closed member metadata/control only, never Attempt/Grant/dispatch authority.
  'execution.member-run-record.v1': { migration: 86, capabilities: ['work.personal-owner-acl.v1', 'work.server-policy.v1', 'execution.member-run-record.v1'] },
  'execution.runtime-enrollment.v1': { migration: 87, capabilities: ['execution.runtime-enrollment.v1'] },
  'execution.agent-connection-record.v1': { migration: 88, capabilities: ['execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1'] },
  'execution.bootstrap-status.v1': { migration: 89, capabilities: ['execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1'] },
  'execution.device-authorization.v1': { migration: 90, capabilities: ['execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.device-authorization.v1'] },
  'execution.bootstrap-session.v1': { migration: 91, capabilities: ['execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.bootstrap-session.v1'] },
  // Member selection/consent and immutable blocked history, never execution.
  'execution.member-prerequisites.v1': { migration: 92, capabilities: ['work.personal-owner-acl.v1', 'work.server-policy.v1', 'execution.member-run-record.v1', 'execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.bootstrap-session.v1', 'execution.member-prerequisites.v1'] },
  // One-use operational text profile is separately represented. Schema or
  // binary compatibility cannot authorize an export, call, lease or release.
  'execution.model-text-step.v1': { migration: 93, capabilities: ['work.personal-owner-acl.v1', 'work.server-policy.v1', 'execution.member-run-record.v1', 'execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.bootstrap-session.v1', 'execution.member-prerequisites.v1', 'execution.model-text-step.v1'] },
  'work.private-model-result.v1': { migration: 94, capabilities: ['work.personal-owner-acl.v1', 'work.server-policy.v1', 'work.private-human-result.v1', 'execution.member-run-record.v1', 'execution.runtime-enrollment.v1', 'execution.agent-connection-record.v1', 'execution.bootstrap-status.v1', 'execution.bootstrap-session.v1', 'execution.member-prerequisites.v1', 'execution.model-text-step.v1', 'work.private-model-result.v1'] },
});
const FOUNDATION_NAMES = [
  '076_principal_resource_scopes.sql', '077_work_scope_privacy.sql', '078_scoped_member_commands.sql',
  '079_asset_upload_lifecycle.sql', '080_avatar_asset_bridge.sql', '081_private_work_commands.sql',
  '082_asset_maintenance.sql', '083_avatar_upload_policy.sql', '084_private_work_result_profiles.sql',
  '085_private_work_policy.sql', '086_execution_runs.sql', '087_runtime_registrations.sql', '088_agent_connections.sql', '089_bootstrap_nonces.sql', '090_device_authorizations.sql', '091_bootstrap_sessions.sql', '092_execution_prerequisites.sql', '093_export_model_steps.sql', '094_private_model_results.sql', '095_credential_vault.sql', '096_model_broker_authorizations.sql', '097_credential_ingest_authorizations.sql',
  '098_domain_media_asset_profiles.sql', '099_community_event_banner_assets.sql',
  '100_domain_media_persistence_policy.sql', '101_community_event_video_assets.sql',
  '102_community_social_thumbnail_assets.sql', '103_skill_submission_image_assets.sql',
  '104_community_event_highlight_asset_pairs.sql',
  '105_operator_service_cover_backfill.sql', '106_social_preview_asset_creation.sql',
  '107_operator_event_video_backfill.sql', '108_domain_media_gc_write_effects.sql',
  '109_banner_social_operator_backfill.sql', '110_skill_highlight_operator_backfill.sql',
  '111_operator_avatar_backfill.sql',
  // Additive member-card/chat integration only. Exact ledger digests and all
  // independently supplied host approvals remain mandatory; no new authority.
  '112_member_card_editorial.sql', '113_chat_stickers_replies.sql',
  // Preparation deadline and explicit OpenRouter admission. Schema recognition
  // never supplies provider readiness, execution or release approval.
  '114_credential_ingest_preparations.sql', '115_openrouter_byok.sql',
  // SQL media writer fence only; does not activate R2-only or retire legacy bytes.
  '116_social_thumbnail_writer_floor.sql',
  // Closed machine admission records; recognition does not activate execution.
  '117_machine_text_execution.sql',
  '118_shop_service_identity.sql',
  '119_tenant_workspaces.sql',
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
    strings(floor.capabilities, CAPABILITIES, CAPABILITIES.length);
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
      strings(record.environments, ENVIRONMENTS); strings(record.capabilities, CAPABILITIES, CAPABILITIES.length);
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
    if (trusted.rollback_floor_shapes.includes(shape) && observedLast < profile.migration) issue('historical_shape_schema_missing', { shape });
    for (const capability of profile.capabilities) required.add(capability);
    if (Math.max(plannedLast, floorLast) >= 85 && shape.startsWith('work.private')) required.add('work.server-policy.v1');
  }
  // Retained capability-only requirements keep their reviewed prerequisites,
  // even when current shapes are empty. Do not infer written shapes from a
  // binary capability, or silently add support to any release approval.
  // 114 requires a persisted preparation before every new ingest submission;
  // generic pre-114 ingest support cannot satisfy the changed writer contract.
  if (Math.max(plannedLast, floorLast) >= 114 && required.has('execution.model-credential-ingest.v1')) required.add('execution.model-credential-preparation.v1');
  for (const shape of ['execution.model-credential-preparation.v1', 'execution.openrouter-selection.v1', 'avatar.legacy-bytes.v1', 'media.service-cover.asset.v1', 'media.event-banner.asset.v1', 'media.event-video.asset.v1', 'media.social-thumbnail.asset.v1', 'media.skill-image.asset.v1', 'media.event-highlight.asset.v1', 'media.social-preview-create.v1', 'media.domain-gc.v1']) {
    if (!required.has(shape)) continue;
    for (const capability of SHAPES[shape].capabilities) required.add(capability);
    if (floor.capabilities.includes(shape)) {
      if (plannedLast < SHAPES[shape].migration) issue('shape_schema_missing', { shape });
      if (observedLast < SHAPES[shape].migration) issue('historical_shape_schema_missing', { shape });
    }
  }
  if (floor.capabilities.includes('media.write-effects.v1')) {
    if (plannedLast < 108) issue('shape_schema_missing', { shape: 'media.write-effects.v1' });
    if (observedLast < 108) issue('historical_shape_schema_missing', { shape: 'media.write-effects.v1' });
  }
  if (floor.capabilities.includes('media.server-policy.v1')) {
    if (plannedLast < 100) issue('shape_schema_missing', { shape: 'media.server-policy.v1' });
    if (observedLast < 100) issue('historical_shape_schema_missing', { shape: 'media.server-policy.v1' });
  }
  if (required.has('execution.member-device-management.v1')) {
    required.add('execution.device-authorization.v1');
    required.add('execution.bootstrap-session.v1');
    // Capability-only retained history cannot be satisfied by a future ledger.
    if (floor.capabilities.includes('execution.member-device-management.v1')) {
      if (plannedLast < 91) issue('shape_schema_missing', { shape: 'execution.member-device-management.v1' });
      if (observedLast < 91) issue('historical_shape_schema_missing', { shape: 'execution.member-device-management.v1' });
    }
  }
  if (required.has('execution.member-model-settings.v1')) required.add('execution.model-credential-custody.v1');
  if (required.has('execution.model-credential-ingest.v1')) required.add('execution.model-credential-custody.v1');
  if (required.has('execution.model-broker-bridge.v1')) {
    required.add('execution.model-credential-custody.v1');
    required.add('execution.model-text-step.v1');
    required.add('work.private-model-result.v1');
  }
  if (required.has('work.private-model-result.v1')) {
    required.add('work.private-human-result.v1');
    required.add('execution.model-text-step.v1');
  }
  if (required.has('execution.model-credential-custody.v1')) required.add('execution.member-prerequisites.v1');
  if (required.has('execution.model-text-step.v1')) required.add('execution.member-prerequisites.v1');
  if (required.has('work.private-human-result.v1')) {
    required.add('work.personal-owner-acl.v1');
    if (Math.max(plannedLast, floorLast) >= 85) required.add('work.server-policy.v1');
  }
  if (required.has('execution.member-prerequisites.v1')) {
    required.add('execution.member-run-record.v1');
    required.add('execution.bootstrap-session.v1');
  }
  if (required.has('execution.member-run-record.v1')) {
    required.add('work.personal-owner-acl.v1');
    required.add('work.server-policy.v1');
  }
  if (required.has('execution.device-authorization.v1')) required.add('execution.bootstrap-status.v1');
  // 091 makes a family mandatory in every newly consumed device exchange.
  // An old device writer cannot claim support merely by knowing the 090 shape.
  if (Math.max(plannedLast, floorLast) >= 91 && required.has('execution.device-authorization.v1')) required.add('execution.bootstrap-session.v1');
  if (required.has('execution.bootstrap-session.v1')) required.add('execution.bootstrap-status.v1');
  if (required.has('execution.bootstrap-status.v1')) required.add('execution.agent-connection-record.v1');
  if (required.has('execution.agent-connection-record.v1')) required.add('execution.runtime-enrollment.v1');
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
