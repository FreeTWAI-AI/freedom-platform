import { resolve, dirname } from 'node:path';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { runPinnedSuite } from '../../packages/contribution-tools/suite-runner.mjs';
import { PINNED_SUITES } from '../../packages/contribution-tools/pinned-suites.mjs';

async function main() {
  const args = process.argv.slice(2);
  let root, suiteId, output;

  if (args.length === 4 && args[0] === '--root' && args[2] === '--suite') {
    root = args[1];
    suiteId = args[3];
  } else if (args.length === 6 && args[0] === '--root' && args[2] === '--suite' && args[4] === '--output') {
    root = args[1];
    suiteId = args[3];
    output = args[5];
  } else {
    process.stderr.write('invalid_pinned_suite_arguments\n');
    process.exit(2);
  }

  const rootPath = resolve(root);
  try {
    const s = await stat(rootPath);
    if (!s.isDirectory()) throw new Error();
  } catch {
    process.stderr.write('invalid_pinned_suite_arguments\n');
    process.exit(2);
  }

  // An unknown id still reaches runPinnedSuite, which returns suite_adapter_unavailable.
  const suite = PINNED_SUITES[suiteId];
  const options = { env: {} };
  if (suite) {
    if (suite.database && process.env.TEST_DATABASE_URL) {
      options.testDatabaseUrl = process.env.TEST_DATABASE_URL;
    }
    if (suite.env) {
      for (const name of suite.env) {
        if (process.env[name] !== undefined) {
          options.env[name] = process.env[name];
        }
      }
    }
  }

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  options.signal = ac.signal;

  const result = await runPinnedSuite(rootPath, suiteId, options);

  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  output = output ? resolve(output) : resolve(rootPath, `.freedom/reports/pinned-${suiteId}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const summary = {
    check_id: result.check_id,
    status: result.status,
    reason: result.reason,
    test_count: result.test_count,
    file_count: result.selected_files ? result.selected_files.length : undefined,
    evidence_sha256: result.evidence_sha256
  };
  process.stdout.write(JSON.stringify(summary) + '\n');

  if (result.status !== 'passed' && result.test_files) {
    for (const file of result.test_files) {
      const passed = file.counts.tests > 0 && file.counts.tests === file.counts.passed && file.suite_events.every(e => e.status === 'passed');
      if (!passed) {
        process.stdout.write(JSON.stringify({ path: file.path, counts: file.counts }) + '\n');
      }
    }
  }

  if (result.status === 'passed') process.exit(0);
  if (result.status === 'not_run') process.exit(2);
  process.exit(1);
}

main().catch(error => {
  process.stderr.write(error.stack + '\n');
  process.exit(1);
});
