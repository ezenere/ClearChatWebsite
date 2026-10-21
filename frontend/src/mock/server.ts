// Servidor SIMULADO (só desenvolvimento/testes, `VITE_MOCK_API=1`): implementa em memória o subconjunto
// do contrato que o site usa — /api/info, auth por código, sessões, chaves, dispositivos, registros,
// push e o WebSocket (hello/welcome, ping, sync.changes, keys.*). Não decifra nada: guarda envelopes,
// como o servidor real. Nunca é incluído no build de produção (import dinâmico atrás da flag).
import { b64u, bytesEqual, fromB64u, isWellFormedEnvelope, randomBytes, sha256 } from '../crypto'
import type {
  AuthResult,
  Change,
  DeviceInput,
  InstanceInfo,
  KeysResponse,
  KeysSetupBody,
  PushConflict,
  PushItem,
  PushRequest
} from '../api/types'

export interface MockConfig {
  name: string
  signupOpen: boolean
  landing: boolean
  captcha: boolean
  /** Código aceito em qualquer verificação por e-mail. */
  code: string
}

export const DEFAULT_MOCK_CONFIG: MockConfig = {
  name: 'ClearChat',
  signupOpen: true,
  landing: true,
  captcha: false,
  code: '123456'
}

interface UserRow {
  id: string
  email: string
  name: string
  created_at: string
  keys_ready: boolean
  keys: KeysResponse | null
  verifier: string | null
  seq: number
  records: Record<string, Change>
}
interface DeviceRow extends DeviceInput {
  id: string
  user_id: string
  created_at: string
  last_seen_at: string | null
  last_ip: string | null
  /** Dispositivo semeado que aparece "online" sem conexão real. */
  fake_online?: boolean
}
export interface MockDb {
  version: 1
  config: MockConfig
  users: Record<string, UserRow>
  devices: Record<string, DeviceRow>
  access: Record<string, { device_id: string; user_id: string; exp: number }>
  refresh: Record<string, { device_id: string }>
  /** "Cookie" cc_refresh do navegador simulado. */
  cookie: string | null
  pending: Record<string, { purpose: 'signup' | 'login'; name?: string; invite?: string }>
  reauth: Record<string, 'delete_account' | 'reset_keys'>
  invites: Record<string, { email?: string; used: boolean }>
  demo?: {
    user_id: string
    dek_hex: string
    password: string
    email: string
    recovery_key: string
  }
}

export interface MockRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string>
  body: unknown
}
export interface MockResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

const KNOWN_TYPES = new Set([
  'provider',
  'setting',
  'preset',
  'memory_collection',
  'memory',
  'chat',
  'session',
  'message',
  'skill'
])
const SCOPED: Record<string, 'chat' | 'memory_collection' | 'self' | null> = {
  provider: null,
  setting: null,
  preset: null,
  memory_collection: null,
  memory: 'memory_collection',
  chat: 'self',
  session: 'chat',
  message: 'chat',
  skill: null
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

const now = (): string => new Date().toISOString()
const uuid = (): string => crypto.randomUUID()
const token = (prefix: string): string => prefix + b64u(randomBytes(32))
const normEmail = (e: unknown): string =>
  String(e ?? '')
    .trim()
    .toLowerCase()

export function emptyDb(config: Partial<MockConfig> = {}): MockDb {
  return {
    version: 1,
    config: { ...DEFAULT_MOCK_CONFIG, ...config },
    users: {},
    devices: {},
    access: {},
    refresh: {},
    cookie: null,
    pending: {},
    reauth: {},
    invites: {}
  }
}

/** Conexão WebSocket do lado do servidor simulado. */
export interface MockConn {
  user_id: string | null
  device_id: string | null
  deliver(msg: unknown): void
  close(code: number, reason: string): void
}

export class MockServer {
  db: MockDb
  private conns = new Set<MockConn>()
  private persist: ((db: MockDb) => void) | null
  latency: [number, number]

  constructor(
    opts: { db?: MockDb; persist?: (db: MockDb) => void; latency?: [number, number] } = {}
  ) {
    this.db = opts.db ?? emptyDb()
    this.persist = opts.persist ?? null
    this.latency = opts.latency ?? [0, 0]
  }

  save(): void {
    this.persist?.(this.db)
  }

  setConfig(patch: Partial<MockConfig>): void {
    this.db.config = { ...this.db.config, ...patch }
    this.save()
  }

  info(): InstanceInfo {
    const c = this.db.config
    return {
      name: c.name,
      server_version: '0.1.0-mock',
      base_url: typeof location !== 'undefined' ? location.origin : 'http://localhost',
      protocol: { min: 1, max: 1, version: '1.4.0' },
      features: {
        signupOpen: c.signupOpen,
        captcha: c.captcha ? { provider: 'turnstile', siteKey: 'mock-site-key' } : null,
        landing: c.landing,
        gateway: false
      },
      links: {
        download: 'https://github.com/ezenere/ClearChat/releases',
        ...(c.signupOpen ? { signup: '/signup' } : {})
      }
    }
  }

  // ------------------------------------------------------------------ HTTP

  async handle(req: MockRequest): Promise<MockResponse> {
    const [lo, hi] = this.latency
    if (hi > 0) await new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)))
    try {
      const res = await this.route(req)
      if (req.method !== 'GET') this.save()
      return res
    } catch (e) {
      if (e instanceof HttpError)
        return {
          status: e.status,
          body: { error: { code: e.code, message: e.message, details: e.details } }
        }
      console.error('[mock] erro interno', e)
      return { status: 500, body: { error: { code: 'internal', message: 'Erro interno (mock).' } } }
    }
  }

  private async route(req: MockRequest): Promise<MockResponse> {
    const { method: m, path: p } = req
    const body = (req.body ?? {}) as Record<string, unknown>
    if (m === 'GET' && p === '/api/info') return { status: 200, body: this.info() }
    if (!p.startsWith('/api/v1/')) throw new HttpError(404, 'not_found', 'Rota inexistente.')
    const r = p.slice('/api/v1'.length)

    // ---------- auth (sem token) ----------
    if (m === 'GET' && r.startsWith('/auth/invite/')) {
      const inv = this.db.invites[decodeURIComponent(r.slice('/auth/invite/'.length))]
      return {
        status: 200,
        body:
          inv && !inv.used
            ? { valid: true, ...(inv.email ? { email: inv.email } : {}) }
            : { valid: false }
      }
    }
    if (m === 'POST' && r === '/auth/signup/start') return this.signupStart(body)
    if (m === 'POST' && r === '/auth/signup/verify') return this.verify(body, 'signup')
    if (m === 'POST' && r === '/auth/code/request') return this.codeRequest(body)
    if (m === 'POST' && r === '/auth/code/verify') return this.verify(body, 'login')
    if (m === 'POST' && r === '/auth/refresh') return this.refreshTokens()

    // ---------- autenticado ----------
    const auth = this.authenticate(req)
    const user = this.db.users[auth.user_id]
    if (m === 'POST' && r === '/auth/logout') {
      this.revokeDevice(auth.device_id)
      return { status: 204 }
    }
    if (m === 'POST' && r === '/auth/reauth/request') {
      const purpose = body.purpose
      if (purpose !== 'delete_account' && purpose !== 'reset_keys')
        throw new HttpError(400, 'invalid_request', 'Propósito inválido.')
      this.db.reauth[user.id] = purpose
      return { status: 202, body: { ok: true } }
    }
    if (r === '/account') {
      if (m === 'GET') return { status: 200, body: this.account(user) }
      if (m === 'PATCH') {
        const name = String(body.name ?? '').trim()
        if (!name || name.length > 64) throw new HttpError(400, 'invalid_request', 'Nome inválido.')
        user.name = name
        return { status: 200, body: this.account(user) }
      }
      if (m === 'DELETE') {
        this.consumeReauth(user.id, 'delete_account', body.code)
        this.broadcast(user.id, { t: 'account.deleted' })
        this.closeUser(user.id, 4403, 'account_deleted')
        for (const d of Object.values(this.db.devices))
          if (d.user_id === user.id) this.revokeDevice(d.id)
        delete this.db.users[user.id]
        if (this.db.demo?.user_id === user.id) delete this.db.demo
        return { status: 204 }
      }
    }
    if (r === '/keys' && m === 'GET') {
      if (!user.keys_ready || !user.keys)
        throw new HttpError(409, 'keys_not_ready', 'As chaves ainda não foram definidas.')
      return { status: 200, body: user.keys }
    }
    if (r === '/keys/setup' && m === 'POST')
      return this.keysSetup(user, body as unknown as KeysSetupBody)
    if (r === '/keys/password' && m === 'PUT') return this.keysChange(user, body, 'password')
    if (r === '/keys/recovery' && m === 'PUT') return this.keysChange(user, body, 'recovery')
    if (r === '/keys/reset' && m === 'POST') {
      this.consumeReauth(user.id, 'reset_keys', body.code)
      user.records = {}
      user.keys = null
      user.keys_ready = false
      user.verifier = null
      this.broadcast(user.id, { t: 'keys.reset' })
      this.closeUser(user.id, 4403, 'keys_reset', auth.device_id)
      return { status: 200, body: { ok: true } }
    }
    if (r === '/devices' && m === 'GET')
      return { status: 200, body: this.listDevices(user.id, auth.device_id) }
    if (r.startsWith('/devices/')) {
      const id = decodeURIComponent(r.slice('/devices/'.length))
      const dev = this.db.devices[id]
      if (!dev || dev.user_id !== user.id)
        throw new HttpError(404, 'not_found', 'Dispositivo inexistente.')
      if (m === 'PATCH') {
        const name = String(body.name ?? '').trim()
        if (!name || name.length > 64) throw new HttpError(400, 'invalid_request', 'Nome inválido.')
        dev.name = name
        return { status: 200, body: { ok: true } }
      }
      if (m === 'DELETE') {
        this.revokeDevice(id)
        return { status: 204 }
      }
    }
    if (r === '/records' && m === 'GET') return this.listRecords(user, req.query)
    if (r === '/records/fetch' && m === 'POST') {
      const items = Array.isArray(body.items) ? (body.items as { type: string; id: string }[]) : []
      if (items.length > 500) throw new HttpError(400, 'invalid_request', 'Itens demais.')
      const records = items
        .map((it) => user.records[`${it.type}|${it.id}`])
        .filter((c): c is Change => !!c)
      return { status: 200, body: { records } }
    }
    if (r === '/sync/push' && m === 'POST')
      return this.push(user, auth.device_id, body as unknown as PushRequest)
    throw new HttpError(404, 'not_found', 'Rota inexistente.')
  }

  private checkCaptcha(body: Record<string, unknown>): void {
    if (this.db.config.captcha && !body.turnstile_token)
      throw new HttpError(400, 'captcha_failed', 'Confirme que você não é um robô.')
  }

  private signupStart(body: Record<string, unknown>): MockResponse {
    const email = normEmail(body.email)
    const name = String(body.name ?? '').trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name)
      throw new HttpError(400, 'invalid_request', 'E-mail ou nome inválido.')
    this.checkCaptcha(body)
    const invite = body.invite_token ? String(body.invite_token) : undefined
    if (invite) {
      const inv = this.db.invites[invite]
      if (!inv || inv.used || (inv.email && inv.email !== email))
        throw new HttpError(400, 'invite_invalid', 'Convite inválido, usado ou expirado.')
    } else if (!this.db.config.signupOpen) {
      throw new HttpError(403, 'signup_closed', 'O cadastro está fechado nesta instância.')
    }
    if (!this.userByEmail(email)) this.db.pending[email] = { purpose: 'signup', name, invite }
    return { status: 202, body: { ok: true } }
  }

  private codeRequest(body: Record<string, unknown>): MockResponse {
    const email = normEmail(body.email)
    if (!email) throw new HttpError(400, 'invalid_request', 'E-mail inválido.')
    this.checkCaptcha(body)
    if (this.userByEmail(email)) this.db.pending[email] = { purpose: 'login' }
    return { status: 202, body: { ok: true } }
  }

  private verify(body: Record<string, unknown>, purpose: 'signup' | 'login'): MockResponse {
    const email = normEmail(body.email)
    const pend = this.db.pending[email]
    if (!pend || pend.purpose !== purpose || String(body.code) !== this.db.config.code)
      throw new HttpError(400, 'code_invalid', 'Código incorreto ou expirado.')
    const device = body.device as DeviceInput | undefined
    if (!device || typeof device.name !== 'string')
      throw new HttpError(400, 'invalid_request', 'Dados do dispositivo ausentes.')
    delete this.db.pending[email]
    let user = this.userByEmail(email)
    if (purpose === 'signup') {
      if (user) throw new HttpError(400, 'code_invalid', 'Código incorreto ou expirado.')
      if (pend.invite) this.db.invites[pend.invite].used = true
      user = {
        id: uuid(),
        email,
        name: pend.name ?? email,
        created_at: now(),
        keys_ready: false,
        keys: null,
        verifier: null,
        seq: 0,
        records: {}
      }
      this.db.users[user.id] = user
    }
    if (!user) throw new HttpError(400, 'code_invalid', 'Código incorreto ou expirado.')
    const tokens = this.issueSession(user.id, device)
    const result: AuthResult = {
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name },
      keys_ready: user.keys_ready,
      keys: user.keys_ready ? user.keys : null
    }
    return { status: purpose === 'signup' ? 201 : 200, body: result }
  }

  private issueSession(userId: string, device: DeviceInput) {
    const id = uuid()
    this.db.devices[id] = {
      id,
      user_id: userId,
      name: String(device.name).slice(0, 64),
      platform: device.platform,
      client: device.client,
      app_version: device.app_version,
      can_host: !!device.can_host,
      created_at: now(),
      last_seen_at: now(),
      last_ip: '127.0.0.1'
    }
    return { ...this.newTokens(id, userId), device_id: id }
  }

  private newTokens(deviceId: string, userId: string) {
    for (const [t, r] of Object.entries(this.db.refresh))
      if (r.device_id === deviceId) delete this.db.refresh[t]
    const access = token('cca_')
    const refresh = token('ccr_')
    this.db.access[access] = { device_id: deviceId, user_id: userId, exp: Date.now() + 3600_000 }
    this.db.refresh[refresh] = { device_id: deviceId }
    this.db.cookie = refresh // web: vai no cookie HttpOnly, não no corpo
    return { access_token: access, access_expires_in: 3600, refresh_expires_in: 60 * 86400 }
  }

  private refreshTokens(): MockResponse {
    const r = this.db.cookie ? this.db.refresh[this.db.cookie] : undefined
    const dev = r && this.db.devices[r.device_id]
    if (!r || !dev) throw new HttpError(401, 'unauthorized', 'Sessão expirada.')
    delete this.db.refresh[this.db.cookie!]
    dev.last_seen_at = now()
    return { status: 200, body: this.newTokens(dev.id, dev.user_id) }
  }

  private authenticate(req: MockRequest): { user_id: string; device_id: string } {
    const h = req.headers['authorization'] ?? ''
    const t = h.startsWith('Bearer ') ? h.slice(7) : ''
    const a = this.db.access[t]
    if (!a || !this.db.users[a.user_id] || !this.db.devices[a.device_id])
      throw new HttpError(401, 'unauthorized', 'Sessão inválida.')
    if (a.exp < Date.now())
      throw new HttpError(401, 'unauthorized', 'Token expirado.', { reason: 'expired' })
    this.db.devices[a.device_id].last_seen_at = now()
    return a
  }

  /** Testes: expira todos os access tokens (força o refresh pelo cookie). */
  expireAccessTokens(): void {
    for (const a of Object.values(this.db.access)) a.exp = 0
    this.save()
  }

  private revokeDevice(id: string): void {
    for (const [t, a] of Object.entries(this.db.access))
      if (a.device_id === id) delete this.db.access[t]
    for (const [t, r] of Object.entries(this.db.refresh))
      if (r.device_id === id) {
        delete this.db.refresh[t]
        if (this.db.cookie === t) this.db.cookie = null
      }
    for (const c of [...this.conns]) if (c.device_id === id) c.close(4403, 'device_revoked')
    delete this.db.devices[id]
  }

  private consumeReauth(userId: string, purpose: string, code: unknown): void {
    if (this.db.reauth[userId] !== purpose || String(code) !== this.db.config.code)
      throw new HttpError(400, 'code_invalid', 'Código incorreto ou expirado.')
    delete this.db.reauth[userId]
  }

  private userByEmail(email: string): UserRow | undefined {
    return Object.values(this.db.users).find((u) => u.email === email)
  }

  private account(u: UserRow) {
    const live = Object.values(u.records).filter((r) => !r.deleted)
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      created_at: u.created_at,
      keys_ready: u.keys_ready,
      usage: {
        record_bytes: live.reduce((n, r) => n + r.size, 0),
        records: live.length,
        blob_bytes: 0,
        blobs: 0,
        devices: Object.values(this.db.devices).filter((d) => d.user_id === u.id).length
      },
      quotas: { record_bytes: null, records: null, blob_bytes: null, devices: null }
    }
  }

  private listDevices(userId: string, current: string) {
    const online = new Set([...this.conns].map((c) => c.device_id))
    return Object.values(this.db.devices)
      .filter((d) => d.user_id === userId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        client: d.client,
        app_version: d.app_version,
        can_host: d.can_host,
        created_at: d.created_at,
        last_seen_at: d.last_seen_at,
        last_ip: d.last_ip,
        online: online.has(d.id) || !!d.fake_online,
        current: d.id === current
      }))
  }

  // ------------------------------------------------------------------ chaves

  private validSlot(slot: unknown, kind: 'password' | 'recovery'): boolean {
    if (!slot || typeof slot !== 'object') return false
    const s = slot as {
      kdf?: Record<string, unknown>
      salt?: string
      wrap?: { n?: string; c?: string }
    }
    try {
      if (fromB64u(String(s.salt)).length !== 16) return false
      if (fromB64u(String(s.wrap?.n)).length !== 12) return false
      if (fromB64u(String(s.wrap?.c)).length !== 48) return false
    } catch {
      return false
    }
    const k = s.kdf ?? {}
    if (kind === 'recovery') return k.alg === 'hkdf-sha256'
    const n = (x: unknown) => (typeof x === 'number' ? x : NaN)
    return (
      k.alg === 'argon2id' &&
      k.v === 19 &&
      k.len === 32 &&
      n(k.m) >= 19456 &&
      n(k.m) <= 1048576 &&
      n(k.t) >= 2 &&
      n(k.t) <= 10 &&
      n(k.p) >= 1 &&
      n(k.p) <= 4
    )
  }

  private keysSetup(user: UserRow, body: KeysSetupBody): MockResponse {
    if (user.keys_ready)
      throw new HttpError(409, 'keys_already_set', 'As chaves já foram definidas.')
    if (!this.validSlot(body.password, 'password') || !this.validSlot(body.recovery, 'recovery'))
      throw new HttpError(400, 'invalid_request', 'Formato das chaves inválido.')
    if (fromB64u(String(body.verifier)).length !== 32)
      throw new HttpError(400, 'invalid_request', 'verifier inválido.')
    user.keys = { key_version: 1, keys_rev: 1, password: body.password, recovery: body.recovery }
    user.verifier = body.verifier
    user.keys_ready = true
    return { status: 200, body: user.keys }
  }

  private async keysChange(
    user: UserRow,
    body: Record<string, unknown>,
    slot: 'password' | 'recovery'
  ): Promise<MockResponse> {
    if (!user.keys || !user.verifier)
      throw new HttpError(409, 'keys_not_ready', 'Chaves não definidas.')
    const ok = await sha256(fromB64u(String(body.key_proof ?? '')))
      .then((h) => bytesEqual(h, fromB64u(user.verifier!)))
      .catch(() => false)
    if (!ok) throw new HttpError(403, 'key_proof_invalid', 'A prova de posse da chave não confere.')
    if (!this.validSlot(body[slot], slot))
      throw new HttpError(400, 'invalid_request', 'Formato inválido.')
    user.keys = { ...user.keys, [slot]: body[slot], keys_rev: user.keys.keys_rev + 1 }
    this.broadcast(user.id, { t: 'keys.changed', keys_rev: user.keys.keys_rev })
    return { status: 200, body: { keys_rev: user.keys.keys_rev } }
  }

  // ------------------------------------------------------------------ registros

  private listRecords(user: UserRow, q: URLSearchParams): MockResponse {
    const type = q.get('type')
    const scope = q.get('scope')
    const after = Number(q.get('after') ?? 0) || 0
    const limit = Math.min(1000, Number(q.get('limit') ?? 500) || 500)
    const payload = q.get('payload') !== '0'
    const all = Object.values(user.records)
      .filter(
        (c) =>
          !c.deleted && c.seq > after && (!type || c.type === type) && (!scope || c.scope === scope)
      )
      .sort((a, b) => a.seq - b.seq)
    const page = all.slice(0, limit)
    const records = page.map((c) =>
      payload ? c : { ...c, env: undefined, omitted: true as const }
    )
    return {
      status: 200,
      body: {
        records,
        next: page.length ? page[page.length - 1].seq : user.seq,
        has_more: all.length > limit,
        head: user.seq
      }
    }
  }

  private push(user: UserRow, deviceId: string, req: PushRequest): MockResponse {
    const items = Array.isArray(req.items) ? req.items : []
    if (!items.length || items.length > 500)
      throw new HttpError(400, 'invalid_request', 'Lote inválido.')
    const inBatch = new Set(items.filter((i) => i.type === 'chat' && !i.deleted).map((i) => i.id))
    for (const it of items) this.validateItem(it)
    const conflicts: PushConflict[] = []
    for (const it of items) {
      const cur = user.records[`${it.type}|${it.id}`]
      const curRev = cur?.rev ?? 0
      if (cur?.deleted && it.base_rev !== cur.rev) {
        conflicts.push({ type: it.type, id: it.id, reason: 'gone', current: cur })
        continue
      }
      if (curRev !== it.base_rev) {
        conflicts.push({ type: it.type, id: it.id, reason: 'rev_mismatch', current: cur })
        continue
      }
      const scopeKind = SCOPED[it.type]
      if ((scopeKind === 'chat' || scopeKind === 'memory_collection') && !it.deleted) {
        const parent = user.records[`${scopeKind}|${it.scope}`]
        if (parent?.deleted) conflicts.push({ type: it.type, id: it.id, reason: 'scope_deleted' })
        else if (!parent && !(scopeKind === 'chat' && inBatch.has(String(it.scope))))
          conflicts.push({ type: it.type, id: it.id, reason: 'scope_missing' })
      }
    }
    if (conflicts.length)
      throw new HttpError(409, 'conflict', 'Conflito de revisão.', { conflicts })
    const results: { type: string; id: string; rev: number; seq: number }[] = []
    const changes: Change[] = []
    for (const it of items) {
      user.seq += 1
      const ch: Change = {
        seq: user.seq,
        type: it.type,
        id: it.id,
        scope: it.scope,
        rev: it.rev,
        deleted: it.deleted,
        ...(it.deleted ? {} : { env: it.env }),
        size: it.deleted || !it.env ? 0 : fromB64u(it.env.c).length,
        blobs: it.deleted ? [] : (it.blobs ?? []),
        device_id: deviceId,
        updated_at: now()
      }
      user.records[`${it.type}|${it.id}`] = ch
      if (it.deleted && (it.type === 'chat' || it.type === 'memory_collection')) {
        const child = it.type === 'chat' ? ['session', 'message'] : ['memory']
        for (const [k, r] of Object.entries(user.records))
          if (child.includes(r.type) && r.scope === it.id) delete user.records[k]
      }
      results.push({ type: it.type, id: it.id, rev: it.rev, seq: user.seq })
      changes.push(ch)
    }
    this.broadcast(user.id, { t: 'sync.changes', changes, head: user.seq })
    return { status: 200, body: { results, head: user.seq } }
  }

  private validateItem(it: PushItem): void {
    const bad = (msg: string) => new HttpError(400, 'invalid_request', msg)
    if (!KNOWN_TYPES.has(it.type)) throw bad(`Tipo desconhecido: ${it.type}`)
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(it.id)) throw bad('id inválido')
    if (it.rev !== it.base_rev + 1) throw bad('rev precisa ser base_rev + 1')
    const sk = SCOPED[it.type]
    if (sk === null && it.scope !== null) throw bad('scope deve ser nulo')
    if (sk === 'self' && it.scope !== it.id) throw bad('scope do chat = id')
    if ((sk === 'chat' || sk === 'memory_collection') && !it.scope) throw bad('scope obrigatório')
    if (it.deleted && (it.env || it.blobs?.length)) throw bad('tombstone sem env/blobs')
    if (it.type === 'setting' && it.deleted) throw bad('setting nunca é tombstone')
    if (!it.deleted && !isWellFormedEnvelope(it.env)) throw bad('envelope malformado')
  }

  /** Simula outro dispositivo apagando um chat (testes de atualização ao vivo). */
  remoteDeleteChat(userId: string, chatId: string): void {
    const user = this.db.users[userId]
    const cur = user?.records[`chat|${chatId}`]
    if (!cur || cur.deleted) return
    const dev = Object.values(this.db.devices).find((d) => d.user_id === userId && d.fake_online)
    this.push(user, dev?.id ?? uuid(), {
      push_id: uuid(),
      items: [
        {
          type: 'chat',
          id: chatId,
          scope: chatId,
          base_rev: cur.rev,
          rev: cur.rev + 1,
          deleted: true,
          blobs: []
        }
      ]
    })
    this.save()
  }

  /** Grava registros já cifrados "vindos" de outro dispositivo (seed / simulações). */
  remotePush(userId: string, items: PushItem[]): void {
    const user = this.db.users[userId]
    const dev = Object.values(this.db.devices).find((d) => d.user_id === userId && d.fake_online)
    this.push(user, dev?.id ?? uuid(), { push_id: uuid(), items })
    this.save()
  }

  addUser(row: Omit<UserRow, 'records' | 'seq'>): UserRow {
    const u: UserRow = { ...row, seq: 0, records: {} }
    this.db.users[u.id] = u
    return u
  }

  addDevice(row: Omit<DeviceRow, 'id'>): string {
    const id = uuid()
    this.db.devices[id] = { ...row, id }
    return id
  }

  addInvite(email?: string): string {
    const t = b64u(randomBytes(32))
    this.db.invites[t] = { email, used: false }
    this.save()
    return t
  }

  // ------------------------------------------------------------------ WebSocket

  connect(conn: MockConn): void {
    this.conns.add(conn)
  }
  disconnect(conn: MockConn): void {
    this.conns.delete(conn)
  }

  onSocketMessage(conn: MockConn, raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw)
    } catch {
      conn.close(4000, 'protocol_error')
      return
    }
    if (msg.t === 'hello') {
      const a = this.db.access[String(msg.access_token)]
      if (!a || a.exp < Date.now()) {
        conn.close(4401, 'unauthorized')
        return
      }
      if (msg.protocol !== 1) {
        conn.close(4001, 'unsupported_protocol')
        return
      }
      for (const c of [...this.conns])
        if (c !== conn && c.device_id === a.device_id) c.close(4409, 'superseded')
      conn.user_id = a.user_id
      conn.device_id = a.device_id
      const u = this.db.users[a.user_id]
      conn.deliver({
        t: 'welcome',
        re: msg.id,
        protocol: 1,
        user_id: u.id,
        device_id: a.device_id,
        head: u.seq,
        server_time: now(),
        chat_states: [],
        state_cursor: 0,
        resumed_windows: [],
        lost_windows: [],
        keys_rev: u.keys?.keys_rev ?? 0
      })
      return
    }
    if (!conn.user_id) {
      conn.close(4000, 'protocol_error')
      return
    }
    if (msg.t === 'ping') {
      conn.deliver({ t: 'pong', re: msg.id, ts: msg.ts })
      return
    }
    conn.deliver({
      t: 'error',
      re: msg.id,
      code: 'invalid_request',
      message: 'Não suportado no mock.'
    })
  }

  private broadcast(userId: string, msg: unknown): void {
    for (const c of this.conns) if (c.user_id === userId) c.deliver(msg)
  }

  private closeUser(userId: string, code: number, reason: string, except?: string): void {
    for (const c of [...this.conns])
      if (c.user_id === userId && c.device_id !== except) c.close(code, reason)
  }
}
