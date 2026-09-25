// Cloudflare Access returns 401 to XHR instead of redirecting the document at its login host.
// redirect:manual turns a leftover redirect into an opaqueredirect response instead of a thrown cross-origin failure.
export const MEMBER_ACCESS_EXPIRED_MESSAGE = '網站登入已過期。請重新載入頁面，再次登入後才能繼續。'

export function accessAwareFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-Requested-With', 'XMLHttpRequest')
  return fetch(input, { ...init, headers, redirect: 'manual' })
}

/** An opaque redirect, or a 401/403 whose body is not JSON, is Cloudflare Access standing in for an expired sign-in. */
export async function isExpiredAccessResponse(response: Response): Promise<boolean> {
  if (response.type === 'opaqueredirect') return true
  if (response.status !== 401 && response.status !== 403) return false
  let text: string
  try { text = await response.clone().text() } catch { return false }
  try { JSON.parse(text); return false } catch { return true }
}

/** Opaque redirects have no readable status. A real Access denial keeps 401 or 403. */
export function expiredAccessStatus(response: Response): number {
  return response.type === 'opaqueredirect' ? 0 : response.status
}
