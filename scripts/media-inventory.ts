import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { MEDIA_SOURCES, inventoryMedia, validateInventoryTarget, type InventoryTarget } from '../packages/media-migration/inventory.js';

type ErrorCode = 'invalid_arguments' | 'database_configuration_required' | 'database_target_mismatch' | 'inventory_unavailable';
const failure = (code: ErrorCode) => ({ exitCode: 2, report: {
  format: 'freedom.media-inventory-cli/v1', status: 'unavailable', code, dataMoved: false,
} });
const flags = new Map([
  ['--environment', 'environment'], ['--expected-database', 'database'], ['--schema', 'schema'],
  ['--expected-role', 'role'], ['--release-sha', 'releaseSha'],
]);
const usage = 'media:inventory --environment local|staging|public --expected-database NAME --schema NAME --expected-role NAME --release-sha SHA [--execute-readonly]';

/** Default mode never opens a database or reads its connection secret. */
export async function runMediaInventory(args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number; report: unknown }> {
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0, report: { usage } };
  const values: Record<string, string> = {};
  let execute = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--execute-readonly') {
        if (execute) return failure('invalid_arguments');
        execute = true;
      } else {
        const field = flags.get(arg);
        if (!field || Object.hasOwn(values, field) || !args[i + 1] || args[i + 1].startsWith('--')) return failure('invalid_arguments');
        values[field] = args[++i];
      }
    }
    let target: InventoryTarget;
    try { target = validateInventoryTarget(values); } catch { return failure('invalid_arguments'); }
    if (!execute) return { exitCode: 0, report: {
      format: 'freedom.media-inventory-cli/v1', dry_run: true, dataMoved: false, target,
      profiles: MEDIA_SOURCES, execution: 'not_run', migrationReadiness: 'not_evaluated',
      requirements: ['explicit_readonly_role', 'matching_database_schema', 'operator_authorized_environment'],
    } };
    const connectionString = env.FREEDOM_MEDIA_DATABASE_URL;
    if (!connectionString) return failure('database_configuration_required');
    let url: URL;
    try {
      url = new URL(connectionString);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash
        || decodeURIComponent(url.pathname.slice(1)) !== target.database || !(decodeURIComponent(url.username) === target.role || (target.environment !== 'local' && decodeURIComponent(url.username).startsWith(target.role + '.') && /^[A-Za-z0-9_-]{1,80}$/.test(decodeURIComponent(url.username).slice(target.role.length + 1))))) return failure('database_target_mismatch');
      const entries = [...url.searchParams];
      if (new Set(entries.map(([key]) => key)).size !== entries.length) return failure('database_target_mismatch');
      if (target.environment === 'local') {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || entries.some(([key]) => key !== 'host')) return failure('database_target_mismatch');
        const socket = url.searchParams.get('host');
        if (socket !== null && (!/^\/[a-zA-Z0-9_./-]+$/.test(socket) || socket.includes('/../') || socket.includes('/./'))) return failure('database_target_mismatch');
      } else if (url.searchParams.get('sslmode') !== 'verify-full' || entries.some(([key]) => key !== 'sslmode')) return failure('database_target_mismatch');
    } catch { return failure('database_target_mismatch'); }
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, application_name: 'freedom-media-inventory' });
    try {
      const inventory = await inventoryMedia(pool, target);
      return { exitCode: inventory.completeness === 'aggregate_inventory_complete' ? 0 : 2, report: {
        format: 'freedom.media-inventory-cli/v1', dry_run: false, readOnly: true, dataMoved: false, inventory,
      } };
    } catch { return failure('inventory_unavailable'); }
    finally { await pool.end(); }
  } catch { return failure('inventory_unavailable'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMediaInventory(process.argv.slice(2), process.env);
  process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
  process.exitCode = result.exitCode;
}
