// WebSocket do protocolo (SYNC_PROTOCOL.md §10) — o site só usa as notificações de registros
// (`sync.changes`) e de chaves/conta para atualizar as listas. Sem stream ao vivo nem comandos remotos.
import type { Change } from './types'

/** O mínimo da API do WebSocket que usamos (permite injetar o mock). */
export interface SocketLike {
  readonly readyState: number
  onopen: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  onerror: ((ev: Event) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type SocketFactory = (url: string) => SocketLike

export type SyncEvent =
  | { t: 'sync.changes'; changes: Change[]; head: number }
  | { t: 'keys.changed'; keys_rev: number }
  | { t: 'keys.reset' }
  | { t: 'account.deleted' }
  | { t: 'welcome'; head: number; keys_rev: number; device_id: string; user_id: string }

export type SocketStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'stopped'

export interface SyncSocketOptions {
  url: string
  factory?: SocketFactory
  /** Access token atual (renovado antes de reconectar após 4401). */
  getToken: () => string | null
  refresh: () => Promise<unknown>
  onEvent: (ev: SyncEvent) => void
  onStatus?: (s: SocketStatus) => void
  /** Fechamento terminal (4403 revogado/resetado, 4001 protocolo, 4409 outra aba assumiu). */
  onFatal?: (code: number) => void
  pingIntervalMs?: number
  pongTimeoutMs?: number
}

const OPEN = 1

export class SyncSocket {
  private ws: SocketLike | null = null
  private attempt = 0
  private reqId = 0
  private stopped = true
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private readonly opts: Required<Omit<SyncSocketOptions, 'onStatus' | 'onFatal'>> &
    Pick<SyncSocketOptions, 'onStatus' | 'onFatal'>
  status: SocketStatus = 'idle'

  constructor(opts: SyncSocketOptions) {
    this.opts = {
      factory: (url) => new WebSocket(url) as unknown as SocketLike,
      pingIntervalMs: 15_000,
      pongTimeoutMs: 10_000,
      ...opts
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.close(1000, 'bye')
    }
    this.setStatus('stopped')
  }

  private setStatus(s: SocketStatus): void {
    this.status = s
    this.opts.onStatus?.(s)
  }

  private nextId(): string {
    return String(++this.reqId)
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.pingTimer = this.pongTimer = this.stableTimer = null
  }

  private connect(): void {
    const token = this.opts.getToken()
    if (!token) {
      this.scheduleReconnect(true)
      return
    }
    this.setStatus('connecting')
    let ws: SocketLike
    try {
      ws = this.opts.factory(this.opts.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          id: this.nextId(),
          protocol: 1,
          access_token: token,
          cursor: 0,
          state_cursor: 0,
          active_windows: [],
          subscriptions: []
        })
      )
    }
    ws.onmessage = (ev) => this.onMessage(ev)
    ws.onerror = () => {
      /* onclose cuida da reconexão */
    }
    ws.onclose = (ev) => this.onClose(ev.code)
  }

  private onMessage(ev: MessageEvent): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    switch (msg.t) {
      case 'welcome':
        this.setStatus('online')
        this.startHeartbeat()
        // zera o backoff só depois de 60 s conectado (§10.2)
        this.stableTimer = setTimeout(() => (this.attempt = 0), 60_000)
        this.opts.onEvent(msg as unknown as SyncEvent)
        break
      case 'pong':
        if (this.pongTimer) clearTimeout(this.pongTimer)
        this.pongTimer = null
        break
      case 'sync.changes':
      case 'keys.changed':
      case 'keys.reset':
      case 'account.deleted':
        this.opts.onEvent(msg as unknown as SyncEvent)
        break
      default:
        break // chat.state, stream.* etc.: não usados pelo site
    }
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== OPEN) return
      ws.send(JSON.stringify({ t: 'ping', id: this.nextId(), ts: Date.now() }))
      if (!this.pongTimer)
        this.pongTimer = setTimeout(() => {
          // sem pong em 10 s → reconectar
          this.ws?.close(4000, 'pong timeout')
        }, this.opts.pongTimeoutMs)
    }, this.opts.pingIntervalMs)
  }

  private onClose(code: number): void {
    this.clearTimers()
    this.ws = null
    if (this.stopped) return
    if (code === 4403 || code === 4001 || code === 4409) {
      this.stopped = true
      this.setStatus('stopped')
      this.opts.onFatal?.(code)
      return
    }
    this.setStatus('offline')
    if (code === 4401) {
      this.opts.refresh().then(
        () => !this.stopped && this.connect(),
        () => this.scheduleReconnect()
      )
      return
    }
    this.scheduleReconnect()
  }

  /** Backoff exponencial com jitter total: random(0, min(30 s, 1 s · 2^tentativa)). */
  private scheduleReconnect(slow = false): void {
    if (this.stopped) return
    const cap = Math.min(30_000, 1000 * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 10)
    const delay = slow ? 5000 : Math.random() * cap
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.connect()
    }, delay)
  }
}
