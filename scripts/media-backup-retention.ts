import { pathToFileURL } from 'node:url';
import { createFileArchiveStore } from '../packages/media-migration/backup-archive-fs.js';
import { planRecoverySetRetention, RetentionError } from '../packages/media-migration/backup-retention.js';

/** Plan-only retention for a local recovery-set archive directory. It reads
 * manifests and readback receipts, never dumps or secrets, and never deletes,
 * releases pins or connects to a database. Exit codes: 0 planned, 3 no freshly
 * verified recovery set (fail closed), 2 invalid arguments/unavailable. */
export async function runBackupRetention(args: string[]) {
  const failure = (code: string) => ({ exitCode: 2, report: { format: 'freedom.recovery-retention-plan/v1', status: 'unavailable', code,
    execution: 'not_run' } });
  try {
    const flags: Record<string, string> = { '--archive-dir': 'dir', '--now': 'now', '--keep-verified': 'keep',
      '--min-retention-hours': 'minHours', '--max-readback-age-hours': 'readbackHours', '--max-sets': 'maxSets' };
    const values: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      const field = flags[args[i]];
      if (!field || Object.hasOwn(values, field) || !args[i + 1] || args[i + 1].startsWith('--')) return failure('invalid_arguments');
      values[field] = args[++i];
    }
    const integer = (v: string | undefined) => (v !== undefined && /^(0|[1-9][0-9]{0,6})$/.test(v) ? Number(v) : NaN);
    const keepVerified = integer(values.keep), minHours = integer(values.minHours), readbackHours = integer(values.readbackHours);
    const maxSets = values.maxSets === undefined ? 1000 : integer(values.maxSets);
    // Every retention parameter is explicit; there is no default retention policy.
    if (!values.dir || !values.now || [keepVerified, minHours, readbackHours, maxSets].some(Number.isNaN)) return failure('invalid_arguments');
    const archive = await createFileArchiveStore(values.dir);
    const plan = await planRecoverySetRetention(archive, { keepVerified, minRetentionSeconds: minHours * 3600,
      maxReadbackAgeSeconds: readbackHours * 3600, maxSets }, values.now);
    return { exitCode: plan.status === 'planned' ? 0 : 3, report: plan };
  } catch (error) {
    return failure(error instanceof RetentionError ? error.code : 'invalid_arguments');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runBackupRetention(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
  process.exitCode = result.exitCode;
}
