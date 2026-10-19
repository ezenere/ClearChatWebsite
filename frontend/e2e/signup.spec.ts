import { expect, test, type Page } from '@playwright/test'
import { DEMO, mockQuery } from './helpers'

async function finishKeySetup(page: Page, email: string, password: string) {
  await expect(page.getByRole('heading', { name: /senha de criptografia/ })).toBeVisible()
  await expect(page.getByText('nunca é enviada ao servidor')).toBeVisible()
  const pw = page.getByLabel('Senha de criptografia', { exact: true })
  // política: curta demais e igual ao e-mail
  await pw.fill('curta')
  await expect(page.getByRole('button', { name: 'Gerar chaves' })).toBeDisabled()
  await pw.fill(email)
  await page.getByLabel('Confirme a senha').fill(email)
  await expect(page.getByRole('button', { name: 'Gerar chaves' })).toBeDisabled()
  await pw.fill(password)
  await expect(page.getByText(/Força: (Boa|Forte)/)).toBeVisible()
  await page.getByLabel('Confirme a senha').fill(password + 'x')
  await expect(page.getByText('As senhas não conferem.')).toBeVisible()
  await page.getByLabel('Confirme a senha').fill(password)
  await page.getByRole('button', { name: 'Gerar chaves' }).click()

  // chave de recuperação: mostrada uma vez, com copiar/baixar/imprimir e confirmação explícita
  await expect(page.getByRole('heading', { name: 'Guarde sua chave de recuperação' })).toBeVisible({
    timeout: 20_000
  })
  const key = (
    await page.getByTestId('recovery-key').locator('span.select-all').allTextContents()
  ).join('-')
  expect(key).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{4}$/)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Baixar' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('clearchat-chave-de-recuperacao.txt')
  await page.getByRole('button', { name: 'Copiar' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key)
  const done = page.getByRole('button', { name: 'Guardei — concluir' })
  await expect(done).toBeDisabled()
  await page.getByLabel('Guardei minha chave de recuperação em um lugar seguro.').check()
  await expect(done).toBeDisabled()
  await page.getByLabel(/4 últimos caracteres/).fill('ZZZZ')
  await expect(page.getByText('Não confere com o fim da chave.')).toBeVisible()
  await page.getByLabel(/4 últimos caracteres/).fill(key.slice(-4).toLowerCase())
  await done.click()
  return key
}

test('cadastro completo: código, senha, chave de recuperação, upload das wraps', async ({
  page
}) => {
  await page.goto('/signup')
  await page.getByLabel('Nome').fill('Bruno Teste')
  await page.getByLabel('E-mail').fill('bruno@exemplo.com')
  await page.getByRole('button', { name: 'Continuar' }).click()
  await expect(page.getByRole('heading', { name: 'Confirme seu e-mail' })).toBeVisible()
  await page.getByLabel('Código de 6 dígitos').fill('000000')
  await expect(page.getByText('Código incorreto ou expirado.')).toBeVisible()
  await page.getByLabel('Código de 6 dígitos').fill(DEMO.code)

  const password = 'cavalo correto bateria grampo'
  const key = await finishKeySetup(page, 'bruno@exemplo.com', password)
  await expect(page.getByRole('heading', { name: 'Tudo pronto' })).toBeVisible()

  // o servidor recebeu só wraps/verifier (nunca senha, DEK ou chave de recuperação)
  const stored = await page.evaluate(() => {
    const u = Object.values(window.__mock!.server.db.users).find(
      (x) => x.email === 'bruno@exemplo.com'
    )!
    return JSON.stringify({ keys: u.keys, verifier: u.verifier })
  })
  expect(stored).toContain('"alg":"argon2id"')
  expect(stored).toContain('"m":65536')
  expect(stored).not.toContain(password)
  expect(stored).not.toContain(key)

  await page.getByRole('button', { name: 'Ir para o painel' }).click()
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible()
  await expect(page.getByText('Nenhuma conversa ainda')).toBeVisible()

  // recarregar = desbloquear de novo (nada no armazenamento do navegador)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Desbloquear seus dados' })).toBeVisible()
  const storage = await page.evaluate(() => sessionStorage.length)
  expect(storage).toBe(0)
  await page.getByLabel('Senha de criptografia').fill(password)
  await page.getByRole('button', { name: 'Desbloquear' }).click()
  await expect(page.getByRole('heading', { name: 'Conversas' })).toBeVisible()
})

test('cadastro fechado com link de convite (e vindo do app)', async ({ page }) => {
  await page.goto('/' + mockQuery({ signup: false }))
  const token = await page.evaluate(() => window.__mock!.addInvite('convidada@exemplo.com'))
  await page.goto(`/signup?invite=${token}&from=app`)
  await expect(page.getByRole('heading', { name: 'Você foi convidado' })).toBeVisible()
  await expect(page.getByLabel('E-mail')).toHaveValue('convidada@exemplo.com')
  await expect(page.getByLabel('E-mail')).not.toBeEditable()
  await page.getByLabel('Nome').fill('Carla')
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.getByLabel('Código de 6 dígitos').fill(DEMO.code)
  await finishKeySetup(page, 'convidada@exemplo.com', 'outra frase bem longa e segura')
  await expect(page.getByText('Volte ao app e entre')).toBeVisible()

  // o convite é de uso único
  await page.goto(`/signup?invite=${token}`)
  await expect(page.getByRole('heading', { name: 'Você já está conectado' })).toBeVisible()
})

test('convite inválido', async ({ page }) => {
  await page.goto('/signup?invite=nao-existe')
  await expect(page.getByRole('heading', { name: 'Convite inválido' })).toBeVisible()
})
