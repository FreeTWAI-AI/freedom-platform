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

/**
 * Validate a wrangler.json/jsonc owned by another workstream against the manifest's safety rules.
 * Read-only: never writes the file.
 */
export function checkWranglerConfig(path, manifest) {
  if (!path || !existsSync(path)) return { status: 'not_run', reason: 'wrangler config not present yet (owned by the Worker workstream)', errors: [] };
  if (/\.toml$/.test(path)) return { status: 'not_run', reason: 'TOML config: convert to wrangler.jsonc or check manually', errors: [] };
  const cfg = parseJsonc(readFileSync(path, 'utf8'));
  const errors = [];
  const warnings = [];
  const protectedHosts = new Set(manifest.protected.hostnames);
  const candidates = Object.fromEntries(Object.entries(manifest.environments).map(([k, e]) => [e.worker.name, { key: k, env: e }]));
  const blocks = [['(top-level)', cfg], ...Object.entries(cfg.env ?? {})];
  const hyperdriveOwners = new Map();
  const matched = new Set();

  for (const [label, block] of blocks) {
    const name = block.name ?? (label === '(top-level)' ? cfg.name : `${cfg.name}-${label}`);
    const routes = [...(block.routes ?? []), ...(block.route ? [block.route] : [])];
    for (const r of routes) {
      const host = routeHost(r);
      if (protectedHosts.has(host) || host === '*.freetwai.com' || host.startsWith('*')) errors.push(`${label}: route ${host} touches a protected or wildcard hostname`);
    }
    const target = candidates[name];
    if (!target) {
      if (routes.length) errors.push(`${label}: Worker ${name} is not a manifest candidate but declares routes`);
      continue;
    }
    matched.add(target.key);
    const workersDev = block.workers_dev ?? cfg.workers_dev;
    const previewUrls = block.preview_urls ?? cfg.preview_urls;
    if (workersDev !== false) errors.push(`${label}: workers_dev must be explicitly false`);
    if (previewUrls !== false) errors.push(`${label}: preview_urls must be explicitly false (omitting it leaves the existing setting unchanged)`);
    for (const r of routes) {
      if (routeHost(r) !== target.env.hostname) errors.push(`${label}: route ${routeHost(r)} is not ${target.env.hostname}`);
      if (typeof r !== 'object' || r.custom_domain !== true) warnings.push(`${label}: prefer custom_domain routes for ${target.env.hostname}`);
    }
    const hd = block.hyperdrive ?? [];
    if (!hd.length) errors.push(`${label}: no Hyperdrive binding`);
    for (const h of hd) {
      if (hyperdriveOwners.has(h.id) && hyperdriveOwners.get(h.id) !== target.key) errors.push(`${label}: Hyperdrive id shared with ${hyperdriveOwners.get(h.id)}`);
      hyperdriveOwners.set(h.id, target.key);
      if (h.localConnectionString && !/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(h.localConnectionString)) errors.push(`${label}: localConnectionString must point at loopback only`);
    }
    for (const [k, v] of Object.entries(block.vars ?? {})) {
      if (/(URL|KEY|SECRET|TOKEN|PASSWORD)$/.test(k) && k !== 'APP_ORIGIN') errors.push(`${label}: ${k} must be a secret, not a plain var`);
      if (/^(postgres(ql)?|mysql):\/\//i.test(String(v))) errors.push(`${label}: var ${k} contains a connection string`);
    }
    if (block.vars?.APP_ORIGIN && block.vars.APP_ORIGIN !== `https://${target.env.hostname}`) errors.push(`${label}: APP_ORIGIN must be https://${target.env.hostname}`);
  }
  for (const key of Object.keys(manifest.environments)) if (!matched.has(key)) warnings.push(`no config block for ${key}`);
  return { status: errors.length ? 'fail' : 'pass', errors, warnings };
}
