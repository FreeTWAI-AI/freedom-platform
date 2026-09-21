export type FreedomEnv = 'local' | 'staging';

export function resolveFreedomEnv(raw = process.env.FREEDOM_ENV): FreedomEnv {
  const v = (raw ?? 'local').trim().toLowerCase();
  if (v === 'staging') return 'staging';
  if (v === 'local' || v === '') return 'local';
  throw new Error(`Unsupported FREEDOM_ENV=${raw}. Use local or staging (production is not enabled).`);
}

export function assertOriginAllowed(env: FreedomEnv, origin: string): void {
  let url: URL;
  try { url = new URL(origin); } catch {
    throw new Error('APP_ORIGIN must be a valid URL.');
  }
  if (env === 'local') {
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new Error('APP_ORIGIN must be local when FREEDOM_ENV=local.');
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
