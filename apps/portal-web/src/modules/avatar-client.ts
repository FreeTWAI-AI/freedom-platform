import { accessAwareFetch, expiredAccessStatus, isExpiredAccessResponse, MEMBER_ACCESS_EXPIRED_MESSAGE } from '../access-fetch';
import { ApiError, type PortalClient } from '../api';
import type { AvatarMetadata } from './MemberAvatar';

export async function uploadMemberAvatar(client: PortalClient, file: File, version: number, key: string): Promise<AvatarMetadata> {
  if (!client.csrfToken) throw new ApiError({ message: '登入狀態已變更，請重新整理後再試。', status: 400 });
  let response: Response;
  try {
    response = await accessAwareFetch('/api/v1/me/avatar', {
      method: 'POST', credentials: 'same-origin', body: file,
      headers: { Accept: 'application/json', 'Content-Type': file.type, 'X-CSRF-Token': client.csrfToken, 'Idempotency-Key': key, 'If-Match': `"${version}"` },
    });
  } catch { throw new ApiError({ message: '連線中斷，頭像是否保存尚未確認。再次保存會安全重試同一操作。', network: true }); }
  if (await isExpiredAccessResponse(response)) {
    const status = expiredAccessStatus(response);
    client.accessExpired = true;
    if (status === 401 || status === 403) client.csrfToken = null;
    client.onUnauthorized?.();
    throw new ApiError({ message: MEMBER_ACCESS_EXPIRED_MESSAGE, status, accessExpired: true });
  }
  client.accessExpired = false;
  if (response.status === 401) { client.csrfToken = null; client.onUnauthorized?.(); }
  let payload: Record<string, unknown>;
  try { payload = await response.json(); }
  catch { throw new ApiError({ message: '回應未完整收到，請再次保存以確認這次操作。', network: true }); }
  if (!response.ok) throw new ApiError({
    message: typeof payload.detail === 'string' ? payload.detail : '頭像未能保存，請稍後再試。',
    status: response.status, code: typeof payload.code === 'string' ? payload.code : undefined, network: response.status >= 500,
  });
  if (typeof payload.aggregate_version !== 'number' || (payload.avatar_url !== null && typeof payload.avatar_url !== 'string')) throw new ApiError({ message: '回應未完整收到，請再次保存以確認這次操作。', network: true });
  return payload as AvatarMetadata;
}
