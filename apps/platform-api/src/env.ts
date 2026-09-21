export type FreedomEnv = 'local' | 'staging';

export function resolveFreedomEnv(raw = process.env.FREEDOM_ENV): FreedomEnv {
  const v = (raw ?? 'local').trim().toLowerCase();
  if (v === 'staging') return 'staging';
  if (v === 'local' || v === '') return 'local';
  throw new Error(`Unsupported FREEDOM_ENV=${raw}. Use local or staging (production is not enabled).`);
}

export function assertOriginAllowed(env: FreedomEnv, origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('APP_ORIGIN must be a valid URL.');
  }
  if (url.origin !== origin) {
    throw new Error('APP_ORIGIN must be an exact origin (no path/query).');
  }
  if (env === 'local') {
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('APP_ORIGIN must be an HTTP loopback origin when FREEDOM_ENV=local.');
    }
    return;
  }
  if (url.protocol !== 'https:') {
    throw new Error('APP_ORIGIN must be https when FREEDOM_ENV=staging.');
  }
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('APP_ORIGIN must be a non-loopback https host when FREEDOM_ENV=staging.');
  }
}

/** Origins accepted for browser Origin header / CSRF-adjacent checks. */
export function allowedBrowserOrigins(env: FreedomEnv, origin: string): Set<string> {
  assertOriginAllowed(env, origin);
  const configured = new URL(origin);
  if (env === 'local') {
    const port = configured.port ? `:${configured.port}` : '';
    return new Set(['127.0.0.1', 'localhost', '[::1]'].map((h) => `http://${h}${port}`));
  }
  return new Set([configured.origin]);
}

/** Hostnames accepted on the incoming request (Tunnel may present public Host or loopback). */
export function allowedRequestHosts(env: FreedomEnv, origin: string): Set<string> {
  assertOriginAllowed(env, origin);
  const configured = new URL(origin);
  if (env === 'local') {
    return new Set(['127.0.0.1', 'localhost', '[::1]']);
  }
  return new Set([configured.hostname, '127.0.0.1', 'localhost', '[::1]']);
}
