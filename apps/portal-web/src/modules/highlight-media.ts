import { accessAwareFetch, expiredAccessStatus, isExpiredAccessResponse, MEMBER_ACCESS_EXPIRED_MESSAGE } from '../access-fetch';
import { ApiError, type PortalClient } from '../api';

export async function imageOrientation(file: File): Promise<'landscape' | 'portrait'> {
  try {
    const bitmap = await createImageBitmap(file);
    const portrait = bitmap.height > bitmap.width;
    bitmap.close();
    return portrait ? 'portrait' : 'landscape';
  } catch {
    return new Promise(resolve => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { const portrait = img.naturalHeight > img.naturalWidth; URL.revokeObjectURL(url); resolve(portrait ? 'portrait' : 'landscape'); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve('landscape'); };
      img.src = url;
    });
  }
}

export async function uploadHighlightImage(client: PortalClient, eventId: string, kind: 'photo' | 'poster', file: File, orientation: 'landscape' | 'portrait', title: string, key: string) {
  if (!client.csrfToken) throw new ApiError({ message: '登入狀態已變更，請重新整理後再試。', status: 400 });
  const requestCsrfToken = client.csrfToken;
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': file.type, 'X-CSRF-Token': client.csrfToken, 'Idempotency-Key': key, 'X-Photo-Orientation': orientation };
  if (title.trim()) headers['X-Media-Title'] = encodeURIComponent(title.trim());
  let response: Response;
  try {
    response = await accessAwareFetch(`/api/v1/event-highlights/${eventId}/${kind === 'photo' ? 'photos' : 'posters'}`, { method: 'POST', credentials: 'same-origin', body: file, headers });
  } catch { throw new ApiError({ message: '連線中斷，這張圖片是否已上傳尚未確認。', network: true }); }
  if (await isExpiredAccessResponse(response)) {
    const status = expiredAccessStatus(response);
    if (client.csrfToken === requestCsrfToken) {
      client.accessExpired = true;
      if (status === 401 || status === 403) client.csrfToken = null;
      client.onUnauthorized?.();
    }
    throw new ApiError({ message: MEMBER_ACCESS_EXPIRED_MESSAGE, status, accessExpired: true });
  }
  if (client.csrfToken === requestCsrfToken) {
    client.accessExpired = false;
    if (response.status === 401) { client.csrfToken = null; client.onUnauthorized?.(); }
  }
  let payload: Record<string, unknown> = {};
  try { payload = await response.json(); } catch { throw new ApiError({ message: '回應未完整收到，請再試一次。', network: true }); }
  if (!response.ok) throw new ApiError({ message: typeof payload.detail === 'string' ? payload.detail : '圖片未能上傳，請稍後再試。', status: response.status, code: typeof payload.code === 'string' ? payload.code : undefined, network: response.status >= 500 });
  return payload;
}
