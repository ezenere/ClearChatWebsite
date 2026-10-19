import { describe, expect, it } from 'vitest'
import { ApiClient, ApiError } from '../api/client'
import type { Change, PushRequest } from '../api/types'
import { createKeyMaterial, deriveSubkeys, openRecord, sealRecord, ARGON2_DEFAULT } from '../crypto'
import { emptyDb, MockServer } from '../mock/server'
import { createMockFetch } from '../mock/transport'
import { activePath, buildTree, siblingInfo, type BranchSel } from './branches'
import { listChats, loadChat, messageNode } from './chats'
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

describe('loadChat: versões das mensagens (§4.3.7/§4.3.8)', () => {
  it('devolve todas as versões + branchSel; o caminho ativo segue a seleção do app', async () => {
    const { server, repo, sk, userId } = await setup()
    const seal = (type: string, id: string, p: Record<string, unknown>) =>
      sealRecord(sk.record, userId, { type, id, scope: 'c', rev: 1 }, p).then((env) => ({
        type,
        id,
        scope: 'c',
        base_rev: 0,
        rev: 1,
        deleted: false,
        env,
        blobs: []
      }))
    const msg = (id: string, sessionId: string, seq: number, extra: Record<string, unknown> = {}) =>
      seal('message', id, {
        sv: 1,
        sessionId,
        seq,
        message: { role: seq % 2 ? 'user' : 'assistant', content: id },
        meta: {},
        createdAt: seq,
        ...extra
      })
    const session = (id: string, extra: Record<string, unknown>) =>
      seal('session', id, {
        sv: 1,
        chatId: 'c',
        parentSessionId: null,
        depth: 0,
        createdAt: 1,
        title: id,
        ...extra
      })
    server.remotePush(userId, [
      await seal('chat', 'c', {
        sv: 1,
        title: 'Versões',
        config: {},
        mainSessionId: 's',
        createdAt: 1,
        updatedAt: 9
      }),
      // seleção do app: a 1ª versão da pergunta editada; valores inválidos são descartados
      await session('s', { branchSel: { a1: 'u2', lixo: 42 } }),
      // subagente gravado por um cliente < 1.2.0 (sem branchSel nem parentId)
      await session('sub', { parentSessionId: 's', depth: 1, createdAt: 2 }),
      await msg('u1', 's', 1), // legado: mãe derivada (raiz)
      await msg('a1', 's', 2), // legado: mãe derivada (u1)
      await msg('u2', 's', 3, { parentId: 'a1' }),
      await msg('a2', 's', 4, { parentId: 'u2' }),
      await msg('u2b', 's', 5, { parentId: 'a1' }),
      await msg('a2b', 's', 6, { parentId: 'u2b' }),
      // mãe de outra sessão não vale: derivada como a anterior por seq DESTA sessão
      await msg('x1', 'sub', 1),
      await msg('x2', 'sub', 2, { parentId: 'u1' })
    ])
    const view = await loadChat(repo, 'c')
    const main = view!.main!
    expect(main.messages.map((m) => m.change.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u2b', 'a2b'])
    expect(main.branchSel).toEqual({ a1: 'u2' })
    const tree = buildTree(main.messages, messageNode)
    const ids = (sel: BranchSel) => activePath(tree, sel).map((m) => m.change.id)
    expect(ids(main.branchSel)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(ids({})).toEqual(['u1', 'a1', 'u2b', 'a2b'])
    expect(siblingInfo(tree, 'u2')).toMatchObject({ index: 0, count: 2, nextId: 'u2b' })

    const sub = view!.subagents[0]
    expect(sub.branchSel).toEqual({})
    const subTree = buildTree(sub.messages, messageNode)
    expect(subTree.parentOf.get('x2')).toBe('x1')
    expect(activePath(subTree, sub.branchSel).map((m) => m.change.id)).toEqual(['x1', 'x2'])
    expect(view!.broken).toBe(0)
  })
})

describe('Repo: registro autêntico fora do contexto pedido (servidor não confiável)', () => {
  const USER = '6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b'

  /** Registro selado de verdade (AAD = os próprios rótulos), como o servidor o guardaria. */
  async function sealed(
    sk: Awaited<ReturnType<typeof deriveSubkeys>>,
    type: string,
    id: string,
    scope: string | null,
    plain: Record<string, unknown>,
    rev = 1
  ): Promise<Change> {
    const env = await sealRecord(sk.record, USER, { type, id, scope, rev }, plain)
    return {
      seq: rev,
      type,
      id,
      scope,
      rev,
      deleted: false,
      env,
      size: 1,
      blobs: [],
      device_id: 'd',
      updated_at: new Date(0).toISOString()
    }
  }

  /** Servidor stub: devolve o que o teste mandar, ignorando o tipo/escopo/id pedidos. */
  function stubRepo(
    sk: Awaited<ReturnType<typeof deriveSubkeys>>,
    h: {
      list?: (q: { type?: string; scope?: string }) => Change[]
      fetch?: (items: { type: string; id: string }[]) => Change[]
      push?: (body: PushRequest) => never
    }
  ) {
    const api = {
      records: async (q: { type?: string; scope?: string }) => ({
        records: h.list?.(q) ?? [],
        next: 0,
        has_more: false
      }),
      fetchRecords: async (items: { type: string; id: string }[]) => ({
        records: h.fetch?.(items) ?? []
      }),
      push: async (body: PushRequest) => h.push!(body)
    } as unknown as ApiClient
    return new Repo(api, USER, sk)
  }

  const subkeys = () => deriveSubkeys(new Uint8Array(32).fill(7))
  const chatPlain = (title: string, mainSessionId: string) => ({
    sv: 1,
    title,
    config: {},
    mainSessionId,
    createdAt: 1,
    updatedAt: 1
  })

  it('listDecrypted: sessão/mensagem de outro chat ou de outro tipo vai para "broken"', async () => {
    const sk = await subkeys()
    const sB = await sealed(sk, 'session', 'sB', 'chatB', { sv: 1, chatId: 'chatB', createdAt: 1 })
    const mB = await sealed(sk, 'message', 'mB', 'chatB', {
      sv: 1,
      sessionId: 'sB',
      seq: 1,
      message: { role: 'user', content: 'ONLY-IN-CHAT-B' },
      meta: {},
      createdAt: 1
    })
    const repo = stubRepo(sk, { list: () => [sB, mB] })
    // a AAD confere (rótulos verdadeiros), mas não é o que foi pedido
    expect(await openRecord(sk.record, USER, mB, mB.env!)).toBeTruthy()
    const msgs = await repo.listDecrypted('message', 'chatA')
    expect(msgs.entries).toEqual([])
    expect(msgs.broken.map((b) => b.change.id).sort()).toEqual(['mB', 'sB'])
    expect(msgs.broken[0].error).toMatch(/fora do contexto/)
    // sem escopo: o tipo ainda é conferido
    const sessions = await repo.listDecrypted('session')
    expect(sessions.entries.map((e) => e.change.id)).toEqual(['sB'])
    expect(sessions.broken.map((b) => b.change.id)).toEqual(['mB'])
  })

  it('fillOmitted: payload buscado de outro escopo não substitui o listado', async () => {
    const sk = await subkeys()
    const real = await sealed(sk, 'message', 'm1', 'chatA', { sv: 1, sessionId: 's', seq: 1 })
    const other = await sealed(sk, 'message', 'm1', 'chatB', { sv: 1, sessionId: 's', seq: 9 })
    const listed: Change = { ...real, env: undefined, omitted: true }
    const repo = stubRepo(sk, { list: () => [listed], fetch: () => [other] })
    const filled = await repo.fillOmitted([listed])
    expect(filled[0]).toBe(listed)
    const r = await repo.listDecrypted('message', 'chatA')
    expect(r.entries).toEqual([])
    expect(r.broken).toHaveLength(1)
    // controle: o mesmo registro (mesmo escopo) substitui normalmente
    const ok = stubRepo(sk, { list: () => [listed], fetch: () => [real] })
    expect((await ok.listDecrypted('message', 'chatA')).entries).toHaveLength(1)
  })

  it('fillOmitted: pede de novo o que o /records/fetch devolveu omitido (orçamento de 8 MiB)', async () => {
    const sk = await subkeys()
    const full = await Promise.all(
      ['m1', 'm2', 'm3'].map((id, i) =>
        sealed(sk, 'message', id, 'chatA', { sv: 1, sessionId: 's', seq: i })
      )
    )
    const listed = full.map((c): Change => ({ ...c, env: undefined, omitted: true }))
    const calls: string[][] = []
    const repo = stubRepo(sk, {
      list: () => listed,
      // como o servidor: o primeiro pedido sempre vem com payload, os que não couberem voltam omitidos
      fetch: (items) => {
        calls.push(items.map((it) => it.id))
        return items.map((it, i) => {
          const c = full.find((f) => f.id === it.id)!
          return i === 0 ? c : { ...c, env: undefined, omitted: true as const }
        })
      }
    })
    const filled = await repo.fillOmitted(listed)
    expect(filled.map((c) => !!c.env && !c.omitted)).toEqual([true, true, true])
    expect(calls).toEqual([['m1', 'm2', 'm3'], ['m2', 'm3'], ['m3']])
    const r = await repo.listDecrypted('message', 'chatA')
    expect(r.entries.map((e) => e.change.id).sort()).toEqual(['m1', 'm2', 'm3'])
    expect(r.broken).toEqual([])
  })

  it('fillOmitted: servidor que nunca manda o payload não prende o laço', async () => {
    const sk = await subkeys()
    const real = await sealed(sk, 'message', 'm1', 'chatA', { sv: 1, sessionId: 's', seq: 1 })
    const listed: Change = { ...real, env: undefined, omitted: true }
    let n = 0
    const repo = stubRepo(sk, {
      list: () => [listed],
      fetch: () => {
        n++
        return [listed]
      }
    })
    expect((await repo.fillOmitted([listed]))[0]).toBe(listed)
    expect(n).toBe(1)
    expect((await repo.listDecrypted('message', 'chatA')).broken).toHaveLength(1)
  })

  it('loadChat: chat de outro id é ignorado; sessões/mensagens de outro chat não aparecem', async () => {
    const sk = await subkeys()
    const chatA = await sealed(sk, 'chat', 'chatA', 'chatA', chatPlain('Chat A', 'sA'))
    const chatB = await sealed(sk, 'chat', 'chatB', 'chatB', chatPlain('Chat B', 'sB'))
    const sB = await sealed(sk, 'session', 'sB', 'chatB', {
      sv: 1,
      chatId: 'chatB',
      parentSessionId: null,
      depth: 0,
      createdAt: 1
    })
    const mB = await sealed(sk, 'message', 'mB', 'chatB', {
      sv: 1,
      sessionId: 'sB',
      seq: 1,
      message: { role: 'user', content: 'ONLY-IN-CHAT-B' },
      meta: {},
      createdAt: 1
    })
    const list = (q: { type?: string }) => (q.type === 'session' ? [sB] : [mB])

    // o servidor responde ao fetch de chatA com o registro (autêntico) de chatB
    const swapped = stubRepo(sk, { list, fetch: () => [chatB] })
    expect(await loadChat(swapped, 'chatA')).toBeNull()

    // o chat certo, mas sessões/mensagens de chatB
    const relocated = stubRepo(sk, { list, fetch: () => [chatA] })
    const view = await loadChat(relocated, 'chatA')
    expect(view!.chat.plain.title).toBe('Chat A')
    expect(view!.main).toBeNull()
    expect(view!.subagents).toEqual([])
    expect(view!.broken).toBe(2)
    expect(JSON.stringify(view)).not.toContain('ONLY-IN-CHAT-B')
  })

  it('save: conflito cujo "current" é outro registro → relança, sem re-selar o plaintext alheio', async () => {
    const sk = await subkeys()
    const chatB = await sealed(
      sk,
      'chat',
      'chatB',
      'chatB',
      {
        ...chatPlain('Chat B', 'sB'),
        secretField: 'B-ONLY'
      },
      2
    )
    const pushes: PushRequest[] = []
    const repo = stubRepo(sk, {
      push: (body) => {
        pushes.push(body)
        throw new ApiError(409, 'conflict', '', {
          conflicts: [{ type: 'chat', id: 'chatA', reason: 'rev_mismatch', current: chatB }]
        })
      }
    })
    const seen: unknown[] = []
    const err = await repo
      .save({ type: 'chat', id: 'chatA', scope: 'chatA' }, null, (cur) => {
        seen.push(cur)
        return { ...(cur ?? chatPlain('Chat A', 'sA')), title: 'Editado' }
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('conflict')
    expect(seen).toEqual([null])
    expect(pushes).toHaveLength(1)
  })
})
