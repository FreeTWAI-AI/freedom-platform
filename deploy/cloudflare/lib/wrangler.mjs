import { existsSync, readFileSync } from 'node:fs';

/** Strip // and block comments and trailing commas outside of strings, then JSON.parse. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) throw new Error('unterminated comment'); i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function routeHost(route) {
  const pattern = typeof route === 'string' ? route : route?.pattern;
  return String(pattern ?? '').replace(/^https?:\/\//, '').split('/')[0];
}

const PLACEHOLDER_ID = /^0{32}$/;
const HYPERDRIVE_ID = /^[0-9a-f]{32}$/;

/**
 * Validate a wrangler.json/jsonc owned by the runtime workstream against the manifest. Read-only.
 * Two separate answers: `structural` (the config is shaped correctly) and `deployment_ready`
 * (every provider fact is proven). Placeholder zero Hyperdrive IDs are deliberately unprovisioned:
 * structurally valid, not deployment-ready. Cache-disabled Hyperdrive is proven only by a provider
 * read of `caching.disabled === true` (pass `hyperdriveConfigs`, keyed by id); no comment, variable
 * or HTTP no-store header proves the query cache is off.
 */
export function checkWranglerConfig(path, manifest, { hyperdriveConfigs } = {}) {
  if (!path || !existsSync(path)) return { status: 'not_run', reason: 'wrangler config not present (owned by the runtime workstream)', errors: [] };
  if (/\.toml$/.test(path)) return { status: 'not_run', reason: 'TOML config: convert to wrangler.jsonc or check manually', errors: [] };
  const cfg = parseJsonc(readFileSync(path, 'utf8'));
  const rt = manifest.runtime;
  const errors = [];
  const warnings = [];
  const blockers = [];
  const injections = [];
  const protectedHosts = new Set(manifest.protected.hostnames);
  const candidates = Object.fromEntries(Object.entries(manifest.environments).map(([k, e]) => [e.worker.name, k]));
  const idOwners = new Map();

  if (cfg.compatibility_date !== rt.compatibility_date) errors.push(`compatibility_date must be ${rt.compatibility_date}`);
  for (const f of rt.compatibility_flags) if (!(cfg.compatibility_flags ?? []).includes(f)) errors.push(`compatibility_flags must include ${f}`);

  for (const [label, block] of [['(top-level)', cfg], ...Object.entries(cfg.env ?? {})]) {
    const name = block.name ?? (label === '(top-level)' ? cfg.name : `${cfg.name}-${label}`);
    const routes = [...(block.routes ?? []), ...(block.route ? [block.route] : [])];
    for (const r of routes) {
      const host = routeHost(r);
      if (protectedHosts.has(host) || host.startsWith('*')) errors.push(`${label}: route ${host} touches a protected or wildcard hostname`);
    }
    if (label !== '(top-level)' && !manifest.environments[label]) errors.push(`${label}: environment is not in the manifest`);
    if (!candidates[name] && routes.length) errors.push(`${label}: Worker ${name} is not a manifest candidate but declares routes`);
  }

  for (const [key, env] of Object.entries(manifest.environments)) {
    const label = key;
    const block = cfg.env?.[key];
    if (!block) { errors.push(`${label}: no env block`); continue; }
    if (block.name !== env.worker.name) errors.push(`${label}: name must be ${env.worker.name}`);
    if ((block.workers_dev ?? cfg.workers_dev) !== false) errors.push(`${label}: workers_dev must be explicitly false`);
    if ((block.preview_urls ?? cfg.preview_urls) !== false) errors.push(`${label}: preview_urls must be explicitly false (omitting it leaves the existing setting unchanged)`);
    const routes = [...(block.routes ?? []), ...(block.route ? [block.route] : [])];
    for (const r of routes) if (routeHost(r) !== env.hostname) errors.push(`${label}: route ${routeHost(r)} is not ${env.hostname}`);
    if (!routes.length) blockers.push(`${label}: custom domain ${env.hostname} is attached by the infrastructure owner (not in config)`);

    // assets is inheritable; images and hyperdrive are not.
    const assets = block.assets ?? cfg.assets;
    if (assets?.binding !== rt.assets_binding) errors.push(`${label}: assets binding must be ${rt.assets_binding}`);
    if (assets?.run_worker_first !== true) errors.push(`${label}: assets.run_worker_first must be true for all routes`);
    if (block.images?.binding !== rt.images_binding) errors.push(`${label}: images binding ${rt.images_binding} is required (not inherited)`);

    const hd = block.hyperdrive ?? [];
    if (hd.length !== 1) errors.push(`${label}: exactly one Hyperdrive binding required, found ${hd.length}`);
    for (const h of hd) {
      if (h.binding !== rt.hyperdrive_binding) { errors.push(`${label}: Hyperdrive binding ${h.binding} is not ${rt.hyperdrive_binding}`); continue; }
      if (h.localConnectionString && !/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(h.localConnectionString)) errors.push(`${label}: localConnectionString must point at loopback only`);
      if (PLACEHOLDER_ID.test(h.id ?? '')) { blockers.push(`${label}: Hyperdrive id is the placeholder (${env.hyperdrive.name} not provisioned)`); continue; }
      if (!HYPERDRIVE_ID.test(h.id ?? '')) { errors.push(`${label}: Hyperdrive id is not a 32-hex id`); continue; }
      if (idOwners.has(h.id)) errors.push(`${label}: Hyperdrive id shared with ${idOwners.get(h.id)}`);
      idOwners.set(h.id, key);
      const provider = hyperdriveConfigs?.[h.id];
      if (!provider) blockers.push(`${label}: caching.disabled not read from the provider (not_run)`);
      else if (provider.caching?.disabled !== true) errors.push(`${label}: provider reports Hyperdrive caching is not disabled`);
    }

    const vars = block.vars ?? {};
    for (const [k, v] of Object.entries(vars)) {
      if (/(URL|KEY|SECRET|TOKEN|PASSWORD)$/.test(k) && k !== 'APP_ORIGIN') errors.push(`${label}: ${k} must be a secret, not a plain var`);
      if (/^(postgres(ql)?|mysql):\/\//i.test(String(v))) errors.push(`${label}: var ${k} contains a connection string`);
    }
    if (vars.APP_ORIGIN !== `https://${env.hostname}`) errors.push(`${label}: APP_ORIGIN must be https://${env.hostname}`);
    if (vars.FREEDOM_ENV !== env.freedom_env) errors.push(`${label}: FREEDOM_ENV must be ${env.freedom_env}`);
    if (vars[rt.source_ip_var.name] !== rt.source_ip_var.value) errors.push(`${label}: ${rt.source_ip_var.name} must be "${rt.source_ip_var.value}" behind Cloudflare`);
    if (rt.release_var in vars) {
      if (!/^[0-9a-f]{40}$/.test(String(vars[rt.release_var]))) errors.push(`${label}: ${rt.release_var} must be a 40-hex commit SHA`);
      else warnings.push(`${label}: ${rt.release_var} is hardcoded; prefer deploy-time injection`);
    } else injections.push(`${label}: ${rt.release_var} via ${rt.release_var_injection}`);
    for (const v of env.var_names) if (!(v in vars) && v !== rt.release_var) injections.push(`${label}: var ${v} supplied outside the config`);
    for (const s of env.secret_names) injections.push(`${label}: secret ${s} (wrangler secret put)`);
  }
  const structural = errors.length ? 'invalid' : 'valid';
  return {
    status: errors.length ? 'fail' : 'pass',
    structural,
    deployment_ready: structural === 'valid' && blockers.length === 0,
    readiness_blockers: blockers,
    required_injections: injections,
    errors,
    warnings,
  };
}
