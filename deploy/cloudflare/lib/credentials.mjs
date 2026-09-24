import { readFileSync, statSync } from 'node:fs';
import { inspect } from 'node:util';

// Only these keys are ever retained from the operator-provided env file; every other line is dropped unread.
export const CLOUDFLARE_KEYS = Object.freeze(['CF_ACCOUNT_ID', 'CF_API_TOKEN']);

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

/** Holds the token in a closure; serialisation and inspection never reveal it. */
export function loadCloudflareCredentials(path, deps = {}) {
  assertPrivateFile(path, deps);
  const values = parseAllowlistedEnv((deps.readFile ?? readFileSync)(path, 'utf8'), CLOUDFLARE_KEYS);
  for (const key of CLOUDFLARE_KEYS) if (!values[key]) throw new Error(`Missing ${key} in credential file (value not shown).`);
  if (!/^[0-9a-f]{32}$/i.test(values.CF_ACCOUNT_ID)) throw new Error('CF_ACCOUNT_ID has an unexpected format (value not shown).');
  const token = values.CF_API_TOKEN;
  const accountId = values.CF_ACCOUNT_ID;
  const creds = {
    accountId,
    authorizationHeader: () => `Bearer ${token}`,
    toJSON: () => ({ accountId: '[id]', token: '[redacted]' }),
    [inspect.custom]: () => '[CloudflareCredentials redacted]',
  };
  return Object.freeze(creds);
}
