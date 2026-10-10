import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkMediaWranglerConfig, MEDIA_WORKER_FEATURES } from '../lib/media-wrangler.mjs';
import { parseJsonc } from '../lib/wrangler.mjs';
import { loadManifest } from '../lib/manifest.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const canonical = parseJsonc(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
const manifest = loadManifest();
const flags = MEDIA_WORKER_FEATURES.map(item => item.flag).filter(Boolean);
function fixture(change = () => {}, run = path => checkMediaWranglerConfig(path, manifest)) {
  const directory = mkdtempSync(join(tmpdir(), 'fp-media-config-'));
  try {
    const config = structuredClone(canonical); change(config);
    const path = join(directory, 'candidate.jsonc'); writeFileSync(path, JSON.stringify(config));
    return run(path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function declared(config) {
  for (const [index, [name, block]] of Object.entries(config.env).entries()) {
    block.hyperdrive[0].id = String(index + 1).repeat(32); // synthetic IDs, no provider proof
    block.vars.FREEDOM_DATABASE_NAME = manifest.environments[name].database.dbname;
    block.r2_buckets = [{ binding: 'MEDIA', bucket_name: manifest.environments[name].r2_buckets[0].name }];
    for (const flag of flags) block.vars[flag] = 'true';
    block.vars.FREEDOM_GUILD_LAUNCHPAD_ENABLED='true';
  }
}

test('actual canonical Wrangler keeps all media flags OFF and reports unavailable bindings, never remote acceptance', () => {
  const report = checkMediaWranglerConfig(resolve(root, 'wrangler.jsonc'), manifest);
  assert.equal(report.structural, true); assert.equal(report.status, 'unavailable');
  assert.equal(report.deployment_ready, false); assert.equal(report.provider_mutations, 0);
  assert.equal(report.enabled_by_this_tool, false); assert.equal(report.runtime_acceptance, 'not_run');
  for (const environment of Object.values(report.mapping)) {
    assert.equal(environment.features.length, 9);
    assert(environment.features.every(item => item.declared_enabled === false));
    assert(environment.features.filter(item => item.flag).every(item => item.installation === 'default_off'));
    assert.deepEqual(environment.required_capabilities, []);
  }
  assert(report.blockers.some(item => item.includes('hyperdrive_placeholder')));
  assert(report.blockers.some(item => item.includes('media_binding_not_configured')));
  assert(report.remaining_checks.every(item => item.status === 'not_run'));
});

test('fixed media flag mapping matches the actual installed main Worker and retained full social writer capability', () => {
  const source = readFileSync(resolve(root, 'apps/platform-api/src/worker.ts'), 'utf8');
  const actual = [...new Set(source.match(/FREEDOM_(?:SERVICE_COVER|EVENT_BANNER|EVENT_VIDEO|SKILL_IMAGE|SOCIAL_THUMBNAIL|EVENT_HIGHLIGHT|MESSAGE_IMAGE|HOSTED_STORE_PHOTOS)_ENABLED/g))].sort();
  assert.deepEqual([...flags].sort(), actual);
  for (const flag of flags) assert(source.includes(`env.${flag}==='true'`));
  const social = MEDIA_WORKER_FEATURES.find(item => item.purpose === 'community.social-thumbnail');
  assert(social.required_capabilities.includes('media.social-preview-create.v1'));
  assert.equal(MEDIA_WORKER_FEATURES.find(item => item.purpose === 'member.avatar').flag, null);
  assert.deepEqual(MEDIA_WORKER_FEATURES.find(item => item.purpose === 'community.event-video').required_bindings, ['MEDIA']);
});

test('declared complete profiles map exact staging/production bucket, DB, app role and capabilities without proof inflation', () => {
  const report = fixture(declared);
  assert.equal(report.structural, true); assert.equal(report.declaration_checks_pass, true);
  assert.equal(report.status, 'declared_only'); assert.equal(report.deployment_ready, false);
  for (const [name, environment] of Object.entries(report.mapping)) {
    const expected = manifest.environments[name];
    assert.equal(environment.expected_database, expected.database.dbname);
    assert.equal(environment.expected_runtime_role, expected.database.roles.runtime);
    assert.equal(environment.expected_bucket, expected.r2_buckets[0].name);
    assert.equal(environment.origin, `https://${expected.hostname}`);
    assert.equal(environment.features.filter(item => item.declared_enabled).length, 9);
    assert.equal(environment.provider_role_database_readback, 'not_run');
    assert.equal(environment.provider_cache_readback, 'not_run');
    assert(environment.required_capabilities.includes('media.server-policy.v1'));
    assert(environment.required_capabilities.includes('media.social-preview-create.v1'));
  }
});

test('unknown values and invented media flags are rejected without exposing their values', () => {
  for (const value of ['TRUE', ' true', '', true, 1, 'SYNTHETIC_SECRET_SENTINEL']) {
    const report = fixture(config => { config.env.next.vars.FREEDOM_SERVICE_COVER_ENABLED = value; });
    assert.equal(report.structural, false);
    assert(!JSON.stringify(report).includes('SYNTHETIC_SECRET_SENTINEL'));
  }
  assert.equal(fixture(config => { config.env.next.vars.FREEDOM_AVATAR_ENABLED = 'true'; }).structural, false);
  assert.equal(fixture(config => { config.vars.FREEDOM_EVENT_VIDEO_ENABLED = 'yes'; }).structural, false);
});

test('non-inherited flags and bindings cannot be borrowed from the default profile', () => {
  const report = fixture(config => {
    config.r2_buckets = [{ binding: 'MEDIA', bucket_name: 'local-only-fixture' }];
    config.vars.FREEDOM_SERVICE_COVER_ENABLED = 'true';
    config.env.next.vars.FREEDOM_SERVICE_COVER_ENABLED = 'true';
  });
  assert.equal(report.status, 'unavailable');
  assert(report.blockers.includes('next:member.service-cover:media_binding_missing'));
  assert.equal(report.mapping['staging-next'].features.find(item => item.purpose === 'member.service-cover').declared_enabled, false);
  const missing = fixture(config => { declared(config); delete config.env.next.images; });
  assert(missing.blockers.includes('next:member.service-cover:images_binding_missing'));
});

test('crossed origins/routes/databases/buckets, role assertions, shared IDs and duplicate bindings are rejected', () => {
  const changes = [
    config => { config.env['staging-next'].vars.APP_ORIGIN = 'https://freetwai.com'; },
    config => { config.env.next.routes = config.env['staging-next'].routes; },
    config => { config.env.next.vars.FREEDOM_DATABASE_NAME = 'freedom_staging_next'; },
    config => { config.env.next.r2_buckets[0].bucket_name = 'freedom-staging-next-private'; },
    config => { config.env.next.vars.FREEDOM_DATABASE_ROLE = 'freedom_next_migrator'; },
    config => { config.env.next.hyperdrive[0].id = config.env['staging-next'].hyperdrive[0].id; },
    config => { config.env.next.r2_buckets.push(config.env.next.r2_buckets[0]); },
    config => { config.env.next.r2_buckets[0].preview_bucket_name = 'freedom-staging-next-private'; },
    config => { config.main = 'apps/media-maintenance/src/worker.ts'; },
  ];
  for (const change of changes) assert.equal(fixture(config => { declared(config); change(config); }).structural, false);
});

test('placeholders are explicitly unavailable and cache/policy-looking vars cannot manufacture readiness', () => {
  const report = fixture(config => {
    declared(config); config.env.next.r2_buckets[0].bucket_name = 'replace-existing-private-bucket';
    config.env.next.vars.FREEDOM_HYPERDRIVE_CACHE_DISABLED = 'true';
    config.env.next.vars.FREEDOM_MEDIA_PERSISTENCE_ALLOWED = 'true';
  });
  assert.equal(report.status, 'unavailable');
  assert(report.blockers.includes('next:media_bucket_placeholder'));
  assert.equal(report.deployment_ready, false);
  assert(report.remaining_checks.every(item => item.status === 'not_run'));
});

test('CLI reports canonical unavailable state and refuses execution/credential arguments', () => {
  const cli = resolve(root, 'deploy/cloudflare/media-preflight.mjs');
  const actual = spawnSync(process.execPath, ['--', cli], { encoding: 'utf8' });
  assert.equal(actual.status, 2, actual.stderr);
  assert.equal(JSON.parse(actual.stdout).status, 'unavailable');
  for (const args of [['--execute'], ['--env-file', 'SYNTHETIC_SECRET_SENTINEL'], ['--config', '--execute']]) {
    const run = spawnSync(process.execPath, ['--', cli, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 1); assert(!run.stderr.includes('SYNTHETIC_SECRET_SENTINEL'));
  }
  const declaredRun = fixture(declared, path => spawnSync(process.execPath, ['--', cli, '--config', path], { encoding: 'utf8' }));
  assert.equal(declaredRun.status, 0, declaredRun.stderr);
  assert.equal(JSON.parse(declaredRun.stdout).deployment_ready, false);
});

test('photo read installation and new upload admission are separate closed declarations',()=>{
  const absent=fixture(config=>{config.env.next.vars.FREEDOM_HOSTED_STORE_PHOTO_UPLOADS_ENABLED='true';});
  assert(absent.blockers.includes('next:storefront.product-photo:read_installation_required'));
  const reads=fixture(config=>{declared(config);for(const flag of flags)config.env.next.vars[flag]='false';config.env.next.vars.FREEDOM_HOSTED_STORE_PHOTOS_ENABLED='true';delete config.env.next.images;});
  assert.equal(reads.mapping.next.features.find(item=>item.purpose==='storefront.product-photo').declared_enabled,true);
  assert(!reads.blockers.includes('next:storefront.product-photo:images_binding_missing'));
  const writes=fixture(config=>{declared(config);config.env.next.vars.FREEDOM_HOSTED_STORE_PHOTO_UPLOADS_ENABLED='true';delete config.env.next.images;});
  assert(writes.blockers.includes('next:storefront.product-photo:images_binding_missing'));
});
