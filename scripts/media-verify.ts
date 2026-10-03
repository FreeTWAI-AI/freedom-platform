import {verifyMedia,planMediaVerify,type VerifyCursor,type MediaVerifyOptions} from '../packages/media-migration/verify.js';
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { MEDIA_SOURCES, validateInventoryTarget, type InventoryTarget } from '../packages/media-migration/inventory.js';

type ErrorCode = 'invalid_arguments' | 'database_configuration_required' | 'database_target_mismatch' | 'verify_unavailable';
const failure = (code: ErrorCode) => ({ exitCode: 2, report: {
  format: 'freedom.media-verify-cli/v1', status: 'unavailable', code, dataMoved: false,
} });
const flags = new Map([
  ['--environment', 'environment'], ['--expected-database', 'database'], ['--schema', 'schema'],
  ['--expected-role', 'role'], ['--release-sha', 'releaseSha'],
]);
const usage = 'media:verify --environment local|staging|public --expected-database NAME --schema NAME --expected-role NAME --release-sha SHA [--execute-readonly] [--max-rows 1..128] [--max-bytes 1..67108864] [--statement-timeout-ms 1..30000] [--max-duration-ms 1..60000] [--cursor BASE64URL_JSON] [--baseline-inventory BASE64URL_JSON] [--baseline-records BASE64URL_JSON]';

/** Default mode never opens a database or reads its connection secret. */
export async function runMediaVerify(args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number; report: unknown }> {
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0, report: { usage } };
  const values: Record<string, string> = {};
  let execute = false;const optionFlags=new Set<string>();const limits:Record<string,number>={};let cursor:VerifyCursor|undefined;let baselineInventory:MediaVerifyOptions['baselineInventory'],baselineRecords:MediaVerifyOptions['baselineRecords'];
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--execute-readonly') {
        if (execute) return failure('invalid_arguments');
        execute = true;
      } else if(['--max-rows','--max-bytes','--statement-timeout-ms','--max-duration-ms','--cursor','--baseline-inventory','--baseline-records'].includes(arg)){
        if(optionFlags.has(arg))return failure('invalid_arguments');optionFlags.add(arg);
        const value=args[++i];if(!value||value.startsWith('--'))return failure('invalid_arguments');
        if(['--cursor','--baseline-inventory','--baseline-records'].includes(arg)){if((arg==='--cursor'&&cursor)||(arg==='--baseline-inventory'&&baselineInventory)||(arg==='--baseline-records'&&baselineRecords)||value.length>(arg==='--cursor'?4096:65536)||!/^[A-Za-z0-9_-]+$/.test(value))return failure('invalid_arguments');try{const decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(arg==='--cursor')cursor=decoded;else if(arg==='--baseline-inventory')baselineInventory=decoded;else baselineRecords=decoded;}catch{return failure('invalid_arguments');}}else{const name={'--max-rows':'maxRows','--max-bytes':'maxBytes','--statement-timeout-ms':'statementTimeoutMs','--max-duration-ms':'maxDurationMs'}[arg]!;if(Object.hasOwn(limits,name)||!/^\d{1,9}$/.test(value))return failure('invalid_arguments');limits[name]=Number(value);}
      } else {
        const field = flags.get(arg);
        if (!field || Object.hasOwn(values, field) || !args[i + 1] || args[i + 1].startsWith('--')) return failure('invalid_arguments');
        values[field] = args[++i];
      }
    }
    let target: InventoryTarget;
    try { target = validateInventoryTarget(values); } catch { return failure('invalid_arguments'); }
    if((limits.maxRows!==undefined&&(limits.maxRows<1||limits.maxRows>128))||(limits.maxBytes!==undefined&&(limits.maxBytes<1||limits.maxBytes>67108864))||(limits.statementTimeoutMs!==undefined&&(limits.statementTimeoutMs<1||limits.statementTimeoutMs>30000))||(limits.maxDurationMs!==undefined&&(limits.maxDurationMs<1||limits.maxDurationMs>60000)))return failure('invalid_arguments');
    let plan;try{plan=planMediaVerify({target,limits,cursor,baselineInventory,baselineRecords});}catch{return failure('invalid_arguments');}
    if (!execute) return { exitCode: 0, report: {
      format: 'freedom.media-verify-cli/v1', dry_run: true, dataMoved: false, target,
      profiles: MEDIA_SOURCES, plan, execution: 'not_run', migrationReadiness: 'not_evaluated',
      requirements: ['explicit_readonly_role', 'matching_database_schema', 'operator_authorized_environment'],
    } };
    const connectionString = env.FREEDOM_MEDIA_DATABASE_URL;
    if (!connectionString) return failure('database_configuration_required');
    let url: URL;
    try {
      url = new URL(connectionString);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash
        || decodeURIComponent(url.pathname.slice(1)) !== target.database || decodeURIComponent(url.username) !== target.role) return failure('database_target_mismatch');
      const entries = [...url.searchParams];
      if (new Set(entries.map(([key]) => key)).size !== entries.length) return failure('database_target_mismatch');
      if (target.environment === 'local') {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || entries.some(([key]) => key !== 'host')) return failure('database_target_mismatch');
        const socket = url.searchParams.get('host');
        if (socket !== null && (!/^\/[a-zA-Z0-9_./-]+$/.test(socket) || socket.includes('/../') || socket.includes('/./'))) return failure('database_target_mismatch');
      } else if (url.searchParams.get('sslmode') !== 'verify-full' || entries.some(([key]) => key !== 'sslmode')) return failure('database_target_mismatch');
    } catch { return failure('database_target_mismatch'); }
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, application_name: 'freedom-media-verify' });
    try {
      const verification = await verifyMedia(pool, {target,limits,cursor,baselineInventory,baselineRecords});
      return { exitCode: verification.scanComplete&&verification.verificationCompleteness==='bounded_batch_verified'&&!verification.inventoryDrift ? 0 : 2, report: {
        format: 'freedom.media-verify-cli/v1', dry_run: false, readOnly: true, dataMoved: false, verification,
      } };
    } catch { return failure('verify_unavailable'); }
    finally { await pool.end(); }
  } catch { return failure('verify_unavailable'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMediaVerify(process.argv.slice(2), process.env);
  process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
  process.exitCode = result.exitCode;
}
