// Chats só ao vivo de outros dispositivos (SYNC_PROTOCOL.md §23.4, §23.10). Em 1.8.0 o site só mostra a
// contagem e uma lista simples (título, host, status) — sem abrir, sem histórico, sem comandos. Tudo em
// memória: a lista vem do servidor (`live.list` + `live.*`) cifrada com K_stream e é decifrada aqui.
import { aadLiveAnnounce, type Envelope, isWellFormedEnvelope, open, unframeJson } from '../crypto'

/** `LiveChat` como o servidor manda (§23.4). */
export interface LiveChatWire {
  chat_id: string
  epoch: number
  arev: number
  running: boolean
  env: Envelope
  host: { device_id: string; name: string; platform: string; status: 'online' | 'grace' }
  announced_at: string
}

/** Plaintext do anúncio (`LiveChatInfo`, §23.4) — só o que o site usa; o resto é ignorado. */
export interface LiveChatInfo {
  chatId: string
  title: string
  status: 'idle' | 'running' | 'waiting'
  updatedAt: number
  personaName: string | null
  model: string | null
}

export interface LiveEntry {
  chat: LiveChatWire
  /** Conhecido antes da reconexão e ausente da lista nova: "reconectando…" até `settling_s` passar. */
  stale: boolean
}

export type LiveMap = Readonly<Record<string, LiveEntry>>

const fresh = (chat: LiveChatWire): LiveEntry => ({ chat, stale: false })

function wellFormed(c: unknown): c is LiveChatWire {
  if (!c || typeof c !== 'object') return false
  const x = c as Record<string, unknown>
  const h = x.host as Record<string, unknown> | undefined
  return (
    typeof x.chat_id === 'string' &&
    Number.isSafeInteger(x.epoch) &&
    Number.isSafeInteger(x.arev) &&
    isWellFormedEnvelope(x.env) &&
    !!h &&
    typeof h.device_id === 'string' &&
    typeof h.name === 'string'
  )
}

/**
 * Resposta do `live.list`: substitui a lista inteira. Com `settling_s > 0` (servidor reiniciou há pouco,
 * hosts ainda reconectando), os chats que já conhecíamos e não vieram ficam como `stale` — quem chama
 * agenda `dropStale` para depois de `settling_s`.
 */
export function applyList(prev: LiveMap, chats: unknown[], settlingS: number): LiveMap {
  const next: Record<string, LiveEntry> = {}
  for (const c of chats) if (wellFormed(c)) next[c.chat_id] = fresh(c)
  if (settlingS > 0)
    for (const [id, e] of Object.entries(prev)) if (!next[id]) next[id] = { ...e, stale: true }
  return next
}

/** `live.update`: dentro do mesmo `epoch`, `arev` menor ou igual à conhecida é ignorada (anti-replay). */
export function applyUpdate(prev: LiveMap, chats: unknown[]): LiveMap {
  let next: Record<string, LiveEntry> | null = null
  for (const c of chats) {
    if (!wellFormed(c)) continue
    const cur = (next ?? prev)[c.chat_id]
    if (cur && !cur.stale && cur.chat.epoch === c.epoch && c.arev <= cur.chat.arev) continue
    next ??= { ...prev }
    next[c.chat_id] = fresh(c)
  }
  return next ?? prev
}

export function applyRemoved(prev: LiveMap, hostDeviceId: string, chatIds: string[]): LiveMap {
  const ids = chatIds.filter((id) => prev[id]?.chat.host.device_id === hostDeviceId)
  if (!ids.length) return prev
  const next = { ...prev }
  for (const id of ids) delete next[id]
  return next
}

export function applyHost(
  prev: LiveMap,
  hostDeviceId: string,
  status: 'online' | 'grace'
): LiveMap {
  let next: Record<string, LiveEntry> | null = null
  for (const [id, e] of Object.entries(prev)) {
    if (e.chat.host.device_id !== hostDeviceId || e.chat.host.status === status) continue
    next ??= { ...prev }
    next[id] = { ...e, chat: { ...e.chat, host: { ...e.chat.host, status } } }
  }
  return next ?? prev
}

export function dropStale(prev: LiveMap): LiveMap {
  if (!Object.values(prev).some((e) => e.stale)) return prev
  return Object.fromEntries(Object.entries(prev).filter(([, e]) => !e.stale))
}

/** Chave do cache de plaintext: muda a cada anúncio novo. */
export const infoKey = (c: LiveChatWire): string =>
  `${c.host.device_id}|${c.chat_id}|${c.epoch}|${c.arev}`

/**
 * Decifra o anúncio com a AAD montada com os campos DE FORA (§23.4). Falha de autenticação ou `chatId`
 * de dentro diferente → null (o item não aparece).
 */
export async function openLiveChat(
  streamKey: Uint8Array,
  userId: string,
  c: LiveChatWire
): Promise<LiveChatInfo | null> {
  try {
    const aad = aadLiveAnnounce(userId, c.host.device_id, c.chat_id, c.epoch, c.arev)
    const p = await unframeJson(await open(streamKey, aad, c.env))
    if (p.chatId !== c.chat_id) return null
    const persona = p.persona as Record<string, unknown> | null | undefined
    const model = p.model as Record<string, unknown> | null | undefined
    const status = p.status === 'running' || p.status === 'waiting' ? p.status : 'idle'
    return {
      chatId: c.chat_id,
      title: typeof p.title === 'string' && p.title.trim() ? p.title.slice(0, 120) : 'Sem título',
      status,
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
      personaName: persona && typeof persona.name === 'string' ? persona.name : null,
      model: model && typeof model.model === 'string' ? model.model : null
    }
  } catch {
    return null
  }
}

export type LiveStatusLabel = 'rodando' | 'aguardando você' | 'ocioso' | 'reconectando'

/** Status mostrado na lista (§23.10). */
export function liveStatus(e: LiveEntry, info: LiveChatInfo | null): LiveStatusLabel {
  if (e.stale || e.chat.host.status === 'grace') return 'reconectando'
  if (info?.status === 'waiting') return 'aguardando você'
  if (info?.status === 'running' || (!info && e.chat.running)) return 'rodando'
  return 'ocioso'
}
