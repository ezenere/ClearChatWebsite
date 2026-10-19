// Site × backend REAL (sem mock): cadastro, chaves, login em outro navegador, desbloqueio, WebSocket
// chegando a "Ao vivo", registro criado pelo site aparecendo no feed de mudanças (REST) e a notificação
// ao vivo (`sync.changes`) atualizando a lista na outra aba sem recarregar.
//
// Rodar (ver frontend/README / ARCHITECTURE.md §10):
//   CLEARCHAT_IT_BACKEND_URL=http://127.0.0.1:8100 CLEARCHAT_IT_MAIL_LOG=/caminho/api.log \
//     npm run test:e2e:integration
// O backend precisa de MAIL_BACKEND=console (o código de e-mail é lido do log), cadastro aberto e sem
// Turnstile. Sem CLEARCHAT_IT_BACKEND_URL tudo é pulado.
import { readFileSync, statSync } from 'node:fs'
import { expect, test, type Browser, type Page, type WebSocket } from '@playwright/test'

const BACKEND = process.env.CLEARCHAT_IT_BACKEND_URL
const MAIL_LOG = process.env.CLEARCHAT_IT_MAIL_LOG

test.skip(!BACKEND, 'CLEARCHAT_IT_BACKEND_URL não definido: testes de integração pulados')
test.describe.configure({ mode: 'serial' })

const stamp = Date.now()
const EMAIL = `it-${stamp}@exemplo.com`
const PASSWORD = 'cavalo correto bateria grampo'
const PROVIDER = `Provedor IT ${stamp}`

function logSize(): number {
  if (!MAIL_LOG)
    throw new Error('CLEARCHAT_IT_MAIL_LOG não definido (log da api com MAIL_BACKEND=console)')
  return statSync(MAIL_LOG).size
}

/** Espera o próximo código de e-mail para `email` escrito no log depois de `offset`. */
async function codeFor(email: string, offset: number): Promise<string> {
  let found: string | null = null
  await expect
    .poll(
      () => {
        const txt = readFileSync(MAIL_LOG!, 'utf8').slice(offset)
        const re = new RegExp(`para ${email.replace(/[.+]/g, '\\$&')} [^\\n]*?(\\d{6})`, 'g')
        const all = [...txt.matchAll(re)]
        found = all.length ? all[all.length - 1][1] : null
        return found
      },
      { message: `código de e-mail para ${email} no log`, timeout: 15_000 }
    )
    .not.toBeNull()
  return found!
}

/** Guarda os frames JSON do WebSocket de sync (`/ws`) da página. */
function watchSync(page: Page): { frames: Record<string, unknown>[]; sockets: WebSocket[] } {
  const out = { frames: [] as Record<string, unknown>[], sockets: [] as WebSocket[] }
  page.on('websocket', (ws) => {
    if (!new URL(ws.url()).pathname.endsWith('/ws')) return // ignora o HMR do Vite
    out.sockets.push(ws)
    ws.on('framereceived', (f) => {
      try {
        out.frames.push(JSON.parse(String(f.payload)))
      } catch {
        /* não-JSON */
      }
    })
  })
  return out
}

async function expectLive(page: Page): Promise<void> {
  await expect(page.getByTestId('live-status').first()).toHaveAttribute('data-status', 'online', {
    timeout: 20_000
  })
  await expect(page.getByTestId('live-status').first()).toHaveText('Ao vivo')
}

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext()
  return ctx.newPage()
}

let pageA: Page
let pageB: Page
let syncA: ReturnType<typeof watchSync>
let syncB: ReturnType<typeof watchSync>

test.afterAll(async () => {
  await pageA?.context().close()
  await pageB?.context().close()
})

test('cadastro no site: código do e-mail, senha, chave de recuperação, painel ao vivo', async ({
  browser
}) => {
  pageA = await newPage(browser)
  syncA = watchSync(pageA)
  const offset = logSize()
  await pageA.goto('/signup')
  await pageA.getByLabel('Nome').fill('Integração')
  await pageA.getByLabel('E-mail').fill(EMAIL)
  await pageA.getByRole('button', { name: 'Continuar' }).click()
  await expect(pageA.getByRole('heading', { name: 'Confirme seu e-mail' })).toBeVisible()
  await pageA.getByLabel('Código de 6 dígitos').fill(await codeFor(EMAIL, offset))

  await expect(pageA.getByRole('heading', { name: /senha de criptografia/ })).toBeVisible()
  await pageA.getByLabel('Senha de criptografia', { exact: true }).fill(PASSWORD)
  await pageA.getByLabel('Confirme a senha').fill(PASSWORD)
  await pageA.getByRole('button', { name: 'Gerar chaves' }).click()
  await expect(pageA.getByRole('heading', { name: 'Guarde sua chave de recuperação' })).toBeVisible(
    { timeout: 30_000 }
  )
  const key = (
    await pageA.getByTestId('recovery-key').locator('span.select-all').allTextContents()
  ).join('-')
  await pageA.getByLabel('Guardei minha chave de recuperação em um lugar seguro.').check()
  await pageA.getByLabel(/4 últimos caracteres/).fill(key.slice(-4))
  await pageA.getByRole('button', { name: 'Guardei — concluir' }).click()
  await expect(pageA.getByRole('heading', { name: 'Tudo pronto' })).toBeVisible()
  await pageA.getByRole('button', { name: 'Ir para o painel' }).click()
  await expect(pageA.getByRole('heading', { name: 'Conversas' })).toBeVisible()

  // WebSocket: hello → welcome do servidor real → "Ao vivo"
  await expectLive(pageA)
  expect(syncA.sockets.length).toBeGreaterThanOrEqual(1)
  expect(syncA.frames.some((f) => f.t === 'welcome')).toBe(true)
})

test('login por código em outro navegador, desbloqueio com a senha, painel ao vivo', async ({
  browser
}) => {
  pageB = await newPage(browser)
  syncB = watchSync(pageB)
  const offset = logSize()
  await pageB.goto('/login')
  await pageB.getByLabel('E-mail').fill(EMAIL)
  await pageB.getByRole('button', { name: 'Enviar código' }).click()
  await expect(pageB.getByRole('heading', { name: 'Digite o código' })).toBeVisible()
  await pageB.getByLabel('Código de 6 dígitos').fill(await codeFor(EMAIL, offset))
  await expect(pageB.getByRole('heading', { name: 'Desbloquear seus dados' })).toBeVisible()
  await pageB.getByLabel('Senha de criptografia').fill(PASSWORD)
  await pageB.getByRole('button', { name: 'Desbloquear' }).click()
  await expect(pageB.getByRole('heading', { name: 'Conversas' })).toBeVisible({ timeout: 30_000 })
  await expectLive(pageB)
})

test('registro criado no site: aparece no feed de mudanças e a outra aba atualiza ao vivo', async ({
  request
}) => {
  // B abre a lista de provedores (vazia) e fica parado nela
  await pageB.getByRole('link', { name: 'Provedores' }).first().click()
  await expect(pageB.getByText('Nenhum provedor')).toBeVisible()
  const framesBefore = syncB.frames.length

  // A cria um provedor
  await pageA.getByRole('link', { name: 'Provedores' }).first().click()
  await pageA.getByRole('button', { name: 'Adicionar' }).first().click()
  const form = pageA.locator('#provider-form')
  await form.getByLabel('Nome', { exact: true }).fill(PROVIDER)
  await form.getByLabel('Chave de API').fill('sk-integracao-segredo')
  await form.getByRole('button', { name: 'Salvar' }).click()
  await expect(pageA.getByText('Provedor adicionado.')).toBeVisible()
  await expect(pageA.getByRole('heading', { name: PROVIDER })).toBeVisible()

  // feed de mudanças (REST, como um app): login por código de um "dispositivo" de teste
  const offset = logSize()
  const device = {
    name: 'e2e-integration',
    platform: 'linux',
    client: 'desktop',
    app_version: '0.0.0',
    can_host: false
  }
  const hdr = { 'X-ClearChat-Client': 'e2e-integration/0', 'X-ClearChat-Protocol': '1' }
  const req = await request.post(`${BACKEND}/api/v1/auth/code/request`, {
    headers: hdr,
    data: { email: EMAIL }
  })
  expect(req.status()).toBe(202)
  const verify = await request.post(`${BACKEND}/api/v1/auth/code/verify`, {
    headers: hdr,
    data: { email: EMAIL, code: await codeFor(EMAIL, offset), device }
  })
  expect(verify.status()).toBe(200)
  const { access_token } = (await verify.json()) as { access_token: string }
  const feed = await request.get(`${BACKEND}/api/v1/sync/changes?since=0&payload=1`, {
    headers: { ...hdr, Authorization: `Bearer ${access_token}` }
  })
  expect(feed.status()).toBe(200)
  const body = (await feed.json()) as {
    changes: { type: string; id: string; deleted?: boolean; env?: unknown }[]
  }
  const providers = body.changes.filter((c) => c.type === 'provider' && !c.deleted)
  expect(providers).toHaveLength(1)
  expect(providers[0].env).toBeTruthy()
  // zero-knowledge: o servidor só tem o envelope cifrado
  const raw = JSON.stringify(body)
  expect(raw).not.toContain(PROVIDER)
  expect(raw).not.toContain('sk-integracao-segredo')

  // B: a notificação `sync.changes` chegou pelo WebSocket e a lista recarregou sozinha (sem reload)
  await expect(pageB.getByRole('heading', { name: PROVIDER })).toBeVisible()
  const live = syncB.frames.slice(framesBefore).filter((f) => f.t === 'sync.changes') as {
    changes: { type: string; id: string }[]
  }[]
  expect(live.some((f) => f.changes.some((c) => c.id === providers[0].id))).toBe(true)
  expect(syncB.sockets.length).toBe(1) // a mesma conexão, sem recarregar a página
})

test('queda da conexão: o site mostra "Reconectando" e volta sozinho para "Ao vivo"', async () => {
  // derruba o socket por fora (como uma queda de rede/proxy) e confere o backoff + nova conexão
  const before = syncB.sockets.length
  await pageB.context().setOffline(true)
  await pageB.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(pageB.getByTestId('live-status').first()).toHaveAttribute(
    'data-status',
    /offline|connecting/,
    { timeout: 45_000 }
  )
  await expect(pageB.getByTestId('live-status').first()).toHaveText(/Reconectando|Conectando/)
  await pageB.context().setOffline(false)
  await expectLive(pageB)
  expect(syncB.sockets.length).toBeGreaterThan(before)
})
