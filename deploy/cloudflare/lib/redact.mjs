// Redaction applied to every string that leaves the preflight tools (stdout, reports, errors).
const RULES = [
  [/\b(authorization|cookie|set-cookie|cf-access-client-secret|x-auth-key)\s*[:=]\s*[^\r\n]+/gi, '$1: [redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\b(postgres(?:ql)?|mysql):\/\/[^\s"'<>]+/gi, '$1://[redacted]'],
  [/\bpscale_(?:pw|tkn|oauth|api)_[A-Za-z0-9_-]+/g, 'pscale_[redacted]'],
  [/\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]'],
  [/\b[0-9a-f]{32}\b/gi, '[id]'],
  // Cloudflare API tokens are 40 URL-safe characters; pure-hex git SHAs stay readable.
  [/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*[g-zG-Z_-])[A-Za-z0-9_-]{40}/g, '[redacted-40]'],
];

export function redactText(value) {
  let text = String(value);
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return text;
}

export function redactDeep(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /token|secret|password|authorization|connection_?string/i.test(k) && typeof v === 'string' ? '[redacted]' : redactDeep(v)]));
  }
  return value;
}
