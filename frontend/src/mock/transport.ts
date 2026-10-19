// Adaptadores do servidor simulado: `fetch` e `WebSocket` falsos com a mesma interface dos reais.
import type { FetchFn } from '../api/client'
import type { SocketLike } from '../api/ws'
import type { MockConn, MockServer } from './server'

export function createMockFetch(server: MockServer, root: string): FetchFn {
  const prefix = new URL(root).pathname.replace(/\/+$/, '')
  return async (input, init = {}) => {
    const url = new URL(input, root)
    let path = url.pathname
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length)
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => (headers[k.toLowerCase()] = v))
    let body: unknown = undefined
    if (typeof init.body === 'string' && init.body) body = JSON.parse(init.body)
    const res = await server.handle({
      method: (init.method ?? 'GET').toUpperCase(),
      path,
      query: url.searchParams,
      headers,
      body
    })
    if (res.status === 204 || res.body === undefined)
      return new Response(null, { status: res.status, headers: res.headers })
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...res.headers }
    })
  }
}

/** WebSocket falso ligado ao MockServer (entrega assíncrona, como a rede). */
export class MockSocket implements SocketLike {
  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  private conn: MockConn

  constructor(private server: MockServer) {
    this.conn = {
      user_id: null,
      device_id: null,
      deliver: (msg) => {
        setTimeout(() => {
          if (this.readyState !== 1) return
          this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
        }, 0)
      },
      close: (code, reason) => this.finish(code, reason)
    }
    setTimeout(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      server.connect(this.conn)
      this.onopen?.({} as Event)
    }, 5)
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket não está aberto')
    setTimeout(() => this.server.onSocketMessage(this.conn, data), 0)
  }

  close(code = 1000, reason = ''): void {
    this.finish(code, reason)
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.server.disconnect(this.conn)
    setTimeout(() => this.onclose?.({ code, reason } as CloseEvent), 0)
  }
}
