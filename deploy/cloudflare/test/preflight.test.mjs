import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { loadCloudflareCredentials, parseAllowlistedEnv, resolveCloudflareKeys } from '../lib/credentials.mjs';
import { createReadOnlyClient, probeCloudflare, readHyperdriveCaching } from '../lib/cloudflare.mjs';
import { assertMutationTarget, loadManifest, validateManifest } from '../lib/manifest.mjs';
import { ociAlternativeCost, planetscaleCost } from '../lib/cost.mjs';
import { checkMigrations, migrationDigest } from '../lib/migrations.mjs';
import { assertProfile, assertReadOnlyOciArgs, CHECKS, interpretPgLimits, ociAlternativeStatus, probeOci, tenancyFromConfig } from '../lib/oci.mjs';
import { assertReadOnlyArgs, defaultRunner, parseRegion, parseSize, probePlanetScale, pscaleEnv, versionAtLeast } from '../lib/planetscale.mjs';
import { buildProvisionPlan } from '../lib/provision-plan.mjs';
import { redactDeep, redactText } from '../lib/redact.mjs';
import { checkWranglerConfig, parseJsonc } from '../lib/wrangler.mjs';
import { run } from '../preflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const ACCOUNT = 'a'.repeat(32);
const ZONE = 'b'.repeat(32);
const TOKEN_ID = 'c'.repeat(32);
// Synthetic, never a real credential.
const FAKE_TOKEN = 'Fake_Test_Token_xYz0123456789abcdefGHIJK';
const manifest = () => loadManifest();
const clone = (v) => JSON.parse(JSON.stringify(v));

function privateEnvFile(body, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-cf-test-'));
  const file = join(dir, 'cf.env');
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

function mockCloudflare(overrides = {}) {
  const calls = [];
  const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });
  const denied = { status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null } };
  const routes = {
    '/user/tokens/verify': ok({ id: TOKEN_ID, status: 'active' }),
    [`/user/tokens/${TOKEN_ID}`]: ok({ policies: [{ effect: 'allow', permission_groups: [{ name: 'DNS Write' }, { name: 'API Tokens Write' }, { name: 'Access: Apps and Policies Write' }, { name: 'Workers R2 Storage Write' }] }] }),
    '/zones?name=freetwai.com': ok([{ id: ZONE, name: 'freetwai.com', status: 'active', plan: { legacy_id: 'free' } }]),
    [`/accounts/${ACCOUNT}/workers/scripts`]: ok([]),
    [`/accounts/${ACCOUNT}/workers/subdomain`]: denied,
    [`/accounts/${ACCOUNT}/workers/domains`]: denied,
    [`/accounts/${ACCOUNT}/hyperdrive/configs`]: denied,
    [`/accounts/${ACCOUNT}/r2/buckets`]: ok({ buckets: [{ name: 'unrelated' }] }),
    [`/accounts/${ACCOUNT}/queues`]: denied,
    [`/accounts/${ACCOUNT}/access/apps`]: ok([{ name: 'Freedom staging', domain: 'staging.freetwai.com' }, { name: 'Freedom staging administrators', domain: 'staging.freetwai.com/admin' }, { name: 'Freedom public administrators', domain: 'freetwai.com/admin' }]),
    [`/accounts/${ACCOUNT}/cfd_tunnel?is_deleted=false&per_page=100`]: ok([{ name: 'freedom-staging', status: 'healthy' }]),
    [`/accounts/${ACCOUNT}/subscriptions`]: denied,
    [`/zones/${ZONE}`]: ok({ id: ZONE }),
    [`/zones/${ZONE}/dns_records?per_page=500`]: ok([
      { name: 'freetwai.com', type: 'CNAME', content: 'uuid.cfargotunnel.com', proxied: true },
      { name: 'staging.freetwai.com', type: 'CNAME', content: 'uuid.cfargotunnel.com', proxied: true },
    ]),
    [`/zones/${ZONE}/workers/routes`]: denied,
    [`/zones/${ZONE}/rulesets/phases/http_request_cache_settings/entrypoint`]: denied,
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    const hit = routes[path] ?? { status: 404, body: { success: false, errors: [{ code: 7003, message: 'no route' }] } };
    return { status: hit.status, json: async () => hit.body };
  };
  return { fetchImpl, calls };
}

test('manifest selects Cloudflare-billed PlanetScale PG18, PS-5 sizes, one HYPERDRIVE and no invented cap', () => {
  const m = manifest();
  assert.deepEqual(validateManifest(m).errors, []);
  assert.equal(m.providers.selected, 'planetscale_cloudflare_billed');
  assert.equal(m.providers.planetscale.billing, 'cloudflare');
  assert.equal(m.database_defaults.major_version, 18);
  assert.deepEqual([m.environments['staging-next'].database.size, m.environments['staging-next'].database.topology], ['PS-5', 'single_node']);
  assert.deepEqual([m.environments.next.database.size, m.environments.next.database.topology], ['PS-5', 'ha']);
  for (const env of Object.values(m.environments)) {
    assert.deepEqual(env.hyperdrive, { name: env.hyperdrive.name, binding: 'HYPERDRIVE', caching_disabled: true });
    assert.ok(env.var_names.includes('FREEDOM_RELEASE_SHA'));
  }
  assert.equal(m.budget.authorized_cap_usd_month, null);
  assert.equal(m.providers.oci.provisioning, false);
  assert.equal(m.providers.d1.drop_in, false);
  assert.equal(m.providers.planetscale.catalog.org_quote.region, 'ap-northeast');
  assert.equal(m.providers.planetscale.pscale_auth_observed.status, 'authenticated');
  const text = JSON.stringify(m);
  assert.doesNotMatch(text, /DB_FRESH|DB_CACHED|max_age_seconds|paid_creation_rule/);
  assert.doesNotMatch(text, /"authorized_cap_usd_month":\s*60/);
});

test('cost arithmetic: recorded Tokyo org quote gives a US$25 base; unknown prices keep the total pending; OCI alternative', () => {
  const current = manifest();
  assert.equal(current.providers.planetscale.catalog.status, 'org_quote_recorded');
  const now = planetscaleCost(current);
  assert.deepEqual(now.environments['staging-next'], { sku: 'PS-5 single_node', nodes: 1, usd_month: 5 });
  assert.deepEqual(now.environments.next, { sku: 'PS-5 ha', nodes: 3, usd_month: 15 });
  assert.deepEqual([now.total, now.total_status, now.quote_required], [25, 'computed', []]);
  assert.match(now.total_meaning, /not total usage/);
  assert.ok(now.excluded.some((e) => /storage and usage/.test(e)) && now.excluded.includes('tax'));
  assert.match(now.org_size_availability, /^org_quote_recorded 2026-09-24: org ted-ted-h, region ap-northeast; PS-5 single_node = PS_5_AWS_ARM\/PS_5_AWS_X86 \(PS-5, replicas 0\) US\$5; PS-5 ha = .*replicas 2\) US\$15$/);
  assert.equal(current.budget.authorized_cap_usd_month, null);
  // Clone and forget the quote: unknown prices never become 0.
  const m = clone(current);
  m.providers.planetscale.catalog.status = 'catalog_required';
  delete m.providers.planetscale.catalog.org_quote;
  m.providers.planetscale.catalog.monthly_usd = { 'PS-5 single_node': null, 'PS-5 ha': null };
  assert.deepEqual(validateManifest(m).errors, []);
  assert.deepEqual(m.providers.planetscale.topology_nodes.ha, { nodes: 3, primary: 1, replicas: 2 });
  const ps = planetscaleCost(m);
  assert.deepEqual(ps.environments['staging-next'], { sku: 'PS-5 single_node', nodes: 1, usd_month: null });
  assert.deepEqual(ps.environments.next, { sku: 'PS-5 ha', nodes: 3, usd_month: null });
  assert.equal(ps.total, null);
  assert.equal(ps.total_status, 'pending_quote');
  assert.deepEqual(ps.quote_required, ['staging-next: PS-5 single_node', 'next: PS-5 ha']);
  assert.equal(ps.cloudflare_workers_paid, 5);
  assert.equal(ps.public_starting_price_single_node, 5);
  assert.match(ps.public_starting_price_meaning, /not the regional or organization quote/);
  assert.doesNotMatch(JSON.stringify(ps), /NaN|\b(15|25|41)\b/);
  // One known, one unknown: still pending, never a partial sum.
  const partial = clone(m);
  partial.providers.planetscale.catalog.monthly_usd['PS-5 single_node'] = 7;
  assert.equal(planetscaleCost(partial).total, null);
  // Only when every selected SKU has a recorded quote is a total computed.
  partial.providers.planetscale.catalog.monthly_usd['PS-5 ha'] = 30;
  assert.deepEqual([planetscaleCost(partial).total, planetscaleCost(partial).total_status], [42, 'computed']);
  assert.match(ps.org_size_availability, /^catalog_required: not read/);
  assert.ok(!('exceeds_user_estimate' in ps) && !('authorized_cap' in ps), 'no spend gate');
  const e4 = ociAlternativeCost(manifest());
  // (0.098 + 0.03) × 1 OCPU + 0.002 × 16 GB = 0.16/h × 730
  assert.equal(e4.db_per_node, 116.8);
  // E4 B93113 0.025 + B93114 0.0015 = 0.0265/h × 730 = 19.345
  assert.equal(e4.environments['staging-next'].connector, 19.35);
  assert.equal(e4.environments.next.db, 233.6);
  assert.equal(e4.total_lower_bound, 394.1);
  const a1 = ociAlternativeCost(manifest(), { connectorShape: 'CI.Standard.A1.Flex' });
  // A1 B93297 0.01 + B93298 0.0015 = 0.0115/h × 730 = 8.395
  assert.equal(a1.environments.next.connector, 8.4);
  assert.equal(a1.total_lower_bound, 372.2);
  for (const x of ['storage', 'backups', 'NAT', 'egress']) assert.ok(e4.excluded.some((e) => e.includes(x)), x);
  assert.throws(() => ociAlternativeCost(manifest(), { connectorShape: 'CI.Standard.E5.Flex' }), /No connector rate/);
  assert.equal(e4.provisioning, false);
});

test('OCI alternative: zero active dbsystem-count blocks despite E5=20; TLS not_run; no provisioning', () => {
  const st = ociAlternativeStatus(manifest());
  assert.equal(st.quota.status, 'blocked');
  assert.match(st.quota.reason, /do not override/);
  assert.deepEqual(st.profiles_checked, ['oracle1', 'oracle2']);
  assert.match(st.profiles.oracle2, /compare-only/);
  assert.equal(st.tls.status, 'not_run');
  assert.equal(st.tls.ready, false);
  assert.match(st.tls.detail, /custom CA/);
  assert.match(st.tls.detail, /does not prove/);
  assert.equal(st.provisioning, false);
});

test('manifest rejects unsafe configurations', () => {
  const cases = [
    [(m) => { m.environments.next.worker.preview_urls = true; }, /preview_urls/],
    [(m) => { m.environments.next.worker.workers_dev = true; }, /workers_dev/],
    [(m) => { m.environments.next.hostname = 'freetwai.com'; }, /hostname/],
    [(m) => { m.environments.next.hyperdrive.caching_disabled = false; }, /caching disabled/],
    [(m) => { m.environments.next.hyperdrive.binding = 'DB_FRESH'; }, /HYPERDRIVE/],
    [(m) => { m.environments.next.hyperdrive = [m.environments.next.hyperdrive, { name: 'freedom-next-cached', binding: 'DB_CACHED' }]; }, /exactly one/],
    [(m) => { m.environments.next.hyperdrive.name = 'freedom-staging-next-hd'; }, /prefix|shared/],
    [(m) => { m.environments['staging-next'].data_source = 'rehearsal-restore-of-public-backup'; }, /synthetic/],
    [(m) => { m.environments.next.database.topology = 'single_node'; }, /HA/],
    [(m) => { m.environments['staging-next'].database.size = 'PS-7'; }, /not a catalog SKU/],
    [(m) => { m.providers.planetscale.catalog.monthly_usd['PS-5 ha'] = 'NaN'; }, /null \(unknown\) or a recorded number/],
    [(m) => { m.providers.planetscale.topology_nodes.ha.nodes = 2; }, /3 nodes/],
    [(m) => { delete m.providers.planetscale.catalog.status; }, /catalog_required/],
    [(m) => { m.database_defaults.engine = 'mysql'; }, /PostgreSQL 18/],
    [(m) => { m.database_defaults.major_version = 17; }, /18/],
    [(m) => { m.environments.next.var_names.push('GITHUB_SOCIAL_TOKEN_KEY'); }, /secret/],
    [(m) => { m.environments.next.var_names = m.environments.next.var_names.filter((v) => v !== 'FREEDOM_RELEASE_SHA'); }, /FREEDOM_RELEASE_SHA/],
    [(m) => { m.environments.next.secret_names.push('DATABASE_URL'); }, /Hyperdrive binding/],
    [(m) => { m.environments.next.access.application_name = 'Freedom staging'; }, /protected/],
    [(m) => { m.protected.hostnames = ['freetwai.com']; }, /staging\.freetwai\.com/],
    [(m) => { m.providers.selected = 'oci'; }, /planetscale_cloudflare_billed/],
    [(m) => { m.providers.planetscale.billing = 'direct'; }, /Cloudflare/],
    [(m) => { m.providers.oci.provisioning = true; }, /surveyed alternative/],
    [(m) => { m.providers.d1.drop_in = true; }, /D1/],
    [(m) => { m.budget.authorized_cap_usd_month = '60'; }, /null/],
  ];
  for (const [mutate, expected] of cases) {
    const m = clone(manifest());
    mutate(m);
    const result = validateManifest(m);
    assert.equal(result.ok, false, `expected failure for ${expected}`);
    assert.ok(result.errors.some((e) => expected.test(e)), `${expected} not in ${result.errors.join(' | ')}`);
  }
});

test('mutation guard is default-deny, protects the old site and refuses every OCI kind', () => {
  const m = manifest();
  assert.ok(assertMutationTarget(m, 'next', 'worker', 'freedom-platform-next'));
  assert.ok(assertMutationTarget(m, 'staging-next', 'hyperdrive', 'freedom-staging-next-hd'));
  assert.ok(assertMutationTarget(m, 'next', 'database', 'freedom-next-pg'));
  assert.throws(() => assertMutationTarget(m, 'next', 'hostname', 'freetwai.com'), /protected/);
  assert.throws(() => assertMutationTarget(m, 'next', 'hostname', 'staging.freetwai.com'), /protected/);
  assert.throws(() => assertMutationTarget(m, 'next', 'access_application', 'Freedom staging'), /protected/);
  assert.throws(() => assertMutationTarget(m, 'next', 'database', 'freedom_public'), /protected/);
  assert.throws(() => assertMutationTarget(m, 'next', 'tunnel', 'freedom-staging'), /Unknown resource kind/);
  assert.throws(() => assertMutationTarget(m, 'next', 'oci_instance', 'oracle1-vm'), /never used or changed/);
  assert.throws(() => assertMutationTarget(m, 'next', 'oci_compartment', 'freedom-next'), /surveyed alternative/);
  assert.throws(() => assertMutationTarget(m, 'next', 'hyperdrive', 'freedom-staging-next-hd'), /not owned/);
  assert.throws(() => assertMutationTarget(m, 'next', 'worker', 'freedom-platform-staging-next'), /not owned/);
  assert.throws(() => assertMutationTarget(m, 'next', 'r2_bucket', 'ai-sister'), /not owned/);
  assert.throws(() => assertMutationTarget(m, 'prod', 'worker', 'x'), /Unknown environment/);
});

test('provision plan is dry-run, guarded, secret-free and never produces a billing signature', () => {
  for (const env of ['staging-next', 'next']) {
    const plan = buildProvisionPlan(manifest(), env);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.provider, 'planetscale_cloudflare_billed');
    assert.match(plan.execution, /not available/);
    const text = JSON.stringify(plan);
    assert.doesNotMatch(text, /postgres(ql)?:\/\/|--connection-string|PGPASSWORD|password=/i);
    assert.doesNotMatch(text, /DB_FRESH|DB_CACHED|max_age|\boci (psql|iam|network|container)|oracle1|oracle2|ssh /i);
    assert.doesNotMatch(text, /pscale auth login/);
    assert.equal(plan.hostname, `${env}.freetwai.com`);
    const idx = (id) => plan.steps.findIndex((s) => s.id === id);
    assert.ok(idx('access-app') < idx('deploy'), 'Access before deploy');
    assert.ok(idx('hyperdrive') < idx('hyperdrive-verify') && idx('hyperdrive-verify') < idx('deploy'), 'caching read-back gates deploy');
    assert.match(plan.steps[idx('hyperdrive')].command, /caching\.disabled=true/);
    const roles = manifest().environments[env].database.roles;
    assert.ok(plan.steps[idx('hyperdrive')].command.includes(`user=${roles.runtime}.<branch-id> `), 'TLS username carries branch suffix');
    assert.deepEqual(plan.steps[idx('roles')].target, ['db_role', roles.migrator]);
    assert.deepEqual(plan.steps[idx('grants')].target, ['db_role', roles.runtime]);
    assert.doesNotMatch(roles.migrator + roles.runtime, /\./, 'SQL role names stay unsuffixed');
    assert.doesNotMatch(plan.steps[idx('roles')].command + plan.steps[idx('grants')].command, /<branch-id>/);
    assert.equal(plan.steps.filter((s) => s.target?.[0] === 'hyperdrive').length, 1, 'exactly one Hyperdrive config');
    const db = plan.steps[idx('ps-database')];
    assert.match(db.alternatives.cli, /^wrangler hyperdrive planetscale signature \| DBUS_SESSION_BUS_ADDRESS=unix:path=\/dev\/null pscale database create freedom-(staging-)?next-pg --org ted-ted-h --engine postgresql --region ap-northeast --cloudflare-billing @- --format json$/);
    assert.match(db.action, /no execute capability/);
    assert.match(db.alternatives.dashboard, /Cloudflare dashboard/);
    assert.match(db.action, /token alone cannot create/);
    assert.match(plan.steps[0].action, /0\.313\.0/);
    assert.match(plan.steps[0].action, /current: authenticated \(oauth\), org ted-ted-h/);
    assert.match(plan.steps[0].action, /org_quote_recorded 2026-09-24/);
    assert.match(plan.steps[0].action, /process-scoped DBUS_SESSION_BUS_ADDRESS=unix:path=\/dev\/null/);
    assert.match(plan.steps[1].action, /US\$25\/month \(base rates only, not total usage/);
    assert.match(plan.steps[idx('deploy')].command, /--var FREEDOM_RELEASE_SHA:<git rev-parse HEAD>/);
    assert.doesNotMatch(plan.steps[0].action, /TOKEN_SAVE_FAILED|not_run|unauthenticated/);
    assert.doesNotMatch(text, /single pending device login/);
    const deployGate = plan.steps[idx('deploy')].action;
    assert.match(deployGate, /structural valid AND static_checks_pass true/);
    assert.match(deployGate, /separate explicit evidence for every required injection/);
    assert.match(deployGate, /wrangler secret list --env /);
    assert.doesNotMatch(deployGate, /AND deployment_ready|deployment_ready true/, 'deploy must not wait on a boolean the checker cannot prove');
    assert.doesNotMatch(text, /\bcap\b|approval|gate-cost/i);
    assert.ok(idx('rollback') > idx('verify'));
  }
  const staging = JSON.stringify(buildProvisionPlan(manifest(), 'staging-next'));
  assert.match(staging, /PS-5 single_node/);
  assert.match(staging, /Never seedLocal/);
  assert.doesNotMatch(staging, /pg_restore/);
  const next = JSON.stringify(buildProvisionPlan(manifest(), 'next'));
  assert.match(next, /PS-5 ha/);
  assert.match(next, /NEW GITHUB_SOCIAL_TOKEN_KEY/);
  assert.match(next, /checksum-verify a fresh full freedom_public backup/);
});

test('credentials: CLOUDFLARE_* current keys, CF_* legacy aliases, conflicts refused, values never shown', () => {
  const OTHER = 'Other_Fake_Token_ABCdef0123456789ghijklmn';
  const parsed = parseAllowlistedEnv(`# c\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nexport CLOUDFLARE_API_TOKEN="${FAKE_TOKEN}"\nOTHER_SECRET=nope\n`, ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  assert.deepEqual(Object.keys(parsed).sort(), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);
  // Fake files only; no real environment or credential file is read.
  const load = (body, mode) => loadCloudflareCredentials(privateEnvFile(body, mode));
  assert.throws(() => load(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${FAKE_TOKEN}\n`, 0o644), /chmod 600/);
  assert.throws(() => load(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`), /Missing CLOUDFLARE_API_TOKEN \(or legacy CF_API_TOKEN\)/);
  for (const body of [
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${FAKE_TOKEN}\n`,
    `CF_ACCOUNT_ID=${ACCOUNT}\nCF_API_TOKEN=${FAKE_TOKEN}\n`,
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCF_API_TOKEN=${FAKE_TOKEN}\nCLOUDFLARE_API_TOKEN=${FAKE_TOKEN}\n`,
  ]) {
    const creds = load(body);
    assert.equal(creds.accountId, ACCOUNT);
    assert.equal(creds.authorizationHeader(), `Bearer ${FAKE_TOKEN}`);
    for (const view of [JSON.stringify(creds), inspect(creds), String(creds)]) assert.doesNotMatch(view, new RegExp(FAKE_TOKEN));
  }
  const conflict = (body) => { try { load(body); } catch (e) { return e.message; } assert.fail('conflict accepted'); };
  const msg = conflict(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${FAKE_TOKEN}\nCF_API_TOKEN=${OTHER}\n`);
  assert.match(msg, /CLOUDFLARE_API_TOKEN and legacy CF_API_TOKEN .* different values/);
  assert.doesNotMatch(msg, new RegExp(`${FAKE_TOKEN}|${OTHER}`));
  const idMsg = conflict(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCF_ACCOUNT_ID=${'e'.repeat(32)}\nCLOUDFLARE_API_TOKEN=${FAKE_TOKEN}\n`);
  assert.match(idMsg, /CLOUDFLARE_ACCOUNT_ID and legacy CF_ACCOUNT_ID/);
  assert.doesNotMatch(idMsg, new RegExp(`${ACCOUNT}|${'e'.repeat(32)}`));
  assert.throws(() => resolveCloudflareKeys({ CLOUDFLARE_ACCOUNT_ID: 'not-hex', CLOUDFLARE_API_TOKEN: 'x' }) && load(`CLOUDFLARE_ACCOUNT_ID=not-hex\nCLOUDFLARE_API_TOKEN=${FAKE_TOKEN}\n`), /unexpected format \(value not shown\)/);
});

test('Cloudflare client is GET-only with a path allowlist', async () => {
  const { fetchImpl, calls } = mockCloudflare();
  const client = createReadOnlyClient({ credentials: { authorizationHeader: () => `Bearer ${FAKE_TOKEN}` }, fetchImpl });
  assert.deepEqual(Object.keys(client), ['get']);
  await assert.rejects(client.get(`/accounts/${ACCOUNT}/workers/scripts/freedom-platform-next`), /allowlist/);
  await assert.rejects(client.get(`/zones/${ZONE}/dns_records`), /allowlist/);
  await assert.rejects(client.get(`/accounts/${ACCOUNT}/tokens`), /allowlist/);
  assert.equal(calls.length, 0);
});

test('Cloudflare probe reports real gaps, escalation risk and protected baseline without leaking', async () => {
  const { fetchImpl, calls } = mockCloudflare();
  const client = createReadOnlyClient({ credentials: { authorizationHeader: () => `Bearer ${FAKE_TOKEN}` }, fetchImpl });
  const report = await probeCloudflare({ client, accountId: ACCOUNT, manifest: manifest() });
  assert.ok(calls.length > 5);
  assert.ok(calls.every((c) => c.method === 'GET'));
  const status = Object.fromEntries(report.capabilities.map((c) => [c.id, c.status]));
  assert.equal(status.hyperdrive, 'missing_permission');
  assert.equal(status.workers_routes, 'missing_permission');
  assert.equal(status.dns, 'granted');
  assert.ok(report.capabilities.find((c) => c.id === 'workers_scripts').note, 'empty list without read permission flagged inconclusive');
  const missingWrite = report.missing_for_provisioning.map((g) => g.group);
  for (const g of ['Workers Scripts Edit', 'Hyperdrive Edit', 'Workers Routes Edit']) assert.ok(missingWrite.includes(g), g);
  assert.ok(!missingWrite.includes('DNS Edit') && !missingWrite.includes('Access: Apps and Policies Edit'));
  assert.ok(!report.missing_for_preflight.some((g) => g.capability === 'queues'), 'queues is optional');
  assert.ok(report.findings.some((f) => f.id === 'token_can_escalate'));
  assert.ok(report.findings.some((f) => f.id === 'protected_hosts_share_origin'));
  assert.equal(report.protected_baseline['candidate:next.freetwai.com'], 'absent');
  assert.equal(report.protected_baseline['access:next.freetwai.com'], 'not_yet_covered');
  assert.equal(report.protected_baseline['freetwai.com'][0].tunnel_target, true);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(text, /cfargotunnel/);
  assert.doesNotMatch(text, new RegExp(ACCOUNT));
});

test('Cloudflare probe flags an occupied candidate hostname', async () => {
  const { fetchImpl } = mockCloudflare({ [`/zones/${ZONE}/dns_records?per_page=500`]: { status: 200, body: { success: true, result: [
    { name: 'freetwai.com', type: 'CNAME', content: 'x', proxied: true },
    { name: 'staging.freetwai.com', type: 'CNAME', content: 'y', proxied: true },
    { name: 'next.freetwai.com', type: 'A', content: '192.0.2.1', proxied: true },
  ] } } });
  const client = createReadOnlyClient({ credentials: { authorizationHeader: () => 'Bearer x' }, fetchImpl });
  const report = await probeCloudflare({ client, accountId: ACCOUNT, manifest: manifest() });
  assert.ok(report.findings.some((f) => f.id === 'candidate_hostname_taken'));
  assert.ok(!report.findings.some((f) => f.id === 'protected_hosts_share_origin'));
});

test('pscale runner only accepts read-only argument vectors', async () => {
  for (const bad of [['auth', 'login'], ['database', 'create', 'x'], ['role', 'create', 'db', 'main', 'r'], ['connect', 'db'], ['password', 'create', 'db', 'main', 'x'], ['database', 'list', '--org', 'a;rm', '--format', 'json']]) {
    assert.throws(() => assertReadOnlyArgs(bad), /allowlist/);
  }
  const seen = [];
  const unauth = await probePlanetScale({ manifest: manifest(), run: async (args) => { seen.push(args.join(' ')); return args[0] === 'version' ? { code: 0, stdout: 'pscale version 0.338.0 (build)' } : { code: 1, stdout: '{"authenticated":false,"auth_method":"none"}' }; } });
  assert.equal(unauth.auth.status, 'unauthenticated');
  assert.ok(unauth.findings.some((f) => f.id === 'planetscale_not_authenticated' && /never logs in/.test(f.detail)));
  assert.equal(unauth.cli.meets_cloudflare_billing_minimum, true);
  assert.deepEqual(seen, ['version', 'auth check --format json'], 'no login, no create, no size read without auth');
  const old = await probePlanetScale({ manifest: manifest(), run: async (args) => (args[0] === 'version' ? { code: 0, stdout: 'pscale version 0.312.9' } : { code: 1, stdout: '{"authenticated":false}' }) });
  assert.ok(old.findings.some((f) => f.id === 'pscale_too_old'));
  assert.equal(versionAtLeast('v0.313.0', '0.313.0'), true);
  assert.equal(versionAtLeast('1.0.0', '0.313.0'), true);
  assert.equal(versionAtLeast('garbage', '0.313.0'), null);
});

test('PlanetScale probe keeps names only and never guesses an organization', async () => {
  const outputs = {
    version: 'pscale version 0.338.0',
    'auth check --format json': '{"authenticated":true,"auth_method":"oauth"}',
    'org list --format json': '[{"name":"freedom"}]',
    'database list --org freedom --format json': '[{"name":"freedom-next-pg","kind":"postgresql","region":{"slug":"ap-northeast"},"state":"ready","html_url":"https://secret.example/x","connection":"postgresql://u:p@h/db"}]',
    'region list --format json': '[{"slug":"ap-northeast","provider":"AWS","enabled":true,"postgresql_supported":true}]',
    'size cluster list --org freedom --engine postgresql --region ap-northeast --format json': '[{"name":"PS-5","rate":5}]',
  };
  const report = await probePlanetScale({ manifest: manifest(), run: async (args) => ({ code: 0, stdout: outputs[args.join(' ')] ?? '' }) });
  assert.equal(report.org, 'freedom');
  assert.deepEqual(report.databases, [{ name: 'freedom-next-pg', kind: 'postgresql', region: 'ap-northeast', state: 'ready' }]);
  assert.ok(report.findings.some((f) => f.id === 'database_name_taken'));
  assert.equal(report.region_choice[0].listed, true);
  assert.equal(report.sizes.region, 'ap-northeast');
  assert.doesNotMatch(JSON.stringify(report), /postgresql:\/\/|secret\.example/);

  const two = await probePlanetScale({ manifest: manifest(), run: async (args) => ({ code: 0, stdout: args[0] === 'org' ? '[{"name":"a"},{"name":"b"}]' : outputs[args.join(' ')] ?? '' }) });
  assert.ok(two.findings.some((f) => f.id === 'planetscale_org_ambiguous'));
  assert.equal(two.databases.length, 0);
});

test('PlanetScale parser reads actual CLI fields: postgresql_supported, cluster name vs display_name, rate and string replicas', async () => {
  assert.deepEqual(parseRegion({ slug: 'ap-northeast', provider: 'AWS', enabled: true, postgresql_supported: false }).postgres, false);
  assert.equal(parseRegion({ slug: 'x', postgresql_enabled: true }).postgres, true, 'older alias kept');
  assert.equal(parseRegion({ slug: 'x' }).postgres, null, 'unknown stays unknown');
  const actual = [
    { name: 'PS_5_AWS_ARM', display_name: 'PS-5', enabled: true, rate: 15, configuration: 'highly available', replicas: '2', replica_rate: 5 },
    { name: 'PS_5_AWS_ARM', display_name: 'PS-5', enabled: true, rate: 5, configuration: 'single node', replicas: '0', replica_rate: 5 },
    { name: 'PS_10_AWS_ARM', display_name: 'PS-10', enabled: true, rate: 41, configuration: 'highly available', replicas: '2' },
  ];
  assert.deepEqual(actual.map(parseSize), [
    { cluster: 'PS_5_AWS_ARM', display_name: 'PS-5', configuration: 'highly available', replicas: 2, rate_usd_month: 15, enabled: true },
    { cluster: 'PS_5_AWS_ARM', display_name: 'PS-5', configuration: 'single node', replicas: 0, rate_usd_month: 5, enabled: true },
    { cluster: 'PS_10_AWS_ARM', display_name: 'PS-10', configuration: 'highly available', replicas: 2, rate_usd_month: 41, enabled: true },
  ]);
  assert.deepEqual(parseSize({ display_name: 'PS-5' }), { cluster: null, display_name: 'PS-5', configuration: null, replicas: null, rate_usd_month: null, enabled: null }, 'display_name is never promoted to a CLI identifier; no zero price');

  const probe = (regions) => {
    const seen = [];
    const outputs = {
      version: 'pscale version 0.338.0',
      'auth check --format json': '{"authenticated":true,"auth_method":"oauth"}',
      'org list --format json': '[{"name":"ted-ted-h"}]',
      'database list --org ted-ted-h --format json': '[]',
      'region list --format json': JSON.stringify(regions),
      'size cluster list --org ted-ted-h --engine postgresql --region gcp-asia-northeast3 --format json': JSON.stringify(actual),
    };
    return probePlanetScale({ manifest: manifest(), run: async (args) => { seen.push(args.join(' ')); return { code: 0, stdout: outputs[args.join(' ')] ?? '' }; } }).then((r) => ({ r, seen }));
  };
  // Tokyo listed but not PostgreSQL-capable, Seoul true: Seoul is selected, Tokyo never claimed available.
  const { r } = await probe([{ slug: 'ap-northeast', provider: 'AWS', enabled: true, postgresql_supported: false }, { slug: 'gcp-asia-northeast3', provider: 'GCP', enabled: true, postgresql_supported: true }]);
  assert.deepEqual(r.region_choice.slice(0, 2).map((c) => [c.pscale_slug, c.listed, c.postgres]), [['ap-northeast', true, false], ['gcp-asia-northeast3', true, true]]);
  assert.equal(r.sizes.region, 'gcp-asia-northeast3');
  assert.equal(r.sizes.skus[0].cluster, 'PS_5_AWS_ARM');
  // Capability unknown everywhere: nothing selected, no size read.
  const unknown = await probe([{ slug: 'ap-northeast', provider: 'AWS', enabled: true }]);
  assert.ok(unknown.r.findings.some((f) => f.id === 'planetscale_region_unavailable'));
  assert.deepEqual(unknown.r.sizes, {});
  assert.ok(!unknown.seen.some((a) => a.startsWith('size')));
});

test('pscale child runner uses the process-scoped DBUS fallback and forwards no credentials', async () => {
  const source = { PATH: '/usr/bin', HOME: '/home/x', XDG_CONFIG_HOME: '/home/x/.config', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus', XDG_RUNTIME_DIR: '/run/user/1', CLOUDFLARE_API_TOKEN: FAKE_TOKEN, PLANETSCALE_SERVICE_TOKEN: 'pscale_tkn_secret', PGPASSWORD: 'pw' };
  const env = pscaleEnv(source);
  assert.deepEqual(env, { NO_COLOR: '1', PATH: '/usr/bin', HOME: '/home/x', XDG_CONFIG_HOME: '/home/x/.config', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null' });
  const calls = [];
  const execFileImpl = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); cb(null, '{"authenticated":true}', ''); };
  const out = await defaultRunner('/fake/pscale', { execFileImpl, source })(['auth', 'check', '--format', 'json']);
  assert.equal(out.code, 0);
  assert.deepEqual(calls[0].args, ['auth', 'check', '--format', 'json']);
  assert.equal(calls[0].opts.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/dev/null');
  assert.doesNotMatch(JSON.stringify(calls[0].opts.env), new RegExp(`${FAKE_TOKEN}|pscale_tkn|PGPASSWORD|/run/user`));
  assert.equal(source.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1/bus', 'caller environment untouched');
});

const TENANCY = 'ocid1.tenancy.oc1..aaaaaaaafaketenancyxyz';
const OCI_CONFIG = `[DEFAULT]\ntenancy=ocid1.tenancy.oc1..aaaaaaaadefaultxyz\n[oracle1]\nuser=ocid1.user.oc1..aaaaaaaauserxyz\nfingerprint=aa:bb\nkey_file=~/.oci/oracle1.pem\ntenancy=${TENANCY}\nregion=us-ashburn-1\n[oracle2]\ntenancy=ocid1.tenancy.oc1..aaaaaaaaothertenancy\n`;

function mockOci(overrides = {}) {
  const calls = [];
  const out = {
    'iam region-subscription list': { data: [{ 'region-name': 'us-ashburn-1', status: 'READY', 'is-home-region': true, 'tenancy-id': TENANCY }] },
    'iam compartment list': { data: [{ name: 'root-child', id: 'ocid1.compartment.oc1..aaaaaaaaxx' }] },
    'psql db-system list': { data: { items: [] } },
    'psql shape-summary list-shapes': { data: { items: [{ shape: 'PostgreSQL.VM.Standard.E5.Flex', 'is-flexible': true, id: 'ocid1.x.oc1..aaaa' }] } },
    'psql default-configuration-collection list-default-configurations': { data: { items: [{ 'display-name': 'PostgreSQL.VM.Standard.E5.Flex-18-generic', 'db-version': '18', 'is-flexible': true, id: 'ocid1.pgconfig.oc1..aaaa' }] } },
    'limits value list --service-name postgresql': { data: [{ name: 'dbsystem-count', 'scope-type': 'REGION', value: 0 }, { name: 'dbsystem-e5-count', 'scope-type': 'REGION', value: 20 }] },
    'limits definition list --service-name postgresql': { data: [{ name: 'dbsystem-count', 'is-deprecated': true, 'scope-type': 'REGION' }, { name: 'dbsystem-e5-count', 'is-deprecated': false, 'scope-type': 'REGION' }] },
    'limits value list --service-name container-instances': { data: [{ name: 'ci-count', 'scope-type': 'REGION', value: 5 }] },
    ...overrides,
  };
  const run = async (args, profile) => {
    calls.push({ args, profile });
    const key = Object.keys(out).find((k) => args.join(' ').startsWith(k));
    return key ? { code: 0, stdout: JSON.stringify(out[key]), stderr: '' } : { code: 1, stdout: '', stderr: 'ServiceError: {"code": "NotAuthorizedOrNotFound", "message": "denied for ocid1.tenancy.oc1..aaaaaaaafaketenancyxyz"}' };
  };
  return { run, calls };
}

test('OCI wrapper refuses profiles outside oracle1/oracle2 and reads only the tenancy key', async () => {
  for (const bad of ['DEFAULT', 'prod', 'oracle3', '../x']) {
    assert.throws(() => assertProfile(bad), /not allowed/);
    await assert.rejects(probeOci({ profile: bad, run: mockOci().run, readConfig: () => OCI_CONFIG }), /not allowed/);
  }
  assert.equal(tenancyFromConfig(OCI_CONFIG, 'oracle1'), TENANCY);
  assert.throws(() => tenancyFromConfig('[oracle1]\nregion=x\n', 'oracle1'), /no tenancy/);
  assert.throws(() => tenancyFromConfig('[oracle1]\ntenancy=$(touch_x)\n', 'oracle1'), /not an OCID/);
});

test('OCI argv allowlist refuses mutations and non-allowlisted reads', () => {
  for (const bad of [
    ['psql', 'db-system', 'create', '--from-json', 'file://x'],
    ['iam', 'compartment', 'create', '--name', 'freedom-next', '--compartment-id', TENANCY],
    ['iam', 'region-subscription', 'create', '--tenancy-id', TENANCY, '--region-key', 'NRT'],
    ['compute', 'instance', 'list', '--compartment-id', TENANCY],
    ['compute', 'instance', 'action', '--action', 'STOP'],
    ['limits', 'value', 'list', '--service-name', 'compute', '--compartment-id', TENANCY, '--all'],
    ['iam', 'region-subscription', 'list', '--tenancy-id', 'not-an-ocid'],
  ]) assert.throws(() => assertReadOnlyOciArgs(bad, TENANCY), /allowlist/, bad.join(' '));
  for (const build of Object.values(CHECKS)) assert.doesNotThrow(() => assertReadOnlyOciArgs(build(TENANCY), TENANCY));
});

test('OCI probe sanitizes output, interprets limits and never leaks OCIDs', async () => {
  const { run, calls } = mockOci({ 'limits value list --service-name container-instances': undefined });
  const report = await probeOci({ profile: 'oracle2', run, readConfig: () => OCI_CONFIG.replace('ocid1.tenancy.oc1..aaaaaaaaothertenancy', TENANCY) });
  assert.ok(calls.every((c) => c.profile === 'oracle2'));
  assert.equal(report.checks.regions.data[0].region, 'us-ashburn-1');
  assert.deepEqual(report.checks.compartments.data, { count: 1, freedom_named: [] });
  assert.equal(report.pg18_default_configs, 1);
  assert.equal(report.pg_limits.status, 'capacity_available');
  assert.equal(report.checks.ci_limit_values.status, 'error');
  const text = JSON.stringify(redactDeep(report));
  assert.doesNotMatch(text, /ocid1\./);
  assert.doesNotMatch(text, /tenancy-id|fingerprint|key_file|root-child/);
});

test('PG limit interpretation distinguishes deprecated aggregate, active zero and missing definitions', () => {
  const values = [{ name: 'dbsystem-count', value: 0 }, { name: 'dbsystem-e5-count', value: 20 }];
  assert.equal(interpretPgLimits(values, [{ name: 'dbsystem-count', deprecated: true }]).status, 'capacity_available');
  assert.equal(interpretPgLimits(values, [{ name: 'dbsystem-count', deprecated: false }]).status, 'blocked');
  assert.equal(interpretPgLimits(values, [{ name: 'dbsystem-e5-count', deprecated: false }]).status, 'unknown');
  assert.equal(interpretPgLimits(values, null).status, 'unknown');
  assert.equal(interpretPgLimits([{ name: 'dbsystem-count', value: 0 }, { name: 'dbsystem-e5-count', value: 0 }], [{ name: 'dbsystem-count', deprecated: true }]).status, 'blocked');
});

test('CLI: provider probes are opt-in; oci compare covers oracle2; bad profiles refused', async () => {
  const oci = mockOci();
  const pscale = [];
  const all = await run(['all'], { ociRun: oci.run, pscaleRun: async (a) => { pscale.push(a); return { code: 0, stdout: '' }; }, ociConfig: () => OCI_CONFIG });
  assert.equal(all.code, 0);
  assert.equal(oci.calls.length, 0, 'all does not touch OCI without --oci');
  assert.equal(pscale.length, 0, 'PlanetScale only runs on explicit request');
  const parsed = JSON.parse(all.output);
  assert.equal(parsed.cost.selected.total, 25);
  assert.equal(parsed.cost.selected.total_status, 'computed');
  assert.equal(parsed.oci_alternative.quota.status, 'blocked');
  assert.equal(parsed.provider_mutations, 0);
  assert.equal(parsed.plan.length, 2);
  const cmp = await run(['oci', '--compare'], { ociRun: oci.run, ociConfig: () => OCI_CONFIG });
  assert.deepEqual(JSON.parse(cmp.output).oci.map((r) => r.profile), ['oracle1', 'oracle2']);
  assert.doesNotMatch(cmp.output, /ocid1\./);
  await assert.rejects(run(['oci', '--oci-profile', 'DEFAULT'], { ociRun: oci.run, ociConfig: () => OCI_CONFIG }), /not allowed/);
  assert.equal((await run(['oci', '--execute'])).code, 3);
});

test('migrations are PostgreSQL-18 managed-service compatible, ledger digest matches the repo runner', () => {
  const expected = manifest().database_defaults.migrations;
  const result = checkMigrations(join(ROOT, 'migrations'), expected);
  assert.equal(result.ok, true, JSON.stringify(result.problems.concat(result.privileged)));
  assert.equal(result.count, 36);
  assert.deepEqual(result.known_gaps, [22]);
  assert.equal(result.last, '037_member_channels.sql');
  const sql = readFileSync(join(ROOT, 'migrations', '001_local_core.sql'), 'utf8');
  assert.equal(result.ledger[0].sha256, migrationDigest(sql));
  // packages/db digest(sql) hashes JSON.stringify(sql); keep the two in lockstep.
  assert.match(readFileSync(join(ROOT, 'packages', 'db', 'index.ts'), 'utf8'), /createHash\('sha256'\)\.update\(JSON\.stringify\(stable\(value\)\)\)/);
});

test('migration scanner flags privileged statements and unexpected gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-mig-'));
  writeFileSync(join(dir, '001_a.sql'), 'CREATE EXTENSION pgcrypto;\n-- CREATE ROLE in a comment is ignored\n');
  writeFileSync(join(dir, '003_c.sql'), 'ALTER TABLE t OWNER TO someone;');
  const result = checkMigrations(dir, { first: 1, last: 3, known_gaps: [] });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /unexpected gaps: 2/.test(p)));
  assert.ok(result.privileged.some((p) => /CREATE EXTENSION/.test(p.statement)));
  assert.ok(result.privileged.some((p) => /OWNER TO/.test(p.statement)));
  assert.ok(!result.privileged.some((p) => /role management/.test(p.statement)));
});

// Mirrors the runtime wrangler.jsonc (runtime worktree commit f089a84): placeholder ids, no routes, no release SHA.
const RUNTIME_CONFIG = {
  name: 'freedom-platform-local', main: 'apps/platform-api/src/worker.ts', compatibility_date: '2026-09-21', compatibility_flags: ['nodejs_compat'],
  workers_dev: false, preview_urls: false,
  assets: { directory: 'apps/portal-web/dist', binding: 'ASSETS', run_worker_first: true, html_handling: 'auto-trailing-slash', not_found_handling: 'none' },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: '0'.repeat(32) }],
  images: { binding: 'IMAGES' },
  vars: { FREEDOM_ENV: 'local', APP_ORIGIN: 'http://127.0.0.1:8787' },
  env: {
    'staging-next': { name: 'freedom-platform-staging-next', workers_dev: false, preview_urls: false, hyperdrive: [{ binding: 'HYPERDRIVE', id: '0'.repeat(32) }], images: { binding: 'IMAGES' }, vars: { FREEDOM_ENV: 'staging', APP_ORIGIN: 'https://staging-next.freetwai.com', FREEDOM_TRUST_CF_CONNECTING_IP: 'true' } },
    next: { name: 'freedom-platform-next', workers_dev: false, preview_urls: false, hyperdrive: [{ binding: 'HYPERDRIVE', id: '0'.repeat(32) }], images: { binding: 'IMAGES' }, vars: { FREEDOM_ENV: 'public', APP_ORIGIN: 'https://next.freetwai.com', FREEDOM_TRUST_CF_CONNECTING_IP: 'true' } },
  },
};
const ID_S = '1'.repeat(32);
const ID_N = '2'.repeat(32);
function writeWrangler(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-wr-'));
  const f = join(dir, 'wrangler.jsonc');
  writeFileSync(f, `// comment\n${JSON.stringify(obj, null, 2).replace(/}$/, ',}')}`);
  return f;
}
function provisioned() {
  const c = clone(RUNTIME_CONFIG);
  c.env['staging-next'].hyperdrive[0].id = ID_S;
  c.env.next.hyperdrive[0].id = ID_N;
  c.env['staging-next'].routes = [{ pattern: 'staging-next.freetwai.com', custom_domain: true }];
  c.env.next.routes = [{ pattern: 'next.freetwai.com', custom_domain: true }];
  return c;
}
const cachingOff = { [ID_S]: { caching: { disabled: true } }, [ID_N]: { caching: { disabled: true } } };

test('wrangler: runtime config with placeholder ids is structurally valid but not deployment-ready', () => {
  const r = checkWranglerConfig(writeWrangler(RUNTIME_CONFIG), manifest());
  assert.equal(r.status, 'pass');
  assert.equal(r.structural, 'valid');
  assert.equal(r.deployment_ready, false);
  assert.deepEqual(r.errors, []);
  for (const env of ['staging-next', 'next']) {
    assert.ok(r.readiness_blockers.some((b) => b.startsWith(`${env}: Hyperdrive id is the placeholder`)), env);
    assert.ok(r.required_injections.some((i) => i.startsWith(`${env}: FREEDOM_RELEASE_SHA via`)), env);
  }
  assert.ok(!r.readiness_blockers.some((b) => /shared/.test(b)) && !r.errors.some((e) => /shared/.test(e)), 'identical placeholders are not a sharing error');
});

test('wrangler: provisioned ids still need a provider caching.disabled read; only then static checks pass', () => {
  const noRead = checkWranglerConfig(writeWrangler(provisioned()), manifest());
  assert.equal(noRead.structural, 'valid');
  assert.equal(noRead.deployment_ready, false);
  assert.equal(noRead.readiness_blockers.filter((b) => /caching\.disabled not read/.test(b)).length, 2);
  const ready = checkWranglerConfig(writeWrangler(provisioned()), manifest(), { hyperdriveConfigs: cachingOff });
  assert.deepEqual([ready.structural, ready.static_checks_pass, ready.readiness_blockers], ['valid', true, []]);
  assert.equal(ready.deployment_ready, false, 'static checks alone are not deployment readiness');
});

test('wrangler: real-shaped ids, cache-off read-back and valid routes are still not deployment-ready without release SHA and secrets', () => {
  const r = checkWranglerConfig(writeWrangler(provisioned()), manifest(), { hyperdriveConfigs: cachingOff });
  assert.equal(r.status, 'pass');
  assert.equal(r.static_checks_pass, true);
  assert.equal(r.deployment_ready, false);
  assert.match(r.deployment_ready_scope, /required injection/);
  for (const env of ['staging-next', 'next']) {
    assert.ok(r.required_injections.some((i) => i.startsWith(`${env}: FREEDOM_RELEASE_SHA via`)), env);
    for (const secret of ['GITHUB_SOCIAL_TOKEN_KEY', 'FREEDOM_ADMIN_CSRF_SECRET']) assert.ok(r.required_injections.includes(`${env}: secret ${secret} (wrangler secret put)`), `${env} ${secret}`);
    assert.ok(r.required_injections.some((i) => i === `${env}: var FREEDOM_DATABASE_NAME supplied outside the config`), env);
  }
});

test('wrangler: exact two-env mocks catch every binding, cache, id, origin, Images and release mistake', () => {
  const cases = [
    ['wrong binding', (c) => { c.env.next.hyperdrive[0].binding = 'DB_FRESH'; }, /DB_FRESH is not HYPERDRIVE/],
    ['extra binding', (c) => { c.env.next.hyperdrive.push({ binding: 'DB_CACHED', id: '3'.repeat(32) }); }, /exactly one Hyperdrive binding/],
    ['missing binding', (c) => { delete c.env.next.hyperdrive; }, /exactly one Hyperdrive binding required, found 0/],
    ['cached true', null, /caching is not disabled/],
    ['shared ids', (c) => { c.env.next.hyperdrive[0].id = ID_S; }, /shared with staging-next/],
    ['bad id', (c) => { c.env.next.hyperdrive[0].id = 'xyz'; }, /32-hex/],
    ['wrong origin', (c) => { c.env.next.vars.APP_ORIGIN = 'https://freetwai.com'; }, /APP_ORIGIN must be https:\/\/next\.freetwai\.com/],
    ['wrong FREEDOM_ENV', (c) => { c.env['staging-next'].vars.FREEDOM_ENV = 'public'; }, /FREEDOM_ENV must be staging/],
    ['missing Images', (c) => { delete c.env.next.images; }, /images binding IMAGES is required/],
    ['wrong assets binding', (c) => { c.assets.binding = 'STATIC'; }, /assets binding must be ASSETS/],
    ['assets not worker-first', (c) => { c.assets.run_worker_first = false; }, /run_worker_first/],
    ['bad release SHA', (c) => { c.env.next.vars.FREEDOM_RELEASE_SHA = 'main'; }, /40-hex commit SHA/],
    ['source IP flag', (c) => { delete c.env.next.vars.FREEDOM_TRUST_CF_CONNECTING_IP; }, /FREEDOM_TRUST_CF_CONNECTING_IP/],
    ['compat date', (c) => { c.compatibility_date = '2026-01-01'; }, /compatibility_date/],
    ['nodejs_compat', (c) => { c.compatibility_flags = []; }, /nodejs_compat/],
    ['preview urls', (c) => { delete c.env.next.preview_urls; delete c.preview_urls; }, /preview_urls/],
    ['protected route', (c) => { c.env.next.routes.push({ pattern: 'freetwai.com/*', zone_name: 'freetwai.com' }); }, /protected/],
    ['secret var', (c) => { c.env.next.vars.GITHUB_SOCIAL_TOKEN_KEY = 'x'; }, /must be a secret/],
    ['missing env', (c) => { delete c.env['staging-next']; }, /staging-next: no env block/],
    ['extra env', (c) => { c.env.prod = { name: 'freedom-platform-prod', routes: ['prod.freetwai.com/*'] }; }, /not in the manifest/],
    ['wrong worker name', (c) => { c.env.next.name = 'freedom-platform'; }, /name must be freedom-platform-next/],
    ['remote local string', (c) => { c.env.next.hyperdrive[0].localConnectionString = 'postgres://u:p@db.example:5432/x'; }, /loopback/],
  ];
  for (const [label, mutate, expected] of cases) {
    const c = provisioned();
    if (mutate) mutate(c);
    const configs = label === 'cached true' ? { [ID_S]: { caching: { disabled: true } }, [ID_N]: { caching: { disabled: false } } } : cachingOff;
    const r = checkWranglerConfig(writeWrangler(c), manifest(), { hyperdriveConfigs: configs });
    assert.equal(r.structural, 'invalid', label);
    assert.equal(r.deployment_ready, false, label);
    assert.ok(r.errors.some((e) => expected.test(e)), `${label}: ${expected} not in ${r.errors.join(' | ')}`);
  }
  const hard = provisioned();
  hard.env.next.vars.FREEDOM_RELEASE_SHA = 'f'.repeat(40);
  assert.ok(checkWranglerConfig(writeWrangler(hard), manifest(), { hyperdriveConfigs: cachingOff }).warnings.some((w) => /hardcoded/.test(w)));
  assert.equal(checkWranglerConfig(join(tmpdir(), 'fp-missing-wrangler.jsonc'), manifest()).status, 'not_run');
  assert.deepEqual(parseJsonc('{"a":"// not a comment", /* x */ "b":[1,],}'), { a: '// not a comment', b: [1] });
});

test('Hyperdrive caching read-back is GET-only, skips placeholders, and maps caching.disabled', async () => {
  const cfg = (disabled) => ({ status: 200, body: { success: true, result: { id: 'x', caching: { disabled }, origin: { password: 'never' } } } });
  const { fetchImpl, calls } = mockCloudflare({ [`/accounts/${ACCOUNT}/hyperdrive/configs/${ID_S}`]: cfg(true), [`/accounts/${ACCOUNT}/hyperdrive/configs/${ID_N}`]: cfg(false) });
  const client = createReadOnlyClient({ credentials: { authorizationHeader: () => `Bearer ${FAKE_TOKEN}` }, fetchImpl });
  const out = await readHyperdriveCaching({ client, accountId: ACCOUNT, ids: [ID_S, ID_N, '0'.repeat(32)] });
  assert.deepEqual(out, { [ID_S]: { caching: { disabled: true } }, [ID_N]: { caching: { disabled: false } } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.doesNotMatch(JSON.stringify(out), /never/);
});

test('CLI wrangler with a fake env file reads caching back through the mock only', async () => {
  const { fetchImpl, calls } = mockCloudflare({
    [`/accounts/${ACCOUNT}/hyperdrive/configs/${ID_S}`]: { status: 200, body: { success: true, result: { caching: { disabled: true } } } },
    [`/accounts/${ACCOUNT}/hyperdrive/configs/${ID_N}`]: { status: 200, body: { success: true, result: { caching: { disabled: true } } } },
  });
  const envFile = privateEnvFile(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${FAKE_TOKEN}\n`);
  const out = await run(['wrangler', '--config', writeWrangler(provisioned()), '--env-file', envFile], { fetchImpl });
  assert.equal(out.code, 0);
  const wr = JSON.parse(out.output).wrangler;
  assert.deepEqual([wr.static_checks_pass, wr.deployment_ready], [true, false]);
  assert.ok(calls.every((c) => c.method === 'GET' && /hyperdrive\/configs\//.test(c.url)));
  assert.doesNotMatch(out.output, new RegExp(`${FAKE_TOKEN}|${ACCOUNT}`));
});

test('redaction removes bearer tokens, connection strings, ids and secret fields', () => {
  const text = redactText(`Authorization: Bearer ${FAKE_TOKEN}\npostgresql://user:pw@host:5432/db pscale_pw_abc123 id ${ACCOUNT} token=${FAKE_TOKEN} sha ${'d'.repeat(40)}`);
  assert.doesNotMatch(text, new RegExp(`${FAKE_TOKEN}|user:pw|pscale_pw_abc|${ACCOUNT}`));
  assert.match(text, new RegExp('d'.repeat(40)), 'git SHAs stay readable');
  assert.deepEqual(redactDeep({ api_token: 'abc', nested: { connection_string: 'x' } }), { api_token: '[redacted]', nested: { connection_string: '[redacted]' } });
});

test('CLI: offline commands succeed, --execute is refused, reports are private', async () => {
  assert.equal((await run(['manifest'])).code, 0);
  assert.equal((await run(['migrations'])).code, 0);
  assert.equal((await run(['plan', '--env', 'next'])).code, 0);
  const refused = await run(['plan', '--env', 'next', '--execute']);
  assert.equal(refused.code, 3);
  assert.match(refused.output, /no execute capability/);
  assert.equal((await run(['all', '--execute'])).code, 3);
  await assert.rejects(run(['plan', '--env', 'next', '--force']), /Unknown option/);
  const reportDir = join(mkdtempSync(join(tmpdir(), 'fp-rep-')), 'reports');
  const out = await run(['manifest', '--report'], { reportDir });
  const file = JSON.parse(out.output).report_file;
  assert.equal(statSync(reportDir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const { fetchImpl, calls } = mockCloudflare();
  const envFile = privateEnvFile(`CF_ACCOUNT_ID=${ACCOUNT}\nCF_API_TOKEN=${FAKE_TOKEN}\n`);
  const cf = await run(['cloudflare', '--env-file', envFile], { fetchImpl });
  const conflictFile = privateEnvFile(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nCLOUDFLARE_API_TOKEN=${FAKE_TOKEN}\nCF_API_TOKEN=x${FAKE_TOKEN}\n`);
  await assert.rejects(run(['cloudflare', '--env-file', conflictFile], { fetchImpl }), (e) => /different values/.test(e.message) && !e.message.includes(FAKE_TOKEN));
  assert.equal(cf.code, 0);
  assert.equal(JSON.parse(cf.output).provider_mutations, 0);
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.doesNotMatch(cf.output, new RegExp(`${FAKE_TOKEN}|${ACCOUNT}`));
});

test('docs: relative links in the migration runbook and README resolve', () => {
  for (const doc of ['docs/development/cloudflare-migration.md', 'deploy/cloudflare/README.md']) {
    const path = join(ROOT, doc);
    const text = readFileSync(path, 'utf8');
    const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]).filter((l) => !/^(https?:|mailto:|#)/.test(l));
    assert.ok(links.length > 0, `${doc} has relative links`);
    for (const link of links) {
      const target = resolve(dirname(path), link.split('#')[0]);
      assert.doesNotThrow(() => statSync(target), `${doc}: broken link ${link}`);
    }
  }
});

test('default `all` makes no network call and renders both plans read-only', async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('network forbidden in tests'); };
  try {
    const out = await run(['all'], { ociRun: async () => { throw new Error('oci forbidden'); }, pscaleRun: async () => { throw new Error('pscale forbidden'); } });
    assert.equal(out.code, 0);
    const r = JSON.parse(out.output);
    assert.equal(r.provider_mutations, 0);
    assert.equal(r.dry_run, true);
    assert.ok(!('cloudflare' in r) && !('oci' in r) && !('planetscale' in r));
  } finally { globalThis.fetch = original; }
  assert.equal(fetched, 0);
});
