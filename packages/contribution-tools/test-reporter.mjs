import { createHash } from 'node:crypto';
import { relative } from 'node:path';

// Structured events avoid accidental TAP/stdout confusion, not hostile-code
// spoofing: this reporter and the tests still run in a candidate-controlled
// local checkout. Never promote these records to authenticated host observations.
export default async function* report(source) {
  const files = [], cases = [], suites = [];
  for await (const event of source) {
    if (['test:pass', 'test:fail'].includes(event.type) && ['test', 'suite'].includes(event.data.details?.type)) {
      const d = event.data;
      const file = typeof d.file === 'string' ? relative(process.cwd(), d.file) : '';
      const status = d.skip !== undefined ? 'skipped' : d.todo !== undefined ? 'todo' : event.type === 'test:pass' ? 'passed'
        : ['cancelledByParent', 'testAborted', 'testTimeoutFailure'].includes(d.details.error?.failureType) ? 'cancelled' : 'failed';
      // Locations and runner identifiers, never test names, assertion text,
      // exception messages, stdout, database URLs or ambient environment.
      const identity = JSON.stringify([file, d.details.type, d.line, d.column, d.nesting, d.testNumber, d.testId, d.parentId]);
      (d.details.type === 'suite' ? suites : cases).push({ file, case_sha256: createHash('sha256').update(identity).digest('hex'), status });
    }
    if (event.type !== 'test:summary') continue;
    const { file, counts, success } = event.data;
    if (file) files.push({ file: relative(process.cwd(), file), counts, success });
    else yield JSON.stringify({ counts, success, files, cases, suites }) + '\n';
  }
}
