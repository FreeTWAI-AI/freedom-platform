import { openSync, closeSync, readSync, fstatSync, readdirSync, constants } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_LIMITS, MigrationPlanError } from './migration-plan.mjs';

/** Local fixed-source adapter. No links/devices, bounded bytes, strict UTF-8. */
export function readMigrationSources(directory) {
  const files = readdirSync(directory, { withFileTypes: true }).filter(e => e.name.endsWith('.sql')).sort((a, b) => a.name < b.name ? -1 : 1);
  if (files.length > MIGRATION_LIMITS.files) throw new MigrationPlanError('migration_catalog_limit');
  let total = 0;
  return files.map(entry => {
    if (!entry.isFile()) throw new MigrationPlanError('migration_source_not_regular');
    const fd = openSync(join(directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new MigrationPlanError('migration_source_not_regular');
      if (stat.size > MIGRATION_LIMITS.fileBytes || (total += stat.size) > MIGRATION_LIMITS.totalBytes) throw new MigrationPlanError('migration_catalog_limit');
      const buffer = Buffer.alloc(stat.size + 1); let length = 0, count;
      do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count && length < buffer.length);
      const after = fstatSync(fd);
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new MigrationPlanError('migration_source_changed');
      const data = buffer.subarray(0, length);
      let sql; try { sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new MigrationPlanError('migration_source_invalid_utf8'); }
      return { name: entry.name, sql };
    } finally { closeSync(fd); }
  });
}
