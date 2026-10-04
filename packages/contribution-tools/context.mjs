import { artifactPath, readBounded, parseJson, sha256 } from './io.mjs';
import { parseFormat, validateFormat } from './formats.mjs';
import { inspectWorkspace, readRevisionFile } from './workspace.mjs';
import { VerificationError, requireCondition as check } from './errors.mjs';
import { validateReleaseSet } from './contracts.mjs';

export const ROOT_INSTRUCTIONS = ['AGENTS.md', 'README.md', 'CONTRIBUTING.md'];
export const isModuleDescriptorPath = path => path === 'freedom.module.json' || path.endsWith('/freedom.module.json');
export function validateDescriptor(value) {
  validateFormat('moduleDescriptor', value);
  for (const path of value.owned_paths) {
    const prefix = path.endsWith('/**') ? path.slice(0, -3) : path;
    artifactPath(prefix);
    check(!prefix.includes('*'), 'invalid_module_pattern');
  }
  for (const path of [...value.public_exports, ...value.instructions, ...value.surfaces.map(surface => surface.entry)]) artifactPath(path);
  check(new Set(value.surfaces.map(surface => surface.surface_id)).size === value.surfaces.length, 'duplicate_surface');
  return value;
}

export function owns(descriptor, path) {
  return descriptor.owned_paths.some(pattern => pattern.endsWith('/**')
    ? path.startsWith(pattern.slice(0, -2)) : path === pattern);
}

export function selectImpact({ baseline, candidate, changedPaths, requestedPaths = [], scopes = [] }) {
  const descriptors = [...baseline, ...candidate], modules = new Set(), unknown = [];
  const known = new Set(descriptors.map(item => item.module_id));
  for (const scope of scopes) {
    check(known.has(scope), 'unknown_module_scope');
    modules.add(scope);
  }
  for (const path of new Set([...changedPaths, ...requestedPaths])) {
    artifactPath(path);
    const matched = descriptors.filter(item => owns(item, path));
    for (const item of matched) modules.add(item.module_id);
    if (ROOT_INSTRUCTIONS.includes(path)) for (const id of known) modules.add(id);
    if (!matched.length && !/^docs\/.*\.md$/.test(path) && !ROOT_INSTRUCTIONS.includes(path)) unknown.push(path);
  }
  // Renamed/deleted/shrunk candidate globs cannot subtract the baseline's impact.
  if (unknown.length) for (const id of known) modules.add(id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of descriptors) if (!modules.has(item.module_id) && item.dependencies.some(id => modules.has(id))) {
      modules.add(item.module_id); grew = true;
    }
  }
  const selected = descriptors.filter(item => modules.has(item.module_id));
  return { module_ids: [...modules].sort(), tests: [...new Set(selected.flatMap(item => item.tests))].sort(),
    instructions: [...new Set(selected.flatMap(item => item.instructions))].sort(), unknown_paths: [...new Set(unknown)].sort() };
}

async function descriptorsFor(workspace, revision) {
  const paths = (revision === 'base' ? workspace.base_paths : workspace.candidate_paths).filter(isModuleDescriptorPath);
  check(paths.length <= 256, 'module_limit');
  const descriptors = [];
  for (const path of paths) {
    let bytes;
    if (revision === 'base') bytes = readRevisionFile(workspace, path);
    else {
      try { bytes = await readBounded(workspace.root, path); }
      catch (error) { if (error.code === 'artifact_missing') continue; throw error; }
    }
    const descriptor = validateDescriptor(parseFormat('moduleDescriptor', bytes));
    // A descriptor change always selects its own previous/new module.
    descriptors.push({ ...descriptor, owned_paths: [...descriptor.owned_paths, path] });
  }
  check(new Set(descriptors.map(item => item.module_id)).size === descriptors.length, 'duplicate_module');
  const known = new Set(descriptors.map(item => item.module_id));
  for (const item of descriptors) check(item.dependencies.every(id => known.has(id)), 'module_dependency_missing');
  const active = new Set(), done = new Set(), byId = new Map(descriptors.map(item => [item.module_id, item]));
  const visit = id => {
    check(!active.has(id), 'module_dependency_cycle');
    if (done.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    active.delete(id); done.add(id);
  };
  for (const id of known) visit(id);
  return descriptors;
}

function allowedInstruction(path) {
  artifactPath(path);
  check(ROOT_INSTRUCTIONS.includes(path) || path.endsWith('/AGENTS.md') || /^(docs|modules|packages|contracts|governance)\/.*\.md$/.test(path)
    || path === 'vendor/freedom-tooling/governance/README.md', 'instruction_path_denied');
  check(!path.split('/').some(part => part.startsWith('.')), 'instruction_path_denied');
}

async function versionInputs(workspace) {
  const inputs = [];
  const paths = ['contracts.lock.json', 'contracts/preview/v1/bundle.json', 'vendor/freedom-platform/bundle.json',
    'vendor/freedom-platform/release-set.json', 'package.json', 'package-lock.json', 'Cargo.lock'];
  for (const path of paths) for (const revision of ['base', 'candidate']) {
    if (!(revision === 'base' ? workspace.base_paths : workspace.candidate_paths).includes(path)) continue;
    let bytes;
    try { bytes = revision === 'base' ? readRevisionFile(workspace, path) : await readBounded(workspace.root, path); }
    catch (error) { if (revision === 'candidate' && error.code === 'artifact_missing') continue; throw error; }
    const input = { path, revision, sha256: sha256(bytes), bytes: bytes.length };
    // Only fixed, public contract formats are copied. Dependency manifests/locks
    // are fingerprinted, not dumped into context (they can contain registry URLs).
    if (!['package.json', 'package-lock.json', 'Cargo.lock'].includes(path)) {
      const data = parseJson(bytes);
      if (path === 'contracts.lock.json') validateFormat(data.format === 'freedom.contract-pin/v1' ? 'lockV1' : 'lockV2', data);
      else if (path.endsWith('/release-set.json')) validateReleaseSet(data);
      else {
        check(data.format === 'freedom.contract-bundle/v1' && data.protocol === 'freedom.preview/v1'
          && typeof data.protocol_sha256 === 'string' && /^[a-f0-9]{64}$/.test(data.protocol_sha256), 'invalid_preview_bundle');
        // Preview metadata is not a ReleaseSet or an execution authorization.
        input.content = JSON.stringify({ format: data.format, protocol: data.protocol, protocol_sha256: data.protocol_sha256 });
      }
      input.content ??= bytes.toString('utf8');
    }
    inputs.push(input);
  }
  return inputs;
}

export async function buildContext({ repositoryRoot, baseRef = 'origin/main', requestedPaths = [], scopes = [], repository }) {
  check(Array.isArray(requestedPaths) && requestedPaths.length <= 4096 && Array.isArray(scopes) && scopes.length <= 256, 'invalid_arguments');
  for (const path of requestedPaths) artifactPath(path);
  for (const scope of scopes) check(typeof scope === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(scope)
    && !/[\r\n]/.test(scope), 'invalid_module_scope');
  const workspace = await inspectWorkspace(repositoryRoot, baseRef);
  if (!repository) {
    const pkg = parseJson(await readBounded(workspace.root, 'package.json'));
    // Reviewed existing scoped consumer names; this labels local context, never
    // authenticates a remote repository or grants publisher trust.
    const scopedNames = { '@freetwai/agent-kit': 'freedom-agent-kit', '@freetwai/freedom-storefront': 'freedom-storefront' };
    const name = Object.hasOwn(scopedNames, pkg.name) ? scopedNames[pkg.name] : pkg.name;
    check(typeof name === 'string' && /^freedom-[a-z-]+$/.test(name) && !/[\r\n]/.test(name), 'repository_identity_required');
    repository = 'FreeTWAI-AI/' + name;
  }
  const baseline = await descriptorsFor(workspace, 'base'), candidate = await descriptorsFor(workspace, 'candidate');
  const impact = selectImpact({ baseline, candidate, changedPaths: workspace.changed_paths, requestedPaths, scopes });
  const blockers = [], documents = [], seen = new Set(); let totalBytes = 0;
  if (!baseline.length) blockers.push('baseline_governance_unavailable');
  if (!candidate.length) blockers.push('candidate_governance_unavailable');
  if (impact.unknown_paths.length) blockers.push('surface_unmapped');
  const sharedInstructions = ['contracts/README.md', 'vendor/freedom-tooling/governance/README.md']
    .filter(path => workspace.base_paths.includes(path) || workspace.candidate_paths.includes(path));
  const relevantPaths = [...workspace.changed_paths, ...requestedPaths, ...[...baseline, ...candidate]
    .filter(item => impact.module_ids.includes(item.module_id)).flatMap(item => item.owned_paths.map(path => path.replace(/\/\*\*$/, '/')))];
  const nestedInstructions = [...workspace.base_paths, ...workspace.candidate_paths].filter(path => path.endsWith('/AGENTS.md')
    && relevantPaths.some(target => target.startsWith(path.slice(0, -'AGENTS.md'.length))));
  const instructions = [...new Set([...ROOT_INSTRUCTIONS, ...sharedInstructions, ...nestedInstructions, ...impact.instructions])];
  for (const path of instructions) {
    allowedInstruction(path);
    for (const revision of ['base', 'candidate']) {
      if (revision === 'base' && !workspace.base_paths.includes(path)) continue;
      let bytes;
      try { bytes = revision === 'base' ? readRevisionFile(workspace, path) : await readBounded(workspace.root, path); }
      catch (error) {
        if (revision === 'candidate' && error.code === 'artifact_missing') { blockers.push('instruction_missing'); continue; }
        throw error;
      }
      const digest = sha256(bytes), identity = path + ':' + digest;
      if (seen.has(identity)) continue;
      seen.add(identity); totalBytes += bytes.length;
      check(totalBytes <= 512_000, 'context_size_limit');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new VerificationError('invalid_instruction_encoding'); }
      documents.push({ path, revision, sha256: digest, bytes: bytes.length, content });
    }
  }
  // Descriptors cite policies, not new ACLs. Existence is not behavior coverage.
  for (const descriptor of candidate) if (impact.module_ids.includes(descriptor.module_id)) {
    for (const entry of [...descriptor.public_exports, ...descriptor.surfaces.map(surface => surface.entry)]) {
      await readBounded(workspace.root, entry);
    }
  }
  const context = { format: 'freedom.coding-context/v1', assurance_level: 'local',
    task_id: 'task-' + sha256(JSON.stringify([workspace.base_commit, workspace.head_commit, workspace.workspace_sha256, requestedPaths, scopes])).slice(0, 16),
    repository, workspace_id: workspace.workspace_id, branch: workspace.branch,
    base_commit: workspace.base_commit, head_commit: workspace.head_commit,
    workspace_sha256: workspace.workspace_sha256, requested_paths: [...new Set(requestedPaths)].sort(), changed_paths: workspace.changed_paths,
    module_ids: impact.module_ids, documents, version_inputs: await versionInputs(workspace),
    publisher_trust: 'unverified', library_usage: 'not_checked',
    tests: impact.tests, blockers: [...new Set(blockers)].sort() };
  check(totalBytes + context.version_inputs.reduce((sum, input) => sum + Buffer.byteLength(input.content ?? ''), 0) <= 512_000, 'context_size_limit');
  validateFormat('codingContext', context);
  const after = await inspectWorkspace(workspace.root, baseRef);
  check(after.workspace_sha256 === workspace.workspace_sha256, 'workspace_changed_during_context');
  return { context, workspace, baseline, candidate, impact };
}
