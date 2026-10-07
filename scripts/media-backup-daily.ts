import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runDailyBackup, type DailyBackupAdapter, type DailyBackupContext } from '../packages/media-migration/backup-daily.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const invalid = () => { throw Error('invalid_daily_backup_installation'); };
async function privateDirectory(path: string) {
  if (!isAbsolute(path) || await realpath(path) !== path) invalid();
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) invalid();
}
async function record(path: string, value: unknown) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Explicit operator executable. No discovery of provider credentials/config,
 * implicit retry, source checkout update, retention, pin release or cutover. */
export async function runDailyBackupCli(args: string[]) {
  let runDirectory: string | undefined;
  try {
    const allowed = ['adapter', 'adapter-sha256', 'environment', 'database', 'schema', 'release', 'operator-source', 'state-dir'];
    const values: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]?.replace(/^--/, '');
      if (!args[index]?.startsWith('--') || !(allowed.includes(key) || key === 'gc-safety') || Object.hasOwn(values, key)
        || !args[index + 1] || args[index + 1].startsWith('--')) invalid();
      values[key] = args[index + 1];
    }
    if (!allowed.every(key => Object.hasOwn(values, key)) || !['production', 'staging'].includes(values.environment)
      || !(values['gc-safety'] === undefined || ['disabled', 'snapshot-pins'].includes(values['gc-safety']))
      || ![values.database, values.schema].every(v => /^[a-z_][a-z0-9_]{0,62}$/.test(v))
      || ![values.release, values['operator-source']].every(v => /^[a-f0-9]{40}$/.test(v))
      || !/^[a-f0-9]{64}$/.test(values['adapter-sha256']) || !isAbsolute(values.adapter)) invalid();
    // The private adapter is operator code. Its explicit hash is an installation
    // check, not a sandbox or an approval of its transitive imports.
    const adapterPath = await realpath(values.adapter), stat = await lstat(values.adapter);
    if (adapterPath !== values.adapter || !stat.isFile() || stat.size > 1024 * 1024
      || ![0, process.getuid!()].includes(stat.uid) || (stat.mode & 0o022) !== 0) invalid();
    if (createHash('sha256').update(await readFile(adapterPath)).digest('hex') !== values['adapter-sha256']) invalid();
    await privateDirectory(values['state-dir']);
    const git = (commands: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null', ...commands], { cwd: root, timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
    if (git(['rev-parse', 'HEAD']) !== values['operator-source'] || git(['status', '--porcelain', '--untracked-files=no'])) invalid();
    const loaded = await import(pathToFileURL(adapterPath).href);
    if (createHash('sha256').update(await readFile(adapterPath)).digest('hex') !== values['adapter-sha256']) invalid();
    const adapter = loaded.dailyBackupAdapter as DailyBackupAdapter;
    const setId = randomUUID(), createdAt = new Date().toISOString(), controller = new AbortController();
    runDirectory = join(values['state-dir'], setId); await mkdir(runDirectory, { mode: 0o700 });
    const context: DailyBackupContext = Object.freeze({ environment: values.environment as 'production' | 'staging',
      database: values.database, schema: values.schema, sourceRelease: values.release, operatorSource: values['operator-source'],
      setId, createdAt, runDirectory, signal: controller.signal,
      ...(values['gc-safety'] === undefined ? {} : { gcSafety: values['gc-safety'] as 'disabled' | 'snapshot-pins' }) });
    const identity = { format: 'freedom.daily-recovery-run/v1', environment: context.environment, database: context.database,
      schema: context.schema, sourceRelease: context.sourceRelease, operatorSource: context.operatorSource,
      adapterSha256: values['adapter-sha256'], gcSafety: context.gcSafety ?? 'disabled', setId, createdAt };
    await record(join(runDirectory, 'started.json'), identity);
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    // Ports must honour this signal and bound their own I/O. systemd provides
    // the independent final process deadline; a killed run has no completion.
    const timer = setTimeout(abort, 20 * 60 * 1000); timer.unref();
    try {
      const result = await runDailyBackup(context, adapter);
      const report = { ...result, adapterSha256: identity.adapterSha256 };
      await record(join(runDirectory, result.status === 'passed' ? 'completed.json' : 'failed.json'), report);
      return { exitCode: result.status === 'passed' ? 0 : 1, report };
    } finally { clearTimeout(timer); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } catch {
    // Never print adapter/provider/SQL diagnostics or private paths.
    const report = { format: 'freedom.daily-recovery-backup/v1', status: 'failed', code: 'daily_backup_installation_or_record_failed',
      cleanupVerified: false, cutoverAuthorized: false };
    if (runDirectory) { try { await record(join(runDirectory, 'unavailable.json'), report); } catch { /* retain existing records */ } }
    return { exitCode: 1, report };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDailyBackupCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.report) + '\n'); process.exitCode = result.exitCode;
}
