// Operator host only. This module is deliberately outside the portable candidate closure.
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseJson } from './io.mjs';
import { createSignedSupervisorPublisher } from './github-supervisor-publisher.mjs';
import { createGithubAppPublisher } from './github-app-publisher.mjs';

const exact = (v, keys) => v && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const positive = n => Number.isSafeInteger(n) && n > 0;
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const check = (v, code = 'publisher_journal_unavailable') => { if (!v) throw new Error(code); };
const phases = ['pending_confirmed', 'failure_confirmed', 'success_acknowledged', 'success_confirmed', 'write_unknown'];
const bindingKeys = ['repository', 'run_id', 'run_attempt', 'pull_request', 'base_commit', 'head_commit', 'candidate_commit', 'candidate_tree'];
const validBinding = b => exact(b, bindingKeys) && typeof b.repository === 'string' && typeof b.run_id === 'string' && /^[1-9][0-9]{0,15}$/.test(b.run_id) && positive(Number(b.run_id)) && positive(b.run_attempt) && positive(b.pull_request) && bindingKeys.slice(4).every(k => sha(b[k])) && b.head_commit === b.candidate_commit && b.base_commit !== b.head_commit;
const identity = b => `${b.run_id}:${b.run_attempt}`;
const unavailable = code => ({status: 'unavailable', code, gate_enforced: false, merge_authorized: false});
const outside = (parent, child) => { const r = relative(parent, child); return r === '..' || r.startsWith('../') || isAbsolute(r); };

/** Protected, pre-created 0700 operator directory; no stale-lock takeover or unknown-write retry. */
export function createDurableSignedSupervisorPublisher(config, ports) {
  check(exact(config, ['adapterConfig', 'publisherConfig', 'journalRoot']) && exact(ports, ['appRequest', 'installationRequest', 'supervisor']) && Object.values(ports).every(v => typeof v === 'function'), 'publisher_journal_configuration_invalid');
  const captured = structuredClone(config), {appRequest, installationRequest, supervisor} = ports;
  check(typeof captured.journalRoot === 'string' && captured.journalRoot.length <= 4096 && isAbsolute(captured.journalRoot) && resolve(captured.journalRoot) === captured.journalRoot, 'publisher_journal_configuration_invalid');
  const root = captured.journalRoot, p = captured.publisherConfig, prefix = `/repos/${p.repository}`;
  // Validate the existing composition configuration synchronously without invoking any port.
  createSignedSupervisorPublisher({adapterConfig: captured.adapterConfig, publisherConfig: p}, {appRequest, installationRequest, supervisor});
  let busy = false;
  return Object.freeze({ async publish(input) {
    if (busy) return unavailable('publisher_busy');
    busy = true;
    let lock, directory, state, statePath, rootStat;
    const safeFile = s => s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600;
    const unchangedRoot = async () => { const s = await lstat(root); check(s.isDirectory() && !s.isSymbolicLink() && s.dev === rootStat.dev && s.ino === rootStat.ino && s.uid === process.getuid() && (s.mode & 0o777) === 0o700); };
    const save = async () => {
      await unchangedRoot();
      const bytes = Buffer.from(JSON.stringify(state)); check(bytes.length <= 16384);
      const temporary = join(root, `.write-${randomBytes(16).toString('hex')}`);
      const f = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
      await unchangedRoot(); await rename(temporary, statePath); await directory.sync();
    };
    const matches = (value, conclusion, binding) => positive(value?.id) && value.id === state.check_id && value.app?.id === p.app_id && value.head_sha === binding.head_commit && value.name === p.check_name && value.status === 'completed' && value.conclusion === conclusion && value.external_id === `freedom:${p.repository_id}:${binding.run_id}:${binding.run_attempt}:${binding.head_commit}`;
    const write = async (conclusion, binding) => {
      if (state.check_id !== null) {
        const existing = await installationRequest('GET', `${prefix}/check-runs/${state.check_id}`);
        check(existing?.id === state.check_id && existing.app?.id === p.app_id && existing.head_sha === binding.head_commit && existing.name === p.check_name);
      }
      state.phase = 'write_unknown'; state.operation = conclusion; await save(); // Durable before HTTP, including PATCH.
      const body = {status: 'completed', conclusion, external_id: `freedom:${p.repository_id}:${binding.run_id}:${binding.run_attempt}:${binding.head_commit}`, output: {title: 'Fixed host verification', summary: conclusion === 'success' ? 'The installed verifier accepted this exact candidate.' : 'This candidate has no current accepted host verification.'}};
      const value = state.check_id === null
        ? await installationRequest('POST', `${prefix}/check-runs`, {name: p.check_name, head_sha: binding.head_commit, ...body})
        : await installationRequest('PATCH', `${prefix}/check-runs/${state.check_id}`, body);
      if (state.check_id === null) { check(positive(value?.id)); state.check_id = value.id; }
      check(matches(value, conclusion, binding));
      // A fulfilled and validated success acknowledgement is known, even if later reads fail.
      state.phase = conclusion === 'success' ? 'success_acknowledged' : 'failure_confirmed'; await save();
      const readback = await installationRequest('GET', `${prefix}/check-runs/${state.check_id}`);
      check(matches(readback, conclusion, binding));
      return value;
    };
    try {
      check(validBinding(input) && input.repository === p.repository, 'publisher_binding_invalid');
      const binding = Object.freeze({...input});
      rootStat = await lstat(root); check(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid() && (rootStat.mode & 0o777) === 0o700 && await realpath(root) === root);
      check(Array.isArray(captured.adapterConfig.candidate_roots));
      for (const candidate of captured.adapterConfig.candidate_roots) { const c = await realpath(candidate); check(outside(c, root) && outside(root, c)); }
      directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const entries = await readdir(root); check(entries.length <= 128 && entries.every(e => /^[a-f0-9]{40}\.json$/.test(e)));
      for (const entry of entries) { const s = await lstat(join(root, entry)); check(safeFile(s) && s.size <= 16384); }
      lock = await open(join(root, '.publisher.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await lock.writeFile('freedom.publisher-lock/v1\n'); await lock.sync(); await directory.sync();
      statePath = join(root, `${binding.head_commit}.json`);
      let f;
      try { f = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (f) {
        try {
          const s = await f.stat(); check(safeFile(s) && s.size <= 16384);
          const bytes = Buffer.alloc(16385); let size = 0;
          while (size < bytes.length) { const {bytesRead} = await f.read(bytes, size, bytes.length - size, size); if (!bytesRead) break; size += bytesRead; }
          check(size <= 16384); state = parseJson(bytes.subarray(0, size), {maxBytes: 16384, maxDepth: 4, maxNodes: 512});
        } finally { await f.close(); }
        check(exact(state, ['format', 'repository_id', 'app_id', 'installation_id', 'check_name', 'binding', 'fence', 'check_id', 'phase', 'operation', 'attempts']) && state.format === 'freedom.publisher-journal/v1' && state.repository_id === p.repository_id && state.app_id === p.app_id && state.installation_id === p.installation_id && state.check_name === p.check_name && validBinding(state.binding) && state.binding.repository === binding.repository && state.binding.head_commit === binding.head_commit && state.binding.pull_request === binding.pull_request && positive(state.fence) && (state.check_id === null || positive(state.check_id)) && phases.includes(state.phase) && ['failure', 'success'].includes(state.operation) && Array.isArray(state.attempts) && state.attempts.length <= 128 && state.attempts.every(v => typeof v === 'string' && /^[1-9][0-9]{0,15}:[1-9][0-9]{0,15}$/.test(v)) && new Set(state.attempts).size === state.attempts.length);
        check(state.attempts.length > 0 && state.attempts.includes(identity(state.binding)) && state.attempts.every(v => v.split(':').every(n => positive(Number(n)))) &&
          (state.phase === 'write_unknown' ? state.check_id !== null || state.operation === 'failure' : state.check_id !== null) &&
          (!state.phase.startsWith('success_') || state.operation === 'success') &&
          (!['pending_confirmed', 'failure_confirmed'].includes(state.phase) || state.operation === 'failure'));
        check(state.phase !== 'write_unknown' && state.phase !== 'success_acknowledged', 'publisher_journal_unknown_write');
        check(!state.attempts.includes(identity(binding)) && state.attempts.length < 128 && state.fence < Number.MAX_SAFE_INTEGER, 'publisher_replay_unavailable');
        // GitHub's per-run API authenticates that run, not global ordering between different runs.
        check(state.binding.run_id === binding.run_id, 'publisher_run_supersession_unavailable');
        check(binding.run_attempt > state.binding.run_attempt, 'publisher_replay_unavailable');
      } else {
        check(entries.length < 128);
        state = {format: 'freedom.publisher-journal/v1', repository_id: p.repository_id, app_id: p.app_id, installation_id: p.installation_id, check_name: p.check_name, binding, fence: 1, check_id: null, phase: 'failure_confirmed', operation: 'failure', attempts: []};
      }
      const signed = createSignedSupervisorPublisher({adapterConfig: captured.adapterConfig, publisherConfig: p}, {
        appRequest,
        installationRequest: async (method, path, body) => {
          if (method === 'POST') { check(path === `${prefix}/check-runs` && body?.conclusion === 'success'); return write('success', binding); }
          return installationRequest(method, path, body);
        },
        supervisor: async authenticated => {
          // Called only after the existing publisher's authenticated App/run/attempt/PR/tree checks.
          state.binding = authenticated; state.fence++; state.attempts.push(identity(authenticated));
          await write('failure', authenticated); state.phase = 'pending_confirmed'; await save();
          return supervisor(authenticated);
        }
      });
      const result = await signed.publish(binding);
      if (result.status === 'published') { state.phase = 'success_confirmed'; await save(); }
      else if (state.phase === 'success_acknowledged') {
        // Compensation is allowed only for a known fulfilled write and a freshly authenticated target.
        let fresh = false;
        await createGithubAppPublisher(p, {appRequest, installationRequest, verify: async () => { fresh = true; throw new Error('publisher_compensation_probe'); }}).publish(binding);
        check(fresh, 'publisher_compensation_unavailable'); await write('failure', binding);
      } else if (state.phase === 'pending_confirmed') { state.phase = 'failure_confirmed'; await save(); }
      return result;
    } catch (error) {
      return unavailable(/^publisher_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'publisher_journal_unavailable');
    } finally {
      if (lock) {
        try { const ours = await lock.stat(), current = await lstat(join(root, '.publisher.lock')); check(safeFile(current) && current.ino === ours.ino && current.dev === ours.dev); await unchangedRoot(); await unlink(join(root, '.publisher.lock')); await directory.sync(); } catch { /* Ownership ambiguity stays locked; never take over. */ }
        await lock.close().catch(() => {});
      }
      if (directory) await directory.close().catch(() => {});
      busy = false;
    }
  }});
}
