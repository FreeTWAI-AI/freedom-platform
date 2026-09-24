import { createHash } from 'node:crypto';
import { redactText } from './redact.mjs';

export const API_BASE = 'https://api.cloudflare.com/client/v4';

// Exhaustive list of paths the preflight may request. There is intentionally no non-GET code path.
const READ_PATHS = [
  /^\/user\/tokens\/verify$/,
  /^\/user\/tokens\/[0-9a-f]{32}$/,
  /^\/accounts\/[0-9a-f]{32}$/,
  /^\/accounts\/[0-9a-f]{32}\/(workers\/scripts|workers\/subdomain|workers\/domains|hyperdrive\/configs|r2\/buckets|queues|access\/apps|subscriptions)$/,
  /^\/accounts\/[0-9a-f]{32}\/hyperdrive\/configs\/[0-9a-f]{32}$/,
  /^\/accounts\/[0-9a-f]{32}\/cfd_tunnel\?is_deleted=false&per_page=100$/,
  /^\/zones\?name=[a-z0-9.-]+$/,
  /^\/zones\/[0-9a-f]{32}$/,
  /^\/zones\/[0-9a-f]{32}\/(workers\/routes|rulesets\/phases\/http_request_cache_settings\/entrypoint)$/,
  /^\/zones\/[0-9a-f]{32}\/dns_records\?per_page=500$/,
];

export function createReadOnlyClient({ credentials, fetchImpl = globalThis.fetch }) {
  async function get(path) {
    if (!READ_PATHS.some((re) => re.test(path))) throw new Error(`Path not in read-only allowlist: ${redactText(path)}`);
    let res;
    try {
      res = await fetchImpl(API_BASE + path, { method: 'GET', headers: { Authorization: credentials.authorizationHeader(), Accept: 'application/json' }, redirect: 'error' });
    } catch (error) {
      return { http: 0, success: false, errors: [{ code: 'network', message: redactText(error?.message ?? error) }], result: null };
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return {
      http: res.status,
      success: Boolean(body?.success),
      errors: (body?.errors ?? []).map((e) => ({ code: e.code ?? null, message: redactText(e.message ?? '') })),
      result: body?.result ?? null,
    };
  }
  return Object.freeze({ get });
}

// Each capability: the read probe that proves visibility, and the permission groups the later
// provisioning phase needs. Permission names follow developers.cloudflare.com/fundamentals/api/reference/permissions/.
export const CAPABILITIES = [
  { id: 'workers_scripts', scope: 'account', path: (a) => `/accounts/${a}/workers/scripts`, read: 'Workers Scripts Read', write: 'Workers Scripts Edit', needed_for: 'upload Worker versions, secrets and custom domains for staging-next / next' },
  { id: 'workers_subdomain', scope: 'account', path: (a) => `/accounts/${a}/workers/subdomain`, read: 'Workers Scripts Read', write: null, needed_for: 'confirm workers.dev stays disabled for Freedom Workers' },
  { id: 'workers_custom_domains', scope: 'account', path: (a) => `/accounts/${a}/workers/domains`, read: 'Workers Scripts Read', write: 'Workers Scripts Edit', needed_for: 'attach staging-next / next custom domains' },
  { id: 'hyperdrive', scope: 'account', path: (a) => `/accounts/${a}/hyperdrive/configs`, read: 'Hyperdrive Read', write: 'Hyperdrive Edit', needed_for: 'one cache-disabled Hyperdrive config (binding HYPERDRIVE) per environment; caching.disabled must be read back before deploy' },
  { id: 'r2', scope: 'account', path: (a) => `/accounts/${a}/r2/buckets`, read: 'Workers R2 Storage Read', write: 'Workers R2 Storage Edit', needed_for: 'private per-environment buckets (optional until the Worker binds R2)' },
  { id: 'queues', scope: 'account', optional: true, path: (a) => `/accounts/${a}/queues`, read: 'Queues Read', write: null, needed_for: 'not needed for this migration; recorded for completeness' },
  { id: 'access_apps', scope: 'account', path: (a) => `/accounts/${a}/access/apps`, read: 'Access: Apps and Policies Read', write: 'Access: Apps and Policies Edit', needed_for: 'protect staging-next / next and their /admin paths before any Worker route is live' },
  { id: 'tunnels', scope: 'account', path: (a) => `/accounts/${a}/cfd_tunnel?is_deleted=false&per_page=100`, read: 'Cloudflare Tunnel Read', write: null, needed_for: 'baseline of existing tunnels (read-only protection check)' },
  { id: 'subscriptions', scope: 'account', path: (a) => `/accounts/${a}/subscriptions`, read: 'Billing Read', write: null, needed_for: 'confirm whether Workers Paid is active (CPU limits for password hashing)' },
  { id: 'zone', scope: 'zone', path: (_a, z) => `/zones/${z}`, read: 'Zone Read', write: null, needed_for: 'zone identity and plan' },
  { id: 'dns', scope: 'zone', path: (_a, z) => `/zones/${z}/dns_records?per_page=500`, read: 'DNS Read', write: 'DNS Edit', needed_for: 'protected-host baseline; candidate hostnames must be absent before provisioning' },
  { id: 'workers_routes', scope: 'zone', path: (_a, z) => `/zones/${z}/workers/routes`, read: 'Workers Routes Read', write: 'Workers Routes Edit', needed_for: 'prove no Worker route overlaps freetwai.com or staging.freetwai.com' },
  { id: 'cache_rules', scope: 'zone', path: (_a, z) => `/zones/${z}/rulesets/phases/http_request_cache_settings/entrypoint`, read: 'Cache Rules Read', write: null, needed_for: 'prove no cache rule caches /api/* or session responses' },
];

// Groups that make a token unsuitable for automation even if it can read what we need.
export const DANGEROUS_GROUPS = ['API Tokens Write', 'API Tokens Edit', 'Account Settings Write', 'Account Settings Edit', 'Billing Write', 'Billing Edit'];

export function classify(response) {
  if (response.http === 200 && response.success) return 'granted';
  if (response.http === 404 && response.errors.some((e) => e.code === 10007 || /not found/i.test(e.message))) return 'granted_empty';
  if (response.http === 403 || response.errors.some((e) => e.code === 10000 || e.code === 9109)) return 'missing_permission';
  if (response.http === 401) return 'invalid_token';
  return 'error';
}

function countResult(result) {
  if (Array.isArray(result)) return result.length;
  if (result && Array.isArray(result.buckets)) return result.buckets.length;
  if (result && Array.isArray(result.rules)) return result.rules.length;
  return result ? 1 : 0;
}

export function fingerprintRecord(record) {
  return createHash('sha256').update(`${record.type}|${record.content}|${record.proxied}`).digest('hex').slice(0, 16);
}

export function consoleActionForMissing(groups) {
  const account = groups.filter((g) => g.scope === 'account').map((g) => g.group);
  const zone = groups.filter((g) => g.scope === 'zone').map((g) => g.group);
  return [
    'Cloudflare dashboard → My Profile → API Tokens → Create Token → Create Custom Token (performed by the account owner, not by this tool).',
    'Name it for one purpose, e.g. "freedom-cf-readonly-preflight"; do NOT add API Tokens, Billing Edit or Account Settings Edit.',
    account.length ? `Permissions → Account → ${[...new Set(account)].join(', ')}; Account Resources → Include → the Freedom account only.` : null,
    zone.length ? `Permissions → Zone → ${[...new Set(zone)].join(', ')}; Zone Resources → Include → Specific zone → freetwai.com.` : null,
    'Client IP Address Filtering → operator host egress IP; TTL → end of the rehearsal window.',
    'Save the token only into a new chmod 600 file (e.g. ~/.config/freedom-cloudflare/readonly.env with CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN; legacy CF_* names also accepted); never paste it into chat, repo or command arguments.',
  ].filter(Boolean);
}

export async function probeCloudflare({ client, accountId, manifest }) {
  const report = { capabilities: [], token: {}, zone: {}, protected_baseline: {}, findings: [] };

  const verify = await client.get('/user/tokens/verify');
  report.token.status = verify.success ? verify.result?.status ?? 'unknown' : classify(verify);
  const tokenId = verify.result?.id;
  let groups = null;
  if (tokenId && /^[0-9a-f]{32}$/.test(tokenId)) {
    const self = await client.get(`/user/tokens/${tokenId}`);
    if (self.success) {
      groups = [...new Set((self.result?.policies ?? []).filter((p) => p.effect === 'allow').flatMap((p) => (p.permission_groups ?? []).map((g) => g.name)))].sort();
      report.token.permission_groups = groups;
      report.token.expires_on_set = Boolean(self.result?.expires_on);
      report.token.ip_restricted = Boolean(self.result?.condition?.request_ip);
    } else report.token.permission_groups = `not_visible (${classify(self)})`;
  }
  const dangerous = (groups ?? []).filter((g) => DANGEROUS_GROUPS.includes(g));
  if (dangerous.length) report.findings.push({ severity: 'high', id: 'token_can_escalate', detail: `Token holds ${dangerous.join(', ')}; it can mint or widen tokens. Do not use it for automated deploys; create purpose-scoped tokens instead.` });

  const zoneLookup = await client.get(`/zones?name=${manifest.zone}`);
  const zone = Array.isArray(zoneLookup.result) ? zoneLookup.result.find((z) => z.name === manifest.zone) : null;
  report.zone = { name: manifest.zone, found: Boolean(zone), status: zone?.status ?? null, plan: zone?.plan?.legacy_id ?? zone?.plan?.name ?? null };

  const results = {};
  for (const cap of CAPABILITIES) {
    if (cap.scope === 'zone' && !zone) { report.capabilities.push({ id: cap.id, status: 'not_run', reason: 'zone not visible' }); continue; }
    const res = await client.get(cap.path(accountId, zone?.id));
    const status = classify(res);
    results[cap.id] = { res, status };
    const entry = { id: cap.id, scope: cap.scope, http: res.http, status, count: status === 'granted' ? countResult(res.result) : null, read_permission: cap.read, write_permission_for_provisioning: cap.write, needed_for: cap.needed_for };
    const base = (g) => g.replace(/ (Read|Write|Edit)$/, '');
    if (groups && status === 'granted' && entry.count === 0 && !groups.some((g) => base(g) === base(cap.read))) {
      entry.note = 'API returned success without the matching permission group; treat an empty list as inconclusive, not as proof of zero resources.';
    }
    report.capabilities.push(entry);
  }

  // Which write permissions will the provisioning phase lack with this token?
  if (groups) {
    const has = (name) => groups.includes(name) || groups.includes(name.replace(/ Edit$/, ' Write'));
    const missingWrite = CAPABILITIES.filter((c) => c.write && !has(c.write)).map((c) => ({ scope: c.scope, group: c.write, capability: c.id }));
    report.missing_for_provisioning = missingWrite;
  }
  const optional = new Set(CAPABILITIES.filter((c) => c.optional).map((c) => c.id));
  const missingRead = report.capabilities.filter((c) => c.status === 'missing_permission' && !optional.has(c.id)).map((c) => ({ scope: c.scope, group: c.read_permission, capability: c.id }));
  report.missing_for_preflight = missingRead;
  report.console_actions = consoleActionForMissing(missingRead);

  // Protected-host baseline: names and content fingerprints only, never record contents.
  if (results.dns?.status === 'granted') {
    const records = results.dns.res.result ?? [];
    const candidates = Object.values(manifest.environments).map((e) => e.hostname);
    for (const host of manifest.protected.hostnames) {
      const matched = records.filter((r) => r.name === host);
      report.protected_baseline[host] = matched.map((r) => ({ type: r.type, proxied: r.proxied, tunnel_target: /\.cfargotunnel\.com$/.test(r.content ?? ''), fingerprint: fingerprintRecord(r) }));
      if (!matched.length) report.findings.push({ severity: 'high', id: 'protected_host_missing', detail: `${host} has no DNS record; stop and investigate before any change.` });
    }
    const prints = manifest.protected.hostnames.flatMap((h) => (report.protected_baseline[h] ?? []).map((r) => r.fingerprint));
    if (new Set(prints).size < prints.length) report.findings.push({ severity: 'info', id: 'protected_hosts_share_origin', detail: 'Protected hostnames resolve to the same tunnel target; that tunnel carries live traffic and must not be edited during staging work.' });
    for (const host of candidates) {
      const taken = records.filter((r) => r.name === host);
      report.protected_baseline[`candidate:${host}`] = taken.length ? 'exists' : 'absent';
      if (taken.length) report.findings.push({ severity: 'high', id: 'candidate_hostname_taken', detail: `${host} already has DNS records; provisioning must not overwrite them.` });
    }
  }
  if (results.access_apps?.status === 'granted') {
    const names = (results.access_apps.res.result ?? []).map((a) => a.name);
    report.protected_baseline.access_applications = manifest.protected.access_applications.map((n) => ({ name: n, present: names.includes(n) }));
    for (const env of Object.values(manifest.environments)) {
      const covered = (results.access_apps.res.result ?? []).some((a) => [a.domain, ...(a.self_hosted_domains ?? [])].some((d) => d === env.hostname || d === `${env.hostname}/*`));
      report.protected_baseline[`access:${env.hostname}`] = covered ? 'covered' : 'not_yet_covered';
    }
  }
  if (results.tunnels?.status === 'granted') {
    report.protected_baseline.tunnels = (results.tunnels.res.result ?? []).map((t) => ({ name: t.name, status: t.status })).sort((a, b) => a.name.localeCompare(b.name));
  }
  if (results.workers_scripts?.status === 'granted') {
    const names = (results.workers_scripts.res.result ?? []).map((s) => s.id);
    for (const env of Object.values(manifest.environments)) {
      if (names.includes(env.worker.name)) report.findings.push({ severity: 'medium', id: 'worker_name_taken', detail: `${env.worker.name} already exists; confirm it is ours before reuse.` });
    }
  }
  if (results.r2?.status === 'granted') {
    const names = (results.r2.res.result?.buckets ?? []).map((b) => b.name);
    for (const env of Object.values(manifest.environments)) for (const b of env.r2_buckets) {
      if (names.includes(b.name)) report.findings.push({ severity: 'medium', id: 'bucket_name_taken', detail: `${b.name} already exists; confirm ownership before reuse.` });
    }
  }
  return report;
}

/**
 * Provider read-back of each Hyperdrive config's caching flag: the only accepted proof that the
 * query cache is off. Returns { [id]: { caching: { disabled } } } for checkWranglerConfig; GET only.
 */
export async function readHyperdriveCaching({ client, accountId, ids }) {
  const out = {};
  for (const id of ids) {
    if (!/^[0-9a-f]{32}$/.test(id) || /^0{32}$/.test(id)) continue;
    const res = await client.get(`/accounts/${accountId}/hyperdrive/configs/${id}`);
    if (res.success) out[id] = { caching: { disabled: res.result?.caching?.disabled === true } };
  }
  return out;
}
