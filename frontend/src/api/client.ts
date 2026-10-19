// Cliente REST do protocolo (SYNC_PROTOCOL.md §6). O access token fica só em memória; o refresh é o
// cookie HttpOnly `cc_refresh` (client "web"), renovado em `POST /auth/refresh` quando o access expira.
import type {
  Account,
  ApiErrorBody,
  AuthResult,
  Change,
  DeviceInfo,
  DeviceInput,
  InstanceInfo,
  KeysResponse,
  KeysSetupBody,
  PasswordSlot,
  PushRequest,
  PushResponse,
  RecordsPage,
  RecoverySlot,
  Tokens
} from './types'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export const PROTOCOL = 1

/** Mensagens pt-BR para códigos sem mensagem útil (o servidor já manda `message` em pt-BR). */
const FALLBACK_MESSAGES: Record<string, string> = {
  network: 'Não foi possível falar com o servidor. Verifique a conexão e tente de novo.',
  invalid_response: 'O servidor respondeu algo inesperado.',
  rate_limited: 'Muitas tentativas. Aguarde um pouco e tente de novo.',
  code_invalid: 'Código incorreto ou expirado.',
  captcha_failed: 'A verificação anti-robô falhou. Tente de novo.',
  signup_closed: 'O cadastro está fechado nesta instância.',
  invite_invalid: 'Este convite é inválido, já foi usado ou expirou.',
  unauthorized: 'Sua sessão expirou. Entre de novo.',
  key_proof_invalid: 'A prova de posse da chave não confere. Desbloqueie de novo.',
  chat_busy: 'Este chat está rodando em um dispositivo agora. Tente quando o turno terminar.',
  quota_exceeded: 'Cota de armazenamento excedida.',
  internal: 'Erro interno do servidor.'
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message || FALLBACK_MESSAGES[code] || `Erro ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
  /** Segundos sugeridos para esperar (429). */
  get retryAfter(): number | null {
    const v = this.details.retry_after
    return typeof v === 'number' ? v : null
  }
}

export const isApiError = (e: unknown, code?: string): e is ApiError =>
  e instanceof ApiError && (code === undefined || e.code === code)

export interface ClientOptions {
  /** `<base>` (origem + caminho de base, sem "/" final). */
  root: string
  fetch?: FetchFn
  clientHeader?: string
}

interface RequestOpts {
  body?: unknown
  query?: Record<string, string | number | undefined>
  /** false = sem Authorization e sem tentar refresh (rotas de auth). */
  auth?: boolean
}

export class ApiClient {
  readonly root: string
  private readonly fetchFn: FetchFn
  private readonly clientHeader: string
  private accessToken: string | null = null
  private refreshing: Promise<Tokens> | null = null
  /** Chamado quando a sessão acaba (refresh recusado, dispositivo revogado, conta desativada). */
  onSessionLost: ((reason: string) => void) | null = null

  constructor(opts: ClientOptions) {
    this.root = opts.root.replace(/\/+$/, '')
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.clientHeader = opts.clientHeader ?? 'web/0.1.0'
  }

  get token(): string | null {
    return this.accessToken
  }
  setToken(t: string | null): void {
    this.accessToken = t
  }

  private async raw<T>(method: string, url: string, opts: RequestOpts): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-ClearChat-Client': this.clientHeader,
      'X-ClearChat-Protocol': String(PROTOCOL)
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.auth !== false && this.accessToken)
      headers.Authorization = `Bearer ${this.accessToken}`
    let qs = ''
    if (opts.query) {
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) p.set(k, String(v))
      const s = p.toString()
      if (s) qs = '?' + s
    }
    let res: Response
    try {
      res = await this.fetchFn(this.root + url + qs, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store'
      })
    } catch {
      throw new ApiError(0, 'network', '')
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let data: unknown = undefined
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new ApiError(res.status, res.ok ? 'invalid_response' : 'internal', '')
      }
    }
    if (!res.ok) {
      const err = (data as ApiErrorBody | undefined)?.error
      const details = { ...(err?.details ?? {}) }
      const ra = res.headers.get('Retry-After')
      if (ra && details.retry_after === undefined && /^\d+$/.test(ra)) details.retry_after = +ra
      throw new ApiError(res.status, err?.code ?? 'internal', err?.message ?? '', details)
    }
    return data as T
  }

  /** Requisição em `<base>/api/v1`; com auth, um 401 dispara um refresh (único em voo) e repete. */
  async request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const url = '/api/v1' + path
    try {
      return await this.raw<T>(method, url, opts)
    } catch (e) {
      if (isApiError(e) && (e.code === 'device_revoked' || e.code === 'account_disabled')) {
        this.accessToken = null
        this.onSessionLost?.(e.code)
      }
      if (opts.auth === false || !isApiError(e) || e.status !== 401 || e.code !== 'unauthorized')
        throw e
      await this.refresh()
      return this.raw<T>(method, url, opts)
    }
  }

  /** Renova o access pelo cookie. Falhou → sessão perdida. */
  refresh(): Promise<Tokens> {
    if (!this.refreshing) {
      this.refreshing = this.raw<Tokens>('POST', '/api/v1/auth/refresh', { body: {}, auth: false })
        .then((t) => {
          this.accessToken = t.access_token
          return t
        })
        .catch((e) => {
          if (isApiError(e) && e.status !== 0 && e.status < 500) {
            this.accessToken = null
            this.onSessionLost?.(e.code)
          }
          throw e
        })
        .finally(() => {
          this.refreshing = null
        })
    }
    return this.refreshing
  }

  // ---------------- instância ----------------
  info(): Promise<InstanceInfo> {
    return this.raw<InstanceInfo>('GET', '/api/info', { auth: false })
  }

  // ---------------- auth ----------------
  inviteCheck(token: string): Promise<{ valid: boolean; email?: string }> {
    return this.request('GET', `/auth/invite/${encodeURIComponent(token)}`, { auth: false })
  }
  signupStart(body: {
    email: string
    name: string
    turnstile_token?: string
    invite_token?: string
  }): Promise<{ ok: true }> {
    return this.request('POST', '/auth/signup/start', { body, auth: false })
  }
  async signupVerify(body: {
    email: string
    code: string
    device: DeviceInput
  }): Promise<AuthResult> {
    const r = await this.request<AuthResult>('POST', '/auth/signup/verify', { body, auth: false })
    this.accessToken = r.access_token
    return r
  }
  codeRequest(body: { email: string; turnstile_token?: string }): Promise<{ ok: true }> {
    return this.request('POST', '/auth/code/request', { body, auth: false })
  }
  async codeVerify(body: {
    email: string
    code: string
    device: DeviceInput
  }): Promise<AuthResult> {
    const r = await this.request<AuthResult>('POST', '/auth/code/verify', { body, auth: false })
    this.accessToken = r.access_token
    return r
  }
  async logout(): Promise<void> {
    try {
      await this.request<void>('POST', '/auth/logout')
    } finally {
      this.accessToken = null
    }
  }
  reauthRequest(purpose: 'delete_account' | 'reset_keys'): Promise<unknown> {
    return this.request('POST', '/auth/reauth/request', { body: { purpose } })
  }

  // ---------------- conta ----------------
  account(): Promise<Account> {
    return this.request('GET', '/account')
  }
  updateAccount(name: string): Promise<Account> {
    return this.request('PATCH', '/account', { body: { name } })
  }
  async deleteAccount(code: string): Promise<void> {
    await this.request<void>('DELETE', '/account', { body: { code } })
    this.accessToken = null
  }

  // ---------------- chaves ----------------
  keys(): Promise<KeysResponse> {
    return this.request('GET', '/keys')
  }
  setupKeys(body: KeysSetupBody): Promise<unknown> {
    return this.request('POST', '/keys/setup', { body })
  }
  changePassword(body: { key_proof: string; password: PasswordSlot }): Promise<unknown> {
    return this.request('PUT', '/keys/password', { body })
  }
  changeRecovery(body: { key_proof: string; recovery: RecoverySlot }): Promise<unknown> {
    return this.request('PUT', '/keys/recovery', { body })
  }
  resetKeys(code: string): Promise<unknown> {
    return this.request('POST', '/keys/reset', { body: { code } })
  }

  // ---------------- dispositivos ----------------
  devices(): Promise<DeviceInfo[]> {
    return this.request('GET', '/devices')
  }
  renameDevice(id: string, name: string): Promise<unknown> {
    return this.request('PATCH', `/devices/${encodeURIComponent(id)}`, { body: { name } })
  }
  revokeDevice(id: string): Promise<void> {
    return this.request('DELETE', `/devices/${encodeURIComponent(id)}`)
  }

  // ---------------- registros ----------------
  records(q: {
    type?: string
    scope?: string
    after?: number
    limit?: number
    payload?: boolean
  }): Promise<RecordsPage> {
    return this.request('GET', '/records', {
      query: {
        type: q.type,
        scope: q.scope,
        after: q.after,
        limit: q.limit,
        payload: q.payload === false ? 0 : 1
      }
    })
  }
  fetchRecords(items: { type: string; id: string }[]): Promise<{ records: Change[] }> {
    return this.request('POST', '/records/fetch', { body: { items } })
  }
  push(body: PushRequest): Promise<PushResponse> {
    return this.request('POST', '/sync/push', { body })
  }
}
