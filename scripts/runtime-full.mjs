import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runLocalSuite } from '../packages/contribution-tools/suite-runner.mjs';

// Diagnostic execution only. This is not an authenticated governance check.
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const report = await runLocalSuite(process.cwd(), 'runtime.full', {
  testDatabaseUrl: process.env.TEST_DATABASE_URL, signal: controller.signal,
});
const directory = resolve('.freedom/reports');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'runtime-full-shards.json'), JSON.stringify(report) + '\n');
console.log(JSON.stringify({ status: report.status, reason: report.reason, test_count: report.test_count,
  shard_count: report.shards?.length, evidence_sha256: report.evidence_sha256,
  database_cleanup_verified: report.database_cleanup_verified }));
process.exitCode = report.status === 'passed' ? 0 : report.status === 'not_run' ? 2 : 1;
