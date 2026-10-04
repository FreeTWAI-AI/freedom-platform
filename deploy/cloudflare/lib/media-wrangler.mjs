import { lstatSync, readFileSync } from 'node:fs';
import { checkWranglerConfig, parseJsonc } from './wrangler.mjs';
import { validateManifest } from './manifest.mjs';

// Installation mapping only: formats, quotas, ACL and persistence authority
// remain in the existing Asset profiles and canonical PostgreSQL policy.
const feature = (purpose, flag, capabilities, images = true) => Object.freeze({
  purpose, flag, required_bindings: Object.freeze(images ? ['MEDIA', 'IMAGES'] : ['MEDIA']),
  required_capabilities: Object.freeze(capabilities),
});
export const MEDIA_WORKER_FEATURES = Object.freeze([
  feature('member.avatar', null, ['avatar.asset-bridge.v1']),
  feature('member.service-cover', 'FREEDOM_SERVICE_COVER_ENABLED', ['media.service-cover.asset.v1', 'media.server-policy.v1']),
  feature('community.event-banner', 'FREEDOM_EVENT_BANNER_ENABLED', ['media.event-banner.asset.v1', 'media.server-policy.v1']),
  feature('community.event-video', 'FREEDOM_EVENT_VIDEO_ENABLED', ['media.event-video.asset.v1', 'media.server-policy.v1'], false),
  feature('skill.submission-image', 'FREEDOM_SKILL_IMAGE_ENABLED', ['media.skill-image.asset.v1', 'media.server-policy.v1']),
  feature('community.social-thumbnail', 'FREEDOM_SOCIAL_THUMBNAIL_ENABLED', ['media.social-thumbnail.asset.v1', 'media.social-preview-create.v1', 'media.server-policy.v1']),
  feature('community.event-highlight', 'FREEDOM_EVENT_HIGHLIGHT_ENABLED', ['media.event-highlight.asset.v1', 'media.server-policy.v1']),
]);
const knownFlags = new Set(MEDIA_WORKER_FEATURES.map(feature => feature.flag).filter(Boolean));
const mediaFlag = /^FREEDOM_.*(?:MEDIA|AVATAR|ASSET|COVER|BANNER|VIDEO|HIGHLIGHT|THUMBNAIL|SKILL_IMAGE).*_ENABLED$/;
const environments = ['staging-next', 'next'];
const remaining = Object.freeze([
  'provider_binding_identity_and_private_bucket', 'hyperdrive_cache_disabled',
  'current_database_and_exact_runtime_role', 'current_database_policy_and_consent',
  'release_capabilities_and_schema_floor', 'remote_worker_media_acceptance',
]);

/** Local declarations only; no credentials, SQL, provider client or execute path. */
export function checkMediaWranglerConfig(path, manifest) {
  const errors = [], blockers = [], mapping = {};
  const report = () => ({ schema: 'freedom.media-worker-config/v1',
    status: errors.length ? 'invalid' : blockers.length ? 'unavailable' : 'declared_only',
    structural: errors.length === 0, declaration_checks_pass: errors.length === 0 && blockers.length === 0,
    deployment_ready: false, enabled_by_this_tool: false, provider_mutations: 0,
    remote_cloud: 'not_run', runtime_acceptance: 'not_run', mapping, errors, blockers,
    remaining_checks: remaining.map(check_id => ({ check_id, status: 'not_run' })),
  });
  try {
    if (validateManifest(manifest).errors.length) throw Error('manifest');
  } catch { errors.push('canonical_manifest_invalid'); return report(); }
  let config, stat;
  try { stat = lstatSync(path); }
  catch { blockers.push('config_unavailable'); return report(); }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 262_144) throw Error('unsafe_config');
    config = parseJsonc(readFileSync(path, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('invalid_config');
  } catch { errors.push('config_invalid_or_unsafe'); return report(); }
  if (config.main !== 'apps/platform-api/src/worker.ts') errors.push('main_worker_entry_required');
  if (Object.keys(config.env ?? {}).some(name => !environments.includes(name))) errors.push('unknown_environment');
  // Reuse the established platform topology checker. Do not copy its free-form
  // config values into this report (private overlays can contain secrets).
  try {
    const platform = checkWranglerConfig(path, manifest);
    if (platform.structural !== 'valid') errors.push('platform_config_invalid');
  } catch { errors.push('platform_config_invalid'); }
  const ids = new Set();
  for (const [label, block] of [['default', config], ...environments.map(name => [name, config.env?.[name]])]) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) { errors.push(`${label}:environment_missing`); continue; }
    const varsValid = block.vars === undefined || (block.vars !== null && typeof block.vars === 'object' && !Array.isArray(block.vars));
    if (!varsValid) errors.push(`${label}:vars_invalid`);
    const vars = varsValid ? (block.vars ?? {}) : {};
    for (const key of knownFlags) if (vars[key] !== undefined && !['true', 'false'].includes(vars[key])) errors.push(`${label}:${key}:invalid_flag`);
    if (Object.keys(vars).some(key => mediaFlag.test(key) && !knownFlags.has(key))) errors.push(`${label}:unknown_media_flag`);
    if (label === 'default') continue;
    const canonical = manifest.environments[label];
    const bucket = canonical.r2_buckets.filter(item => item.public === false);
    if (bucket.length !== 1) { errors.push(`${label}:canonical_private_bucket_ambiguous`); continue; }
    if (vars.FREEDOM_DATABASE_NAME !== undefined && vars.FREEDOM_DATABASE_NAME !== canonical.database.dbname) errors.push(`${label}:database_name_crossed`);
    if (vars.FREEDOM_DATABASE_NAME === undefined) blockers.push(`${label}:database_name_injection_unverified`);
    // No runtime role variable is consumed by the Worker. An invented declaration
    // cannot replace the exact-role readback required below.
    if ('FREEDOM_DATABASE_ROLE' in vars) errors.push(`${label}:unsupported_database_role_variable`);
    const hyperdrive = Array.isArray(block.hyperdrive) ? block.hyperdrive.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
    for (const item of hyperdrive) {
      if (/^0{32}$/.test(item.id ?? '')) blockers.push(`${label}:hyperdrive_placeholder`);
      else if (/^[a-f0-9]{32}$/.test(item.id ?? '')) {
        if (ids.has(item.id)) errors.push(`${label}:hyperdrive_shared_across_environments`);
        ids.add(item.id);
      }
    }
    const bucketsValid = block.r2_buckets === undefined || (Array.isArray(block.r2_buckets) && block.r2_buckets.every(item => item && typeof item === 'object' && !Array.isArray(item)));
    if (!bucketsValid) errors.push(`${label}:r2_bindings_invalid`);
    const media = (bucketsValid ? (block.r2_buckets ?? []) : []).filter(item => item.binding === 'MEDIA');
    if (media.length > 1) errors.push(`${label}:duplicate_media_binding`);
    const installed = media.length === 1;
    if (installed && media[0].bucket_name !== bucket[0].name) {
      if (!media[0].bucket_name || /^(?:replace-|placeholder|0+$)/i.test(media[0].bucket_name)) blockers.push(`${label}:media_bucket_placeholder`);
      else errors.push(`${label}:media_bucket_crossed`);
    }
    // Remote R2 targets cannot be public or a second ambiguous preview store.
    if (installed && media[0].preview_bucket_name !== undefined && media[0].preview_bucket_name !== bucket[0].name) errors.push(`${label}:alternate_media_store`);
    const features = MEDIA_WORKER_FEATURES.map(feature => {
      const enabled = feature.flag === null ? installed : vars[feature.flag] === 'true';
      if (enabled && !installed) blockers.push(`${label}:${feature.purpose}:media_binding_missing`);
      if (enabled && feature.required_bindings.includes('IMAGES') && block.images?.binding !== 'IMAGES') blockers.push(`${label}:${feature.purpose}:images_binding_missing`);
      return { ...feature, declared_enabled: enabled,
        installation: feature.flag === null ? (installed ? 'native_binding_declared' : 'native_binding_absent') : (enabled ? 'explicit_flag_declared' : 'default_off'),
        persistence_authorized: 'not_run', storage_mode: 'not_run' };
    });
    if (!installed) blockers.push(`${label}:media_binding_not_configured`);
    mapping[label] = { worker: canonical.worker.name, origin: `https://${canonical.hostname}`,
      route: canonical.route, expected_bucket: bucket[0].name, expected_database: canonical.database.dbname,
      expected_runtime_role: canonical.database.roles.runtime, hyperdrive_binding: canonical.hyperdrive.binding,
      hyperdrive_name: canonical.hyperdrive.name, required_caching_disabled: true,
      provider_role_database_readback: 'not_run', provider_cache_readback: 'not_run', features,
      required_capabilities: [...new Set(features.filter(item => item.declared_enabled).flatMap(item => item.required_capabilities))].sort(),
    };
  }
  return report();
}
