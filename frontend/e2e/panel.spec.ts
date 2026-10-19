import { expect, test } from '@playwright/test'
import { loginDemo, unlock } from './helpers'

test.beforeEach(async ({ page }) => {
  await loginDemo(page)
})

test('ver conversa decifrada (markdown, raciocínio, ferramentas, subagente) e apagar', async ({
  page
}) => {
  await page.getByRole('link', { name: /Refatorar o parser de SSE/ }).click()
  await expect(page.getByRole('heading', { name: 'Refatorar o parser de SSE' })).toBeVisible()
  await expect(page.locator('.md pre code').first()).toContainText('export function* parseSSE')
  await expect(page.locator('.md strong', { hasText: '26 testes passando' })).toBeVisible()
  await page.getByRole('button', { name: /Raciocínio/ }).click()
  await expect(page.getByText('Preciso ver o parser atual')).toBeVisible()
  await page.getByRole('button', { name: /shell/ }).click()
  await expect(page.getByText('Test Files  1 failed | 1 passed (2)')).toBeVisible()
  await page.getByRole('button', { name: /^Mapear usos do parser Encontre/ }).click()
  await expect(page.getByText('src/main/providers/anthropic.ts').last()).toBeVisible()

  await page.getByRole('button', { name: 'Apagar' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apagar' }).click()
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Refatorar o parser de SSE/ })).toHaveCount(0)
  // cascata no servidor: sessões e mensagens do chat sumiram
  const left = await page.evaluate(() => {
    const d = window.__mock!.server.db
    const u = d.users[d.demo!.user_id]
    const chat = Object.values(u.records).find((r) => r.type === 'chat' && r.deleted)!
    return Object.values(u.records).filter((r) => r.scope === chat.id && r.type !== 'chat').length
  })
  expect(left).toBe(0)
})

test('lista de conversas: filtro e atualização ao vivo pelo WebSocket', async ({ page }) => {
  await expect(page.getByText(/4 conversas/)).toBeVisible()
  await page.getByLabel('Filtrar conversas').fill('rsync')
  await expect(page.getByRole('link', { name: /Script de backup/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Ideias de nomes/ })).toHaveCount(0)
  await page.getByLabel('Filtrar conversas').fill('')
  await expect(page.getByText('Ao vivo').first()).toBeVisible()
  await page.evaluate(() => window.__mock!.remoteNewChat('Conversa vinda do notebook'))
  await expect(page.getByRole('link', { name: /Conversa vinda do notebook/ })).toBeVisible()
  await page.evaluate(() => {
    const d = window.__mock!.server.db
    const u = d.users[d.demo!.user_id]
    const id = Object.values(u.records).find((r) => r.type === 'chat' && !r.deleted)!.id
    window.__mock!.remoteDeleteChat(id)
  })
  await expect(page.getByText(/4 conversas/)).toBeVisible()
})

test('provedores: adicionar, editar (preservando campos desconhecidos) e apagar', async ({
  page
}) => {
  await page.getByRole('link', { name: 'Provedores' }).click()
  await expect(page.getByTestId('provider-card')).toHaveCount(3)
  await page.getByRole('button', { name: 'Adicionar' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Nome').fill('Groq')
  await dlg.getByLabel('Tipo').selectOption('openai')
  await expect(dlg.getByLabel('URL base')).toHaveValue('https://api.openai.com/v1')
  await dlg.getByLabel('URL base').fill('https://api.groq.com/openai/v1/')
  await dlg.getByLabel('Chave de API').fill('gsk_teste_123456789')
  await dlg.getByRole('button', { name: 'Adicionar' }).click()
  await dlg.getByLabel('Nome do cabeçalho').fill('X-Org')
  await dlg.getByLabel('Valor do cabeçalho').fill('time-a')
  await dlg.getByRole('button', { name: 'Salvar' }).click()
  await expect(page.getByText('Provedor adicionado.')).toBeVisible()
  const card = page.getByTestId('provider-card').filter({ hasText: 'Groq' })
  await expect(card).toContainText('https://api.groq.com/openai/v1')
  await expect(card).toContainText('X-Org')
  await expect(card).not.toContainText('gsk_teste_123456789')
  await card.getByRole('button', { name: 'Mostrar chave' }).click()
  await expect(card).toContainText('gsk_teste_123456789')

  // editar o provedor que tem um campo de versão futura
  const ollama = page.getByTestId('provider-card').filter({ hasText: 'Ollama local' })
  await ollama.getByRole('button', { name: 'Editar Ollama local' }).click()
  await dlg.getByLabel('Chave de API').fill('chave-nova')
  await dlg.getByRole('button', { name: 'Salvar' }).click()
  await expect(page.getByText('Provedor salvo.')).toBeVisible()
  await ollama.getByRole('button', { name: 'Mostrar chave' }).click()
  await expect(ollama).toContainText('chave-nova')
  // conferência no "servidor": decifra com a DEK da demo e confere o campo preservado
  const preserved = await page.evaluate(async () => {
    const { deriveSubkeys, fromHex, openRecord } = (await import(
      /* @vite-ignore */ '/src/crypto/index.ts' as string
    )) as typeof import('../src/crypto')
    const d = window.__mock!.server.db
    const u = d.users[d.demo!.user_id]
    const sk = await deriveSubkeys(fromHex(d.demo!.dek_hex))
    for (const r of Object.values(u.records)) {
      if (r.type !== 'provider' || r.deleted) continue
      const p = await openRecord(sk.record, u.id, r, r.env!)
      if (p.name === 'Ollama local') return { rev: r.rev, p }
    }
    return null
  })
  expect(preserved?.rev).toBe(2)
  expect(preserved?.p.futureField).toEqual({ keep: true })
  expect(preserved?.p.apiKey).toBe('chave-nova')

  await card.getByRole('button', { name: 'Apagar Groq' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apagar' }).click()
  await expect(page.getByText('Provedor apagado.')).toBeVisible()
  await expect(page.getByTestId('provider-card')).toHaveCount(3)
})

test('edição concorrente: LWW por campo reaplica só o que mudou', async ({ page }) => {
  await page.getByRole('link', { name: 'Provedores' }).click()
  const card = page.getByTestId('provider-card').filter({ hasText: 'Anthropic' })
  await card.getByRole('button', { name: 'Editar Anthropic' }).click()
  // outro dispositivo renomeia o provedor enquanto o formulário está aberto
  await page.evaluate(async () => {
    const { deriveSubkeys, fromHex, openRecord, sealRecord } = (await import(
      /* @vite-ignore */ '/src/crypto/index.ts' as string
    )) as typeof import('../src/crypto')
    const m = window.__mock!
    const d = m.server.db
    const u = d.users[d.demo!.user_id]
    const sk = await deriveSubkeys(fromHex(d.demo!.dek_hex))
    for (const x of Object.values(u.records)) {
      if (x.type !== 'provider' || x.deleted) continue
      const p = await openRecord(sk.record, u.id, x, x.env!)
      if (p.name !== 'Anthropic') continue
      const env = await sealRecord(
        sk.record,
        u.id,
        { ...x, rev: x.rev + 1 },
        { ...p, baseUrl: 'https://proxy.exemplo.com/v1' }
      )
      m.server.remotePush(u.id, [
        {
          type: 'provider',
          id: x.id,
          scope: null,
          base_rev: x.rev,
          rev: x.rev + 1,
          deleted: false,
          env,
          blobs: []
        }
      ])
    }
  })
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Nome').fill('Anthropic (trabalho)')
  await dlg.getByRole('button', { name: 'Salvar' }).click()
  await expect(page.getByText('Provedor salvo.')).toBeVisible()
  const merged = page.getByTestId('provider-card').filter({ hasText: 'Anthropic (trabalho)' })
  await expect(merged).toContainText('https://proxy.exemplo.com/v1')
})

test('pesquisa na web: chaves dos buscadores', async ({ page }) => {
  await page.getByRole('link', { name: 'Pesquisa na web' }).click()
  await expect(page.getByLabel('Exa')).toHaveValue('exa_demo_8f2c41d0b7e6')
  await expect(page.getByText('sem chave')).toHaveCount(0)
  await page.getByLabel('Tavily').fill('tvly-nova-chave')
  await page.getByLabel('Exa').fill('')
  await page.getByRole('button', { name: 'Salvar chaves' }).click()
  await expect(page.getByText('Chaves salvas.')).toBeVisible()
  await page.reload()
  await unlock(page)
  await page.getByRole('link', { name: 'Pesquisa na web' }).click()
  await expect(page.getByLabel('Tavily')).toHaveValue('tvly-nova-chave')
  await expect(page.getByLabel('Exa')).toHaveValue('')
  await expect(page.getByText('sem chave')).toBeVisible()
})

test('dispositivos: listar, renomear e desconectar', async ({ page }) => {
  await page.getByRole('link', { name: 'Dispositivos' }).click()
  await expect(page.getByTestId('device-row')).toHaveCount(3)
  await expect(page.getByTestId('device-row').first()).toContainText('este dispositivo')
  const mac = page.getByTestId('device-row').filter({ hasText: 'MacBook do trabalho' })
  await mac.getByRole('button', { name: 'Renomear' }).click()
  await page.getByRole('dialog').getByLabel('Nome').fill('MacBook antigo')
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click()
  const renamed = page.getByTestId('device-row').filter({ hasText: 'MacBook antigo' })
  await expect(renamed).toBeVisible()
  await renamed.getByRole('button', { name: 'Desconectar' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Desconectar' }).click()
  await expect(page.getByTestId('device-row')).toHaveCount(2)
})

test('access token expirado é renovado pelo cookie de refresh', async ({ page }) => {
  await page.evaluate(() => window.__mock!.expireAccess())
  await page.getByRole('link', { name: 'Conta' }).click()
  await expect(page.getByText('demo@clearchat.dev').last()).toBeVisible()
  await expect(page.getByText('Registros')).toBeVisible()
})

test('trocar a senha de criptografia', async ({ page }) => {
  await page.getByRole('link', { name: 'Segurança' }).click()
  const form = page.getByTestId('change-password')
  await form.getByLabel('Senha atual').fill('errada-errada')
  await form.getByLabel('Nova senha', { exact: true }).fill('minha nova frase secreta')
  await form.getByLabel('Confirme a senha').fill('minha nova frase secreta')
  await form.getByRole('button', { name: 'Trocar senha' }).click()
  await expect(page.getByText('A senha atual está incorreta.')).toBeVisible()
  await form.getByLabel('Senha atual').fill('demonstracao-segura')
  await form.getByRole('button', { name: 'Trocar senha' }).click()
  await expect(page.getByText(/Senha de criptografia trocada/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Bloquear agora' }).click()
  await unlock(page)
  await expect(page.getByText('Senha incorreta.')).toBeVisible()
  await page.getByLabel('Senha de criptografia').fill('minha nova frase secreta')
  await page.getByRole('button', { name: 'Desbloquear' }).click()
  // volta para onde estava
  await expect(page.getByRole('heading', { name: 'Segurança' })).toBeVisible()
})

test('nova chave de recuperação pelo painel', async ({ page }) => {
  await page.getByRole('link', { name: 'Segurança' }).click()
  const before = await page.evaluate(() =>
    JSON.stringify(
      window.__mock!.server.db.users[window.__mock!.server.db.demo!.user_id].keys!.recovery
    )
  )
  await page.getByRole('button', { name: 'Gerar nova chave de recuperação' }).click()
  const dlg = page.getByRole('dialog')
  const key = (
    await dlg.getByTestId('recovery-key').locator('span.select-all').allTextContents()
  ).join('-')
  await dlg.getByLabel('Guardei minha chave de recuperação em um lugar seguro.').check()
  await dlg.getByLabel(/4 últimos caracteres/).fill(key.slice(-4))
  await dlg.getByRole('button', { name: 'Guardei — ativar a nova chave' }).click()
  await expect(page.getByText(/Nova chave de recuperação ativada/)).toBeVisible()
  const after = await page.evaluate(() =>
    JSON.stringify(
      window.__mock!.server.db.users[window.__mock!.server.db.demo!.user_id].keys!.recovery
    )
  )
  expect(after).not.toBe(before)
})

test('apagar conta com código por e-mail', async ({ page }) => {
  await page.getByRole('link', { name: 'Conta' }).click()
  await page.getByRole('button', { name: 'Apagar conta' }).click()
  const dlg = page.getByRole('dialog')
  const send = dlg.getByRole('button', { name: 'Enviar código de confirmação' })
  await expect(send).toBeDisabled()
  await dlg.getByLabel(/Digite seu e-mail/).fill('demo@clearchat.dev')
  await send.click()
  await dlg.getByLabel('Código de 6 dígitos').fill('123456')
  await dlg.getByRole('button', { name: 'Apagar minha conta' }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText('Sua conta foi apagada.')).toBeVisible()
})

test('instância', async ({ page }) => {
  await page.getByRole('link', { name: 'Instância' }).click()
  await expect(page.getByText('compatível', { exact: true })).toBeVisible()
  await expect(page.getByText('Cadastro aberto')).toBeVisible()
})
