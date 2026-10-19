// Conversas: lista (título, atualização, tamanho) e conteúdo (sessões + mensagens) de um chat.
import { matchesContext, type Repo, type Entry, type BrokenEntry } from './repo'
import type { ChatPlain, MessagePlain, SessionPlain } from './schemas'

export interface ChatSummary {
  entry: Entry<ChatPlain>
  id: string
  title: string
  updatedAt: number
  /** Bytes cifrados do chat + sessões + mensagens. */
  size: number
  messages: number
}

export async function listChats(
  repo: Repo
): Promise<{ chats: ChatSummary[]; broken: BrokenEntry[] }> {
  const [{ entries, broken }, sessions, messages] = await Promise.all([
    repo.listDecrypted<ChatPlain>('chat'),
    repo.listAll({ type: 'session', payload: false }),
    repo.listAll({ type: 'message', payload: false })
  ])
  const size = new Map<string, number>()
  const count = new Map<string, number>()
  for (const c of [...sessions, ...messages]) {
    if (!c.scope) continue
    size.set(c.scope, (size.get(c.scope) ?? 0) + c.size)
    if (c.type === 'message') count.set(c.scope, (count.get(c.scope) ?? 0) + 1)
  }
  const chats = entries.map((entry) => ({
    entry,
    id: entry.change.id,
    title: (entry.plain.title || '').trim() || 'Sem título',
    updatedAt:
      typeof entry.plain.updatedAt === 'number'
        ? entry.plain.updatedAt
        : Date.parse(entry.change.updated_at),
    size: entry.change.size + (size.get(entry.change.id) ?? 0),
    messages: count.get(entry.change.id) ?? 0
  }))
  chats.sort((a, b) => b.updatedAt - a.updatedAt)
  return { chats, broken }
}

export interface SessionView {
  entry: Entry<SessionPlain>
  messages: Entry<MessagePlain>[]
}

export interface ChatView {
  chat: Entry<ChatPlain>
  main: SessionView | null
  subagents: SessionView[]
  broken: number
}

export async function loadChat(repo: Repo, chatId: string): Promise<ChatView | null> {
  // o registro do chat tem escopo = o próprio id (§4.2); outro chat devolvido pelo servidor é ignorado
  const chatCtx = { type: 'chat', id: chatId, scope: chatId }
  const [chats, sessions, messages] = await Promise.all([
    repo.fillOmitted(
      (await repo.api.fetchRecords([{ type: 'chat', id: chatId }])).records.filter(
        (c) => !c.deleted && matchesContext(c, chatCtx)
      )
    ),
    repo.listDecrypted<SessionPlain>('session', chatId),
    repo.listDecrypted<MessagePlain>('message', chatId)
  ])
  if (!chats.length) return null
  const chat = { change: chats[0], plain: await repo.decrypt<ChatPlain>(chats[0], chatCtx) }
  const bySession = new Map<string, Entry<MessagePlain>[]>()
  for (const m of messages.entries) {
    const list = bySession.get(m.plain.sessionId) ?? []
    list.push(m)
    bySession.set(m.plain.sessionId, list)
  }
  for (const list of bySession.values()) list.sort((a, b) => a.plain.seq - b.plain.seq)
  const views = sessions.entries
    .map((entry) => ({ entry, messages: bySession.get(entry.change.id) ?? [] }))
    .sort((a, b) => a.entry.plain.createdAt - b.entry.plain.createdAt)
  const main =
    views.find((v) => v.entry.change.id === chat.plain.mainSessionId) ??
    views.find((v) => !v.entry.plain.parentSessionId) ??
    null
  return {
    chat,
    main,
    subagents: views.filter((v) => v !== main),
    broken: sessions.broken.length + messages.broken.length
  }
}
