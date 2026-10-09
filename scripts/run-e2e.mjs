// Required CI calls `npm run test:e2e` with no extra arguments. That command
// runs the ordinary Playwright suite first, then the private-AI spec with
// FREEDOM_E2E_PRIVATE_AI_FIXTURE=1, then the shared-asset avatar spec with
// FREEDOM_E2E_AVATAR_ASSET_FIXTURE=1, then the direct-message image spec with
// FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE=1, then first-participation guidance with
// FREEDOM_E2E_FIRST_PARTICIPATION=1. Each extra pass is a new process and
// schema. Explicit test filters and an already requested fixture stay one
// Playwright invocation. The fixture flags are never set on the same pass.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRIVATE_AI_SPEC = 'tests/e2e/private-work-ai.spec.ts';
export const AVATAR_ASSET_SPEC = 'tests/e2e/member-avatar-asset.spec.ts';
export const MESSAGE_IMAGE_SPEC = 'tests/e2e/message-images.spec.ts';
export const FIRST_PARTICIPATION_SPEC = 'tests/e2e/first-participation.spec.ts';

const TAKES_VALUE = new Set([
  '--add-reporter', '--browser', '--config', '-c', '--global-timeout', '--grep', '-g',
  '--grep-invert', '-G', '--last-failed-file', '--max-failures', '--output', '--repeat-each',
  '--reporter', '--retries', '--run-agents', '--shard', '--test-list', '--test-list-invert',
  '--timeout', '--trace', '--tsconfig', '--ui-host', '--ui-port', '--update-source-method',
  '--workers', '-j',
]);
const OPTIONAL_CHOICE = new Map([
  ['--debug', new Set(['inspector', 'cli'])],
  ['--update-snapshots', new Set(['all', 'changed', 'missing', 'none'])],
  ['-u', new Set(['all', 'changed', 'missing', 'none'])],
]);

function looksLikePathFilter(token) {
  return token.includes('/') || token.includes('\\') || /\.(?:[cm]?[jt]sx?)(?::\d+)?$/i.test(token);
}

export function explicitFileArgs(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') {
      files.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-')) {
      files.push(token);
      continue;
    }
    if (token.includes('=')) continue;
    if (token === '--project') {
      while (index + 1 < argv.length && !argv[index + 1].startsWith('-') && !looksLikePathFilter(argv[index + 1])) index++;
      continue;
    }
    if (token === '--only-changed') {
      if (index + 1 < argv.length && !argv[index + 1].startsWith('-') && !looksLikePathFilter(argv[index + 1])) index++;
      continue;
    }
    const choices = OPTIONAL_CHOICE.get(token);
    if (choices) {
      if (index + 1 < argv.length && choices.has(argv[index + 1])) index++;
      continue;
    }
    if (TAKES_VALUE.has(token) && index + 1 < argv.length && !argv[index + 1].startsWith('-')) index++;
  }
  return files;
}

function terminalFlag(argv) {
  return argv.some(token => token === '--help' || token === '-h' || token === '--version' || token === '-V');
}

export function planE2e(argv, env = {}) {
  const args = [...argv];
  if (env.FREEDOM_E2E_FIRST_PARTICIPATION === '1' || env.FREEDOM_E2E_PRIVATE_AI_FIXTURE === '1' || env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE === '1' || env.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE === '1' || explicitFileArgs(args).length > 0 || terminalFlag(args)) return [{ args, env }];
  return [
    { args, env },
    { args: [...args, PRIVATE_AI_SPEC], env: { ...env, FREEDOM_E2E_PRIVATE_AI_FIXTURE: '1' } },
    { args: [...args, AVATAR_ASSET_SPEC], env: { ...env, FREEDOM_E2E_AVATAR_ASSET_FIXTURE: '1' } },
    { args: [...args, MESSAGE_IMAGE_SPEC], env: { ...env, FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE: '1' } },
    { args: [...args, FIRST_PARTICIPATION_SPEC], env: { ...env, FREEDOM_E2E_FIRST_PARTICIPATION: '1' } },
  ];
}

export async function runE2e(argv, env, spawnPlaywright) {
  let result = { code: 0, signal: null };
  for (const step of planE2e(argv, env)) {
    result = await spawnPlaywright(step.args, step.env);
    if (result?.signal || result?.code !== 0) return result ?? { code: 1, signal: null };
  }
  return result;
}

const root = fileURLToPath(new URL('..', import.meta.url));

function playwrightCommand(args) {
  try {
    const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
    return { command: process.execPath, argv: [cli, 'test', ...args] };
  } catch {
    return { command: 'playwright', argv: ['test', ...args] };
  }
}

export function spawnPlaywright(args, env) {
  const { command, argv } = playwrightCommand(args);
  return new Promise(resolveExit => {
    const child = spawn(command, argv, { cwd: root, env, stdio: 'inherit' });
    child.once('error', () => resolveExit({ code: 127, signal: null }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

// Re-raise the child signal so the parent observes that signal. A numeric
// status is returned only when Playwright exited by itself.
export async function applyNativeExit(result) {
  if (result?.signal) {
    process.kill(process.pid, result.signal);
    await new Promise(() => {});
  }
  process.exit(result?.code ?? 1);
}

async function main() {
  await applyNativeExit(await runE2e(process.argv.slice(2), process.env, spawnPlaywright));
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(resolve(entryArg)).href) main();
