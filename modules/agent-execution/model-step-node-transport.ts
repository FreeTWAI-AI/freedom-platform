import { assertProviderTarget } from './provider-target.js';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { AdapterFault } from './adapters/common.js';
import type { ByokObservation } from './adapters/byok.js';

/** Node broker provider transport only. Worker bundles replace this module. */
export async function exchange(url: URL, method: 'GET' | 'POST', headers: Record<string, string>, body?: Uint8Array): Promise<ByokObservation> {
  assertProviderTarget(url, method, true);
  return new Promise((resolve, reject) => {
    let settled = false, size = 0, chunks = 0;
    const parts: Buffer[] = [];
    const done = (error?: AdapterFault, value?: ByokObservation) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { request.destroy(); reject(error); } else resolve(value!);
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: {
      Accept: 'application/json', 'Accept-Encoding': 'identity', ...headers,
      ...(body ? { 'Content-Length': String(body.byteLength) } : {}),
    }, agent: false }, response => {
      const allowed: Record<string, string> = {};
      for (const name of ['content-type', 'content-length', 'content-encoding', 'location']) {
        const value = response.headers[name];
        if (Array.isArray(value)) { done(new AdapterFault('invalid_response')); return; }
        if (value !== undefined) allowed[name] = value;
      }
      if (response.statusCode !== 200) { response.destroy(); done(new AdapterFault(response.statusCode === 401 || response.statusCode === 403 ? 'authentication_unavailable' : 'outcome_unknown')); return; }
      if (allowed.location || allowed['content-encoding'] && allowed['content-encoding'] !== 'identity'
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(allowed['content-type'] ?? '')) {
        response.destroy(); done(new AdapterFault('invalid_response')); return;
      }
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength; chunks++;
        if (size > 32768 || chunks > 256) { response.destroy(); done(new AdapterFault('response_limit')); return; }
        parts.push(Buffer.from(chunk));
      });
      response.on('aborted', () => done(new AdapterFault('outcome_unknown')));
      response.on('error', () => done(new AdapterFault('outcome_unknown')));
      response.on('end', () => {
        if (allowed['content-length'] !== undefined && (!/^(0|[1-9][0-9]*)$(?![\s\S])/.test(allowed['content-length'])
          || BigInt(allowed['content-length']) !== BigInt(size))) { done(new AdapterFault('invalid_response')); return; }
        done(undefined, { status: 200, headers: allowed, body: new Uint8Array(Buffer.concat(parts, size)) });
      });
    });
    const timer = setTimeout(() => done(new AdapterFault('outcome_unknown')), 30000);
    request.on('error', () => done(new AdapterFault('outcome_unknown')));
    if (body) request.end(body); else request.end();
  });
}
