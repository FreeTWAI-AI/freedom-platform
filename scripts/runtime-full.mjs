import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { runLocalSuite, runRuntimePartition } from '../packages/contribution-tools/suite-runner.mjs';

// Diagnostic execution only. This is not an authenticated governance check.
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const args = process.argv.slice(2);
let report, output;
if (args.length) {
  if (args.length !== 6 || args[0] !== '--partition-count' || !['4','6'].includes(args[1]) ||
    args[2] !== '--partition-index' || !/^[0-9]$/.test(args[3]) || Number(args[3]) >= Number(args[1]) || args[4] !== '--output' || !args[5]) {
    console.error('invalid_runtime_partition_arguments'); process.exit(2);
  }
  report = await runRuntimePartition(process.cwd(), { partitionCount:Number(args[1]),partitionIndex:Number(args[3]),
    testDatabaseUrl:process.env.TEST_DATABASE_URL,signal:controller.signal });
  output = resolve(args[5]);
} else {
  report = await runLocalSuite(process.cwd(), 'runtime.full', {
    testDatabaseUrl: process.env.TEST_DATABASE_URL, signal: controller.signal,
  });
  output = resolve('.freedom/reports/runtime-full-shards.json');
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report) + '\n');
const outcome = report.report ?? report;
console.log(JSON.stringify({ check_id:report.check_id,status:outcome.status,reason:outcome.reason,
  test_count:outcome.test_count,partition_index:report.partition_index,evidence_sha256:outcome.evidence_sha256,
  database_cleanup_verified:report.database_cleanup_verified }));
process.exitCode = outcome.status === 'passed' ? 0 : outcome.status === 'not_run' ? 2 : 1;
