// Chats só ao vivo no site (§23.4, §23.10): vetores do anúncio (docs/test-vectors/live.json), regras da
// lista (ack substitui, anti-replay por arev, removed/host, settling) e o fluxo do WebSocket.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { type SocketLike, SyncSocket } from '../api/ws'
import { aadLiveAnnounce, type Envelope, fromHex, fromUtf8, open, utf8 } from '../crypto'
import {
  applyHost,
  applyList,
  applyRemoved,
  applyUpdate,
  dropStale,
  type LiveChatWire,
  liveStatus,
  openLiveChat
} from './liveChats'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/test-vectors')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const live: any = JSON.parse(readFileSync(join(DIR, 'live.json'), 'utf8'))
const announce = live.cases.find((c: { name: string }) => c.name === 'live-announce')
const KEY = fromHex(live.stream_key_hex)
const CHAT = JSON.parse(announce.json).chatId as string
const EPOCH = 1793923200000

function wire(
  over: Partial<LiveChatWire> = {},
  host = live.host_device_id as string
): LiveChatWire {
  return {
    chat_id: CHAT,
    epoch: EPOCH,
    arev: 3,
    running: true,
    env: announce.envelope as Envelope,
    host: { device_id: host, name: 'PC da Ana', platform: 'linux', status: 'online' },
    announced_at: '2026-11-06T12:00:00.000Z',
    ...over
  }
}

describe('live.json (anúncio)', () => {
  it('AAD exata e decifra o vetor', async () => {
    const aad = aadLiveAnnounce(live.user_id, live.host_device_id, CHAT, EPOCH, 3)
    expect(fromUtf8(aad)).toBe(announce.aad_utf8)
    const frame = await open(KEY, utf8(announce.aad_utf8), announce.envelope)
    expect(Buffer.from(frame).toString('hex')).toBe(announce.frame_hex)
    const info = await openLiveChat(KEY, live.user_id, wire())
    expect(info).toEqual({
      chatId: CHAT,
      title: 'Plano da viagem',
      status: 'waiting',
      updatedAt: 1793923260000,
      personaName: 'Padrão',
      model: 'anthropic/claude-sonnet-4.5'
    })
  })

  it('casos que DEVEM falhar', async () => {
    for (const c of live.must_fail) {
      await expect(open(KEY, utf8(c.aad_utf8), c.envelope)).rejects.toThrow()
    }
    // campos de fora trocados (outro host, arev, epoch, chat) → o item não aparece
    expect(
      await openLiveChat(KEY, live.user_id, wire({}, '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5c'))
    ).toBeNull()
    expect(await openLiveChat(KEY, live.user_id, wire({ arev: 4 }))).toBeNull()
    expect(await openLiveChat(KEY, live.user_id, wire({ epoch: EPOCH + 1 }))).toBeNull()
    expect(await openLiveChat(KEY, live.user_id, wire({ chat_id: 'outro' }))).toBeNull()
    expect(await openLiveChat(new Uint8Array(32), live.user_id, wire())).toBeNull()
  })
})

describe('lista ao vivo', () => {
  const a = wire({ chat_id: 'a', arev: 1 })
  const b = wire({ chat_id: 'b', arev: 1 }, 'host-2')

  it('ack substitui; settling mantém os conhecidos como reconectando', () => {
    let m = applyList({}, [a, b, { lixo: true }], 0)
    expect(Object.keys(m).sort()).toEqual(['a', 'b'])
    m = applyList(m, [a], 0)
    expect(Object.keys(m)).toEqual(['a'])
    m = applyList({ a: { chat: a, stale: false }, b: { chat: b, stale: false } }, [a], 30)
    expect(m.b.stale).toBe(true)
    expect(liveStatus(m.b, null)).toBe('reconectando')
    expect(Object.keys(dropStale(m))).toEqual(['a'])
  })

  it('anti-replay por arev dentro do epoch; epoch novo vale', () => {
    let m = applyList({}, [a], 0)
    expect(applyUpdate(m, [wire({ chat_id: 'a', arev: 1, running: false })])).toBe(m)
    m = applyUpdate(m, [wire({ chat_id: 'a', arev: 2, running: false })])
    expect(m.a.chat.arev).toBe(2)
    expect(applyUpdate(m, [wire({ chat_id: 'a', arev: 1 })])).toBe(m)
    m = applyUpdate(m, [wire({ chat_id: 'a', arev: 1, epoch: EPOCH + 9 })])
    expect(m.a.chat.epoch).toBe(EPOCH + 9)
  })

  it('removed só do host certo; host em tolerância = reconectando', () => {
    let m = applyList({}, [a, b], 0)
    expect(applyRemoved(m, 'host-2', ['a'])).toBe(m)
    m = applyRemoved(m, 'host-2', ['b'])
    expect(Object.keys(m)).toEqual(['a'])
    m = applyHost(m, live.host_device_id, 'grace')
    expect(liveStatus(m.a, null)).toBe('reconectando')
    m = applyHost(m, live.host_device_id, 'online')
    const info = { chatId: 'a', title: 't', updatedAt: 0, personaName: null, model: null }
    expect(liveStatus(m.a, { ...info, status: 'waiting' })).toBe('aguardando você')
    expect(liveStatus(m.a, { ...info, status: 'running' })).toBe('rodando')
    expect(liveStatus(m.a, { ...info, status: 'idle' })).toBe('ocioso')
  })
})

class FakeSocket implements SocketLike {
  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: Record<string, unknown>[] = []
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

describe('SyncSocket + live.*', () => {
  it('declara caps, pede live.list depois do welcome e descarta live.* antes do ack', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const events: { t: string }[] = []
    const s = new SyncSocket({
      url: 'ws://x/ws',
      factory: () => {
        const f = new FakeSocket()
        sockets.push(f)
        return f
      },
      getToken: () => 'cca_1',
      refresh: async () => undefined,
      onEvent: (e) => events.push(e)
    })
    s.start()
    const ws = sockets[0]
    ws.open()
    expect(ws.sent[0]).toMatchObject({ t: 'hello', caps: ['live_chats'] })
    ws.recv({ t: 'welcome', re: '1', head: 0, keys_rev: 1, caps: ['live_chats'] })
    const list = ws.sent.at(-1)!
    expect(list.t).toBe('live.list')
    ws.recv({ t: 'live.update', chats: [] }) // antes do ack: já está nele
    ws.recv({ t: 'ack', re: list.id, chats: [wire()], settling_s: 0 })
    ws.recv({ t: 'live.removed', host_device_id: 'h', chat_ids: ['x'], reason: 'deleted' })
    ws.recv({ t: 'live.refresh_request', requester_device_id: 'd' }) // o site não é host
    expect(events.map((e) => e.t)).toEqual(['welcome', 'live.list', 'live.removed'])
    // servidor sem suporte: não pede lista
    ws.close(1000)
    vi.advanceTimersByTime(2_000)
    const ws2 = sockets[1]
    ws2.open()
    ws2.recv({ t: 'welcome', re: ws2.sent[0].id, head: 0, keys_rev: 1 })
    expect(ws2.sent.some((m) => m.t === 'live.list')).toBe(false)
    s.stop()
    vi.useRealTimers()
  })
})
