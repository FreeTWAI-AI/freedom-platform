import { accessAwareFetch, expiredAccessStatus, isExpiredAccessResponse } from '../access-fetch';

export const ADMIN_ACCESS_EXPIRED_MESSAGE = '管理員登入已過期。請重新載入頁面，再次登入後才能繼續。';
const NETWORK_MESSAGE = '目前無法連線。操作不會自動重送，請重新載入確認結果。';
const INCOMPLETE_MESSAGE = '管理入口沒有回傳完整資料，請重新確認管理身分。';

export class AdminRequestError extends Error {
  readonly accessExpired: boolean;
  constructor(message: string, readonly status = 0, accessExpired = false) {
    super(message);
    this.name = 'AdminRequestError';
    this.accessExpired = accessExpired;
  }
}

export class AdminClient {
  csrf: string | null = null;
  onAccessExpired: (() => void) | null = null;
  onAccessRecovered: (() => void) | null = null;
  /** Only the latest request may flip the panel between expired and recovered. */
  private latestRequest = 0;

  private failAccess(status: number, notify: boolean): never {
    if (status === 401 || status === 403) this.csrf = null;
    if (notify) this.onAccessExpired?.();
    throw new AdminRequestError(ADMIN_ACCESS_EXPIRED_MESSAGE, status, true);
  }

  async request<T>(path: string, body?: unknown, options: { key?: string; version?: number | null } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) {
      if (!this.csrf) throw new AdminRequestError('管理員驗證已過期，請重新確認管理身分。', 403);
      headers['Content-Type'] = 'application/json';
      headers['X-Admin-CSRF'] = this.csrf;
      headers['Idempotency-Key'] = options.key ?? crypto.randomUUID();
      if (options.version) headers['If-Match'] = `"${options.version}"`;
    }
    const ticket = ++this.latestRequest;
    let response: Response;
    try {
      response = await accessAwareFetch(`/admin/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AdminRequestError(NETWORK_MESSAGE);
    }
    if (await isExpiredAccessResponse(response)) this.failAccess(expiredAccessStatus(response), ticket === this.latestRequest);
    let value: any;
    try { value = await response.json(); }
    catch { throw new AdminRequestError(INCOMPLETE_MESSAGE, response.status); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.csrf = null;
      throw new AdminRequestError(typeof value?.detail === 'string' ? value.detail : '無法完成管理操作，請重新載入確認。', response.status);
    }
    if (ticket === this.latestRequest) this.onAccessRecovered?.();
    return value as T;
  }
}
