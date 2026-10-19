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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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
    await vi.advanceTimersByTimeAsync(0)
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

  it('sem factory (ou factory undefined) usa o WebSocket do navegador', () => {
    vi.useFakeTimers()
    const created: FakeSocket[] = []
    vi.stubGlobal(
      'WebSocket',
      class extends FakeSocket {
        constructor(url: string) {
          super(url)
          created.push(this)
        }
      }
    )
    try {
      // regressão: `factory: getSocketFactory()` (undefined fora do mock) apagava o padrão e o
      // site nunca abria o WebSocket — ficava em "Reconectando" para sempre
      const s = new SyncSocket({
        url: 'wss://x/ws',
        factory: undefined,
        getToken: () => 'cca_1',
        refresh: async () => undefined,
        onEvent: () => {}
      })
      s.start()
      expect(created.length).toBe(1)
      created[0].open()
      expect(created[0].sent[0]).toMatchObject({ t: 'hello', access_token: 'cca_1' })
      created[0].recv({ t: 'welcome', re: '1', head: 0, keys_rev: 1 })
      expect(s.status).toBe('online')
      s.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('factory que lança → offline e nova tentativa com backoff', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.99) // jitter no teto: 0,99 s, depois 1,98 s
    let calls = 0
    const statuses: string[] = []
    const s = new SyncSocket({
      url: 'wss://x/ws',
      factory: (url) => {
        calls++
        if (calls < 3) throw new Error('boom')
        return new FakeSocket(url)
      },
      getToken: () => 'cca_1',
      refresh: async () => undefined,
      onEvent: () => {},
      onStatus: (st) => statuses.push(st)
    })
    s.start()
    expect(s.status).toBe('offline')
    vi.advanceTimersByTime(1_000)
    expect(calls).toBe(2)
    vi.advanceTimersByTime(2_000)
    expect(calls).toBe(3)
    expect(s.status).toBe('connecting')
    expect(statuses).toContain('offline')
    s.stop()
  })

  it('sem welcome a tempo → abandona e reconecta', () => {
    vi.useFakeTimers()
    const { s, sockets } = setup()
    s.start()
    sockets[0].open() // hello enviado, servidor não responde
    expect(s.status).toBe('connecting')
    vi.advanceTimersByTime(15_000)
    expect(s.status).toBe('offline')
    expect(sockets[0].readyState).toBe(3)
    vi.advanceTimersByTime(1_000)
    expect(sockets.length).toBe(2)
    s.stop()
  })

  it('socket que nunca abre (nem fecha) → reconecta', () => {
    vi.useFakeTimers()
    const { s, sockets } = setup()
    s.start()
    vi.advanceTimersByTime(15_000)
    expect(s.status).toBe('offline')
    vi.advanceTimersByTime(1_000)
    expect(sockets.length).toBe(2)
    s.stop()
  })

  it('1000/1006/4002/4429 → reconecta com backoff; 4409 e 4001 → param', () => {
    vi.useFakeTimers()
    const { s, sockets, fatal } = setup()
    s.start()
    let n = 1
    for (const [i, code] of [1000, 1006, 4002, 4429].entries()) {
      sockets[n - 1].open()
      sockets[n - 1].close(code)
      expect(s.status).toBe('offline')
      vi.advanceTimersByTime(1000 * 2 ** i) // teto do backoff nesta tentativa
      expect(sockets.length).toBe(++n)
    }
    sockets[n - 1].open()
    sockets[n - 1].close(4409)
    expect(s.status).toBe('stopped')
    expect(fatal).toHaveBeenCalledWith(4409)
    vi.advanceTimersByTime(60_000)
    expect(sockets.length).toBe(n)
  })

  it('4401 repetido não vira laço sem pausa', async () => {
    vi.useFakeTimers()
    const { s, sockets, refresh } = setup()
    s.start()
    sockets[0].open()
    sockets[0].close(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets.length).toBe(2) // 1º 4401: reconecta já
    sockets[1].open()
    sockets[1].close(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(s.status).toBe('offline') // 2º seguido: espera o backoff
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sockets.length).toBe(3)
    s.stop()
  })

  it('retryNow() pula o backoff quando offline', () => {
    vi.useFakeTimers()
    const { s, sockets } = setup()
    s.start()
    sockets[0].open()
    sockets[0].close(1006)
    s.retryNow()
    expect(sockets.length).toBe(2)
    s.stop()
  })
})
