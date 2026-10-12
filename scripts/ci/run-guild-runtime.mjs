import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {runLocalSuite} from '../../packages/contribution-tools/suite-runner.mjs';
import {GUILD_PRESENTATION_PROFILE} from '../../packages/contribution-tools/guild-presentation-profile.mjs';

// Fixed host-owned suite; neither a descriptor nor a CLI file list can replace it.
if (process.argv.length !== 2) throw Error('invalid_guild_runtime_arguments');
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const report = await runLocalSuite(process.cwd(), GUILD_PRESENTATION_PROFILE.runtimeSuite, {
  testDatabaseUrl: process.env.TEST_DATABASE_URL, signal: controller.signal,
});
const output = resolve('.freedom/reports/guild-runtime.json');
await mkdir(dirname(output), {recursive: true});
await writeFile(output, JSON.stringify(report) + '\n');
console.log(JSON.stringify({check_id: report.check_id, status: report.status, reason: report.reason, test_count: report.test_count}));
process.exitCode = report.status === 'passed' ? 0 : 1;
