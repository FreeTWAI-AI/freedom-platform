import { AdapterFault } from './adapters/common.js';

/** Fixed network destinations only; model identifiers never select an origin.
 * Native Node fixtures have their own loopback-only constructor and opt in here. */
export function assertProviderTarget(url: URL, method: 'GET' | 'POST', localFixture = false): void {
  if (url.username || url.password || url.hash || url.search) throw new AdapterFault('invalid_input');
  if (localFixture && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port) return;
  if (url.protocol !== 'https:' || url.port) throw new AdapterFault('invalid_input');
  const path = url.pathname;
  const supported = url.hostname === 'api.openai.com'
    ? method === 'POST' ? path === '/v1/responses' : /^\/v1\/models\/[A-Za-z0-9][A-Za-z0-9._:%-]*$/.test(path)
    : url.hostname === 'api.anthropic.com'
      ? method === 'POST' ? path === '/v1/messages' : /^\/v1\/models\/[A-Za-z0-9][A-Za-z0-9._:%-]*$/.test(path)
      : url.hostname === 'openrouter.ai' && (method === 'POST' ? path === '/api/v1/chat/completions'
        : path === '/api/v1/key' || /^\/api\/v1\/model\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:%-]*$/.test(path));
  if (!supported || /%(?!3A)/i.test(path)) throw new AdapterFault('invalid_input');
}
