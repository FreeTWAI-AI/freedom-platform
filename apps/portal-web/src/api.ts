import { accessAwareFetch, expiredAccessStatus, isExpiredAccessResponse, MEMBER_ACCESS_EXPIRED_MESSAGE } from './access-fetch'
import type { ProblemDetails, SessionPayload } from './types'

const API_BASE = '/api/v1'

export class ApiError extends Error {
  readonly status: number
  readonly type?: string
  readonly title?: string
  readonly detail?: string
  readonly code?: string
  readonly network: boolean
  readonly unauthorized: boolean
  readonly conflict: boolean
  readonly timedOut: boolean
  readonly accessExpired: boolean
  readonly cfRay?: string
  readonly requestId?: string

  constructor(init: {
    message: string
    status?: number
    type?: string
    title?: string
    detail?: string
    code?: string
    network?: boolean
    timedOut?: boolean
    accessExpired?: boolean
    cfRay?: string
    requestId?: string
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status ?? 0
    this.type = init.type
    this.title = init.title
    this.detail = init.detail
    this.code = init.code
    this.network = init.network ?? false
    this.timedOut = init.timedOut ?? false
    this.accessExpired = init.accessExpired ?? false
    this.cfRay = init.cfRay
    this.requestId = init.requestId
    this.unauthorized = this.status === 401
    this.conflict = this.status === 409 || this.status === 412 || this.code === 'conflict'
  }
}

export type RequestOptions = {
  body?: unknown
  idempotencyKey?: string
  ifMatch?: number
  skipAuthHandler?: boolean
}

function quoteEtag(version: number): string {
  const trimmed = String(version)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed
  return `"${trimmed}"`
}

function messageFromProblem(status: number, problem: ProblemDetails | null, mutation = false): string {
  // Upstream outages may return an HTML page or a JSON wrapper with raw proxy text.
  // Neither belongs in a member's form; keep the HTTP code on ApiError for recovery.
  if (status >= 500) return `服務暫時無法回應（${status}）。${mutation?'尚未確認結果，請稍後重試。':'請稍後重試。'}`
  const rawTitle = typeof problem?.title === 'string' ? problem.title.trim() : ''
  const code = typeof problem?.code === 'string' ? problem.code.trim() : ''
  // Some routes send the machine code as title; members only need the readable detail.
  const title = rawTitle && (rawTitle === code || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(rawTitle)) ? '' : rawTitle
  const detail = typeof problem?.detail === 'string' ? problem.detail.trim() : ''
  if (title && detail && title !== detail) return `${title}：${detail}`
  if (detail) return detail
  if (title) return title
  if (status === 401) return '登入已過期，請重新登入。'
  if (status === 403) return '目前無法執行此操作，請重新確認登入狀態。'
  return `請求未完成（${status}），請稍後重試。`
}

function cloudflareRay(response?: Response): string | undefined {
  const value=response?.headers.get('cf-ray')?.trim()
  return value&&/^[a-f0-9]{8,32}(?:-[a-z0-9]{2,12})?$/i.test(value)?value:undefined
}

function requestId(response?: Response): string | undefined {
  const value=response?.headers.get('x-freedom-request-id')?.trim()
  return value&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value:undefined
}

export class PortalClient {
  csrfToken: string | null = null
  onUnauthorized: (() => void) | null = null
  /** Set for the current response before onUnauthorized, so the app can offer a page reload instead of the member login form. */
  accessExpired = false

  constructor(private readonly options: {timeoutMs?: number} = {}) {}

  async get<T>(path: string, options: { skipAuthHandler?: boolean } = {}): Promise<T> {
    return this.request<T>('GET', path, options)
  }

  async post<T>(path: string, body: unknown, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body })
  }

  async getSession(): Promise<SessionPayload> {
    return this.get<SessionPayload>('/session', { skipAuthHandler: true })
  }

  async login(email: string, password: string): Promise<SessionPayload> {
    return this.post<SessionPayload>(
      '/auth/login',
      { email, password },
      { skipAuthHandler: true },
    )
  }

  async register(body: {email:string;password:string;nickname:string}): Promise<SessionPayload> {
    return this.post<SessionPayload>('/auth/register', body, { skipAuthHandler:true })
  }

  async logout(idempotencyKey: string): Promise<void> {
    await this.post('/auth/logout', {}, { idempotencyKey })
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const isLogin = method === 'POST' && (path === '/auth/login' || path === '/auth/register')
    const needsCsrf = method !== 'GET' && !isLogin

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (needsCsrf) {
      if (!this.csrfToken) {
        throw new ApiError({ message: '缺少安全權杖，請重新載入後再試', status: 400 })
      }
      headers['X-CSRF-Token'] = this.csrfToken
      const key = options.idempotencyKey ?? crypto.randomUUID()
      headers['Idempotency-Key'] = key
    }
    if (options.ifMatch) {
      headers['If-Match'] = quoteEtag(options.ifMatch)
    }

    const controller = new AbortController()
    let response: Response | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ApiError({
          message: '連線等候過久，尚未確認結果。請稍後重試。',
          status: response?.status, cfRay:cloudflareRay(response), requestId:requestId(response), network: true, timedOut: true,
        }))
        controller.abort()
      }, this.options.timeoutMs ?? 20_000)
    })
    const operation = async () => {
      response = await accessAwareFetch(`${API_BASE}${path}`, {
        method, headers, credentials: 'same-origin', signal: controller.signal,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      if (await isExpiredAccessResponse(response)) {
        const status = expiredAccessStatus(response)
        this.accessExpired = true
        // 401/403 drop the local member token. An opaque redirect has no status.
        // Either way the shell is told, because only a navigation can sign in again.
        if (!options.skipAuthHandler) {
          if (status === 401 || status === 403) this.csrfToken = null
          this.onUnauthorized?.()
        }
        throw new ApiError({
          message: MEMBER_ACCESS_EXPIRED_MESSAGE, status, accessExpired: true,
          cfRay: cloudflareRay(response), requestId: requestId(response),
        })
      }
      this.accessExpired = false
      // A malformed or stalled error body must not suppress an actual 401.
      if (response.status === 401 && !options.skipAuthHandler) {
        this.csrfToken = null
        this.onUnauthorized?.()
      }
      let payload: unknown
      try { payload = await readJson(response) }
      catch {
        if (!response.ok) {
          throw new ApiError({message: messageFromProblem(response.status, null, method !== 'GET'), status: response.status, cfRay:cloudflareRay(response), requestId:requestId(response), network: response.status >= 500 && method !== 'GET'})
        }
        throw new ApiError({message:'回應未完整收到，尚未確認結果。請稍後重試。', status: response.status, cfRay:cloudflareRay(response), requestId:requestId(response), network:true})
      }
      if (!response.ok) {
        const problem = isProblem(payload) ? payload : null
        const serverFailure = response.status >= 500
        throw new ApiError({
          message: messageFromProblem(response.status, problem, method !== 'GET'), status: response.status, cfRay:cloudflareRay(response), requestId:requestId(response),
          type: serverFailure ? undefined : problem?.type,
          title: serverFailure ? undefined : problem?.title,
          detail: serverFailure ? undefined : problem?.detail,
          code: serverFailure ? undefined : problem?.code, network: serverFailure && method !== 'GET',
        })
      }
      return payload as T
    }
    try { return await Promise.race([operation(), timeout]) }
    catch (cause) {
      if (cause instanceof ApiError) throw cause
      throw new ApiError({message:'無法連線到伺服器，尚未確認結果。請確認網路後重試。', status: response?.status, cfRay:cloudflareRay(response), requestId:requestId(response), network:true})
    } finally { clearTimeout(timer) }
  }

}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text && (response.status === 204 || response.status === 205)) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ApiError({
      message: '伺服器回傳了無法解析的內容',
      status: response.status,
    })
  }
}

function isProblem(value: unknown): value is ProblemDetails {
  return Boolean(value) && typeof value === 'object'
}

export function requireItems<T>(payload: unknown, label: string): T[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new ApiError({ message: `${label} 回應格式不正確` })
  }
  return (payload as { items: T[] }).items
}

export function requireDashboard<T extends { now: unknown; next: unknown; gained: unknown; review_queue: unknown; summary: unknown }>(
  payload: unknown,
): T {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError({ message: '工作台回應格式不正確' })
  }
  const data = payload as T
  if (!Array.isArray(data.now) || !Array.isArray(data.next) || !Array.isArray(data.gained) || !Array.isArray(data.review_queue)) {
    throw new ApiError({ message: '工作台回應缺少列表欄位' })
  }
  if (!data.summary || typeof data.summary !== 'object') {
    throw new ApiError({ message: '工作台回應缺少摘要' })
  }
  return data
}
