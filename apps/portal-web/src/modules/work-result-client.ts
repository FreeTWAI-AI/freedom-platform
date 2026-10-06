import { accessAwareFetch, expiredAccessStatus, isExpiredAccessResponse, MEMBER_ACCESS_EXPIRED_MESSAGE } from '../access-fetch';
import { ApiError, type PortalClient } from '../api';

const TIMEOUT_MS = 20_000;

export type ResultContentType = 'text/plain' | 'text/markdown';

export type UploadVerified = { upload_id: string; verified: true; version: string };

/** PUT the exact bytes of a prepared result upload. Content-Length is left to the browser, which sets it for a Uint8Array body. */
export async function putWorkResultContent(client: PortalClient, path: string, bytes: Uint8Array, contentType: ResultContentType, uploadVersion: string, idempotencyKey: string, signal?: AbortSignal): Promise<UploadVerified> {
  const payload = await exchange(client, path, {
    method: 'PUT',
    body: bytes,
    headers: {
      Accept: 'application/json',
      'Content-Type': contentType,
      'Idempotency-Key': idempotencyKey,
      'If-Match': quote(uploadVersion),
    },
    signal,
  });
  if (!payload || typeof payload !== 'object') throw new ApiError({ message: '回應未完整收到，尚未確認結果。請稍後重試。', network: true, status: 0 });
  const row = payload as { upload_id?: unknown; verified?: unknown; version?: unknown };
  if (typeof row.upload_id !== 'string' || row.verified !== true || typeof row.version !== 'string') {
    throw new ApiError({ message: '回應未完整收到，尚未確認結果。請稍後重試。', network: true, status: 0 });
  }
  return { upload_id: row.upload_id, verified: true, version: row.version };
}

/** Read result bytes as text. This route is not JSON, so PortalClient.get cannot be used. */
export async function getWorkResultText(client: PortalClient, path: string, signal?: AbortSignal): Promise<string> {
  const response = await send(client, path, { method: 'GET', headers: { Accept: 'text/plain, text/markdown;q=0.9' }, signal });
  if (!response.ok) throw await problemFrom(response, 'GET');
  return response.text();
}

async function exchange(client: PortalClient, path: string, init: { method: string; body?: Uint8Array; headers: Record<string, string>; signal?: AbortSignal }): Promise<unknown> {
  const response = await send(client, path, init);
  let payload: unknown;
  try { payload = await response.json(); }
  catch {
    if (!response.ok) throw await problemFrom(response, init.method, true);
    throw new ApiError({ message: '回應未完整收到，尚未確認結果。請稍後重試。', status: response.status, network: true });
  }
  if (!response.ok) throw problem(response, payload, init.method);
  return payload;
}

async function send(client: PortalClient, path: string, init: { method: string; body?: Uint8Array; headers: Record<string, string>; signal?: AbortSignal }): Promise<Response> {
  if (init.method !== 'GET' && !client.csrfToken) throw new ApiError({ message: '缺少安全權杖，請重新載入後再試', status: 400 });
  const requestCsrf = client.csrfToken;
  const headers = new Headers(init.headers);
  if (init.method !== 'GET' && requestCsrf) headers.set('X-CSRF-Token', requestCsrf);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  let response: Response;
  try {
    response = await accessAwareFetch(path, { method: init.method, credentials: 'same-origin', headers, body: init.body ? new Uint8Array(init.body) : undefined, signal: controller.signal });
  } catch {
    if (init.signal?.aborted) throw new ApiError({ message: '已取消', code: 'aborted', status: 0, network: true });
    if (timedOut) throw new ApiError({ message: '連線等候過久，尚未確認結果。請稍後重試。', status: 0, network: true, timedOut: true });
    throw new ApiError({ message: '無法連線到伺服器，尚未確認結果。請確認網路後重試。', status: 0, network: true });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
  if (await isExpiredAccessResponse(response)) {
    const status = expiredAccessStatus(response);
    if (client.csrfToken === requestCsrf) {
      client.accessExpired = true;
      if (status === 401 || status === 403) client.csrfToken = null;
      client.onUnauthorized?.();
    }
    throw new ApiError({ message: MEMBER_ACCESS_EXPIRED_MESSAGE, status, accessExpired: true });
  }
  if (client.csrfToken === requestCsrf) {
    client.accessExpired = false;
    if (response.status === 401) { client.csrfToken = null; client.onUnauthorized?.(); }
  }
  return response;
}

function quote(version: string): string {
  return version.startsWith('"') && version.endsWith('"') ? version : `"${version}"`;
}

async function problemFrom(response: Response, method: string, unparsed = false): Promise<ApiError> {
  if (unparsed) return problem(response, null, method);
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  return problem(response, payload, method);
}

function problem(response: Response, payload: unknown, method: string): ApiError {
  const serverFailure = response.status >= 500;
  const row = payload && typeof payload === 'object' ? payload as { code?: unknown; detail?: unknown } : null;
  const code = typeof row?.code === 'string' ? row.code : undefined;
  const detail = typeof row?.detail === 'string' ? row.detail : undefined;
  const message = serverFailure
    ? `服務暫時無法回應（${response.status}）。${method !== 'GET' ? '尚未確認結果，請稍後重試。' : '請稍後重試。'}`
    : detail || `請求未完成（${response.status}），請稍後重試。`;
  return new ApiError({
    message,
    status: response.status,
    code: serverFailure ? undefined : code,
    detail: serverFailure ? undefined : detail,
    network: serverFailure && method !== 'GET',
  });
}
