// Monthly cost arithmetic from the manifest. A selected SKU whose regional/organization price is
// not recorded stays null and makes the total pending: it is never summed as 0, NaN or a guess.
// Items outside any quote (storage, backups, NAT, egress, tax, credits) are listed as excluded.
// The user's US$50–100 is context, never a gate.
const round = (n) => Math.round(n * 100) / 100;

/** Selected path: Cloudflare-billed PlanetScale (same prices as direct per the Cloudflare page). */
export function planetscaleCost(manifest) {
  const ps = manifest.providers.planetscale;
  const environments = {};
  for (const [key, env] of Object.entries(manifest.environments)) {
    const sku = `${env.database.size} ${env.database.topology}`;
    const usd = ps.catalog.monthly_usd[sku];
    environments[key] = { sku, nodes: ps.topology_nodes[env.database.topology].nodes, usd_month: typeof usd === 'number' ? usd : null };
  }
  const workers = manifest.cloudflare.workers_paid_usd_month;
  const unknown = Object.entries(environments).filter(([, e]) => e.usd_month === null).map(([k, e]) => `${k}: ${e.sku}`);
  const db = Object.values(environments).reduce((s, e) => s + (e.usd_month ?? 0), 0);
  return {
    basis: `${ps.catalog.source} (${ps.catalog.status}); billed through Cloudflare at the same price`,
    environments,
    cloudflare_workers_paid: workers,
    public_starting_price_single_node: ps.catalog.public_summary?.public_starting_price_usd_month ?? null,
    public_starting_price_meaning: 'public "starts at" figure only; not the regional or organization quote for any selected SKU',
    total: unknown.length ? null : round(db + workers),
    total_status: unknown.length ? 'pending_quote' : 'computed',
    quote_required: unknown,
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
    // OCI's own survey assumption (HA = 2 nodes); PlanetScale HA is 3 nodes and is not mixed in here.
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
