// Monthly cost arithmetic from the catalog snapshots in the manifest. Items that are not in a
// snapshot (storage above included amounts, backups, NAT, egress, tax, credits) are listed as
// excluded rather than guessed. The user's US$50–100 is context, never a gate.
const round = (n) => Math.round(n * 100) / 100;

/** Selected path: Cloudflare-billed PlanetScale (same prices as direct per the Cloudflare page). */
export function planetscaleCost(manifest) {
  const ps = manifest.providers.planetscale;
  const environments = {};
  for (const [key, env] of Object.entries(manifest.environments)) {
    const sku = `${env.database.size} ${env.database.topology} arm64`;
    environments[key] = { sku, usd_month: ps.catalog.monthly_usd[sku] };
  }
  const workers = manifest.cloudflare.workers_paid_usd_month;
  const db = Object.values(environments).reduce((s, e) => s + e.usd_month, 0);
  return {
    basis: `${ps.catalog.source} (${ps.catalog.retrieved}); billed through Cloudflare at the same price`,
    environments,
    cloudflare_workers_paid: workers,
    total: round(db + workers),
    org_size_availability: 'not_run (needs authenticated pscale organization)',
    excluded: ['storage/egress above plan inclusions', 'Cloudflare usage above Workers Paid included amounts', 'tax'],
    user_estimate: manifest.budget.user_context_estimate_usd_month,
  };
}

/** Surveyed OCI alternative at paid list rates; no free credits assumed and nothing provisioned. */
export function ociAlternativeCost(manifest, { connectorShape = 'CI.Standard.E4.Flex' } = {}) {
  const oci = manifest.providers.oci;
  const p = oci.price_catalog.items;
  const h = oci.price_catalog.hours_per_month;
  const min = oci.facts.db_shape_minimum;
  const rates = oci.price_catalog.connector_rates[connectorShape];
  if (!rates) throw new Error(`No connector rate for ${connectorShape}`);
  const dbNode = round(((p.B99060.usd + p.B97384.usd) * min.ocpu + p.B97385.usd * min.memory_gb) * h);
  const connector = round((p[rates.ocpu].usd * oci.connector.ocpu + p[rates.memory].usd * oci.connector.memory_gb) * h);
  const environments = {};
  for (const [key, env] of Object.entries(manifest.environments)) {
    const nodes = env.database.topology === 'ha' ? 2 : 1;
    environments[key] = { db_nodes: nodes, db: round(dbNode * nodes), connector, subtotal: round(dbNode * nodes + connector) };
  }
  const workers = manifest.cloudflare.workers_paid_usd_month;
  return {
    basis: `${oci.price_catalog.source} (${oci.price_catalog.retrieved}), ${h} h/month`,
    connector_shape: connectorShape,
    db_per_node: dbNode,
    environments,
    cloudflare_workers_paid: workers,
    total_lower_bound: round(Object.values(environments).reduce((s, e) => s + e.subtotal, 0) + workers),
    excluded: ['DB optimized storage (B99062, size unverified)', 'backups', 'NAT gateway', 'egress', 'tax', 'free credits (not assumed)'],
    provisioning: false,
  };
}
