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

/**
 * idle: nunca iniciado · connecting: abrindo/esperando o `welcome` · online: `welcome` recebido ·
 * offline: caiu, nova tentativa agendada (backoff) · stopped: parado (stop() ou fechamento terminal).
 */
export type SocketStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'stopped'

/** Fechamentos em que o cliente NÃO reconecta sozinho (§10.2). */
export const TERMINAL_CLOSE_CODES: readonly number[] = [4001, 4403, 4409]

export interface SyncSocketOptions {
  url: string
  /** Fábrica do socket; ausente/undefined = `new WebSocket(url)` do navegador. */
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
  /** Tempo máximo entre abrir o socket e receber o `welcome` (senão fecha e tenta de novo). */
  handshakeTimeoutMs?: number
}

const OPEN = 1
const browserFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike

export class SyncSocket {
  private ws: SocketLike | null = null
  private attempt = 0
  /** 4401 seguidos sem `welcome` no meio (evita laço refresh → 4401 → refresh sem pausa). */
  private authFailures = 0
  private reqId = 0
  private stopped = true
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly url: string
  private readonly factory: SocketFactory
  private readonly pingIntervalMs: number
  private readonly pongTimeoutMs: number
  private readonly handshakeTimeoutMs: number
  private readonly opts: SyncSocketOptions
  status: SocketStatus = 'idle'
  /** Código do último fechamento (para a interface explicar o estado). */
  lastCloseCode: number | null = null

  constructor(opts: SyncSocketOptions) {
    // Atenção: `{ ...defaults, ...opts }` NÃO serve — uma chave presente com valor undefined (ex.:
    // `factory: getSocketFactory()` fora do modo mock) apagaria o padrão.
    this.opts = opts
    this.url = opts.url
    this.factory = opts.factory ?? browserFactory
    this.pingIntervalMs = opts.pingIntervalMs ?? 15_000
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 10_000
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 15_000
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.authFailures = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.clearRetry()
    this.drop(1000, 'bye')
    this.setStatus('stopped')
  }

  /** Tenta já (ex.: o navegador voltou a ficar online ou a aba voltou a ficar visível). */
  retryNow(): void {
    if (this.stopped || this.status !== 'offline') return
    this.clearRetry()
    this.connect()
  }

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return
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
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.pingTimer = this.pongTimer = this.stableTimer = this.handshakeTimer = null
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /** Solta o socket atual sem disparar o onclose dele. */
  private drop(code: number, reason: string): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws.close(code, reason)
    } catch {
      /* já fechado */
    }
  }

  private connect(): void {
    this.clearTimers()
    this.drop(1000, 'reconnect')
    const token = this.opts.getToken()
    if (!token) {
      this.setStatus('offline')
      this.scheduleReconnect(5000)
      return
    }
    this.setStatus('connecting')
    let ws: SocketLike
    try {
      ws = this.factory(this.url)
    } catch {
      this.setStatus('offline')
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    // Sem `welcome` a tempo (abertura travada, proxy que não repassa, hello sem resposta): tenta de novo.
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      this.lose(ws, 4000)
    }, this.handshakeTimeoutMs)
    ws.onopen = () => {
      try {
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
      } catch {
        this.lose(ws, 4000)
      }
    }
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev)
    }
    ws.onerror = () => {
      /* o onclose vem em seguida e cuida da reconexão */
    }
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClose(ev.code)
    }
  }

  /** Abandona o socket (sem esperar o onclose, que pode não vir) e segue como se tivesse fechado. */
  private lose(ws: SocketLike, code: number): void {
    if (this.ws !== ws) return
    this.drop(code, 'timeout')
    this.onClose(code)
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
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
        this.authFailures = 0
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
        break // chat.state, stream.*, error etc.: não usados pelo site
    }
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== OPEN) return
      try {
        ws.send(JSON.stringify({ t: 'ping', id: this.nextId(), ts: Date.now() }))
      } catch {
        this.lose(ws, 4000)
        return
      }
      if (!this.pongTimer)
        this.pongTimer = setTimeout(() => {
          // sem pong em 10 s → reconectar (sem depender do onclose de um socket meio morto)
          this.pongTimer = null
          this.lose(ws, 4000)
        }, this.pongTimeoutMs)
    }, this.pingIntervalMs)
  }

  private onClose(code: number): void {
    this.clearTimers()
    this.ws = null
    this.lastCloseCode = code
    if (this.stopped) return
    if (TERMINAL_CLOSE_CODES.includes(code)) {
      this.stopped = true
      this.clearRetry()
      this.setStatus('stopped')
      this.opts.onFatal?.(code)
      return
    }
    this.setStatus('offline')
    if (code === 4401) {
      // token expirado/inválido: renova e reconecta já — na 2ª vez seguida, com o backoff normal
      this.authFailures++
      this.opts.refresh().then(
        () => {
          if (this.stopped || this.ws || this.retryTimer) return
          if (this.authFailures <= 1) this.connect()
          else this.scheduleReconnect()
        },
        () => {
          if (!this.stopped && !this.ws && !this.retryTimer) this.scheduleReconnect()
        }
      )
      return
    }
    this.scheduleReconnect()
  }

  /** Backoff exponencial com jitter total: random(0, min(30 s, 1 s · 2^tentativa)). */
  private scheduleReconnect(fixedDelayMs?: number): void {
    if (this.stopped) return
    this.clearRetry()
    const cap = Math.min(30_000, 1000 * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 10)
    const delay = fixedDelayMs ?? Math.random() * cap
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.connect()
    }, delay)
  }
}
