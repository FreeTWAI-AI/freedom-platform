// Temporary hostile-fork credential probe (2026-10-06). It only targets a disposable branch and is never merged to main.
// It prints presence booleans, variable names and a sanitized push outcome. It never prints a value.
import { execFileSync } from 'node:child_process';

const names = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OPENROUTER_API_KEY', 'FREEDOM_SIGNING_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN'];
const present = Object.fromEntries(names.map(name => [name, Boolean(process.env[name])]));
const secretLikeNames = Object.keys(process.env).filter(name => /token|secret|password|private|credential|api_?key/i.test(name)).sort();
let persistedCheckoutCredential = false;
try {
  persistedCheckoutCredential = execFileSync('git', ['config', '--get-regexp', '^http\\..*\\.extraheader$'], { encoding: 'utf8' }).trim().length > 0;
} catch { /* no persisted header */ }
let push = 'allowed', pushReason = null;
try {
  execFileSync('git', ['push', 'https://github.com/FreeTWAI-AI/freedom-platform.git', 'HEAD:refs/heads/ops/trust-pin-d1c9-fork-push-probe-20261006'],
    { stdio: 'pipe', timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
} catch (error) {
  push = 'denied';
  const text = String(error.stderr ?? '') + String(error.message ?? '');
  pushReason = /403|denied/i.test(text) ? 'permission_denied' : /could not read Username|terminal prompts disabled|Authentication failed/i.test(text) ? 'no_credential' : 'other';
}
console.log('TRUST_PIN_FORK_CREDENTIAL_PROBE ' + JSON.stringify({ job: process.env.GITHUB_JOB ?? null, event: process.env.GITHUB_EVENT_NAME ?? null,
  head_repository: process.env.GITHUB_HEAD_REF ? 'fork_or_branch_head' : null, present, secret_like_names: secretLikeNames, persisted_checkout_credential: persistedCheckoutCredential, push, push_reason: pushReason }));
