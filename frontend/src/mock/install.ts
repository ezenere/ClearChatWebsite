// Liga o servidor simulado no navegador (`VITE_MOCK_API=1`). Estado persistido em localStorage para
// sobreviver a recarregamentos (simula o servidor + o cookie HttpOnly). Configuração da instância:
//   ?mock_landing=0|1  ?mock_signup=0|1  ?mock_captcha=0|1  ?mock_name=...  ?mock_reset=1
import type { FetchFn } from '../api/client'
import type { SocketFactory } from '../api/ws'
import { DEMO, remoteNewChat, seedDemo } from './seed'
import { emptyDb, type MockConfig, type MockDb, MockServer } from './server'
import { createMockFetch, MockSocket } from './transport'

const DB_KEY = 'clearchat-mock-db'

declare global {
  interface Window {
    __mock?: {
      server: MockServer
      demo: typeof DEMO
      setConfig: (c: Partial<MockConfig>) => void
      expireAccess: () => void
      remoteDeleteChat: (chatId?: string) => void
      remoteNewChat: (title?: string) => Promise<void>
      addInvite: (email?: string) => string
      reset: () => void
    }
  }
}

function load(): MockDb | null {
  try {
    const raw = localStorage.getItem(DB_KEY)
    const db = raw ? (JSON.parse(raw) as MockDb) : null
    return db?.version === 1 ? db : null
  } catch {
    return null
  }
}

export async function installMock(
  root: string
): Promise<{ fetch: FetchFn; socketFactory: SocketFactory }> {
  const q = new URLSearchParams(location.search)
  if (q.get('mock_reset') === '1') localStorage.removeItem(DB_KEY)
  const server = new MockServer({
    db: load() ?? emptyDb(),
    persist: (db) => {
      try {
        localStorage.setItem(DB_KEY, JSON.stringify(db))
      } catch {
        /* cota cheia: segue só em memória */
      }
    },
    latency: navigator.webdriver ? [0, 30] : [80, 220]
  })
  const flag = (k: string) => (q.has(k) ? q.get(k) === '1' : undefined)
  const patch: Partial<MockConfig> = {}
  if (flag('mock_landing') !== undefined) patch.landing = flag('mock_landing')
  if (flag('mock_signup') !== undefined) patch.signupOpen = flag('mock_signup')
  if (flag('mock_captcha') !== undefined) patch.captcha = flag('mock_captcha')
  if (q.get('mock_name')) patch.name = q.get('mock_name')!
  if (Object.keys(patch).length) server.setConfig(patch)
  if (!server.db.demo && !Object.values(server.db.users).some((u) => u.email === DEMO.email)) {
    await seedDemo(server)
    server.save()
  }
  window.__mock = {
    server,
    demo: DEMO,
    setConfig: (c) => server.setConfig(c),
    expireAccess: () => server.expireAccessTokens(),
    remoteDeleteChat: (chatId) => {
      const demo = server.db.demo
      if (!demo) return
      const u = server.db.users[demo.user_id]
      const id = chatId ?? Object.values(u.records).find((r) => r.type === 'chat' && !r.deleted)?.id
      if (id) server.remoteDeleteChat(demo.user_id, id)
    },
    remoteNewChat: (title) => remoteNewChat(server, title),
    addInvite: (email) => server.addInvite(email),
    reset: () => {
      localStorage.removeItem(DB_KEY)
      location.reload()
    }
  }
  console.info(
    `[mock] API simulada ativa. Conta de demonstração: ${DEMO.email} · código ${server.db.config.code} · senha "${DEMO.password}"`
  )
  return { fetch: createMockFetch(server, root), socketFactory: () => new MockSocket(server) }
}
