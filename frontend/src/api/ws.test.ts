import { afterEach, describe, expect, it, vi } from 'vitest'
import { type SocketLike, SyncSocket } from './ws'

class FakeSocket implements SocketLike {
  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: Record<string, unknown>[] = []
  constructor(readonly url: string) {}
  open() {
    this.readyState = 1
    this.onopen?.({} as Event)
  }
  recv(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code } as CloseEvent)
  }
}

afterEach(() => vi.useRealTimers())

function setup(token = 'cca_1') {
  const sockets: FakeSocket[] = []
  const events: unknown[] = []
  const fatal = vi.fn()
  const refresh = vi.fn(async () => undefined)
  const s = new SyncSocket({
    url: 'wss://x/clearchat/ws',
    factory: (url) => {
      const f = new FakeSocket(url)
      sockets.push(f)
      return f
    },
    getToken: () => token,
    refresh,
    onEvent: (e) => events.push(e),
    onFatal: fatal
  })
  return { s, sockets, events, fatal, refresh }
}

describe('SyncSocket', () => {
  it('hello com o token, welcome, sync.changes e heartbeat', () => {
    vi.useFakeTimers()
    const { s, sockets, events } = setup()
    s.start()
    const ws = sockets[0]
    expect(ws.url).toBe('wss://x/clearchat/ws')
    ws.open()
    expect(ws.sent[0]).toMatchObject({ t: 'hello', protocol: 1, access_token: 'cca_1', id: '1' })
    ws.recv({ t: 'welcome', re: '1', head: 5, keys_rev: 1 })
    expect(s.status).toBe('online')
    ws.recv({ t: 'sync.changes', changes: [{ type: 'chat' }], head: 6 })
    ws.recv({ t: 'chat.state', chat_id: 'x' }) // ignorado pelo site
    expect(events.map((e) => (e as { t: string }).t)).toEqual(['welcome', 'sync.changes'])
    vi.advanceTimersByTime(15_000)
    expect(ws.sent.at(-1)).toMatchObject({ t: 'ping' })
    // sem pong em 10 s → fecha e reconecta
    vi.advanceTimersByTime(10_000)
    expect(ws.readyState).toBe(3)
    vi.advanceTimersByTime(2_000)
    expect(sockets.length).toBe(2)
    s.stop()
  })

  it('4401 → refresh e reconecta; 4403 → fatal sem reconectar', async () => {
    vi.useFakeTimers()
    const { s, sockets, fatal, refresh } = setup()
    s.start()
    sockets[0].open()
    sockets[0].close(4401)
    expect(refresh).toHaveBeenCalled()
    await vi.runOnlyPendingTimersAsync()
    expect(sockets.length).toBe(2)
    sockets[1].open()
    sockets[1].close(4403)
    expect(fatal).toHaveBeenCalledWith(4403)
    vi.advanceTimersByTime(60_000)
    expect(sockets.length).toBe(2)
  })

  it('stop() não reconecta', () => {
    vi.useFakeTimers()
    const { s, sockets } = setup()
    s.start()
    sockets[0].open()
    s.stop()
    vi.advanceTimersByTime(60_000)
    expect(sockets.length).toBe(1)
    expect(s.status).toBe('stopped')
  })
})
