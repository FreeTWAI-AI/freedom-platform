// Imported from the operator's reviewed tools installation, never a PR script.
// Expected pins below are supplied independently by that host, not read from a
// candidate manifest. This local adapter is not an installation approval system.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMigrationSources } from '../../packages/db/migration-files.mjs';
import { resolveMigrationPlan, migrationDigest, MIGRATION_LIMITS, DAG_MIGRATIONS } from '../../packages/db/migration-plan.mjs';

const CORE = Object.freeze(['packages/db/migration-plan.mjs', 'packages/db/migration-files.mjs', 'packages/db/migration-runner.mjs']);
const FORMAT = 'freedom.migration-installation/v1', HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, keys, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail(code);
}
function pinned(value, pattern) { return typeof value === 'string' && pattern.exec(value)?.[0] === value; }
function outside(parent, child) { const p = relative(parent, child); return p.startsWith('..' + '/') || p === '..' || isAbsolute(p); }
function hostDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== realpathSync(path)) fail('migration_installation_path_invalid');
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) fail('migration_installation_path_invalid');
  return path;
}
function read(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd); if (!before.isFile() || before.size > limit) fail('migration_installation_file_invalid');
    const buffer = Buffer.alloc(before.size + 1); let length = 0, count;
    do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count && length < buffer.length);
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('migration_installation_changed');
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
function git(root, args, limit = 4194304) {
  return execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.allow=never', ...args], { cwd: root, timeout: 15000, maxBuffer: limit,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore','pipe','pipe'] });
}
function sourceFile(root, commit, path, limit) {
  const entry = git(root, ['ls-tree', commit, '--', path]).toString();
  const expected = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)\n$/.exec(entry);
  if (!expected || expected[3] !== path) fail('migration_source_not_regular');
  const bytes = git(root, ['cat-file', 'blob', expected[2]], limit + 1);
  if (bytes.length > limit || !bytes.equals(read(join(root, path), limit))) fail('migration_source_changed');
  return bytes;
}
function writeSnapshot(root, records) {
  for (const [path, bytes] of records) {
    mkdirSync(dirname(join(root,path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root,path), bytes, { mode: 0o400, flag: 'wx' });
  }
}
function catalog(records) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return records.filter(([p]) => p.startsWith('migrations/')).map(([p,b]) => ({ name: p.slice(11), sql: decoder.decode(b) }));
}

/** Prepare an external immutable-byte snapshot. Returned digests must be
 * reviewed/pinned by the host; this operation does not approve its own output. */
export function prepareMigrationInstallation({ sourceRoot, sourceCommit, profile, installationParent }) {
  hostDirectory(installationParent);
  if (!pinned(sourceCommit, HEX40) || !isAbsolute(sourceRoot) || realpathSync(sourceRoot) !== resolve(sourceRoot)
    || !outside(sourceRoot, installationParent)) fail('migration_source_identity_invalid');
  if (git(sourceRoot, ['rev-parse','--show-prefix']).toString().trim() !== '' || git(sourceRoot, ['rev-parse','HEAD']).toString().trim() !== sourceCommit
    || git(sourceRoot, ['status','--porcelain=v1','--untracked-files=all']).length) fail('migration_source_mixed_worktree');
  for (const path of ['objects/info/alternates','info/grafts']) {
    const metadata = git(sourceRoot, ['rev-parse','--git-path',path]).toString().trim();
    if (existsSync(resolve(sourceRoot,metadata))) fail('migration_source_indirection');
  }
  const tree = git(sourceRoot,['rev-parse', sourceCommit+'^{tree}']).toString().trim(); if (!pinned(tree, HEX40)) fail('migration_source_identity_invalid');
  const sql = readMigrationSources(join(sourceRoot,'migrations'));
  const records = CORE.map(path => [path,sourceFile(sourceRoot,sourceCommit,path,262144)]);
  records.push(['package-lock.json',sourceFile(sourceRoot,sourceCommit,'package-lock.json',2097152)]);
  for (const entry of sql) records.push(['migrations/'+entry.name,sourceFile(sourceRoot,sourceCommit,'migrations/'+entry.name,MIGRATION_LIMITS.fileBytes)]);
  records.sort(([a],[b]) => a < b ? -1 : 1);
  const plan = resolveMigrationPlan(catalog(records), profile);
  const descriptor = { format: FORMAT, source_commit: sourceCommit, source_tree: tree, profile,
    profile_digest: migrationDigest(profile), plan_digest: plan.plan_digest, ledger_digest: plan.ledger_digest,
    files: records.map(([path,bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) };
  const bytes = Buffer.from(JSON.stringify(descriptor)), directory = mkdtempSync(join(installationParent,'migration-install-'));
  try {
    writeSnapshot(directory,records); writeFileSync(join(directory,'installation.json'),bytes,{ mode:0o400,flag:'wx' });
    return { installation_directory: directory, source_commit: sourceCommit, source_tree: tree,
      installation_digest: hash(bytes), profile_digest: descriptor.profile_digest, plan_digest: plan.plan_digest,
      ledger_digest: plan.ledger_digest, trust: 'host_pin_required', deployment_authorized: false };
  } catch (error) { rmSync(directory,{recursive:true,force:true}); throw error; }
}

function loadInstallation({ installationDirectory, expectedInstallationDigest, expectedSourceCommit, expectedProfileDigest }) {
  hostDirectory(installationDirectory);
  if (!pinned(expectedInstallationDigest,HEX64) || !pinned(expectedProfileDigest,HEX64) || !pinned(expectedSourceCommit,HEX40)) fail('migration_host_pins_required');
  const bytes = read(join(installationDirectory,'installation.json'),2097152);
  if (hash(bytes) !== expectedInstallationDigest) fail('migration_installation_pin_mismatch');
  let value; try { value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { fail('migration_installation_invalid'); }
  exact(value,['format','source_commit','source_tree','profile','profile_digest','plan_digest','ledger_digest','files'],'migration_installation_invalid');
  if (value.format !== FORMAT || value.source_commit !== expectedSourceCommit || !pinned(value.source_tree,HEX40)
    || value.profile_digest !== expectedProfileDigest || migrationDigest(value.profile) !== expectedProfileDigest) fail('migration_source_profile_mismatch');
  if (!Array.isArray(value.files) || value.files.length > MIGRATION_LIMITS.files+4) fail('migration_installation_invalid');
  const records = [], paths = new Set(); let total = 0;
  for (const entry of value.files) {
    exact(entry,['path','bytes','sha256'],'migration_installation_invalid');
    const core = CORE.includes(entry.path) || entry.path === 'package-lock.json';
    if (typeof entry.path !== 'string' || (!core && !/^migrations\/[a-zA-Z0-9_]+\.sql$/.test(entry.path)) || entry.path.length > 139
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MIGRATION_LIMITS.fileBytes || !pinned(entry.sha256,HEX64) || paths.has(entry.path)) fail('migration_installation_invalid');
    paths.add(entry.path); if ((total += entry.bytes) > MIGRATION_LIMITS.totalBytes+3145728) fail('migration_installation_invalid');
    // Refuse symlinked intermediate directories, not just the final file.
    if (realpathSync(dirname(join(installationDirectory,entry.path))) !== dirname(join(installationDirectory,entry.path))) fail('migration_installation_path_invalid');
    const data = read(join(installationDirectory,entry.path),entry.bytes);
    if (data.length !== entry.bytes || hash(data) !== entry.sha256) fail('migration_installation_changed');
    records.push([entry.path,data]);
  }
  if ([...CORE,'package-lock.json'].some(p => !paths.has(p))) fail('migration_installation_incomplete');
  function inspect(path, prefix='') {
    for (const entry of readdirSync(path,{withFileTypes:true})) {
      const key = prefix+entry.name;
      if (entry.isDirectory()) { if (![...paths].some(p => p.startsWith(key+'/'))) fail('migration_installation_extra_file'); inspect(join(path,entry.name),key+'/'); }
      else if (!entry.isFile() || (!paths.has(key) && key !== 'installation.json')) fail('migration_installation_extra_file');
    }
  }
  inspect(installationDirectory);
  const sources = catalog(records), plan = resolveMigrationPlan(sources,value.profile);
  if (plan.plan_digest !== value.plan_digest || plan.ledger_digest !== value.ledger_digest) fail('migration_installation_plan_mismatch');
  return { value,records,sources };
}

/** Caller supplies a host-owned pool and target; no secret file is read here. */
export async function runInstalledMigrations(pool, options) {
  exact(options,['installationDirectory','expectedInstallationDigest','expectedSourceCommit','expectedProfileDigest','target'],'migration_host_arguments_invalid');
  exact(options.target,['database','role','schema'],'migration_target_required');
  const installed = loadInstallation(options);
  // Formal DAG release floors are not installed. This adapter admits DAG only
  // under the existing disposable-test naming boundary, never a public target.
  // Names are a fail-closed compatibility restriction, not isolation authority.
  if (installed.value.profile.format === DAG_MIGRATIONS
    && (typeof options.target.database !== 'string' || !options.target.database.startsWith('fp_')
      || typeof options.target.schema !== 'string' || !options.target.schema.startsWith('fp_'))) fail('migration_v2_target_not_activated');
  // Import only a fresh private copy of the exact validated closure, so later
  // edits of the installation or candidate cannot affect module resolution.
  const temporary = mkdtempSync(join(dirname(options.installationDirectory),'migration-run-'));
  try {
    writeSnapshot(temporary,installed.records.filter(([path]) => CORE.includes(path)));
    const { runMigrationPlan } = await import(pathToFileURL(join(temporary,'packages/db/migration-runner.mjs')).href);
    const result = await runMigrationPlan(pool,{ sources:installed.sources,profile:installed.value.profile,target:options.target });
    return { ...result, source_commit:installed.value.source_commit, source_tree:installed.value.source_tree,
      installation_digest:options.expectedInstallationDigest, profile_digest:options.expectedProfileDigest,
      evidence:'installed-local-operator-entry', deployment_authorized:false };
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}

/** Public repo CLI and private wrapper may share these non-secret host args. */
export function installedMigrationArguments(args) {
  const names = { '--installation':'installationDirectory', '--expected-installation':'expectedInstallationDigest',
    '--expected-source':'expectedSourceCommit', '--expected-profile':'expectedProfileDigest',
    '--database':'database', '--role':'role', '--schema':'schema' };
  if (!Array.isArray(args) || args.length !== 14) fail('migration_host_arguments_invalid');
  const values = {};
  for (let i=0; i<args.length; i+=2) {
    if (!Object.hasOwn(names,args[i])) fail('migration_host_arguments_invalid');
    const key = names[args[i]];
    if (!key || Object.hasOwn(values,key) || typeof args[i+1] !== 'string' || args[i+1].startsWith('--')) fail('migration_host_arguments_invalid');
    values[key] = args[i+1];
  }
  const { database,role,schema,...options } = values; return { ...options,target:{database,role,schema} };
}
