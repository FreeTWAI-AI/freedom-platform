import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { loadCloudflareCredentials, parseAllowlistedEnv } from '../lib/credentials.mjs';
import { createReadOnlyClient, probeCloudflare } from '../lib/cloudflare.mjs';
import { assertMutationTarget, loadManifest, validateManifest } from '../lib/manifest.mjs';
import { checkMigrations, migrationDigest } from '../lib/migrations.mjs';
import { assertReadOnlyArgs, probePlanetScale } from '../lib/planetscale.mjs';
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

test('manifest is valid and keeps environments, names and budget segregated', () => {
  const result = validateManifest(manifest());
  assert.deepEqual(result.errors, []);
  assert.ok(result.database_monthly_usd_after_resize_gates <= manifest().database_defaults.monthly_budget_usd.database_base_cap_without_new_approval);
});

test('manifest rejects unsafe configurations', () => {
  const cases = [
    [(m) => { m.environments.next.worker.preview_urls = true; }, /preview_urls/],
    [(m) => { m.environments.next.worker.workers_dev = true; }, /workers_dev/],
    [(m) => { m.environments.next.hostname = 'freetwai.com'; }, /hostname/],
    [(m) => { m.environments.next.hyperdrive[0].caching_disabled = false; }, /caching disabled/],
    [(m) => { m.environments.next.hyperdrive[0].name = 'freedom-staging-next-fresh'; }, /prefix|shared/],
    [(m) => { m.environments['staging-next'].data_source = 'rehearsal-restore-of-public-backup'; }, /synthetic/],
    [(m) => { m.environments.next.database.topology = 'single_node'; }, /HA/],
    [(m) => { m.database_defaults.engine = 'mysql'; }, /not Vitess/],
    [(m) => { m.database_defaults.major_version = 17; }, /18/],
    [(m) => { m.environments.next.var_names.push('GITHUB_SOCIAL_TOKEN_KEY'); }, /secret/],
    [(m) => { m.environments.next.secret_names.push('DATABASE_URL'); }, /Hyperdrive binding/],
    [(m) => { m.environments.next.access.application_name = 'Freedom staging'; }, /protected/],
    [(m) => { m.environments.next.database.resize_gate.catalog_monthly_usd = 500; }, /exceeds cap/],
    [(m) => { m.protected.hostnames = ['freetwai.com']; }, /staging\.freetwai\.com/],
  ];
  for (const [mutate, expected] of cases) {
    const m = clone(manifest());
    mutate(m);
    const result = validateManifest(m);
    assert.equal(result.ok, false, `expected failure for ${expected}`);
    assert.ok(result.errors.some((e) => expected.test(e)), `${expected} not in ${result.errors.join(' | ')}`);
  }
});

test('mutation guard is default-deny and protects the old hosts', () => {
  const m = manifest();
  assert.ok(assertMutationTarget(m, 'next', 'worker', 'freedom-platform-next'));
  assert.ok(assertMutationTarget(m, 'staging-next', 'hyperdrive', 'freedom-staging-next-fresh'));
  assert.throws(() => assertMutationTarget(m, 'next', 'hostname', 'freetwai.com'), /protected/);
  assert.throws(() => assertMutationTarget(m, 'next', 'hostname', 'staging.freetwai.com'), /protected/);
  assert.throws(() => assertMutationTarget(m, 'next', 'access_application', 'Freedom staging'), /protected/);
  assert.throws(() => assertMutationTarget(m, 'next', 'database', 'freedom_public'), /protected/);
  assert.throws(() => assertMutationTarget(m, 'next', 'tunnel', 'freedom-staging'), /never mutated/);
  assert.throws(() => assertMutationTarget(m, 'next', 'worker', 'freedom-platform-staging-next'), /not owned/);
  assert.throws(() => assertMutationTarget(m, 'next', 'r2_bucket', 'ai-sister'), /not owned/);
  assert.throws(() => assertMutationTarget(m, 'prod', 'worker', 'x'), /Unknown environment/);
});

test('provision plan is dry-run, guarded, and free of secrets in argv', () => {
  for (const env of ['staging-next', 'next']) {
    const plan = buildProvisionPlan(manifest(), env);
    assert.equal(plan.dry_run, true);
    const text = JSON.stringify(plan);
    assert.doesNotMatch(text, /postgres(ql)?:\/\/|--connection-string|PGPASSWORD|password=/i);
    assert.equal(plan.hostname, `${env}.freetwai.com`);
    assert.ok(plan.steps.findIndex((s) => s.id === 'access-app') < plan.steps.findIndex((s) => s.id === 'deploy'), 'Access before deploy');
    const fresh = plan.steps.find((s) => s.id === 'hyperdrive-fresh');
    assert.match(fresh.command, /caching\.disabled=true/);
  }
  const staging = JSON.stringify(buildProvisionPlan(manifest(), 'staging-next'));
  assert.match(staging, /Never run seedLocal/);
  assert.doesNotMatch(staging, /pg_restore/);
  assert.match(JSON.stringify(buildProvisionPlan(manifest(), 'next')), /NEW GITHUB_SOCIAL_TOKEN_KEY/);
});

test('credential loader keeps only allowlisted keys and refuses readable files', () => {
  const parsed = parseAllowlistedEnv(`# c\nCF_ACCOUNT_ID=${ACCOUNT}\nexport CF_API_TOKEN="${FAKE_TOKEN}"\nOTHER_SECRET=nope\n`, ['CF_ACCOUNT_ID', 'CF_API_TOKEN']);
  assert.deepEqual(Object.keys(parsed).sort(), ['CF_ACCOUNT_ID', 'CF_API_TOKEN']);
  assert.throws(() => loadCloudflareCredentials(privateEnvFile(`CF_ACCOUNT_ID=${ACCOUNT}\nCF_API_TOKEN=${FAKE_TOKEN}\n`, 0o644)), /chmod 600/);
  assert.throws(() => loadCloudflareCredentials(privateEnvFile(`CF_ACCOUNT_ID=${ACCOUNT}\n`)), /Missing CF_API_TOKEN/);
  const creds = loadCloudflareCredentials(privateEnvFile(`CF_ACCOUNT_ID=${ACCOUNT}\nCF_API_TOKEN=${FAKE_TOKEN}\n`));
  assert.doesNotMatch(JSON.stringify(creds), new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(inspect(creds), new RegExp(FAKE_TOKEN));
  assert.doesNotMatch(String(creds), new RegExp(FAKE_TOKEN));
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
  assert.ok(unauth.findings.some((f) => f.id === 'planetscale_login_required'));
  assert.deepEqual(seen, ['version', 'auth check --format json']);
});

test('PlanetScale probe keeps names only and never guesses an organization', async () => {
  const outputs = {
    version: 'pscale version 0.338.0',
    'auth check --format json': '{"authenticated":true,"auth_method":"oauth"}',
    'org list --format json': '[{"name":"freedom"}]',
    'database list --org freedom --format json': '[{"name":"freedom-next","kind":"postgresql","region":{"slug":"ap-northeast"},"state":"ready","html_url":"https://secret.example/x","connection":"postgresql://u:p@h/db"}]',
    'region list --format json': '[{"slug":"ap-northeast","provider":"AWS","enabled":true}]',
    'size cluster list --org freedom --engine postgresql --region ap-northeast --format json': '[{"name":"PS-5","rate":5}]',
  };
  const report = await probePlanetScale({ manifest: manifest(), run: async (args) => ({ code: 0, stdout: outputs[args.join(' ')] ?? '' }) });
  assert.equal(report.org, 'freedom');
  assert.deepEqual(report.databases, [{ name: 'freedom-next', kind: 'postgresql', region: 'ap-northeast', state: 'ready' }]);
  assert.ok(report.findings.some((f) => f.id === 'database_name_taken'));
  assert.equal(report.region_choice[0].listed, true);
  assert.equal(report.sizes.region, 'ap-northeast');
  assert.doesNotMatch(JSON.stringify(report), /postgresql:\/\/|secret\.example/);

  const two = await probePlanetScale({ manifest: manifest(), run: async (args) => ({ code: 0, stdout: args[0] === 'org' ? '[{"name":"a"},{"name":"b"}]' : outputs[args.join(' ')] ?? '' }) });
  assert.ok(two.findings.some((f) => f.id === 'planetscale_org_ambiguous'));
  assert.equal(two.databases.length, 0);
});

test('migrations are PlanetScale-compatible, ledger digest matches the repo runner', () => {
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

test('wrangler config checker enforces no public preview and candidate-only routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-wr-'));
  const write = (obj) => { const f = join(dir, `w${Math.random()}.jsonc`); writeFileSync(f, `// comment\n${JSON.stringify(obj, null, 2).replace(/}$/, ',}')}`); return f; };
  const good = {
    name: 'freedom-platform', workers_dev: false, preview_urls: false,
    env: {
      'staging-next': { workers_dev: false, preview_urls: false, routes: [{ pattern: 'staging-next.freetwai.com', custom_domain: true }], hyperdrive: [{ binding: 'DB_FRESH', id: '1'.repeat(32) }], vars: { APP_ORIGIN: 'https://staging-next.freetwai.com' } },
      next: { workers_dev: false, preview_urls: false, routes: [{ pattern: 'next.freetwai.com', custom_domain: true }], hyperdrive: [{ binding: 'DB_FRESH', id: '2'.repeat(32) }], vars: { APP_ORIGIN: 'https://next.freetwai.com' } },
    },
  };
  assert.equal(checkWranglerConfig(write(good), manifest()).status, 'pass');
  const bad = clone(good);
  delete bad.env.next.preview_urls; delete bad.preview_urls;
  bad.env.next.routes.push({ pattern: 'freetwai.com/*', zone_name: 'freetwai.com' });
  bad.env['staging-next'].hyperdrive[0].id = '2'.repeat(32);
  bad.env.next.vars.GITHUB_SOCIAL_TOKEN_KEY = 'x';
  const result = checkWranglerConfig(write(bad), manifest());
  assert.equal(result.status, 'fail');
  for (const re of [/preview_urls/, /protected/, /shared/, /must be a secret/]) assert.ok(result.errors.some((e) => re.test(e)), String(re));
  assert.equal(checkWranglerConfig(join(dir, 'missing.jsonc'), manifest()).status, 'not_run');
  assert.deepEqual(parseJsonc('{"a":"// not a comment", /* x */ "b":[1,],}'), { a: '// not a comment', b: [1] });
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
  await assert.rejects(run(['plan', '--env', 'next', '--force']), /Unknown option/);
  const reportDir = join(mkdtempSync(join(tmpdir(), 'fp-rep-')), 'reports');
  const out = await run(['manifest', '--report'], { reportDir });
  const file = JSON.parse(out.output).report_file;
  assert.equal(statSync(reportDir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const { fetchImpl, calls } = mockCloudflare();
  const envFile = privateEnvFile(`CF_ACCOUNT_ID=${ACCOUNT}\nCF_API_TOKEN=${FAKE_TOKEN}\n`);
  const cf = await run(['cloudflare', '--env-file', envFile], { fetchImpl });
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
