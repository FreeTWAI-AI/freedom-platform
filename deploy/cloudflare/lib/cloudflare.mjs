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
  /^\/zones\/[0-9a-f]{32}\/dns_records\?per_page=500(?:&page=[1-9][0-9]{0,4})?$/,
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
      result_info: body?.result_info ?? null,
    };
  }
  return Object.freeze({ get });
}

// Each capability: the read probe that proves visibility, and the permission groups the later
// provisioning phase needs. Permission names follow developers.cloudflare.com/fundamentals/api/reference/permissions/.
export const CAPABILITIES = [
  { id: 'workers_scripts', scope: 'account', path: (a) => `/accounts/${a}/workers/scripts`, read: 'Workers Scripts Read', write: 'Workers Scripts Edit', needed_for: 'read Worker scripts for freedom-platform-next and freedom-platform-staging-next. Historical pre-cutover use also uploaded custom domains. Production releases do not re-upload secrets.' },
  { id: 'workers_subdomain', scope: 'account', path: (a) => `/accounts/${a}/workers/subdomain`, read: 'Workers Scripts Read', write: null, needed_for: 'confirm workers.dev stays disabled for Freedom Workers' },
  { id: 'workers_custom_domains', scope: 'account', path: (a) => `/accounts/${a}/workers/domains`, read: 'Workers Scripts Read', write: 'Workers Scripts Edit', needed_for: 'confirm retired custom domains next.freetwai.com and staging-next.freetwai.com stay absent. Both live environments use zone routes, not custom domains. Historical: this probe existed to attach the staging-next custom domain.' },
  { id: 'hyperdrive', scope: 'account', path: (a) => `/accounts/${a}/hyperdrive/configs`, read: 'Hyperdrive Read', write: 'Hyperdrive Edit', needed_for: 'one cache-disabled Hyperdrive config (binding HYPERDRIVE) per environment; caching.disabled must be read back before deploy' },
  { id: 'r2', scope: 'account', path: (a) => `/accounts/${a}/r2/buckets`, read: 'Workers R2 Storage Read', write: 'Workers R2 Storage Edit', needed_for: 'private per-environment buckets (optional until the Worker binds R2)' },
  { id: 'queues', scope: 'account', optional: true, path: (a) => `/accounts/${a}/queues`, read: 'Queues Read', write: null, needed_for: 'not needed for this migration; recorded for completeness' },
  { id: 'access_apps', scope: 'account', path: (a) => `/accounts/${a}/access/apps`, read: 'Access: Apps and Policies Read', write: 'Access: Apps and Policies Edit', needed_for: 'staging.freetwai.com stays behind the pre-existing applications Freedom staging and Freedom staging administrators (referenced, not created). Production freetwai.com is public; /admin stays on Freedom public administrators. Access applications for next.freetwai.com and staging-next.freetwai.com were deleted on 2026-09-25 and must stay absent.' },
  { id: 'tunnels', scope: 'account', path: (a) => `/accounts/${a}/cfd_tunnel?is_deleted=false&per_page=100`, read: 'Cloudflare Tunnel Read', write: null, needed_for: 'baseline of existing tunnels (read-only; do not edit any tunnel). Tunnel freedom-staging was deleted on 2026-09-25. No Castle tunnel hostname remains. Historical: the freetwai.com ingress was removed at the production cutover while the Castle staging tunnel still existed.' },
  { id: 'subscriptions', scope: 'account', path: (a) => `/accounts/${a}/subscriptions`, read: 'Billing Read', write: null, needed_for: 'confirm whether Workers Paid is active (CPU limits for password hashing)' },
  { id: 'zone', scope: 'zone', path: (_a, z) => `/zones/${z}`, read: 'Zone Read', write: null, needed_for: 'zone identity and plan' },
  { id: 'dns', scope: 'zone', path: (_a, z) => `/zones/${z}/dns_records?per_page=500`, read: 'DNS Read', write: 'DNS Edit', needed_for: 'both environment hostnames must be exactly one proxied AAAA placeholder; retired next.freetwai.com and staging-next.freetwai.com must be absent. The protected hostname list is empty. Absent is claimed only when result_info proves the listing is complete. Historical pre-cutover check treated every candidate hostname as not-yet-created. After production cutover and before staging cutover, staging.freetwai.com was a protected tunnel CNAME and staging-next.freetwai.com was required to be present.' },
  { id: 'workers_routes', scope: 'zone', path: (_a, z) => `/zones/${z}/workers/routes`, read: 'Workers Routes Read', write: 'Workers Routes Edit', needed_for: 'zone routes freetwai.com/* on freedom-platform-next and staging.freetwai.com/* on freedom-platform-staging-next. No other route. Retired hostnames must not be routes. Historical pre-cutover check expected zero zone routes; after production cutover only the apex route was expected.' },
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

// DNS list pages are 500. Past this, the probe cannot prove it saw every name; it fails closed.
const DNS_PAGE_SIZE = 500;
const DNS_MAX_PAGES = 40;

function dnsRecordsPath(zoneId, page) {
  const base = `/zones/${zoneId}/dns_records?per_page=${DNS_PAGE_SIZE}`;
  return page > 1 ? `${base}&page=${page}` : base;
}

/** Integers from result_info, or null when they do not describe one complete page-size listing. */
function dnsResultInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const page = info.page;
  const perPage = info.per_page;
  const totalCount = info.total_count;
  const totalPages = info.total_pages;
  if (![page, perPage, totalCount, totalPages].every((n) => Number.isInteger(n))) return null;
  if (page < 1 || perPage !== DNS_PAGE_SIZE || totalCount < 0 || totalPages < 0 || totalPages > DNS_MAX_PAGES) return null;
  if (totalCount === 0) return (totalPages === 0 || totalPages === 1) && page === 1 ? { page, perPage, totalCount, totalPages: 1 } : null;
  if (totalPages !== Math.ceil(totalCount / perPage)) return null;
  return { page, perPage, totalCount, totalPages };
}

function dnsPageLength(page, info) {
  if (info.totalCount === 0) return 0;
  return page < info.totalPages ? info.perPage : info.totalCount - info.perPage * (info.totalPages - 1);
}

function dnsCountAgrees(info, length) {
  return info?.count === undefined || info.count === length;
}

/**
 * Follow result_info until every page is in hand. `complete` is true only when page, per_page,
 * total_count and total_pages agree and the concatenated records equal total_count. Records from
 * pages we did read are still returned so a name we have seen can be marked taken.
 */
function dnsRows(pages) {
  return pages.flatMap((p) => (Array.isArray(p?.result) ? p.result : []));
}

async function collectDnsRecords(client, zoneId, first) {
  const info = first?.http === 200 && first?.success ? dnsResultInfo(first.result_info) : null;
  if (!info || info.page !== 1 || !Array.isArray(first?.result) || !/^[0-9a-f]{32}$/.test(String(zoneId))) {
    return { complete: false, records: dnsRows([first]) };
  }
  const pages = [first];
  for (let page = 2; page <= info.totalPages; page++) {
    let res;
    try { res = await client.get(dnsRecordsPath(zoneId, page)); } catch { return { complete: false, records: dnsRows(pages) }; }
    pages.push(res);
    const nextInfo = res?.http === 200 && res?.success ? dnsResultInfo(res.result_info) : null;
    const aligned = nextInfo && Array.isArray(res.result) && nextInfo.page === page && nextInfo.perPage === info.perPage && nextInfo.totalCount === info.totalCount && nextInfo.totalPages === info.totalPages;
    if (!aligned) return { complete: false, records: dnsRows(pages) };
  }
  const records = dnsRows(pages);
  const complete = pages.every((p, i) => dnsCountAgrees(p.result_info, p.result.length) && p.result.length === dnsPageLength(i + 1, info)) && records.length === info.totalCount;
  return { complete, records };
}

export function consoleActionForMissing(groups) {
  const account = groups.filter((g) => g.scope === 'account').map((g) => g.group);
  const zone = groups.filter((g) => g.scope === 'zone').map((g) => g.group);
  return [
    'Cloudflare dashboard → My Profile → API Tokens → Create Token → Create Custom Token (performed by the account owner, not by this tool).',
    'Name it for one purpose, e.g. "freedom-cf-readonly-preflight"; do NOT add API Tokens, Billing Edit or Account Settings Edit.',
    account.length ? `Permissions → Account → ${[...new Set(account)].join(', ')}; Account Resources → Include → the Freedom account only.` : null,
    zone.length ? `Permissions → Zone → ${[...new Set(zone)].join(', ')}; Zone Resources → Include → Specific zone → freetwai.com.` : null,
    'Client IP Address Filtering → operator host egress IP; TTL → a short operator-chosen window.',
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

  // Hostname baseline after both 2026-09-25 cutovers. Names and content fingerprints
  // only; record contents are never copied into the report.
  //
  // Historical pre-cutover check: every environment hostname was a candidate that
  // should be absent (ready to create) or "taken" (do not overwrite). That reading
  // contradicts the live zone routes. After production cutover and before staging
  // cutover, staging.freetwai.com was a protected tunnel CNAME and
  // staging-next.freetwai.com (role cloudflare_staging) had to be present
  // (baseline deployed:<host>, finding deployed_hostname_missing).
  // Current classes:
  // - protected hostnames: the list is empty. The share-fingerprint check remains
  //   if more than one protected hostname is configured again.
  // - each environment with a zone route: exactly one proxied AAAA 100:: placeholder,
  //   not a tunnel CNAME.
  // - retired (next.freetwai.com and staging-next.freetwai.com): must be absent.
  // `absent` is used only when result_info proves the listing is complete.
  // A name that was not seen on an incomplete listing stays `incomplete_listing`.
  if (results.dns?.status === 'granted') {
    const listed = await collectDnsRecords(client, zone?.id, results.dns.res);
    const records = listed.records;
    const dnsCapability = report.capabilities.find((c) => c.id === 'dns');
    if (dnsCapability) dnsCapability.count = listed.complete ? records.length : null;
    const summarize = (matched) => matched.map((r) => ({ type: r.type, proxied: r.proxied, tunnel_target: /\.cfargotunnel\.com$/.test(r.content ?? ''), fingerprint: fingerprintRecord(r) }));
    const seen = (host) => records.filter((r) => r.name === host);
    const tunnelTarget = (r) => /\.cfargotunnel\.com$/.test(r.content ?? '');
    for (const host of manifest.protected.hostnames) {
      const matched = seen(host);
      if (matched.length) report.protected_baseline[host] = summarize(matched);
      else if (listed.complete) {
        report.protected_baseline[host] = [];
        report.findings.push({ severity: 'high', id: 'protected_host_missing', detail: `${host} has no DNS record; stop and investigate before any change.` });
      } else report.protected_baseline[host] = 'incomplete_listing';
    }
    if (listed.complete) {
      const prints = manifest.protected.hostnames.flatMap((h) => (Array.isArray(report.protected_baseline[h]) ? report.protected_baseline[h] : []).map((r) => r.fingerprint));
      if (prints.length > 1 && new Set(prints).size < prints.length) report.findings.push({ severity: 'info', id: 'protected_hosts_share_origin', detail: 'Protected hostnames resolve to the same tunnel target. The protected list is empty because no Castle tunnel hostname remains; this check still fires if that list is restored with a shared target.' });
    }
    const expectPlaceholder = (env, prefix) => {
      const matched = seen(env.hostname);
      const key = `${prefix}:${env.hostname}`;
      if (!matched.length) {
        report.protected_baseline[key] = listed.complete ? [] : 'incomplete_listing';
        if (listed.complete) report.findings.push({ severity: 'high', id: `${prefix}_hostname_missing`, detail: `${env.hostname} has no DNS record; the zone route must keep the proxied AAAA placeholder.` });
        return;
      }
      report.protected_baseline[key] = summarize(matched);
      const placeholder = matched.length === 1 && matched[0].type === 'AAAA' && matched[0].proxied === true && matched[0].content === '100::';
      if (matched.some(tunnelTarget)) report.findings.push({ severity: 'high', id: `${prefix}_still_on_tunnel`, detail: `${env.hostname} still has a tunnel CNAME; DNS is the proxied AAAA placeholder.` });
      if (!placeholder) report.findings.push({ severity: 'high', id: `${prefix}_dns_unexpected`, detail: `${env.hostname} is not exactly one proxied AAAA placeholder.` });
    };
    for (const env of Object.values(manifest.environments)) {
      if (env.route) expectPlaceholder(env, env.role === 'production' ? 'production' : 'staging');
      for (const host of env.retired_hostnames ?? []) {
        const matched = seen(host);
        if (matched.length) {
          report.protected_baseline[`retired:${host}`] = 'present';
          report.findings.push({ severity: 'high', id: 'retired_hostname_present', detail: `${host} was removed on 2026-09-25 and must stay absent.` });
        } else if (listed.complete) report.protected_baseline[`retired:${host}`] = 'absent';
        else report.protected_baseline[`retired:${host}`] = 'incomplete_listing';
      }
    }
    if (!listed.complete) report.findings.push({ severity: 'high', id: 'dns_listing_incomplete', detail: 'DNS listing was not proven complete. Hostnames that were not seen are incomplete_listing, not absent. Do not treat a partial list as proof that a retired name is gone or that a deployed name is missing.' });
  }
  if (results.access_apps?.status === 'granted') {
    const apps = results.access_apps.res.result ?? [];
    const names = apps.map((a) => a.name);
    report.protected_baseline.access_applications = manifest.protected.access_applications.map((n) => ({ name: n, present: names.includes(n) }));
    for (const row of report.protected_baseline.access_applications) {
      if (!row.present) report.findings.push({ severity: 'high', id: 'protected_access_application_missing', detail: `${row.name} is a pre-existing protected Access application and must stay present.` });
    }
    const domainsOf = (app) => [app.domain, ...(app.self_hosted_domains ?? [])];
    const coversHost = (host) => apps.some((a) => domainsOf(a).some((d) => d === host || d === `${host}/*`));
    for (const env of Object.values(manifest.environments)) {
      const sitewide = coversHost(env.hostname);
      if (env.access?.required === true) {
        report.protected_baseline[`access:${env.hostname}`] = sitewide ? 'covered' : 'not_yet_covered';
        if (!sitewide) report.findings.push({ severity: 'high', id: 'staging_access_missing', detail: `${env.hostname} must stay behind its pre-existing whole-host Access application.` });
      } else {
        // freetwai.com/admin is the protected admin app and is not site-wide coverage.
        report.protected_baseline[`access:${env.hostname}`] = sitewide ? 'sitewide_unexpected' : 'public';
        if (sitewide) report.findings.push({ severity: 'high', id: 'production_sitewide_access', detail: `${env.hostname} is behind a whole-host Access application. Production is public; only /admin stays on Freedom public administrators.` });
      }
      for (const host of env.retired_hostnames ?? []) {
        if (apps.some((a) => domainsOf(a).some((d) => d === host || d === `${host}/*` || (typeof d === 'string' && d.startsWith(`${host}/`))))) {
          report.findings.push({ severity: 'high', id: 'retired_access_application', detail: `${host} still has an Access application. Those applications were deleted on 2026-09-25.` });
        }
      }
      for (const name of env.access?.retired_application_names ?? []) {
        if (names.includes(name)) report.findings.push({ severity: 'high', id: 'retired_access_application', detail: `Access application ${name} was removed on 2026-09-25 and must stay absent.` });
      }
    }
  }
  if (results.tunnels?.status === 'granted') {
    report.protected_baseline.tunnels = (results.tunnels.res.result ?? []).map((t) => ({ name: t.name, status: t.status })).sort((a, b) => a.name.localeCompare(b.name));
    if (report.protected_baseline.tunnels.some((t) => t.name === 'freedom-staging')) report.findings.push({ severity: 'high', id: 'retired_tunnel_present', detail: 'Tunnel freedom-staging was deleted on 2026-09-25 and must stay absent.' });
  }
  if (results.workers_custom_domains?.status === 'granted' && Array.isArray(results.workers_custom_domains.res.result)) {
    const retiredHosts = new Set(Object.values(manifest.environments).flatMap((env) => env.retired_hostnames ?? []));
    const liveHosts = new Set(Object.values(manifest.environments).filter((env) => env.route).map((env) => env.hostname));
    for (const domain of results.workers_custom_domains.res.result) {
      const host = domain?.hostname ?? domain?.domain ?? '';
      if (retiredHosts.has(host)) report.findings.push({ severity: 'high', id: 'retired_custom_domain', detail: `${host} still has a Worker custom domain and must stay absent.` });
      else if (liveHosts.has(host)) report.findings.push({ severity: 'high', id: 'unexpected_custom_domain', detail: `${host} is a zone route and must not also be a Worker custom domain.` });
    }
  }
  if (results.workers_routes?.status === 'granted' && Array.isArray(results.workers_routes.res.result)) {
    const patterns = results.workers_routes.res.result.map((route) => route?.pattern).filter((pattern) => typeof pattern === 'string');
    const allowed = new Set(Object.values(manifest.environments).map((env) => env.route?.pattern).filter(Boolean));
    const retiredHosts = new Set(Object.values(manifest.environments).flatMap((env) => env.retired_hostnames ?? []));
    for (const pattern of allowed) {
      if (!patterns.includes(pattern)) report.findings.push({ severity: 'high', id: 'zone_route_missing', detail: `${pattern} is not a zone route.` });
    }
    for (const pattern of patterns) {
      const host = pattern.replace(/^https?:\/\//, '').split('/')[0];
      if (retiredHosts.has(host)) report.findings.push({ severity: 'high', id: 'retired_hostname_present', detail: `${host} still has a zone route and must stay absent.` });
      else if (!allowed.has(pattern)) report.findings.push({ severity: 'high', id: 'zone_route_unexpected', detail: `${pattern} is not an environment zone route.` });
    }
  }
  if (results.workers_scripts?.status === 'granted') {
    const names = (results.workers_scripts.res.result ?? []).map((s) => s.id);
    for (const env of Object.values(manifest.environments)) {
      if (!names.includes(env.worker.name)) continue;
      report.protected_baseline[`worker:${env.worker.name}`] = 'present';
      // Historical pre-cutover id was worker_name_taken (medium): a script that
      // already existed was a reuse risk before the first deploy. Both Workers
      // are expected to exist after 2026-09-25; keep the ownership check as info.
      report.findings.push({ severity: 'info', id: 'worker_name_present', detail: `${env.worker.name} is present; confirm it is this environment before reuse.` });
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
