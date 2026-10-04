import { sign, KeyObject } from 'node:crypto';
// Operator-installed library only. Never import a candidate's copy into a publisher host.
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const runId = value => typeof value === 'string' && value.length <= 16 && /^[1-9][0-9]*$/.test(value) && positive(Number(value));
function requireThat(value, code) { if (!value) throw new Error(code); }
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Requests are authenticated operator-owned closures; this module never accepts credentials. */
export function createGithubAppPublisher(config, ports) {
  requireThat(exact(config, ['repository', 'repository_id', 'app_id', 'installation_id', 'check_name']), 'publisher_config_invalid');
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) &&
    [config.repository_id, config.app_id, config.installation_id].every(positive) &&
    /^[A-Za-z0-9 _./-]{1,100}$/.test(config.check_name), 'publisher_config_invalid');
  requireThat(exact(ports, ['appRequest', 'installationRequest', 'verify']) &&
    Object.values(ports).every(value => typeof value === 'function'), 'publisher_ports_invalid');
  config = Object.freeze({ ...config });
  ports = Object.freeze({ ...ports });
  const consumed = new Set();
  let busy = false;
  const prefix = `/repos/${config.repository}`;
  async function current(binding) {
    const app = await ports.appRequest('GET', '/app');
    requireThat(app.id === config.app_id, 'publisher_app_mismatch');
    const installation = await ports.appRequest('GET', `${prefix}/installation`);
    requireThat(installation.id === config.installation_id && installation.app_id === config.app_id &&
      installation.suspended_at === null && installation.permissions?.checks === 'write', 'publisher_installation_mismatch');
    const repository = await ports.installationRequest('GET', prefix);
    requireThat(repository.id === config.repository_id && repository.full_name === config.repository, 'publisher_repository_mismatch');
    const run = await ports.installationRequest('GET', `${prefix}/actions/runs/${binding.run_id}`);
    requireThat(positive(run.id) && String(run.id) === binding.run_id && run.run_attempt === binding.run_attempt && run.repository?.id === config.repository_id &&
      run.event === 'pull_request' && run.head_sha === binding.head_commit &&
      run.pull_requests?.some(pr => pr.number === binding.pull_request), 'publisher_run_mismatch');
    const attempt = await ports.installationRequest('GET', `${prefix}/actions/runs/${binding.run_id}/attempts/${binding.run_attempt}`);
    requireThat(positive(attempt.id) && String(attempt.id) === binding.run_id && attempt.run_attempt === binding.run_attempt &&
      attempt.repository?.id === config.repository_id && attempt.event === 'pull_request' &&
      attempt.head_sha === binding.head_commit &&
      attempt.pull_requests?.some(pr => pr.number === binding.pull_request), 'publisher_run_attempt_mismatch');
    const pr = await ports.installationRequest('GET', `${prefix}/pulls/${binding.pull_request}`);
    requireThat(pr.number === binding.pull_request && pr.state === 'open' && pr.merged === false &&
      pr.base?.repo?.id === config.repository_id && pr.base.sha === binding.base_commit &&
      pr.head?.sha === binding.head_commit, 'publisher_candidate_superseded');
    const commit = await ports.installationRequest('GET', `${prefix}/git/commits/${binding.candidate_commit}`);
    requireThat(commit.sha === binding.candidate_commit && commit.tree?.sha === binding.candidate_tree, 'publisher_tree_mismatch');
  }
  return Object.freeze({
    async publish(input) {
      const unavailable = code => ({ status: 'unavailable', code, gate_enforced: false, merge_authorized: false });
      if (busy) return unavailable('publisher_busy');
      busy = true;
      try {
        requireThat(exact(input, ['repository', 'run_id', 'run_attempt', 'pull_request', 'base_commit', 'head_commit', 'candidate_commit', 'candidate_tree']), 'publisher_binding_invalid');
        const binding = Object.freeze({ ...input });
        requireThat(binding.repository === config.repository && runId(binding.run_id) && positive(binding.run_attempt) && positive(binding.pull_request) &&
          ['base_commit', 'head_commit', 'candidate_commit', 'candidate_tree'].every(key => sha(binding[key])) &&
          binding.base_commit !== binding.candidate_commit, 'publisher_binding_invalid');
        requireThat(binding.candidate_commit === binding.head_commit, 'publisher_integration_candidate_unavailable');
        const key = `${binding.run_id}:${binding.run_attempt}:${binding.candidate_commit}`;
        requireThat(!consumed.has(key) && consumed.size < 1024, 'publisher_replay_unavailable');
        await current(binding);
        // Installed verifier obtains its own authenticated observations; no artifact/report parameter exists.
        const report = await ports.verify(binding);
        requireThat(report?.format === 'freedom.host-verifier-report/v1' && report.status === 'passed' &&
          Array.isArray(report.blockers) && report.blockers.length === 0 &&
          Array.isArray(report.selected_suites) && report.selected_suites.length > 0 &&
          Array.isArray(report.checks) && report.checks.length === report.selected_suites.length &&
          new Set(report.selected_suites).size === report.selected_suites.length &&
          report.checks.every(check => report.selected_suites.includes(check.suite_id) && check.status === 'passed' && /^[a-f0-9]{64}$/.test(check.evidence_sha256)) &&
          new Set(report.checks.map(check => check.suite_id)).size === report.checks.length && report.binding &&
          Object.keys(binding).every(field => report.binding[field] === binding[field]), 'publisher_verified_decision_unavailable');
        await current(binding);
        consumed.add(key); // Unknown POST acknowledgement cannot cause an automatic retry.
        const externalId = `freedom:${config.repository_id}:${binding.run_id}:${binding.run_attempt}:${binding.candidate_commit}`;
        const check = await ports.installationRequest('POST', `${prefix}/check-runs`, {
          name: config.check_name, head_sha: binding.candidate_commit, status: 'completed', conclusion: 'success',
          external_id: externalId,
          output: { title: 'Fixed host verification', summary: 'The installed verifier accepted this exact candidate.' }
        });
        const matches = value => positive(value?.id) && value.app?.id === config.app_id && value.head_sha === binding.candidate_commit &&
          value.name === config.check_name && value.status === 'completed' && value.conclusion === 'success' && value.external_id === externalId;
        requireThat(matches(check), 'publisher_response_mismatch');
        const readback = await ports.installationRequest('GET', `${prefix}/check-runs/${check.id}`);
        requireThat(matches(readback) && readback.id === check.id, 'publisher_readback_mismatch');
        await current(binding);
        return { status: 'published', check_id: check.id, head_sha: binding.candidate_commit, app_id: config.app_id,
          gate_enforced: false, merge_authorized: false };
      } catch (error) {
        // Never disclose transport errors, tokens, response bodies or candidate payloads.
        const code = /^publisher_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'publisher_transport_unavailable';
        return unavailable(code);
      } finally { busy = false; }
    }
  });
}


/** Operator bootstrap only: pass an already-loaded RSA KeyObject, never a candidate key/path. */
export function createGithubAppTransport(config, privateKey, { fetchImpl = globalThis.fetch } = {}) {
  requireThat(exact(config, ['repository', 'repository_id', 'app_id', 'installation_id']) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository) &&
    [config.repository_id, config.app_id, config.installation_id].every(positive), 'publisher_config_invalid');
  requireThat(privateKey instanceof KeyObject && privateKey.type === 'private' && privateKey.asymmetricKeyType === 'rsa' &&
    privateKey.asymmetricKeyDetails.modulusLength >= 2048 && typeof fetchImpl === 'function', 'publisher_key_invalid');
  config = Object.freeze({ ...config });
  const prefix = `/repos/${config.repository}`;
  const permissions = Object.freeze({ checks: 'write', contents: 'read', actions: 'read', pull_requests: 'read', metadata: 'read' });
  let token = null, expires = 0;
  function jwt() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 300, iss: String(config.app_id) })).toString('base64url');
    const value = `${header}.${payload}`;
    return `${value}.${sign('RSA-SHA256', Buffer.from(value), privateKey).toString('base64url')}`;
  }
  async function request(method, path, credential, body) {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method, redirect: 'error', signal: abort.signal,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${credential}`,
          'X-GitHub-Api-Version': '2026-03-10', 'user-agent': 'freedom-fixed-host', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      requireThat(response.status === (method === 'POST' ? 201 : 200) && !response.redirected &&
        (!response.url || response.url === `https://api.github.com${path}`), 'publisher_http_unavailable');
      const reader = response.body?.getReader();
      requireThat(reader, 'publisher_response_unavailable');
      let size = 0; const chunks = [];
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          requireThat(size <= 1048576, 'publisher_response_unavailable'); chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new Error('publisher_transport_unavailable'); }
    finally { clearTimeout(timer); }
  }
  async function installationToken() {
    if (token && Date.now() < expires - 60000) return token;
    const value = await request('POST', `/app/installations/${config.installation_id}/access_tokens`, jwt(), {
      repository_ids: [config.repository_id], permissions
    });
    requireThat(typeof value.token === 'string' && value.token.length > 0 && value.token.length <= 4096 &&
      Array.isArray(value.repositories) && value.repositories.length === 1 &&
      value.repositories[0].id === config.repository_id && value.repositories[0].full_name === config.repository &&
      exact(value.permissions, Object.keys(permissions)) &&
      Object.keys(permissions).every(key => value.permissions[key] === permissions[key]), 'publisher_token_scope_unavailable');
    expires = Date.parse(value.expires_at);
    requireThat(Number.isFinite(expires) && expires > Date.now() + 60000 && expires <= Date.now() + 3660000, 'publisher_token_expiry_unavailable');
    token = value.token;
    return token;
  }
  return Object.freeze({
    appRequest: async (method, path) => {
      requireThat(method === 'GET' && (path === '/app' || path === `${prefix}/installation`), 'publisher_endpoint_rejected');
      return request(method, path, jwt());
    },
    installationRequest: async (method, path, body) => {
      const getAllowed = path === prefix ||
        path.startsWith(`${prefix}/`) && /^(check-runs\/[1-9][0-9]*|actions\/runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*)?|pulls\/[1-9][0-9]*|git\/commits\/[a-f0-9]{40})$/.test(path.slice(prefix.length + 1));
      requireThat(method === 'GET' && body === undefined && getAllowed ||
        method === 'POST' && path === `${prefix}/check-runs` && body &&
        exact(body, ['name', 'head_sha', 'status', 'conclusion', 'external_id', 'output']) && sha(body.head_sha) &&
        body.status === 'completed' && ['success', 'failure'].includes(body.conclusion) &&
        typeof body.name === 'string' && body.name.length <= 128 && typeof body.external_id === 'string' && body.external_id.length <= 256 &&
        exact(body.output, ['title', 'summary']) && typeof body.output.title === 'string' && body.output.title.length <= 128 &&
        typeof body.output.summary === 'string' && body.output.summary.length <= 1024 ||
        method === 'PATCH' && path.startsWith(`${prefix}/check-runs/`) && /^[1-9][0-9]*$/.test(path.slice(`${prefix}/check-runs/`.length)) &&
        exact(body, ['status', 'conclusion', 'external_id', 'output']) && body.status === 'completed' &&
        ['success', 'failure'].includes(body.conclusion) && typeof body.external_id === 'string' && body.external_id.length <= 256 &&
        exact(body.output, ['title', 'summary']) && typeof body.output.title === 'string' && body.output.title.length <= 128 &&
        typeof body.output.summary === 'string' && body.output.summary.length <= 1024, 'publisher_endpoint_rejected');
      return request(method, path, await installationToken(), body);
    }
  });
}
