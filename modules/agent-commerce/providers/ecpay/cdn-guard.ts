import { EcpayProtocolError } from './errors.js';
import type { FormFields } from './form.js';

const CDN_BLOCKED_TERM_PATTERN =
  /[;|`]|net\s+localgroup|cmd32\.exe|cmd\.exe|cmd\s*\/c|net\.exe|nmap\.exe|nc\.exe|telnet\.exe|wguest\.exe|wsh\.exe|rcmd\.exe|ftp\.exe|traceroute|tracert|tclsh|tftp|echo|cd\s*(?:\/|\\|\.\.)|chmod\s*\+x/i;

export function findCdnBlockedTerm(value: string): string | null {
  if (typeof value !== 'string') {
    throw new EcpayProtocolError('invalid_input');
  }
  const match = CDN_BLOCKED_TERM_PATTERN.exec(value);
  return match ? match[0] : null;
}

export function assertCdnSafe(value: string): void {
  if (findCdnBlockedTerm(value) !== null) {
    throw new EcpayProtocolError('invalid_input');
  }
}

export function assertFieldsCdnSafe(fields: FormFields): void {
  for (const [, value] of fields) {
    assertCdnSafe(value);
  }
}
