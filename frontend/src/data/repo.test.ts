import { describe, expect, it } from 'vitest'
import { ApiClient } from '../api/client'
import { createKeyMaterial, deriveSubkeys, openRecord, sealRecord, ARGON2_DEFAULT } from '../crypto'
import { emptyDb, MockServer } from '../mock/server'
import { createMockFetch } from '../mock/transport'
import { listChats, loadChat } from './chats'
import { Repo } from './repo'
import type { ProviderPlain } from './schemas'

const ROOT = 'http://localhost'
const device = {
  name: 'T',
  platform: 'web',
  client: 'web' as const,
  app_version: '1',
  can_host: false
}

async function setup() {
  const server = new MockServer({ db: emptyDb() })
  const api = new ApiClient({ root: ROOT, fetch: createMockFetch(server, ROOT) })
  await api.signupStart({ email: 'r@e.com', name: 'R' })
  const auth = await api.signupVerify({ email: 'r@e.com', code: '123456', device })
  const { dek, body } = await createKeyMaterial(auth.user.id, 'senha longa de teste', {
    ...ARGON2_DEFAULT,
    m: 19456,
    t: 2
  })
  await api.setupKeys(body)
  const sk = await deriveSubkeys(dek)
  return { server, api, sk, repo: new Repo(api, auth.user.id, sk), userId: auth.user.id }
}

describe('Repo (envelopes de registro de ponta a ponta)', () => {
  it('cria, lê, edita com LWW por campo após conflito e apaga', async () => {
    const { server, repo, sk, userId } = await setup()
    const ref = { type: 'provider', id: 'p1', scope: null }
    const created = await repo.save<ProviderPlain>(ref, null, () => ({
      sv: 1,
      name: 'A',
      baseUrl: 'https://a',
      apiKey: 'k1',
      headers: {},
      createdAt: 1,
      extra: 'preservar'
    }))
    expect(created.change.rev).toBe(1)
    // o servidor só tem o envelope (sem plaintext)
    const stored = server.db.users[userId].records['provider|p1']
    expect(JSON.stringify(stored)).not.toContain('k1')
    expect(await openRecord(sk.record, userId, stored, stored.env!)).toMatchObject({ name: 'A' })

    // outro dispositivo muda baseUrl (rev 2)
    const plain2 = { ...created.plain, baseUrl: 'https://b' }
    const env = await sealRecord(sk.record, userId, { ...ref, rev: 2 }, plain2)
    server.remotePush(userId, [{ ...ref, base_rev: 1, rev: 2, deleted: false, env, blobs: [] }])

    // aqui, ainda com a rev 1, troca só o nome → conflito → reaplica só "name" sobre a rev 2
    const saved = await repo.save<ProviderPlain>(ref, created, (cur) => ({
      ...cur!,
      name: 'Novo nome'
    }))
    expect(saved.change.rev).toBe(3)
    const { entries } = await repo.listDecrypted<ProviderPlain>('provider')
    expect(entries[0].plain).toMatchObject({
      name: 'Novo nome',
      baseUrl: 'https://b',
      extra: 'preservar'
    })

    // apagar com rev velha: a exclusão vence
    await repo.remove(created.change)
    expect((await repo.listDecrypted('provider')).entries).toEqual([])
    // apagar de novo = sucesso (já apagado)
    await repo.remove(created.change)
  })

  it('registro com AAD errada vai para "broken" sem derrubar a lista', async () => {
    const { server, repo, sk, userId } = await setup()
    const env = await sealRecord(
      sk.record,
      userId,
      { type: 'provider', id: 'x', scope: null, rev: 9 },
      { sv: 1 }
    )
    server.remotePush(userId, [
      {
        type: 'provider',
        id: 'x',
        scope: null,
        base_rev: 0,
        rev: 1,
        deleted: false,
        env,
        blobs: []
      }
    ])
    const r = await repo.listDecrypted('provider')
    expect(r.entries).toHaveLength(0)
    expect(r.broken).toHaveLength(1)
  })

  it('conversas: tamanhos, contagem e conteúdo por sessão (payload omitido busca depois)', async () => {
    const { server, repo, sk, userId } = await setup()
    const seal = (type: string, id: string, scope: string | null, p: Record<string, unknown>) =>
      sealRecord(sk.record, userId, { type, id, scope, rev: 1 }, p).then((env) => ({
        type,
        id,
        scope,
        base_rev: 0,
        rev: 1,
        deleted: false,
        env,
        blobs: []
      }))
    server.remotePush(userId, [
      await seal('chat', 'c', 'c', {
        sv: 1,
        title: 'Olá',
        config: {},
        mainSessionId: 's',
        createdAt: 1,
        updatedAt: 5
      }),
      await seal('session', 's', 'c', {
        sv: 1,
        chatId: 'c',
        parentSessionId: null,
        depth: 0,
        createdAt: 1,
        title: 'P'
      }),
      await seal('message', 'm2', 'c', {
        sv: 1,
        sessionId: 's',
        seq: 2,
        message: { role: 'assistant', content: 'b' },
        meta: {},
        createdAt: 3
      }),
      await seal('message', 'm1', 'c', {
        sv: 1,
        sessionId: 's',
        seq: 1,
        message: { role: 'user', content: 'a' },
        meta: {},
        createdAt: 2
      })
    ])
    const { chats } = await listChats(repo)
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ title: 'Olá', messages: 2, updatedAt: 5 })
    const recs = Object.values(server.db.users[userId].records)
    expect(chats[0].size).toBe(recs.reduce((n, r) => n + r.size, 0))
    const view = await loadChat(repo, 'c')
    expect(view!.main!.messages.map((m) => m.plain.seq)).toEqual([1, 2])
    expect(await loadChat(repo, 'nao-existe')).toBeNull()
  })
})
