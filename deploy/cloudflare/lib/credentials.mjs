import { readFileSync, statSync } from 'node:fs';
import { inspect } from 'node:util';

// Current Wrangler/Cloudflare names first; the CF_* names are accepted as legacy aliases.
export const CLOUDFLARE_KEYS = Object.freeze({
  CLOUDFLARE_ACCOUNT_ID: 'CF_ACCOUNT_ID',
  CLOUDFLARE_API_TOKEN: 'CF_API_TOKEN',
});
// Only these keys are ever retained from the operator-provided env file; every other line is dropped unread.
const ALLOWED = Object.freeze([...Object.keys(CLOUDFLARE_KEYS), ...Object.values(CLOUDFLARE_KEYS)]);

export function assertPrivateFile(path, { stat = statSync, uid = process.getuid?.() } = {}) {
  const info = stat(path);
  if (!info.isFile()) throw new Error(`Credential path is not a regular file: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Credential file must not be readable by group/other (chmod 600): ${path}`);
  if (uid !== undefined && info.uid !== uid) throw new Error(`Credential file must be owned by the current user: ${path}`);
}

export function parseAllowlistedEnv(text, allowed) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !allowed.includes(m[1])) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** Current key wins only when the legacy alias is absent or identical; a conflict is an error. Values never appear in messages. */
export function resolveCloudflareKeys(values) {
  const out = {};
  for (const [current, legacy] of Object.entries(CLOUDFLARE_KEYS)) {
    const a = values[current];
    const b = values[legacy];
    if (a && b && a !== b) throw new Error(`${current} and legacy ${legacy} are both set with different values; keep one (values not shown).`);
    if (!a && !b) throw new Error(`Missing ${current} (or legacy ${legacy}) in credential file (value not shown).`);
    out[current] = a || b;
  }
  return out;
}

/** Holds the token in a closure; serialisation and inspection never reveal it. */
export function loadCloudflareCredentials(path, deps = {}) {
  assertPrivateFile(path, deps);
  const values = resolveCloudflareKeys(parseAllowlistedEnv((deps.readFile ?? readFileSync)(path, 'utf8'), ALLOWED));
  if (!/^[0-9a-f]{32}$/i.test(values.CLOUDFLARE_ACCOUNT_ID)) throw new Error('CLOUDFLARE_ACCOUNT_ID has an unexpected format (value not shown).');
  const token = values.CLOUDFLARE_API_TOKEN;
  const accountId = values.CLOUDFLARE_ACCOUNT_ID;
  const creds = {
    accountId,
    authorizationHeader: () => `Bearer ${token}`,
    toJSON: () => ({ accountId: '[id]', token: '[redacted]' }),
    toString: () => '[CloudflareCredentials redacted]',
    [inspect.custom]: () => '[CloudflareCredentials redacted]',
  };
  return Object.freeze(creds);
}
