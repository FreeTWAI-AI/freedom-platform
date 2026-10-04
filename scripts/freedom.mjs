// Thin local entrypoint. CI must pin the verifier independently of candidate code.
import { runFreedomCli } from '../packages/contribution-tools/cli.mjs';
process.exitCode = await runFreedomCli();
