// Fixed endpoint construction only. Never discovers credentials or enables CI.
import { createHash } from 'node:crypto';
import { parseJson } from './io.mjs';
import { LEDGER_REF } from './worker-unit-routing.mjs';
import { validateDispatchState } from './worker-unit-dispatch.mjs';
const repository = 'FreeTWAI/freedom-platform';
const gh = `https://api.github.com/repos/${repository}`;
const cc = 'https://circleci.com/api/v2';
const workflow = 'worker-unit-fallback.yml';
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = x => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(x);
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const blobSha = bytes => hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1');
function check(ok) { if (!ok) throw Error('worker_http_unavailable'); }
function bind(b, config) {
  check(b && Object.keys(b).sort().join() === 'attempt,repository,runnerSha,sourceSha,suite,suiteDigest' &&
    b.repository === repository && b.suite === 'ci.worker-unit' && sha(b.sourceSha) && id(b.attempt) &&
    b.runnerSha === config.runnerSha && b.suiteDigest === config.suiteDigest);
}

export function workerUnitHttp(config, { enabled = false, credentials, fetchImpl = globalThis.fetch, verifyEvidence, timeoutMs = 5000 } = {}) {
  check(typeof enabled === 'boolean' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  // Disabled construction does not inspect providers or acquire credentials.
  if (!enabled) {
    const disabled = async () => { throw Error('worker_http_disabled'); };
    return Object.freeze({ read: disabled, commit: disabled, dispatch: disabled, observe: disabled });
  }
  check(config && Object.keys(config).sort().join() === 'circleConfigSha,circleConfigTag,circleDefinitionId,circleProjectSlug,githubWorkflowSha,githubWorkflowTag,resourceClass,runnerSha,suiteDigest');
  check(/^circleci\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(config.circleProjectSlug) &&
    config.circleProjectSlug.split('/').slice(1).every(uuid) && uuid(config.circleDefinitionId) &&
    [config.circleConfigTag, config.githubWorkflowTag, config.resourceClass].every(id) &&
    [config.circleConfigSha, config.githubWorkflowSha, config.runnerSha].every(sha) && digest(config.suiteDigest));
  check(typeof fetchImpl === 'function' && typeof credentials?.github === 'function' && typeof credentials?.circleci === 'function');
  config = Object.freeze({ ...config });
  const providers = Object.freeze({ github: credentials.github, circleci: credentials.circleci });
  const refPath = LEDGER_REF.slice(5);

  // Deadline covers credential acquisition, HTTP headers AND the streamed body.
  // Fixed origins, no redirects/retries, no credential caching or error reflection.
  async function request(provider, method, path, body, statuses, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const bounded = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let reader, abort;
    try {
      const operation = async () => {
        bounded.throwIfAborted();
        const credential = await providers[provider](bounded);
        bounded.throwIfAborted();
        check(typeof credential === 'string' && /^[\x21-\x7e]{1,4096}$/.test(credential));
        const base = provider === 'github' ? gh : cc;
        check(path.startsWith('/') && !path.includes('..') && !path.includes('?') && !path.includes('#') && !path.includes('%'));
        const url = base + path;
        const headers = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'freedom-worker-unit-controller' };
        if (provider === 'github') Object.assign(headers, { authorization: `Bearer ${credential}`, 'X-GitHub-Api-Version': '2026-03-10' });
        else headers['Circle-Token'] = credential;
        const serialized = body === undefined ? undefined : JSON.stringify(body);
        check(serialized === undefined || Buffer.byteLength(serialized) <= 4000000);
        const response = await fetchImpl(url, { method, headers, body: serialized, redirect: 'error', signal: bounded });
        check(!response.redirected && (!response.url || response.url === url) && statuses.includes(response.status));
        if (response.status === 204) return { status: 204, data: null };
        const length = response.headers.get('content-length');
        check(length === null || (/^\d+$/.test(length) && Number(length) <= 4000000));
        reader = response.body?.getReader(); check(reader);
        const chunks = []; let size = 0;
        for (;;) {
          bounded.throwIfAborted();
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; check(size <= 4000000); chunks.push(Buffer.from(part.value));
        }
        return { status: response.status, data: parseJson(Buffer.concat(chunks), { maxBytes: 4000000, maxDepth: 32, maxNodes: 100000 }) };
      };
      return await Promise.race([operation(), new Promise((_, reject) => {
        abort = () => reject(Error('worker_http_unavailable'));
        bounded.addEventListener('abort', abort, { once: true });
        if (bounded.aborted) abort();
      })]);
    } catch { throw Error('worker_http_unavailable'); }
    finally {
      controller.abort(); clearTimeout(timer); bounded.removeEventListener('abort', abort);
      // Do not await a hostile or stalled stream cancellation.
      reader?.cancel().catch(() => {});
    }
  }
  const get = async (provider, path, signal) => (await request(provider, 'GET', path, undefined, [200], signal)).data;
  async function ref(signal) {
    const r = await get('github', `/git/ref/${refPath}`, signal);
    check(r.ref === LEDGER_REF && r.object?.type === 'commit' && sha(r.object.sha)); return r.object.sha;
  }
  async function pinnedTag(tag, expected, signal) {
    const r = await get('github', `/git/ref/tags/${tag}`, signal);
    // Lightweight immutable tags only. Annotated tags require separate support.
    check(r.ref === `refs/tags/${tag}` && r.object?.type === 'commit' && r.object.sha === expected);
  }
  const safe = fn => async (input, signal) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const bounded = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let abort;
    try {
      bounded.throwIfAborted();
      return await Promise.race([fn(input, bounded), new Promise((_, reject) => {
        abort = () => reject(Error('worker_http_unavailable'));
        bounded.addEventListener('abort', abort, { once: true }); if (bounded.aborted) abort();
      })]);
    } catch { throw Error('worker_http_unavailable'); }
    finally { controller.abort(); clearTimeout(timer); bounded.removeEventListener('abort', abort); }
  };
  return Object.freeze({
    read: safe(async (input, signal) => {
      check(input.ref === LEDGER_REF);
      const head = await ref(signal);
      const commit = await get('github', `/git/commits/${head}`, signal);
      check(commit.sha === head && sha(commit.tree?.sha));
      const tree = await get('github', `/git/trees/${commit.tree.sha}`, signal);
      check(tree.sha === commit.tree.sha && tree.truncated === false && Array.isArray(tree.tree) && tree.tree.length === 1);
      const file = tree.tree[0]; check(file.path === 'ledger.json' && file.mode === '100644' && file.type === 'blob' && sha(file.sha));
      const blob = await get('github', `/git/blobs/${file.sha}`, signal);
      check(blob.sha === file.sha && blob.encoding === 'base64' && typeof blob.content === 'string' && /^[A-Za-z0-9+/=\r\n]*$/.test(blob.content));
      const bytes = Buffer.from(blob.content, 'base64');
      check(bytes.length <= 2000000 && blob.size === bytes.length && blobSha(bytes) === file.sha);
      const state = structuredClone(parseJson(bytes, { maxBytes: 2000000 })); validateDispatchState(state);
      return { head, state };
    }),
    commit: safe(async (p, signal) => {
      check(p.ref === LEDGER_REF && p.path === 'ledger.json' && p.force === false && Array.isArray(p.parents) && p.parents.length === 1 && sha(p.parents[0]) &&
        typeof p.bytes === 'string' && Buffer.byteLength(p.bytes) <= 2000000 && hash(p.bytes) === p.sha256);
      validateDispatchState(structuredClone(parseJson(Buffer.from(p.bytes), { maxBytes: 2000000 })));
      if (await ref(signal) !== p.parents[0]) return { status: 'rejected' };
      const blob = (await request('github', 'POST', '/git/blobs', { content: p.bytes, encoding: 'utf-8' }, [201], signal)).data;
      check(blob.sha === blobSha(Buffer.from(p.bytes)));
      const tree = (await request('github', 'POST', '/git/trees', { tree: [{ path: 'ledger.json', mode: '100644', type: 'blob', sha: blob.sha }] }, [201], signal)).data;
      check(sha(tree.sha));
      const commit = (await request('github', 'POST', '/git/commits', { message: 'worker-unit reservation transition', tree: tree.sha, parents: p.parents }, [201], signal)).data;
      check(sha(commit.sha) && commit.tree?.sha === tree.sha && commit.parents?.length === 1 && commit.parents[0].sha === p.parents[0]);
      const updated = (await request('github', 'PATCH', `/git/refs/${refPath}`, { sha: commit.sha, force: false }, [200], signal)).data;
      check(updated.ref === LEDGER_REF && updated.object?.sha === commit.sha && updated.object.type === 'commit');
      return { status: 'committed', head: commit.sha, sha256: p.sha256 };
    }),
    dispatch: safe(async (p, signal) => {
      bind(p.binding, config);
      const b = p.binding;
      if (p.provider === 'circleci') {
        check(p.costContract?.configSha === config.circleConfigSha && p.costContract.resourceClass === config.resourceClass &&
          p.costContract.runnerSha === config.runnerSha && p.costContract.suiteDigest === config.suiteDigest);
        await pinnedTag(config.circleConfigTag, config.circleConfigSha, signal);
        const r = await request('circleci', 'POST', `/project/${config.circleProjectSlug}/pipeline/run`, {
          definition_id: config.circleDefinitionId, config: { tag: config.circleConfigTag }, checkout: { tag: config.circleConfigTag },
          parameters: { 'run-worker-pilot': true, 'candidate-sha': b.sourceSha, 'runner-sha': b.runnerSha, 'suite-digest': b.suiteDigest, 'routing-attempt': b.attempt }
        }, [201], signal);
        check(uuid(r.data.id)); return { pipeline: r.data.id };
      }
      check(p.provider === 'github' && p.costContract === null);
      await pinnedTag(config.githubWorkflowTag, config.githubWorkflowSha, signal);
      const r = await request('github', 'POST', `/actions/workflows/${workflow}/dispatches`, {
        ref: config.githubWorkflowTag, inputs: { source_sha: b.sourceSha, runner_sha: b.runnerSha, suite_digest: b.suiteDigest, attempt: b.attempt, run_worker: true }
      }, [200, 204], signal);
      // Legacy no-content acknowledgement cannot identify a run. Never invent one.
      if (r.status === 204) return {};
      check(Number.isSafeInteger(r.data.workflow_run_id) && r.data.workflow_run_id > 0);
      return { pipeline: String(r.data.workflow_run_id) };
    }),
    observe: safe(async (p, signal) => {
      bind(p.binding, config);
      if (p.pipeline === null) return { state: 'unknown' }; // No unauthenticated attempt search or guessed non-dispatch.
      let metadata;
      if (p.provider === 'circleci') {
        check(uuid(p.pipeline));
        const pipeline = await get('circleci', `/pipeline/${p.pipeline}`, signal);
        check(pipeline.id === p.pipeline && pipeline.project_slug === config.circleProjectSlug);
        if (pipeline.vcs?.revision !== config.circleConfigSha) return { state: 'unknown' };
        const workflows = await get('circleci', `/pipeline/${p.pipeline}/workflow`, signal);
        if (workflows.next_page_token || !Array.isArray(workflows.items) || workflows.items.length !== 1) return { state: 'unknown' };
        const w = workflows.items[0]; check(uuid(w.id) && w.pipeline_id === p.pipeline);
        const jobs = await get('circleci', `/workflow/${w.id}/job`, signal);
        if (jobs.next_page_token || !Array.isArray(jobs.items) || jobs.items.length !== 1) return { state: 'unknown' };
        metadata = { pipeline, workflow: w, jobs: jobs.items };
      } else {
        check(p.provider === 'github' && typeof p.pipeline === 'string' && /^[1-9][0-9]{0,15}$/.test(p.pipeline));
        const run = await get('github', `/actions/runs/${p.pipeline}`, signal);
        check(String(run.id) === p.pipeline && run.repository?.full_name === repository && run.event === 'workflow_dispatch' &&
          run.head_sha === config.githubWorkflowSha && run.path === `.github/workflows/${workflow}` && run.run_attempt === 1 &&
          run.display_title === `ci.worker-unit ${p.binding.sourceSha} ${p.binding.attempt}`);
        const jobs = await get('github', `/actions/runs/${p.pipeline}/jobs`, signal);
        if (jobs.total_count !== 1 || !Array.isArray(jobs.jobs) || jobs.jobs.length !== 1) return { state: 'unknown' };
        metadata = { run, jobs: jobs.jobs };
      }
      // Provider success is NOT suite evidence. This hook must independently
      // validate retained complete runner evidence and exact execution identity.
      if (typeof verifyEvidence !== 'function') return { state: 'unknown' };
      const observation = await verifyEvidence(Object.freeze({ expected: structuredClone(p), metadata }), signal);
      check(observation?.binding && Object.keys(p.binding).every(k => observation.binding[k] === p.binding[k]) && observation.pipeline === p.pipeline);
      check(metadata.jobs.some(j => String(j.id) === observation.job));
      if (observation.state === 'passed') check(p.provider === 'github' ? metadata.run.conclusion === 'success' && metadata.jobs[0].conclusion === 'success' : metadata.workflow.status === 'success' && metadata.jobs[0].status === 'success');
      return observation;
    })
  });
}
