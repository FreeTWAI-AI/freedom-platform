import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Problem } from './problem.js';

/** Server-only continuation integrity. This never grants resource access. */
export interface TenantListCursorBinding {
  purpose: 'work' | 'results' | 'instances' | 'installations' | 'seller-orders';
  tenantId: string;
  principalId: string;
  scopeId: string;
  resourceId: string | null;
  filter: string;
}
export interface TenantListCursorCodec {
  encode(position: Record<string, string>, binding: TenantListCursorBinding): string;
  /** Call only after current tenant, parent resource and instance authorization, even on page one. */
  decode(raw: string | undefined, binding: TenantListCursorBinding): Record<string, unknown> | null;
}
const invalid = () => new Problem(422, 'invalid_cursor', '分頁游標無效。');
const unavailable = () => { throw new Problem(503, 'tenant_cursor_unavailable', '分頁服務目前無法使用。'); };
export const unavailableTenantListCursor: TenantListCursorCodec = Object.freeze({ encode: unavailable, decode: unavailable });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bindingDigest(binding: TenantListCursorBinding) {
  return createHash('sha256').update(JSON.stringify([
    binding.purpose, binding.tenantId, binding.principalId, binding.scopeId, binding.resourceId, binding.filter,
  ])).digest('base64url');
}
function canonicalBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw invalid();
  return bytes;
}

/** A dedicated, independently generated 32-byte key, encoded as unpadded base64url. */
export function createTenantListCursorCodec(
  secret: string | undefined, host: { environment: string; origin: string },
): TenantListCursorCodec {
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return unavailableTenantListCursor;
  const key = Buffer.from(secret, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== secret) return unavailableTenantListCursor;
  // Both fields come from validated host configuration, never request headers or cookies.
  const domain = JSON.stringify(['freedom.tenant-list-cursor/v1', host.environment, host.origin]);
  const sign = (body: string) => createHmac('sha256', key).update(domain).update('\0').update(body).digest();
  return Object.freeze({
    encode(position, binding) {
      const body = Buffer.from(JSON.stringify({ v: 1, b: bindingDigest(binding), p: position })).toString('base64url');
      const token = `${body}.${sign(body).toString('base64url')}`;
      if (token.length > 512) throw invalid();
      return token;
    },
    decode(raw, binding) {
      if (raw === undefined) return null;
      if (raw.length > 512) throw invalid();
      const parts = raw.split('.');
      if (parts.length !== 2) throw invalid();
      const [body, signature] = parts;
      const supplied = canonicalBytes(signature);
      if (supplied.length !== 32 || !timingSafeEqual(supplied, sign(body))) throw invalid();
      let envelope: unknown;
      try { envelope = JSON.parse(canonicalBytes(body).toString('utf8')); }
      catch { throw invalid(); }
      if (!record(envelope) || Object.keys(envelope).sort().join(',') !== 'b,p,v'
        || envelope.v !== 1 || envelope.b !== bindingDigest(binding) || !record(envelope.p)) throw invalid();
      return envelope.p;
    },
  } satisfies TenantListCursorCodec);
}
