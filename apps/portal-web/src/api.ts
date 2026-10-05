import { accessAwareFetch, expiredAccessStatus, isExpiredAccessResponse, MEMBER_ACCESS_EXPIRED_MESSAGE } from './access-fetch'
import { logConsoleEvent } from './game-console-core'
import { consoleChannel } from './game-console-routing'
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
  ifMatch?: number | string
  skipAuthHandler?: boolean
  background?: boolean
  suppressConsole?: boolean
}

function quoteEtag(version: number | string): string {
  const trimmed = String(version)
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed
  return `"${trimmed}"`
}

const GITHUB_MEMBER_CODES = new Set(['github_rate_limited', 'github_unavailable', 'github_invalid_response', 'github_response_too_large', 'github_read_budget'])

function safePlatformDetail(detail: string): boolean {
  return detail.length > 0 && detail.length <= 400 && !/[<>]/.test(detail) && !/bearer|fpg_|fpk_|token|authorization/i.test(detail) && /[\u4e00-\u9fff]/.test(detail)
}

function retryHeaderSeconds(header: string | null): number | undefined {
  if (!header || !/^\d+$/.test(header.trim())) return undefined
  const value = Number(header.trim())
  return value > 86400 ? undefined : value
}

function githubMemberMessage(code: string, problem: ProblemDetails | null, path: string, retryHeader: string | null): string {
  const detail = typeof problem?.detail === 'string' ? problem.detail.trim() : ''
  const fallback: Record<string, string> = {
    github_rate_limited: 'GitHub 暫時限制查詢，請稍後重試。',
    github_unavailable: 'GitHub 暫時無法回覆，請稍後重新嘗試。',
    github_invalid_response: 'GitHub 回應不完整，請稍後重試。',
    github_response_too_large: 'GitHub 回應過大，這次未完成。',
    github_read_budget: 'GitHub 查詢忙碌，請稍後重試。',
  }
  let message = safePlatformDetail(detail) ? detail : (fallback[code] ?? 'GitHub 暫時無法完成，請稍後重試。')
  const publish = /\/skill-submissions\/[^/]+\/publish$/.test(path)
  if (publish && !message.includes('草稿')) message = `草稿已保留，尚未公開。${message}`
  if (publish && !message.includes('發佈')) message += '請再按「發佈」。'
  const retry = retryHeaderSeconds(retryHeader)
  if (publish && retry !== undefined && !message.includes(String(retry))) {
    message = message.replace(/請再按「發佈」。$/, '')
    message += `約 ${retry} 秒後可再按「發佈」。`
  }
  return message
}

function messageFromProblem(status: number, problem: ProblemDetails | null, mutation = false, path = '', retryHeader: string | null = null): string {
  // Upstream outages may return an HTML page or a JSON wrapper with raw proxy text.
  // Neither belongs in a member's form; keep the HTTP code on ApiError for recovery.
  if (status === 503 && /^\/co-creation\/projects\/[^/]+\/activity$/.test(path)) {
    if (problem?.code === 'github_rate_limited') return 'GitHub 暫時限制查詢，請稍後重試，或直接前往儲存庫查看 Issue。'
    if (problem?.code === 'github_read_budget') return 'GitHub 查詢目前忙碌，請稍後重試，或直接前往儲存庫查看 Issue。'
  }
  const githubCode = typeof problem?.code === 'string' ? problem.code.trim() : ''
  if (status >= 500 && GITHUB_MEMBER_CODES.has(githubCode)) return githubMemberMessage(githubCode, problem, path, retryHeader)
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

  /** Best-effort diagnostic metadata only; this path never logs its own failure. */
  reportError(action:string,errorCode:string,httpStatus?:number):void {
    if(typeof window==='undefined'||!this.csrfToken)return
    const safeAction=action.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,':id').replace(/\/\d+(?=\/|$)/g,'/:number').replace(/%[0-9a-f]{2}/gi,'_').slice(0,120)
    const code=/^[a-zA-Z0-9_:-]{1,80}$/.test(errorCode)?errorCode:'client_error'
    if(!/^(GET|POST|PUT|PATCH|DELETE|UI) \/[a-zA-Z0-9_/:.#-]*$/.test(safeAction))return
    void fetch(`${API_BASE}/me/client-errors`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':this.csrfToken,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({action:safeAction,error_code:code,...(httpStatus!==undefined?{http_status:httpStatus}:{})})}).catch(()=>{})
  }

  async get<T>(path: string, options: { skipAuthHandler?: boolean; background?: boolean } = {}): Promise<T> {
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
    // Requests can outlive logout/re-login. Their auth failures belong only to
    // the session that dispatched them, never a later member session.
    const requestCsrfToken = this.csrfToken
    const headers: Record<string, string> = { Accept: 'application/json' }
    const publicAuth = method === 'POST' && (['/auth/login','/auth/register','/auth/reset/request','/auth/reset/confirm'].includes(path)||/^\/public\/events\/[0-9a-f-]{36}\/register$/.test(path))
    const needsCsrf = method !== 'GET' && !publicAuth

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
    if (options.ifMatch !== undefined) {
      headers['If-Match'] = quoteEtag(options.ifMatch)
    }

    const controller = new AbortController()
    const currentAuthResponse = () => this.csrfToken === requestCsrfToken && !controller.signal.aborted
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
        // 401/403 drop the local member token. An opaque redirect has no status.
        // Either way the shell is told, because only a navigation can sign in again.
        if (currentAuthResponse()) {
          this.accessExpired = true
          if (!options.skipAuthHandler) {
            if (status === 401 || status === 403) this.csrfToken = null
            this.onUnauthorized?.()
          }
        }
        throw new ApiError({
          message: MEMBER_ACCESS_EXPIRED_MESSAGE, status, accessExpired: true,
          cfRay: cloudflareRay(response), requestId: requestId(response),
        })
      }
      // A malformed or stalled error body must not suppress an actual 401.
      if (currentAuthResponse()) {
        this.accessExpired = false
        if (response.status === 401 && !options.skipAuthHandler) {
          this.csrfToken = null
          this.onUnauthorized?.()
        }
      }
      let payload: unknown
      try { payload = await readJson(response) }
      catch {
        if (!response.ok) {
          throw new ApiError({message: messageFromProblem(response.status, null, method !== 'GET', path, response.headers.get('retry-after')), status: response.status, cfRay:cloudflareRay(response), requestId:requestId(response), network: response.status >= 500 && method !== 'GET'})
        }
        throw new ApiError({message:'回應未完整收到，尚未確認結果。請稍後重試。', status: response.status, cfRay:cloudflareRay(response), requestId:requestId(response), network:true})
      }
      if (!response.ok) {
        const problem = isProblem(payload) ? payload : null
        const serverFailure = response.status >= 500
        const knownGitHub = serverFailure && typeof problem?.code === 'string' && GITHUB_MEMBER_CODES.has(problem.code)
        const safeDetail = typeof problem?.detail === 'string' && safePlatformDetail(problem.detail.trim()) ? problem.detail : undefined
        throw new ApiError({
          message: messageFromProblem(response.status, problem, method !== 'GET', path, response.headers.get('retry-after')), status: response.status, cfRay:cloudflareRay(response), requestId:requestId(response),
          type: serverFailure && !knownGitHub ? undefined : problem?.type,
          title: serverFailure && !knownGitHub ? undefined : problem?.title,
          detail: serverFailure ? (knownGitHub ? safeDetail : undefined) : problem?.detail,
          code: serverFailure && !knownGitHub ? undefined : problem?.code, network: serverFailure && method !== 'GET' && !knownGitHub,
        })
      }
      return payload as T
    }
    try { return await Promise.race([operation(), timeout]) }
    catch (cause) {
      const failure = cause instanceof ApiError ? cause : new ApiError({message:'無法連線到伺服器，尚未確認結果。請確認網路後重試。', status: response?.status, cfRay:cloudflareRay(response), requestId:requestId(response), network:true})
      if(!options.background&&!options.suppressConsole)logConsoleEvent({
        channel:consoleChannel('system_api_error'), level:failure.status>=500||failure.network?'error':'warning', kind:'status', source:'介面錯誤', message:failure.message,
        detail:`${method} ${path.split('?')[0]}${failure.code?` · ${failure.code}`:''}`,
      })
      if(!options.background&&path!=='/me/client-errors'&&!failure.accessExpired&&failure.status!==401)this.reportError(`${method} ${path}`,failure.code??(failure.network?'network_error':`http_${failure.status}`),failure.status)
      throw failure
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
