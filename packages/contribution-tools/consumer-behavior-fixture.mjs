// Trusted host fixture. No candidate imports, callbacks, migration code or reports.
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { protocol, protocolSha256 } from '../../contracts/preview/v1/protocol.mjs';
import { parseJson } from './io.mjs';

export const CONSUMER_BEHAVIOR_PROFILES = Object.freeze({
  'FreeTWAI-AI/freedom-agent-kit': Object.freeze({ entry: 'loadMemberWorkspace', scenarios: ['authorized'] }),
  'FreeTWAI-AI/freedom-storefront': Object.freeze({ entry: 'loadConnectedStorefront', scenarios: ['authorized', 'wrong_scope', 'revoked'] }),
  'FreeTWAI-AI/freedom-supplier-client': Object.freeze({ entry: 'loadSupplierWorkspace', scenarios: ['authorized', 'wrong_scope', 'revoked'] }),
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const marker = () => randomBytes(24).toString('hex');
const problem = status => ({ type: 'about:blank', title: 'Synthetic fixture denied', status, code: 'fixture_denied', detail: '' });
function challenge(repository, scenario) {
  const kit = repository.endsWith('/freedom-agent-kit'), storefront = repository.endsWith('/freedom-storefront');
  const credential = kit ? 'freedom_local_session=' + marker() : 'fw_read_' + randomBytes(32).toString('base64url');
  const routes = new Map(); let expected;
  if (kit) {
    const user = { user_id: randomUUID(), email: marker() + '@example.invalid', display_name: marker() };
    const dashboard = { fixture_marker: marker() }, work = [{ work_item_id: randomUUID(), title: marker(), aggregate_version: 1 }];
    const positioning = { profile: null, tracks: [{ fixture_marker: marker() }], recommendations: [{ fixture_marker: marker() }] };
    const guilds = [{ guild_key: 'synthetic', name: marker(), membership: null }];
    routes.set('/api/v1/protocol', { protocol: protocol.version, revision: 'synthetic', protocol_sha256: protocolSha256,
      operations: Object.keys(protocol.operations), authentication: 'member_session_csrf', external_job_execution: false, public_checkout: false });
    routes.set('/api/v1/session', { user, csrf_token: marker() });
    routes.set('/api/v1/dashboard', dashboard); routes.set('/api/v1/work-items', { items: work });
    routes.set('/api/v1/me/positioning', positioning); routes.set('/api/v1/guilds', { items: guilds });
    expected = { member: user, dashboard, work, positioning, guilds, mode: 'internal_preview', agent_execution_grant: false };
  } else {
    const kind = scenario === 'wrong_scope' ? (storefront ? 'supplier' : 'storefront') : storefront ? 'storefront' : 'supplier';
    const store = randomUUID(), connection = { kind, scope: kind + ':read', read_only: true, connection_id: randomUUID(),
      fixture_marker: marker(), ...(kind === 'storefront' ? { store_id: store } : {}) };
    routes.set('/client-api/v1/connection', connection);
    if (scenario === 'authorized' && storefront) {
      const catalog = [{ product_id: randomUUID(), fixture_marker: marker() }], stores = [{ store_id: store, fixture_marker: marker() }];
      const listings = [{ store_id: store, listing_id: randomUUID(), fixture_marker: marker() }];
      routes.set('/client-api/v1/retail/catalog', { read_only: true, items: catalog });
      routes.set('/client-api/v1/retail/stores', { read_only: true, items: stores });
      routes.set('/client-api/v1/retail/listings', { read_only: true, items: listings });
      expected = { schema_version: '1', mode: 'internal_preview', store_id: store, catalog, stores, listings,
        capabilities: { checkout: false, payments: false, public_publication: false, service_offers: false } };
    } else if (scenario === 'authorized') {
      const products = [{ product_id: randomUUID(), fixture_marker: marker() }], requests = [{ listing_id: randomUUID(), fixture_marker: marker() }];
      routes.set('/client-api/v1/supplier/products', { read_only: true, items: products });
      routes.set('/client-api/v1/supplier/requests', { read_only: true, items: requests });
      expected = { connection, products, requests, read_only: true };
    }
  }
  return { kit, storefront, credential, routes, expected, scenario, trace: [], invalid: false };
}

/** This server observes actual HTTP bytes from the isolated container's Unix socket.
 * Its synthetic denials test client handling, not the platform server's ACLs. */
export async function createConsumerHttpFixture({ repository, socketPath, onViolation }) {
  if (!Object.hasOwn(CONSUMER_BEHAVIOR_PROFILES, repository)) throw Error('consumer_profile_required');
  let active, fault = false, count = 0;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 2000, headersTimeout: 2000 }, (request, response) => {
    const state = active, path = request.url;
    if (++count > 32 || !state || state.sealed || request.method !== 'GET' || !state.routes.has(path)
      || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0
      || request.headers['x-csrf-token'] || (state.kit
        ? request.headers.cookie !== state.credential || request.headers.authorization !== undefined
        : request.headers.authorization !== 'Bearer ' + state.credential || request.headers.cookie !== undefined)) {
      fault = true; if (state) state.invalid = true; response.destroy(); onViolation(); return;
    }
    const status = state.scenario === 'revoked' ? 401 : 200;
    const body = JSON.stringify(status === 401 ? problem(401) : state.routes.get(path));
    state.trace.push({ method: 'GET', path, status, credential_matched: true, response_sha256: hash(body) });
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
    response.end(body);
  });
  server.maxConnections = 16; server.maxRequestsPerSocket = 1; server.keepAliveTimeout = 1;
  server.on('clientError', (_error, socket) => { fault = true; socket.destroy(); onViolation(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o666);
  return {
    begin(scenario) {
      if (!CONSUMER_BEHAVIOR_PROFILES[repository].scenarios.includes(scenario) || fault) throw Error('consumer_fixture_invalid');
      active = challenge(repository, scenario);
      return { repository, credential: active.credential };
    },
    async verify(response) {
      const state = active;
      const raw = Buffer.from(await response.arrayBuffer());
      const value = parseJson(raw, { maxBytes: 65536, maxDepth: 12, maxNodes: 2048 });
      const paths = state.trace.map(item => item.path).sort(), expectedPaths = [...state.routes.keys()].sort();
      let matched = !fault && !state.invalid && isDeepStrictEqual(paths, expectedPaths);
      if (state.scenario === 'authorized') {
        if (state.storefront && value && typeof value === 'object') {
          matched &&= typeof value.generated_at === 'string' && Number.isFinite(Date.parse(value.generated_at));
          delete value.generated_at;
        }
        matched &&= response.status === 200 && isDeepStrictEqual(value, parseJson(JSON.stringify(state.expected)));
      } else matched &&= response.status === 422 && isDeepStrictEqual(value, parseJson(JSON.stringify({ error: true, status: state.scenario === 'revoked' ? 401 : null })));
      state.sealed = true;
      return { scenario: state.scenario, status: matched ? 'passed' : 'failed',
        expected_requests: expectedPaths.length, observed_requests: state.trace.length,
        response_matches_challenge: matched, http_trace: structuredClone(state.trace) };
    },
    assertHealthy() { if (fault) throw Error('consumer_fixture_invalid'); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
