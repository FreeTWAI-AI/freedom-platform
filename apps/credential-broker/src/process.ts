import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { readBoundedHttpJson } from '../../../packages/execution-state/http-body.js';
import { Problem } from '../../../packages/shared/problem.js';
import type { BrokerBridge } from './bridge.js';

export interface BrokerBridgeProcessOptions { origin: string; bridge: BrokerBridge }
const path = '/internal/model-execution';
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
function rejected() { return new Problem(403, 'model_broker_authorization_invalid', 'Broker request is invalid.'); }

/** Explicit local process transport for a separately bootstrapped broker.
 * Production private bindings must provide their own authenticated transport;
 * this numeric-loopback listener is never installed by the public API. */
export function createBrokerBridgeProcessServer(options: BrokerBridgeProcessOptions): Server {
  const origin = new URL(options.origin), bridge = options.bridge;
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || !origin.port
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || origin.origin !== options.origin || !bridge || typeof bridge.handle !== 'function') {
    throw new Problem(503, 'model_broker_unavailable', 'Broker process ports are unavailable.');
  }
  const handle = bridge.handle.bind(bridge);
  const socketHost = origin.hostname === '[::1]' ? '::1' : origin.hostname;
  function requestHeaders(incoming: IncomingMessage): Headers {
    const result = new Headers(), seen = new Set<string>();
    for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
      const key = incoming.rawHeaders[index].toLowerCase(), value = incoming.rawHeaders[index + 1];
      if (seen.has(key)) throw rejected();
      seen.add(key); result.set(key, value);
    }
    return result;
  }
  const server = createServer({ requestTimeout: 6000, headersTimeout: 5000, maxHeaderSize: 8192 }, async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.once('aborted', () => abort.abort());
    try {
      const sent = requestHeaders(incoming);
      if (incoming.socket.localAddress !== socketHost || incoming.socket.localPort !== Number(origin.port)
        || incoming.method !== 'POST' || incoming.url !== path || sent.get('Host') !== origin.host
        || ['Authorization', 'DPoP', 'Cookie', 'Content-Encoding', 'Origin', 'Sec-Fetch-Site',
          'X-Freedom-Connection', 'X-Freedom-Nonce'].some(name => sent.has(name))) throw rejected();
      const request = new Request(origin.origin + path, { method: 'POST', headers: sent, signal: abort.signal,
        body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } as RequestInit);
      const response = await handle(await readBoundedHttpJson(request));
      outgoing.writeHead(200, headers); outgoing.end(JSON.stringify(response));
    } catch (error) {
      const status = error instanceof Problem ? error.status : 503;
      const code = status === 503 ? 'model_broker_unavailable' : 'model_broker_authorization_invalid';
      // No parser, SQL, crypto or provider exception is serialized or logged.
      if (!outgoing.headersSent) outgoing.writeHead(status, headers);
      outgoing.end(JSON.stringify({ code }));
      incoming.resume();
    }
  });
  server.maxRequestsPerSocket = 128;
  server.keepAliveTimeout = 5000;
  return server;
}
