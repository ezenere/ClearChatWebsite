import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, type FetchFn } from './client'
import { emptyDb, MockServer } from '../mock/server'
import { createMockFetch } from '../mock/transport'

const ROOT = 'https://exemplo.com/clearchat'
const device = {
  name: 'Teste',
  platform: 'web',
  client: 'web' as const,
  app_version: '0.1.0',
  can_host: false
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

describe('ApiClient (fetch falso)', () => {
  it('monta URL com o caminho de base, cabeçalhos do protocolo e Bearer', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const f: FetchFn = async (url, init = {}) => {
      calls.push({ url, init })
      return json(200, { ok: true })
    }
    const c = new ApiClient({ root: ROOT + '/', fetch: f, clientHeader: 'web/9.9.9' })
    c.setToken('cca_abc')
    await c.records({ type: 'provider', after: 10, payload: false })
    const { url, init } = calls[0]
    expect(url).toBe(`${ROOT}/api/v1/records?type=provider&after=10&payload=0`)
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe('Bearer cca_abc')
    expect(h['X-ClearChat-Protocol']).toBe('1')
    expect(h['X-ClearChat-Client']).toBe('web/9.9.9')
    expect(init.credentials).toBe('same-origin')
    await c.info()
    expect(calls[1].url).toBe(`${ROOT}/api/info`)
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('erro do contrato vira ApiError com code/message/details e Retry-After', async () => {
    const f: FetchFn = async () =>
      json(
        429,
        { error: { code: 'rate_limited', message: 'Calma.', details: {} } },
        { 'Retry-After': '120' }
      )
    const c = new ApiClient({ root: ROOT, fetch: f })
    const err = await c.codeRequest({ email: 'a@b.c' }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(429)
    expect(err.code).toBe('rate_limited')
    expect(err.message).toBe('Calma.')
    expect(err.retryAfter).toBe(120)
  })

  it('falha de rede vira code "network"', async () => {
    const c = new ApiClient({ root: ROOT, fetch: async () => Promise.reject(new TypeError('x')) })
    await expect(c.info()).rejects.toMatchObject({ code: 'network', status: 0 })
  })

  it('401 → um único refresh em voo (cookie) e repete as requisições', async () => {
    let refreshes = 0
    const f: FetchFn = async (url, init = {}) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++
        await new Promise((r) => setTimeout(r, 10))
        return json(200, {
          access_token: 'cca_new',
          access_expires_in: 3600,
          refresh_expires_in: 1
        })
      }
      const auth = (init.headers as Record<string, string>).Authorization
      if (auth !== 'Bearer cca_new')
        return json(401, {
          error: { code: 'unauthorized', message: '', details: { reason: 'expired' } }
        })
      return json(200, [])
    }
    const c = new ApiClient({ root: ROOT, fetch: f })
    c.setToken('cca_old')
    await Promise.all([c.devices(), c.devices(), c.devices()])
    expect(refreshes).toBe(1)
    expect(c.token).toBe('cca_new')
  })

  it('refresh recusado → sessão perdida; dispositivo revogado também', async () => {
    const lost = vi.fn()
    const f: FetchFn = async (url) =>
      url.endsWith('/auth/refresh')
        ? json(401, { error: { code: 'refresh_reused', message: '' } })
        : json(401, { error: { code: 'unauthorized', message: '' } })
    const c = new ApiClient({ root: ROOT, fetch: f })
    c.onSessionLost = lost
    c.setToken('cca_x')
    await expect(c.account()).rejects.toMatchObject({ code: 'refresh_reused' })
    expect(lost).toHaveBeenCalledWith('refresh_reused')
    expect(c.token).toBeNull()

    const c2 = new ApiClient({
      root: ROOT,
      fetch: async () => json(403, { error: { code: 'device_revoked', message: '' } })
    })
    c2.onSessionLost = lost
    await expect(c2.account()).rejects.toMatchObject({ code: 'device_revoked' })
    expect(lost).toHaveBeenLastCalledWith('device_revoked')
  })
})

describe('ApiClient × servidor simulado (contrato de ponta a ponta)', () => {
  it('cadastro, sessão por cookie, chaves, push, conflito e cascata', async () => {
    const server = new MockServer({ db: emptyDb({ code: '654321' }) })
    const c = new ApiClient({ root: ROOT, fetch: createMockFetch(server, ROOT) })
    expect((await c.info()).features.captcha).toBeNull()
    await c.signupStart({ email: ' Novo@Exemplo.com ', name: 'Novo' })
    await expect(
      c.signupVerify({ email: 'novo@exemplo.com', code: '000000', device })
    ).rejects.toMatchObject({
      code: 'code_invalid'
    })
    await c.signupStart({ email: 'novo@exemplo.com', name: 'Novo' })
    const r = await c.signupVerify({ email: 'novo@exemplo.com', code: '654321', device })
    expect(r.keys_ready).toBe(false)
    expect(r.refresh_token).toBeUndefined() // web: refresh só no cookie
    await expect(c.keys()).rejects.toMatchObject({ code: 'keys_not_ready', status: 409 })

    // access expirado → refresh pelo "cookie"
    server.expireAccessTokens()
    expect((await c.account()).email).toBe('novo@exemplo.com')

    const env = { v: 1, k: 1, n: 'AAAAAAAAAAAAAAAA', c: 'A'.repeat(24) }
    const push = (items: object[]) =>
      c.push({ push_id: crypto.randomUUID(), items: items as never })
    const res = await push([
      { type: 'chat', id: 'c1', scope: 'c1', base_rev: 0, rev: 1, deleted: false, env, blobs: [] },
      {
        type: 'message',
        id: 'm1',
        scope: 'c1',
        base_rev: 0,
        rev: 1,
        deleted: false,
        env,
        blobs: []
      }
    ])
    expect(res.results.map((x) => x.seq)).toEqual([1, 2])
    const conflict = await push([
      { type: 'chat', id: 'c1', scope: 'c1', base_rev: 0, rev: 1, deleted: false, env, blobs: [] }
    ]).catch((e) => e)
    expect(conflict.code).toBe('conflict')
    expect(conflict.details.conflicts[0]).toMatchObject({
      reason: 'rev_mismatch',
      current: { rev: 1 }
    })
    await push([
      { type: 'chat', id: 'c1', scope: 'c1', base_rev: 1, rev: 2, deleted: true, blobs: [] }
    ])
    const page = await c.records({ scope: 'c1' })
    expect(page.records).toEqual([])
    const fetched = await c.fetchRecords([{ type: 'chat', id: 'c1' }])
    expect(fetched.records[0]).toMatchObject({ deleted: true, rev: 2 })

    await c.logout()
    expect(c.token).toBeNull()
    await expect(c.refresh()).rejects.toMatchObject({ code: 'unauthorized' })
  })
})
