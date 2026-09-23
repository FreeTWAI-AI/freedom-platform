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

  constructor(init: {
    message: string
    status?: number
    type?: string
    title?: string
    detail?: string
    code?: string
    network?: boolean
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status ?? 0
    this.type = init.type
    this.title = init.title
    this.detail = init.detail
    this.code = init.code
    this.network = init.network ?? false
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

function messageFromProblem(status: number, problem: ProblemDetails | null, fallback: string): string {
  const title = problem?.title?.trim()
  const detail = problem?.detail?.trim()
  if (title && detail) return `${title}：${detail}`
  if (detail) return detail
  if (title) return title
  return fallback || `請求失敗（${status}）`
}

export class PortalClient {
  csrfToken: string | null = null
  onUnauthorized: (() => void) | null = null

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

  async register(body: {email:string;password:string;nickname:string;contacts:Record<string,{value:string;visibility:string}>}): Promise<SessionPayload> {
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

    let response: Response
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch {
      throw new ApiError({
        message: '無法連線到伺服器。請確認網路連線後再試，不會自動重送。',
        network: true,
      })
    }

    let payload: unknown
    try { payload = await readJson(response) }
    catch {
      throw new ApiError({message:'回應未完整收到，操作結果尚未確認。請重新整理或用同一操作重試。',network:method!=='GET'})
    }

    if (response.status === 401 && !options.skipAuthHandler) {
      this.csrfToken = null
      this.onUnauthorized?.()
    }

    if (!response.ok) {
      const problem = isProblem(payload) ? payload : null
      throw new ApiError({
        message: messageFromProblem(response.status, problem, response.statusText),
        status: response.status,
        type: problem?.type,
        title: problem?.title,
        detail: problem?.detail,
        code: problem?.code,
        network: response.status >= 500 && method !== 'GET',
      })
    }

    return payload as T
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
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
