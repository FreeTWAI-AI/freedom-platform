// HOST ONLY. No candidate imports, executable paths, test reports or ambient
// network/database discovery. An isolated transport is an explicitly trusted
// host port, NOT self-authenticating merely because it implements this API.
import { fileURLToPath } from 'node:url';
import { MEMBER_BEHAVIOR as manifest, MEMBER_BEHAVIOR_CASES as cases } from './behavior-manifest.mjs';
import { artifactPath, parseJson, readBounded, sha256 } from './io.mjs';
import { requireCondition as check, VerificationError } from './errors.mjs';
import { VERIFIER_INSTALLATION_FILES, validateHostEvidenceBinding, validateHostWorkflow } from './trusted-ci.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value) && value.length === 36;
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const reasons = new Set(['behavior_response_invalid','behavior_body_missing','behavior_transport_timeout','behavior_response_limit',
  'behavior_status_mismatch','behavior_cache_mismatch','behavior_conditional_bypass','behavior_head_body','behavior_avatar_mismatch',
  'behavior_content_type_mismatch','behavior_problem_mismatch','behavior_metadata_mismatch','behavior_private_leak',
  'behavior_list_mismatch','behavior_work_mismatch','behavior_target_binding_mismatch']);
const safeReason = error => error instanceof VerificationError && reasons.has(error.code) ? error.code : 'behavior_transport_failed';
function fields(value, keys) { check(value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'invalid_behavior_input'); }
function fixtureCopy(value) {
  fields(value, ['instance_id', 'owner', 'outsider', 'revoked', 'work_id']);
  check(uuid(value.instance_id) && uuid(value.work_id), 'invalid_behavior_fixture');
  for (const name of ['owner', 'outsider', 'revoked']) {
    fields(value[name], name === 'revoked' ? ['cookie', 'csrf'] : ['id', 'cookie', 'csrf']);
    check(name === 'revoked' || uuid(value[name].id), 'invalid_behavior_fixture');
    check(typeof value[name].cookie === 'string' && /^freedom_local_session=[A-Za-z0-9_-]{16,128}$/.test(value[name].cookie)
      && !/[\r\n]/.test(value[name].cookie) && typeof value[name].csrf === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value[name].csrf)
      && !/[\r\n]/.test(value[name].csrf), 'invalid_behavior_fixture');
  }
  check(value.owner.id !== value.outsider.id && new Set(['owner', 'outsider', 'revoked'].map(key => value[key].cookie)).size === 3, 'invalid_behavior_fixture');
  return freeze(structuredClone(value));
}
export function behaviorFixtureIdentity(raw) {
  const fixture = fixtureCopy(raw);
  // Credentials and private body bytes are deliberately NOT hashed/stored.
  const identity = { profile: manifest.fixture_profile, revision: manifest.fixture_revision, instance_id: fixture.instance_id,
    owner_id: fixture.owner.id, outsider_id: fixture.outsider.id, work_id: fixture.work_id };
  return freeze({ ...identity, sha256: sha256(JSON.stringify(identity)) });
}
export async function installedBehaviorHarnessDigest() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const paths = [...new Set([...VERIFIER_INSTALLATION_FILES, 'packages/contribution-tools/behavior-manifest.mjs', 'packages/contribution-tools/behavior-harness.mjs'])].sort();
  const records = [];
  for (const path of paths) records.push([artifactPath(path), sha256(await readBounded(root, path))]);
  return sha256(JSON.stringify(records)); // installation identity, not trust approval
}
function requestFor(item, fixture, signal) {
  const path = item.path.replace(':owner', fixture.owner.id).replace(':work', fixture.work_id);
  const headers = { Origin: manifest.origin };
  if (item.actor !== 'anonymous') {
    headers.Cookie = fixture[item.actor].cookie;
    if (item.omit !== 'csrf') headers['X-CSRF-Token'] = fixture[item.actor].csrf;
  }
  let body;
  if (item.method === 'POST') {
    headers['Content-Type'] = item.operation === 'member.avatar.replace' ? 'image/png' : 'application/json';
    if (item.omit !== 'key') headers['Idempotency-Key'] = 'host-behavior-' + item.id.replaceAll('.', '-');
    if (item.omit !== 'version') headers['If-Match'] = '"1"';
    body = item.operation === 'member.avatar.replace' ? new Uint8Array([137,80,78,71,13,10,26,10]) : '{}';
  }
  if (item.conditional) Object.assign(headers, { Range: 'bytes=0-10', 'If-None-Match': '"1"', 'If-Modified-Since': 'Thu, 01 Jan 2099 00:00:00 GMT' });
  return new Request(manifest.origin + path, { method: item.method, headers, body, redirect: 'error', signal });
}
async function responseBytes(response, signal) {
  check(response instanceof Response, 'behavior_response_invalid');
  check(response.body !== null, 'behavior_body_missing');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      check(!signal.aborted, 'behavior_transport_timeout');
      const { value, done } = await reader.read(); if (done) break;
      check(value instanceof Uint8Array && chunks.length < 4096 && (size += value.length) <= manifest.limits.response_bytes, 'behavior_response_limit');
      chunks.push(value.slice());
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function assertResponse(item, response, bytes, fixture) {
  check(response.status === item.status && !response.redirected, 'behavior_status_mismatch');
  check(/(?:^|,)\s*(?:private,\s*)?no-store(?:\s*,|$)/i.test(response.headers.get('cache-control') ?? ''), 'behavior_cache_mismatch');
  if (item.conditional) check(!response.headers.has('etag') && !response.headers.has('content-range'), 'behavior_conditional_bypass');
  if (item.shape === 'head') { check(bytes.length === 0, 'behavior_head_body'); return; }
  if (item.shape === 'avatar') {
    check(response.headers.get('content-type') === 'image/webp' && bytes.length >= 12
      && new TextDecoder().decode(bytes.subarray(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8,12)) === 'WEBP', 'behavior_avatar_mismatch'); return;
  }
  check((response.headers.get('content-type') ?? '').startsWith('application/json') || item.shape === 'problem'
    && (response.headers.get('content-type') ?? '').startsWith('application/problem+json'), 'behavior_content_type_mismatch');
  const value = parseJson(bytes, { maxBytes: manifest.limits.response_bytes, maxNodes: 4096 });
  const text = new TextDecoder().decode(bytes);
  if (item.shape === 'problem') {
    check(value && typeof value === 'object' && !Array.isArray(value) && typeof value.code === 'string'
      && !text.includes(manifest.title) && !text.includes(manifest.objective) && !text.includes(fixture.work_id), 'behavior_problem_mismatch'); return;
  }
  if (item.shape === 'metadata') {
    check(same(Object.keys(value).sort(), ['aggregate_version','avatar_url']) && value.aggregate_version === 1
      && value.avatar_url === `/api/v1/members/${fixture.owner.id}/avatar?v=1`, 'behavior_metadata_mismatch'); return;
  }
  if (item.shape === 'empty-list') { check(value.total === 0 && Array.isArray(value.items) && value.items.length === 0 && !text.includes(manifest.title), 'behavior_private_leak'); return; }
  if (item.shape === 'list') { check(value.total === 1 && Array.isArray(value.items) && value.items.length === 1, 'behavior_list_mismatch'); }
  const work = item.shape === 'list' ? value.items[0] : value;
  check(same(Object.keys(work).sort(), ['aggregate_version','created_at','objective','state','title','work_item_id'])
    && work.work_item_id === fixture.work_id && work.title === manifest.title && work.objective === manifest.objective
    && work.state === 'draft' && work.aggregate_version === 1 && typeof work.created_at === 'string', 'behavior_work_mismatch');
}
async function bounded(operation, timeout, controller) {
  let timer;
  try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new VerificationError('behavior_transport_timeout', true));
  }, timeout); })]); } finally { clearTimeout(timer); }
}

/** Host ports must be installed outside candidate influence. This API neither
 * authenticates a transport nor proves fixture/checkout provisioning. It does
 * not accept arbitrary reports, test lists, executable paths or pass flags. */
export async function runMemberRouteBehavior(input, ports = {}) {
  fields(input, ['binding','workflow','expectedHarnessSha256','fixture']);
  const binding = validateHostEvidenceBinding(input.binding), workflow = validateHostWorkflow(input.workflow), fixture = fixtureCopy(input.fixture);
  const expectedHarness = input.expectedHarnessSha256, observe = ports.observeTarget, request = ports.request;
  check(digest(expectedHarness), 'invalid_behavior_harness_digest');
  check(Object.keys(ports).every(key => ['request','observeTarget'].includes(key)), 'invalid_behavior_host_port');
  const fixtureIdentity = behaviorFixtureIdentity(fixture), installed = await installedBehaviorHarnessDigest(), outcomes = [];
  const result = (status, reason, observation = null) => freeze({ assurance_level: 'local', status,
    execution_authorized: false, merge_authorized: false, publisher_trust: 'unverified',
    check: { check_id: manifest.suite_id, status: status === 'failed' ? 'failed' : observation ? 'passed' : 'not_run', reason,
      test_count: outcomes.length, ...(observation ? { evidence_sha256: observation.evidence_sha256 } : {}) },
    observation, outcomes, blockers: ['registration_behavior_audit_required', 'trusted_publisher_unavailable', ...(observation ? [] : [reason])] });
  if (installed !== expectedHarness) return result('unavailable', 'behavior_harness_unapproved');
  if (typeof request !== 'function' || typeof observe !== 'function') return result('unavailable', 'behavior_transport_unavailable');
  const controller = new AbortController(), start = Date.now();
  const target = async () => {
    const observed = await bounded(() => observe(), manifest.limits.request_timeout_ms, controller);
    fields(observed, ['binding','workflow','harness_sha256','fixture']);
    check(same(validateHostEvidenceBinding(observed.binding), binding) && same(validateHostWorkflow(observed.workflow), workflow)
      && observed.harness_sha256 === installed && same(observed.fixture, fixtureIdentity), 'behavior_target_binding_mismatch');
  };
  let total = 0;
  try {
    await target();
    for (const item of cases) {
      let status = 'passed', reason = 'behavior_assertions_observed';
      try {
        check(Date.now() - start < manifest.limits.run_timeout_ms, 'behavior_transport_timeout');
        await bounded(async () => {
          const response = await request(requestFor(item, fixture, controller.signal), controller.signal);
          const bytes = item.shape === 'head' && response instanceof Response && response.body === null ? new Uint8Array() : await responseBytes(response, controller.signal);
          check((total += bytes.length) <= manifest.limits.total_response_bytes, 'behavior_response_limit');
          assertResponse(item, response, bytes, fixture);
        }, manifest.limits.request_timeout_ms, controller);
      } catch (error) { status = 'failed'; reason = safeReason(error); }
      outcomes.push({ case_sha256: sha256(item.id), status, reason });
      if (controller.signal.aborted) break;
    }
    await target();
  } catch (error) { return result('failed', safeReason(error)); }
  if (outcomes.length !== cases.length || outcomes.some(item => item.status !== 'passed')) return result('failed', 'behavior_cases_failed');
  const evidence_sha256 = sha256(JSON.stringify({ binding, workflow, harness_sha256: installed, fixture: fixtureIdentity, outcomes }));
  const observation = { suite_id: manifest.suite_id, binding, workflow, harness_sha256: installed, conclusion: 'success',
    tests: cases.length, failures: 0, skipped: 0, cancelled: 0, evidence_sha256 };
  // This observation is a host-port handoff, NOT authenticated workflow proof.
  return result('unavailable', 'fixed_behavior_observed_only', observation);
}
