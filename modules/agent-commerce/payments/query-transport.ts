import { ECPAY_ORIGINS, type EcpayEnvironment } from '../providers/ecpay/index.js';
import type { EcpayServerRequest } from '../providers/ecpay/aio-credit/index.js';

export type QueryTransportResult =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'error'; code: 'timeout' | 'network' | 'response_too_large' };
export interface PaymentQueryTransport {
  send(request: EcpayServerRequest, environment: EcpayEnvironment): Promise<QueryTransportResult>;
}
const QUERY_PATH = '/Cashier/QueryTradeInfo/V5';
const RESPONSE_LIMIT = 64 * 1024;
const fixtures = new WeakSet<PaymentQueryTransport>();

/** This transport admits only the protocol library's payment query endpoint.
 * Status codes remain responses; the engine maps redirects and other non-200s
 * to its closed http_status error without following their Location header. */
export function createEcpayQueryTransport({ fetch = globalThis.fetch }: {
  fetch?: typeof globalThis.fetch;
} = {}): PaymentQueryTransport {
  return Object.freeze({
    async send(request: EcpayServerRequest, environment: EcpayEnvironment): Promise<QueryTransportResult> {
      try {
        const url = new URL(request.url);
        if (!Object.hasOwn(ECPAY_ORIGINS.payment, environment)
          || url.origin !== ECPAY_ORIGINS.payment[environment] || url.pathname !== QUERY_PATH
          || url.username || url.password || url.search || url.hash) throw Error();
      }
      catch { throw Error('transport_host_refused'); }

      const signal = AbortSignal.timeout(10_000);
      try {
        const response = await fetch(request.url, {
          method: 'POST', headers: { 'Content-Type': request.contentType }, body: request.bodyText(),
          redirect: 'manual', signal,
        });
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return { kind: 'response', status: response.status, body: '' };
        }
        const reader = response.body?.getReader();
        if (!reader) return { kind: 'response', status: response.status, body: '' };
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > RESPONSE_LIMIT) {
              await reader.cancel().catch(() => undefined);
              return { kind: 'error', code: 'response_too_large' };
            }
            chunks.push(value);
          }
        }
        finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return { kind: 'response', status: response.status, body: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
      }
      catch (error) {
        const name = error instanceof Error ? error.name : '';
        return { kind: 'error', code: signal.aborted || name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
      }
    },
  });
}

/** An explicit host environment prevents a fixture from being installed on a
 * deployed host. The handler never delegates to fetch. */
export function createFixtureQueryTransport(
  handler: PaymentQueryTransport['send'], freedomEnv: 'local' | 'staging' | 'public',
): PaymentQueryTransport {
  if (freedomEnv !== 'local') throw Error('payment_fixture_requires_local');
  const transport = Object.freeze({ send: handler });
  fixtures.add(transport);
  return transport;
}
export function assertQueryTransportInstallation(transport: PaymentQueryTransport | undefined, freedomEnv: 'local' | 'staging' | 'public'): void {
  if (transport && fixtures.has(transport) && freedomEnv !== 'local') throw Error('payment_fixture_requires_local');
}
