import { buildContext } from './context.mjs';
import { verifyWorkspace } from './verify.mjs';
import { writeLocalArtifact, validateArtifactOutputPath } from './local-artifacts.mjs';
import { VerificationError, safeFailure } from './errors.mjs';

function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['prepare', 'context', 'verify'].includes(command)) throw new VerificationError('unknown_command');
  const options = { baseRef: 'origin/main', requestedPaths: [], scopes: [] }, seen = new Set();
  let report;
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!value || value.startsWith('--') || seen.has(flag)) throw new VerificationError('invalid_arguments');
    seen.add(flag);
    if (flag === '--base-ref') options.baseRef = value;
    else if (flag === '--scope') options.scopes = value.split(',');
    else if (flag === '--paths') options.requestedPaths = value.split(',');
    else if (flag === '--report' && command === 'verify') report = value;
    else throw new VerificationError('invalid_arguments');
  }
  return { command, options, report };
}

export async function runFreedomCli(args = process.argv.slice(2), repositoryRoot = process.cwd()) {
  try {
    const { command, options, report: reportPath } = parseArgs(args);
    if (reportPath) validateArtifactOutputPath(reportPath);
    if (command === 'verify') {
      const report = await verifyWorkspace({ repositoryRoot, ...options });
      if (reportPath) await writeLocalArtifact(repositoryRoot, reportPath, report);
      console.log(JSON.stringify(report));
      return report.status === 'passed' ? 0 : report.status === 'unavailable' ? 2 : 1;
    }
    const { context } = await buildContext({ repositoryRoot, ...options });
    if (command === 'context') console.log(JSON.stringify(context));
    else {
      const path = await writeLocalArtifact(repositoryRoot, `.freedom/context/${context.task_id}/bundle.json`, context);
      console.log(JSON.stringify({ format: context.format, assurance_level: 'local', context_path: path,
        task_id: context.task_id, base_commit: context.base_commit, head_commit: context.head_commit,
        module_ids: context.module_ids, tests: context.tests, blockers: context.blockers }));
    }
    return context.blockers.length ? 2 : 0;
  } catch (error) {
    const failure = safeFailure(error);
    console.log(JSON.stringify({ format: 'freedom.cli-error/v1', assurance_level: 'local', ...failure }));
    return failure.status === 'unavailable' ? 2 : 1;
  }
}
