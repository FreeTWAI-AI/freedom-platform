import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export function bodySha256Hex(body: string | Uint8Array): string {
  const rawBytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return createHash('sha256').update(rawBytes).digest('hex').toLowerCase();
}
